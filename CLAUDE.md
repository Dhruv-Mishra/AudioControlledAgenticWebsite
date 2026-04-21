# CLAUDE.md

Project-level instructions for Claude Code. Kept under ~200 lines so the full file stays in context and gets followed.

## Project: LiveAgentNavigationWebsite

A website featuring live AI agents that help visitors navigate and interact with the site (chat, guided tours, answer questions about content). The project is in an **early scaffold** state — the agent configuration under `.claude/agents/` exists, but the application code (`index.html`, `server.js`, `js/`, etc.) still needs to be built.

## Tech Stack (target)

- **Frontend:** vanilla HTML/CSS/JS by default. Introduce a framework only if a specific feature earns it (discuss with `oracle` before adding build tooling).
- **Backend:** Node.js (`server.js`) serving static pages and AI API routes. Default dev port `3001` (fallback `3000`, `3458`).
- **AI:** Anthropic Claude via server-side routes. Default model families: Opus 4.7 for hard reasoning, Sonnet 4.6 as the balanced default, Haiku 4.5 for latency-sensitive paths. Keys server-side only (`ANTHROPIC_API_KEY` in env).

## Target Project Structure

```
/
├── index.html, about.html, projects.html, contact.html, chat.html
├── css/                    # styles, tokens
├── js/                     # client-side scripts
├── server.js               # Node server + AI API routes
├── api/                    # server modules (chat, embeddings, etc.)
├── DESIGN.md               # active design system (tokens, typography, spacing)
├── CLAUDE.md               # this file
└── .claude/
    ├── agents/             # subagent definitions (designer, frontend-dev, ai-engineer, oracle, reviewer, orchestrator)
    ├── commands/run-workflow.md
    └── settings.json       # CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
```

## Commands

- Start dev server: `node server.js` (or `PORT=3001 node server.js`)
- Health check: `curl -s http://localhost:3001/api/health`
- Lint (once added): `npm run lint`
- Typecheck (once added): `npm run typecheck`
- Tests (once added): `npm test`

## Multi-Agent Workflow — Agent Teams First

This project has `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` enabled in `.claude/settings.json`. **Prefer agent teams over sequential subagent calls** for anything non-trivial.

### Roster (in `.claude/agents/`)

| Agent | Use when |
|---|---|
| `orchestrator` | coordinating multi-step or multi-component work — run as main session via `claude --agent orchestrator` |
| `designer` | any visual decision (components, pages, tokens, typography) |
| `frontend-dev` | implementing UI in HTML/CSS/JS (or framework code if the stack adopts one) |
| `ai-engineer` | any LLM feature — prompts, model calls, tool use, RAG, streaming, evals |
| `oracle` | architecture decisions (file structure, build tooling, AI topology, perf strategy) |
| `reviewer` | quality / accessibility / security / AI-integration review after any implementation |

### Choose delegation mode

- **Single subagent** — use when a task fits in one role and ≤2 files (e.g. "review `chat.js`", "pick colors for the hero").
- **Agent team (default for anything larger)** — spawn a team when the task spans 3+ files, mixes UI and AI, needs parallel research, or has independent sub-parts. Teammates share a task list and can message each other.

### Team composition rules

- **3–5 teammates is the sweet spot.** Going beyond 6 rarely helps and raises coordination cost and token spend.
- **Each teammate owns a distinct set of files.** Assign ownership explicitly at team creation to prevent merge conflicts. A teammate must not edit another teammate's files without coordination.
- **Reuse subagent definitions.** When declaring a teammate, reference a definition by name (e.g. "a teammate using the `ai-engineer` agent type") so they inherit the correct tools and system prompt.
- **One team per lead session.** Clean up the current team before starting a new one. Teams cannot nest — teammates cannot spawn their own teams or subagents.
- **Require a brief plan** before any destructive or cross-cutting change (schema, deletions, large refactors). Sync the team on the plan, then work.

### Typical team shapes

- **New feature (UI + AI):** designer + ai-engineer plan in parallel → frontend-dev integrates → reviewer validates.
- **Full page build:** designer plans the page → 2–3 frontend-dev teammates each own a section → reviewer validates.
- **Parallel research / bug hunt:** 2–4 teammates explore competing hypotheses or areas, then converge on findings.

## Code Style

- **Indentation:** 2 spaces. No tabs.
- **Quotes:** single quotes in JS, double quotes in HTML attributes.
- **Semicolons:** required in JS.
- **Naming:** `kebab-case.html`, `kebab-case.css`, `camelCase` for JS identifiers, `PascalCase` for components if a framework is introduced.
- **CSS tokens:** all design values flow through CSS custom properties (or the active token system in `DESIGN.md`). No hardcoded hex in component styles.
- **HTML:** semantic — `<nav>`, `<main>`, `<section>`, `<article>`, `<header>`, `<footer>`, `<aside>`. `alt` on every `<img>`. Visible focus states on every interactive element.
- **Responsive:** mobile-first. Base styles for mobile, `@media (min-width: ...)` for larger.
- **Accessibility bar:** 4.5:1 contrast for body text, full keyboard nav, `prefers-reduced-motion` honored, skip links on multi-section pages.

## AI Integration Rules (non-negotiable)

- **API keys stay server-side.** Never ship a key to the browser. The browser hits your own API route, which calls the model.
- **Sanitize model output before rendering as HTML.** Treat LLM output as untrusted input for XSS purposes.
- **Bound user input in prompts.** Wrap user text in delimiter tags (e.g. `<user_input>...</user_input>`) and instruct the model to treat it as data, not instructions.
- **Rate limit and auth every model-calling endpoint.** Per-IP minimum; per-user when auth exists.
- **Stream user-facing generation.** SSE (or framework equivalent) — don't buffer whole responses.
- **Prompt-cache stable prefixes** (system prompt, tool schemas, long static context). Target >80% cache hit rate on hot paths.
- **Log per call:** model ID, input/output token counts, stop reason, latency. Never log raw user content without a retention policy.
- **Retry with backoff** on 429/529. Don't retry other 4xx.
- **At least one failure-mode UI state** for every AI feature: loading, rate-limited, error, refusal.

When writing Anthropic SDK code, the `ai-engineer` should invoke the `claude-api` skill for current best practices on caching, streaming, and model selection.

## Verification Before Claiming Done

- Dev server starts and `/api/health` returns 200.
- Every page changed renders in a browser (not just typechecks).
- `reviewer` has run and returned PASS.
- For AI features: at least one representative prompt from the eval set returns a good output and the UI handles a forced failure (e.g. bad key) gracefully.

## What NOT to do

- Don't edit files outside your team-assigned ownership.
- Don't skip `designer` for visual components or `ai-engineer` for LLM features.
- Don't hardcode API keys, colors, spacing, or model IDs in multiple places.
- Don't introduce a framework, CSS library, or state manager without `oracle` sign-off.
- Don't spawn a team for a task that fits one subagent — it's wasted tokens.
- Don't mark a task done without the verification checks above.
