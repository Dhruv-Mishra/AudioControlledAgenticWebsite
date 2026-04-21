'use strict';

/**
 * Minimal in-memory rate limiter. Per-IP buckets with rolling windows.
 *
 *   - maxConcurrentLive : simultaneous WS sessions per IP (1 default).
 *   - maxLivePerHour    : new WS sessions per IP per hour.
 *   - maxFramesPerSecond: max audio chunk frames per sec per session (soft).
 */

const CFG = {
  maxConcurrentLive: 1,
  maxLivePerHour: 60,
  maxFramesPerSecond: 120
};

const state = new Map(); // ip -> { concurrent, windowStart, windowCount }

function now() { return Date.now(); }

function acquireSession(ip) {
  const s = state.get(ip) || { concurrent: 0, windowStart: now(), windowCount: 0 };
  const t = now();
  if (t - s.windowStart > 60 * 60 * 1000) {
    s.windowStart = t;
    s.windowCount = 0;
  }
  if (s.windowCount >= CFG.maxLivePerHour) {
    return { ok: false, code: 'rate_limited', message: `Too many sessions per hour (max ${CFG.maxLivePerHour}).` };
  }
  if (s.concurrent >= CFG.maxConcurrentLive) {
    return { ok: false, code: 'too_many_concurrent', message: 'Only one live session per IP at a time.' };
  }
  s.concurrent += 1;
  s.windowCount += 1;
  state.set(ip, s);
  return { ok: true };
}

function releaseSession(ip) {
  const s = state.get(ip);
  if (!s) return;
  s.concurrent = Math.max(0, s.concurrent - 1);
  state.set(ip, s);
}

/** Per-session frame limiter. Returns a closure tracking a sliding 1s window. */
function makeFrameLimiter() {
  const windowMs = 1000;
  let windowStart = now();
  let count = 0;
  return function allowFrame() {
    const t = now();
    if (t - windowStart > windowMs) {
      windowStart = t;
      count = 0;
    }
    count += 1;
    return count <= CFG.maxFramesPerSecond;
  };
}

function ipFromRequest(req) {
  const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket?.remoteAddress || 'unknown';
}

module.exports = { acquireSession, releaseSession, makeFrameLimiter, ipFromRequest, CFG };
