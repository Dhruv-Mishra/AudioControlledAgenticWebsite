// Pending Action Queue — defers visually-disruptive tool actions (page
// navigation, modal toggles, palette opens, map focus changes) until the
// model's current speech turn has FULLY completed (audio drained), so a
// page swap doesn't slice the agent mid-sentence.
//
// Why a queue and not Apache Kafka?
//   We live entirely in one browser tab, in one event loop, with one
//   producer (the Gemini Live tool dispatcher) and one consumer (the
//   page after speech ends). Kafka is a multi-broker, multi-partition
//   distributed commit log designed to survive node failures and
//   reorder concurrent producers across a network. Here:
//     • zero network hops, zero serialization, zero broker process
//     • strict insertion-order is free (Array.push / shift)
//     • the "topic" is "pending" — one of them, with at most ~3 entries
//     • turn-complete is a single in-process CustomEvent
//   A 60-line Set + two listeners gives perfect ordering, sub-ms latency,
//   and adds nothing to the bundle. Kafka would add a network broker,
//   complex auth, and the wrong consistency model (durable replay) for
//   what is a transient UI gating problem.
//
// Contract:
//   • enqueue(action, {label, reason}) — schedule a thunk to run after
//     speech completes. Returns the action's queued descriptor.
//   • drain(reason) — starts executing every pending action in FIFO
//     order, swallowing per-action errors so one bad thunk can't break
//     the chain. Returns the count that was pending when drain began.
//   • drainAsync(reason) — same drain, but resolves after async actions
//     have finished.
//   • clear(reason) — drop everything (used on call teardown).
//   • size — how many actions are waiting.
//   • addEventListener('drained', cb) — fired after each drain pass.
//
// Gating policy (decided by the caller, typically VoiceAgent):
//   The queue itself does NOT subscribe to turn_complete /
//   agent-playback-drained — that wiring lives in voice-agent.js so it
//   can compose with the existing dual-gate logic used by end-call.

const DEFAULT_LABEL = 'pending-action';

export class PendingActionQueue extends EventTarget {
  constructor({ logger } = {}) {
    super();
    this._queue = [];
    this._draining = false;
    this._log = typeof logger === 'function' ? logger : () => {};
  }

  get size() { return this._queue.length; }
  get isEmpty() { return this._queue.length === 0; }

  /** Schedule a thunk. `action` MUST be a function. The optional
   *  `dedupeKey` lets callers collapse duplicate enqueues — if a key is
   *  provided and a queued entry already shares it, the new action
   *  REPLACES the old one (last-write-wins). This stops a fast double
   *  navigate('/map.html') from firing twice. */
  enqueue(action, { label = DEFAULT_LABEL, reason = '', dedupeKey = null } = {}) {
    if (typeof action !== 'function') {
      throw new TypeError('PendingActionQueue.enqueue requires a function');
    }
    const entry = { action, label, reason, dedupeKey, enqueuedAt: Date.now() };
    if (dedupeKey) {
      const existingIdx = this._queue.findIndex((e) => e.dedupeKey === dedupeKey);
      if (existingIdx !== -1) {
        this._queue[existingIdx] = entry;
        this._log('replaced ' + label + ' (dedupe=' + dedupeKey + ')');
        return entry;
      }
    }
    this._queue.push(entry);
    this._log('enqueued ' + label + ' (size=' + this._queue.length + ' reason=' + reason + ')');
    return entry;
  }

  /** Execute every pending action in FIFO order. Per-action errors are
   *  caught and logged; the chain continues. Re-entrant calls during a
   *  drain are no-ops (reentrancy guard). */
  drain(reason = 'drain') {
    if (this._draining) {
      this._log('drain reentry ignored (reason=' + reason + ')');
      return 0;
    }
    const pending = this._queue.length;
    if (pending === 0) return 0;
    this.drainAsync(reason).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[pending-queue] drain failed', err && err.message);
    });
    return pending;
  }

  /** Awaitable drain for queued async effects such as UI tool calls and
   *  short transition sounds. */
  async drainAsync(reason = 'drain') {
    if (this._draining) {
      this._log('drain reentry ignored (reason=' + reason + ')');
      return 0;
    }
    if (this._queue.length === 0) return 0;
    this._draining = true;
    const ran = [];
    try {
      while (this._queue.length > 0) {
        const entry = this._queue.shift();
        const waitedMs = Date.now() - entry.enqueuedAt;
        try {
          this._log('drain ' + entry.label + ' (waited=' + waitedMs + 'ms reason=' + reason + ')');
          const result = entry.action();
          if (result && typeof result.then === 'function') await result;
          ran.push(entry.label);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[pending-queue] action threw: ' + entry.label, err && err.message);
        }
      }
    } finally {
      this._draining = false;
    }
    try {
      this.dispatchEvent(new CustomEvent('drained', { detail: { reason, ran } }));
    } catch {}
    return ran.length;
  }

  /** Drop everything without running. Used on call teardown so a
   *  queued navigate doesn't fire after the user has hung up. */
  clear(reason = 'clear') {
    if (this._queue.length === 0) return 0;
    const dropped = this._queue.length;
    this._log('cleared (count=' + dropped + ' reason=' + reason + ')');
    this._queue = [];
    return dropped;
  }
}
