'use strict';

const express  = require('express');
const multer   = require('multer');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');
const { v4: uuidv4 } = require('uuid');
const { patchBinary, detectArch } = require('./patcher');
const { patchApk, detectApkType } = require('./apk_patcher');

const app  = express();
const PORT = 3000;

// ── Directories ───────────────────────────────────────────────────────────────
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'outputs');
[UPLOAD_DIR, OUTPUT_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Multer: .so / .bin ────────────────────────────────────────────────────────
const uploadSo = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename:    (req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `${uuidv4()}_${safe}`);
    },
  }),
  limits: { fileSize: 150 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (/\.(so|bin)$/i.test(file.originalname)) cb(null, true);
    else cb(Object.assign(new Error('Only .so or .bin files allowed'), { code: 'INVALID_TYPE' }));
  },
});

// ── Multer: APK ───────────────────────────────────────────────────────────────
const uploadApk = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename:    (req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `${uuidv4()}_${safe}`);
    },
  }),
  limits: { fileSize: 500 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (/\.(apk|xapk|apkm|apks)$/i.test(file.originalname)) cb(null, true);
    else cb(Object.assign(new Error('Only .apk/.xapk/.apkm/.apks files allowed'), { code: 'INVALID_TYPE' }));
  },
});

// ── Multer error handler helper ───────────────────────────────────────────────
function handleMulterError(err, res) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File terlalu besar. Maksimum ukuran file terlampaui.' });
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }
  if (err && err.code === 'INVALID_TYPE') return res.status(400).json({ error: err.message });
  if (err) return res.status(500).json({ error: err.message });
}

// ── Active jobs (SSE) ─────────────────────────────────────────────────────────
// jobId → { logs:[], done:bool, success:bool, downloadId:string|null,
//            filename:string, clients:Set<fn>, createdAt:number }
const activeJobs = new Map();

// ── Heartbeat to keep SSE alive through proxies ───────────────────────────────
setInterval(() => {
  for (const [, job] of activeJobs) {
    if (!job.done) {
      job.clients.forEach(send => {
        try { send({ level: '__ping__' }); } catch {}
      });
    }
  }
}, 15000);

// ── Auto-cleanup ──────────────────────────────────────────────────────────────
function cleanup() {
  const MAX_AGE = 60 * 60 * 1000; // 1 hour
  const now = Date.now();
  for (const dir of [UPLOAD_DIR, OUTPUT_DIR]) {
    try {
      for (const f of fs.readdirSync(dir)) {
        const fp = path.join(dir, f);
        try { if (now - fs.statSync(fp).mtimeMs > MAX_AGE) fs.unlinkSync(fp); } catch {}
      }
    } catch {}
  }
  for (const [id, job] of activeJobs.entries()) {
    if (job.done && (now - job.createdAt) > MAX_AGE) activeJobs.delete(id);
  }
}
setInterval(cleanup, 10 * 60 * 1000);

// ═════════════════════════════════════════════════════════════════════════════
//  FLUTTER SSL PATCH
// ═════════════════════════════════════════════════════════════════════════════

// POST /api/patch
app.post('/api/patch', (req, res) => {
  uploadSo.single('file')(req, res, (err) => {
    if (err) return handleMulterError(err, res);
    if (!req.file) return res.status(400).json({ error: 'Tidak ada file yang diupload.' });

    const forcedArch = (req.body.arch && req.body.arch !== 'auto') ? req.body.arch : null;
    const printOnly  = req.body.printOnly === 'true';
    const log        = [];

    try {
      const inputBuf = fs.readFileSync(req.file.path);
      log.push({ level: 'info', text: `File: ${req.file.originalname} (${(inputBuf.length / 1024 / 1024).toFixed(2)} MB)` });

      const result = patchBinary(inputBuf, forcedArch, log);
      try { fs.unlinkSync(req.file.path); } catch {}

      if (!result.success) return res.json({ success: false, log: result.log });
      if (printOnly)        return res.json({ success: true, printOnly: true, log: result.log, meta: result.meta });

      const jobId      = uuidv4();
      const outName    = req.file.originalname.replace(/\.so$/i, '_patched.so').replace(/\.bin$/i, '_patched.bin');
      const outputPath = path.join(OUTPUT_DIR, `${jobId}_${outName}`);
      fs.writeFileSync(outputPath, result.patchedBuf);
      setTimeout(() => { try { fs.unlinkSync(outputPath); } catch {} }, 20 * 60 * 1000);

      return res.json({ success: true, printOnly: false, log: result.log, meta: result.meta,
        downloadId: jobId, filename: outName, sizeBytes: result.patchedBuf.length });

    } catch (err2) {
      try { fs.unlinkSync(req.file.path); } catch {}
      console.error('[/api/patch]', err2);
      return res.status(500).json({ error: err2.message || 'Internal server error' });
    }
  });
});

// POST /api/detect
app.post('/api/detect', (req, res) => {
  uploadSo.single('file')(req, res, (err) => {
    if (err) return handleMulterError(err, res);
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    try {
      const buf    = fs.readFileSync(req.file.path);
      const result = detectArch(buf);
      try { fs.unlinkSync(req.file.path); } catch {}
      return res.json({ ...result, size: buf.length });
    } catch (err2) {
      try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(500).json({ error: err2.message });
    }
  });
});

// GET /api/download/:id
app.get('/api/download/:id', (req, res) => {
  const { id } = req.params;
  if (!/^[a-f0-9-]{36}$/i.test(id)) return res.status(400).json({ error: 'Invalid download ID' });

  let files;
  try { files = fs.readdirSync(OUTPUT_DIR).filter(f => f.startsWith(id + '_')); }
  catch { return res.status(500).json({ error: 'Storage error' }); }
  if (!files.length) return res.status(404).json({ error: 'File tidak ditemukan atau sudah expired (20 menit).' });

  const fullPath = path.join(OUTPUT_DIR, files[0]);
  const outName  = files[0].slice(id.length + 1);
  res.download(fullPath, outName, (dlErr) => {
    if (!dlErr) { try { fs.unlinkSync(fullPath); } catch {} }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  APK PATCHER
// ═════════════════════════════════════════════════════════════════════════════

// POST /api/apk/scan
app.post('/api/apk/scan', (req, res) => {
  uploadApk.single('file')(req, res, async (err) => {
    if (err) return handleMulterError(err, res);
    if (!req.file) return res.status(400).json({ error: 'Tidak ada APK yang diupload.' });

    try {
      const info     = await detectApkType(req.file.path);
      const token    = uuidv4();
      const destPath = path.join(UPLOAD_DIR, `${token}_${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`);
      fs.renameSync(req.file.path, destPath);
      setTimeout(() => { try { fs.unlinkSync(destPath); } catch {} }, 60 * 60 * 1000);

      return res.json({ success: true, token,
        filename: req.file.originalname, size: req.file.size, ...info });
    } catch (err2) {
      try { fs.unlinkSync(req.file.path); } catch {}
      console.error('[/api/apk/scan]', err2);
      return res.status(500).json({ error: err2.message || 'Scan failed' });
    }
  });
});

// POST /api/apk/patch  — start async job, stream via SSE
app.post('/api/apk/patch', (req, res) => {
  const { token, filename, options } = req.body || {};

  if (!token || typeof token !== 'string' || !/^[a-f0-9-]{36}$/i.test(token))
    return res.status(400).json({ error: 'Token tidak valid.' });
  if (!filename || typeof filename !== 'string')
    return res.status(400).json({ error: 'Filename required.' });

  let apkFiles;
  try { apkFiles = fs.readdirSync(UPLOAD_DIR).filter(f => f.startsWith(token + '_')); }
  catch { return res.status(500).json({ error: 'Storage read error' }); }
  if (!apkFiles.length)
    return res.status(404).json({ error: 'APK tidak ditemukan atau sudah expired. Silakan upload ulang.' });

  const apkPath    = path.join(UPLOAD_DIR, apkFiles[0]);
  const jobId      = uuidv4();
  const safeOrig   = apkFiles[0].slice(token.length + 1);
  const outName    = safeOrig.replace(/\.(apk|xapk|apkm|apks)$/i, '_Patched.apk');
  const outputPath = path.join(OUTPUT_DIR, `${jobId}_${outName}`);

  const job = {
    logs: [], done: false, success: false,
    downloadId: null, filename: outName,
    clients: new Set(), createdAt: Date.now(),
  };
  activeJobs.set(jobId, job);

  // Respond immediately with jobId
  res.json({ success: true, jobId });

  const onLog = (entry) => {
    if (!entry || typeof entry !== 'object') return;
    job.logs.push(entry);
    job.clients.forEach(send => { try { send(entry); } catch {} });
  };

  patchApk(apkPath, outputPath, options || {}, onLog)
    .then(result => {
      job.done    = true;
      job.success = result.success;
      if (result.success && fs.existsSync(outputPath)) {
        job.downloadId = jobId;
        setTimeout(() => { try { fs.unlinkSync(outputPath); } catch {} }, 30 * 60 * 1000);
      }
      try { if (fs.existsSync(apkPath)) fs.unlinkSync(apkPath); } catch {}
      onLog(result.success
        ? { level: 'success', text: '✅ APK berhasil di-patch dan siap didownload!' }
        : { level: 'error',   text: `❌ Patch gagal. ${result.error || 'Lihat log di atas.'}` });
      onLog({ level: '__done__', success: result.success,
              downloadId: result.success ? jobId : null, filename: outName });
    })
    .catch(fatalErr => {
      job.done = true;
      console.error('[patchApk fatal]', fatalErr);
      onLog({ level: 'error', text: `Fatal error: ${fatalErr.message}` });
      onLog({ level: '__done__', success: false, downloadId: null, filename: outName });
    });
});

// GET /api/apk/status/:jobId  — SSE stream
app.get('/api/apk/status/:jobId', (req, res) => {
  const { jobId } = req.params;
  if (!/^[a-f0-9-]{36}$/i.test(jobId)) return res.status(400).end('Bad ID');

  const job = activeJobs.get(jobId);
  if (!job) return res.status(404).json({ error: 'Job tidak ditemukan.' });

  // SSE headers
  res.setHeader('Content-Type',  'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();

  const write = (entry) => {
    try {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
      if (res.flush) res.flush(); // compression flush if enabled
    } catch {}
  };

  // Replay buffered logs
  for (const entry of job.logs) write(entry);

  // If job is already done, close immediately
  if (job.done) {
    write({ level: '__done__', success: job.success,
            downloadId: job.downloadId, filename: job.filename });
    return res.end();
  }

  // Subscribe to live events
  job.clients.add(write);

  // Clean up on disconnect
  const cleanup = () => {
    job.clients.delete(write);
    try { res.end(); } catch {}
  };
  req.on('close',   cleanup);
  req.on('error',   cleanup);
  res.on('error',   cleanup);
});

// GET /api/apk/download/:jobId
app.get('/api/apk/download/:jobId', (req, res) => {
  const { jobId } = req.params;
  if (!/^[a-f0-9-]{36}$/i.test(jobId)) return res.status(400).json({ error: 'Invalid ID' });

  let files;
  try { files = fs.readdirSync(OUTPUT_DIR).filter(f => f.startsWith(jobId + '_')); }
  catch { return res.status(500).json({ error: 'Storage error' }); }
  if (!files.length) return res.status(404).json({ error: 'File tidak ditemukan atau sudah expired (30 menit).' });

  const fullPath = path.join(OUTPUT_DIR, files[0]);
  const outName  = files[0].slice(jobId.length + 1);
  res.download(fullPath, outName, (dlErr) => {
    if (!dlErr) { try { fs.unlinkSync(fullPath); } catch {} }
  });
});

// GET /api/apk/job/:jobId  — poll job status (fallback for browsers without SSE)
app.get('/api/apk/job/:jobId', (req, res) => {
  const { jobId } = req.params;
  if (!/^[a-f0-9-]{36}$/i.test(jobId)) return res.status(400).json({ error: 'Invalid ID' });
  const job = activeJobs.get(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ done: job.done, success: job.success,
             downloadId: job.downloadId, filename: job.filename,
             logCount: job.logs.length,
             logs: job.logs.slice(-50) }); // last 50 entries for poll
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '3.1.0', node: process.version,
             uptime: Math.floor(process.uptime()),
             tools: { java: true, apktool: true, aapt: true, python3: true } });
});

// ── Global error middleware ───────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[unhandled]', err);
  if (!res.headersSent) res.status(500).json({ error: err.message || 'Unexpected error' });
});

// ── Catch-all SPA ─────────────────────────────────────────────────────────────
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🛡️  APK Patch Suite v3.1  →  http://0.0.0.0:${PORT}`);
  console.log(`   Node ${process.version} | Express 5 | Multer 2 | UUID 14`);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('SIGINT',  () => { cleanup(); process.exit(0); });
process.on('uncaughtException',  e => console.error('[uncaughtException]', e));
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));
