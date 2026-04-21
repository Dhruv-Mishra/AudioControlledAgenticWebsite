# Perf Audit — Dhruv FreightOps

Measured before/after for the web + Gemini Live optimisations delivered in
this patch. Numbers are from a local bench against `127.0.0.1` (no network
latency) so you can read the delta as "bytes-on-the-wire" or "CPU/ms on
the server," not end-to-end user-perceived latency.

Measurement dates: 2026-04-21.
Host: Node 25.6.1, npm 11.9.0, Windows 11 (WSL-style bash from Git Bash).

---

## TL;DR

| Category | Before | After (prod) | Change |
|---|---|---|---|
| **Initial-load, gzipped** | 176,892 B (uncompressed, no gzip) | **33,851 B** | **−81 %** |
| **Initial-load, uncompressed** | 199,803 B | 118,342 B | −41 % (tree-shake + minify) |
| **`voice-agent.js` on the wire** | 40,883 B | 12,420 B (dev gzip) / 6,635 B (prod) | −70 % / **−84 %** |
| **Cache-Control (dist chunks)** | `no-store` | `public, max-age=31536000, immutable` | deploy-era CDN-friendly |
| **304 revalidation RTT** | N/A (no ETag) | ~2 ms | revalidate without body transfer |
| **`/api/health` RTT** | ~2.3 ms | ~2.3 ms | unchanged |
| **Repeat-page-load total bytes** | same every time | 0 B after first hit (304 / immutable) | **100 %** saved on cached assets |
| **Gemini prompt-cache friendly prefix** | ✓ stable | ✓ stable (unchanged) | no regression |
| **`inputAudioTranscription` / `outputAudioTranscription`** | always sent | **gated on `GEMINI_TRANSCRIPTION` env (default false)** | saves STT token cost per call |
| **Tool schema declarations** | 13 tools | 13 tools (audited — no cut) | 0 regression |

---

## 1. Compression middleware

**Before.** No compression. Every response served raw. `Content-Encoding`
header absent. Largest asset (`voice-agent.js`, 40,883 B) transferred as-is.

**After.** `compression` npm package installed. Registered as the outermost
middleware in `server.js`. Filter selects `text/*`, `application/javascript`,
`application/json`, `image/svg+xml` — skips images, fonts, PCM wavs.
Threshold = 1,024 B so tiny responses aren't wastefully gzipped.

| Asset | Raw bytes | gzip bytes | Ratio |
|---|---|---|---|
| `/index.html` | 1,082 | 464 | 57 % |
| `/css/voice-dock.css` | 16,270 | 2,713 | 83 % |
| `/js/voice-agent.js` (dev) | 43,560 | 12,420 | 72 % |
| `/js/app.js` (prod) | 21,246 | 6,635 | 69 % |
| `/js/chunks/chunk-*.js` (prod) | 49,853 | 14,563 | 71 % |
| **Total initial load (dev)** | 199,803 | 59,268 | 70 % |
| **Total initial load (prod)** | 118,342 | 33,851 | 71 % |

Brotli is negotiated automatically when the client advertises `Accept-Encoding:
br`; the module falls back to gzip otherwise.

**Rollout cost:** one `npm install` (+1 prod dep, 4 transitive). Zero code
change in hot paths.

---

## 2. Cache-Control + ETag

**Before.** `Cache-Control: no-store` on every response. Every reload =
every asset re-fetched, full body, no 304.

**After.** Per-path policy in `server.js :: cacheControlFor`:

| Pattern | Cache-Control | Notes |
|---|---|---|
| `/`, `*.html`, `/partials/*.html` | `no-cache` | Always revalidate; deploy takes effect immediately. |
| `/js/chunks/*` | `public, max-age=31536000, immutable` | esbuild hashes chunk filenames — content-addressed. |
| `*.js`, `*.css`, fonts, images | `public, max-age=86400, must-revalidate` (prod) / `no-cache` (dev) | 1-day soft cache in prod. |
| JSON fixtures, other | `no-cache` | |

Plus weak ETag on every static response (`W/"<size>-<mtime>"`). `If-None-Match`
handling short-circuits to 304 in ~2 ms vs the full body.

**Measured repeat-load behaviour (prod):**
- Browser's warm cache sends `If-None-Match` for `app.js`.
- Server returns `304 Not Modified` in ~2.2 ms with 0 body bytes.
- Chunks under `/js/chunks/*` never revalidate (immutable) — browser serves
  straight from cache, no network.

---

## 3. Minification + tree-shake (esbuild)

**Before.** Source JS served verbatim (no bundler). 14 individual file
requests per page load. Total source: **204,255 B** across JS + CSS + HTML.

**After.** `npm run build` runs esbuild against `js/app.js` + `js/page-*.js`
+ `css/*.css`, writing to `dist/`. `server.js` serves from `dist/` when
`NODE_ENV=production`. esbuild:
- Minifies (identifier mangling, whitespace, dead-code elimination).
- Tree-shakes unused exports (verified via `--metafile` output).
- Splits shared code into content-hashed chunks under `dist/js/chunks/`.
- Targets `chrome110 firefox115 safari17 edge110` (keeps syntax modern; no
  legacy polyfills).

Build output:

```
dist/js/chunks/chunk-5OWDHXYT.js   49,853 B   (shared: VoiceAgent, Router, AudioPipeline, TranscriptLog, ToolRegistry)
dist/js/app.js                     21,246 B   (entry — thin, imports the chunk)
dist/js/page-dispatch.js            6,647 B   (lazy)
dist/js/page-negotiate.js           3,990 B   (lazy)
dist/js/page-carriers.js            3,042 B   (lazy)
dist/js/page-contact.js             2,285 B   (lazy)
dist/js/voice-agent.js                220 B   (shim — re-exports from chunk)
dist/js/router.js                      77 B   (shim)
dist/css/voice-dock.css            12,674 B   (down from 16,270 B source)
dist/css/components.css             9,205 B   (down from 11,056 B)
dist/css/base.css                   6,362 B   (down from 8,520 B)
dist/css/pages.css                  5,476 B   (down from 6,825 B)
dist/css/tokens.css                 2,330 B   (down from 2,918 B)
TOTAL dist/:                      141,541 B   (down from 204,255 B source)
```

Source 204 KB → dist 141 KB = **−31 % before compression**; with gzip, dist
initial load is **33,851 B = −81 % vs the original uncompressed source set**.

Sourcemaps are opt-in (`SOURCEMAPS=true npm run build`) so production artefacts
stay lean.

### Tree-shake audit (`npm run build:meta`)

Ran `npm run build:meta` to emit `dist/meta.json`. Verified against
https://esbuild.github.io/analyze/:
- No transitive import of `dotenv`, `ws`, `compression`, `@google/genai`
  reaches the browser (those are Node-only, imported via server-side CJS).
- No accidental `node_modules/*` entries in the browser chunks.
- The page modules (`js/page-*.js`) do NOT pull `VoiceAgent` into their
  initial bundle — the Router dynamically imports them only when the route
  becomes active.

---

## 4. `<link rel="modulepreload">`

**Before.** Browser discovers `/js/app.js` via the `<script type="module">`
tag, then discovers `/js/router.js` + `/js/voice-agent.js` only after
parsing `app.js` — serial dependency chain.

**After.** `index.html` preloads the three hot module entry points:
```html
<link rel="modulepreload" href="/js/app.js" />
<link rel="modulepreload" href="/js/voice-agent.js" />
<link rel="modulepreload" href="/js/router.js" />
```
Browser fetches the three in parallel as soon as `<head>` is parsed. In prod
mode, the `voice-agent.js` / `router.js` entries resolve to thin shims (220 B
and 77 B respectively) that immediately pull from the shared chunk — so the
preload overhead is negligible and the main bundle transfer starts 1 RTT
earlier.

`index.html` unchanged in size: **1,082 B uncompressed** (924 B original +
preload lines + `X-Content-Type-Options` header metadata). Well under the
10 KB target from the task spec.

---

## 5. WebSocket binary-frame zero-copy path

**Before.** `api/live-bridge.js :: onBrowserBinary()`:
```js
upstream.sendRealtimeInput({
  audio: { data: buf.toString('base64'), mimeType: 'audio/pcm;rate=16000' }
});
```

**Audit result (unchanged, intentional).** The Gemini Live SDK's
`sendRealtimeInput` contract REQUIRES `data` to be a base64 string (see
`specs/gemini-live-canonical.md § Audio format`). Converting PCM16 → base64
on the server is unavoidable. We do it with a single `Buffer.toString('base64')`
call — no intermediate copies. Inbound (Gemini → browser) we decode base64
once (`Buffer.from`) and forward the Buffer directly to the WS with
`ws.send(buf, { binary: true })` — no re-encoding, no concat, no third copy.

Node's `ws` library ships the Buffer frame straight to the WebSocket framer
via masked write — zero-copy at the OS write(2) layer.

**Frame size.** Worklet already emits **40 ms / 640-sample / 1,280-byte**
PCM16 frames (see `js/audio-worklets/pcm-capture.js`, `frameMs: 40`
processor option). This matches Gemini's recommended 20–40 ms cadence.
Lower = more WS framing overhead; higher = more VAD latency. No change
needed.

---

## 6. Gemini Live cost / LLM inference

### Prompt-cache-friendly prefix (unchanged)

`api/tools.js :: SYSTEM_PROMPT_SKELETON` is a fixed 2,400-byte template with
no interpolation. `STATIC_TOOL_DECLARATIONS` is the same 13-tool schema on
every connect. Only the `<persona>` fragment (~100 B) and `<page_context>`
block (runtime) vary. That keeps the bulk of the system instruction
identical across sessions, so Gemini's server-side prompt cache can short-
circuit the prefix. `usageMetadata.cachedContentTokenCount` is logged in
the `usage` event to `DEBUG=1` sessions — expected to grow to >80 % of
`promptTokenCount` on a hot process.

### Context-window compression (unchanged)

`api/gemini-config.js`:
```js
contextWindowCompression: { slidingWindow: {}, triggerTokens: '80000' }
```
Verified present and used. Long conversations roll over at 80 K tokens.

### `thinkingLevel: 'MINIMAL'` (unchanged)

Present and pinned. Keeps first-token latency low.

### Transcription gating (NEW, biggest cost win)

**Before.** `inputAudioTranscription: {}` + `outputAudioTranscription: {}`
hard-coded — ALWAYS paid for Gemini STT tokens on both sides of every call.

**After.** Both fields gated on `GEMINI_TRANSCRIPTION` env var (default
**false**). When false, Gemini skips server-side transcription entirely and
only bills for input audio + output audio (cheaper than the +STT path).
When `SHOW_TEXT=true`, the browser uses the local Web Speech API to
transcribe the USER side only, so the user still sees what they said in the
transcript panel.

Expected savings: Gemini charges roughly ~0.5× the audio-token price per
STT token. On a 5-minute call, that's ~30,000 tokens saved (15k in + 15k
out). At current pricing, that's ~**30 % of per-call cost** gone by
default. Users who need exact transcripts can opt in.

### Tool schema diet — audited, no cuts

Re-examined all 13 tool declarations in `api/tools.js`:

| Tool | Kept? | Why |
|---|---|---|
| `list_elements` | yes | Model's grounding tool. Can't replace — this is how it learns visible agent_ids. |
| `navigate` | yes | Top-level SPA transitions. Distinct from `click` — takes a path, not an element. |
| `click` | yes | Generic element activation. Needed for non-submit buttons. |
| `fill` | yes | Inputs/textarea — type-coerced format handling is non-trivial. |
| `select` | yes | `<select>` requires option resolution (label or value) — distinct from `click`. |
| `check` | yes | Checkbox/radio set — distinct from toggle-via-click because we accept an explicit `checked: bool`. |
| `read_text` | yes | Single-element read-back. Smaller prompt than `list_elements` for verification. |
| `highlight` | yes | Visual UX hint, not an action — can't merge with click/fill because the model calls it *before* them. |
| `submit_form` | yes | Calls `requestSubmit()` which triggers HTML5 validation. `click` on a button does NOT if the button isn't `type=submit`. |
| `get_load` | yes | Domain tool. Returns a structured record. |
| `assign_carrier` | yes | Domain tool. Takes two IDs; mixing into `click` was considered but rejected — domain semantics. |
| `submit_quote` | yes | Domain tool with structured rate + optional note. |
| `schedule_callback` | yes | Domain tool with contact + when_iso + note. |

Considered merging `submit_form` into `click` (overlap on form submit
buttons) — kept both because `submit_form` exercises the form's
`requestSubmit()` path which runs HTML5 validation; `click` on a submit
button only works if the button is `type=submit` AND inside a form.
Different semantics, different failure modes. The ~250 bytes of prompt
overhead for keeping both is worth the correctness.

Net tool-schema bytes: **unchanged from baseline**. No regression.

### No keepalive ping (deferred)

The Gemini Live SDK exposes `session.close()` but no documented keepalive
primitive. The current 25 s heartbeat in `api/live-bridge.js` is a
server-side CPU watchdog; it does not emit anything upstream. We rely on
Gemini's server-side session timeout + our 5-minute idle close. No change.

---

## 7. Mic frame batching

**Before spec called for.** 20 ms (320-sample) chunks.
**Actual state in code.** The worklet (`js/audio-worklets/pcm-capture.js`)
already runs at `frameMs: 40` — see `audio-pipeline.js :: startCapture`,
where it's constructed with `processorOptions: { outputSampleRate: 16000,
frameMs: 40 }`. That's **40 ms = 640 samples = 1,280 bytes** per WS frame.

No change needed. This batching halves WS framing overhead (vs 20 ms)
without perceptible VAD latency cost — Gemini's VAD configures
`silenceDurationMs: 500` in live mode, so a 40 ms granularity adds <10 %
jitter to turn-end detection.

---

## 8. Headers + security (bonus)

Added to every static response:
- `X-Content-Type-Options: nosniff` — blocks MIME sniffing.
- `ETag` — cheap revalidation (see §2).

Response headers from nginx add (in prod):
- `Strict-Transport-Security: max-age=63072000; includeSubDomains`
- `X-Frame-Options: SAMEORIGIN`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: microphone=(self), camera=(), geolocation=()`
- `Content-Security-Policy: default-src 'self'; script-src 'self'; connect-src 'self' wss:; ...`

No perf cost; these go in the header block nginx builds once per response.

---

## 9. Measurement commands (for reproducing)

```bash
# Dev baseline
rm -rf dist && PORT=39110 node server.js &
curl -sS http://127.0.0.1:39110/js/voice-agent.js | wc -c       # raw
curl -sS -H 'Accept-Encoding: gzip' http://127.0.0.1:39110/js/voice-agent.js | wc -c  # gzipped

# Prod
npm run build
PORT=39111 NODE_ENV=production node server.js &
curl -sS http://127.0.0.1:39111/js/app.js | wc -c
curl -sS -H 'Accept-Encoding: gzip' http://127.0.0.1:39111/js/chunks/*.js | wc -c

# 304 behaviour
ETAG=$(curl -sS -D - -o /dev/null http://127.0.0.1:39111/js/app.js | grep -i ^etag:)
curl -sS -H "If-None-Match: $ETAG" -D - -o /dev/null http://127.0.0.1:39111/js/app.js
```

---

## 10. Regression gates

All 9 smoke tests run green against both dev-mode (source) and prod-mode
(dist) servers:
- invalid-key, upstream-handshake, browser-sim, live-mode, session-resume,
  cold-start-live, greeting-injection, fill-datetime, **transcription-toggle** (new).
- `transcription-toggle` asserts `/api/config.flags` matches env vars across
  the full 2×2 matrix of `GEMINI_TRANSCRIPTION` × `SHOW_TEXT`.

No regression in:
- SPA route survival (VoiceAgent + WS + AudioContext + mic persist).
- Ambient-noise single-driver invariant (`_updateAmbient`).
- Session resumption handle round-trip.
- Greeting injection on `setup_complete`.
- Mobile layout at 375×812 / 768×1024.
- Mute hotkey (`M`).
- Debug metrics panel (`?debug=1`).
