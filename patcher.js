'use strict';

/**
 * Flutter SSL Patch Engine (Pure Node.js)
 * Ported from flutter_ssl_patch.py by AbhiTheModder
 * https://github.com/AbhiTheModder/termux-scripts
 */

// ─── Byte Patterns ───────────────────────────────────────────────────────────
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

const RET0_PATCHES = {
  arm64: Buffer.from([0x00, 0x00, 0x80, 0xD2, 0xC0, 0x03, 0x5F, 0xD6]),
  arm:   Buffer.from([0x00, 0x00, 0xA0, 0xE3, 0x1E, 0xFF, 0x2F, 0xE1]),
  x86:   Buffer.from([0x48, 0x31, 0xC0, 0xC3]),
};

// ─── Architecture Detection ──────────────────────────────────────────────────
function detectArch(buf) {
  // Guard: must be a Buffer with at least 20 bytes
  if (!buf || !Buffer.isBuffer(buf) || buf.length < 20) {
    return { arch: null, bits: null, error: 'File too small or invalid' };
  }
  // ELF magic
  if (buf[0] !== 0x7F || buf[1] !== 0x45 || buf[2] !== 0x4C || buf[3] !== 0x46) {
    return { arch: null, bits: null, error: 'Not a valid ELF binary (bad magic bytes)' };
  }
  const elfClass   = buf[4]; // 1=32-bit  2=64-bit
  const elfMachine = buf.readUInt16LE(18);

  if (elfMachine === 0xB7) return { arch: 'arm64', bits: 64 };
  if (elfMachine === 0x28) return { arch: 'arm',   bits: 32 };
  if (elfMachine === 0x3E) return { arch: 'x86',   bits: 64 };
  if (elfMachine === 0x03) return { arch: 'x86',   bits: 32 };

  return { arch: null, bits: elfClass === 2 ? 64 : 32,
           error: `Unsupported e_machine: 0x${elfMachine.toString(16).toUpperCase()}` };
}

// ─── Pattern Parser ──────────────────────────────────────────────────────────
function parsePattern(patternStr) {
  return patternStr.trim().split(/\s+/).map(tok => {
    if (tok === '..') return { byte: 0x00, mask: 0x00 };
    if (tok.includes('.')) {
      const hi = tok[0] === '.' ? null : parseInt(tok[0], 16);
      const lo = tok[1] === '.' ? null : parseInt(tok[1], 16);
      let byte_ = 0, mask = 0;
      if (hi !== null) { byte_ |= (hi << 4); mask |= 0xF0; }
      if (lo !== null) { byte_ |= lo;        mask |= 0x0F; }
      return { byte: byte_, mask };
    }
    return { byte: parseInt(tok, 16), mask: 0xFF };
  });
}

// ─── Pattern Search ──────────────────────────────────────────────────────────
function searchPattern(buf, parsed) {
  const patLen = parsed.length;
  const bufLen = buf.length;
  if (patLen === 0 || patLen > bufLen) return [];
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

// ─── Find Function Start ─────────────────────────────────────────────────────
function findFunctionStart(buf, offset, arch) {
  const SEARCH_BACK = 256;
  const start = Math.max(0, offset - SEARCH_BACK);

  if (arch === 'arm64') {
    for (let i = offset; i >= start; i -= 4) {
      if (i + 4 > buf.length) continue;
      const w = buf.readUInt32LE(i);
      if ((w & 0xFFC07FFF) === 0xA9807BFD) return i;
      if ((w & 0xFFC07FFF) === 0xA9007BFD) return i;
      if ((w & 0xFF8003FF) === 0xD10003FF) return i;
    }
  } else if (arch === 'arm') {
    for (let i = offset; i >= start; i -= 2) {
      if (i + 2 > buf.length) continue;
      if (buf[i] === 0x2D && buf[i + 1] === 0xE9) return i;
      if (buf[i] === 0xF0 && (buf[i + 1] & 0xF0) === 0x40) return i;
    }
  } else if (arch === 'x86') {
    for (let i = offset; i >= start; i--) {
      if (buf[i] === 0x55) return i;
    }
  }
  return offset;
}

// ─── Main Patch ──────────────────────────────────────────────────────────────
function patchBinary(inputBuf, forcedArch, log) {
  // Defensive: ensure log is an array and push helper works
  if (!Array.isArray(log)) log = [];
  const push = (level, text) => log.push({ level, text });

  // Guard: validate input
  if (!inputBuf || !Buffer.isBuffer(inputBuf)) {
    push('error', 'Invalid input: not a Buffer');
    return { success: false, log };
  }
  if (inputBuf.length < 64) {
    push('error', `File too small (${inputBuf.length} bytes) — not a valid ELF binary`);
    return { success: false, log };
  }
  if (inputBuf.length > 200 * 1024 * 1024) {
    push('error', 'File too large (>200 MB)');
    return { success: false, log };
  }

  // Detect arch
  const detected = detectArch(inputBuf);
  const arch = forcedArch || detected.arch;

  if (!arch) {
    push('error', detected.error || 'Could not detect architecture');
    return { success: false, log };
  }

  push('info',  `Binary: ELF ${detected.bits || '?'}-bit`);
  push('info',  `Architecture: ${arch}${forcedArch ? ' (forced)' : ' (auto-detected)'}`);

  const archPatterns = PATTERNS[arch];
  if (!archPatterns || archPatterns.length === 0) {
    push('error', `No patterns defined for architecture: ${arch}`);
    return { success: false, log };
  }

  push('step',  `Scanning binary (${(inputBuf.length / 1024 / 1024).toFixed(2)} MB)...`);
  push('step',  `Searching ssl_verify_peer_cert using ${archPatterns.length} pattern(s)...`);

  // Search patterns
  let foundOffset = null, patternIdx = null;

  for (let i = 0; i < archPatterns.length; i++) {
    let parsed;
    try { parsed = parsePattern(archPatterns[i]); } catch { continue; }
    const hits = searchPattern(inputBuf, parsed);
    if (hits.length > 0) {
      foundOffset = hits[0];
      patternIdx  = i + 1;
      push('found', `Pattern [${i + 1}/${archPatterns.length}] matched at offset 0x${foundOffset.toString(16).toUpperCase()}`);
      if (hits.length > 1) push('info', `(${hits.length} matches total — using first)`);
      break;
    } else {
      push('info', `Pattern [${i + 1}/${archPatterns.length}] → no match`);
    }
  }

  if (foundOffset === null) {
    push('error', 'ssl_verify_peer_cert not found. The Flutter binary may be unsupported, obfuscated, or wrong arch.');
    push('info',  'Tip: Try a different architecture, or use APK Patcher mode for Smali-based SSL bypass.');
    return { success: false, log };
  }

  // Find function start
  const fnOffset = findFunctionStart(inputBuf, foundOffset, arch);
  if (fnOffset !== foundOffset) {
    push('info', `Function start: 0x${fnOffset.toString(16).toUpperCase()} (walked back from match offset)`);
  } else {
    push('info', `Function start: 0x${fnOffset.toString(16).toUpperCase()}`);
  }

  // Apply patch
  const patch = RET0_PATCHES[arch];
  if (!patch) {
    push('error', `No ret0 patch bytes defined for ${arch}`);
    return { success: false, log };
  }
  if (fnOffset + patch.length > inputBuf.length) {
    push('error', 'Patch would exceed binary bounds — invalid offset');
    return { success: false, log };
  }

  const originalBytes = Array.from(inputBuf.slice(fnOffset, fnOffset + patch.length))
    .map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
  push('info', `Original bytes: ${originalBytes}`);

  const patchedBuf = Buffer.from(inputBuf);
  patch.copy(patchedBuf, fnOffset);

  const patchedBytes = Array.from(patch)
    .map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
  push('info',    `Patched  bytes: ${patchedBytes}`);
  push('success', 'ssl_verify_peer_cert patched successfully!');
  push('success', 'SSL certificate verification is now bypassed.');

  return {
    success: true, log, patchedBuf,
    meta: { arch, foundOffset: `0x${foundOffset.toString(16).toUpperCase()}`,
            fnOffset: `0x${fnOffset.toString(16).toUpperCase()}`,
            patternIdx, originalBytes, patchedBytes },
  };
}

module.exports = { patchBinary, detectArch, PATTERNS };
