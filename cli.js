#!/usr/bin/env node
'use strict';

const { spawn }   = require('child_process');
const path        = require('path');
const fs          = require('fs');

// ---------------------------------------------------------------------------
// ANSI colours
// ---------------------------------------------------------------------------
const IS_TTY = process.stdout.isTTY;

const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  cyan:    '\x1b[36m',
  red:     '\x1b[31m',
  magenta: '\x1b[35m',
  white:   '\x1b[37m',
};

function col(name, text) {
  if (!IS_TTY) return text;
  return `${C[name]}${text}${C.reset}`;
}
function bold(text)  { return IS_TTY ? `${C.bold}${text}${C.reset}` : text; }
function dim(text)   { return IS_TTY ? `${C.dim}${text}${C.reset}`  : text; }

// ---------------------------------------------------------------------------
// Visual helpers
// ---------------------------------------------------------------------------
function banner() {
  console.log();
  console.log(col('cyan', '╔══════════════════════════════════════╗'));
  console.log(col('cyan', '║') + bold('  Guitar Audio Correction Tool  v1.0  ') + col('cyan', '║'));
  console.log(col('cyan', '╚══════════════════════════════════════╝'));
  console.log();
}

function progressBar(pct, width = 32) {
  const filled = Math.round(pct / 100 * width);
  const empty  = width - filled;
  return col('cyan', '█'.repeat(filled)) + dim('░'.repeat(empty));
}

function confColor(conf) {
  const pct = (conf * 100).toFixed(0) + '%';
  if (conf >= 0.8) return col('green',  pct);
  if (conf >= 0.5) return col('yellow', pct);
  return col('red', pct);
}

function noteFlags(note) {
  const f = [];
  if (note.has_buzz)   f.push(col('red',    'BUZZ'));
  if (note.off_pitch) {
    const sign = note.pitch_deviation_cents > 0 ? '+' : '';
    f.push(col('yellow', `${sign}${note.pitch_deviation_cents.toFixed(0)}¢`));
  }
  if (note.has_vibrato) f.push(col('blue', 'VIB'));
  return f.join(' ');
}

function fmtNoteRow(note) {
  const ts   = dim(note.timestamp.toFixed(2) + 's');
  const name = note.was_corrected
    ? `${dim(note.original_note)} → ${col('green', note.corrected_note)}`
    : col('white', note.original_note);
  return `  ${ts}  ${name.padEnd(24)}  conf:${confColor(note.confidence)}  ${noteFlags(note)}`;
}

// ---------------------------------------------------------------------------
// Python bridge
// ---------------------------------------------------------------------------
async function findPython() {
  for (const bin of ['python3', 'python']) {
    const ok = await new Promise(res => {
      const p = spawn(bin, ['--version'], { stdio: 'ignore' });
      p.on('close', c => res(c === 0));
      p.on('error', () => res(false));
    });
    if (ok) return bin;
  }
  throw new Error('Python 3 not found. Install it and ensure it is on PATH.');
}

function runPython(pyArgs, onProgress) {
  return new Promise(async (resolve, reject) => {
    const python     = await findPython().catch(reject);
    if (!python) return;
    const scriptPath = path.join(__dirname, 'audio_processor.py');

    if (!fs.existsSync(scriptPath)) {
      return reject(new Error(`audio_processor.py not found at ${scriptPath}`));
    }

    const proc = spawn(python, [scriptPath, ...pyArgs], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });

    proc.stderr.on('data', d => {
      for (const line of d.toString().split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          if (msg.type === 'progress' && onProgress) onProgress(msg);
        } catch {
          process.stderr.write(dim(trimmed) + '\n');
        }
      }
    });

    proc.on('close', code => {
      if (code !== 0) {
        return reject(new Error(`audio_processor.py exited with code ${code}`));
      }
      const raw = stdout.trim();
      if (!raw) return reject(new Error('No output from audio_processor.py'));
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error(`Could not parse Python output:\n${raw}`));
      }
    });

    proc.on('error', err => reject(new Error(`Failed to spawn Python: ${err.message}`)));
  });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdAnalyze(inputFile, opts) {
  banner();
  requireFile(inputFile);

  const outputJson = opts.output || stripExt(inputFile) + '_analysis.json';

  console.log(`${bold('Input:')}   ${col('cyan', inputFile)}`);
  console.log(`${bold('Output:')}  ${col('cyan', outputJson)}`);
  console.log();
  console.log(col('blue', '▶ Analysing…'));
  console.log();

  let lastPct = -1;

  const result = await runPython(
    ['analyze', inputFile, '--output', outputJson,
     ...(opts.sr  ? ['--sr',  String(opts.sr)]  : []),
     ...(opts.hop ? ['--hop', String(opts.hop)] : [])],
    msg => {
      if (msg.percent !== undefined && msg.percent !== lastPct) {
        lastPct = msg.percent;
        process.stdout.write(
          `\r  ${progressBar(msg.percent)} ${String(msg.percent).padStart(3)}%  ` +
          dim(msg.message.slice(0, 42).padEnd(42))
        );
      } else if (msg.percent === undefined) {
        // Ensure we're on a new line after any progress bar
        if (lastPct >= 0) { process.stdout.write('\n'); lastPct = -1; }
        console.log(`  ${col('cyan', '→')} ${msg.message}`);
      }
    }
  );

  if (lastPct >= 0) process.stdout.write('\n');
  console.log();

  exitOnFailure(result, 'Analysis');

  const s = result.summary;
  console.log(col('green', '✓ Analysis complete'));
  console.log();
  console.log(bold('─── Summary ──────────────────────────────'));
  console.log(`  Duration:           ${bold(s.duration + 's')}`);
  console.log(`  Notes detected:     ${bold(s.total_notes)}`);
  console.log(`  Flagged:            ${s.flagged_notes > 0 ? col('yellow', s.flagged_notes) : col('green', s.flagged_notes)}`);
  console.log(`    Buzz issues:      ${s.buzz_notes    > 0 ? col('red',    s.buzz_notes)    : col('green', s.buzz_notes)}`);
  console.log(`    Off-pitch:        ${s.off_pitch_notes > 0 ? col('yellow', s.off_pitch_notes) : col('green', s.off_pitch_notes)}`);
  console.log(`  Avg confidence:     ${confColor(s.average_confidence)}`);
  console.log(dim('──────────────────────────────────────────'));
  console.log();

  // Flagged notes detail
  const analysis    = JSON.parse(fs.readFileSync(outputJson, 'utf8'));
  const flagged     = analysis.notes.filter(n => n.has_buzz || n.off_pitch || n.confidence < 0.5);

  if (flagged.length > 0) {
    console.log(col('yellow', `⚠  Flagged notes (${flagged.length}):`));
    flagged.forEach(n => console.log(fmtNoteRow(n)));
    console.log();
  } else {
    console.log(col('green', '✓ No problem notes detected'));
    console.log();
  }

  console.log(`${dim('Saved:')} ${col('cyan', outputJson)}`);
  console.log();
  console.log(bold('Next step:'));
  console.log(`  ${col('cyan', `node cli.js correct ${inputFile} --fixes ${outputJson}`)}`);
  console.log();
}


async function cmdCorrect(inputFile, opts) {
  banner();
  requireFile(inputFile);

  if (!opts.fixes) {
    die(`--fixes <analysis.json> is required.\nRun first: node cli.js analyze ${inputFile}`);
  }
  requireFile(opts.fixes, '--fixes');

  const outputWav  = opts.output || stripExt(inputFile) + '_corrected.wav';
  const midiFlag   = opts['output-midi'];
  const outputMidi = midiFlag
    ? (midiFlag === true ? stripExt(inputFile) + '.mid' : midiFlag)
    : null;
  const aggr       = parseFloat(opts.aggressiveness || opts.a || '0.8');
  const smoothVib  = opts['smooth-vibrato'] === true || opts['smooth-vibrato'] === 'true';

  console.log(`${bold('Input:')}            ${col('cyan', inputFile)}`);
  console.log(`${bold('Fixes:')}            ${col('cyan', opts.fixes)}`);
  console.log(`${bold('Output WAV:')}       ${col('cyan', outputWav)}`);
  if (outputMidi)
    console.log(`${bold('Output MIDI:')}      ${col('cyan', outputMidi)}`);
  console.log(`${bold('Aggressiveness:')}   ${col('cyan', (aggr * 100).toFixed(0) + '%')}`);
  if (smoothVib)
    console.log(`${bold('Vibrato:')}          ${col('yellow', 'smoothing on')}`);
  console.log();
  console.log(col('blue', '▶ Correcting…'));
  console.log();

  const pyArgs = [
    'correct', inputFile,
    '--fixes',          opts.fixes,
    '--output',         outputWav,
    '--aggressiveness', String(aggr),
    ...(outputMidi   ? ['--output-midi',    outputMidi] : []),
    ...(smoothVib    ? ['--smooth-vibrato']             : []),
  ];

  let lastPct = -1;

  const result = await runPython(pyArgs, msg => {
    if (msg.percent !== undefined && msg.percent !== lastPct) {
      lastPct = msg.percent;
      process.stdout.write(
        `\r  ${progressBar(msg.percent)} ${String(msg.percent).padStart(3)}%  ` +
        dim(msg.message.slice(0, 42).padEnd(42))
      );
    } else if (msg.percent === undefined) {
      if (lastPct >= 0) { process.stdout.write('\n'); lastPct = -1; }
      console.log(`  ${col('cyan', '→')} ${msg.message}`);
    }
  });

  if (lastPct >= 0) process.stdout.write('\n');
  console.log();

  exitOnFailure(result, 'Correction');

  const s = result.summary;
  console.log(col('green', '✓ Correction complete'));
  console.log();
  console.log(bold('─── Results ──────────────────────────────'));
  console.log(`  Notes analysed:     ${bold(s.notes_analyzed)}`);
  console.log(`  Notes corrected:    ${s.notes_corrected > 0 ? col('yellow', s.notes_corrected) : col('green', s.notes_corrected)}`);
  console.log(dim('──────────────────────────────────────────'));
  console.log();

  // Correction detail from report
  if (result.report && fs.existsSync(result.report)) {
    const rpt = JSON.parse(fs.readFileSync(result.report, 'utf8'));
    if (rpt.corrections.length > 0) {
      console.log(col('yellow', `Changes (${rpt.corrections.length}):`));
      rpt.corrections.forEach(c => {
        const noteStr = c.original_note !== c.corrected_note
          ? `${dim(c.original_note)} → ${col('green', c.corrected_note)}`
          : col('white', c.original_note);
        const acts = dim(c.actions.join('  '));
        console.log(`  ${dim(c.timestamp.toFixed(2) + 's')}  ${noteStr.padEnd(24)}  ${acts}`);
      });
      console.log();
    }
  }

  console.log(bold('─── Output files ──────────────────────────'));
  console.log(`  ${col('green', '✓')} Corrected audio:  ${col('cyan', result.output_wav)}`);
  if (result.output_midi)
    console.log(`  ${col('green', '✓')} MIDI file:        ${col('cyan', result.output_midi)}`);
  console.log(`  ${col('green', '✓')} Report JSON:      ${col('cyan', result.report)}`);
  console.log(dim('────────────────────────────────────────────'));
  console.log();
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------
function printHelp() {
  banner();
  console.log(bold('Usage:'));
  console.log(`  ${col('cyan', 'node cli.js analyze')} <input.wav|mp3> [options]`);
  console.log(`  ${col('cyan', 'node cli.js correct')} <input.wav|mp3> --fixes <analysis.json> [options]`);
  console.log(`  ${col('cyan', 'node cli.js check-deps')}`);
  console.log();
  console.log(bold('analyze options:'));
  console.log(`  ${dim('--output <path>')}       Output JSON  (default: <input>_analysis.json)`);
  console.log(`  ${dim('--sr     <rate>')}        Sample rate  (default: 22050)`);
  console.log(`  ${dim('--hop    <length>')}      Hop length   (default: 512)`);
  console.log();
  console.log(bold('correct options:'));
  console.log(`  ${dim('--fixes          <path>')}  Analysis JSON from analyze step  (required)`);
  console.log(`  ${dim('--output         <path>')}  Output WAV path  (default: <input>_corrected.wav)`);
  console.log(`  ${dim('--output-midi [<path>]')}  Export MIDI  (path optional, auto-named if flag-only)`);
  console.log(`  ${dim('--aggressiveness <0-1>')}  Correction strength  (default: 0.8)`);
  console.log(`  ${dim('--smooth-vibrato')}         Smooth out vibrato`);
  console.log();
  console.log(bold('Examples:'));
  console.log(`  ${dim('node cli.js analyze guitar_take.wav')}`);
  console.log(`  ${dim('node cli.js correct guitar_take.wav --fixes guitar_take_analysis.json --output-midi')}`);
  console.log(`  ${dim('node cli.js correct guitar_take.wav --fixes guitar_take_analysis.json --aggressiveness 0.5 --smooth-vibrato')}`);
  console.log();
}

async function cmdCheckDeps() {
  console.log(bold('\nChecking dependencies…\n'));
  const python = await findPython().catch(() => null);
  if (!python) {
    console.log(`  ${col('red', '✗')} Python 3 not found`);
    process.exit(1);
  }
  console.log(`  ${col('green', '✓')} Python: ${python}`);

  const pyCheck = `
import sys
mods = ['librosa','soundfile','scipy','numpy']
for m in mods:
    try:
        __import__(m)
        print('OK', m)
    except ImportError:
        print('MISSING', m)
try:
    from midiutil import MIDIFile
    print('OK midiutil')
except ImportError:
    print('OPTIONAL_MISSING midiutil')
`;

  const lines = await new Promise((res, rej) => {
    const p = spawn(python, ['-c', pyCheck], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.on('close', () => res(out.trim().split('\n')));
    p.on('error', rej);
  });

  let allOk = true;
  for (const line of lines) {
    const [status, mod] = line.trim().split(' ');
    if (status === 'OK') {
      console.log(`  ${col('green', '✓')} ${mod}`);
    } else if (status === 'MISSING') {
      console.log(`  ${col('red',    '✗')} ${mod}  ${dim('(required)')}`);
      allOk = false;
    } else if (status === 'OPTIONAL_MISSING') {
      console.log(`  ${col('yellow', '○')} ${mod}  ${dim('(optional – needed for MIDI export)')}`);
    }
  }

  if (!allOk) {
    console.log();
    console.log(col('yellow', 'Install missing packages:'));
    console.log(`  ${dim('pip install librosa soundfile scipy numpy')}`);
    console.log(`  ${dim('pip install midiutil   # for MIDI export')}`);
  }
  console.log();
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = {};
  const pos  = [];
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      // Treat next token as value only if it doesn't start with '--'
      if (next !== undefined && !next.startsWith('--')) {
        opts[key] = next;
        i += 2;
      } else {
        opts[key] = true;
        i += 1;
      }
    } else {
      pos.push(a);
      i++;
    }
  }
  return { opts, pos };
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------
function requireFile(filePath, label = 'file') {
  if (!fs.existsSync(filePath)) {
    die(`${label} not found: ${filePath}`);
  }
}

function exitOnFailure(result, label) {
  if (!result || !result.success) {
    die(`${label} failed: ${(result && result.error) || 'unknown error'}`);
  }
}

function die(msg) {
  console.error(`\n${col('red', '✗ Error:')} ${msg}\n`);
  process.exit(1);
}

function stripExt(filePath) {
  return filePath.replace(/\.[^/.]+$/, '');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
async function main() {
  const raw  = process.argv.slice(2);
  const cmd  = raw[0];

  if (!cmd || cmd === '--help' || cmd === '-h') {
    printHelp();
    return;
  }

  const { opts, pos } = parseArgs(raw.slice(1));

  try {
    switch (cmd) {
      case 'analyze':
        if (!pos[0]) die('Input file required.\n  node cli.js analyze <input.wav>');
        await cmdAnalyze(pos[0], opts);
        break;

      case 'correct':
        if (!pos[0]) die('Input file required.\n  node cli.js correct <input.wav> --fixes <analysis.json>');
        await cmdCorrect(pos[0], opts);
        break;

      case 'check-deps':
        await cmdCheckDeps();
        break;

      default:
        console.error(col('red', `Unknown command: ${cmd}`));
        printHelp();
        process.exit(1);
    }
  } catch (err) {
    console.error(`\n${col('red', '✗ Error:')} ${err.message}\n`);
    process.exit(1);
  }
}

main();
