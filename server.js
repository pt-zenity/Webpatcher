'use strict';

const express  = require('express');
const multer   = require('multer');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');
const { v4: uuidv4 } = require('uuid');
const { patchBinary, detectArch } = require('./patcher');

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

// ── Multer (file upload) ─────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => cb(null, `${uuidv4()}_${file.originalname}`),
});

const upload = multer({
  storage,
  limits: { fileSize: 150 * 1024 * 1024 }, // 150 MB
  fileFilter: (req, file, cb) => {
    const ok = file.originalname.endsWith('.so') || file.originalname.endsWith('.bin');
    cb(ok ? null : new Error('Only .so or .bin files are allowed'), ok);
  },
});

// ── Auto-cleanup (delete files older than 30 min) ────────────────────────────
function cleanup() {
  const MAX_AGE = 30 * 60 * 1000;
  const now = Date.now();
  [UPLOAD_DIR, OUTPUT_DIR].forEach(dir => {
    try {
      fs.readdirSync(dir).forEach(f => {
        const fp = path.join(dir, f);
        if (now - fs.statSync(fp).mtimeMs > MAX_AGE) fs.unlinkSync(fp);
      });
    } catch {}
  });
}
setInterval(cleanup, 5 * 60 * 1000);

// ════════════════════════════════════════════════════════════════════════════
//  API Routes
// ════════════════════════════════════════════════════════════════════════════

// ── POST /api/patch ──────────────────────────────────────────────────────────
app.post('/api/patch', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const forcedArch = req.body.arch && req.body.arch !== 'auto' ? req.body.arch : null;
  const printOnly  = req.body.printOnly === 'true';
  const log        = [];

  try {
    const inputBuf = fs.readFileSync(req.file.path);
    log.push({ level: 'info', text: `File: ${req.file.originalname} (${(inputBuf.length / 1024 / 1024).toFixed(2)} MB)` });

    const result = patchBinary(inputBuf, forcedArch, log);

    // Clean up uploaded file
    try { fs.unlinkSync(req.file.path); } catch {}

    if (!result.success) {
      return res.json({ success: false, log: result.log });
    }

    if (printOnly) {
      return res.json({ success: true, printOnly: true, log: result.log, meta: result.meta });
    }

    // Save patched binary
    const jobId      = uuidv4();
    const outName    = req.file.originalname.replace('.so', '_patched.so');
    const outputPath = path.join(OUTPUT_DIR, `${jobId}_${outName}`);
    fs.writeFileSync(outputPath, result.patchedBuf);

    // Schedule deletion after 15 min
    setTimeout(() => { try { fs.unlinkSync(outputPath); } catch {} }, 15 * 60 * 1000);

    return res.json({
      success:    true,
      printOnly:  false,
      log:        result.log,
      meta:       result.meta,
      downloadId: jobId,
      filename:   outName,
      sizeBytes:  result.patchedBuf.length,
    });

  } catch (err) {
    try { fs.unlinkSync(req.file.path); } catch {}
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/download/:id ────────────────────────────────────────────────────
app.get('/api/download/:id', (req, res) => {
  const { id } = req.params;
  // Security: only alphanumeric + dash
  if (!/^[a-f0-9-]+$/i.test(id)) return res.status(400).json({ error: 'Invalid ID' });

  const files = fs.readdirSync(OUTPUT_DIR).filter(f => f.startsWith(id + '_'));
  if (!files.length) return res.status(404).json({ error: 'File not found or expired' });

  const fullPath = path.join(OUTPUT_DIR, files[0]);
  const outName  = files[0].replace(`${id}_`, '');
  res.download(fullPath, outName, err => {
    if (!err) { try { fs.unlinkSync(fullPath); } catch {} }
  });
});

// ── GET /api/detect ──────────────────────────────────────────────────────────
app.post('/api/detect', upload.single('file'), (req, res) => {
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

// ── GET /api/health ──────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status:  'ok',
    version: '2.0.0',
    node:    process.version,
    uptime:  Math.floor(process.uptime()),
  });
});

// ── Catch-all → index.html ───────────────────────────────────────────────────
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🛡️  Flutter SSL Patch Tool  →  http://0.0.0.0:${PORT}`);
  console.log(`   Node ${process.version}  |  Express 5  |  Multer 2  |  UUID 14`);
});
