// renderer/src/RecordingsList.jsx
import React, { useState } from "react";

/*
  Small recordings list component.
  Props:
    - recordings: array of { name, path, size, mtimeMs }
    - onReveal: optional callback after revealing / opening
*/
export default function RecordingsList({ recordings = [], onReveal = () => {} }) {
  const [playingUrl, setPlayingUrl] = useState(null);

  const reveal = async (path) => {
    if (!window.electronAPI || !window.electronAPI.revealRecording) {
      alert("Reveal not available in browser");
      return;
    }
    try {
      await window.electronAPI.revealRecording(path);
      onReveal();
    } catch (e) {
      console.warn("reveal error", e);
    }
  };

  const openExternal = async (path) => {
    if (!window.electronAPI || !window.electronAPI.openRecordingsFolder) {
      alert("Open not available in browser");
      return;
    }
    try {
      await window.electronAPI.revealRecording(path);
    } catch (e) {
      console.warn("open external error", e);
    }
  };

  const playInline = (path) => {
    const fileUrl = "file:///" + path.replace(/\\/g, "/");
    setPlayingUrl(fileUrl);
  };

  return (
    <div className="recordings-list">
      {recordings.length === 0 && <div className="empty">No recordings yet</div>}
      {recordings.map(r => (
        <div className="recording-row" key={r.path}>
          <div className="meta">
            <div className="name" title={r.name}>{r.name}</div>
            <div className="sub">{new Date(r.mtimeMs).toLocaleString()} • {r.size ? (r.size/1024/1024).toFixed(2) + " MB" : ""}</div>
          </div>
          <div className="actions">
            <button className="mini" onClick={() => playInline(r.path)}>Play</button>
            <button className="mini" onClick={() => reveal(r.path)}>Reveal</button>
            <button className="mini" onClick={() => openExternal(r.path)}>Open</button>
          </div>
        </div>
      ))}

      {playingUrl && (
        <div style={{marginTop:12}}>
          <video src={playingUrl} controls autoPlay style={{ width: "100%", borderRadius: 8 }} />
          <div style={{ textAlign: "right", marginTop: 8 }}>
            <button className="mini" onClick={() => setPlayingUrl(null)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}
