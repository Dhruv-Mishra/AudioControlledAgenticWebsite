// Leaflet wrapper — lazy-loaded from js/page-map.js on /map.html.
//
// Ownership:
//   - init Leaflet once per mount, wire DOM-backed divIcon pins for loads
//     + carriers, draw lane polylines, render popups, manage the slide-in
//     detail panel + list-view fallback.
//   - expose a direct `window.__mapWidget` API object with a `ready`
//     Promise so agent tool handlers can `await` it before calling the
//     widget. No document-event bridge.

const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
// For a production deploy with real traffic, swap to Stadia's free tier
// by setting STADIA_API_KEY in .env and using:
//   https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png?api_key=...
const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';

const DEFAULT_VIEW = { lat: 39.5, lng: -98.35, zoom: 4 };

// World envelope used to clamp panning. Slightly inset from the
// mathematical poles because Web Mercator distorts above ~85°.
const WORLD_BOUNDS = [[-85.05112878, -180], [85.05112878, 180]];
const TILE_PIXEL_SIZE = 256;
// Hard floor so we never let the user zoom out further than "the world
// shows once". 2 → roughly 1024 px wide world; we still recompute per
// container below.
const ABSOLUTE_MIN_ZOOM = 2;

// Compute the smallest zoom level at which a single (un-tiled,
// un-wrapped) world copy completely fills `containerWidth` CSS pixels.
// At zoom z, the world is `TILE_PIXEL_SIZE * 2^z` pixels wide. We need
// 2^z * 256 >= width, so z >= log2(width / 256). ceil() guarantees the
// world is at least as wide as the viewport — anything smaller would
// expose blank space (or, with wrap on, a repeating strip).
function computeMinZoomForWidth(containerWidth) {
  const w = Math.max(1, Number(containerWidth) || 1);
  const raw = Math.log2(w / TILE_PIXEL_SIZE);
  const ceil = Math.ceil(raw);
  return Math.max(ABSOLUTE_MIN_ZOOM, Number.isFinite(ceil) ? ceil : ABSOLUTE_MIN_ZOOM);
}

const PAN_DURATION_LOCAL_S = 0.28;
const PAN_DURATION_FLY_S   = 0.90;
const FLY_THRESHOLD_KM     = 1500;

// Frozen city → {lat, lng} lookup. Covers every city referenced in
// data/loads.json + data/carriers.json plus common dispatch cities.
const CITY_COORDS = Object.freeze({
  'Atlanta, GA':        { lat: 33.7490, lng: -84.3880 },
  'Austin, TX':         { lat: 30.2672, lng: -97.7431 },
  'Charlotte, NC':      { lat: 35.2271, lng: -80.8431 },
  'Chicago, IL':        { lat: 41.8781, lng: -87.6298 },
  'Dallas, TX':         { lat: 32.7767, lng: -96.7970 },
  'Denver, CO':         { lat: 39.7392, lng: -104.9903 },
  'Detroit, MI':        { lat: 42.3314, lng: -83.0458 },
  'Houston, TX':        { lat: 29.7604, lng: -95.3698 },
  'Indianapolis, IN':   { lat: 39.7684, lng: -86.1581 },
  'Jacksonville, FL':   { lat: 30.3322, lng: -81.6557 },
  'Kansas City, MO':    { lat: 39.0997, lng: -94.5786 },
  'Las Vegas, NV':      { lat: 36.1699, lng: -115.1398 },
  'Los Angeles, CA':    { lat: 34.0522, lng: -118.2437 },
  'Memphis, TN':        { lat: 35.1495, lng: -90.0490 },
  'Miami, FL':          { lat: 25.7617, lng: -80.1918 },
  'Minneapolis, MN':    { lat: 44.9778, lng: -93.2650 },
  'Nashville, TN':      { lat: 36.1627, lng: -86.7816 },
  'Newark, NJ':         { lat: 40.7357, lng: -74.1724 },
  'New Orleans, LA':    { lat: 29.9511, lng: -90.0715 },
  'New York, NY':       { lat: 40.7128, lng: -74.0060 },
  'Orlando, FL':        { lat: 28.5383, lng: -81.3792 },
  'Philadelphia, PA':   { lat: 39.9526, lng: -75.1652 },
  'Phoenix, AZ':        { lat: 33.4484, lng: -112.0740 },
  'Portland, OR':       { lat: 45.5152, lng: -122.6784 },
  'Salt Lake City, UT': { lat: 40.7608, lng: -111.8910 },
  'San Francisco, CA':  { lat: 37.7749, lng: -122.4194 },
  'Seattle, WA':        { lat: 47.6062, lng: -122.3321 },
  'St. Louis, MO':      { lat: 38.6270, lng: -90.1994 }
});

// Carrier HQ fallback — keyed by id.
const CARRIER_HQ = Object.freeze({
  'C-088': { city: 'Newark, NJ' },
  'C-118': { city: 'Atlanta, GA' },
  'C-204': { city: 'Chicago, IL' },
  'C-302': { city: 'Seattle, WA' },
  'C-410': { city: 'Memphis, TN' },
  'C-511': { city: 'Minneapolis, MN' },
  'C-722': { city: 'Houston, TX' },
  'C-845': { city: 'Los Angeles, CA' }
});

function prefersReducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

function injectLeafletCss() {
  const hrefs = ['/public/leaflet/leaflet.css'];
  hrefs.forEach((href) => {
    if (document.head.querySelector(`link[data-leaflet-css="${href}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.setAttribute('data-leaflet-css', href);
    document.head.appendChild(link);
  });
}

// Leaflet is vendored under public/leaflet/ and loaded via classic <script>
// tags (UMD). No bare specifiers; nothing for esbuild to resolve.
const LEAFLET_UMD_URL = '/public/leaflet/leaflet.js';

function loadScriptOnce(url) {
  return new Promise((resolve, reject) => {
    const existing = document.head.querySelector(`script[data-vendor-src="${url}"]`);
    if (existing) {
      if (existing.dataset.loaded === 'true') { resolve(); return; }
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error(`Failed to load ${url}`)), { once: true });
      return;
    }
    const s = document.createElement('script');
    s.src = url;
    s.async = false;
    s.defer = false;
    s.setAttribute('data-vendor-src', url);
    s.addEventListener('load', () => { s.dataset.loaded = 'true'; resolve(); }, { once: true });
    s.addEventListener('error', () => reject(new Error(`Failed to load ${url}`)), { once: true });
    document.head.appendChild(s);
  });
}

let _leafletPromise = null;
async function loadLeaflet() {
  if (typeof window !== 'undefined' && window.L && typeof window.L.map === 'function') {
    return window.L;
  }
  if (_leafletPromise) return _leafletPromise;
  _leafletPromise = (async () => {
    await loadScriptOnce(LEAFLET_UMD_URL);
    if (typeof window === 'undefined' || !window.L || typeof window.L.map !== 'function') {
      throw new Error('Leaflet UMD script loaded but window.L is not the expected namespace.');
    }
    return window.L;
  })();
  return _leafletPromise;
}

function resolveCity(name) {
  if (!name) return null;
  const trimmed = String(name).trim();
  return CITY_COORDS[trimmed] || null;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function fmtMiles(n) { return n == null ? '—' : `${Number(n).toLocaleString('en-US')} mi`; }
function fmtMoney(n) { return n == null ? '—' : `$${Number(n).toLocaleString('en-US')}`; }

function fmtEta(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch { return '—'; }
}

const STATUS_LABEL = {
  in_transit: 'In transit',
  booked: 'Booked',
  pending: 'Pending',
  delayed: 'Delayed',
  delivered: 'Delivered'
};

function statusChipClass(status) {
  switch (status) {
    case 'in_transit': return 'chip chip--info';
    case 'booked':     return 'chip chip--neutral';
    case 'pending':    return 'chip chip--warn';
    case 'delayed':    return 'chip chip--danger';
    case 'delivered':  return 'chip chip--ok';
    default:           return 'chip chip--neutral';
  }
}

function haversineKm(a, b) {
  const toRad = (x) => (x * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) *
    Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function shuffledSample(arr, n) {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

/**
 * Create a freshly-mounted map. Returns `{ api, destroy }` where `api`
 * matches the Widget API Freeze contract in specs/map-reliability-oracle.md §2
 * and is also exposed as `window.__mapWidget`.
 */
export async function createMap(root, { loads, carriers }, onEarlyApi) {
  const cleanups = [];
  const track = (fn) => cleanups.push(fn);
  let destroyed = false;

  const flashTimers = new Set();
  const tileRetryTimers = new Set();
  const pendingTransitionListeners = new Set();

  let readyResolve;
  let readyReject;
  let readySettled = false;
  const ready = new Promise((res, rej) => {
    readyResolve = (v) => { readySettled = true; res(v); };
    readyReject  = (e) => { readySettled = true; rej(e); };
  });
  // Prevent "unhandledrejection" noise if no caller awaits.
  ready.catch(() => {});

  // Settled by destroy() to unwind the first-tile await cleanly if the
  // caller tears us down mid-mount. Closes the partial-mount race where
  // window.__mapWidget would leak a live Leaflet instance.
  let firstTileReject = null;

  function envelopeOk(result) { return { ok: true, result }; }
  function envelopeErr(code, error) { return { ok: false, code, error }; }

  // Public API stub — methods are wired below. `destroy` must exist before
  // any `await` so partial-mount failures can still tear down.
  const api = {
    get isDestroyed() { return destroyed; },
    ready,
    panTo: () => envelopeErr('not_ready', 'Map not mounted yet.'),
    focusTarget: () => envelopeErr('not_ready', 'Map not mounted yet.'),
    highlightLoad: () => envelopeErr('not_ready', 'Map not mounted yet.'),
    focusCarrier: () => envelopeErr('not_ready', 'Map not mounted yet.'),
    setLayerVisible: () => envelopeErr('not_ready', 'Map not mounted yet.'),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (let i = cleanups.length - 1; i >= 0; i--) {
        try { cleanups[i](); } catch (err) { console.error('[map-widget] cleanup', err); }
      }
      cleanups.length = 0;
      flashTimers.forEach(clearTimeout); flashTimers.clear();
      tileRetryTimers.forEach(clearTimeout); tileRetryTimers.clear();
      pendingTransitionListeners.clear();
      // Wake the first-tile await so createMap can unwind through its
      // catch block (which calls api.destroy — idempotent).
      if (typeof firstTileReject === 'function') {
        const rej = firstTileReject; firstTileReject = null;
        try { rej(new Error('destroyed')); } catch {}
      }
      if (!readySettled) {
        try { readyReject({ ok: false, code: 'destroyed', error: 'Map torn down.' }); } catch {}
      }
    }
  };

  // Hand the partial api to the caller SYNCHRONOUSLY, before any await.
  // This closes the partial-mount race: if the caller navigates away
  // between here and the first `tileload`, page-map.js::exit can still
  // call `destroy()` on the stored early-api reference and everything
  // unwinds cleanly.
  if (typeof onEarlyApi === 'function') {
    try { onEarlyApi(api); } catch {}
  }

  try {
    injectLeafletCss();
    const L = await loadLeaflet();

    const canvas = root.querySelector('#map-canvas');
    const detail = root.querySelector('#map-detail');
    const attribution = root.querySelector('#map-attribution');
    const filterRail = root.querySelector('#map-filter-rail');
    const filterList = root.querySelector('#map-filter-list');
    const listView = root.querySelector('#map-list-view');
    const listViewItems = root.querySelector('#map-list-items');
    const listToggleBtn = root.querySelector('#map-list-toggle');
    const searchInput = root.querySelector('#map-search');
    const zoomInBtn = root.querySelector('#map-zoom-in');
    const zoomOutBtn = root.querySelector('#map-zoom-out');
    const resetBtn = root.querySelector('#map-reset');
    const tileErrorEl = root.querySelector('#map-tile-error');
    const tileRetryBtn = root.querySelector('#map-tile-retry');

    if (!canvas) throw new Error('map-widget: #map-canvas missing from partial');

    // Skeleton overlay — mounted BEFORE Leaflet instantiates.
    const skeleton = document.createElement('div');
    skeleton.className = 'map-skeleton';
    skeleton.setAttribute('data-agent-id', 'map.skeleton');
    skeleton.setAttribute('aria-hidden', 'true');
    const skeletonPulse = document.createElement('div');
    skeletonPulse.className = 'map-skeleton-pulse';
    const skeletonLabel = document.createElement('p');
    skeletonLabel.className = 'map-skeleton-label';
    skeletonLabel.textContent = 'Loading map…';
    skeleton.appendChild(skeletonPulse);
    skeleton.appendChild(skeletonLabel);
    canvas.appendChild(skeleton);
    track(() => { try { skeleton.remove(); } catch {} });

    // Empty state — hidden initially; shown when every toggleable layer is off.
    const emptyStateEl = document.createElement('div');
    emptyStateEl.className = 'map-empty-state';
    emptyStateEl.setAttribute('role', 'status');
    emptyStateEl.hidden = true;
    const emptyTitle = document.createElement('p');
    emptyTitle.className = 'map-empty-state-title';
    emptyTitle.textContent = 'Nothing to show';
    const emptyBody = document.createElement('p');
    emptyBody.className = 'map-empty-state-body';
    emptyBody.innerHTML = 'Toggle <strong>Loads</strong>, <strong>Carriers</strong>, or <strong>Lanes</strong> in the filter rail to reveal pins.';
    emptyStateEl.appendChild(emptyTitle);
    emptyStateEl.appendChild(emptyBody);
    canvas.appendChild(emptyStateEl);
    track(() => { try { emptyStateEl.remove(); } catch {} });

    const reducedAtMount = prefersReducedMotion();

    // Initial minZoom from the canvas's first measured width. We pin it
    // to a safe floor and then refine on the first resize observation,
    // because the canvas may not have its final size at construction
    // time (route mount before layout settles).
    const initialWidth = canvas.getBoundingClientRect().width || canvas.clientWidth || 1024;
    const initialMinZoom = computeMinZoomForWidth(initialWidth);

    const map = L.map(canvas, {
      keyboard: true,
      zoomControl: false,
      attributionControl: false,
      zoomAnimation: !reducedAtMount,
      markerZoomAnimation: !reducedAtMount,
      fadeAnimation: !reducedAtMount,
      preferCanvas: false,
      // World-wrap clamp — together these prevent the "infinite repeating
      // strip" bug. `worldCopyJump:false` stops Leaflet from teleporting
      // markers across antimeridian copies; `maxBounds` + viscosity 1.0
      // makes the panning rubber-band hard at the world envelope so the
      // user physically cannot drag past one world copy.
      worldCopyJump: false,
      maxBounds: WORLD_BOUNDS,
      maxBoundsViscosity: 1.0,
      minZoom: initialMinZoom,
      maxZoom: 18
    }).setView([DEFAULT_VIEW.lat, DEFAULT_VIEW.lng], Math.max(DEFAULT_VIEW.zoom, initialMinZoom));
    track(() => { try { map.remove(); } catch {} });

    // Dedicated panes per layer so we can fade whole layers via opacity on
    // a single DOM node instead of add/removeLayer.
    map.createPane('loads-pane');    map.getPane('loads-pane').style.zIndex    = '410';
    map.createPane('carriers-pane'); map.getPane('carriers-pane').style.zIndex = '420';
    map.createPane('lanes-pane');    map.getPane('lanes-pane').style.zIndex    = '405';

    const tileLayer = L.tileLayer(TILE_URL, {
      attribution: TILE_ATTRIBUTION,
      maxZoom: 18,
      minZoom: ABSOLUTE_MIN_ZOOM,
      // The single most important option for the wrap fix: do NOT request
      // tiles outside [-180, 180]. Without this Leaflet happily renders
      // x = -1, x = nTiles, etc., which is what produced the repeating
      // world-strip the user reported.
      noWrap: true,
      bounds: WORLD_BOUNDS
    });
    tileLayer.addTo(map);

    // Tile retry + error banner wiring.
    const tileState = {
      failed: 0, lastFailAt: 0, retries: new Map(),
      bannerShown: false, bannerShownAt: 0
    };
    const BANNER_MIN_HOLD_MS = 2000;
    const showTileErrorBanner = () => {
      if (!tileErrorEl || tileState.bannerShown) return;
      tileErrorEl.hidden = false;
      tileState.bannerShown = true;
      tileState.bannerShownAt = Date.now();
    };
    const hideTileErrorBanner = () => {
      if (!tileErrorEl || !tileState.bannerShown) return;
      // Hold the banner for at least BANNER_MIN_HOLD_MS before hiding
      // so a single late-arriving tileload doesn't flash it off-then-on.
      const age = Date.now() - tileState.bannerShownAt;
      if (age < BANNER_MIN_HOLD_MS) {
        const t = setTimeout(() => {
          tileRetryTimers.delete(t);
          if (tileState.failed === 0 && tileState.bannerShown && tileErrorEl) {
            tileErrorEl.hidden = true;
            tileState.bannerShown = false;
          }
        }, BANNER_MIN_HOLD_MS - age);
        tileRetryTimers.add(t);
        return;
      }
      tileErrorEl.hidden = true;
      tileState.bannerShown = false;
    };

    const onTileError = (ev) => {
      const now = Date.now();
      if (now - tileState.lastFailAt > 10_000) tileState.failed = 0;
      tileState.lastFailAt = now;
      tileState.failed++;
      const key = ev && ev.coords ? `${ev.coords.z}/${ev.coords.x}/${ev.coords.y}` : `r${Math.random()}`;
      const tries = tileState.retries.get(key) || 0;
      if (tries < 2) {
        tileState.retries.set(key, tries + 1);
        const t = setTimeout(() => {
          tileRetryTimers.delete(t);
          try { tileLayer.redraw(); } catch {}
        }, 800 + Math.random() * 400);
        tileRetryTimers.add(t);
      }
      if (tileState.failed > 5) showTileErrorBanner();
    };
    const onTileLoadEvt = () => {
      tileState.failed = Math.max(0, tileState.failed - 1);
      if (tileState.failed === 0) hideTileErrorBanner();
    };
    tileLayer.on('tileerror', onTileError);
    tileLayer.on('tileload', onTileLoadEvt);
    track(() => {
      try { tileLayer.off('tileerror', onTileError); } catch {}
      try { tileLayer.off('tileload', onTileLoadEvt); } catch {}
    });

    let onTileRetryClick = null;
    if (tileRetryBtn) {
      onTileRetryClick = () => {
        tileState.failed = 0;
        tileState.retries.clear();
        hideTileErrorBanner();
        try { tileLayer.redraw(); } catch {}
      };
      tileRetryBtn.addEventListener('click', onTileRetryClick);
      track(() => { try { tileRetryBtn.removeEventListener('click', onTileRetryClick); } catch {} });
    }

    // Render attribution into our own element so Leaflet's default chrome
    // stays off.
    if (attribution) {
      attribution.replaceChildren();
      attribution.append('© ');
      const osm = document.createElement('a');
      osm.href = 'https://www.openstreetmap.org/copyright';
      osm.target = '_blank';
      osm.rel = 'noopener';
      osm.textContent = 'OpenStreetMap';
      attribution.append(osm, ' contributors');
    }

    // --- layers (plain layerGroups on dedicated panes — no clustering)
    const loadLayer    = L.layerGroup([], { pane: 'loads-pane' });
    const carrierLayer = L.layerGroup([], { pane: 'carriers-pane' });
    const laneLayer    = L.layerGroup([], { pane: 'lanes-pane' });

    loadLayer.addTo(map);
    carrierLayer.addTo(map);
    laneLayer.addTo(map);
    track(() => { try { loadLayer.clearLayers(); } catch {} });
    track(() => { try { carrierLayer.clearLayers(); } catch {} });
    track(() => { try { laneLayer.clearLayers(); } catch {} });

    const visibleLayers = new Set(['loads', 'carriers', 'lanes']);
    let delayedOnly = false;

    // --- marker registry: id → entry
    const registry = new Map();
    track(() => registry.clear());

    // Currently selected carrier pin element (for is-selected toggle).
    let selectedPinEl = null;

    const TRUCK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28" fill="none">
  <rect x="8" y="6" width="12" height="16" rx="2" fill="currentColor" opacity="0.9"/>
  <path d="M10 6V3a1 1 0 011-1h6a1 1 0 011 1v3" fill="currentColor" opacity="0.7"/>
  <path d="M14 1l4 4h-8z" fill="currentColor"/>
  <circle cx="10" cy="22" r="1.5" fill="currentColor" opacity="0.5"/>
  <circle cx="18" cy="22" r="1.5" fill="currentColor" opacity="0.5"/>
</svg>`;

    function makeDivIcon(pinClass, ariaLabel, pane) {
      return L.divIcon({
        className: '',
        html: `<div class="map-pin ${pinClass}" tabindex="0" role="button" aria-label="${escapeHtml(ariaLabel)}">${TRUCK_SVG}</div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
        pane
      });
    }

    function makeCarrierDivIcon(carrier, ariaLabel, pane) {
      const statusCls = carrier.status ? `map-pin--${carrier.status}` : 'map-pin--carrier';
      const heading = typeof carrier.heading === 'number' ? carrier.heading : 0;
      return L.divIcon({
        className: '',
        html: `<div class="map-pin ${statusCls}" tabindex="0" role="button" aria-label="${escapeHtml(ariaLabel)}" style="transform: rotate(${heading}deg)">${TRUCK_SVG}</div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
        pane
      });
    }

    function addLoadMarker(load) {
      const pickupLL = resolveCity(load.pickup);
      const dropoffLL = resolveCity(load.dropoff);
      if (!pickupLL && !dropoffLL) return;

      const pinClass = `map-pin--${load.status || 'booked'}`;

      const pickupId = `map.pin.${load.id}.pickup`;
      const dropoffId = `map.pin.${load.id}.dropoff`;

      const pickupMarker = pickupLL
        ? L.marker([pickupLL.lat, pickupLL.lng], {
            icon: makeDivIcon(pinClass, `Load ${load.id} pickup, ${load.pickup || 'unknown coordinates'}`, 'loads-pane'),
            keyboard: true,
            pane: 'loads-pane'
          })
        : null;
      const dropoffMarker = dropoffLL
        ? L.marker([dropoffLL.lat, dropoffLL.lng], {
            icon: makeDivIcon(pinClass, `Load ${load.id} dropoff, ${load.dropoff || 'unknown coordinates'}`, 'loads-pane'),
            keyboard: true,
            pane: 'loads-pane'
          })
        : null;

      [pickupMarker, dropoffMarker].forEach((m, idx) => {
        if (!m) return;
        const side = idx === 0 ? 'pickup' : 'dropoff';
        m.on('click', () => openLoadDetail(load, side));
        m.on('keypress', (ev) => {
          const key = ev && ev.originalEvent && ev.originalEvent.key;
          if (key === 'Enter' || key === ' ') openLoadDetail(load, side);
        });
        loadLayer.addLayer(m);
        const pinEl = m.getElement();
        if (pinEl) pinEl.setAttribute('data-agent-id', idx === 0 ? pickupId : dropoffId);
      });

      let lane = null;
      if (pickupLL && dropoffLL) {
        const pending = !load.carrier || load.status === 'pending';
        const laneClass = pending ? 'map-lane map-lane--pending' : 'map-lane';
        lane = L.polyline(
          [[pickupLL.lat, pickupLL.lng], [dropoffLL.lat, dropoffLL.lng]],
          { className: laneClass, weight: 2, interactive: true, pane: 'lanes-pane' }
        );
        lane.on('click', () => openLoadDetail(load));
        laneLayer.addLayer(lane);
      }

      registry.set(load.id, {
        kind: 'load',
        record: load,
        pickup: pickupMarker,
        dropoff: dropoffMarker,
        pickupLL,
        dropoffLL,
        lane,
        pickupAgentId: pickupId,
        dropoffAgentId: dropoffId
      });
    }

    function addCarrierMarker(carrier) {
      const hq = CARRIER_HQ[carrier.id];
      const coords = hq ? resolveCity(hq.city) : null;
      if (!coords) return;
      const id = `map.pin.${carrier.id}`;
      const m = L.marker([coords.lat, coords.lng], {
        icon: makeCarrierDivIcon(carrier, `Carrier ${carrier.name} in ${hq.city}`, 'carriers-pane'),
        keyboard: true,
        pane: 'carriers-pane'
      });
      m.bindPopup(buildCarrierPopup(carrier, hq.city));
      const handleClick = () => {
        // Toggle is-selected on pins
        if (selectedPinEl) selectedPinEl.classList.remove('is-selected');
        const el = m.getElement();
        const pin = el && el.querySelector('.map-pin');
        if (pin) {
          pin.classList.add('is-selected');
          selectedPinEl = pin;
        }
        openCarrierPanel(carrier, hq.city, pin);
      };
      m.on('click', handleClick);
      m.on('keypress', (ev) => {
        const key = ev && ev.originalEvent && ev.originalEvent.key;
        if (key === 'Enter' || key === ' ') handleClick();
      });
      carrierLayer.addLayer(m);
      const pinEl = m.getElement();
      if (pinEl) pinEl.setAttribute('data-agent-id', id);
      registry.set(carrier.id, { kind: 'carrier', record: carrier, marker: m, coords, agentId: id });
    }

    function buildCarrierPopup(carrier, city) {
      const wrap = document.createElement('div');
      const head = document.createElement('div');
      head.className = 'map-popup-title';
      head.textContent = carrier.name;
      const sub = document.createElement('div');
      sub.className = 'map-popup-sub';
      sub.textContent = `${carrier.mc || ''} · ${city || ''} · ${carrier.available ? 'Available' : 'Assigned'}`;
      wrap.appendChild(head);
      wrap.appendChild(sub);
      return wrap;
    }

    let renderFilterListTimer = null;
    function renderFilterListImmediate() {
      if (!filterList) return;
      filterList.replaceChildren();
      const q = searchInput && searchInput.value ? searchInput.value.trim().toLowerCase() : '';

      const addItem = ({ id, dotColor, label, meta, onClick }) => {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'map-filter-list-item';
        btn.setAttribute('data-agent-id', id);
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.style.background = dotColor;
        const text = document.createElement('span');
        text.innerHTML = `${escapeHtml(label)}<br><span class="meta">${escapeHtml(meta)}</span>`;
        btn.appendChild(dot);
        btn.appendChild(text);
        btn.addEventListener('click', onClick);
        li.appendChild(btn);
        filterList.appendChild(li);
      };

      if (visibleLayers.has('loads')) {
        loads.forEach((l) => {
          if (delayedOnly && l.status !== 'delayed') return;
          if (q && !`${l.id} ${l.pickup} ${l.dropoff} ${l.carrier || ''}`.toLowerCase().includes(q)) return;
          addItem({
            id: `map.list.${l.id}`,
            dotColor: colorForStatus(l.status),
            label: `${l.id}`,
            meta: `${l.pickup || '?'} → ${l.dropoff || '?'}`,
            onClick: () => { focusLoadInternal(l.id); if (window.__loadModal) window.__loadModal.open(l, { context: 'map' }); }
          });
        });
      }
      if (visibleLayers.has('carriers')) {
        carriers.forEach((c) => {
          const hq = CARRIER_HQ[c.id];
          if (q && !`${c.id} ${c.name} ${hq && hq.city ? hq.city : ''}`.toLowerCase().includes(q)) return;
          addItem({
            id: `map.list.${c.id}`,
            dotColor: 'var(--color-info)',
            label: c.name,
            meta: `${c.id}${hq ? ' · ' + hq.city : ''}`,
            onClick: () => focusCarrierInternal(c.id)
          });
        });
      }
    }
    function renderFilterList() {
      // 80ms debounce per Oracle [W9]
      if (renderFilterListTimer) clearTimeout(renderFilterListTimer);
      renderFilterListTimer = setTimeout(() => {
        renderFilterListTimer = null;
        renderFilterListImmediate();
      }, 80);
    }
    track(() => {
      if (renderFilterListTimer) { clearTimeout(renderFilterListTimer); renderFilterListTimer = null; }
      if (filterList) { try { filterList.replaceChildren(); } catch {} }
    });

    function colorForStatus(s) {
      switch (s) {
        case 'booked': return 'var(--color-accent)';
        case 'pending': return 'var(--color-warn)';
        case 'delayed': return 'var(--color-danger)';
        case 'delivered': return 'var(--color-text-dim)';
        case 'in_transit': return 'var(--color-info)';
        default: return 'var(--color-text-muted)';
      }
    }

    function renderListView() {
      if (!listViewItems) return;
      listViewItems.replaceChildren();
      loads.forEach((l) => {
        const li = document.createElement('li');
        li.textContent = `${l.id} — ${l.pickup || '?'} → ${l.dropoff || '?'}`;
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = `${STATUS_LABEL[l.status] || l.status} · ${fmtMiles(l.miles)} · ETA ${fmtEta(l.eta)}`;
        li.appendChild(meta);
        li.setAttribute('role', 'button');
        li.setAttribute('tabindex', '0');
        li.setAttribute('aria-label', `Load ${l.id}, ${l.pickup || ''} to ${l.dropoff || ''}`);
        const openLoad = () => {
          focusLoadInternal(l.id);
          if (window.__loadModal) { try { window.__loadModal.open(l, { context: 'map' }); } catch {} }
        };
        li.addEventListener('click', openLoad);
        li.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openLoad(); }
        });
        listViewItems.appendChild(li);
      });
      carriers.forEach((c) => {
        const hq = CARRIER_HQ[c.id];
        const li = document.createElement('li');
        li.textContent = `${c.name} (${c.id})`;
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = `${hq ? hq.city : 'Unknown HQ'} · ${c.available ? 'Available' : 'Assigned'}`;
        li.appendChild(meta);
        listViewItems.appendChild(li);
      });
    }

    // --- detail panel

    let detailOpener = null;

    function openDetailPanel(contentNode, opener) {
      if (!detail) return;
      closeCarrierPanel();
      detail.replaceChildren();
      const hdr = document.createElement('div');
      hdr.className = 'map-detail-header';
      const h = document.createElement('h2');
      h.textContent = contentNode.dataset.title || 'Detail';
      hdr.appendChild(h);
      const close = document.createElement('button');
      close.className = 'icon-btn';
      close.type = 'button';
      close.setAttribute('aria-label', 'Close detail');
      close.textContent = '×';
      close.addEventListener('click', closeDetailPanel);
      hdr.appendChild(close);
      detail.appendChild(hdr);
      detail.appendChild(contentNode);
      detail.hidden = false;
      void detail.offsetWidth;
      detail.classList.add('is-open');
      detailOpener = opener || null;
      try { close.focus(); } catch {}
    }

    function closeDetailPanel() {
      if (!detail) return;
      detail.classList.remove('is-open');
      const reduced = prefersReducedMotion();
      const done = () => {
        detail.hidden = true;
        detail.removeEventListener('transitionend', done);
        pendingTransitionListeners.delete(done);
      };
      if (reduced) {
        done();
      } else {
        detail.addEventListener('transitionend', done);
        pendingTransitionListeners.add(done);
      }
      const opener = detailOpener;
      detailOpener = null;
      if (opener && typeof opener.focus === 'function') {
        try { opener.focus(); } catch {}
      }
    }
    track(() => {
      if (!detail) return;
      pendingTransitionListeners.forEach((fn) => {
        try { detail.removeEventListener('transitionend', fn); } catch {}
      });
      pendingTransitionListeners.clear();
    });

    function openLoadDetail(load, side) {
      const entry = registry.get(load.id);
      const opener = entry && entry[side] ? entry[side].getElement() : (entry && entry.pickup ? entry.pickup.getElement() : null);
      if (window.__loadModal) {
        closeCarrierPanel();
        window.__loadModal.open(load, { context: 'map', opener });
        return;
      }
      // Fallback: old detail panel
      const wrap = document.createElement('div');
      wrap.dataset.title = `Load ${load.id}`;
      const dl = document.createElement('dl');
      dl.className = 'detail-kv';
      const kv = [
        ['Status', STATUS_LABEL[load.status] || load.status],
        ['Pickup', load.pickup || '—'],
        ['Dropoff', load.dropoff || '—'],
        ['Carrier', load.carrier || 'Unassigned'],
        ['Commodity', load.commodity || '—'],
        ['Miles', fmtMiles(load.miles)],
        ['Rate', fmtMoney(load.rate)],
        ['ETA', fmtEta(load.eta)]
      ];
      kv.forEach(([k, v]) => {
        const dt = document.createElement('dt'); dt.textContent = k;
        const dd = document.createElement('dd'); dd.textContent = v;
        dl.appendChild(dt); dl.appendChild(dd);
      });
      wrap.appendChild(dl);
      openDetailPanel(wrap, opener);
    }

    function openCarrierDetail(carrier, city) {
      const wrap = document.createElement('div');
      wrap.dataset.title = carrier.name;
      const dl = document.createElement('dl');
      dl.className = 'detail-kv';
      const kv = [
        ['ID', carrier.id],
        ['MC', carrier.mc || '—'],
        ['DOT', carrier.dot || '—'],
        ['HQ', city || 'Unknown'],
        ['Rating', typeof carrier.rating === 'number' ? carrier.rating.toFixed(1) : '—'],
        ['Equipment', (carrier.equipment || []).join(', ') || '—'],
        ['Lanes', (carrier.lanes || []).join(', ') || '—'],
        ['Available', carrier.available ? 'Yes' : 'No'],
        ['Phone', carrier.phone || '—']
      ];
      kv.forEach(([k, v]) => {
        const dt = document.createElement('dt'); dt.textContent = k;
        const dd = document.createElement('dd'); dd.textContent = v;
        dl.appendChild(dt); dl.appendChild(dd);
      });
      wrap.appendChild(dl);

      const entry = registry.get(carrier.id);
      const opener = entry && entry.marker ? entry.marker.getElement() : null;
      openDetailPanel(wrap, opener);
    }

    // --- Carrier detail panel (FlightRadar-style aside) ---

    const carrierPanel = root.querySelector('#carrier-detail-panel');
    let carrierPanelOpener = null;

    const STATUS_LABEL_CARRIER = {
      idle: 'Idle',
      in_transit: 'In transit',
      delayed: 'Delayed',
      loading: 'Loading',
      booked: 'Booked',
      delivered: 'Delivered'
    };

    function carrierStatusChipClass(status) {
      switch (status) {
        case 'in_transit': return 'chip chip--info';
        case 'idle':       return 'chip chip--neutral';
        case 'delayed':    return 'chip chip--danger';
        case 'loading':    return 'chip chip--warn';
        case 'booked':     return 'chip chip--neutral';
        default:           return 'chip chip--neutral';
      }
    }

    function openCarrierPanel(carrier, city, openerEl) {
      if (!carrierPanel) {
        // Fallback to old drawer if panel markup missing
        openCarrierDetail(carrier, city);
        return;
      }

      closeDetailPanel();
      try { window.__loadModal?.close(); } catch {}
      carrierPanelOpener = openerEl || null;

      // Image
      const slug = carrier.imageSlug || 'truck-generic';
      const imgSrc = `/public/images/carriers/${slug}.webp`;
      const source = carrierPanel.querySelector('.carrier-panel-hero source');
      const img = carrierPanel.querySelector('.carrier-panel-img');
      if (source) source.setAttribute('srcset', imgSrc);
      if (img) {
        img.src = imgSrc;
        img.alt = `${carrier.name} truck`;
      }

      // Status chip
      const statusEl = carrierPanel.querySelector('.carrier-panel-status');
      if (statusEl) {
        statusEl.className = `chip carrier-panel-status ${carrierStatusChipClass(carrier.status).replace('chip ', '')}`;
        statusEl.textContent = STATUS_LABEL_CARRIER[carrier.status] || carrier.status || '';
      }

      // Name + IDs
      const nameEl = carrierPanel.querySelector('.carrier-panel-name');
      if (nameEl) nameEl.textContent = carrier.name;
      const idsEl = carrierPanel.querySelector('.carrier-panel-ids');
      if (idsEl) idsEl.innerHTML = `<span class="mono">${escapeHtml(carrier.mc)}</span> · DOT <span class="mono">${escapeHtml(carrier.dot || '—')}</span>`;

      // Equipment chips
      const chipsEl = carrierPanel.querySelector('.carrier-panel-chips');
      if (chipsEl) {
        chipsEl.replaceChildren();
        (carrier.equipment || []).forEach((eq) => {
          const c = document.createElement('span');
          c.className = 'chip chip--neutral';
          c.textContent = eq;
          chipsEl.appendChild(c);
        });
      }

      // Load KV
      const etaEl = carrierPanel.querySelector('.carrier-panel-eta');
      const speedEl = carrierPanel.querySelector('.carrier-panel-speed');
      const headingEl = carrierPanel.querySelector('.carrier-panel-heading');
      if (etaEl) etaEl.textContent = '—';
      if (speedEl) speedEl.textContent = carrier.speed != null ? `${carrier.speed} mph` : '—';
      if (headingEl) headingEl.textContent = carrier.heading != null ? `${carrier.heading}°` : '—';

      // Driver
      const driverNameEl = carrierPanel.querySelector('.carrier-panel-driver-name');
      const driverHosEl = carrierPanel.querySelector('.carrier-panel-driver-hos');
      if (driverNameEl) driverNameEl.textContent = carrier.driver ? carrier.driver.name : '—';
      if (driverHosEl) driverHosEl.textContent = carrier.driver ? `${carrier.driver.hosRemaining}h` : '—';

      // Show panel
      carrierPanel.setAttribute('aria-hidden', 'false');
      // Force a reflow so the visibility/transform transition runs from base state.
      void carrierPanel.offsetWidth;
      carrierPanel.classList.add('is-open');

      // Wire close button
      const closeBtn = carrierPanel.querySelector('.carrier-panel-close');
      if (closeBtn) {
        closeBtn.onclick = () => closeCarrierPanel();
        closeBtn.focus();
      }

      // Wire action buttons
      carrierPanel.querySelectorAll('[data-action]').forEach((btn) => {
        btn.onclick = () => {
          const action = btn.getAttribute('data-action');
          // Try tool-registry handlers
          const toolRegistry = window.__toolRegistry;
          if (toolRegistry) {
            if (action === 'call-driver' && typeof toolRegistry.call_carrier === 'function') {
              toolRegistry.call_carrier({ carrierId: carrier.id });
              return;
            }
            if (action === 'assign-load' && typeof toolRegistry.assign_load === 'function') {
              toolRegistry.assign_load({ carrierId: carrier.id });
              return;
            }
            if (action === 'track' && typeof toolRegistry.track_carrier === 'function') {
              toolRegistry.track_carrier({ carrierId: carrier.id });
              return;
            }
          }
          // Fallback: dispatch custom event
          window.dispatchEvent(new CustomEvent('carrier-action', {
            detail: { action, carrierId: carrier.id }
          }));
          console.info(`[map-widget] carrier-action: ${action} for ${carrier.id}`);
        };
      });
    }

    function closeCarrierPanel() {
      if (!carrierPanel) return;
      carrierPanel.classList.remove('is-open');

      // Deselect pin
      if (selectedPinEl) {
        selectedPinEl.classList.remove('is-selected');
        selectedPinEl = null;
      }

      const reduced = prefersReducedMotion();
      const done = () => {
        carrierPanel.setAttribute('aria-hidden', 'true');
        carrierPanel.removeEventListener('transitionend', done);
        pendingTransitionListeners.delete(done);
      };

      if (reduced) {
        done();
      } else {
        carrierPanel.addEventListener('transitionend', done, { once: true });
        pendingTransitionListeners.add(done);
        // Timeout fallback
        const fallback = setTimeout(() => {
          flashTimers.delete(fallback);
          done();
        }, 250);
        flashTimers.add(fallback);
      }

      const opener = carrierPanelOpener;
      carrierPanelOpener = null;
      if (opener && typeof opener.focus === 'function') {
        try { opener.focus(); } catch {}
      }
    }

    // --- pan helpers

    // Debounce rapid flyTo calls from the agent — within 400ms, force
    // animate:false so we don't cancel an in-flight flyTo with a new one.
    let _lastCallAt = 0;
    function shouldSkipAnimation() {
      const now = Date.now();
      const tooFast = now - _lastCallAt < 400;
      _lastCallAt = now;
      return tooFast;
    }

    function smoothPan(target, zoom) {
      const reduced = prefersReducedMotion();
      const z = (zoom != null && Number.isFinite(Number(zoom))) ? Number(zoom) : map.getZoom();
      if (reduced) {
        map.setView([target.lat, target.lng], z, { animate: false });
        return;
      }
      if (shouldSkipAnimation()) {
        map.setView([target.lat, target.lng], z, { animate: false });
        return;
      }
      const here = map.getCenter();
      const distance = haversineKm({ lat: here.lat, lng: here.lng }, target);
      if (distance > FLY_THRESHOLD_KM) {
        map.flyTo([target.lat, target.lng], z, { animate: true, duration: PAN_DURATION_FLY_S });
      } else {
        map.setView([target.lat, target.lng], z, { animate: true, duration: PAN_DURATION_LOCAL_S });
      }
    }

    function smoothFitBounds(bounds) {
      const reduced = prefersReducedMotion();
      if (reduced) {
        map.fitBounds(bounds, { animate: false, maxZoom: 6 });
        return;
      }
      if (shouldSkipAnimation()) {
        map.fitBounds(bounds, { animate: false, maxZoom: 6 });
        return;
      }
      const here = map.getCenter();
      const center = bounds.getCenter();
      const distance = haversineKm({ lat: here.lat, lng: here.lng }, { lat: center.lat, lng: center.lng });
      const duration = distance > FLY_THRESHOLD_KM ? PAN_DURATION_FLY_S : PAN_DURATION_LOCAL_S;
      map.flyToBounds(bounds, { animate: true, duration, maxZoom: 6 });
    }

    function announceFocus(label) {
      try {
        const el = document.getElementById('route-live-region');
        if (el && label) el.textContent = `Focused on ${label}`;
      } catch {}
    }

    // --- internal actions (used by list clicks + agent methods)

    function focusLoadInternal(loadId) {
      const entry = registry.get(loadId);
      if (!entry || entry.kind !== 'load') return false;
      const ll = entry.pickupLL || entry.dropoffLL;
      if (!ll) return false;
      if (entry.pickupLL && entry.dropoffLL) {
        const bounds = L.latLngBounds([
          [entry.pickupLL.lat, entry.pickupLL.lng],
          [entry.dropoffLL.lat, entry.dropoffLL.lng]
        ]).pad(0.25);
        smoothFitBounds(bounds);
      } else {
        smoothPan({ lat: ll.lat, lng: ll.lng }, 7);
      }
      [entry.pickup, entry.dropoff].forEach((m) => {
        if (!m) return;
        const el = m.getElement();
        if (!el) return;
        const pin = el.querySelector('.map-pin');
        if (pin) flash(pin);
      });
      return true;
    }

    function focusCarrierInternal(carrierId) {
      const entry = registry.get(carrierId);
      if (!entry || entry.kind !== 'carrier') return false;
      smoothPan({ lat: entry.coords.lat, lng: entry.coords.lng }, 7);
      const el = entry.marker && entry.marker.getElement();
      const pin = el && el.querySelector('.map-pin');
      if (pin) flash(pin);
      return true;
    }

    function flash(el) {
      el.classList.remove('is-agent-highlighted');
      void el.offsetWidth;
      el.classList.add('is-agent-highlighted');
      const t = setTimeout(() => {
        flashTimers.delete(t);
        el.classList.remove('is-agent-highlighted');
      }, 1600);
      flashTimers.add(t);
    }

    function knownCityHint() {
      // Short list of covered cities to surface in target-not-found errors.
      const sample = shuffledSample(Object.keys(CITY_COORDS), 5);
      return sample.join(', ');
    }

    function focusTargetInternal(target) {
      // coord object
      if (target && typeof target === 'object' && !Array.isArray(target)
          && Number.isFinite(Number(target.lat)) && Number.isFinite(Number(target.lng))) {
        const lat = Number(target.lat);
        const lng = Number(target.lng);
        const z = Number.isFinite(Number(target.zoom)) ? Number(target.zoom) : undefined;
        smoothPan({ lat, lng }, z);
        const label = `${lat.toFixed(2)}, ${lng.toFixed(2)}`;
        announceFocus(label);
        return { matched: 'coords', label };
      }

      const str = String(target == null ? '' : target).trim();
      if (!str) return null;

      // Id lookup first.
      if (registry.has(str)) {
        const entry = registry.get(str);
        if (entry.kind === 'load') {
          const ok = focusLoadInternal(str);
          if (!ok) return null;
          announceFocus(`load ${str}`);
          return { matched: 'load', label: str };
        }
        if (entry.kind === 'carrier') {
          const ok = focusCarrierInternal(str);
          if (!ok) return null;
          announceFocus(`carrier ${str}`);
          return { matched: 'carrier', label: str };
        }
      }

      // Exact city.
      const cityExact = CITY_COORDS[str];
      if (cityExact) {
        smoothPan({ lat: cityExact.lat, lng: cityExact.lng }, 7);
        announceFocus(str);
        return { matched: 'city', label: str };
      }
      const lower = str.toLowerCase();
      const cityKey = Object.keys(CITY_COORDS).find((k) => k.toLowerCase() === lower);
      if (cityKey) {
        const c = CITY_COORDS[cityKey];
        smoothPan({ lat: c.lat, lng: c.lng }, 7);
        announceFocus(cityKey);
        return { matched: 'city', label: cityKey };
      }

      // State match.
      const stateMatches = Object.keys(CITY_COORDS).filter((k) => {
        const st = k.split(',')[1] ? k.split(',')[1].trim() : '';
        return st && (st.toLowerCase() === lower || lower.endsWith(' ' + st.toLowerCase()));
      });
      if (stateMatches.length) {
        const bounds = L.latLngBounds(stateMatches.map((k) => [CITY_COORDS[k].lat, CITY_COORDS[k].lng])).pad(0.2);
        smoothFitBounds(bounds);
        announceFocus(str);
        return { matched: 'state', label: str };
      }

      // Loose contains.
      const partial = Object.keys(CITY_COORDS).find((k) => k.toLowerCase().includes(lower));
      if (partial) {
        const c = CITY_COORDS[partial];
        smoothPan({ lat: c.lat, lng: c.lng }, 7);
        announceFocus(partial);
        return { matched: 'city', label: partial };
      }
      return null;
    }

    function highlightLoadInternal(loadId) {
      const ok = focusLoadInternal(loadId);
      if (!ok) return null;
      const entry = registry.get(loadId);
      announceFocus(`load ${loadId}`);
      if (window.__loadModal && entry.record) {
        try { window.__loadModal.open(entry.record, { context: 'map' }); } catch {}
      }
      return {
        load_id: loadId,
        pickup: entry.record && entry.record.pickup,
        dropoff: entry.record && entry.record.dropoff
      };
    }

    function setLayerVisibleInternal(layer, on) {
      const name = String(layer || '').toLowerCase();
      const visible = !!on;
      if (name === 'loads')    applyPaneVisibility('loads-pane', visible, 'loads');
      else if (name === 'carriers') applyPaneVisibility('carriers-pane', visible, 'carriers');
      else if (name === 'lanes') applyPaneVisibility('lanes-pane', visible, 'lanes');
      else if (name === 'delayed') { delayedOnly = visible; applyDelayedFilter(); }
      else return null;

      const chip = filterRail && filterRail.querySelector(`[data-layer="${CSS.escape(name)}"]`);
      if (chip) chip.setAttribute('aria-pressed', visible ? 'true' : 'false');
      renderFilterList();
      updateEmptyState();
      return { layer: name, visible };
    }

    function applyPaneVisibility(paneName, visible, setKey) {
      const pane = map.getPane(paneName);
      if (!pane) return;
      if (visible) visibleLayers.add(setKey);
      else visibleLayers.delete(setKey);
      pane.classList.toggle('map-pane-hidden', !visible);
    }

    function applyDelayedFilter() {
      // Loads pane — we rebuild the layer's contents but re-apply each
      // marker's `data-agent-id` so the agent's element scanner still sees
      // them (Oracle [W6]).
      loadLayer.clearLayers();
      loads.forEach((l) => {
        if (delayedOnly && l.status !== 'delayed') return;
        const entry = registry.get(l.id);
        if (!entry) return;
        if (entry.pickup) {
          loadLayer.addLayer(entry.pickup);
          const el = entry.pickup.getElement();
          if (el) el.setAttribute('data-agent-id', entry.pickupAgentId);
        }
        if (entry.dropoff) {
          loadLayer.addLayer(entry.dropoff);
          const el = entry.dropoff.getElement();
          if (el) el.setAttribute('data-agent-id', entry.dropoffAgentId);
        }
      });
    }

    function updateEmptyState() {
      if (!emptyStateEl) return;
      const anyVisible =
        visibleLayers.has('loads') || visibleLayers.has('carriers') || visibleLayers.has('lanes');
      emptyStateEl.hidden = anyVisible;
    }

    // --- bootstrap data + bind UI

    loads.forEach(addLoadMarker);
    carriers.forEach(addCarrierMarker);
    renderFilterListImmediate();
    renderListView();

    // Wire load-modal data + listen for modal:open to close carrier panel
    if (window.__loadModal) {
      window.__loadModalData = { carriers, loads };
      if (typeof window.__loadModal.setData === 'function') {
        window.__loadModal.setData({ carriers, loads });
      }
    }
    function onModalOpen(ev) {
      if (ev.detail && ev.detail.kind === 'load') closeCarrierPanel();
    }
    window.addEventListener('modal:open', onModalOpen);
    track(() => window.removeEventListener('modal:open', onModalOpen));
    updateEmptyState();

    // Chip filters
    if (filterRail) {
      const chipBtns = filterRail.querySelectorAll('.chip-btn[data-layer]');
      const chipHandlers = [];
      chipBtns.forEach((btn) => {
        const handler = () => {
          const layer = btn.getAttribute('data-layer');
          const next = btn.getAttribute('aria-pressed') !== 'true';
          setLayerVisibleInternal(layer, next);
        };
        btn.addEventListener('click', handler);
        chipHandlers.push([btn, handler]);
      });
      track(() => { chipHandlers.forEach(([b, h]) => { try { b.removeEventListener('click', h); } catch {} }); });
    }

    let onSearchInput = null;
    if (searchInput) {
      onSearchInput = () => renderFilterList();
      searchInput.addEventListener('input', onSearchInput);
      track(() => { try { searchInput.removeEventListener('input', onSearchInput); } catch {} });
    }

    // Zoom/reset controls — user-initiated, always animated (outside the
    // agent-debounce window).
    let onZoomIn = null, onZoomOut = null, onReset = null;
    if (zoomInBtn) {
      onZoomIn = () => {
        const reduced = prefersReducedMotion();
        map.zoomIn(1, { animate: !reduced });
      };
      zoomInBtn.addEventListener('click', onZoomIn);
      track(() => { try { zoomInBtn.removeEventListener('click', onZoomIn); } catch {} });
    }
    if (zoomOutBtn) {
      onZoomOut = () => {
        const reduced = prefersReducedMotion();
        map.zoomOut(1, { animate: !reduced });
      };
      zoomOutBtn.addEventListener('click', onZoomOut);
      track(() => { try { zoomOutBtn.removeEventListener('click', onZoomOut); } catch {} });
    }
    if (resetBtn) {
      onReset = () => {
        const reduced = prefersReducedMotion();
        if (reduced) {
          map.setView([DEFAULT_VIEW.lat, DEFAULT_VIEW.lng], DEFAULT_VIEW.zoom, { animate: false });
        } else {
          map.flyTo([DEFAULT_VIEW.lat, DEFAULT_VIEW.lng], DEFAULT_VIEW.zoom, {
            animate: true,
            duration: PAN_DURATION_FLY_S
          });
        }
      };
      resetBtn.addEventListener('click', onReset);
      track(() => { try { resetBtn.removeEventListener('click', onReset); } catch {} });
    }

    // List view fallback toggle
    let listOpen = false;
    let onListToggle = null;
    function setListView(on) {
      listOpen = !!on;
      if (listView) {
        listView.hidden = !listOpen;
        listView.toggleAttribute('inert', !listOpen);
      }
      if (canvas) canvas.setAttribute('aria-hidden', listOpen ? 'true' : 'false');
      if (listToggleBtn) {
        listToggleBtn.setAttribute('aria-pressed', listOpen ? 'true' : 'false');
        listToggleBtn.textContent = listOpen ? 'Map view' : 'List view';
      }
    }
    if (listToggleBtn) {
      onListToggle = () => setListView(!listOpen);
      listToggleBtn.addEventListener('click', onListToggle);
      track(() => { try { listToggleBtn.removeEventListener('click', onListToggle); } catch {} });
    }

    // ESC closes detail panel or carrier panel
    function onKeydown(ev) {
      if (ev.key === 'Escape') {
        if (carrierPanel && carrierPanel.classList.contains('is-open')) {
          closeCarrierPanel();
          return;
        }
        if (detail && detail.classList.contains('is-open')) {
          closeDetailPanel();
        }
      }
    }
    document.addEventListener('keydown', onKeydown);
    track(() => document.removeEventListener('keydown', onKeydown));

    // Click outside the carrier panel closes it (desktop + mobile).
    // Pin clicks open the panel via openCarrierPanel(), so we explicitly
    // ignore clicks inside the panel itself or on a Leaflet marker.
    function onDocClickForCarrierPanel(ev) {
      if (!carrierPanel || !carrierPanel.classList.contains('is-open')) return;
      const t = ev.target;
      if (!(t instanceof Node)) return;
      if (carrierPanel.contains(t)) return;
      // Don't close when clicking a marker — that path opens a different carrier.
      if (t instanceof Element && t.closest('.leaflet-marker-icon')) return;
      closeCarrierPanel();
    }
    document.addEventListener('click', onDocClickForCarrierPanel, true);
    track(() => document.removeEventListener('click', onDocClickForCarrierPanel, true));

    // Mobile swipe-down-to-dismiss on the bottom-sheet detail. Attached
    // unconditionally — the `dy > 60 && scrollTop === 0` guard makes them
    // harmless on desktop, and that sidesteps the "viewport resized past
    // the breakpoint" race where mount-time matchMedia misses.
    let onDetailTouchStart = null, onDetailTouchMove = null;
    if (detail) {
      let touchStartY = 0;
      onDetailTouchStart = (ev) => {
        if (ev.touches.length !== 1) return;
        touchStartY = ev.touches[0].clientY;
      };
      onDetailTouchMove = (ev) => {
        if (ev.touches.length !== 1) return;
        const dy = ev.touches[0].clientY - touchStartY;
        if (dy > 60 && detail.scrollTop === 0) {
          closeDetailPanel();
          touchStartY = ev.touches[0].clientY;
        }
      };
      detail.addEventListener('touchstart', onDetailTouchStart, { passive: true });
      detail.addEventListener('touchmove',  onDetailTouchMove,  { passive: true });
      track(() => {
        try { detail.removeEventListener('touchstart', onDetailTouchStart); } catch {}
        try { detail.removeEventListener('touchmove',  onDetailTouchMove); } catch {}
      });
    }

    // Leaflet needs an explicit invalidateSize() when its container changes.
    // We also recompute minZoom against the new container width so the
    // world-wrap clamp tracks the viewport — without this, rotating a
    // phone (480 → 800 px) would let the user zoom out to a width where
    // the world no longer fills the canvas.
    const applyMinZoomForCanvas = () => {
      try {
        const w = canvas.getBoundingClientRect().width || canvas.clientWidth || 0;
        if (!w) return;
        const next = computeMinZoomForWidth(w);
        if (next !== map.getMinZoom()) {
          map.setMinZoom(next);
          if (map.getZoom() < next) {
            map.setZoom(next, { animate: false });
          }
        }
      } catch {}
    };
    const ro = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => {
          try { map.invalidateSize(); } catch {}
          applyMinZoomForCanvas();
        })
      : null;
    if (ro && canvas) ro.observe(canvas);
    // Refine immediately in case the canvas just laid out.
    applyMinZoomForCanvas();
    track(() => { if (ro) { try { ro.disconnect(); } catch {} } });

    // Click-outside on mobile closes carrier panel
    if (carrierPanel) {
      const onCanvasClick = (ev) => {
        if (!carrierPanel.classList.contains('is-open')) return;
        if (carrierPanel.contains(ev.target)) return;
        // Only on narrow screens (bottom-sheet mode)
        if (window.innerWidth > 640) return;
        closeCarrierPanel();
      };
      if (canvas) canvas.addEventListener('click', onCanvasClick);
      track(() => { if (canvas) canvas.removeEventListener('click', onCanvasClick); });
    }

    // --- wire public API methods (now that internals exist).

    api.panTo = function panTo(lat, lng, zoom, opts) {
      if (destroyed) return envelopeErr('destroyed', 'Map has been torn down.');
      if (!readySettled) return envelopeErr('not_ready', 'Map not mounted yet.');
      const la = Number(lat); const ln = Number(lng);
      if (!Number.isFinite(la) || !Number.isFinite(ln)) {
        return envelopeErr('bad_input', 'panTo: lat/lng must be finite numbers.');
      }
      const z = (zoom != null && Number.isFinite(Number(zoom))) ? Number(zoom) : map.getZoom();
      if (opts && opts.animate === false) {
        map.setView([la, ln], z, { animate: false });
      } else {
        smoothPan({ lat: la, lng: ln }, z);
      }
      return envelopeOk({ lat: la, lng: ln, zoom: z });
    };

    api.focusTarget = function focusTarget(target) {
      if (destroyed) return envelopeErr('destroyed', 'Map has been torn down.');
      if (!readySettled) return envelopeErr('not_ready', 'Map not mounted yet.');
      // Bad-input guard: plain empty string or null.
      if (target == null) return envelopeErr('bad_input', 'focusTarget: empty target.');
      if (typeof target === 'string' && !target.trim()) {
        return envelopeErr('bad_input', 'focusTarget: empty target.');
      }
      const r = focusTargetInternal(target);
      if (!r) {
        const display = typeof target === 'string' ? target : JSON.stringify(target);
        return envelopeErr(
          'target_not_found',
          `No city, state, or id matched "${display}". Known cities include: ${knownCityHint()}.`
        );
      }
      return envelopeOk(r);
    };

    api.highlightLoad = function highlightLoad(loadId) {
      if (destroyed) return envelopeErr('destroyed', 'Map has been torn down.');
      if (!readySettled) return envelopeErr('not_ready', 'Map not mounted yet.');
      const id = typeof loadId === 'string' ? loadId.trim() : '';
      if (!id) return envelopeErr('bad_input', 'highlightLoad: empty id.');
      const entry = registry.get(id);
      if (!entry || entry.kind !== 'load') {
        return envelopeErr(
          'load_not_found',
          `Load "${id}" not in current dataset. (${loads.length} loads total.)`
        );
      }
      const r = highlightLoadInternal(id);
      if (!r) {
        return envelopeErr(
          'load_not_found',
          `Load "${id}" not in current dataset. (${loads.length} loads total.)`
        );
      }
      return envelopeOk(r);
    };

    api.focusCarrier = function focusCarrier(carrierId) {
      if (destroyed) return envelopeErr('destroyed', 'Map has been torn down.');
      if (!readySettled) return envelopeErr('not_ready', 'Map not mounted yet.');
      const id = typeof carrierId === 'string' ? carrierId.trim() : '';
      if (!id) return envelopeErr('bad_input', 'focusCarrier: empty id.');
      const entry = registry.get(id);
      if (!entry || entry.kind !== 'carrier') {
        return envelopeErr('carrier_not_found', `Carrier "${id}" not in current dataset.`);
      }
      const ok = focusCarrierInternal(id);
      if (!ok) return envelopeErr('carrier_not_found', `Carrier "${id}" not in current dataset.`);
      const hq = CARRIER_HQ[id];
      return envelopeOk({ carrier_id: id, city: hq ? hq.city : '' });
    };

    api.setLayerVisible = function setLayerVisible(layer, on) {
      if (destroyed) return envelopeErr('destroyed', 'Map has been torn down.');
      if (!readySettled) return envelopeErr('not_ready', 'Map not mounted yet.');
      const name = String(layer || '').toLowerCase();
      if (!['loads', 'carriers', 'lanes', 'delayed'].includes(name)) {
        return envelopeErr(
          'unknown_layer',
          `Layer "${name}" not recognised. One of: loads, carriers, lanes, delayed.`
        );
      }
      const r = setLayerVisibleInternal(name, on);
      if (!r) {
        return envelopeErr(
          'unknown_layer',
          `Layer "${name}" not recognised. One of: loads, carriers, lanes, delayed.`
        );
      }
      return envelopeOk(r);
    };

    api.getViewState = function getViewState() {
      if (destroyed) return null;
      try {
        const c = map.getCenter();
        return {
          center: { lat: c.lat, lng: c.lng },
          zoom: map.getZoom(),
          visibleLayers: [...visibleLayers],
          delayedOnly,
          listOpen
        };
      } catch { return null; }
    };

    api.restoreViewState = function restoreViewState(snap) {
      if (destroyed || !snap) return;
      try {
        if (snap.center && Number.isFinite(snap.center.lat) && Number.isFinite(snap.center.lng) && Number.isFinite(snap.zoom)) {
          map.setView([snap.center.lat, snap.center.lng], snap.zoom, { animate: false });
        }
        ['loads', 'carriers', 'lanes'].forEach((l) => {
          const want = Array.isArray(snap.visibleLayers) && snap.visibleLayers.includes(l);
          if (want !== visibleLayers.has(l)) setLayerVisibleInternal(l, want);
        });
        if (typeof snap.delayedOnly === 'boolean' && snap.delayedOnly !== delayedOnly) {
          setLayerVisibleInternal('delayed', snap.delayedOnly);
        }
        if (typeof snap.listOpen === 'boolean' && snap.listOpen !== listOpen) {
          setListView(snap.listOpen);
        }
      } catch {}
    };

    // Expose BEFORE ready resolves so callers can `await w.ready`.
    window.__mapWidget = api;
    track(() => { if (window.__mapWidget === api) { try { delete window.__mapWidget; } catch { window.__mapWidget = undefined; } } });

    // Wait for first tile paint (or give up after ~5s and fail loudly, or
    // unwind synchronously if destroy() is called mid-mount).
    await new Promise((res, rej) => {
      let settled = false;
      const settle = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(budget);
        tileRetryTimers.delete(budget);
        try { tileLayer.off('tileload', onFirstTile); } catch {}
        firstTileReject = null;
        fn(arg);
      };
      const budget = setTimeout(() => {
        settle(rej, new Error('Tile provider unreachable after retries.'));
      }, 5000);
      tileRetryTimers.add(budget);
      const onFirstTile = () => settle(res);
      // `.once` self-removes the listener even on Leaflet-internal error paths.
      tileLayer.once('tileload', onFirstTile);
      // Expose the reject so destroy() can wake this await synchronously.
      firstTileReject = (err) => settle(rej, err);
    });

    // Hide skeleton + clear aria-busy AFTER first paint.
    skeleton.classList.add('is-hidden');
    if (canvas) canvas.removeAttribute('aria-busy');
    const skelDone = () => {
      skeleton.hidden = true;
      skeleton.removeEventListener('transitionend', skelDone);
    };
    if (prefersReducedMotion()) {
      skelDone();
    } else {
      skeleton.addEventListener('transitionend', skelDone);
      track(() => { try { skeleton.removeEventListener('transitionend', skelDone); } catch {} });
    }

    readyResolve();
    return { api, destroy: api.destroy };
  } catch (err) {
    api.destroy();
    if (!readySettled) {
      try { readyReject({ ok: false, code: 'tile_error', error: String(err && err.message || err) }); } catch {}
    }
    throw err;
  }
}

export { CITY_COORDS };
