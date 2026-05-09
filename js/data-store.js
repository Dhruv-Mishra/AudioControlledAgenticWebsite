const STORAGE_KEY = 'dhruv-fo.store.v1';
const STORE_VERSION = 1;
const PERSIST_DELAY_MS = 200;

const emitter = new EventTarget();

let initPromise = null;
let ready = false;
let readyEmitted = false;
let persistTimer = null;

let baseLoads = new Map();
let baseCarriers = new Map();
let loadPatches = {};
let carrierPatches = {};
let loads = new Map();
let carriers = new Map();

function emptyOverlay() {
  return { loads: {}, carriers: {} };
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneValue(value) {
  if (value == null || typeof value !== 'object') return value;
  if (typeof structuredClone === 'function') {
    try { return structuredClone(value); } catch {}
  }
  return JSON.parse(JSON.stringify(value));
}

function normalizeId(id) {
  return String(id == null ? '' : id).trim();
}

function getStorage() {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {}
  return null;
}

function readOverlay() {
  const storage = getStorage();
  if (!storage) return emptyOverlay();
  let raw = null;
  try { raw = storage.getItem(STORAGE_KEY); } catch { return emptyOverlay(); }
  if (!raw) return emptyOverlay();

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== STORE_VERSION) {
      try { storage.removeItem(STORAGE_KEY); } catch {}
      return emptyOverlay();
    }
    return {
      loads: isPlainObject(parsed.loads) ? parsed.loads : {},
      carriers: isPlainObject(parsed.carriers) ? parsed.carriers : {}
    };
  } catch {
    try { storage.removeItem(STORAGE_KEY); } catch {}
    return emptyOverlay();
  }
}

function valuesEqual(a, b) {
  if (Object.is(a, b)) return true;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

function diffPatch(base, patch) {
  const out = {};
  if (!isPlainObject(patch)) return out;
  Object.keys(patch).forEach((key) => {
    const value = patch[key];
    if (typeof value === 'undefined') return;
    if (!valuesEqual(base ? base[key] : undefined, value)) {
      out[key] = cloneValue(value);
    }
  });
  return out;
}

function hasKeys(obj) {
  return !!obj && Object.keys(obj).length > 0;
}

function sanitizeOverlayMap(rawPatches, baseMap) {
  const out = {};
  if (!isPlainObject(rawPatches)) return out;
  Object.keys(rawPatches).forEach((id) => {
    const normalized = normalizeId(id);
    if (!normalized || !baseMap.has(normalized) || !isPlainObject(rawPatches[id])) return;
    const diff = diffPatch(baseMap.get(normalized), rawPatches[id]);
    if (hasKeys(diff)) out[normalized] = diff;
  });
  return out;
}

function mapRows(rows) {
  const map = new Map();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    if (!row || !row.id) return;
    map.set(normalizeId(row.id), cloneValue(row));
  });
  return map;
}

function mergeMap(baseMap, patchMap) {
  const merged = new Map();
  baseMap.forEach((base, id) => {
    merged.set(id, {
      ...cloneValue(base),
      ...(isPlainObject(patchMap[id]) ? cloneValue(patchMap[id]) : {})
    });
  });
  return merged;
}

function rebuildMergedState() {
  loads = mergeMap(baseLoads, loadPatches);
  carriers = mergeMap(baseCarriers, carrierPatches);
}

async function fetchJson(path) {
  const response = await fetch(path);
  if (!response || response.ok === false) {
    throw new Error(`Could not load ${path}: ${response ? response.status : 'no response'}`);
  }
  return response.json();
}

function persistNow() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }

  const storage = getStorage();
  if (!storage) return;
  const hasOverlay = hasKeys(loadPatches) || hasKeys(carrierPatches);
  try {
    if (!hasOverlay) {
      storage.removeItem(STORAGE_KEY);
      return;
    }
    storage.setItem(STORAGE_KEY, JSON.stringify({
      version: STORE_VERSION,
      loads: cloneValue(loadPatches),
      carriers: cloneValue(carrierPatches)
    }));
  } catch {}
}

function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(persistNow, PERSIST_DELAY_MS);
}

function emit(eventName, detail = {}) {
  emitter.dispatchEvent(new CustomEvent(eventName, { detail }));
}

function applyLoadPatch(id, patch) {
  const normalized = normalizeId(id);
  const base = baseLoads.get(normalized);
  if (!base) throw new Error(`Unknown load ${id}`);
  const nextPatch = diffPatch(base, {
    ...(loadPatches[normalized] || {}),
    ...(isPlainObject(patch) ? cloneValue(patch) : {})
  });
  if (hasKeys(nextPatch)) loadPatches[normalized] = nextPatch;
  else delete loadPatches[normalized];
  const merged = {
    ...cloneValue(base),
    ...(loadPatches[normalized] ? cloneValue(loadPatches[normalized]) : {})
  };
  loads.set(normalized, merged);
  return cloneValue(merged);
}

function applyCarrierPatch(id, patch) {
  const normalized = normalizeId(id);
  const base = baseCarriers.get(normalized);
  if (!base) throw new Error(`Unknown carrier ${id}`);
  const nextPatch = diffPatch(base, {
    ...(carrierPatches[normalized] || {}),
    ...(isPlainObject(patch) ? cloneValue(patch) : {})
  });
  if (hasKeys(nextPatch)) carrierPatches[normalized] = nextPatch;
  else delete carrierPatches[normalized];
  const merged = {
    ...cloneValue(base),
    ...(carrierPatches[normalized] ? cloneValue(carrierPatches[normalized]) : {})
  };
  carriers.set(normalized, merged);
  return cloneValue(merged);
}

function matchesSearch(record, fields, search) {
  const needle = String(search || '').trim().toLowerCase();
  if (!needle) return true;
  return fields.some((field) => String(record[field] == null ? '' : record[field]).toLowerCase().includes(needle));
}

function statusMatches(recordStatus, wanted) {
  if (wanted == null || wanted === '' || wanted === 'all') return true;
  const statuses = Array.isArray(wanted) ? wanted : [wanted];
  return statuses.map(String).includes(String(recordStatus));
}

/**
 * Initialize the client-side freight store. Idempotent; callers receive the
 * same in-flight promise, and records returned by getters/listers are snapshots.
 */
export function initDataStore() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const [loadRows, carrierRows] = await Promise.all([
      fetchJson('/data/loads.json'),
      fetchJson('/data/carriers.json')
    ]);

    baseLoads = mapRows(loadRows);
    baseCarriers = mapRows(carrierRows);
    const overlay = readOverlay();
    loadPatches = sanitizeOverlayMap(overlay.loads, baseLoads);
    carrierPatches = sanitizeOverlayMap(overlay.carriers, baseCarriers);
    rebuildMergedState();
    ready = true;

    if (!readyEmitted) {
      readyEmitted = true;
      emit('data:ready', {
        loads: listLoads(),
        carriers: listCarriers()
      });
    }
  })().catch((err) => {
    ready = false;
    initPromise = null;
    throw err;
  });
  return initPromise;
}

export function isReady() {
  return ready;
}

export function resetStore() {
  loadPatches = {};
  carrierPatches = {};
  rebuildMergedState();
  persistNow();
  emit('store:reset', { source: 'reset' });
  emit('load:updated', { id: null, load: null, patch: null, source: 'reset' });
  emit('carrier:updated', { id: null, carrier: null, patch: null, source: 'reset' });
}

/** Return a snapshot of a load. Mutate records only through store APIs. */
export function getLoad(id) {
  const record = loads.get(normalizeId(id));
  return record ? cloneValue(record) : undefined;
}

/** Return load snapshots. Mutate records only through store APIs. */
export function listLoads(filter = {}) {
  return Array.from(loads.values()).filter((load) => {
    if (!statusMatches(load.status, filter.status)) return false;
    if (filter.carrierId != null && normalizeId(load.carrierId) !== normalizeId(filter.carrierId)) return false;
    if (!matchesSearch(load, ['id', 'pickup', 'dropoff', 'carrier', 'commodity'], filter.search)) return false;
    if (typeof filter.predicate === 'function' && !filter.predicate(cloneValue(load))) return false;
    return true;
  }).map(cloneValue);
}

export function updateLoad(id, patch, { source } = {}) {
  const normalized = normalizeId(id);
  const appliedPatch = isPlainObject(patch) ? cloneValue(patch) : {};
  const load = applyLoadPatch(normalized, appliedPatch);
  schedulePersist();
  emit('load:updated', { id: normalized, load: cloneValue(load), patch: appliedPatch, source });
  return cloneValue(load);
}

export function countLoadsByStatus() {
  const counts = { pending: 0, booked: 0, in_transit: 0, delayed: 0, delivered: 0 };
  loads.forEach((load) => {
    const key = load.status || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  });
  return counts;
}

/** Return a snapshot of a carrier. Mutate records only through store APIs. */
export function getCarrier(id) {
  const record = carriers.get(normalizeId(id));
  return record ? cloneValue(record) : undefined;
}

/** Return carrier snapshots. Mutate records only through store APIs. */
export function listCarriers(filter = {}) {
  return Array.from(carriers.values()).filter((carrier) => {
    if (typeof filter.available === 'boolean' && carrier.available !== filter.available) return false;
    if (!statusMatches(carrier.status, filter.status)) return false;
    if (!matchesSearch(carrier, ['id', 'name', 'mc', 'dot'], filter.search)) return false;
    if (typeof filter.predicate === 'function' && !filter.predicate(cloneValue(carrier))) return false;
    return true;
  }).map(cloneValue);
}

export function updateCarrier(id, patch, { source } = {}) {
  const normalized = normalizeId(id);
  const appliedPatch = isPlainObject(patch) ? cloneValue(patch) : {};
  const carrier = applyCarrierPatch(normalized, appliedPatch);
  schedulePersist();
  emit('carrier:updated', { id: normalized, carrier: cloneValue(carrier), patch: appliedPatch, source });
  return cloneValue(carrier);
}

export function assignCarrierToLoad(loadId, carrierId, { source } = {}) {
  const normalizedLoadId = normalizeId(loadId);
  const normalizedCarrierId = normalizeId(carrierId);
  const currentLoad = loads.get(normalizedLoadId);
  const carrier = carriers.get(normalizedCarrierId);
  if (!currentLoad) throw new Error(`Unknown load ${loadId}`);
  if (!carrier) throw new Error(`Unknown carrier ${carrierId}`);

  const patch = {
    carrier: carrier.name || null,
    carrierId: carrier.id
  };
  if (currentLoad.status === 'pending') patch.status = 'booked';

  const load = applyLoadPatch(normalizedLoadId, patch);
  const carrierSnapshot = cloneValue(carrier);
  schedulePersist();
  emit('load:updated', { id: normalizedLoadId, load: cloneValue(load), patch: cloneValue(patch), source });
  emit('carrier:updated', { id: normalizedCarrierId, carrier: carrierSnapshot, patch: {}, source });
  return { load: cloneValue(load), carrier: cloneValue(carrierSnapshot) };
}

export function subscribe(eventName, cb) {
  if (typeof cb !== 'function') throw new Error('subscribe requires a callback');
  const handler = (event) => cb(event.detail, event);
  emitter.addEventListener(eventName, handler);
  return () => emitter.removeEventListener(eventName, handler);
}

export function flushPersist() {
  persistNow();
}
