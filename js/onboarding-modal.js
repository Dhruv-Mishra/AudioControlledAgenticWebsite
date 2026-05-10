const GLOBAL_SKIP_KEY = 'jarvis.onboarding.skip_all.v1';
const PAGE_KEY_PREFIX = 'jarvis.onboarding.seen.';

const PAGE_GUIDES = {
  dispatch: {
    paths: ['/', '/index.html'],
    eyebrow: 'User testing preview',
    title: 'Dispatch, with Jarvis on the desk',
    slides: [
      {
        diagram: 'assistant',
        title: 'A live agent replaces the extra dispatcher seat.',
        body: 'Jarvis can read the board, open loads, filter lanes, and take routine actions while you stay in flow.'
      },
      {
        diagram: 'board',
        title: 'The board is action-ready.',
        body: 'Rows, filters, map lanes, export, status requests, and escalations are built as things the agent can operate.'
      },
      {
        diagram: 'handoff',
        title: 'You can still drive every step.',
        body: 'Click manually, talk to Jarvis, or let him handle a defined task and confirm the result back to you.'
      }
    ]
  },
  carriers: {
    paths: ['/carriers.html'],
    eyebrow: 'Roster guide',
    title: 'Find the right truck faster',
    slides: [
      {
        diagram: 'filter',
        title: 'Filter the roster by equipment and availability.',
        body: 'Jarvis can narrow the list, shortlist carriers, and open map context for a specific carrier.'
      },
      {
        diagram: 'message',
        title: 'Actions do not stop at browsing.',
        body: 'Message, call, shortlist, import, and add-carrier controls now produce visible workflow outcomes.'
      },
      {
        diagram: 'assistant',
        title: 'Use the agent as a carrier coordinator.',
        body: 'Ask for the best fit on a lane, then let Jarvis line up the next action on your behalf.'
      }
    ]
  },
  negotiate: {
    paths: ['/negotiate.html'],
    eyebrow: 'Negotiation demo',
    title: 'A harder, more human rate desk',
    slides: [
      {
        diagram: 'negotiation',
        title: 'The carrier has a real operating story.',
        body: 'There is no fixed 25 percent box. Offers can be accepted, countered, rejected, or closed entirely.'
      },
      {
        diagram: 'risk',
        title: 'Every counter carries a read.',
        body: 'Negotiator profiles hint at pressure through fleet size, lanes, years in the business, and account commitments.'
      },
      {
        diagram: 'handoff',
        title: 'Jarvis can suggest the next number.',
        body: 'Ask for one recommendation, review the amount, then submit or accept when the deal is right.'
      }
    ]
  },
  map: {
    paths: ['/map.html'],
    eyebrow: 'Map guide',
    title: 'Spatial dispatch at a glance',
    slides: [
      {
        diagram: 'map',
        title: 'Loads, carriers, and lanes share one surface.',
        body: 'Search, layer toggles, pins, list view, and carrier panels are visible to Jarvis as actionable controls.'
      },
      {
        diagram: 'track',
        title: 'Use the map as a live assistant view.',
        body: 'Ask Jarvis to find a load, highlight a carrier, focus a region, or track what is delayed.'
      }
    ]
  },
  contact: {
    paths: ['/contact.html'],
    eyebrow: 'Support guide',
    title: 'Support without the ticket queue',
    slides: [
      {
        diagram: 'message',
        title: 'Jarvis can help write and schedule.',
        body: 'Fill the form yourself or ask the agent to prepare a callback with load context already attached.'
      },
      {
        diagram: 'assistant',
        title: 'Human escalation stays one step away.',
        body: 'The demo shows how an AI assistant handles routine support while a dispatcher takes the exceptions.'
      }
    ]
  }
};

let root = null;
let activeGuide = null;
let activeIndex = 0;
let lastFocus = null;
let skipAllChecked = false;
const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function storageSet(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

function storageRemove(key) {
  try { localStorage.removeItem(key); } catch {}
}

function pageKey(name) {
  return `${PAGE_KEY_PREFIX}${name}.v1`;
}

function guideForPath(path) {
  return Object.entries(PAGE_GUIDES).find(([, guide]) => guide.paths.includes(path)) || null;
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function diagram(type) {
  const nodes = {
    assistant: ['Visitor', 'Jarvis', 'Page action'],
    board: ['Load table', 'Filters', 'Status'],
    handoff: ['Your limit', 'Agent turn', 'Confirmation'],
    filter: ['Lane', 'Equipment', 'Shortlist'],
    message: ['Context', 'Message', 'Queued'],
    negotiation: ['Offer', 'Profile', 'Counter'],
    risk: ['Lane fit', 'Pressure', 'Walk away'],
    map: ['Loads', 'Map', 'Carriers'],
    track: ['Search', 'Focus', 'Track']
  }[type] || ['Page', 'Agent', 'Action'];
  return `<div class="onboarding-diagram onboarding-diagram--${escapeHtml(type)}" aria-hidden="true">
    <span>${escapeHtml(nodes[0])}</span>
    <i></i>
    <span>${escapeHtml(nodes[1])}</span>
    <i></i>
    <span>${escapeHtml(nodes[2])}</span>
  </div>`;
}

function getFocusableElements(container) {
  return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter((el) => {
    if (!el || el.getAttribute('aria-hidden') === 'true') return false;
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  });
}

function trapFocus(event) {
  const modal = root && root.querySelector('.onboarding-modal');
  if (!modal) return;
  const focusable = getFocusableElements(modal);
  if (!focusable.length) {
    event.preventDefault();
    try { modal.focus(); } catch {}
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (!modal.contains(active)) {
    event.preventDefault();
    first.focus();
    return;
  }
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
    return;
  }
  if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

function handleOnboardingKeydown(event) {
  if (!activeGuide || event.__onboardingHandled) return;
  event.__onboardingHandled = true;
  if (event.key === 'Escape') closeGuide({ completed: false });
  if (event.key === 'Tab') trapFocus(event);
  if (event.key === 'ArrowRight') showSlide(activeIndex + 1);
  if (event.key === 'ArrowLeft') showSlide(activeIndex - 1);
}

function ensureRoot() {
  if (root && document.body.contains(root)) return root;
  root = document.createElement('div');
  root.className = 'onboarding-root';
  root.setAttribute('data-agent-id', 'onboarding.root');
  root.hidden = true;
  document.body.appendChild(root);
  root.addEventListener('click', (event) => {
    const action = event.target && event.target.closest && event.target.closest('[data-onboarding-action]');
    if (!action) return;
    const name = action.getAttribute('data-onboarding-action');
    if (name === 'next') showSlide(activeIndex + 1);
    if (name === 'prev') showSlide(activeIndex - 1);
    if (name === 'close') closeGuide({ completed: false });
    if (name === 'finish') closeGuide({ completed: true });
    if (name === 'skip-all') {
      storageSet(GLOBAL_SKIP_KEY, '1');
      closeGuide({ completed: true });
    }
    if (name === 'dot') showSlide(Number(action.getAttribute('data-index') || 0));
  });
  root.addEventListener('keydown', handleOnboardingKeydown);
  return root;
}

function render() {
  if (!root || !activeGuide) return;
  const slide = activeGuide.guide.slides[activeIndex];
  const isLast = activeIndex >= activeGuide.guide.slides.length - 1;
  root.innerHTML = `
    <div class="onboarding-backdrop"></div>
    <section class="onboarding-modal" role="dialog" aria-modal="true" aria-labelledby="onboarding-title" aria-describedby="onboarding-copy">
      <header class="onboarding-head">
        <div>
          <p class="eyebrow">${escapeHtml(activeGuide.guide.eyebrow)}</p>
          <h2 id="onboarding-title">${escapeHtml(activeGuide.guide.title)}</h2>
        </div>
        <button class="icon-btn onboarding-close" type="button" aria-label="Close onboarding" data-onboarding-action="close" data-agent-id="onboarding.close">&times;</button>
      </header>
      <div class="onboarding-slide" data-agent-id="onboarding.slide">
        ${diagram(slide.diagram)}
        <div class="onboarding-copy">
          <h3>${escapeHtml(slide.title)}</h3>
          <p id="onboarding-copy">${escapeHtml(slide.body)}</p>
        </div>
      </div>
      <div class="onboarding-dots" role="group" aria-label="Onboarding slides">
        ${activeGuide.guide.slides.map((_, index) => `<button type="button" data-onboarding-action="dot" data-index="${index}" aria-label="Show slide ${index + 1}" aria-current="${index === activeIndex ? 'step' : 'false'}"></button>`).join('')}
      </div>
      <footer class="onboarding-actions">
        <label class="onboarding-check">
          <input type="checkbox" id="onboarding-skip-check" data-agent-id="onboarding.skip_check" ${skipAllChecked ? 'checked' : ''} />
          <span>Don't show guides again</span>
        </label>
        <div class="onboarding-button-row">
          <button class="btn btn--ghost btn--sm" type="button" data-onboarding-action="skip-all" data-agent-id="onboarding.skip_all">Skip all</button>
          <button class="btn btn--outlined btn--sm" type="button" data-onboarding-action="prev" ${activeIndex === 0 ? 'disabled' : ''}>Back</button>
          <button class="btn btn--primary btn--sm" type="button" data-onboarding-action="${isLast ? 'finish' : 'next'}" data-agent-id="onboarding.next">${isLast ? 'I understand / try out' : 'Next'}</button>
        </div>
      </footer>
    </section>
  `;
}

function showSlide(index) {
  if (!activeGuide) return;
  const skipCheck = root && root.querySelector('#onboarding-skip-check');
  if (skipCheck) skipAllChecked = !!skipCheck.checked;
  activeIndex = Math.max(0, Math.min(index, activeGuide.guide.slides.length - 1));
  render();
}

function closeGuide({ completed }) {
  if (!root || !activeGuide) return;
  const skipCheck = root.querySelector('#onboarding-skip-check');
  if (skipCheck) skipAllChecked = !!skipCheck.checked;
  if (skipAllChecked) storageSet(GLOBAL_SKIP_KEY, '1');
  storageSet(pageKey(activeGuide.name), '1');
  root.hidden = true;
  root.innerHTML = '';
  document.documentElement.classList.remove('is-onboarding-open');
  document.body.classList.remove('is-onboarding-open');
  document.removeEventListener('keydown', handleOnboardingKeydown, true);
  activeGuide = null;
  skipAllChecked = false;
  try { lastFocus && lastFocus.focus(); } catch {}
}

function openGuide(name, guide) {
  const el = ensureRoot();
  lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  activeGuide = { name, guide };
  activeIndex = 0;
  skipAllChecked = false;
  render();
  el.hidden = false;
  document.documentElement.classList.add('is-onboarding-open');
  document.body.classList.add('is-onboarding-open');
  document.addEventListener('keydown', handleOnboardingKeydown, true);
  const button = el.querySelector('[data-onboarding-action="next"], [data-onboarding-action="finish"]');
  try { button && button.focus(); } catch {}
}

function maybeShow(path, force = false) {
  const targetPath = path || location.pathname;
  const found = guideForPath(targetPath);
  if (!found) return;
  const [name, guide] = found;
  if (!force && storageGet(GLOBAL_SKIP_KEY) === '1') return;
  if (!force && storageGet(pageKey(name)) === '1') return;
  window.setTimeout(() => {
    if (!force && location.pathname !== targetPath) return;
    openGuide(name, guide);
  }, 120);
}

export function initOnboarding({ router } = {}) {
  ensureRoot();
  if (router && typeof router.addEventListener === 'function') {
    router.addEventListener('route-change', (event) => {
      const detail = event.detail || {};
      maybeShow(detail.path || location.pathname);
    });
  }
  window.__onboarding = {
    show: () => maybeShow(location.pathname, true),
    reset: () => {
      storageRemove(GLOBAL_SKIP_KEY);
      Object.keys(PAGE_GUIDES).forEach((name) => storageRemove(pageKey(name)));
    }
  };
}
