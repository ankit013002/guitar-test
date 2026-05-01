"use strict";

const express = require("express");
const multer = require("multer");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn, spawnSync } = require("child_process");
const { randomUUID } = require("crypto");

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: ["http://localhost:5173", "http://localhost:3001"] }));
app.use(express.json());

// Health check – also used by tests to detect server readiness
app.get("/api/health", (_req, res) =>
  res.json({ ok: true, python: PYTHON || null }),
);

// Detect Python once at startup (GUITAR_PYTHON env var overrides auto-detection)
let PYTHON = process.env.GUITAR_PYTHON || null;
if (!PYTHON) {
  for (const bin of ["python3", "python", "py"]) {
    if (
      spawnSync(bin, ["-c", "import numpy"], { stdio: "pipe" }).status === 0
    ) {
      PYTHON = bin;
      break;
    }
  }
}
if (!PYTHON) console.warn("[WARN] Python 3 not found – API calls will fail.");
else console.log(`[INFO] Python binary: ${PYTHON}`);

// Script path (GUITAR_SCRIPT env var allows substituting a mock for testing)
const AUDIO_SCRIPT =
  process.env.GUITAR_SCRIPT || path.join(__dirname, "audio_processor.py");

// ---------------------------------------------------------------------------
// Job store
// ---------------------------------------------------------------------------

/** @typedef {{ id:string, dir:string, createdAt:number, inputFile:string, outputWav:string,
 *   outputJson:string, outputMidi:string|null, outputPng:string, genSpec:boolean,
 *   status:'running'|'done'|'error', progress:object[], clients:Set<any>,
 *   analyzeResult:object|null, correctResult:object|null, analysis:object|null }} Job */

/** @type {Map<string, Job>} */
const jobs = new Map();

// Purge jobs older than 1 hour every 30 minutes
setInterval(
  () => {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [id, job] of jobs) {
      if (job.createdAt < cutoff) {
        try {
          fs.rmSync(job.dir, { recursive: true, force: true });
        } catch {}
        jobs.delete(id);
      }
    }
  },
  30 * 60 * 1000,
).unref();

// ---------------------------------------------------------------------------
// Multer  –  create per-job temp dir BEFORE multer processes the upload
// ---------------------------------------------------------------------------

app.use("/api/fix", (req, _res, next) => {
  req.jobId = randomUUID();
  req.jobDir = path.join(os.tmpdir(), `guitar-${req.jobId}`);
  fs.mkdirSync(req.jobDir, { recursive: true });
  next();
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => cb(null, req.jobDir),
    filename: (_req, file, cb) => cb(null, file.originalname),
  }),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB
  fileFilter: (_req, file, cb) => {
    if (/\.(wav|mp3|flac|ogg|m4a|aiff?)$/i.test(file.originalname))
      cb(null, true);
    else cb(new Error("Only audio files are accepted"));
  },
});

// ---------------------------------------------------------------------------
// POST /api/fix  –  upload + kick off Python fix in background
// ---------------------------------------------------------------------------

app.post("/api/fix", upload.single("audio"), (req, res) => {
  if (!req.file)
    return res.status(400).json({ error: "No audio file provided" });
  if (!PYTHON)
    return res.status(500).json({ error: "Python 3 not found on this server" });

  const jobId = req.jobId;
  const jobDir = req.jobDir;
  const base = path.basename(
    req.file.originalname,
    path.extname(req.file.originalname),
  );
  const body = req.body;

  const inputFile = req.file.path;
  const outputWav = path.join(jobDir, `${base}_corrected.wav`);
  const outputJson = path.join(jobDir, `${base}_analysis.json`);
  const outputMidi =
    body.exportMidi === "true" ? path.join(jobDir, `${base}.mid`) : null;
  const outputPng = path.join(jobDir, `${base}_spectrogram.png`);
  const genSpec = body.spectrogram === "true";
  const aggrParsed = parseFloat(body.aggressiveness ?? "0.8");
  const aggr = Math.max(0, Math.min(1, isNaN(aggrParsed) ? 0.8 : aggrParsed));
  const smoothVib = body.smoothVibrato === "true";
  const validModes = ["auto", "mono", "chord"];
  const mode = validModes.includes(body.mode) ? body.mode : "auto";

  /** @type {Job} */
  const job = {
    id: jobId,
    dir: jobDir,
    createdAt: Date.now(),
    inputFile,
    outputWav,
    outputJson,
    outputMidi,
    outputPng,
    genSpec,
    aggr,
    smoothVib,
    status: "running",
    progress: [],
    clients: new Set(),
    analyzeResult: null,
    correctResult: null,
    analysis: null,
  };
  jobs.set(jobId, job);

  // Respond immediately with the job ID – client subscribes to SSE for updates
  res.json({ jobId });

  // ── Run Python in background ─────────────────────────────────────────────
  const pyArgs = [
    AUDIO_SCRIPT,
    "fix",
    inputFile,
    "--output",
    outputWav,
    "--output-analysis",
    outputJson,
    "--aggressiveness",
    String(aggr),
    ...(outputMidi ? ["--output-midi", outputMidi] : []),
    ...(smoothVib ? ["--smooth-vibrato"] : []),
    "--mode", mode,
  ];

  const proc = spawn(PYTHON, pyArgs, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";

  proc.stdout.on("data", (d) => {
    stdout += d.toString();
  });

  proc.stderr.on("data", (d) => {
    for (const raw of d.toString().split("\n")) {
      const t = raw.trim();
      if (!t) continue;
      try {
        const msg = JSON.parse(t);
        if (msg.type === "progress") {
          job.progress.push(msg);
          _broadcast(job, msg);
        }
      } catch {
        /* non-JSON stderr line – ignore */
      }
    }
  });

  proc.on("error", (err) => _fail(job, `spawn error: ${err.message}`));

  proc.on("close", async (code) => {
    if (code !== 0) return _fail(job, `Python exited with code ${code}`);

    const lines = stdout.trim().split("\n").filter(Boolean);
    let analyzeResult, correctResult;
    try {
      [analyzeResult, correctResult] = lines.map((l) => JSON.parse(l));
      correctResult = correctResult ?? analyzeResult;
    } catch {
      return _fail(job, "Could not parse Python output – check server logs");
    }

    job.analyzeResult = analyzeResult;
    job.correctResult = correctResult;

    if (fs.existsSync(outputJson)) {
      try {
        job.analysis = JSON.parse(fs.readFileSync(outputJson, "utf8"));
      } catch {}
    }

    // Optionally generate spectrogram (before/after comparison)
    if (genSpec) await _genSpec(job);

    job.status = "done";
    _broadcast(job, {
      type: "done",
      analyzeResult,
      correctResult,
      hasSpectrogram: genSpec && fs.existsSync(outputPng),
      hasMidi: !!outputMidi && fs.existsSync(outputMidi),
    });
    _closeClients(job);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _fail(job, error) {
  job.status = "error";
  _broadcast(job, { type: "error", error });
  _closeClients(job);
}

function _broadcast(job, event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const c of job.clients) {
    try {
      c.write(data);
    } catch {}
  }
}

function _closeClients(job) {
  for (const c of job.clients) {
    try {
      c.end();
    } catch {}
  }
  job.clients.clear();
}

function _genSpec(job) {
  return new Promise((resolve) => {
    const args = [
      AUDIO_SCRIPT,
      "spectrogram",
      job.inputFile,
      "--output",
      job.outputPng,
      ...(fs.existsSync(job.outputJson) ? ["--analysis", job.outputJson] : []),
      ...(fs.existsSync(job.outputWav) ? ["--compare", job.outputWav] : []),
    ];
    const p = spawn(PYTHON, args, { stdio: ["ignore", "pipe", "pipe"] });
    p.stderr.on("data", (d) => {
      for (const raw of d.toString().split("\n")) {
        const t = raw.trim();
        if (!t) continue;
        try {
          const msg = JSON.parse(t);
          if (msg.type === "progress")
            _broadcast(job, {
              type: "progress",
              message: `Spectrogram: ${msg.message}`,
              percent: msg.percent,
            });
        } catch {}
      }
    });
    p.on("close", resolve);
    p.on("error", resolve);
  });
}

// ---------------------------------------------------------------------------
// GET /api/events/:id  –  Server-Sent Events (real-time progress)
// ---------------------------------------------------------------------------

app.get("/api/events/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Replay any buffered progress events (handles late-connecting clients)
  for (const msg of job.progress) res.write(`data: ${JSON.stringify(msg)}\n\n`);

  if (job.status === "done") {
    res.write(
      `data: ${JSON.stringify({
        type: "done",
        analyzeResult: job.analyzeResult,
        correctResult: job.correctResult,
        hasSpectrogram: job.genSpec && fs.existsSync(job.outputPng),
        hasMidi: !!job.outputMidi && fs.existsSync(job.outputMidi),
      })}\n\n`,
    );
    return res.end();
  }

  if (job.status === "error") {
    res.write(
      `data: ${JSON.stringify({ type: "error", error: "Job failed" })}\n\n`,
    );
    return res.end();
  }

  job.clients.add(res);
  req.on("close", () => job.clients.delete(res));
});

// ---------------------------------------------------------------------------
// GET /api/result/:id
// ---------------------------------------------------------------------------

app.get("/api/result/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (job.status !== "done")
    return res.status(202).json({ status: job.status });
  res.json({
    analyzeResult: job.analyzeResult,
    correctResult: job.correctResult,
    analysis: job.analysis,
    hasSpectrogram: job.genSpec && fs.existsSync(job.outputPng),
    hasMidi: !!job.outputMidi && fs.existsSync(job.outputMidi),
  });
});

// ---------------------------------------------------------------------------
// Download endpoints
// ---------------------------------------------------------------------------

app.get("/api/download/:id/wav", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || !fs.existsSync(job.outputWav))
    return res.status(404).json({ error: "Not found" });
  res.download(job.outputWav, path.basename(job.outputWav));
});

app.get("/api/download/:id/midi", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job?.outputMidi || !fs.existsSync(job.outputMidi))
    return res.status(404).json({ error: "Not found" });
  res.download(job.outputMidi, path.basename(job.outputMidi));
});

app.get("/api/download/:id/analysis", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || !fs.existsSync(job.outputJson))
    return res.status(404).json({ error: "Not found" });
  res.download(job.outputJson, path.basename(job.outputJson));
});

app.get("/api/spectrogram/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || !fs.existsSync(job.outputPng))
    return res.status(404).json({ error: "No spectrogram" });
  res.sendFile(job.outputPng);
});

app.get("/api/original/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || !fs.existsSync(job.inputFile))
    return res.status(404).json({ error: "Not found" });
  res.sendFile(job.inputFile);
});

// ---------------------------------------------------------------------------
// POST /api/reapply/:id  –  re-run correction with per-note approval overrides
// ---------------------------------------------------------------------------

app.post("/api/reapply/:id", express.json(), async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (!fs.existsSync(job.outputJson))
    return res.status(400).json({ error: "No analysis file — run fix first" });

  try {
    // Merge per-note approval overrides into the stored analysis JSON
    const analysis = JSON.parse(fs.readFileSync(job.outputJson, "utf8"));
    const overrideMap = new Map(
      (req.body.overrides ?? []).map((o) => [o.index, o]),
    );
    for (const note of analysis.notes) {
      const ov = overrideMap.get(note.index);
      if (!ov) continue;
      if ("pitch_correct_approved" in ov)
        note.pitch_correct_approved = ov.pitch_correct_approved;
      if ("buzz_remove_approved" in ov)
        note.buzz_remove_approved = ov.buzz_remove_approved;
    }
    fs.writeFileSync(job.outputJson, JSON.stringify(analysis, null, 2));

    // Re-run Python correct (no pYIN, so much faster than fix)
    const pyArgs = [
      AUDIO_SCRIPT, "correct",
      job.inputFile,
      "--fixes", job.outputJson,
      "--output", job.outputWav,
      "--aggressiveness", String(job.aggr ?? 0.8),
      ...(job.smoothVib ? ["--smooth-vibrato"] : []),
    ];

    const result = await new Promise((resolve, reject) => {
      const proc = spawn(PYTHON, pyArgs, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      proc.stdout.on("data", (d) => { stdout += d; });
      proc.on("close", (code) => {
        if (code !== 0) return reject(new Error(`Python exited ${code}`));
        try { resolve(JSON.parse(stdout.trim())); }
        catch { reject(new Error("Could not parse Python output")); }
      });
      proc.on("error", reject);
    });

    res.json({ success: true, result });
  } catch (err) {
    console.error("[reapply]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Error handling (multer validation, etc.)
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err.code === "LIMIT_FILE_SIZE")
    return res.status(413).json({ error: "File too large (max 200 MB)" });
  if (err.message === "Only audio files are accepted")
    return res.status(400).json({ error: err.message });
  console.error("[ERROR]", err.message);
  res.status(500).json({ error: "Internal server error" });
});

// ---------------------------------------------------------------------------
// Serve built React app in production
// ---------------------------------------------------------------------------

const uiDist = path.join(__dirname, "ui", "dist");
if (fs.existsSync(uiDist)) {
  app.use(express.static(uiDist));
  app.get("*", (_req, res) => res.sendFile(path.join(uiDist, "index.html")));
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () =>
  console.log(
    `[INFO] Guitar Audio Correction UI  →  http://localhost:${PORT}\n`,
  ),
);
