// Rate Negotiation page module — exports { enter, exit } for the SPA router.

let state = null;
let agentRef = null;

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function addLogEntry({ author = 'System', body = '', kind = 'info' }) {
  const entry = { author, body: String(body || '').slice(0, 400), kind, at: new Date().toLocaleTimeString() };
  state.log.unshift(entry);
  renderLog();
  return entry;
}

function renderLog() {
  const el = document.getElementById('convo-log');
  if (!el) return;
  el.innerHTML = '';
  state.log.forEach((e) => {
    const node = document.createElement('div');
    node.className = 'convo-entry';
    node.setAttribute('data-kind', e.kind);
    node.innerHTML = `<div class="author">${escapeHtml(e.author)} · <span class="mono">${escapeHtml(e.at)}</span></div><div class="body">${escapeHtml(e.body)}</div>`;
    el.appendChild(node);
  });
}

function currentTargetRate() {
  const el = document.getElementById('field-target-rate');
  if (!el) return null;
  const v = Number(el.value || 0);
  return isFinite(v) && v > 0 ? v : null;
}

function submitQuoteLocal(targetRate, note) {
  const target = Number(targetRate);
  if (!isFinite(target) || target <= 0) {
    return { ok: false, error: 'Target rate must be a positive number.' };
  }
  const el = document.getElementById('field-target-rate');
  if (el) {
    el.value = Math.round(target);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const amt = document.getElementById('rate-readout-amount');
  if (amt) amt.textContent = `$${Math.round(target).toLocaleString('en-US')}`;

  const entry = addLogEntry({
    author: 'Dispatcher (you)',
    body: `Submitted target rate ${Math.round(target).toLocaleString('en-US')} USD${note ? ' — ' + note : ''}.`,
    kind: 'counter'
  });
  return { ok: true, submitted: { target_rate: Math.round(target), note, at: entry.at } };
}

function wireControls() {
  const form = document.getElementById('negotiate-form');
  if (!form) return;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const target = currentTargetRate();
    if (target == null) { addLogEntry({ author: 'System', body: 'Enter a target rate first.', kind: 'reject' }); return; }
    const noteEl = document.getElementById('field-note');
    submitQuoteLocal(target, noteEl ? noteEl.value : '');
  });

  const counterBtn = document.getElementById('btn-counter');
  if (counterBtn) counterBtn.addEventListener('click', () => {
    const target = currentTargetRate();
    if (target == null) { addLogEntry({ author: 'System', body: 'Enter a target rate first.', kind: 'reject' }); return; }
    addLogEntry({ author: 'Carrier', body: `Counter-offered ${(target + 125).toLocaleString('en-US')} USD.`, kind: 'counter' });
  });

  const acceptBtn = document.getElementById('btn-accept');
  if (acceptBtn) acceptBtn.addEventListener('click', () => {
    const target = currentTargetRate();
    if (target == null) return;
    addLogEntry({ author: 'System', body: `Rate ${target.toLocaleString('en-US')} USD accepted. Booking confirmed.`, kind: 'accept' });
  });

  const targetEl = document.getElementById('field-target-rate');
  if (targetEl) targetEl.addEventListener('input', () => {
    const v = Number(targetEl.value || 0);
    const amt = document.getElementById('rate-readout-amount');
    if (amt) amt.textContent = isFinite(v) && v > 0
      ? `$${Math.round(v).toLocaleString('en-US')}`
      : '—';
  });
}

export async function enter(root, { voiceAgent }) {
  state = { log: [], load: null, carriers: [] };
  agentRef = voiceAgent;
  const [loads, carriers] = await Promise.all([
    fetch('/data/loads.json').then((r) => r.json()),
    fetch('/data/carriers.json').then((r) => r.json())
  ]);
  state.load = loads.find((l) => l.status === 'pending') || loads[0];
  state.carriers = carriers;

  // Populate the static form defaults from the seed load.
  if (state.load) {
    const pickup = document.getElementById('field-pickup');
    const dropoff = document.getElementById('field-dropoff');
    const commodity = document.getElementById('field-commodity');
    const weight = document.getElementById('field-weight');
    const target = document.getElementById('field-target-rate');
    const note = document.getElementById('field-note');
    if (pickup) pickup.value = state.load.pickup;
    if (dropoff) dropoff.value = state.load.dropoff;
    if (commodity) commodity.value = state.load.commodity;
    if (weight) weight.value = state.load.weight || '';
    if (target) target.value = '';
    if (note) note.value = '';
    const idEl = document.getElementById('load-id-readout');
    if (idEl) idEl.textContent = state.load.id;
  }

  wireControls();
  renderLog();
  addLogEntry({
    author: 'System',
    body: 'Negotiation opened. Ask Jarvis: "Set the target rate to 1850 and submit a counter."',
    kind: 'info'
  });

  if (voiceAgent && voiceAgent.toolRegistry) {
    voiceAgent.toolRegistry.registerDomain('submit_quote', (args) => {
      return submitQuoteLocal(args.target_rate, args.note);
    });
    voiceAgent.toolRegistry.registerDomain('get_load', () => ({
      ok: false, error: 'Load lookup is on the Dispatch page.'
    }));
    voiceAgent.toolRegistry.registerDomain('assign_carrier', () => ({
      ok: false, error: 'Carrier assignment is on the Dispatch page.'
    }));
    voiceAgent.toolRegistry.registerDomain('schedule_callback', () => ({
      ok: false, error: 'schedule_callback is on the Contact page.'
    }));
  }

  import('./quick-chips.js').then((chips) => {
    chips.registerChips(voiceAgent, [
      { id: 'negotiate.counter_100', label: 'Counter +$100', run: () => {
        const el = document.getElementById('field-target-rate');
        if (!el) return;
        const curr = Number(el.value || 0) || 0;
        el.value = String(Math.round(curr + 100));
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }},
      { id: 'negotiate.accept', label: 'Accept', tool: 'click', args: { agent_id: 'negotiate.accept' } },
      { id: 'negotiate.add_pickup_time', label: 'Add pickup time', run: () => {
        const n = document.getElementById('field-note');
        if (!n) return;
        const prefix = n.value ? n.value + ' · ' : '';
        n.value = `${prefix}Pickup ${new Date().toLocaleString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
        n.dispatchEvent(new Event('input', { bubbles: true }));
      }}
    ]);
  }).catch(() => {});
}

export function exit() {
  if (agentRef && agentRef.toolRegistry && typeof agentRef.toolRegistry.unregisterDomain === 'function') {
    agentRef.toolRegistry.unregisterDomain('submit_quote');
    agentRef.toolRegistry.unregisterDomain('get_load');
    agentRef.toolRegistry.unregisterDomain('assign_carrier');
    agentRef.toolRegistry.unregisterDomain('schedule_callback');
  }
  import('./quick-chips.js').then((chips) => chips.clearChips()).catch(() => {});
  state = null;
  agentRef = null;
}
