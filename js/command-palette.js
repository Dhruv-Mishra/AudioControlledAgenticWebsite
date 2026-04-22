// Command palette. Ctrl/⌘+K opens a searchable action menu. Actions are
// exported from js/palette-actions.js so new actions only need one file.

import { buildActions } from './palette-actions.js';

let rootEl = null;
let backdropEl = null;
let modalEl = null;
let inputEl = null;
let listEl = null;
let countLiveEl = null;
let isOpen = false;
let voiceAgentRef = null;
let actions = [];
let filteredActions = [];
let activeIndex = 0;
let lastFocused = null;

const MAX_ROWS = 40;

function matchScore(action, q) {
  if (!q) return 1;
  const hay = `${action.label} ${action.keywords || ''} ${action.section || ''}`.toLowerCase();
  const needle = q.toLowerCase();
  if (hay.includes(needle)) return 2;
  const terms = needle.split(/\s+/).filter(Boolean);
  let score = 0;
  for (const t of terms) {
    if (hay.includes(t)) score += 1;
  }
  return score > 0 ? 1 + score / terms.length : 0;
}

function renderList(q) {
  if (!listEl || !countLiveEl) return;
  const scored = actions
    .map((a) => ({ a, s: matchScore(a, q) }))
    .filter((x) => x.s > 0)
    .sort((x, y) => y.s - x.s || x.a.label.localeCompare(y.a.label))
    .slice(0, MAX_ROWS)
    .map((x) => x.a);
  filteredActions = scored;
  activeIndex = filteredActions.length ? 0 : -1;

  listEl.replaceChildren();
  let currentSection = null;
  filteredActions.forEach((a, i) => {
    if (a.section && a.section !== currentSection) {
      currentSection = a.section;
      const h = document.createElement('div');
      h.className = 'palette-section';
      h.textContent = currentSection;
      listEl.appendChild(h);
    }
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'palette-row';
    row.setAttribute('role', 'option');
    row.setAttribute('data-idx', String(i));
    row.setAttribute('data-agent-id', `palette.action.${a.id}`);
    row.textContent = a.label;
    row.addEventListener('mousemove', () => setActive(i));
    row.addEventListener('click', () => run(i));
    if (i === activeIndex) row.classList.add('is-active');
    listEl.appendChild(row);
  });
  countLiveEl.textContent = `${filteredActions.length} ${filteredActions.length === 1 ? 'action' : 'actions'}`;
}

function setActive(i) {
  if (i < 0 || i >= filteredActions.length) return;
  activeIndex = i;
  listEl.querySelectorAll('.palette-row').forEach((r) => r.classList.remove('is-active'));
  const row = listEl.querySelector(`.palette-row[data-idx="${i}"]`);
  if (row) {
    row.classList.add('is-active');
    row.scrollIntoView({ block: 'nearest' });
  }
}

function run(i) {
  const a = filteredActions[i];
  if (!a || typeof a.handler !== 'function') return;
  close();
  try {
    Promise.resolve(a.handler({ voiceAgent: voiceAgentRef })).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[palette] action failed', a.id, err);
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[palette] action threw', a.id, err);
  }
}

function onKeyDown(ev) {
  if (ev.key === 'Escape') { ev.preventDefault(); close(); return; }
  if (ev.key === 'ArrowDown') {
    ev.preventDefault();
    setActive(Math.min(activeIndex + 1, filteredActions.length - 1));
    return;
  }
  if (ev.key === 'ArrowUp') {
    ev.preventDefault();
    setActive(Math.max(activeIndex - 1, 0));
    return;
  }
  if (ev.key === 'Enter') {
    ev.preventDefault();
    if (activeIndex >= 0) run(activeIndex);
    return;
  }
  if (ev.key === 'Tab') {
    // Keep focus inside the modal — focus trap.
    ev.preventDefault();
    if (inputEl && document.activeElement !== inputEl) inputEl.focus();
  }
}

function onBackdropClick(ev) {
  if (ev.target === backdropEl) close();
}

function ensureMount() {
  if (rootEl) return;
  rootEl = document.createElement('div');
  rootEl.className = 'palette-root';
  rootEl.id = 'jarvis-palette';
  rootEl.hidden = true;
  rootEl.innerHTML = `
    <div class="palette-backdrop" data-palette-backdrop></div>
    <div class="palette-modal" role="dialog" aria-modal="true" aria-labelledby="palette-heading" data-agent-id="palette.root">
      <h2 id="palette-heading" class="sr-only">Command palette</h2>
      <div class="palette-input-wrap">
        <input type="text" class="palette-input" id="palette-input"
               data-agent-id="palette.input"
               placeholder="Type a command or search…"
               autocomplete="off" spellcheck="false"
               aria-label="Command palette search"
               aria-controls="palette-list" />
      </div>
      <div class="palette-list" id="palette-list" role="listbox" data-agent-id="palette.list"></div>
      <div class="palette-footer">
        <span class="palette-hint"><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
        <span class="palette-hint"><kbd>↵</kbd> run</span>
        <span class="palette-hint"><kbd>Esc</kbd> close</span>
        <span class="sr-only" aria-live="polite" id="palette-count"></span>
      </div>
    </div>
  `;
  document.body.appendChild(rootEl);
  backdropEl = rootEl.querySelector('[data-palette-backdrop]');
  modalEl = rootEl.querySelector('.palette-modal');
  inputEl = rootEl.querySelector('#palette-input');
  listEl = rootEl.querySelector('#palette-list');
  countLiveEl = rootEl.querySelector('#palette-count');

  inputEl.addEventListener('input', () => renderList(inputEl.value));
  inputEl.addEventListener('keydown', onKeyDown);
  backdropEl.addEventListener('click', onBackdropClick);
}

export function open(query = '') {
  ensureMount();
  if (isOpen) {
    if (query) { inputEl.value = query; renderList(query); }
    return;
  }
  isOpen = true;
  lastFocused = document.activeElement;
  actions = buildActions();
  inputEl.value = query || '';
  renderList(inputEl.value);
  rootEl.hidden = false;
  // Reflow for transition.
  void rootEl.offsetWidth;
  rootEl.classList.add('is-open');
  inputEl.focus();
}

export function close() {
  if (!isOpen) return;
  isOpen = false;
  rootEl.classList.remove('is-open');
  // Hide after transition settles.
  setTimeout(() => { if (rootEl && !isOpen) rootEl.hidden = true; }, 200);
  if (lastFocused && typeof lastFocused.focus === 'function') {
    try { lastFocused.focus(); } catch {}
  }
}

function handleGlobalKey(ev) {
  // Ctrl/⌘+K toggles the palette. Match 'k' or 'K'.
  const isK = ev.key === 'k' || ev.key === 'K';
  if (!isK) return;
  if (!(ev.ctrlKey || ev.metaKey)) return;
  // Ignore when typing in another interactive element — unless we're
  // already open (letting Esc/keyboard flow take precedence). This
  // prevents accidental open/close when the user is mid-typing in a
  // page search or form input.
  if (!isOpen) {
    const t = ev.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  }
  ev.preventDefault();
  if (isOpen) close();
  else open();
}

export function init({ voiceAgent } = {}) {
  voiceAgentRef = voiceAgent || null;
  ensureMount();
  document.addEventListener('keydown', handleGlobalKey);
}

export function runActionById(id, runArgs = {}) {
  const a = buildActions().find((x) => x.id === id);
  if (!a) return { ok: false, error: `Unknown palette action: ${id}` };
  try {
    const res = a.handler({ voiceAgent: voiceAgentRef, ...runArgs });
    if (res && typeof res.then === 'function') {
      res.catch((err) => console.error('[palette] async handler error', err));
    }
    return { ok: true, ran: id };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

export function registerTools(registry) {
  if (!registry || typeof registry.registerDomain !== 'function') return;
  registry.registerDomain('open_palette', (args) => {
    open(String((args && args.query) || ''));
    return { ok: true, opened: true };
  });
  registry.registerDomain('run_palette_action', (args) => {
    const id = String((args && args.action_id) || '');
    if (!id) return { ok: false, error: 'action_id is required' };
    return runActionById(id);
  });
}
