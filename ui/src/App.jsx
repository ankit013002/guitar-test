import { useState, useRef, useEffect, useMemo } from "react";

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const AUDIO_EXTS = /\.(wav|mp3|flac|ogg|m4a|aiff?)$/i;

const confClass = (c) =>
  c >= 0.8 ? "conf-high" : c >= 0.5 ? "conf-mid" : "conf-low";
const confLabel = (c) => `${(c * 100).toFixed(0)}%`;

const INITIAL_OPTS = {
  aggressiveness: 0.8,
  smoothVibrato: false,
  exportMidi: false,
  spectrogram: true,
  mode: "auto",
};

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function App() {
  const [file, setFile] = useState(null);
  const [drag, setDrag] = useState(false);
  const [opts, setOpts] = useState(INITIAL_OPTS);
  const [phase, setPhase] = useState("idle"); // idle|processing|done|error
  const [steps, setSteps] = useState([]);
  const [pct, setPct] = useState(0);
  const [curStep, setCurStep] = useState("");
  const [jobId, setJobId] = useState(null);
  const [result, setResult] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);
  const [originalUrl, setOriginalUrl] = useState(null);
  const [audioTime, setAudioTime] = useState(0);
  const [noteOverrides, setNoteOverrides] = useState({});
  const [reapplying, setReapplying] = useState(false);
  const [corrVersion, setCorrVersion] = useState(0);

  const esRef = useRef(null);
  const fileInputRef = useRef(null);
  const stepsEndRef = useRef(null);
  const corrAudioRef = useRef(null);
  const origAudioRef = useRef(null);

  // Cleanup SSE on unmount
  useEffect(() => () => esRef.current?.close(), []);

  // Auto-scroll step log
  useEffect(() => {
    stepsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [steps]);

  // Blob URL for original audio playback – revoked automatically on file change/reset
  useEffect(() => {
    if (!file) {
      setOriginalUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setOriginalUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // ── File handling ────────────────────────────────────────────────────────

  function selectFile(f) {
    if (!f || !AUDIO_EXTS.test(f.name)) return;
    esRef.current?.close();
    setFile(f);
    setPhase("idle");
    setResult(null);
    setErrorMsg(null);
    setSteps([]);
    setPct(0);
    setJobId(null);
    setNoteOverrides({});
    setAudioTime(0);
    setCorrVersion(0);
  }

  function toggleOverride(noteIndex, field) {
    const note = result?.analysis?.notes?.find((n) => n.index === noteIndex);
    if (!note) return;
    const defaultVal = field === "pitch" ? note.off_pitch : note.has_buzz;
    setNoteOverrides((prev) => {
      const cur = prev[noteIndex] ?? {};
      const curVal = field in cur ? cur[field] : defaultVal;
      return { ...prev, [noteIndex]: { ...cur, [field]: !curVal } };
    });
  }

  function handleSeek(time) {
    if (corrAudioRef.current) corrAudioRef.current.currentTime = time;
    if (origAudioRef.current) origAudioRef.current.currentTime = time;
    setAudioTime(time);
  }

  async function handleReapply() {
    setReapplying(true);
    const overrides = Object.entries(noteOverrides).map(([idx, ov]) => {
      const entry = { index: parseInt(idx) };
      if ("pitch" in ov) entry.pitch_correct_approved = ov.pitch;
      if ("buzz" in ov) entry.buzz_remove_approved = ov.buzz;
      return entry;
    });
    try {
      const resp = await fetch(`/api/reapply/${jobId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overrides }),
      });
      const text = await resp.text();
      let data;
      try { data = JSON.parse(text); } catch {
        throw new Error(resp.ok ? "Invalid response from server" : `Server error ${resp.status}`);
      }
      if (!resp.ok) throw new Error(data.error ?? `Server error ${resp.status}`);
      setResult((r) => ({ ...r, correctResult: data.result }));
      setNoteOverrides({});
      setCorrVersion((v) => v + 1);
    } catch (e) {
      alert(`Re-apply failed: ${e.message}`);
    } finally {
      setReapplying(false);
    }
  }

  function onDrop(e) {
    e.preventDefault();
    setDrag(false);
    selectFile(e.dataTransfer?.files?.[0]);
  }

  // ── Fix ──────────────────────────────────────────────────────────────────

  async function handleFix() {
    if (!file || phase === "processing") return;

    esRef.current?.close();
    setPhase("processing");
    setSteps([]);
    setPct(0);
    setResult(null);
    setErrorMsg(null);
    setCurStep("Uploading…");

    try {
      const fd = new FormData();
      fd.append("audio", file);
      fd.append("aggressiveness", String(opts.aggressiveness));
      fd.append("smoothVibrato", String(opts.smoothVibrato));
      fd.append("exportMidi", String(opts.exportMidi));
      fd.append("spectrogram", String(opts.spectrogram));
      fd.append("mode", opts.mode);

      const resp = await fetch("/api/fix", { method: "POST", body: fd });
      if (!resp.ok) {
        const body = await resp
          .json()
          .catch(() => ({ error: resp.statusText }));
        throw new Error(body.error || "Upload failed");
      }
      const { jobId: id } = await resp.json();
      setJobId(id);

      // Subscribe to SSE progress stream
      const es = new EventSource(`/api/events/${id}`);
      esRef.current = es;

      es.onmessage = (e) => {
        const msg = JSON.parse(e.data);

        if (msg.type === "progress") {
          if (msg.percent !== undefined) setPct(msg.percent);
          setCurStep(msg.message);
          setSteps((s) => [...s, msg]);
        } else if (msg.type === "done") {
          es.close();
          setPct(100);
          // Fetch the full analysis JSON (notes array) separately
          fetch(`/api/result/${id}`)
            .then((r) => r.json())
            .then((data) =>
              setResult({
                analyzeResult: msg.analyzeResult,
                correctResult: msg.correctResult,
                hasSpectrogram: msg.hasSpectrogram,
                hasMidi: msg.hasMidi,
                analysis: data.analysis,
              }),
            )
            .catch(() =>
              setResult({
                analyzeResult: msg.analyzeResult,
                correctResult: msg.correctResult,
                hasSpectrogram: msg.hasSpectrogram,
                hasMidi: msg.hasMidi,
                analysis: null,
              }),
            );
          setPhase("done");
        } else if (msg.type === "error") {
          es.close();
          setErrorMsg(msg.error || "Processing failed");
          setPhase("error");
        }
      };

      es.onerror = () => {
        es.close();
        if (phase !== "done") {
          setErrorMsg("Lost connection to server. Is the server running?");
          setPhase("error");
        }
      };
    } catch (err) {
      setErrorMsg(err.message);
      setPhase("error");
    }
  }

  function handleReset() {
    esRef.current?.close();
    setFile(null);
    setPhase("idle");
    setResult(null);
    setErrorMsg(null);
    setSteps([]);
    setPct(0);
    setJobId(null);
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="app">
      {/* ── Header ── */}
      <header className="app-header">
        <div className="header-inner">
          <span className="header-icon">🎸</span>
          <div>
            <h1>Guitar Audio Correction</h1>
            <p>
              One-shot pitch correction, buzz removal &amp; MIDI export —
              powered by pYIN + OLA
            </p>
          </div>
        </div>
      </header>

      <main className="app-main">
        {/* ── Upload + Controls ── */}
        <div className="top-row">
          {/* Drop zone */}
          <div
            className={`drop-zone ${drag ? "drag-over" : ""} ${file ? "has-file" : ""} ${phase === "processing" ? "disabled" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              if (phase !== "processing") setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={phase !== "processing" ? onDrop : (e) => e.preventDefault()}
            onClick={() =>
              phase !== "processing" && fileInputRef.current?.click()
            }
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".wav,.mp3,.flac,.ogg,.m4a,.aif,.aiff"
              style={{ display: "none" }}
              onChange={(e) => selectFile(e.target.files?.[0])}
            />
            {file ? (
              <div className="drop-content">
                <span className="drop-icon">🎵</span>
                <span className="drop-filename">{file.name}</span>
                <span className="drop-meta">
                  {(file.size / 1024 / 1024).toFixed(1)} MB
                </span>
                {phase === "idle" && (
                  <span className="drop-hint">Click or drop to change</span>
                )}
              </div>
            ) : (
              <div className="drop-content">
                <span className="drop-icon">📂</span>
                <span className="drop-label">Drop your recording here</span>
                <span className="drop-hint">or click to browse</span>
                <span className="drop-formats">
                  WAV · MP3 · FLAC · OGG · M4A
                </span>
              </div>
            )}
          </div>

          {/* Options panel */}
          <div className="options-panel">
            <div className="options-title">Options</div>

            <label className="opt-row">
              <span className="opt-label">
                Aggressiveness
                <span className="opt-value">
                  {Math.round(opts.aggressiveness * 100)}%
                </span>
              </span>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={opts.aggressiveness}
                disabled={phase === "processing"}
                onChange={(e) =>
                  setOpts((o) => ({
                    ...o,
                    aggressiveness: parseFloat(e.target.value),
                  }))
                }
                className="range-input"
              />
            </label>

            {[
              ["smoothVibrato", "Smooth vibrato (OLA)"],
              ["exportMidi", "Export MIDI file"],
              ["spectrogram", "Generate spectrogram"],
            ].map(([key, label]) => (
              <div key={key} className="opt-row opt-toggle-row">
                <span className="opt-label">{label}</span>
                <button
                  type="button"
                  className={`toggle ${opts[key] ? "on" : "off"}`}
                  disabled={phase === "processing"}
                  onClick={() => setOpts((o) => ({ ...o, [key]: !o[key] }))}
                >
                  {opts[key] ? "ON" : "OFF"}
                </button>
              </div>
            ))}

            <div className="opt-row opt-toggle-row">
              <span className="opt-label">Track type</span>
              <select
                className="mode-select"
                value={opts.mode}
                disabled={phase === "processing"}
                onChange={(e) => setOpts((o) => ({ ...o, mode: e.target.value }))}
              >
                <option value="auto">Auto-detect</option>
                <option value="mono">Melody / lead</option>
                <option value="chord">Chords / strumming</option>
              </select>
            </div>
          </div>
        </div>

        {/* ── Action buttons ── */}
        {phase === "idle" && (
          <button
            type="button"
            className="fix-btn"
            onClick={handleFix}
            disabled={!file}
          >
            ⚡ Fix &amp; Correct
          </button>
        )}

        {phase === "done" && (
          <button type="button" className="reset-btn" onClick={handleReset}>
            ↩ New Recording
          </button>
        )}

        {/* ── Progress ── */}
        {phase === "processing" && (
          <div className="progress-card">
            <div className="progress-header">
              <span className="progress-pct">{pct}%</span>
              <span className="progress-step">{curStep}</span>
            </div>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="step-log">
              {steps.slice(-10).map((s, i) => (
                <div
                  key={i}
                  className={`step-line ${s.percent !== undefined ? "has-pct" : ""}`}
                >
                  <span className="step-arrow">›</span>
                  <span>{s.message}</span>
                </div>
              ))}
              <div ref={stepsEndRef} />
            </div>
          </div>
        )}

        {/* ── Error ── */}
        {phase === "error" && (
          <div className="error-card">
            <span className="error-x">✗</span>
            <div className="error-body">
              <strong>Processing failed</strong>
              <p>{errorMsg}</p>
            </div>
            <button type="button" className="reset-btn" onClick={handleReset}>
              Try Again
            </button>
          </div>
        )}

        {/* ── Results ── */}
        {phase === "done" && result && (
          <>
            <section className="card">
              <h2 className="card-title">Audio Comparison</h2>
              <div className="audio-players">
                <AudioPlayer label="Original" src={originalUrl} audioRef={origAudioRef} />
                <AudioPlayer
                  key={corrVersion}
                  label="Corrected"
                  src={`/api/download/${jobId}/wav?v=${corrVersion}`}
                  audioRef={corrAudioRef}
                  onTimeUpdate={setAudioTime}
                />
              </div>
            </section>
            {result.hasSpectrogram && (
              <SpectrogramPanel
                jobId={jobId}
                duration={result.analyzeResult?.summary?.duration}
                audioTime={audioTime}
                onSeek={handleSeek}
              />
            )}
            {result.analysis?.notes?.length > 0 && (
              <NotesTable
                notes={result.analysis.notes}
                overrides={noteOverrides}
                onToggle={toggleOverride}
                onReapply={handleReapply}
                reapplying={reapplying}
                audioTime={audioTime}
              />
            )}
            <SummaryCard
              analyzeResult={result.analyzeResult}
              correctResult={result.correctResult}
            />
            <DownloadsCard jobId={jobId} result={result} />
          </>
        )}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AudioPlayer
// ---------------------------------------------------------------------------

function AudioPlayer({ label, src, audioRef, onTimeUpdate }) {
  return (
    <div className="audio-player">
      <span className="audio-label">{label}</span>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio
        ref={audioRef}
        controls
        src={src}
        preload="metadata"
        onTimeUpdate={onTimeUpdate ? (e) => onTimeUpdate(e.target.currentTime) : undefined}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// SummaryCard
// ---------------------------------------------------------------------------

function SummaryCard({ analyzeResult, correctResult }) {
  const as = analyzeResult?.summary ?? {};
  const cs = correctResult?.summary ?? {};

  const stats = [
    { label: "Duration", value: as.duration != null ? `${as.duration}s` : "—" },
    {
      label: "Tempo",
      value: as.tempo_bpm != null ? `${as.tempo_bpm} BPM` : "—",
    },
    { label: "Notes detected", value: as.total_notes ?? "—" },
    {
      label: "Flagged",
      value: as.flagged_notes ?? "—",
      cls: as.flagged_notes > 0 ? "text-yellow" : "text-green",
    },
    {
      label: "Buzz issues",
      value: as.buzz_notes ?? "—",
      cls: as.buzz_notes > 0 ? "text-red" : "text-green",
    },
    {
      label: "Off-pitch",
      value: as.off_pitch_notes ?? "—",
      cls: as.off_pitch_notes > 0 ? "text-yellow" : "text-green",
    },
    {
      label: "Avg confidence",
      value:
        as.average_confidence != null ? confLabel(as.average_confidence) : "—",
      cls:
        as.average_confidence != null ? confClass(as.average_confidence) : "",
    },
    {
      label: "Corrected",
      value: cs.notes_corrected ?? "—",
      cls: cs.notes_corrected > 0 ? "text-cyan" : "",
    },
  ];

  return (
    <section className="card">
      <h2 className="card-title">Analysis Summary</h2>
      <div className="stat-grid">
        {stats.map((s) => (
          <div key={s.label} className="stat-item">
            <span className="stat-label">{s.label}</span>
            <span className={`stat-value ${s.cls ?? ""}`}>{s.value}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// NotesTable
// ---------------------------------------------------------------------------

function NotesTable({ notes, overrides, onToggle, onReapply, reapplying, audioTime }) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? notes : notes.slice(0, 20);
  const hasOverrides = Object.keys(overrides).length > 0;

  // Which note is currently playing
  const activeIndex = useMemo(() => {
    let idx = -1;
    for (const n of notes) {
      if (n.timestamp <= audioTime) idx = n.index;
      else break;
    }
    return idx;
  }, [audioTime, notes]);

  function getEnabled(note, field) {
    const ov = overrides[note.index];
    if (ov && field in ov) return ov[field];
    return field === "pitch" ? note.off_pitch : note.has_buzz;
  }

  return (
    <section className="card">
      <h2 className="card-title">
        Detected Notes
        <span className="badge">{notes.length}</span>
        <button
          type="button"
          className="reapply-btn"
          onClick={onReapply}
          disabled={reapplying || !hasOverrides}
          title={hasOverrides ? "Re-run correction with your changes" : "Toggle P or B on any note to enable"}
        >
          {reapplying ? "Applying…" : "Re-apply corrections"}
        </button>
      </h2>
      <p className="notes-hint">
        Toggle <strong>P</strong> (pitch) or <strong>B</strong> (buzz) on any note to enable or force-apply that fix, then click Re-apply to hear the result.
      </p>
      <div className="table-wrap">
        <table className="notes-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Time</th>
              <th>Note</th>
              <th>Deviation</th>
              <th>Confidence</th>
              <th>Flags</th>
              <th>P</th>
              <th>B</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((note, i) => {
              const hasPitch = note.off_pitch;
              const hasBuzz = note.has_buzz;
              const isActive = note.index === activeIndex;
              const pitchOn = getEnabled(note, "pitch");
              const buzzOn = getEnabled(note, "buzz");
              return (
                <tr
                  key={i}
                  className={[
                    hasBuzz || hasPitch ? "row-flagged" : "",
                    isActive ? "row-active" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  <td className="text-muted">{i + 1}</td>
                  <td className="text-muted mono">{note.timestamp.toFixed(2)}s</td>
                  <td>
                    {note.was_corrected ? (
                      <>
                        <span className="text-muted">{note.original_note}</span>
                        <span className="arrow"> → </span>
                        <span className="text-green">{note.corrected_note}</span>
                      </>
                    ) : (
                      <span className="mono">{note.original_note}</span>
                    )}
                  </td>
                  <td className="mono">
                    <span className={Math.abs(note.pitch_deviation_cents) > 20 ? "text-yellow" : "text-muted"}>
                      {note.pitch_deviation_cents > 0 ? "+" : ""}
                      {note.pitch_deviation_cents.toFixed(0)}¢
                    </span>
                  </td>
                  <td>
                    <span className={confClass(note.confidence)}>
                      {confLabel(note.confidence)}
                    </span>
                  </td>
                  <td className="flags-cell">
                    {hasBuzz && <span className="flag flag-buzz">BUZZ</span>}
                    {hasPitch && (
                      <span className="flag flag-pitch">
                        {note.pitch_deviation_cents > 0 ? "+" : ""}
                        {note.pitch_deviation_cents.toFixed(0)}¢
                      </span>
                    )}
                    {note.has_vibrato && <span className="flag flag-vib">VIB</span>}
                  </td>
                  <td>
                    <button
                      type="button"
                      className={`fix-toggle ${pitchOn ? "on" : "off"}`}
                      onClick={() => onToggle(note.index, "pitch")}
                      title={pitchOn ? "Pitch fix ON — click to disable" : "Pitch fix OFF — click to force-apply"}
                    >
                      P
                    </button>
                  </td>
                  <td>
                    <button
                      type="button"
                      className={`fix-toggle ${buzzOn ? "on" : "off"}`}
                      onClick={() => onToggle(note.index, "buzz")}
                      title={buzzOn ? "Buzz fix ON — click to disable" : "Buzz fix OFF — click to force-apply"}
                    >
                      B
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {notes.length > 20 && (
        <button
          type="button"
          className="show-more"
          onClick={() => setShowAll((s) => !s)}
        >
          {showAll ? "Show less" : `Show all ${notes.length} notes`}
        </button>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// SpectrogramPanel
// ---------------------------------------------------------------------------

function SpectrogramPanel({ jobId, duration, audioTime, onSeek }) {
  const [loaded, setLoaded] = useState(false);
  const src = `/api/spectrogram/${jobId}?_=${Date.now()}`;
  const cursorPct = duration > 0 ? Math.min(100, (audioTime / duration) * 100) : 0;

  function handleClick(e) {
    if (!loaded || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    onSeek(((e.clientX - rect.left) / rect.width) * duration);
  }

  return (
    <section className="card">
      <h2 className="card-title">Spectrogram — click to seek</h2>
      {!loaded && <div className="spec-loader">Loading spectrogram…</div>}
      <div
        className="spec-wrapper"
        onClick={handleClick}
        style={{ cursor: loaded ? "crosshair" : "default" }}
      >
        <img
          src={src}
          alt="Audio spectrogram"
          className={`spectrogram ${loaded ? "" : "hidden"}`}
          onLoad={() => setLoaded(true)}
          onError={() => setLoaded(true)}
        />
        {loaded && (
          <div className="spec-cursor" style={{ left: `${cursorPct}%` }} />
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// DownloadsCard
// ---------------------------------------------------------------------------

function DownloadsCard({ jobId, result }) {
  return (
    <section className="card downloads-card">
      <h2 className="card-title">Downloads</h2>
      <div className="dl-row">
        <a
          href={`/api/download/${jobId}/wav`}
          download
          className="dl-btn dl-wav"
        >
          ↓ Corrected WAV
        </a>
        {result.hasMidi && (
          <a
            href={`/api/download/${jobId}/midi`}
            download
            className="dl-btn dl-midi"
          >
            ↓ MIDI File
          </a>
        )}
        <a
          href={`/api/download/${jobId}/analysis`}
          download
          className="dl-btn dl-json"
        >
          ↓ Analysis JSON
        </a>
      </div>
    </section>
  );
}
