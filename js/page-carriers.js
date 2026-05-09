// Carrier Directory page module — exports { enter, exit } for the SPA router.

import { restoreFiltersFromUrl } from './tool-registry.js';
import { assignCarrierToLoad, getLoad, initDataStore, listCarriers, subscribe } from './data-store.js';
import { formatCarrierAvailability } from './formatters.js';

let state = null;
let agentRef = null;

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function chipForTone(tone) {
  if (tone === 'success') return 'ok';
  if (tone === 'danger') return 'danger';
  if (tone === 'warn') return 'warn';
  if (tone === 'info') return 'info';
  return 'neutral';
}

function filtered() {
  const { q, eq, available } = state.filter;
  const qq = (q || '').trim().toLowerCase();
  return listCarriers({
    available: available !== 'all' ? available === 'yes' : undefined,
    search: qq,
    predicate: (c) => {
      if (eq !== 'all' && !c.equipment.map((e) => e.toLowerCase()).includes(eq)) return false;
      return true;
    }
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
    const availability = formatCarrierAvailability(c);
    const card = document.createElement('article');
    card.className = 'carrier-card';
    card.setAttribute('data-agent-id', `carriers.card.${c.id}`);
    // Thumbnail: every carrier in data/carriers.json carries an `imageSlug`
    // pointing to a WebP under /public/images/carriers/. Falls back to the
    // generic truck silhouette so a missing slug doesn't 404.
    const slug = c.imageSlug || 'truck-generic';
    const imgSrc = `/public/images/carriers/${escapeHtml(slug)}.webp`;
    const initials = (c.name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
    card.innerHTML = `
      <a class="carrier-card-thumb" href="#" data-agent-id="carriers.card.${c.id}.thumb"
         aria-label="${escapeHtml(c.name)} truck photo"
         data-agent-description="Truck photo for ${escapeHtml(c.name)} (${escapeHtml(c.equipment.join(', '))}).">
        <img src="${imgSrc}" alt="${escapeHtml(c.name)} ${escapeHtml(c.equipment[0] || 'truck')}"
             loading="lazy" decoding="async" width="320" height="180" />
        <span class="carrier-card-monogram" aria-hidden="true">${escapeHtml(initials)}</span>
        <span class="carrier-card-thumb-eq">${escapeHtml(c.equipment[0] || 'Equipment')}</span>
      </a>
      <div class="carrier-card-body">
        <div class="row" style="justify-content: space-between;">
          <div class="name">${escapeHtml(c.name)}</div>
          <span class="chip chip--${chipForTone(availability.tone)}">${availability.label}</span>
        </div>
        <div class="meta"><span class="mono">${c.id}</span> · ${escapeHtml(c.mc)} · <span class="hero-numeral carrier-rating">${c.rating.toFixed(1)}</span><span class="muted"> ★</span></div>
        <div class="meta">Lanes: ${c.lanes.map(escapeHtml).join(', ')}</div>
        <div class="meta">Equipment: ${c.equipment.map(escapeHtml).join(', ')}</div>
        <div class="row-actions">
          <a class="btn btn--sm" href="tel:${encodeURIComponent(c.phone)}" data-agent-id="carriers.card.${c.id}.call" data-external>Call</a>
          <button class="btn btn--sm" data-agent-id="carriers.card.${c.id}.message">Message</button>
          <button class="btn btn--sm btn--primary" data-agent-id="carriers.card.${c.id}.shortlist">Shortlist</button>
        </div>
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
  state = { filter: { q: '', eq: 'all', available: 'all' } };
  agentRef = voiceAgent;
  await initDataStore();

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
  state._unsubscribeStore = subscribe('carrier:updated', () => { if (state) renderGrid(); });

  if (voiceAgent && voiceAgent.toolRegistry) {
    voiceAgent.toolRegistry.registerDomain('get_load', (args) => {
      const load = getLoad(String(args.load_id || args.id || '').trim());
      return load ? { ok: true, load } : { ok: false, error: `No load ${args.load_id || args.id}` };
    });
    voiceAgent.toolRegistry.registerDomain('assign_carrier', (args) => {
      try {
        const result = assignCarrierToLoad(args.load_id, args.carrier_id, { source: 'agent' });
        return { ok: true, load: result.load, carrier: result.carrier };
      } catch (err) {
        return { ok: false, error: err && err.message || String(err) };
      }
    });
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
  if (state && state._unsubscribeStore) {
    try { state._unsubscribeStore(); } catch {}
  }
  import('./quick-chips.js').then((chips) => chips.clearChips()).catch(() => {});
  state = null;
  agentRef = null;
}
