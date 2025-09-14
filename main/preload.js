// main/preload.js
const { contextBridge, ipcRenderer } = require('electron');

console.log('PRELOAD starting — process.type=', process?.type);

contextBridge.exposeInMainWorld('electronAPI', {
  getSources: async (opts) => {
    const res = await ipcRenderer.invoke('desktop-get-sources', opts);
    if (!res || !res.success) {
      const e = new Error(res && res.error ? res.error : 'failed to get sources from main');
      console.error('electronAPI.getSources error in preload (from main):', e);
      throw e;
    }
    return res.sources;
  },

  saveVideo: (buffer, filename) => ipcRenderer.invoke('save-video', { buffer, filename }),

  listRecordings: () => ipcRenderer.invoke('list-recordings'),
  openRecordingsFolder: () => ipcRenderer.invoke('open-recordings-folder'),
  revealRecording: (fullPath) => ipcRenderer.invoke('reveal-recording', fullPath),

  // OTP related
  sendOtp: (email) => ipcRenderer.invoke('send-otp', { email }),
  verifyOtp: (email, code) => ipcRenderer.invoke('verify-otp', { email, code }),

  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  on: (channel, cb) => ipcRenderer.on(channel, cb)
});
