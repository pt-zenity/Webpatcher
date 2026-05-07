'use strict';

/**
 * APK Patcher Bridge  (Node.js → Python ApkPatcher)
 * Real-time stdout streaming, robust ANSI stripping, full error handling
 */

const { execFile, spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

// ── Strip ANSI escape codes + control chars ───────────────────────────────────
const ANSI_RE = /(\x9B|\x1B\[)[0-?]*[ -/]*[@-~]|\x1B[^[]/g;
function stripAnsi(s) {
  return String(s)
    .replace(ANSI_RE, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .trim();
}

// Lines that are pure visual noise — skip them
const SKIP_RE = /^[_\-=|+✦✧*\s]{3,}$|^\s*$|^[▀▄█▌▐░▒▓]+|^eJz|^[a-zA-Z0-9+/]{40,}={0,2}$/;

// ── Detect APK type (Flutter / Pairip / package name) ────────────────────────
function detectApkType(apkPath) {
  return new Promise((resolve) => {
    const PY = `
import zipfile,json,sys,subprocess,os
result={'flutter':False,'pairip':False,'pkg':'','files':0,'error':''}
try:
    with zipfile.ZipFile(sys.argv[1]) as z:
        names=z.namelist()
        result['files']=len(names)
        result['flutter']=any('libflutter.so' in n for n in names)
        result['pairip']=any('libpairip' in n.lower() for n in names)
    try:
        r=subprocess.run(['aapt','dump','badging',sys.argv[1]],
            capture_output=True,text=True,timeout=20)
        for line in r.stdout.splitlines():
            if line.startswith('package:') and "name='" in line:
                result['pkg']=line.split("name='")[1].split("'")[0]
                break
    except Exception as e:
        result['pkg']=''
except Exception as e:
    result['error']=str(e)
print(json.dumps(result))
`;
    execFile('python3', ['-c', PY, apkPath],
      { timeout: 25000, maxBuffer: 256 * 1024 },
      (err, stdout, stderr) => {
        try {
          const data = JSON.parse(stdout.trim());
          resolve(data);
        } catch {
          resolve({ flutter: false, pairip: false, pkg: '', files: 0,
                    error: err ? err.message : 'parse error' });
        }
      });
  });
}

// ── The Python runner script ──────────────────────────────────────────────────
// Uses Popen with real-time line-by-line output via a sentinel protocol
const RUNNER_PY = String.raw`
import sys, os, json, subprocess, shutil, time

def strip_ansi(s):
    import re
    return re.sub(r'(\x9B|\x1B\[)[0-?]*[ -/]*[@-~]|\x1B[^[]', '', s).strip()

def emit(level, text):
    text = strip_ansi(text)
    if not text: return
    skip_pat = r'^[_\-=|+ *\s]{3,}$|^[▀▄█▌▐░▒▓]+|^eJz|^[A-Za-z0-9+/]{40,}={0,2}$'
    import re
    if re.match(skip_pat, text): return
    sys.stdout.write(json.dumps({'level': level, 'text': text}) + '\n')
    sys.stdout.flush()

def main():
    data     = json.loads(sys.argv[1])
    apk_path = data['apk_path']
    options  = data['options']
    out_path = data['output_path']

    cmd = ['python3', '-m', 'ApkPatcher', '-i', apk_path]

    if options.get('flutter'):       cmd.append('-f')
    if options.get('pairip_corex'):  cmd.extend(['-p', '-x'])
    elif options.get('pairip'):      cmd.append('-p')
    if options.get('spoof_pkg'):     cmd.append('-pkg')
    if options.get('remove_ads'):    cmd.append('-rmads')
    if options.get('remove_ss'):     cmd.append('-rmss')
    if options.get('remove_usb'):    cmd.append('-rmusb')
    if options.get('random_info'):   cmd.append('-r')
    if options.get('purchase'):      cmd.append('-P')
    if options.get('tg_patch'):      cmd.append('-t')
    if options.get('android_id'):
        aid = str(options['android_id']).strip()
        if aid:
            cmd.extend(['-D', aid])

    env = os.environ.copy()
    env['PYTHONUNBUFFERED'] = '1'
    env['TERM'] = 'dumb'
    env['NO_COLOR'] = '1'
    env['JAVA_HOME'] = '/usr/lib/jvm/java-21-openjdk-amd64'
    env['PATH'] = '/usr/bin:/usr/local/bin:/usr/lib/jvm/java-21-openjdk-amd64/bin:' + env.get('PATH', '')

    emit('info', 'CMD: ' + ' '.join(cmd))

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            env=env,
        )

        for line in proc.stdout:
            clean = strip_ansi(line)
            if not clean:
                continue
            # classify line
            low = clean.lower()
            if any(k in low for k in ['error', 'exception', 'traceback', 'failed', 'not found']):
                level = 'error'
            elif any(k in low for k in ['warning', 'warn']):
                level = 'warn'
            elif any(k in low for k in ['success', 'patched', 'done', 'complete', 'finish', 'apk']):
                level = 'success'
            elif any(k in low for k in ['decompil', 'recompil', 'smali', 'patch', 'sign', 'build', 'analy']):
                level = 'step'
            else:
                level = 'info'
            emit(level, clean)

        proc.wait(timeout=600)
        returncode = proc.returncode

    except subprocess.TimeoutExpired:
        proc.kill()
        emit('error', 'Timeout: proses melebihi 10 menit')
        sys.stdout.write(json.dumps({'__result__': False, 'reason': 'timeout'}) + '\n')
        sys.stdout.flush()
        return
    except Exception as e:
        emit('error', f'Subprocess error: {e}')
        sys.stdout.write(json.dumps({'__result__': False, 'reason': str(e)}) + '\n')
        sys.stdout.flush()
        return

    # Find output APK
    base    = os.path.splitext(os.path.basename(apk_path))[0]
    apk_dir = os.path.dirname(apk_path)
    candidates = [
        os.path.join(apk_dir, base + '_Patched.apk'),
        os.path.join(apk_dir, base + '_Patch.apk'),
        os.path.join(os.path.expanduser('~'), base + '_Patched.apk'),
    ]
    found_apk = next((c for c in candidates if os.path.exists(c)), None)
    ok = False
    if found_apk:
        try:
            shutil.move(found_apk, out_path)
            ok = True
        except Exception as e:
            emit('error', f'Move failed: {e}')

    # Clean up decompile dir
    for decomp_base in [apk_dir, os.path.expanduser('~')]:
        decomp = os.path.join(decomp_base, base + '_decompiled')
        if os.path.exists(decomp):
            try: shutil.rmtree(decomp, ignore_errors=True)
            except: pass

    sys.stdout.write(json.dumps({'__result__': ok, 'returncode': returncode}) + '\n')
    sys.stdout.flush()

main()
`;

// ── Main patch function ────────────────────────────────────────────────────────
function patchApk(apkPath, outputPath, options, onLog) {
  return new Promise((resolve) => {
    // Write runner script to a temp file
    const scriptFile = path.join(os.tmpdir(), `apkpatch_${Date.now()}_${Math.random().toString(36).slice(2)}.py`);
    try { fs.writeFileSync(scriptFile, RUNNER_PY, 'utf8'); }
    catch (e) { onLog({ level: 'error', text: `Cannot write runner: ${e.message}` }); return resolve({ success: false, error: e.message }); }

    const payload = JSON.stringify({ apk_path: apkPath, options: options || {}, output_path: outputPath });

    const env = {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      TERM: 'dumb',
      NO_COLOR: '1',
      JAVA_HOME: '/usr/lib/jvm/java-21-openjdk-amd64',
      PATH: `/usr/bin:/usr/local/bin:/usr/lib/jvm/java-21-openjdk-amd64/bin:${process.env.PATH || ''}`,
    };

    // Log what patches will run
    const flagList = [];
    if (options.flutter)      flagList.push('Flutter SSL (-f)');
    if (options.pairip_corex) flagList.push('Pairip + CoreX (-p -x)');
    else if (options.pairip)  flagList.push('Pairip (-p)');
    if (options.spoof_pkg)    flagList.push('Spoof PKG (-pkg)');
    if (options.remove_ads)   flagList.push('Remove Ads (-rmads)');
    if (options.remove_ss)    flagList.push('Screenshot Bypass (-rmss)');
    if (options.remove_usb)   flagList.push('USB Debug Bypass (-rmusb)');
    if (options.random_info)  flagList.push('Random Device Info (-r)');
    if (options.purchase)     flagList.push('Purchase Bypass (-P)');
    if (options.tg_patch)     flagList.push('Telegram Patch (-t)');
    if (options.android_id)   flagList.push(`Android ID: ${options.android_id}`);

    onLog({ level: 'step', text: `Memulai ApkPatcher...` });
    onLog({ level: 'info', text: `APK: ${path.basename(apkPath)}` });
    onLog({ level: 'info', text: `Patches: ${flagList.length ? flagList.join(' | ') : '(none selected)'}` });
    onLog({ level: 'step', text: 'Decompiling APK dengan Apktool... (bisa 30–90 detik)' });

    const proc = spawn('python3', [scriptFile, payload], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let lineBuffer = '';
    let resultEntry = null;
    let finished = false;

    const processLine = (raw) => {
      const line = raw.trim();
      if (!line) return;

      // Check for result sentinel
      if (line.startsWith('{') && line.includes('__result__')) {
        try {
          resultEntry = JSON.parse(line);
          return;
        } catch {}
      }

      // Try parsing as structured log from runner
      if (line.startsWith('{') && line.includes('"level"')) {
        try {
          const entry = JSON.parse(line);
          if (entry.level && entry.text) {
            const clean = stripAnsi(entry.text);
            if (clean && !SKIP_RE.test(clean)) {
              onLog({ level: entry.level, text: clean });
            }
            return;
          }
        } catch {}
      }

      // Plain text line
      const clean = stripAnsi(line);
      if (!clean || SKIP_RE.test(clean)) return;

      // Classify
      const low = clean.toLowerCase();
      let level = 'info';
      if (/error|exception|traceback|failed|not found|errno/i.test(clean)) level = 'error';
      else if (/warning|warn/i.test(clean)) level = 'warn';
      else if (/success|patched|done|complete|finish/i.test(clean)) level = 'success';
      else if (/decompil|recompil|smali|patch|sign|build|analy|apktool/i.test(clean)) level = 'step';
      onLog({ level, text: clean });
    };

    const onData = (chunk) => {
      lineBuffer += chunk.toString('utf8');
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop(); // keep incomplete last line
      for (const l of lines) processLine(l);
    };

    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData); // stderr also merged

    proc.on('error', (err) => {
      finished = true;
      try { fs.unlinkSync(scriptFile); } catch {}
      onLog({ level: 'error', text: `Gagal menjalankan Python: ${err.message}` });
      resolve({ success: false, error: err.message });
    });

    proc.on('close', (code) => {
      if (finished) return;
      finished = true;

      // Flush remaining buffer
      if (lineBuffer.trim()) processLine(lineBuffer);
      lineBuffer = '';

      try { fs.unlinkSync(scriptFile); } catch {}

      const success = resultEntry ? Boolean(resultEntry.__result__) : (code === 0 && fs.existsSync(outputPath));

      if (success) {
        onLog({ level: 'success', text: 'APK berhasil di-patch!' });
        resolve({ success: true });
      } else {
        const reason = resultEntry?.reason || `exit code ${code}`;
        onLog({ level: 'error', text: `Patch gagal (${reason}). Pastikan APK valid dan pilihan patch sesuai.` });
        resolve({ success: false, error: reason });
      }
    });

    // Safety timeout — kill if hung >8 minutes
    const killTimer = setTimeout(() => {
      if (!finished) {
        finished = true;
        try { proc.kill('SIGKILL'); } catch {}
        onLog({ level: 'error', text: 'Proses dihentikan paksa (timeout 8 menit).' });
        resolve({ success: false, error: 'timeout' });
      }
    }, 8 * 60 * 1000);

    proc.on('close', () => clearTimeout(killTimer));
  });
}

module.exports = { patchApk, detectApkType };
