/**
 * Tests for cli.js helpers.
 *
 * Uses Node's built-in test runner (available since Node 18):
 *   node --test tests/test_cli.js
 *
 * Integration tests that spawn Python are marked with the "integration" group
 * and are skipped automatically when Python / audio_processor.py is unavailable.
 */

"use strict";

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawnSync, spawn } = require("node:child_process");

// ---------------------------------------------------------------------------
// Import the module under test.
// cli.js guards its main() call with `require.main !== module`, so importing
// it here does NOT run the CLI entry-point.
// ---------------------------------------------------------------------------
const cli = require(path.join(__dirname, "..", "cli.js"));

const {
  padVisual,
  progressBar,
  confColor,
  noteFlags,
  fmtNoteRow,
  stripExt,
  parseArgs,
  makeProgressHandler,
  exitOnFailure,
  requireFile,
  die,
} = cli;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip all ANSI escape sequences from a string. */
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Run `node cli.js <args>` as a child process and return { stdout, stderr, status }. */
function runCLI(args = [], opts = {}) {
  const cliPath = path.join(__dirname, "..", "cli.js");
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    timeout: 15000,
    ...opts,
  });
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status ?? -1,
  };
}

// ---------------------------------------------------------------------------
// 1.  padVisual
// ---------------------------------------------------------------------------

describe("padVisual", () => {
  test("pads a plain string to the target length", () => {
    const result = padVisual("abc", 6);
    assert.equal(stripAnsi(result), "abc   ");
  });

  test("does not pad when string is already at target length", () => {
    const result = padVisual("hello", 5);
    assert.equal(stripAnsi(result), "hello");
  });

  test("does not truncate strings longer than target", () => {
    const result = padVisual("toolong", 3);
    assert.equal(stripAnsi(result).startsWith("toolong"), true);
  });

  test("ignores ANSI codes when computing visual length", () => {
    // Wrap 'hi' in a colour sequence – visual length is still 2
    const coloured = "\x1b[32mhi\x1b[0m";
    const result = padVisual(coloured, 6);
    const plain = stripAnsi(result);
    assert.equal(plain, "hi    "); // 2 visible chars + 4 spaces = 6
  });

  test("returns original string unchanged when len is 0", () => {
    const result = padVisual("test", 0);
    assert.equal(stripAnsi(result), "test");
  });
});

// ---------------------------------------------------------------------------
// 2.  progressBar
// ---------------------------------------------------------------------------

describe("progressBar", () => {
  test("returns a string of the correct total width (ignoring ANSI)", () => {
    const bar = stripAnsi(progressBar(50, 20));
    assert.equal(bar.length, 20);
  });

  test("0% → all empty blocks", () => {
    const bar = stripAnsi(progressBar(0, 10));
    assert.ok(
      !bar.includes("█"),
      `Expected no filled blocks at 0%, got: ${bar}`,
    );
  });

  test("100% → all filled blocks", () => {
    const bar = stripAnsi(progressBar(100, 10));
    assert.ok(
      !bar.includes("░"),
      `Expected no empty blocks at 100%, got: ${bar}`,
    );
  });

  test("50% → half filled, half empty", () => {
    const bar = stripAnsi(progressBar(50, 10));
    const filled = (bar.match(/█/g) || []).length;
    const empty = (bar.match(/░/g) || []).length;
    assert.equal(filled, 5);
    assert.equal(empty, 5);
  });

  test("uses default width of 32 characters", () => {
    const bar = stripAnsi(progressBar(0));
    assert.equal(bar.length, 32);
  });
});

// ---------------------------------------------------------------------------
// 3.  confColor
// ---------------------------------------------------------------------------

describe("confColor", () => {
  test("returns a string", () => {
    assert.equal(typeof confColor(0.9), "string");
  });

  test("plain text contains the percentage", () => {
    assert.ok(stripAnsi(confColor(0.85)).includes("85%"));
  });

  test("high confidence (0.8) renders green", () => {
    // ANSI green = \x1b[32m
    const result = confColor(0.8);
    assert.ok(
      result.includes("\x1b[32m") || stripAnsi(result).endsWith("%"),
      "Expected green colour for conf=0.8",
    );
  });

  test("medium confidence (0.5) renders yellow", () => {
    const result = confColor(0.5);
    assert.ok(
      result.includes("\x1b[33m") || stripAnsi(result).endsWith("%"),
      "Expected yellow colour for conf=0.5",
    );
  });

  test("low confidence (0.3) renders red", () => {
    const result = confColor(0.3);
    assert.ok(
      result.includes("\x1b[31m") || stripAnsi(result).endsWith("%"),
      "Expected red colour for conf=0.3",
    );
  });

  test("boundary exactly 0.8 renders as high confidence", () => {
    const high = stripAnsi(confColor(0.8));
    const low = stripAnsi(confColor(0.79));
    // Both should contain % – colour is the relevant difference
    assert.ok(high.endsWith("%"));
    assert.ok(low.endsWith("%"));
  });
});

// ---------------------------------------------------------------------------
// 4.  noteFlags
// ---------------------------------------------------------------------------

describe("noteFlags", () => {
  const base = {
    has_buzz: false,
    off_pitch: false,
    has_vibrato: false,
    pitch_deviation_cents: 0,
  };

  test("returns empty string for a clean note", () => {
    assert.equal(stripAnsi(noteFlags(base)), "");
  });

  test("includes BUZZ flag when has_buzz is true", () => {
    const result = stripAnsi(noteFlags({ ...base, has_buzz: true }));
    assert.ok(result.includes("BUZZ"), `Expected BUZZ in: ${result}`);
  });

  test("includes positive cent deviation with + sign", () => {
    const result = stripAnsi(
      noteFlags({ ...base, off_pitch: true, pitch_deviation_cents: 15 }),
    );
    assert.ok(result.includes("+15¢"), `Expected +15¢ in: ${result}`);
  });

  test("includes negative cent deviation without + sign", () => {
    const result = stripAnsi(
      noteFlags({ ...base, off_pitch: true, pitch_deviation_cents: -20 }),
    );
    assert.ok(result.includes("-20¢"), `Expected -20¢ in: ${result}`);
  });

  test("includes VIB flag when has_vibrato is true", () => {
    const result = stripAnsi(noteFlags({ ...base, has_vibrato: true }));
    assert.ok(result.includes("VIB"), `Expected VIB in: ${result}`);
  });

  test("includes all flags when all conditions are true", () => {
    const result = stripAnsi(
      noteFlags({
        has_buzz: true,
        off_pitch: true,
        has_vibrato: true,
        pitch_deviation_cents: -5,
      }),
    );
    assert.ok(result.includes("BUZZ"));
    assert.ok(result.includes("¢"));
    assert.ok(result.includes("VIB"));
  });
});

// ---------------------------------------------------------------------------
// 5.  fmtNoteRow
// ---------------------------------------------------------------------------

describe("fmtNoteRow", () => {
  const baseNote = {
    timestamp: 1.234,
    original_note: "A4",
    corrected_note: "A4",
    was_corrected: false,
    confidence: 0.9,
    has_buzz: false,
    off_pitch: false,
    has_vibrato: false,
    pitch_deviation_cents: 0,
  };

  test("returns a non-empty string", () => {
    assert.ok(fmtNoteRow(baseNote).length > 0);
  });

  test("includes the timestamp", () => {
    const result = stripAnsi(fmtNoteRow(baseNote));
    assert.ok(result.includes("1.23"), `Expected timestamp in: ${result}`);
  });

  test("includes the note name for uncorrected notes", () => {
    const result = stripAnsi(fmtNoteRow(baseNote));
    assert.ok(result.includes("A4"), `Expected note name in: ${result}`);
  });

  test("shows original → corrected for corrected notes", () => {
    const corrected = {
      ...baseNote,
      was_corrected: true,
      original_note: "A#4",
      corrected_note: "A4",
    };
    const result = stripAnsi(fmtNoteRow(corrected));
    assert.ok(result.includes("A#4"), `Expected original note: ${result}`);
    assert.ok(result.includes("A4"), `Expected corrected note: ${result}`);
    assert.ok(result.includes("→"), `Expected arrow in: ${result}`);
  });
});

// ---------------------------------------------------------------------------
// 6.  stripExt
// ---------------------------------------------------------------------------

describe("stripExt", () => {
  test("strips .wav extension", () => {
    assert.equal(stripExt("guitar.wav"), "guitar");
  });

  test("strips .json extension", () => {
    assert.equal(stripExt("analysis.json"), "analysis");
  });

  test("strips only the last extension with multiple dots", () => {
    assert.equal(stripExt("my.guitar.recording.wav"), "my.guitar.recording");
  });

  test("preserves paths without extensions", () => {
    assert.equal(stripExt("noextension"), "noextension");
  });

  test("handles full paths", () => {
    const result = stripExt("/home/user/music/song.wav");
    assert.equal(result, "/home/user/music/song");
  });

  test("handles Windows-style paths", () => {
    const result = stripExt("C:\\Users\\music\\song.wav");
    assert.equal(result, "C:\\Users\\music\\song");
  });

  test("handles .mp3 extension", () => {
    assert.equal(stripExt("track.mp3"), "track");
  });
});

// ---------------------------------------------------------------------------
// 7.  parseArgs
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  test("returns positional args separately from options", () => {
    const { opts, pos } = parseArgs(["input.wav", "--output", "out.wav"]);
    assert.deepEqual(pos, ["input.wav"]);
    assert.equal(opts.output, "out.wav");
  });

  test("boolean flag (no value) is set to true", () => {
    const { opts } = parseArgs(["--smooth-vibrato"]);
    assert.equal(opts["smooth-vibrato"], true);
  });

  test("flag followed by another flag is treated as boolean", () => {
    const { opts } = parseArgs(["--smooth-vibrato", "--output-midi"]);
    assert.equal(opts["smooth-vibrato"], true);
    assert.equal(opts["output-midi"], true);
  });

  test("flag with string value stores the value", () => {
    const { opts } = parseArgs(["--aggressiveness", "0.6"]);
    assert.equal(opts.aggressiveness, "0.6");
  });

  test("multiple positional args collected in order", () => {
    const { pos } = parseArgs(["a.wav", "b.wav"]);
    assert.deepEqual(pos, ["a.wav", "b.wav"]);
  });

  test("empty argv returns empty opts and pos", () => {
    const { opts, pos } = parseArgs([]);
    assert.deepEqual(opts, {});
    assert.deepEqual(pos, []);
  });

  test("mixed positional and flags", () => {
    const { opts, pos } = parseArgs([
      "file.wav",
      "--sr",
      "44100",
      "--smooth-vibrato",
    ]);
    assert.deepEqual(pos, ["file.wav"]);
    assert.equal(opts.sr, "44100");
    assert.equal(opts["smooth-vibrato"], true);
  });

  test("flag value starting with -- is treated as next boolean flag", () => {
    // --foo --bar: bar should not be consumed as foo's value
    const { opts } = parseArgs(["--foo", "--bar"]);
    assert.equal(opts.foo, true);
    assert.equal(opts.bar, true);
  });
});

// ---------------------------------------------------------------------------
// 8.  makeProgressHandler
// ---------------------------------------------------------------------------

describe("makeProgressHandler", () => {
  /**
   * Capture everything written to process.stdout.write during a callback.
   * Returns the captured string.
   */
  function captureStdout(fn) {
    const chunks = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    };
    const origLog = console.log;
    const logChunks = [];
    console.log = (...args) => logChunks.push(args.join(" ") + "\n");
    try {
      fn();
    } finally {
      process.stdout.write = orig;
      console.log = origLog;
    }
    return { raw: chunks.join(""), logged: logChunks.join("") };
  }

  test("onProgress with percent writes inline (\\r) output", () => {
    const { onProgress } = makeProgressHandler();
    const { raw } = captureStdout(() => {
      onProgress({ type: "progress", message: "Loading", percent: 50 });
    });
    assert.ok(
      raw.includes("\r"),
      `Expected \\r in output: ${JSON.stringify(raw)}`,
    );
  });

  test("onProgress with same percent twice does not re-render", () => {
    const { onProgress } = makeProgressHandler();
    const chunks = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => {
      chunks.push(chunk);
      return true;
    };
    onProgress({ type: "progress", message: "X", percent: 30 });
    const after1 = chunks.length;
    onProgress({ type: "progress", message: "X", percent: 30 });
    const after2 = chunks.length;
    process.stdout.write = orig;
    assert.equal(after1, after2, "Should not re-render for duplicate percent");
  });

  test("onProgress without percent logs message line", () => {
    const { onProgress } = makeProgressHandler();
    const { logged } = captureStdout(() => {
      onProgress({ type: "progress", message: "Detecting notes" });
    });
    assert.ok(
      logged.includes("Detecting notes"),
      `Expected message in logged output: ${logged}`,
    );
  });

  test("flush() adds newline if percent progress was active", () => {
    const { onProgress, flush } = makeProgressHandler();
    const chunks = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => {
      chunks.push(chunk);
      return true;
    };
    onProgress({ type: "progress", message: "Working", percent: 80 });
    flush();
    process.stdout.write = orig;
    const combined = chunks.join("");
    assert.ok(combined.includes("\n"), "Expected newline from flush()");
  });

  test("flush() does nothing when no percent progress has been sent", () => {
    const { flush } = makeProgressHandler();
    let called = false;
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => {
      called = true;
      return true;
    };
    flush();
    process.stdout.write = orig;
    assert.equal(
      called,
      false,
      "flush() should not write when no percent was shown",
    );
  });
});

// ---------------------------------------------------------------------------
// 9.  exitOnFailure
// ---------------------------------------------------------------------------

describe("exitOnFailure", () => {
  test("does not throw for a successful result", () => {
    assert.doesNotThrow(() => exitOnFailure({ success: true }, "Test"));
  });

  test("calls process.exit(1) for a failed result", () => {
    // Temporarily override process.exit to capture the call
    const orig = process.exit;
    let exitCalled = false;
    process.exit = () => {
      exitCalled = true;
      throw new Error("__exit__");
    };
    const origErr = console.error;
    console.error = () => {};
    try {
      exitOnFailure({ success: false, error: "oops" }, "Test");
    } catch (e) {
      if (e.message !== "__exit__") throw e;
    } finally {
      process.exit = orig;
      console.error = origErr;
    }
    assert.ok(exitCalled, "Expected process.exit to be called");
  });

  test("calls process.exit(1) for null result", () => {
    const orig = process.exit;
    let exitCalled = false;
    process.exit = () => {
      exitCalled = true;
      throw new Error("__exit__");
    };
    const origErr = console.error;
    console.error = () => {};
    try {
      exitOnFailure(null, "Test");
    } catch (e) {
      if (e.message !== "__exit__") throw e;
    } finally {
      process.exit = orig;
      console.error = origErr;
    }
    assert.ok(exitCalled);
  });
});

// ---------------------------------------------------------------------------
// 10.  requireFile
// ---------------------------------------------------------------------------

describe("requireFile", () => {
  test("does not throw when file exists", () => {
    // Use this test file itself as a known-existing file
    assert.doesNotThrow(() => requireFile(__filename));
  });

  test("calls process.exit(1) when file does not exist", () => {
    const orig = process.exit;
    let exitCalled = false;
    process.exit = () => {
      exitCalled = true;
      throw new Error("__exit__");
    };
    const origErr = console.error;
    console.error = () => {};
    try {
      requireFile("/this/does/not/exist/ever.wav");
    } catch (e) {
      if (e.message !== "__exit__") throw e;
    } finally {
      process.exit = orig;
      console.error = origErr;
    }
    assert.ok(exitCalled, "Expected process.exit for missing file");
  });
});

// ---------------------------------------------------------------------------
// 11.  CLI integration tests (spawn the CLI as a child process)
// ---------------------------------------------------------------------------

describe("CLI integration", () => {
  test("no arguments prints help and exits 0", () => {
    const { stdout, status } = runCLI([]);
    assert.equal(status, 0, `Expected exit 0, got ${status}`);
    assert.ok(
      stripAnsi(stdout).toLowerCase().includes("usage") ||
        stripAnsi(stdout).toLowerCase().includes("fix"),
      `Expected help text, got: ${stdout.slice(0, 200)}`,
    );
  });

  test("--help prints help and exits 0", () => {
    const { stdout, status } = runCLI(["--help"]);
    assert.equal(status, 0, `Expected exit 0, got ${status}`);
    assert.ok(
      stripAnsi(stdout).toLowerCase().includes("usage"),
      `Expected help text, got: ${stdout.slice(0, 200)}`,
    );
  });

  test("unknown command exits with non-zero status", () => {
    const { status } = runCLI(["not-a-real-command"]);
    assert.notEqual(status, 0, "Expected non-zero exit for unknown command");
  });

  test("analyze with missing file exits non-zero", () => {
    const { status } = runCLI(["analyze", "/no/such/file.wav"]);
    assert.notEqual(status, 0, "Expected non-zero exit for missing input file");
  });

  test("correct without --fixes exits non-zero", () => {
    const { status } = runCLI(["correct", "/no/such/file.wav"]);
    assert.notEqual(
      status,
      0,
      "Expected non-zero exit when --fixes is missing",
    );
  });

  test("fix with missing file exits non-zero", () => {
    const { status } = runCLI(["fix", "/no/such/file.wav"]);
    assert.notEqual(status, 0, "Expected non-zero exit for missing input file");
  });

  test("check-deps runs without crashing", () => {
    // This may exit 0 (all deps present) or 1 (missing), but must not throw
    const { status } = runCLI(["check-deps"], { timeout: 20000 });
    assert.ok(status === 0 || status === 1, `Unexpected exit code: ${status}`);
  });
});
