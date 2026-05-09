import { isLoadInMotion } from './formatters.js';

const BOOKED_REVENUE_STATUSES = new Set(['booked', 'in_transit', 'delayed', 'delivered']);
const OPEN_BOOKED_REVENUE_STATUSES = new Set(['booked', 'in_transit', 'delayed']);
const DEFAULT_LOAD_STATUSES = ['pending', 'booked', 'in_transit', 'delayed', 'delivered'];

function rows(input) {
  return Array.isArray(input) ? input : [];
}

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sumLoadField(loads, predicate, field) {
  return rows(loads).reduce((total, load) => {
    if (!load || !predicate(load)) return total;
    const value = finiteNumber(load[field]);
    return value == null ? total : total + value;
  }, 0);
}

function stateFromCity(value) {
  const match = String(value || '').trim().match(/,\s*([A-Za-z]{2})\s*$/);
  return match ? match[1].toUpperCase() : null;
}

function equipmentList(carrier) {
  if (!carrier) return [];
  if (Array.isArray(carrier.equipment)) return carrier.equipment;
  return carrier.equipment ? [carrier.equipment] : [];
}

/** Formula: count loads by exact status, seeded with pending/booked/in_transit/delayed/delivered and preserving any other status keys. */
export function selectLoadStatusCounts(loads) {
  const counts = DEFAULT_LOAD_STATUSES.reduce((acc, status) => {
    acc[status] = 0;
    return acc;
  }, {});

  rows(loads).forEach((load) => {
    const status = load && load.status ? String(load.status) : 'unknown';
    counts[status] = (counts[status] || 0) + 1;
  });

  return counts;
}

/** Formula: sum finite rate where status is booked, in_transit, delayed, or delivered. */
export function selectBookedRevenue(loads) {
  return sumLoadField(loads, (load) => BOOKED_REVENUE_STATUSES.has(load.status), 'rate');
}

/** Formula: sum finite rate where status is booked, in_transit, or delayed. */
export function selectOpenBookedRevenue(loads) {
  return sumLoadField(loads, (load) => OPEN_BOOKED_REVENUE_STATUSES.has(load.status), 'rate');
}

/** Formula: count loads where isLoadInMotion(load) is true, meaning booked or in_transit. */
export function selectLoadsInMotion(loads) {
  return rows(loads).filter(isLoadInMotion).length;
}

/** Formula: sum finite miles where status is exactly in_transit. */
export function selectMilesInMotion(loads) {
  return sumLoadField(loads, (load) => load.status === 'in_transit', 'miles');
}

/** Formula: count loads where status is not delivered. */
export function selectOpenLoads(loads) {
  return rows(loads).filter((load) => load && load.status !== 'delivered').length;
}

/** Formula: count loads where status is exactly delayed. */
export function selectDelayedLoads(loads) {
  return rows(loads).filter((load) => load && load.status === 'delayed').length;
}

/** Formula: count loads where status is exactly pending. */
export function selectPendingLoads(loads) {
  return rows(loads).filter((load) => load && load.status === 'pending').length;
}

/** Formula: sum finite rate divided by sum finite miles over loads with finite rate and miles > 0; returns null when none qualify. */
export function selectAverageRatePerMile(loads) {
  const totals = rows(loads).reduce((acc, load) => {
    const rate = finiteNumber(load && load.rate);
    const miles = finiteNumber(load && load.miles);
    if (rate == null || miles == null || miles <= 0) return acc;
    acc.rate += rate;
    acc.miles += miles;
    return acc;
  }, { rate: 0, miles: 0 });

  return totals.miles > 0 ? totals.rate / totals.miles : null;
}

/** Formula: group all loads by pickup-state->dropoff-state, returning count and sum(rate)/sum(miles) for eligible loads in each lane. */
export function selectLanesSummary(loads) {
  const laneMap = new Map();

  rows(loads).forEach((load) => {
    const pickupState = stateFromCity(load && load.pickup);
    const dropoffState = stateFromCity(load && load.dropoff);
    if (!pickupState || !dropoffState) return;

    const key = `${pickupState}->${dropoffState}`;
    const current = laneMap.get(key) || {
      key,
      label: `${pickupState} -> ${dropoffState}`,
      count: 0,
      rate: 0,
      miles: 0
    };
    current.count += 1;

    const rate = finiteNumber(load.rate);
    const miles = finiteNumber(load.miles);
    if (rate != null && miles != null && miles > 0) {
      current.rate += rate;
      current.miles += miles;
    }
    laneMap.set(key, current);
  });

  return Array.from(laneMap.values())
    .map((lane) => ({
      key: lane.key,
      label: lane.label,
      count: lane.count,
      avgRatePerMile: lane.miles > 0 ? lane.rate / lane.miles : null
    }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/** Formula: count all carrier records. */
export function selectTotalCarriers(carriers) {
  return rows(carriers).length;
}

/** Formula: count carriers where available is exactly true. */
export function selectAvailableCarriers(carriers) {
  return rows(carriers).filter((carrier) => carrier && carrier.available === true).length;
}

/** Formula: alias selectAvailableCarriers because there is no explicit online field yet. */
export function selectDriversOnline(carriers) {
  return selectAvailableCarriers(carriers);
}

/** Formula: mean finite carrier rating rounded to two decimals as a Number; returns null when no ratings qualify. */
export function selectAverageCarriersRating(carriers) {
  const ratings = rows(carriers)
    .map((carrier) => finiteNumber(carrier && carrier.rating))
    .filter((rating) => rating != null);
  if (!ratings.length) return null;
  const mean = ratings.reduce((total, rating) => total + rating, 0) / ratings.length;
  return Math.round(mean * 100) / 100;
}

/** Formula: count each carrier equipment name across all carriers, sorted by count descending then name ascending. */
export function selectEquipmentCounts(carriers) {
  const counts = new Map();
  rows(carriers).forEach((carrier) => {
    equipmentList(carrier).forEach((equipment) => {
      const name = String(equipment || '').trim();
      if (!name) return;
      counts.set(name, (counts.get(name) || 0) + 1);
    });
  });

  return new Map(Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}
