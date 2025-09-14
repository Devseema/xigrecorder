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
  if (n < 1024*1024) return `${(n/1024).toFixed(1)} KB`;
  if (n < 1024*1024*1024) return `${(n/(1024*1024)).toFixed(1)} MB`;
  return `${(n/(1024*1024*1024)).toFixed(1)} GB`;
}

/* Use a simple localStorage-backed counter for guest usage.
   Keys:
    - xig_guest_count  (number of recordings used when not logged in)
    - xig_user_email   (when logged in)
    - xig_user_count   (number of recordings used while logged in)
*/
function getGuestCount() {
  return Number(localStorage.getItem('xig_guest_count') || 0);
}
function incGuestCount() {
  const v = getGuestCount() + 1;
  localStorage.setItem('xig_guest_count', String(v));
  return v;
}
function resetGuestCount() {
  localStorage.setItem('xig_guest_count','0');
}
function getUserEmail() {
  return localStorage.getItem('xig_user_email') || null;
}
function setUserEmail(e) {
  if (e) localStorage.setItem('xig_user_email', e);
  else localStorage.removeItem('xig_user_email');
}
function getUserCount() {
  return Number(localStorage.getItem('xig_user_count') || 0);
}
function incUserCount() {
  const v = getUserCount() + 1;
  localStorage.setItem('xig_user_count', String(v));
  return v;
}
function resetUserCount() {
  localStorage.setItem('xig_user_count', '0');
}
function logoutUser() {
  setUserEmail(null);
  resetUserCount();
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

  const [accountPanelOpen, setAccountPanelOpen] = useState(false);
  const [accountEmail, setAccountEmail] = useState(getUserEmail() || "");
  const [otpSent, setOtpSent] = useState(false);
  const [otpValue, setOtpValue] = useState("");
  const [guestCount, setGuestCountState] = useState(getGuestCount());
  const [userCount, setUserCountState] = useState(getUserCount());

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

    // set account email from localStorage if present
    setAccountEmail(getUserEmail() || "");

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (pendingDisplayStreamRef.current) {
        try { pendingDisplayStreamRef.current.getTracks().forEach(t=>t.stop()); } catch(_) {}
      }
      if (audioContextRef.current) {
        try { audioContextRef.current.close(); } catch(_) {}
      }
    };
    // eslint-disable-next-line
  }, []);

  useEffect(() => {
    setGuestCountState(getGuestCount());
    setUserCountState(getUserCount());
  }, [toasts]);

  function addToast(text, kind = "neutral") {
    const id = toastIdRef.current++;
    setToasts(s => [...s, { id, text, kind }]);
    setTimeout(() => setToasts(s => s.filter(x => x.id !== id)), 3500);
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
    addToast("Refreshed", "ok");
  }

  /* -------- Microphone acquisition (robust) -------- */
  async function getMicStream(selectedId) {
    async function tryG(constraint) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: constraint, video: false });
        console.log("getMicStream success constraint:", constraint, "tracks:", s.getAudioTracks().map(t=>({id:t.id,label:t.label})));
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
          await new Promise(r=>setTimeout(r,120));
        } catch(e) { console.warn('priming mic permission failed', e); }
      }
    } catch(e) { console.warn('enumerate in priming failed', e); }

    if (selectedId && selectedId !== 'default' && selectedId !== 'communications') {
      try { return await tryG({ deviceId: { exact: selectedId } }); } catch(e) { console.warn('exact device try failed', e); }
    }
    if (selectedId && selectedId !== 'default' && selectedId !== 'communications') {
      try { return await tryG({ deviceId: selectedId }); } catch(e) { console.warn('non-exact device try failed', e); }
    }
    return await tryG(true);
  }

  /* -------- Recording limits logic (guest/login) -------- */
  // limits stored centrally as config
  const LIMITS = {
    guestFree: 5,
    loggedInFree: 10
  };

  function canStartRecording() {
    const email = getUserEmail();
    if (!email) {
      return getGuestCount() < LIMITS.guestFree;
    } else { 
      const guestUsed = getGuestCount();
      const userUsed = getUserCount();
      return (guestUsed + userUsed) < LIMITS.loggedInFree;
    }
  }

  function noteRecordingSaved() {
    const email = getUserEmail();
    if (!email) {
      const newCount = incGuestCount();
      setGuestCountState(newCount);
    } else {
      const newCount = incUserCount();
      setUserCountState(newCount);
    }
  }

  /* -------- Picker + countdown + start/stop -------- */
  const commenceStartRecording = async () => {
    // check limits
    if (!canStartRecording()) {
      // open account panel (login)
      setAccountPanelOpen(true);
      addToast('Guest limit reached (5). Please log in to continue.', 'warn');
      return;
    }

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
    const id = setInterval(()=> {
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
            try { if (pendingDisplayStreamRef.current) pendingDisplayStreamRef.current.getTracks().forEach(t=>t.stop()); } catch(_) {}
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
      try { mixerDestinationRef.current.disconnect(); } catch(_) {}
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

      console.log("Combined tracks before recording:", combined.getTracks().map(t=>({kind:t.kind,label:t.label,id:t.id})));
      if (combined.getAudioTracks().length === 0) {
        console.warn("No audio tracks in combined stream");
        addToast("No audio present — check mic permissions or capture mode", "warn");
      }

      // preview
      if (previewRef.current) {
        previewRef.current.srcObject = combined;
        previewRef.current.muted = true;
        try { await previewRef.current.play(); } catch(_) {}
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
        timerRef.current = setInterval(()=>setSeconds(s=>s+1), 1000);
      };

      mr.onstop = async () => {
        setRecording(false);
        if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
        setStatus("Finalizing...");
        addToast("Saving recording...", "neutral");

        const blob = new Blob(chunksRef.current, { type: 'video/webm' });
        const filename = `xigrecorder_${new Date().toISOString().replace(/[:.]/g,'-')}.webm`;
        const approxSize = chunksRef.current.reduce((s,c)=>s+(c.size||0), 0);
        console.log('Approx bytes:', approxSize, 'chunks:', chunksRef.current.length);

        try {
          if (window.electronAPI && typeof window.electronAPI.saveVideo === 'function') {
            const arrayBuffer = await blob.arrayBuffer();
            const res = await window.electronAPI.saveVideo(arrayBuffer, filename);
            console.log('saveVideo response', res);
            if (res && res.success) {
              addToast("Saved to Videos", "ok");
              setStatus("Saved: " + res.path + ` (${niceBytes(res.size || approxSize)})`);
              // note usage increment here
              noteRecordingSaved();
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
            noteRecordingSaved();
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
            try { mixerDestinationRef.current.disconnect(); } catch(_) {}
            mixerDestinationRef.current = null;
          }
        } catch (e) {}
        streamsRef.current = null;
        // reload recordings list
        loadRecordings();
      };

      // small delay to avoid immediate empty recording
      await new Promise(r=>setTimeout(r, 200));

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
      try { if (pendingDisplayStreamRef.current) { pendingDisplayStreamRef.current.getTracks().forEach(t=>t.stop()); pendingDisplayStreamRef.current = null; } } catch(e){}
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
    } catch(e) { console.warn(e); addToast("Could not open folder", "error"); }
  };

  /* -------- OTP / account flow (renderer side) -------- */

  async function sendOtpToEmail(email) {
    if (!window.electronAPI || !window.electronAPI.sendOtp) {
      addToast("OTP sending not available (not in Electron)", "error");
      return { success: false, error: 'not-available' };
    }
    try {
      const res = await window.electronAPI.sendOtp(email);
      if (res && res.success) {
        setOtpSent(true);
        addToast('OTP sent to ' + email, 'ok');
        return { success: true };
      } else {
        addToast('OTP send failed: ' + (res && res.error), 'error');
        return { success: false, error: res && res.error };
      }
    } catch (err) {
      console.error('sendOtpToEmail error', err);
      addToast('OTP send error: ' + (err.message || err), 'error');
      return { success: false, error: err && err.message };
    }
  }

  async function verifyOtpForEmail(email, code) {
    if (!window.electronAPI || !window.electronAPI.verifyOtp) {
      addToast("OTP verify not available (not in Electron)", "error");
      return { success: false, error: 'not-available' };
    }
    try {
      const res = await window.electronAPI.verifyOtp(email, code);
      if (res && res.success) {
        // store user as logged in
        setUserEmail(email);
        addToast('Logged in as ' + email, 'ok');
        setAccountPanelOpen(false);
        setOtpSent(false);
        setOtpValue('');
        setUserCountState(getUserCount());
        return { success: true };
      } else {
        addToast('OTP verify failed: ' + (res && res.error), 'error');
        return { success: false, error: res && res.error };
      }
    } catch (err) {
      console.error('verifyOtpForEmail error', err);
      addToast('OTP verify error: ' + (err.message || err), 'error');
      return { success: false, error: err && err.message };
    }
  }

  /* Testing helper: reset guest count (button shown only in dev/test) */
  function handleResetGuestCount() {
    resetGuestCount();
    setGuestCountState(0);
    addToast('Guest count reset', 'ok');
  }

  /* -------- Render -------- */
  return (
    <div className="app-root xr-root">
      <header className="xr-header">
        <div>
          <h1 className="brand">XigRecorder</h1>
          <div className="subtitle">Screen + Microphone recorder — desktop app</div>
        </div>
        <div style={{display:'flex',gap:12,alignItems:'center'}}>
          <button className="mini" onClick={refreshAll}>Refresh</button>
          <button className="mini" onClick={openRecordingsFolder}>Open Videos</button>
          <button className="mini" onClick={() => setAccountPanelOpen(s=>!s)}>{getUserEmail() ? 'Account' : 'Login / Signup'}</button>
        </div>
      </header>

      <main className="xr-main app-main">
        {/* LEFT PANE */}
        <div className="left-pane">
          <div className="card sources-card">
            <div className="card-title">Source</div>
            <div className="sources-grid" aria-label="source list" style={{maxHeight: '320px', overflowY:'auto'}}>
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
            <div className="row" style={{alignItems:'center'}}>
              <label>Capture</label>
              <select value={captureMode} onChange={e => setCaptureMode(e.target.value)}>
                <option value="video+mic">Video + Microphone</option>
                <option value="video-only">Video only</option>
                <option value="audio-only">Audio only (microphone)</option>
                <option value="video+system">Video + System audio</option>
              </select>

              <label style={{marginLeft:12}}>Microphone</label>
              <select value={selectedMicId} onChange={e => setSelectedMicId(e.target.value)}>
                <option value="">Default microphone</option>
                {micDevices.map(m => <option key={m.deviceId} value={m.deviceId}>{m.label || m.deviceId}</option>)}
              </select>

              <button className="mini" onClick={enumerateMics}>Refresh Mics</button>

              <div style={{marginLeft:'auto'}}>
                <div style={{color:'#9aa7b0'}}>{status}</div>
              </div>
            </div>

            <div className="row actions" style={{marginTop:12}}>
              {countdown > 0 ? (
                <div style={{fontSize:18, fontWeight:700}}>Starting in {countdown}...</div>
              ) : (
                <>
                  <button className="primary" onClick={commenceStartRecording} disabled={recording}>Start Recording</button>
                  <button className="secondary" onClick={stopRecording} disabled={!recording}>Stop</button>
                </>
              )}

              <div style={{marginLeft:'auto', display:'flex',alignItems:'center',gap:12}}>
                {recording ? <div className="record-indicator"><span className="dot" /> {formatSecs(seconds)}</div> : null}
                <div className="save-msg" title={status}>{status}</div>
              </div>
            </div>

            <div style={{marginTop:12, display:'flex', gap:10, alignItems:'center'}}>
              <div className="small-note">Files saved to your system <strong>Videos</strong> folder (Electron). In browser they download to your Downloads folder.</div>
              <div style={{marginLeft:'auto', color:'#9aa7b0'}}>Sources loaded (desktop)</div>
            </div>

            <div style={{marginTop:12}}>
              <button className="mini" onClick={handleResetGuestCount}>Reset Guest Count (test)</button>
              <div style={{marginTop:8, color:'#9aa7b0'}}>Guest used {guestCount} / 5. Logged-in additional used {userCount}</div>
            </div>
          </div>
        </div>

        {/* RIGHT PANE */}
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
              <div className="recordings-list" style={{maxHeight: 240, overflowY:'auto'}}>
                <RecordingsList recordings={recordings} onReveal={() => { loadRecordings(); }} />
              </div>
              <div className="recordings-actions" style={{marginTop:10}}>
                <button className="mini" onClick={loadRecordings}>Refresh list</button>
                <button className="mini" onClick={openRecordingsFolder}>Open folder</button>
              </div>
            </div>
          </div>
        </div>

      </main>

      {/* Account panel (modal-ish) */}
      {accountPanelOpen && (
        <div style={{
          position:'fixed', left:0, right:0, top:0, bottom:0,
          display:'flex', alignItems:'center', justifyContent:'center', zIndex:3000,
          background:'rgba(0,0,0,0.5)'
        }}>
          <div style={{width:420, background:'#0b1520', borderRadius:12, padding:18, boxShadow:'0 8px 30px rgba(0,0,0,0.6)'}}>
            <div style={{display:'flex', justifyContent:'space-between', alignItems:'center'}}>
              <div style={{fontWeight:700, fontSize:18}}>Account</div>
              <div style={{cursor:'pointer'}} onClick={()=>setAccountPanelOpen(false)}>Close</div>
            </div>

            <div style={{marginTop:12}}>
              <div style={{color:'#9aa7b0'}}>Logged in: {getUserEmail() || 'Guest'}</div>
              <div style={{marginTop:12}}>
                <input type="email" placeholder="Email" value={accountEmail} onChange={e=>setAccountEmail(e.target.value)} style={{width:'100%', padding:10, borderRadius:8, border:'1px solid rgba(255,255,255,0.04)', background:'#070b0f', color:'#fff'}} />
                <div style={{display:'flex', gap:8, marginTop:8}}>
                  <button className="primary" onClick={async ()=>{
                    if (!accountEmail) return addToast('Enter email', 'warn');
                    const res = await sendOtpToEmail(accountEmail);
                    if (res.success) {
                      // OTP sent; show input (we set otpSent true already)
                    }
                  }}>Send OTP</button>
                  <button className="secondary" onClick={()=>{
                    setAccountEmail('');
                    setOtpValue('');
                    setOtpSent(false);
                  }}>Clear</button>
                </div>

                {otpSent && (
                  <div style={{marginTop:12}}>
                    <input placeholder="Enter OTP" value={otpValue} onChange={e=>setOtpValue(e.target.value)} style={{width:'100%', padding:10, borderRadius:8, border:'1px solid rgba(255,255,255,0.04)', background:'#070b0f', color:'#fff'}} />
                    <div style={{display:'flex', gap:8, marginTop:8}}>
                      <button className="primary" onClick={async ()=>{
                        const res = await verifyOtpForEmail(accountEmail, otpValue);
                        if (res.success) {
                          setAccountPanelOpen(false);
                          setAccountEmail(accountEmail);
                        }
                      }}>Verify OTP</button>
                      <button className="mini" onClick={()=>{ setOtpValue(''); }}>Clear</button>
                    </div>
                  </div>
                )}
              </div>

              <div style={{marginTop:12, color:'#9aa7b0'}}>For now login/signup is simulated. Once verified you'll be able to record extra times (total 10 recordings).</div>

            </div>
          </div>
        </div>
      )}

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
