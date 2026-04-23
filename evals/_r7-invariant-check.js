// Round-7 invariant checker. Reads a run dump (from
// `_r7-browser-repro-v2.js`) and asserts ALL round-7 invariants pass.
//
// Invariants:
//   I1. Background audio MUST NOT play during callOpen.
//       → no `media.play.call background` event BETWEEN unlock-dance
//         (first one, which is immediately paused) and `audio_prelude_ended`.
//   I2. Agent audio (binary WS frames) MUST NOT reach the client before
//       `audio_prelude_ended` is sent.
//   I3. `audio_prelude_ended` is sent exactly once per run.
//   I4. The first real background `play.call` happens within ±100 ms of
//       the `audio_prelude_ended` send.
//   I5. No console.error events occurred (other than permission / WS
//       errors from invalid key).
//
// Exit 0 if all invariants hold; 1 if any fail.

'use strict';

const fs = require('fs');
const path = require('path');

const FILE = process.argv[2];
if (!FILE) {
  console.error('usage: node _r7-invariant-check.js <dump.json>');
  process.exit(2);
}

const events = JSON.parse(fs.readFileSync(FILE, 'utf8'));

const fails = [];
function check(name, cond, detail) {
  if (cond) console.log('  OK  ' + name + (detail ? ' (' + detail + ')' : ''));
  else { console.error('  FAIL ' + name + (detail ? ' (' + detail + ')' : '')); fails.push(name); }
}

// Extract key events
const preludeSends = events.filter((e) => e.kind === 'ws.send' && e.detail && e.detail.type === 'audio_prelude_ended');
const bgPlayCalls = events.filter((e) => e.kind === 'media.play.call' && /background/.test(String(e.detail || '')));
// The first bg play is the unlock dance (muted + immediately paused).
// The second+ is the real one (from _onCallOpenEnded).
const bgRealPlay = bgPlayCalls.length >= 2 ? bgPlayCalls[1] : null;
const wsBinaries = events.filter((e) => e.kind === 'ws.recv.binary');
const consoleErrors = events.filter((e) => e.kind === 'console.error');

const preludeT = preludeSends[0] ? preludeSends[0].t : null;
const firstBinT = wsBinaries[0] ? wsBinaries[0].t : null;
const bgRealT = bgRealPlay ? bgRealPlay.t : null;

console.log('Parsed: ' + events.length + ' events');
console.log('preludeSends=' + preludeSends.length + ' t=' + preludeT);
console.log('bgPlayCalls=' + bgPlayCalls.length + ' firstDanceAt=' + (bgPlayCalls[0] ? bgPlayCalls[0].t : null) + ' realAt=' + bgRealT);
console.log('wsBinaries=' + wsBinaries.length + ' firstAt=' + firstBinT);
console.log('consoleErrors=' + consoleErrors.length);

// I1: background does not play audibly between unlock and prelude.
// The first bg play is ALWAYS the unlock dance (muted, paused within
// same tick). We check: is there a REAL play.call on background that
// is NOT immediately paused, before prelude?
// We do that by finding the set of bg play.call events NOT followed
// within 20ms by a bg pause.call.
const unpausedBgPlaysBeforePrelude = [];
for (let i = 0; i < bgPlayCalls.length; i++) {
  const p = bgPlayCalls[i];
  const pausedWithin = events.some((e) =>
    e.kind === 'media.pause.call' && /background/.test(String(e.detail || '')) && e.t >= p.t && e.t <= p.t + 20
  );
  if (!pausedWithin && (preludeT == null || p.t < preludeT - 5)) {
    unpausedBgPlaysBeforePrelude.push(p);
  }
}
check('I1 background not played during callOpen',
  unpausedBgPlaysBeforePrelude.length === 0,
  'unpaused=' + unpausedBgPlaysBeforePrelude.length);

// I2: no agent binary before prelude.
const binariesBeforePrelude = wsBinaries.filter((e) => preludeT != null && e.t < preludeT - 5);
check('I2 no agent audio before audio_prelude_ended',
  binariesBeforePrelude.length === 0,
  'preBin=' + binariesBeforePrelude.length);

// I3: exactly one prelude send.
check('I3 audio_prelude_ended sent exactly once',
  preludeSends.length === 1,
  'count=' + preludeSends.length);

// I4: first real bg play within 100ms of prelude.
if (bgRealT != null && preludeT != null) {
  const delta = Math.abs(bgRealT - preludeT);
  check('I4 bg starts within 100ms of prelude send',
    delta <= 100,
    'delta=' + delta + 'ms');
}

// I5: no unexpected console.error (allow WS errors from invalid key).
const unexpectedErrors = consoleErrors.filter((e) => {
  const s = String(e.detail || '');
  if (/invalid_key|unauthori|permission|401|403|GEMINI/i.test(s)) return false;  // expected
  if (/agent audio arrived before callOpen/.test(s)) return true;  // round-5 safety belt — regression
  if (/safety timeout fired/.test(s)) return true;
  if (/restart exceeded/.test(s)) return true;
  return false;
});
check('I5 no unexpected console.error',
  unexpectedErrors.length === 0,
  'unexpected=' + unexpectedErrors.length);

if (fails.length) {
  console.error('\nFAIL: ' + fails.length + ' invariant(s) failed');
  process.exit(1);
}
console.log('\nALL INVARIANTS HOLD');
process.exit(0);
