'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  screen,
  powerMonitor,
  Menu,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

// ------------------------------------------------------------
//  Liquid Glass Music
//  Desktop music widget. On Windows the current track comes from
//  the system media session (SMTC) — Yandex Music desktop or its
//  web player in a browser both work, without tokens.
// ------------------------------------------------------------

const APP_ID = 'ru.liquidglass.music';
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
const IS_DEV = process.argv.includes('--dev');
const IS_SMOKE = process.argv.includes('--smoke');

// The window is slightly larger than the glass panel: the transparent
// margin holds the drop shadow, so it never gets clipped by the OS.
const WINDOW_WIDTH = 424;
const WINDOW_HEIGHT = 624;

// Floating island overlay: independent always-on-top window.
const ISLAND_WIDTH = 400;
const ISLAND_HEIGHT = 200;

const DEFAULT_SETTINGS = {
  mode: 'auto', // auto | yandex | demo
  theme: 'dark', // dark | light
  alwaysOnTop: false,
  bounds: null,
};

const APP_LABELS = [
  [/yandex/i, 'Яндекс Музыка'],
  [/spotify/i, 'Spotify'],
  [/msedge/i, 'Microsoft Edge'],
  [/chrome/i, 'Google Chrome'],
  [/firefox/i, 'Firefox'],
  [/opera/i, 'Opera'],
  [/vivaldi/i, 'Vivaldi'],
  [/vlc/i, 'VLC'],
  [/aimp/i, 'AIMP'],
  [/foobar/i, 'foobar2000'],
  [/musicbee/i, 'MusicBee'],
];

let mainWindow = null;
let islandWindow = null;
let settings = { ...DEFAULT_SETTINGS };
let provider = null;
let quitting = false;
let moveSaveTimer = null;

app.setAppUserModelId(APP_ID);

// ------------------------------------------------------------
//  File log (the launcher detaches Electron, so stdout is gone)
// ------------------------------------------------------------
function installFileLogging() {
  const dir = path.join(os.tmpdir(), 'liquid-glass-music');
  const file = path.join(dir, 'app.log');

  try {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) {
      fs.writeFileSync(file, '');
    }
  } catch {
    return;
  }

  for (const level of ['log', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      try {
        const text = args
          .map((value) => {
            if (typeof value === 'string') return value;
            if (value instanceof Error) return value.stack || value.message;
            try {
              return JSON.stringify(value);
            } catch {
              return String(value);
            }
          })
          .join(' ');
        fs.appendFileSync(
          file,
          `[${new Date().toISOString()}] [${level}] ${text}\n`,
          'utf8'
        );
      } catch { }
    };
  }
}

installFileLogging();

// ------------------------------------------------------------
//  Single instance
// ------------------------------------------------------------
const hasLock = app.requestSingleInstanceLock();

if (!hasLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(init);
}

// ------------------------------------------------------------
//  Settings on disk
// ------------------------------------------------------------
function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsFile(), 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    settings = { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }

  if (!['auto', 'yandex', 'demo'].includes(settings.mode)) settings.mode = 'auto';
  if (!['dark', 'light'].includes(settings.theme)) settings.theme = 'dark';
  settings.alwaysOnTop = Boolean(settings.alwaysOnTop);
  if (!settings.bounds || typeof settings.bounds.x !== 'number') settings.bounds = null;
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    const tmp = settingsFile() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
    fs.renameSync(tmp, settingsFile());
  } catch (error) {
    console.error('[settings] save failed:', error.message);
  }
}

// ------------------------------------------------------------
//  Window
// ------------------------------------------------------------
function restoreBounds() {
  const bounds = settings.bounds;
  if (!bounds) return null;

  const visible = screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return (
      bounds.x < area.x + area.width - 80 &&
      bounds.x + WINDOW_WIDTH > area.x + 80 &&
      bounds.y < area.y + area.height - 80 &&
      bounds.y + WINDOW_HEIGHT > area.y + 80
    );
  });

  return visible ? { x: bounds.x, y: bounds.y } : null;
}

function createWindow() {
  const saved = restoreBounds();

  const windowOptions = {
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: WINDOW_WIDTH,
    minHeight: WINDOW_HEIGHT,
    maxWidth: WINDOW_WIDTH,
    maxHeight: WINDOW_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    title: 'Liquid Glass Music',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  };

  if (saved) {
    windowOptions.x = saved.x;
    windowOptions.y = saved.y;
  }

  // Real hardware blur behind the window on macOS.
  if (IS_MAC) {
    windowOptions.vibrancy = 'under-window';
    windowOptions.visualEffectState = 'active';
  }

  mainWindow = new BrowserWindow(windowOptions);

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.setAlwaysOnTop(settings.alwaysOnTop, 'floating');
    mainWindow.show();
    if (IS_DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });
    if (IS_SMOKE) runSmokeTest();
  });

  // Never navigate the widget away from its own page.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('moved', () => {
    clearTimeout(moveSaveTimer);
    moveSaveTimer = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const [x, y] = mainWindow.getPosition();
      settings.bounds = { x, y };
      saveSettings();
      positionIslandWindow();
    }, 500);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (islandWindow && !islandWindow.isDestroyed()) islandWindow.close();
  });
}

function positionIslandWindow() {
  if (!islandWindow || islandWindow.isDestroyed()) return;

  const display =
    mainWindow && !mainWindow.isDestroyed()
      ? screen.getDisplayMatching(mainWindow.getBounds())
      : screen.getPrimaryDisplay();
  const area = display.workArea;

  islandWindow.setBounds(
    {
      x: Math.round(area.x + (area.width - ISLAND_WIDTH) / 2),
      y: Math.round(area.y + 8),
      width: ISLAND_WIDTH,
      height: ISLAND_HEIGHT,
    },
    false
  );
}

function createIslandWindow() {
  if (islandWindow && !islandWindow.isDestroyed()) return;

  islandWindow = new BrowserWindow({
    width: ISLAND_WIDTH,
    height: ISLAND_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    title: 'Liquid Glass Island',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  // Above normal windows and above fullscreen games where the OS allows it.
  islandWindow.setAlwaysOnTop(true, 'screen-saver');
  islandWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  islandWindow.setIgnoreMouseEvents(false);

  islandWindow.loadFile(path.join(__dirname, 'src', 'island.html'));

  islandWindow.once('ready-to-show', () => {
    if (!islandWindow || islandWindow.isDestroyed()) return;
    positionIslandWindow();
    islandWindow.setAlwaysOnTop(true, 'screen-saver');
    islandWindow.showInactive();
  });

  islandWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== islandWindow.webContents.getURL()) event.preventDefault();
  });

  islandWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  islandWindow.on('closed', () => {
    islandWindow = null;
  });
}

// ------------------------------------------------------------
//  Media provider (Windows SMTC bridge)
//
//  🔌 ТОЧКА ИНТЕГРАЦИИ С РЕАЛЬНЫМ API
//  Сейчас трек берётся из системной медиасессии Windows (SMTC) через
//  smtc/bridge/SmtcBridge.exe — это настоящие данные Яндекса, без mock.
//  Чтобы добавить Spotify Web API или неофициальный API Яндекса,
//  замените/дополните этот класс источником, который:
//    1) отдаёт объект { found, track: { aumid, app, title, artist, album,
//       status, positionMs, durationMs, canSeek }, coverKey, cover };
//    2) принимает команды playpause / next / prev / seek.
//  Renderer (src/app.js) менять не нужно — формат состояния общий.
// ------------------------------------------------------------
class SmtcProvider {
  constructor() {
    this.exe = path.join(__dirname, 'smtc', 'bridge', 'SmtcBridge.exe');
    this.cacheDir = path.join(os.tmpdir(), 'liquid-glass-music');
    this.child = null;
    this.stopped = false;
    this.restartTimer = null;
    this.backoff = 500;
    this.commandSeq = 0;
    this.coverCache = new Map();
    this.lastSentCoverKey = null;

    this.rawSessions = [];
    this.lastPayload = null;
    this.ready = false;
    this.hasSeenPlaying = false;

    fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  start() {
    if (!IS_WIN || this.child || this.stopped) return;
    if (!fs.existsSync(this.exe)) {
      console.error('[smtc] bridge not found:', this.exe);
      this.broadcast({ found: false, demo: true, mode: settings.mode, error: 'bridge-missing' });
      return;
    }

    const child = spawn(
      this.exe,
      ['--cache-dir', this.cacheDir, '--parent-pid', String(process.pid)],
      {
        cwd: path.dirname(this.exe),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    this.child = child;

    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => this.onLine(line));

    const errors = readline.createInterface({ input: child.stderr });
    errors.on('line', (line) => {
      if (line.trim()) console.error('[smtc]', line);
    });

    child.on('error', (error) => {
      console.error('[smtc] spawn error:', error.message);
    });

    child.on('close', (code) => {
      if (this.child === child) this.child = null;
      lines.close();
      errors.close();
      this.ready = false;
      this.rawSessions = [];
      this.lastSentCoverKey = null;
      if (this.stopped) return;

      console.error('[smtc] bridge exited with code', code);
      this.broadcast({ found: false, demo: true, mode: settings.mode, error: 'bridge-exited' });
      this.scheduleRestart();
    });
  }

  scheduleRestart() {
    if (this.stopped) return;
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start();
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, 15000);
  }

  restart() {
    if (!IS_WIN) return;
    this.stopChild();
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.backoff = 500;
    this.stopped = false;
    this.rawSessions = [];
    this.lastPayload = null;
    this.lastSentCoverKey = null;
    this.start();
  }

  stopChild() {
    const child = this.child;
    this.child = null;
    if (child) {
      try {
        child.kill();
      } catch { }
    }
  }

  destroy() {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    this.stopChild();
  }

  onLine(line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') return;

    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return;
    }

    if (message.type !== 'state') return;

    if (message.ok) {
      this.ready = true;
      this.backoff = 500;
      this.rawSessions = Array.isArray(message.sessions) ? message.sessions : [];
      if (this.rawSessions.some((session) => session.status === 'playing')) {
        this.hasSeenPlaying = true;
      }
    } else {
      this.rawSessions = [];
      if (message.error) console.error('[smtc] bridge error:', message.error);
    }

    this.broadcast();
  }

  selectSession() {
    if (settings.mode === 'demo') return null;
    if (!this.rawSessions.length) return null;

    const isYandex = (session) => /yandex/i.test(session.aumid || '');
    const isActive = (session) =>
      session.status === 'playing' || session.status === 'changing';

    const pick = (list) => {
      if (!list.length) return null;
      const rank = (session) => {
        if (session.status === 'playing') return 0;
        if (session.status === 'changing') return 1;
        if (session.status === 'paused') return 2;
        return 3;
      };
      return [...list].sort((a, b) => rank(a) - rank(b))[0];
    };

    const yandex = this.rawSessions.filter(isYandex);

    if (settings.mode === 'yandex') {
      return pick(yandex);
    }

    // auto
    // Fresh launch with only paused sessions: keep the demo running, so the
    // widget is alive instead of showing a frozen track. Once anything has
    // played, a paused track is shown as-is (like Apple Music does).
    if (!this.hasSeenPlaying && !this.rawSessions.some(isActive)) {
      return null;
    }

    // Whatever is actually playing wins; Yandex Music has priority.
    const activeYandex = yandex.filter(isActive);
    if (activeYandex.length) return pick(activeYandex);

    const activeAny = this.rawSessions.filter(isActive);
    if (activeAny.length) return pick(activeAny);

    // Nothing plays right now: keep the last source visible.
    return pick(yandex) || pick(this.rawSessions);
  }

  buildPayload({ forceCover = false } = {}) {
    const selected = this.selectSession();

    if (!selected) {
      // Make sure the artwork is sent again when a session comes back.
      this.lastSentCoverKey = null;

      const payload = {
        found: false,
        demo: true,
        mode: settings.mode,
        at: Date.now(),
        track: null,
        coverKey: null,
      };
      this.lastPayload = payload;
      return payload;
    }

    const coverKey =
      selected.coverPath && selected.coverVersion
        ? `${selected.aumid}|${selected.coverVersion}`
        : null;

    let cover;
    if (coverKey) {
      const cached = this.coverCache.get(coverKey);
      if (cached) {
        cover = cached;
      } else {
        cover = this.readCover(selected.coverPath);
        if (cover) {
          this.coverCache.set(coverKey, cover);
          if (this.coverCache.size > 12) {
            const oldest = this.coverCache.keys().next().value;
            this.coverCache.delete(oldest);
          }
        }
      }
    }

    const shouldSendCover =
      (forceCover || coverKey !== this.lastSentCoverKey) && Boolean(cover);
    this.lastSentCoverKey = coverKey;

    const payload = {
      found: true,
      demo: false,
      mode: settings.mode,
      at: Date.now(),
      coverKey,
      track: {
        aumid: selected.aumid,
        app: appLabel(selected.aumid),
        title: selected.title || 'Неизвестный трек',
        artist: selected.artist || 'Неизвестный исполнитель',
        album: selected.album || '',
        status: selected.status || 'paused',
        positionMs: Number(selected.positionMs) || 0,
        durationMs: Number(selected.durationMs) || 0,
        canSeek: Boolean(selected.canSeek),
        coverKey,
      },
    };

    if (shouldSendCover) payload.cover = cover;

    this.lastPayload = payload;
    return payload;
  }

  readCover(file) {
    try {
      const bytes = fs.readFileSync(file);
      if (!bytes.length) return null;

      let mime = 'image/png';
      if (bytes[0] === 0xff && bytes[1] === 0xd8) mime = 'image/jpeg';
      else if (bytes[0] === 0x47 && bytes[1] === 0x49) mime = 'image/gif';
      else if (
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46
      ) {
        mime = 'image/webp';
      }

      return `data:${mime};base64,${bytes.toString('base64')}`;
    } catch {
      return null;
    }
  }

  broadcast(extra = null) {
    const payload = extra || this.buildPayload();
    for (const target of [mainWindow, islandWindow]) {
      if (target && !target.isDestroyed()) {
        target.webContents.send('media:state', payload);
      }
    }
  }

  current() {
    return this.buildPayload({ forceCover: true });
  }

  sendCommand(action, positionMs = 0) {
    const selected = this.selectSession();
    if (!selected) return false;

    const id = `${Date.now()}-${++this.commandSeq}`;
    const target = path.join(this.cacheDir, `command-${id}.json`);
    const temp = target + '.tmp';

    try {
      fs.writeFileSync(
        temp,
        JSON.stringify({
          action,
          aumid: selected.aumid,
          positionMs: Math.max(0, Number(positionMs) || 0),
        }),
        'utf8'
      );
      fs.renameSync(temp, target);
      return true;
    } catch (error) {
      console.error('[smtc] command failed:', error.message);
      return false;
    }
  }
}

function appLabel(aumid) {
  if (!aumid) return 'Медиа';
  for (const [pattern, label] of APP_LABELS) {
    if (pattern.test(aumid)) return label;
  }
  const leaf = String(aumid).split(/[\\!]/).pop();
  return leaf || 'Медиа';
}

// ------------------------------------------------------------
//  Yandex Music helpers
// ------------------------------------------------------------
let cachedYandexExe = null;

function findYandexMusicExe() {
  if (cachedYandexExe !== null) return cachedYandexExe;

  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'YandexMusic'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Yandex Music'),
    path.join(process.env.PROGRAMFILES || '', 'YandexMusic'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'YandexMusic'),
  ];

  for (const dir of candidates) {
    if (!dir || !fs.existsSync(dir)) continue;
    try {
      const files = fs
        .readdirSync(dir)
        .filter((name) => name.toLowerCase().endsWith('.exe'))
        .filter((name) => !/uninstall|unins|elevate|createdump/i.test(name))
        .map((name) => path.join(dir, name))
        .filter((file) => {
          try {
            return fs.statSync(file).size > 5 * 1024 * 1024;
          } catch {
            return false;
          }
        })
        .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);

      if (files.length) {
        cachedYandexExe = files[0];
        return cachedYandexExe;
      }
    } catch { }
  }

  cachedYandexExe = '';
  return '';
}

async function openYandexMusic() {
  const exe = findYandexMusicExe();
  if (exe) {
    try {
      const child = spawn(exe, [], { detached: true, stdio: 'ignore' });
      child.unref();
      return { ok: true, how: 'app' };
    } catch (error) {
      console.error('[yandex] launch failed:', error.message);
    }
  }

  try {
    await shell.openExternal('https://music.yandex.ru');
    return { ok: true, how: 'web' };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function openTrack(track) {
  const query = [track && track.title, track && track.artist]
    .filter(Boolean)
    .join(' ')
    .trim();

  const url = query
    ? `https://music.yandex.ru/search?text=${encodeURIComponent(query)}`
    : 'https://music.yandex.ru';

  await shell.openExternal(url);
  return { ok: true };
}

// ------------------------------------------------------------
//  IPC
// ------------------------------------------------------------
function registerIpc() {
  ipcMain.handle('app:bootstrap', () => ({
    settings,
    platform: process.platform,
    version: app.getVersion(),
    yandexInstalled: Boolean(findYandexMusicExe()),
    bridgeReady: Boolean(provider && provider.ready),
  }));

  ipcMain.handle('settings:update', (_event, patch) => {
    if (!patch || typeof patch !== 'object') return settings;

    if (['auto', 'yandex', 'demo'].includes(patch.mode)) settings.mode = patch.mode;
    if (['dark', 'light'].includes(patch.theme)) settings.theme = patch.theme;
    if (typeof patch.alwaysOnTop === 'boolean') settings.alwaysOnTop = patch.alwaysOnTop;

    saveSettings();

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setAlwaysOnTop(settings.alwaysOnTop, 'floating');
    }

    if (provider) provider.broadcast();

    return settings;
  });

  ipcMain.handle('toggleIslandMode', async (_event, enabled) => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;

    // Сохраняем текущие границы окна для восстановления
    if (state ? state.settings : (global.state = {})) {
      global.state.savedBounds = mainWindow.getBounds();
    }

    if (enabled) {
      mainWindow.setSize(320, 48, false);
      mainWindow.setAlwaysOnTop(true, 'floating');
      mainWindow.setResizable(false);
      mainWindow.setMinimizable(false);
      mainWindow.setMaximizable(false);
    } else {
      const saved = global.state?.savedBounds;
      if (saved) {
        mainWindow.setBounds(saved, false);
      } else {
        mainWindow.setSize(WINDOW_WIDTH, WINDOW_HEIGHT, false);
      }
      mainWindow.setAlwaysOnTop(settings.alwaysOnTop, 'floating');
      mainWindow.setResizable(true);
      mainWindow.setMinimizable(true);
      mainWindow.setMaximizable(true);
    }
    return true;
  });

  ipcMain.handle('window:action', (_event, action) => {
    if (!mainWindow || mainWindow.isDestroyed()) return null;

    switch (action) {
      case 'minimize':
        mainWindow.minimize();
        return true;
      case 'close':
        mainWindow.close();
        return true;
      case 'pin': {
        settings.alwaysOnTop = !settings.alwaysOnTop;
        mainWindow.setAlwaysOnTop(settings.alwaysOnTop, 'floating');
        saveSettings();
        return settings.alwaysOnTop;
      }
      default:
        return null;
    }
  });

  ipcMain.handle('media:state', () => (provider ? provider.current() : null));

  ipcMain.handle('media:command', (_event, payload) => {
    if (!provider || !payload) return false;
    const allowed = new Set(['playpause', 'play', 'pause', 'next', 'prev', 'seek']);
    if (!allowed.has(payload.action)) return false;
    return provider.sendCommand(payload.action, payload.positionMs);
  });

  ipcMain.handle('provider:restart', () => {
    if (!provider) return false;
    provider.restart();
    return true;
  });

  ipcMain.handle('open:yandex', () => openYandexMusic());
  ipcMain.handle('open:track', (_event, track) => openTrack(track));
}

// ------------------------------------------------------------
//  App lifecycle
// ------------------------------------------------------------
function init() {
  loadSettings();

  if (!IS_MAC) Menu.setApplicationMenu(null);

  registerIpc();
  createWindow();
  createIslandWindow();

  provider = new SmtcProvider();
  provider.start();

  powerMonitor.on('resume', () => {
    if (provider) provider.restart();
  });
}

app.on('window-all-closed', () => {
  if (!IS_MAC) app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
    createIslandWindow();
  }
});

let shortcutCreated = false;

// Leave a desktop shortcut behind when the player really exits.
// The script is detached so it can finish even while Electron is tearing down.
function createDesktopShortcut() {
  if (!IS_WIN || IS_SMOKE || shortcutCreated) return;
  shortcutCreated = true;

  const scriptPath = path.join(__dirname, 'create-shortcut.ps1');
  if (!fs.existsSync(scriptPath)) return;

  // In a packaged portable build __dirname lives in a temporary folder, so the
  // shortcut must point at the real launcher on the desktop, not start.bat.
  const shortcutTarget = app.isPackaged
    ? process.env.PORTABLE_EXECUTABLE_FILE || process.execPath
    : null;
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
  ];
  if (shortcutTarget) {
    args.push('-TargetPath', shortcutTarget, '-WorkingDirectory', path.dirname(shortcutTarget));
  }

  try {
    const child = spawn('powershell.exe', args, {
      cwd: __dirname,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', () => {});
    child.unref();
  } catch (error) {
    console.error('create-shortcut:', error?.message || error);
  }
}

app.on('before-quit', () => {
  quitting = true;
  if (provider) provider.destroy();
});

app.on('will-quit', () => {
  if (provider) provider.destroy();
  createDesktopShortcut();
});

// ------------------------------------------------------------
//  Visual smoke test: npm run smoke
//  Saves preview.png and prints runtime diagnostics.
// ------------------------------------------------------------
function runSmokeTest() {
  setTimeout(async () => {
    try {
      const diagnostics = await mainWindow.webContents.executeJavaScript(`
        (() => {
          const glass = document.querySelector('.glass');
          const widget = document.querySelector('.widget');
          const title = document.getElementById('trackTitle');
          const artist = document.getElementById('trackArtist');
          const source = document.getElementById('sourceName');
          const cover = document.querySelector('.cover.is-visible');
          const covers = [...document.querySelectorAll('.cover')]
            .filter((img) => img.classList.contains('is-visible'))
            .map((img) => ({
              len: img.src.length,
              natural: [img.naturalWidth, img.naturalHeight],
            }));
          const style = glass ? getComputedStyle(glass) : null;
          const rootStyle = getComputedStyle(document.documentElement);
          const rect = (selector) => {
            const element = document.querySelector(selector);
            if (!element) return null;
            const r = element.getBoundingClientRect();
            return {
              x: Math.round(r.x),
              y: Math.round(r.y),
              w: Math.round(r.width),
              h: Math.round(r.height),
              bottom: Math.round(r.bottom),
            };
          };
          const content = document.querySelector('.content');
          const playPause = document.querySelector('.ctrl.play .icon-pause');
          const wasPlaying = widget ? widget.classList.contains('is-playing') : false;
          if (widget) widget.classList.add('is-playing');
          const pauseDisplayWhenPlaying = playPause
            ? getComputedStyle(playPause).display
            : null;
          if (widget) widget.classList.toggle('is-playing', wasPlaying);

          return {
            api: Boolean(window.api),
            theme: document.body.dataset.theme,
            title: title ? title.textContent : null,
            artist: artist ? artist.textContent : null,
            source: source ? source.textContent : null,
            playing: widget ? widget.classList.contains('is-playing') : null,
            covers,
            coverAlt: cover ? cover.alt : null,
            backdropFilter: style ? (style.backdropFilter || style.webkitBackdropFilter) : null,
            background: style ? style.backgroundImage.slice(0, 120) : null,
            accent: rootStyle.getPropertyValue('--accent').trim(),
            blob1a: document.querySelector('.blob-1')
              ? getComputedStyle(document.querySelector('.blob-1')).getPropertyValue('--b1a').trim()
              : null,
            playPauseDisplay: playPause ? getComputedStyle(playPause).display : null,
            pauseDisplayWhenPlaying,
            titleFont: title ? getComputedStyle(title).fontFamily : null,
            rects: {
              widget: rect('.widget'),
              art: rect('.art-frame'),
              meta: rect('.meta'),
              timeline: rect('.timeline'),
              controls: rect('.controls'),
              bottom: rect('.bottom'),
            },
            contentOverflow: content
              ? { scroll: content.scrollHeight, client: content.clientHeight }
              : null,
            sheetOpen: document.getElementById('sheet').classList.contains('open'),
            size: { w: window.innerWidth, h: window.innerHeight },
            errors: window.__errors || [],
          };
        })()
      `);

      const image = await mainWindow.webContents.capturePage();
      fs.writeFileSync(path.join(__dirname, 'preview.png'), image.toPNG());

      // Second screenshot with the settings sheet open.
      await mainWindow.webContents.executeJavaScript(
        `document.getElementById('settingsBtn').click()`
      );
      await new Promise((resolve) => setTimeout(resolve, 750));

      const sheetState = await mainWindow.webContents.executeJavaScript(`
        (() => {
          const sheet = document.getElementById('sheet');
          const r = sheet.getBoundingClientRect();
          return {
            open: sheet.classList.contains('open'),
            rect: {
              x: Math.round(r.x),
              y: Math.round(r.y),
              w: Math.round(r.width),
              h: Math.round(r.height),
            },
          };
        })()
      `);

      const settingsImage = await mainWindow.webContents.capturePage();
      fs.writeFileSync(path.join(__dirname, 'preview-settings.png'), settingsImage.toPNG());

      // Light theme preview (then restore dark, so the user's default stays dark).
      const lightState = await mainWindow.webContents.executeJavaScript(`
        (() => {
          document.querySelector('#themeSeg button[data-theme="light"]').click();
          document.getElementById('sheetClose').click();
          return true;
        })()
      `);
      await new Promise((resolve) => setTimeout(resolve, 900));

      const lightDiagnostics = await mainWindow.webContents.executeJavaScript(`
        (() => {
          const glass = document.querySelector('.glass');
          return {
            theme: document.body.dataset.theme,
            textColor: getComputedStyle(document.body).color,
            glassBackground: glass ? getComputedStyle(glass).backgroundImage.slice(0, 80) : null,
            sheetOpen: document.getElementById('sheet').classList.contains('open'),
          };
        })()
      `);

      const lightImage = await mainWindow.webContents.capturePage();
      fs.writeFileSync(path.join(__dirname, 'preview-light.png'), lightImage.toPNG());

      await mainWindow.webContents.executeJavaScript(
        `document.querySelector('#themeSeg button[data-theme="dark"]').click()`
      );
      await new Promise((resolve) => setTimeout(resolve, 250));

      // Optional: verify that the demo rotates the track every 10 seconds.
      let demoRotation = null;
      if (process.argv.includes('--smoke-demo')) {
        const readDemo = () =>
          mainWindow.webContents.executeJavaScript(`
            (() => ({
              title: document.getElementById('trackTitle').textContent,
              artist: document.getElementById('trackArtist').textContent,
              accent: getComputedStyle(document.documentElement)
                .getPropertyValue('--accent').trim(),
              source: document.getElementById('sourceName').textContent,
              mode: document.querySelector('#modeSeg button.active')?.dataset.mode,
            }))()
          `);

        await mainWindow.webContents.executeJavaScript(
          `document.querySelector('#modeSeg button[data-mode="demo"]').click()`
        );
        await new Promise((resolve) => setTimeout(resolve, 600));

        const before = await readDemo();
        await new Promise((resolve) => setTimeout(resolve, 10500));
        const after = await readDemo();

        demoRotation = {
          before,
          after,
          changed:
            before.title !== after.title &&
            before.artist !== after.artist &&
            before.accent !== after.accent,
        };

        await mainWindow.webContents.executeJavaScript(
          `document.querySelector('#modeSeg button[data-mode="auto"]').click()`
        );
        await new Promise((resolve) => setTimeout(resolve, 400));
      }

      console.log(
        'SMOKE_RESULT ' +
          JSON.stringify({
            ...diagnostics,
            sheetState,
            lightState,
            lightDiagnostics,
            demoRotation,
          })
      );
    } catch (error) {
      console.error('SMOKE_ERROR', error);
    } finally {
      app.quit();
    }
  }, 4000);
}
