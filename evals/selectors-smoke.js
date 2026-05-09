'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

if (typeof globalThis.CustomEvent !== 'function') {
  globalThis.CustomEvent = class CustomEvent extends Event {
    constructor(type, init = {}) { super(type); this.detail = init.detail; }
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
  const file = path.resolve(__dirname, '..', rel);
  if (!fs.existsSync(file)) return { ok: false, status: 404, json: async () => ({}) };
  return {
    ok: true,
    status: 200,
    json: async () => JSON.parse(fs.readFileSync(file, 'utf8'))
  };
};

const loads = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'data', 'loads.json'), 'utf8'));
const carriers = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'data', 'carriers.json'), 'utf8'));
const selectorsUrl = pathToFileURL(path.resolve(__dirname, '..', 'js', 'selectors.js')).href;
const formattersUrl = pathToFileURL(path.resolve(__dirname, '..', 'js', 'formatters.js')).href;

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stateFromCity(value) {
  const match = String(value || '').trim().match(/,\s*([A-Za-z]{2})\s*$/);
  return match ? match[1].toUpperCase() : null;
}

function ok(message) {
  console.log('ok - ' + message);
}

(async () => {
  const selectors = await import(`${selectorsUrl}?${Date.now()}`);
  const formatters = await import(`${formattersUrl}?${Date.now()}`);

  const bookedStatuses = new Set(['booked', 'in_transit', 'delayed', 'delivered']);
  const expectedBookedRevenue = loads
    .filter((load) => bookedStatuses.has(load.status))
    .reduce((total, load) => total + (finiteNumber(load.rate) || 0), 0);
  assert.strictEqual(selectors.selectBookedRevenue(loads), expectedBookedRevenue);
  assert(!loads.some((load) => load.status === 'pending' && finiteNumber(load.rate) != null), 'canonical pending loads should not carry committed revenue');
  ok('selectBookedRevenue excludes pending');

  const expectedOpenBookedRevenue = loads
    .filter((load) => load.status === 'booked' || load.status === 'in_transit' || load.status === 'delayed')
    .reduce((total, load) => total + (finiteNumber(load.rate) || 0), 0);
  assert.strictEqual(selectors.selectOpenBookedRevenue(loads), expectedOpenBookedRevenue);
  assert.strictEqual(selectors.selectOpenBookedRevenue(loads), expectedBookedRevenue - 620);
  ok('selectOpenBookedRevenue excludes delivered and pending');

  const expectedInMotion = loads.filter(formatters.isLoadInMotion).length;
  assert.strictEqual(selectors.selectLoadsInMotion(loads), expectedInMotion);
  ok('selectLoadsInMotion matches canonical formatter predicate');

  const expectedMilesInMotion = loads
    .filter((load) => load.status === 'in_transit')
    .reduce((total, load) => total + (finiteNumber(load.miles) || 0), 0);
  assert.strictEqual(selectors.selectMilesInMotion(loads), expectedMilesInMotion);
  ok('selectMilesInMotion only counts in-transit miles');

  assert.strictEqual(selectors.selectOpenLoads(loads), loads.filter((load) => load.status !== 'delivered').length);
  ok('selectOpenLoads excludes delivered');

  const eligibleRateMiles = loads.reduce((acc, load) => {
    const rate = finiteNumber(load.rate);
    const miles = finiteNumber(load.miles);
    if (rate == null || miles == null || miles <= 0) return acc;
    acc.rate += rate;
    acc.miles += miles;
    return acc;
  }, { rate: 0, miles: 0 });
  const expectedAverageRatePerMile = eligibleRateMiles.rate / eligibleRateMiles.miles;
  assert.strictEqual(selectors.selectAverageRatePerMile(loads), expectedAverageRatePerMile);
  ok('selectAverageRatePerMile uses hand-computed data/loads.json totals');

  assert.strictEqual(selectors.selectAvailableCarriers(carriers), carriers.filter((carrier) => carrier.available === true).length);
  ok('selectAvailableCarriers matches direct filter');

  const expectedRating = Math.round((carriers.reduce((total, carrier) => total + carrier.rating, 0) / carriers.length) * 100) / 100;
  assert.strictEqual(selectors.selectAverageCarriersRating(carriers), expectedRating);
  ok('selectAverageCarriersRating matches manual mean');

  const equipmentCounts = selectors.selectEquipmentCounts(carriers);
  assert.strictEqual(equipmentCounts.get('Dry van'), carriers.filter((carrier) => carrier.equipment.includes('Dry van')).length);
  assert.strictEqual(equipmentCounts.get('Reefer'), carriers.filter((carrier) => carrier.equipment.includes('Reefer')).length);
  ok('selectEquipmentCounts returns canonical equipment counts');

  const laneSummaries = selectors.selectLanesSummary(loads);
  assert(laneSummaries.length > 0, 'expected at least one lane summary');
  const expectedLaneKey = 'IL->TX';
  const expectedLaneCount = loads.filter((load) => `${stateFromCity(load.pickup)}->${stateFromCity(load.dropoff)}` === expectedLaneKey).length;
  const lane = laneSummaries.find((summary) => summary.key === expectedLaneKey);
  assert(lane, `expected ${expectedLaneKey} lane summary`);
  assert.strictEqual(lane.count, expectedLaneCount);
  ok('selectLanesSummary returns lane counts from pickup/dropoff states');

  console.log('PASS selectors-smoke');
})().catch((err) => {
  console.error('FAIL', err && err.stack || err);
  process.exit(1);
});
