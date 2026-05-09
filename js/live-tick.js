import {
  assignCarrierToLoad,
  initDataStore,
  isReady,
  listCarriers,
  listLoads,
  updateLoad
} from './data-store.js';

const DEFAULT_INTERVAL_MS = 6000;
const SOURCE = 'live-tick';
const PHASES = ['pending-to-booked', 'booked-to-transit', 'transit-to-delivered', 'recycle'];
const FLOOR_STATUSES = ['pending', 'booked', 'in_transit'];

let timerId = null;
let clearTimer = null;
let phaseIndex = 0;
let initPromise = null;
let tickInFlight = false;

const lastTransitionAt = new Map();

function canUseBrowserTimers() {
  return typeof window !== 'undefined' && typeof setInterval !== 'undefined';
}

function normalizeInterval(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : DEFAULT_INTERVAL_MS;
}

function ensureStoreReady() {
  if (isReady()) return Promise.resolve();
  if (!initPromise) {
    initPromise = initDataStore().catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

function stateCode(value) {
  const match = String(value || '').trim().match(/,\s*([A-Za-z]{2})\s*$/);
  return match ? match[1].toUpperCase() : null;
}

function laneKeyForLoad(load) {
  const pickup = stateCode(load && load.pickup);
  const dropoff = stateCode(load && load.dropoff);
  return pickup && dropoff ? `${pickup}-${dropoff}` : null;
}

function carrierMatchesLoad(load, carrier) {
  const laneKey = laneKeyForLoad(load);
  if (!laneKey || !carrier || !Array.isArray(carrier.lanes)) return false;
  return carrier.lanes.map(String).includes(laneKey);
}

function compareIds(a, b) {
  return String(a && a.id || '').localeCompare(String(b && b.id || ''), 'en-US', { numeric: true });
}

function pickCarrier(load) {
  const available = listCarriers({ available: true }).slice().sort(compareIds);
  return available.find((carrier) => carrierMatchesLoad(load, carrier)) || available[0] || null;
}

function countStatuses(loads) {
  return loads.reduce((counts, load) => {
    const status = load && load.status ? String(load.status) : 'unknown';
    counts[status] = (counts[status] || 0) + 1;
    return counts;
  }, {});
}

function canDrain(loads, status) {
  if (!FLOOR_STATUSES.includes(status)) return true;
  const counts = countStatuses(loads);
  return (counts[status] || 0) > 1;
}

function oldestLoad(loads) {
  if (!loads.length) return null;
  return loads.reduce((oldest, load) => {
    const oldestAt = lastTransitionAt.has(oldest.id) ? lastTransitionAt.get(oldest.id) : 0;
    const loadAt = lastTransitionAt.has(load.id) ? lastTransitionAt.get(load.id) : 0;
    return loadAt < oldestAt ? load : oldest;
  }, loads[0]);
}

function rememberTransition(loadId) {
  lastTransitionAt.set(loadId, Date.now());
}

function makeMutation(phase, load, nextLoad, fromStatus, toStatus, extra = {}) {
  rememberTransition(load.id);
  return {
    phase,
    loadId: load.id,
    from: fromStatus,
    to: toStatus,
    source: SOURCE,
    load: nextLoad,
    ...extra
  };
}

function runPendingToBooked(loads) {
  if (!canDrain(loads, 'pending')) return null;
  const candidate = oldestLoad(loads.filter((load) => load.status === 'pending'));
  if (!candidate) return null;
  const carrier = pickCarrier(candidate);
  if (!carrier) return null;
  const { load } = assignCarrierToLoad(candidate.id, carrier.id, { source: SOURCE });
  return makeMutation('pending-to-booked', candidate, load, candidate.status, load.status, { carrierId: carrier.id });
}

function runBookedToTransit(loads) {
  if (!canDrain(loads, 'booked')) return null;
  const candidate = oldestLoad(loads.filter((load) => load.status === 'booked'));
  if (!candidate) return null;
  const load = updateLoad(candidate.id, { status: 'in_transit' }, { source: SOURCE });
  return makeMutation('booked-to-transit', candidate, load, candidate.status, load.status);
}

function runTransitToDelivered(loads) {
  if (!canDrain(loads, 'in_transit')) return null;
  const candidate = oldestLoad(loads.filter((load) => load.status === 'in_transit'));
  if (!candidate) return null;
  const load = updateLoad(candidate.id, { status: 'delivered' }, { source: SOURCE });
  return makeMutation('transit-to-delivered', candidate, load, candidate.status, load.status);
}

function hasFloorStall(loads) {
  const counts = countStatuses(loads);
  return FLOOR_STATUSES.every((status) => (counts[status] || 0) <= 1);
}

function shouldRecycle(loads) {
  const delivered = loads.filter((load) => load.status === 'delivered');
  if (!delivered.length) return false;
  const nonDeliveredCount = loads.length - delivered.length;
  return nonDeliveredCount === 0 || nonDeliveredCount < 2 || hasFloorStall(loads);
}

function runRecycle(loads) {
  if (!shouldRecycle(loads)) return null;
  const candidate = oldestLoad(loads.filter((load) => load.status === 'delivered'));
  if (!candidate) return null;
  const load = updateLoad(candidate.id, { status: 'pending', carrier: null, carrierId: null }, { source: SOURCE });
  return makeMutation('recycle', candidate, load, candidate.status, load.status);
}

function runPhase(phase, loads) {
  if (phase === 'pending-to-booked') return runPendingToBooked(loads);
  if (phase === 'booked-to-transit') return runBookedToTransit(loads);
  if (phase === 'transit-to-delivered') return runTransitToDelivered(loads);
  if (phase === 'recycle') return runRecycle(loads);
  return null;
}

function runOneTick() {
  const loads = listLoads();
  if (!loads.length) return null;

  for (let offset = 0; offset < PHASES.length; offset += 1) {
    const index = (phaseIndex + offset) % PHASES.length;
    const mutation = runPhase(PHASES[index], loads);
    if (mutation) {
      phaseIndex = (index + 1) % PHASES.length;
      return mutation;
    }
  }

  phaseIndex = (phaseIndex + 1) % PHASES.length;
  return null;
}

function runScheduledTick() {
  if (tickInFlight) return;
  tickInFlight = true;
  ensureStoreReady()
    .then(() => { runOneTick(); })
    .catch((err) => {
      if (typeof console !== 'undefined' && console.error) console.error('[live-tick] tick failed', err);
    })
    .finally(() => { tickInFlight = false; });
}

export function startLiveTick({ intervalMs = DEFAULT_INTERVAL_MS, scheduler = null } = {}) {
  if (timerId !== null) return timerId;
  if (!canUseBrowserTimers()) return null;

  const setTimer = scheduler && typeof scheduler.setInterval === 'function'
    ? scheduler.setInterval
    : setInterval;
  clearTimer = scheduler && typeof scheduler.clearInterval === 'function'
    ? scheduler.clearInterval
    : (typeof clearInterval === 'function' ? clearInterval : null);

  timerId = setTimer(runScheduledTick, normalizeInterval(intervalMs));
  return timerId;
}

export function stopLiveTick() {
  if (timerId !== null && typeof clearTimer === 'function') clearTimer(timerId);
  timerId = null;
  clearTimer = null;
  phaseIndex = 0;
  initPromise = null;
  tickInFlight = false;
  lastTransitionAt.clear();
}

export function isLiveTickRunning() {
  return timerId !== null;
}

export function _runOneTickForTests() {
  if (!isReady()) return null;
  return runOneTick();
}