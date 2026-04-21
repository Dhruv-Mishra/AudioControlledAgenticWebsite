// Smoke — `coerceFillValue` logic in js/tool-registry.js. Pure unit
// test; no browser, no server, no network.
//
// Verifies the coercion used by the `fill` tool handles the input types
// the model is most likely to send wrong values for. Catches
// regressions where a format change silently breaks the
// datetime-local / date / time / month / week / number / tel paths.
//
// Usage:  node evals/fill-datetime-smoke.mjs
//         npm run smoke:fill-datetime

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const modUrl = pathToFileURL(path.resolve('js/tool-registry.js')).href;
const { coerceFillValue, formatHintFor } = await import(modUrl);

let failed = 0;
function check(label, got, want) {
  try {
    assert.deepStrictEqual(got, want);
    console.log(`PASS ${label}`);
  } catch (err) {
    console.error(`FAIL ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`);
    failed += 1;
  }
}

// --- datetime-local -----------------------------------------------------
// The exact failure the user reported: Gemini sent an ISO UTC string;
// the input silently rejected it. Post-fix, we coerce to local
// `YYYY-MM-DDTHH:MM` (minute precision).
{
  // Freeze the local TZ offset for deterministic output. In CI this
  // typically runs in the server's TZ; we just verify the SHAPE.
  const got = coerceFillValue('2027-04-05T00:00:00.000Z', 'datetime-local');
  assert.equal(got.ok, true, 'datetime-local UTC parse must succeed');
  // YYYY-MM-DDTHH:MM with no `Z` and no seconds. Exactly 16 chars.
  assert.match(got.value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'datetime-local format');
  console.log(`PASS datetime-local: "2027-04-05T00:00:00.000Z" → "${got.value}"`);
}
check('datetime-local already-local',
  coerceFillValue('2027-04-05T13:30', 'datetime-local'),
  { ok: true, value: '2027-04-05T13:30' });
check('datetime-local invalid',
  coerceFillValue('nope', 'datetime-local'),
  { ok: false, value: '', reason: 'Could not parse as a date-time. Send ISO 8601 like 2027-04-05T13:30 or 2027-04-05T13:30:00Z.' });
check('datetime-local empty',
  coerceFillValue('', 'datetime-local'),
  { ok: true, value: '' });

// --- date ---------------------------------------------------------------
{
  const got = coerceFillValue('2027-04-05T00:00:00.000Z', 'date');
  assert.equal(got.ok, true);
  assert.match(got.value, /^\d{4}-\d{2}-\d{2}$/, 'date format');
  console.log(`PASS date from ISO: "${got.value}"`);
}
check('date plain',
  coerceFillValue('2027-04-05', 'date'),
  { ok: true, value: '2027-04-05' });
check('date invalid',
  coerceFillValue('not a date', 'date'),
  { ok: false, value: '', reason: 'Could not parse as a date. Send YYYY-MM-DD or any ISO 8601 date-time.' });

// --- time ---------------------------------------------------------------
check('time HH:MM', coerceFillValue('09:30', 'time'), { ok: true, value: '09:30' });
check('time H:MM (single digit)', coerceFillValue('9:30', 'time'), { ok: true, value: '09:30' });
check('time HH:MM:SS → HH:MM', coerceFillValue('09:30:15', 'time'), { ok: true, value: '09:30' });
check('time 2:30 PM',  coerceFillValue('2:30 PM', 'time'), { ok: true, value: '14:30' });
check('time 12:00 AM → 00:00', coerceFillValue('12:00 AM', 'time'), { ok: true, value: '00:00' });
check('time 12:00 PM → 12:00', coerceFillValue('12:00 PM', 'time'), { ok: true, value: '12:00' });

// --- month --------------------------------------------------------------
check('month plain',
  coerceFillValue('2027-04', 'month'),
  { ok: true, value: '2027-04' });
{
  const got = coerceFillValue('April 2027', 'month');
  // Some engines parse 'April 2027' as the 1st of April in local TZ; the
  // result must at least match YYYY-MM shape.
  if (got.ok) {
    assert.match(got.value, /^\d{4}-\d{2}$/, 'month shape');
    console.log(`PASS month "April 2027" → "${got.value}"`);
  } else {
    // Not all engines parse this string; if reason is present the error
    // shape is still correct. Log and move on.
    console.log(`SKIP month "April 2027" (engine does not parse): ${got.reason}`);
  }
}

// --- week ---------------------------------------------------------------
{
  // Any parseable date yields YYYY-Www.
  const got = coerceFillValue('2027-01-15', 'week');
  assert.equal(got.ok, true);
  assert.match(got.value, /^\d{4}-W\d{2}$/, 'week shape');
  console.log(`PASS week "2027-01-15" → "${got.value}"`);
}

// --- number / range -----------------------------------------------------
check('number plain',        coerceFillValue('1850', 'number'),        { ok: true, value: '1850' });
check('number commas',       coerceFillValue('1,850', 'number'),       { ok: true, value: '1850' });
check('number dollar',       coerceFillValue('$1,850.50', 'number'),   { ok: true, value: '1850.5' });
check('number neg',          coerceFillValue('-42', 'number'),         { ok: true, value: '-42' });
check('number trailing text',coerceFillValue('1850 USD', 'number'),    { ok: true, value: '1850' });
check('number invalid',      coerceFillValue('not a number', 'number'),{ ok: false, value: '', reason: 'Could not parse "not a number" as a number.' });
check('range',               coerceFillValue('50', 'range'),           { ok: true, value: '50' });

// --- tel ----------------------------------------------------------------
check('tel plain',        coerceFillValue('+1 (555) 867-5309', 'tel'), { ok: true, value: '+1 (555) 867-5309' });
check('tel with ext',     coerceFillValue('555-0100 ext. 42', 'tel'),  { ok: true, value: '555-0100  42' });

// --- text / textarea / email / url --------------------------------------
check('text passthrough',   coerceFillValue('Hello world', 'text'),           { ok: true, value: 'Hello world' });
check('textarea passthrough', coerceFillValue('line 1\nline 2', 'textarea'),  { ok: true, value: 'line 1\nline 2' });
check('email trim',         coerceFillValue('  foo@example.com  ', 'email'),  { ok: true, value: 'foo@example.com' });
check('url trim',           coerceFillValue('  https://x.com/  ', 'url'),     { ok: true, value: 'https://x.com/' });
check('unknown type',       coerceFillValue('whatever', 'color'),             { ok: true, value: 'whatever' });

// --- format hints -------------------------------------------------------
assert.equal(formatHintFor('datetime-local'), 'YYYY-MM-DDTHH:MM (local time, no Z)');
assert.equal(formatHintFor('date'), 'YYYY-MM-DD');
assert.equal(formatHintFor('tel'), 'digits with optional +, -, (, ), spaces');
assert.equal(formatHintFor('unknown'), 'plain text');
console.log('PASS formatHintFor returns expected strings');

// ------------------------------------------------------------------------
if (failed === 0) {
  console.log(`\nALL FILL-DATETIME SMOKE CHECKS PASSED`);
  process.exit(0);
} else {
  console.error(`\nFAIL: ${failed} failures`);
  process.exit(1);
}
