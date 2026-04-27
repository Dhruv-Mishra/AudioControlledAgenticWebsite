// load-modal.js — singleton body-portal modal for load detail.
// Auto-registers window.__loadModal and window.__modals.closeAll.

const STATUS_LABEL = {
  in_transit: { label: 'In transit', chip: 'info' },
  booked:     { label: 'Booked',     chip: 'neutral' },
  pending:    { label: 'Pending',    chip: 'warn' },
  delayed:    { label: 'Delayed',    chip: 'danger' },
  delivered:  { label: 'Delivered',  chip: 'ok' }
};

const MODAL_HTML = `<div id="load-modal-root" class="load-modal" data-modal-root="load" aria-hidden="true"
     aria-label="Load detail">
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
      <h2 class="load-modal-title" data-agent-id="load_modal.title"
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
let currentLoad = null;
let currentOpts = null;
let cachedData = { carriers: [], loads: [] };

function prefersReducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

function ensureRoot() {
  const mapRoot = document.getElementById('map-root');
  // Reparent if the preferred host changed (SPA nav between map ↔ other pages)
  if (root && root.isConnected) {
    const desired = mapRoot || document.body;
    if (root.parentNode !== desired) desired.appendChild(root);
    return root;
  }
  root = document.getElementById('load-modal-root');
  if (root) {
    const desired = mapRoot || document.body;
    if (root.parentNode !== desired) desired.appendChild(root);
    return root;
  }
  const div = document.createElement('div');
  div.innerHTML = MODAL_HTML;
  root = div.firstElementChild;
  // Prefer mounting inside the map root so vertical placement matches
  // the carrier-panel aside (which is also a child of #map-root and uses
  // position:absolute relative to it). Falls back to <body> on pages
  // without a map (e.g. dispatch) where position:fixed kicks in.
  (mapRoot || document.body).appendChild(root);
  // Close button
  const closeBtn = root.querySelector('.load-modal-close');
  if (closeBtn) closeBtn.addEventListener('click', close);
  return root;
}

function fmtMiles(n) {
  return n == null ? '—' : `${Number(n).toLocaleString('en-US')} mi`;
}
function fmtWeight(n) {
  return n == null ? '—' : `${Number(n).toLocaleString('en-US')} lb`;
}
function fmtRate(n) {
  return n == null ? '—' : `$${Number(n).toLocaleString('en-US')}`;
}
function fmtEta(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch { return '—'; }
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function resolveCarrier(load) {
  const carriers = cachedData.carriers || [];
  return carriers.find((c) => c.id === load.carrierId || c.name === load.carrier) || null;
}

function populateFields(load) {
  const el = root;
  const statusMeta = STATUS_LABEL[load.status] || { label: load.status || '—', chip: 'neutral' };

  // Status chip
  const statusEl = el.querySelector('[data-modal-field="status"]');
  if (statusEl) {
    statusEl.textContent = statusMeta.label;
    statusEl.className = `chip load-modal-status chip--${statusMeta.chip}`;
  }

  // Title
  const titleEl = el.querySelector('[data-modal-field="title"]');
  if (titleEl) titleEl.textContent = `Load ${load.id}`;

  // Route
  setField('pickup', load.pickup || '—');
  setField('dropoff', load.dropoff || '—');
  setField('miles', fmtMiles(load.miles));

  // Shipment
  setField('commodity', load.commodity || '—');
  setField('weight', fmtWeight(load.weight));
  setField('rate', fmtRate(load.rate));
  setField('eta', fmtEta(load.eta));

  // Carrier
  const carrier = resolveCarrier(load);
  setField('carrier', carrier ? carrier.name : (load.carrier || 'Unassigned'));

  // Subtitle
  const subtitle = root.querySelector('.load-modal-subtitle');
  if (subtitle) {
    const milesPart = load.miles ? `${Number(load.miles).toLocaleString('en-US')} mi` : '';
    const etaPart = load.eta ? `ETA ${fmtEta(load.eta)}` : '';
    const route = `${load.pickup || '?'} → ${load.dropoff || '?'}`;
    subtitle.textContent = [route, milesPart, etaPart].filter(Boolean).join(' · ');
  }

  // Hero image
  const slug = carrier && carrier.imageSlug ? carrier.imageSlug : 'truck-generic';
  const imgSrc = `/public/images/carriers/${slug}.webp`;
  const source = el.querySelector('[data-modal-field="hero_srcset"]');
  const img = el.querySelector('[data-modal-field="hero_img"]');
  if (source) source.setAttribute('srcset', imgSrc);
  if (img) {
    img.classList.remove('is-loaded');
    img.onload = () => img.classList.add('is-loaded');
    img.onerror = () => img.classList.add('is-loaded');
    img.src = imgSrc;
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

async function handleShowOnMap() {
  const load = currentLoad;
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

function handleCenterOnMap() {
  const load = currentLoad;
  if (!load) return;
  close();
  if (window.__mapWidget) window.__mapWidget.highlightLoad(load.id);
}

function handleAssignCarrier() {
  const load = currentLoad;
  if (!load) return;
  window.dispatchEvent(new CustomEvent('load-action', {
    detail: { action: 'assign', loadId: load.id }
  }));
}

function handleCallCarrier() {
  const load = currentLoad;
  if (!load) return;
  window.dispatchEvent(new CustomEvent('carrier-action', {
    detail: { action: 'call-driver', carrierId: load.carrierId || null, loadId: load.id }
  }));
}

function handleRequestStatus() {
  const load = currentLoad;
  if (!load) return;
  window.dispatchEvent(new CustomEvent('carrier-action', {
    detail: { action: 'request-status', carrierId: load.carrierId || null, loadId: load.id }
  }));
}

function onKeydown(ev) {
  if (ev.key === 'Escape') { close(); }
}

// Recompute the body-portal top offset when the viewport crosses the
// 640 px breakpoint while the modal is open (e.g. device rotation).
// Without this, rotating portrait→landscape leaves the offset unset and
// the modal slides under the sticky header. Listener is wired only while
// the modal is open and removed on close.
function onResize() {
  if (!root || !root.classList.contains('is-open')) return;
  if (root.parentNode !== document.body) return;
  if (window.innerWidth > 640) {
    const header = document.querySelector('.app-header');
    const hh = header ? Math.round(header.getBoundingClientRect().height) : 0;
    root.style.setProperty('--load-modal-top-offset', hh + 'px');
  } else {
    root.style.removeProperty('--load-modal-top-offset');
  }
}

export function open(load, opts = {}) {
  if (!load) return;
  const el = ensureRoot();
  currentLoad = load;
  currentOpts = opts;

  // When body-portaled (no #map-root on the page, e.g. dispatch), offset
  // the panel below the sticky app-header so it doesn't overlap. On the
  // map page the panel lives inside #map-root and this is a no-op.
  // Skip on mobile (≤640 px) — bottom-sheet layout doesn't use top offset.
  if (el.parentNode === document.body && window.innerWidth > 640) {
    const header = document.querySelector('.app-header');
    const hh = header ? Math.round(header.getBoundingClientRect().height) : 0;
    el.style.setProperty('--load-modal-top-offset', hh + 'px');
  } else {
    el.style.removeProperty('--load-modal-top-offset');
  }

  populateFields(load);
  renderActions(load, opts);

  // Signal other panels to close
  window.dispatchEvent(new CustomEvent('modal:open', { detail: { kind: 'load' } }));

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

  currentLoad = null;
  currentOpts = null;
}

export function isOpen() {
  return !!(root && root.classList.contains('is-open'));
}

export function getCurrent() {
  return currentLoad;
}

export function setData(data) {
  if (data && data.carriers) cachedData.carriers = data.carriers;
  if (data && data.loads) cachedData.loads = data.loads;
}

// Window globals
window.__loadModal = { open, close, isOpen, getCurrent, setData };
window.__modals = window.__modals || {};
window.__modals.closeAll = () => {
  try { window.__loadModal.close(); } catch {}
  // Also dismiss the carrier aside if it is open (owned by map-widget).
  try {
    const carrierClose = document.querySelector('.carrier-panel.is-open .carrier-panel-close');
    if (carrierClose) carrierClose.click();
  } catch {}
};
