// Client-side tool executor + element-scanner. The server forwards tool_call
// messages from the model; we execute them here and return tool_result back.
//
// Security: we only act on elements currently present in the DOM with a
// matching data-agent-id. No `eval`, no arbitrary CSS selectors. Every tool
// that touches inputs emits native events so the page's own listeners react.

const VALID_PATHS = new Set(['/', '/index.html', '/carriers.html', '/negotiate.html', '/contact.html']);

function textOf(el) {
  if (!el) return '';
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
    return (el.value || '').toString();
  }
  return (el.textContent || '').replace(/\s+/g, ' ').trim();
}

function roleOf(el) {
  if (!el) return 'region';
  const tag = el.tagName.toLowerCase();
  if (tag === 'button') return 'button';
  if (tag === 'a') return 'link';
  if (tag === 'input') {
    const t = (el.getAttribute('type') || 'text').toLowerCase();
    if (t === 'checkbox' || t === 'radio') return 'check';
    if (t === 'submit' || t === 'button') return 'button';
    return 'input';
  }
  if (tag === 'textarea') return 'textarea';
  if (tag === 'select') return 'select';
  if (tag === 'form') return 'form';
  return el.getAttribute('role') || 'region';
}

function labelOf(el) {
  if (!el) return '';
  const aria = el.getAttribute('aria-label');
  if (aria) return aria.trim();
  const labelled = el.getAttribute('aria-labelledby');
  if (labelled) {
    const r = document.getElementById(labelled);
    if (r) return (r.textContent || '').trim();
  }
  if (el.id) {
    const associated = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (associated) return (associated.textContent || '').trim();
  }
  const closestLabel = el.closest('label');
  if (closestLabel) return (closestLabel.textContent || '').trim();
  if (el.placeholder) return el.placeholder.trim();
  const t = textOf(el);
  return t.slice(0, 120);
}

function optionsOf(el) {
  if (!el || el.tagName !== 'SELECT') return undefined;
  return Array.from(el.options).map((o) => o.label || o.textContent || o.value).filter(Boolean);
}

function stateOf(el) {
  if (!el) return {};
  if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
    return { checked: !!el.checked, disabled: !!el.disabled };
  }
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
    return { value: (el.value || '').toString().slice(0, 200), disabled: !!el.disabled };
  }
  return { disabled: !!el.disabled };
}

function isVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  return true;
}

export function scanAgentElements() {
  const nodes = document.querySelectorAll('[data-agent-id]');
  const out = [];
  for (const el of nodes) {
    if (!isVisible(el)) continue;
    const id = el.getAttribute('data-agent-id');
    if (!id) continue;
    out.push({
      id,
      role: roleOf(el),
      label: labelOf(el),
      page: location.pathname,
      state: stateOf(el),
      options: optionsOf(el)
    });
  }
  return out;
}

function findByAgentId(agentId) {
  if (!agentId || typeof agentId !== 'string') return null;
  const el = document.querySelector(`[data-agent-id="${CSS.escape(agentId)}"]`);
  return el || null;
}

function emitFlash(el) {
  if (!el) return;
  el.classList.remove('is-agent-highlighted');
  // Force reflow to restart animation.
  void el.offsetWidth;
  el.classList.add('is-agent-highlighted');
  setTimeout(() => el.classList.remove('is-agent-highlighted'), 1400);
}

function fireInputEvent(el) {
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

async function waitForIdle(ms = 120) {
  return new Promise((r) => setTimeout(r, ms));
}

export class ToolRegistry {
  /**
   * @param {object} opts
   * @param {(msg: object) => void} opts.sendTextMessage  send JSON envelope back to server
   * @param {(route: string) => void} opts.onNavigate     called with new path; default uses the SPA router if present, else full reload
   * @param {(summary: string) => void} [opts.onToolNote] UI-side hook to log tool actions
   */
  constructor({ sendTextMessage, onNavigate, onToolNote }) {
    this.send = sendTextMessage;
    this.onNavigate = onNavigate || ((p) => {
      // Prefer the SPA router so the VoiceAgent survives the navigation
      // (no WS reconnect, no AudioContext teardown). Fall back to a full
      // reload if, for any reason, the router isn't attached yet.
      if (typeof window !== 'undefined' && window.__router && typeof window.__router.navigate === 'function') {
        window.__router.navigate(p);
      } else {
        window.location.href = p;
      }
    });
    this.onToolNote = onToolNote || (() => {});
    this.domainHandlers = new Map();
  }

  /** Register a domain-specific tool handler. name must match api/tools.js declarations. */
  registerDomain(name, handler) {
    this.domainHandlers.set(name, handler);
  }

  /** Remove a domain-specific tool handler. Safe to call with unknown names. */
  unregisterDomain(name) {
    this.domainHandlers.delete(name);
  }

  async handleToolCall({ id, name, args }) {
    const reply = (payload) => {
      this.send({ type: 'tool_result', id, name, ...payload });
    };
    try {
      const result = await this._execute(name, args || {});
      this.onToolNote(`${name}(${JSON.stringify(args || {})}) → ${safeJson(result)}`);
      reply({ ok: true, result });
    } catch (err) {
      const msg = (err && err.message) || String(err);
      this.onToolNote(`${name} failed: ${msg}`);
      reply({ ok: false, error: msg });
    }
  }

  async _execute(name, args) {
    switch (name) {
      case 'navigate': {
        const p = String(args.path || '').trim();
        if (!VALID_PATHS.has(p)) throw new Error(`Unknown path "${p}".`);
        this.onNavigate(p);
        return { navigated: p };
      }
      case 'click': {
        const el = findByAgentId(args.agent_id);
        if (!el) throw new Error(`No element with data-agent-id="${args.agent_id}".`);
        emitFlash(el);
        await waitForIdle();
        el.click();
        return { clicked: args.agent_id, text: textOf(el).slice(0, 200) };
      }
      case 'fill': {
        const el = findByAgentId(args.agent_id);
        if (!el) throw new Error(`No element with data-agent-id="${args.agent_id}".`);
        if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') {
          throw new Error(`Element "${args.agent_id}" is not an input/textarea.`);
        }
        emitFlash(el);
        await waitForIdle();
        el.focus();
        el.value = String(args.value ?? '');
        fireInputEvent(el);
        return { filled: args.agent_id, value: el.value };
      }
      case 'select': {
        const el = findByAgentId(args.agent_id);
        if (!el) throw new Error(`No element with data-agent-id="${args.agent_id}".`);
        if (el.tagName !== 'SELECT') throw new Error(`Element "${args.agent_id}" is not a <select>.`);
        const opt = String(args.option || '');
        const target = Array.from(el.options).find(
          (o) => (o.label || o.textContent || '').trim().toLowerCase() === opt.toLowerCase() ||
                 (o.value || '').toLowerCase() === opt.toLowerCase()
        );
        if (!target) throw new Error(`No option matching "${opt}".`);
        emitFlash(el);
        await waitForIdle();
        el.value = target.value;
        fireInputEvent(el);
        return { selected: args.agent_id, option: target.label || target.textContent };
      }
      case 'check': {
        const el = findByAgentId(args.agent_id);
        if (!el) throw new Error(`No element with data-agent-id="${args.agent_id}".`);
        if (el.tagName !== 'INPUT' || (el.type !== 'checkbox' && el.type !== 'radio')) {
          throw new Error(`Element "${args.agent_id}" is not a checkbox/radio.`);
        }
        emitFlash(el);
        el.checked = !!args.checked;
        fireInputEvent(el);
        return { checked: el.checked };
      }
      case 'read_text': {
        const el = findByAgentId(args.agent_id);
        if (!el) throw new Error(`No element with data-agent-id="${args.agent_id}".`);
        return { text: textOf(el).slice(0, 500) };
      }
      case 'highlight': {
        const el = findByAgentId(args.agent_id);
        if (!el) throw new Error(`No element with data-agent-id="${args.agent_id}".`);
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        emitFlash(el);
        return { highlighted: args.agent_id };
      }
      case 'submit_form': {
        const el = findByAgentId(args.agent_id);
        if (!el) throw new Error(`No element with data-agent-id="${args.agent_id}".`);
        if (el.tagName !== 'FORM') throw new Error(`Element "${args.agent_id}" is not a <form>.`);
        emitFlash(el);
        // requestSubmit runs validation + emits submit event; fallback to submit()
        if (typeof el.requestSubmit === 'function') el.requestSubmit();
        else el.submit();
        return { submitted: args.agent_id };
      }
      default: {
        const handler = this.domainHandlers.get(name);
        if (handler) return await handler(args);
        throw new Error(`Unknown tool: ${name}`);
      }
    }
  }
}

function safeJson(v) {
  try { return JSON.stringify(v).slice(0, 200); } catch { return '[unserialisable]'; }
}
