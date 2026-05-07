/**
 * Flutter SSL Patch Engine (Pure Node.js)
 * Ported from flutter_ssl_patch.py by AbhiTheModder
 * https://github.com/AbhiTheModder/termux-scripts
 */

'use strict';

// ─── Byte Patterns (identical to original Python/JS scripts) ─────────────────
const PATTERNS = {
  arm64: [
    'F. 0F 1C F8 F. 5. 01 A9 F. 5. 02 A9 F. .. 03 A9 .. .. .. .. 68 1A 40 F9',
    'F. 43 01 D1 FE 67 01 A9 F8 5F 02 A9 F6 57 03 A9 F4 4F 04 A9 13 00 40 F9 F4 03 00 AA 68 1A 40 F9',
    'FF 43 01 D1 FE 67 01 A9 .. .. 06 94 .. 7. 06 94 68 1A 40 F9 15 15 41 F9 B5 00 00 B4 B6 4A 40 F9',
    'FF .3 01 D1 F. .. 01 A9 .. .. .. 94 .. .. .. 52 48 00 00 39 1A 50 40 F9 DA 02 00 B4 48 03 40 F9',
    'F. 0F 1C F8 F. .. 0. .. .. .. .. .9 .. .. 0. .. 68 1A 40 F9 15 .. 4. F9 B5 00 00 B4 B6 46 40 F9',
  ],
  arm: [
    '2D E9 F. 4. D0 F8 00 80 81 46 D8 F8 18 00 D0 F8',
  ],
  x86: [
    '55 41 57 41 56 41 55 41 54 53 50 49 89 fe 48 8b 1f 48 8b 43 30 4c 8b b8 d0 01 00 00 4d 85 ff 74 12 4d 8b a7 90 00 00 00 4d 85 e4 74 4a 49 8b 04 24 eb 46',
    '55 41 57 41 56 41 55 41 54 53 50 49 89 f. 4c 8b 37 49 8b 46 30 4c 8b a. .. 0. 00 00 4d 85 e. 74 1. 4d 8b',
    '55 41 57 41 56 41 55 41 54 53 48 83 EC 18 49 89 FF 48 8B 1F 48 8B 43 30 4C 8B A0 28 02 00 00 4D 85 E4 74',
    '55 41 57 41 56 41 55 41 54 53 48 83 EC 18 49 89 FE 4C 8B 27 49 8B 44 24 30 48 8B 98 D0 01 00 00 48 85 DB',
    '55 41 57 41 56 41 55 41 54 53 48 83 EC 38 C6 02 50 48 8B AF A. 00 00 00 48 85 ED 74 7. 48 83 7D 00 00 74',
  ],
};

// ret0 patch bytes per architecture
// These overwrite the function prologue so it immediately returns 0
const RET0_PATCHES = {
  arm64: Buffer.from([0x00, 0x00, 0x80, 0xD2, 0xC0, 0x03, 0x5F, 0xD6]), // mov x0,#0; ret
  arm:   Buffer.from([0x00, 0x00, 0xA0, 0xE3, 0x1E, 0xFF, 0x2F, 0xE1]), // mov r0,#0; bx lr
  x86:   Buffer.from([0x48, 0x31, 0xC0, 0xC3]),                          // xor rax,rax; ret
};

// ─── Architecture Detection ──────────────────────────────────────────────────
function detectArch(buf) {
  // ELF magic check
  if (buf[0] !== 0x7F || buf[1] !== 0x45 || buf[2] !== 0x4C || buf[3] !== 0x46) {
    return { arch: null, error: 'Not a valid ELF binary' };
  }

  const elfClass  = buf[4]; // 1=32-bit, 2=64-bit
  const elfMachine = buf.readUInt16LE(18);

  // e_machine values:
  // 0x28 = ARM (32-bit)
  // 0xB7 = AArch64 (ARM64)
  // 0x3E = x86-64
  // 0x03 = x86 (32-bit)

  if (elfMachine === 0xB7) return { arch: 'arm64', bits: 64 };
  if (elfMachine === 0x28) return { arch: 'arm',   bits: 32 };
  if (elfMachine === 0x3E) return { arch: 'x86',   bits: 64 };
  if (elfMachine === 0x03) return { arch: 'x86',   bits: 32 };

  return { arch: null, error: `Unsupported e_machine: 0x${elfMachine.toString(16)}` };
}

// ─── Pattern Parser ──────────────────────────────────────────────────────────
// Converts "F. 0F 1C F8 .." into array of { byte, mask } objects
function parsePattern(patternStr) {
  return patternStr.trim().split(/\s+/).map(tok => {
    if (tok === '..') return { byte: 0x00, mask: 0x00 };
    if (tok.includes('.')) {
      // Partial wildcard e.g. "F." "4." ".3"
      const hi = tok[0] === '.' ? null : parseInt(tok[0], 16);
      const lo = tok[1] === '.' ? null : parseInt(tok[1], 16);
      let byte_ = 0, mask = 0;
      if (hi !== null) { byte_ |= (hi << 4); mask |= 0xF0; }
      if (lo !== null) { byte_ |= lo;         mask |= 0x0F; }
      return { byte: byte_, mask };
    }
    return { byte: parseInt(tok, 16), mask: 0xFF };
  });
}

// ─── Boyer-Moore-like pattern search with wildcards ──────────────────────────
function searchPattern(buf, parsed) {
  const patLen = parsed.length;
  const bufLen = buf.length;
  const results = [];

  outer:
  for (let i = 0; i <= bufLen - patLen; i++) {
    for (let j = 0; j < patLen; j++) {
      const { byte: pb, mask } = parsed[j];
      if ((buf[i + j] & mask) !== (pb & mask)) continue outer;
    }
    results.push(i);
  }
  return results;
}

// ─── Find function start (walk back to find prologue) ────────────────────────
// For arm64: look for common prologues like "stp x29, x30" or "sub sp"
// For arm: look for PUSH {r4-r11, lr}
// Fallback: use found offset directly
function findFunctionStart(buf, offset, arch) {
  const SEARCH_BACK = 256; // max bytes to walk back
  const start = Math.max(0, offset - SEARCH_BACK);

  if (arch === 'arm64') {
    // STP x29, x30, [sp, ...] = FD 7B ?? A9
    // SUB SP, SP = FF ?? ?? D1
    for (let i = offset; i >= start; i -= 4) {
      const w = buf.readUInt32LE(i);
      // STP x29, x30, [sp, #-N]!
      if ((w & 0xFFC07FFF) === 0xA9807BFD) return i;
      // STP x29, x30, [sp, #offset]
      if ((w & 0xFFC07FFF) === 0xA9007BFD) return i;
      // SUB sp, sp, #imm
      if ((w & 0xFFFFF000) === 0xD10003FF) return i;
      if ((w & 0xFF8003FF) === 0xD10003FF) return i;
    }
  } else if (arch === 'arm') {
    // PUSH { ..., lr } = 2D E9 ?? 4x
    for (let i = offset; i >= start; i -= 2) {
      if (i + 1 < buf.length) {
        const lo = buf[i], hi = buf[i + 1];
        if (lo === 0x2D && hi === 0xE9) return i;
        if (lo === 0xF0 && (hi & 0xF0) === 0x40) return i; // PUSH (THUMB2)
      }
    }
  } else if (arch === 'x86') {
    // PUSH rbp = 55, or standard prologue 55 48 89 E5
    for (let i = offset; i >= start; i--) {
      if (buf[i] === 0x55) return i;
    }
  }

  return offset; // fallback: use found offset
}

// ─── Main Patch Function ─────────────────────────────────────────────────────
function patchBinary(inputBuf, forcedArch, log) {
  const push = (msg) => { log.push(msg); };

  // 1. Detect architecture
  const detected = detectArch(inputBuf);
  const arch = forcedArch || detected.arch;

  if (!arch) {
    push({ level: 'error', text: detected.error || 'Could not detect architecture' });
    return { success: false, log };
  }

  push({ level: 'info',  text: `Binary detected: ELF ${detected.bits || '?'}-bit` });
  push({ level: 'info',  text: `Architecture: ${arch}` });

  const archPatterns = PATTERNS[arch];
  if (!archPatterns) {
    push({ level: 'error', text: `No patterns defined for architecture: ${arch}` });
    return { success: false, log };
  }

  push({ level: 'step',  text: 'Analyzing binary...' });
  push({ level: 'step',  text: `Searching for ssl_verify_peer_cert (${archPatterns.length} patterns)...` });

  // 2. Search patterns
  let foundOffset = null;
  let matchedPattern = null;
  let patternIdx = null;

  for (let i = 0; i < archPatterns.length; i++) {
    const parsed = parsePattern(archPatterns[i]);
    const hits = searchPattern(inputBuf, parsed);
    if (hits.length > 0) {
      foundOffset = hits[0];
      matchedPattern = archPatterns[i];
      patternIdx = i + 1;
      push({ level: 'found', text: `Pattern [${i + 1}/${archPatterns.length}] matched at offset 0x${foundOffset.toString(16).toUpperCase()}` });
      break;
    } else {
      push({ level: 'info', text: `Pattern [${i + 1}/${archPatterns.length}] → no match` });
    }
  }

  if (foundOffset === null) {
    push({ level: 'error', text: 'ssl_verify_peer_cert not found. Try a different Flutter version or architecture.' });
    return { success: false, log };
  }

  // 3. Find function start
  const fnOffset = findFunctionStart(inputBuf, foundOffset, arch);
  push({ level: 'info',  text: `Function start at offset: 0x${fnOffset.toString(16).toUpperCase()}` });

  // 4. Apply patch
  const patch = RET0_PATCHES[arch];
  if (!patch) {
    push({ level: 'error', text: `No ret0 patch defined for ${arch}` });
    return { success: false, log };
  }

  // Validate we have enough space
  if (fnOffset + patch.length > inputBuf.length) {
    push({ level: 'error', text: 'Patch would exceed binary bounds' });
    return { success: false, log };
  }

  // Read original bytes for reporting
  const originalBytes = inputBuf.slice(fnOffset, fnOffset + patch.length)
    .toString('hex').toUpperCase().match(/.{2}/g).join(' ');
  push({ level: 'info', text: `Original bytes: ${originalBytes}` });

  // Clone buffer and apply patch
  const patchedBuf = Buffer.from(inputBuf);
  patch.copy(patchedBuf, fnOffset);

  const patchedBytes = patch.toString('hex').toUpperCase().match(/.{2}/g).join(' ');
  push({ level: 'info', text: `Patched  bytes: ${patchedBytes}` });

  push({ level: 'success', text: 'ssl_verify_peer_cert patched successfully!' });
  push({ level: 'success', text: 'SSL certificate verification is now bypassed.' });

  return {
    success: true,
    log,
    patchedBuf,
    meta: {
      arch,
      foundOffset: `0x${foundOffset.toString(16).toUpperCase()}`,
      fnOffset:    `0x${fnOffset.toString(16).toUpperCase()}`,
      patternIdx,
      originalBytes,
      patchedBytes,
    },
  };
}

module.exports = { patchBinary, detectArch, PATTERNS };
