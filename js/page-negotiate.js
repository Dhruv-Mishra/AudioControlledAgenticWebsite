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
let inflight = null;    // { id, controller }
let unsubAccept = null;
let unsubOffer = null;
let unsubInput = null;
let unsubKey = null;
let unsubStore = null;

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

function renderHistory() {
  const el = $('negotiate-history');
  if (!el || !state) return;
  if (!state.history.length) {
    el.innerHTML = '<li class="negotiate-history-empty muted">No offers yet.</li>';
    return;
  }
  el.innerHTML = state.history.slice().reverse().map((h) => {
    const t = new Date(h.at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const who = h.actor === 'dispatcher' ? 'You' : (h.actor === 'carrier' ? 'Carrier' : 'System');
    const amt = h.amount ? `<span class="mono">$${fmt(Math.round(h.amount))}</span>` : '';
    const tag = h.type === 'accept' ? '<span class="chip chip--ok">Accepted</span>'
      : h.type === 'reject' ? '<span class="chip chip--danger">Rejected</span>'
      : h.type === 'counter' ? '<span class="chip chip--warn">Counter</span>'
      : h.type === 'error' ? '<span class="chip chip--danger">Error</span>'
      : '<span class="chip chip--info">Offer</span>';
    return `<li class="negotiate-history-item" data-kind="${escapeHtml(h.type)}">
      <span class="negotiate-history-meta"><span class="mono">${escapeHtml(t)}</span> &middot; ${escapeHtml(who)}</span>
      <span class="negotiate-history-body">${tag} ${amt} ${h.note ? '<span class="muted">— ' + escapeHtml(h.note) + '</span>' : ''}</span>
    </li>`;
  }).join('');
}

function renderState() {
  if (!state) return;
  const submit = $('negotiate-submit');
  const accept = $('btn-accept');
  const counter = $('btn-counter');
  const target = $('field-target-rate');
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

  const chip = document.querySelector('#negotiate-form .panel-header .chip');
  if (chip) {
    chip.className = 'chip ' + (
      state.status === 'accepted' ? 'chip--ok' :
      state.status === 'rejected' ? 'chip--danger' :
      state.status === 'countered' ? 'chip--warn' :
      'chip--info'
    );
    chip.textContent = state._justReopened
      ? 'Rejected — reopened'
      : state.status[0].toUpperCase() + state.status.slice(1);
  }

  if (rejected) {
    setHint('Carrier rejected — try a different price.', 'warn');
  } else if (terminal) {
    setHint(state.status === 'accepted'
      ? `Booked at $${fmt(Math.round(state.latestOffer && state.latestOffer.amount))}.`
      : `Negotiation ${state.status}.`, state.status === 'accepted' ? 'ok' : 'warn');
  }
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

async function callCarrier({ amount, intent, signal }) {
  const delay = 600 + Math.random() * 600;
  await new Promise((res, rej) => {
    const t = setTimeout(res, delay);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); }, { once: true });
  });
  if (intent === 'accept') {
    return { kind: 'accept', amount: state.latestOffer ? state.latestOffer.amount : amount };
  }
  const ratio = suggestedRate ? amount / suggestedRate : 1;
  if (ratio >= 1.05) return { kind: 'accept', amount };
  if (ratio <= 0.92) return { kind: 'reject', note: 'Below floor for this lane.' };
  return { kind: 'counter', amount: Math.round((amount + suggestedRate) / 2 / 25) * 25 };
}

async function doSubmit(intent) {
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
    const v = fsm.validateOffer(draft, suggestedRate);
    if (!v.ok) { setHint(v.error, 'warn'); return; }
    amount = v.value;
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
  setHint('Submitting…', '');
  announce(intent === 'accept' ? 'Sending acceptance.' : `Sending offer of $${fmt(amount)}.`);
  renderState();

  const controller = new AbortController();
  inflight = { id: lockId, controller };

  try {
    const outcome = await callCarrier({ amount, intent, signal: controller.signal });
    fsm.resolveSubmit(state, lockId, outcome);
    fsm.save(state);
    lastSubmitAt = Date.now();
    setHint(
      outcome.kind === 'accept' ? `Accepted at $${fmt(outcome.amount)}.`
      : outcome.kind === 'counter' ? `Carrier countered at $${fmt(outcome.amount)}.`
      : 'Carrier declined.',
      outcome.kind === 'accept' ? 'ok' : (outcome.kind === 'reject' ? 'warn' : '')
    );
    announce(
      outcome.kind === 'accept' ? `Carrier accepted at $${fmt(outcome.amount)}.`
      : outcome.kind === 'counter' ? `Carrier countered at $${fmt(outcome.amount)}.`
      : 'Carrier declined the offer.'
    );
  } catch (err) {
    if (err && err.message === 'aborted') return;
    fsm.failSubmit(state, lockId, err && err.message || 'Network error');
    fsm.save(state);
    setHint('Submission failed — try again.', 'warn');
    announce('Submission failed.');
  } finally {
    if (inflight && inflight.id === lockId) inflight = null;
    renderState();
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
  suggestedRate = Number(load && load.rate) || (load && load.miles ? Math.round(load.miles * 2.4 / 25) * 25 : 1850);

  state = (load && fsm.load(load.id)) || fsm.makeInitial(load && load.id, suggestedRate);
  if (state.status === 'idle') fsm.beginDrafting(state);

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
    if (amt && target) amt.textContent = target.value ? `$${fmt(Math.round(target.value))}` : '—';
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
      state.history.push({ actor: 'carrier', type: 'counter', amount: n + 125, note: 'Logged manually', at: new Date().toISOString() });
      state.latestOffer = { amount: n + 125, by: 'carrier' };
      fsm.save(state); renderState();
    });
  }

  const target = $('field-target-rate');
  if (target) {
    const onInput = () => {
      const v = Number(target.value || 0);
      const amt = $('rate-readout-amount');
      if (amt) amt.textContent = isFinite(v) && v > 0 ? `$${fmt(Math.round(v))}` : '—';
      // First keystroke after a reopen clears the transitional chip label.
      if (state && state._justReopened) { delete state._justReopened; renderState(); }
      if (target.value) {
        const v2 = fsm.validateOffer(target.value, suggestedRate);
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
      const draft = $('field-target-rate');
      if (draft) { draft.value = String(Math.round(Number(args.target_rate) || 0)); draft.dispatchEvent(new Event('input', { bubbles: true })); }
      doSubmit('offer');
      return { ok: true, scheduled: true, target_rate: Number(args.target_rate) || null };
    });
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
  [unsubAccept, unsubOffer, unsubInput, unsubKey].forEach((fn) => { try { fn && fn(); } catch {} });
  try { unsubStore && unsubStore(); } catch {}
  unsubAccept = unsubOffer = unsubInput = unsubKey = null;
  unsubStore = null;
  if (agentRef && agentRef.toolRegistry && typeof agentRef.toolRegistry.unregisterDomain === 'function') {
    ['submit_quote', 'get_load', 'assign_carrier', 'schedule_callback'].forEach((n) => agentRef.toolRegistry.unregisterDomain(n));
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
