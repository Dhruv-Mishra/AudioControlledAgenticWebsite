'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

if (typeof globalThis.CustomEvent !== 'function') {
  globalThis.CustomEvent = class CustomEvent extends Event {
    constructor(type, init = {}) { super(type, init); this.detail = init.detail; }
  };
}

function makeLocalStorage() {
  const data = new Map();
  return {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
    removeItem(key) { data.delete(key); },
    clear() { data.clear(); }
  };
}

globalThis.localStorage = makeLocalStorage();
globalThis.fetch = async (url) => {
  const pathname = String(url);
  const rel = pathname.startsWith('/') ? pathname.slice(1) : pathname;
  if (rel !== 'data/loads.json' && rel !== 'data/carriers.json') {
    return { ok: false, status: 404, json: async () => ({}) };
  }
  const file = path.resolve(__dirname, '..', rel);
  return {
    ok: true,
    status: 200,
    json: async () => JSON.parse(fs.readFileSync(file, 'utf8'))
  };
};

const storeUrl = pathToFileURL(path.resolve(__dirname, '..', 'js', 'data-store.js')).href;
const formattersUrl = pathToFileURL(path.resolve(__dirname, '..', 'js', 'formatters.js')).href;

async function freshStore(label) {
  return import(`${storeUrl}?${label}-${Date.now()}-${Math.random()}`);
}

function ok(message) {
  console.log('ok - ' + message);
}

(async () => {
  const store = await freshStore('initial');
  let readyCount = 0;
  store.subscribe('data:ready', () => { readyCount += 1; });
  const firstInit = store.initDataStore();
  const secondInit = store.initDataStore();
  assert.strictEqual(firstInit, secondInit, 'initDataStore should return same in-flight promise');
  await firstInit;
  assert.strictEqual(readyCount, 1, 'data:ready should fire exactly once');
  assert.strictEqual(store.isReady(), true, 'store should be ready');
  ok('initDataStore idempotent and data:ready fires once');

  const load = store.getLoad('LD-10824');
  assert(load && load.id === 'LD-10824' && load.pickup && load.dropoff, 'getLoad should return a complete record');
  ok('getLoad returns canonical load record');

  const inTransit = store.listLoads({ status: 'in_transit' });
  assert(inTransit.length > 0, 'expected in-transit loads');
  assert(inTransit.every((row) => row.status === 'in_transit'), 'status filter should only return in-transit');
  ok('listLoads filters by status');

  const chicago = store.listLoads({ search: 'chicago' });
  assert(chicago.some((row) => row.id === 'LD-10824'), 'case-insensitive search should match Chicago');
  ok('listLoads search is case-insensitive');

  let updateDetail = null;
  store.subscribe('load:updated', (detail) => { updateDetail = detail; });
  store.updateLoad('LD-10824', { status: 'delivered' }, { source: 'test' });
  assert(updateDetail, 'load:updated should fire');
  assert.strictEqual(updateDetail.id, 'LD-10824');
  assert.strictEqual(updateDetail.load.status, 'delivered');
  assert.deepStrictEqual(updateDetail.patch, { status: 'delivered' });
  assert.strictEqual(updateDetail.source, 'test');
  assert.strictEqual(store.getLoad('LD-10824').status, 'delivered');
  ok('updateLoad emits and updates snapshots');

  store.flushPersist();
  const persisted = JSON.parse(localStorage.getItem('dhruv-fo.store.v1'));
  assert.strictEqual(persisted.version, 1);
  assert.deepStrictEqual(persisted.loads['LD-10824'], { status: 'delivered' });

  const storeAfterReload = await freshStore('reload');
  await storeAfterReload.initDataStore();
  assert.strictEqual(storeAfterReload.getLoad('LD-10824').status, 'delivered');
  storeAfterReload.resetStore();
  assert.strictEqual(localStorage.getItem('dhruv-fo.store.v1'), null, 'resetStore should wipe persisted overlay');
  assert.strictEqual(storeAfterReload.getLoad('LD-10824').status, 'in_transit');
  ok('persistence round-trip and resetStore work');

  let loadEvents = 0;
  let carrierEvents = 0;
  storeAfterReload.subscribe('load:updated', () => { loadEvents += 1; });
  storeAfterReload.subscribe('carrier:updated', () => { carrierEvents += 1; });
  const assignment = storeAfterReload.assignCarrierToLoad('LD-10826', 'C-118', { source: 'test' });
  assert.strictEqual(assignment.load.carrierId, 'C-118');
  assert.strictEqual(assignment.load.carrier, 'Peach Express');
  assert.strictEqual(assignment.load.status, 'booked');
  assert.strictEqual(loadEvents, 1);
  assert.strictEqual(carrierEvents, 1);
  ok('assignCarrierToLoad updates load and emits both events');

  const formatters = await import(`${formattersUrl}?${Date.now()}-${Math.random()}`);
  const carrier = storeAfterReload.getCarrier('C-204');
  const availabilityA = formatters.formatCarrierAvailability(carrier).label;
  const availabilityB = formatters.formatCarrierAvailability({ ...carrier }).label;
  assert.strictEqual(availabilityA, availabilityB);
  assert.strictEqual(availabilityA, 'Unavailable');
  ok('formatCarrierAvailability is caller-independent');

  assert.strictEqual(formatters.isLoadInMotion({ status: 'booked' }), true);
  assert.strictEqual(formatters.isLoadInMotion({ status: 'in_transit' }), true);
  assert.strictEqual(formatters.isLoadInMotion({ status: 'pending' }), false);
  assert.strictEqual(formatters.isLoadInMotion({ status: 'delivered' }), false);
  assert.strictEqual(formatters.isLoadInMotion({ status: 'delayed' }), false);
  ok('isLoadInMotion uses canonical booked + in_transit definition');

  console.log('PASS data-store-smoke');
})().catch((err) => {
  console.error('FAIL', err && err.stack || err);
  process.exit(1);
});
