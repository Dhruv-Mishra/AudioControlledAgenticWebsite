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
import { getSelection } from './page-state.js';
import { assignCarrierToLoad, getLoad, initDataStore, listLoads, subscribe } from './data-store.js';

let agentRef = null;
let state = null;       // FSM state object
let load = null;        // selected load
let suggestedRate = 0;
let lastSubmitAt = 0;
const THROTTLE_MS = 1500;
const CARRIER_RESPONSE_DELAY_MS = 1800;
const AGENT_REACTION_DELAY_MS = 1500;
const TYPEWRITER_STEP_MS = 18;
let inflight = null;    // { id, controller }
let carrierTyping = null;
let pendingTypewriterHistoryId = null;
let agentReactionTimer = null;
const completedTypewriterHistoryIds = new Set();
let unsubAccept = null;
let unsubOffer = null;
let unsubInput = null;
let unsubKey = null;
let unsubStore = null;
let unsubDelegate = null;
let unsubAgentPropose = null;
let unsubAgentRun = null;

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
  }
];

const REACTIONS = {
  accept: [
    'That works if we can lock it now.',
    'I can get my driver moving on that number.',
    'Good enough for this lane. Let us book it.'
  ],
  counter: [
    'I am close, but I need a little more to protect the truck.',
    'We are not far apart. Meet me here and I can keep this moving.',
    'That is moving in the right direction, but I still have risk on the lane.',
    'I can sharpen it once more, but I need a serious next move.'
  ],
  reject: [
    'That is too thin for the miles and timing.',
    'I cannot take that back to the driver with a straight face.',
    'We are below where this truck needs to be.',
    'That number tells me we may be solving different problems.'
  ],
  walkaway: [
    'I am going to pass before this burns more time.',
    'We are too far apart, so I am closing this out.',
    'I have another load that fits better. I am stepping away.',
    'The haggling is not worth holding the truck. We are done here.'
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

function createNegotiatorProfile() {
  const base = pick(NEGOTIATOR_TYPES);
  const market = Math.max(500, Number(suggestedRate) || Number(load && load.rate) || 1850);
  const floor = Math.round(market * between(base.floorRange[0], base.floorRange[1]));
  const target = Math.max(floor + 40, Math.round(market * between(base.targetRange[0], base.targetRange[1])));
  const quickClose = Math.max(floor, Math.round(market * between(base.quickRange[0], base.quickRange[1])));
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

function readDelegation() {
  const enabled = !!($('field-agent-delegate') && $('field-agent-delegate').checked);
  const maxEl = $('field-agent-max-rate');
  const maxRate = maxEl && Number(maxEl.value) > 0 ? Number(maxEl.value) : null;
  return {
    enabled,
    max_rate: maxRate,
    can_submit_without_each_turn: enabled,
    instruction: enabled
      ? 'Jarvis may propose and submit offers within the user max rate.'
      : 'Jarvis should confirm before submitting offers.'
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
  const currentSuggestedRate = getSuggestedRate();
  const history = state && Array.isArray(state.history) ? state.history : [];
  return {
    load_id: (state && state.loadId) || (load && load.id) || null,
    suggested_rate: currentSuggestedRate,
    quote_rules: 'Any positive dollar amount is valid. There is no multiple-of-25 rule and no fixed percent band.',
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
  if (outcome.kind === 'accept') return `Carrier accepted at $${money(outcome.amount)}.`;
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
    agentRef.sendAppEvent('negotiator_response_arrived', detail);
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
  const pending = carrierTyping ? `<li class="negotiate-history-item negotiate-history-item--pending" data-kind="pending" aria-live="polite" aria-busy="true">
      <span class="negotiate-history-meta"><span class="mono">now</span> &middot; Carrier</span>
      <span class="negotiate-history-body"><span class="chip chip--info">Reviewing</span> <span class="typing-line"><span class="typing-text">Negotiator is reviewing your offer</span><span class="typing-dots" aria-hidden="true"><span></span><span></span><span></span></span></span></span>
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
  const submitting = state.status === 'submitting';
  const terminal = fsm.isTerminal(state);
  const rejected = state.status === 'rejected';
  // Rejected is RECOVERABLE — inputs stay live so the user can craft a
  // new counter. Only `accepted` (and the unused `expired`) hard-lock.
  const lockInputs = submitting || (terminal && !rejected);

  if (submit) {
    submit.disabled = lockInputs;
    submit.textContent = submitting && state.intent === 'offer' ? 'Submitting…'
      : terminal && !rejected ? 'Closed'
      : rejected ? 'Send new counter'
      : 'Submit offer';
  }
  if (accept) {
    // Can't accept a rejection — there's no live offer on the table.
    accept.disabled = lockInputs || rejected;
    if (state.status === 'accepted') {
      accept.classList.add('btn--locked');
      accept.textContent = 'Accepted ✓';
    } else if (submitting && state.intent === 'accept') {
      accept.textContent = 'Accepting…';
    } else {
      accept.classList.remove('btn--locked');
      accept.textContent = 'Accept';
    }
  }
  if (counter) counter.disabled = lockInputs;
  if (target) target.disabled = lockInputs;
  if (agentRun) agentRun.disabled = lockInputs;
  if (agentPropose) agentPropose.disabled = lockInputs;

  const chip = document.querySelector('#negotiate-form .panel-header .chip');
  if (chip) {
    chip.className = 'chip ' + (
      state.status === 'accepted' ? 'chip--ok' :
      state.status === 'walked_away' ? 'chip--danger' :
      state.status === 'rejected' ? 'chip--danger' :
      state.status === 'countered' ? 'chip--warn' :
      'chip--info'
    );
    const label = state.status === 'walked_away'
      ? 'Walked away'
      : state.status[0].toUpperCase() + state.status.slice(1);
    chip.textContent = state._justReopened
      ? 'Rejected — reopened'
      : label;
  }

  if (rejected) {
    setHint('Carrier rejected — try a different price.', 'warn');
  } else if (terminal) {
    setHint(state.status === 'accepted'
      ? `Booked at $${fmt(Math.round(state.latestOffer && state.latestOffer.amount))}.`
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
  const enabled = !!($('field-agent-delegate') && $('field-agent-delegate').checked);
  const max = $('field-agent-max-rate');
  if (max) max.disabled = !enabled;
  renderNegotiatorRead();
}

function proposeAgentOffer() {
  if (!state) return null;
  const profile = ensureNegotiatorProfile();
  const delegation = readDelegation();
  const current = readDraftAmount() || Number(suggestedRate) || Number(load && load.rate) || 1850;
  const lastCarrier = state.latestOffer && state.latestOffer.by === 'carrier' ? Number(state.latestOffer.amount) : null;
  let proposal;
  if (lastCarrier) {
    proposal = Math.max(current + between(20, 90), lastCarrier - between(45, 160));
  } else if (profile) {
    proposal = current * between(0.98, 1.05) + (profile.target - current) * between(0.18, 0.34);
  } else {
    proposal = current + between(75, 175);
  }
  if (delegation.max_rate) proposal = Math.min(proposal, delegation.max_rate);
  proposal = Math.max(1, Math.round(proposal));
  const target = $('field-target-rate');
  const note = $('field-note');
  if (target) {
    target.value = String(proposal);
    target.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (note && !note.value.trim()) {
    note.value = 'Jarvis is testing a firm but closeable number.';
    note.dispatchEvent(new Event('input', { bubbles: true }));
  }
  setHint(`Jarvis proposed $${fmt(proposal)} based on the negotiator read.`, 'ok');
  return proposal;
}

function noteFeelsAggressive(note) {
  return /final|take it or leave|cheap|ridiculous|now|last offer|must/i.test(String(note || ''));
}

function setNegotiatorMood(profile, mood, comment) {
  profile.mood = mood;
  profile.lastComment = comment || profile.lastComment;
}

function buildCounterAmount(profile, amount, turnCount) {
  const concession = Math.min(0.82, profile.concession * (turnCount + 1) + Math.random() * 0.16);
  const desired = profile.target - ((profile.target - profile.floor) * concession);
  const bridge = amount + ((desired - amount) * between(0.45, 0.78));
  const counter = Math.max(profile.floor, bridge, amount + between(35, 140));
  return Math.round(counter);
}

async function callCarrier({ amount, intent, note, signal }) {
  await delayWithAbort(CARRIER_RESPONSE_DELAY_MS, signal);
  const profile = ensureNegotiatorProfile();
  if (intent === 'accept') {
    return { kind: 'accept', amount: state.latestOffer ? state.latestOffer.amount : amount };
  }
  if (!profile) return { kind: 'counter', amount: Math.round(amount + 100), note: pick(REACTIONS.counter) };

  const history = state && Array.isArray(state.history) ? state.history : [];
  const turnCount = history.filter((entry) => entry.actor === 'dispatcher' && entry.type === 'offer').length;
  const market = Number(suggestedRate) || Number(profile.target) || amount;
  const lowballSeverity = Math.max(0, (profile.floor - amount) / Math.max(1, market));
  const pressure = noteFeelsAggressive(note) ? 0.16 : 0;
  profile.friction = Math.min(1, Number(profile.friction || 0) + (lowballSeverity * (0.9 + profile.sensitivity)) + pressure + (turnCount > 3 ? 0.08 : 0));

  const walkAwayChance = Math.max(0, profile.friction - profile.patience) * (0.55 + profile.sensitivity);
  if (turnCount > 1 && Math.random() < walkAwayChance) {
    const comment = pick(REACTIONS.walkaway);
    setNegotiatorMood(profile, 'done', comment);
    return { kind: 'walkaway', note: comment };
  }

  if (amount >= profile.quickClose) {
    const comment = pick(REACTIONS.accept);
    setNegotiatorMood(profile, 'ready to close', comment);
    return { kind: 'accept', amount, note: comment };
  }

  const acceptable = amount >= profile.floor;
  const acceptChance = acceptable
    ? Math.min(0.72, 0.18 + ((amount - profile.floor) / Math.max(1, profile.target - profile.floor)) * 0.58 + (profile.stance === 'quick close' ? 0.18 : 0))
    : 0;
  if (acceptable && Math.random() < acceptChance) {
    const comment = pick(REACTIONS.accept);
    setNegotiatorMood(profile, 'satisfied', comment);
    return { kind: 'accept', amount, note: comment };
  }

  if (amount < profile.floor * (0.9 + Math.random() * 0.05)) {
    const comment = pick(REACTIONS.reject);
    setNegotiatorMood(profile, profile.friction > 0.6 ? 'irritated' : 'guarded', comment);
    return { kind: 'reject', note: comment };
  }

  const counterAmount = buildCounterAmount(profile, amount, turnCount);
  const comment = pick(REACTIONS.counter);
  setNegotiatorMood(profile, profile.friction > 0.55 ? 'strained' : 'engaged', comment);
  return { kind: 'counter', amount: counterAmount, note: comment };
}

async function doSubmit(intent, opts = {}) {
  if (!state) return;
  // If the carrier rejected last round, auto-reopen so the dispatcher
  // can submit a fresh counter without ceremony.
  if (intent === 'offer' && state.status === 'rejected') {
    try { fsm.reopen(state); fsm.save(state); } catch {}
  }
  if (fsm.isTerminal(state) || fsm.isLocked(state)) return;
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
  setHint('Submitting…', '');
  announce(intent === 'accept' ? 'Sending acceptance.' : `Sending offer of $${fmt(amount)}.`);
  renderState();

  const controller = new AbortController();
  inflight = { id: lockId, controller };
  let arrived = null;

  try {
    const outcome = await callCarrier({ amount, intent, note: readNote(), signal: controller.signal });
    fsm.resolveSubmit(state, lockId, outcome);
    carrierTyping = null;
    const carrierEntry = intent === 'offer' ? latestCarrierHistoryEntry() : null;
    if (carrierEntry) pendingTypewriterHistoryId = historyEntryId(carrierEntry);
    fsm.save(state);
    lastSubmitAt = Date.now();
    setHint(
      outcome.kind === 'accept' ? `Accepted at $${money(outcome.amount)}.`
      : outcome.kind === 'counter' ? `Carrier countered at $${money(outcome.amount)}. ${outcome.note || ''}`
      : outcome.kind === 'walkaway' ? `Carrier closed negotiation. ${outcome.note || ''}`
      : `Carrier declined. ${outcome.note || ''}`,
      outcome.kind === 'accept' ? 'ok' : (outcome.kind === 'reject' ? 'warn' : '')
    );
    announce(
      outcome.kind === 'accept' ? `Carrier accepted at $${money(outcome.amount)}.`
      : outcome.kind === 'counter' ? `Carrier countered at $${money(outcome.amount)}.`
      : outcome.kind === 'walkaway' ? 'Carrier closed the negotiation.'
      : 'Carrier declined the offer.'
    );
    if (carrierEntry) arrived = { outcome, entry: carrierEntry };
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
  }
}

function pickLoad(loads) {
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
}

export async function enter(root, { voiceAgent }) {
  agentRef = voiceAgent;
  await initDataStore();
  load = pickLoad(listLoads());
  suggestedRate = Number(load && load.rate) || (load && load.miles ? Math.round(load.miles * 2.4) : 1850);

  state = (load && fsm.load(load.id)) || fsm.makeInitial(load && load.id, suggestedRate);
  if (state.status === 'idle') fsm.beginDrafting(state);
  ensureNegotiatorProfile();

  if (load) {
    const map = [
      ['field-pickup', load.pickup],
      ['field-dropoff', load.dropoff],
      ['field-commodity', load.commodity],
      ['field-weight', load.weight || ''],
      ['field-target-rate', state.latestOffer ? state.latestOffer.amount : ((state.history[0] && state.history[0].amount) || '')]
    ];
    map.forEach(([id, v]) => { const el = $(id); if (el) el.value = v == null ? '' : v; });
    const idEl = $('load-id-readout');
    if (idEl) idEl.textContent = load.id;
    const amt = $('rate-readout-amount');
    const target = $('field-target-rate');
    if (amt && target) amt.textContent = target.value ? `$${money(target.value)}` : '—';
    const sug = $('negotiate-suggested');
    if (sug) sug.textContent = `$${fmt(suggestedRate)}`;
  }
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
    const onAccept = () => doSubmit('accept');
    accept.addEventListener('click', onAccept);
    unsubAccept = () => accept.removeEventListener('click', onAccept);
  }

  const counter = $('btn-counter');
  if (counter) {
    counter.addEventListener('click', () => {
      if (!state || fsm.isTerminal(state) || fsm.isLocked(state)) return;
      const n = readDraftAmount();
      if (!Number.isFinite(n) || n <= 0) { setHint('Enter a target rate first.', 'warn'); return; }
      const profile = ensureNegotiatorProfile();
      const turnCount = state.history.filter((entry) => entry.actor === 'dispatcher' && entry.type === 'offer').length;
      const counterAmount = profile ? buildCounterAmount(profile, n, turnCount) : Math.round(n + 100);
      const comment = pick(REACTIONS.counter);
      if (profile) setNegotiatorMood(profile, 'engaged', comment);
      state.history.push({ actor: 'carrier', type: 'counter', amount: counterAmount, note: comment, at: new Date().toISOString() });
      state.latestOffer = { amount: counterAmount, by: 'carrier' };
      const entry = latestCarrierHistoryEntry();
      if (entry) pendingTypewriterHistoryId = historyEntryId(entry);
      fsm.save(state); renderState();
      if (entry) notifyNegotiatorResponseArrived({ kind: 'counter', amount: counterAmount, note: comment }, entry);
    });
  }

  const delegate = $('field-agent-delegate');
  const maxRate = $('field-agent-max-rate');
  if (delegate) {
    const onDelegate = () => updateDelegationUi();
    delegate.addEventListener('change', onDelegate);
    unsubDelegate = () => delegate.removeEventListener('change', onDelegate);
  }
  if (maxRate) {
    const onMax = () => renderNegotiatorRead();
    maxRate.addEventListener('input', onMax);
    unsubDelegate = unsubDelegate
      ? (() => { const prev = unsubDelegate; return () => { prev(); maxRate.removeEventListener('input', onMax); }; })()
      : () => maxRate.removeEventListener('input', onMax);
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
      const delegation = readDelegation();
      if (!delegation.enabled) {
        setHint('Turn on Jarvis authority before letting the agent submit.', 'warn');
        return;
      }
      if (!readDraftAmount()) proposeAgentOffer();
      void doSubmit('offer', { agent: true });
    };
    agentRun.addEventListener('click', onRun);
    unsubAgentRun = () => agentRun.removeEventListener('click', onRun);
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
        negotiator: context.negotiator,
        agent_delegation: context.agent_delegation
      };
    });
    voiceAgent.toolRegistry.registerDomain('get_negotiation_context', () => getNegotiationContext());
    voiceAgent.toolRegistry.registerDomain('get_load', () => ({ ok: true, load: load ? getLoad(load.id) || load : null }));
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
      { id: 'negotiate.counter_100', label: 'Bump +$100', run: () => {
        const el = $('field-target-rate'); if (!el) return;
        const curr = Number(el.value || 0) || (suggestedRate || 0);
        el.value = String(Math.round(curr + 100));
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }},
      { id: 'negotiate.accept', label: 'Accept', run: () => doSubmit('accept') },
      { id: 'negotiate.submit', label: 'Submit offer', run: () => doSubmit('offer') }
    ]);
  }).catch(() => {});
}

export function exit() {
  if (inflight) { try { inflight.controller.abort(); } catch {} inflight = null; }
  if (agentReactionTimer) { clearTimeout(agentReactionTimer); agentReactionTimer = null; }
  carrierTyping = null;
  pendingTypewriterHistoryId = null;
  [unsubAccept, unsubOffer, unsubInput, unsubKey, unsubDelegate, unsubAgentPropose, unsubAgentRun].forEach((fn) => { try { fn && fn(); } catch {} });
  try { unsubStore && unsubStore(); } catch {}
  unsubAccept = unsubOffer = unsubInput = unsubKey = unsubDelegate = unsubAgentPropose = unsubAgentRun = null;
  unsubStore = null;
  if (agentRef && agentRef.toolRegistry && typeof agentRef.toolRegistry.unregisterDomain === 'function') {
    ['submit_quote', 'get_negotiation_context', 'get_load', 'assign_carrier', 'schedule_callback'].forEach((n) => agentRef.toolRegistry.unregisterDomain(n));
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
