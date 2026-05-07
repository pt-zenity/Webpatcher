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

// ── Directories ──────────────────────────────────────────────────────────────
const UPLOAD_DIR  = path.join(__dirname, 'uploads');
const OUTPUT_DIR  = path.join(__dirname, 'outputs');
[UPLOAD_DIR, OUTPUT_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Multer: .so / .bin files (Flutter SSL) ───────────────────────────────────
const storageSo = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => cb(null, `${uuidv4()}_${file.originalname}`),
});
const uploadSo = multer({
  storage: storageSo,
  limits: { fileSize: 150 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(so|bin)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only .so or .bin files are allowed'), ok);
  },
});

// ── Multer: APK files ────────────────────────────────────────────────────────
const storageApk = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => cb(null, `${uuidv4()}_${file.originalname}`),
});
const uploadApk = multer({
  storage: storageApk,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
  fileFilter: (req, file, cb) => {
    const ok = /\.(apk|xapk|apkm|apks)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only .apk, .xapk, .apkm, .apks files are allowed'), ok);
  },
});

// ── Active jobs for SSE streaming ────────────────────────────────────────────
const activeJobs = new Map(); // jobId → { logs: [], done: bool, clients: Set }

// ── Auto-cleanup (files older than 60 min) ───────────────────────────────────
function cleanup() {
  const MAX_AGE = 60 * 60 * 1000;
  const now = Date.now();
  [UPLOAD_DIR, OUTPUT_DIR].forEach(dir => {
    try {
      fs.readdirSync(dir).forEach(f => {
        const fp = path.join(dir, f);
        try {
          if (now - fs.statSync(fp).mtimeMs > MAX_AGE) fs.unlinkSync(fp);
        } catch {}
      });
    } catch {}
  });
  // Clean old jobs
  for (const [id, job] of activeJobs.entries()) {
    if (job.done && job.createdAt && (now - job.createdAt) > MAX_AGE) {
      activeJobs.delete(id);
    }
  }
}
setInterval(cleanup, 10 * 60 * 1000);

// ════════════════════════════════════════════════════════════════════════════
//  FLUTTER SSL PATCH ROUTES
// ════════════════════════════════════════════════════════════════════════════

// POST /api/patch  — patch libflutter.so
app.post('/api/patch', uploadSo.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const forcedArch = req.body.arch && req.body.arch !== 'auto' ? req.body.arch : null;
  const printOnly  = req.body.printOnly === 'true';
  const log        = [];

  try {
    const inputBuf = fs.readFileSync(req.file.path);
    log.push({ level: 'info', text: `File: ${req.file.originalname} (${(inputBuf.length / 1024 / 1024).toFixed(2)} MB)` });

    const result = patchBinary(inputBuf, forcedArch, log);
    try { fs.unlinkSync(req.file.path); } catch {}

    if (!result.success) return res.json({ success: false, log: result.log });

    if (printOnly) return res.json({ success: true, printOnly: true, log: result.log, meta: result.meta });

    const jobId      = uuidv4();
    const outName    = req.file.originalname.replace(/\.so$/i, '_patched.so');
    const outputPath = path.join(OUTPUT_DIR, `${jobId}_${outName}`);
    fs.writeFileSync(outputPath, result.patchedBuf);
    setTimeout(() => { try { fs.unlinkSync(outputPath); } catch {} }, 20 * 60 * 1000);

    return res.json({
      success: true, printOnly: false, log: result.log, meta: result.meta,
      downloadId: jobId, filename: outName, sizeBytes: result.patchedBuf.length,
    });
  } catch (err) {
    try { fs.unlinkSync(req.file.path); } catch {}
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/detect  — detect arch of .so
app.post('/api/detect', uploadSo.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const buf    = fs.readFileSync(req.file.path);
    const result = detectArch(buf);
    try { fs.unlinkSync(req.file.path); } catch {}
    return res.json({ ...result, size: buf.length });
  } catch (err) {
    try { fs.unlinkSync(req.file.path); } catch {}
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/download/:id  — download patched file
app.get('/api/download/:id', (req, res) => {
  const { id } = req.params;
  if (!/^[a-f0-9-]+$/i.test(id)) return res.status(400).json({ error: 'Invalid ID' });

  const files = fs.readdirSync(OUTPUT_DIR).filter(f => f.startsWith(id + '_'));
  if (!files.length) return res.status(404).json({ error: 'File not found or expired' });

  const fullPath = path.join(OUTPUT_DIR, files[0]);
  const outName  = files[0].replace(`${id}_`, '');
  res.download(fullPath, outName, err => {
    if (!err) { try { fs.unlinkSync(fullPath); } catch {} }
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  APK PATCHER ROUTES
// ════════════════════════════════════════════════════════════════════════════

// POST /api/apk/scan  — scan APK (detect Flutter, Pairip, pkg name)
app.post('/api/apk/scan', uploadApk.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No APK uploaded' });
  try {
    const info = await detectApkType(req.file.path);
    // Keep the file for patching — return a temp token
    const token = uuidv4();
    // Move to outputs with token so user can ref it
    const destPath = path.join(UPLOAD_DIR, `${token}_${req.file.originalname}`);
    fs.renameSync(req.file.path, destPath);
    setTimeout(() => { try { fs.unlinkSync(destPath); } catch {} }, 60 * 60 * 1000);

    return res.json({
      success: true,
      token,
      filename: req.file.originalname,
      size: req.file.size,
      ...info,
    });
  } catch (err) {
    try { fs.unlinkSync(req.file.path); } catch {}
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/apk/patch  — start APK patch job (returns jobId, streams via SSE)
app.post('/api/apk/patch', (req, res) => {
  const { token, filename, options } = req.body;
  if (!token || !filename) return res.status(400).json({ error: 'token and filename required' });
  if (!/^[a-f0-9-]+$/i.test(token)) return res.status(400).json({ error: 'Invalid token' });

  const apkFiles = fs.readdirSync(UPLOAD_DIR).filter(f => f.startsWith(token + '_'));
  if (!apkFiles.length) return res.status(404).json({ error: 'APK not found or expired. Please re-upload.' });

  const apkPath = path.join(UPLOAD_DIR, apkFiles[0]);
  const jobId   = uuidv4();
  const outName = apkFiles[0].replace(`${token}_`, '').replace(/\.apk$/i, '_Patched.apk');
  const outputPath = path.join(OUTPUT_DIR, `${jobId}_${outName}`);

  const job = { logs: [], done: false, success: false, downloadId: null, filename: outName, clients: new Set(), createdAt: Date.now() };
  activeJobs.set(jobId, job);

  res.json({ success: true, jobId });

  // Run async
  const onLog = (entry) => {
    job.logs.push(entry);
    job.clients.forEach(send => send(entry));
  };

  patchApk(apkPath, outputPath, options || {}, onLog)
    .then(result => {
      job.done    = true;
      job.success = result.success;
      if (result.success && fs.existsSync(outputPath)) {
        job.downloadId = jobId;
        setTimeout(() => { try { fs.unlinkSync(outputPath); } catch {} }, 30 * 60 * 1000);
      }
      try { fs.unlinkSync(apkPath); } catch {}
      const final = result.success
        ? { level: 'success', text: `✅ Selesai! File siap didownload.` }
        : { level: 'error',   text: `❌ Patch gagal. ${result.error || ''}` };
      onLog(final);
      onLog({ level: '__done__', success: result.success, downloadId: result.success ? jobId : null, filename: outName });
    })
    .catch(err => {
      job.done = true;
      onLog({ level: 'error', text: `Fatal: ${err.message}` });
      onLog({ level: '__done__', success: false });
    });
});

// GET /api/apk/status/:jobId  — SSE stream for job logs
app.get('/api/apk/status/:jobId', (req, res) => {
  const { jobId } = req.params;
  if (!/^[a-f0-9-]+$/i.test(jobId)) return res.status(400).end();

  const job = activeJobs.get(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (entry) => {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  };

  // Send existing logs first
  job.logs.forEach(send);

  if (job.done) {
    send({ level: '__done__', success: job.success, downloadId: job.downloadId, filename: job.filename });
    return res.end();
  }

  // Register client
  job.clients.add(send);
  req.on('close', () => { job.clients.delete(send); });
});

// GET /api/apk/download/:jobId
app.get('/api/apk/download/:jobId', (req, res) => {
  const { jobId } = req.params;
  if (!/^[a-f0-9-]+$/i.test(jobId)) return res.status(400).json({ error: 'Invalid ID' });

  const files = fs.readdirSync(OUTPUT_DIR).filter(f => f.startsWith(jobId + '_'));
  if (!files.length) return res.status(404).json({ error: 'File not found or expired' });

  const fullPath = path.join(OUTPUT_DIR, files[0]);
  const outName  = files[0].replace(`${jobId}_`, '');
  res.download(fullPath, outName, err => {
    if (!err) { try { fs.unlinkSync(fullPath); } catch {} }
  });
});

// ── Health ───────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status:  'ok',
    version: '3.0.0',
    node:    process.version,
    uptime:  Math.floor(process.uptime()),
    tools:   { java: true, apktool: true, aapt: true, python3: true },
  });
});

// ── Catch-all → index.html ───────────────────────────────────────────────────
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🛡️  APK Patch Suite  →  http://0.0.0.0:${PORT}`);
  console.log(`   Node ${process.version}  |  Express 5  |  Multer 2  |  UUID 14`);
});
