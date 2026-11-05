'use strict';

/* ============================================================
   Liquid Glass Music — renderer
   ============================================================ */

window.__errors = [];
window.addEventListener('error', (event) => {
  window.__errors.push(String(event.message || event.error || 'error'));
});
window.addEventListener('unhandledrejection', (event) => {
  window.__errors.push(String(event.reason || 'rejection'));
});

const $ = (id) => document.getElementById(id);

const els = {
  widget: $('widget'),
  sourcePill: $('sourcePill'),
  sourceName: $('sourceName'),
  minBtn: $('minBtn'),
  closeBtn: $('closeBtn'),
  artFrame: $('artFrame'),
  artGlow: $('artGlow'),
  coverA: $('coverA'),
  coverB: $('coverB'),
  meta: $('meta'),
  title: $('trackTitle'),
  artist: $('trackArtist'),
  progress: $('progress'),
  progressFill: $('progressFill'),
  progressThumb: $('progressThumb'),
  timeCurrent: $('timeCurrent'),
  timeTotal: $('timeTotal'),
  playBtn: $('playBtn'),
  prevBtn: $('prevBtn'),
  nextBtn: $('nextBtn'),
  openBtn: $('openBtn'),
  openLabel: $('openLabel'),
  pinBtn: $('pinBtn'),
  settingsBtn: $('settingsBtn'),
  sheet: $('sheet'),
  sheetClose: $('sheetClose'),
  modeSeg: $('modeSeg'),
  themeSeg: $('themeSeg'),
  sourceHint: $('sourceHint'),
  pinSwitch: $('pinSwitch'),
  openYandexBtn: $('openYandexBtn'),
  reconnectBtn: $('reconnectBtn'),
  toast: $('toast'),
  blob1: document.querySelector('.blob-1'),
  blob2: document.querySelector('.blob-2'),
  blob3: document.querySelector('.blob-3'),
};

const DEMO_TRACKS = [
  {
    title: 'Midnight Drive',
    artist: 'Aurora Waves',
    duration: 224,
    palette: ['#ff3d8b', '#9d4dff', '#22d3ee'],
  },
  {
    title: 'Neon Bloom',
    artist: 'Kaito',
    duration: 198,
    palette: ['#ff8a1f', '#ff2d55', '#ffd166'],
  },
  {
    title: 'Deep Water',
    artist: 'Mira Sol',
    duration: 246,
    palette: ['#00e0b8', '#2f7bff', '#b14aff'],
  },
];

const DEMO_ROTATE_MS = 10_000;

const state = {
  settings: { mode: 'auto', theme: 'dark', alwaysOnTop: false },
  bootstrap: null,

  live: null,
  liveActive: false,
  liveReceivedAt: 0,
  liveTrackKey: '',
  liveCover: null,
  liveCoverKey: null,

  demoIndex: 0,
  demoPosition: 0,
  demoPlaying: true,
  demoBase: nowSec(),
  demoTimer: null,

  artLayer: 0,
  artSrc: '',
  artSeq: 0,

  paletteKey: '',
  paletteSeq: 0,
  paletteCache: new Map(),
  coverCache: new Map(),

  dragging: false,
  dragRatio: 0,
  seek: null,
  playPending: null,

  sheetOpen: false,
  startupHint: false,
  lastSecond: -1,
  lastDuration: -1,
  toastTimer: null,
  metaTimer: null,
  tickTimer: null,
};

const bridge = window.api || {
  // Browser preview fallback (index.html can be opened without Electron).
  bootstrap: async () => ({
    settings: { mode: 'auto', theme: 'dark', alwaysOnTop: false },
    platform: 'web',
    yandexInstalled: false,
    bridgeReady: false,
  }),
  currentState: async () => null,
  onState: () => {},
  command: async () => false,
  updateSettings: async (patch) => ({ ...state.settings, ...patch }),
  windowAction: async () => null,
  restartProvider: async () => false,
  openYandex: async () => ({ ok: true, how: 'web' }),
  openTrack: async () => ({ ok: true }),
};

/* ============================================================
   Утилиты
   ============================================================ */
function nowSec() {
  return performance.now() / 1000;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function hashString(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/* ============================================================
   Цвет
   ============================================================ */
function hslToHex(hue, saturation, lightness) {
  const h = ((hue % 360) + 360) % 360;
  const s = clamp(saturation, 0, 1);
  const l = clamp(lightness, 0, 1);

  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;

  let r = 0;
  let g = 0;
  let b = 0;

  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];

  const toHex = (value) =>
    Math.round((value + m) * 255)
      .toString(16)
      .padStart(2, '0');

  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function rgbToHsl(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const lightness = (max + min) / 2;

  if (delta === 0) return [0, 0, lightness];

  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue;

  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;

  hue *= 60;
  if (hue < 0) hue += 360;

  return [hue, saturation, lightness];
}

function hueDistance(a, b) {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

function fallbackPalette(seedText) {
  const base = hashString(String(seedText || 'liquid')) % 360;
  return [
    hslToHex(base, 0.82, 0.62),
    hslToHex(base + 52, 0.75, 0.58),
    hslToHex(base + 305, 0.82, 0.6),
  ];
}

/* ============================================================
   Палитра: извлечение из обложки
   ============================================================ */
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

async function extractPalette(src) {
  const image = await loadImage(src);

  const canvas = document.createElement('canvas');
  canvas.width = 40;
  canvas.height = 40;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('canvas unavailable');

  context.drawImage(image, 0, 0, 40, 40);
  const data = context.getImageData(0, 0, 40, 40).data;

  const buckets = Array.from({ length: 24 }, () => ({
    count: 0,
    hue: 0,
    saturation: 0,
    lightness: 0,
    weight: 0,
  }));

  for (let index = 0; index < data.length; index += 4) {
    const r = data[index] / 255;
    const g = data[index + 1] / 255;
    const b = data[index + 2] / 255;
    const [hue, saturation, lightness] = rgbToHsl(r, g, b);

    if (lightness < 0.07 || lightness > 0.95) continue;
    if (saturation < 0.16) continue;

    const bucketIndex = Math.min(23, Math.floor(hue / 15));
    const bucket = buckets[bucketIndex];
    const weight = 0.25 + saturation * (1 - Math.abs(lightness - 0.55) * 1.4);

    bucket.count += 1;
    bucket.hue += hue * weight;
    bucket.saturation += saturation * weight;
    bucket.lightness += lightness * weight;
    bucket.weight += weight;
  }

  const ranked = buckets
    .filter((bucket) => bucket.count >= 5 && bucket.weight > 0)
    .sort((a, b) => b.weight - a.weight);

  const picked = [];

  for (const bucket of ranked) {
    const hue = bucket.hue / bucket.weight;
    if (picked.every((item) => hueDistance(item.hue, hue) > 32)) {
      picked.push({
        hue,
        saturation: bucket.saturation / bucket.weight,
        lightness: bucket.lightness / bucket.weight,
      });
    }
    if (picked.length === 3) break;
  }

  if (!picked.length) {
    return fallbackPalette(src.slice(0, 64));
  }

  const baseHue = picked[0].hue;
  while (picked.length < 3) {
    const hue = baseHue + (picked.length === 1 ? 52 : 305);
    picked.push({ hue, saturation: 0.8, lightness: 0.6 });
  }

  return picked.map((item) =>
    hslToHex(
      item.hue,
      clamp(item.saturation * 1.18, 0.58, 0.96),
      clamp(item.lightness, 0.48, 0.64)
    )
  );
}

function applyPalette(colors) {
  if (!colors || colors.length < 3) return;
  const [a, b, c] = colors;

  document.documentElement.style.setProperty('--accent', a);
  document.documentElement.style.setProperty('--accent-2', b);

  // Registered custom properties transition smoothly inside each blob.
  els.blob1.style.setProperty('--b1a', a);
  els.blob1.style.setProperty('--b1b', b);
  els.blob2.style.setProperty('--b2a', b);
  els.blob2.style.setProperty('--b2b', c);
  els.blob3.style.setProperty('--b3a', c);
  els.blob3.style.setProperty('--b3b', a);
}

/* ============================================================
   Обложки
   ============================================================ */
function makeCover(colors, seedText) {
  const [a, b, c] = colors;
  const seed = hashString(String(seedText));
  let randomState = seed || 1;

  const random = () => {
    randomState = (randomState * 1664525 + 1013904223) >>> 0;
    return randomState / 4294967296;
  };

  const blobs = Array.from({ length: 5 }, (_, index) => {
    const x = 40 + random() * 430;
    const y = 30 + random() * 450;
    const radius = 80 + random() * 130;
    const color = [a, b, c, '#ffffff'][index % 4];
    const opacity = 0.32 + random() * 0.35;
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${radius.toFixed(1)}" fill="${color}" opacity="${opacity.toFixed(2)}"/>`;
  }).join('');

  const arc = `
    <circle cx="256" cy="256" r="152" fill="none" stroke="#ffffff" stroke-opacity=".20" stroke-width="1.4"/>
    <circle cx="256" cy="256" r="96" fill="none" stroke="#ffffff" stroke-opacity=".13" stroke-width="1"/>
    <path d="M104 366 C 184 286, 328 286, 408 366" fill="none" stroke="#ffffff" stroke-opacity=".18" stroke-width="1.2"/>
  `;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${a}"/>
        <stop offset=".52" stop-color="${b}"/>
        <stop offset="1" stop-color="${c}"/>
      </linearGradient>
      <filter id="soft" x="-40%" y="-40%" width="180%" height="180%">
        <feGaussianBlur stdDeviation="52"/>
      </filter>
      <filter id="grain">
        <feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="2" stitchTiles="stitch"/>
        <feColorMatrix type="saturate" values="0"/>
      </filter>
      <radialGradient id="vignette" cx=".5" cy=".32" r=".82">
        <stop offset=".42" stop-color="#000" stop-opacity="0"/>
        <stop offset="1" stop-color="#000" stop-opacity=".42"/>
      </radialGradient>
    </defs>
    <rect width="512" height="512" fill="url(#bg)"/>
    <g filter="url(#soft)">${blobs}</g>
    <rect width="512" height="512" fill="url(#vignette)"/>
    ${arc}
    <rect width="512" height="512" filter="url(#grain)" opacity=".09"/>
  </svg>`;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function demoCover(index) {
  const cacheKey = `demo:${index}`;
  if (state.coverCache.has(cacheKey)) return state.coverCache.get(cacheKey);

  const track = DEMO_TRACKS[index];
  const cover = makeCover(track.palette, `${track.title}:${track.artist}`);
  state.coverCache.set(cacheKey, cover);
  return cover;
}

function setArt(src, { sheen = false } = {}) {
  if (!src || src === state.artSrc) return;
  state.artSrc = src;

  const layers = [els.coverA, els.coverB];
  const nextIndex = 1 - state.artLayer;
  const next = layers[nextIndex];
  const previous = layers[state.artLayer];

  const sequence = ++state.artSeq;
  let revealed = false;

  const reveal = () => {
    if (revealed || sequence !== state.artSeq) return;
    revealed = true;
    next.classList.add('is-visible');
    previous.classList.remove('is-visible');
    state.artLayer = nextIndex;

    if (els.artGlow) {
      els.artGlow.style.backgroundImage = `url("${src}")`;
    }
  };

  next.onload = reveal;
  next.onerror = () => { };
  next.src = src;

  if (next.complete && next.naturalWidth > 0) reveal();
  if (sheen) playSheen();
}

function playSheen() {
  els.artFrame.classList.remove('sheen');
  void els.artFrame.offsetWidth;
  els.artFrame.classList.add('sheen');
}

/* ============================================================
   Текстовые данные
   ============================================================ */
function updateMeta(track, animate = false) {
  els.title.textContent = track.title;
  els.title.title = track.title;
  els.artist.textContent = track.artist;
  els.artist.title = track.artist;
  const alt = `Обложка: ${track.title} — ${track.artist}`;
  els.coverA.alt = alt;
  els.coverB.alt = alt;

  if (animate) {
    els.meta.classList.remove('swap');
    void els.meta.offsetWidth;
    els.meta.classList.add('swap');
    clearTimeout(state.metaTimer);
    state.metaTimer = setTimeout(() => els.meta.classList.remove('swap'), 600);
  }
}

function setTotal(duration) {
  const seconds = Number(duration) || 0;
  els.timeTotal.textContent = seconds > 0 ? formatTime(seconds) : '—';
  state.lastDuration = Math.floor(seconds);
}

function setSource(label) {
  els.sourceName.textContent = label;
  els.sourcePill.title = label === 'Демо-режим'
    ? 'Демонстрационный режим: 3 трека и живые градиенты'
    : `Источник: ${label}`;
}

function updateSourceHint() {
  if (!els.sourceHint) return;

  if (state.settings.mode === 'demo') {
    els.sourceHint.textContent =
      'Демо-режим включён вручную. Каждые 10 секунд меняется трек и палитра.';
    return;
  }

  if (state.liveActive && state.live?.track) {
    const track = state.live.track;
    const status = track.status === 'playing' ? 'играет' : 'пауза';
    els.sourceHint.textContent = `${track.app}: ${track.title} — ${track.artist} · ${status}`;
    return;
  }

  if (state.bootstrap && state.bootstrap.platform !== 'win32') {
    els.sourceHint.textContent =
      'Медиасессии Windows доступны только на Windows. Здесь работает демо-режим.';
    return;
  }

  els.sourceHint.textContent =
    'Медиасессия не найдена. Включите трек в Яндекс Музыке — виджет подхватит его автоматически.';
}

/* ============================================================
   Настройки / тема
   ============================================================ */
function applyTheme(theme) {
  document.body.dataset.theme = theme === 'light' ? 'light' : 'dark';
  if (els.themeSeg) {
    els.themeSeg.querySelectorAll('button').forEach((button) => {
      button.classList.toggle('active', button.dataset.theme === document.body.dataset.theme);
    });
  }
}

function syncSegments() {
  els.modeSeg.querySelectorAll('button').forEach((button) => {
    button.classList.toggle('active', button.dataset.mode === state.settings.mode);
  });
}

function syncPin() {
  const pinned = Boolean(state.settings.alwaysOnTop);
  els.pinBtn.classList.toggle('active', pinned);
  els.pinBtn.setAttribute('aria-pressed', String(pinned));
  els.pinSwitch.setAttribute('aria-checked', String(pinned));
}

function setSourceUi() {
  if (state.liveActive && state.live?.track) {
    const track = state.live.track;
    setSource(track.app || 'Медиа');
    els.openLabel.textContent = /yandex/i.test(track.aumid || '') ? 'Открыть' : 'Найти';
  } else {
    setSource('Демо-режим');
    els.openLabel.textContent = 'Открыть';
  }
  updateSourceHint();
}

/* ============================================================
   Демо-режим
   ============================================================ */
function demoTrack() {
  return DEMO_TRACKS[state.demoIndex];
}

function applyDemoVisuals(animate = false) {
  const track = demoTrack();

  updateMeta(track, animate);
  setTotal(track.duration);
  applyPalette(track.palette);
  state.paletteKey = `demo:${state.demoIndex}`;
  setArt(demoCover(state.demoIndex), { sheen: animate });
  setSourceUi();
}

function setDemoTrack(index, { animate = true, reset = true } = {}) {
  const length = DEMO_TRACKS.length;
  state.demoIndex = ((index % length) + length) % length;

  if (reset) {
    state.demoPosition = 0;
    state.demoBase = nowSec();
    state.lastSecond = -1;
  }

  applyDemoVisuals(animate);
}

function restartDemoClock() {
  clearInterval(state.demoTimer);
  state.demoTimer = setInterval(() => {
    if (state.liveActive) return;
    if (!state.demoPlaying) return;

    state.demoPosition = 0;
    state.demoBase = nowSec();
    state.lastSecond = -1;
    setDemoTrack(state.demoIndex + 1, { reset: false, animate: true });
  }, DEMO_ROTATE_MS);
}

/* ============================================================
   Прямой эфир: SMTC
   ============================================================ */
function ensureLivePalette(trackKey) {
  if (!state.liveCover) return;

  const cacheKey = state.liveCoverKey || trackKey;
  const cached = state.paletteCache.get(cacheKey);

  if (cached) {
    applyPalette(cached);
    state.paletteKey = trackKey;
    return;
  }

  const sequence = ++state.paletteSeq;

  extractPalette(state.liveCover)
    .then((palette) => {
      if (!palette || sequence !== state.paletteSeq) return;

      state.paletteCache.set(cacheKey, palette);
      if (state.paletteCache.size > 20) {
        const oldest = state.paletteCache.keys().next().value;
        state.paletteCache.delete(oldest);
      }

      if (state.liveTrackKey === trackKey) {
        // The real album artwork always stays; the palette only colors the glass.
        applyPalette(palette);
        state.paletteKey = trackKey;
      }
    })
    .catch(() => {
      if (sequence !== state.paletteSeq) return;
      if (state.liveTrackKey === trackKey && state.paletteKey !== trackKey) {
        applyPalette(fallbackPalette(trackKey));
        state.paletteKey = trackKey;
      }
    });
}

function updateLiveArt(track, trackKey) {
  if (state.liveCover) {
    setArt(state.liveCover, { sheen: true });
    ensureLivePalette(trackKey);
    return;
  }

  // No artwork in the media session: build one from the track's own palette.
  const palette = fallbackPalette(`${track.title}:${track.artist}`);
  applyPalette(palette);
  state.paletteKey = trackKey;
  setArt(makeCover(palette, trackKey), { sheen: true });
}

function handleLiveState(payload) {
  if (!payload) return;

  state.live = payload;
  const usable = state.settings.mode !== 'demo' && payload.found && payload.track;

  if (!usable) {
    const wasActive = state.liveActive;
    state.liveActive = false;
    state.liveTrackKey = '';
    state.liveCover = null;
    state.liveCoverKey = null;
    state.seek = null;
    state.playPending = null;

    if (wasActive) {
      if (state.demoPlaying) {
        state.demoBase = nowSec() - state.demoPosition;
      }
      state.lastSecond = -1;
      applyDemoVisuals(true);
    } else {
      setSourceUi();
    }
    return;
  }

  const track = payload.track;
  const trackKey = `${track.aumid}|${track.title}|${track.artist}|${track.album}`;
  const isNew = trackKey !== state.liveTrackKey;
  const previousCoverKey = state.liveCoverKey;

  if (payload.cover) state.liveCover = payload.cover;
  state.liveCoverKey = payload.coverKey || null;
  state.liveActive = true;
  if (state.startupHint) {
    state.startupHint = false;
    els.toast.classList.remove('show');
  }
  state.liveReceivedAt = Date.now();
  state.liveTrackKey = trackKey;

  if (isNew) {
    if (!payload.cover) state.liveCover = null;
    state.seek = null;
    state.playPending = null;
    state.lastSecond = -1;
  }

  // Drop optimistic state as soon as the player confirms it.
  if (state.playPending) {
    const reportedPlaying = track.status === 'playing';
    if (
      reportedPlaying === state.playPending.playing ||
      Date.now() - state.playPending.at > 2400
    ) {
      state.playPending = null;
    }
  }

  if (state.seek) {
    const reportedSeconds = (track.positionMs || 0) / 1000;
    if (
      Math.abs(reportedSeconds - state.seek.position) < 1.5 ||
      Date.now() - state.seek.at > 2400
    ) {
      state.seek = null;
    }
  }

  if (isNew) {
    updateMeta(track, true);
    setTotal((track.durationMs || 0) / 1000);
    updateLiveArt(track, trackKey);
  } else if (payload.cover && payload.coverKey !== previousCoverKey) {
    updateLiveArt(track, trackKey);
  }

  setSourceUi();
}

/* ============================================================
   Текущее состояние воспроизведения
   ============================================================ */
function currentTrackInfo() {
  if (state.liveActive && state.live?.track) {
    const track = state.live.track;
    return {
      title: track.title,
      artist: track.artist,
      duration: (track.durationMs || 0) / 1000,
      aumid: track.aumid,
      app: track.app,
      track,
    };
  }

  const track = demoTrack();
  return {
    title: track.title,
    artist: track.artist,
    duration: track.duration,
    aumid: 'demo',
    app: 'Демо-режим',
    track,
  };
}

function isPlaying() {
  if (state.liveActive) {
    if (state.playPending) return state.playPending.playing;
    return state.live?.track?.status === 'playing';
  }
  return state.demoPlaying;
}

function currentPosition() {
  if (state.liveActive && state.live?.track) {
    const track = state.live.track;
    let base = (track.positionMs || 0) / 1000;
    let anchor = state.liveReceivedAt;
    let playing = track.status === 'playing';

    if (state.playPending) {
      base = state.playPending.position;
      anchor = state.playPending.at;
      playing = state.playPending.playing;
    }

    if (state.seek) {
      base = state.seek.position;
      anchor = state.seek.at;
      playing = isPlaying();
    }

    let position = base + (playing ? (Date.now() - anchor) / 1000 : 0);
    if (track.durationMs > 0) position = Math.min(position, track.durationMs / 1000);
    return Math.max(0, position);
  }

  let position = state.demoPosition;
  if (state.demoPlaying) position += nowSec() - state.demoBase;
  return Math.min(position, demoTrack().duration);
}

/* ============================================================
   Отрисовка кадра
   ============================================================ */
  // Adaptive cadence: DOM updates are cheap at 4 fps and nobody can
  // notice the difference on a progress bar, while 60+ fps rAF loop
  // burned CPU constantly.
  function tick() {
    const info = currentTrackInfo();
    const duration = Number(info.duration) || 0;

    if (state.liveActive && Math.floor(duration) !== state.lastDuration) {
      setTotal(duration);
    }

    let position = currentPosition();
    if (state.dragging) position = state.dragRatio * duration;

    const ratio = duration > 0 ? clamp(position / duration, 0, 1) : 0;

    els.progress.style.setProperty('--p', ratio.toFixed(5));
    els.progress.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
    els.progress.setAttribute(
      'aria-valuetext',
      `${formatTime(position)} из ${duration > 0 ? formatTime(duration) : '—'}`
    );

    const second = Math.floor(position);
    if (second !== state.lastSecond) {
      state.lastSecond = second;
      els.timeCurrent.textContent = formatTime(position);
    }

    const playing = state.dragging ? false : isPlaying();
    els.widget.classList.toggle('is-playing', playing);
    els.playBtn.setAttribute('aria-label', playing ? 'Пауза' : 'Играть');
  }

  function scheduleTick() {
    clearTimeout(state.tickTimer);
    const playing = !state.dragging && isPlaying();
    const delay = state.dragging ? 100 : playing ? 250 : 1000;
    state.tickTimer = setTimeout(() => {
      tick();
      scheduleTick();
    }, delay);
  }

/* ============================================================
   Перемотка
   ============================================================ */
function commitPosition(seconds) {
  const info = currentTrackInfo();
  const duration = Number(info.duration) || 0;
  if (!(duration > 0)) return;

  const position = clamp(seconds, 0, duration);
  state.lastSecond = -1;

  if (state.liveActive) {
    state.seek = { position, at: Date.now() };
    bridge
      .command({ action: 'seek', positionMs: Math.round(position * 1000) })
      .then((ok) => {
        if (!ok) state.seek = null;
      });
  } else {
    state.demoPosition = position;
    state.demoBase = nowSec();
  }
}

function seekBy(delta) {
  commitPosition(currentPosition() + delta);
}

function ratioFromEvent(event) {
  const rect = els.progress.getBoundingClientRect();
  if (rect.width <= 0) return 0;
  return clamp((event.clientX - rect.left) / rect.width, 0, 1);
}

function onProgressPointerDown(event) {
  if (event.button !== 0) return;
  if (!(currentTrackInfo().duration > 0)) return;

  state.dragging = true;
  state.dragRatio = ratioFromEvent(event);
  els.progress.classList.add('dragging');

  try {
    els.progress.setPointerCapture(event.pointerId);
  } catch { }

  event.preventDefault();
}

function onProgressPointerMove(event) {
  if (!state.dragging) return;
  state.dragRatio = ratioFromEvent(event);
}

function onProgressPointerUp(event) {
  if (!state.dragging) return;

  state.dragging = false;
  els.progress.classList.remove('dragging');

  const duration = currentTrackInfo().duration;
  if (duration > 0) commitPosition(state.dragRatio * duration);

  try {
    els.progress.releasePointerCapture(event.pointerId);
  } catch { }
}

function onProgressPointerCancel() {
  state.dragging = false;
  els.progress.classList.remove('dragging');
}

/* ============================================================
   Управление
   ============================================================ */
async function togglePlay() {
  if (state.liveActive) {
    const playing = isPlaying();
    const position = currentPosition();

    state.playPending = {
      playing: !playing,
      at: Date.now(),
      position,
    };

    const ok = await bridge.command({ action: 'playpause' });
    if (!ok) {
      state.playPending = null;
      showToast('Не удалось отправить команду плееру');
    }
    return;
  }

  if (state.demoPlaying) {
    state.demoPosition = currentPosition();
    state.demoPlaying = false;
  } else {
    state.demoBase = nowSec() - state.demoPosition;
    state.demoPlaying = true;
  }
}

async function nextTrack() {
  if (state.liveActive) {
    state.playPending = null;
    state.seek = { position: 0, at: Date.now() };

    const ok = await bridge.command({ action: 'next' });
    if (!ok) {
      state.seek = null;
      showToast('Не удалось отправить команду плееру');
    }
    return;
  }

  state.demoPosition = 0;
  state.demoBase = nowSec();
  state.lastSecond = -1;
  setDemoTrack(state.demoIndex + 1, { reset: false, animate: true });
  restartDemoClock();
}

async function previousTrack() {
  if (state.liveActive) {
    state.playPending = null;
    state.seek = { position: 0, at: Date.now() };

    const ok = await bridge.command({ action: 'prev' });
    if (!ok) {
      state.seek = null;
      showToast('Не удалось отправить команду плееру');
    }
    return;
  }

  state.demoPosition = 0;
  state.demoBase = nowSec();
  state.lastSecond = -1;
  setDemoTrack(state.demoIndex - 1, { reset: false, animate: true });
  restartDemoClock();
}

/* ============================================================
   Настройки
   ============================================================ */
async function setMode(mode) {
  if (!['auto', 'yandex', 'demo'].includes(mode)) return;
  if (mode === state.settings.mode) return;

  state.settings.mode = mode;
  syncSegments();
  updateSourceHint();

  if (mode === 'demo') {
    state.liveActive = false;
    state.liveTrackKey = '';
    state.liveCover = null;
    state.liveCoverKey = null;
    state.playPending = null;
    state.seek = null;
    state.demoBase = nowSec() - state.demoPosition;
    state.lastSecond = -1;
    applyDemoVisuals(true);
  }

  try {
    const updated = await bridge.updateSettings({ mode });
    if (updated) state.settings = { ...state.settings, ...updated };
  } catch { }

  try {
    const payload = await bridge.currentState();
    if (payload) handleLiveState(payload);
  } catch { }

  syncSegments();
}

async function setTheme(theme) {
  if (!['dark', 'light'].includes(theme)) return;
  state.settings.theme = theme;
  applyTheme(theme);

  try {
    await bridge.updateSettings({ theme });
  } catch { }
}

async function togglePin() {
  if (!window.api) {
    state.settings.alwaysOnTop = !state.settings.alwaysOnTop;
    syncPin();
    return;
  }

  try {
    const pinned = await bridge.windowAction('pin');
    if (typeof pinned === 'boolean') {
      state.settings.alwaysOnTop = pinned;
      syncPin();
    }
  } catch {
    showToast('Не удалось закрепить окно');
  }
}

function openSheet() {
  state.sheetOpen = true;
  els.sheet.classList.add('open');
  els.sheet.setAttribute('aria-hidden', 'false');
  setTimeout(() => els.sheetClose.focus(), 80);
}

function closeSheet() {
  state.sheetOpen = false;
  els.sheet.classList.remove('open');
  els.sheet.setAttribute('aria-hidden', 'true');
  els.settingsBtn.focus();
}

function showToast(message, duration = 2400) {
  if (!message) return;
  els.toast.textContent = message;
  els.toast.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    els.toast.classList.remove('show');
  }, duration);
}

async function openYandexMusic() {
  try {
    const result = await bridge.openYandex();
    if (result && result.ok) {
      showToast(
        result.how === 'app'
          ? 'Открываю Яндекс Музыку…'
          : 'Открываю веб-плеер Яндекс Музыки…'
      );
    } else {
      showToast('Не удалось открыть Яндекс Музыку');
    }
  } catch {
    showToast('Не удалось открыть Яндекс Музыку');
  }
}

async function openCurrentTrack() {
  if (!state.liveActive) {
    await openYandexMusic();
    return;
  }

  const track = currentTrackInfo();
  showToast('Открываю поиск в Яндекс Музыке…');

  try {
    await bridge.openTrack({ title: track.title, artist: track.artist });
  } catch {
    showToast('Не удалось открыть ссылку');
  }
}

async function reconnect() {
  try {
    const ok = await bridge.restartProvider();
    if (!ok) {
      showToast('Медиамост недоступен на этой системе');
      return;
    }

    showToast('Переподключаю медиасессию…');
    setTimeout(() => {
      if (!state.liveActive) {
        showToast('Сессия не найдена. Проверьте, что трек играет.');
      }
    }, 3200);
  } catch {
    showToast('Не удалось переподключиться');
  }
}

/* ============================================================
   События
   ============================================================ */
function bindEvents() {
  els.playBtn.addEventListener('click', togglePlay);
  els.nextBtn.addEventListener('click', nextTrack);
  els.prevBtn.addEventListener('click', previousTrack);
  els.openBtn.addEventListener('click', openCurrentTrack);
  els.pinBtn.addEventListener('click', togglePin);
  els.settingsBtn.addEventListener('click', openSheet);
  els.sheetClose.addEventListener('click', closeSheet);

  els.minBtn.addEventListener('click', () => bridge.windowAction('minimize'));
  els.closeBtn.addEventListener('click', () => bridge.windowAction('close'));

  els.modeSeg.querySelectorAll('button').forEach((button) => {
    button.addEventListener('click', () => setMode(button.dataset.mode));
  });

  els.themeSeg.querySelectorAll('button').forEach((button) => {
    button.addEventListener('click', () => setTheme(button.dataset.theme));
  });

  els.pinSwitch.addEventListener('click', togglePin);
  els.openYandexBtn.addEventListener('click', openYandexMusic);
  els.reconnectBtn.addEventListener('click', reconnect);

  els.progress.addEventListener('pointerdown', onProgressPointerDown);
  els.progress.addEventListener('pointermove', onProgressPointerMove);
  els.progress.addEventListener('pointerup', onProgressPointerUp);
  els.progress.addEventListener('pointercancel', onProgressPointerCancel);

  els.progress.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      event.stopPropagation();
      const step = event.shiftKey ? 15 : 5;
      seekBy(event.key === 'ArrowRight' ? step : -step);
      return;
    }

    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      event.stopPropagation();
      const duration = currentTrackInfo().duration;
      if (duration > 0) commitPosition(event.key === 'Home' ? 0 : duration);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (state.sheetOpen) {
        event.preventDefault();
        closeSheet();
      }
      return;
    }

    const target = event.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;

    if (event.code === 'Space') {
      if (target && target.closest && target.closest('button, a, [role="slider"]')) return;
      event.preventDefault();
      togglePlay();
      return;
    }

    if (
      (event.key === 'ArrowRight' || event.key === 'ArrowLeft') &&
      !state.sheetOpen
    ) {
      if (target && target.closest && target.closest('button, a, [role="slider"]')) return;
      event.preventDefault();
      const step = event.shiftKey ? 15 : 5;
      seekBy(event.key === 'ArrowRight' ? step : -step);
    }
  });

  document.addEventListener('dragstart', (event) => event.preventDefault());

// Pause the blurred blob animations while the window is hidden.
document.addEventListener('visibilitychange', () => {
  document.body.classList.toggle('is-hidden', document.hidden);
});
}

/* ============================================================
   Запуск
   ============================================================ */
async function boot() {
  if (!window.api) {
    document.body.classList.add('is-browser');
    const controls = document.querySelector('.window-controls');
    if (controls) controls.style.display = 'none';
  }

  try {
    state.bootstrap = await bridge.bootstrap();
    if (state.bootstrap && state.bootstrap.settings) {
      state.settings = { ...state.settings, ...state.bootstrap.settings };
    }
  } catch (error) {
    window.__errors.push('bootstrap: ' + (error?.message || error));
  }

  applyTheme(state.settings.theme);
  syncSegments();
  syncPin();
  bindEvents();

  state.demoBase = nowSec();
  setDemoTrack(0, { animate: false, reset: true });
  restartDemoClock();
  tick();
  scheduleTick();

  bridge.onState(handleLiveState);

  try {
    const payload = await bridge.currentState();
    if (payload) handleLiveState(payload);
  } catch (error) {
    window.__errors.push('currentState: ' + (error?.message || error));
  }

  // First-run hint: if the widget fell back to the demo, tell the user how to
  // get real Yandex Music data. Shown once, and disappears as soon as a real
  // track arrives.
  if (
    !state.liveActive &&
    state.settings.mode !== 'demo' &&
    state.bootstrap &&
    state.bootstrap.platform === 'win32'
  ) {
    state.startupHint = true;
    setTimeout(() => {
      if (state.startupHint && !state.liveActive) {
        showToast('Включите трек в Яндекс Музыке — виджет подхватит его', 4200);
      }
    }, 1600);
  }
}

boot();
