// main/index.js
require('dotenv').config(); // load .env in main process
const { app, BrowserWindow, ipcMain, desktopCapturer, shell } = require('electron');
const path = require('path');
const fs = require('fs');

console.log('MAIN starting, env BREVO_FROM_EMAIL present?', !!process.env.BREVO_FROM_EMAIL);

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

/* ===========================
   File save / desktop capture
   =========================== */

// Robust save-video handler (accepts ArrayBuffer / TypedArray / Buffer / base64 / structured clone)
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

// Provide desktop sources via main (desktopCapturer available here)
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

// Recordings helpers (list, open folder, reveal file)
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

/* ===================================
   OTP sending / verification (Brevo)
   =================================== */

// configuration from env
const BREVO_API_KEY = process.env.BREVO_API_KEY || process.env.APIKEY || process.env.BREVO_KEY;
const BREVO_FROM_EMAIL = process.env.BREVO_FROM_EMAIL || process.env.BREVO_FROM || 'no-reply@example.com';
const BREVO_FROM_NAME = process.env.BREVO_FROM_NAME || 'XigRecorder';
const OTP_TTL = Number(process.env.OTP_TTL_SECONDS || 300); // seconds

if (!BREVO_API_KEY) {
  console.warn('BREVO_API_KEY not found in env. OTP emailing will fail until set.');
}

// in-memory OTP map: email -> { code, expiresAt }
const OTP_STORE = new Map();

// helper to generate 6-digit OTP
function genOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// helper to send via Brevo using fetch (node v18+ has global fetch, else try node-fetch)
async function sendBrevoEmail({ toEmail, subject, htmlContent, textContent }) {
  if (!BREVO_API_KEY) throw new Error('No BREVO API key configured (BREVO_API_KEY)');

  // try global fetch, else require node-fetch
  let _fetch = global.fetch;
  if (typeof _fetch !== 'function') {
    try {
      _fetch = require('node-fetch');
    } catch (e) {
      throw new Error('fetch not available and node-fetch not installed');
    }
  }

  const url = 'https://api.brevo.com/v3/smtp/email';
  const body = {
    sender: { name: BREVO_FROM_NAME, email: BREVO_FROM_EMAIL },
    to: [{ email: toEmail }],
    subject: subject,
    htmlContent: htmlContent,
    textContent: textContent
  };

  const res = await _fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': BREVO_API_KEY
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Brevo API error ${res.status}: ${text}`);
  }
  const json = await res.json();
  return json;
}

ipcMain.handle('send-otp', async (event, { email }) => {
  try {
    if (!email || typeof email !== 'string') throw new Error('Invalid email');

    const code = genOtp();
    const expiresAt = Date.now() + OTP_TTL * 1000;
    OTP_STORE.set(email, { code, expiresAt });

    const subject = 'Your XigRecorder OTP';
    const htmlContent = `<p>Hello —</p><p>Your XigRecorder OTP is <strong>${code}</strong>. It expires in ${Math.floor(OTP_TTL/60)} minutes.</p><p>If you didn't request this, ignore this email.</p>`;
    const textContent = `Your XigRecorder OTP is ${code}. Expires in ${Math.floor(OTP_TTL/60)} minutes.`;

    // send email
    await sendBrevoEmail({ toEmail: email, subject, htmlContent, textContent });
    console.log('OTP sent to', email, 'code:', code);

    return { success: true, message: 'OTP sent' };
  } catch (err) {
    console.error('send-otp error', err);
    return { success: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('verify-otp', async (event, { email, code }) => {
  try {
    if (!email || !code) throw new Error('email and code required');
    const rec = OTP_STORE.get(email);
    if (!rec) return { success: false, error: 'No OTP requested for this email' };
    if (Date.now() > rec.expiresAt) {
      OTP_STORE.delete(email);
      return { success: false, error: 'OTP expired' };
    }
    if (String(rec.code) !== String(code).trim()) {
      return { success: false, error: 'Invalid OTP' };
    }
    // valid -> remove OTP (one-time)
    OTP_STORE.delete(email);
    // return success (you may want to create a real user/session here)
    return { success: true, message: 'OTP verified' };
  } catch (err) {
    console.error('verify-otp error', err);
    return { success: false, error: (err && err.message) || String(err) };
  }
});

/* ===== app event handlers ===== */
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
