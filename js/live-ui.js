// Live UI: a thin clock + ops counters strip, mounted in the app header.
// Counters are sourced from the freight store; only the clock ticks.

import { initDataStore, listCarriers, listLoads, subscribe } from './data-store.js';
import {
  selectAvailableCarriers,
  selectBookedRevenue,
  selectLoadsInMotion
} from './selectors.js';

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
let unsubscribeStore = null;
let resolveHost = () => null;

function pad2(n) { return String(n).padStart(2, '0'); }

function recompute() {
  const d = new Date();
  liveState.now = d;
  liveState.clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  const loads = listLoads();
  const carriers = listCarriers();
  liveState.loadsInMotion = selectLoadsInMotion(loads);
  liveState.carriersOnline = selectAvailableCarriers(carriers);
  liveState.bookedToday = selectBookedRevenue(loads);
}

function publish() {
  recompute();
  const host = resolveHost();
  if (host) {
    if (!host.children.length) render(host);
    else patch(host);
  }
  listeners.forEach((fn) => { try { fn(getLiveState()); } catch {} });
}

function stopTicker() {
  if (tickHandle !== null) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
}

function startTicker() {
  if (tickHandle !== null) return;
  if (typeof document !== 'undefined' && document.hidden) return;
  tickHandle = setInterval(() => {
    publish();
  }, 1000);
}

function handleVisibilityChange() {
  if (document.hidden) {
    stopTicker();
    return;
  }
  publish();
  startTicker();
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
  try { initDataStore().then(publish).catch(() => {}); } catch {}

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
  resolveHost = ensureHost;

  recompute();
  const host = ensureHost();
  if (host) render(host);
  unsubscribeStore = [
    subscribe('data:ready', publish),
    subscribe('load:updated', publish),
    subscribe('carrier:updated', publish),
    subscribe('store:reset', publish)
  ];

  startTicker();
  try { document.addEventListener('visibilitychange', handleVisibilityChange); } catch {}

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
