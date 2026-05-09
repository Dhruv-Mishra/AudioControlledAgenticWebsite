// Looping typewriter for page headers.
// - Cycles through a list of phrases per element.
// - Type → hold → erase → next, indefinitely.
// - Slower default cadence so the effect is visible (was 26ms, now 70ms).
// - prefers-reduced-motion is intentionally ignored (per user override).
// - Pauses while the page tab is hidden to save battery.

const CONTROLLERS = new WeakMap();

// Per-route phrase pools. The first phrase is what's already in the H1
// (so initial paint matches static markup); subsequent phrases rotate in.
const ROUTE_PHRASES = {
  '/': [
    'Every load on every lane.',
    'Orchestrated by voice.',
    'Dispatch that listens back.',
    'Move freight at the speed of speech.'
  ],
  '/index.html': [
    'Every load on every lane.',
    'Orchestrated by voice.',
    'Dispatch that listens back.',
    'Move freight at the speed of speech.'
  ],
  '/carriers.html': [
    'Every rig you can put on a load today.',
    'Forty-plus carriers, one shortlist.',
    'Filter, call, book — by voice.',
    'The roster, ready to roll.'
  ],
  '/negotiate.html': [
    'Quote it, counter it, close it.',
    'Hold the line on rate.',
    'Counter without leaving the call.',
    'Margin you can hear.'
  ],
  '/contact.html': [
    'A dispatcher, not a ticket queue.',
    'Two-minute median response.',
    'Talk to a human, or to Jarvis.',
    'Support that picks up.'
  ],
  '/map.html': [
    'Where every truck is, right now.',
    'Click any lane to dive in.',
    'Live freight, live overlay.',
    'The whole network, one canvas.'
  ]
};

function phrasesForRoute() {
  const path = (typeof location !== 'undefined' && location.pathname) || '/';
  return ROUTE_PHRASES[path] || ROUTE_PHRASES['/'];
}

function stopController(el) {
  const c = CONTROLLERS.get(el);
  if (c) {
    c.cancelled = true;
    CONTROLLERS.delete(el);
  }
}

export function typewrite(el, opts = {}) {
  if (!el || !(el instanceof Element)) return;
  stopController(el);

  const {
    typeMs   = 70,    // ms per character while typing
    eraseMs  = 35,    // ms per character while erasing
    holdMs   = 1800,  // ms to hold the fully-typed phrase
    gapMs    = 300,   // ms between phrases
    caret    = true
  } = opts;

  // Cache the original HTML so static markup keeps any <em>/<br/>.
  if (!el.dataset.twHtml) el.dataset.twHtml = el.innerHTML;
  const originalHtml = el.dataset.twHtml;

  // Build the phrase list: explicit data-tw-phrases attr (JSON array) wins,
  // else the route-default pool, else just the original text.
  let phrases = null;
  const explicit = el.getAttribute('data-tw-phrases');
  if (explicit) {
    try { phrases = JSON.parse(explicit); } catch {}
  }
  if (!Array.isArray(phrases) || !phrases.length) phrases = phrasesForRoute().slice();

  // Reserve height to prevent layout shift while characters come and go.
  el.innerHTML = originalHtml;
  const reservedH = el.getBoundingClientRect().height;
  if (reservedH > 0) el.style.minHeight = `${Math.ceil(reservedH)}px`;

  if (caret) el.classList.add('tw-typing');

  const ctrl = { cancelled: false };
  CONTROLLERS.set(el, ctrl);

  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const visible = () => (typeof document === 'undefined') || !document.hidden;

  (async function loop() {
    let idx = 0;
    while (!ctrl.cancelled) {
      if (!visible()) { await sleep(500); continue; }
      const phrase = String(phrases[idx % phrases.length] || '');
      // Type out
      for (let i = 1; i <= phrase.length; i++) {
        if (ctrl.cancelled) return;
        el.textContent = phrase.slice(0, i);
        await sleep(typeMs);
      }
      await sleep(holdMs);
      // Erase
      for (let i = phrase.length; i >= 0; i--) {
        if (ctrl.cancelled) return;
        el.textContent = phrase.slice(0, i);
        await sleep(eraseMs);
      }
      await sleep(gapMs);
      idx++;
    }
  })();
}

/**
 * Auto-apply to anything inside `root` matching `[data-tw]` or `.tw`.
 * Picks every visible <h1> as a fallback so every page gets something.
 */
export function autoApplyTypewriter(root) {
  if (!root) return;
  const targets = new Set();
  root.querySelectorAll('[data-tw], .tw').forEach((el) => targets.add(el));
  if (!targets.size) {
    root.querySelectorAll('h1').forEach((h1) => {
      if (!h1.classList.contains('sr-only')) targets.add(h1);
    });
  }
  let i = 0;
  targets.forEach((el) => {
    typewrite(el, { typeMs: 70, eraseMs: 35, holdMs: 1800, gapMs: 300 });
    i++;
  });
}
