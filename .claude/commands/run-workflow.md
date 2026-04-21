# Run Multi-Agent Workflow

Execute the full website-development pipeline autonomously. Defers to CLAUDE.md for project rules and agent roster.

## How to run

Act as (or delegate to) `orchestrator` — run the main session as `claude --agent orchestrator` so it can spawn teammates. Default to an **agent team**; fall back to a single subagent only for trivial, single-role, ≤2-file tasks.

## Phases

Skip any phase that doesn't apply to the task.

1. **Refine.** Read the task. Skim CLAUDE.md and the relevant files. Auto-resolve ambiguity from code. Batch any unresolvable questions into one message.
2. **Plan.** Decompose into ordered tasks. Identify parallelizable sub-parts. Hard architectural choices → `oracle`.
3. **Design (UI).** `designer` produces a spec grounded in the active design system. Skip if no visual surface.
4. **Design (AI).** `ai-engineer` defines model, prompt, call shape, caching, failure modes, and the contract the frontend will consume. Skip if no LLM feature.
5. **Implement in parallel.** Spawn a team: `frontend-dev` owns UI files; `ai-engineer` owns server routes + prompts. Assign explicit file ownership. Run lint / typecheck / build.
6. **Review.** `reviewer` audits. Route Critical/Warning items back to the owning teammate; re-review.
7. **Validate.** `designer` confirms visual fidelity; `ai-engineer` runs an eval and a forced-failure smoke test. Exercise the feature in a browser for interactive changes.
8. **Summary.** Report changes, decisions, review status, and follow-ups.

## Autonomy

- Don't pause for inter-phase approval — the review/validate loop catches issues.
- Batch any required user questions into a single interaction.
- Destructive operations (data deletion, force-push, schema drops) still require explicit user confirmation.

## User's Task

$ARGUMENTS
