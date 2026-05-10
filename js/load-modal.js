// load-modal.js — singleton body-portal modal for load detail.
// Auto-registers window.__loadModal and window.__modals.closeAll.

import { getCarrier, getLoad, initDataStore, isReady, listCarriers, subscribe } from './data-store.js';
import { formatEta, formatLoadStatus, formatMiles, formatMoney, formatWeight } from './formatters.js';

const MODAL_HTML = `<div id="load-modal-root" class="load-modal" data-modal-root="load" role="dialog"
  aria-modal="true" aria-hidden="true" aria-labelledby="load-modal-title" tabindex="-1">
  <aside class="load-modal-card">

    <div class="load-modal-hero">
      <picture>
        <source type="image/webp" data-modal-field="hero_srcset" />
        <img class="load-modal-img" width="480" height="320"
             loading="lazy" decoding="async" alt=""
             data-modal-field="hero_img" />
      </picture>
      <span class="chip load-modal-status" data-agent-id="load_modal.status"
            data-modal-field="status"></span>
      <button class="load-modal-close icon-btn" type="button"
              aria-label="Close load detail"
              data-agent-id="load_modal.action.close">&times;</button>
    </div>

    <div class="load-modal-body">
      <h2 id="load-modal-title" class="load-modal-title" data-agent-id="load_modal.title"
          data-modal-field="title"></h2>
      <p class="load-modal-subtitle" data-modal-field="subtitle"></p>

      <section class="load-modal-section">
        <h3 class="load-modal-section-title">Route</h3>
        <dl class="load-modal-kv">
          <dt>Pickup</dt>  <dd data-agent-id="load_modal.pickup"  data-modal-field="pickup"></dd>
          <dt>Dropoff</dt> <dd data-agent-id="load_modal.dropoff" data-modal-field="dropoff"></dd>
          <dt>Miles</dt>   <dd data-agent-id="load_modal.miles"   data-modal-field="miles"></dd>
        </dl>
      </section>

      <section class="load-modal-section">
        <h3 class="load-modal-section-title">Shipment</h3>
        <dl class="load-modal-kv">
          <dt>Commodity</dt> <dd data-agent-id="load_modal.commodity" data-modal-field="commodity"></dd>
          <dt>Weight</dt>    <dd data-agent-id="load_modal.weight"    data-modal-field="weight"></dd>
          <dt>Rate</dt>      <dd data-agent-id="load_modal.rate"      data-modal-field="rate"></dd>
          <dt>ETA</dt>       <dd data-agent-id="load_modal.eta"       data-modal-field="eta"></dd>
        </dl>
      </section>

      <section class="load-modal-section">
        <h3 class="load-modal-section-title">Carrier</h3>
        <dl class="load-modal-kv">
          <dt>Carrier</dt> <dd data-agent-id="load_modal.carrier" data-modal-field="carrier"></dd>
        </dl>
      </section>
    </div>

    <div class="load-modal-actions" data-agent-id="load_modal.actions"></div>
  </aside>
</div>`;

let root = null;
let currentLoadId = null;
let currentOpts = null;
let unsubscribeLoad = null;
let unsubscribeCarrier = null;
let scrollLockState = null;

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

function prefersReducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

function ensureRoot() {
  // Keep the modal viewport-owned. Mounting inside map/list containers makes
  // mobile sheet placement depend on whichever page surface opened it.
  const desired = document.body;
  if (root && root.isConnected) {
    if (root.parentNode !== desired) desired.appendChild(root);
    return root;
  }
  root = document.getElementById('load-modal-root');
  if (root) {
    if (root.parentNode !== desired) desired.appendChild(root);
    wireRoot(root);
    return root;
  }
  const div = document.createElement('div');
  div.innerHTML = MODAL_HTML;
  root = div.firstElementChild;
  desired.appendChild(root);
  wireRoot(root);
  return root;
}

function wireRoot(el) {
  if (!el || el.dataset.loadModalWired === 'true') return;
  el.dataset.loadModalWired = 'true';
  el.addEventListener('click', onBackdropClick);
  const closeBtn = root.querySelector('.load-modal-close');
  if (closeBtn) closeBtn.addEventListener('click', close);
}

function chipForTone(tone) {
  if (tone === 'success') return 'ok';
  if (tone === 'danger') return 'danger';
  if (tone === 'warn') return 'warn';
  if (tone === 'info') return 'info';
  return 'neutral';
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function resolveCarrier(load) {
  if (!load) return null;
  if (load.carrierId) return getCarrier(load.carrierId) || null;
  if (load.carrier) {
    return listCarriers({ predicate: (c) => c.name === load.carrier })[0] || null;
  }
  return null;
}

function resolveLoad(input) {
  const id = typeof input === 'object' && input ? input.id : input;
  const fresh = getLoad(id);
  return fresh || (typeof input === 'object' && input ? input : null);
}

function rerenderCurrent() {
  if (!root || !currentLoadId) return;
  const load = getLoad(currentLoadId);
  if (!load) return;
  populateFields(load);
  renderActions(load, currentOpts || {});
}

function clearStoreSubscriptions() {
  try { unsubscribeLoad && unsubscribeLoad(); } catch {}
  try { unsubscribeCarrier && unsubscribeCarrier(); } catch {}
  unsubscribeLoad = null;
  unsubscribeCarrier = null;
}

function subscribeCurrentLoad() {
  clearStoreSubscriptions();
  unsubscribeLoad = subscribe('load:updated', (detail) => {
    if (!currentLoadId) return;
    if (!detail || detail.id == null || detail.id === currentLoadId) rerenderCurrent();
  });
  unsubscribeCarrier = subscribe('carrier:updated', (detail) => {
    if (!currentLoadId) return;
    const load = getLoad(currentLoadId);
    if (!load) return;
    if (!detail || detail.id == null || detail.id === load.carrierId) rerenderCurrent();
  });
}

function populateFields(load) {
  const el = root;
  const statusMeta = formatLoadStatus(load.status);

  // Status chip
  const statusEl = el.querySelector('[data-modal-field="status"]');
  if (statusEl) {
    statusEl.textContent = statusMeta.label;
    statusEl.className = `chip load-modal-status chip--${chipForTone(statusMeta.tone)}`;
  }

  // Title
  const titleEl = el.querySelector('[data-modal-field="title"]');
  if (titleEl) titleEl.textContent = `Load ${load.id}`;

  // Route
  setField('pickup', load.pickup || '—');
  setField('dropoff', load.dropoff || '—');
  setField('miles', formatMiles(load.miles));

  // Shipment
  setField('commodity', load.commodity || '—');
  setField('weight', formatWeight(load.weight));
  setField('rate', formatMoney(load.rate));
  setField('eta', formatEta(load).niceAbsolute);

  // Carrier
  const carrier = resolveCarrier(load);
  setField('carrier', carrier ? carrier.name : (load.carrier || 'Unassigned'));

  // Subtitle
  const subtitle = root.querySelector('.load-modal-subtitle');
  if (subtitle) {
    const milesPart = load.miles ? formatMiles(load.miles) : '';
    const etaPart = load.eta ? `ETA ${formatEta(load).niceAbsolute}` : '';
    const route = `${load.pickup || '?'} → ${load.dropoff || '?'}`;
    subtitle.textContent = [route, milesPart, etaPart].filter(Boolean).join(' · ');
  }

  // Hero image
  const slug = carrier && carrier.imageSlug ? carrier.imageSlug : 'truck-generic';
  const imgSrc = `/public/images/carriers/${slug}.webp`;
  const source = el.querySelector('[data-modal-field="hero_srcset"]');
  const img = el.querySelector('[data-modal-field="hero_img"]');
  if (source && source.getAttribute('srcset') !== imgSrc) source.setAttribute('srcset', imgSrc);
  if (img) {
    const targetSrc = new URL(imgSrc, window.location.href).href;
    if (img.src !== targetSrc) {
      img.classList.remove('is-loaded');
      img.onload = () => img.classList.add('is-loaded');
      img.onerror = () => img.classList.add('is-loaded');
      img.src = imgSrc;
    } else {
      img.classList.add('is-loaded');
    }
    img.alt = carrier
      ? `${carrier.name} — Load ${load.id}`
      : `Freight load ${load.id}`;
  }
}

function setField(name, value) {
  const el = root.querySelector(`[data-modal-field="${name}"]`);
  if (el && el.tagName !== 'SOURCE' && el.tagName !== 'IMG' && el.tagName !== 'SPAN') {
    el.textContent = value;
  }
}

function renderActions(load, opts) {
  const actionsEl = root.querySelector('.load-modal-actions');
  if (!actionsEl) return;
  actionsEl.innerHTML = '';

  const hasCarrier = !!(load.carrierId || load.carrier);
  const buttons = [];

  if (opts.context === 'dispatch') {
    buttons.push({ label: 'Show on map', agentId: 'load_modal.action.show_on_map', handler: handleShowOnMap });
  }
  if (opts.context === 'map') {
    buttons.push({ label: 'Center on map', agentId: 'load_modal.action.center_on_map', handler: handleCenterOnMap });
  }
  if (!hasCarrier) {
    buttons.push({ label: 'Assign carrier', agentId: 'load_modal.action.assign_carrier', handler: handleAssignCarrier });
  }
  if (hasCarrier) {
    buttons.push({ label: 'Call carrier', agentId: 'load_modal.action.call_carrier', handler: handleCallCarrier });
    buttons.push({ label: 'Request status', agentId: 'load_modal.action.request_status', handler: handleRequestStatus });
  }

  buttons.forEach(({ label, agentId, handler }) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn';
    btn.textContent = label;
    btn.setAttribute('data-agent-id', agentId);
    btn.addEventListener('click', handler);
    actionsEl.appendChild(btn);
  });
}

function getFocusableElements() {
  if (!root) return [];
  return Array.from(root.querySelectorAll(FOCUSABLE_SELECTOR)).filter((el) => {
    if (!el || el.getAttribute('aria-hidden') === 'true') return false;
    if (el.disabled) return false;
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  });
}

function trapFocus(ev) {
  const focusable = getFocusableElements();
  if (!focusable.length) {
    ev.preventDefault();
    try { root.focus(); } catch {}
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;

  if (!root.contains(active)) {
    ev.preventDefault();
    first.focus();
    return;
  }
  if (ev.shiftKey && active === first) {
    ev.preventDefault();
    last.focus();
    return;
  }
  if (!ev.shiftKey && active === last) {
    ev.preventDefault();
    first.focus();
  }
}

function lockPageScroll() {
  if (scrollLockState || !document.body) return;
  const doc = document.documentElement;
  const body = document.body;
  const scrollY = window.scrollY || doc.scrollTop || 0;
  scrollLockState = {
    scrollY,
    bodyPosition: body.style.position,
    bodyTop: body.style.top,
    bodyLeft: body.style.left,
    bodyRight: body.style.right,
    bodyWidth: body.style.width,
    bodyOverflow: body.style.overflow,
    docOverflow: doc.style.overflow
  };

  doc.classList.add('is-modal-open');
  body.classList.add('is-modal-open');
  doc.style.overflow = 'hidden';
  body.style.overflow = 'hidden';
  body.style.position = 'fixed';
  body.style.top = `-${scrollY}px`;
  body.style.left = '0';
  body.style.right = '0';
  body.style.width = '100%';
}

function unlockPageScroll() {
  if (!scrollLockState || !document.body) return;
  const doc = document.documentElement;
  const body = document.body;
  const { scrollY } = scrollLockState;

  body.style.position = scrollLockState.bodyPosition;
  body.style.top = scrollLockState.bodyTop;
  body.style.left = scrollLockState.bodyLeft;
  body.style.right = scrollLockState.bodyRight;
  body.style.width = scrollLockState.bodyWidth;
  body.style.overflow = scrollLockState.bodyOverflow;
  doc.style.overflow = scrollLockState.docOverflow;
  body.classList.remove('is-modal-open');
  doc.classList.remove('is-modal-open');
  scrollLockState = null;

  try { window.scrollTo(0, scrollY); } catch {}
}

function onBackdropClick(ev) {
  if (ev.target === root) close();
}

async function handleShowOnMap() {
  const load = getCurrent();
  if (!load) return;
  close();
  if (window.__router && typeof window.__router.navigate === 'function') {
    await window.__router.navigate('/map.html');
  } else {
    location.href = '/map.html';
    return;
  }
  const w = window.__mapWidget;
  if (!w) return;
  try { await w.ready; } catch { return; }
  w.highlightLoad(load.id);
}

async function handleCenterOnMap() {
  const load = getCurrent();
  if (!load) return;
  close();
  const w = window.__mapWidget;
  if (!w) return;
  try { await w.ready; } catch { return; }
  if (typeof w.focusTarget === 'function') w.focusTarget(load.id);
}

function handleAssignCarrier() {
  const load = getCurrent();
  if (!load) return;
  window.dispatchEvent(new CustomEvent('load-action', {
    detail: { action: 'assign', loadId: load.id }
  }));
}

function handleCallCarrier() {
  const load = getCurrent();
  if (!load) return;
  window.dispatchEvent(new CustomEvent('carrier-action', {
    detail: { action: 'call-driver', carrierId: load.carrierId || null, loadId: load.id }
  }));
}

function handleRequestStatus() {
  const load = getCurrent();
  if (!load) return;
  window.dispatchEvent(new CustomEvent('carrier-action', {
    detail: { action: 'request-status', carrierId: load.carrierId || null, loadId: load.id }
  }));
}

function onKeydown(ev) {
  if (ev.key === 'Escape') { close(); return; }
  if (ev.key === 'Tab') trapFocus(ev);
}

// Recompute the body-portal top offset when the viewport crosses the
// 640 px breakpoint while the modal is open (e.g. device rotation).
// Without this, rotating portrait→landscape leaves the offset unset and
// the modal slides under the sticky header. Listener is wired only while
// the modal is open and removed on close.
function onResize() {
  if (!root || !root.classList.contains('is-open')) return;
  if (window.innerWidth > 640) {
    const header = document.querySelector('.app-header');
    const hh = header ? Math.round(header.getBoundingClientRect().height) : 0;
    root.style.setProperty('--load-modal-top-offset', hh + 'px');
  } else {
    root.style.removeProperty('--load-modal-top-offset');
  }
}

export function open(load, opts = {}) {
  const resolved = resolveLoad(load);
  if (!resolved || !resolved.id) return;
  const el = ensureRoot();
  currentLoadId = resolved.id;
  currentOpts = opts;
  subscribeCurrentLoad();
  try {
    if (!isReady()) {
      initDataStore().then(() => {
        rerenderCurrent();
      }).catch(() => {});
    }
  } catch {}

  // Offset the desktop drawer below the sticky app-header. Mobile bottom
  // sheet sizing is handled entirely in CSS with dynamic viewport units.
  if (window.innerWidth > 640) {
    const header = document.querySelector('.app-header');
    const hh = header ? Math.round(header.getBoundingClientRect().height) : 0;
    el.style.setProperty('--load-modal-top-offset', hh + 'px');
  } else {
    el.style.removeProperty('--load-modal-top-offset');
  }

  populateFields(resolved);
  renderActions(resolved, opts);

  // Signal other panels to close
  window.dispatchEvent(new CustomEvent('modal:open', { detail: { kind: 'load' } }));

  lockPageScroll();
  el.setAttribute('aria-hidden', 'false');
  void el.offsetWidth;
  el.classList.add('is-open');

  // Focus close button
  const closeBtn = el.querySelector('.load-modal-close');
  if (closeBtn) closeBtn.focus();

  // ESC listener
  document.addEventListener('keydown', onKeydown);
  // Resize listener: recompute top-offset when crossing 640 px boundary.
  window.addEventListener('resize', onResize, { passive: true });
}

export function close() {
  if (!root || !root.classList.contains('is-open')) return;
  const opener = currentOpts && currentOpts.opener;

  root.classList.remove('is-open');
  document.removeEventListener('keydown', onKeydown);
  window.removeEventListener('resize', onResize);

  const reduced = prefersReducedMotion();
  const done = () => {
    root.setAttribute('aria-hidden', 'true');
    root.removeEventListener('transitionend', done);
    unlockPageScroll();
    // Return focus
    if (opener && opener.isConnected && typeof opener.focus === 'function') {
      opener.focus();
    }
  };

  if (reduced) {
    done();
  } else {
    root.addEventListener('transitionend', done, { once: true });
    // Fallback
    setTimeout(done, 300);
  }

  clearStoreSubscriptions();
  currentLoadId = null;
  currentOpts = null;
}

export function isOpen() {
  return !!(root && root.classList.contains('is-open'));
}

export function getCurrent() {
  return currentLoadId ? getLoad(currentLoadId) : null;
}

export function setLoadId(id) {
  const load = getLoad(id);
  if (!load) return false;
  currentLoadId = load.id;
  subscribeCurrentLoad();
  rerenderCurrent();
  return true;
}

export function setData() {
  return false;
}

// Window globals
window.__loadModal = { open, close, isOpen, getCurrent, setLoadId, setData };
window.__modals = window.__modals || {};
window.__modals.closeAll = () => {
  try { window.__loadModal.close(); } catch {}
  // Also dismiss the carrier aside if it is open (owned by map-widget).
  try {
    const carrierClose = document.querySelector('.carrier-panel.is-open .carrier-panel-close');
    if (carrierClose) carrierClose.click();
  } catch {}
};
