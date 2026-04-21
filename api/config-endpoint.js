'use strict';

const { LIVE_MODEL_ID } = require('./gemini-config');
const { publicPersonas, DEFAULT_PERSONA_ID } = require('./personas');

/** Small JSON config endpoint so the client knows which persona list to render. */
function handleConfig(req, res) {
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify({
    model: LIVE_MODEL_ID,
    personas: publicPersonas(),
    defaultPersona: DEFAULT_PERSONA_ID,
    wakeWord: 'hey jarvis',
    talkKey: 'Space'
  }));
}

module.exports = { handleConfig };
