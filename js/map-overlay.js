// Production-grade NON-INVASIVE map overlay.
//
// Truck markers are parented INSIDE Leaflet's `overlayPane`. That pane is
// transformed by Leaflet during zoom animations, so our trucks track the
// zoom natively — no per-frame JS, no hide/show flicker, no drift.
//
// Positions use map.latLngToLayerPoint(latLng) (relative to the layer
// origin), which Leaflet keeps in sync with the pane's transform. We only
// reposition on `viewreset` (zoomend / pan stop) and a slow 5s drift
// timer — never during the zoom animation itself.
//
// Click selection: trucks have pointer-events:auto; the wrapper does not.
// The overlay never blocks map drag/zoom.

import { getLoad, listCarriers, listLoads } from './data-store.js';
import { loadProgress } from './formatters.js';
import * as pageState from './page-state.js';

const CARRIER_HQ_CITY = {
  'C-088': 'Newark, NJ',
  'C-118': 'Atlanta, GA',
  'C-204': 'Chicago, IL',
  'C-302': 'Seattle, WA',
  'C-410': 'Memphis, TN',
  'C-511': 'Minneapolis, MN',
  'C-722': 'Houston, TX',
  'C-845': 'Los Angeles, CA'
};
const CITY_LATLNG = {
  'Newark, NJ':       { lat: 40.7357, lng: -74.1724 },
  'Atlanta, GA':      { lat: 33.7490, lng: -84.3880 },
  'Chicago, IL':      { lat: 41.8781, lng: -87.6298 },
  'Seattle, WA':      { lat: 47.6062, lng: -122.3321 },
  'Memphis, TN':      { lat: 35.1495, lng: -90.0490 },
  'Minneapolis, MN':  { lat: 44.9778, lng: -93.2650 },
  'Houston, TX':      { lat: 29.7604, lng: -95.3698 },
  'Los Angeles, CA':  { lat: 34.0522, lng: -118.2437 }
};

const TRUCK_GLYPH =
  '<svg viewBox="0 0 32 20" width="22" height="14" aria-hidden="true">' +
  // Cab
  '<rect x="19" y="6"  width="10" height="9"  rx="1.5" fill="currentColor"/>' +
  // Windshield
  '<rect x="21" y="7.5" width="4"  height="3"  rx="0.6" fill="#0c0c0d" opacity="0.6"/>' +
  // Trailer
  '<rect x="2"  y="3"  width="17" height="12" rx="1.2" fill="currentColor" opacity="0.85"/>' +
  // Wheels
  '<circle cx="7"  cy="17" r="2.2" fill="#0c0c0d"/>' +
  '<circle cx="7"  cy="17" r="1.1" fill="currentColor"/>' +
  '<circle cx="14" cy="17" r="2.2" fill="#0c0c0d"/>' +
  '<circle cx="14" cy="17" r="1.1" fill="currentColor"/>' +
  '<circle cx="24" cy="17" r="2.2" fill="#0c0c0d"/>' +
  '<circle cx="24" cy="17" r="1.1" fill="currentColor"/>' +
  '</svg>';

function isMovable(load) {
  // Show a sprite on EVERY load that has resolvable endpoints. Pending /
  // booked / delivered drift slowly (handled in getLoadProgress).
  return !!load;
}

export function mountOverlay({ widgetApi, root, getLoads = listLoads, getCarriers = listCarriers }) {
  if (!widgetApi || typeof widgetApi._getLeafletMap !== 'function') {
    return () => {};
  }
  const map = widgetApi._getLeafletMap();
  const filterList = root && root.querySelector('#map-filter-list');
  if (!map) return () => {};

  // Dedicated pane ABOVE markerPane (600) and lanes (405) so trucks
  // always render on top of the dotted route. Created on first mount;
  // re-mount is safe because Leaflet's createPane is idempotent.
  let overlayPaneEl;
  try {
    if (!map.getPane('overlay-trucks-pane')) {
      const p = map.createPane('overlay-trucks-pane');
      p.style.zIndex = '650';
      p.style.pointerEvents = 'none';
    }
    overlayPaneEl = map.getPane('overlay-trucks-pane');
  } catch {}
  const panes = map.getPanes && map.getPanes();
  const host = overlayPaneEl || (panes && panes.overlayPane) || (map.getContainer && map.getContainer());
  if (!host) return () => {};

  const overlay = document.createElement('div');
  overlay.className = 'map-overlay';
  overlay.setAttribute('aria-hidden', 'true');
  // Zero-size positioning anchor at (0,0) of the layer system. Children
  // use absolute coords in the layer-point coordinate space.
  overlay.style.position = 'absolute';
  overlay.style.left = '0';
  overlay.style.top = '0';
  overlay.style.width = '0';
  overlay.style.height = '0';
  overlay.style.pointerEvents = 'none';
  host.appendChild(overlay);

  const truckEls = new Map(); // load.id -> { el, load }
  const carrierEls = new Map(); // carrier.id -> { el, latLng }
  let driftTimer = null;
  let listPaintTimer = null;
  let mutObs = null;

  function stopTimers() {
    if (driftTimer) {
      clearInterval(driftTimer);
      driftTimer = null;
    }
    if (listPaintTimer) {
      clearInterval(listPaintTimer);
      listPaintTimer = null;
    }
  }

  function startTimers() {
    if (typeof document !== 'undefined' && document.hidden) return;
    if (!driftTimer) driftTimer = setInterval(reposition, 500);
    if (!listPaintTimer) listPaintTimer = setInterval(paintListBars, 5000);
  }

  function onVisibilityChange() {
    if (document.hidden) {
      stopTimers();
      return;
    }
    reposition();
    paintListBars();
    startTimers();
  }

  function ensureTruckEl(load) {
    let entry = truckEls.get(load.id);
    if (entry) return entry;
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'map-overlay-truck';
    el.setAttribute('data-load-id', load.id);
    el.setAttribute('data-status', load.status || '');
    el.setAttribute('aria-label', `Truck ${load.id}, ${load.pickup} to ${load.dropoff}`);
    el.title = `${load.id}  ·  ${load.pickup} → ${load.dropoff}`;
    el.innerHTML = TRUCK_GLYPH;
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      handleSelect(load);
    });
    overlay.appendChild(el);
    entry = { el, load };
    truckEls.set(load.id, entry);
    return entry;
  }

  function removeTruckEl(loadId) {
    const entry = truckEls.get(loadId);
    if (!entry) return;
    try { entry.el.remove(); } catch {}
    truckEls.delete(loadId);
  }

  function reposition() {
    const now = Date.now();
    const activeIds = new Set();
    getLoads().forEach((l) => {
      activeIds.add(l.id);
      if (!isMovable(l)) {
        if (truckEls.has(l.id)) removeTruckEl(l.id);
        return;
      }
      const p = loadProgress(l, now);
      if (!p.currentLatLng) return;
      const entry = ensureTruckEl(l);
      let pt;
      try {
        // layerPoint, not containerPoint — during zoom anim the pane CSS
        // transform scales us along automatically.
        pt = map.latLngToLayerPoint([p.currentLatLng.lat, p.currentLatLng.lng]);
      } catch { return; }
      entry.el.style.transform =
        `translate3d(${Math.round(pt.x)}px, ${Math.round(pt.y)}px, 0) ` +
        `translate(-50%, -50%)`;
      if (entry.load.status !== l.status) {
        entry.el.setAttribute('data-status', l.status || '');
        entry.load = l;
      }
    });
    truckEls.forEach((entry, loadId) => {
      if (!activeIds.has(loadId)) removeTruckEl(loadId);
    });
    // Stationary carrier sprites at HQ.
    carrierEls.forEach((entry) => {
      let pt;
      try { pt = map.latLngToLayerPoint([entry.latLng.lat, entry.latLng.lng]); } catch { return; }
      entry.el.style.transform =
        `translate3d(${Math.round(pt.x)}px, ${Math.round(pt.y)}px, 0) ` +
        `translate(-50%, -50%)`;
    });
  }

  function ensureCarrierSprite(carrier) {
    if (carrierEls.has(carrier.id)) return;
    const city = CARRIER_HQ_CITY[carrier.id];
    const ll = city && CITY_LATLNG[city];
    if (!ll) return;
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'map-overlay-truck map-overlay-truck--carrier';
    el.setAttribute('data-carrier-id', carrier.id);
    el.setAttribute('aria-label', `Carrier ${carrier.name || carrier.id} at ${city}`);
    el.title = `${carrier.id}  ·  ${carrier.name || ''}  ·  ${city}`;
    el.innerHTML = TRUCK_GLYPH;
    overlay.appendChild(el);
    carrierEls.set(carrier.id, { el, latLng: ll });
  }

  getCarriers().forEach(ensureCarrierSprite);

  // Recompute layer-point positions when Leaflet resets the layer origin
  // (after every pan/zoom). During the actual zoom animation the pane
  // transform handles us — no JS needed.
  const onViewReset = () => reposition();
  const onZoomEnd   = () => reposition();
  const onMoveEnd   = () => reposition();
  map.on('viewreset', onViewReset);
  map.on('zoomend',   onZoomEnd);
  map.on('moveend',   onMoveEnd);
  map.on('resize',    onMoveEnd);

  // --- Side-rail list bars + ETA
  function decorateListRow(li) {
    if (!li || li.dataset.overlayDecorated === 'true') return;
    const child = li.firstElementChild;
    const agentId = child && child.getAttribute && child.getAttribute('data-agent-id');
    if (!agentId || !/^map\.list\.LD-/.test(agentId)) return;
    const id = agentId.replace('map.list.', '');
    const load = getLoad(id);
    if (!load) return;
    const bar = document.createElement('span');
    bar.className = 'map-list-progress';
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.dataset.status = load.status || '';
    bar.innerHTML = '<span></span><span class="map-list-progress-sprite" aria-hidden="true"></span>';
    li.appendChild(bar);
    const meta = li.querySelector('.meta');
    if (meta) {
      const eta = document.createElement('span');
      eta.className = 'map-list-eta mono';
      meta.appendChild(eta);
    }
    li.dataset.overlayDecorated = 'true';
    li.dataset.overlayLoadId = load.id;
  }

  function paintListBars() {
    if (!filterList) return;
    const now = Date.now();
    filterList.querySelectorAll('li[data-overlay-load-id]').forEach((li) => {
      const id = li.dataset.overlayLoadId;
      const load = getLoad(id);
      if (!load) return;
      const p = loadProgress(load, now);
      const bar = li.querySelector('.map-list-progress');
      if (bar) {
        const fill = bar.firstElementChild;
        const sprite = bar.querySelector('.map-list-progress-sprite');
        const pct = Math.round(p.progress * 100);
        if (fill) fill.style.width = `${pct}%`;
        if (sprite) sprite.style.left = `${pct}%`;
        bar.setAttribute('aria-valuenow', String(pct));
      }
      const eta = li.querySelector('.map-list-eta');
      if (eta) eta.textContent = ` · ${p.etaText}`;
    });
  }

  function decorateAll() {
    if (!filterList) return;
    filterList.querySelectorAll('li').forEach(decorateListRow);
    paintListBars();
    refreshSelectionHighlight();
  }

  if (filterList) {
    mutObs = new MutationObserver(() => requestAnimationFrame(decorateAll));
    mutObs.observe(filterList, { childList: true, subtree: false });
  }
  startTimers();
  try { document.addEventListener('visibilitychange', onVisibilityChange); } catch {}

  // --- Selection broadcast
  function handleSelect(load) {
    try { pageState.selectLoad(load.id, `${load.pickup || ''} → ${load.dropoff || ''}`); } catch {}
    refreshSelectionHighlight();
    try {
      if (window.__loadModal) {
        if (typeof window.__loadModal.setLoadId === 'function') window.__loadModal.setLoadId(load.id);
        window.__loadModal.open(load.id, { context: 'map' });
      }
    } catch {}
  }

  function refreshSelectionHighlight() {
    let sel;
    try { sel = pageState.getSelection(); } catch { sel = null; }
    const id = sel && sel.loadId;
    if (filterList) {
      filterList.querySelectorAll('li[data-overlay-load-id]').forEach((li) => {
        const isMatch = li.dataset.overlayLoadId === id;
        li.classList.toggle('is-selected', !!isMatch);
      });
    }
    truckEls.forEach((entry, loadId) => {
      entry.el.classList.toggle('is-selected', loadId === id);
    });
    // Highlight pickup/dropoff pins + lane polyline on the underlying map.
    try {
      if (widgetApi && typeof widgetApi._setLoadEmphasis === 'function') {
        widgetApi._setLoadEmphasis(id || null);
      }
    } catch {}
  }

  let unsubSelection = () => {};
  try {
    if (typeof pageState.subscribeSelection === 'function') {
      unsubSelection = pageState.subscribeSelection(refreshSelectionHighlight) || (() => {});
    }
  } catch {}

  decorateAll();
  reposition();

  return function destroy() {
    try { map.off('viewreset', onViewReset); } catch {}
    try { map.off('zoomend',   onZoomEnd);   } catch {}
    try { map.off('moveend',   onMoveEnd);   } catch {}
    try { map.off('resize',    onMoveEnd);   } catch {}
    stopTimers();
    try { document.removeEventListener('visibilitychange', onVisibilityChange); } catch {}
    if (mutObs) { try { mutObs.disconnect(); } catch {} }
    try { unsubSelection(); } catch {}
    truckEls.forEach((entry) => { try { entry.el.remove(); } catch {} });
    truckEls.clear();
    carrierEls.forEach((entry) => { try { entry.el.remove(); } catch {} });
    carrierEls.clear();
    try { overlay.remove(); } catch {}
  };
}
