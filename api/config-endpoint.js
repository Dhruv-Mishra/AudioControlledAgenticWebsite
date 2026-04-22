'use strict';

const { LIVE_MODEL_ID } = require('./gemini-config');
const { publicPersonas, DEFAULT_PERSONA_ID } = require('./personas');
const { GEMINI_TRANSCRIPTION, SHOW_TEXT, STT_BACKEND, HUMAN_CALL_LAYER } = require('./server-flags');

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
    talkKey: 'Space',
    // Preferred STT backend for the browser. The client honours this as a
    // policy hint; it may still fall back to Web Speech if Whisper init fails.
    sttBackend: STT_BACKEND,
    // Feature flags — browser mirrors them to decide what to render.
    flags: {
      geminiTranscription: !!GEMINI_TRANSCRIPTION,
      showText: !!SHOW_TEXT,
      humanCallLayer: !!HUMAN_CALL_LAYER
    }
  }));
}

module.exports = { handleConfig };
