'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// InnovatIA Analytics Builder — Electron main process
//
// The main process owns everything that must not live in the renderer:
//   * persistence of audit events, saved dashboards, OAC release records and
//     connection settings (stored under the per-user app-data directory),
//   * window lifecycle and secure webPreferences defaults.
//
// Connection secrets are deliberately NOT persisted here: the settings store
// keeps endpoints and usernames only. Passwords/wallets belong in OCI Vault
// or the enterprise vault, per blueprint §12.3.
// ---------------------------------------------------------------------------

const STORE_FILES = {
  audit: 'audit-log.json',
  dashboards: 'dashboards.json',
  releases: 'oac-releases.json',
  settings: 'settings.json'
};

function storePath(name) {
  return path.join(app.getPath('userData'), STORE_FILES[name]);
}

function readStore(name, fallback) {
  try {
    const raw = fs.readFileSync(storePath(name), 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeStore(name, value) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(storePath(name), JSON.stringify(value, null, 2), 'utf8');
}

const MAX_AUDIT_EVENTS = 5000;

function registerIpc() {
  ipcMain.handle('store:appendAudit', (_evt, event) => {
    const log = readStore('audit', []);
    log.push({ ...event, id: log.length + 1, recordedAt: new Date().toISOString() });
    // Retain a bounded window locally; enterprise deployments forward to the
    // gateway audit schema (AI_* objects) which is the system of record.
    writeStore('audit', log.slice(-MAX_AUDIT_EVENTS));
    return { ok: true };
  });

  ipcMain.handle('store:getAudit', () => readStore('audit', []));

  ipcMain.handle('store:getDashboards', () => readStore('dashboards', []));
  ipcMain.handle('store:saveDashboards', (_evt, dashboards) => {
    writeStore('dashboards', dashboards);
    return { ok: true };
  });

  ipcMain.handle('store:getReleases', () => readStore('releases', []));
  ipcMain.handle('store:saveReleases', (_evt, releases) => {
    writeStore('releases', releases);
    return { ok: true };
  });

  ipcMain.handle('store:getSettings', () => readStore('settings', null));
  ipcMain.handle('store:saveSettings', (_evt, settings) => {
    // Never persist secrets, even if a renderer bug passes them through.
    const { password, walletPassword, clientSecret, ...safe } = settings || {};
    writeStore('settings', safe);
    return { ok: true };
  });

  ipcMain.handle('app:exportFile', async (_evt, { suggestedName, content }) => {
    const win = BrowserWindow.getFocusedWindow();
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: suggestedName
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    fs.writeFileSync(filePath, content, 'utf8');
    return { ok: true, filePath };
  });

  ipcMain.handle('app:version', () => app.getVersion());

  ipcMain.handle('app:pickFile', async (_evt, { title, filters }) => {
    const win = BrowserWindow.getFocusedWindow();
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: title || 'Select file',
      properties: ['openFile'],
      filters: filters || [{ name: 'All files', extensions: ['*'] }]
    });
    if (canceled || !filePaths.length) return { ok: false, canceled: true };
    return { ok: true, filePath: filePaths[0] };
  });

  // Connection tests run in the main process (the renderer's CSP blocks
  // outbound requests by design). Reachability/auth handshake only —
  // credentials are sent as request headers and never logged or persisted.
  ipcMain.handle('conn:httpTest', async (_evt, { url, method = 'GET', headers = {}, timeoutMs = 8000 }) => {
    const started = Date.now();
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') {
        return { ok: false, error: 'Only HTTPS endpoints are permitted (§12.3).' };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(url, { method, headers, signal: controller.signal, redirect: 'manual' });
      clearTimeout(timer);
      return { ok: res.status < 400, status: res.status, latencyMs: Date.now() - started };
    } catch (e) {
      return { ok: false, error: e.name === 'AbortError' ? `Timed out after ${timeoutMs} ms` : e.message, latencyMs: Date.now() - started };
    }
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0d0d0d',
    title: 'InnovatIA Analytics Builder',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // External links (Oracle docs etc.) open in the system browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
