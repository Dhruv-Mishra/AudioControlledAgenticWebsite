const EMPTY = '\u2014';

const CITY_COORDS = {
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
};

const LOAD_STATUS = {
  pending: { label: 'Pending', tone: 'neutral' },
  booked: { label: 'Booked', tone: 'info' },
  in_transit: { label: 'In transit', tone: 'info' },
  delayed: { label: 'Delayed', tone: 'warn' },
  delivered: { label: 'Delivered', tone: 'success' }
};

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function titleCase(value) {
  const text = String(value == null || value === '' ? 'unknown' : value)
    .replace(/[_-]+/g, ' ')
    .trim();
  return text.replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}

function resolveCity(name) {
  if (!name) return null;
  return CITY_COORDS[String(name).trim()] || null;
}

function haversineMiles(a, b) {
  const toRad = (value) => (value * Math.PI) / 180;
  const radius = 3958.8;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) *
    Math.sin(dLng / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(x));
}

function hashSeed(id) {
  const text = String(id || 'x');
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

function formatRelativeDuration(ms) {
  const totalMinutes = Math.max(0, Math.round(Math.abs(ms) / 60_000));
  if (totalMinutes < 1) return 'less than 1 min';
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours ? `${days}d ${remainingHours}h` : `${days}d`;
}

function formatRemaining(ms, status) {
  if (status === 'delivered') return 'Delivered';
  if (status === 'pending') return 'Awaiting carrier';
  if (status === 'booked') return 'Pickup pending';
  if (!Number.isFinite(ms) || ms <= 0) return 'Arriving';
  const total = Math.round(ms / 60_000);
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours <= 0) return `${minutes}m`;
  return `${hours}h ${String(minutes).padStart(2, '0')}m`;
}

export function formatMoney(value) {
  const number = numberOrNull(value);
  return number == null ? EMPTY : `$${Math.round(number).toLocaleString('en-US')}`;
}

export function formatMiles(value) {
  const number = numberOrNull(value);
  return number == null ? EMPTY : `${Math.round(number).toLocaleString('en-US')} mi`;
}

export function formatWeight(value) {
  const number = numberOrNull(value);
  return number == null ? EMPTY : `${Math.round(number).toLocaleString('en-US')} lb`;
}

export function formatLoadStatus(status) {
  return LOAD_STATUS[status] || { label: titleCase(status), tone: 'neutral' };
}

export function formatCarrierAvailability(carrier) {
  if (!carrier || !carrier.available) {
    if (carrier && carrier.status === 'in_transit') return { label: 'On a load', tone: 'info' };
    return { label: 'Unavailable', tone: 'neutral' };
  }
  return { label: 'Available', tone: 'success' };
}

export function formatEta(load, now = Date.now()) {
  const iso = load && load.eta ? String(load.eta) : null;
  if (!iso) return { iso: null, niceRelative: EMPTY, niceAbsolute: EMPTY };
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return { iso, niceRelative: EMPTY, niceAbsolute: EMPTY };
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const diff = date.getTime() - nowMs;
  const duration = formatRelativeDuration(diff);
  return {
    iso,
    niceRelative: diff >= 0 ? `in ${duration}` : `${duration} ago`,
    niceAbsolute: date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    })
  };
}

/**
 * Canonical moving-load definition: only booked and in-transit loads count as
 * in motion. Delayed loads require attention but are not counted as rolling.
 */
export function isLoadInMotion(load) {
  return !!load && (load.status === 'in_transit' || load.status === 'booked');
}

const DEMO_LOOP_MS_MIN = 1_200_000;
const DEMO_LOOP_MS_MAX = 2_400_000;

export function loadProgress(load, now = Date.now()) {
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const empty = { progress: 0, remainingMs: 0, etaText: EMPTY, currentLatLng: null, bearingDeg: 0, eta: formatEta(load, nowMs) };
  if (!load) return empty;

  const start = resolveCity(load.pickup);
  const end = resolveCity(load.dropoff);
  const explicitMiles = Number(load.miles);
  const miles = Number.isFinite(explicitMiles) && explicitMiles > 0
    ? explicitMiles
    : (start && end ? haversineMiles(start, end) : 300);

  const seed = hashSeed(load.id);
  const totalMs = DEMO_LOOP_MS_MIN + seed * (DEMO_LOOP_MS_MAX - DEMO_LOOP_MS_MIN);
  const phase = seed * totalMs;
  const periodMs = totalMs * 1.4;
  const elapsed = ((nowMs - phase) % periodMs + periodMs) % periodMs;

  let progress;
  let remainingMs;
  if (load.status === 'delivered') {
    progress = 1;
    remainingMs = 0;
  } else if (load.status === 'pending' || load.status === 'booked') {
    progress = (elapsed / periodMs) * 0.25;
    remainingMs = (miles / 38) * 3_600_000;
  } else {
    progress = Math.min(1, elapsed / totalMs);
    remainingMs = Math.max(0, (miles / 38) * 3_600_000 * (1 - progress));
  }

  let currentLatLng = null;
  let bearingDeg = 0;
  if (start && end) {
    currentLatLng = {
      lat: start.lat + (end.lat - start.lat) * progress,
      lng: start.lng + (end.lng - start.lng) * progress
    };
    bearingDeg = ((Math.atan2(end.lng - start.lng, end.lat - start.lat) * 180) / Math.PI + 360) % 360;
  } else if (start) {
    currentLatLng = { lat: start.lat, lng: start.lng };
  }

  return {
    progress,
    remainingMs,
    etaText: formatRemaining(remainingMs, load.status),
    currentLatLng,
    bearingDeg,
    eta: formatEta(load, nowMs)
  };
}
