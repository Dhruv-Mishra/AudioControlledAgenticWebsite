import { initDataStore, isReady, listCarriers, listLoads, subscribe } from './data-store.js';
import { formatMiles, formatMoney } from './formatters.js';
import {
  selectAvailableCarriers,
  selectAverageCarriersRating,
  selectAverageRatePerMile,
  selectBookedRevenue,
  selectDelayedLoads,
  selectDriversOnline,
  selectEquipmentCounts,
  selectLoadStatusCounts,
  selectLoadsInMotion,
  selectMilesInMotion,
  selectOpenBookedRevenue,
  selectOpenLoads,
  selectPendingLoads,
  selectTotalCarriers
} from './selectors.js';

const EMPTY = '\u2014';
const boundRoots = new Set();
const storeEvents = ['data:ready', 'load:updated', 'carrier:updated', 'store:reset'];

let subscribed = false;
let initPromise = null;

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function formatRatePerMile(value) {
  return value == null ? EMPTY : `$${value.toFixed(2)}/mi`;
}

function formatRating(value) {
  return value == null ? EMPTY : value.toFixed(1);
}

function equipmentCountText(count, element) {
  const hint = element && typeof element.getAttribute === 'function'
    ? element.getAttribute('data-kpi-format')
    : '';
  if (hint === 'count') return String(count);
  return `${count.toLocaleString('en-US')} ${count === 1 ? 'rig' : 'rigs'}`;
}

const KPI_RENDERERS = {
  'booked.revenue': ({ loads }) => formatMoney(selectBookedRevenue(loads)),
  'booked.revenue.open': ({ loads }) => formatMoney(selectOpenBookedRevenue(loads)),
  'loads.in_motion': ({ loads }) => String(selectLoadsInMotion(loads)),
  'loads.miles_in_motion': ({ loads }) => formatMiles(selectMilesInMotion(loads)),
  'loads.open': ({ loads }) => String(selectOpenLoads(loads)),
  'loads.delayed': ({ loads }) => String(selectDelayedLoads(loads)),
  'loads.pending': ({ loads }) => String(selectPendingLoads(loads)),
  'loads.in_transit': ({ counts }) => String(counts.in_transit || 0),
  'loads.booked': ({ counts }) => String(counts.booked || 0),
  'loads.delivered': ({ counts }) => String(counts.delivered || 0),
  'loads.total': ({ loads }) => String(loads.length),
  'loads.avg_rate_per_mile': ({ loads }) => formatRatePerMile(selectAverageRatePerMile(loads)),
  'carriers.total': ({ carriers }) => String(selectTotalCarriers(carriers)),
  'carriers.available': ({ carriers }) => String(selectAvailableCarriers(carriers)),
  'carriers.online': ({ carriers }) => String(selectDriversOnline(carriers)),
  'carriers.avg_rating': ({ carriers }) => formatRating(selectAverageCarriersRating(carriers))
};

function makeContext() {
  const loads = listLoads();
  const carriers = listCarriers();
  const equipmentCounts = selectEquipmentCounts(carriers);
  const equipmentBySlug = new Map();
  equipmentCounts.forEach((count, name) => {
    equipmentBySlug.set(slugify(name), { name, count });
  });

  return {
    loads,
    carriers,
    counts: selectLoadStatusCounts(loads),
    equipmentBySlug
  };
}

function collectKpiElements(root) {
  if (!root) return [];
  const elements = [];
  if (typeof root.getAttribute === 'function' && root.getAttribute('data-kpi')) {
    elements.push(root);
  }
  if (typeof root.querySelectorAll === 'function') {
    elements.push(...root.querySelectorAll('[data-kpi]'));
  }
  return Array.from(new Set(elements));
}

function renderEquipmentKpi(key, context, element) {
  const slug = key.slice('equipment.'.length);
  const item = context.equipmentBySlug.get(slug);
  return equipmentCountText(item ? item.count : 0, element);
}

function renderKpiElement(element, context) {
  const key = element.getAttribute('data-kpi');
  if (!key) return;
  const isEquipment = key.startsWith('equipment.');
  const renderer = isEquipment ? null : KPI_RENDERERS[key];
  if (!isEquipment && !renderer) {
    // Dev-mode aid: typo'd `data-kpi` keys silently no-op'd before, which
    // is hard to debug. Warn once per unknown key.
    warnUnknownKpiKey(key);
    return;
  }
  const value = isEquipment
    ? renderEquipmentKpi(key, context, element)
    : renderer(context, element);
  if (value == null) return;
  element.textContent = value;
}

const _warnedKpiKeys = new Set();
function warnUnknownKpiKey(key) {
  if (_warnedKpiKeys.has(key)) return;
  _warnedKpiKeys.add(key);
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('jarvis.debug') === '1') {
      // eslint-disable-next-line no-console
      console.warn('[kpi-binder] no renderer for data-kpi="' + key + '"');
    }
  } catch {}
}

function refreshAllBoundKpis() {
  boundRoots.forEach((root) => refreshKpisIn(root));
}

function ensureSubscriptions() {
  if (subscribed) return;
  subscribed = true;
  storeEvents.forEach((eventName) => {
    subscribe(eventName, refreshAllBoundKpis);
  });
}

function ensureStoreReady() {
  if (isReady()) return Promise.resolve();
  if (!initPromise) {
    initPromise = initDataStore()
      .then(() => refreshAllBoundKpis())
      .catch((err) => {
        initPromise = null;
        if (typeof console !== 'undefined' && console.error) console.error('[kpi-binder] data store init failed', err);
      });
  }
  return initPromise;
}

export function refreshKpisIn(root = document) {
  if (!root || !isReady()) return;
  const elements = collectKpiElements(root);
  if (!elements.length) return;
  const context = makeContext();
  elements.forEach((element) => renderKpiElement(element, context));
}

export function bindKpis(root = document) {
  if (!root) return;
  boundRoots.add(root);
  ensureSubscriptions();
  if (isReady()) refreshKpisIn(root);
  else ensureStoreReady();
}
