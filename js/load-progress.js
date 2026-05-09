// Deterministic time-driven progress for a load.
// Same inputs (load, nowMs) → same outputs, so trucks resume their correct
// position on every refresh / SPA nav / device.

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

function resolveCity(name) {
  if (!name) return null;
  return CITY_COORDS[String(name).trim()] || null;
}

function haversineMiles(a, b) {
  const toRad = (x) => (x * Math.PI) / 180;
  const R = 3958.8;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) *
    Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function hashSeed(id) {
  const s = String(id || 'x');
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 0xffffffff;
}

// Demo loop, intentionally slow so motion reads as "freight" not
// "animation". 20–40 minutes per full route.
const DEMO_LOOP_MS_MIN = 1_200_000;
const DEMO_LOOP_MS_MAX = 2_400_000;

export function getLoadProgress(load, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const empty = { progress: 0, remainingMs: 0, etaText: '—', currentLatLng: null, bearingDeg: 0 };
  if (!load) return empty;

  const a = resolveCity(load.pickup);
  const b = resolveCity(load.dropoff);
  const miles = Number.isFinite(load.miles) && load.miles > 0
    ? load.miles
    : (a && b ? haversineMiles(a, b) : 300);

  const seed = hashSeed(load.id);
  const totalMs = DEMO_LOOP_MS_MIN + seed * (DEMO_LOOP_MS_MAX - DEMO_LOOP_MS_MIN);
  const phase = seed * totalMs;
  const periodMs = totalMs * 1.4;
  const elapsed = ((now - phase) % periodMs + periodMs) % periodMs;

  let progress, remainingMs;
  if (load.status === 'delivered') {
    progress = 1; remainingMs = 0;
  } else if (load.status === 'pending' || load.status === 'booked') {
    // Drift slowly between origin and 25% so pickup pin still feels alive.
    progress = (elapsed / periodMs) * 0.25;
    remainingMs = (miles / 38) * 3_600_000;
  } else {
    progress = Math.min(1, elapsed / totalMs);
    remainingMs = Math.max(0, (miles / 38) * 3_600_000 * (1 - progress));
  }

  let currentLatLng = null;
  let bearingDeg = 0;
  if (a && b) {
    currentLatLng = {
      lat: a.lat + (b.lat - a.lat) * progress,
      lng: a.lng + (b.lng - a.lng) * progress
    };
    bearingDeg = ((Math.atan2(b.lng - a.lng, b.lat - a.lat) * 180) / Math.PI + 360) % 360;
  } else if (a) {
    currentLatLng = { lat: a.lat, lng: a.lng };
  }

  return { progress, remainingMs, etaText: fmtRemaining(remainingMs, load.status), currentLatLng, bearingDeg };
}

function fmtRemaining(ms, status) {
  if (status === 'delivered') return 'Delivered';
  if (status === 'pending') return 'Awaiting carrier';
  if (status === 'booked') return 'Pickup pending';
  if (!Number.isFinite(ms) || ms <= 0) return 'Arriving';
  const total = Math.round(ms / 60_000);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h <= 0) return `${m}m`;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}
