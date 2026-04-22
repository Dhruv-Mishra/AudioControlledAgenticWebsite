// /map.html page module — exports { enter, exit } for the SPA router.
// Dynamic-imports the Leaflet wrapper so the map chunk never enters the
// main bundle. Data is loaded from the existing JSON fixtures; we do NOT
// mutate them (coordinates live in js/map-widget.js CITY_COORDS).

let instance = null;
let agentRef = null;

async function loadData() {
  const [loads, carriers] = await Promise.all([
    fetch('/data/loads.json').then((r) => r.json()),
    fetch('/data/carriers.json').then((r) => r.json())
  ]);
  return { loads, carriers };
}

export async function enter(root, { voiceAgent }) {
  agentRef = voiceAgent;

  // Make the surrounding <main> full-bleed while on the map page.
  const main = root && root.closest && root.closest('.app-main');
  if (main) main.classList.add('app-main--map');

  const mapRoot = root.querySelector('#map-root') || root;

  const { loads, carriers } = await loadData();
  const { createMap } = await import('./map-widget.js');
  instance = await createMap(mapRoot, { loads, carriers });
}

export function exit() {
  if (instance && typeof instance.destroy === 'function') {
    try { instance.destroy(); } catch {}
  }
  instance = null;
  agentRef = null;
  const main = document.querySelector('.app-main.app-main--map');
  if (main) main.classList.remove('app-main--map');
}
