# Oracle — Seamless Cross-Page Navigation

## Question

How do we deliver truly seamless cross-page navigation so the user never
experiences a WebSocket reconnect, AudioContext teardown, or mic re-grab when
clicking between `/`, `/carriers.html`, `/negotiate.html`, and
`/contact.html`? The current handle-based resumption hides the content gap
but still destroys the voice stack on every navigation — the call audibly cuts.

## Decision

**Client-side SPA routing via the History API.** Collapse the four HTML
documents into a single `index.html` shell + four route partials loaded via
`fetch()` and injected into a `<main id="route-target">`. The VoiceAgent
(`AudioPipeline`, WebSocket, mic worklet, noise graph) is built once at
initial page load and survives every subsequent route change because no
full-document navigation ever happens.

## Rationale

Only an SPA can give the user a *real*-phone-call feel. Every other option
tears the audio stack down and relies on reconnect-fast or paper-over-gap
tricks:

| Option | Seamlessness | Cost | Chosen? |
|---|---|---|---|
| **(A) SPA routing via History API** | True — nothing disconnects | Moderate one-time refactor; four partials, minimal router, per-route `enter/exit` | **YES** |
| (B) `SharedWorker` hosting the WS | True for WS, **not** for mic/AudioContext (those are scoped to the main page and still die on navigation — a SharedWorker cannot host `getUserMedia` or play audio) | High; message-channel plumbing for every frame; worklets cannot live in a SharedWorker | No |
| (C) Service Worker + Navigation Preload | Faster navigation but the document still dies; AudioContext and mic still die | Medium; complex cache topology | No |
| (D) Multi-page with aggressive preload | Near-seamless visually; mic and WS still drop for ~100-300 ms | Low but visible to the user; the user explicitly said this is not acceptable | No |

B is attractive for WS continuity but doesn't solve the `AudioContext` and
`getUserMedia` problem: both are bound to the Window that originated them
and are destroyed on full-document navigation. That is the entire point of
SPA routing — one Window for the whole session.

C adds complexity without fundamentally changing the lifecycle: the
document is still recreated, which means `AudioPipeline` is reinitialised,
which means the user hears the hand-off.

D was the current approach (handle resumption across full document loads)
and is what the user says is unacceptable.

## Implementation Notes

### 1. File layout

```
index.html                   — the single shell
partials/dispatch.html       — extracted <main> contents of index.html
partials/carriers.html       — extracted <main> contents of carriers.html
partials/negotiate.html      — extracted <main> contents of negotiate.html
partials/contact.html        — extracted <main> contents of contact.html
carriers.html                — DELETED (server aliases /carriers.html → index.html)
negotiate.html               — DELETED
contact.html                 — DELETED
js/router.js                 — new minimal router (History API + click hijack)
js/page-*.js                 — become modules exporting { enter, exit }
js/ui.js                     — bootstraps once on initial load, not per page
```

### 2. Server changes (`server.js`)

- All known routes (`/`, `/carriers.html`, `/negotiate.html`, `/contact.html`)
  serve **`index.html`**.
- New directory `partials/` is served under `/partials/*.html`.
- Unknown routes 404 as before.
- `/api/live` is unchanged — the WS is opened once and never torn down by
  navigation.
- Add `partials` to the STATIC_DIRS allowlist.

### 3. Router (`js/router.js`)

A ~150-line vanilla ES module:

- On `DOMContentLoaded`, call `router.navigate(location.pathname, { replace: true })`.
- Global click handler: any `<a>` whose href is same-origin and NOT marked
  `data-external` / `target=_blank` / a download — preventDefault, call
  `router.navigate(href)`.
- `router.navigate(path)`:
  1. Resolve `path` to a registered route and its partial URL.
  2. Call `currentRoute.exit()` if there is one.
  3. `fetch('/partials/<name>.html')` — parse, replace the `<main>` contents.
  4. Update `document.title`.
  5. Call `newRoute.enter(mainEl)` which the route module imports and
     returns from its module-level `export`.
  6. `history.pushState({ route }, '', path)` (or `replaceState` on initial
     load).
  7. Mark the nav link `aria-current="page"`.
  8. Notify the VoiceAgent of the page change:
     `voiceAgent.handleRouteChange({ path, elements })`. The VoiceAgent
     sends a single `page_context` frame (no reconnect).
- `popstate` listener: mirror of `navigate` but without pushState.
- Announce route change via a polite live region so screen-reader users
  hear the new page title.

### 4. Page modules (`js/page-*.js`)

Each becomes:

```js
export const route = {
  name: 'carriers',
  title: 'Carriers — HappyRobot FreightOps',
  async enter(root) {
    // DOM is already injected. Just wire event handlers and data.
    await loadData();
    renderGrid();
    bindFilters();
    // Register domain tools. The VoiceAgent is already running.
    registerDomainTools();
  },
  exit() {
    // Remove any module-scoped listeners, clear intervals, etc.
    unregisterDomainTools();
  }
};
```

The router imports each route module **once** via dynamic `import()` on
first navigation; subsequent navigations reuse the cached module.

### 5. VoiceAgent lifecycle

- Constructor still runs once on initial load.
- New method `handleRouteChange({ path, elements })`:
  - Update `location.pathname` mirror and `_prevPathname`.
  - If `setupComplete`, immediately send `page_context`.
  - If NOT `setupComplete`, queue the page context to be sent on next
    `setup_complete`.
  - Persist session blob with the new `lastPath`.
- Remove the WS-reconnect-on-navigation path — it's dead code now but
  keep the reconnection logic for actual WS drops.
- Session resumption handle stays valuable for real disconnects (network
  drop, server restart); it simply isn't needed cross-page anymore.

### 6. Tool registry — cross-page domain tool registration

The existing `ToolRegistry.registerDomain(name, handler)` is fine. Each
route's `enter()` calls `registerDomain` for the tools relevant to that
page; `exit()` calls `unregisterDomain` (new method) to clean up. We do
**not** re-register static tools — those never change.

The `navigate` tool now calls `router.navigate(path)` instead of
`window.location.href = path`. No more full-document reload when Jarvis
navigates.

### 7. Session-storage blob is still useful

The cross-page blob in `sessionStorage` is no longer load-bearing for
cross-page continuity (the `VoiceAgent` lives across routes). It remains
useful for:
- Surviving a **full tab reload** or a genuine WS drop → reconnect cycle.
- Restoring transcript after an accidental F5.

Keep the blob code. Stop writing `lastPath` on every change — routes are
now in-memory transitions. Still write the blob on `pagehide`.

### 8. Back/forward and deep linking

- `history.pushState` + `popstate` handles back/forward.
- Server serves `index.html` for every known route, so a user deep-linking
  to `/carriers.html` gets the right page on first load.
- Unknown paths → 404 (plain text).

### 9. Accessibility

- `main.setAttribute('aria-busy', 'true')` during partial fetch.
- After the partial renders, move focus to `<h1>` on the new page and
  announce the new title via a polite live region (`<div role="status">`).
- Respect `prefers-reduced-motion` — no cross-fade by default; one can be
  added later.

### 10. CSS tokens / design fidelity

No visual change. The dock stays fixed-position; only the `<main>` content
swaps. Page-specific stylesheets are global (all in `css/pages.css`), so
everything Just Works.

## Rejected alternatives (deeper detail)

### SharedWorker

SharedWorkers CAN host a WebSocket, but they can't host an `AudioContext`
or `getUserMedia()`. The main page's mic and audio pipeline would still
die on each navigation. You'd end up with half a seamless stack and a
more complex IPC — worst of both worlds.

### Full-framework SPA (Next/React/Vue)

CLAUDE.md requires oracle sign-off for any framework. An SPA router is a
~150-line vanilla module; a framework is an order of magnitude more code
and build machinery for the same user-visible behaviour. Not justified.

### Continue multi-page with faster reconnect

The user's exact words: "it's not seamless … like a real phone call that
doesn't cut." Any approach that destroys and rebuilds the mic and
AudioContext will produce a glitch regardless of how fast the reconnect
is. Rejected.

## Acceptance criteria

1. Click between all four pages repeatedly. The WebSocket connection
   object (`voice-dock-metrics: wsState=1`) never changes.
2. `document.getElementById('voice-status-pill').dataset.state` stays
   `listening` (or whatever its pre-click state was) through navigation —
   no `live_opening` transition.
3. `pipeline.ctx` reference identity stays stable (`ctxId` unchanged)
   across navigations.
4. No mic permission prompt re-fires.
5. Saying something mid-navigation arrives at Gemini without a gap — the
   model responds on the destination page as if nothing changed.
