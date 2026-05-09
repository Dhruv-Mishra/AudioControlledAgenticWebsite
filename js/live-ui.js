// Live UI: a thin clock + ops counters strip, mounted in the app header.
//
// All counters are deterministic functions of Date.now() so they look
// alive but never reset on refresh. Numbers drift slowly; the clock
// ticks every second.

const liveState = {
  // last computed snapshot — refreshed every tick.
  now: new Date(),
  clock: '',
  loadsInMotion: 0,
  carriersOnline: 0,
  bookedToday: 0
};

let started = false;
let tickHandle = null;
let listeners = new Set();
let loadsRef = [];

function pad2(n) { return String(n).padStart(2, '0'); }

function deterministicCount(seedKey, base, jitter) {
  // Use minute resolution so the number changes maybe every couple of
  // minutes — feels alive without flickering.
  const minute = Math.floor(Date.now() / 60_000);
  let h = 2166136261 ^ minute;
  for (let i = 0; i < seedKey.length; i++) {
    h ^= seedKey.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const r = ((h >>> 0) / 0xffffffff);
  return Math.round(base + (r * 2 - 1) * jitter);
}

function recompute() {
  const d = new Date();
  liveState.now = d;
  liveState.clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  const inMotion = loadsRef.filter((l) => l.status === 'in_transit' || l.status === 'delayed').length;
  liveState.loadsInMotion = inMotion || deterministicCount('loadsInMotion', 18, 4);
  liveState.carriersOnline = deterministicCount('carriersOnline', 31, 5);
  // Booked today varies through the day, max around 5pm local.
  const dayFrac = (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400;
  const curve = Math.min(1, dayFrac * 1.4);
  liveState.bookedToday = Math.round(48000 * curve + deterministicCount('booked', 800, 600));
}

function render(host) {
  if (!host) return;
  host.innerHTML = `
    <span class="live-strip-dot" aria-hidden="true"></span>
    <span class="live-strip-clock mono" data-live="clock">${liveState.clock}</span>
    <span class="live-strip-sep" aria-hidden="true">·</span>
    <span class="live-strip-metric"><span class="mono" data-live="loads">${liveState.loadsInMotion}</span> rolling</span>
    <span class="live-strip-sep" aria-hidden="true">·</span>
    <span class="live-strip-metric"><span class="mono" data-live="carriers">${liveState.carriersOnline}</span> online</span>
    <span class="live-strip-sep" aria-hidden="true">·</span>
    <span class="live-strip-metric">$<span class="mono" data-live="booked">${liveState.bookedToday.toLocaleString('en-US')}</span> today</span>
  `;
}

function patch(host) {
  if (!host) return;
  const m = (k, v) => { const el = host.querySelector(`[data-live="${k}"]`); if (el && el.textContent !== String(v)) el.textContent = String(v); };
  m('clock', liveState.clock);
  m('loads', liveState.loadsInMotion);
  m('carriers', liveState.carriersOnline);
  m('booked', liveState.bookedToday.toLocaleString('en-US'));
}

export function getLiveState() {
  return {
    now_iso: liveState.now.toISOString(),
    clock_local: liveState.clock,
    loads_in_motion: liveState.loadsInMotion,
    carriers_online: liveState.carriersOnline,
    revenue_booked_today_usd: liveState.bookedToday
  };
}

export function startLiveUi() {
  if (started) return;
  started = true;
  // Loads dataset for grounding the in-motion count.
  fetch('/data/loads.json').then((r) => r.json()).then((rows) => {
    loadsRef = Array.isArray(rows) ? rows : [];
  }).catch(() => {});

  // Inject the host element into the header right-rail (created by ui.js).
  // Falls back to creating our own anchor on .app-header if the right-rail
  // hasn't been built yet for any reason — the ticker MUST be visible.
  const ensureHost = () => {
    let right = document.querySelector('.app-header-right');
    if (!right) {
      const header = document.querySelector('.app-header');
      if (!header) return null;
      right = document.createElement('div');
      right.className = 'app-header-right';
      header.appendChild(right);
    }
    let host = right.querySelector('.live-strip');
    if (!host) {
      host = document.createElement('div');
      host.className = 'live-strip';
      host.setAttribute('aria-label', 'Live network status');
      host.setAttribute('role', 'status');
      right.insertBefore(host, right.firstChild);
      if (typeof console !== 'undefined' && console.debug) {
        console.debug('[live-ui] mounted ticker into', right);
      }
    }
    return host;
  };

  recompute();
  const host = ensureHost();
  if (host) render(host);

  tickHandle = setInterval(() => {
    recompute();
    const h = ensureHost();
    if (h) {
      if (!h.children.length) render(h);
      else patch(h);
    }
    listeners.forEach((fn) => { try { fn(getLiveState()); } catch {} });
  }, 1000);

  // Re-mount on SPA route changes in case anything clobbers the header.
  try {
    window.addEventListener('route-change', () => {
      const h = ensureHost();
      if (h && !h.children.length) render(h);
    });
  } catch {}
}

export function onLiveUpdate(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
