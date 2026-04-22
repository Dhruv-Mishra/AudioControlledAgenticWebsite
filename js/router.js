// Minimal client-side router. History API + partial fetch. The VoiceAgent
// survives every route change — no WebSocket reconnect, no AudioContext
// teardown, no mic re-grab. That is the whole point of this file.
//
// Route lifecycle:
//   1. Click on an <a> or call router.navigate(path).
//   2. currentRoute.exit()                 — tear down page-local state.
//   3. fetch('/partials/<name>.html')      — load section markup.
//   4. Replace #route-target innerHTML.
//   5. document.title updates.
//   6. history.pushState (or replaceState on initial).
//   7. route.enter(root, { path })         — bind handlers, load data.
//   8. voiceAgent.handleRouteChange()      — send one page_context frame.
//
// No framework. No build step. ~150 lines of vanilla JS.

const ROUTES = Object.freeze({
  '/': {
    name: 'dispatch',
    title: 'Dispatch Board — Dhruv FreightOps',
    partial: '/partials/dispatch.html',
    load: () => import('./page-dispatch.js')
  },
  '/index.html': {
    name: 'dispatch',
    title: 'Dispatch Board — Dhruv FreightOps',
    partial: '/partials/dispatch.html',
    load: () => import('./page-dispatch.js')
  },
  '/carriers.html': {
    name: 'carriers',
    title: 'Carriers — Dhruv FreightOps',
    partial: '/partials/carriers.html',
    load: () => import('./page-carriers.js')
  },
  '/negotiate.html': {
    name: 'negotiate',
    title: 'Rate Negotiation — Dhruv FreightOps',
    partial: '/partials/negotiate.html',
    load: () => import('./page-negotiate.js')
  },
  '/contact.html': {
    name: 'contact',
    title: 'Contact Support — Dhruv FreightOps',
    partial: '/partials/contact.html',
    load: () => import('./page-contact.js')
  },
  '/map.html': {
    name: 'map',
    title: 'Freight Map — Dhruv FreightOps',
    partial: '/partials/map.html',
    load: () => import('./page-map.js')
  }
});

const DEBUG = (() => {
  try {
    if (new URLSearchParams(location.search).get('debug') === '1') return true;
    if (localStorage.getItem('jarvis.debug') === '1') return true;
  } catch {}
  return false;
})();

function dlog(...args) {
  if (!DEBUG) return;
  // eslint-disable-next-line no-console
  console.log('[router]', ...args);
}

function normalisePath(href) {
  if (!href) return '/';
  const u = new URL(href, location.origin);
  if (u.origin !== location.origin) return null;
  return u.pathname || '/';
}

function sameOrigin(a) {
  try {
    return new URL(a.href, location.origin).origin === location.origin;
  } catch { return false; }
}

class Router extends EventTarget {
  constructor({ target, voiceAgent, onRouteChange }) {
    super();
    this.target = target;
    this.voiceAgent = voiceAgent;
    this.onRouteChange = onRouteChange || (() => {});
    this.currentRoute = null;
    this.currentModule = null;
    this.navigating = false;
    this.liveRegion = this._ensureLiveRegion();
    this._bindClicks();
    window.addEventListener('popstate', (e) => this._onPopState(e));
  }

  _ensureLiveRegion() {
    let el = document.getElementById('route-live-region');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'route-live-region';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.className = 'sr-only';
    document.body.appendChild(el);
    return el;
  }

  _bindClicks() {
    document.addEventListener('click', (ev) => {
      if (ev.defaultPrevented) return;
      if (ev.button !== 0) return;
      if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      const a = ev.target.closest('a');
      if (!a) return;
      if (!a.href) return;
      if (a.hasAttribute('download')) return;
      if (a.target && a.target !== '' && a.target !== '_self') return;
      if (a.hasAttribute('data-external')) return;
      if (!sameOrigin(a)) return;
      const path = normalisePath(a.href);
      if (path == null) return;
      if (!ROUTES[path]) return; // leave non-route links alone.
      // In-page anchor against the current route (e.g. href="#voice-dock"
      // on /carriers.html): let the browser handle the scroll; no route
      // change is needed.
      try {
        const u = new URL(a.href, location.origin);
        if (u.pathname === location.pathname && u.hash) return;
      } catch {}
      ev.preventDefault();
      this.navigate(path);
    }, true);
  }

  async navigate(path, { replace = false, suppressNotify = false, force = false } = {}) {
    const route = ROUTES[path] || ROUTES['/'];
    const nextPath = ROUTES[path] ? path : '/';
    // If we're already on this route and not being asked to force a
    // re-render (e.g. via popstate/replace on initial boot), skip.
    if (!force && !replace && this.currentRoute && this.currentRoute.path === nextPath) {
      dlog('navigate skipped — already at', nextPath);
      return;
    }
    if (this.navigating) {
      dlog('navigate queued — already navigating', nextPath);
    }
    this.navigating = true;
    dlog('navigate', nextPath, route.name);
    try {
      // Exit previous route (if any).
      if (this.currentModule && typeof this.currentModule.exit === 'function') {
        try { await this.currentModule.exit(); } catch (err) { console.error('[router] exit error', err); }
      }

      // Load partial markup + module in parallel.
      this.target.setAttribute('aria-busy', 'true');
      const [html, mod] = await Promise.all([
        fetch(route.partial, { cache: 'no-store' }).then((r) => {
          if (!r.ok) throw new Error(`partial ${route.partial} → ${r.status}`);
          return r.text();
        }),
        route.load()
      ]);

      // Swap the markup in one assignment — no flicker.
      this.target.innerHTML = html;
      document.title = route.title;
      this.target.removeAttribute('aria-busy');

      // History API bookkeeping. We never call this on popstate (the browser
      // already updated the URL) — controlled via `replace`/`push` flag.
      if (!replace && location.pathname !== nextPath) {
        history.pushState({ route: route.name }, '', nextPath);
      } else if (replace) {
        history.replaceState({ route: route.name }, '', nextPath);
      }

      // Update aria-current on the nav links.
      this._markActiveNav(nextPath);

      // Announce the new page to screen readers.
      this.liveRegion.textContent = `Loaded ${route.title}`;

      // Call the route's enter(). Gives it the mounted DOM root.
      if (mod && typeof mod.enter === 'function') {
        await mod.enter(this.target, { path: nextPath, voiceAgent: this.voiceAgent });
      }

      this.currentRoute = { ...route, path: nextPath };
      this.currentModule = mod;

      // Focus the new page's <h1> for keyboard + screen-reader users.
      const h1 = this.target.querySelector('h1');
      if (h1) {
        h1.setAttribute('tabindex', '-1');
        try { h1.focus({ preventScroll: true }); } catch {}
      }

      if (!suppressNotify) {
        this.onRouteChange({ path: nextPath, name: route.name, title: route.title });
      }

      this.dispatchEvent(new CustomEvent('route-change', { detail: { path: nextPath, name: route.name } }));
    } catch (err) {
      console.error('[router] navigate error', err);
      this.target.innerHTML = `<div class="route-error" role="alert">Failed to load this page: ${escapeHtml(err.message || String(err))}</div>`;
      this.target.removeAttribute('aria-busy');
    } finally {
      this.navigating = false;
    }
  }

  _markActiveNav(path) {
    const links = document.querySelectorAll('.app-nav a[href]');
    links.forEach((a) => {
      const href = a.getAttribute('href');
      if (!href) return;
      const match = href === path || (href === '/' && path === '/index.html');
      if (match) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
  }

  async _onPopState() {
    await this.navigate(location.pathname, { replace: true });
  }
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

export { Router, ROUTES };
