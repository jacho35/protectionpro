/* ProtectionPro — one header layout for every workspace (UX plan, item 112).
 *
 * Every workspace toolbar ends with the same cluster, on the right:
 *     ⚙ Settings · primary action (blue) · ? Guide
 * Each workspace builds its own toolbar; this moves the parts that belong in
 * the cluster into a `.ws-tail` at the end of it, again after each re-render.
 * A workspace's standing settings (volt-drop limits, snaking …) live in a
 * `.ws-pop` — a Settings button with a small panel — instead of the row.
 *
 * `SPECS` is the table: host = the toolbar, settings / primary = what to move
 * (either may be absent), guide = the "? Guide" link the help module put there.
 */

const WsHead = {
  SPECS: [
    { host: '.sch-toolbar', settings: '#sch-side-toggle', primary: '#sch-run-check' },
    { host: '.sl-toolbar', settings: '.ws-pop' },
    { host: '#plan-toolbar' },
    { host: '#ov-main .ov-acts', primary: '[data-ov="calc"]' },
  ],

  // The order of a cluster's parts: settings, primary, guide.
  order(parts) { return ['settings', 'primary', 'guide'].filter(k => parts[k]); },

  sync() {
    for (const spec of this.SPECS) {
      for (const host of document.querySelectorAll(spec.host)) {
        const parts = {
          settings: spec.settings && host.querySelector(spec.settings),
          primary: spec.primary && host.querySelector(spec.primary),
          guide: host.querySelector('.hg-link'),
        };
        if (!parts.settings && !parts.primary && !parts.guide) continue;
        let tail = host.querySelector(':scope > .ws-tail');
        if (!tail) { tail = document.createElement('div'); tail.className = 'ws-tail'; host.appendChild(tail); }
        else if (host.lastElementChild !== tail) host.appendChild(tail);
        let prev = null;
        for (const k of this.order(parts)) {
          const el = parts[k];
          if (k === 'primary') el.classList.add('ws-primary');
          if (el.parentNode !== tail || (prev && prev.nextElementSibling !== el) || (!prev && tail.firstElementChild !== el)) {
            if (prev) prev.insertAdjacentElement('afterend', el); else tail.insertBefore(el, tail.firstChild);
          }
          prev = el;
        }
      }
    }
  },

  init() {
    // Settings popover: the button shows / hides its panel; a click elsewhere closes it.
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.ws-pop > button');
      document.querySelectorAll('.ws-pop.open').forEach(p => { if (!btn || p !== btn.parentNode) this._toggle(p, false); });
      if (btn) this._toggle(btn.parentNode, !btn.parentNode.classList.contains('open'));
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') document.querySelectorAll('.ws-pop.open').forEach(p => this._toggle(p, false));
    });
    let t = null;
    new MutationObserver(() => { if (!t) t = requestAnimationFrame(() => { t = null; this.sync(); }); })
      .observe(document.body, { childList: true, subtree: true });
    this.sync();
  },

  _toggle(pop, open) {
    pop.classList.toggle('open', open);
    const b = pop.querySelector(':scope > button');
    if (b) b.setAttribute('aria-expanded', String(open));
  },
};
