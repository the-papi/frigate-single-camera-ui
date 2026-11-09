'use strict';
/*
 * Frigate single camera UI – a simple Frigate viewer (PWA).
 *
 * All times are unix seconds (wall clock). Recorded playback uses Frigate's
 * VOD HLS endpoint one clock-hour at a time. VOD concatenates segments and
 * skips gaps, so we map between video time and wall time using the
 * recording segment list of that hour.
 */

const $ = (id) => document.getElementById(id);
const video = $('video');
const liveImg = $('live');
const canvas = $('timeline');
const ctx = canvas.getContext('2d');

const HOUR = 3600;
const MIN_SPAN = 60;            // 1 minute
const MAX_SPAN = 3 * 24 * HOUR; // 3 days
const MAX_SHARE_CLIP = 15 * 60; // clips longer than this are not buffered in memory on phones
const now = () => Date.now() / 1000;
const floorHour = (t) => Math.floor(t / HOUR) * HOUR;

const state = {
  camera: null,
  mode: 'live',               // 'live' | 'playback'
  cur: now(),                 // playhead (wall time)
  view: { start: now() - HOUR, end: now() + 180 },
  win: null,                  // loaded HLS window {camera, start, segs}
  rec: null,                  // {start, camera} while recording a clip
  rate: 1,
  following: true,            // auto-scroll timeline with playhead
  previewEnd: null,
};

let hls = null;

// ---------------------------------------------------------------- helpers

function toast(msg, isError = false, ms = 3500) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'snackbar' + (isError ? ' error' : '');
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), ms);
}

async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  if (r.status === 401) {
    onUnauthorized();
    throw new Error('Not signed in');
  }
  if (!r.ok) {
    let detail = r.statusText;
    try { const j = await r.json(); detail = j.message || j.detail || detail; } catch {}
    throw new Error(detail || `HTTP ${r.status}`);
  }
  return r.json();
}

const pad = (n) => String(n).padStart(2, '0');
function fmtTime(t, withDate = true, withSec = true) {
  const d = new Date(t * 1000);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}` + (withSec ? `:${pad(d.getSeconds())}` : '');
  if (!withDate) return time;
  const today = new Date().toDateString() === d.toDateString();
  const yesterday = new Date(Date.now() - 86400000).toDateString() === d.toDateString();
  const day = today ? 'Today' : yesterday ? 'Yesterday'
    : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  return `${day} ${time}`;
}
function fmtDur(s) {
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

// ------------------------------------------------- recordings (per hour)

const recCache = new Map(); // key camera:hour -> {segs, fetchedAt, promise}

function getHour(camera, hour, fresh = false) {
  const key = `${camera}:${hour}`;
  const c = recCache.get(key);
  const isCurrent = hour + HOUR > now() - 30;
  const stale = c && isCurrent && now() - c.fetchedAt > 20;
  if (c && !fresh && !stale) return c.promise;
  if (c && c.loading) return c.promise;

  const entry = c || { segs: [], fetchedAt: 0 };
  entry.loading = true;
  entry.promise = api(`/api/${encodeURIComponent(camera)}/recordings?after=${hour}&before=${hour + HOUR}`)
    .then((rows) => {
      entry.segs = rows
        .map((r) => ({
          s: r.start_time,
          e: r.start_time + (r.duration || r.end_time - r.start_time),
          motion: r.motion || 0,
        }))
        .filter((r) => r.e > hour && r.s < hour + HOUR && r.e > r.s)
        .sort((a, b) => a.s - b.s);
      entry.fetchedAt = now();
      dirty = true;
      thresholdDirty = true;
      return entry.segs;
    })
    .catch((e) => {
      recCache.delete(key);
      throw e;
    })
    .finally(() => (entry.loading = false));
  recCache.set(key, entry);
  return entry.promise;
}

function ensureViewData() {
  if (!state.camera || !signedIn) return;
  const end = Math.min(state.view.end, now());
  for (let h = floorHour(state.view.start); h < end; h += HOUR) {
    getHour(state.camera, h).catch((e) => signedIn && toast(`Failed to load recordings: ${e.message}`, true));
  }
}

// ------------------------------------------------- significant motion

// A segment counts as "significant" motion when its motion value is at least
// SIG_FRACTION of the typical strong motion (90th percentile of everything
// loaded for this camera). Significant segments closer than MOTION_GAP
// seconds are merged into one motion event.
const SIG_FRACTION = 0.2;
const MOTION_GAP = 30;
const PREROLL = 2;

let thresholdDirty = true, thresholdCache = 1;
function motionThreshold() {
  if (!thresholdDirty) return thresholdCache;
  const vals = [];
  for (const [key, c] of recCache) {
    if (!key.startsWith(state.camera + ':')) continue;
    for (const sg of c.segs) if (sg.motion > 0) vals.push(sg.motion);
  }
  vals.sort((a, b) => a - b);
  thresholdCache = vals.length ? Math.max(1, vals[Math.floor(vals.length * 0.9)] * SIG_FRACTION) : 1;
  thresholdDirty = false;
  return thresholdCache;
}

/** Yield recording segments hour by hour going forward (dir=1) or backward (dir=-1) from t. */
async function* segmentsFrom(cam, t, dir, maxHours) {
  const seen = new Set();
  let hour = floorHour(t);
  for (let i = 0; i < maxHours; i++, hour += dir * HOUR) {
    if (dir > 0 && hour > now()) return;
    const segs = await getHour(cam, hour);
    const list = dir > 0 ? segs : [...segs].reverse();
    for (const sg of list) {
      if (seen.has(sg.s)) continue; // segments crossing an hour boundary show up twice
      seen.add(sg.s);
      yield sg;
    }
  }
}

async function findMotion(dir) {
  const cam = state.camera;
  const from = playheadTime();
  await getHour(cam, floorHour(from)).catch(() => {});
  const thr = motionThreshold();
  const sig = (sg) => sg.motion >= thr;

  if (dir > 0) {
    // first significant segment after `from` that isn't part of the event we're in
    let lastSigEnd = -Infinity;
    for await (const sg of segmentsFrom(cam, from - MOTION_GAP, 1, 72)) {
      if (!sig(sg)) continue;
      if (sg.s > from + PREROLL + 1 && sg.s - lastSigEnd > MOTION_GAP) return sg.s;
      lastSigEnd = Math.max(lastSigEnd, sg.e);
    }
    return null;
  }
  // backward: the start of the nearest event that begins before `from`
  // (pressing it again within the first seconds of an event goes to the one before)
  const limit = from - PREROLL - 3;
  let cand = null;
  for await (const sg of segmentsFrom(cam, limit, -1, 72)) {
    if (!sig(sg) || sg.s >= limit) continue;
    if (cand && cand.s - sg.e > MOTION_GAP) return cand.s;
    cand = sg;
  }
  return cand ? cand.s : null;
}

let motionBusy = false;
async function skipMotion(dir) {
  if (motionBusy || !state.camera) return;
  motionBusy = true;
  const btn = $(dir > 0 ? 'nextMotion' : 'prevMotion');
  btn.classList.add('busy');
  try {
    const t = await findMotion(dir);
    if (t == null) {
      toast(dir > 0 ? 'No newer motion' : 'No earlier motion in the last 3 days');
      return;
    }
    const target = t - PREROLL;
    state.following = true;
    if (target < state.view.start || target > state.view.end) centerView(target, 0.3);
    await playAt(target);
  } catch (e) {
    if (signedIn) toast(`Motion search failed: ${e.message}`, true);
  } finally {
    motionBusy = false;
    btn.classList.remove('busy');
  }
}

// ---------------------------------------------------- video <-> wall time

function clipSegs(segs, start, end) {
  return segs
    .map((s) => ({ s: Math.max(s.s, start), e: Math.min(s.e, end) }))
    .filter((s) => s.e > s.s);
}

function wallToVideo(t) {
  let v = 0;
  for (const s of state.win.segs) {
    if (t <= s.s) break;
    v += Math.min(t, s.e) - s.s;
  }
  return v;
}

function videoToWall(v) {
  const segs = state.win.segs;
  for (const s of segs) {
    const d = s.e - s.s;
    if (v <= d) return s.s + v;
    v -= d;
  }
  return segs.length ? segs[segs.length - 1].e : state.win.start;
}

// --------------------------------------------------------------- playback

const canFullscreen = document.fullscreenEnabled || !!video.webkitEnterFullscreen;

function setMode(mode) {
  state.mode = mode;
  const live = mode === 'live';
  $('mode').innerHTML = `<span class="dot"></span>${live ? 'LIVE' : 'RECORDING'}`;
  $('mode').className = 'badge ' + (live ? 'live' : 'rec');
  liveImg.hidden = !live;
  video.hidden = live;
  $('golive').hidden = live;
  $('speedWrap').hidden = live;
  // iPhones can only fullscreen <video>, not the live snapshot
  $('fullscreen').hidden = !(document.fullscreenEnabled || (!live && video.webkitEnterFullscreen));
  if (live) {
    video.pause();
    $('spinner').hidden = true;
    startLive();
  }
  updatePlayBtn();
}

let liveTimer = null;
let liveToken = 0;
function stopLive() { liveToken++; clearTimeout(liveTimer); }
function startLive() {
  clearTimeout(liveTimer);
  const token = ++liveToken;
  const tick = () => {
    if (state.mode !== 'live' || token !== liveToken || !state.camera) return;
    if (document.hidden) { liveTimer = setTimeout(tick, 1000); return; }
    const img = new Image();
    img.onload = () => {
      if (token !== liveToken) return;
      liveImg.src = img.src;
      liveTimer = setTimeout(tick, 500);
    };
    img.onerror = () => { liveTimer = setTimeout(tick, 3000); };
    img.src = `/api/${encodeURIComponent(state.camera)}/latest.jpg?h=720&height=720&_=${Date.now()}`;
  };
  tick();
}

function goLive() {
  if (hls) { hls.destroy(); hls = null; }
  state.win = null;
  state.following = true;
  setMode('live');
  state.cur = now();
  centerView(state.cur, 0.85);
}

/**
 * Start recorded playback at wall time t (snapped to the nearest recording
 * if t falls into a gap). dir < 0 means "searching backwards".
 */
async function playAt(t, { autoplay = true, dir = 1, previewEnd = null } = {}) {
  const cam = state.camera;
  state.previewEnd = previewEnd;
  for (let guard = 0; guard < 24 * 7; guard++) {
    if (t >= now() - 5) { goLive(); return; }
    const hour = floorHour(t);
    const isCurrent = hour + HOUR > now() - 60;
    let segs;
    try {
      segs = clipSegs(await getHour(cam, hour, isCurrent), hour, hour + HOUR);
    } catch (e) {
      if (signedIn) toast(`Failed to load recordings: ${e.message}`, true);
      return;
    }
    if (cam !== state.camera) return;

    if (dir < 0) {
      // Last segment starting before t; if t is in a gap after it, jump near its end.
      const prev = [...segs].reverse().find((s) => s.s <= t);
      if (prev) {
        if (t > prev.e) t = Math.max(prev.s, prev.e - 10);
        return loadAndSeek(cam, hour, segs, t, autoplay);
      }
      t = hour - 0.001; // try previous hour
      continue;
    }

    const seg = segs.find((s) => s.e > t + 0.05);
    if (seg) return loadAndSeek(cam, hour, segs, Math.max(t, seg.s), autoplay);
    t = hour + HOUR; // nothing left in this hour, try the next one
  }
  toast('No recordings found there', true);
}

function loadAndSeek(cam, hour, segs, t, autoplay) {
  setMode('playback');
  state.cur = t;
  const same = state.win && state.win.camera === cam && state.win.start === hour &&
               state.win.segs.length === segs.length;
  if (same) {
    video.currentTime = wallToVideo(t);
    if (autoplay) video.play().catch(() => {});
    return;
  }

  state.win = { camera: cam, start: hour, segs };
  const startPos = wallToVideo(t);
  const url = `/vod/${encodeURIComponent(cam)}/start/${hour}/end/${hour + HOUR}/index.m3u8`;
  $('spinner').hidden = false;

  if (hls) { hls.destroy(); hls = null; }
  const onReady = () => {
    video.currentTime = startPos;
    video.playbackRate = state.rate;
    if (autoplay) video.play().catch(() => {});
  };

  if (window.Hls && Hls.isSupported()) {
    hls = new Hls({ startPosition: startPos, maxBufferLength: 30, enableWorker: true });
    hls.on(Hls.Events.MANIFEST_PARSED, onReady);
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;
      if (data.response?.code === 401) { onUnauthorized(); return; }
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) { hls.recoverMediaError(); return; }
      toast(`Playback error: ${data.details}`, true);
      $('spinner').hidden = true;
    });
    hls.loadSource(url);
    hls.attachMedia(video);
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    // iOS Safari: native HLS
    video.src = url;
    video.addEventListener('loadedmetadata', onReady, { once: true });
  } else {
    toast('This browser cannot play HLS', true);
  }
}

function togglePlay() {
  if (state.mode === 'live') {
    // "Pause" live: switch to recordings just before now.
    playAt(now() - 30, { dir: -1, autoplay: false });
    return;
  }
  if (video.paused) video.play().catch(() => {}); else video.pause();
}

function step(sec) {
  const t = playheadTime() + sec;
  playAt(t, { dir: Math.sign(sec), autoplay: state.mode === 'live' || !video.paused });
}

const playheadTime = () => (state.mode === 'live' ? now() : state.cur);

function updatePlayBtn() {
  const playing = state.mode === 'live' || !video.paused;
  $('play').firstElementChild.textContent = playing ? 'pause' : 'play_arrow';
}

video.addEventListener('timeupdate', () => {
  if (state.mode !== 'playback' || !state.win) return;
  state.cur = videoToWall(video.currentTime);
  if (state.previewEnd && state.cur >= state.previewEnd) {
    video.pause();
    state.previewEnd = null;
  }
});
video.addEventListener('playing', () => { $('spinner').hidden = true; updatePlayBtn(); });
video.addEventListener('pause', updatePlayBtn);
video.addEventListener('play', updatePlayBtn);
video.addEventListener('waiting', () => { $('spinner').hidden = false; });
video.addEventListener('canplay', () => { $('spinner').hidden = true; });
video.addEventListener('ended', () => {
  if (state.mode !== 'playback' || !state.win) return;
  // Continue into the next hour (or refresh the current one).
  const segs = state.win.segs;
  const end = segs.length ? segs[segs.length - 1].e : state.win.start + HOUR;
  playAt(end + 0.1, { previewEnd: state.previewEnd });
});

// --------------------------------------------------------------- timeline

let dirty = true;
let cssW = 0, cssH = 0;

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  cssW = canvas.clientWidth;
  cssH = canvas.clientHeight;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  dirty = true;
}
new ResizeObserver(resizeCanvas).observe(canvas);

// Timeline colors come from the CSS theme tokens (light/dark aware).
let C = {};
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  const g = (n) => cs.getPropertyValue(n).trim();
  C = {
    rec: g('--tl-rec'), motion: g('--md-primary'), label: g('--md-on-surface-variant'),
    grid: g('--tl-grid'), gridStrong: g('--tl-grid-strong'), future: g('--tl-future'),
    sel: g('--tl-sel'), selEdge: g('--tl-sel-edge'), playhead: g('--md-error'),
    now: g('--md-outline'), tipBg: g('--md-inverse-surface'), tipFg: g('--md-inverse-on-surface'),
  };
  dirty = true;
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', readColors);
const FONT = '500 11px Roboto, system-ui, sans-serif';

const span = () => state.view.end - state.view.start;
const tToX = (t) => ((t - state.view.start) / span()) * cssW;
const xToT = (x) => state.view.start + (x / cssW) * span();

function setView(start, end) {
  let s = end - start;
  s = Math.min(MAX_SPAN, Math.max(MIN_SPAN, s));
  const mid = (start + end) / 2;
  start = mid - s / 2;
  end = mid + s / 2;
  const maxEnd = now() + s * 0.25; // don't scroll too far into the future
  if (end > maxEnd) { start -= end - maxEnd; end = maxEnd; }
  state.view = { start, end };
  dirty = true;
  ensureViewData();
}

function centerView(t, frac = 0.5) {
  const s = span();
  setView(t - s * frac, t + s * (1 - frac));
}

function zoom(factor, anchorT) {
  if (anchorT == null) anchorT = state.cur;
  const { start, end } = state.view;
  setView(anchorT - (anchorT - start) * factor, anchorT + (end - anchorT) * factor);
}

const TICK_STEPS = [10, 30, 60, 300, 600, 900, 1800, 3600, 3 * 3600, 6 * 3600, 12 * 3600, 86400];

function draw() {
  const W = cssW, H = cssH;
  if (!W) return;
  ctx.clearRect(0, 0, W, H);

  const AXIS_H = 20;
  const top = AXIS_H, bottom = H - 4, barH = bottom - top;
  const tNow = now();

  // future area
  const xNow = tToX(tNow);
  if (xNow < W) {
    ctx.fillStyle = C.future;
    ctx.fillRect(Math.max(0, xNow), 0, W, H);
  }

  // recordings coverage + motion, bucketed per 2px
  const BW = 2;
  const nb = Math.ceil(W / BW);
  const cover = new Uint8Array(nb);
  const motion = new Float32Array(nb);
  const values = [];
  if (state.camera) {
    for (let h = floorHour(state.view.start); h < state.view.end; h += HOUR) {
      const c = recCache.get(`${state.camera}:${h}`);
      if (!c) continue;
      for (const s of c.segs) {
        if (s.e < state.view.start || s.s > state.view.end) continue;
        const b0 = Math.max(0, Math.floor(tToX(s.s) / BW));
        const b1 = Math.min(nb - 1, Math.floor(tToX(s.e) / BW));
        for (let b = b0; b <= b1; b++) {
          cover[b] = 1;
          if (s.motion > motion[b]) motion[b] = s.motion;
        }
        if (s.motion > 0) values.push(s.motion);
      }
    }
  }
  // normalize against ~95th percentile so one big spike doesn't flatten everything
  values.sort((a, b) => a - b);
  const ref = values.length ? Math.max(1, values[Math.floor(values.length * 0.95)]) : 1;

  ctx.fillStyle = C.rec;
  for (let b = 0; b < nb; b++) if (cover[b]) ctx.fillRect(b * BW, top, BW, barH);

  ctx.fillStyle = C.motion;
  const thr = motionThreshold();
  for (let b = 0; b < nb; b++) {
    if (!motion[b]) continue;
    const v = Math.min(1, Math.sqrt(motion[b] / ref));
    const h = Math.max(2, v * (barH - 2));
    ctx.globalAlpha = motion[b] >= thr ? 1 : 0.35; // minor motion is ignored by the skip buttons
    ctx.fillRect(b * BW, bottom - h, BW - 0.5, h);
  }
  ctx.globalAlpha = 1;

  // ticks
  const s = span();
  const step = TICK_STEPS.find((st) => (st / s) * W >= 80) || 86400;
  const tz = -new Date(state.view.start * 1000).getTimezoneOffset() * 60;
  let t = Math.floor((state.view.start + tz) / step) * step - tz;
  ctx.font = FONT;
  ctx.textBaseline = 'middle';
  for (; t <= state.view.end; t += step) {
    const x = Math.round(tToX(t)) + 0.5;
    const d = new Date(t * 1000);
    const midnight = d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0;
    ctx.strokeStyle = midnight ? C.gridStrong : C.grid;
    ctx.beginPath(); ctx.moveTo(x, AXIS_H - 6); ctx.lineTo(x, H); ctx.stroke();
    ctx.fillStyle = C.label;
    const label = midnight || step >= 86400
      ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
      : fmtTime(t, false, step < 60);
    ctx.fillText(label, x + 3, AXIS_H / 2);
  }

  // now line
  if (xNow >= 0 && xNow <= W) {
    ctx.strokeStyle = C.now;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(xNow + 0.5, top); ctx.lineTo(xNow + 0.5, H); ctx.stroke();
    ctx.setLineDash([]);
  }

  // clip being recorded: from its start to the playhead
  if (state.rec && state.rec.camera === state.camera) {
    const a = state.rec.start, b = playheadTime();
    const x0 = tToX(Math.min(a, b)), x1 = tToX(Math.max(a, b));
    ctx.fillStyle = 'rgba(255, 59, 48, 0.25)';
    ctx.fillRect(x0, top, Math.max(2, x1 - x0), barH);
    ctx.fillStyle = '#ff3b30';
    ctx.fillRect(Math.round(tToX(a)) - 1, top, 2, barH);
  }

  // playhead
  const xp = tToX(state.cur);
  if (xp >= -2 && xp <= W + 2) {
    ctx.fillStyle = C.playhead;
    ctx.fillRect(Math.round(xp) - 1, top - 4, 2, H - top + 4);
    ctx.beginPath();
    ctx.moveTo(xp - 5, top - 6); ctx.lineTo(xp + 5, top - 6); ctx.lineTo(xp, top);
    ctx.fill();
  }

  // hover label
  const lx0 = hoverX;
  if (lx0 != null) {
    const ht = xToT(lx0);
    const txt = fmtTime(ht, s > 20 * HOUR);
    ctx.font = FONT;
    const tw = ctx.measureText(txt).width + 12;
    const lx = Math.min(W - tw, Math.max(0, lx0 - tw / 2));
    ctx.fillStyle = C.tipBg;
    ctx.beginPath(); ctx.roundRect(lx, 1, tw, 18, 4); ctx.fill();
    ctx.fillStyle = C.tipFg;
    ctx.fillText(txt, lx + 6, 10);
    ctx.fillStyle = C.label;
    ctx.fillRect(lx0, top, 1, barH);
  }
}

let lastDrawnX = null, lastDrawnSec = 0;
function frame() {
  if (state.mode === 'live') state.cur = now();

  // follow the playhead when it nears the right edge
  if (state.following && !drag && !pinch) {
    const s = span();
    if (state.mode === 'live') {
      if (state.cur > state.view.end - s * 0.1) centerView(state.cur, 0.85);
    } else if (!video.paused && (state.cur > state.view.end - s * 0.05 || state.cur < state.view.start)) {
      centerView(state.cur, 0.3);
    }
  }

  const xp = Math.round(tToX(state.cur));
  const sec = Math.floor(now());
  if (dirty || xp !== lastDrawnX || sec !== lastDrawnSec) {
    draw();
    dirty = false;
    lastDrawnX = xp;
    lastDrawnSec = sec;
    $('clock').textContent = fmtTime(state.cur);
    updateRecUI();
  }
  requestAnimationFrame(frame);
}

// ---- timeline interaction: pan, pinch-zoom, tap to seek

let drag = null;   // {x0, view0, moved}
let pinch = null;  // {d0, view0, tMid}
let hoverX = null;
const pointers = new Map();

function pinchInfo() {
  const [a, b] = [...pointers.values()];
  return { d: Math.max(20, Math.abs(a.x - b.x)), mid: (a.x + b.x) / 2 };
}

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.offsetX });
  if (pointers.size === 2) {
    drag = null;
    const { d, mid } = pinchInfo();
    pinch = { d0: d, view0: { ...state.view }, tMid: xToT(mid) };
    state.following = false;
    return;
  }
  if (pointers.size > 2) return;
  drag = { x0: e.offsetX, view0: { ...state.view }, moved: false };
});

canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'mouse') { hoverX = e.offsetX; dirty = true; }
  if (pointers.has(e.pointerId)) pointers.get(e.pointerId).x = e.offsetX;

  if (pinch && pointers.size >= 2) {
    const { d, mid } = pinchInfo();
    const s0 = pinch.view0.end - pinch.view0.start;
    const s1 = Math.min(MAX_SPAN, Math.max(MIN_SPAN, s0 * (pinch.d0 / d)));
    // keep the time that was under the fingers under their (moving) midpoint
    const start = pinch.tMid - (mid / cssW) * s1;
    setView(start, start + s1);
    return;
  }
  if (!drag) return;
  const dx = e.offsetX - drag.x0;
  if (Math.abs(dx) > (e.pointerType === 'mouse' ? 4 : 8)) drag.moved = true;
  if (!drag.moved) return;
  canvas.classList.add('dragging');
  state.following = false;
  const dt = (dx / cssW) * (drag.view0.end - drag.view0.start);
  setView(drag.view0.start - dt, drag.view0.end - dt);
});

function endPointer(e, cancelled) {
  pointers.delete(e.pointerId);
  if (pinch) {
    if (pointers.size < 2) pinch = null;
    return;
  }
  if (!drag) return;
  canvas.classList.remove('dragging');
  const d = drag;
  drag = null;
  if (!cancelled && !d.moved) {
    state.following = true;
    playAt(xToT(e.offsetX));
  }
}
canvas.addEventListener('pointerup', (e) => endPointer(e, false));
canvas.addEventListener('pointercancel', (e) => endPointer(e, true));
canvas.addEventListener('pointerleave', (e) => {
  if (e.pointerType === 'mouse') { hoverX = null; dirty = true; }
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
    state.following = false;
    const dt = (e.deltaX / cssW) * span();
    setView(state.view.start + dt, state.view.end + dt);
  } else {
    zoom(Math.exp(e.deltaY * 0.002), xToT(e.offsetX));
  }
}, { passive: false });

$('zoomIn').onclick = () => zoom(0.5);
$('zoomOut').onclick = () => zoom(2);

// ------------------------------------------------------------------ clips
//
// Like HikConnect: press Record → the playhead time becomes the clip start and
// a REC timer runs while you watch (live or recorded) → press Stop → the clip
// from start to the current playhead is cut by Frigate and offered in a sheet
// (preview, save/share or download).

const MIN_CLIP = 2;           // seconds
const REC_LAG_TIMEOUT = 60;   // max seconds to wait for Frigate to write the last segment

function startRecording() {
  if (!state.camera) return;
  state.rec = { start: playheadTime(), camera: state.camera };
  $('recBtn').setAttribute('aria-pressed', 'true');
  $('recBtn').querySelector('.icon').textContent = 'stop';
  $('recBtn').querySelector('.lbl').textContent = 'Stop';
  $('recBtn').title = 'Stop recording (R)';
  $('recBadge').hidden = false;
  $('player').classList.add('recording');
  updateRecUI();
  if (state.mode === 'playback' && video.paused) video.play().catch(() => {});
}

function updateRecUI() {
  if (!state.rec) return;
  $('recTime').textContent = fmtDur(Math.abs(playheadTime() - state.rec.start));
}

function cancelRecording() {
  state.rec = null;
  $('recBtn').setAttribute('aria-pressed', 'false');
  $('recBtn').querySelector('.icon').textContent = 'fiber_manual_record';
  $('recBtn').querySelector('.lbl').textContent = 'Record';
  $('recBtn').title = 'Record a clip (R)';
  $('recBadge').hidden = true;
  $('player').classList.remove('recording');
  dirty = true;
}

function stopRecording() {
  const rec = state.rec;
  if (!rec) return;
  let a = rec.start, b = playheadTime();
  if (b < a) [a, b] = [b, a]; // user scrubbed backwards while recording
  cancelRecording();
  if (b - a < MIN_CLIP) { toast('Clip too short – record a bit longer', true); return; }
  if (state.mode === 'playback') video.pause();
  finishClip(rec.camera, Math.floor(a), Math.ceil(b));
}

$('recBtn').onclick = () => (state.rec ? stopRecording() : startRecording());

function clipFileName(cam, s, e) {
  const d = new Date(s * 1000);
  return `${cam}_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_` +
         `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}_${e - s}s.mp4`;
}
const clipUrl = (cam, s, e) => `/api/${encodeURIComponent(cam)}/start/${s}/end/${e}/clip.mp4`;

function canShareFiles() {
  try {
    return !!navigator.canShare && navigator.canShare({ files: [new File([''], 'x.mp4', { type: 'video/mp4' })] });
  } catch { return false; }
}

const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('Aborted', 'AbortError')); }, { once: true });
});

// ---- finished clip sheet

let clipJob = null; // {ctl, cam, s, e, file, blobUrl}

function setSheetStatus(text, kind = 'busy', progress = null) {
  const st = $('sheetStatus');
  st.hidden = kind === 'hidden';
  st.className = 'sheet-status' + (kind === 'error' ? ' error' : kind === 'done' ? ' done' : '');
  $('sheetStatusText').textContent = text;
  const pr = $('sheetProgress');
  pr.hidden = kind !== 'busy';
  pr.classList.toggle('indeterminate', progress == null);
  pr.querySelector('.bar').style.width = progress == null ? '' : `${Math.round(progress * 100)}%`;
}

function showDownload(href, name, primary) {
  const a = $('sheetDownload');
  a.href = href;
  a.download = name;
  a.hidden = false;
  a.className = 'btn wide ' + (primary ? 'filled' : 'tonal');
}

async function finishClip(cam, s, e) {
  closeSheet();
  const job = clipJob = { ctl: new AbortController(), cam, s, e, file: null, blobUrl: null };
  const name = clipFileName(cam, s, e);
  const share = canShareFiles();

  $('sheetInfo').textContent = `${fmtTime(s)} → ${fmtTime(e, false)} · ${fmtDur(e - s)}`;
  $('sheetVideo').hidden = true;
  $('sheetShare').hidden = true;
  $('sheetDownload').hidden = true;
  $('sheetClose').textContent = 'Discard';
  $('sheet').hidden = false;

  try {
    // 1) Frigate writes ~10 s segments with some delay – wait until the end is on disk.
    if (e > now() - 120) {
      const deadline = now() + REC_LAG_TIMEOUT;
      setSheetStatus('Waiting for the camera to finish recording…');
      while (now() < deadline) {
        const segs = await getHour(cam, floorHour(e - 1), true);
        if (segs.length && segs[segs.length - 1].e >= e - 1) break;
        await sleep(3000, job.ctl.signal);
      }
    }
    if (job !== clipJob) return;

    // 2) Long clips are not buffered in memory – offer a direct download instead.
    if (e - s > MAX_SHARE_CLIP) {
      setSheetStatus('Long clip – too big for a preview, download it directly.', 'done');
      showDownload(clipUrl(cam, s, e), name, true);
      $('sheetClose').textContent = 'Close';
      return;
    }

    // 3) Fetch the MP4 (Frigate cuts it on the fly) with progress.
    setSheetStatus('Preparing clip…');
    const r = await fetch(clipUrl(cam, s, e), { signal: job.ctl.signal });
    if (r.status === 401) { onUnauthorized(); return; }
    if (!r.ok) {
      let detail = `Frigate returned ${r.status}`;
      try { const j = await r.json(); detail = j.message || j.detail || detail; } catch {}
      throw new Error(detail);
    }
    const total = Number(r.headers.get('content-length')) || 0;
    const reader = r.body.getReader();
    const chunks = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      setSheetStatus(`Downloading… ${(loaded / 1048576).toFixed(1)} MB`, 'busy', total ? loaded / total : null);
    }
    if (job !== clipJob) return;
    const file = new File(chunks, name, { type: 'video/mp4' });
    if (file.size < 1024) throw new Error('No recordings found for this time');

    job.file = file;
    job.blobUrl = URL.createObjectURL(file);
    $('sheetVideo').src = job.blobUrl;
    $('sheetVideo').hidden = false;
    $('sheetInfo').textContent += ` · ${(file.size / 1048576).toFixed(1)} MB`;
    setSheetStatus('', 'hidden');
    $('sheetShare').hidden = !share;
    showDownload(job.blobUrl, name, !share);
    $('sheetClose').textContent = 'Done';
  } catch (err) {
    if (err.name === 'AbortError' || job !== clipJob) return;
    setSheetStatus(`Couldn't create the clip: ${err.message}`, 'error');
    $('sheetClose').textContent = 'Close';
  }
}

function closeSheet() {
  const job = clipJob;
  clipJob = null;
  if (job) {
    job.ctl.abort();
    if (job.blobUrl) setTimeout(() => URL.revokeObjectURL(job.blobUrl), 60000); // let a started download finish
  }
  $('sheet').hidden = true;
  $('sheetVideo').pause();
  $('sheetVideo').removeAttribute('src');
}

$('sheetShare').onclick = async () => {
  if (!clipJob?.file) return;
  try {
    await navigator.share({ files: [clipJob.file], title: clipJob.file.name });
  } catch (err) {
    if (err.name !== 'AbortError') toast(`Sharing failed: ${err.message}`, true);
  }
};

$('sheetClose').onclick = closeSheet;
$('sheet').addEventListener('click', (e) => { if (e.target === $('sheet')) closeSheet(); });

// --------------------------------------------------------------- controls

$('play').onclick = togglePlay;
$('back').onclick = () => step(-10);
$('fwd').onclick = () => step(10);
$('prevMotion').onclick = () => skipMotion(-1);
$('nextMotion').onclick = () => skipMotion(1);
$('golive').onclick = goLive;
$('speed').onchange = (e) => {
  state.rate = Number(e.target.value);
  video.playbackRate = state.rate;
};
$('fullscreen').onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else if (document.fullscreenEnabled) $('player').requestFullscreen().catch(() => {});
  else if (state.mode === 'playback' && video.webkitEnterFullscreen) video.webkitEnterFullscreen(); // iPhone
};
document.addEventListener('fullscreenchange', () => {
  $('fullscreen').firstElementChild.textContent = document.fullscreenElement ? 'fullscreen_exit' : 'fullscreen';
});

document.addEventListener('keydown', (e) => {
  if (!signedIn || e.target.matches('input, select, textarea')) return;
  if (!$('sheet').hidden) { if (e.key === 'Escape') closeSheet(); return; }
  switch (e.key) {
    case ' ': e.preventDefault(); togglePlay(); break;
    case 'ArrowLeft': e.preventDefault(); step(e.shiftKey ? -60 : -10); break;
    case 'ArrowRight': e.preventDefault(); step(e.shiftKey ? 60 : 10); break;
    case 'r': case 'R': $('recBtn').click(); break;
    case 'n': case 'N': skipMotion(1); break;
    case 'p': case 'P': skipMotion(-1); break;
    case 'Escape':
      if (state.rec) { cancelRecording(); toast('Recording discarded'); }
      break;
    case 'l': case 'L': goLive(); break;
    case '+': case '=': zoom(0.5); break;
    case '-': zoom(2); break;
    case 'f': case 'F': $('fullscreen').click(); break;
  }
});

$('camera').onchange = (e) => selectCamera(e.target.value);

function selectCamera(cam) {
  state.camera = cam;
  thresholdDirty = true;
  try { localStorage.setItem('camera', cam); } catch {}
  cancelRecording();
  goLive();
  ensureViewData();
}

// ------------------------------------------------------------------- auth

let signedIn = false;

function stopEverything() {
  signedIn = false;
  if (hls) { hls.destroy(); hls = null; }
  stopLive();
  video.pause();
  state.win = null;
  state.camera = null;
  recCache.clear();
  cancelRecording();
  closeSheet();
}

function showLogin(message) {
  stopEverything();
  $('app').hidden = true;
  $('login').hidden = false;
  $('loginError').hidden = !message;
  $('loginError').textContent = message || '';
  setTimeout(() => ($('loginUser').value ? $('loginPass') : $('loginUser')).focus(), 50);
}

function onUnauthorized() {
  if (!$('login').hidden) return;
  showLogin(signedIn ? 'Your session expired – please sign in again.' : '');
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('loginBtn');
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  $('loginError').hidden = true;
  try {
    const r = await fetch('/_ui/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: $('loginUser').value.trim(), password: $('loginPass').value }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.detail || `Sign in failed (${r.status})`);
    $('loginPass').value = '';
    $('login').hidden = true;
    start();
  } catch (err) {
    $('loginError').textContent = err.message;
    $('loginError').hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
});

$('logout').onclick = async () => {
  await fetch('/_ui/logout', { method: 'POST' }).catch(() => {});
  showLogin();
};

// ------------------------------------------------------------------- init

async function start() {
  let cfg, ui = {};
  try {
    [cfg, ui] = await Promise.all([api('/api/config'), api('/_ui/config').catch(() => ({}))]);
  } catch (e) {
    if ($('login').hidden) toast(`Cannot reach Frigate: ${e.message}`, true, 10000);
    return;
  }
  signedIn = true;
  $('login').hidden = true;
  $('app').hidden = false;

  const cams = Object.entries(cfg.cameras || {})
    .filter(([, c]) => c.enabled !== false)
    .map(([name]) => name);
  if (!cams.length) { toast('No cameras found in Frigate config', true, 10000); return; }

  const sel = $('camera');
  sel.innerHTML = '';
  for (const c of cams) sel.add(new Option(c.replace(/_/g, ' '), c));
  $('cameraWrap').hidden = cams.length < 2;

  let saved = null;
  try { saved = localStorage.getItem('camera'); } catch {}
  const cam = [saved, ui.default_camera].find((c) => c && cams.includes(c)) || cams[0];
  sel.value = cam;
  selectCamera(cam);
}

readColors();
requestAnimationFrame(frame);
setInterval(() => { dirty = true; ensureViewData(); }, 15000);
// coming back to the installed app after a while: refresh live + timeline right away
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && signedIn) { dirty = true; ensureViewData(); }
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
start();
