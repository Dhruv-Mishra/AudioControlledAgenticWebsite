// Captions overlay — bottom-center strip showing the last 1–2 lines of
// agent speech. Visible when the user's transcript mode is 'captions'.
// Auto-fades 3 s after `turn_complete`.
//
// Source of truth for visibility: voice-agent event stream
//   - transcript_delta / agent addDelta → append / replace live text
//   - turn-complete → start auto-fade timer
//
// Tool handler:
//   set_captions({enabled}) → flips transcript mode to 'captions' or 'off'
//   (unless 'full' is active — leaves 'full' alone).

import { sanitizeAgentSpeechText } from './speech-text.js';

const AUTO_FADE_MS = 3000;
const MAX_CHARS = 300;

let root = null;
let textEl = null;
let fadeTimer = null;
let currentText = '';
// Set when `onTurnComplete` fires; the next non-empty delta starts a
// fresh caption (prevents the new turn's text from concatenating onto
// the previous turn during the 3 s fade window).
let turnEnded = false;

function ensureMount() {
  if (root) return root;
  root = document.createElement('div');
  root.className = 'voice-captions';
  root.id = 'jarvis-captions';
  root.setAttribute('data-agent-id', 'captions.overlay');
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');
  root.hidden = true;
  textEl = document.createElement('span');
  textEl.className = 'voice-captions-text';
  root.appendChild(textEl);
  document.body.appendChild(root);
  return root;
}

function clearFade() {
  if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
}

function show() {
  if (!root) return;
  root.hidden = false;
  // Force reflow before toggling class so the transition runs.
  void root.offsetWidth;
  root.classList.add('is-visible');
}

function hide() {
  if (!root) return;
  root.classList.remove('is-visible');
  // Keep hidden attribute in sync once the fade is done.
  setTimeout(() => {
    if (!root) return;
    if (!root.classList.contains('is-visible')) root.hidden = true;
  }, 200);
}

function setText(text) {
  currentText = text;
  if (!textEl) return;
  // Truncate by chars to keep strip readable.
  const clamped = text.length > MAX_CHARS
    ? '…' + text.slice(text.length - MAX_CHARS)
    : text;
  textEl.textContent = clamped;
}

/** Controller API — called by voice-agent wiring. */
export function appendAgentDelta(delta, { finished = false } = {}) {
  if (!root) ensureMount();
  clearFade();
  if (typeof delta !== 'string' || !delta) {
    if (finished) scheduleFade();
    return;
  }
  // First delta after a turn break starts a fresh caption — don't
  // bleed the previous turn's text into the new one.
  if (turnEnded) {
    turnEnded = false;
    currentText = '';
  }
  setText(sanitizeAgentSpeechText(currentText + delta));
  show();
  if (finished) scheduleFade();
}

export function onTurnComplete() {
  turnEnded = true;
  scheduleFade();
}

function scheduleFade() {
  clearFade();
  fadeTimer = setTimeout(() => {
    hide();
    currentText = '';
    if (textEl) textEl.textContent = '';
  }, AUTO_FADE_MS);
}

/** Called when the user flips transcript mode to captions/off. Makes sure
 *  the overlay is mounted (captions) or hidden (off/full). */
export function setEnabled(enabled) {
  ensureMount();
  if (!enabled) {
    clearFade();
    hide();
    currentText = '';
    if (textEl) textEl.textContent = '';
  }
}

/** Reset state — call on end-call so stale text doesn't flash next call. */
export function reset() {
  clearFade();
  currentText = '';
  turnEnded = false;
  if (textEl) textEl.textContent = '';
  hide();
}

/** Soft reset on route change — clears any in-flight caption text so a
 *  new page doesn't inherit half a sentence from the previous page, and
 *  cancels any pending fade. Keeps the overlay element mounted; the
 *  next agent-delta will re-show it. Distinct from `reset()` which is
 *  also intended for end-of-call. */
export function resetForRouteChange() {
  clearFade();
  currentText = '';
  turnEnded = false;
  if (textEl) textEl.textContent = '';
  hide();
}

export function init(voiceAgent) {
  ensureMount();
  if (!voiceAgent) return;
  // Listen for agent text deltas. The agent dispatches 'state' and
  // 'turn-complete' events; we bolt onto the transcript delta via the
  // transcript object is not directly available, so we listen to the
  // voice-agent-dispatched events instead.
  voiceAgent.addEventListener('agent-delta', (ev) => {
    const d = ev.detail || {};
    appendAgentDelta(d.text || '', { finished: !!d.finished });
  });
  voiceAgent.addEventListener('turn-complete', () => onTurnComplete());
  voiceAgent.addEventListener('call-ended', () => reset());
  // Cross-page: clear stale captions when the SPA router swaps the
  // page underneath us. Without this, the next turn's deltas would
  // concatenate onto whatever was already on screen.
  if (typeof window !== 'undefined' && window.__router && typeof window.__router.addEventListener === 'function') {
    window.__router.addEventListener('route-change', () => resetForRouteChange());
  } else if (typeof window !== 'undefined') {
    // Router may not yet be attached at init time; fall back to the
    // history event so we still cover popstate.
    window.addEventListener('popstate', () => resetForRouteChange());
  }
}

export function mount() { return ensureMount(); }
