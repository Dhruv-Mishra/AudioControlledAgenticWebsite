// Round-6 smoke stub: replaces @google/genai live.connect with a
// harness-controlled fake. Logs sendRealtimeInput calls to stdout and
// — when the bridge fires a greeting text — simulates Gemini producing
// audio + transcript + turn_complete frames by invoking the bridge's
// `onmessage` callback. The harness uses file sentinels to drive two
// phases independently:
//
//   sentinel `.setup` → fire the first `onmessage` (no content) to
//     unblock the bridge's `upstreamSetupComplete` gate.
//
// Separately, when the bridge calls `sendRealtimeInput({text})` — the
// greeting fire — we respond ~20 ms later with a simulated modelTurn
// containing a short audio chunk + output transcript + turn_complete.
// This lets the test assert that the CLIENT does not see those frames
// until it sends `audio_prelude_ended`.
//
// Loaded via `node -r evals/_greet-gating-stub.js server.js`.
'use strict';
const Module = require('module');
const path = require('path');
const origRequire = Module.prototype.require;
const SENTINEL_SETUP = path.resolve(__dirname, '_greet-gating-stub.setup');

Module.prototype.require = function patched(id) {
  if (id === '@google/genai') {
    const real = origRequire.apply(this, arguments);
    const RealClass = real.GoogleGenAI;
    class PatchedGenAI {
      constructor(opts) {
        this._real = new RealClass(opts);
        this.live = {
          connect: async (cfg) => {
            process.stdout.write('[SMOKE-STUB] live.connect requested\n');
            const callbacks = (cfg && cfg.callbacks) || {};

            // Fire a fake onmessage with a modelTurn (audio chunk +
            // transcript) followed by turnComplete. Invoked when the
            // bridge calls sendRealtimeInput({text}) — simulating
            // Gemini generating the greeting.
            const simulateGreetingResponse = () => {
              setTimeout(() => {
                if (!callbacks.onmessage) return;
                process.stdout.write('[SMOKE-STUB] simulating greeting audio+transcript\n');
                // 1. audio chunk (modelTurn.parts[].inlineData.data)
                const fakePcm = Buffer.alloc(800, 0x42);  // 800 bytes of dummy PCM
                callbacks.onmessage({
                  serverContent: {
                    modelTurn: {
                      parts: [{
                        inlineData: { data: fakePcm.toString('base64'), mimeType: 'audio/pcm;rate=24000' }
                      }]
                    }
                  }
                });
                // 2. output transcription
                callbacks.onmessage({
                  serverContent: {
                    outputTranscription: { text: 'Hi! This is Jarvis.', finished: true }
                  }
                });
                // 3. turn complete
                callbacks.onmessage({ serverContent: { turnComplete: true } });
                process.stdout.write('[SMOKE-STUB] greeting turn_complete dispatched\n');
              }, 20);
            };

            const fakeSession = {
              sendRealtimeInput(arg) {
                const kind = arg && arg.text ? 'text'
                  : (arg && arg.audio ? 'audio'
                    : (arg && arg.audioStreamEnd ? 'audioStreamEnd' : 'unknown'));
                const textPreview = arg && arg.text
                  ? String(arg.text).slice(0, 80).replace(/\n/g, ' ')
                  : '';
                process.stdout.write(
                  '[SMOKE-STUB] sendRealtimeInput kind=' + kind +
                  (textPreview ? ' text="' + textPreview + '..."' : '') + '\n'
                );
                // When the bridge injects the greeting text, simulate
                // Gemini's response turn. This is what the client
                // should see queued in the pre-greet buffer.
                if (kind === 'text' && arg.text && String(arg.text).includes('<call_initiated>')) {
                  simulateGreetingResponse();
                }
              },
              sendClientContent() {
                process.stdout.write('[SMOKE-STUB] sendClientContent called (should NOT happen on 3.1)\n');
              },
              sendToolResponse() {
                process.stdout.write('[SMOKE-STUB] sendToolResponse called\n');
              },
              close() {
                process.stdout.write('[SMOKE-STUB] close called\n');
                if (callbacks.onclose) setImmediate(() => callbacks.onclose({ code: 1000, reason: 'smoke-stub-close' }));
              }
            };

            // Harness triggers the fake "setup_complete" by touching
            // SENTINEL_SETUP. We poll every 50 ms.
            const fireSetup = () => {
              try { require('fs').unlinkSync(SENTINEL_SETUP); } catch (_) {}
              if (callbacks.onmessage) {
                process.stdout.write('[SMOKE-STUB] firing first onmessage (setup_complete)\n');
                // Empty payload — bridge treats any onmessage as setup OK.
                callbacks.onmessage({ serverContent: {} });
              }
            };
            const poll = setInterval(() => {
              try {
                if (require('fs').existsSync(SENTINEL_SETUP)) {
                  clearInterval(poll);
                  fireSetup();
                }
              } catch (_) {}
            }, 50);
            if (callbacks.onopen) setImmediate(() => callbacks.onopen());
            return fakeSession;
          }
        };
      }
    }
    return Object.assign({}, real, { GoogleGenAI: PatchedGenAI });
  }
  return origRequire.apply(this, arguments);
};
