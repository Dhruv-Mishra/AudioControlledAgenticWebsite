// Agent activity indicator — live status strip above the call button.
//
// Collapses to 0 px when idle. Shows:
//   - debounced "Thinking…" when state → MODEL_THINKING for > 500 ms
//   - tool-call phrases on tool_call events
//   - agent-authored notes via `set_activity_note({text, ttl_seconds})`

const TOOL_PHRASES = {
  get_load: 'Looking up load…',
  assign_carrier: 'Assigning carrier…',
  submit_quote: 'Submitting quote…',
  schedule_callback: 'Scheduling callback…',
  filter_loads: 'Filtering loads…',
  filter_carriers: 'Filtering carriers…',
  navigate: 'Navigating…',
  click: 'Taking action…',
  fill: 'Filling form…',
  select: 'Choosing option…',
  check: 'Toggling…',
  read_text: 'Reading page…',
  highlight: 'Pointing it out…',
  submit_form: 'Submitting form…',
  open_palette: 'Opening palette…',
  run_palette_action: 'Running action…',
  set_captions: 'Updating captions…',
  set_quick_actions: 'Updating shortcuts…',
  set_theme: 'Switching theme…',
  set_activity_note: ''  // handled separately
};

const THINKING_DEBOUNCE_MS = 500;
const MAX_TTL_S = 30;
const MIN_TTL_S = 1;
const DEFAULT_TTL_S = 5;
const MAX_CHARS = 80;

let root = null;
let textEl = null;
let dotEl = null;
let currentNote = '';
let thinkingTimer = null;
let overrideTimer = null;
let overrideUntil = 0;

function ensureMount() {
  if (root) return root;
  // Look for the mount point inside the voice dock action panel.
  const host = document.querySelector('.voice-dock-action');
  if (!host) return null;
  root = document.createElement('div');
  root.className = 'voice-activity';
  root.id = 'jarvis-activity';
  root.setAttribute('data-agent-id', 'activity.status');
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');
  dotEl = document.createElement('span');
  dotEl.className = 'voice-activity-dot';
  dotEl.setAttribute('aria-hidden', 'true');
  textEl = document.createElement('span');
  textEl.className = 'voice-activity-text';
  root.appendChild(dotEl);
  root.appendChild(textEl);
  // Insert as the FIRST child of the action region so it sits above the
  // big call button.
  host.insertBefore(root, host.firstChild);
  return root;
}

function truncate(s) {
  const str = String(s || '').replace(/\s+/g, ' ').trim();
  if (str.length <= MAX_CHARS) return str;
  return str.slice(0, MAX_CHARS - 1) + '…';
}

function render(text) {
  if (!root) return;
  currentNote = text || '';
  if (textEl) textEl.textContent = currentNote;
  if (currentNote) {
    root.classList.add('is-active');
  } else {
    root.classList.remove('is-active');
  }
}

function clearOverride() {
  overrideUntil = 0;
  if (overrideTimer) { clearTimeout(overrideTimer); overrideTimer = null; }
}

function isOverrideActive() {
  return overrideUntil > Date.now();
}

function setAutoNote(text) {
  // Auto-notes do not clobber an active override.
  if (isOverrideActive()) return;
  render(text);
}

function setOverrideNote(text, ttlS) {
  const ttl = Math.min(MAX_TTL_S, Math.max(MIN_TTL_S, Number(ttlS) || DEFAULT_TTL_S));
  overrideUntil = Date.now() + ttl * 1000;
  if (overrideTimer) clearTimeout(overrideTimer);
  overrideTimer = setTimeout(() => {
    clearOverride();
    render('');
  }, ttl * 1000);
  render(truncate(text));
}

function onState(state) {
  // Debounced "Thinking…" — only show after > 500 ms in MODEL_THINKING.
  if (state === 'model_thinking') {
    if (thinkingTimer) clearTimeout(thinkingTimer);
    thinkingTimer = setTimeout(() => {
      setAutoNote('Thinking…');
    }, THINKING_DEBOUNCE_MS);
    return;
  }
  if (thinkingTimer) { clearTimeout(thinkingTimer); thinkingTimer = null; }
  if (state === 'tool_executing') {
    // Only set a generic phrase if no specific tool phrase was set
    // during onToolCallStart. If a tool phrase is already showing, leave
    // it until onToolCallEnd clears.
    if (!currentNote && !isOverrideActive()) setAutoNote('Taking action…');
    return;
  }
  if (state === 'live_ready' || state === 'model_speaking') {
    if (!isOverrideActive()) render('');
    return;
  }
  if (state === 'idle' || state === 'error' || state === 'closing') {
    if (!isOverrideActive()) render('');
    return;
  }
}

function onToolCallStart(name) {
  if (!name) return;
  if (isOverrideActive()) return;
  const phrase = TOOL_PHRASES[name];
  if (phrase) setAutoNote(phrase);
  else setAutoNote('Taking action…');
}

function onToolCallEnd() {
  if (isOverrideActive()) return;
  // After a tool ends, fall through to state-based messages; if state has
  // already transitioned to live_ready we want the note cleared.
  render('');
}

/** Tool handler body — exported so tool-registry can register it. */
export function setActivityNote(args) {
  const text = args && args.text != null ? String(args.text) : '';
  const ttl = args && args.ttl_seconds != null ? Number(args.ttl_seconds) : DEFAULT_TTL_S;
  if (!text) {
    // Explicit clear.
    clearOverride();
    render('');
    return { ok: true, cleared: true };
  }
  setOverrideNote(text, ttl);
  return { ok: true, text: truncate(text), ttl_seconds: Math.min(MAX_TTL_S, Math.max(MIN_TTL_S, ttl || DEFAULT_TTL_S)) };
}

export function init(voiceAgent) {
  if (!ensureMount() || !voiceAgent) return;
  voiceAgent.addEventListener('state', (ev) => {
    const s = ev.detail && ev.detail.state;
    if (s) onState(s);
  });
  voiceAgent.addEventListener('tool-call-start', (ev) => {
    const name = ev.detail && ev.detail.name;
    onToolCallStart(name);
  });
  voiceAgent.addEventListener('tool-call-end', () => onToolCallEnd());
  voiceAgent.addEventListener('call-ended', () => {
    clearOverride();
    render('');
  });
}

export function registerTool(registry) {
  if (!registry || typeof registry.registerDomain !== 'function') return;
  registry.registerDomain('set_activity_note', setActivityNote);
}
