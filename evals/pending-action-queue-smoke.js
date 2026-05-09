// pending-action-queue smoke. Behavioural — no DOM.
//
// What we assert:
//   1. enqueue() does not run the action immediately.
//   2. drain() runs queued actions in FIFO order.
//   3. drain() is reentry-safe and idempotent against an empty queue.
//   4. Per-action errors are caught; the chain continues.
//   5. dedupeKey replaces the existing entry rather than appending.
//   6. clear() drops everything without running.
//   7. The 'drained' CustomEvent fires after a drain pass and lists
//      every action label that ran.
//
// How it runs in Node: dynamic-imports the ESM module; provides a
// minimal CustomEvent shim if one isn't already on globalThis.

'use strict';

const path = require('path');
const { pathToFileURL } = require('url');

// CustomEvent shim for old Node versions (>=19 has it natively).
if (typeof globalThis.CustomEvent !== 'function') {
  globalThis.CustomEvent = class CustomEvent extends Event {
    constructor(type, init = {}) { super(type, init); this.detail = init.detail; }
  };
}

(async () => {
  const url = pathToFileURL(path.resolve(__dirname, '..', 'js', 'pending-action-queue.js')).href;
  const { PendingActionQueue } = await import(url);

  const fail = (msg) => { console.error('FAIL: ' + msg); process.exit(1); };
  const ok = (msg) => console.log('ok - ' + msg);

  // 1. enqueue is deferred.
  {
    const q = new PendingActionQueue();
    let ran = false;
    q.enqueue(() => { ran = true; }, { label: 'a' });
    if (ran) fail('enqueue ran action immediately');
    if (q.size !== 1) fail('size should be 1, was ' + q.size);
    ok('enqueue defers');
  }

  // 2. drain FIFO.
  {
    const q = new PendingActionQueue();
    const order = [];
    q.enqueue(() => order.push('a'), { label: 'a' });
    q.enqueue(() => order.push('b'), { label: 'b' });
    q.enqueue(() => order.push('c'), { label: 'c' });
    const ran = q.drain('test');
    if (ran !== 3) fail('drain count ' + ran + ' != 3');
    if (order.join(',') !== 'a,b,c') fail('FIFO order broken: ' + order.join(','));
    if (q.size !== 0) fail('queue not empty after drain');
    ok('drain FIFO');
  }

  // 3. reentry + empty are no-ops.
  {
    const q = new PendingActionQueue();
    if (q.drain() !== 0) fail('empty drain should return 0');
    let ran = 0;
    q.enqueue(() => {
      ran += 1;
      // Re-entrant drain during action execution must be a no-op.
      const re = q.drain('reentry');
      if (re !== 0) fail('reentry drain should return 0, got ' + re);
    }, { label: 'a' });
    q.enqueue(() => { ran += 1; }, { label: 'b' });
    q.drain();
    if (ran !== 2) fail('expected both actions to run, ran=' + ran);
    ok('reentry safe + empty no-op');
  }

  // 4. errors caught, chain continues.
  {
    const q = new PendingActionQueue();
    let ran = 0;
    q.enqueue(() => { throw new Error('boom'); }, { label: 'bad' });
    q.enqueue(() => { ran += 1; }, { label: 'good' });
    q.drain();
    if (ran !== 1) fail('chain stopped after error');
    ok('errors caught, chain continues');
  }

  // 5. dedupeKey replaces.
  {
    const q = new PendingActionQueue();
    const ran = [];
    q.enqueue(() => ran.push('first'), { label: 'nav', dedupeKey: 'navigate:/x' });
    q.enqueue(() => ran.push('second'), { label: 'nav', dedupeKey: 'navigate:/x' });
    if (q.size !== 1) fail('dedupe should leave size 1, got ' + q.size);
    q.drain();
    if (ran.join(',') !== 'second') fail('dedupe should keep last, got ' + ran.join(','));
    ok('dedupeKey replaces');
  }

  // 6. clear.
  {
    const q = new PendingActionQueue();
    let ran = 0;
    q.enqueue(() => { ran += 1; });
    q.enqueue(() => { ran += 1; });
    const dropped = q.clear('test');
    if (dropped !== 2) fail('clear count ' + dropped + ' != 2');
    q.drain();
    if (ran !== 0) fail('cleared actions should not run, ran=' + ran);
    ok('clear drops without running');
  }

  // 7. drained event fires with labels.
  {
    const q = new PendingActionQueue();
    let detail = null;
    q.addEventListener('drained', (ev) => { detail = ev.detail; });
    q.enqueue(() => {}, { label: 'one' });
    q.enqueue(() => {}, { label: 'two' });
    q.drain('test');
    if (!detail) fail('drained event did not fire');
    if (detail.reason !== 'test') fail('drained reason wrong: ' + detail.reason);
    if (!Array.isArray(detail.ran) || detail.ran.join(',') !== 'one,two') {
      fail('drained ran labels wrong: ' + JSON.stringify(detail.ran));
    }
    ok('drained event fires with labels');
  }

  console.log('PASS pending-action-queue-smoke');
})().catch((err) => {
  console.error('FAIL', err && err.stack || err);
  process.exit(1);
});
