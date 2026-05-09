// Production-grade negotiation finite state machine.
//
// States:
//   idle → drafting → submitting → countered → drafting (loop)
//                                 → accepted   (terminal)
//                                 → rejected   (terminal)
//                                 → expired    (terminal)
//
// Invariants:
//   - Only one in-flight submission at a time (lockedBy tracks it).
//   - Transitions are explicit; invalid throws.
//   - Persisted to sessionStorage keyed by loadId so refresh resumes.
//   - Pure logic; UI lives in page-negotiate.js.

const STORAGE_KEY = (loadId) => `negotiation:${loadId}`;
// Only `accepted` and `expired` are truly terminal. `rejected` is recoverable
// via `reopen()` so the dispatcher can craft a new counter-offer.
// (`expired` is currently unused but reserved for a future timeout path.)
const TERMINAL = new Set(['accepted', 'expired']);

const VALID = {
  idle:       new Set(['drafting']),
  drafting:   new Set(['submitting']),
  submitting: new Set(['countered', 'accepted', 'rejected', 'drafting' /* on failure */]),
  countered:  new Set(['drafting', 'submitting' /* immediate accept on counter */, 'accepted', 'rejected']),
  rejected:   new Set(['drafting'] /* via reopen() */)
};

export function makeInitial(loadId, suggestedRate) {
  return {
    loadId,
    suggestedRate: Number(suggestedRate) || null,
    status: 'idle',
    history: [],
    latestOffer: null,
    lockedBy: null,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}

export function load(loadId) {
  if (!loadId) return null;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY(loadId));
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || o.loadId !== loadId) return null;
    return o;
  } catch { return null; }
}

export function save(state) {
  if (!state || !state.loadId) return;
  try { sessionStorage.setItem(STORAGE_KEY(state.loadId), JSON.stringify(state)); } catch {}
}

export function clear(loadId) {
  try { sessionStorage.removeItem(STORAGE_KEY(loadId)); } catch {}
}

function transition(state, next) {
  if (TERMINAL.has(state.status)) {
    throw new Error(`Negotiation is ${state.status}; no further transitions.`);
  }
  const allowed = VALID[state.status];
  if (!allowed || !allowed.has(next)) {
    throw new Error(`Invalid transition ${state.status} → ${next}.`);
  }
  state.status = next;
  state.updatedAt = Date.now();
}

function appendHistory(state, entry) {
  state.history.push({ ...entry, at: new Date().toISOString() });
  if (state.history.length > 40) state.history.splice(0, state.history.length - 40);
}

/** Begin drafting. Idempotent. */
export function beginDrafting(state) {
  if (state.status === 'idle') transition(state, 'drafting');
  return state;
}

/** Reopen a rejected negotiation so the dispatcher can craft a new counter. */
export function reopen(state) {
  if (state.status !== 'rejected') {
    throw new Error(`reopen() requires status "rejected", got "${state.status}".`);
  }
  transition(state, 'drafting');
  appendHistory(state, { actor: 'system', type: 'reopen', note: 'Reopened after rejection.' });
  state._justReopened = true;
  return state;
}

/** Validate an offer. Returns { ok, error?, value? }. */
export function validateOffer(amount, suggested, opts = {}) {
  const { tolerance = 0.25, step = 25 } = opts;
  const n = Number(amount);
  if (!Number.isFinite(n)) return { ok: false, error: 'Enter a number.' };
  if (n <= 0) return { ok: false, error: 'Offer must be greater than zero.' };
  if (suggested && Number.isFinite(suggested)) {
    const lo = suggested * (1 - tolerance);
    const hi = suggested * (1 + tolerance);
    if (n < lo || n > hi) {
      return {
        ok: false,
        error: `Offer must be within ±${Math.round(tolerance * 100)}% of suggested ($${Math.round(lo)}–$${Math.round(hi)}).`
      };
    }
  }
  const rounded = Math.round(n / step) * step;
  return { ok: true, value: rounded };
}

/** Mark a submission as in-flight. Returns false if locked. */
export function beginSubmit(state, lockId, intent) {
  if (state.lockedBy) return false;
  if (state.status !== 'drafting' && state.status !== 'countered') {
    if (state.status === 'idle') transition(state, 'drafting');
    else throw new Error(`Cannot submit from ${state.status}.`);
  }
  state.lockedBy = lockId;
  state.intent = intent || 'offer';
  transition(state, 'submitting');
  return true;
}

/** Resolve the in-flight submission with an outcome from the (simulated) carrier. */
export function resolveSubmit(state, lockId, outcome) {
  if (state.lockedBy !== lockId) return; // stale resolve
  state.lockedBy = null;
  const { kind, amount, note } = outcome || {};
  if (kind === 'accept') {
    appendHistory(state, { actor: state.intent === 'accept' ? 'dispatcher' : 'carrier', type: 'accept', amount, note });
    state.latestOffer = { amount, by: 'agreed' };
    transition(state, 'accepted');
  } else if (kind === 'counter') {
    appendHistory(state, { actor: 'carrier', type: 'counter', amount, note });
    state.latestOffer = { amount, by: 'carrier' };
    transition(state, 'countered');
  } else if (kind === 'reject') {
    appendHistory(state, { actor: 'carrier', type: 'reject', note });
    transition(state, 'rejected');
  } else {
    transition(state, 'drafting');
  }
}

/** Submission failed (network etc). Roll back to drafting. */
export function failSubmit(state, lockId, error) {
  if (state.lockedBy !== lockId) return;
  state.lockedBy = null;
  appendHistory(state, { actor: 'system', type: 'error', note: String(error || 'Submission failed.') });
  transition(state, 'drafting');
}

/** Record a dispatcher offer added to history (called right before resolveSubmit). */
export function recordOffer(state, amount, note) {
  appendHistory(state, { actor: 'dispatcher', type: 'offer', amount: Number(amount), note });
  state.latestOffer = { amount: Number(amount), by: 'dispatcher' };
}

export function isTerminal(state) {
  return TERMINAL.has(state && state.status);
}

export function isLocked(state) {
  return !!(state && state.lockedBy);
}
