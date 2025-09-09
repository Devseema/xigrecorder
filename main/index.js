// xigrecorder/main/index.js
const { app, BrowserWindow, ipcMain, desktopCapturer, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');

/* ---------------------------
   Persistent usage limits
   --------------------------- */
// const store = new Store({
//   name: 'xigrecorder-store',
//   defaults: {
//     freeCount: 0,       // guest recordings used (max 5)
//     userCount: 0,       // logged-in recordings used (max 10 unless subscribed)
//     isLoggedIn: false,  // toggle via login flow later
//     isSubscribed: false // toggle via payment later
//   }
// });
// --- robust store setup (supports electron-store or a JSON fallback) ---
let store = null;
try {
  // attempt to require electron-store
  const StorePkg = require('electron-store');
  // handle both commonjs function export and possible default interop
  const StoreCtor = (typeof StorePkg === 'function') ? StorePkg : (StorePkg && StorePkg.default) ? StorePkg.default : null;
  if (StoreCtor) {
    store = new StoreCtor({
      name: 'xigrecorder-store',
      defaults: {
        freeCount: 0,
        userCount: 0,
        isLoggedIn: false,
        isSubscribed: false
      }
    });
    console.log('Using electron-store for persistent settings.');
  } else {
    console.warn('electron-store present but not constructor; falling back to JSON store.');
  }
} catch (err) {
  console.warn('electron-store not available or failed to load; falling back to JSON store:', err && err.message);
}

// If electron-store not available or failed, use a minimal JSON-file store
if (!store) {
  // file in userData so it is per-user and writable
  const storeFile = path.join(app.getPath('userData') || app.getPath('home'), 'xigrecorder-store.json');
  let data = { freeCount: 0, userCount: 0, isLoggedIn: false, isSubscribed: false };

  try {
    if (fs.existsSync(storeFile)) {
      const txt = fs.readFileSync(storeFile, 'utf8');
      if (txt) data = Object.assign(data, JSON.parse(txt));
    } else {
      // write initial file
      try { fs.writeFileSync(storeFile, JSON.stringify(data, null, 2), 'utf8'); } catch(_) {}
    }
  } catch (e) {
    console.warn('Could not read/write fallback store file:', e && e.message);
  }

  // mimic the electron-store API surface used by the app:
  store = {
    get: (k, def) => (typeof k === 'undefined' ? data : (k in data ? data[k] : def)),
    set: (k, v) => {
      try {
        data[k] = v;
        fs.writeFileSync(storeFile, JSON.stringify(data, null, 2), 'utf8');
      } catch (e) {
        console.warn('Failed to write fallback store file:', e && e.message);
      }
      return data;
    },
    // convenience to inspect the whole store
    store: data
  };

  console.log('Using fallback JSON store at', storeFile);
}


function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false,
      enableRemoteModule: false
    }
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL || process.env.VITE_DEV_SERVER_URL;
  console.log('createWindow devUrl:', devUrl);

  if (devUrl) {
    win.loadURL(devUrl)
      .then(() => console.log('Loaded dev URL:', devUrl))
      .catch(err => {
        console.error('Failed to load dev URL:', err);
        const filePath = path.join(__dirname, '../renderer/dist/index.html');
        win.loadFile(filePath).catch(e => console.error('Fallback loadFile failed:', e));
      });
    // open DevTools for debugging during development
    win.webContents.openDevTools({ mode: 'right' });
  } else {
    const filePath = path.join(__dirname, '../renderer/dist/index.html');
    win.loadFile(filePath).catch(err => console.error('loadFile error:', err));
  }
}

app.whenReady().then(createWindow);

/* ---------------------------
   Robust save-video handler
   (unchanged behavior)
   --------------------------- */
ipcMain.handle('save-video', async (event, { buffer, filename }) => {
  try {
    if (!filename || typeof filename !== 'string') throw new Error('Invalid filename');

    const videosPath = app.getPath('videos') || app.getPath('home');
    await fs.promises.mkdir(videosPath, { recursive: true });
    const filePath = path.join(videosPath, filename);
    console.log('save-video ->', filePath);

    let dataBuffer;

    if (Buffer.isBuffer(buffer)) {
      dataBuffer = buffer;
    } else if (buffer instanceof ArrayBuffer) {
      dataBuffer = Buffer.from(new Uint8Array(buffer));
    } else if (ArrayBuffer.isView(buffer)) {
      dataBuffer = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    } else if (buffer && typeof buffer === 'object' && (Array.isArray(buffer.data) || buffer.data instanceof ArrayBuffer || ArrayBuffer.isView(buffer.data))) {
      if (Array.isArray(buffer.data)) dataBuffer = Buffer.from(buffer.data);
      else if (buffer.data instanceof ArrayBuffer) dataBuffer = Buffer.from(new Uint8Array(buffer.data));
      else if (ArrayBuffer.isView(buffer.data)) {
        const v = buffer.data;
        dataBuffer = Buffer.from(v.buffer, v.byteOffset, v.byteLength);
      } else dataBuffer = Buffer.from(String(buffer.data));
    } else if (typeof buffer === 'string') {
      if (buffer.startsWith('data:')) {
        const comma = buffer.indexOf(',');
        const base64 = buffer.slice(comma + 1);
        dataBuffer = Buffer.from(base64, 'base64');
      } else {
        try { dataBuffer = Buffer.from(buffer, 'base64'); }
        catch { dataBuffer = Buffer.from(buffer); }
      }
    } else {
      try {
        const maybeArr = buffer && buffer.data ? buffer.data : buffer;
        dataBuffer = Buffer.from(new Uint8Array(maybeArr));
      } catch (err) {
        console.warn('save-video: fallback stringify', err);
        dataBuffer = Buffer.from(JSON.stringify(buffer || ''));
      }
    }

    await fs.promises.writeFile(filePath, dataBuffer);
    console.log('Saved', filePath, 'size=', dataBuffer.length);
    return { success: true, path: filePath, size: dataBuffer.length };
  } catch (err) {
    console.error('save-video error:', err);
    return { success: false, error: (err && err.message) || String(err) };
  }
});

/* ---------------------------
   Desktop sources
   --------------------------- */
ipcMain.handle('desktop-get-sources', async (event, opts = { types: ['screen', 'window'] }) => {
  try {
    const sources = await desktopCapturer.getSources(opts);
    const mapped = sources.map(s => ({
      id: s.id,
      name: s.name,
      thumbnail: s.thumbnail ? s.thumbnail.toDataURL() : null
    }));
    return { success: true, sources: mapped };
  } catch (err) {
    console.error('desktop-get-sources error', err);
    return { success: false, error: err.message || String(err) };
  }
});

/* ---------------------------
   Recordings helpers
   --------------------------- */
ipcMain.handle('list-recordings', async () => {
  try {
    const videosPath = app.getPath('videos');
    const files = await fs.promises.readdir(videosPath);
    const webmFiles = [];
    for (const f of files) {
      if (!f.toLowerCase().endsWith('.webm')) continue;
      const full = path.join(videosPath, f);
      try {
        const stat = await fs.promises.stat(full);
        webmFiles.push({ name: f, path: full, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch (e) {}
    }
    webmFiles.sort((a,b)=>b.mtimeMs-a.mtimeMs);
    return { success: true, files: webmFiles, folder: videosPath };
  } catch (err) {
    console.error('list-recordings error', err);
    return { success: false, error: err.message || String(err) };
  }
});

ipcMain.handle('open-recordings-folder', async () => {
  try {
    const videosPath = app.getPath('videos');
    const res = await shell.openPath(videosPath);
    if (res) throw new Error(res);
    return { success: true, folder: videosPath };
  } catch (err) {
    console.error('open-recordings-folder error', err);
    return { success: false, error: err.message || String(err) };
  }
});

ipcMain.handle('reveal-recording', async (event, fullPath) => {
  try {
    shell.showItemInFolder(fullPath);
    return { success: true };
  } catch (err) {
    console.error('reveal-recording error', err);
    return { success: false, error: err.message || String(err) };
  }
});

/* ---------------------------
   USAGE LIMITS API
   --------------------------- */
// Get current usage info
ipcMain.handle('get-usage-info', async () => ({
  freeCount: store.get('freeCount', 0),
  userCount: store.get('userCount', 0),
  isLoggedIn: store.get('isLoggedIn', false),
  isSubscribed: store.get('isSubscribed', false)
}));

// Called AFTER a successful recording is saved
ipcMain.handle('increment-recording-count', async () => {
  if (!store.get('isLoggedIn')) {
    const next = (store.get('freeCount', 0) || 0) + 1;
    store.set('freeCount', next);
    return { mode: 'guest', count: next, max: 5 };
  } else {
    const next = (store.get('userCount', 0) || 0) + 1;
    store.set('userCount', next);
    const max = store.get('isSubscribed') ? Infinity : 10;
    return { mode: 'user', count: next, max };
  }
});

// Dev/test helpers (optional)
ipcMain.handle('reset-usage', async () => {
  store.set('freeCount', 0);
  store.set('userCount', 0);
  return true;
});
ipcMain.handle('set-login-state', async (e, { isLoggedIn = false } = {}) => {
  store.set('isLoggedIn', !!isLoggedIn);
  return store.store;
});
ipcMain.handle('set-subscribed', async (e, { isSubscribed = false } = {}) => {
  store.set('isSubscribed', !!isSubscribed);
  return store.store;
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
