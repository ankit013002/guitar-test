#!/usr/bin/env node
/**
 * tests/mock_python.js
 * Simulates audio_processor.py for server integration tests.
 *
 * The server spawns it as:
 *   spawn(node_binary, [mock_python.js, subcommand, inputFile, ...flags])
 *
 * process.argv layout when Node runs this file:
 *   [0] node binary
 *   [1] mock_python.js path  (Node uses first arg as the script – i.e. AUDIO_SCRIPT)
 *   [2] subcommand (fix | spectrogram)
 *   [3] inputFile
 *   [4..] flags
 *
 * Special: if <inputFile> basename === "fail.wav", the fix command exits 1.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2); // [subcommand, inputFile, ...flags]
const subcommand = args[0];
const inputFile = args[1];

function getFlag(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

// ── fix ───────────────────────────────────────────────────────────────────
if (subcommand === "fix") {
  if (inputFile && path.basename(inputFile) === "fail.wav") {
    process.stderr.write("Simulated Python error\n");
    process.exit(1);
  }

  const outputWav = getFlag("--output");
  const outputJson = getFlag("--output-analysis");
  const outputMidi = getFlag("--output-midi");

  // Emit progress events to stderr
  for (const msg of [
    { type: "progress", message: "Analyzing audio", percent: 20 },
    { type: "progress", message: "Correcting pitch", percent: 60 },
    { type: "progress", message: "Writing output", percent: 90 },
  ])
    process.stderr.write(JSON.stringify(msg) + "\n");

  // Write minimal 44-byte WAV (RIFF header, no samples)
  if (outputWav) {
    fs.mkdirSync(path.dirname(outputWav), { recursive: true });
    const wav = Buffer.alloc(44);
    wav.write("RIFF", 0);
    wav.writeUInt32LE(36, 4);
    wav.write("WAVE", 8);
    wav.write("fmt ", 12);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20); // PCM
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(44100, 24);
    wav.writeUInt32LE(88200, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(0, 40);
    fs.writeFileSync(outputWav, wav);
  }

  // Write analysis JSON
  if (outputJson) {
    fs.mkdirSync(path.dirname(outputJson), { recursive: true });
    fs.writeFileSync(
      outputJson,
      JSON.stringify({
        notes: [
          {
            timestamp: 0.5,
            original_note: "E4",
            corrected_note: "E4",
            pitch_deviation_cents: 10,
            confidence: 0.9,
            has_buzz: false,
            has_vibrato: false,
            off_pitch: false,
            was_corrected: false,
          },
          {
            timestamp: 1.2,
            original_note: "A3",
            corrected_note: "A4",
            pitch_deviation_cents: 35,
            confidence: 0.7,
            has_buzz: false,
            has_vibrato: false,
            off_pitch: true,
            was_corrected: true,
          },
        ],
      }),
    );
  }

  // Write minimal MIDI stub
  if (outputMidi) {
    fs.mkdirSync(path.dirname(outputMidi), { recursive: true });
    fs.writeFileSync(outputMidi, Buffer.from([0x4d, 0x54, 0x68, 0x64])); // "MThd"
  }

  // Two JSON lines on stdout: analyze result, then correct result
  process.stdout.write(
    JSON.stringify({
      summary: {
        duration: 5.0,
        tempo_bpm: 120,
        total_notes: 2,
        flagged_notes: 1,
        buzz_notes: 0,
        off_pitch_notes: 1,
        average_confidence: 0.8,
      },
    }) + "\n",
  );
  process.stdout.write(
    JSON.stringify({
      summary: { notes_corrected: 1 },
    }) + "\n",
  );
  process.exit(0);
}

// ── spectrogram ───────────────────────────────────────────────────────────
if (subcommand === "spectrogram") {
  const outputPng = getFlag("--output");
  if (outputPng) {
    fs.mkdirSync(path.dirname(outputPng), { recursive: true });
    // Minimal valid 1×1 transparent PNG
    fs.writeFileSync(
      outputPng,
      Buffer.from(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489" +
          "0000000a49444154789c6260000000020001e221bc330000000049454e44ae426082",
        "hex",
      ),
    );
  }
  process.stderr.write(
    JSON.stringify({
      type: "progress",
      message: "Generating spectrogram",
      percent: 100,
    }) + "\n",
  );
  process.exit(0);
}

process.stderr.write(`Unknown subcommand: ${subcommand}\n`);
process.exit(1);
