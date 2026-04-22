// Quick-action chips row. Mounts above the transcript panel inside the
// voice dock body. Per-page defaults are registered by each page module
// via `registerChips(voiceAgent, chips)`.
//
// Chip shape: { id, label, tool, args?, run? }
//   - `tool` + `args` routes through voiceAgent.toolRegistry (client-local,
//     no LLM round-trip). `run` is an optional direct handler used for
//     non-tool quick actions.
//
// Agent override: `set_quick_actions({chips})` replaces the current row
// until the next route change or the next override call.

const MAX_CHIPS = 5;

let rootEl = null;
let voiceAgentRef = null;
let currentChips = [];
let defaultChips = [];
let overrideActive = false;

function ensureMount() {
  if (rootEl) return rootEl;
  const body = document.querySelector('.voice-dock-body');
  if (!body) return null;
  rootEl = document.createElement('div');
  rootEl.className = 'voice-chips';
  rootEl.id = 'jarvis-chips';
  rootEl.setAttribute('data-agent-id', 'chips.root');
  rootEl.setAttribute('role', 'toolbar');
  rootEl.setAttribute('aria-label', 'Quick actions');
  // Mount as first child so chips appear above the transcript.
  body.insertBefore(rootEl, body.firstChild);
  return rootEl;
}

function sanitizeChips(chips) {
  if (!Array.isArray(chips)) return [];
  return chips
    .filter((c) => c && typeof c === 'object')
    .map((c) => ({
      id: String(c.id || '').slice(0, 64) || `chip-${Math.random().toString(36).slice(2, 8)}`,
      label: String(c.label || '').slice(0, 60),
      tool: c.tool ? String(c.tool) : '',
      args: c.args && typeof c.args === 'object' ? c.args : null,
      run: typeof c.run === 'function' ? c.run : null
    }))
    .filter((c) => c.label)
    .slice(0, MAX_CHIPS);
}

function render() {
  if (!rootEl) return;
  rootEl.replaceChildren();
  if (!currentChips.length) {
    rootEl.classList.remove('is-visible');
    rootEl.hidden = true;
    return;
  }
  rootEl.hidden = false;
  rootEl.classList.add('is-visible');
  currentChips.forEach((c) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip-btn';
    btn.textContent = c.label;
    btn.setAttribute('data-agent-id', `chips.${c.id}`);
    btn.addEventListener('click', () => onChipClick(c));
    rootEl.appendChild(btn);
  });
}

function onChipClick(chip) {
  if (chip.run) {
    try { chip.run({ voiceAgent: voiceAgentRef }); } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[chips] run threw', err);
    }
    return;
  }
  if (!chip.tool || !voiceAgentRef || !voiceAgentRef.toolRegistry) return;
  const reg = voiceAgentRef.toolRegistry;
  // Call the client handler directly — no LLM round-trip. We fake a
  // tool_call envelope so the registry's normal contract runs.
  const fakeCall = { id: `chip-${Date.now()}`, name: chip.tool, args: chip.args || {} };
  try {
    reg.handleToolCall(fakeCall);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[chips] handleToolCall failed', err);
  }
}

/** Page-module API. Registers the defaults for the current route. Resets
 *  the override flag so new route takes precedence. */
export function registerChips(voiceAgent, chips) {
  if (voiceAgent && !voiceAgentRef) voiceAgentRef = voiceAgent;
  defaultChips = sanitizeChips(chips);
  overrideActive = false;
  currentChips = defaultChips.slice();
  if (!rootEl) ensureMount();
  render();
}

/** Clear chips on route exit. */
export function clearChips() {
  defaultChips = [];
  if (!overrideActive) {
    currentChips = [];
    render();
  }
}

/** Agent override via `set_quick_actions`. */
function setQuickActions(args) {
  const chips = sanitizeChips(args && args.chips);
  overrideActive = chips.length > 0;
  currentChips = chips.length ? chips : defaultChips.slice();
  if (!rootEl) ensureMount();
  render();
  return { ok: true, chips: currentChips.map((c) => ({ id: c.id, label: c.label })) };
}

export function init({ voiceAgent, router } = {}) {
  voiceAgentRef = voiceAgent || null;
  ensureMount();
  // Clear the override on any route change so per-page defaults resume.
  if (router && typeof router.addEventListener === 'function') {
    router.addEventListener('route-change', () => {
      overrideActive = false;
      currentChips = defaultChips.slice();
      render();
    });
  }
}

export function registerTool(registry) {
  if (!registry || typeof registry.registerDomain !== 'function') return;
  registry.registerDomain('set_quick_actions', setQuickActions);
}
