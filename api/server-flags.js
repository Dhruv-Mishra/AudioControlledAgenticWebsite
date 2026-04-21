'use strict';

/**
 * Runtime feature flags. Read ONCE at server start (env vars are static).
 * Exposed to the browser via /api/config so the client honours the same
 * matrix without a code change.
 *
 * Env var parsing uses strict-boolean semantics:
 *   - "true" / "1" / "yes" / "on"  → true
 *   - "false" / "0" / "no" / "off" / undefined / "" → false
 *   - Anything else → the supplied default.
 *
 * Defaults:
 *   - GEMINI_TRANSCRIPTION=false  (save credits; client falls back to local
 *                                  Web Speech API for the user side when
 *                                  SHOW_TEXT=true).
 *   - SHOW_TEXT=true              (transcript panel + tool args visible).
 *
 * The matrix honoured end-to-end (see deploy/README.md § Env vars):
 *
 *   | GEMINI_TRANSCRIPTION | SHOW_TEXT | Transcripts shown | Source       | Server logs text |
 *   |---|---|---|---|---|
 *   | false | true  | yes | local Web Speech (user-side) | yes |
 *   | false | false | no  | —                            | no  |
 *   | true  | true  | yes | Gemini (both sides)          | yes |
 *   | true  | false | no  | —                            | no  |
 */

function parseBool(raw, fallback) {
  if (raw == null) return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === 'off' || v === '') return false;
  return fallback;
}

// Snapshot once — env vars are read-only at runtime.
const GEMINI_TRANSCRIPTION = parseBool(process.env.GEMINI_TRANSCRIPTION, false);
const SHOW_TEXT = parseBool(process.env.SHOW_TEXT, true);

// Boot-time summary so ops can see exactly what the process is honouring.
process.stdout.write(
  `[server-flags] GEMINI_TRANSCRIPTION=${GEMINI_TRANSCRIPTION} SHOW_TEXT=${SHOW_TEXT}\n`
);

module.exports = { GEMINI_TRANSCRIPTION, SHOW_TEXT, parseBool };
