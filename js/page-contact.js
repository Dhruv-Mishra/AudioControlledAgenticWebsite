// Contact / Support page module — exports { enter, exit } for the SPA router.

let state = null;
let agentRef = null;

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function addCallback({ contact, whenIso, note }) {
  const d = new Date(whenIso);
  const when = isNaN(d.getTime())
    ? whenIso
    : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const entry = { contact, when, note: note || '' };
  state.callbacks.unshift(entry);
  renderCallbacks();
  return entry;
}

function renderCallbacks() {
  const root = document.getElementById('callback-list');
  if (!root) return;
  root.innerHTML = '';
  if (!state.callbacks.length) {
    root.innerHTML = `<div class="muted">No callbacks scheduled yet.</div>`;
    return;
  }
  state.callbacks.forEach((c) => {
    const el = document.createElement('div');
    el.className = 'callback-item';
    el.innerHTML = `<div class="row-sm" style="justify-content: space-between;"><strong>${escapeHtml(c.contact)}</strong><span class="when">${escapeHtml(c.when)}</span></div><div class="muted">${escapeHtml(c.note || '')}</div>`;
    root.appendChild(el);
  });
}

function wireForm() {
  const form = document.getElementById('contact-form');
  if (!form) return;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const contact = String(fd.get('name') || '');
    const email = String(fd.get('email') || '');
    const message = String(fd.get('message') || '');
    const preferred = String(fd.get('preferred-time') || new Date(Date.now() + 3600_000).toISOString());
    const fb = document.getElementById('contact-feedback');
    if (!contact || !email || !message) {
      if (fb) fb.textContent = 'Please fill every field before submitting.';
      return;
    }
    addCallback({ contact, whenIso: preferred, note: `Email: ${email}. Note: ${message}` });
    if (fb) fb.textContent = `Callback scheduled for ${contact}.`;
    form.reset();
  });
}

export async function enter(root, { voiceAgent }) {
  state = { callbacks: [] };
  agentRef = voiceAgent;
  wireForm();
  renderCallbacks();

  if (voiceAgent && voiceAgent.toolRegistry) {
    voiceAgent.toolRegistry.registerDomain('schedule_callback', (args) => {
      const contact = String(args.contact || '').trim();
      const whenIso = String(args.when_iso || '').trim();
      if (!contact || !whenIso) return { ok: false, error: 'contact and when_iso are required.' };
      const entry = addCallback({ contact, whenIso, note: args.note || '' });
      return { ok: true, scheduled: entry };
    });
    voiceAgent.toolRegistry.registerDomain('get_load',       () => ({ ok: false, error: 'Load lookup is on Dispatch.' }));
    voiceAgent.toolRegistry.registerDomain('assign_carrier', () => ({ ok: false, error: 'Carrier assignment is on Dispatch.' }));
    voiceAgent.toolRegistry.registerDomain('submit_quote',   () => ({ ok: false, error: 'Submit quotes from the Rate Negotiation page.' }));
  }

  import('./quick-chips.js').then((chips) => {
    chips.registerChips(voiceAgent, [
      { id: 'contact.schedule_callback', label: 'Schedule callback', run: () => {
        const form = document.getElementById('contact-form');
        if (form && typeof form.scrollIntoView === 'function') form.scrollIntoView({ behavior: 'smooth', block: 'start' });
        const nameEl = document.getElementById('contact-name');
        if (nameEl) nameEl.focus();
      }},
      { id: 'contact.attach_last_load', label: 'Attach last load', run: () => {
        const msg = document.getElementById('contact-message');
        if (!msg) return;
        const prefix = msg.value ? msg.value + '\n\n' : '';
        msg.value = `${prefix}Re: last viewed load.`;
        msg.dispatchEvent(new Event('input', { bubbles: true }));
      }}
    ]);
  }).catch(() => {});
}

export function exit() {
  if (agentRef && agentRef.toolRegistry && typeof agentRef.toolRegistry.unregisterDomain === 'function') {
    agentRef.toolRegistry.unregisterDomain('schedule_callback');
    agentRef.toolRegistry.unregisterDomain('get_load');
    agentRef.toolRegistry.unregisterDomain('assign_carrier');
    agentRef.toolRegistry.unregisterDomain('submit_quote');
  }
  import('./quick-chips.js').then((chips) => chips.clearChips()).catch(() => {});
  state = null;
  agentRef = null;
}

export function getState() {
  return { callbacks: state ? state.callbacks.slice() : [] };
}

export function setState(snap) {
  if (!snap || !state) return;
  if (Array.isArray(snap.callbacks)) {
    state.callbacks = snap.callbacks.slice();
    renderCallbacks();
  }
}
