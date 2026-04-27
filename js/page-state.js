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
  Object.keys(fields).forEach((id) => {
    const el = root.querySelector('#' + (window.CSS && CSS.escape ? CSS.escape(id) : id));
    if (!el) return;
    const f = fields[id];
    if (f && 'checked' in f) {
      if (el.checked !== f.checked) {
        el.checked = !!f.checked;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        touched = true;
      }
    } else if (f && 'value' in f) {
      if (el.value !== f.value) {
        el.value = f.value;
        // Page filter handlers listen on 'input' and 'change' — fire both.
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
