'use strict';

/* ============================================================
   Liquid Glass Music — Dynamic Island overlay
   Standalone renderer for the always-on-top island window.
   ============================================================ */
(() => {
  const PLAY_ICON =
    '<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true"><path d="M8 5.4v13.2a1 1 0 0 0 1.54.84l10.1-6.6a1 1 0 0 0 0-1.68L9.54 4.56A1 1 0 0 0 8 5.4Z"/></svg>';
  const PAUSE_ICON =
    '<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true"><path d="M7 5h3.3v14H7zM13.7 5H17v14h-3.3z"/></svg>';
  const PREV_ICON =
    '<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true"><path d="M6.5 5h2.2v14H6.5zM19 5.65v12.7a1 1 0 0 1-1.55.83l-8.8-6.35a1 1 0 0 1 0-1.66l8.8-6.35A1 1 0 0 1 19 5.65Z"/></svg>';
  const NEXT_ICON =
    '<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true"><path d="M15.3 5h2.2v14h-2.2zM5 5.65v12.7a1 1 0 0 0 1.55.83l8.8-6.35a1 1 0 0 0 0-1.66l-8.8-6.35A1 1 0 0 0 5 5.65Z"/></svg>';
  const CHEVRON_ICON =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

  const api = window.api || {
    onState: () => () => {},
    currentState: async () => null,
    command: async () => false,
  };

  const PRESETS = ['compact', 'expanded', 'full'];
  const STORAGE_KEY = 'lg.dynamicIsland.preset';
  const DEFAULT_PALETTE = ['#8b5cf6', '#22d3ee', '#7ef7c6'];

  let preset = 'expanded';
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (PRESETS.includes(saved)) preset = saved;
  } catch {
    /* ignore storage restrictions */
  }

  let track = null;
  let trackKey = '';
  let cover = '';
  let lastCover = '';
  let playing = false;
  let positionBase = 0;
  let positionAt = performance.now();
  let paintedPlaying = null;
  let flashTimer = 0;
  let paletteSeq = 0;
  let paletteKey = '';
  let paletteCover = '';

  const root = document.getElementById('lgIsland');
  const node = (id) => document.getElementById(id);

  const els = {
    main: root.querySelector('.lg-di-main'),
    cover: node('lgDiCover'),
    title: node('lgDiTitle'),
    artist: node('lgDiArtist'),
    badge: node('lgDiBadge'),
    playSm: node('lgDiPlaySm'),
    cycle: node('lgDiCycle'),
    fill: node('lgDiFill'),
    current: node('lgDiCurrent'),
    total: node('lgDiTotal'),
    prev: node('lgDiPrev'),
    play: node('lgDiPlay'),
    next: node('lgDiNext'),
    presets: Array.from(root.querySelectorAll('[data-preset]')),
  };

  els.prev.innerHTML = PREV_ICON;
  els.next.innerHTML = NEXT_ICON;
  els.cycle.innerHTML = CHEVRON_ICON;

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

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function hashString(text) {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

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

  function hexToRgba(hex, alpha) {
    const clean = String(hex || '').replace('#', '');
    const value =
      clean.length === 3
        ? clean
            .split('')
            .map((part) => part + part)
            .join('')
        : clean.padEnd(6, '0').slice(0, 6);
    const number = parseInt(value, 16);
    const r = (number >> 16) & 255;
    const g = (number >> 8) & 255;
    const b = number & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function applyIslandPalette(colors) {
    const [a, b, c] =
      Array.isArray(colors) && colors.length >= 3 ? colors : DEFAULT_PALETTE;

    root.style.setProperty('--di-accent', a);
    root.style.setProperty('--di-accent-2', b);
    root.style.setProperty('--di-accent-3', c);
    root.style.setProperty('--di-tint-1', hexToRgba(a, 0.3));
    root.style.setProperty('--di-tint-2', hexToRgba(b, 0.22));
    root.style.setProperty('--di-edge', hexToRgba(a, 0.28));
  }

  async function updateIslandPalette(src, seed) {
    const sequence = ++paletteSeq;
    if (!src) {
      applyIslandPalette(fallbackPalette(seed || 'liquid'));
      return;
    }

    try {
      const colors = await extractPalette(src);
      if (sequence !== paletteSeq) return;
      applyIslandPalette(colors);
    } catch {
      if (sequence !== paletteSeq) return;
      applyIslandPalette(fallbackPalette(seed || 'liquid'));
    }
  }

  function currentPosition() {
    if (!track) return 0;
    const elapsed = playing ? (performance.now() - positionAt) / 1000 : 0;
    return Math.max(0, positionBase + elapsed);
  }

  function setPreset(next, manual = false) {
    if (!PRESETS.includes(next)) return;
    preset = next;
    root.classList.remove('mode-compact', 'mode-expanded', 'mode-full');
    root.classList.add('mode-' + preset);
    root.dataset.preset = preset;
    els.presets.forEach((button) => {
      button.classList.toggle('on', button.dataset.preset === preset);
    });
    if (manual) {
      try {
        localStorage.setItem(STORAGE_KEY, preset);
      } catch {
        /* ignore */
      }
    }
  }

  function paintPlay(next) {
    if (paintedPlaying === next) return;
    paintedPlaying = next;
    els.playSm.innerHTML = next ? PAUSE_ICON : PLAY_ICON;
    els.play.innerHTML = next ? PAUSE_ICON : PLAY_ICON;
    const label = next ? 'Пауза' : 'Воспроизвести';
    els.playSm.setAttribute('aria-label', label);
    els.play.setAttribute('aria-label', label);
  }

  function flashTrack() {
    window.clearTimeout(flashTimer);
    root.classList.remove('is-new');
    void root.offsetWidth;
    root.classList.add('is-new');
    flashTimer = window.setTimeout(() => root.classList.remove('is-new'), 850);
  }

  function refresh() {
    const active = Boolean(track);
    const duration = active ? Math.max(0, (track.durationMs || 0) / 1000) : 0;
    const position = active ? Math.min(currentPosition(), duration || Infinity) : 0;

    els.title.textContent = active ? track.title || 'Без названия' : 'Liquid Glass Music';
    els.artist.textContent = active
      ? [track.artist, track.album].filter(Boolean).join(' · ') || 'Неизвестный исполнитель'
      : 'Нет активного трека';
    els.badge.textContent = active ? 'LIVE' : 'IDLE';
    els.current.textContent = formatTime(position);
    els.total.textContent = formatTime(duration);
    els.fill.style.width = duration > 0 ? ((position / duration) * 100).toFixed(2) + '%' : '0%';

    root.classList.toggle('is-live', active);
    root.classList.toggle('is-demo', !active);
    root.classList.toggle('is-paused', !active || !playing);
    paintPlay(active && playing);

    if (cover !== lastCover) {
      lastCover = cover;
      if (cover) {
        els.cover.src = cover;
        root.classList.add('has-cover');
      } else {
        els.cover.removeAttribute('src');
        root.classList.remove('has-cover');
      }
    }
  }

  function applyPayload(payload) {
    if (!payload || !payload.found || !payload.track) {
      track = null;
      trackKey = '';
      cover = '';
      playing = false;
      positionBase = 0;
      positionAt = performance.now();
      if (paletteKey !== '__idle__') {
        paletteKey = '__idle__';
        paletteCover = '';
        updateIslandPalette('', 'liquid');
      }
      refresh();
      return;
    }

    const nextTrack = payload.track;
    const nextKey = [
      nextTrack.aumid || '',
      nextTrack.title || '',
      nextTrack.artist || '',
      nextTrack.album || '',
    ].join('|');
    const isNew = nextKey !== trackKey;
    const wasPlaying = playing;
    const reported = Math.max(0, (nextTrack.positionMs || 0) / 1000);
    const estimated = currentPosition();

    track = nextTrack;
    trackKey = nextKey;

    if (payload.cover) {
      cover = payload.cover;
    } else if (isNew) {
      cover = '';
    }

    if (isNew || paletteKey !== nextKey || paletteCover !== cover) {
      paletteKey = nextKey;
      paletteCover = cover;
      updateIslandPalette(cover, nextKey);
    }

    const nextPlaying = nextTrack.status === 'playing';
    if (isNew || nextPlaying !== wasPlaying || Math.abs(reported - estimated) > 1.2) {
      positionBase = reported;
      positionAt = performance.now();
    }
    playing = nextPlaying;

    if (isNew && nextKey) flashTrack();
    refresh();
  }

  function setPlaying(next) {
    if (playing === next) return;
    positionBase = currentPosition();
    positionAt = performance.now();
    playing = next;
    refresh();
  }

  async function togglePlay() {
    const before = playing;
    setPlaying(!before);
    const ok = await api.command({ action: 'playpause' });
    if (!ok) {
      setPlaying(before);
      refresh();
    }
  }

  async function skip(action) {
    positionBase = 0;
    positionAt = performance.now();
    refresh();
    await api.command({ action });
  }

  function cyclePreset() {
    const index = PRESETS.indexOf(preset);
    setPreset(PRESETS[(index + 1) % PRESETS.length], true);
  }

  els.main.addEventListener('click', (event) => {
    if (event.target.closest('button')) return;
    cyclePreset();
  });

  els.cycle.addEventListener('click', (event) => {
    event.stopPropagation();
    cyclePreset();
  });

  const onToggle = (event) => {
    event.stopPropagation();
    togglePlay();
  };
  els.playSm.addEventListener('click', onToggle);
  els.play.addEventListener('click', onToggle);

  els.prev.addEventListener('click', (event) => {
    event.stopPropagation();
    skip('prev');
  });

  els.next.addEventListener('click', (event) => {
    event.stopPropagation();
    skip('next');
  });

  els.presets.forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      setPreset(button.dataset.preset, true);
    });
  });

  setPreset(preset, false);
  refresh();

  api.onState(applyPayload);
  api
    .currentState()
    .then((payload) => applyPayload(payload))
    .catch(() => refresh());

  window.setInterval(refresh, 250);
})();
