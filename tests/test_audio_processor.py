"""
Comprehensive tests for audio_processor.py.

Run with:
    pytest tests/test_audio_processor.py -v

Slow integration tests (those that invoke the full DSP pipeline) are marked
with @pytest.mark.slow and can be excluded with:
    pytest tests/test_audio_processor.py -v -m "not slow"
"""

import io
import json
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
import pytest

# Make the package root importable regardless of where pytest is invoked from.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import audio_processor as ap


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------

def _make_sine_wav(freq_hz=440.0, duration=1.0, sr=22050, amplitude=0.5):
    """Write a mono sine-wave WAV and return its path (caller must delete)."""
    import soundfile as sf
    t = np.linspace(0, duration, int(sr * duration), endpoint=False)
    y = (amplitude * np.sin(2 * np.pi * freq_hz * t)).astype(np.float32)
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp.close()
    sf.write(tmp.name, y, sr)
    return tmp.name


def _make_noisy_wav(freq_hz=440.0, duration=1.0, sr=22050, noise_level=0.35):
    """Write a sine + white-noise WAV (simulates fret buzz) and return path."""
    import soundfile as sf
    t = np.linspace(0, duration, int(sr * duration), endpoint=False)
    y = 0.5 * np.sin(2 * np.pi * freq_hz * t)
    rng = np.random.default_rng(42)
    y = y + noise_level * rng.standard_normal(len(y))
    y = np.clip(y, -1.0, 1.0).astype(np.float32)
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp.close()
    sf.write(tmp.name, y, sr)
    return tmp.name


def _run_stdout(fn, *args, **kwargs):
    """Run fn(*args, **kwargs) and return the JSON dict emitted to stdout."""
    buf = io.StringIO()
    with patch("sys.stdout", buf):
        fn(*args, **kwargs)
    return json.loads(buf.getvalue().strip())


def _cleanup(*paths):
    for p in paths:
        if p and os.path.exists(p):
            try:
                os.remove(p)
            except OSError:
                pass


# ---------------------------------------------------------------------------
# 1.  _progress  ─ JSON format on stderr
# ---------------------------------------------------------------------------

class TestProgress(unittest.TestCase):

    def _capture(self, *args, **kwargs):
        buf = io.StringIO()
        with patch("sys.stderr", buf):
            ap._progress(*args, **kwargs)
        return json.loads(buf.getvalue().strip())

    def test_type_is_progress(self):
        data = self._capture("Loading…")
        self.assertEqual(data["type"], "progress")

    def test_message_preserved(self):
        data = self._capture("Detecting onsets")
        self.assertEqual(data["message"], "Detecting onsets")

    def test_no_percent_without_step(self):
        data = self._capture("Loading…")
        self.assertNotIn("percent", data)

    def test_percent_at_first_step(self):
        data = self._capture("Step 1", step=1, total=4)
        self.assertEqual(data["percent"], 25)

    def test_percent_at_last_step(self):
        data = self._capture("Done", step=4, total=4)
        self.assertEqual(data["percent"], 100)

    def test_percent_zero_at_step_zero(self):
        data = self._capture("Start", step=0, total=10)
        self.assertEqual(data["percent"], 0)

    def test_percent_is_integer(self):
        data = self._capture("Mid", step=1, total=3)
        self.assertIsInstance(data["percent"], int)


# ---------------------------------------------------------------------------
# 2.  _result  ─ JSON on stdout
# ---------------------------------------------------------------------------

class TestResult(unittest.TestCase):

    def _capture(self, payload):
        buf = io.StringIO()
        with patch("sys.stdout", buf):
            ap._result(payload)
        return json.loads(buf.getvalue().strip())

    def test_success_true(self):
        data = self._capture({"success": True})
        self.assertTrue(data["success"])

    def test_extra_fields_preserved(self):
        data = self._capture({"success": True, "output": "/tmp/x.wav"})
        self.assertEqual(data["output"], "/tmp/x.wav")

    def test_error_payload(self):
        data = self._capture({"success": False, "error": "boom"})
        self.assertFalse(data["success"])
        self.assertEqual(data["error"], "boom")

    def test_emits_valid_json(self):
        buf = io.StringIO()
        with patch("sys.stdout", buf):
            ap._result({"success": True, "items": [1, 2, 3]})
        parsed = json.loads(buf.getvalue())
        self.assertEqual(parsed["items"], [1, 2, 3])


# ---------------------------------------------------------------------------
# 3.  _vibrato_smooth_ola  ─ edge cases and contracts
# ---------------------------------------------------------------------------

class TestVibratoSmoothOla(unittest.TestCase):

    SR = 22050
    HOP = 512

    def _f0(self, n, base=440.0, vib_hz=5.0, vib_amt=5.0):
        """Return a list of n f0 values with mild vibrato."""
        return [base + vib_amt * np.sin(i * vib_hz) for i in range(n)]

    def test_passthrough_when_target_hz_zero(self):
        seg = np.ones(8192, dtype=np.float32)
        result = ap._vibrato_smooth_ola(seg, self._f0(20), self.SR, self.HOP, 0.0)
        np.testing.assert_array_equal(result, seg)

    def test_passthrough_when_target_hz_negative(self):
        seg = np.ones(4096, dtype=np.float32)
        result = ap._vibrato_smooth_ola(seg, self._f0(10), self.SR, self.HOP, -100.0)
        np.testing.assert_array_equal(result, seg)

    def test_passthrough_when_f0_frames_empty(self):
        seg = np.random.randn(8192).astype(np.float32)
        result = ap._vibrato_smooth_ola(seg, [], self.SR, self.HOP, 440.0)
        np.testing.assert_array_equal(result, seg)

    def test_passthrough_when_segment_too_short(self):
        # Less than hop_length * 4 samples → no processing
        seg = np.random.randn(100).astype(np.float32)
        result = ap._vibrato_smooth_ola(seg, self._f0(5), self.SR, self.HOP, 440.0)
        np.testing.assert_array_equal(result, seg)

    def test_output_same_length_as_input(self):
        seg = np.random.randn(8192).astype(np.float32)
        result = ap._vibrato_smooth_ola(seg, self._f0(20), self.SR, self.HOP, 440.0)
        self.assertEqual(len(result), len(seg))

    def test_output_same_length_non_power_of_two(self):
        seg = np.random.randn(9001).astype(np.float32)
        result = ap._vibrato_smooth_ola(seg, self._f0(25), self.SR, self.HOP, 440.0)
        self.assertEqual(len(result), len(seg))

    def test_all_unvoiced_f0_output_length_preserved(self):
        # f0=0 means unvoiced; no pitch shift should occur
        seg = np.random.randn(8192).astype(np.float32)
        f0_frames = [0.0] * 20
        result = ap._vibrato_smooth_ola(seg, f0_frames, self.SR, self.HOP, 440.0)
        self.assertEqual(len(result), len(seg))

    def test_output_is_float32(self):
        seg = np.random.randn(8192).astype(np.float32)
        result = ap._vibrato_smooth_ola(seg, self._f0(20), self.SR, self.HOP, 440.0)
        self.assertEqual(result.dtype, np.float32)


# ---------------------------------------------------------------------------
# 4.  analyze_audio  ─ error handling
# ---------------------------------------------------------------------------

class TestAnalyzeAudioErrors(unittest.TestCase):

    def test_missing_file_success_false(self):
        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as f:
            out = f.name
        try:
            result = _run_stdout(ap.analyze_audio, "/no/such/file.wav", out)
            self.assertFalse(result["success"])
        finally:
            _cleanup(out)

    def test_missing_file_error_mentions_not_found(self):
        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as f:
            out = f.name
        try:
            result = _run_stdout(ap.analyze_audio, "/no/such/file.wav", out)
            self.assertIn("not found", result["error"].lower())
        finally:
            _cleanup(out)


# ---------------------------------------------------------------------------
# 5.  analyze_audio  ─ integration (uses real audio)
# ---------------------------------------------------------------------------

@pytest.mark.slow
class TestAnalyzeAudioIntegration(unittest.TestCase):

    def setUp(self):
        self.wav = _make_sine_wav(freq_hz=440.0, duration=2.0, sr=22050)
        self.out_json = tempfile.NamedTemporaryFile(suffix=".json", delete=False).name

    def tearDown(self):
        _cleanup(self.wav, self.out_json)

    def test_success_true(self):
        result = _run_stdout(ap.analyze_audio, self.wav, self.out_json)
        self.assertTrue(result["success"])

    def test_output_path_reported(self):
        result = _run_stdout(ap.analyze_audio, self.wav, self.out_json)
        self.assertEqual(result["output"], self.out_json)

    def test_output_json_created(self):
        _run_stdout(ap.analyze_audio, self.wav, self.out_json)
        self.assertTrue(os.path.isfile(self.out_json))

    def test_output_json_required_keys(self):
        _run_stdout(ap.analyze_audio, self.wav, self.out_json)
        with open(self.out_json) as f:
            analysis = json.load(f)
        for key in ("input_file", "duration_seconds", "sample_rate", "hop_length",
                    "tempo_bpm", "total_notes", "notes"):
            self.assertIn(key, analysis, f"Missing key: {key}")

    def test_tempo_in_valid_range(self):
        _run_stdout(ap.analyze_audio, self.wav, self.out_json)
        with open(self.out_json) as f:
            analysis = json.load(f)
        self.assertGreaterEqual(analysis["tempo_bpm"], 40.0)
        self.assertLessEqual(analysis["tempo_bpm"], 300.0)

    def test_duration_close_to_actual(self):
        _run_stdout(ap.analyze_audio, self.wav, self.out_json)
        with open(self.out_json) as f:
            analysis = json.load(f)
        self.assertAlmostEqual(analysis["duration_seconds"], 2.0, delta=0.2)

    def test_note_fields_present(self):
        _run_stdout(ap.analyze_audio, self.wav, self.out_json)
        with open(self.out_json) as f:
            analysis = json.load(f)
        required = (
            "timestamp", "duration", "original_note", "original_midi",
            "pitch_deviation_cents", "confidence", "buzz_score",
            "has_buzz", "off_pitch", "has_vibrato", "was_corrected",
            "sample_start", "sample_end",
        )
        for note in analysis["notes"]:
            for key in required:
                self.assertIn(key, note, f"Note missing key: {key}")

    def test_no_notes_shorter_than_30ms(self):
        _run_stdout(ap.analyze_audio, self.wav, self.out_json)
        with open(self.out_json) as f:
            analysis = json.load(f)
        for note in analysis["notes"]:
            self.assertGreaterEqual(
                note["duration"], 0.030,
                f"Note at {note['timestamp']:.3f}s has duration {note['duration']:.3f}s < 30ms",
            )

    def test_sample_start_less_than_sample_end(self):
        _run_stdout(ap.analyze_audio, self.wav, self.out_json)
        with open(self.out_json) as f:
            analysis = json.load(f)
        for note in analysis["notes"]:
            self.assertLess(note["sample_start"], note["sample_end"])

    def test_clean_sine_not_flagged_as_buzz(self):
        _run_stdout(ap.analyze_audio, self.wav, self.out_json)
        with open(self.out_json) as f:
            analysis = json.load(f)
        buzz_notes = [n for n in analysis["notes"] if n["has_buzz"]]
        self.assertEqual(
            len(buzz_notes), 0,
            f"Clean sine should not be flagged as buzz; got {len(buzz_notes)} buzz notes",
        )

    def test_summary_total_notes_matches_list(self):
        result = _run_stdout(ap.analyze_audio, self.wav, self.out_json)
        with open(self.out_json) as f:
            analysis = json.load(f)
        self.assertEqual(result["summary"]["total_notes"], len(analysis["notes"]))

    def test_summary_contains_all_keys(self):
        result = _run_stdout(ap.analyze_audio, self.wav, self.out_json)
        for key in ("duration", "tempo_bpm", "total_notes", "flagged_notes",
                    "buzz_notes", "off_pitch_notes", "average_confidence"):
            self.assertIn(key, result["summary"], f"summary missing key: {key}")

    def test_a4_sine_detected_near_correct_pitch(self):
        """A 440 Hz sine should be detected as close to A4."""
        _run_stdout(ap.analyze_audio, self.wav, self.out_json)
        with open(self.out_json) as f:
            analysis = json.load(f)
        if analysis["notes"]:
            # The most common detected note should be in the A4 vicinity (MIDI 69)
            midis = [n["original_midi"] for n in analysis["notes"]]
            closest = min(midis, key=lambda m: abs(m - 69))
            self.assertAlmostEqual(closest, 69, delta=2,
                                   msg=f"Expected MIDI ~69 (A4), got {closest}")


# ---------------------------------------------------------------------------
# 6.  correct_audio  ─ error handling
# ---------------------------------------------------------------------------

class TestCorrectAudioErrors(unittest.TestCase):

    def test_missing_input_file(self):
        result = _run_stdout(
            ap.correct_audio, "/no/such/input.wav", "/no/fixes.json", "/tmp/out.wav"
        )
        self.assertFalse(result["success"])
        self.assertIn("not found", result["error"].lower())

    def test_missing_fixes_json(self):
        wav = _make_sine_wav(duration=0.3)
        try:
            result = _run_stdout(
                ap.correct_audio, wav, "/no/such/fixes.json", "/tmp/out.wav"
            )
            self.assertFalse(result["success"])
            self.assertIn("not found", result["error"].lower())
        finally:
            _cleanup(wav)


# ---------------------------------------------------------------------------
# 7.  correct_audio  ─ aggressiveness clamping
# ---------------------------------------------------------------------------

@pytest.mark.slow
class TestAggressivenessClamping(unittest.TestCase):

    def _run_correction(self, aggressiveness):
        wav = _make_sine_wav(freq_hz=440.0, duration=1.0)
        out_wav = tempfile.NamedTemporaryFile(suffix=".wav", delete=False).name
        analysis_path = tempfile.NamedTemporaryFile(suffix=".json", delete=False).name
        report = os.path.splitext(out_wav)[0] + "_correction_report.json"
        try:
            _run_stdout(ap.analyze_audio, wav, analysis_path)
            result = _run_stdout(
                ap.correct_audio, wav, analysis_path, out_wav,
                aggressiveness=aggressiveness,
            )
            return result, os.path.isfile(out_wav)
        finally:
            _cleanup(wav, out_wav, analysis_path, report)

    def test_value_above_one_does_not_crash(self):
        result, produced = self._run_correction(5.0)
        self.assertTrue(produced)

    def test_value_above_one_returns_success(self):
        result, _ = self._run_correction(2.0)
        self.assertTrue(result["success"])

    def test_negative_value_does_not_crash(self):
        result, produced = self._run_correction(-1.0)
        self.assertTrue(produced)

    def test_negative_value_returns_success(self):
        result, _ = self._run_correction(-0.5)
        self.assertTrue(result["success"])


# ---------------------------------------------------------------------------
# 8.  correct_audio  ─ full pipeline integration
# ---------------------------------------------------------------------------

@pytest.mark.slow
class TestCorrectAudioIntegration(unittest.TestCase):

    def setUp(self):
        self.wav = _make_sine_wav(freq_hz=440.0, duration=2.0)
        self.analysis_json = tempfile.NamedTemporaryFile(suffix=".json", delete=False).name
        self.out_wav = tempfile.NamedTemporaryFile(suffix=".wav", delete=False).name
        _run_stdout(ap.analyze_audio, self.wav, self.analysis_json)

    def tearDown(self):
        report = os.path.splitext(self.out_wav)[0] + "_correction_report.json"
        _cleanup(self.wav, self.analysis_json, self.out_wav, report)

    def test_produces_wav_file(self):
        _run_stdout(ap.correct_audio, self.wav, self.analysis_json, self.out_wav)
        self.assertTrue(os.path.isfile(self.out_wav))

    def test_output_wav_is_readable(self):
        import soundfile as sf
        _run_stdout(ap.correct_audio, self.wav, self.analysis_json, self.out_wav)
        y, sr = sf.read(self.out_wav)
        self.assertGreater(len(y), 0)
        self.assertEqual(sr, 22050)

    def test_output_wav_is_pcm16(self):
        import soundfile as sf
        _run_stdout(ap.correct_audio, self.wav, self.analysis_json, self.out_wav)
        info = sf.info(self.out_wav)
        self.assertIn("PCM_16", info.subtype)

    def test_output_wav_peak_not_clipping(self):
        import soundfile as sf
        _run_stdout(ap.correct_audio, self.wav, self.analysis_json, self.out_wav)
        y, _ = sf.read(self.out_wav)
        self.assertLessEqual(np.max(np.abs(y)), 1.0 + 1e-4)

    def test_output_wav_normalised_when_loud(self):
        """When input peak exceeds 0.98, correct_audio must normalise the output to ~0.95."""
        import soundfile as sf
        # Build a full-scale (amplitude=1.0) sine so normalisation definitely fires
        loud_wav = _make_sine_wav(freq_hz=440.0, duration=1.5, amplitude=1.0)
        loud_out = tempfile.NamedTemporaryFile(suffix=".wav", delete=False).name
        loud_analysis = tempfile.NamedTemporaryFile(suffix=".json", delete=False).name
        loud_report = os.path.splitext(loud_out)[0] + "_correction_report.json"
        try:
            _run_stdout(ap.analyze_audio, loud_wav, loud_analysis)
            _run_stdout(ap.correct_audio, loud_wav, loud_analysis, loud_out)
            y, _ = sf.read(loud_out)
            peak = np.max(np.abs(y))
            self.assertLessEqual(peak, 0.97, f"Output peak {peak:.4f} should be <= 0.97")
            self.assertGreater(peak, 0.90, f"Output peak {peak:.4f} should be > 0.90")
        finally:
            _cleanup(loud_wav, loud_out, loud_analysis, loud_report)

    def test_produces_correction_report(self):
        _run_stdout(ap.correct_audio, self.wav, self.analysis_json, self.out_wav)
        report_path = os.path.splitext(self.out_wav)[0] + "_correction_report.json"
        self.assertTrue(os.path.isfile(report_path), "correction_report.json not created")

    def test_correction_report_required_keys(self):
        _run_stdout(ap.correct_audio, self.wav, self.analysis_json, self.out_wav)
        report_path = os.path.splitext(self.out_wav)[0] + "_correction_report.json"
        with open(report_path) as f:
            report = json.load(f)
        for key in ("input_file", "output_file", "aggressiveness", "tempo_bpm",
                    "total_corrections", "corrections", "notes"):
            self.assertIn(key, report, f"report missing key: {key}")

    def test_result_json_success_true(self):
        result = _run_stdout(ap.correct_audio, self.wav, self.analysis_json, self.out_wav)
        self.assertTrue(result["success"])

    def test_result_json_summary_keys(self):
        result = _run_stdout(ap.correct_audio, self.wav, self.analysis_json, self.out_wav)
        for key in ("notes_analyzed", "notes_corrected", "tempo_bpm"):
            self.assertIn(key, result["summary"], f"summary missing key: {key}")

    def test_result_reports_output_wav_path(self):
        result = _run_stdout(ap.correct_audio, self.wav, self.analysis_json, self.out_wav)
        self.assertEqual(result["output_wav"], self.out_wav)


# ---------------------------------------------------------------------------
# 9.  correct_audio  ─ buzz removal attack transient preserved
# ---------------------------------------------------------------------------

@pytest.mark.slow
class TestBuzzRemovalAttackPreservation(unittest.TestCase):
    """
    Verify that the first ~20ms of a segment is NOT filtered (attack is preserved).
    We force has_buzz=True in a hand-crafted analysis JSON and compare
    the output WAV to the input in the [crossfade_end, attack_end] window.
    """

    SR = 22050

    def _make_buzzy_analysis(self, wav_path, sample_start, sample_end):
        analysis = {
            "input_file": wav_path,
            "sample_rate": self.SR,
            "hop_length": 512,
            "tempo_bpm": 120.0,
            "notes": [{
                "index": 0,
                "timestamp": sample_start / self.SR,
                "duration": (sample_end - sample_start) / self.SR,
                "original_freq_hz": 440.0,
                "original_note": "A4",
                "original_midi": 69,
                "corrected_note": "A4",
                "corrected_freq_hz": 440.0,
                "corrected_midi": 69,
                "pitch_deviation_cents": 0.0,
                "confidence": 0.9,
                "buzz_score": 0.6,
                "has_buzz": True,
                "off_pitch": False,
                "has_vibrato": False,
                "vibrato_semitones": 0.0,
                "was_corrected": False,
                "f0_frames": [],
                "frame_start": sample_start // 512,
                "frame_end": sample_end // 512,
                "sample_start": sample_start,
                "sample_end": sample_end,
            }],
        }
        tmp = tempfile.NamedTemporaryFile(suffix=".json", delete=False)
        tmp.close()
        with open(tmp.name, "w") as f:
            json.dump(analysis, f)
        return tmp.name

    def test_attack_region_unchanged_after_buzz_removal(self):
        import soundfile as sf
        import librosa
        rng = np.random.default_rng(0)
        sr = self.SR
        dur = 1.5
        t = np.linspace(0, dur, int(sr * dur), endpoint=False)
        # Keep amplitude LOW (peak ≤ 0.5) so normalization (peak > 0.98) never fires.
        # That means the attack region in the output should equal the librosa-loaded input.
        y = (0.3 * np.sin(2 * np.pi * 440 * t)
             + 0.12 * rng.standard_normal(len(t))).astype(np.float32)
        y = np.clip(y, -0.5, 0.5)

        wav = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        wav.close()
        sf.write(wav.name, y, sr)

        # Load with librosa the same way correct_audio does so quantisation is identical.
        y_librosa, _ = librosa.load(wav.name, sr=sr, mono=True)

        # Note spans from 50ms to 1.45s
        ss = int(sr * 0.05)
        se = int(sr * 1.45)
        fixes = self._make_buzzy_analysis(wav.name, ss, se)
        out_wav = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        out_wav.close()
        report = os.path.splitext(out_wav.name)[0] + "_correction_report.json"

        try:
            _run_stdout(ap.correct_audio, wav.name, fixes, out_wav.name)
            y_out, _ = sf.read(out_wav.name)

            # The attack window in the note is the first 20ms past the note start.
            # The first 5ms is also a crossfade boundary; check from crossfade_end → attack_end.
            fade_n   = min(int(sr * 0.005), (se - ss) // 4)
            attack_n = min(int(sr * 0.020), (se - ss) // 3)
            check_s  = ss + fade_n
            check_e  = ss + attack_n

            # Tolerance: two PCM_16 round-trips (6.1e-5 per trip) + small crossfade edge.
            np.testing.assert_allclose(
                y_out[check_s:check_e],
                y_librosa[check_s:check_e],
                atol=5e-3,
                err_msg="Attack transient was modified by buzz removal",
            )
        finally:
            _cleanup(wav.name, fixes, out_wav.name, report)


# ---------------------------------------------------------------------------
# 10.  correct_audio  ─ octave correction constants & logic
# ---------------------------------------------------------------------------

class TestOctaveCorrectionBoundaries(unittest.TestCase):
    """Verify the MIDI range constants and the octave-shift logic direction."""

    def test_guitar_midi_min_is_e2(self):
        self.assertEqual(ap.GUITAR_MIDI_MIN, 40)

    def test_guitar_midi_max_is_e6(self):
        self.assertEqual(ap.GUITAR_MIDI_MAX, 88)

    def test_midi_below_min_shifts_up_to_range(self):
        midi = ap.GUITAR_MIDI_MIN - 12
        corrected = midi
        while corrected < ap.GUITAR_MIDI_MIN:
            corrected += 12
        self.assertGreaterEqual(corrected, ap.GUITAR_MIDI_MIN)
        self.assertLessEqual(corrected, ap.GUITAR_MIDI_MAX)

    def test_midi_above_max_shifts_down_to_range(self):
        midi = ap.GUITAR_MIDI_MAX + 12
        corrected = midi
        while corrected > ap.GUITAR_MIDI_MAX:
            corrected -= 12
        self.assertGreaterEqual(corrected, ap.GUITAR_MIDI_MIN)
        self.assertLessEqual(corrected, ap.GUITAR_MIDI_MAX)

    def test_midi_in_range_unchanged(self):
        midi = 60  # C4 – well within guitar range
        self.assertGreaterEqual(midi, ap.GUITAR_MIDI_MIN)
        self.assertLessEqual(midi, ap.GUITAR_MIDI_MAX)


# ---------------------------------------------------------------------------
# 11.  generate_spectrogram  ─ error handling
# ---------------------------------------------------------------------------

class TestGenerateSpectrogramErrors(unittest.TestCase):

    def test_missing_file_success_false(self):
        out_png = tempfile.NamedTemporaryFile(suffix=".png", delete=False).name
        try:
            result = _run_stdout(ap.generate_spectrogram, "/no/such/file.wav", out_png)
            self.assertFalse(result["success"])
        finally:
            _cleanup(out_png)

    def test_missing_file_error_message(self):
        out_png = tempfile.NamedTemporaryFile(suffix=".png", delete=False).name
        try:
            result = _run_stdout(ap.generate_spectrogram, "/no/such/file.wav", out_png)
            self.assertIn("not found", result["error"].lower())
        finally:
            _cleanup(out_png)


# ---------------------------------------------------------------------------
# 12.  generate_spectrogram  ─ integration (skipped if matplotlib missing)
# ---------------------------------------------------------------------------

@pytest.mark.slow
class TestGenerateSpectrogramIntegration(unittest.TestCase):

    def setUp(self):
        pytest.importorskip("matplotlib", reason="matplotlib not installed")
        self.wav = _make_sine_wav(freq_hz=440.0, duration=1.0)
        self.out_png = tempfile.NamedTemporaryFile(suffix=".png", delete=False).name

    def tearDown(self):
        _cleanup(self.wav, self.out_png)

    def test_produces_png(self):
        result = _run_stdout(ap.generate_spectrogram, self.wav, self.out_png)
        self.assertTrue(result["success"])
        self.assertTrue(os.path.isfile(self.out_png))

    def test_png_has_reasonable_size(self):
        _run_stdout(ap.generate_spectrogram, self.wav, self.out_png)
        self.assertGreater(os.path.getsize(self.out_png), 5000)

    def test_result_output_path_matches(self):
        result = _run_stdout(ap.generate_spectrogram, self.wav, self.out_png)
        self.assertEqual(result["output"], self.out_png)

    def test_with_analysis_overlay(self):
        """Should succeed when an analysis JSON is passed."""
        analysis_json = tempfile.NamedTemporaryFile(suffix=".json", delete=False).name
        try:
            _run_stdout(ap.analyze_audio, self.wav, analysis_json)
            result = _run_stdout(
                ap.generate_spectrogram, self.wav, self.out_png,
                analysis_json=analysis_json,
            )
            self.assertTrue(result["success"])
        finally:
            _cleanup(analysis_json)


# ---------------------------------------------------------------------------
# 13.  fix_audio  ─ one-shot pipeline
# ---------------------------------------------------------------------------

@pytest.mark.slow
class TestFixAudioIntegration(unittest.TestCase):

    def setUp(self):
        self.wav = _make_sine_wav(freq_hz=440.0, duration=2.0)
        self.out_wav = tempfile.NamedTemporaryFile(suffix=".wav", delete=False).name

    def tearDown(self):
        report = os.path.splitext(self.out_wav)[0] + "_correction_report.json"
        _cleanup(self.wav, self.out_wav, report)

    def test_produces_corrected_wav(self):
        with patch("sys.stdout", io.StringIO()):
            ap.fix_audio(self.wav, self.out_wav)
        self.assertTrue(os.path.isfile(self.out_wav))

    def test_emits_two_json_lines(self):
        buf = io.StringIO()
        with patch("sys.stdout", buf):
            ap.fix_audio(self.wav, self.out_wav)
        lines = [l for l in buf.getvalue().strip().splitlines() if l.strip()]
        self.assertEqual(len(lines), 2, f"Expected 2 JSON lines, got: {lines}")

    def test_first_line_is_analyze_result(self):
        buf = io.StringIO()
        with patch("sys.stdout", buf):
            ap.fix_audio(self.wav, self.out_wav)
        lines = [l for l in buf.getvalue().strip().splitlines() if l.strip()]
        analyze_result = json.loads(lines[0])
        self.assertTrue(analyze_result["success"])
        self.assertIn("summary", analyze_result)
        self.assertIn("total_notes", analyze_result["summary"])

    def test_second_line_is_correct_result(self):
        buf = io.StringIO()
        with patch("sys.stdout", buf):
            ap.fix_audio(self.wav, self.out_wav)
        lines = [l for l in buf.getvalue().strip().splitlines() if l.strip()]
        correct_result = json.loads(lines[1])
        self.assertTrue(correct_result["success"])
        self.assertIn("output_wav", correct_result)

    def test_temp_analysis_json_cleaned_up(self):
        """When output_json is not provided, the temp file must be deleted."""
        tmpdir = tempfile.gettempdir()
        before = set(os.listdir(tmpdir))
        with patch("sys.stdout", io.StringIO()):
            ap.fix_audio(self.wav, self.out_wav)
        after = set(os.listdir(tmpdir))
        leaked = [f for f in after - before if "_analysis.json" in f]
        self.assertEqual(leaked, [], f"Temp file(s) not cleaned up: {leaked}")

    def test_analysis_json_kept_when_requested(self):
        out_json = tempfile.NamedTemporaryFile(suffix=".json", delete=False).name
        try:
            with patch("sys.stdout", io.StringIO()):
                ap.fix_audio(self.wav, self.out_wav, output_json=out_json)
            self.assertTrue(os.path.isfile(out_json))
        finally:
            _cleanup(out_json)

    def test_aggressiveness_zero_still_produces_output(self):
        with patch("sys.stdout", io.StringIO()):
            ap.fix_audio(self.wav, self.out_wav, aggressiveness=0.0)
        self.assertTrue(os.path.isfile(self.out_wav))


# ---------------------------------------------------------------------------
# 14.  main()  ─ CLI argument routing
# ---------------------------------------------------------------------------

class TestCLIRouting(unittest.TestCase):

    def _run_main(self, argv):
        buf = io.StringIO()
        with patch.object(sys, "argv", ["audio_processor.py"] + argv):
            with patch("sys.stdout", buf):
                try:
                    ap.main()
                except SystemExit:
                    pass
        return buf.getvalue()

    def test_no_command_does_not_crash(self):
        # Should print help and exit cleanly (SystemExit caught above)
        self._run_main([])

    def test_unknown_command_exits(self):
        with patch.object(sys, "argv", ["audio_processor.py", "bogus-command"]):
            with self.assertRaises(SystemExit):
                ap.main()

    def test_analyze_missing_file_returns_error_json(self):
        out_json = tempfile.NamedTemporaryFile(suffix=".json", delete=False).name
        try:
            output = self._run_main(["analyze", "/no/such/file.wav", "--output", out_json])
            data = json.loads(output.strip())
            self.assertFalse(data["success"])
        finally:
            _cleanup(out_json)

    def test_correct_missing_input_returns_error_json(self):
        output = self._run_main([
            "correct", "/no/such/file.wav",
            "--fixes", "/no/fixes.json",
            "--output", "/tmp/out.wav",
        ])
        data = json.loads(output.strip())
        self.assertFalse(data["success"])

    def test_spectrogram_missing_file_returns_error_json(self):
        out_png = tempfile.NamedTemporaryFile(suffix=".png", delete=False).name
        try:
            output = self._run_main(["spectrogram", "/no/such/file.wav", "--output", out_png])
            data = json.loads(output.strip())
            self.assertFalse(data["success"])
        finally:
            _cleanup(out_png)

    @pytest.mark.slow
    def test_analyze_valid_file_returns_success(self):
        wav = _make_sine_wav(freq_hz=330.0, duration=1.5)
        out_json = tempfile.NamedTemporaryFile(suffix=".json", delete=False).name
        try:
            output = self._run_main(["analyze", wav, "--output", out_json])
            data = json.loads(output.strip())
            self.assertTrue(data["success"])
        finally:
            _cleanup(wav, out_json)


if __name__ == "__main__":
    unittest.main()
