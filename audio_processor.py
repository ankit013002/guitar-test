#!/usr/bin/env python3
"""Python backend for guitar audio correction: pitch detection, buzz removal, MIDI export."""

import sys
import json
import argparse
import warnings

import numpy as np
import librosa
import soundfile as sf
from scipy import signal

warnings.filterwarnings('ignore')

try:
    from midiutil import MIDIFile
    HAS_MIDI = True
except ImportError:
    HAS_MIDI = False

GUITAR_MIDI_MIN = 40   # E2
GUITAR_MIDI_MAX = 88   # E6


# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------

def _progress(message, step=None, total=None):
    """Emit a JSON progress line on stderr for the Node.js consumer."""
    payload = {"type": "progress", "message": message}
    if step is not None and total is not None:
        payload["percent"] = int(step / total * 100)
    print(json.dumps(payload), file=sys.stderr, flush=True)


def _result(data):
    """Emit the final JSON result on stdout."""
    print(json.dumps(data), flush=True)


# ---------------------------------------------------------------------------
# ANALYSIS
# ---------------------------------------------------------------------------

def analyze_audio(input_file, output_json, sr_target=22050, hop_length=512, frame_length=2048):
    _progress("Loading audio file…")
    y, sr = librosa.load(input_file, sr=sr_target, mono=True)
    duration = librosa.get_duration(y=y, sr=sr)
    _progress(f"Loaded {duration:.2f}s at {sr} Hz")

    # --- Onset detection ------------------------------------------------
    _progress("Detecting note onsets…")
    onset_frames = librosa.onset.onset_detect(
        y=y, sr=sr, hop_length=hop_length, backtrack=True, units='frames'
    )
    onset_times = librosa.frames_to_time(onset_frames, sr=sr, hop_length=hop_length)

    # Sentinel at end
    onset_frames = np.append(onset_frames, len(y) // hop_length)
    onset_times  = np.append(onset_times,  duration)

    # --- Pitch detection (pyin – robust for guitar) ----------------------
    _progress("Running pYIN pitch detection…")
    f0, voiced_flag, voiced_probs = librosa.pyin(
        y,
        fmin=librosa.note_to_hz('E2'),
        fmax=librosa.note_to_hz('E6'),
        sr=sr,
        hop_length=hop_length,
        frame_length=frame_length,
    )

    # --- Spectral features for buzz detection ---------------------------
    _progress("Computing spectral features…")
    D         = librosa.stft(y, n_fft=frame_length, hop_length=hop_length)
    magnitude = np.abs(D)
    freqs     = librosa.fft_frequencies(sr=sr, n_fft=frame_length)

    buzz_mask   = freqs > 5000
    normal_mask = (freqs > 80) & (freqs <= 5000)

    high_energy   = magnitude[buzz_mask,   :].sum(axis=0)
    normal_energy = magnitude[normal_mask, :].sum(axis=0)
    buzz_ratio    = high_energy / (normal_energy + 1e-8)

    # --- Per-note analysis ----------------------------------------------
    _progress("Analysing individual notes…")
    notes = []
    n_segs = len(onset_frames) - 1

    for i in range(n_segs):
        fs = int(onset_frames[i])
        fe = int(onset_frames[i + 1])
        if fs >= fe:
            continue

        seg_f0      = f0[fs:fe]
        seg_voiced  = voiced_flag[fs:fe]
        seg_probs   = voiced_probs[fs:fe]
        seg_buzz    = buzz_ratio[fs:fe]

        voiced_f0 = seg_f0[seg_voiced & (seg_f0 > 0)]
        if len(voiced_f0) < 3:
            continue

        median_freq         = float(np.median(voiced_f0))
        midi_float          = librosa.hz_to_midi(median_freq)
        midi_note           = int(round(midi_float))
        midi_note           = int(np.clip(midi_note, 0, 127))
        note_name           = librosa.midi_to_note(midi_note)
        pitch_dev_cents     = float((midi_float - midi_note) * 100)
        confidence          = float(np.mean(seg_probs[seg_voiced]) if seg_voiced.any() else 0.0)
        buzz_score          = float(np.percentile(seg_buzz, 95))

        voiced_midi_vals    = librosa.hz_to_midi(voiced_f0)
        vibrato_semitones   = float(np.std(voiced_midi_vals)) if len(voiced_midi_vals) > 1 else 0.0

        has_buzz    = buzz_score > 0.30
        off_pitch   = abs(pitch_dev_cents) > 20
        has_vibrato = vibrato_semitones > 0.15

        notes.append({
            "index":                i,
            "timestamp":            float(onset_times[i]),
            "duration":             float(onset_times[i + 1] - onset_times[i]),
            "original_freq_hz":     median_freq,
            "original_note":        note_name,
            "original_midi":        midi_note,
            "pitch_deviation_cents": pitch_dev_cents,
            "corrected_note":       note_name,
            "corrected_freq_hz":    median_freq,
            "confidence":           round(confidence, 3),
            "buzz_score":           round(buzz_score, 4),
            "has_buzz":             has_buzz,
            "off_pitch":            off_pitch,
            "has_vibrato":          has_vibrato,
            "vibrato_semitones":    round(vibrato_semitones, 3),
            "was_corrected":        False,
            "frame_start":          fs,
            "frame_end":            fe,
            "sample_start":         int(librosa.frames_to_samples(fs,  hop_length=hop_length)),
            "sample_end":           int(librosa.frames_to_samples(fe,  hop_length=hop_length)),
        })

    total         = len(notes)
    flagged       = sum(1 for n in notes if n['has_buzz'] or n['off_pitch'] or n['confidence'] < 0.5)
    buzz_count    = sum(1 for n in notes if n['has_buzz'])
    off_pitch_cnt = sum(1 for n in notes if n['off_pitch'])
    avg_conf      = float(np.mean([n['confidence'] for n in notes])) if notes else 0.0

    analysis = {
        "input_file":        input_file,
        "duration_seconds":  duration,
        "sample_rate":       sr,
        "hop_length":        hop_length,
        "total_notes":       total,
        "flagged_notes":     flagged,
        "buzz_notes":        buzz_count,
        "off_pitch_notes":   off_pitch_cnt,
        "average_confidence": round(avg_conf, 3),
        "notes":             notes,
    }

    with open(output_json, 'w') as fh:
        json.dump(analysis, fh, indent=2)

    _progress(f"Done: {total} notes, {flagged} flagged")
    _result({
        "success": True,
        "output":  output_json,
        "summary": {
            "total_notes":       total,
            "flagged_notes":     flagged,
            "buzz_notes":        buzz_count,
            "off_pitch_notes":   off_pitch_cnt,
            "average_confidence": round(avg_conf, 3),
            "duration":          round(duration, 2),
        },
    })


# ---------------------------------------------------------------------------
# CORRECTION
# ---------------------------------------------------------------------------

def correct_audio(input_file, fixes_json, output_wav,
                  output_midi=None, aggressiveness=0.8, smooth_vibrato=False):

    _progress("Loading analysis…")
    with open(fixes_json) as fh:
        analysis = json.load(fh)

    sr         = analysis['sample_rate']
    hop_length = analysis['hop_length']
    notes      = analysis['notes']

    _progress("Loading audio…")
    y, _sr = librosa.load(input_file, sr=sr, mono=True)
    y_out  = y.copy()

    total       = len(notes)
    corrections = []

    for idx, note in enumerate(notes):
        _progress(f"Note {idx + 1}/{total}: {note['original_note']}", idx + 1, total)

        ss = note['sample_start']
        se = min(note['sample_end'], len(y_out))
        if ss >= se:
            continue

        seg      = y_out[ss:se].copy()
        modified = False
        c_info   = {
            "index":          note['index'],
            "timestamp":      note['timestamp'],
            "original_note":  note['original_note'],
            "corrected_note": note['original_note'],
            "actions":        [],
        }

        # --- Pitch correction -------------------------------------------
        dev_cents = note['pitch_deviation_cents']
        if note['off_pitch'] and abs(dev_cents) > 10:
            shift_semitones = (-dev_cents * aggressiveness) / 100.0
            if abs(shift_semitones) > 0.05:
                try:
                    seg = librosa.effects.pitch_shift(
                        seg, sr=sr, n_steps=shift_semitones, bins_per_octave=24
                    )
                    note['corrected_note']    = librosa.midi_to_note(note['original_midi'])
                    note['corrected_freq_hz'] = float(librosa.midi_to_hz(note['original_midi']))
                    note['was_corrected']     = True
                    modified                  = True
                    c_info['corrected_note']  = note['corrected_note']
                    c_info['actions'].append(f"pitch_shift {dev_cents:+.1f}¢")
                except Exception as exc:
                    c_info['actions'].append(f"pitch_shift_err: {exc}")

        # --- Octave correction (out-of-guitar-range MIDI) ----------------
        midi_val = note['original_midi']
        if midi_val < GUITAR_MIDI_MIN or midi_val > GUITAR_MIDI_MAX:
            corrected_midi = midi_val
            while corrected_midi < GUITAR_MIDI_MIN:
                corrected_midi += 12
            while corrected_midi > GUITAR_MIDI_MAX:
                corrected_midi -= 12
            if corrected_midi != midi_val:
                shift = corrected_midi - midi_val
                try:
                    seg = librosa.effects.pitch_shift(seg, sr=sr, n_steps=shift)
                    note['corrected_note']    = librosa.midi_to_note(corrected_midi)
                    note['corrected_freq_hz'] = float(librosa.midi_to_hz(corrected_midi))
                    note['was_corrected']     = True
                    modified                  = True
                    c_info['corrected_note']  = note['corrected_note']
                    c_info['actions'].append(
                        f"octave_fix {note['original_note']}→{note['corrected_note']}"
                    )
                except Exception as exc:
                    c_info['actions'].append(f"octave_fix_err: {exc}")

        # --- Vibrato smoothing (optional) --------------------------------
        if smooth_vibrato and note.get('has_vibrato') and len(seg) > 20:
            b, a = signal.butter(2, 0.3, btype='low')
            seg      = signal.filtfilt(b, a, seg)
            modified = True
            c_info['actions'].append("vibrato_smoothed")

        # --- Buzz removal ------------------------------------------------
        if note['has_buzz']:
            buzz_score = note['buzz_score']
            cutoff_hz  = max(3000, int(5000 - buzz_score * 1000 * aggressiveness))
            nyquist    = sr / 2
            norm_cut   = cutoff_hz / nyquist

            if norm_cut < 0.99 and len(seg) > 20:
                try:
                    b, a     = signal.butter(4, norm_cut, btype='low')
                    filtered = signal.filtfilt(b, a, seg)
                    blend    = min(0.9, buzz_score * aggressiveness * 1.5)
                    seg      = (1.0 - blend) * seg + blend * filtered
                    note['was_corrected'] = True
                    modified              = True
                    c_info['actions'].append(
                        f"buzz_removed cutoff={cutoff_hz}Hz blend={blend:.2f}"
                    )
                except Exception as exc:
                    c_info['actions'].append(f"buzz_removal_err: {exc}")

        if modified:
            # Preserve original RMS level to avoid loudness shift
            orig_peak = np.max(np.abs(y_out[ss:se])) + 1e-8
            seg_peak  = np.max(np.abs(seg))            + 1e-8
            seg       = seg * (orig_peak / seg_peak)
            length    = se - ss
            y_out[ss:se] = seg[:length]
            corrections.append(c_info)

    # Normalize to prevent clipping
    _progress("Normalising output…")
    peak = np.max(np.abs(y_out))
    if peak > 0.98:
        y_out = y_out * (0.95 / peak)

    _progress(f"Writing {output_wav}…")
    sf.write(output_wav, y_out, sr, subtype='PCM_16')

    report_path = output_wav.replace('.wav', '_correction_report.json')
    report = {
        "input_file":        input_file,
        "output_file":       output_wav,
        "aggressiveness":    aggressiveness,
        "total_corrections": len(corrections),
        "corrections":       corrections,
        "notes": [
            {
                "timestamp":      n['timestamp'],
                "original_note":  n['original_note'],
                "corrected_note": n['corrected_note'],
                "confidence":     n['confidence'],
                "was_corrected":  n['was_corrected'],
                "has_buzz":       n['has_buzz'],
                "off_pitch":      n['off_pitch'],
            }
            for n in notes
        ],
    }
    with open(report_path, 'w') as fh:
        json.dump(report, fh, indent=2)

    # --- MIDI export ----------------------------------------------------
    midi_out = None
    if output_midi:
        if not HAS_MIDI:
            _progress("midiutil not installed — skipping MIDI export")
        else:
            _progress("Generating MIDI…")
            try:
                midi = MIDIFile(1)
                midi.addTempo(0, 0, 120)
                for n in notes:
                    if n['corrected_freq_hz'] <= 0:
                        continue
                    pitch    = int(np.clip(
                        round(librosa.hz_to_midi(n['corrected_freq_hz'])), 0, 127
                    ))
                    t_beats  = n['timestamp'] * 120 / 60
                    d_beats  = max(0.1, n['duration'] * 120 / 60)
                    velocity = int(np.clip(n['confidence'] * 100, 40, 127))
                    midi.addNote(0, 0, pitch, t_beats, d_beats, velocity)
                with open(output_midi, 'wb') as fh:
                    midi.writeFile(fh)
                midi_out = output_midi
                _progress(f"MIDI saved to {output_midi}")
            except Exception as exc:
                _progress(f"MIDI export failed: {exc}")

    notes_corrected = sum(1 for n in notes if n['was_corrected'])
    _result({
        "success":     True,
        "output_wav":  output_wav,
        "output_midi": midi_out,
        "report":      report_path,
        "summary": {
            "notes_analyzed":  len(notes),
            "notes_corrected": notes_corrected,
            "corrections_made": len(corrections),
        },
    })


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description='Guitar Audio Correction – Python backend')
    sub    = parser.add_subparsers(dest='command')

    ap = sub.add_parser('analyze')
    ap.add_argument('input')
    ap.add_argument('--output',  default=None)
    ap.add_argument('--sr',      type=int,   default=22050)
    ap.add_argument('--hop',     type=int,   default=512)

    cp = sub.add_parser('correct')
    cp.add_argument('input')
    cp.add_argument('--fixes',            required=True)
    cp.add_argument('--output',           default=None)
    cp.add_argument('--output-midi',      default=None)
    cp.add_argument('--aggressiveness',   type=float, default=0.8)
    cp.add_argument('--smooth-vibrato',   action='store_true')

    args = parser.parse_args()

    if args.command == 'analyze':
        out = args.output or args.input.rsplit('.', 1)[0] + '_analysis.json'
        analyze_audio(args.input, out, sr_target=args.sr, hop_length=args.hop)

    elif args.command == 'correct':
        out = args.output or args.input.rsplit('.', 1)[0] + '_corrected.wav'
        correct_audio(
            args.input, args.fixes, out,
            output_midi    = getattr(args, 'output_midi', None),
            aggressiveness = args.aggressiveness,
            smooth_vibrato = args.smooth_vibrato,
        )
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == '__main__':
    main()
