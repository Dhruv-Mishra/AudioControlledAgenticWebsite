let toastRegion = null;
let activeDialog = null;
const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function ensureToastRegion() {
  if (toastRegion && document.body.contains(toastRegion)) return toastRegion;
  toastRegion = document.createElement('div');
  toastRegion.className = 'action-toast-region';
  toastRegion.setAttribute('role', 'status');
  toastRegion.setAttribute('aria-live', 'polite');
  toastRegion.setAttribute('aria-atomic', 'false');
  document.body.appendChild(toastRegion);
  return toastRegion;
}

export function notify(message, opts = {}) {
  const region = ensureToastRegion();
  const toast = document.createElement('div');
  const kind = opts.kind || 'info';
  toast.className = `action-toast action-toast--${kind}`;
  toast.textContent = String(message || 'Done.');
  region.appendChild(toast);
  const timeout = Number(opts.timeout || 3600);
  window.setTimeout(() => {
    toast.classList.add('is-leaving');
    window.setTimeout(() => toast.remove(), 220);
  }, timeout);
  return toast;
}

function fieldMarkup(field) {
  const id = `action-field-${field.name}`;
  const value = field.value == null ? '' : field.value;
  const common = `id="${escapeHtml(id)}" name="${escapeHtml(field.name)}" class="${field.type === 'textarea' ? 'textarea' : 'input'}" ${field.required ? 'required' : ''} ${field.placeholder ? `placeholder="${escapeHtml(field.placeholder)}"` : ''}`;
  const control = field.type === 'textarea'
    ? `<textarea ${common} rows="${Number(field.rows || 4)}">${escapeHtml(value)}</textarea>`
    : `<input ${common} type="${escapeHtml(field.type || 'text')}" value="${escapeHtml(value)}" />`;
  return `<div class="field">
    <label class="field-label" for="${escapeHtml(id)}">${escapeHtml(field.label || field.name)}</label>
    ${control}
  </div>`;
}

function getFocusableElements(container) {
  return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter((el) => {
    if (!el || el.getAttribute('aria-hidden') === 'true') return false;
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  });
}

function trapFocus(event, container) {
  const focusable = getFocusableElements(container);
  if (!focusable.length) {
    event.preventDefault();
    try { container.focus(); } catch {}
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (!container.contains(active)) {
    event.preventDefault();
    first.focus();
    return;
  }
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
    return;
  }
  if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

export function showActionDialog(options = {}) {
  if (activeDialog) activeDialog.close();
  const fields = Array.isArray(options.fields) ? options.fields : [];
  const backdrop = document.createElement('div');
  backdrop.className = 'action-dialog-backdrop';
  backdrop.innerHTML = `
    <form class="action-dialog" role="dialog" aria-modal="true" aria-labelledby="action-dialog-title">
      <header class="action-dialog-head">
        <div>
          <h2 id="action-dialog-title">${escapeHtml(options.title || 'Action')}</h2>
          ${options.description ? `<p class="muted">${escapeHtml(options.description)}</p>` : ''}
        </div>
        <button class="icon-btn action-dialog-close" type="button" aria-label="Close">&times;</button>
      </header>
      <div class="action-dialog-body stack">
        ${fields.map(fieldMarkup).join('')}
      </div>
      <footer class="action-dialog-actions">
        <button class="btn btn--ghost" type="button" data-action="cancel">Cancel</button>
        <button class="btn btn--primary" type="submit">${escapeHtml(options.primaryLabel || 'Done')}</button>
      </footer>
    </form>
  `;
  const form = backdrop.querySelector('.action-dialog');
  const closeBtn = backdrop.querySelector('.action-dialog-close');
  const cancelBtn = backdrop.querySelector('[data-action="cancel"]');
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const handleKeydown = (event) => {
    if (event.key === 'Escape') close();
    if (event.key === 'Tab') trapFocus(event, form);
  };

  const close = () => {
    document.removeEventListener('keydown', handleKeydown, true);
    backdrop.remove();
    activeDialog = null;
    try { previous && previous.focus(); } catch {}
  };

  activeDialog = { close };

  closeBtn.addEventListener('click', close);
  cancelBtn.addEventListener('click', close);
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) close();
  });
  document.addEventListener('keydown', handleKeydown, true);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    const result = typeof options.onSubmit === 'function' ? options.onSubmit(data, form) : undefined;
    if (result !== false) close();
  });

  document.body.appendChild(backdrop);
  const focusTarget = form.querySelector('input, textarea, select, button');
  try { focusTarget && focusTarget.focus(); } catch {}

  return activeDialog;
}
