// /map.html page module — exports { enter, exit } for the SPA router.
// Dynamic-imports the Leaflet wrapper so the map chunk never enters the
// main bundle. Data is loaded from the existing JSON fixtures; we do NOT
// mutate them (coordinates live in js/map-widget.js CITY_COORDS).

let instance = null;
let agentRef = null;

async function loadData() {
  try {
    const [loads, carriers] = await Promise.all([
      fetch('/data/loads.json').then((r) => {
        if (!r.ok) throw new Error(`loads.json → ${r.status}`);
        return r.json();
      }),
      fetch('/data/carriers.json').then((r) => {
        if (!r.ok) throw new Error(`carriers.json → ${r.status}`);
        return r.json();
      })
    ]);
    return { loads, carriers };
  } catch (err) {
    throw new Error('Could not load map data: ' + (err && err.message || err));
  }
}

function renderErrorBanner(root, message) {
  if (!root) return;
  const banner = document.createElement('div');
  banner.className = 'map-load-error';
  banner.setAttribute('role', 'alert');
  banner.textContent = message;
  root.prepend(banner);
}

export async function enter(root, { voiceAgent }) {
  agentRef = voiceAgent;

  // Make the surrounding <main> full-bleed while on the map page.
  const main = root && root.closest && root.closest('.app-main');
  if (main) main.classList.add('app-main--map');

  const mapRoot = root.querySelector('#map-root') || root;

  // Double-mount guard: if a previous instance was left around, tear it
  // down before re-mounting.
  if (instance) {
    try { exit(); } catch {}
  }

  let data;
  try {
    data = await loadData();
  } catch (err) {
    renderErrorBanner(mapRoot, err.message || 'Map data failed to load.');
    return;
  }

  try {
    const { createMap } = await import('./map-widget.js');
    instance = await createMap(mapRoot, data);
  } catch (err) {
    console.error('[page-map] createMap failed', err);
    renderErrorBanner(mapRoot, 'Map failed to mount: ' + (err && err.message || err));
    instance = null;
  }
}

export function exit() {
  // Destroy happens even if createMap threw — instance may be {api, destroy}
  // or just a partial object. Be defensive.
  if (instance && typeof instance.destroy === 'function') {
    try { instance.destroy(); } catch (err) { console.error('[page-map] destroy', err); }
  } else if (instance && instance.api && typeof instance.api.destroy === 'function') {
    try { instance.api.destroy(); } catch {}
  }
  instance = null;
  agentRef = null;
  const main = document.querySelector('.app-main.app-main--map');
  if (main) main.classList.remove('app-main--map');
  // Defensive: wipe the global even if destroy missed it (partial-mount failure).
  if (typeof window !== 'undefined' && window.__mapWidget) {
    try { delete window.__mapWidget; } catch { window.__mapWidget = undefined; }
  }
}
