# Gemini Live — Canonical Reference

Short-form reference drawn directly from `@google/genai@1.50.1` TypeScript
typedefs (`node_modules/@google/genai/dist/genai.d.ts`) and the
`gemini-live-api-examples` repo at `main` as of 2026-04-21. Source of
truth for the divergence audit (`specs/live-implementation-audit.md`).

## SDK shape

```
const { GoogleGenAI } = require('@google/genai');  // v1.50.1, CJS import works
const ai = new GoogleGenAI({ apiKey });
const session = await ai.live.connect({
  model: 'gemini-3.1-flash-live-preview',
  config: <LiveConnectConfig>,
  callbacks: {
    onopen: () => {...},
    onmessage: (LiveServerMessage) => {...},
    onerror: (ErrorEvent) => {...},
    onclose: (CloseEvent) => {...},
  }
});
```

`session` methods:

```
session.sendRealtimeInput({ audio: { data: <base64 string>, mimeType: 'audio/pcm;rate=16000' } });
session.sendRealtimeInput({ audioStreamEnd: true });   // force end-of-turn
session.sendClientContent({ turns: [ { role: 'user', parts: [{ text: '...' }] } ], turnComplete: true });
session.sendToolResponse({ functionResponses: [{ id, name, response: { result } }] });  // { error } on failure
session.close();
```

## LiveConnectConfig — fields we use

```ts
{
  // shape per genai.d.ts :: LiveConnectConfig (lines 7134-7229)
  responseModalities?: Modality[];           // e.g. ['AUDIO']
  speechConfig?: SpeechConfig;                // { voiceConfig: { prebuiltVoiceConfig: { voiceName } } }
  systemInstruction?: ContentUnion;          // { parts: [{ text }] } works
  thinkingConfig?: ThinkingConfig;            // { thinkingLevel: 'MINIMAL' }  -- enum ThinkingLevel.MINIMAL
  contextWindowCompression?: ContextWindowCompressionConfig; // { slidingWindow: {}, triggerTokens: '80000' }
  realtimeInputConfig?: RealtimeInputConfig; // { automaticActivityDetection, activityHandling?, turnCoverage? }
  inputAudioTranscription?: AudioTranscriptionConfig;  // {} (opts-in)
  outputAudioTranscription?: AudioTranscriptionConfig; // {} (opts-in)
  sessionResumption?: SessionResumptionConfig;  // { handle?, transparent? }
  tools?: ToolListUnion;                     // [{ functionDeclarations: [...] }]
}
```

## AutomaticActivityDetection — fields

From `genai.d.ts :: AutomaticActivityDetection` (line 600):

```ts
{
  disabled?: boolean;
  startOfSpeechSensitivity?: StartSensitivity;   // enum: START_SENSITIVITY_HIGH / LOW / UNSPECIFIED
  endOfSpeechSensitivity?: EndSensitivity;       // enum: END_SENSITIVITY_HIGH / LOW / UNSPECIFIED
  prefixPaddingMs?: number;
  silenceDurationMs?: number;
}
```

camelCase (verified in SDK). `silenceDurationMs`, `prefixPaddingMs` are
the real field names.

## SessionResumptionConfig

```ts
{
  handle?: string;       // handle from previous LiveServerSessionResumptionUpdate.newHandle
  transparent?: boolean; // if true, server sends last_consumed_client_message_index
}
```

Shape at the config level: `sessionResumption: { handle }` **directly on
LiveConnectConfig** — not nested under any other field. Verified in SDK
lines 7092 and 7202.

## LiveServerMessage fields we parse

```ts
{
  setupComplete?: LiveServerSetupComplete;  // { sessionId? } — first message after connect
  serverContent?: LiveServerContent;         // modelTurn / generationComplete / turnComplete /
                                             //   interrupted / inputTranscription / outputTranscription
  toolCall?: LiveServerToolCall;             // { functionCalls: [{ name, id, args }] }
  toolCallCancellation?: LiveServerToolCallCancellation; // { ids: [...] }
  usageMetadata?: UsageMetadata;             // { promptTokenCount, responseTokenCount, cachedContentTokenCount }
  goAway?: LiveServerGoAway;                 // { timeLeft }
  sessionResumptionUpdate?: LiveServerSessionResumptionUpdate;
                                             // { newHandle?, resumable?, lastConsumedClientMessageIndex? }
}
```

## LiveServerContent

The canonical examples (`gemini-live-ephemeral-tokens-websocket/frontend/geminilive.js`
`parseResponseMessages`) parse each field **independently** — audio and
transcripts can arrive in the same message:

```js
const sc = msg.serverContent;
if (sc.modelTurn && sc.modelTurn.parts) {
  for (const p of sc.modelTurn.parts) {
    if (p.inlineData && p.inlineData.data) /* base64 24k PCM */;
    if (p.text) /* text response part */;
  }
}
if (sc.inputTranscription?.text)  /* user speech delta */
if (sc.outputTranscription?.text) /* model speech delta */
if (sc.interrupted)     /* model was barged */
if (sc.generationComplete) /* model finished generating audio (before turnComplete) */
if (sc.turnComplete)    /* full turn done, VAD end */
```

## Audio format

- **Input** (client → Gemini): PCM 16-bit little-endian, mono, 16 kHz, 20–40 ms chunks.
  Encoded as **base64 string** inside `sendRealtimeInput({ audio: { data, mimeType } })`.
  `mimeType` MUST include rate: `'audio/pcm;rate=16000'`.
- **Output** (Gemini → client): PCM 16-bit little-endian, mono, 24 kHz.
  Delivered as **base64 string** in `part.inlineData.data`; decode with
  `Buffer.from(b64, 'base64')` server-side.

## Tool responses

Canonical shape (`gemini-live-genai-python-sdk/gemini_live.py`, browser
`script.js`):

```
sendToolResponse({ functionResponses: [
  // Success:
  { id, name, response: { result: <string or small object> } },
  // Failure:
  { id, name, response: { error: <message string> } }
]})
```

The `response` object uses EITHER `result` OR `error` — not both. Model
treats any other shape as unknown.

## Session lifecycle

```
ai.live.connect(...)  resolves → onopen fires
    ↓
first onmessage is setupComplete (may carry { sessionId })
    ↓
(user audio → sendRealtimeInput → server VAD → model generates audio)
    ↓
loop of onmessage with serverContent (incl. transcripts) + toolCall
    ↓
on error → onerror fires (ErrorEvent with .error or .message)
    ↓
on server shutdown-soon → serverMessage.goAway (soft warning)
    ↓
on session end → onclose fires (CloseEvent with .code .reason)
```

## Session resumption flow

If the connect config includes `sessionResumption: { handle }`:

1. Server may restore prior turn history bound to that handle.
2. On first `sessionResumptionUpdate` after connect:
   - `resumable === true` (or `undefined`, treated as true) → resume worked.
   - `resumable === false` → handle was rejected; conversation starts fresh.
3. Throughout the session, server sends periodic
   `sessionResumptionUpdate` with a fresh `newHandle` — store the latest
   one for future reconnects.

If connect config includes `sessionResumption: {}` (empty object, NO
handle): server sends updates anyway (so future reconnects can resume).

If connect config OMITS `sessionResumption`: no updates are sent.

## Error classification heuristics (empirical, from SDK error messages)

| Pattern in `error.message` | Code |
|---|---|
| `api key`, `unauthor`, `PERMISSION_DENIED`, `invalid` | `invalid_key` |
| `not found`, `UNSUPPORTED`, `unsupported model`, `NOT_FOUND` | `model_unavailable` |
| `429`, `rate`, `quota`, `RESOURCE_EXHAUSTED` | `rate_limited` |
| `refus`, `safety`, `BLOCK` | `refusal` |
| `network`, `timeout`, `ECONNRESET`, `EAI_AGAIN`, `socket`, `WebSocket` | `network` |

## Close-code buckets (from `CloseEvent.code`)

| Code | Meaning |
|---|---|
| 1008, 1007, 4401, 4003 | Auth / policy violation → `invalid_key` in our tree |
| 1000, 1001 | Normal close / going away |
| 1011 | Server error |

## Model IDs

- Preview: `gemini-3.1-flash-live-preview`
- Legacy alias (fallback): `gemini-live-2.5-flash-preview`
- Both serve via the same SDK path.

## Prebuilt voices

`Kore`, `Puck`, `Charon`, `Fenrir`, `Aoede`, `Leda`, `Orus`, `Zephyr`,
`Callirrhoe`, `Autonoe`, `Enceladus`. If one is rejected at runtime,
fall back to `Kore`.
