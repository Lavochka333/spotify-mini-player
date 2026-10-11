const { app, BrowserWindow, desktopCapturer, ipcMain, globalShortcut, screen, dialog } = require('electron');
const { pathToFileURL } = require('url');
const fs = require('fs');
const path = require('path');
const { onSessionsChanged, getAllSessions, shutdown } = require('windows-media-sessions');
const { execFile } = require('child_process');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const statePath = path.join(app.getPath('userData'), 'window-state.json');
const settingsPath = path.join(app.getPath('userData'), 'settings.json');
const settingsBackupPath = `${settingsPath}.bak`;
let win;
let settingsWin;
let stopMediaWatch;
let lastTrackKey = '';
const coverCache = new Map();
const singleInstanceLock = app.requestSingleInstanceLock();

if (!singleInstanceLock) {
  app.quit();
}

function readState() {
  try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return {}; }
}

function readJsonFile(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

let storedSettings = readJsonFile(settingsPath) || readJsonFile(settingsBackupPath) || {};

function readSettings() {
  return storedSettings;
}

function writeSettings(nextSettings) {
  const tempPath = `${settingsPath}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(tempPath, JSON.stringify(nextSettings, null, 2), 'utf8');
  if (fs.existsSync(settingsPath)) fs.copyFileSync(settingsPath, settingsBackupPath);
  fs.renameSync(tempPath, settingsPath);
  storedSettings = nextSettings;
}

function asciiImageUrl() {
  const imagePath = readSettings().asciiImage;
  return imagePath && fs.existsSync(imagePath) ? pathToFileURL(imagePath).href : '';
}

const defaultAsciiSettings = { width: 76, height: 43, symbols: 12, frames: 16, speed: 4, rotation: 24, opacity: 100, originX: 50, originY: 50, full360: false, lockAspect: false, hidden: false, displayMode: 'ascii', x: 276, y: 3 };

function asciiSettings() {
  return { ...defaultAsciiSettings, ...(readSettings().ascii || {}) };
}

function broadcastAsciiImage() {
  const url = asciiImageUrl();
  if (win && !win.isDestroyed()) win.webContents.send('ascii-image', url);
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('ascii-image', url);
  return url;
}

function broadcastAsciiSettings() {
  const value = asciiSettings();
  if (win && !win.isDestroyed()) win.webContents.send('ascii-settings', value);
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('ascii-settings', value);
  return value;
}

function saveState() {
  if (!win || win.isDestroyed()) return;
  const { x, y } = win.getBounds();
  fs.writeFileSync(statePath, JSON.stringify({ x, y }));
}

function createWindow() {
  const saved = readState();
  const area = screen.getPrimaryDisplay().workArea;
  win = new BrowserWindow({
    width: 380,
    height: 124,
    x: Number.isFinite(saved.x) ? saved.x : area.x + area.width - 404,
    y: Number.isFinite(saved.y) ? saved.y : area.y + area.height - 148,
    transparent: true,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  });

  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile('index.html');
  win.webContents.on('console-message', (_event, level, message) => {
    console.log(`[renderer:${level}] ${message}`);
  });
  win.on('moved', saveState);
  win.webContents.once('did-finish-load', () => {
    startMediaWatch();
    broadcastAsciiImage();
    broadcastAsciiSettings();
  });
}

function settingsBounds() {
  const anchor = win.getBounds();
  const area = screen.getDisplayMatching(anchor).workArea;
  const margin = 12;
  const gap = 16;
  const width = Math.min(700, area.width - margin * 2);
  const height = Math.min(640, area.height - margin * 2);
  const clampX = x => Math.max(area.x + margin, Math.min(x, area.x + area.width - margin - width));
  const clampY = y => Math.max(area.y + margin, Math.min(y, area.y + area.height - margin - height));
  const candidates = [
    { x: anchor.x - width - gap, y: anchor.y + anchor.height - height },
    { x: anchor.x + anchor.width + gap, y: anchor.y },
    { x: anchor.x + anchor.width - width, y: anchor.y - height - gap },
    { x: anchor.x, y: anchor.y + anchor.height + gap }
  ].map(p => ({ x: clampX(p.x), y: clampY(p.y), width, height }));
  // Prefer a position that leaves the widget accessible for editing the animation.
  const overlap = p => Math.max(0, Math.min(p.x + width, anchor.x + anchor.width) - Math.max(p.x, anchor.x)) *
    Math.max(0, Math.min(p.y + height, anchor.y + anchor.height) - Math.max(p.y, anchor.y));
  return candidates.reduce((best, p) => overlap(p) < overlap(best) ? p : best);
}

function showSettings() {
  settingsWin.setBounds(settingsBounds());
  settingsWin.setAlwaysOnTop(true, 'floating');
  settingsWin.show();
  settingsWin.moveTop();
  settingsWin.focus();
  win?.webContents.send('ascii-edit-mode', true);
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    showSettings();
    return;
  }
  settingsWin = new BrowserWindow({
    ...settingsBounds(),
    parent: win,
    modal: false,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  });
  settingsWin.loadFile('settings.html');
  settingsWin.webContents.once('did-finish-load', () => { broadcastAsciiImage(); broadcastAsciiSettings(); });
  settingsWin.once('ready-to-show', () => {
    if (settingsWin && !settingsWin.isDestroyed()) showSettings();
  });
  settingsWin.on('closed', () => {
    settingsWin = null;
    win?.webContents.send('ascii-edit-mode', false);
  });
}

function spotifySession(sessions) {
  const spotify = sessions.filter(s => /spotify/i.test(s.sourceAppUserModelId || s.id || ''));
  return spotify.find(s => s.playbackStatus === 'playing') || spotify[0] || null;
}

async function findCover(title, artist) {
  const key = `${title}\u0000${artist}`.toLowerCase();
  if (coverCache.has(key)) return coverCache.get(key);
  try {
    const query = new URLSearchParams({ term: `${artist} ${title}`, entity: 'song', limit: '1' });
    const response = await fetch(`https://itunes.apple.com/search?${query}`);
    const json = await response.json();
    const url = json.results?.[0]?.artworkUrl100?.replace('100x100bb', '300x300bb') || '';
    coverCache.set(key, url);
    return url;
  } catch {
    return '';
  }
}

async function publishMedia(sessions) {
  const session = spotifySession(sessions);
  if (!session?.title) {
    lastTrackKey = '';
    win?.webContents.send('track-update', null);
    return;
  }
  const key = `${session.title}\u0000${session.artist || ''}\u0000${session.playbackStatus}`;
  if (key === lastTrackKey) return;
  lastTrackKey = key;
  const cover = session.thumbnail || await findCover(session.title, session.artist || '');
  win?.webContents.send('track-update', {
    title: session.title,
    artist: session.artist || session.albumTitle || '',
    cover,
    playing: session.playbackStatus === 'playing'
  });
}

async function startMediaWatch() {
  try {
    await publishMedia(await getAllSessions());
    stopMediaWatch = onSessionsChanged(publishMedia);
  } catch (error) {
    console.error('Media session error:', error);
  }
}

app.whenReady().then(() => {
  if (!singleInstanceLock) return;
  // Chromium получает звук с устройства вывода Windows через loopback.
  sessionHandler();
  createWindow();
  globalShortcut.register('CommandOrControl+Shift+M', () => win?.webContents.send('toggle-compact'));
  globalShortcut.register('CommandOrControl+Shift+H', () => win?.isVisible() ? win.hide() : win.show());
});

app.on('second-instance', () => {
  if (!win || win.isDestroyed()) return;
  if (!win.isVisible()) win.show();
  win.focus();
});

function sessionHandler() {
  const { session } = require('electron');
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    callback({ video: sources[0], audio: 'loopback' });
  });
}

ipcMain.on('close-widget', () => {
  if (win && !win.isDestroyed()) win.close();
  app.quit();
});
ipcMain.on('minimize-widget', () => win?.webContents.send('toggle-compact'));
ipcMain.on('open-settings', openSettings);
ipcMain.on('close-settings', () => settingsWin?.close());
ipcMain.handle('get-ascii-image', () => asciiImageUrl());
ipcMain.handle('choose-ascii-image', async () => {
  const result = await dialog.showOpenDialog(settingsWin || win, {
    title: 'Выберите изображение для ASCII-анимации',
    properties: ['openFile'],
    filters: [
      { name: 'Изображения', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }
    ]
  });
  if (result.canceled || !result.filePaths[0]) return asciiImageUrl();
  writeSettings({ ...readSettings(), asciiImage: result.filePaths[0] });
  return broadcastAsciiImage();
});
ipcMain.handle('clear-ascii-image', () => {
  const current = readSettings();
  delete current.asciiImage;
  writeSettings(current);
  return broadcastAsciiImage();
});
ipcMain.handle('get-ascii-settings', () => asciiSettings());
ipcMain.handle('update-ascii-settings', (_event, patch) => {
  const current = readSettings();
  const next = { ...asciiSettings(), ...patch };
  next.width = Math.max(40, Math.min(120, Number(next.width) || 76));
  next.height = Math.max(24, Math.min(76, Number(next.height) || 43));
  next.symbols = Math.max(6, Math.min(28, Math.round(Number(next.symbols) || 12)));
  next.frames = Math.max(4, Math.min(60, Math.round(Number(next.frames) || 16)));
  next.speed = Math.max(1, Math.min(12, Number(next.speed) || 4));
  next.rotation = Math.max(5, Math.min(80, Number(next.rotation) || 24));
  next.opacity = Math.max(5, Math.min(100, Math.round(Number(next.opacity) || 100)));
  next.originX = Math.max(0, Math.min(100, Number.isFinite(Number(next.originX)) ? Number(next.originX) : 50));
  next.originY = Math.max(0, Math.min(100, Number.isFinite(Number(next.originY)) ? Number(next.originY) : 50));
  next.lockAspect = Boolean(next.lockAspect);
  next.hidden = Boolean(next.hidden);
  next.x = Math.max(0, Math.min(284, Number.isFinite(Number(next.x)) ? Number(next.x) : 276));
  next.y = Math.max(0, Math.min(61, Number.isFinite(Number(next.y)) ? Number(next.y) : 3));
  next.full360 = Boolean(next.full360);
  next.displayMode = ['ascii', 'colorAscii', 'image'].includes(next.displayMode) ? next.displayMode : 'ascii';
  writeSettings({ ...current, ascii: next });
  return broadcastAsciiSettings();
});
function normalizeWidgetSettings(value) {
  const sensitivity = value?.bassSensitivity;
  return { bassSensitivity: typeof sensitivity === 'number' && Number.isFinite(sensitivity)
    ? Math.round(Math.max(0, Math.min(100, sensitivity))) : 50,
    bassMethod: typeof value?.bassMethod === 'boolean' ? value.bassMethod : true,
    spectralMethod: typeof value?.spectralMethod === 'boolean' ? value.spectralMethod : true,
    rhythmMethod: typeof value?.rhythmMethod === 'boolean' ? value.rhythmMethod : true,
    beatDetector: ['aubiojs', 'bass'].includes(value?.beatDetector) ? value.beatDetector : 'aubiojs',
    coverWiggle: typeof value?.coverWiggle === 'boolean' ? value.coverWiggle : false };
}
function widgetSettings() {
  return normalizeWidgetSettings(readSettings().widget);
}
ipcMain.handle('get-widget-settings', () => widgetSettings());
ipcMain.handle('update-widget-settings', (_event, patch) => {
  const current = readSettings();
  const merged = { ...widgetSettings() };
  for (const key of ['bassSensitivity', 'bassMethod', 'spectralMethod', 'rhythmMethod', 'beatDetector', 'coverWiggle']) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, key)) merged[key] = patch[key];
  }
  const next = normalizeWidgetSettings(merged);
  writeSettings({ ...current, widget: { ...current.widget, ...next } });
  for (const target of [win, settingsWin]) if (target && !target.isDestroyed()) target.webContents.send('widget-settings', next);
  return next;
});
function visualizerSettings() {
  const type = readSettings().visualizer?.type;
  return { type: ['bars', 'mirror', 'wave', 'dots'].includes(type) ? type : 'bars' };
}
ipcMain.handle('get-visualizer-settings', () => visualizerSettings());
ipcMain.handle('update-visualizer-settings', (_event, patch) => {
  const type = patch?.type;
  if (!['bars', 'mirror', 'wave', 'dots'].includes(type)) return visualizerSettings();
  writeSettings({ ...readSettings(), visualizer: { type } });
  for (const target of [win, settingsWin]) if (target && !target.isDestroyed()) target.webContents.send('visualizer-settings', { type });
  return { type };
});

ipcMain.on('media-control', (_event, action) => {
  if (!['previous', 'playpause', 'next'].includes(action)) return;
  execFile('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(__dirname, 'media-control.ps1'), action
  ], { windowsHide: true }, error => {
    if (error) console.error('Media control error:', error.message);
  });
});
ipcMain.handle('audio-output', (_event, action) => new Promise((resolve, reject) => {
  if (!['get', 'toggle'].includes(action)) return reject(new Error('Unknown audio output action'));
  execFile('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(__dirname, 'audio-output.ps1'), action
  ], { windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
    if (error) return reject(error);
    try { resolve(JSON.parse(stdout.trim())); } catch (parseError) { reject(parseError); }
  });
}));

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopMediaWatch?.();
  shutdown().catch(() => {});
});
