// Rate Negotiation page — production-grade FSM-driven flow.
//
// Replaces the previous spammable handlers. See js/negotiation-state.js
// for the state machine. UI rules:
//   - Accept disabled while submitting; locks permanently after success.
//   - Make Offer disabled while submitting; throttled to 1.5 s between
//     successful submissions; client-side validated before send.
//   - History timeline shows every offer / counter / accept / reject.
//   - SessionStorage persistence so refresh resumes mid-negotiation.
//   - aria-live region announces state transitions.
//   - AbortController cancels in-flight on exit().

import * as fsm from './negotiation-state.js';
import { getSelection, selectLoad as rememberSelectedLoad } from './page-state.js';
import { assignCarrierToLoad, getLoad, initDataStore, listLoads, subscribe } from './data-store.js';

let agentRef = null;
let state = null;       // FSM state object
let load = null;        // selected load
let suggestedRate = 0;
let lastSubmitAt = 0;
const THROTTLE_MS = 1500;
const CARRIER_RESPONSE_DELAY_MS = 5000;
const CARRIER_RESPONSE_JITTER_MS = 900;
const AGENT_REACTION_DELAY_MS = 600;
const AUTO_NEGOTIATION_TURN_DELAY_MS = 1900;
const AUTO_NEGOTIATION_MAX_ROUNDS = 6;
const TYPEWRITER_STEP_MS = 18;
let inflight = null;    // { id, controller }
let carrierTyping = null;
let pendingTypewriterHistoryId = null;
let agentReactionTimer = null;
let autoNegotiationTimer = null;
let autoNegotiation = { active: false, maxRate: null, rounds: 0 };
let agentSuggestionCache = null;
const completedTypewriterHistoryIds = new Set();
let unsubAccept = null;
let unsubOffer = null;
let unsubInput = null;
let unsubKey = null;
let unsubStore = null;
let unsubDelegate = null;
let unsubAgentPropose = null;
let unsubAgentRun = null;
let unsubNewNegotiation = null;
let unsubLaneInputs = null;

const CITY_OPTIONS = [
  'Atlanta, GA', 'Austin, TX', 'Charlotte, NC', 'Chicago, IL', 'Dallas, TX',
  'Denver, CO', 'Detroit, MI', 'Houston, TX', 'Indianapolis, IN', 'Jacksonville, FL',
  'Kansas City, MO', 'Las Vegas, NV', 'Los Angeles, CA', 'Memphis, TN',
  'Miami, FL', 'Minneapolis, MN', 'Nashville, TN', 'Newark, NJ', 'New Orleans, LA',
  'New York, NY', 'Orlando, FL', 'Philadelphia, PA', 'Phoenix, AZ', 'Portland, OR',
  'Salt Lake City, UT', 'San Francisco, CA', 'Seattle, WA', 'St. Louis, MO'
];

const CITY_COORDS = Object.freeze({
  'Atlanta, GA': { lat: 33.7490, lng: -84.3880 },
  'Austin, TX': { lat: 30.2672, lng: -97.7431 },
  'Charlotte, NC': { lat: 35.2271, lng: -80.8431 },
  'Chicago, IL': { lat: 41.8781, lng: -87.6298 },
  'Dallas, TX': { lat: 32.7767, lng: -96.7970 },
  'Denver, CO': { lat: 39.7392, lng: -104.9903 },
  'Detroit, MI': { lat: 42.3314, lng: -83.0458 },
  'Houston, TX': { lat: 29.7604, lng: -95.3698 },
  'Indianapolis, IN': { lat: 39.7684, lng: -86.1581 },
  'Jacksonville, FL': { lat: 30.3322, lng: -81.6557 },
  'Kansas City, MO': { lat: 39.0997, lng: -94.5786 },
  'Las Vegas, NV': { lat: 36.1699, lng: -115.1398 },
  'Los Angeles, CA': { lat: 34.0522, lng: -118.2437 },
  'Memphis, TN': { lat: 35.1495, lng: -90.0490 },
  'Miami, FL': { lat: 25.7617, lng: -80.1918 },
  'Minneapolis, MN': { lat: 44.9778, lng: -93.2650 },
  'Nashville, TN': { lat: 36.1627, lng: -86.7816 },
  'Newark, NJ': { lat: 40.7357, lng: -74.1724 },
  'New Orleans, LA': { lat: 29.9511, lng: -90.0715 },
  'New York, NY': { lat: 40.7128, lng: -74.0060 },
  'Orlando, FL': { lat: 28.5383, lng: -81.3792 },
  'Philadelphia, PA': { lat: 39.9526, lng: -75.1652 },
  'Phoenix, AZ': { lat: 33.4484, lng: -112.0740 },
  'Portland, OR': { lat: 45.5152, lng: -122.6784 },
  'Salt Lake City, UT': { lat: 40.7608, lng: -111.8910 },
  'San Francisco, CA': { lat: 37.7749, lng: -122.4194 },
  'Seattle, WA': { lat: 47.6062, lng: -122.3321 },
  'St. Louis, MO': { lat: 38.6270, lng: -90.1994 }
});

const COMMODITY_OPTIONS = [
  'Auto parts', 'Consumer electronics', 'Food-grade dry freight', 'Industrial chemicals',
  'Machinery', 'Packaged foods', 'Packaged goods', 'Paper products', 'Pharmaceuticals',
  'Refrigerated produce', 'Retail fixtures', 'Steel coils'
];

const PRICING_MODEL = Object.freeze({
  baseFee: 235,
  linehaulPerMile: 1.62,
  fuelPerMile: 0.42,
  weightPerMilePerThousandLb: 0.013,
  handlingPerThousandLb: 6.5,
  heavyThresholdLb: 34000,
  heavyHandlingPerThousandLb: 15,
  minimumBillableMiles: 120,
  defaultWeightLb: 26000,
  minimumRate: 650,
  sellerFloorMargin: 1.04,
  sellerTargetMargin: 1.14,
  sellerQuickCloseMargin: 1.08
});

const NEGOTIATOR_TYPES = [
  {
    name: 'Maya Torres',
    role: 'Regional fleet owner',
    description: 'Runs a mature dry-van operation with long-standing retail freight and little appetite for fuzzy pickup details.',
    experience: '18 years in freight',
    fleet: '42 tractors / 96 trailers',
    primaryLanes: 'Midwest to Southeast retail lanes',
    anchorAccount: 'Home improvement retail network',
    operatingPressure: 'Keeping seated trucks loaded after two soft weeks',
    negotiationPosture: 'Rewards fast commitment, clean appointment windows, and numbers that keep drivers moving.',
    stance: 'quick close',
    mood: 'interested',
    patience: 0.44,
    sensitivity: 0.38,
    floorRange: [0.94, 1.01],
    targetRange: [1.08, 1.18],
    quickRange: [1.02, 1.08],
    concession: 0.22,
    read: 'Wants a clean number and will reward speed.'
  },
  {
    name: 'Grant Weller',
    role: 'Enterprise carrier sales lead',
    description: 'Represents a premium carrier group built around service-sensitive shippers and tight tender acceptance.',
    experience: '22 years in transportation',
    fleet: '115 tractors plus brokerage capacity',
    primaryLanes: 'Food-grade and high-service contract corridors',
    anchorAccount: 'One of the largest refrigerated shippers in the region',
    operatingPressure: 'Protecting margin on volatile spot freight',
    negotiationPosture: 'Pushes back on accessorial risk, short lead times, and offers that ignore service cost.',
    stance: 'firm margin',
    mood: 'guarded',
    patience: 0.62,
    sensitivity: 0.58,
    floorRange: [0.99, 1.08],
    targetRange: [1.16, 1.3],
    quickRange: [1.12, 1.2],
    concession: 0.14,
    read: 'Will counter in smaller moves and dislikes lowballing.'
  },
  {
    name: 'Priya Nandakumar',
    role: 'Backhaul desk strategist',
    description: 'Balances contract freight with opportunistic spot moves when a lane fills an otherwise empty return leg.',
    experience: '11 years dispatching regional fleets',
    fleet: '20 reefers / 34 dry vans',
    primaryLanes: 'Texas, Arkansas, Tennessee, and Gulf backhauls',
    anchorAccount: 'Produce consolidators and seasonal beverage shippers',
    operatingPressure: 'Solving reload fit before committing scarce refrigerated capacity',
    negotiationPosture: 'Trades rate movement for backhaul fit, reload certainty, and faster payment terms.',
    stance: 'opportunistic',
    mood: 'curious',
    patience: 0.72,
    sensitivity: 0.32,
    floorRange: [0.9, 0.98],
    targetRange: [1.04, 1.16],
    quickRange: [1.0, 1.07],
    concession: 0.28,
    read: 'Flexible when the lane solves a backhaul problem.'
  },
  {
    name: 'Calvin Brooks',
    role: 'Night dispatch lead',
    description: 'Runs the after-hours board for a dense regional network where timing mistakes ripple across the next morning.',
    experience: '9 years on carrier operations desks',
    fleet: '64 trucks across two terminals',
    primaryLanes: 'Great Lakes, Ohio Valley, and Northeast reloads',
    anchorAccount: 'Automotive packaging and expedited replenishment',
    operatingPressure: 'Holding scarce overnight capacity with limited schedule slack',
    negotiationPosture: 'Needs quick clarity and is unlikely to keep haggling once the truck has another option.',
    stance: 'low patience',
    mood: 'impatient',
    patience: 0.28,
    sensitivity: 0.72,
    floorRange: [0.97, 1.05],
    targetRange: [1.1, 1.24],
    quickRange: [1.05, 1.12],
    concession: 0.1,
    read: 'May close the window if the haggling feels unserious.'
  },
  {
    name: 'Elena Marsh',
    role: 'Produce carrier owner-operator',
    description: 'Runs a small reefer fleet and knows exactly where temperature-control risk eats margin. She will move for clean appointments and fast payment.',
    experience: '14 years moving refrigerated freight',
    fleet: '9 reefers / 3 dry vans',
    primaryLanes: 'West Coast produce and mountain-state grocery lanes',
    anchorAccount: 'Regional grocers and cold-storage consolidators',
    operatingPressure: 'Protecting reefer hours while produce season tightens capacity',
    negotiationPosture: 'Flexible on backhauls, firm when temperature risk or mountain miles are in play.',
    stance: 'risk priced',
    mood: 'careful',
    patience: 0.58,
    sensitivity: 0.46,
    floorRange: [0.98, 1.07],
    targetRange: [1.12, 1.28],
    quickRange: [1.06, 1.15],
    concession: 0.18,
    read: 'Will bargain, but reefer risk has to be respected.'
  },
  {
    name: 'Marcus Reed',
    role: 'Spot-market broker carrier rep',
    description: 'Covers a mixed network of partner trucks and watches margin, reload timing, and whether the dispatcher sounds serious.',
    experience: '7 years on spot boards',
    fleet: 'Brokered partner network across 16 markets',
    primaryLanes: 'Cross-country dry van and opportunistic reloads',
    anchorAccount: 'National retail replenishment desk',
    operatingPressure: 'Keeping partner trucks committed before another broker books them',
    negotiationPosture: 'Tests the buyer early, then moves quickly if the money is credible.',
    stance: 'opportunistic margin',
    mood: 'probing',
    patience: 0.5,
    sensitivity: 0.64,
    floorRange: [0.95, 1.04],
    targetRange: [1.12, 1.26],
    quickRange: [1.05, 1.13],
    concession: 0.2,
    read: 'Will reward credible movement, but punishes unserious counters.'
  },
  {
    name: 'Nora Feld',
    role: 'Heavy freight dispatch manager',
    description: 'Coordinates heavier shipments where detention, dock time, and driver availability matter as much as mileage.',
    experience: '16 years dispatching industrial freight',
    fleet: '31 tractors with dry van and flatbed partners',
    primaryLanes: 'Industrial Midwest, Gulf, and Northeast lanes',
    anchorAccount: 'Manufacturing and building-material shippers',
    operatingPressure: 'Avoiding cheap freight that ties up a driver for a full shift',
    negotiationPosture: 'Measured and practical, but the floor rises when weight or dock risk is high.',
    stance: 'practical floor',
    mood: 'steady',
    patience: 0.67,
    sensitivity: 0.42,
    floorRange: [0.96, 1.05],
    targetRange: [1.09, 1.22],
    quickRange: [1.04, 1.11],
    concession: 0.24,
    read: 'Will meet a fair number when the operational risk is covered.'
  }
];

const REACTIONS = {
  accept: [
    'That works if we can lock it now.',
    'I can get my driver moving on that number.',
    'Good enough for this lane. Let us book it.',
    'We are aligned on that rate from my side.',
    'That number gets it done for us.',
    'I can accept that and hold the truck.',
    'That is close enough. I am good to move forward.'
  ],
  counter: [
    'I am close, but I need a little more to protect the truck.',
    'We are not far apart. Meet me here and I can keep this moving.',
    'That is moving in the right direction, but I still have risk on the lane.',
    'I can sharpen it once more, but I need a serious next move.',
    'I can give some ground, just not all the way to that number.',
    'There is room to work here, but I need the rate to carry the linehaul.',
    'If you can move a bit, I can keep this truck warm for you.',
    'I am willing to meet you partway, but I cannot make that exact rate work.'
  ],
  nearMiss: [
    'We are basically there. Give me a little cover and I can accept.',
    'That is very close. I need a small bump to protect the driver.',
    'I can almost sign off there, but not quite at that number.',
    'We are close enough that I do not want to lose the load over a small gap.'
  ],
  angryCounter: [
    'You came back the wrong direction, so my number is going up now.',
    'That move tells me the truck is being squeezed. I need more than my last ask.',
    'I was moving toward you, but that counter backs us up.',
    'If we are resetting the conversation, I have to reset the price too.'
  ],
  reject: [
    'That is too thin for the miles and timing.',
    'I cannot take that back to the driver with a straight face.',
    'We are below where this truck needs to be.',
    'That number tells me we may be solving different problems.',
    'I do not have a path to cover this truck at that rate.',
    'That is not a workable offer for this lane.',
    'I would rather decline than hold the truck on a number that light.'
  ],
  walkaway: [
    'I am going to pass before this burns more time.',
    'We are too far apart, so I am closing this out.',
    'I have another load that fits better. I am stepping away.',
    'The haggling is not worth holding the truck. We are done here.',
    'I need to release this truck to another option.',
    'This is not coming together fast enough for me to keep capacity held.'
  ],
  walkawayClose: [
    'We were close enough to close, but the penny-by-penny haggling burned the goodwill. Have some respect for the truck.',
    'That was nearly there. I am not holding capacity while we argue over lunch money.',
    'You had this in reach, then kept shaving it. This is freight, not a vegetable stand.',
    'We were close, but I am not negotiating every last dollar like we are buying tomatoes at a market.',
    'The rate was close. The way this dragged out is the problem, so I am releasing the truck.',
    'At this point the money is close, but the respect is not. I am done holding the driver.',
    'We could have booked this five minutes ago. I am not rewarding another tiny squeeze.',
    'Close number, wrong energy. I am moving this truck to someone who can commit.'
  ],
  walkawayFar: [
    'We are not in the same neighborhood on price, and I am not spending more clock on it.',
    'That is still too far under the truck. Do not waste my time with that spread.',
    'The gap is too wide for this lane. I am closing it out.',
    'I cannot bridge that kind of distance without pretending the cost is not real.',
    'We are miles apart on the money, so I am taking the truck elsewhere.',
    'That number does not cover the work. I am done chasing it.',
    'There is no clean path from your offer to my floor. I am stepping away.',
    'This is too far off market for me to keep the conversation alive.'
  ],
  longHaul: [
    'That is a long pull, and fuel exposure is doing most of the work here.',
    'For that much road time, I need the rate to cover more than just miles.',
    'Cross-country exposure keeps my floor higher on this one.'
  ],
  shortHaul: [
    'For a short move like this, accessorials matter more than mileage.',
    'The local timing and dock risk are what I am pricing here.',
    'Short haul does not mean cheap if the truck gets tied up.'
  ],
  reefer: [
    'With temperature control in play, I need more protection in the rate.',
    'Reefer freight carries risk I cannot price like standard dry van.',
    'The cold-chain piece keeps my floor tighter.'
  ],
  sensitive: [
    'That commodity needs cleaner handling than a basic dry-van move.',
    'The handling profile on this freight keeps my floor higher.',
    'I need some margin for the service risk on that commodity.'
  ],
  heavy: [
    'At that weight, I need to protect the driver and equipment time.',
    'This is heavy enough that I cannot chase the very bottom of the market.',
    'Weight is part of the rate here, not just mileage.'
  ]
};

const $ = (id) => document.getElementById(id);

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function announce(msg) {
  const live = $('negotiate-live');
  if (live) live.textContent = msg;
}

function setHint(msg, kind) {
  const el = $('negotiate-hint');
  if (!el) return;
  el.textContent = msg || '';
  el.dataset.kind = kind || '';
}

function fmt(n) { return Number(n || 0).toLocaleString('en-US'); }

function money(n) {
  const value = Number(n || 0);
  return value.toLocaleString('en-US', { maximumFractionDigits: value % 1 ? 2 : 0 });
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)] || list[0] || '';
}

function between(min, max) {
  return min + Math.random() * (max - min);
}

function randomInt(min, max) {
  return Math.round(between(min, max));
}

function uniqueStrings(values) {
  return Array.from(new Set(values.map((v) => String(v || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function writeFieldValue(id, value) {
  const el = $(id);
  if (!el) return;
  el.value = value == null ? '' : String(value);
}

function fillSelect(id, values, selected) {
  const el = $(id);
  if (!el || el.tagName !== 'SELECT') return;
  const opts = uniqueStrings(values);
  const current = selected == null ? el.value : String(selected || '');
  el.innerHTML = opts.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('');
  if (current && opts.includes(current)) el.value = current;
}

function populateLaneSelects(loadRows) {
  const rows = Array.isArray(loadRows) ? loadRows : [];
  fillSelect('field-pickup', CITY_OPTIONS.concat(rows.map((row) => row.pickup)), load && load.pickup);
  fillSelect('field-dropoff', CITY_OPTIONS.concat(rows.map((row) => row.dropoff)), load && load.dropoff);
  fillSelect('field-commodity', COMMODITY_OPTIONS.concat(rows.map((row) => row.commodity)), load && load.commodity);
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

function estimateLaneMiles(pickup, dropoff) {
  const from = CITY_COORDS[pickup];
  const to = CITY_COORDS[dropoff];
  if (!from || !to) return Number(load && load.miles) || null;
  return Math.round(haversineMiles(from, to) * 1.18);
}

function roundToNearest25(value) {
  return Math.round(Number(value || 0) / 25) * 25;
}

function commodityPricingAdjustment(commodity) {
  const text = String(commodity || '').toLowerCase();
  if (/reefer|refrigerated|produce|pharma|pharmaceutical/.test(text)) {
    return { perMile: 0.18, flat: 135, note: 'temperature-control risk' };
  }
  if (/chemical|electronics|machinery|auto/.test(text)) {
    return { perMile: 0.08, flat: 85, note: 'higher-value handling' };
  }
  if (/steel/.test(text)) {
    return { perMile: 0.1, flat: 110, note: 'securement and weight risk' };
  }
  return { perMile: 0, flat: 0, note: '' };
}

function getLanePricing(lane) {
  const miles = Math.max(
    PRICING_MODEL.minimumBillableMiles,
    Number(lane && lane.miles) || Number(load && load.miles) || PRICING_MODEL.minimumBillableMiles
  );
  const weight = Math.max(
    1000,
    Number(lane && lane.weight) || Number(load && load.weight) || PRICING_MODEL.defaultWeightLb
  );
  const weightThousands = weight / 1000;
  const heavyThousands = Math.max(0, weight - PRICING_MODEL.heavyThresholdLb) / 1000;
  const commodity = commodityPricingAdjustment(lane && lane.commodity);
  const ratePerMile = PRICING_MODEL.linehaulPerMile +
    PRICING_MODEL.fuelPerMile +
    (weightThousands * PRICING_MODEL.weightPerMilePerThousandLb) +
    commodity.perMile;
  const raw = PRICING_MODEL.baseFee +
    (miles * ratePerMile) +
    (weightThousands * PRICING_MODEL.handlingPerThousandLb) +
    (heavyThousands * PRICING_MODEL.heavyHandlingPerThousandLb) +
    commodity.flat;
  const suggested = roundToNearest25(Math.max(PRICING_MODEL.minimumRate, raw));
  const sellerFloor = roundToNearest25(suggested * PRICING_MODEL.sellerFloorMargin);
  const sellerTarget = roundToNearest25(suggested * PRICING_MODEL.sellerTargetMargin);
  const sellerQuickClose = roundToNearest25(suggested * PRICING_MODEL.sellerQuickCloseMargin);
  const notes = [];
  if (miles >= 1800) notes.push('long-haul fuel and hours');
  if (weight >= PRICING_MODEL.heavyThresholdLb) notes.push('heavy load handling');
  if (commodity.note) notes.push(commodity.note);
  return {
    distance_miles: Math.round(miles),
    weight_lb: Math.round(weight),
    linehaul_per_mile: Number(ratePerMile.toFixed(2)),
    rate_per_mile: Number((suggested / Math.max(1, miles)).toFixed(2)),
    suggested_rate: suggested,
    seller_floor: Math.max(sellerFloor, suggested),
    seller_target: Math.max(sellerTarget, sellerFloor + 50),
    seller_quick_close: Math.max(sellerQuickClose, sellerFloor),
    notes
  };
}

function laneFromLoad(row) {
  if (!row) return { pickup: '', dropoff: '', commodity: '', weight: null, miles: null };
  const pickup = row.pickup || '';
  const dropoff = row.dropoff || '';
  return {
    pickup,
    dropoff,
    commodity: row.commodity || '',
    weight: Number(row.weight) || null,
    miles: Number(row.miles) || estimateLaneMiles(pickup, dropoff)
  };
}

function getLaneDraft() {
  const pickup = ($('field-pickup') && $('field-pickup').value) || (load && load.pickup) || '';
  const dropoff = ($('field-dropoff') && $('field-dropoff').value) || (load && load.dropoff) || '';
  const commodity = ($('field-commodity') && $('field-commodity').value) || (load && load.commodity) || '';
  const weight = Number(($('field-weight') && $('field-weight').value) || (load && load.weight) || 0) || null;
  const miles = estimateLaneMiles(pickup, dropoff);
  return { pickup, dropoff, commodity, weight, miles };
}

function updateSuggestedReadout(pricing) {
  const currentPricing = pricing || getLanePricing(getLaneDraft());
  const sug = $('negotiate-suggested');
  if (!sug) return;
  sug.textContent = `$${fmt(currentPricing.suggested_rate)}`;
  sug.title = `${fmt(currentPricing.distance_miles)} mi, ${fmt(currentPricing.weight_lb)} lb, $${currentPricing.rate_per_mile}/mi`;
}

function clearAgentSuggestionCache() {
  agentSuggestionCache = null;
}

function syncSuggestedRateFromLane({ resetProfile = false, render = false } = {}) {
  const lane = getLaneDraft();
  const pricing = getLanePricing(lane);
  suggestedRate = pricing.suggested_rate;
  if (state) {
    state.suggestedRate = suggestedRate;
    state.pricing = pricing;
    const canResetProfile = resetProfile &&
      (!Array.isArray(state.history) || state.history.length === 0) &&
      !fsm.isLocked(state) &&
      !fsm.isTerminal(state);
    if (canResetProfile) state.negotiator = createNegotiatorProfile();
    fsm.save(state);
  }
  updateSuggestedReadout(pricing);
  if (render) renderNegotiatorRead();
  return pricing;
}

function getLanePressureComments(lane) {
  const comments = [];
  const commodity = String(lane && lane.commodity || '').toLowerCase();
  if (lane && lane.miles >= 1800) comments.push(...REACTIONS.longHaul);
  else if (lane && lane.miles && lane.miles <= 400) comments.push(...REACTIONS.shortHaul);
  if (/reefer|refrigerated|produce|food|pharma|pharmaceutical/.test(commodity)) comments.push(...REACTIONS.reefer);
  if (/chemical|electronics|pharma|steel|machinery|auto/.test(commodity)) comments.push(...REACTIONS.sensitive);
  if (Number(lane && lane.weight) >= 39000) comments.push(...REACTIONS.heavy);
  return comments;
}

function getWalkawayPriceBand(profile, amount) {
  const offer = Number(amount) || 0;
  const floor = Number(profile && profile.floor) || 0;
  const target = Number(profile && profile.target) || floor;
  const lastCarrier = latestCarrierAskAmount();
  const reference = Math.max(1, lastCarrier || floor || target || offer || 1);
  const floorGap = floor > 0 ? floor - offer : Infinity;
  const carrierGap = lastCarrier ? Math.abs(lastCarrier - offer) : Infinity;
  const closeToFloor = floor > 0 && floorGap <= Math.max(85, reference * 0.045);
  const closeToAsk = lastCarrier && carrierGap <= Math.max(100, reference * 0.04);
  return closeToFloor || closeToAsk ? 'close' : 'far';
}

function buildSellerComment(kind, { profile, amount, counterAmount, angry = false, near = false } = {}) {
  const lane = getLaneDraft();
  const pool = [];
  if (angry) pool.push(...REACTIONS.angryCounter);
  if (near) pool.push(...REACTIONS.nearMiss);
  if (kind === 'walkaway') {
    pool.push(...(getWalkawayPriceBand(profile, amount) === 'close' ? REACTIONS.walkawayClose : REACTIONS.walkawayFar));
  }
  pool.push(...(REACTIONS[kind] || REACTIONS.counter));
  pool.push(...getLanePressureComments(lane));
  if (lane.pickup && lane.dropoff && lane.miles >= 1800) {
    pool.push(`${lane.pickup} to ${lane.dropoff} is a cross-country haul, so I need the rate to carry fuel and hours.`);
  }
  if (profile && profile.mood === 'irritated') {
    pool.push('I need a cleaner move than that if we are going to keep talking.');
  }
  const base = pick(pool);
  if (kind === 'counter' && Number.isFinite(Number(counterAmount)) && Number.isFinite(Number(amount))) {
    const gap = Number(counterAmount) - Number(amount);
    if (gap > 0 && gap <= 75) return base + ' We are close.';
  }
  return base;
}

function buildThinkingMessage(intent) {
  const lane = getLaneDraft();
  if (intent === 'accept') return 'Seller is confirming the close';
  const options = ['Seller is checking margin', 'Seller is reviewing the lane', 'Seller is weighing the counter'];
  if (lane.miles >= 1800) options.push('Seller is checking fuel and hours on the long haul');
  if (/reefer|refrigerated|produce|pharma/i.test(lane.commodity)) options.push('Seller is checking temperature-control risk');
  if (Number(lane.weight) >= 39000) options.push('Seller is checking weight and dock time');
  return pick(options);
}

function getCarrierResponseDelay(intent) {
  const lane = getLaneDraft();
  let delay = CARRIER_RESPONSE_DELAY_MS + randomInt(0, CARRIER_RESPONSE_JITTER_MS);
  if (intent === 'accept') delay += 500;
  if (lane.miles >= 1800) delay += 650;
  if (/reefer|refrigerated|produce|pharma/i.test(lane.commodity)) delay += 450;
  return delay;
}

function createNegotiatorProfile() {
  const base = pick(NEGOTIATOR_TYPES);
  const pricing = getLanePricing(getLaneDraft());
  const market = Math.max(500, Number(pricing.suggested_rate) || Number(suggestedRate) || Number(load && load.rate) || 1850);
  const floor = Math.max(pricing.seller_floor, Math.round(market * between(base.floorRange[0], base.floorRange[1])));
  const target = Math.max(floor + 40, pricing.seller_target, Math.round(market * between(base.targetRange[0], base.targetRange[1])));
  const quickClose = Math.max(floor, Math.min(target, pricing.seller_quick_close, Math.round(market * between(base.quickRange[0], base.quickRange[1]))));
  return {
    name: base.name,
    role: base.role,
    description: base.description,
    experience: base.experience,
    fleet: base.fleet,
    primaryLanes: base.primaryLanes,
    anchorAccount: base.anchorAccount,
    operatingPressure: base.operatingPressure,
    negotiationPosture: base.negotiationPosture,
    stance: base.stance,
    mood: base.mood,
    read: base.read,
    patience: Number(base.patience.toFixed(2)),
    sensitivity: Number(base.sensitivity.toFixed(2)),
    concession: Number(base.concession.toFixed(2)),
    floor,
    target,
    quickClose,
    friction: 0,
    lastComment: base.read
  };
}

function ensureNegotiatorProfile() {
  if (!state) return null;
  if (!state.negotiator || !Number.isFinite(Number(state.negotiator.floor)) || !state.negotiator.description) {
    state.negotiator = createNegotiatorProfile();
    fsm.save(state);
  }
  return state.negotiator;
}

function publicNegotiatorProfile() {
  const p = ensureNegotiatorProfile();
  if (!p) return null;
  return {
    name: p.name,
    role: p.role,
    description: p.description,
    experience: p.experience,
    fleet: p.fleet,
    primary_lanes: p.primaryLanes,
    anchor_account: p.anchorAccount,
    operating_pressure: p.operatingPressure,
    negotiation_posture: p.negotiationPosture,
    last_comment: p.lastComment || p.read
  };
}

function readAgentMaxRate() {
  const maxEl = $('field-agent-max-rate');
  const maxRate = maxEl && Number(maxEl.value) > 0 ? Number(maxEl.value) : null;
  return maxRate;
}

function readDelegation() {
  const maxRate = readAgentMaxRate();
  return {
    enabled: !!maxRate,
    max_rate: maxRate,
    auto_active: !!autoNegotiation.active,
    rounds_completed: Number(autoNegotiation.rounds) || 0,
    can_submit_without_each_turn: !!maxRate,
    instruction: maxRate
      ? 'Jarvis may negotiate multiple rounds within max_rate, but must ask the user before closing a seller-accepted deal.'
      : 'Jarvis should suggest one realistic number and confirm each submitted amount with the user.'
  };
}

function getSuggestedRate() {
  const stateRate = Number(state && state.suggestedRate);
  if (Number.isFinite(stateRate) && stateRate > 0) return stateRate;
  const loadRate = Number(load && load.rate);
  if (Number.isFinite(loadRate) && loadRate > 0) return loadRate;
  const fallbackRate = Number(suggestedRate);
  return Number.isFinite(fallbackRate) && fallbackRate > 0 ? fallbackRate : null;
}

function getNegotiationContext() {
  const pricing = syncSuggestedRateFromLane();
  const currentSuggestedRate = getSuggestedRate();
  const history = state && Array.isArray(state.history) ? state.history : [];
  const lane = getLaneDraft();
  return {
    load_id: (state && state.loadId) || (load && load.id) || null,
    suggested_rate: currentSuggestedRate,
    quote_rules: 'Any positive dollar amount is valid. There is no multiple-of-25 rule and no fixed percent band. Suggested pricing is based on lane miles, weight, commodity risk, fuel, and handling.',
    lane: { ...lane, pricing },
    pricing,
    negotiator: publicNegotiatorProfile(),
    agent_delegation: readDelegation(),
    last_offer: state && state.latestOffer ? state.latestOffer : null,
    history_count: history.length,
    status: state && state.status
  };
}

function historyEntryId(entry) {
  if (!entry) return '';
  return [entry.at || '', entry.actor || '', entry.type || '', entry.amount || '', String(entry.note || '').slice(0, 36)].join('|');
}

function latestCarrierHistoryEntry() {
  if (!state || !Array.isArray(state.history)) return null;
  for (let i = state.history.length - 1; i >= 0; i -= 1) {
    if (state.history[i] && state.history[i].actor === 'carrier') return state.history[i];
  }
  return null;
}

function runPendingTypewriters(rootEl) {
  if (!rootEl) return;
  const nodes = rootEl.querySelectorAll('.js-carrier-typewriter');
  nodes.forEach((node) => {
    const id = node.getAttribute('data-history-id') || '';
    const full = node.getAttribute('data-typewriter-text') || '';
    if (!id || !full) return;
    if (completedTypewriterHistoryIds.has(id)) {
      node.textContent = full;
      node.classList.add('tw-done');
      return;
    }
    if (node.dataset.typingStarted === '1') return;
    node.dataset.typingStarted = '1';
    node.classList.add('tw-typing');
    const reduce = typeof window !== 'undefined'
      && window.matchMedia
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      node.textContent = full;
      node.classList.add('tw-done');
      completedTypewriterHistoryIds.add(id);
      return;
    }
    let index = 0;
    const timer = setInterval(() => {
      index += 1;
      node.textContent = full.slice(0, index);
      if (index >= full.length) {
        clearInterval(timer);
        node.classList.add('tw-done');
        completedTypewriterHistoryIds.add(id);
        if (pendingTypewriterHistoryId === id) pendingTypewriterHistoryId = null;
      }
    }, TYPEWRITER_STEP_MS);
  });
}

function delayWithAbort(ms, signal) {
  return new Promise((res, rej) => {
    const timer = setTimeout(res, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        rej(new Error('aborted'));
      }, { once: true });
    }
  });
}

function describeOutcome(outcome) {
  if (!outcome) return 'Carrier responded.';
  if (outcome.kind === 'accept') return `Seller accepted at $${money(outcome.amount)}.`;
  if (outcome.kind === 'counter') return `Carrier countered at $${money(outcome.amount)}. ${outcome.note || ''}`.trim();
  if (outcome.kind === 'walkaway') return `Carrier closed the negotiation. ${outcome.note || ''}`.trim();
  if (outcome.kind === 'reject') return `Carrier declined the offer. ${outcome.note || ''}`.trim();
  return 'Carrier responded.';
}

function scheduleAgentResponseTrigger(detail) {
  if (agentReactionTimer) clearTimeout(agentReactionTimer);
  agentReactionTimer = setTimeout(() => {
    agentReactionTimer = null;
    if (!agentRef || typeof agentRef.sendAppEvent !== 'function') return;
    agentRef.sendAppEvent('negotiator_response_arrived', detail, {
      deferUntilSpeechEnd: true,
      label: 'app_event:negotiator_response_arrived',
      reason: 'negotiator_response'
    });
  }, AGENT_REACTION_DELAY_MS);
}

function notifyNegotiatorResponseArrived(outcome, entry) {
  const detail = {
    load_id: (state && state.loadId) || (load && load.id) || null,
    status: state && state.status,
    outcome: outcome && outcome.kind,
    amount: outcome && Number.isFinite(Number(outcome.amount)) ? Number(outcome.amount) : null,
    note: outcome && outcome.note ? String(outcome.note) : '',
    summary: describeOutcome(outcome),
    history_entry_id: historyEntryId(entry),
    context: getNegotiationContext()
  };
  try { window.dispatchEvent(new CustomEvent('negotiator:response-arrived', { detail })); } catch {}
  scheduleAgentResponseTrigger(detail);
}

function renderHistory() {
  const el = $('negotiate-history');
  if (!el || !state) return;
  if (!state.history.length && !carrierTyping) {
    el.innerHTML = '<li class="negotiate-history-empty muted">No offers yet.</li>';
    return;
  }
  const thinkingText = carrierTyping && carrierTyping.message
    ? carrierTyping.message
    : 'Seller is reviewing your offer';
  const pending = carrierTyping ? `<li class="negotiate-history-item negotiate-history-item--pending" data-kind="pending" aria-live="polite" aria-busy="true">
      <span class="negotiate-history-meta"><span class="mono">now</span> &middot; Carrier</span>
      <span class="negotiate-history-body"><span class="chip chip--info">Thinking</span> <span class="typing-line"><span class="typing-text">${escapeHtml(thinkingText)}</span><span class="typing-dots" aria-hidden="true"><span></span><span></span><span></span></span></span></span>
    </li>` : '';
  const rows = state.history.slice().reverse().map((h) => {
    const t = new Date(h.at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const who = h.actor === 'dispatcher' ? 'You' : (h.actor === 'carrier' ? 'Carrier' : 'System');
    const amt = h.amount ? `<span class="mono">$${money(h.amount)}</span>` : '';
    const tag = h.type === 'accept' ? '<span class="chip chip--ok">Accepted</span>'
      : h.type === 'reject' ? '<span class="chip chip--danger">Rejected</span>'
      : h.type === 'walkaway' ? '<span class="chip chip--danger">Closed</span>'
      : h.type === 'counter' ? '<span class="chip chip--warn">Counter</span>'
      : h.type === 'error' ? '<span class="chip chip--danger">Error</span>'
      : '<span class="chip chip--info">Offer</span>';
    const id = historyEntryId(h);
    const noteText = h.note ? ` — ${h.note}` : '';
    const typewrite = h.actor === 'carrier' && h.note && id === pendingTypewriterHistoryId && !completedTypewriterHistoryIds.has(id);
    const note = h.note
      ? (typewrite
        ? `<span class="muted negotiate-history-note js-carrier-typewriter" data-history-id="${escapeHtml(id)}" data-typewriter-text="${escapeHtml(noteText)}"></span>`
        : `<span class="muted negotiate-history-note">${escapeHtml(noteText)}</span>`)
      : '';
    return `<li class="negotiate-history-item" data-kind="${escapeHtml(h.type)}">
      <span class="negotiate-history-meta"><span class="mono">${escapeHtml(t)}</span> &middot; ${escapeHtml(who)}</span>
      <span class="negotiate-history-body">${tag} ${amt} ${note}</span>
    </li>`;
  }).join('');
  el.innerHTML = pending + rows;
  runPendingTypewriters(el);
}

function renderNegotiatorRead() {
  const el = $('negotiator-read');
  const p = publicNegotiatorProfile();
  if (!el || !p) return;
  const stats = [
    ['Role', p.role],
    ['Experience', p.experience],
    ['Fleet', p.fleet],
    ['Primary lanes', p.primary_lanes],
    ['Anchor account', p.anchor_account],
    ['Current pressure', p.operating_pressure]
  ];
  el.innerHTML = `
    <div class="negotiator-read-head">
      <span class="negotiator-read-title">${escapeHtml(p.name)}</span>
      <span class="chip chip--info">Negotiator profile</span>
    </div>
    <p class="negotiator-read-description">${escapeHtml(p.description)}</p>
    <div class="negotiator-read-grid">
      ${stats.map(([label, value]) => `<div class="negotiator-read-stat"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('')}
    </div>
    <p class="negotiator-read-comment"><strong>Posture:</strong> ${escapeHtml(p.negotiation_posture)}</p>
    <p class="negotiator-read-comment"><strong>Latest read:</strong> ${escapeHtml(p.last_comment)}</p>
  `;
}

function renderState() {
  if (!state) return;
  const submit = $('negotiate-submit');
  const accept = $('btn-accept');
  const counter = $('btn-counter');
  const target = $('field-target-rate');
  const agentRun = $('negotiate-agent-run');
  const agentPropose = $('negotiate-agent-propose');
  const newNegotiation = $('btn-new-negotiation');
  const submitting = state.status === 'submitting';
  const sellerAccepted = state.status === 'seller_accepted';
  const terminal = fsm.isTerminal(state);
  const rejected = state.status === 'rejected';
  const canTryAnother = terminal || rejected;
  const hasAcceptableOffer = !rejected && !!(state.latestOffer && Number(state.latestOffer.amount) > 0);
  // Rejected is RECOVERABLE — inputs stay live so the user can craft a
  // new counter. Only `accepted` (and the unused `expired`) hard-lock.
  const lockInputs = submitting || sellerAccepted || (terminal && !rejected);

  if (submit) {
    submit.disabled = lockInputs;
    submit.textContent = submitting && state.intent === 'offer' ? 'Submitting…'
      : sellerAccepted ? 'Seller accepted'
      : terminal && !rejected ? 'Closed'
      : rejected ? 'Send new counter'
      : 'Submit offer';
  }
  if (accept) {
    accept.classList.remove('btn--locked');
    if (canTryAnother) {
      accept.disabled = submitting;
      accept.textContent = 'Try another';
    } else if (submitting && state.intent === 'accept') {
      accept.disabled = true;
      accept.textContent = 'Accepting…';
    } else {
      accept.disabled = !hasAcceptableOffer || (lockInputs && !sellerAccepted);
      accept.textContent = 'Accept and try another';
    }
  }
  if (counter) counter.disabled = lockInputs;
  if (target) target.disabled = lockInputs;
  if (agentRun) agentRun.disabled = lockInputs;
  if (agentPropose) agentPropose.disabled = lockInputs;
  if (newNegotiation) {
    newNegotiation.hidden = !(terminal || sellerAccepted || rejected);
    newNegotiation.disabled = submitting;
    newNegotiation.textContent = state.status === 'accepted'
      ? 'New negotiation'
      : 'Try another negotiation';
  }

  const chip = document.querySelector('#negotiate-form .panel-header .chip');
  if (chip) {
    chip.className = 'chip ' + (
      state.status === 'accepted' ? 'chip--ok' :
      state.status === 'seller_accepted' ? 'chip--ok' :
      state.status === 'walked_away' ? 'chip--danger' :
      state.status === 'rejected' ? 'chip--danger' :
      state.status === 'countered' ? 'chip--warn' :
      'chip--info'
    );
    const label = state.status === 'seller_accepted'
      ? 'Seller accepted'
      : state.status === 'walked_away'
      ? 'Walked away'
      : state.status[0].toUpperCase() + state.status.slice(1);
    chip.textContent = state._justReopened
      ? 'Rejected — reopened'
      : label;
  }

  if (rejected) {
    setHint('Carrier rejected — try a different price.', 'warn');
  } else if (sellerAccepted) {
    setHint(`Seller accepted at $${fmt(Math.round(state.latestOffer && state.latestOffer.amount))}. Close the deal when ready.`, 'ok');
  } else if (terminal) {
    setHint(state.status === 'accepted'
      ? `Deal closed at $${fmt(Math.round(state.latestOffer && state.latestOffer.amount))}.`
      : state.status === 'walked_away' ? 'Carrier closed the negotiation.'
      : `Negotiation ${state.status}.`, state.status === 'accepted' ? 'ok' : 'warn');
  }
  renderNegotiatorRead();
  renderHistory();
}

function readDraftAmount() {
  const el = $('field-target-rate');
  if (!el) return null;
  const n = Number(el.value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function readNote() {
  const el = $('field-note');
  return el ? el.value.trim() : '';
}

function updateDelegationUi() {
  const maxRate = readAgentMaxRate();
  if (autoNegotiation.active && maxRate) autoNegotiation.maxRate = maxRate;
  renderNegotiatorRead();
}

function latestDispatcherOfferAmount() {
  if (!state || !Array.isArray(state.history)) return null;
  for (let i = state.history.length - 1; i >= 0; i -= 1) {
    const entry = state.history[i];
    if (entry && entry.actor === 'dispatcher' && entry.type === 'offer' && Number(entry.amount) > 0) {
      return Number(entry.amount);
    }
  }
  return null;
}

function latestCarrierAskAmount() {
  if (!state || !Array.isArray(state.history)) return null;
  for (let i = state.history.length - 1; i >= 0; i -= 1) {
    const entry = state.history[i];
    if (entry && entry.actor === 'carrier' && entry.type === 'counter' && Number(entry.amount) > 0) {
      return Number(entry.amount);
    }
  }
  return null;
}

function buildAgentSuggestionKey({ forAuto = false } = {}) {
  const lane = getLaneDraft();
  const latestAmount = state && state.latestOffer ? Number(state.latestOffer.amount) || null : null;
  return JSON.stringify({
    forAuto: !!forAuto,
    loadId: state && state.loadId || load && load.id || null,
    status: state && state.status || null,
    suggestedRate: Number(suggestedRate) || null,
    maxRate: readAgentMaxRate(),
    lastCarrier: latestCarrierAskAmount(),
    lastDispatcher: latestDispatcherOfferAmount(),
    latestAmount,
    pickup: lane.pickup,
    dropoff: lane.dropoff,
    commodity: lane.commodity,
    weight: Number(lane.weight) || null,
    miles: Number(lane.miles) || null
  });
}

function applyAgentProposal(proposal, { forAuto = false, fromCache = false } = {}) {
  const target = $('field-target-rate');
  const note = $('field-note');
  const maxRate = readAgentMaxRate();
  if (target) {
    target.value = String(proposal);
    target.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (note && !note.value.trim()) {
    note.value = forAuto
      ? 'Jarvis is moving up gradually while staying under the max.'
      : 'Jarvis is testing a firm but closeable number.';
    note.dispatchEvent(new Event('input', { bubbles: true }));
  }
  setHint(`Jarvis ${fromCache ? 'kept' : 'suggested'} $${fmt(proposal)}${maxRate ? ` within the $${fmt(maxRate)} max` : ''}.`, 'ok');
  return proposal;
}

function proposeAgentOffer({ forAuto = false } = {}) {
  if (!state) return null;
  if (fsm.isTerminal(state)) {
    setHint('Negotiation is already closed. Start a new negotiation to make another offer.', 'warn');
    return null;
  }
  if (state.status === 'seller_accepted') {
    setHint(`Seller already accepted at $${fmt(state.latestOffer && state.latestOffer.amount)}. Close the deal or start a new negotiation.`, 'ok');
    return null;
  }
  if (fsm.isLocked(state)) {
    setHint('Already submitting. Wait for the seller to respond.', 'warn');
    return null;
  }
  const suggestionKey = buildAgentSuggestionKey({ forAuto });
  if (!forAuto && agentSuggestionCache && agentSuggestionCache.key === suggestionKey) {
    return applyAgentProposal(agentSuggestionCache.proposal, { forAuto, fromCache: true });
  }
  const delegation = readDelegation();
  const maxRate = delegation.max_rate;
  const current = Number(suggestedRate) || Number(load && load.rate) || readDraftAmount() || maxRate || 1850;
  const lastCarrier = latestCarrierAskAmount();
  const lastDispatcher = latestDispatcherOfferAmount();
  let proposal;
  if (lastCarrier) {
    if (maxRate && lastCarrier > maxRate) {
      proposal = Math.max(lastDispatcher || current, maxRate);
    } else {
      const floor = lastDispatcher || Math.min(current, maxRate || current);
      const gap = Math.max(0, lastCarrier - floor);
      proposal = floor + gap * between(forAuto ? 0.34 : 0.26, forAuto ? 0.5 : 0.42) + between(10, 35);
      if (gap <= 90) proposal = Math.min(lastCarrier, floor + Math.max(25, gap * 0.75));
    }
  } else if (maxRate) {
    proposal = Math.min(current || maxRate, maxRate * between(0.78, 0.86));
  } else {
    proposal = current * between(0.94, 1.01);
  }
  if (maxRate) proposal = Math.min(proposal, maxRate);
  if (lastDispatcher && proposal <= lastDispatcher) proposal = lastDispatcher + between(25, 80);
  if (maxRate) proposal = Math.min(proposal, maxRate);
  proposal = Math.max(1, Math.round(proposal));
  if (!forAuto) agentSuggestionCache = { key: suggestionKey, proposal };
  return applyAgentProposal(proposal, { forAuto });
}

function noteFeelsAggressive(note) {
  return /final|take it or leave|cheap|ridiculous|now|last offer|must/i.test(String(note || ''));
}

function setNegotiatorMood(profile, mood, comment) {
  profile.mood = mood;
  profile.lastComment = comment || profile.lastComment;
}

function buildCounterAmount(profile, amount, turnCount, opts = {}) {
  const lastCarrier = Number(opts.lastCarrierAmount) > 0 ? Number(opts.lastCarrierAmount) : null;
  const lastDispatcher = Number(opts.lastDispatcherAmount) > 0 ? Number(opts.lastDispatcherAmount) : null;
  const angry = opts.angry === true;
  const concession = Math.min(0.82, profile.concession * (turnCount + 1) + Math.random() * 0.16);
  const desired = profile.target - ((profile.target - profile.floor) * concession);
  const minimumGap = amount < profile.floor ? between(70, 170) : between(25, 85);
  if (lastCarrier && angry) {
    return Math.round(Math.max(amount + minimumGap, lastCarrier + between(35, 120)));
  }
  const bridge = amount + ((desired - amount) * between(0.36, 0.68));
  let counter = Math.max(profile.floor, bridge, amount + minimumGap);
  if (lastCarrier) {
    const buyerImproved = !lastDispatcher || amount >= lastDispatcher - 1;
    const concessionStep = buyerImproved ? between(35, 145) : between(0, 35);
    counter = Math.min(counter, lastCarrier - concessionStep);
    if (counter <= amount) counter = Math.min(lastCarrier, amount + Math.max(15, minimumGap * 0.5));
    if (counter > lastCarrier) counter = lastCarrier;
  }
  return Math.round(counter);
}

async function callCarrier({ amount, intent, note, signal }) {
  await delayWithAbort(getCarrierResponseDelay(intent), signal);
  syncSuggestedRateFromLane({ resetProfile: false });
  const profile = ensureNegotiatorProfile();
  if (intent === 'accept') {
    return {
      kind: 'accept',
      amount: state.latestOffer ? state.latestOffer.amount : amount,
      note: 'Confirmed. I will mark this closed on our side.'
    };
  }
  if (!profile) return { kind: 'counter', amount: Math.round(amount + 100), note: pick(REACTIONS.counter) };

  const history = state && Array.isArray(state.history) ? state.history : [];
  const turnCount = history.filter((entry) => entry.actor === 'dispatcher' && entry.type === 'offer').length;
  const lastCarrier = latestCarrierAskAmount();
  const lastDispatcher = latestDispatcherOfferAmount();
  const market = Number(suggestedRate) || Number(profile.target) || amount;
  const lowballSeverity = Math.max(0, (profile.floor - amount) / Math.max(1, market));
  const pressure = noteFeelsAggressive(note) ? 0.16 : 0;
  const backwardsMove = lastDispatcher && amount < lastDispatcher - 25;
  profile.friction = Math.min(1, Number(profile.friction || 0) + (lowballSeverity * (0.9 + profile.sensitivity)) + pressure + (backwardsMove ? 0.18 : 0) + (turnCount > 3 ? 0.08 : 0));

  const closeGap = lastCarrier ? lastCarrier - amount : Infinity;
  if (lastCarrier && closeGap <= Math.max(35, lastCarrier * 0.018) && amount >= profile.floor * 0.96) {
    const comment = buildSellerComment('accept', { profile, amount, near: true });
    setNegotiatorMood(profile, 'aligned', comment);
    return { kind: 'accept', amount, note: comment };
  }

  const walkAwayChance = Math.max(0, profile.friction - profile.patience) * (0.55 + profile.sensitivity);
  if (turnCount > 1 && Math.random() < walkAwayChance) {
    const comment = buildSellerComment('walkaway', { profile, amount });
    setNegotiatorMood(profile, 'done', comment);
    return { kind: 'walkaway', note: comment };
  }

  if (amount >= profile.quickClose) {
    const comment = buildSellerComment('accept', { profile, amount });
    setNegotiatorMood(profile, 'ready to close', comment);
    return { kind: 'accept', amount, note: comment };
  }

  const acceptable = amount >= profile.floor;
  const acceptChance = acceptable
    ? Math.min(0.72, 0.18 + ((amount - profile.floor) / Math.max(1, profile.target - profile.floor)) * 0.58 + (profile.stance === 'quick close' ? 0.18 : 0))
    : 0;
  if (acceptable && Math.random() < acceptChance) {
    const comment = buildSellerComment('accept', { profile, amount });
    setNegotiatorMood(profile, 'satisfied', comment);
    return { kind: 'accept', amount, note: comment };
  }

  if (amount < profile.floor * (0.9 + Math.random() * 0.05)) {
    const comment = buildSellerComment('reject', { profile, amount });
    setNegotiatorMood(profile, profile.friction > 0.6 ? 'irritated' : 'guarded', comment);
    return { kind: 'reject', note: comment };
  }

  const angerIncrease = !!lastCarrier && (backwardsMove || pressure > 0 || profile.friction > profile.patience + 0.28) && Math.random() < 0.48;
  const counterAmount = buildCounterAmount(profile, amount, turnCount, {
    lastCarrierAmount: lastCarrier,
    lastDispatcherAmount: lastDispatcher,
    angry: angerIncrease
  });
  const near = Number(counterAmount) - Number(amount) <= 100;
  const comment = buildSellerComment('counter', { profile, amount, counterAmount, angry: angerIncrease, near });
  setNegotiatorMood(profile, angerIncrease ? 'irritated' : (profile.friction > 0.55 ? 'strained' : 'engaged'), comment);
  return { kind: 'counter', amount: counterAmount, note: comment };
}

async function doSubmit(intent, opts = {}) {
  if (!state) return;
  // If the carrier rejected last round, auto-reopen so the dispatcher
  // can submit a fresh counter without ceremony.
  if (intent === 'offer' && state.status === 'rejected') {
    try { fsm.reopen(state); fsm.save(state); } catch {}
  }
  if (intent === 'offer' && state.status === 'seller_accepted') {
    setHint('Seller already accepted from their side. Close the deal or start a new negotiation.', 'ok');
    return;
  }
  if (fsm.isTerminal(state)) {
    setHint('Negotiation is already closed. Start a new negotiation to make another offer.', 'warn');
    announce('Negotiation is already closed.');
    return;
  }
  if (fsm.isLocked(state)) return;
  const now = Date.now();
  if (now - lastSubmitAt < THROTTLE_MS) {
    setHint('Wait a moment between submissions…', 'warn');
    return;
  }

  let amount;
  if (intent === 'accept') {
    amount = state.latestOffer ? state.latestOffer.amount : readDraftAmount();
    if (!Number.isFinite(amount) || amount <= 0) {
      setHint('Nothing to accept yet — submit an offer first.', 'warn');
      return;
    }
  } else {
    const draft = readDraftAmount();
    const v = fsm.validateOffer(draft);
    if (!v.ok) { setHint(v.error, 'warn'); return; }
    amount = v.value;
    const delegation = readDelegation();
    if (opts.agent === true && delegation.max_rate && amount > delegation.max_rate) {
      setHint(`Jarvis limit is $${fmt(delegation.max_rate)}. Raise the max rate or lower the offer.`, 'warn');
      return;
    }
    const target = $('field-target-rate');
    if (target) target.value = String(amount);
  }

  const lockId = `s${now}`;
  if (!fsm.beginSubmit(state, lockId, intent)) {
    setHint('Already submitting…', 'warn');
    return;
  }
  if (intent === 'offer') fsm.recordOffer(state, amount, readNote());
  fsm.save(state);
  carrierTyping = intent === 'offer' ? { lockId, startedAt: Date.now() } : null;
  if (carrierTyping) carrierTyping.message = buildThinkingMessage(intent);
  setHint('Submitting…', '');
  announce(intent === 'accept' ? 'Sending acceptance.' : `Sending offer of $${fmt(amount)}.`);
  renderState();

  const controller = new AbortController();
  inflight = { id: lockId, controller };
  let arrived = null;
  let outcome = null;
  let startNextAfterAccept = false;

  try {
    outcome = await callCarrier({ amount, intent, note: readNote(), signal: controller.signal });
    fsm.resolveSubmit(state, lockId, outcome);
    carrierTyping = null;
    const carrierEntry = intent === 'offer' ? latestCarrierHistoryEntry() : null;
    if (carrierEntry) pendingTypewriterHistoryId = historyEntryId(carrierEntry);
    fsm.save(state);
    lastSubmitAt = Date.now();
    setHint(
      outcome.kind === 'accept' && intent === 'offer' ? `Seller accepted at $${money(outcome.amount)}. Close the deal when ready.`
      : outcome.kind === 'accept' ? `Deal closed at $${money(outcome.amount)}.`
      : outcome.kind === 'counter' ? `Carrier countered at $${money(outcome.amount)}. ${outcome.note || ''}`
      : outcome.kind === 'walkaway' ? `Carrier closed negotiation. ${outcome.note || ''}`
      : `Carrier declined. ${outcome.note || ''}`,
      outcome.kind === 'accept' ? 'ok' : (outcome.kind === 'reject' ? 'warn' : '')
    );
    announce(
      outcome.kind === 'accept' && intent === 'offer' ? `Seller accepted at $${money(outcome.amount)}. Waiting for your close confirmation.`
      : outcome.kind === 'accept' ? `Deal closed at $${money(outcome.amount)}.`
      : outcome.kind === 'counter' ? `Carrier countered at $${money(outcome.amount)}.`
      : outcome.kind === 'walkaway' ? 'Carrier closed the negotiation.'
      : 'Carrier declined the offer.'
    );
    if (carrierEntry) arrived = { outcome, entry: carrierEntry };
    startNextAfterAccept = !!(opts.startNextOnAccept && intent === 'accept' && outcome && outcome.kind === 'accept');
  } catch (err) {
    if (err && err.message === 'aborted') return;
    carrierTyping = null;
    fsm.failSubmit(state, lockId, err && err.message || 'Network error');
    fsm.save(state);
    setHint('Submission failed — try again.', 'warn');
    announce('Submission failed.');
  } finally {
    if (inflight && inflight.id === lockId) inflight = null;
    if (carrierTyping && carrierTyping.lockId === lockId) carrierTyping = null;
    renderState();
    if (arrived) notifyNegotiatorResponseArrived(arrived.outcome, arrived.entry);
    if (opts.autoContinue) handleAutoNegotiationOutcome(outcome);
    if (startNextAfterAccept) {
      window.setTimeout(() => {
        if (state && fsm.isTerminal(state)) startNewNegotiation();
      }, 700);
    }
  }
}

function clearAutoNegotiation() {
  if (autoNegotiationTimer) clearTimeout(autoNegotiationTimer);
  autoNegotiationTimer = null;
  autoNegotiation = { active: false, maxRate: null, rounds: 0 };
}

function stopAutoNegotiation(message, kind) {
  clearAutoNegotiation();
  if (message) {
    setHint(message, kind || '');
    announce(message);
  }
}

function runAgentNegotiationTurn() {
  if (!state || fsm.isLocked(state)) return;
  if (state.status === 'seller_accepted') {
    stopAutoNegotiation(`Seller accepted at $${fmt(state.latestOffer && state.latestOffer.amount)}. Close the deal when you are ready.`, 'ok');
    return;
  }
  if (fsm.isTerminal(state)) {
    stopAutoNegotiation('Negotiation is already closed. Start a new negotiation to keep going.', 'warn');
    return;
  }
  const maxRate = readAgentMaxRate();
  if (!maxRate) {
    stopAutoNegotiation('Tell Jarvis your maximum rate first, then he can negotiate within it.', 'warn');
    return;
  }
  const carrierAsk = latestCarrierAskAmount();
  if (carrierAsk && carrierAsk > maxRate) {
    stopAutoNegotiation(`Seller is at $${fmt(carrierAsk)}, above your $${fmt(maxRate)} max. Raise the max or hold firm.`, 'warn');
    return;
  }
  if (autoNegotiation.rounds >= AUTO_NEGOTIATION_MAX_ROUNDS) {
    stopAutoNegotiation('Jarvis reached the round limit without a close. Review the last counter before continuing.', 'warn');
    return;
  }
  autoNegotiation.active = true;
  autoNegotiation.maxRate = maxRate;
  autoNegotiation.rounds += 1;
  const proposal = proposeAgentOffer({ forAuto: true });
  if (!proposal) {
    stopAutoNegotiation('Jarvis could not build the next offer yet.', 'warn');
    return;
  }
  if (proposal > maxRate) {
    stopAutoNegotiation(`Jarvis will not offer $${fmt(proposal)} because your max is $${fmt(maxRate)}.`, 'warn');
    return;
  }
  setHint(`Jarvis round ${autoNegotiation.rounds}: offering $${fmt(proposal)} within your $${fmt(maxRate)} max.`, 'ok');
  void doSubmit('offer', { agent: true, autoContinue: true });
}

function scheduleAutoNegotiationNext() {
  if (!autoNegotiation.active || autoNegotiationTimer) return;
  autoNegotiationTimer = setTimeout(() => {
    autoNegotiationTimer = null;
    runAgentNegotiationTurn();
  }, AUTO_NEGOTIATION_TURN_DELAY_MS);
}

function handleAutoNegotiationOutcome(outcome) {
  if (!autoNegotiation.active || !outcome) return;
  const maxRate = autoNegotiation.maxRate || readAgentMaxRate();
  if (outcome.kind === 'counter') {
    if (Number(outcome.amount) > Number(maxRate)) {
      stopAutoNegotiation(`Seller countered at $${fmt(outcome.amount)}, above your $${fmt(maxRate)} max. Should we raise the limit or hold?`, 'warn');
      return;
    }
    scheduleAutoNegotiationNext();
    return;
  }
  if (outcome.kind === 'accept') {
    stopAutoNegotiation(`Seller accepted at $${fmt(outcome.amount)}. Close the deal when you approve.`, 'ok');
    return;
  }
  if (outcome.kind === 'reject') {
    stopAutoNegotiation('Seller declined that number. Raise the max or try a different shipment.', 'warn');
    return;
  }
  if (outcome.kind === 'walkaway') {
    stopAutoNegotiation('Seller walked away. Try another negotiation when ready.', 'warn');
  }
}

function pickNextLoad(loads) {
  if (!Array.isArray(loads) || !loads.length) return null;
  if (!load) return loads.find((l) => l.status === 'pending') || loads[0];
  const idx = loads.findIndex((l) => l.id === load.id);
  for (let offset = 1; offset <= loads.length; offset += 1) {
    const candidate = loads[(idx + offset + loads.length) % loads.length];
    if (candidate && candidate.id !== load.id) return candidate;
  }
  return loads[0];
}

function hydrateLoadIntoForm() {
  if (!load) return;
  populateLaneSelects(listLoads());
  writeFieldValue('field-pickup', load.pickup);
  writeFieldValue('field-dropoff', load.dropoff);
  writeFieldValue('field-commodity', load.commodity);
  writeFieldValue('field-weight', load.weight || '');
  writeFieldValue('field-target-rate', state && state.latestOffer ? state.latestOffer.amount : '');
  writeFieldValue('field-note', '');
  const idEl = $('load-id-readout');
  if (idEl) idEl.textContent = load.id;
  const amt = $('rate-readout-amount');
  const target = $('field-target-rate');
  if (amt && target) amt.textContent = target.value ? `$${money(target.value)}` : '—';
  syncSuggestedRateFromLane({ resetProfile: true, render: true });
}

function resetNegotiationViewForLoad(nextLoad) {
  load = nextLoad;
  clearAutoNegotiation();
  clearAgentSuggestionCache();
  completedTypewriterHistoryIds.clear();
  carrierTyping = null;
  pendingTypewriterHistoryId = null;
  const pricing = getLanePricing(laneFromLoad(load));
  suggestedRate = pricing.suggested_rate;
  state = fsm.load(load.id) || fsm.makeInitial(load.id, suggestedRate);
  if (state.status === 'idle') fsm.beginDrafting(state);
  state.pricing = pricing;
  ensureNegotiatorProfile();
  hydrateLoadIntoForm();
}

export async function openLoadById(loadId, { source = 'agent' } = {}) {
  await initDataStore();
  const id = String(loadId || '').trim();
  if (!id) return { ok: false, error: 'openLoadById requires load_id.' };
  const nextLoad = getLoad(id);
  if (!nextLoad) return { ok: false, error: `No load ${id}.` };
  try { rememberSelectedLoad(nextLoad.id, `${nextLoad.pickup || ''} → ${nextLoad.dropoff || ''}`); } catch {}
  resetNegotiationViewForLoad(nextLoad);
  setHint(`Loaded ${nextLoad.id} for negotiation.`, 'ok');
  announce(`Loaded ${nextLoad.id} for negotiation.`);
  renderState();
  return {
    ok: true,
    source,
    load_id: nextLoad.id,
    lane: `${nextLoad.pickup || ''} → ${nextLoad.dropoff || ''}`,
    status: state && state.status,
    suggested_rate: suggestedRate
  };
}

function startNewNegotiation() {
  if (state && state.loadId) fsm.clear(state.loadId);
  clearAutoNegotiation();
  clearAgentSuggestionCache();
  completedTypewriterHistoryIds.clear();
  carrierTyping = null;
  pendingTypewriterHistoryId = null;
  load = pickNextLoad(listLoads()) || load;
  const pricing = getLanePricing(laneFromLoad(load));
  suggestedRate = pricing.suggested_rate;
  state = fsm.makeInitial(load && load.id, suggestedRate);
  state.pricing = pricing;
  fsm.beginDrafting(state);
  ensureNegotiatorProfile();
  fsm.save(state);
  hydrateLoadIntoForm();
  setHint('New negotiation started with a fresh seller read.', 'ok');
  announce('New negotiation ready.');
  renderState();
}

function handleAcceptOrTryAnother() {
  if (!state) return;
  if (fsm.isTerminal(state) || state.status === 'rejected') {
    startNewNegotiation();
    return;
  }
  void doSubmit('accept', { startNextOnAccept: true });
}

function pickLoad(loads) {
  try {
    const queryId = new URLSearchParams(location.search || '').get('load_id');
    if (queryId) {
      const found = loads.find((l) => String(l.id).toLowerCase() === String(queryId).toLowerCase());
      if (found) return found;
    }
  } catch {}
  const sel = getSelection();
  if (sel && sel.loadId) {
    const found = loads.find((l) => l.id === sel.loadId);
    if (found) return found;
  }
  return loads.find((l) => l.status === 'pending') || loads[0];
}

function refreshLoadFields() {
  if (!load) return;
  const fresh = getLoad(load.id);
  if (!fresh) return;
  load = fresh;
  populateLaneSelects(listLoads());
  const map = [
    ['field-pickup', load.pickup],
    ['field-dropoff', load.dropoff],
    ['field-commodity', load.commodity],
    ['field-weight', load.weight || '']
  ];
  map.forEach(([id, value]) => {
    const el = $(id);
    if (el) el.value = value == null ? '' : value;
  });
  syncSuggestedRateFromLane({ resetProfile: true, render: true });
}

export async function enter(root, { voiceAgent }) {
  agentRef = voiceAgent;
  if (typeof window !== 'undefined') {
    window.__negotiatePage = { openLoadById };
  }
  await initDataStore();
  load = pickLoad(listLoads());
  suggestedRate = getLanePricing(laneFromLoad(load)).suggested_rate;

  state = (load && fsm.load(load.id)) || fsm.makeInitial(load && load.id, suggestedRate);
  if (state.status === 'idle') fsm.beginDrafting(state);
  ensureNegotiatorProfile();

  populateLaneSelects(listLoads());
  hydrateLoadIntoForm();
  unsubStore = subscribe('load:updated', (detail) => {
    if (!load) return;
    if (!detail || detail.id == null || detail.id === load.id) refreshLoadFields();
  });

  const form = $('negotiate-form');
  if (form) {
    const onSubmit = (e) => { e.preventDefault(); doSubmit('offer'); };
    form.addEventListener('submit', onSubmit);
    unsubOffer = () => form.removeEventListener('submit', onSubmit);
  }

  const accept = $('btn-accept');
  if (accept) {
    const onAccept = () => handleAcceptOrTryAnother();
    accept.addEventListener('click', onAccept);
    unsubAccept = () => accept.removeEventListener('click', onAccept);
  }

  const counter = $('btn-counter');
  if (counter) {
    counter.addEventListener('click', () => {
      if (!state || fsm.isTerminal(state) || fsm.isLocked(state)) return;
      const n = readDraftAmount();
      if (!Number.isFinite(n) || n <= 0) { setHint('Enter a target rate first.', 'warn'); return; }
      void doSubmit('offer');
    });
  }

  const maxRate = $('field-agent-max-rate');
  if (maxRate) {
    const onMax = () => renderNegotiatorRead();
    maxRate.addEventListener('input', onMax);
    unsubDelegate = () => maxRate.removeEventListener('input', onMax);
  }
  const laneControls = ['field-pickup', 'field-dropoff', 'field-commodity', 'field-weight']
    .map((id) => $(id))
    .filter(Boolean);
  if (laneControls.length) {
    const onLaneInput = () => {
      clearAgentSuggestionCache();
      syncSuggestedRateFromLane({ resetProfile: true, render: true });
      renderState();
    };
    laneControls.forEach((el) => {
      el.addEventListener('input', onLaneInput);
      el.addEventListener('change', onLaneInput);
    });
    unsubLaneInputs = () => laneControls.forEach((el) => {
      el.removeEventListener('input', onLaneInput);
      el.removeEventListener('change', onLaneInput);
    });
  }
  const agentPropose = $('negotiate-agent-propose');
  if (agentPropose) {
    const onPropose = () => proposeAgentOffer();
    agentPropose.addEventListener('click', onPropose);
    unsubAgentPropose = () => agentPropose.removeEventListener('click', onPropose);
  }
  const agentRun = $('negotiate-agent-run');
  if (agentRun) {
    const onRun = () => {
      if (!readAgentMaxRate()) {
        setHint('Enter your maximum rate so Jarvis can negotiate without crossing it.', 'warn');
        return;
      }
      clearAutoNegotiation();
      autoNegotiation = { active: true, maxRate: readAgentMaxRate(), rounds: 0 };
      runAgentNegotiationTurn();
    };
    agentRun.addEventListener('click', onRun);
    unsubAgentRun = () => agentRun.removeEventListener('click', onRun);
  }
  const newNegotiation = $('btn-new-negotiation');
  if (newNegotiation) {
    const onNewNegotiation = () => startNewNegotiation();
    newNegotiation.addEventListener('click', onNewNegotiation);
    unsubNewNegotiation = () => newNegotiation.removeEventListener('click', onNewNegotiation);
  }
  updateDelegationUi();

  const target = $('field-target-rate');
  if (target) {
    const onInput = () => {
      const v = Number(target.value || 0);
      const amt = $('rate-readout-amount');
      if (amt) amt.textContent = isFinite(v) && v > 0 ? `$${money(v)}` : '—';
      // First keystroke after a reopen clears the transitional chip label.
      if (state && state._justReopened) { delete state._justReopened; renderState(); }
      if (target.value) {
        const v2 = fsm.validateOffer(target.value);
        setHint(v2.ok ? '' : v2.error, v2.ok ? '' : 'warn');
      } else {
        setHint('', '');
      }
    };
    target.addEventListener('input', onInput);
    unsubInput = () => target.removeEventListener('input', onInput);
  }

  const onKey = (e) => {
    if (e.key === 'Escape' && document.activeElement && document.activeElement.id === 'field-target-rate') {
      const t = $('field-target-rate'); if (t) { t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); }
    }
  };
  document.addEventListener('keydown', onKey);
  unsubKey = () => document.removeEventListener('keydown', onKey);

  if (voiceAgent && voiceAgent.toolRegistry) {
    voiceAgent.toolRegistry.registerDomain('submit_quote', (args) => {
      const context = getNegotiationContext();
      if (!state) {
        const err = new Error('No active negotiation is loaded. Navigate to the Rate Negotiation page and start a negotiation first.');
        err.code = 'NEGOTIATION_NOT_READY';
        err.recovery = { next_step: 'Start or load a negotiation before submitting a quote.' };
        throw err;
      }
      if (fsm.isTerminal(state)) {
        const err = new Error(`Negotiation is already closed with status "${state.status}". Do not submit another offer on this negotiation.`);
        err.code = 'NEGOTIATION_CLOSED';
        err.recovery = { next_step: 'Start a new negotiation before making another offer.' };
        setHint('Negotiation is already closed. Start a new negotiation to make another offer.', 'warn');
        throw err;
      }
      if (state.status === 'seller_accepted') {
        const err = new Error('Seller already accepted from their side. Ask the user before closing the deal; do not submit another offer.');
        err.code = 'SELLER_ALREADY_ACCEPTED';
        err.recovery = { next_step: 'Ask the user whether to close the accepted deal or start a new negotiation.' };
        setHint('Seller already accepted from their side. Close the deal or start a new negotiation.', 'ok');
        throw err;
      }
      if (fsm.isLocked(state)) {
        const err = new Error('A quote is already being submitted. Wait for the seller response before sending another offer.');
        err.code = 'NEGOTIATION_BUSY';
        err.recovery = { next_step: 'Wait for the current seller response.' };
        throw err;
      }
      const validation = fsm.validateOffer(args && args.target_rate);
      if (!validation.ok) {
        setHint(validation.error, 'warn');
        const err = new Error(validation.error);
        err.code = 'INVALID_QUOTE_AMOUNT';
        err.recovery = { rule: 'Send any positive dollar amount.' };
        throw err;
      }
      const draft = $('field-target-rate');
      if (draft) { draft.value = String(validation.value); draft.dispatchEvent(new Event('input', { bubbles: true })); }
      const note = $('field-note');
      if (note && args && typeof args.note === 'string') {
        note.value = args.note;
        note.dispatchEvent(new Event('input', { bubbles: true }));
      }
      void doSubmit('offer', { agent: true });
      return {
        ok: true,
        scheduled: true,
        target_rate: validation.value,
        suggested_rate: context.suggested_rate,
        pricing: context.pricing,
        negotiator: context.negotiator,
        agent_delegation: context.agent_delegation
      };
    });
    voiceAgent.toolRegistry.registerDomain('get_negotiation_context', () => getNegotiationContext());
    voiceAgent.toolRegistry.registerDomain('get_load', (args = {}) => {
      const requestedId = String(args.load_id || args.id || '').trim();
      const targetLoad = requestedId ? getLoad(requestedId) : (load ? getLoad(load.id) || load : null);
      if (!targetLoad) {
        return {
          ok: false,
          error: `No load ${requestedId || '(current)'}`,
          code: 'LOAD_NOT_FOUND',
          recovery: { next_step: 'Ask for a valid load ID or use open_load with a known load_id.' }
        };
      }
      return {
        ok: true,
        load: targetLoad,
        current_load_id: load && load.id,
        selected: !!(load && targetLoad.id === load.id),
        recovery: load && targetLoad.id !== load.id
          ? { next_step: `Use open_load({ load_id: "${targetLoad.id}", target_page: "negotiate" }) to make this the active negotiation load.` }
          : undefined
      };
    });
    voiceAgent.toolRegistry.registerDomain('assign_carrier', (args) => {
      try {
        const result = assignCarrierToLoad(args.load_id, args.carrier_id, { source: 'agent' });
        return { ok: true, load: result.load, carrier: result.carrier };
      } catch (err) {
        return { ok: false, error: err && err.message || String(err) };
      }
    });
    voiceAgent.toolRegistry.registerDomain('schedule_callback', () => ({ ok: false, error: 'schedule_callback is on the Contact page.' }));
  }

  renderState();
  announce('Negotiation ready.');

  import('./quick-chips.js').then((chips) => {
    chips.registerChips(voiceAgent, [
      { id: 'negotiate.submit', label: 'Submit offer', run: () => doSubmit('offer') },
      { id: 'negotiate.accept_try_another', label: 'Accept and try another', run: () => handleAcceptOrTryAnother() },
      { id: 'negotiate.agent.suggest', label: 'Jarvis suggest', run: () => proposeAgentOffer() }
    ]);
  }).catch(() => {});
}

export function exit() {
  if (inflight) { try { inflight.controller.abort(); } catch {} inflight = null; }
  if (agentReactionTimer) { clearTimeout(agentReactionTimer); agentReactionTimer = null; }
  clearAutoNegotiation();
  carrierTyping = null;
  pendingTypewriterHistoryId = null;
  [unsubAccept, unsubOffer, unsubInput, unsubKey, unsubDelegate, unsubAgentPropose, unsubAgentRun, unsubNewNegotiation, unsubLaneInputs].forEach((fn) => { try { fn && fn(); } catch {} });
  try { unsubStore && unsubStore(); } catch {}
  unsubAccept = unsubOffer = unsubInput = unsubKey = unsubDelegate = unsubAgentPropose = unsubAgentRun = unsubNewNegotiation = unsubLaneInputs = null;
  unsubStore = null;
  if (agentRef && agentRef.toolRegistry && typeof agentRef.toolRegistry.unregisterDomain === 'function') {
    ['submit_quote', 'get_negotiation_context', 'get_load', 'assign_carrier', 'schedule_callback'].forEach((n) => agentRef.toolRegistry.unregisterDomain(n));
  }
  if (typeof window !== 'undefined' && window.__negotiatePage && window.__negotiatePage.openLoadById === openLoadById) {
    delete window.__negotiatePage;
  }
  import('./quick-chips.js').then((chips) => chips.clearChips()).catch(() => {});
  state = null; load = null; agentRef = null;
}

export function getState() { return state ? { fsm: state } : null; }
export function setState(snap) {
  if (snap && snap.fsm && state && snap.fsm.loadId === state.loadId) {
    state = snap.fsm;
    renderState();
  }
}
