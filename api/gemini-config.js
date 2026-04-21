'use strict';

/**
 * Single source of truth for the Gemini Live connection config.
 * The model ID is pinned here — update in exactly one place.
 */

const LIVE_MODEL_ID = process.env.GEMINI_LIVE_MODEL || 'gemini-3.1-flash-live-preview';

// If the pinned model is not served, we fall back to the SDK-documented alias.
const LIVE_MODEL_FALLBACK = 'gemini-live-2.5-flash-preview';

// Prebuilt voice names used by personas (from Gemini Live docs).
const KNOWN_VOICES = [
  'Kore', 'Puck', 'Charon', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr',
  'Callirrhoe', 'Autonoe', 'Enceladus'
];

// Session-resumption window used by the cross-page handoff. We re-use a
// captured `sessionResumptionUpdate.newHandle` if the browser reconnects
// within this window; beyond it, we start fresh. The Gemini Live API does
// not document a public TTL for resumption handles, so we bound it to a
// reasonable cache-lifetime for user-facing continuity. 10 minutes matches
// the upper end of typical browser session pauses (tab switch, nav).
const SESSION_RESUME_WINDOW_MS = 10 * 60 * 1000;

// VAD presets. Wake-word mode: user says "Hey Jarvis" then a phrase — a
// slightly longer silence window feels natural. Live mode: turn-taking needs
// to be snappy so the model reacts quickly when the user stops.
const VAD_PRESETS = {
  wakeword: {
    silenceDurationMs: 700,
    prefixPaddingMs: 20,
    startOfSpeechSensitivity: 'START_SENSITIVITY_LOW',
    endOfSpeechSensitivity: 'END_SENSITIVITY_LOW'
  },
  live: {
    silenceDurationMs: 500,
    prefixPaddingMs: 20,
    startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
    endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH'
  }
};

/** Build the base config dict for `ai.live.connect()`. */
function buildLiveConfig({ systemInstruction, voiceName, functionDeclarations, mode = 'wakeword', resumptionHandle }) {
  const vad = VAD_PRESETS[mode] || VAD_PRESETS.wakeword;
  const cfg = {
    responseModalities: ['AUDIO'],
    speechConfig: {
      voiceConfig: { prebuiltVoiceConfig: { voiceName } }
    },
    systemInstruction: { parts: [{ text: systemInstruction }] },
    thinkingConfig: { thinkingLevel: 'MINIMAL' },
    contextWindowCompression: {
      slidingWindow: {},
      triggerTokens: '80000'
    },
    realtimeInputConfig: {
      automaticActivityDetection: {
        silenceDurationMs: vad.silenceDurationMs,
        prefixPaddingMs: vad.prefixPaddingMs,
        startOfSpeechSensitivity: vad.startOfSpeechSensitivity,
        endOfSpeechSensitivity: vad.endOfSpeechSensitivity
      },
      // Default activityHandling is START_OF_ACTIVITY_INTERRUPTS; we leave it
      // as-is so barge-in works out of the box.
      turnCoverage: 'TURN_INCLUDES_ONLY_ACTIVITY'
    },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    sessionResumption: resumptionHandle ? { handle: resumptionHandle } : {},
    tools: functionDeclarations && functionDeclarations.length
      ? [{ functionDeclarations }]
      : undefined
  };
  return cfg;
}

module.exports = {
  LIVE_MODEL_ID,
  LIVE_MODEL_FALLBACK,
  KNOWN_VOICES,
  VAD_PRESETS,
  SESSION_RESUME_WINDOW_MS,
  buildLiveConfig
};
