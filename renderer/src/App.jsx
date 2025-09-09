// renderer/src/App.jsx
import React, { useEffect, useRef, useState } from "react";
import "./app.css";
import RecordingsList from "./RecordingsList";

/* Helpers */
function formatSecs(s) {
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}
function niceBytes(n) {
  if (!n && n !== 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/* --- App --- */
export default function App() {
  const [isElectron, setIsElectron] = useState(!!window.electronAPI);
  const [sources, setSources] = useState([]);
  const [selectedSourceId, setSelectedSourceId] = useState("");
  const [micDevices, setMicDevices] = useState([]);
  const [selectedMicId, setSelectedMicId] = useState("");
  const [captureMode, setCaptureMode] = useState("video+mic");
  const [status, setStatus] = useState("idle");
  const [countdown, setCountdown] = useState(0);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [toasts, setToasts] = useState([]);
  const [recordings, setRecordings] = useState([]);
  const [usageInfo, setUsageInfo] = useState(null);

  const previewRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const streamsRef = useRef(null);
  const timerRef = useRef(null);

  const pendingDisplayStreamRef = useRef(null);
  const pendingPickerOpeningRef = useRef(false);

  const audioContextRef = useRef(null);
  const mixerDestinationRef = useRef(null);

  const lastStartTimeRef = useRef(null);

  const toastIdRef = useRef(1);

  useEffect(() => {
    setIsElectron(!!window.electronAPI);
    loadSources();
    enumerateMics();
    loadRecordings();
    loadUsageInfo();

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (pendingDisplayStreamRef.current) {
        try { pendingDisplayStreamRef.current.getTracks().forEach(t => t.stop()); } catch (_) {}
      }
      if (audioContextRef.current) {
        try { audioContextRef.current.close(); } catch (_) {}
      }
    };
    // eslint-disable-next-line
  }, []);

  function addToast(text, kind = "neutral") {
    const id = toastIdRef.current++;
    setToasts(s => [...s, { id, text, kind }]);
    setTimeout(() => setToasts(s => s.filter(x => x.id !== id)), 3500);
  }

  /* -------- Usage API -------- */
  async function loadUsageInfo() {
    if (!window.electronAPI || !window.electronAPI.getUsageInfo) return;
    try {
      const info = await window.electronAPI.getUsageInfo();
      setUsageInfo(info || null);
    } catch (e) {
      console.warn("loadUsageInfo failed", e);
    }
  }

  async function canRecord() {
    // If no electron API available, allow (browser fallback)
    if (!window.electronAPI || !window.electronAPI.getUsageInfo) return true;
    try {
      const info = await window.electronAPI.getUsageInfo();
      setUsageInfo(info || null);

      if (!info.isLoggedIn && (info.freeCount || 0) >= 5) {
        addToast("Guest limit reached (5). Please log in to continue.", "warn");
        return false;
      }
      if (info.isLoggedIn && !info.isSubscribed && (info.userCount || 0) >= 10) {
        addToast("Limit reached (10 recordings). Please subscribe to continue.", "warn");
        return false;
      }
      return true;
    } catch (e) {
      console.warn("canRecord check failed", e);
      return true;
    }
  }

  /* -------- Source & Mic enumerate -------- */
  async function loadSources() {
    setStatus("Loading sources...");
    if (window.electronAPI && window.electronAPI.getSources) {
      try {
        const s = await window.electronAPI.getSources();
        setSources(s || []);
        if (s && s.length) setSelectedSourceId(s[0].id);
        setStatus("Sources loaded (desktop)");
        return;
      } catch (err) {
        console.warn("desktop getSources failed:", err);
        setStatus("desktop capture unavailable — using screen picker");
      }
    }
    // fallback to a single picker option
    setSources([{ id: "picker://screen", name: "Screen picker (native)", thumbnail: null }]);
    setSelectedSourceId("picker://screen");
  }

  async function enumerateMics() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const mics = devices.filter(d => d.kind === "audioinput");
      setMicDevices(mics);
      if (mics.length) setSelectedMicId(mics[0].deviceId);
      console.log("enumerated mics:", mics);
    } catch (e) {
      console.warn("enumerateDevices failed", e);
    }
  }

  async function loadRecordings() {
    if (!window.electronAPI || !window.electronAPI.listRecordings) return;
    try {
      const res = await window.electronAPI.listRecordings();
      if (res && res.success) setRecordings(res.files || []);
    } catch (e) {
      console.warn("loadRecordings failed", e);
    }
  }

  async function refreshAll() {
    addToast("Refreshing...", "neutral");
    await loadSources();
    await enumerateMics();
    await loadRecordings();
    await loadUsageInfo();
    addToast("Refreshed", "ok");
  }

  /* -------- Microphone acquisition (robust) -------- */
  async function getMicStream(selectedId) {
    async function tryG(constraint) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: constraint, video: false });
        console.log("getMicStream success constraint:", constraint, "tracks:", s.getAudioTracks().map(t => ({ id: t.id, label: t.label })));
        return s;
      } catch (err) {
        console.warn("getMicStream fail for", constraint, err);
        throw err;
      }
    }

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const labelsShown = devices.some(d => d.kind === 'audioinput' && d.label && d.label.length > 0);
      if (!labelsShown) {
        try {
          await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
          await new Promise(r => setTimeout(r, 120));
        } catch (e) { console.warn('priming mic permission failed', e); }
      }
    } catch (e) { console.warn('enumerate in priming failed', e); }

    if (selectedId && selectedId !== 'default' && selectedId !== 'communications') {
      try { return await tryG({ deviceId: { exact: selectedId } }); } catch (e) { console.warn('exact device try failed', e); }
    }
    if (selectedId && selectedId !== 'default' && selectedId !== 'communications') {
      try { return await tryG({ deviceId: selectedId }); } catch (e) { console.warn('non-exact device try failed', e); }
    }
    return await tryG(true);
  }

  /* -------- Picker + countdown + start/stop -------- */

  // Wrapper to check usage then start countdown/recording
  const commenceStartRecording = async () => {
    const ok = await canRecord();
    if (!ok) return;

    if (!selectedSourceId) { addToast("Select a source", "warn"); setStatus("Select a source"); return; }

    if (selectedSourceId === "picker://screen") {
      if (!pendingDisplayStreamRef.current && !pendingPickerOpeningRef.current) {
        try {
          pendingPickerOpeningRef.current = true;
          addToast("Opening screen picker — choose what to share", "neutral");
          const gdOptions = { video: true, audio: (captureMode === 'video+system' || captureMode === 'audio-only') ? true : false };
          const s = await navigator.mediaDevices.getDisplayMedia(gdOptions);
          pendingDisplayStreamRef.current = s;
          attachStreamEndHandler(s);
          addToast("Screen selected", "ok");
        } catch (err) {
          console.warn("picker fail/cancel", err);
          setStatus("Picker canceled");
          addToast("Picker canceled", "warn");
          pendingDisplayStreamRef.current = null;
          pendingPickerOpeningRef.current = false;
          return;
        } finally { pendingPickerOpeningRef.current = false; }
      }
    }

    setCountdown(3);
    setStatus("Starting in 3s...");
    addToast("Recording starts in 3s", "neutral");
    const id = setInterval(() => {
      setCountdown(c => {
        if (c <= 1) { clearInterval(id); setCountdown(0); startRecording(); return 0; }
        return c - 1;
      });
    }, 1000);
  };

  function attachStreamEndHandler(stream) {
    if (!stream) return;
    stream.getTracks().forEach(track => {
      track.onended = () => {
        console.log('TRACK.ONENDED', track.kind, track.label);
        setTimeout(() => {
          if (!recording) {
            try { if (pendingDisplayStreamRef.current) pendingDisplayStreamRef.current.getTracks().forEach(t => t.stop()); } catch (_) {}
            pendingDisplayStreamRef.current = null;
          } else {
            const started = lastStartTimeRef.current || 0;
            const now = Date.now();
            if (now - started > 700) {
              addToast("Sharing stopped — stopping recording", "warn");
              stopRecording();
            } else {
              console.log('transient track end ignored (within 700ms)');
            }
          }
        }, 120);
      };
    });
  }

  function mixAudioTracks(screenStream, micStream) {
    const screenHasAudio = !!(screenStream && screenStream.getAudioTracks && screenStream.getAudioTracks().length > 0);
    const micHasAudio = !!(micStream && micStream.getAudioTracks && micStream.getAudioTracks().length > 0);

    if (!screenHasAudio && !micHasAudio) return [];
    if (!micHasAudio && screenHasAudio) return screenStream.getAudioTracks();
    if (!screenHasAudio && micHasAudio) return micStream.getAudioTracks();

    if (!audioContextRef.current) audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
    const ac = audioContextRef.current;

    if (mixerDestinationRef.current) {
      try { mixerDestinationRef.current.disconnect(); } catch (_) {}
      mixerDestinationRef.current = null;
    }

    const destination = ac.createMediaStreamDestination();
    mixerDestinationRef.current = destination;

    if (screenHasAudio) {
      try {
        const screenSource = ac.createMediaStreamSource(screenStream);
        screenSource.connect(destination);
      } catch (e) {
        console.warn('mixAudioTracks: screenSource failed', e);
      }
    }
    if (micHasAudio) {
      try {
        const micSource = ac.createMediaStreamSource(micStream);
        micSource.connect(destination);
      } catch (e) {
        console.warn('mixAudioTracks: micSource failed', e);
      }
    }
    return destination.stream.getAudioTracks();
  }

  async function startRecording() {
    try {
      setStatus("Requesting streams...");
      let screenStream = null;
      let micStream = null;

      if (selectedSourceId === "picker://screen") {
        if (!pendingDisplayStreamRef.current) { addToast("No screen selected", "warn"); setStatus("No screen"); return; }
        screenStream = pendingDisplayStreamRef.current;
        pendingDisplayStreamRef.current = null;
        attachStreamEndHandler(screenStream);
      } else {
        const sc = {
          video: {
            mandatory: {
              chromeMediaSource: "desktop",
              chromeMediaSourceId: selectedSourceId,
              maxFrameRate: 30
            }
          },
          audio: captureMode === "video+system" ? {
            mandatory: {
              chromeMediaSource: "desktop",
              chromeMediaSourceId: selectedSourceId
            }
          } : false
        };
        if (captureMode !== "audio-only") {
          screenStream = await navigator.mediaDevices.getUserMedia(sc);
          attachStreamEndHandler(screenStream);
        }
      }

      if (captureMode === "audio-only" || captureMode === "video+mic") {
        try {
          micStream = await getMicStream(selectedMicId);
        } catch (err) {
          console.warn("mic acquisition failed", err);
          micStream = null;
          addToast("Mic not available / permission denied", "warn");
        }
      }

      // Compose combined stream
      let combined = null;
      if (captureMode === "audio-only") {
        if (!micStream) { addToast("Mic not available", "error"); setStatus("No mic"); return; }
        combined = micStream;
        streamsRef.current = { screenStream: null, audioStream: micStream, combined };
      } else {
        combined = new MediaStream();
        if (screenStream) screenStream.getVideoTracks().forEach(t => combined.addTrack(t));

        let audioTracks = [];
        const screenHasAudio = !!(screenStream && screenStream.getAudioTracks && screenStream.getAudioTracks().length > 0);
        const micHasAudio = !!(micStream && micStream.getAudioTracks && micStream.getAudioTracks().length > 0);

        if (micHasAudio && screenHasAudio) {
          audioTracks = mixAudioTracks(screenStream, micStream);
        } else if (micHasAudio) {
          audioTracks = micStream.getAudioTracks();
        } else if (screenHasAudio) {
          audioTracks = screenStream.getAudioTracks();
        }

        audioTracks.forEach(t => combined.addTrack(t));
        streamsRef.current = { screenStream, audioStream: micStream, combined };
      }

      console.log("Combined tracks before recording:", combined.getTracks().map(t => ({ kind: t.kind, label: t.label, id: t.id })));
      if (combined.getAudioTracks().length === 0) {
        console.warn("No audio tracks in combined stream");
        addToast("No audio present — check mic permissions or capture mode", "warn");
      }

      // preview
      if (previewRef.current) {
        previewRef.current.srcObject = combined;
        previewRef.current.muted = true;
        try { await previewRef.current.play(); } catch (_) {}
      }

      // recorder options (prefer vp8)
      const options = {};
      if (MediaRecorder.isTypeSupported) {
        if (MediaRecorder.isTypeSupported('video/webm;codecs=vp8')) options.mimeType = 'video/webm;codecs=vp8';
        else if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9')) options.mimeType = 'video/webm;codecs=vp9';
        else options.mimeType = 'video/webm';
      }

      const mr = new MediaRecorder(combined, options);
      mediaRecorderRef.current = mr;
      chunksRef.current = [];

      mr.ondataavailable = e => { if (e.data && e.data.size) { console.log('ondataavailable size', e.data.size); chunksRef.current.push(e.data); } };

      mr.onstart = () => {
        lastStartTimeRef.current = Date.now();
        setRecording(true);
        setStatus("Recording...");
        addToast("Recording started", "recording");
        setSeconds(0);
        timerRef.current = setInterval(() => setSeconds(s => s + 1), 1000);
      };

      mr.onstop = async () => {
        setRecording(false);
        if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
        setStatus("Finalizing...");
        addToast("Saving recording...", "neutral");

        const blob = new Blob(chunksRef.current, { type: 'video/webm' });
        const filename = `xigrecorder_${new Date().toISOString().replace(/[:.]/g, '-')}.webm`;
        const approxSize = chunksRef.current.reduce((s, c) => s + (c.size || 0), 0);
        console.log('Approx bytes:', approxSize, 'chunks:', chunksRef.current.length);

        try {
          if (window.electronAPI && typeof window.electronAPI.saveVideo === 'function') {
            const arrayBuffer = await blob.arrayBuffer();
            const res = await window.electronAPI.saveVideo(arrayBuffer, filename);
            console.log('saveVideo response', res);
            if (res && res.success) {
              addToast("Saved to Videos", "ok");
              setStatus("Saved: " + res.path + ` (${niceBytes(res.size || approxSize)})`);
              // increment usage count now that a recording was saved
              try {
                if (window.electronAPI && typeof window.electronAPI.incrementRecording === 'function') {
                  await window.electronAPI.incrementRecording();
                  await loadUsageInfo();
                }
              } catch (ie) {
                console.warn('incrementRecording failed', ie);
              }
            } else {
              addToast("Save failed", "error");
              setStatus("Save failed: " + (res && res.error));
            }
          } else {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
            addToast("Downloaded (browser)", "ok");
            setStatus("Downloaded (browser)");
          }
        } catch (err) {
          console.error('save error', err);
          addToast("Save error: " + (err.message || err), "error");
          setStatus("Save error: " + (err.message || err));
        }

        // cleanup
        try {
          streamsRef.current?.screenStream?.getTracks()?.forEach(t => t.stop());
          streamsRef.current?.audioStream?.getTracks()?.forEach(t => t.stop());
          if (previewRef.current) { previewRef.current.pause(); previewRef.current.srcObject = null; }
          if (mixerDestinationRef.current) {
            try { mixerDestinationRef.current.disconnect(); } catch (_) {}
            mixerDestinationRef.current = null;
          }
        } catch (e) { }
        streamsRef.current = null;
        // reload recordings list
        loadRecordings();
      };

      // small delay to avoid immediate empty recording
      await new Promise(r => setTimeout(r, 200));

      try {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'inactive') {
          mediaRecorderRef.current.start(1000);
        } else {
          console.warn('Recorder not inactive -> not starting', mediaRecorderRef.current && mediaRecorderRef.current.state);
        }
      } catch (err) {
        console.error('Recorder.start failed', err);
        addToast('Recorder start failed: ' + (err.message || err), 'error');
      }
    } catch (err) {
      console.error('startRecording error', err);
      addToast('Start failed: ' + (err && err.message), 'error');
      setStatus('Start failed: ' + (err && err.message));
      try { if (pendingDisplayStreamRef.current) { pendingDisplayStreamRef.current.getTracks().forEach(t => t.stop()); pendingDisplayStreamRef.current = null; } } catch (e) { }
    }
  }

  function stopRecording() {
    try {
      const mr = mediaRecorderRef.current;
      if (mr && (mr.state === 'recording' || mr.state === 'paused')) {
        mr.stop();
        addToast('Stopped recording', 'neutral');
      } else {
        setStatus('Recorder not running');
      }
    } catch (err) {
      console.error('stopRecording error', err);
      setStatus('Stop failed: ' + (err && err.message));
    }
  }

  /* -------- UI helpers -------- */
  const onSelectSource = (id) => {
    setSelectedSourceId(id);
  };

  const openRecordingsFolder = async () => {
    if (!window.electronAPI || !window.electronAPI.openRecordingsFolder) {
      addToast("Not available (browser)", "warn");
      return;
    }
    try {
      const res = await window.electronAPI.openRecordingsFolder();
      if (res && res.success) addToast("Opened folder", "ok");
    } catch (e) { console.warn(e); addToast("Could not open folder", "error"); }
  };

  /* -------- Render -------- */
  return (
    <div className="app-root xr-root">
      <header className="xr-header">
        <div>
          <h1 className="brand">XigRecorder</h1>
          <div className="subtitle">Screen + Microphone recorder — desktop app</div>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <button className="mini" onClick={refreshAll}>Refresh</button>
          <button className="mini" onClick={openRecordingsFolder}>Open Videos</button>
        </div>
      </header>

      <main className="xr-main app-main">
        {/* LEFT PANE: sources and controls (scrollable) */}
        <div className="left-pane">

          <div className="card sources-card">
            <div className="card-title">Source</div>
            <div className="sources-grid" aria-label="source list">
              {sources.length === 0 && <div className="empty">No sources found</div>}
              {sources.map(s => (
                <button
                  key={s.id}
                  className={`source-tile ${selectedSourceId === s.id ? 'selected' : ''}`}
                  onClick={() => onSelectSource(s.id)}
                  title={s.name}
                >
                  <div className="thumb">
                    {s.thumbnail ? <img src={s.thumbnail} alt={s.name} /> : <div className="thumb-empty" />}
                  </div>
                  <div className="source-label">{s.name}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="card controls-card">
            <div className="row" style={{ alignItems: 'center' }}>
              <label>Capture</label>
              <select value={captureMode} onChange={e => setCaptureMode(e.target.value)}>
                <option value="video+mic">Video + Microphone</option>
                <option value="video-only">Video only</option>
                <option value="audio-only">Audio only (microphone)</option>
                <option value="video+system">Video + System audio</option>
              </select>

              <label style={{ marginLeft: 12 }}>Microphone</label>
              <select value={selectedMicId} onChange={e => setSelectedMicId(e.target.value)}>
                <option value="">Default microphone</option>
                {micDevices.map(m => <option key={m.deviceId} value={m.deviceId}>{m.label || m.deviceId}</option>)}
              </select>

              <button className="mini" onClick={enumerateMics}>Refresh Mics</button>

              <div style={{ marginLeft: 'auto' }}>
                <div style={{ color: '#9aa7b0' }}>{status}</div>
              </div>
            </div>

            <div className="row actions" style={{ marginTop: 12 }}>
              {countdown > 0 ? (
                <div style={{ fontSize: 18, fontWeight: 700 }}>Starting in {countdown}...</div>
              ) : (
                <>
                  <button className="primary" onClick={commenceStartRecording} disabled={recording}>Start Recording</button>
                  <button className="secondary" onClick={stopRecording} disabled={!recording}>Stop</button>
                </>
              )}

              <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
                {recording ? <div className="record-indicator"><span className="dot" /> {formatSecs(seconds)}</div> : null}
                <div className="save-msg" title={status}>{status}</div>
              </div>
            </div>

            <div className="small-note" style={{ marginTop: 12 }}>
              Files saved to your system <strong>Videos</strong> folder (Electron). In browser they download to your Downloads folder.
            </div>

            {/* Usage info */}
            <div style={{ marginTop: 8, color: '#9aa7b0', fontSize: 13 }}>
              {usageInfo ? (
                usageInfo.isLoggedIn ? (
                  usageInfo.isSubscribed ? "Subscribed user: unlimited recordings" :
                    `Logged in: ${usageInfo.userCount || 0}/10 recordings used`
                ) : (
                  `Guest: ${usageInfo.freeCount || 0}/5 recordings used`
                )
              ) : null}
            </div>
          </div>

        </div>

        {/* RIGHT PANE: sticky preview + recordings */}
        <div className="right-pane">
          <div className="right-sticky">
            <div className="card preview-card">
              <div className="card-title">Preview <span className="muted">(muted)</span></div>
              <div className="preview-wrap">
                <video ref={previewRef} className="preview-video" playsInline />
              </div>
              <div className="preview-foot">If blank, try Refresh or check mic permissions.</div>
            </div>

            <div className="card recordings-card">
              <div className="card-title">Recordings</div>
              <div className="recordings-list">
                <RecordingsList recordings={recordings} onReveal={() => { loadRecordings(); }} />
              </div>
              <div className="recordings-actions" style={{ marginTop: 10 }}>
                <button className="mini" onClick={loadRecordings}>Refresh list</button>
                <button className="mini" onClick={openRecordingsFolder}>Open folder</button>
              </div>
            </div>
          </div>
        </div>

      </main>

      <div className="toasts">
        {toasts.map(t => <div key={t.id} className={`toast ${t.kind || ''}`}>{t.text}</div>)}
      </div>

      {countdown > 0 && (
        <div className="countdown-overlay">
          <div className="countdown-big">{countdown}</div>
          <div className="countdown-sub">Get ready — recording starts soon</div>
        </div>
      )}
    </div>
  );
}
