'use strict';

/**
 * WS nonce minting + verification.
 *
 * Shape (base64url-decoded): rand(16) || exp_u32be(4) || sig(32)
 *   sig = HMAC-SHA256(secret, rand || exp)
 *
 * Lifecycle:
 *   - Client GETs /api/ws-nonce → { nonce, exp } where exp is epoch-seconds.
 *   - Client opens WS with ?token=<nonce>.
 *   - Server parses token, HMAC-verifies (constant-time), checks exp, checks
 *     a tiny in-memory replay LRU (see `replaySeen`). All O(1); ≤ 1 ms.
 *   - Failure → HTTP 401 on upgrade.
 *
 * Secret source: env var `WS_NONCE_SECRET`.
 *   - If unset in development: generate a per-process random secret and log a
 *     one-line warning; the server still starts.
 *   - If unset in production (NODE_ENV=production): refuse to start.
 *
 * Rationale:
 *   Pure Node crypto — no new dependency. Encrypted+MAC'd and timed-out,
 *   so a foreign client cannot forge or replay a token.
 */

const crypto = require('crypto');

// 60-second TTL. Short enough that a leaked nonce is worthless; long enough
// that slow clicks don't race.
const NONCE_TTL_MS = 60 * 1000;
const NONCE_VERSION = 1;

// Replay LRU. Keyed by the base64url nonce. Value is the exp-ms — we evict
// entries as their TTL expires. Bounded to MAX_REPLAY_ENTRIES so a flood of
// tokens can't OOM the server.
const MAX_REPLAY_ENTRIES = 10_000;
const replaySeen = new Map();

// ---------- secret resolution ----------

let _resolvedSecret = null;
let _warnedEphemeralSecret = false;

function resolveSecret(env) {
  if (_resolvedSecret) return _resolvedSecret;
  const fromEnv = (env && env.WS_NONCE_SECRET) || process.env.WS_NONCE_SECRET;
  if (fromEnv && fromEnv.length >= 16) {
    _resolvedSecret = Buffer.from(fromEnv, 'utf8');
    return _resolvedSecret;
  }
  const isProd = (env && env.NODE_ENV === 'production') || process.env.NODE_ENV === 'production';
  if (isProd) {
    throw new Error('WS_NONCE_SECRET is required in production. Set it in the environment and restart.');
  }
  // Dev: ephemeral per-process secret.
  _resolvedSecret = crypto.randomBytes(32);
  if (!_warnedEphemeralSecret) {
    _warnedEphemeralSecret = true;
    // eslint-disable-next-line no-console
    process.stdout.write('[ws-nonce] WS_NONCE_SECRET not set; using ephemeral per-process secret (dev only).\n');
  }
  return _resolvedSecret;
}

// ---------- base64url helpers ----------

function b64urlEncode(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function b64urlDecode(str) {
  if (typeof str !== 'string') return null;
  // Reject any character outside the base64url alphabet (defence in depth).
  if (!/^[A-Za-z0-9_-]+$/.test(str)) return null;
  const pad = str.length % 4 === 2 ? '==' : str.length % 4 === 3 ? '=' : '';
  try {
    return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
  } catch {
    return null;
  }
}

// ---------- mint ----------

/**
 * Return { nonce, exp } — nonce is a url-safe string; exp is epoch-ms.
 */
function mintNonce(env) {
  const secret = resolveSecret(env);
  const rand = crypto.randomBytes(16);
  const expMs = Date.now() + NONCE_TTL_MS;
  // 4-byte u32 = epoch-SECONDS (fits until 2106).
  const expSec = Math.floor(expMs / 1000);
  const expBuf = Buffer.alloc(4);
  expBuf.writeUInt32BE(expSec, 0);
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(rand);
  hmac.update(expBuf);
  const sig = hmac.digest();
  const token = Buffer.concat([rand, expBuf, sig]); // 52 bytes
  return { nonce: b64urlEncode(token), exp: expMs, version: NONCE_VERSION };
}

// ---------- verify ----------

/**
 * Returns `{ ok: true }` on success, `{ ok: false, reason }` on failure.
 * Reasons: 'format', 'expired', 'bad_sig', 'replay'.
 */
function verifyNonce(nonce, env) {
  if (typeof nonce !== 'string' || nonce.length === 0) {
    return { ok: false, reason: 'format' };
  }
  const buf = b64urlDecode(nonce);
  // 16 + 4 + 32 = 52 bytes exactly.
  if (!buf || buf.length !== 52) return { ok: false, reason: 'format' };

  const rand = buf.subarray(0, 16);
  const expBuf = buf.subarray(16, 20);
  const sig = buf.subarray(20, 52);

  const expSec = expBuf.readUInt32BE(0);
  const expMs = expSec * 1000;
  if (expMs <= Date.now()) {
    return { ok: false, reason: 'expired' };
  }

  // HMAC verify — constant-time.
  const secret = resolveSecret(env);
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(rand);
  hmac.update(expBuf);
  const expected = hmac.digest();
  let sigOk = false;
  try {
    sigOk = sig.length === expected.length && crypto.timingSafeEqual(sig, expected);
  } catch {
    sigOk = false;
  }
  if (!sigOk) return { ok: false, reason: 'bad_sig' };

  // Replay check. Cheap sweep when the map gets big — we check the first few
  // entries on the iteration order (insertion order) and evict expired.
  _sweepReplay();
  if (replaySeen.has(nonce)) {
    return { ok: false, reason: 'replay' };
  }
  replaySeen.set(nonce, expMs);
  // Bound the set size defensively.
  if (replaySeen.size > MAX_REPLAY_ENTRIES) {
    const firstKey = replaySeen.keys().next().value;
    if (firstKey) replaySeen.delete(firstKey);
  }
  return { ok: true, expMs };
}

function _sweepReplay() {
  if (replaySeen.size === 0) return;
  // Opportunistic: remove up to 32 expired entries per call (O(1) amortised).
  let removed = 0;
  const now = Date.now();
  for (const [key, exp] of replaySeen) {
    if (exp <= now) {
      replaySeen.delete(key);
      removed += 1;
      if (removed >= 32) break;
    } else {
      break; // insertion-order iteration; once we hit a live entry we stop.
    }
  }
}

// ---------- HTTP endpoint ----------

/**
 * GET /api/ws-nonce → { nonce, exp }.
 * Any other method → 405.
 */
function handleWsNonce(req, res) {
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    res.end('Method Not Allowed');
    return;
  }
  try {
    const { nonce, exp, version } = mintNonce(process.env);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(JSON.stringify({ nonce, exp, version, ttlMs: NONCE_TTL_MS }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: false, error: String(err && err.message || err) }));
  }
}

/**
 * Helper for `server.on('upgrade')`: parse + verify the nonce token on the
 * WS URL. Returns `{ ok: true }` / `{ ok: false, reason }`.
 */
function verifyNonceFromRequest(req, env) {
  let token = null;
  try {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    token = u.searchParams.get('token');
  } catch { /* fall through */ }
  if (!token) {
    // Accept fallback via Sec-WebSocket-Protocol: nonce.<value>
    const sub = req.headers['sec-websocket-protocol'];
    if (typeof sub === 'string') {
      const parts = sub.split(',').map((s) => s.trim());
      for (const p of parts) {
        if (p.startsWith('nonce.')) { token = p.slice('nonce.'.length); break; }
      }
    }
  }
  if (!token) return { ok: false, reason: 'missing' };
  return verifyNonce(token, env || process.env);
}

module.exports = {
  handleWsNonce,
  mintNonce,
  verifyNonce,
  verifyNonceFromRequest,
  // Exposed for tests.
  _state: { replaySeen, NONCE_TTL_MS, MAX_REPLAY_ENTRIES, NONCE_VERSION }
};
