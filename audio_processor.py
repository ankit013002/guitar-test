#!/usr/bin/env python3
"""Python backend for guitar audio correction: pitch detection, buzz removal, MIDI export, spectrogram."""

import sys
import os
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
    payload = {"type": "progress", "message": message}
    if step is not None and total is not None:
        payload["percent"] = int(step / total * 100)
    print(json.dumps(payload), file=sys.stderr, flush=True)


def _result(data):
    print(json.dumps(data), flush=True)


# ---------------------------------------------------------------------------
# Vibrato smoothing – OLA time-varying pitch correction
# ---------------------------------------------------------------------------

def _vibrato_smooth_ola(segment, f0_frames, sr, hop_length, target_hz):
    """
    Overlap-add pitch correction: each chunk is shifted toward target_hz
    based on its local median f0. Removes within-note pitch variation (vibrato).
    """
    if target_hz <= 0 or not f0_frames or len(segment) < hop_length * 4:
        return segment

    target_midi = float(librosa.hz_to_midi(target_hz))
    chunk_size  = hop_length * 16   # ~371 ms at 22050/512
    hop_size    = hop_length * 8    # ~186 ms
    window      = np.hanning(chunk_size).astype(np.float32)
    n_f0        = len(f0_frames)

    out     = np.zeros(len(segment) + chunk_size, dtype=np.float32)
    weights = np.zeros(len(segment) + chunk_size, dtype=np.float32)

    for chunk_start in range(0, len(segment), hop_size):
        chunk = np.zeros(chunk_size, dtype=np.float32)
        end   = min(chunk_start + chunk_size, len(segment))
        chunk[:end - chunk_start] = segment[chunk_start:end]

        f0_lo      = chunk_start // hop_length
        f0_hi      = min((chunk_start + chunk_size) // hop_length, n_f0)
        voiced_f0s = [f0_frames[i] for i in range(f0_lo, f0_hi) if i < n_f0 and f0_frames[i] > 0]

        if voiced_f0s:
            src_midi = float(librosa.hz_to_midi(float(np.median(voiced_f0s))))
            n_steps  = target_midi - src_midi
            if abs(n_steps) > 0.05:
                try:
                    chunk = librosa.effects.pitch_shift(
                        chunk, sr=sr, n_steps=n_steps, bins_per_octave=24
                    )
                except Exception:
                    pass

        windowed = chunk * window
        out[chunk_start:chunk_start + chunk_size]     += windowed
        weights[chunk_start:chunk_start + chunk_size] += window

    seg_len = len(segment)
    w       = weights[:seg_len]
    o       = out[:seg_len]
    valid   = w > 0.01
    result  = np.where(valid, o / np.where(valid, w, 1.0), segment.astype(np.float32))
    return result


# ---------------------------------------------------------------------------
# Analysis
# ---------------------------------------------------------------------------

def analyze_audio(input_file, output_json, sr_target=22050, hop_length=512, frame_length=2048):
    _progress("Loading audio file…")
    y, sr    = librosa.load(input_file, sr=sr_target, mono=True)
    duration = librosa.get_duration(y=y, sr=sr)
    _progress(f"Loaded {duration:.2f}s at {sr} Hz")

    # Tempo detection
    _progress("Estimating tempo…")
    try:
        tempo_val, _ = librosa.beat.beat_track(y=y, sr=sr, hop_length=hop_length)
        tempo_bpm    = float(tempo_val) if 40.0 <= float(tempo_val) <= 300.0 else 120.0
    except Exception:
        tempo_bpm = 120.0
    _progress(f"Estimated tempo: {tempo_bpm:.1f} BPM")

    # Onset detection
    _progress("Detecting note onsets…")
    onset_frames = librosa.onset.onset_detect(
        y=y, sr=sr, hop_length=hop_length, backtrack=True, units='frames'
    )
    onset_times  = librosa.frames_to_time(onset_frames, sr=sr, hop_length=hop_length)
    onset_frames = np.append(onset_frames, len(y) // hop_length)
    onset_times  = np.append(onset_times,  duration)

    # Pitch detection
    _progress("Running pYIN pitch detection…")
    f0, voiced_flag, voiced_probs = librosa.pyin(
        y,
        fmin=librosa.note_to_hz('E2'),
        fmax=librosa.note_to_hz('E6'),
        sr=sr,
        hop_length=hop_length,
        frame_length=frame_length,
    )

    # Spectral features for buzz detection
    _progress("Computing spectral features…")
    D         = librosa.stft(y, n_fft=frame_length, hop_length=hop_length)
    magnitude = np.abs(D)
    freqs     = librosa.fft_frequencies(sr=sr, n_fft=frame_length)

    buzz_mask     = freqs > 5000
    normal_mask   = (freqs > 80) & (freqs <= 5000)
    high_energy   = magnitude[buzz_mask,   :].sum(axis=0)
    normal_energy = magnitude[normal_mask, :].sum(axis=0)
    buzz_ratio    = high_energy / (normal_energy + 1e-8)

    # Per-note analysis
    _progress("Analysing individual notes…")
    notes  = []
    n_segs = len(onset_frames) - 1

    for i in range(n_segs):
        fs = int(onset_frames[i])
        fe = int(onset_frames[i + 1])
        if fs >= fe:
            continue

        seg_f0     = f0[fs:fe]
        seg_voiced = voiced_flag[fs:fe]
        seg_probs  = voiced_probs[fs:fe]
        seg_buzz   = buzz_ratio[fs:fe]

        voiced_f0 = seg_f0[seg_voiced & (seg_f0 > 0)]
        if len(voiced_f0) < 3:
            continue

        median_freq      = float(np.median(voiced_f0))
        midi_float       = librosa.hz_to_midi(median_freq)
        midi_note        = int(np.clip(round(midi_float), 0, 127))
        note_name        = librosa.midi_to_note(midi_note)
        pitch_dev_cents  = float((midi_float - midi_note) * 100)
        confidence       = float(np.mean(seg_probs[seg_voiced]) if seg_voiced.any() else 0.0)
        buzz_score       = float(np.percentile(seg_buzz, 95))
        voiced_midi_vals = librosa.hz_to_midi(voiced_f0)
        vibrato_st       = float(np.std(voiced_midi_vals)) if len(voiced_midi_vals) > 1 else 0.0

        has_buzz    = buzz_score > 0.30
        off_pitch   = abs(pitch_dev_cents) > 20
        has_vibrato = vibrato_st > 0.15

        # Per-frame f0 stored for OLA vibrato correction (0 = unvoiced)
        f0_frames_note = [
            round(float(f0[j]), 2) if (j < len(voiced_flag) and voiced_flag[j] and f0[j] > 0) else 0.0
            for j in range(fs, fe)
        ]

        notes.append({
            "index":                 i,
            "timestamp":             float(onset_times[i]),
            "duration":              float(onset_times[i + 1] - onset_times[i]),
            "original_freq_hz":      median_freq,
            "original_note":         note_name,
            "original_midi":         midi_note,
            "pitch_deviation_cents": pitch_dev_cents,
            "corrected_note":        note_name,
            "corrected_freq_hz":     median_freq,
            "confidence":            round(confidence, 3),
            "buzz_score":            round(buzz_score, 4),
            "has_buzz":              has_buzz,
            "off_pitch":             off_pitch,
            "has_vibrato":           has_vibrato,
            "vibrato_semitones":     round(vibrato_st, 3),
            "was_corrected":         False,
            "f0_frames":             f0_frames_note,
            "frame_start":           fs,
            "frame_end":             fe,
            "sample_start":          int(librosa.frames_to_samples(fs, hop_length=hop_length)),
            "sample_end":            int(librosa.frames_to_samples(fe, hop_length=hop_length)),
        })

    total         = len(notes)
    flagged       = sum(1 for n in notes if n['has_buzz'] or n['off_pitch'] or n['confidence'] < 0.5)
    buzz_count    = sum(1 for n in notes if n['has_buzz'])
    off_pitch_cnt = sum(1 for n in notes if n['off_pitch'])
    avg_conf      = float(np.mean([n['confidence'] for n in notes])) if notes else 0.0

    analysis = {
        "input_file":         input_file,
        "duration_seconds":   duration,
        "sample_rate":        sr,
        "hop_length":         hop_length,
        "tempo_bpm":          round(tempo_bpm, 1),
        "total_notes":        total,
        "flagged_notes":      flagged,
        "buzz_notes":         buzz_count,
        "off_pitch_notes":    off_pitch_cnt,
        "average_confidence": round(avg_conf, 3),
        "notes":              notes,
    }

    with open(output_json, 'w') as fh:
        json.dump(analysis, fh, indent=2)

    _progress(f"Done: {total} notes, {flagged} flagged, tempo {tempo_bpm:.1f} BPM")
    _result({
        "success": True,
        "output":  output_json,
        "summary": {
            "total_notes":        total,
            "flagged_notes":      flagged,
            "buzz_notes":         buzz_count,
            "off_pitch_notes":    off_pitch_cnt,
            "average_confidence": round(avg_conf, 3),
            "duration":           round(duration, 2),
            "tempo_bpm":          round(tempo_bpm, 1),
        },
    })


# ---------------------------------------------------------------------------
# Correction
# ---------------------------------------------------------------------------

def correct_audio(input_file, fixes_json, output_wav,
                  output_midi=None, aggressiveness=0.8, smooth_vibrato=False):

    _progress("Loading analysis…")
    with open(fixes_json) as fh:
        analysis = json.load(fh)

    sr        = analysis['sample_rate']
    hop_length = analysis['hop_length']
    tempo_bpm  = analysis.get('tempo_bpm', 120.0)
    notes      = analysis['notes']

    _progress(f"Tempo: {tempo_bpm:.1f} BPM")
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

        # Respect TUI review decisions if present, else use auto-detection flags
        do_pitch   = note.get('pitch_correct_approved', note['off_pitch'])
        do_buzz    = note.get('buzz_remove_approved',   note['has_buzz'])
        do_vibrato = smooth_vibrato and note.get('has_vibrato', False)

        # --- Pitch correction -------------------------------------------
        dev_cents = note['pitch_deviation_cents']
        if do_pitch and abs(dev_cents) > 10:
            shift_st = (-dev_cents * aggressiveness) / 100.0
            if abs(shift_st) > 0.05:
                try:
                    seg = librosa.effects.pitch_shift(
                        seg, sr=sr, n_steps=shift_st, bins_per_octave=24
                    )
                    note['corrected_note']    = librosa.midi_to_note(note['original_midi'])
                    note['corrected_freq_hz'] = float(librosa.midi_to_hz(note['original_midi']))
                    note['was_corrected']     = True
                    modified                  = True
                    c_info['corrected_note']  = note['corrected_note']
                    c_info['actions'].append(f"pitch_shift {dev_cents:+.1f}¢")
                except Exception as exc:
                    c_info['actions'].append(f"pitch_shift_err: {exc}")

        # --- Octave correction ------------------------------------------
        midi_val = note['original_midi']
        if midi_val < GUITAR_MIDI_MIN or midi_val > GUITAR_MIDI_MAX:
            corrected_midi = midi_val
            while corrected_midi < GUITAR_MIDI_MIN:
                corrected_midi += 12
            while corrected_midi > GUITAR_MIDI_MAX:
                corrected_midi -= 12
            if corrected_midi != midi_val:
                try:
                    seg = librosa.effects.pitch_shift(seg, sr=sr, n_steps=corrected_midi - midi_val)
                    note['corrected_note']    = librosa.midi_to_note(corrected_midi)
                    note['corrected_freq_hz'] = float(librosa.midi_to_hz(corrected_midi))
                    note['was_corrected']     = True
                    modified                  = True
                    c_info['corrected_note']  = note['corrected_note']
                    c_info['actions'].append(f"octave_fix {note['original_note']}→{note['corrected_note']}")
                except Exception as exc:
                    c_info['actions'].append(f"octave_fix_err: {exc}")

        # --- Vibrato smoothing (OLA) ------------------------------------
        if do_vibrato:
            f0_frames = note.get('f0_frames') or []
            target_hz = note.get('corrected_freq_hz', note['original_freq_hz'])
            if f0_frames and target_hz > 0:
                try:
                    seg = _vibrato_smooth_ola(seg, f0_frames, sr, hop_length, target_hz)
                    note['was_corrected'] = True
                    modified              = True
                    c_info['actions'].append("vibrato_smoothed")
                except Exception as exc:
                    c_info['actions'].append(f"vibrato_smooth_err: {exc}")
            else:
                c_info['actions'].append("vibrato_skip: no f0 data (re-analyze to enable)")

        # --- Buzz removal -----------------------------------------------
        if do_buzz:
            buzz_score = note['buzz_score']
            cutoff_hz  = max(3000, int(5000 - buzz_score * 1000 * aggressiveness))
            norm_cut   = cutoff_hz / (sr / 2)
            if norm_cut < 0.99 and len(seg) > 20:
                try:
                    b, a     = signal.butter(4, norm_cut, btype='low')
                    filtered = signal.filtfilt(b, a, seg)
                    blend    = min(0.9, buzz_score * aggressiveness * 1.5)
                    seg      = (1.0 - blend) * seg + blend * filtered
                    note['was_corrected'] = True
                    modified              = True
                    c_info['actions'].append(f"buzz_removed cutoff={cutoff_hz}Hz blend={blend:.2f}")
                except Exception as exc:
                    c_info['actions'].append(f"buzz_removal_err: {exc}")

        if modified:
            orig_peak = np.max(np.abs(y_out[ss:se])) + 1e-8
            seg_peak  = np.max(np.abs(seg))            + 1e-8
            seg       = seg * (orig_peak / seg_peak)
            y_out[ss:se] = seg[:se - ss]
            corrections.append(c_info)

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
        "tempo_bpm":         tempo_bpm,
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

    # MIDI export
    midi_out = None
    if output_midi:
        if not HAS_MIDI:
            _progress("midiutil not installed — skipping MIDI export")
        else:
            _progress(f"Generating MIDI at {tempo_bpm:.1f} BPM…")
            try:
                midi = MIDIFile(1)
                midi.addTempo(0, 0, tempo_bpm)
                for n in notes:
                    if n['corrected_freq_hz'] <= 0:
                        continue
                    pitch    = int(np.clip(round(librosa.hz_to_midi(n['corrected_freq_hz'])), 0, 127))
                    t_beats  = n['timestamp'] * tempo_bpm / 60.0
                    d_beats  = max(0.1, n['duration'] * tempo_bpm / 60.0)
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
            "notes_analyzed":   len(notes),
            "notes_corrected":  notes_corrected,
            "corrections_made": len(corrections),
            "tempo_bpm":        tempo_bpm,
        },
    })


# ---------------------------------------------------------------------------
# Spectrogram
# ---------------------------------------------------------------------------

def generate_spectrogram(input_file, output_png, analysis_json=None, compare_file=None, sr_target=22050):
    """Mel spectrogram PNG with analysis overlay; optional before/after comparison."""
    try:
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
        from matplotlib.lines import Line2D
    except ImportError:
        _result({"success": False, "error": "matplotlib not installed. Run: pip install matplotlib"})
        return

    _progress("Loading audio…")
    y1, sr = librosa.load(input_file, sr=sr_target, mono=True)

    analysis = None
    if analysis_json:
        try:
            with open(analysis_json) as fh:
                analysis = json.load(fh)
            _progress(f"Loaded analysis: {len(analysis.get('notes', []))} notes")
        except Exception as exc:
            _progress(f"Could not load analysis: {exc}")

    y2 = None
    if compare_file:
        try:
            _progress("Loading comparison audio…")
            y2, _ = librosa.load(compare_file, sr=sr, mono=True)
        except Exception as exc:
            _progress(f"Could not load compare file: {exc}")

    n_cols        = 2 if y2 is not None else 1
    fig, axes_row = plt.subplots(1, n_cols, figsize=(8 * n_cols, 5), squeeze=False)
    axes          = axes_row[0]
    fig.patch.set_facecolor('#0d1117')

    hop   = 512
    n_fft = 2048

    def plot_spec(ax, audio, title, overlay=False):
        S      = librosa.feature.melspectrogram(y=audio, sr=sr, n_mels=128, hop_length=hop, n_fft=n_fft)
        S_db   = librosa.power_to_db(S, ref=np.max)
        times  = librosa.times_like(S, sr=sr, hop_length=hop)
        mfreqs = librosa.mel_frequencies(n_mels=128, fmin=0, fmax=sr // 2)

        ax.pcolormesh(times, mfreqs, S_db, cmap='magma', vmin=-80, vmax=0, shading='auto')
        ax.set_yscale('log')
        ax.set_ylim(80, sr // 2)
        ax.set_xlabel('Time (s)', color='#8b9ab0')
        ax.set_ylabel('Frequency (Hz)', color='#8b9ab0')
        ax.set_title(title, color='#e6edf3', fontsize=11, pad=8)
        ax.tick_params(colors='#8b9ab0')
        ax.set_facecolor('#0d1117')
        for spine in ax.spines.values():
            spine.set_color('#30363d')

        if overlay and analysis:
            for note in analysis.get('notes', []):
                ts   = note['timestamp']
                freq = note.get('original_freq_hz', 0)
                if freq <= 0:
                    continue
                conf   = note['confidence']
                color  = '#58d68d' if conf >= 0.8 else ('#f39c12' if conf >= 0.5 else '#e74c3c')
                marker = 'x' if note.get('has_buzz') else 'o'
                ax.axvline(x=ts, color='#58a6ff', alpha=0.2, linewidth=0.7, linestyle='--')
                ax.plot(ts, freq, marker, color=color,
                        markersize=5 if marker == 'o' else 6,
                        alpha=0.85, markeredgewidth=1.5, zorder=5)

    _progress("Rendering spectrogram…")
    plot_spec(axes[0], y1, f'Original: {os.path.basename(input_file)}', overlay=True)
    if y2 is not None:
        plot_spec(axes[1], y2, f'Corrected: {os.path.basename(compare_file)}', overlay=True)

    legend_els = [
        Line2D([0], [0], marker='o', color='w', markerfacecolor='#58d68d', markersize=6, label='High conf'),
        Line2D([0], [0], marker='o', color='w', markerfacecolor='#f39c12', markersize=6, label='Med conf'),
        Line2D([0], [0], marker='o', color='w', markerfacecolor='#e74c3c', markersize=6, label='Low conf'),
        Line2D([0], [0], marker='x', color='#e74c3c', markersize=6, markeredgewidth=1.5, label='Buzz'),
    ]
    axes[0].legend(handles=legend_els, loc='upper right',
                   facecolor='#161b22', edgecolor='#30363d',
                   labelcolor='#8b9ab0', fontsize=7)

    plt.tight_layout(pad=1.5)
    _progress(f"Saving to {output_png}…")
    plt.savefig(output_png, dpi=150, bbox_inches='tight', facecolor=fig.get_facecolor())
    plt.close()

    _result({"success": True, "output": output_png})


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description='Guitar Audio Correction – Python backend')
    sub    = parser.add_subparsers(dest='command')

    ap = sub.add_parser('analyze')
    ap.add_argument('input')
    ap.add_argument('--output', default=None)
    ap.add_argument('--sr',     type=int, default=22050)
    ap.add_argument('--hop',    type=int, default=512)

    cp = sub.add_parser('correct')
    cp.add_argument('input')
    cp.add_argument('--fixes',           required=True)
    cp.add_argument('--output',          default=None)
    cp.add_argument('--output-midi',     default=None)
    cp.add_argument('--aggressiveness',  type=float, default=0.8)
    cp.add_argument('--smooth-vibrato',  action='store_true')

    sp = sub.add_parser('spectrogram')
    sp.add_argument('input')
    sp.add_argument('--output',   default=None)
    sp.add_argument('--analysis', default=None)
    sp.add_argument('--compare',  default=None)
    sp.add_argument('--sr',       type=int, default=22050)

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

    elif args.command == 'spectrogram':
        out = args.output or args.input.rsplit('.', 1)[0] + '_spectrogram.png'
        generate_spectrogram(
            args.input, out,
            analysis_json = args.analysis,
            compare_file  = args.compare,
            sr_target     = args.sr,
        )

    else:
        parser.print_help()
        sys.exit(1)


if __name__ == '__main__':
    main()
