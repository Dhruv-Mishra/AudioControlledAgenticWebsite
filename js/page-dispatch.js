// Dispatch Board page module — exports { enter, exit } for the SPA router.
// The VoiceAgent lives in the shell (ui.js) and is passed in via enter();
// this module only wires its own DOM + domain tools.

import { restoreFiltersFromUrl } from './tool-registry.js';
import {
  assignCarrierToLoad,
  getLoad,
  initDataStore,
  listCarriers,
  listLoads,
  subscribe
} from './data-store.js';
import {
  formatEta,
  formatLoadStatus,
  formatMiles,
  formatMoney,
  formatWeight
} from './formatters.js';
import {
  selectBookedRevenue,
  selectDelayedLoads,
  selectLanesSummary,
  selectLoadStatusCounts,
  selectLoadsInMotion,
  selectMilesInMotion,
  selectOpenLoads
} from './selectors.js';
import './load-modal.js';

// Per-mount state. Recreated on each enter() so navigation is clean.
let state = null;
let agentRef = null;

function chipForTone(tone) {
  if (tone === 'success') return 'ok';
  if (tone === 'danger') return 'danger';
  if (tone === 'warn') return 'warn';
  if (tone === 'info') return 'info';
  return 'neutral';
}

function statusMeta(status) {
  const meta = formatLoadStatus(status);
  return { ...meta, chip: chipForTone(meta.tone) };
}

function currentLoads() {
  return listLoads();
}

function currentCarriers() {
  return listCarriers();
}

function filterLoads() {
  const { q, status, lane } = state.filter;
  const qq = (q || '').trim().toLowerCase();
  return listLoads({
    status: status !== 'all' ? status : undefined,
    search: qq,
    predicate: (l) => {
      if (lane) {
        const laneStr = `${l.pickup} ${l.dropoff}`.toLowerCase();
        if (!laneStr.includes(lane.toLowerCase())) return false;
      }
      return true;
    }
  });
}

function renderSummary() {
  const loads = currentLoads();
  const counts = selectLoadStatusCounts(loads);
  const transit = counts.in_transit || 0;
  const pending = counts.pending || 0;
  const delayed = counts.delayed || 0;
  const revenue = selectBookedRevenue(loads);
  const el = document.getElementById('summary-grid');
  if (!el) return;
  el.innerHTML = `
    <div class="summary-card"><div class="label">In transit</div><div class="value" data-agent-id="dispatch.kpi.in_transit" data-kpi="loads.in_transit">${transit}</div><div class="meta">On the road</div></div>
    <div class="summary-card"><div class="label">Pending</div><div class="value" data-agent-id="dispatch.kpi.pending" data-kpi="loads.pending">${pending}</div><div class="meta">Awaiting carrier</div></div>
    <div class="summary-card"><div class="label">Delayed</div><div class="value" data-agent-id="dispatch.kpi.delayed" data-kpi="loads.delayed">${delayed}</div><div class="meta">Needs attention</div></div>
    <div class="summary-card"><div class="label">Booked rev.</div><div class="value" data-agent-id="dispatch.kpi.revenue" data-kpi="booked.revenue">${formatMoney(revenue)}</div><div class="meta"><span data-kpi="loads.total">${loads.length}</span> loads</div></div>
  `;
}

function renderTable() {
  const tbody = document.getElementById('loads-tbody');
  if (!tbody) return;
  const rows = filterLoads();
  tbody.innerHTML = '';
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted" style="padding: var(--sp-5); text-align: center;">No loads match these filters.</td></tr>`;
    return;
  }
  rows.forEach((l) => {
    const tr = document.createElement('tr');
    tr.setAttribute('data-agent-id', `dispatch.row.${l.id}`);
    tr.setAttribute('data-load-id', l.id);
    tr.setAttribute('tabindex', '0');
    tr.setAttribute('role', 'button');
    tr.setAttribute('aria-label', `Load ${l.id}, ${l.pickup} to ${l.dropoff}`);
    if (l.id === state.selectedId) tr.setAttribute('aria-selected', 'true');
    const meta = statusMeta(l.status);
    tr.innerHTML = `
      <td><span class="mono">${l.id}</span></td>
      <td>${escapeHtml(l.pickup)} → ${escapeHtml(l.dropoff)}</td>
      <td>${escapeHtml(l.carrier || '—')}</td>
      <td><span class="chip chip--${meta.chip}">${meta.label}</span></td>
      <td class="mono">${formatMiles(l.miles)}</td>
      <td class="mono">${formatMoney(l.rate)}</td>
      <td class="mono">${formatEta(l).niceAbsolute}</td>
    `;
    tr.addEventListener('click', () => selectLoad(l.id));
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault(); selectLoad(l.id);
      }
    });
    tbody.appendChild(tr);
  });
}

function selectLoad(id) {
  state.selectedId = id;
  document.querySelectorAll('#loads-tbody tr').forEach((tr) => {
    tr.removeAttribute('aria-selected');
    if (tr.getAttribute('data-load-id') === id) tr.setAttribute('aria-selected', 'true');
  });
  renderDetail();

  const load = getLoad(id);
  if (load && window.__loadModal) {
    const opener = document.querySelector(`tr[data-load-id="${CSS.escape(id)}"]`);
    if (typeof window.__loadModal.setLoadId === 'function') window.__loadModal.setLoadId(id);
    window.__loadModal.open(id, { context: 'dispatch', opener });
  }
}

function renderDetail() {
  const panel = document.getElementById('detail-panel');
  if (!panel) return;
  const id = state.selectedId;
  const l = id && getLoad(id);
  if (!l) {
    panel.innerHTML = `<div class="muted">Select a load to see details.</div>`;
    return;
  }
  const meta = statusMeta(l.status);
  panel.innerHTML = `
    <div class="row" style="justify-content: space-between;">
      <h2 data-agent-id="dispatch.detail.title">Load <span class="mono">${l.id}</span></h2>
      <span class="chip chip--${meta.chip}">${meta.label}</span>
    </div>
    <dl class="detail-kv" style="margin-top: var(--sp-3);">
      <dt>Pickup</dt><dd data-agent-id="dispatch.detail.pickup">${escapeHtml(l.pickup)}</dd>
      <dt>Dropoff</dt><dd data-agent-id="dispatch.detail.dropoff">${escapeHtml(l.dropoff)}</dd>
      <dt>Commodity</dt><dd data-agent-id="dispatch.detail.commodity">${escapeHtml(l.commodity)}</dd>
      <dt>Weight</dt><dd class="mono">${formatWeight(l.weight)}</dd>
      <dt>Miles</dt><dd class="mono">${formatMiles(l.miles)}</dd>
      <dt>Rate</dt><dd class="mono" data-agent-id="dispatch.detail.rate">${formatMoney(l.rate)}</dd>
      <dt>Carrier</dt><dd data-agent-id="dispatch.detail.carrier">${escapeHtml(l.carrier || 'Unassigned')}</dd>
      <dt>ETA</dt><dd class="mono" data-agent-id="dispatch.detail.eta">${formatEta(l).niceAbsolute}</dd>
    </dl>
    <div class="detail-actions">
      <button class="btn btn--primary" data-agent-id="dispatch.detail.assign_carrier" id="detail-assign">Assign carrier</button>
      <button class="btn" data-agent-id="dispatch.detail.request_status">Request status update</button>
      <button class="btn btn--danger" data-agent-id="dispatch.detail.escalate">Escalate</button>
    </div>
  `;

  const btn = document.getElementById('detail-assign');
  if (btn) btn.addEventListener('click', () => {
    const avail = currentCarriers().filter((c) => c.available);
    const pick = avail[0];
    if (!pick) { window.alert('No carriers available.'); return; }
    assignCarrierLocal(l.id, pick.id, 'dispatch');
  });
}

function assignCarrierLocal(loadId, carrierId, source = 'dispatch') {
  try {
    const { load } = assignCarrierToLoad(loadId, carrierId, { source });
    return { ok: true, load };
  } catch (err) {
    return { ok: false, error: err && err.message || String(err) };
  }
}

function renderMapCard() {
  const sub = document.getElementById('dispatch-map-sub');
  const ul = document.getElementById('dispatch-map-lanes');
  if (!ul) return;
  const loads = currentLoads();
  const open = loads.filter((l) => l.status !== 'delivered');
  if (sub) {
    const openCount = selectOpenLoads(loads);
    const delayed = selectDelayedLoads(loads);
    sub.textContent = delayed
      ? `${openCount} open · ${delayed} delayed`
      : `${openCount} open loads`;
  }
  ul.innerHTML = '';
  open.slice(0, 6).forEach((l) => {
    const li = document.createElement('li');
    li.className = 'dispatch-map-lane';
    li.setAttribute('data-agent-id', `dispatch.map_lane.${l.id}`);
    li.setAttribute('data-status', l.status || 'booked');
    li.setAttribute('data-load-id', l.id);
    li.setAttribute('role', 'button');
    li.setAttribute('tabindex', '0');
    li.setAttribute('aria-label', `${l.id}, ${l.pickup} to ${l.dropoff}, ${l.status || 'booked'}`);
    li.innerHTML = `
      <span class="lane-dot" aria-hidden="true"></span>
      <span class="lane-route">${escapeHtml(l.pickup)} → ${escapeHtml(l.dropoff)}</span>
      <span class="lane-id">${escapeHtml(l.id)}</span>
    `;
    const openMap = async () => {
      if (typeof window === 'undefined' || !window.__router || typeof window.__router.navigate !== 'function') {
        location.href = '/map.html';
        return;
      }
      await window.__router.navigate('/map.html');
      const w = window.__mapWidget;
      if (!w) return;
      try { await w.ready; } catch { return; }
      await w.highlightLoad(l.id);
    };
    li.addEventListener('click', openMap);
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMap(); }
    });
    ul.appendChild(li);
  });
}

function bindMapCard() {
  const link = document.querySelector('a[data-agent-id="dispatch.open_map"]');
  if (!link) return;
  link.addEventListener('click', (e) => {
    if (typeof window === 'undefined' || !window.__router || typeof window.__router.navigate !== 'function') return;
    e.preventDefault();
    window.__router.navigate('/map.html');
  });
}

function formatRatePerMile(value) {
  return value == null ? '—' : `$${value.toFixed(2)}/mi avg`;
}

function renderLaneSummaries() {
  const byKey = new Map(selectLanesSummary(currentLoads()).map((summary) => [summary.key, summary]));
  document.querySelectorAll('[data-lane]').forEach((card) => {
    const key = card.getAttribute('data-lane');
    const meta = card.querySelector('[data-lane-meta]') || card.querySelector('.lane-meta');
    if (!key || !meta) return;
    const summary = byKey.get(key);
    if (!summary) {
      meta.textContent = '—';
      return;
    }
    const countLabel = summary.count === 1 ? 'load' : 'loads';
    const avg = formatRatePerMile(summary.avgRatePerMile);
    meta.innerHTML = `${summary.count.toLocaleString('en-US')} ${countLabel} &middot; <span class="hero-numeral">${escapeHtml(avg)}</span>`;
  });
}

// ---- Hero KPI strip + Activity feed (homepage v3 sections) ----------
//
// Both surfaces are data-driven from the same `state.loads` snapshot the
// table reads, so the voice agent (which scans data-agent-id nodes) sees
// the same numbers a sighted user does.

function renderHeroKpi() {
  const loads = currentLoads();
  const active = selectLoadsInMotion(loads);
  const milesInMotion = selectMilesInMotion(loads);
  const bookedToday = selectBookedRevenue(loads);

  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };
  setText('hero-kpi-active', active.toLocaleString('en-US'));
  setText('hero-kpi-miles', formatMiles(milesInMotion));
  setText('hero-kpi-rev', formatMoney(bookedToday));

  const ts = document.getElementById('dispatch-hero-ts') ||
             document.querySelector('[data-agent-id="dispatch.hero.timestamp"]');
  if (ts) {
    const d = new Date();
    ts.textContent = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
}

function renderActivityFeed() {
  const ul = document.getElementById('activity-feed');
  if (!ul) return;
  const loads = currentLoads();
  // Build the initial event stream once per page mount, then mutate it
  // in-place via tickActivityFeed() so the agent's `get_activity_feed`
  // tool can read a stable, growing list.
  if (!state._activityEvents) {
    const events = [];
    loads.forEach((l) => {
      if (l.status === 'in_transit') {
        events.push({ kind: 'transit', when: l.eta ? new Date(l.eta).getTime() - 1000 * 60 * 60 * 6 : Date.now(), loadId: l.id });
      } else if (l.status === 'delayed') {
        events.push({ kind: 'delayed', when: Date.now() - Math.random() * 1000 * 60 * 90, loadId: l.id });
      } else if (l.status === 'booked') {
        events.push({ kind: 'booked', when: Date.now() - Math.random() * 1000 * 60 * 240, loadId: l.id });
      } else if (l.status === 'delivered') {
        events.push({ kind: 'delivered', when: Date.now() - Math.random() * 1000 * 60 * 60 * 18, loadId: l.id });
      } else if (l.status === 'pending') {
        events.push({ kind: 'pending', when: Date.now() - Math.random() * 1000 * 60 * 30, loadId: l.id });
      }
    });
    events.sort((a, b) => b.when - a.when);
    state._activityEvents = events;
  }
  // Mirror to a window global so the agent tool can read without
  // crossing module boundaries.
  try { window.__activityFeed = state._activityEvents; } catch {}
  paintActivityFeed();
}

function relTimeText(ts) {
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + ' min ago';
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + ' hr ago';
  return Math.round(hrs / 24) + ' d ago';
}

function paintActivityFeed() {
  const ul = document.getElementById('activity-feed');
  if (!ul || !state || !Array.isArray(state._activityEvents)) return;
  const labels = {
    transit:   { dot: 'info',    text: 'Picked up' },
    delayed:   { dot: 'danger',  text: 'Delayed' },
    booked:    { dot: 'ok',      text: 'Carrier booked' },
    delivered: { dot: 'neutral', text: 'Delivered' },
    pending:   { dot: 'warn',    text: 'Posted' },
    countered: { dot: 'warn',    text: 'Carrier countered' },
    quoted:    { dot: 'info',    text: 'Quote submitted' },
    available: { dot: 'ok',      text: 'Carrier available' }
  };
  ul.replaceChildren();
  state._activityEvents.slice(0, 12).forEach((ev) => {
    const load = getLoad(ev.loadId);
    if (!load) return;
    const meta = labels[ev.kind] || labels.pending;
    const li = document.createElement('li');
    li.className = 'activity-item';
    li.setAttribute('data-agent-id', `dispatch.activity.${load.id}`);
    li.setAttribute('data-event', ev.kind);
    li.innerHTML = `
      <span class="activity-dot chip--${meta.dot}" aria-hidden="true"></span>
      <div class="activity-body">
        <div class="activity-line">
          <strong>${escapeHtml(meta.text)}</strong>
          <span class="mono">${escapeHtml(load.id)}</span>
          <span class="muted">${escapeHtml(load.pickup)} &rarr; ${escapeHtml(load.dropoff)}</span>
        </div>
        <div class="activity-meta muted">
          ${escapeHtml(load.carrier || 'Unassigned')} &middot;
          ${formatMoney(load.rate)} &middot;
          <time datetime="${new Date(ev.when).toISOString()}" data-rel-time="${ev.when}">${escapeHtml(relTimeText(ev.when))}</time>
        </div>
      </div>
    `;
    li.addEventListener('click', () => selectLoad(load.id));
    ul.appendChild(li);
  });
}

// Cheap text-only refresh — runs every 30s to keep "4 min ago" honest
// without rebuilding the whole list.
function tickActivityRelTimes() {
  const ul = document.getElementById('activity-feed');
  if (!ul) return;
  ul.querySelectorAll('time[data-rel-time]').forEach((t) => {
    const ts = Number(t.getAttribute('data-rel-time'));
    if (Number.isFinite(ts)) t.textContent = relTimeText(ts);
  });
}

// Inject a fresh synthetic event every 5 min so the feed feels live.
// Cycles deterministically through a small pool of templates and the
// available loads/carriers — no randomness so reload stays stable.
function tickActivityInjector() {
  if (!state || !Array.isArray(state._activityEvents)) return;
  const loads = currentLoads();
  if (!loads.length) return;
  const pool = ['transit', 'booked', 'quoted', 'countered', 'available', 'delayed'];
  const minute = Math.floor(Date.now() / 60000);
  const kind = pool[minute % pool.length];
  const load = loads[minute % loads.length];
  state._activityEvents.unshift({ kind, when: Date.now(), loadId: load.id });
  if (state._activityEvents.length > 24) state._activityEvents.length = 24;
  try { window.__activityFeed = state._activityEvents; } catch {}
  paintActivityFeed();
}

function refreshFromStore() {
  if (!state) return;
  renderSummary();
  renderTable();
  renderDetail();
  renderMapCard();
  renderLaneSummaries();
  renderHeroKpi();
  renderActivityFeed();
}

function bindFilters() {
  const q = document.getElementById('filter-q');
  const st = document.getElementById('filter-status');
  const ln = document.getElementById('filter-lane');
  if (!q || !st || !ln) return;
  q.addEventListener('input', () => { state.filter.q = q.value; renderTable(); });
  st.addEventListener('change', () => { state.filter.status = st.value; renderTable(); });
  ln.addEventListener('input', () => { state.filter.lane = ln.value; renderTable(); });
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

// ---------- module lifecycle for the router ----------
export async function enter(root, { voiceAgent }) {
  state = { filter: { q: '', status: 'all', lane: '' }, selectedId: null };
  agentRef = voiceAgent;
  await initDataStore();

  renderSummary();
  renderTable();
  renderDetail();
  renderMapCard();
  renderLaneSummaries();
  renderHeroKpi();
  renderActivityFeed();
  bindMapCard();
  bindFilters();

  // Live timers: refresh "X min ago" labels every 30s, inject a fresh
  // event every 5 minutes. Cleared in exit().
  if (state._relTimer) clearInterval(state._relTimer);
  if (state._injectTimer) clearInterval(state._injectTimer);
  state._relTimer = setInterval(tickActivityRelTimes, 30_000);
  state._injectTimer = setInterval(tickActivityInjector, 5 * 60_000);

  if (voiceAgent && voiceAgent.toolRegistry) {
    voiceAgent.toolRegistry.registerDomain('get_activity_feed', () => {
      const list = (state && state._activityEvents) || [];
      return {
        ok: true,
        events: list.slice(0, 12).map((ev) => ({
          kind: ev.kind,
          load_id: ev.loadId,
          summary: (() => {
            const load = getLoad(ev.loadId);
            return load ? `${ev.kind} on ${load.id} (${load.pickup} → ${load.dropoff})` : `${ev.kind} on ${ev.loadId}`;
          })(),
          ago_text: relTimeText(ev.when),
          timestamp_iso: new Date(ev.when).toISOString()
        }))
      };
    });
    voiceAgent.toolRegistry.registerDomain('get_load', (args) => {
      const l = getLoad(String(args.load_id || '').trim());
      if (!l) return { ok: false, error: `No load ${args.load_id}` };
      selectLoad(l.id);
      return { ok: true, load: l };
    });
    voiceAgent.toolRegistry.registerDomain('assign_carrier', (args) => {
      return assignCarrierLocal(args.load_id, args.carrier_id, 'agent');
    });
    voiceAgent.toolRegistry.registerDomain('submit_quote', () => ({
      ok: false, error: 'submit_quote is only available on the Rate Negotiation page.'
    }));
    voiceAgent.toolRegistry.registerDomain('schedule_callback', () => ({
      ok: false, error: 'schedule_callback is only available on the Contact page.'
    }));
  }

  // Restore filters from URL query (?dispatch.status=delayed, etc) after
  // the filter inputs have been bound.
  restoreFiltersFromUrl('dispatch');

  // Listen for load-action events from the modal
  const onLoadAction = (e) => {
    const { action, loadId } = e.detail || {};
    if (action === 'assign' && loadId) {
      const avail = currentCarriers().filter((c) => c.available);
      const pick = avail[0];
      if (!pick) return;
      assignCarrierLocal(loadId, pick.id, 'modal');
    }
  };
  window.addEventListener('load-action', onLoadAction);
  state._onLoadAction = onLoadAction;
  state._unsubscribeStore = [
    subscribe('load:updated', refreshFromStore),
    subscribe('carrier:updated', refreshFromStore)
  ];

  // Register per-page quick-action chips (best-effort — module is dynamic).
  import('./quick-chips.js').then((chips) => {
    chips.registerChips(voiceAgent, [
      { id: 'dispatch.show_delayed', label: 'Show delayed', tool: 'filter_loads', args: { status: 'delayed' } },
      { id: 'dispatch.transit_tx', label: 'In-transit TX', tool: 'filter_loads', args: { status: 'in_transit', lane_contains: 'TX' } },
      { id: 'dispatch.export', label: 'Export CSV', tool: 'click', args: { agent_id: 'dispatch.action.export' } }
    ]);
  }).catch(() => {});
}

export function exit() {
  if (state) {
    if (state._relTimer) clearInterval(state._relTimer);
    if (state._injectTimer) clearInterval(state._injectTimer);
  }
  if (agentRef && agentRef.toolRegistry && typeof agentRef.toolRegistry.unregisterDomain === 'function') {
    agentRef.toolRegistry.unregisterDomain('get_activity_feed');
    agentRef.toolRegistry.unregisterDomain('get_load');
    agentRef.toolRegistry.unregisterDomain('assign_carrier');
    agentRef.toolRegistry.unregisterDomain('submit_quote');
    agentRef.toolRegistry.unregisterDomain('schedule_callback');
  }
  if (state && state._onLoadAction) {
    window.removeEventListener('load-action', state._onLoadAction);
  }
  if (state && Array.isArray(state._unsubscribeStore)) {
    state._unsubscribeStore.forEach((fn) => { try { fn(); } catch {} });
  }
  import('./quick-chips.js').then((chips) => chips.clearChips()).catch(() => {});
  state = null;
  agentRef = null;
}

export function getState() {
  return { selectedId: state ? state.selectedId : null };
}

export function setState(snap) {
  if (!snap || !state) return;
  if (snap.selectedId) selectLoad(snap.selectedId);
}
