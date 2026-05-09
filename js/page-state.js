// page-state.js — per-route view state across SPA navigation.
//
// Persistence model: in-memory only.
//   • Survives SPA route switches (module stays loaded).
//   • Wiped on hard refresh (module re-evaluates).
//   • Wiped on tab close (process dies).
// This matches what users expect from "back to where I was" without
// turning into stale state across sessions, and avoids any storage
// quota / privacy / serialization cost.
//
// Auto-captures (no per-page wiring needed):
//   • window scroll position
//   • value of every <input>/<select>/<textarea> inside the route root
//     that has an id (filter inputs, search boxes, form fields).
//
// Per-page hook (optional): if the page module exports `getState()` and
// `setState(state)`, the router will round-trip its return value through
// this store too. Use for state that doesn't live in the DOM (Leaflet
// center/zoom, selected pin, etc.). Module state is held by reference —
// pages may return live objects; do not mutate them after returning.

const store = new Map();

export function captureDom(root) {
  const fields = {};
  if (!root) return { scrollY: window.scrollY || 0, fields };
  const inputs = root.querySelectorAll('input[id], select[id], textarea[id]');
  inputs.forEach((el) => {
    if (el.type === 'password' || el.type === 'file') return;
    if (el.type === 'checkbox' || el.type === 'radio') {
      fields[el.id] = { checked: !!el.checked };
    } else {
      fields[el.id] = { value: el.value };
    }
  });
  return { scrollY: window.scrollY || 0, fields };
}

export function applyDom(root, snap) {
  if (!root || !snap) return false;
  let touched = false;
  const fields = snap.fields || {};
  // Single DOM scan: iterate inputs directly instead of Object.keys + querySelector per id.
  const inputs = root.querySelectorAll('input[id], select[id], textarea[id]');
  inputs.forEach((el) => {
    const f = fields[el.id];
    if (!f) return;
    if ('checked' in f) {
      if (el.checked !== f.checked) {
        el.checked = !!f.checked;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        touched = true;
      }
    } else if ('value' in f) {
      if (el.value !== f.value) {
        el.value = f.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        touched = true;
      }
    }
  });
  return touched;
}

export function save(routeName, root, moduleState) {
  if (!routeName) return;
  store.set(routeName, {
    dom: captureDom(root),
    module: moduleState === undefined ? null : moduleState
  });
}

export function load(routeName) {
  if (!routeName) return null;
  return store.get(routeName) || null;
}

export function restoreScroll(snap) {
  if (!snap || !snap.dom) return false;
  const y = Number(snap.dom.scrollY);
  if (!Number.isFinite(y) || y <= 0) return false;
  // Defer to the next frame so layout has settled (images/lazy content).
  requestAnimationFrame(() => {
    try { window.scrollTo(0, y); } catch {}
  });
  return true;
}

export function clear(routeName) {
  if (routeName) store.delete(routeName);
  else store.clear();
}

// ---------------------------------------------------------------------------
// UI selection + form draft (agent-aware context).
//
// Survives SPA route switches via in-memory state, persists across hard
// refreshes via sessionStorage so clicking a load on the map and then
// hitting F5 keeps that load selected.
// ---------------------------------------------------------------------------

const SEL_KEY = 'jarvis.selection';
const DRAFT_KEY = 'jarvis.formDraft';

function readJson(key) {
  try { const raw = sessionStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function writeJson(key, v) {
  try { sessionStorage.setItem(key, JSON.stringify(v)); } catch {}
}

const selection = readJson(SEL_KEY) || { loadId: null, carrierId: null, kind: null, label: null, at: null };
let formDraftCache = readJson(DRAFT_KEY) || {};
const subscribers = new Set();
let lastFocusedField = null;

function notify() {
  subscribers.forEach((fn) => { try { fn(getSelection()); } catch {} });
}

export function getSelection() {
  return { ...selection };
}

export function selectLoad(id, label) {
  if (!id) return;
  selection.kind = 'load';
  selection.loadId = String(id);
  selection.carrierId = null;
  selection.label = label || String(id);
  selection.at = new Date().toISOString();
  writeJson(SEL_KEY, selection);
  notify();
  try { window.dispatchEvent(new CustomEvent('jarvis:selection', { detail: getSelection() })); } catch {}
}

export function selectCarrier(id, label) {
  if (!id) return;
  selection.kind = 'carrier';
  selection.carrierId = String(id);
  selection.loadId = null;
  selection.label = label || String(id);
  selection.at = new Date().toISOString();
  writeJson(SEL_KEY, selection);
  notify();
  try { window.dispatchEvent(new CustomEvent('jarvis:selection', { detail: getSelection() })); } catch {}
}

export function clearSelection() {
  selection.kind = null;
  selection.loadId = null;
  selection.carrierId = null;
  selection.label = null;
  selection.at = null;
  writeJson(SEL_KEY, selection);
  notify();
}

export function subscribeSelection(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

// Form-draft: a delegated 'input' listener installed in app.js feeds this.
export function recordFormInput(el) {
  if (!el || el.type === 'password' || el.type === 'file') return;
  if (el.dataset && el.dataset.private === 'true') return;
  const ac = (el.getAttribute && el.getAttribute('autocomplete')) || '';
  if (/^cc-/.test(ac)) return;
  const key = el.id || el.name;
  if (!key) return;
  let value;
  if (el.type === 'checkbox' || el.type === 'radio') value = !!el.checked;
  else value = String(el.value || '').slice(0, 500);
  const page = location.pathname || '/';
  if (!formDraftCache[page]) formDraftCache[page] = {};
  formDraftCache[page][key] = value;
  writeJson(DRAFT_KEY, formDraftCache);
}

export function recordFormFocus(el) {
  if (!el) { lastFocusedField = null; return; }
  if (el.type === 'password' || el.type === 'file') { lastFocusedField = null; return; }
  const key = el.id || el.name;
  if (!key) { lastFocusedField = null; return; }
  lastFocusedField = {
    name: key,
    type: el.type || el.tagName.toLowerCase(),
    value: (el.type === 'checkbox' || el.type === 'radio') ? !!el.checked : String(el.value || '').slice(0, 200),
    page: location.pathname || '/'
  };
}

export function getFormDraft() {
  const page = location.pathname || '/';
  return formDraftCache[page] || {};
}

export function getFocusedField() {
  return lastFocusedField ? { ...lastFocusedField } : null;
}
