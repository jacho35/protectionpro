/* ProtectionPro — Shared UI helpers
 *
 * Toast notifications and promise-based modal dialogs that replace the native
 * blocking alert()/confirm()/prompt(). Works on desktop and mobile; the mobile
 * toast (MobileUI.showToast) delegates here so there is a single toast system.
 *
 * Usage:
 *   UI.toast('Saved', 'success');
 *   await UI.alert('Something happened');
 *   if (await UI.confirm('Delete this?', { danger: true })) { ... }
 *   const name = await UI.prompt('Project name:', 'Untitled');  // null if cancelled
 */
const UI = {
  _toastContainer: null,

  // ─── Toasts ────────────────────────────────────────────────────────────────

  toast(message, type = 'info', duration = 3200) {
    // Alias the historical 'warn' spelling to the styled 'warning' class so the
    // amber toast style applies (only .toast-warning exists in app.css).
    if (type === 'warn') type = 'warning';
    if (!this._toastContainer) {
      let c = document.getElementById('toast-container');
      if (!c) {
        c = document.createElement('div');
        c.id = 'toast-container';
        c.setAttribute('aria-live', 'polite');
        c.setAttribute('aria-atomic', 'false');
        document.body.appendChild(c);
      }
      this._toastContainer = c;
    }

    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    el.textContent = message;
    this._toastContainer.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));

    const remove = () => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 250);
    };
    const timer = setTimeout(remove, duration);
    el.addEventListener('click', () => { clearTimeout(timer); remove(); });
    return el;
  },

  // ─── Global busy overlay ─────────────────────────────────────────────────────
  // Reference-counted so overlapping analyses keep the lock until the last one
  // finishes. Blocks canvas/toolbar interaction while a request is in flight.
  _busyCount: 0,

  setBusy(on, label = 'Working…') {
    this._busyCount = Math.max(0, this._busyCount + (on ? 1 : -1));
    let overlay = document.getElementById('busy-overlay');
    if (this._busyCount > 0) {
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'busy-overlay';
        overlay.setAttribute('role', 'status');
        overlay.setAttribute('aria-live', 'polite');
        overlay.innerHTML = '<div class="busy-box"><div class="busy-spinner"></div>' +
          '<div class="busy-label"></div></div>';
        document.body.appendChild(overlay);
      }
      overlay.querySelector('.busy-label').textContent = label;
      overlay.classList.add('visible');
    } else if (overlay) {
      overlay.classList.remove('visible');
    }
  },

  // ─── Dialogs (promise-based) ─────────────────────────────────────────────────

  alert(message, opts = {}) {
    return this._dialog({ kind: 'alert', message, title: 'Notice', ...opts });
  },

  confirm(message, opts = {}) {
    return this._dialog({ kind: 'confirm', message, title: 'Confirm', ...opts });
  },

  prompt(message, defaultValue = '', opts = {}) {
    return this._dialog({ kind: 'prompt', message, title: 'Input', defaultValue, ...opts });
  },

  _dialog({ kind, message, title, defaultValue = '', okText, cancelText, danger }) {
    return new Promise((resolve) => {
      const prevFocus = document.activeElement;

      const overlay = document.createElement('div');
      overlay.className = 'modal ui-dialog';
      overlay.style.zIndex = '3000';

      const content = document.createElement('div');
      content.className = 'modal-content ui-dialog-content';
      content.setAttribute('role', kind === 'alert' ? 'alertdialog' : 'dialog');
      content.setAttribute('aria-modal', 'true');

      const titleId = 'ui-dialog-title';
      const okLabel = okText || (kind === 'alert' ? 'OK' : kind === 'prompt' ? 'OK' : 'OK');
      const cancelLabel = cancelText || 'Cancel';

      let bodyHtml = `<div class="modal-header"><h3 id="${titleId}"></h3></div>`;
      bodyHtml += `<div class="modal-body"><p class="ui-dialog-message"></p>`;
      if (kind === 'prompt') {
        bodyHtml += `<input type="text" class="ui-dialog-input" />`;
      }
      bodyHtml += `<div class="ui-dialog-actions">`;
      if (kind !== 'alert') {
        bodyHtml += `<button type="button" class="btn-small ui-dialog-cancel"></button>`;
      }
      bodyHtml += `<button type="button" class="btn-primary ui-dialog-ok${danger ? ' ui-dialog-danger' : ''}"></button>`;
      bodyHtml += `</div></div>`;
      content.innerHTML = bodyHtml;
      content.setAttribute('aria-labelledby', titleId);
      overlay.appendChild(content);
      document.body.appendChild(overlay);

      // Text content set via .textContent to avoid HTML injection; newlines kept
      content.querySelector('h3').textContent = title;
      content.querySelector('.ui-dialog-message').textContent = message;
      const okBtn = content.querySelector('.ui-dialog-ok');
      okBtn.textContent = okLabel;
      const cancelBtn = content.querySelector('.ui-dialog-cancel');
      if (cancelBtn) cancelBtn.textContent = cancelLabel;
      const input = content.querySelector('.ui-dialog-input');
      if (input) input.value = defaultValue;

      let settled = false;
      const cleanup = (result) => {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        // Restore focus to whatever triggered the dialog
        if (prevFocus && typeof prevFocus.focus === 'function') {
          try { prevFocus.focus(); } catch (_) { /* element gone */ }
        }
        resolve(result);
      };

      const confirmResult = () => {
        if (kind === 'prompt') cleanup(input ? input.value : '');
        else if (kind === 'confirm') cleanup(true);
        else cleanup(undefined);
      };
      const cancelResult = () => {
        if (kind === 'prompt') cleanup(null);
        else if (kind === 'confirm') cleanup(false);
        else cleanup(undefined);
      };

      okBtn.addEventListener('click', confirmResult);
      if (cancelBtn) cancelBtn.addEventListener('click', cancelResult);
      // Click on the backdrop cancels (same as Escape)
      overlay.addEventListener('mousedown', (e) => {
        if (e.target === overlay) cancelResult();
      });

      // Focus trap: keep Tab within the dialog, Esc cancels, Enter confirms
      const focusables = () => [...content.querySelectorAll(
        'button, input, [href], select, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter(el => !el.disabled && el.offsetParent !== null);

      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          cancelResult();
        } else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') {
          e.preventDefault();
          confirmResult();
        } else if (e.key === 'Tab') {
          const items = focusables();
          if (items.length === 0) return;
          const first = items[0];
          const last = items[items.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      };
      document.addEventListener('keydown', onKey, true);

      // Initial focus: prompt input, else the primary button
      requestAnimationFrame(() => {
        if (input) { input.focus(); input.select(); }
        else okBtn.focus();
      });
    });
  },
};

/* ─── ModalFocus ──────────────────────────────────────────────────────────────
 * Focus management for the app's existing modals (the ones toggled via
 * `style.display`). When a modal becomes visible it records the element that
 * had focus, moves focus into the modal, and traps Tab within it; when hidden
 * it restores focus to the trigger. The UI.* dialogs above manage their own
 * focus, so they are excluded here.
 */
const ModalFocus = {
  _stack: [],

  init() {
    document.querySelectorAll('.modal').forEach(m => this._observe(m));
  },

  _observe(modal) {
    if (modal.classList.contains('ui-dialog')) return; // dialogs self-manage
    const mo = new MutationObserver(() => {
      const visible = modal.style.display !== 'none';
      const tracked = this._stack.some(e => e.modal === modal);
      if (visible && !tracked) this._open(modal);
      else if (!visible && tracked) this._close(modal);
    });
    mo.observe(modal, { attributes: true, attributeFilter: ['style'] });
  },

  _focusables(modal) {
    return [...modal.querySelectorAll(
      'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])')]
      .filter(el => !el.disabled && el.offsetParent !== null);
  },

  _open(modal) {
    const prevFocus = document.activeElement;
    const onKey = (e) => {
      if (e.key !== 'Tab') return;
      const items = this._focusables(modal);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      // If focus escaped the modal entirely, pull it back
      if (!modal.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
        return;
      }
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    modal.addEventListener('keydown', onKey);
    this._stack.push({ modal, prevFocus, onKey });

    // Only steal focus if an open-handler hasn't already focused something inside
    if (!modal.contains(document.activeElement)) {
      const items = this._focusables(modal);
      if (items.length) items[0].focus();
    }
  },

  _close(modal) {
    const idx = this._stack.map(e => e.modal).lastIndexOf(modal);
    if (idx === -1) return;
    const entry = this._stack.splice(idx, 1)[0];
    modal.removeEventListener('keydown', entry.onKey);
    // Restore focus to the trigger element if it's still around and focusable
    if (entry.prevFocus && typeof entry.prevFocus.focus === 'function' &&
        document.body.contains(entry.prevFocus)) {
      try { entry.prevFocus.focus(); } catch (_) { /* gone */ }
    }
  },
};

document.addEventListener('DOMContentLoaded', () => ModalFocus.init());
