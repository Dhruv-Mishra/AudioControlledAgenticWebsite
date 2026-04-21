'use strict';

/**
 * HappyRobot FreightOps demo server.
 *
 * - Serves static HTML/CSS/JS.
 * - /api/health   : liveness + GEMINI_API_KEY presence indicator.
 * - /api/config   : client config (model id, persona list, wake word).
 * - /api/eval     : text-mode probe for the eval harness (POST).
 * - /api/transcript: append-only transcript logger (POST).
 * - /api/live (WS): Gemini Live ↔ browser audio + tool-call bridge.
 */

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { WebSocketServer } = require('ws');

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

const PORT = Number(process.env.PORT) || 3001;
const ROOT = __dirname;
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
  '.map':  'application/json; charset=utf-8'
};

const STATIC_DIRS = ['css', 'js', 'public', 'data', 'partials'];

// Routes that the SPA router handles client-side. The server serves the
// single-page shell (index.html) for each — the History API then rewrites
// the URL without a document reload.
const SPA_ROUTES = new Set([
  '/',
  '/index.html',
  '/carriers.html',
  '/negotiate.html',
  '/contact.html'
]);

function safeJoin(root, reqPath) {
  const p = path.posix.normalize(reqPath).replace(/^\/+/, '');
  const abs = path.join(root, p);
  // Prevent traversal
  if (!abs.startsWith(root)) return null;
  return abs;
}

async function serveFile(abs, res) {
  try {
    const stat = await fsp.stat(abs);
    if (stat.isDirectory()) {
      res.writeHead(404); res.end('Not Found');
      return;
    }
    const ext = path.extname(abs).toLowerCase();
    const data = await fsp.readFile(abs);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store'
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
    return path.join(ROOT, 'index.html');
  }
  // Partials (served under /partials/*.html) are the section bodies that
  // the client router injects into the shell's <main> element.
  if (pathname.startsWith('/partials/') && pathname.endsWith('.html')) {
    return safeJoin(ROOT, pathname);
  }
  // Static asset under known top-level dir
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length && STATIC_DIRS.includes(parts[0])) {
    return safeJoin(ROOT, pathname);
  }
  // Special case: /favicon.ico
  if (pathname === '/favicon.ico') return path.join(ROOT, 'public', 'favicon.svg');
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
      // Log a compact line only. Retention policy: stdout + nowhere else.
      const at = new Date().toISOString();
      const text = String(obj.text || '').slice(0, 1000).replace(/\s+/g, ' ').trim();
      const kind = String(obj.kind || 'final').slice(0, 20);
      process.stdout.write(`[transcript] ${at} kind=${kind} len=${text.length}\n`);
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
const server = http.createServer(async (req, res) => {
  const pathname = urlPathname(req);

  // API
  if (pathname === '/api/health') return handleHealth(req, res);
  if (pathname === '/api/config') return handleConfig(req, res);
  if (pathname === '/api/eval')   return handleEval(req, res);
  if (pathname === '/api/transcript') return handleTranscript(req, res);

  // Static
  if (req.method === 'GET') {
    const abs = resolveStaticPath(pathname);
    if (abs) return serveFile(abs, res);
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
    `HappyRobot FreightOps listening on http://localhost:${PORT}\n` +
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
