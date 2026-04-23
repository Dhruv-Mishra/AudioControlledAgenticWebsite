'use strict';

// Ad-hoc smoke for isOriginAllowed wildcard support. Not wired to npm —
// run with `node evals/_origin-wildcard-smoke.js`. Mirrors the inline
// compilation block in server.js so any drift is caught manually.

process.env.NODE_ENV = 'production';
process.env.WS_NONCE_SECRET = 'x'.repeat(64);
process.env.ALLOWED_ORIGINS = [
  'https://jarvis.whoisdhruv.com',
  'https://*.whoisdhruv.com',
  'http://localhost:3011'
].join(',');

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const ALLOWED_ORIGIN_EXACT = new Set();
const ALLOWED_ORIGIN_WILDCARDS = [];
for (const entry of ALLOWED_ORIGINS) {
  if (entry.includes('*')) {
    const pattern = entry
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^.]+');
    ALLOWED_ORIGIN_WILDCARDS.push(new RegExp('^' + pattern + '$'));
  } else {
    ALLOWED_ORIGIN_EXACT.add(entry);
  }
}

function match(origin) {
  const o = String(origin).toLowerCase();
  if (ALLOWED_ORIGIN_EXACT.has(o)) return true;
  for (const re of ALLOWED_ORIGIN_WILDCARDS) if (re.test(o)) return true;
  return false;
}

const cases = [
  ['https://jarvis.whoisdhruv.com',        true,  'exact match'],
  ['https://foo.whoisdhruv.com',           true,  'one-label wildcard'],
  ['https://FOO.whoisdhruv.com',           true,  'case-insensitive'],
  ['https://whoisdhruv.com',               false, 'apex must NOT match wildcard'],
  ['https://a.b.whoisdhruv.com',           false, 'nested subdomain must NOT match'],
  ['http://foo.whoisdhruv.com',            false, 'scheme mismatch'],
  ['https://foo.whoisdhruv.com:8443',      false, 'port present when pattern has none'],
  ['https://evil.com',                     false, 'unrelated host'],
  ['https://whoisdhruvXcom',               false, 'dot is literal, not wildcard'],
  ['http://localhost:3011',                true,  'exact localhost'],
  ['',                                     false, 'empty'],
];

let pass = 0, fail = 0;
for (const [origin, want, label] of cases) {
  const got = match(origin);
  const ok = got === want;
  if (ok) pass++; else fail++;
  console.log(
    (ok ? 'PASS' : 'FAIL') + ' | ' +
    String(label).padEnd(42) + ' | origin=' + JSON.stringify(origin) +
    ' want=' + want + ' got=' + got
  );
}
console.log('---');
console.log('pass=' + pass + ' fail=' + fail);
process.exit(fail ? 1 : 0);
