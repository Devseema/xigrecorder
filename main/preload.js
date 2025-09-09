// main/preload.js
const { contextBridge, ipcRenderer } = require('electron');

console.log('PRELOAD starting — process.type=', process?.type);

// Helper wrapper: call ipc and normalize errors
async function invokeSafe(channel, ...args) {
  try {
    const res = await ipcRenderer.invoke(channel, ...args);
    return res;
  } catch (err) {
    console.error(`preload.invokeSafe ${channel} error:`, err);
    throw err;
  }
}

contextBridge.exposeInMainWorld('electronAPI', {
  /* ---------- Desktop sources (main desktopCapturer) ---------- */
  getSources: async (opts) => {
    const res = await invokeSafe('desktop-get-sources', opts);
    if (!res || !res.success) {
      const e = new Error(res && res.error ? res.error : 'failed to get sources from main');
      console.error('electronAPI.getSources error in preload (from main):', e);
      throw e;
    }
    return res.sources;
  },

  /* ---------- Save / recordings helpers ---------- */
  // Accepts: (buffer, filename) OR ({ buffer, filename }) depending on renderer callsite
  saveVideo: (bufferOrObj, maybeFilename) => {
    if (bufferOrObj && typeof bufferOrObj === 'object' && bufferOrObj.buffer && bufferOrObj.filename) {
      return invokeSafe('save-video', bufferOrObj);
    }
    return invokeSafe('save-video', { buffer: bufferOrObj, filename: maybeFilename });
  },

  listRecordings: () => invokeSafe('list-recordings'),
  openRecordingsFolder: () => invokeSafe('open-recordings-folder'),
  revealRecording: (fullPath) => invokeSafe('reveal-recording', fullPath),

  /* ---------- Usage limits API (guest/user/subscribed) ---------- */
  getUsageInfo: () => invokeSafe('get-usage-info'),
  incrementRecording: () => invokeSafe('increment-recording-count'),
  resetUsage: () => invokeSafe('reset-usage'),
  setLoginState: (payload = { isLoggedIn: false }) => invokeSafe('set-login-state', payload),
  setSubscribed: (payload = { isSubscribed: false }) => invokeSafe('set-subscribed', payload),

  /* ---------- General helpers (keep for compatibility) ---------- */
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  on: (channel, cb) => {
    // wrap to avoid leaking Node event objects into renderer
    const wrapped = (event, ...args) => cb(...args);
    const off = () => ipcRenderer.removeListener(channel, wrapped);
    ipcRenderer.on(channel, wrapped);
    return off;
  }
});
