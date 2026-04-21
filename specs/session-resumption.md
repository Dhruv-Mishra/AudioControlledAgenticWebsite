# Cross-Page Session Resumption

How "Jarvis" keeps a single continuous conversation alive as the user clicks
between pages (`/`, `/carriers.html`, `/negotiate.html`, `/contact.html`). No
SPA router. No shared database. Just `sessionStorage` + the Gemini Live
`sessionResumption` handle, wired into the existing `hello` handshake.

## Problem

Each page is a fresh full document load. Before this change, each load:
- opened a new `ai.live.connect()` upstream,
- started with an empty transcript,
- made the model forget everything it had been told earlier in the tab.

The user experienced this as Jarvis forgetting their name the moment they
clicked a nav link.

## Scope

**In scope:** surviving navigation inside the same tab (common demo flow).
**Out of scope:** cross-tab, cross-device, post-refresh *after* window close,
persistence to server / DB, and SPA routing.

## Architecture

```
  ┌──── Page A (e.g. /) ─────────────────┐
  │ VoiceAgent                           │
  │  ─ captures handle from server       │
  │  ─ on `pagehide` → writes blob       │
  └───────────┬──────────────────────────┘
              │  sessionStorage['jarvis.session']
              ▼
  ┌──── Page B (e.g. /carriers.html) ────┐
  │ VoiceAgent                           │
  │  ─ reads blob BEFORE WS opens        │
  │  ─ hydrates transcript + divider     │
  │  ─ sends hello { resumeHandle, ... } │
  └───────────┬──────────────────────────┘
              │  WS text frame
              ▼
  ┌──── /api/live bridge ────────────────┐
  │ attach()                             │
  │  ─ validates handle age              │
  │  ─ openUpstream({ explicitHandle })  │
  └───────────┬──────────────────────────┘
              │  ai.live.connect({ sessionResumption: { handle } })
              ▼
         Gemini Live
```

## sessionStorage schema

Key: `jarvis.session`

```jsonc
{
  "handle": "string — last SessionResumptionUpdate.newHandle",
  "handleIssuedAt": 1744300000000,       // ms timestamp when we captured it
  "mode": "wakeword" | "live",
  "persona": "professional" | ...,
  "muted": false,
  "compression": true,                   // phone-line bandpass ON by default
  "noise": "off" | "phone" | "office" | "static",
  "noiseVolume": 0.15,                   // 0.0 – 1.0
  "lastPath": "/",                       // previous pathname; used to render
                                         //   "Now on /carriers.html" divider
  "transcript": [                        // committed-final rows only
    { "from": "user",  "text": "...", "at": 1744... },
    { "from": "agent", "text": "...", "at": 1744... }
  ]
}
```

Interim (still-streaming) transcript rows are intentionally NOT persisted.
They get replayed via Gemini's resumed turn history if resumption succeeds;
otherwise they'd be a lie-by-omission showing a half-sentence that the
model can't continue.

### Caps

- `MAX_PERSISTED_TRANSCRIPT_LINES = 120`
- `MAX_PERSISTED_TRANSCRIPT_BYTES = 80 * 1024` (80 KB — well under the
  ~5 MB sessionStorage quota; writes are bounded + truncated tail-first).

## TTLs & constants

| Constant | Value | Defined in | Meaning |
|---|---|---|---|
| `SESSION_RESUME_WINDOW_MS` | 10 min | `api/gemini-config.js` | Server-side cap on how old an incoming `resumeHandle` can be before we drop it. |
| `RESUME_WINDOW_MS` | 10 min | `js/voice-agent.js` (exported) | Client-side cap — same number, checked independently in case the server's own check drifts. |
| `IDLE_EXPIRY_MS` | 10 min | `js/voice-agent.js` (exported) | Cap on "last activity" before the sessionStorage blob is pruned on next read. |

**Why 10 minutes?** Gemini does not publicly document a TTL on
`SessionResumptionConfig.handle`. 10 minutes matches typical "tab-idle →
user returns" lifetimes in the demo, is well short of anything a prompt-cache
or session cookie would pin, and leaves a clean ceiling: if a user leaves
longer than that, we'd rather start fresh (cold-open) than stall on a dead
handle. If Google later publishes a formal TTL that's shorter than 10 min,
lower both constants to match.

## Wire protocol

### Client → Server

The hello envelope is extended with two optional fields:

```
{
  "type": "hello",
  "persona": "professional",
  "elements": [ ... ],
  "page": "/carriers.html",
  "mode": "wakeword" | "live",
  "userAgent": "...",
  "resumeHandle": "<handle>",               // optional, from sessionStorage
  "resumeHandleIssuedAt": 1744300000000     // optional; server enforces age
}
```

A new client → server message type is introduced:

```
{
  "type": "page_context",
  "page": "/carriers.html",
  "title": "Carrier Directory",
  "elements": [ { "id": "carriers.card.C-101", "label": "Liberty Freight" }, ... ]
}
```

The browser emits this once per page load, after the server reports
`setup_complete` (LIVE_READY state in the client's state machine).

### Server → Client

Three new message types are sent, all optional:

```
{ "type": "session_resumption",   "handle": "<newHandle>" }
// Emitted every time Gemini sends sessionResumptionUpdate with a new
// handle. The browser overwrites its in-memory handle + persists on next
// turn-complete / page-hide.

{ "type": "session_resumed",      "handle": "<handle>" }
// Emitted EXACTLY ONCE per session, the first time we receive a
// resumption-update after connecting WITH an explicit handle and the
// upstream reports resumable=true (default).

{ "type": "session_resume_failed", "reason": "upstream_not_resumable" }
// Emitted instead of session_resumed when upstream returns resumable=false.
// Browser dims the restored transcript rows and clears its handle.
```

### `hello_ack` additions

```
{
  "type": "hello_ack",
  ...,
  "resumeRequested": true,          // whether server saw a handle in hello
  "resumeWindowMs": 600000
}
```

## Server-side behaviour

See `api/live-bridge.js`:

1. On `hello`, validate the incoming handle: non-empty string, ≤ 8 KB,
   `issuedAt` within `SESSION_RESUME_WINDOW_MS` of now (or absent — trust
   the browser's own window check).
2. Pass the handle to `buildLiveConfig({ resumptionHandle })` which populates
   `sessionResumption: { handle }` in the SDK config.
3. Remember `attemptedResumeHandle` so we can emit `session_resumed` vs
   `session_resume_failed` when the first `sessionResumptionUpdate` arrives.
4. On each `sessionResumptionUpdate.newHandle`, forward `session_resumption`
   with the new handle; the client persists it.
5. On `page_context`, build a `<page_context>…</page_context>` delimited
   block and inject it via `upstream.sendClientContent({ turns, turnComplete: true })`.
   Guarded: drops silently if upstream is not yet `setupComplete`.

## Client-side behaviour

See `js/voice-agent.js` + `js/stt-logger.js`:

1. Constructor reads + validates `sessionStorage['jarvis.session']`:
   - Age > `IDLE_EXPIRY_MS` → wipe, start fresh.
   - Handle age > `RESUME_WINDOW_MS` → blob kept but handle dropped.
2. Restored state applied BEFORE first DOM render (prevents flash of
   hardcoded defaults): mode, persona, muted, compression, noise mode,
   noise volume, transcript.
3. `TranscriptLog.hydrate({ lines })` appends prior rows. If the previous
   `lastPath` differs from the current pathname, `appendDivider("Now on /…")`
   inserts a slim muted separator.
4. WS opens. Hello includes `resumeHandle` + `resumeHandleIssuedAt` if
   present.
5. On `setup_complete`, if `_prevPathname !== location.pathname`, send one
   `page_context` message. `pageContextInjected` flag prevents re-fires
   across persona switches on the same page.
6. On `session_resumed`, un-dim hydrated rows (no-op if they weren't
   dimmed — they're not dimmed by default). Set `resuming = false`.
7. On `session_resume_failed`, dim hydrated rows, clear handle, keep the
   visible transcript. Next turn starts a fresh context but the user still
   sees their prior history.
8. On `pagehide` / `beforeunload`, serialize the current state to
   sessionStorage. Also persist on every `turn_complete` so an unexpected
   close loses at most one turn.
9. `clearTranscript()` wipes both the DOM rows AND the sessionStorage blob
   so the next page load is genuinely cold.

## Fallback behaviour

| Failure mode | Result |
|---|---|
| No blob in sessionStorage | Cold-open. No divider. No hydration. Behaves exactly as before. |
| Blob present but handle older than window | Blob is kept (to restore prefs/transcript) but no `resumeHandle` is sent. Server opens a fresh session. Transcript remains hydrated (un-dimmed) because the user's conversation is still theirs to read, even if the model has forgotten. |
| Server returns `session_resume_failed` | Client dims hydrated rows (`.voice-line.is-hydrated.is-stale`). Subsequent turns run on a fresh session. |
| Persona or mode switch | Handle is cleared. Session config changes (voice, VAD), so the handle is meaningless. Comment: this matches `api/live-bridge.js`'s existing behaviour on `persona` / `set_mode` messages (no-handle reopen). |
| QuotaExceeded on sessionStorage write | Blob is pruned: we keep metadata (handle, prefs) and drop the transcript. Next page load shows a fresh transcript panel. |

## SDK method choice

We use `session.sendClientContent({ turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true })`.

Alternatives considered:
- `session.sendRealtimeInput({ text })` — in `@google/genai@1.50.1` the
  realtime-input path is designed for audio + media chunks and VAD. Text
  *is* supported by the SDK but the canonical Node example
  (`gemini-live-api-examples/command-line/node/main.mts`) uses
  `sendClientContent` for anything that needs a deterministic turn-end.
- `session.sendText(text)` — not present in the Node SDK's `Session` type
  (confirmed by grep over `node_modules/@google/genai/dist/genai.d.ts`).
  This is a browser-raw-WS helper in the ephemeral-tokens example's
  `geminilive.js`, not the SDK.

`sendClientContent` with `turnComplete: true` is the right call: the text
is a normal "user turn" from the model's perspective, the SDK wraps the
`Content` for us, and the Live API responds to it the way it would any
other user turn (which is what we want — a short acknowledgement).

## Observability

Server (DEBUG=1):
```
[live <sid>] hello persona=professional mode=wakeword page=/carriers.html elements=18 resume=yes
[live <sid>] upstream connect requested model=gemini-3.1-flash-live-preview voice=Kore persona=professional mode=wakeword resume=yes
[live <sid>] session_resumption handle updated len=312
[live <sid>] session_resumed OK (handle honoured by upstream)
[live <sid>] page_context_injected page=/carriers.html elements=18 textLen=1124
```

Client (`?debug=1`):
```
[jarvis] ws onopen, sending hello mode=wakeword resume=yes
[jarvis] server msg hello_ack
[jarvis] server msg session_resumption
[jarvis] setup_complete
[jarvis] session_resumed — conversation continued
[jarvis] inject page_context page=/carriers.html elements=18
```

## Verification

### Automated

`npm run smoke:session-resume` — 4 phases, all against an invalid key
(tests the wire protocol, not Gemini itself):
1. Fresh hello (no handle) → server logs `resume=no`.
2. Hello WITH fresh handle → server logs `resume=yes` and passes it to
   `ai.live.connect`.
3. Hello WITH stale handle → server logs `hello resumeHandle dropped`
   and then `resume=no`.
4. `page_context` message while upstream isn't ready → server logs
   `page_context ignored — upstream not ready` (proves the handler is
   wired and guards correctly).

All 4 existing smoke tests still pass (`npm run smoke:invalid-key`,
`smoke:upstream-handshake`, `smoke:browser-sim`, `smoke:live-mode`).

### Manual

1. Open `/` with a valid `GEMINI_API_KEY` set.
2. Say: "My name is Skyler. Remember that."
3. Wait for Jarvis to acknowledge.
4. Click the **Carriers** nav link.
5. After the page loads (prior transcript visible, divider "Now on
   /carriers.html", audio glyphs active), say: "What did I say my name
   was?"
6. Jarvis should answer "Skyler" (or equivalent).

If step 6 returns a blank / generic answer: resumption is not actually
wired end-to-end. Re-read `api/live-bridge.js :: openUpstream` and
confirm `sessionResumption: { handle }` is making it into the upstream
config.
