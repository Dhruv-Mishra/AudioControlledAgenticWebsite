// Carrier Directory page module — exports { enter, exit } for the SPA router.

import { restoreFiltersFromUrl } from './tool-registry.js';
import { assignCarrierToLoad, getLoad, initDataStore, listCarriers, subscribe } from './data-store.js';
import { formatCarrierAvailability } from './formatters.js';
import { notify, showActionDialog } from './action-feedback.js';

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

function readShortlist() {
  try {
    const raw = localStorage.getItem('jarvis.carrier.shortlist.v1');
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch { return new Set(); }
}

function saveShortlist(list) {
  try { localStorage.setItem('jarvis.carrier.shortlist.v1', JSON.stringify(Array.from(list))); } catch {}
}

function filtered() {
  const { q, eq, available } = state.filter;
  const qq = (q || '').trim().toLowerCase();
  const shortlistOnly = qq === 'shortlisted';
  return listCarriers({
    available: available !== 'all' ? available === 'yes' : undefined,
    search: shortlistOnly ? '' : qq,
    predicate: (c) => {
      if (shortlistOnly && !state.shortlist.has(c.id)) return false;
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
    const shortlisted = state.shortlist && state.shortlist.has(c.id);
    const card = document.createElement('article');
    card.className = 'carrier-card';
    card.setAttribute('data-agent-id', `carriers.card.${c.id}`);
    card.setAttribute('data-carrier-id', c.id);
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
        <div class="meta"><span class="mono">${c.id}</span> · ${escapeHtml(c.mc)} · <span class="hero-numeral carrier-rating">${c.rating.toFixed(1)}</span><span class="muted"> ★</span>${shortlisted ? ' · Shortlisted' : ''}</div>
        <div class="meta">Lanes: ${c.lanes.map(escapeHtml).join(', ')}</div>
        <div class="meta">Equipment: ${c.equipment.map(escapeHtml).join(', ')}</div>
        <div class="row-actions">
          <a class="btn btn--sm" href="tel:${encodeURIComponent(c.phone)}" data-agent-id="carriers.card.${c.id}.call" data-external>Call</a>
          <button class="btn btn--sm" data-agent-id="carriers.card.${c.id}.message">Message</button>
          <button class="btn btn--sm ${shortlisted ? 'btn--outlined' : 'btn--primary'}" data-agent-id="carriers.card.${c.id}.shortlist" aria-pressed="${shortlisted ? 'true' : 'false'}">${shortlisted ? 'Shortlisted' : 'Shortlist'}</button>
        </div>
      </div>
    `;
    root.appendChild(card);
  });
}

function carrierFromEventTarget(target) {
  const card = target && target.closest && target.closest('[data-carrier-id]');
  const id = card && card.getAttribute('data-carrier-id');
  return id ? listCarriers().find((carrier) => carrier.id === id) : null;
}

async function openCarrierOnMap(carrier) {
  if (!carrier) return;
  if (window.__router && typeof window.__router.navigate === 'function') {
    await window.__router.navigate('/map.html');
  } else {
    location.href = '/map.html';
    return;
  }
  const map = window.__mapWidget;
  if (map && typeof map.focusTarget === 'function') {
    try { await map.ready; } catch {}
    await map.focusTarget(carrier.id);
  }
  notify(`Opened ${carrier.name} on the map.`, { kind: 'ok' });
}

function openMessageDialog(carrier) {
  if (!carrier) return;
  showActionDialog({
    title: `Message ${carrier.name}`,
    description: 'Queue a dispatcher message with lane context.',
    primaryLabel: 'Queue message',
    fields: [
      { name: 'channel', label: 'Channel', value: carrier.phone || carrier.email || carrier.id, required: true },
      { name: 'message', label: 'Message', type: 'textarea', rows: 4, value: `Can you confirm availability for your next ${carrier.equipment[0] || 'truck'} lane?`, required: true }
    ],
    onSubmit(values) {
      notify(`Message queued to ${carrier.name}: ${String(values.message || '').slice(0, 80)}`, { kind: 'ok' });
    }
  });
}

function toggleShortlist(carrier) {
  if (!carrier) return;
  if (state.shortlist.has(carrier.id)) {
    state.shortlist.delete(carrier.id);
    notify(`${carrier.name} removed from shortlist.`, { kind: 'warn' });
  } else {
    state.shortlist.add(carrier.id);
    notify(`${carrier.name} added to shortlist.`, { kind: 'ok' });
  }
  saveShortlist(state.shortlist);
  renderGrid();
}

function bindCarrierActions() {
  const root = document.getElementById('carrier-grid');
  if (!root) return;
  root.addEventListener('click', (event) => {
    const carrier = carrierFromEventTarget(event.target);
    if (!carrier) return;
    if (event.target.closest('[data-agent-id$=".thumb"]')) {
      event.preventDefault();
      void openCarrierOnMap(carrier);
      return;
    }
    if (event.target.closest('[data-agent-id$=".message"]')) {
      event.preventDefault();
      openMessageDialog(carrier);
      return;
    }
    if (event.target.closest('[data-agent-id$=".shortlist"]')) {
      event.preventDefault();
      toggleShortlist(carrier);
    }
  });
}

function bindToolbarActions() {
  const importBtn = document.querySelector('[data-agent-id="carriers.action.import"]');
  const addBtn = document.querySelector('[data-agent-id="carriers.action.new"]');
  if (importBtn) importBtn.addEventListener('click', () => {
    showActionDialog({
      title: 'Import carriers',
      description: 'Stage a CSV import for review.',
      primaryLabel: 'Stage import',
      fields: [
        { name: 'source', label: 'Source', value: 'carrier-roster.csv', required: true },
        { name: 'notes', label: 'Notes', type: 'textarea', rows: 3, placeholder: 'Equipment, lanes, or compliance notes' }
      ],
      onSubmit(values) {
        notify(`Import staged from ${values.source || 'carrier roster'}.`, { kind: 'ok' });
      }
    });
  });
  if (addBtn) addBtn.addEventListener('click', () => {
    showActionDialog({
      title: 'Add carrier',
      description: 'Create a carrier intake draft for Jarvis to complete.',
      primaryLabel: 'Create draft',
      fields: [
        { name: 'name', label: 'Carrier name', required: true },
        { name: 'equipment', label: 'Equipment', placeholder: 'Dry van, reefer' },
        { name: 'lane', label: 'Primary lane', placeholder: 'Chicago to Dallas' },
        { name: 'phone', label: 'Phone', type: 'tel' }
      ],
      onSubmit(values) {
        notify(`Carrier draft created for ${values.name || 'new carrier'}.`, { kind: 'ok' });
      }
    });
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
  state = { filter: { q: '', eq: 'all', available: 'all' }, shortlist: readShortlist() };
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
  bindCarrierActions();
  bindToolbarActions();
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
