// Client-side tool executor + element-scanner. The server forwards tool_call
// messages from the model; we execute them here and return tool_result back.
//
// Security: we only act on elements currently present in the DOM with a
// matching data-agent-id. No `eval`, no arbitrary CSS selectors. Every tool
// that touches inputs emits native events so the page's own listeners react.

import {
  assignCarrierToLoad,
  getLoad,
  initDataStore,
  isReady,
  listCarriers,
  listLoads
} from './data-store.js';
import {
  selectAvailableCarriers,
  selectBookedRevenue,
  selectLoadsInMotion
} from './selectors.js';

const VALID_PATHS = new Set(['/', '/index.html', '/carriers.html', '/negotiate.html', '/contact.html', '/map.html']);

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

// latency-pass: was 120 ms setTimeout per click/fill/select — each tool burned
// ~120 ms of wall-clock before the action fired. The original intent was "let
// the flash animation start painting before we interact with the element".
// rAF-based yield gives the paint a tick (~16 ms on 60 Hz) while cutting the
// tool-call round-trip by ~100 ms. requestAnimationFrame is synchronous to the
// next paint; setTimeout(0) can be coalesced far later under load.
async function waitForIdle() {
  if (typeof requestAnimationFrame === 'function') {
    return new Promise((r) => requestAnimationFrame(() => r()));
  }
  return new Promise((r) => setTimeout(r, 0));
}

const DEBUG = (() => {
  try {
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('debug') === '1') return true;
    if (typeof localStorage !== 'undefined' && localStorage.getItem('jarvis.debug') === '1') return true;
  } catch {}
  return false;
})();
function dlog(...args) {
  if (!DEBUG) return;
  // eslint-disable-next-line no-console
  console.log('[tool-registry]', ...args);
}

/** Pad a number to 2 digits. */
function pad2(n) { return String(n).padStart(2, '0'); }
function pad3(n) { return String(n).padStart(3, '0'); }
function pad4(n) { return String(n).padStart(4, '0'); }

/** ISO week number (Mon-start) per RFC 3339 §4.1 / ISO 8601. Returns
 *  `YYYY-Www` where Www is 01-53. */
function isoWeekString(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${pad2(week)}`;
}

/**
 * Coerce a raw value into the format a given `<input type="...">` will
 * accept. Returns `{ value, ok, reason }`. When `ok === false`, `value`
 * is the best-effort string we tried (often '') and `reason` explains
 * the expected format.
 *
 * Pure function — exported for unit tests. Does NOT touch the DOM.
 *
 * Supported input types: datetime-local, date, time, month, week,
 * number, range, tel, email, url, search, password, text, textarea
 * (pass 'textarea' as the type). Any other type falls through to a
 * trimmed string.
 */
export function coerceFillValue(rawValue, inputType) {
  const type = String(inputType || 'text').toLowerCase();
  if (rawValue == null) return { ok: true, value: '' };
  const raw = String(rawValue);

  // Fast-path: empty value.
  if (!raw.length) return { ok: true, value: '' };

  switch (type) {
    case 'datetime-local': {
      // Accept any ISO-8601-ish string. <input type="datetime-local">
      // requires `YYYY-MM-DDTHH:MM` or `YYYY-MM-DDTHH:MM:SS` in LOCAL
      // time (no `Z`, no offset). We reformat to the minute-precision
      // form which is the most widely supported.
      const d = new Date(raw);
      if (isNaN(d.getTime())) {
        return {
          ok: false, value: '',
          reason: 'Could not parse as a date-time. Send ISO 8601 like 2027-04-05T13:30 or 2027-04-05T13:30:00Z.'
        };
      }
      const s = `${pad4(d.getFullYear())}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
      return { ok: true, value: s };
    }
    case 'date': {
      const d = new Date(raw);
      if (isNaN(d.getTime())) {
        return { ok: false, value: '', reason: 'Could not parse as a date. Send YYYY-MM-DD or any ISO 8601 date-time.' };
      }
      return { ok: true, value: `${pad4(d.getFullYear())}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` };
    }
    case 'time': {
      // Accept `HH:MM` / `HH:MM:SS` / `H:MM (AM|PM)` / a full datetime.
      const trimmed = raw.trim();
      // Try a direct HH:MM(:SS) match first.
      const direct = /^([0-1]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(trimmed);
      if (direct) {
        return { ok: true, value: `${pad2(direct[1])}:${pad2(direct[2])}` };
      }
      // Try AM/PM.
      const ampm = /^([0-1]?\d):([0-5]\d)\s*(am|pm)$/i.exec(trimmed);
      if (ampm) {
        let h = Number(ampm[1]);
        if (/pm/i.test(ampm[3]) && h < 12) h += 12;
        if (/am/i.test(ampm[3]) && h === 12) h = 0;
        return { ok: true, value: `${pad2(h)}:${pad2(ampm[2])}` };
      }
      // Fallback: parse as a full datetime and take HH:MM.
      const d = new Date(raw);
      if (!isNaN(d.getTime())) {
        return { ok: true, value: `${pad2(d.getHours())}:${pad2(d.getMinutes())}` };
      }
      return { ok: false, value: '', reason: 'Could not parse as a time. Send HH:MM in 24-hour time.' };
    }
    case 'month': {
      const d = new Date(raw);
      if (isNaN(d.getTime())) {
        return { ok: false, value: '', reason: 'Could not parse as a month. Send YYYY-MM.' };
      }
      return { ok: true, value: `${pad4(d.getFullYear())}-${pad2(d.getMonth() + 1)}` };
    }
    case 'week': {
      const d = new Date(raw);
      if (isNaN(d.getTime())) {
        return { ok: false, value: '', reason: 'Could not parse as a week. Send YYYY-Www.' };
      }
      return { ok: true, value: isoWeekString(d) };
    }
    case 'number':
    case 'range': {
      // Strip common noise: currency symbols, commas, trailing text.
      // Keep the first signed-number match.
      const cleaned = raw.replace(/[^\d.\-eE+]/g, '');
      const n = Number(cleaned);
      if (!Number.isFinite(n)) {
        return { ok: false, value: '', reason: `Could not parse "${raw}" as a number.` };
      }
      return { ok: true, value: String(n) };
    }
    case 'tel': {
      // Allow digits, +, -, (, ), space, and a leading plus. Strip
      // everything else (e.g. "ext. 123" or parenthetical notes).
      const cleaned = raw.replace(/[^\d+\-()\s]/g, '').trim();
      return { ok: true, value: cleaned };
    }
    case 'email': {
      return { ok: true, value: raw.trim() };
    }
    case 'url': {
      return { ok: true, value: raw.trim() };
    }
    case 'search':
    case 'password':
    case 'text':
    case 'textarea':
    default: {
      return { ok: true, value: raw };
    }
  }
}

/** Human-readable hint for the error payload when a set is rejected. */
export function formatHintFor(inputType) {
  switch (String(inputType || '').toLowerCase()) {
    case 'datetime-local': return 'YYYY-MM-DDTHH:MM (local time, no Z)';
    case 'date':           return 'YYYY-MM-DD';
    case 'time':           return 'HH:MM (24-hour)';
    case 'month':          return 'YYYY-MM';
    case 'week':           return 'YYYY-Www';
    case 'number':
    case 'range':          return 'a numeric string, no thousands separators or currency symbols';
    case 'tel':            return 'digits with optional +, -, (, ), spaces';
    case 'email':          return 'a valid email address';
    case 'url':            return 'a valid URL';
    default:               return 'plain text';
  }
}

export class ToolRegistry {
  /**
   * @param {object} opts
   * @param {(msg: object) => void} opts.sendTextMessage  send JSON envelope back to server
   * @param {(route: string) => void} opts.onNavigate     called with new path; default uses the SPA router if present, else full reload
   * @param {(summary: string) => void} [opts.onToolNote] UI-side hook to log tool actions
   * @param {() => boolean} [opts.showText] runtime flag: when false, onToolNote is called with the tool NAME only (no args, no results, no error messages).
   */
  constructor({ sendTextMessage, onNavigate, onToolNote, showText, transcriptMode }) {
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
    // Defaults to "text visible" — VoiceAgent overrides with a live getter.
    this.showText = typeof showText === 'function' ? showText : () => true;
    // Live getter for the transcript display mode. When it returns 'off'
    // or 'captions', tool-note rendering is suppressed (tool execution
    // itself is unaffected). Default 'full' for callers that don't pass one.
    this.transcriptMode = typeof transcriptMode === 'function' ? transcriptMode : () => 'full';
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
    // latency-pass: tool_call → tool_result round-trip telemetry. Gated on
    // localStorage['jarvis.debug']==='1'; zero cost otherwise. The model
    // perceives "action speed" as the time from it emitting toolCall to us
    // returning toolResult — this is priority-3 in the audit.
    const rttStart = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const reply = (payload) => {
      this.send({ type: 'tool_result', id, name, ...payload });
      try {
        if (typeof localStorage !== 'undefined' && localStorage.getItem('jarvis.debug') === '1') {
          const rtt = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - rttStart);
          // eslint-disable-next-line no-console
          console.log(`[jarvis phase] tool_rtt ${name} ${rtt}ms ok=${payload && payload.ok !== false}`);
        }
      } catch {}
    };
    const textVisible = !!this.showText();
    // Mode-gated UI notes: off/captions modes skip transcript noise.
    const renderNote = this.transcriptMode() === 'full';
    try {
      const result = await this._execute(name, args || {});
      // When SHOW_TEXT=false the operator asked us to show tool NAMES only;
      // args/values can contain user-spoken content.
      if (renderNote) {
        if (textVisible) {
          this.onToolNote(`${name}(${JSON.stringify(args || {})}) → ${safeJson(result)}`);
        } else {
          this.onToolNote(name);
        }
      }
      reply({ ok: true, result });
    } catch (err) {
      const msg = (err && err.message) || String(err);
      if (renderNote) {
        if (textVisible) {
          this.onToolNote(`${name} failed: ${msg}`);
        } else {
          this.onToolNote(`${name} (failed)`);
        }
      }
      // Attach structured fillFailure so the model sees what format we
      // expected. If present we also bundle it into `result` (on the
      // ok:false side of the envelope) for richer context.
      const envelope = { ok: false, error: msg };
      if (err && err.fillFailure) envelope.result = { fill_failure: err.fillFailure };
      if (err && err.code) envelope.code = err.code;
      if (err && err.recovery) envelope.recovery = err.recovery;
      reply(envelope);
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
        const rawValue = args.value == null ? '' : String(args.value);
        const inputType = el.tagName === 'TEXTAREA'
          ? 'textarea'
          : (el.getAttribute('type') || 'text').toLowerCase();
        const coerced = coerceFillValue(rawValue, inputType);
        dlog('fill', args.agent_id, 'type=' + inputType, 'requested=' + JSON.stringify(rawValue), 'coerced=' + JSON.stringify(coerced));

        if (!coerced.ok) {
          // Coercion failed — tell the model exactly what went wrong.
          const err = new Error(
            `fill_failed: input "${args.agent_id}" type=${inputType} rejected "${rawValue}". ${coerced.reason} Try again with the required format.`
          );
          err.fillFailure = {
            agent_id: args.agent_id,
            input_type: inputType,
            requested: rawValue,
            actual: '',
            reason: coerced.reason
          };
          throw err;
        }

        emitFlash(el);
        await waitForIdle();
        el.focus();
        el.value = coerced.value;
        fireInputEvent(el);

        // Verify-back read: if the DOM rejected our value (empty after
        // set despite non-empty input), surface a descriptive error so
        // the model can retry with a different format rather than
        // silently continuing on a lie.
        const actual = String(el.value == null ? '' : el.value);
        if (rawValue !== '' && actual === '') {
          dlog('fill', args.agent_id, 'value rejected by DOM — actual empty');
          const err = new Error(
            `fill_failed: input "${args.agent_id}" type=${inputType} accepted "${coerced.value}" but its value stayed empty — the browser rejected the format. Required format: ${formatHintFor(inputType)}.`
          );
          err.fillFailure = {
            agent_id: args.agent_id,
            input_type: inputType,
            requested: rawValue,
            coerced: coerced.value,
            actual: '',
            reason: `Browser rejected the coerced value. Required format: ${formatHintFor(inputType)}.`
          };
          throw err;
        }
        return {
          filled: args.agent_id,
          input_type: inputType,
          requested: rawValue,
          value: actual
        };
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
      case 'read_modal': {
        const root =
          document.querySelector('[data-modal-root="load"].is-open') ||
          document.querySelector('.carrier-panel.is-open') ||
          document.querySelector('[data-modal-root].is-open');
        if (!root || !isVisible(root)) return { open: false };
        const isLoad = root.matches('[data-modal-root="load"]') || !!root.querySelector('[data-modal-field]');
        const kind = isLoad ? 'load' : 'carrier';
        let title = '';
        const titleEl = root.querySelector('[data-modal-field="title"]')
          || root.querySelector('.carrier-panel-name')
          || root.querySelector('.load-modal-title');
        if (titleEl) title = (titleEl.textContent || '').trim();
        const fields = {};
        root.querySelectorAll('[data-modal-field]').forEach((el) => {
          const k = el.getAttribute('data-modal-field');
          if (!k) return;
          fields[k] = (el.textContent || '').trim();
        });
        // Carrier panel doesn't use data-modal-field — fall back to common selectors.
        if (kind === 'carrier' && Object.keys(fields).length === 0) {
          const map = {
            name: '.carrier-panel-name',
            ids: '.carrier-panel-ids',
            status: '.carrier-panel-status',
            eta: '.carrier-panel-eta',
            speed: '.carrier-panel-speed',
            heading: '.carrier-panel-heading',
            driver_name: '.carrier-panel-driver-name',
            driver_hos: '.carrier-panel-driver-hos'
          };
          Object.entries(map).forEach(([k, sel]) => {
            const el = root.querySelector(sel);
            if (el) fields[k] = (el.textContent || '').trim();
          });
        }
        const actions = [];
        root.querySelectorAll('[data-agent-id*=".action."]').forEach((el) => {
          if (isVisible(el)) actions.push(el.getAttribute('data-agent-id'));
        });
        // Carrier panel uses [data-action] instead of agent-id action verbs.
        if (kind === 'carrier') {
          root.querySelectorAll('[data-action]').forEach((el) => {
            if (isVisible(el)) actions.push(`carrier_panel.action.${el.getAttribute('data-action')}`);
          });
        }
        return { open: true, kind, title, fields, actions };
      }
      case 'close_modal': {
        if (typeof window !== 'undefined' && window.__modals && typeof window.__modals.closeAll === 'function') {
          window.__modals.closeAll();
        }
        // Carrier panel: simulate close-button click if still open.
        const carrierClose = document.querySelector('.carrier-panel.is-open .carrier-panel-close');
        if (carrierClose) { try { carrierClose.click(); } catch {} }
        const anyOpen =
          document.querySelector('[data-modal-root].is-open') ||
          document.querySelector('.carrier-panel.is-open');
        return { closed: !anyOpen };
      }
      case 'get_load': {
        const handler = this.domainHandlers.get(name);
        if (handler) return await handler(args);
        await initDataStore();
        const id = String(args.load_id || args.id || '').trim();
        const load = getLoad(id);
        if (!load) return { ok: false, error: `No load ${id || args.load_id}` };
        return { ok: true, load };
      }
      case 'assign_carrier': {
        const handler = this.domainHandlers.get(name);
        if (handler) return await handler(args);
        await initDataStore();
        try {
          const result = assignCarrierToLoad(args.load_id, args.carrier_id, { source: 'agent' });
          return { ok: true, load: result.load, carrier: result.carrier };
        } catch (err) {
          return { ok: false, error: err && err.message || String(err) };
        }
      }
      case 'filter_loads': {
        const handler = this.domainHandlers.get(name);
        if (handler) return await handler(args);
        return applyDispatchFilters(args || {});
      }
      case 'filter_carriers': {
        const handler = this.domainHandlers.get(name);
        if (handler) return await handler(args);
        return applyCarrierFilters(args || {});
      }
      case 'get_live_state': {
        const handler = this.domainHandlers.get(name);
        if (handler) return await handler(args);
        await initDataStore();
        const loadRows = listLoads();
        const carrierRows = listCarriers();
        return {
          now_iso: new Date().toISOString(),
          loads_in_motion: selectLoadsInMotion(loadRows),
          carriers_online: selectAvailableCarriers(carrierRows),
          revenue_booked_today_usd: selectBookedRevenue(loadRows)
        };
      }
      default: {
        const handler = this.domainHandlers.get(name);
        if (handler) return await handler(args);
        const err = new Error(`Tool "${name}" is not available on the current page. Navigate to the correct page first.`);
        err.code = 'tool_not_available';
        err.recovery = 'Use the navigate tool to go to the page where this tool is registered, then retry.';
        throw err;
      }
    }
  }
}

/**
 * Drive the dispatch-page filter inputs by agent_id. Used by the
 * `filter_loads` tool handler AND the URL query restore on page load.
 * Pure DOM driver — safe even if the inputs don't exist (returns ok:false).
 */
export function applyDispatchFilters({ status, lane_contains, carrier_contains, min_miles, max_miles }) {
  const changes = {};
  const statusEl = document.querySelector('[data-agent-id="dispatch.filters.status"]');
  const laneEl = document.querySelector('[data-agent-id="dispatch.filters.lane"]');
  const searchEl = document.querySelector('[data-agent-id="dispatch.filters.search"]');
  if (!statusEl || !laneEl || !searchEl) {
    return { ok: false, error: 'Dispatch filters not mounted. Navigate to the Dispatch page first.' };
  }
  if (typeof status === 'string' && status) {
    statusEl.value = status;
    statusEl.dispatchEvent(new Event('input', { bubbles: true }));
    statusEl.dispatchEvent(new Event('change', { bubbles: true }));
    changes.status = status;
  }
  if (typeof lane_contains === 'string') {
    laneEl.value = lane_contains;
    laneEl.dispatchEvent(new Event('input', { bubbles: true }));
    changes.lane_contains = lane_contains;
  }
  // Use search box to encode carrier + numeric filters since the page's
  // native filter uses a single text search across id/lane/carrier/commodity.
  const searchParts = [];
  if (typeof carrier_contains === 'string' && carrier_contains) searchParts.push(carrier_contains);
  if (searchParts.length) {
    searchEl.value = searchParts.join(' ');
    searchEl.dispatchEvent(new Event('input', { bubbles: true }));
    changes.carrier_contains = carrier_contains;
  }
  if (Number.isFinite(Number(min_miles))) changes.min_miles = Number(min_miles);
  if (Number.isFinite(Number(max_miles))) changes.max_miles = Number(max_miles);
  syncUrlFilters('dispatch', { status, lane_contains, carrier_contains, min_miles, max_miles });
  const result = { ok: true, applied: changes };
  if (isReady()) {
    result.count = listLoads({
      status: typeof status === 'string' && status && status !== 'all' ? status : undefined,
      search: carrier_contains,
      predicate: (load) => {
        if (typeof lane_contains === 'string' && lane_contains) {
          const lane = `${load.pickup || ''} ${load.dropoff || ''}`.toLowerCase();
          if (!lane.includes(lane_contains.toLowerCase())) return false;
        }
        const miles = Number(load.miles);
        if (Number.isFinite(Number(min_miles)) && miles < Number(min_miles)) return false;
        if (Number.isFinite(Number(max_miles)) && miles > Number(max_miles)) return false;
        return true;
      }
    }).length;
  }
  return result;
}

/** Drive the carriers-page filter inputs. */
export function applyCarrierFilters({ equipment, available, search }) {
  const eqEl = document.querySelector('[data-agent-id="carriers.filters.equipment"]');
  const avEl = document.querySelector('[data-agent-id="carriers.filters.available"]');
  const qEl = document.querySelector('[data-agent-id="carriers.filters.search"]');
  if (!eqEl || !avEl || !qEl) {
    return { ok: false, error: 'Carrier filters not mounted. Navigate to the Carriers page first.' };
  }
  const changes = {};
  if (typeof equipment === 'string' && equipment) {
    eqEl.value = equipment;
    eqEl.dispatchEvent(new Event('change', { bubbles: true }));
    changes.equipment = equipment;
  }
  if (typeof available === 'string' && available) {
    avEl.value = available;
    avEl.dispatchEvent(new Event('change', { bubbles: true }));
    changes.available = available;
  }
  if (typeof search === 'string') {
    qEl.value = search;
    qEl.dispatchEvent(new Event('input', { bubbles: true }));
    changes.search = search;
  }
  syncUrlFilters('carriers', { equipment, available, search });
  const result = { ok: true, applied: changes };
  if (isReady()) {
    result.count = listCarriers({
      available: available === 'yes' ? true : available === 'no' ? false : undefined,
      search,
      predicate: (carrier) => {
        if (typeof equipment === 'string' && equipment && equipment !== 'all') {
          return carrier.equipment.map((item) => item.toLowerCase()).includes(equipment.toLowerCase());
        }
        return true;
      }
    }).length;
  }
  return result;
}

function syncUrlFilters(domain, params) {
  try {
    const url = new URL(location.href);
    Object.keys(params).forEach((k) => {
      const v = params[k];
      const key = `${domain}.${k}`;
      if (v == null || v === '' || v === 'all') url.searchParams.delete(key);
      else url.searchParams.set(key, String(v));
    });
    history.replaceState(null, '', url.toString());
  } catch {}
}

/** On page load, restore filters from the URL query (if any). Called by
 *  page modules after they've bound their own filter inputs. */
export function restoreFiltersFromUrl(domain) {
  try {
    const url = new URL(location.href);
    const read = (k) => url.searchParams.get(`${domain}.${k}`);
    if (domain === 'dispatch') {
      const status = read('status');
      const lane = read('lane_contains');
      const carrier = read('carrier_contains');
      if (status || lane || carrier) {
        applyDispatchFilters({
          status: status || undefined,
          lane_contains: lane || undefined,
          carrier_contains: carrier || undefined
        });
      }
    } else if (domain === 'carriers') {
      const equipment = read('equipment');
      const available = read('available');
      const search = read('search');
      if (equipment || available || search) {
        applyCarrierFilters({
          equipment: equipment || undefined,
          available: available || undefined,
          search: search || undefined
        });
      }
    }
  } catch {}
}

function safeJson(v) {
  try { return JSON.stringify(v).slice(0, 200); } catch { return '[unserialisable]'; }
}
