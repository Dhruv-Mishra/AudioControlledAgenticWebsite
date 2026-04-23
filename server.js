'use strict';

/**
 * Dhruv FreightOps demo server.
 *
 * - Serves static HTML/CSS/JS. In production (NODE_ENV=production) serves
 *   from `dist/` (built by `npm run build`); otherwise serves source.
 * - /api/health   : liveness + GEMINI_API_KEY presence indicator.
 * - /api/config   : client config (model id, persona list, wake word).
 * - /api/eval     : text-mode probe for the eval harness (POST).
 * - /api/transcript: append-only transcript logger (POST).
 * - /api/live (WS): Gemini Live ↔ browser audio + tool-call bridge.
 *
 * Perf middleware:
 *   - compression(): gzip/brotli negotiation on text/*, JSON, JS, CSS.
 *   - Long-lived Cache-Control on versioned/built assets (dist/ mode) and
 *     no-cache on the HTML shell + partials (always).
 *   - ETag on every static response (via file size + mtime hash) so even
 *     un-versioned assets revalidate cheaply.
 */

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { WebSocketServer } = require('ws');
const compression = require('compression');

// Load .env first, then .env.local with override — matches the convention used
// in the user's Python prototype (GeminiFlashAgentTest uses .env.local) AND the
// common Node convention (plain .env). Either filename works.
try {
  const dotenv = require('dotenv');
  dotenv.config({ path: '.env' });
  dotenv.config({ path: '.env.local', override: true });
} catch (_) { /* dotenv optional */ }

// Redacted startup log: was the key picked up?
(function logKey() {
  const k = process.env.GEMINI_API_KEY;
  if (k && k.length > 0) {
    process.stdout.write(`[server] GEMINI_API_KEY detected (len=${k.length})\n`);
  } else {
    process.stdout.write(`[server] GEMINI_API_KEY NOT SET. Put it in .env or .env.local — voice features will fail.\n`);
  }
})();

const { handleHealth } = require('./api/health');
const { handleConfig } = require('./api/config-endpoint');
const { handleEval } = require('./api/eval');
const liveBridge = require('./api/live-bridge');
const {
  acquireSession,
  releaseSession,
  ipFromRequest
} = require('./api/rate-limit');
const { SHOW_TEXT } = require('./api/server-flags');

const PORT = Number(process.env.PORT) || 3011;
const IS_PROD = process.env.NODE_ENV === 'production';
const ROOT = __dirname;
const DIST_ROOT = path.join(ROOT, 'dist');
// In prod mode we serve the compiled bundle. If the dist/ dir is missing,
// emit a loud warning (but keep serving from source) — the deploy script is
// supposed to run `npm run build` before starting the service.
const SERVE_ROOT = IS_PROD && fs.existsSync(DIST_ROOT) ? DIST_ROOT : ROOT;
if (IS_PROD && SERVE_ROOT === ROOT) {
  process.stdout.write(`[server] NODE_ENV=production but dist/ missing — falling back to source. Run \`npm run build\`.\n`);
}

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.wav':  'audio/wav',
  '.mp3':  'audio/mpeg',
  '.webm': 'audio/webm',
  '.ogg':  'audio/ogg',
  '.map':  'application/json; charset=utf-8'
};

// audio-flow: 'audio' is served so the browser can fetch the three
// startCall / background / endCall clips (webm primary, mp3 fallback).
const STATIC_DIRS = ['css', 'js', 'public', 'data', 'partials', 'audio'];

// Routes that the SPA router handles client-side. The server serves the
// single-page shell (index.html) for each — the History API then rewrites
// the URL without a document reload.
const SPA_ROUTES = new Set([
  '/',
  '/index.html',
  '/carriers.html',
  '/negotiate.html',
  '/contact.html',
  '/map.html'
]);

// Assets under these paths are content-addressed (esbuild hashes chunks) or
// aggressively cacheable because their URLs never change. We set
// `immutable, max-age=31536000` so CDNs + browsers hard-cache. On a
// source-tree deploy (NODE_ENV=dev), we fall back to a short max-age.
function cacheControlFor(pathname) {
  // HTML shell + partials: always revalidate so a deploy takes effect.
  if (pathname === '/' || pathname.endsWith('.html') || pathname.startsWith('/partials/')) {
    return 'no-cache';
  }
  // Versioned chunk bundles (dist/js/chunks/NAME-HASH.js): treat as immutable.
  if (/^\/js\/chunks\//.test(pathname)) {
    return 'public, max-age=31536000, immutable';
  }
  // Top-level JS/CSS: no content hash today, but safe to cache for a day.
  // Long-tail static assets (favicon, data fixtures, fonts) — 1 day is fine.
  // audio-flow: the three call-audio clips (mp3/webm) are included here
  // so the browser can cache them across reloads — they're small and
  // don't change per deploy.
  if (/\.(?:js|css|svg|png|jpg|ico|woff|woff2|mp3|webm|ogg|wav)$/i.test(pathname)) {
    return IS_PROD
      ? 'public, max-age=86400, must-revalidate'
      : 'no-cache';
  }
  // JSON fixtures + everything else: no-cache.
  return 'no-cache';
}

// Lightweight ETag using inode/size/mtime — avoids streaming whole file to hash.
function weakEtag(stat) {
  return `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
}

function safeJoin(root, reqPath) {
  const p = path.posix.normalize(reqPath).replace(/^\/+/, '');
  const abs = path.join(root, p);
  // Prevent traversal
  if (!abs.startsWith(root)) return null;
  return abs;
}

async function serveFile(abs, req, res) {
  try {
    const stat = await fsp.stat(abs);
    if (stat.isDirectory()) {
      res.writeHead(404); res.end('Not Found');
      return;
    }
    const ext = path.extname(abs).toLowerCase();
    // Determine URL path for Cache-Control lookup: strip SERVE_ROOT and
    // normalise to posix.
    const relUrl = '/' + path.relative(SERVE_ROOT, abs).split(path.sep).join('/');
    const etag = weakEtag(stat);

    // 304 fast-path: if client already has a fresh copy, skip the transfer.
    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch && ifNoneMatch === etag) {
      res.writeHead(304, {
        'Cache-Control': cacheControlFor(relUrl),
        ETag: etag
      });
      res.end();
      return;
    }
    const data = await fsp.readFile(abs);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': cacheControlFor(relUrl),
      ETag: etag,
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(data);
  } catch (err) {
    res.writeHead(404); res.end('Not Found');
  }
}

function resolveStaticPath(pathname) {
  // SPA-routed pages always serve the same shell document. The History
  // API rewrites the URL client-side; the server keeps /carriers.html &c.
  // bookmarkable (deep-linking works) while the browser never fully
  // reloads during in-app navigation.
  if (SPA_ROUTES.has(pathname) || pathname === '') {
    return path.join(SERVE_ROOT, 'index.html');
  }
  // Partials (served under /partials/*.html) are the section bodies that
  // the client router injects into the shell's <main> element.
  if (pathname.startsWith('/partials/') && pathname.endsWith('.html')) {
    return safeJoin(SERVE_ROOT, pathname);
  }
  // Static asset under known top-level dir
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length && STATIC_DIRS.includes(parts[0])) {
    return safeJoin(SERVE_ROOT, pathname);
  }
  // Special case: /favicon.ico
  if (pathname === '/favicon.ico') return path.join(SERVE_ROOT, 'public', 'favicon.svg');
  return null;
}

function isOriginAllowed(origin) {
  if (!origin) return true; // loopback / curl
  if (!ALLOWED_ORIGINS.length) {
    // Dev defaults
    return /^(https?:\/\/)?(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
  }
  return ALLOWED_ORIGINS.includes(origin);
}

async function handleTranscript(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405); res.end(); return;
  }
  let body = '';
  const chunks = [];
  let total = 0;
  req.on('data', (c) => { total += c.length; if (total > 32 * 1024) { req.destroy(); return; } chunks.push(c); });
  req.on('end', () => {
    try {
      body = Buffer.concat(chunks).toString('utf8');
      const obj = JSON.parse(body || '{}');
      // Compact log line only. Retention policy: stdout + nowhere else.
      // When SHOW_TEXT=false we log the kind + length but NEVER the text
      // body itself — the whole point of the flag is that transcript
      // content stays out of server logs.
      const at = new Date().toISOString();
      const kind = String(obj.kind || 'final').slice(0, 20);
      const textLen = obj && typeof obj.text === 'string' ? obj.text.length : 0;
      if (SHOW_TEXT) {
        process.stdout.write(`[transcript] ${at} kind=${kind} len=${textLen}\n`);
      } else {
        process.stdout.write(`[transcript] ${at} kind=${kind} len=${textLen} (text redacted: SHOW_TEXT=false)\n`);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  });
}

function urlPathname(req) {
  try {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    return u.pathname;
  } catch {
    return (req.url || '/').split('?')[0];
  }
}

// --------- HTTP server ---------

// Initialise compression middleware once — it returns a (req, res, next)
// handler. We pass text/json/js/css to it; binary image content isn't
// gzip-sensitive so we skip via the `filter`. Threshold 1 KB so tiny
// responses aren't compressed (overhead > savings).
const compressMw = compression({
  threshold: 1024,
  filter: (req, res) => {
    const ct = String(res.getHeader('Content-Type') || '');
    return /text\/|application\/(?:json|javascript|xml)|image\/svg\+xml/i.test(ct);
  }
});

function runCompression(req, res) {
  return new Promise((resolve) => {
    compressMw(req, res, () => resolve());
  });
}

const server = http.createServer(async (req, res) => {
  const pathname = urlPathname(req);

  // Run compression middleware on every response. It's cheap — ~500 ns
  // overhead when the response is excluded by threshold + filter.
  await runCompression(req, res);

  // API
  if (pathname === '/api/health') return handleHealth(req, res);
  if (pathname === '/api/config') return handleConfig(req, res);
  if (pathname === '/api/eval')   return handleEval(req, res);
  if (pathname === '/api/transcript') return handleTranscript(req, res);

  // Static
  if (req.method === 'GET') {
    const abs = resolveStaticPath(pathname);
    if (abs) return serveFile(abs, req, res);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

// --------- WS server ---------
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const pathname = urlPathname(req);
  if (pathname !== '/api/live') {
    socket.destroy();
    return;
  }
  if (!isOriginAllowed(req.headers.origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  const ip = ipFromRequest(req);
  const rl = acquireSession(ip);
  if (!rl.ok) {
    socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.once('close', () => releaseSession(ip));
    try {
      liveBridge.attach(ws, req, process.env);
    } catch (err) {
      try {
        ws.send(JSON.stringify({ type: 'error', code: 'bridge_init', message: err.message, retriable: false }));
      } catch { /* ignore */ }
      ws.close();
    }
  });
});

server.listen(PORT, () => {
  const hasKey = !!process.env.GEMINI_API_KEY;
  process.stdout.write(
    `Dhruv FreightOps listening on http://localhost:${PORT}\n` +
    `  NODE_ENV:       ${process.env.NODE_ENV || 'development'}\n` +
    `  serve root:     ${SERVE_ROOT === DIST_ROOT ? 'dist/' : 'source'}\n` +
    `  GEMINI_API_KEY: ${hasKey ? 'set' : 'NOT SET (voice features will error)'}\n` +
    `  WS endpoint:    ws://localhost:${PORT}/api/live\n`
  );
});

// Graceful shutdown
function shutdown() {
  try { wss.close(); } catch {}
  try { server.close(() => process.exit(0)); } catch { process.exit(0); }
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
