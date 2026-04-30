#!/usr/bin/env node
'use strict';

const { spawn }  = require('child_process');
const path       = require('path');
const fs         = require('fs');
const readline   = require('readline');

// ---------------------------------------------------------------------------
// ANSI colours
// ---------------------------------------------------------------------------
const IS_TTY = process.stdout.isTTY;

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m',
  cyan:  '\x1b[36m', red:    '\x1b[31m', white: '\x1b[37m',
};

function col(name, text) { return IS_TTY ? `${C[name]}${text}${C.reset}` : text; }
function bold(text)  { return IS_TTY ? `${C.bold}${text}${C.reset}`  : text; }
function dim(text)   { return IS_TTY ? `${C.dim}${text}${C.reset}`   : text; }

// Pad to a visual width, ignoring ANSI escape sequences in the length count
function padVisual(str, len) {
  const stripped = str.replace(/\x1b\[[0-9;]*m/g, '');
  return str + ' '.repeat(Math.max(0, len - stripped.length));
}

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
  return col('cyan', '█'.repeat(filled)) + dim('░'.repeat(width - filled));
}

function confColor(conf) {
  const pct = (conf * 100).toFixed(0) + '%';
  return conf >= 0.8 ? col('green', pct) : conf >= 0.5 ? col('yellow', pct) : col('red', pct);
}

function noteFlags(note) {
  const f = [];
  if (note.has_buzz) f.push(col('red', 'BUZZ'));
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
  return `  ${ts}  ${padVisual(name, 16)}  conf:${confColor(note.confidence)}  ${noteFlags(note)}`;
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
    let python;
    try { python = await findPython(); } catch (e) { return reject(e); }

    const scriptPath = path.join(__dirname, 'audio_processor.py');
    if (!fs.existsSync(scriptPath))
      return reject(new Error(`audio_processor.py not found at ${scriptPath}`));

    const proc = spawn(python, [scriptPath, ...pyArgs], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => {
      for (const line of d.toString().split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const msg = JSON.parse(t);
          if (msg.type === 'progress' && onProgress) onProgress(msg);
        } catch { process.stderr.write(dim(t) + '\n'); }
      }
    });

    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`audio_processor.py exited with code ${code}`));
      const raw = stdout.trim();
      if (!raw) return reject(new Error('No output from audio_processor.py'));
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error(`Could not parse Python output:\n${raw}`)); }
    });

    proc.on('error', err => reject(new Error(`Failed to spawn Python: ${err.message}`)));
  });
}

// ---------------------------------------------------------------------------
// Progress display helper
// ---------------------------------------------------------------------------
function makeProgressHandler() {
  let lastPct = -1;
  function onProgress(msg) {
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
  }
  function flush() { if (lastPct >= 0) { process.stdout.write('\n'); lastPct = -1; } }
  return { onProgress, flush };
}

// ---------------------------------------------------------------------------
// analyze
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

  const { onProgress, flush } = makeProgressHandler();
  const result = await runPython(
    ['analyze', inputFile, '--output', outputJson,
     ...(opts.sr  ? ['--sr',  String(opts.sr)]  : []),
     ...(opts.hop ? ['--hop', String(opts.hop)] : [])],
    onProgress
  );
  flush();
  console.log();
  exitOnFailure(result, 'Analysis');

  const s = result.summary;
  console.log(col('green', '✓ Analysis complete'));
  console.log();
  console.log(bold('─── Summary ──────────────────────────────'));
  console.log(`  Duration:           ${bold(s.duration + 's')}`);
  console.log(`  Tempo:              ${bold(s.tempo_bpm + ' BPM')}`);
  console.log(`  Notes detected:     ${bold(s.total_notes)}`);
  console.log(`  Flagged:            ${s.flagged_notes   > 0 ? col('yellow', s.flagged_notes)   : col('green', s.flagged_notes)}`);
  console.log(`    Buzz issues:      ${s.buzz_notes      > 0 ? col('red',    s.buzz_notes)      : col('green', s.buzz_notes)}`);
  console.log(`    Off-pitch:        ${s.off_pitch_notes > 0 ? col('yellow', s.off_pitch_notes) : col('green', s.off_pitch_notes)}`);
  console.log(`  Avg confidence:     ${confColor(s.average_confidence)}`);
  console.log(dim('──────────────────────────────────────────'));
  console.log();

  const analysis = JSON.parse(fs.readFileSync(outputJson, 'utf8'));
  const flagged  = analysis.notes.filter(n => n.has_buzz || n.off_pitch || n.confidence < 0.5);

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
  console.log(bold('Next steps:'));
  console.log(`  ${col('cyan', `node cli.js review  ${outputJson}`)}`);
  console.log(`  ${col('cyan', `node cli.js correct ${inputFile} --fixes ${outputJson}`)}`);
  console.log(`  ${col('cyan', `node cli.js preview ${inputFile} --analysis ${outputJson}`)}`);
  console.log();
}

// ---------------------------------------------------------------------------
// correct
// ---------------------------------------------------------------------------
async function cmdCorrect(inputFile, opts) {
  banner();
  requireFile(inputFile);
  if (!opts.fixes) die(`--fixes <analysis.json> is required.\nRun first: node cli.js analyze ${inputFile}`);
  requireFile(opts.fixes, '--fixes');

  const outputWav  = opts.output || stripExt(inputFile) + '_corrected.wav';
  const midiFlag   = opts['output-midi'];
  const outputMidi = midiFlag ? (midiFlag === true ? stripExt(inputFile) + '.mid' : midiFlag) : null;
  const aggr       = parseFloat(opts.aggressiveness || '0.8');
  const smoothVib  = opts['smooth-vibrato'] === true || opts['smooth-vibrato'] === 'true';

  console.log(`${bold('Input:')}            ${col('cyan', inputFile)}`);
  console.log(`${bold('Fixes:')}            ${col('cyan', opts.fixes)}`);
  console.log(`${bold('Output WAV:')}       ${col('cyan', outputWav)}`);
  if (outputMidi) console.log(`${bold('Output MIDI:')}      ${col('cyan', outputMidi)}`);
  console.log(`${bold('Aggressiveness:')}   ${col('cyan', (aggr * 100).toFixed(0) + '%')}`);
  if (smoothVib)  console.log(`${bold('Vibrato:')}          ${col('yellow', 'smoothing on (OLA)')}`);
  console.log();
  console.log(col('blue', '▶ Correcting…'));
  console.log();

  const { onProgress, flush } = makeProgressHandler();
  const result = await runPython([
    'correct', inputFile,
    '--fixes',          opts.fixes,
    '--output',         outputWav,
    '--aggressiveness', String(aggr),
    ...(outputMidi  ? ['--output-midi',    outputMidi] : []),
    ...(smoothVib   ? ['--smooth-vibrato']             : []),
  ], onProgress);
  flush();
  console.log();
  exitOnFailure(result, 'Correction');

  const s = result.summary;
  console.log(col('green', '✓ Correction complete'));
  console.log();
  console.log(bold('─── Results ──────────────────────────────'));
  console.log(`  Notes analysed:     ${bold(s.notes_analyzed)}`);
  console.log(`  Notes corrected:    ${s.notes_corrected > 0 ? col('yellow', s.notes_corrected) : col('green', s.notes_corrected)}`);
  console.log(`  Tempo (MIDI):       ${bold(s.tempo_bpm + ' BPM')}`);
  console.log(dim('──────────────────────────────────────────'));
  console.log();

  if (result.report && fs.existsSync(result.report)) {
    const rpt = JSON.parse(fs.readFileSync(result.report, 'utf8'));
    if (rpt.corrections.length > 0) {
      console.log(col('yellow', `Changes (${rpt.corrections.length}):`));
      rpt.corrections.forEach(c => {
        const noteStr = c.original_note !== c.corrected_note
          ? `${dim(c.original_note)} → ${col('green', c.corrected_note)}`
          : col('white', c.original_note);
        console.log(`  ${dim(c.timestamp.toFixed(2) + 's')}  ${padVisual(noteStr, 18)}  ${dim(c.actions.join('  '))}`);
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
// review – interactive TUI
// ---------------------------------------------------------------------------
async function cmdReview(analysisFile, opts) {
  if (!fs.existsSync(analysisFile)) die(`File not found: ${analysisFile}`);
  if (!process.stdin.isTTY)         die('review requires an interactive terminal (cannot pipe)');

  const analysis = JSON.parse(fs.readFileSync(analysisFile, 'utf8'));
  const flagged  = analysis.notes.filter(n => n.has_buzz || n.off_pitch || n.confidence < 0.5);

  if (flagged.length === 0) {
    banner();
    console.log(col('green', '✓ No flagged notes — nothing to review.'));
    console.log();
    return;
  }

  // Initialise per-note decisions (default: apply what analysis flagged)
  for (const n of flagged) {
    if (n.pitch_correct_approved === undefined) n.pitch_correct_approved = n.off_pitch;
    if (n.buzz_remove_approved   === undefined) n.buzz_remove_approved   = n.has_buzz;
  }

  let idx = 0;
  const W = 54;  // inner content width

  function render() {
    process.stdout.write('\x1b[2J\x1b[H');
    const n   = flagged[idx];
    const sep = col('cyan', '├' + '─'.repeat(W + 2) + '┤');
    const ln  = (s = '') => process.stdout.write(col('cyan', '│') + ' ' + padVisual(s, W) + ' ' + col('cyan', '│\n'));

    console.log(col('cyan', '┌' + '─'.repeat(W + 2) + '┐'));
    ln(bold('Guitar Correction Review'));
    ln(dim(`Flagged note ${idx + 1} of ${flagged.length}  ·  ${path.basename(analysisFile)}`));
    console.log(sep);

    ln(`Note: ${bold(n.original_note)}   at ${n.timestamp.toFixed(2)}s   dur: ${n.duration.toFixed(2)}s`);
    ln(`Confidence: ${confColor(n.confidence)}   Freq: ${n.original_freq_hz.toFixed(1)} Hz`);
    ln();

    if (n.off_pitch) {
      const sign = n.pitch_deviation_cents > 0 ? '+' : '';
      ln(col('yellow', `⚠ Off-pitch: ${sign}${n.pitch_deviation_cents.toFixed(0)}¢ from nearest semitone`));
    }
    if (n.has_buzz)    ln(col('red',  `⚠ Buzz detected  (score: ${n.buzz_score.toFixed(3)})`));
    if (n.has_vibrato) ln(col('blue', `≈ Vibrato: ±${n.vibrato_semitones.toFixed(2)} semitones`));
    if (!n.off_pitch && !n.has_buzz && !n.has_vibrato) ln(col('yellow', '⚠ Low confidence'));

    console.log(sep);

    const pState = n.pitch_correct_approved ? col('green', '● ON ') : col('red',   '○ OFF');
    const bState = n.buzz_remove_approved   ? col('green', '● ON ') : col('red',   '○ OFF');
    ln(`[P] Pitch correction: ${pState}   [B] Buzz removal: ${bState}`);

    console.log(sep);
    ln(`${dim('← →')} navigate   ${dim('A')} approve rest   ${dim('S')} skip rest   ${dim('Q')} save & quit`);
    console.log(col('cyan', '└' + '─'.repeat(W + 2) + '┘'));

    // Progress dots
    const dots = flagged.map((fn, i) => {
      const active = fn.pitch_correct_approved || fn.buzz_remove_approved;
      if (i === idx) return col('cyan',  '●');
      return active ? col('green', '·') : dim('·');
    }).join('');
    console.log(`\n  ${dots}  ${dim(`(${idx + 1}/${flagged.length})`)}`);
  }

  return new Promise(resolve => {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const cleanup = (save) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeAllListeners('keypress');
      process.stdout.write('\x1b[2J\x1b[H');

      if (save) {
        // flagged entries are object refs into analysis.notes, so changes are already reflected
        fs.writeFileSync(analysisFile, JSON.stringify(analysis, null, 2));
        const nOn = flagged.filter(n => n.pitch_correct_approved || n.buzz_remove_approved).length;
        console.log(col('green', `✓ Saved: ${nOn}/${flagged.length} notes queued for correction`));
        console.log(`  ${dim('File:')} ${col('cyan', analysisFile)}`);
        console.log();
        console.log(bold('Next step:'));
        console.log(`  ${col('cyan', `node cli.js correct ${analysis.input_file} --fixes ${analysisFile}`)}`);
      } else {
        console.log(col('yellow', 'Review cancelled — no changes saved.'));
      }
      console.log();
      resolve();
    };

    process.stdin.on('keypress', (str, key) => {
      if (!key) return;
      const n = flagged[idx];

      if (key.ctrl && key.name === 'c') { cleanup(false); return; }

      switch (true) {
        case key.name === 'right':
          idx = Math.min(idx + 1, flagged.length - 1); break;
        case key.name === 'left':
          idx = Math.max(idx - 1, 0); break;
        case str === 'p' || str === 'P':
          n.pitch_correct_approved = !n.pitch_correct_approved; break;
        case str === 'b' || str === 'B':
          n.buzz_remove_approved = !n.buzz_remove_approved; break;
        case str === 'a' || str === 'A':
          flagged.slice(idx).forEach(fn => {
            fn.pitch_correct_approved = fn.off_pitch;
            fn.buzz_remove_approved   = fn.has_buzz;
          }); break;
        case str === 's' || str === 'S':
          flagged.slice(idx).forEach(fn => {
            fn.pitch_correct_approved = false;
            fn.buzz_remove_approved   = false;
          }); break;
        case str === 'q' || str === 'Q' || key.name === 'return':
          cleanup(true); return;
      }
      render();
    });

    render();
  });
}

// ---------------------------------------------------------------------------
// preview – spectrogram generation
// ---------------------------------------------------------------------------
async function cmdPreview(inputFile, opts) {
  banner();
  requireFile(inputFile);

  const compareFile  = typeof opts.compare  === 'string' ? opts.compare  : null;
  const analysisFile = typeof opts.analysis === 'string' ? opts.analysis
                     : typeof opts.fixes    === 'string' ? opts.fixes    : null;
  const outputPng    = opts.output || stripExt(inputFile) + '_spectrogram.png';

  if (compareFile  && !fs.existsSync(compareFile))  die(`--compare file not found: ${compareFile}`);
  if (analysisFile && !fs.existsSync(analysisFile)) die(`--analysis file not found: ${analysisFile}`);

  console.log(`${bold('Input:')}    ${col('cyan', inputFile)}`);
  if (compareFile)  console.log(`${bold('Compare:')}  ${col('cyan', compareFile)}`);
  if (analysisFile) console.log(`${bold('Analysis:')} ${col('cyan', analysisFile)}`);
  console.log(`${bold('Output:')}   ${col('cyan', outputPng)}`);
  console.log();
  console.log(col('blue', '▶ Generating spectrogram…'));
  console.log();

  const result = await runPython([
    'spectrogram', inputFile,
    '--output', outputPng,
    ...(analysisFile ? ['--analysis', analysisFile] : []),
    ...(compareFile  ? ['--compare',  compareFile]  : []),
  ], msg => console.log(`  ${col('cyan', '→')} ${msg.message}`));

  exitOnFailure(result, 'Spectrogram');
  console.log();
  console.log(col('green', `✓ Spectrogram saved: ${result.output}`));
  console.log();

  if (!opts['no-open']) {
    try {
      openFile(result.output);
      console.log(dim('Opening image viewer…'));
    } catch { /* silently skip on headless */ }
  }
  console.log();
}

function openFile(filePath) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32'          ? 'start'
    : 'xdg-open';
  spawn(cmd, [filePath], {
    detached: true, stdio: 'ignore', shell: process.platform === 'win32'
  }).unref();
}

// ---------------------------------------------------------------------------
// check-deps
// ---------------------------------------------------------------------------
async function cmdCheckDeps() {
  console.log(bold('\nChecking dependencies…\n'));
  let python;
  try { python = await findPython(); }
  catch { console.log(`  ${col('red', '✗')} Python 3 not found`); process.exit(1); }
  console.log(`  ${col('green', '✓')} Python: ${python}`);

  const pyCheck = `
mods = ['librosa','soundfile','scipy','numpy']
for m in mods:
    try: __import__(m); print('OK', m)
    except ImportError: print('MISSING', m)
for m in ['midiutil', 'matplotlib']:
    try: __import__(m); print('OK', m)
    except ImportError: print('OPTIONAL_MISSING', m)
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
    if (status === 'OK')
      console.log(`  ${col('green', '✓')} ${mod}`);
    else if (status === 'MISSING') {
      console.log(`  ${col('red', '✗')} ${mod}  ${dim('(required)')}`);
      allOk = false;
    } else if (status === 'OPTIONAL_MISSING')
      console.log(`  ${col('yellow', '○')} ${mod}  ${dim('(optional)')}`);
  }

  if (!allOk) {
    console.log();
    console.log(col('yellow', 'Install missing packages:'));
    console.log(`  ${dim('pip install librosa soundfile scipy numpy')}`);
    console.log(`  ${dim('pip install midiutil matplotlib   # optional')}`);
  }
  console.log();
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------
function printHelp() {
  banner();
  console.log(bold('Usage:'));
  console.log(`  ${col('cyan', 'node cli.js analyze')}   <input.wav>  [options]`);
  console.log(`  ${col('cyan', 'node cli.js review')}    <analysis.json>`);
  console.log(`  ${col('cyan', 'node cli.js correct')}   <input.wav>  --fixes <analysis.json>  [options]`);
  console.log(`  ${col('cyan', 'node cli.js preview')}   <input.wav>  [options]`);
  console.log(`  ${col('cyan', 'node cli.js check-deps')}`);
  console.log();
  console.log(bold('analyze options:'));
  console.log(`  ${dim('--output <path>')}        JSON output  (default: <input>_analysis.json)`);
  console.log(`  ${dim('--sr     <rate>')}         Sample rate  (default: 22050)`);
  console.log();
  console.log(bold('review keys:'));
  console.log(`  ${dim('← →')}  navigate notes   ${dim('P')}  toggle pitch correction`);
  console.log(`  ${dim('B')}    toggle buzz removal   ${dim('A')}  approve rest   ${dim('S')}  skip rest   ${dim('Q')}  save & quit`);
  console.log();
  console.log(bold('correct options:'));
  console.log(`  ${dim('--fixes <path>')}           Analysis JSON  (required)`);
  console.log(`  ${dim('--output <path>')}           Output WAV     (default: <input>_corrected.wav)`);
  console.log(`  ${dim('--output-midi [<path>]')}   Export MIDI    (auto-named if no path given)`);
  console.log(`  ${dim('--aggressiveness <0-1>')}   Correction strength  (default: 0.8)`);
  console.log(`  ${dim('--smooth-vibrato')}          Remove vibrato via OLA pitch correction`);
  console.log();
  console.log(bold('preview options:'));
  console.log(`  ${dim('--analysis <path>')}        Overlay note markers from analysis JSON`);
  console.log(`  ${dim('--compare  <path>')}        Side-by-side with corrected WAV`);
  console.log(`  ${dim('--output   <path>')}        PNG output  (default: <input>_spectrogram.png)`);
  console.log(`  ${dim('--no-open')}                Don't launch image viewer`);
  console.log();
  console.log(bold('Examples:'));
  console.log(`  ${dim('node cli.js analyze  guitar.wav')}`);
  console.log(`  ${dim('node cli.js review   guitar_analysis.json')}`);
  console.log(`  ${dim('node cli.js correct  guitar.wav --fixes guitar_analysis.json --output-midi --smooth-vibrato')}`);
  console.log(`  ${dim('node cli.js preview  guitar.wav --analysis guitar_analysis.json --compare guitar_corrected.wav')}`);
  console.log();
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = {}, pos = [];
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key  = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { opts[key] = next; i += 2; }
      else { opts[key] = true; i += 1; }
    } else { pos.push(a); i++; }
  }
  return { opts, pos };
}

function requireFile(filePath, label = 'file') {
  if (!fs.existsSync(filePath)) die(`${label} not found: ${filePath}`);
}

function exitOnFailure(result, label) {
  if (!result || !result.success)
    die(`${label} failed: ${(result && result.error) || 'unknown error'}`);
}

function die(msg) {
  console.error(`\n${col('red', '✗ Error:')} ${msg}\n`);
  process.exit(1);
}

function stripExt(filePath) { return filePath.replace(/\.[^/.]+$/, ''); }

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
async function main() {
  const raw = process.argv.slice(2);
  const cmd = raw[0];

  if (!cmd || cmd === '--help' || cmd === '-h') { printHelp(); return; }

  const { opts, pos } = parseArgs(raw.slice(1));

  try {
    switch (cmd) {
      case 'analyze':
        if (!pos[0]) die('Input file required.\n  node cli.js analyze <input.wav>');
        await cmdAnalyze(pos[0], opts); break;

      case 'review':
        if (!pos[0]) die('Analysis JSON required.\n  node cli.js review <analysis.json>');
        await cmdReview(pos[0], opts); break;

      case 'correct':
        if (!pos[0]) die('Input file required.\n  node cli.js correct <input.wav> --fixes <analysis.json>');
        await cmdCorrect(pos[0], opts); break;

      case 'preview':
        if (!pos[0]) die('Input file required.\n  node cli.js preview <input.wav>');
        await cmdPreview(pos[0], opts); break;

      case 'check-deps':
        await cmdCheckDeps(); break;

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
