// Theme controller — applies dark / light / system.
//
// Storage: localStorage['jarvis.theme'], default 'system'. The inline
// bootstrap script in index.html <head> applies the stored theme before
// CSS loads (prevents FOUC). This module is the runtime driver: it
// listens for user toggles, prefers-color-scheme changes, and exposes a
// tool handler.

const STORAGE_KEY = 'jarvis.theme';
const VALID = new Set(['dark', 'light', 'system']);

let mediaQuery = null;
let mqListener = null;
let segmentRoot = null;

function load() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return VALID.has(v) ? v : 'system';
  } catch { return 'system'; }
}

function save(value) {
  try { localStorage.setItem(STORAGE_KEY, value); } catch {}
}

function resolveEffective(pref) {
  if (pref === 'dark' || pref === 'light') return pref;
  try {
    return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch { return 'dark'; }
}

function applyAttribute(effective) {
  document.documentElement.setAttribute('data-theme', effective);
}

function syncSegmentUi(pref) {
  if (!segmentRoot) return;
  segmentRoot.querySelectorAll('button[data-theme-value]').forEach((b) => {
    const active = b.getAttribute('data-theme-value') === pref;
    b.setAttribute('aria-checked', active ? 'true' : 'false');
    b.classList.toggle('is-active', active);
  });
}

function attachMediaQueryListener() {
  try {
    if (mediaQuery && mqListener) mediaQuery.removeEventListener('change', mqListener);
    mediaQuery = matchMedia('(prefers-color-scheme: light)');
    mqListener = () => {
      if (load() === 'system') applyAttribute(resolveEffective('system'));
    };
    mediaQuery.addEventListener('change', mqListener);
  } catch {}
}

/** Set the theme preference and apply it. Exported so the tool handler and
 *  UI callers can share one code path. */
export function setTheme(value) {
  const next = VALID.has(value) ? value : 'system';
  save(next);
  applyAttribute(resolveEffective(next));
  syncSegmentUi(next);
  return { theme: next, effective: resolveEffective(next) };
}

/** Build the Dark / Light / System segmented control inside the settings
 *  sheet. Returns the root element so the caller can mount it where it
 *  wants. */
export function buildSegment() {
  const wrap = document.createElement('div');
  wrap.className = 'voice-control-row';
  wrap.setAttribute('role', 'radiogroup');
  wrap.setAttribute('aria-label', 'Theme');
  wrap.innerHTML = `
    <span class="voice-control-label">Theme</span>
    <div class="segmented theme-seg" data-agent-id="theme.toggle" id="voice-theme-seg">
      <button role="radio" type="button" data-theme-value="dark" data-agent-id="theme.dark" aria-checked="false">Dark</button>
      <button role="radio" type="button" data-theme-value="light" data-agent-id="theme.light" aria-checked="false">Light</button>
      <button role="radio" type="button" data-theme-value="system" data-agent-id="theme.system" aria-checked="false">System</button>
    </div>
  `;
  return wrap;
}

/** Initialise theme UI + listeners. Safe to call once per page load. */
export function init() {
  const seg = document.getElementById('voice-theme-seg');
  if (!seg) return;
  segmentRoot = seg;
  const pref = load();
  applyAttribute(resolveEffective(pref));
  syncSegmentUi(pref);
  attachMediaQueryListener();

  seg.addEventListener('click', (ev) => {
    const btn = ev.target && ev.target.closest('button[data-theme-value]');
    if (!btn) return;
    setTheme(btn.getAttribute('data-theme-value'));
  });
}

/** Tool handler for `set_theme`. Registered from app.js via voiceAgent.toolRegistry. */
export function registerTool(registry) {
  if (!registry || typeof registry.registerDomain !== 'function') return;
  registry.registerDomain('set_theme', (args) => {
    const value = String(args && args.theme || '');
    if (!VALID.has(value)) return { ok: false, error: 'theme must be dark, light, or system' };
    const result = setTheme(value);
    return { ok: true, ...result };
  });
}

export function currentTheme() { return load(); }
