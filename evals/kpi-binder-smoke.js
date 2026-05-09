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

function makeElement(attributes) {
  return {
    textContent: '',
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null;
    }
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

const expectedLoadCount = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'data', 'loads.json'), 'utf8')).length;
const storeUrl = pathToFileURL(path.resolve(__dirname, '..', 'js', 'data-store.js')).href;
const binderUrl = pathToFileURL(path.resolve(__dirname, '..', 'js', 'kpi-binder.js')).href;

(async () => {
  const totalLoads = makeElement({ 'data-kpi': 'loads.total' });
  const root = {
    querySelectorAll(selector) {
      return selector === '[data-kpi]' ? [totalLoads] : [];
    }
  };

  const store = await import(storeUrl);
  const binder = await import(binderUrl);
  await store.initDataStore();
  binder.bindKpis(root);

  assert.strictEqual(totalLoads.textContent, String(expectedLoadCount));
  console.log('ok - bindKpis updates loads.total');
  console.log('PASS kpi-binder-smoke');
})().catch((err) => {
  console.error('FAIL', err && err.stack || err);
  process.exit(1);
});
