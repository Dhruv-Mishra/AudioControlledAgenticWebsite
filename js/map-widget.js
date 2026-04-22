// Leaflet wrapper — lazy-loaded from js/page-map.js on /map.html.
//
// Ownership:
//   - init Leaflet once per mount, wire DOM-backed divIcon pins for loads
//     + carriers, draw lane polylines, render popups, manage the slide-in
//     detail panel + list-view fallback.
//   - listen on `document` for `map:focus`, `map:highlight-load`,
//     `map:show-layer` so the agent tool handlers can drive the map
//     without holding a reference to the widget.
//   - expose a direct `window.__mapWidget` API object for testing + the
//     agent to call from tool handlers.

const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
// For a production deploy with real traffic, swap to Stadia's free tier
// by setting STADIA_API_KEY in .env and using:
//   https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png?api_key=...
const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';

const DEFAULT_VIEW = { lat: 39.5, lng: -98.35, zoom: 4 };

// Frozen city → {lat, lng} lookup. Covers every city referenced in
// data/loads.json + data/carriers.json plus common dispatch cities.
// Unknown cities fall through to DEFAULT_VIEW with an aria-label on the
// pin of "unknown coordinates".
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

// Carrier HQ fallback — infer from the area code in the phone number when
// the carrier's lanes don't give us a definite city. Keyed by id.
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
  const hrefs = [
    '/public/leaflet/leaflet.css',
    '/public/leaflet/MarkerCluster.css',
    '/public/leaflet/MarkerCluster.Default.css'
  ];
  hrefs.forEach((href) => {
    if (document.head.querySelector(`link[data-leaflet-css="${href}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.setAttribute('data-leaflet-css', href);
    document.head.appendChild(link);
  });
}

// Leaflet + markercluster are vendored under public/leaflet/ and loaded via
// classic <script> tags (UMD). This is the canonical Leaflet pattern and
// avoids a subtle gotcha with the ESM build: the imported module namespace
// is sealed, so the markercluster UMD plugin's `L.markerClusterGroup = …`
// assignment silently fails in sloppy mode and the method never attaches.
// Script-tag UMD gives us a plain mutable `window.L` the plugin can extend.
//
// Works identically in dev (public/ served from source) and prod (copied to
// dist/public/ by scripts/build.js::copyStatic). No bare specifiers; nothing
// for esbuild to resolve.
const LEAFLET_UMD_URL = '/public/leaflet/leaflet.js';
const MARKERCLUSTER_URL = '/public/leaflet/leaflet.markercluster-src.js';

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
    s.async = false;       // preserve relative load order vs other scripts
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

let _markerClusterPromise = null;
async function loadMarkerCluster(L) {
  if (L && typeof L.markerClusterGroup === 'function') return;
  if (_markerClusterPromise) { await _markerClusterPromise; return; }
  _markerClusterPromise = (async () => {
    await loadScriptOnce(MARKERCLUSTER_URL);
    // Sanity check: the plugin MUST have attached itself to window.L. If not,
    // fail loudly so the caller sees a meaningful error instead of the
    // downstream `L.markerClusterGroup is not a function`.
    if (!window.L || typeof window.L.markerClusterGroup !== 'function') {
      throw new Error('leaflet.markercluster loaded but did not attach markerClusterGroup to L.');
    }
  })();
  await _markerClusterPromise;
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

/**
 * Create a freshly-mounted map. Returns an API object for programmatic
 * control and a teardown() function.
 *
 * @param {HTMLElement} root  The section root (#map-root).
 * @param {{loads: object[], carriers: object[]}} data
 */
export async function createMap(root, { loads, carriers }) {
  injectLeafletCss();
  const L = await loadLeaflet();
  await loadMarkerCluster(L);

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

  if (!canvas) throw new Error('map-widget: #map-canvas missing from partial');

  const reduced = prefersReducedMotion();

  const map = L.map(canvas, {
    keyboard: true,
    zoomControl: false,
    attributionControl: false,
    zoomAnimation: !reduced,
    markerZoomAnimation: !reduced,
    fadeAnimation: !reduced,
    preferCanvas: false
  }).setView([DEFAULT_VIEW.lat, DEFAULT_VIEW.lng], DEFAULT_VIEW.zoom);

  L.tileLayer(TILE_URL, {
    attribution: TILE_ATTRIBUTION,
    maxZoom: 18,
    crossOrigin: true
  }).addTo(map);

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

  // --- layers
  const loadLayer = L.markerClusterGroup({
    showCoverageOnHover: false,
    iconCreateFunction: (cluster) => L.divIcon({
      className: '',
      html: `<div class="map-cluster">${cluster.getChildCount()}</div>`,
      iconSize: [28, 28]
    })
  });
  const carrierLayer = L.layerGroup();
  const laneLayer = L.layerGroup();

  loadLayer.addTo(map);
  carrierLayer.addTo(map);
  laneLayer.addTo(map);

  const visibleLayers = new Set(['loads', 'carriers', 'lanes']);
  let delayedOnly = false;

  // --- marker registry
  // key: load-id or carrier-id → { marker, type, record, pickupLatLng?, dropoffLatLng?, lane? }
  const registry = new Map();

  function makeDivIcon(cls, ariaLabel) {
    // The outer Leaflet marker element carries the stable `data-agent-id`
    // (`map.pin.<id>.<side>`) — see addLoadMarker / addCarrierMarker below.
    // The inner .map-pin div is purely visual; keeping a data-agent-id here
    // would expose the human aria-label text to the agent's element scanner.
    return L.divIcon({
      className: '',
      html: `<div class="map-pin ${cls}" tabindex="0" role="button" aria-label="${escapeHtml(ariaLabel)}"></div>`,
      iconSize: [16, 16],
      iconAnchor: [8, 8]
    });
  }

  function addLoadMarker(load) {
    const pickupLL = resolveCity(load.pickup);
    const dropoffLL = resolveCity(load.dropoff);
    if (!pickupLL && !dropoffLL) return;

    const cls = `map-pin--${load.status || 'booked'}`;

    const pickupId = `map.pin.${load.id}.pickup`;
    const dropoffId = `map.pin.${load.id}.dropoff`;

    const pickupMarker = pickupLL
      ? L.marker([pickupLL.lat, pickupLL.lng], {
          icon: makeDivIcon(cls, `Load ${load.id} pickup, ${load.pickup || 'unknown coordinates'}`),
          keyboard: true
        })
      : null;
    const dropoffMarker = dropoffLL
      ? L.marker([dropoffLL.lat, dropoffLL.lng], {
          icon: makeDivIcon(cls, `Load ${load.id} dropoff, ${load.dropoff || 'unknown coordinates'}`),
          keyboard: true
        })
      : null;

    const popup = buildLoadPopup(load);

    [pickupMarker, dropoffMarker].forEach((m, idx) => {
      if (!m) return;
      m.bindPopup(popup);
      // When the user clicks the pin, also open the detail panel.
      m.on('click', () => openLoadDetail(load, idx === 0 ? 'pickup' : 'dropoff'));
      m.on('keypress', (ev) => {
        const key = ev && ev.originalEvent && ev.originalEvent.key;
        if (key === 'Enter' || key === ' ') openLoadDetail(load, idx === 0 ? 'pickup' : 'dropoff');
      });
      loadLayer.addLayer(m);
      // Tag the marker's DOM element with data-agent-id so the agent can
      // snapshot it. `_icon` is Leaflet's own element reference.
      const pinEl = m.getElement();
      if (pinEl) {
        pinEl.setAttribute('data-agent-id', idx === 0 ? pickupId : dropoffId);
      }
    });

    let lane = null;
    if (pickupLL && dropoffLL) {
      const pending = !load.carrier || load.status === 'pending';
      const cls = pending ? 'map-lane map-lane--pending' : 'map-lane';
      lane = L.polyline(
        [[pickupLL.lat, pickupLL.lng], [dropoffLL.lat, dropoffLL.lng]],
        { className: cls, weight: 2, interactive: true }
      );
      lane.bindPopup(popup);
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
      lane
    });
  }

  function addCarrierMarker(carrier) {
    const hq = CARRIER_HQ[carrier.id];
    const coords = hq ? resolveCity(hq.city) : null;
    if (!coords) return;
    const id = `map.pin.${carrier.id}`;
    const m = L.marker([coords.lat, coords.lng], {
      icon: makeDivIcon('map-pin--carrier', `Carrier ${carrier.name} in ${hq.city}`),
      keyboard: true
    });
    m.bindPopup(buildCarrierPopup(carrier, hq.city));
    m.on('click', () => openCarrierDetail(carrier, hq.city));
    m.on('keypress', (ev) => {
      const key = ev && ev.originalEvent && ev.originalEvent.key;
      if (key === 'Enter' || key === ' ') openCarrierDetail(carrier, hq.city);
    });
    carrierLayer.addLayer(m);
    const pinEl = m.getElement();
    if (pinEl) pinEl.setAttribute('data-agent-id', id);
    registry.set(carrier.id, { kind: 'carrier', record: carrier, marker: m, coords });
  }

  function buildLoadPopup(load) {
    const status = STATUS_LABEL[load.status] || load.status || '';
    const chipCls = statusChipClass(load.status);
    const wrap = document.createElement('div');
    const head = document.createElement('div');
    head.className = 'map-popup-title';
    const idSpan = document.createElement('span');
    idSpan.textContent = load.id;
    head.appendChild(idSpan);
    const chip = document.createElement('span');
    chip.className = chipCls;
    chip.textContent = status;
    head.appendChild(chip);
    const sub = document.createElement('div');
    sub.className = 'map-popup-sub';
    sub.textContent = `${load.pickup || '?'} → ${load.dropoff || '?'} · ${load.miles ? load.miles + 'mi' : ''} · ETA ${fmtEta(load.eta)}`;
    wrap.appendChild(head);
    wrap.appendChild(sub);
    return wrap;
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

  function renderFilterList() {
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
          onClick: () => focusLoad(l.id)
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
          onClick: () => focusCarrier(c.id)
        });
      });
    }
  }

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

  let detailOpener = null; // element to return focus to on close

  function openDetailPanel(contentNode, opener) {
    if (!detail) return;
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
    // Force reflow so the transition fires.
    void detail.offsetWidth;
    detail.classList.add('is-open');
    detailOpener = opener || null;
    try { close.focus(); } catch {}
  }

  function closeDetailPanel() {
    if (!detail) return;
    detail.classList.remove('is-open');
    const done = () => {
      detail.hidden = true;
      detail.removeEventListener('transitionend', done);
    };
    if (reduced) done();
    else detail.addEventListener('transitionend', done);
    const opener = detailOpener;
    detailOpener = null;
    if (opener && typeof opener.focus === 'function') {
      try { opener.focus(); } catch {}
    }
  }

  function openLoadDetail(load, side) {
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

    const entry = registry.get(load.id);
    const opener = entry && entry[side] ? entry[side].getElement() : (entry && entry.pickup ? entry.pickup.getElement() : null);
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

  // --- agent-callable methods

  const smoothOpts = { animate: !reduced, duration: reduced ? 0 : 0.28 };

  function panTo(lat, lng, zoom) {
    const z = zoom != null && Number.isFinite(Number(zoom)) ? Number(zoom) : map.getZoom();
    map.setView([Number(lat), Number(lng)], z, smoothOpts);
  }

  function focusLoad(loadId) {
    const entry = registry.get(loadId);
    if (!entry || entry.kind !== 'load') return false;
    const ll = entry.pickupLL || entry.dropoffLL;
    if (!ll) return false;
    if (entry.pickupLL && entry.dropoffLL) {
      const bounds = L.latLngBounds([
        [entry.pickupLL.lat, entry.pickupLL.lng],
        [entry.dropoffLL.lat, entry.dropoffLL.lng]
      ]).pad(0.25);
      map.flyToBounds(bounds, smoothOpts);
    } else {
      map.flyTo([ll.lat, ll.lng], 7, smoothOpts);
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

  function focusCarrier(carrierId) {
    const entry = registry.get(carrierId);
    if (!entry || entry.kind !== 'carrier') return false;
    map.flyTo([entry.coords.lat, entry.coords.lng], 7, smoothOpts);
    const el = entry.marker && entry.marker.getElement();
    const pin = el && el.querySelector('.map-pin');
    if (pin) flash(pin);
    return true;
  }

  function flash(el) {
    el.classList.remove('is-agent-highlighted');
    void el.offsetWidth;
    el.classList.add('is-agent-highlighted');
    setTimeout(() => el.classList.remove('is-agent-highlighted'), 1400);
  }

  function focusTarget(target) {
    if (target == null) return false;
    // coord object
    if (typeof target === 'object' && target !== null && Number.isFinite(target.lat) && Number.isFinite(target.lng)) {
      panTo(target.lat, target.lng, target.zoom);
      return true;
    }
    const str = String(target).trim();
    if (!str) return false;

    // Id lookup first — cheaper than a string match.
    if (registry.has(str)) {
      const entry = registry.get(str);
      if (entry.kind === 'load') return focusLoad(str);
      if (entry.kind === 'carrier') return focusCarrier(str);
    }

    // City match (exact key, then case-insensitive key-contains).
    const cityExact = CITY_COORDS[str];
    if (cityExact) {
      map.flyTo([cityExact.lat, cityExact.lng], 7, smoothOpts);
      return true;
    }
    const lower = str.toLowerCase();
    const cityKey = Object.keys(CITY_COORDS).find((k) => k.toLowerCase() === lower);
    if (cityKey) {
      const c = CITY_COORDS[cityKey];
      map.flyTo([c.lat, c.lng], 7, smoothOpts);
      return true;
    }

    // State match — accept "TX", "tx", "Texas".
    const stateMatches = Object.keys(CITY_COORDS).filter((k) => {
      const st = k.split(',')[1] ? k.split(',')[1].trim() : '';
      return st && (st.toLowerCase() === lower || lower.endsWith(' ' + st.toLowerCase()));
    });
    if (stateMatches.length) {
      const bounds = L.latLngBounds(stateMatches.map((k) => [CITY_COORDS[k].lat, CITY_COORDS[k].lng])).pad(0.2);
      map.flyToBounds(bounds, { ...smoothOpts, maxZoom: 6 });
      return true;
    }

    // Loose contains.
    const partial = Object.keys(CITY_COORDS).find((k) => k.toLowerCase().includes(lower));
    if (partial) {
      const c = CITY_COORDS[partial];
      map.flyTo([c.lat, c.lng], 7, smoothOpts);
      return true;
    }
    return false;
  }

  function highlightLoad(loadId) {
    const ok = focusLoad(loadId);
    if (!ok) return false;
    const entry = registry.get(loadId);
    // Open the first available pin's popup.
    const m = entry.pickup || entry.dropoff;
    if (m) m.openPopup();
    return true;
  }

  function setLayerVisible(layer, on) {
    const name = String(layer || '').toLowerCase();
    const visible = !!on;
    if (name === 'loads') {
      if (visible) { visibleLayers.add('loads'); loadLayer.addTo(map); }
      else { visibleLayers.delete('loads'); map.removeLayer(loadLayer); }
    } else if (name === 'carriers') {
      if (visible) { visibleLayers.add('carriers'); carrierLayer.addTo(map); }
      else { visibleLayers.delete('carriers'); map.removeLayer(carrierLayer); }
    } else if (name === 'lanes') {
      if (visible) { visibleLayers.add('lanes'); laneLayer.addTo(map); }
      else { visibleLayers.delete('lanes'); map.removeLayer(laneLayer); }
    } else if (name === 'delayed') {
      delayedOnly = visible;
      applyDelayedFilter();
    } else {
      return false;
    }
    // Reflect in the chip buttons.
    const chip = filterRail && filterRail.querySelector(`[data-layer="${CSS.escape(name)}"]`);
    if (chip) chip.setAttribute('aria-pressed', visible ? 'true' : 'false');
    renderFilterList();
    return true;
  }

  function applyDelayedFilter() {
    // Re-add markers conditionally.
    loadLayer.clearLayers();
    loads.forEach((l) => {
      if (delayedOnly && l.status !== 'delayed') return;
      const entry = registry.get(l.id);
      if (!entry) return;
      [entry.pickup, entry.dropoff].forEach((m) => { if (m) loadLayer.addLayer(m); });
    });
  }

  // --- bootstrap data + bind UI

  loads.forEach(addLoadMarker);
  carriers.forEach(addCarrierMarker);
  renderFilterList();
  renderListView();

  // Chip filters
  if (filterRail) {
    filterRail.querySelectorAll('.chip-btn[data-layer]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const layer = btn.getAttribute('data-layer');
        const next = btn.getAttribute('aria-pressed') !== 'true';
        setLayerVisible(layer, next);
      });
    });
  }

  if (searchInput) searchInput.addEventListener('input', () => renderFilterList());

  // Zoom/reset controls
  if (zoomInBtn) zoomInBtn.addEventListener('click', () => map.zoomIn(1, smoothOpts));
  if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => map.zoomOut(1, smoothOpts));
  if (resetBtn) resetBtn.addEventListener('click', () => {
    map.flyTo([DEFAULT_VIEW.lat, DEFAULT_VIEW.lng], DEFAULT_VIEW.zoom, smoothOpts);
  });

  // List view fallback toggle
  let listOpen = false;
  function setListView(on) {
    listOpen = !!on;
    if (listView) listView.hidden = !listOpen;
    if (canvas) canvas.setAttribute('aria-hidden', listOpen ? 'true' : 'false');
    if (listToggleBtn) {
      listToggleBtn.setAttribute('aria-pressed', listOpen ? 'true' : 'false');
      listToggleBtn.textContent = listOpen ? 'Map view' : 'List view';
    }
  }
  if (listToggleBtn) listToggleBtn.addEventListener('click', () => setListView(!listOpen));

  // ESC closes detail panel
  function onKeydown(ev) {
    if (ev.key === 'Escape' && detail && detail.classList.contains('is-open')) {
      closeDetailPanel();
    }
  }
  document.addEventListener('keydown', onKeydown);

  // --- agent event wiring
  const onFocus = (ev) => {
    const d = ev.detail || {};
    focusTarget(d.target != null ? d.target : d);
  };
  const onHighlight = (ev) => {
    const d = ev.detail || {};
    if (d.load_id) highlightLoad(d.load_id);
  };
  const onShowLayer = (ev) => {
    const d = ev.detail || {};
    if (d.layer != null && d.visible != null) setLayerVisible(d.layer, d.visible);
  };
  document.addEventListener('map:focus', onFocus);
  document.addEventListener('map:highlight-load', onHighlight);
  document.addEventListener('map:show-layer', onShowLayer);

  // Make the canvas itself resizable when the rail collapses — Leaflet
  // needs an explicit invalidateSize() when its container changes size.
  const ro = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(() => { try { map.invalidateSize(); } catch {} })
    : null;
  if (ro && canvas) ro.observe(canvas);

  const api = {
    panTo,
    focusTarget,
    highlightLoad,
    setLayerVisible,
    focusLoad,
    focusCarrier,
    openLoadDetail,
    openCarrierDetail,
    CITY_COORDS,
    _map: map
  };

  // expose a global handle for the agent's tool handlers (fallback for
  // environments where the event wiring hasn't caught up).
  window.__mapWidget = api;

  function destroy() {
    try { map.remove(); } catch {}
    if (ro && canvas) try { ro.unobserve(canvas); } catch {}
    document.removeEventListener('keydown', onKeydown);
    document.removeEventListener('map:focus', onFocus);
    document.removeEventListener('map:highlight-load', onHighlight);
    document.removeEventListener('map:show-layer', onShowLayer);
    if (window.__mapWidget === api) delete window.__mapWidget;
  }

  return { api, destroy };
}

export { CITY_COORDS };
