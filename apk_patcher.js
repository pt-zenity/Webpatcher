'use strict';

/**
 * APK Patcher Bridge (Node.js → Python ApkPatcher)
 * Wraps TechnoIndian/ApkPatcher via Python subprocess
 */

const { execFile, spawn } = require('child_process');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');

// ── Python helper script (written to tmp at runtime) ────────────────────────
const PYTHON_RUNNER = `
import sys, os, json, subprocess, tempfile, shutil, time, threading
from pathlib import Path

def run_apk_patcher(apk_path, options, output_path):
    """Run ApkPatcher via subprocess and capture output"""
    args = ['python3', '-c', '''
import sys
sys.path.insert(0, "/usr/local/lib/python3.12/site-packages")
from ApkPatcher.APK_PATCHER import RK_Techno_IND
''']

    # Build command
    cmd = ['python3', '-m', 'ApkPatcher', '-i', apk_path]

    if options.get('flutter'):    cmd.append('-f')
    if options.get('pairip'):     cmd.append('-p')
    if options.get('pairip_corex'): cmd.extend(['-p', '-x'])
    if options.get('spoof_pkg'):  cmd.append('-pkg')
    if options.get('remove_ads'): cmd.append('-rmads')
    if options.get('remove_ss'):  cmd.append('-rmss')
    if options.get('remove_usb'): cmd.append('-rmusb')
    if options.get('random_info'):cmd.append('-r')
    if options.get('purchase'):   cmd.append('-P')
    if options.get('tg_patch'):   cmd.append('-t')
    if options.get('android_id'):
        cmd.extend(['-D', options['android_id']])
    if options.get('skip_patch'):
        for m in options['skip_patch']:
            cmd.extend(['-skip', m])

    env = os.environ.copy()
    env['PYTHONUNBUFFERED'] = '1'
    env['JAVA_HOME'] = '/usr/lib/jvm/java-21-openjdk-amd64'
    env['PATH'] = '/usr/bin:/usr/local/bin:' + env.get('PATH','')

    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=600,
        env=env
    )

    # Find output APK
    base = os.path.splitext(os.path.basename(apk_path))[0]
    apk_dir = os.path.dirname(apk_path)
    patched = os.path.join(apk_dir, base + '_Patched.apk')

    if not os.path.exists(patched):
        patched = os.path.join(apk_dir, base + '_Patch.apk')

    if os.path.exists(patched):
        shutil.move(patched, output_path)
        ok = True
    else:
        ok = False

    # Clean decompile dir
    decomp = os.path.join(os.path.expanduser('~'), base + '_decompiled')
    if os.path.exists(decomp):
        shutil.rmtree(decomp, ignore_errors=True)

    print(json.dumps({
        'success': ok,
        'stdout': result.stdout[-8000:] if result.stdout else '',
        'stderr': result.stderr[-4000:] if result.stderr else '',
        'returncode': result.returncode
    }))

import json, sys
data = json.loads(sys.argv[1])
run_apk_patcher(data['apk_path'], data['options'], data['output_path'])
`;

// ── Detect APK contents (Flutter / Pairip) via pure Node ────────────────────
function detectApkType(apkPath) {
  return new Promise((resolve) => {
    // Use Python to check zip entries
    const code = `
import zipfile, json, sys
try:
    z = zipfile.ZipFile(sys.argv[1])
    names = z.namelist()
    flutter  = any('libflutter.so' in n for n in names)
    pairip   = any('libpairip' in n.lower() for n in names)
    pkg = ''
    try:
        import subprocess
        r = subprocess.run(['aapt', 'dump', 'badging', sys.argv[1]],
            capture_output=True, text=True, timeout=15)
        for line in r.stdout.splitlines():
            if line.startswith("package:"):
                pkg = line.split("name='")[1].split("'")[0]
                break
    except: pass
    print(json.dumps({'flutter':flutter,'pairip':pairip,'pkg':pkg,'files':len(names)}))
except Exception as e:
    print(json.dumps({'error':str(e),'flutter':False,'pairip':False,'pkg':'','files':0}))
`;
    execFile('python3', ['-c', code, apkPath], { timeout: 20000 }, (err, stdout) => {
      try { resolve(JSON.parse(stdout.trim())); }
      catch { resolve({ flutter: false, pairip: false, pkg: '', files: 0 }); }
    });
  });
}

// ── Run ApkPatcher ────────────────────────────────────────────────────────────
function patchApk(apkPath, outputPath, options, onLog) {
  return new Promise((resolve) => {
    const scriptFile = path.join(os.tmpdir(), `apkpatcher_${Date.now()}.py`);
    fs.writeFileSync(scriptFile, PYTHON_RUNNER);

    const payload = JSON.stringify({ apk_path: apkPath, options, output_path: outputPath });

    const env = {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      JAVA_HOME: '/usr/lib/jvm/java-21-openjdk-amd64',
      PATH: `/usr/bin:/usr/local/bin:${process.env.PATH || ''}`,
    };

    onLog({ level: 'step', text: 'Menjalankan ApkPatcher...' });
    onLog({ level: 'info', text: `APK: ${path.basename(apkPath)}` });

    const flagList = [];
    if (options.flutter)     flagList.push('Flutter SSL (-f)');
    if (options.pairip)      flagList.push('Pairip (-p)');
    if (options.pairip_corex) flagList.push('Pairip CoreX (-p -x)');
    if (options.spoof_pkg)   flagList.push('Spoof PKG (-pkg)');
    if (options.remove_ads)  flagList.push('Remove Ads (-rmads)');
    if (options.remove_ss)   flagList.push('Remove Screenshot (-rmss)');
    if (options.remove_usb)  flagList.push('Remove USB Debug (-rmusb)');
    if (options.random_info) flagList.push('Random Device Info (-r)');
    if (options.purchase)    flagList.push('Purchase Bypass (-P)');
    if (options.tg_patch)    flagList.push('Telegram Patch (-t)');
    if (options.android_id)  flagList.push(`Android ID: ${options.android_id}`);
    onLog({ level: 'info', text: `Patches: ${flagList.join(', ') || 'none'}` });

    onLog({ level: 'step', text: 'Decompiling APK dengan Apktool...' });

    const proc = spawn('python3', [scriptFile, payload], { env, timeout: 600000 });

    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => {
      stderr += d.toString();
      // stream meaningful lines
      d.toString().split('\n').forEach(line => {
        const l = line.trim();
        if (l && !l.includes('ANSI') && !l.includes('\x1b[')) {
          const clean = l.replace(/\x1b\[[0-9;]*m/g, '').trim();
          if (clean) onLog({ level: 'info', text: clean });
        }
      });
    });

    proc.on('close', (code) => {
      try { fs.unlinkSync(scriptFile); } catch {}
      try {
        const result = JSON.parse(stdout.trim());
        // Parse stdout lines as logs
        (result.stdout || '').split('\n').forEach(line => {
          const l = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
          if (l) onLog({ level: 'info', text: l });
        });
        if (result.success) {
          onLog({ level: 'success', text: 'APK berhasil di-patch!' });
          resolve({ success: true });
        } else {
          onLog({ level: 'error', text: 'Patch gagal. Lihat log di atas.' });
          if (result.stderr) onLog({ level: 'warn', text: result.stderr.slice(0, 500) });
          resolve({ success: false, error: 'Patch failed' });
        }
      } catch (e) {
        onLog({ level: 'error', text: `Parse error: ${e.message}` });
        onLog({ level: 'warn', text: stderr.slice(0, 1000) });
        resolve({ success: false, error: e.message });
      }
    });

    proc.on('error', (err) => {
      try { fs.unlinkSync(scriptFile); } catch {}
      onLog({ level: 'error', text: `Process error: ${err.message}` });
      resolve({ success: false, error: err.message });
    });
  });
}

module.exports = { patchApk, detectApkType };
