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

function makeScheduler() {
  let nextId = 1;
  const timers = new Map();
  return {
    setInterval(fn, intervalMs) {
      const id = { id: nextId, intervalMs };
      nextId += 1;
      timers.set(id, fn);
      return id;
    },
    clearInterval(id) { timers.delete(id); },
    activeCount() { return timers.size; }
  };
}

function counts(store) {
  return store.listLoads().reduce((acc, load) => {
    acc[load.status] = (acc[load.status] || 0) + 1;
    return acc;
  }, {});
}

function ok(message) {
  console.log('ok - ' + message);
}

globalThis.window = {};
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

const liveTickUrl = pathToFileURL(path.resolve(__dirname, '..', 'js', 'live-tick.js')).href;
const storeUrl = pathToFileURL(path.resolve(__dirname, '..', 'js', 'data-store.js')).href;

(async () => {
  const liveTick = await import(`${liveTickUrl}?${Date.now()}-${Math.random()}`);
  const store = await import(storeUrl);
  const scheduler = makeScheduler();

  const firstHandle = liveTick.startLiveTick({ intervalMs: 1234, scheduler });
  const secondHandle = liveTick.startLiveTick({ intervalMs: 6000, scheduler });
  assert.strictEqual(secondHandle, firstHandle, 'startLiveTick should return the existing handle');
  assert.strictEqual(liveTick.isLiveTickRunning(), true, 'ticker should report running after start');
  assert.strictEqual(scheduler.activeCount(), 1, 'idempotent start should schedule one timer');
  ok('startLiveTick is idempotent');

  liveTick.stopLiveTick();
  assert.strictEqual(liveTick.isLiveTickRunning(), false, 'ticker should stop cleanly');
  assert.strictEqual(scheduler.activeCount(), 0, 'stopLiveTick should clear the timer');
  ok('stopLiveTick clears timer state');

  await store.initDataStore();
  let loadEvents = 0;
  let lastSource = null;
  store.subscribe('load:updated', (detail) => {
    loadEvents += 1;
    lastSource = detail && detail.source;
  });

  const mutation = liveTick._runOneTickForTests();
  assert(mutation, 'test tick should produce a mutation');
  assert.strictEqual(mutation.source, 'live-tick');
  assert.strictEqual(lastSource, 'live-tick');
  assert(loadEvents > 0, 'load:updated should fire for a live tick mutation');
  assert.notStrictEqual(mutation.from, mutation.to, 'status should change');
  ok('_runOneTickForTests mutates the store and emits a live-tick event');

  store.resetStore();
  liveTick.stopLiveTick();
  const before = counts(store);
  liveTick._runOneTickForTests();
  liveTick._runOneTickForTests();
  const after = counts(store);
  assert(after.pending < before.pending, 'pending count should decrease after assignment');
  assert(after.in_transit > before.in_transit, 'in_transit count should increase after pickup');
  ok('rotation moves pending freight into booked and in-transit buckets');

  store.resetStore();
  liveTick.stopLiveTick();
  store.listLoads().forEach((load) => {
    store.updateLoad(load.id, { status: 'delivered' }, { source: 'test' });
  });
  const recycle = liveTick._runOneTickForTests();
  assert(recycle, 'recycle tick should produce a mutation');
  assert.strictEqual(recycle.phase, 'recycle');
  assert.strictEqual(recycle.to, 'pending');
  assert.strictEqual(counts(store).pending, 1, 'recycle should reset one delivered load to pending');
  ok('recycling resets one delivered load to pending');

  const handle = liveTick.startLiveTick({ scheduler });
  assert(handle, 'ticker should return a handle when browser timers are available');
  assert.strictEqual(liveTick.isLiveTickRunning(), true);
  liveTick.stopLiveTick();
  assert.strictEqual(liveTick.isLiveTickRunning(), false);
  assert.strictEqual(scheduler.activeCount(), 0);
  ok('isLiveTickRunning reflects start and stop');

  store.resetStore();
  store.flushPersist();
  console.log('PASS live-tick-smoke');
})().catch((err) => {
  console.error('FAIL', err && err.stack || err);
  process.exit(1);
});