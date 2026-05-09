// Transcript panel.
//
// Design:
//  * Append-only. A transcript line, once finalized, is never mutated.
//  * Per-role "live" row accumulates streaming transcription deltas during a
//    turn. `addDelta({from, delta, finished})` APPENDS the delta to the
//    currently-open row for that role. When `finished` is true the row is
//    promoted to final and the next delta for that role starts a new row.
//  * `turnBreak()` closes all live rows — called on `turn_complete` or
//    `interrupted`. Guarantees the next utterance always starts fresh.
//  * `add({from, text, final: true})` appends a completed system/tool/user
//    line in one shot (used for announcements, tool notes).
//  * `serialize()` returns the committed-final line list — used by the
//    cross-page sessionStorage handoff. Interim (still-streaming) rows are
//    intentionally NOT serialized; they get replayed via Gemini's resumed
//    turn history, not our local transcript.
//  * `hydrate({ lines })` restores previously-finalized rows in place so
//    the user sees a continuous conversation immediately on page load,
//    before the WS re-opens. `appendDivider(text)` renders a small muted
//    row that marks a session handoff (e.g. "Now on /carriers.html").
//
// Rationale: Gemini Live streams `inputAudioTranscription` and
// `outputAudioTranscription` as DELTAS. Each frame's `text` is a new
// fragment, not a running total. Prior implementation overwrote the row's
// textContent with each delta — looked like erasure. This version accumulates.

import { sanitizeAgentSpeechText } from './speech-text.js';

const BATCH_MS = 500;

export class TranscriptLog {
  constructor(rootEl) {
    this.root = rootEl;
    this.lines = [];
    this.pendingPost = [];
    this.timer = null;
    // Tracks the currently-open "live" row per role (user / agent).
    this.live = { user: null, agent: null };
  }

  /** Append a delta to the currently-open row for `from`, opening one if needed. */
  addDelta({ from, delta, finished = false }) {
    if (!this.root) return;
    const text = String(delta || '');
    if (!text) {
      if (finished) this._closeLive(from);
      return;
    }
    let row = this.live[from];
    if (!row) {
      row = this._makeLive(from);
      this.live[from] = row;
      this.root.appendChild(row.el);
    }
    row.buffer += text;
    if (from === 'agent') row.buffer = sanitizeAgentSpeechText(row.buffer);
    row.textEl.textContent = row.buffer;
    this._scrollBottom();
    if (finished) {
      this._closeLive(from);
      // Persist the final line for server-side logging.
      this._queuePost({ from, text: row.buffer, at: Date.now() });
    }
  }

  /** Close the live row for `from` (marks it final). */
  _closeLive(from) {
    const row = this.live[from];
    if (!row) return;
    row.el.dataset.interim = '0';
    row.textEl.classList.remove('is-interim');
    this.live[from] = null;
    this.lines.push({ from, text: row.buffer, final: true, at: Date.now() });
  }

  /** Close all live rows. Called on turn_complete / interrupted. */
  turnBreak() {
    this._closeLive('user');
    this._closeLive('agent');
  }

  /** Clear all interim rows (drop unfinished deltas). */
  dropLive() {
    for (const from of Object.keys(this.live)) {
      const row = this.live[from];
      if (row && row.el && row.el.parentNode) row.el.parentNode.removeChild(row.el);
      this.live[from] = null;
    }
  }

  /** Return the committed-final line array as a serialisable list.
   *  (Live/interim rows are intentionally excluded — see file header.) */
  serialize() {
    return this.lines.map((l) => ({
      from: l.from, text: l.text, at: l.at || Date.now()
    }));
  }

  /** Return the text of the last `n` finalized entries. */
  lastNFinals(n) {
    const out = [];
    for (let i = this.lines.length - 1; i >= 0 && out.length < n; i--) {
      if (this.lines[i].final && this.lines[i].text) {
        out.push(this.lines[i].text);
      }
    }
    return out;
  }

  /** Restore previously-finalized lines into the DOM. Call BEFORE the WS
   *  re-opens so the user sees continuity immediately. */
  hydrate({ lines }) {
    if (!this.root || !Array.isArray(lines) || !lines.length) return;
    for (const l of lines) {
      const text = String(l.text || '').trim();
      if (!text) continue;
      const from = (l.from === 'user' || l.from === 'agent' || l.from === 'tool')
        ? l.from : 'system';
      const el = this._makeStatic(from, text);
      el.classList.add('is-hydrated');
      this.root.appendChild(el);
      this.lines.push({ from, text, final: true, at: Number(l.at) || Date.now() });
    }
    this._scrollBottom();
  }

  /** Append a small muted divider row, used to mark a session handoff
   *  across page navigations — e.g. "Now on /carriers.html". */
  appendDivider(text) {
    if (!this.root) return;
    const el = document.createElement('div');
    el.className = 'voice-line voice-line--divider';
    el.setAttribute('role', 'separator');
    el.setAttribute('aria-orientation', 'horizontal');
    el.dataset.from = 'divider';
    const body = document.createElement('span');
    body.className = 'voice-line-text';
    body.textContent = String(text || '').trim();
    el.appendChild(body);
    this.root.appendChild(el);
    this._scrollBottom();
  }

  /** Dim the existing (pre-resume) rows. Used when upstream rejects
   *  resumption — the restored transcript is still visible but visually
   *  de-emphasised so the user sees "that conversation is cold now".
   *  Idempotent. */
  setPriorRowsDimmed(dimmed) {
    if (!this.root) return;
    const cls = 'is-stale';
    const rows = this.root.querySelectorAll('.voice-line.is-hydrated');
    rows.forEach((r) => r.classList.toggle(cls, !!dimmed));
  }

  /** Append a completed line (system announcement, tool note, etc). */
  add({ from, text }) {
    if (!this.root) return;
    const clean = String(text || '').trim();
    if (!clean) return;
    // If a live row for this role is open, close it first so we don't
    // interleave announcements into a streaming transcription.
    if (this.live[from]) this._closeLive(from);
    this.root.appendChild(this._makeStatic(from, clean));
    this.lines.push({ from, text: clean, final: true, at: Date.now() });
    this._scrollBottom();
    this._queuePost({ from, text: clean, at: Date.now() });
  }

  /** Purge the visible transcript. Server-side logs are untouched. */
  clearAll() {
    if (!this.root) return;
    this.root.replaceChildren();
    this.live.user = null;
    this.live.agent = null;
    this.lines = [];
  }

  _makeLive(from) {
    const el = document.createElement('div');
    el.className = 'voice-line';
    el.dataset.from = from;
    el.dataset.interim = '1';
    const tag = document.createElement('span');
    tag.className = 'voice-line-tag';
    tag.textContent = this._tagFor(from);
    const body = document.createElement('span');
    body.className = 'voice-line-text is-interim';
    el.appendChild(tag);
    el.appendChild(body);
    return { el, textEl: body, buffer: '' };
  }

  _makeStatic(from, text) {
    const el = document.createElement('div');
    el.className = 'voice-line';
    el.dataset.from = from;
    el.dataset.interim = '0';
    const tag = document.createElement('span');
    tag.className = 'voice-line-tag';
    tag.textContent = this._tagFor(from);
    const body = document.createElement('span');
    body.className = 'voice-line-text';
    body.textContent = text;
    el.appendChild(tag);
    el.appendChild(body);
    return el;
  }

  _tagFor(from) {
    if (from === 'user') return 'You';
    if (from === 'agent') return 'Jarvis';
    if (from === 'tool') return 'Tool';
    return 'System';
  }

  _scrollBottom() {
    if (!this.root) return;
    this.root.scrollTop = this.root.scrollHeight;
  }

  _queuePost(line) {
    this.pendingPost.push(line);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this._flushPost();
    }, BATCH_MS);
  }

  async _flushPost() {
    const batch = this.pendingPost.splice(0);
    for (const line of batch) {
      try {
        await fetch('/api/transcript', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: line.from, text: line.text, at: line.at })
        });
      } catch { /* offline, drop */ }
    }
  }
}
