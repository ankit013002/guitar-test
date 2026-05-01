"use strict";
/**
 * tests/test_server.js
 * Integration tests for server.js (Express API layer).
 * Starts the server as a subprocess with a mock Python script so no real
 * audio processing happens, then exercises every HTTP endpoint.
 */
const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const MOCK = path.join(__dirname, "mock_python.js");
const TEST_PORT = 3099;
const BASE = `http://localhost:${TEST_PORT}`;

// ── Test helpers ───────────────────────────────────────────────────────────

/** Minimal 44-byte RIFF WAV with no audio samples. */
function makeWav() {
  const b = Buffer.alloc(44);
  b.write("RIFF", 0);
  b.writeUInt32LE(36, 4);
  b.write("WAVE", 8);
  b.write("fmt ", 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(44100, 24);
  b.writeUInt32LE(88200, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(0, 40);
  return b;
}

/** GET any endpoint; returns { status, headers, body, json }. */
function httpGet(urlPath) {
  return new Promise((resolve, reject) => {
    http
      .get(`${BASE}${urlPath}`, (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch {}
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: raw,
            json,
          });
        });
      })
      .on("error", reject);
  });
}

/** POST multipart/form-data to /api/fix. Returns { status, json }. */
async function postFix(opts = {}) {
  const filename = opts.filename ?? "test.wav";
  const fd = new FormData();
  fd.append("audio", new Blob([makeWav()], { type: "audio/wav" }), filename);
  fd.append("aggressiveness", String(opts.aggressiveness ?? 0.8));
  fd.append("smoothVibrato", String(opts.smoothVibrato ?? false));
  fd.append("exportMidi", String(opts.exportMidi ?? false));
  fd.append("spectrogram", String(opts.spectrogram ?? false));
  const r = await fetch(`${BASE}/api/fix`, { method: "POST", body: fd });
  return { status: r.status, json: await r.json().catch(() => null) };
}

/**
 * Consumes the SSE stream for a job until a "done" or "error" event arrives
 * (or the stream ends, or timeoutMs elapses). Returns array of parsed events.
 */
function collectSSE(jobId, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const events = [];
    let buf = "";
    const req = http.get(`${BASE}/api/events/${jobId}`, (res) => {
      const timer = setTimeout(() => {
        res.destroy();
        resolve(events);
      }, timeoutMs);
      res.on("data", (chunk) => {
        buf += chunk.toString();
        const parts = buf.split("\n\n");
        buf = parts.pop();
        for (const part of parts) {
          for (const line of part.split("\n")) {
            if (line.startsWith("data: ")) {
              try {
                events.push(JSON.parse(line.slice(6)));
              } catch {}
            }
          }
        }
        if (events.some((e) => e.type === "done" || e.type === "error")) {
          clearTimeout(timer);
          res.destroy();
          resolve(events);
        }
      });
      res.on("end", () => {
        clearTimeout(timer);
        resolve(events);
      });
      res.on("error", (e) => {
        clearTimeout(timer);
        if (e.code === "ECONNRESET") resolve(events);
        else reject(e);
      });
    });
    req.on("error", reject);
  });
}

/** Poll /api/health until the server responds or the deadline is reached. */
async function waitServer(ms = 12_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      await httpGet("/api/health");
      return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Test server did not start within the timeout");
}

// ── Shared jobs (created once before any test runs) ────────────────────────
let basicJobId = null; // basic successful job (no midi, no spectrogram)
let midiSpecJobId = null; // successful job with midi + spectrogram
let failedJobId = null; // job where Python exits non-zero

// ── Suite ──────────────────────────────────────────────────────────────────
describe("Guitar Audio Correction – server", () => {
  let serverProc;

  before(async () => {
    // Start server with mock Python so no real audio processing occurs
    serverProc = spawn(process.execPath, [path.join(ROOT, "server.js")], {
      env: {
        ...process.env,
        PORT: String(TEST_PORT),
        GUITAR_PYTHON: process.execPath, // node binary acts as "python"
        GUITAR_SCRIPT: MOCK, // mock_python.js acts as audio_processor.py
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    serverProc.stdout.resume();
    serverProc.stderr.resume();

    await waitServer();

    // Pre-create shared jobs and wait for each to complete
    {
      const { json } = await postFix();
      basicJobId = json.jobId;
      await collectSSE(basicJobId);
    }
    {
      const { json } = await postFix({ exportMidi: true, spectrogram: true });
      midiSpecJobId = json.jobId;
      await collectSSE(midiSpecJobId);
    }
    {
      // "fail.wav" triggers mock_python to exit with code 1
      const fd = new FormData();
      fd.append(
        "audio",
        new Blob([makeWav()], { type: "audio/wav" }),
        "fail.wav",
      );
      fd.append("aggressiveness", "0.8");
      fd.append("smoothVibrato", "false");
      fd.append("exportMidi", "false");
      fd.append("spectrogram", "false");
      const r = await fetch(`${BASE}/api/fix`, { method: "POST", body: fd });
      const { jobId } = await r.json();
      failedJobId = jobId;
      await collectSSE(failedJobId);
    }
  });

  after(() => serverProc?.kill("SIGTERM"));

  // ── GET /api/health ────────────────────────────────────────────────────
  describe("GET /api/health", () => {
    test("returns 200 with ok:true", async () => {
      const { status, json } = await httpGet("/api/health");
      assert.equal(status, 200);
      assert.equal(json.ok, true);
    });

    test("reports the python binary in use", async () => {
      const { json } = await httpGet("/api/health");
      assert.ok(json.python, "python field should be a non-empty string");
    });
  });

  // ── POST /api/fix ──────────────────────────────────────────────────────
  describe("POST /api/fix", () => {
    test("no file body → 400", async () => {
      const r = await fetch(`${BASE}/api/fix`, {
        method: "POST",
        body: new FormData(),
      });
      assert.equal(r.status, 400);
    });

    test("non-audio extension → 400", async () => {
      const fd = new FormData();
      fd.append("audio", new Blob(["data"]), "notes.txt");
      const r = await fetch(`${BASE}/api/fix`, { method: "POST", body: fd });
      assert.equal(r.status, 400);
    });

    test("valid WAV → 200", async () => {
      const { status } = await postFix();
      assert.equal(status, 200);
    });

    test("response body contains a UUID jobId", async () => {
      const { json } = await postFix();
      assert.match(
        json.jobId,
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });

    test("negative aggressiveness accepted (clamped to 0)", async () => {
      const { status } = await postFix({ aggressiveness: -99 });
      assert.equal(status, 200);
    });

    test("aggressiveness > 1 accepted (clamped to 1)", async () => {
      const { status } = await postFix({ aggressiveness: 50 });
      assert.equal(status, 200);
    });

    test("non-numeric aggressiveness defaults gracefully", async () => {
      const fd = new FormData();
      fd.append(
        "audio",
        new Blob([makeWav()], { type: "audio/wav" }),
        "test.wav",
      );
      fd.append("aggressiveness", "banana");
      const r = await fetch(`${BASE}/api/fix`, { method: "POST", body: fd });
      assert.equal(r.status, 200);
    });

    test("each job gets a unique id", async () => {
      const [a, b] = await Promise.all([postFix(), postFix()]);
      assert.notEqual(a.json.jobId, b.json.jobId);
    });
  });

  // ── GET /api/events/:id ────────────────────────────────────────────────
  describe("GET /api/events/:id", () => {
    test("unknown id → 404", async () => {
      const { status } = await httpGet(
        "/api/events/00000000-0000-0000-0000-000000000000",
      );
      assert.equal(status, 404);
    });

    test("content-type is text/event-stream", async () => {
      const { headers } = await httpGet(`/api/events/${basicJobId}`);
      assert.ok(headers["content-type"]?.includes("text/event-stream"));
    });

    test("completed job: replays at least one progress event", async () => {
      const events = await collectSSE(basicJobId);
      assert.ok(events.filter((e) => e.type === "progress").length > 0);
    });

    test("completed job: stream ends with a done event", async () => {
      const events = await collectSSE(basicJobId);
      assert.ok(events.some((e) => e.type === "done"));
    });

    test("done event contains analyzeResult", async () => {
      const events = await collectSSE(basicJobId);
      const done = events.find((e) => e.type === "done");
      assert.ok(done?.analyzeResult?.summary);
    });

    test("done event contains correctResult", async () => {
      const events = await collectSSE(basicJobId);
      const done = events.find((e) => e.type === "done");
      assert.ok(done?.correctResult?.summary);
    });

    test("fresh job: receives live progress then done", async () => {
      const { json } = await postFix();
      const events = await collectSSE(json.jobId);
      assert.ok(events.some((e) => e.type === "progress"));
      assert.ok(events.some((e) => e.type === "done"));
    });

    test("failed job: emits error event", async () => {
      const events = await collectSSE(failedJobId);
      assert.ok(events.some((e) => e.type === "error"));
    });
  });

  // ── GET /api/result/:id ────────────────────────────────────────────────
  describe("GET /api/result/:id", () => {
    test("unknown id → 404", async () => {
      const { status } = await httpGet(
        "/api/result/00000000-0000-0000-0000-000000000000",
      );
      assert.equal(status, 404);
    });

    test("completed job → 200", async () => {
      const { status } = await httpGet(`/api/result/${basicJobId}`);
      assert.equal(status, 200);
    });

    test("result has analyzeResult.summary", async () => {
      const { json } = await httpGet(`/api/result/${basicJobId}`);
      assert.ok(json.analyzeResult?.summary);
    });

    test("result has correctResult.summary", async () => {
      const { json } = await httpGet(`/api/result/${basicJobId}`);
      assert.ok(json.correctResult?.summary);
    });

    test("result has analysis.notes array", async () => {
      const { json } = await httpGet(`/api/result/${basicJobId}`);
      assert.ok(Array.isArray(json.analysis?.notes));
    });

    test("failed job → 202 with status:'error'", async () => {
      const { status, json } = await httpGet(`/api/result/${failedJobId}`);
      assert.equal(status, 202);
      assert.equal(json.status, "error");
    });
  });

  // ── GET /api/download/:id/* ────────────────────────────────────────────
  describe("GET /api/download/:id/*", () => {
    test("unknown id / wav → 404", async () => {
      const { status } = await httpGet(
        "/api/download/00000000-0000-0000-0000-000000000000/wav",
      );
      assert.equal(status, 404);
    });

    test("unknown id / midi → 404", async () => {
      const { status } = await httpGet(
        "/api/download/00000000-0000-0000-0000-000000000000/midi",
      );
      assert.equal(status, 404);
    });

    test("unknown id / analysis → 404", async () => {
      const { status } = await httpGet(
        "/api/download/00000000-0000-0000-0000-000000000000/analysis",
      );
      assert.equal(status, 404);
    });

    test("completed job wav → 200", async () => {
      const { status } = await httpGet(`/api/download/${basicJobId}/wav`);
      assert.equal(status, 200);
    });

    test("wav response has content-disposition: attachment", async () => {
      const { headers } = await httpGet(`/api/download/${basicJobId}/wav`);
      assert.ok(headers["content-disposition"]?.includes("attachment"));
    });

    test("completed job analysis → 200", async () => {
      const { status } = await httpGet(`/api/download/${basicJobId}/analysis`);
      assert.equal(status, 200);
    });

    test("analysis download body is valid JSON", async () => {
      const { body } = await httpGet(`/api/download/${basicJobId}/analysis`);
      assert.doesNotThrow(() => JSON.parse(body));
    });

    test("job without midi → midi 404", async () => {
      const { status } = await httpGet(`/api/download/${basicJobId}/midi`);
      assert.equal(status, 404);
    });

    test("job with midi enabled → midi 200", async () => {
      const { status } = await httpGet(`/api/download/${midiSpecJobId}/midi`);
      assert.equal(status, 200);
    });
  });

  // ── GET /api/spectrogram/:id ───────────────────────────────────────────
  describe("GET /api/spectrogram/:id", () => {
    test("unknown id → 404", async () => {
      const { status } = await httpGet(
        "/api/spectrogram/00000000-0000-0000-0000-000000000000",
      );
      assert.equal(status, 404);
    });

    test("job without spectrogram → 404", async () => {
      const { status } = await httpGet(`/api/spectrogram/${basicJobId}`);
      assert.equal(status, 404);
    });

    test("job with spectrogram → 200", async () => {
      const { status } = await httpGet(`/api/spectrogram/${midiSpecJobId}`);
      assert.equal(status, 200);
    });
  });

  // ── GET /api/original/:id ──────────────────────────────────────────────
  describe("GET /api/original/:id", () => {
    test("unknown id → 404", async () => {
      const { status } = await httpGet(
        "/api/original/00000000-0000-0000-0000-000000000000",
      );
      assert.equal(status, 404);
    });

    test("valid job → 200", async () => {
      const { status } = await httpGet(`/api/original/${basicJobId}`);
      assert.equal(status, 200);
    });
  });
});
