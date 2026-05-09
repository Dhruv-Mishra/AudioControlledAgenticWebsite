// Carrier Directory page module — exports { enter, exit } for the SPA router.

import { restoreFiltersFromUrl } from './tool-registry.js';

let state = null;
let agentRef = null;

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

async function loadData() {
  state.carriers = await fetch('/data/carriers.json').then((r) => r.json());
}

function filtered() {
  const { q, eq, available } = state.filter;
  const qq = (q || '').trim().toLowerCase();
  return state.carriers.filter((c) => {
    if (available !== 'all') {
      const want = available === 'yes';
      if (c.available !== want) return false;
    }
    if (eq !== 'all' && !c.equipment.map((e) => e.toLowerCase()).includes(eq)) return false;
    if (qq) {
      const hay = `${c.name} ${c.id} ${c.mc} ${c.lanes.join(' ')}`.toLowerCase();
      if (!hay.includes(qq)) return false;
    }
    return true;
  });
}

function renderGrid() {
  const root = document.getElementById('carrier-grid');
  if (!root) return;
  const rows = filtered();
  root.innerHTML = '';
  if (!rows.length) {
    root.innerHTML = `<div class="muted">No carriers match these filters.</div>`;
    return;
  }
  rows.forEach((c) => {
    const card = document.createElement('article');
    card.className = 'carrier-card';
    card.setAttribute('data-agent-id', `carriers.card.${c.id}`);
    card.innerHTML = `
      <div class="row" style="justify-content: space-between;">
        <div class="name">${escapeHtml(c.name)}</div>
        <span class="chip chip--${c.available ? 'ok' : 'neutral'}">${c.available ? 'Available' : 'Unavailable'}</span>
      </div>
      <div class="meta"><span class="mono">${c.id}</span> · ${escapeHtml(c.mc)} · ★ ${c.rating.toFixed(1)}</div>
      <div class="meta">Lanes: ${c.lanes.map(escapeHtml).join(', ')}</div>
      <div class="meta">Equipment: ${c.equipment.map(escapeHtml).join(', ')}</div>
      <div class="row-actions">
        <a class="btn btn--sm" href="tel:${encodeURIComponent(c.phone)}" data-agent-id="carriers.card.${c.id}.call" data-external>Call</a>
        <button class="btn btn--sm" data-agent-id="carriers.card.${c.id}.message">Message</button>
        <button class="btn btn--sm btn--primary" data-agent-id="carriers.card.${c.id}.shortlist">Shortlist</button>
      </div>
    `;
    root.appendChild(card);
  });
}

function bindFilters() {
  const q = document.getElementById('carrier-q');
  const eq = document.getElementById('carrier-eq');
  const av = document.getElementById('carrier-available');
  if (!q || !eq || !av) return;
  q.addEventListener('input', () => { state.filter.q = q.value; renderGrid(); });
  eq.addEventListener('change', () => { state.filter.eq = eq.value; renderGrid(); });
  av.addEventListener('change', () => { state.filter.available = av.value; renderGrid(); });
}

export async function enter(root, { voiceAgent }) {
  state = { carriers: [], filter: { q: '', eq: 'all', available: 'all' } };
  agentRef = voiceAgent;
  await loadData();

  // Pre-filter from URL: ?eq=dry+van etc. Lets the equipment tiles on
  // the dispatch homepage and the in-page quick-filter strip act as
  // plain <a> links without any router coupling.
  try {
    const sp = new URLSearchParams(location.search);
    const eqParam = (sp.get('eq') || '').trim().toLowerCase();
    if (eqParam) {
      state.filter.eq = eqParam;
      const eqSel = document.getElementById('carrier-eq');
      if (eqSel) {
        // The select uses lowercased option values that match the URL param.
        const match = Array.from(eqSel.options).find((o) => o.value.toLowerCase() === eqParam);
        if (match) eqSel.value = match.value;
      }
    }
  } catch {}

  renderGrid();
  bindFilters();

  if (voiceAgent && voiceAgent.toolRegistry) {
    voiceAgent.toolRegistry.registerDomain('get_load', () => ({
      ok: false, error: 'Load lookup is only on the Dispatch page. Navigate there first.'
    }));
    voiceAgent.toolRegistry.registerDomain('assign_carrier', () => ({
      ok: false, error: 'Navigate to the Dispatch page to assign a carrier to a load.'
    }));
    voiceAgent.toolRegistry.registerDomain('submit_quote', () => ({
      ok: false, error: 'Submit quotes from the Rate Negotiation page.'
    }));
    voiceAgent.toolRegistry.registerDomain('schedule_callback', () => ({
      ok: false, error: 'Schedule callbacks from the Contact page.'
    }));
  }

  restoreFiltersFromUrl('carriers');

  import('./quick-chips.js').then((chips) => {
    chips.registerChips(voiceAgent, [
      { id: 'carriers.reefer', label: 'Reefer available', tool: 'filter_carriers', args: { equipment: 'reefer', available: 'yes' } },
      { id: 'carriers.top_dry_van', label: 'Top-rated dry-van', tool: 'filter_carriers', args: { equipment: 'dry van' } },
      { id: 'carriers.shortlisted', label: 'Shortlisted', tool: 'filter_carriers', args: { search: 'Shortlisted' } }
    ]);
  }).catch(() => {});
}

export function exit() {
  if (agentRef && agentRef.toolRegistry && typeof agentRef.toolRegistry.unregisterDomain === 'function') {
    agentRef.toolRegistry.unregisterDomain('get_load');
    agentRef.toolRegistry.unregisterDomain('assign_carrier');
    agentRef.toolRegistry.unregisterDomain('submit_quote');
    agentRef.toolRegistry.unregisterDomain('schedule_callback');
  }
  import('./quick-chips.js').then((chips) => chips.clearChips()).catch(() => {});
  state = null;
  agentRef = null;
}
