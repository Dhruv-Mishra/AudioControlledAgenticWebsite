'use strict';

const { LIVE_MODEL_ID } = require('./gemini-config');

function handleHealth(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({
    ok: true,
    uptime: Math.round(process.uptime()),
    model: LIVE_MODEL_ID,
    hasApiKey: !!process.env.GEMINI_API_KEY,
    timestamp: new Date().toISOString()
  }));
}

module.exports = { handleHealth };
