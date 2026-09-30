/* ProtectionPro — SearchSelect: a type-to-filter box over a native <select>.
 *
 *   SearchSelect.attach(selectEl, { placeholder })
 *
 * The <select> stays the source of truth (its options, optgroups, value and
 * the table's own `change` handler): it is hidden, and a text box + list is
 * drawn beside it. Picking an entry sets select.value and fires a bubbling
 * `change` on the select, so the caller's code does not change at all.
 *
 * Search is a wildcard match on the option text, case-insensitive:
 *   words match in any order     "cu 16"    → 16mm² Cu PVC LV
 *   * any run, ? one character   "16*xlpe"  → 16mm² Cu XLPE LV
 *   mm2 matches mm²              "16mm2"    → 16mm² …
 * Keyboard: ↓/↑ move, Enter picks, Esc closes (restores the current value).
 * The list is position: fixed so it is never clipped by a scrolling dialog.
 * Re-attach after the <select> is re-rendered (a new element is a new attach).
 * An <option data-ss-always> (e.g. CableLib's "Show all cables…") is listed
 * whatever is typed, so a filtered-out entry is never a dead end.
 */

const SearchSelect = {
  _norm(s) { return String(s || '').toLowerCase().replace(/²/g, '2').replace(/³/g, '3').replace(/\s+/g, ' '); },

  // One RegExp per whitespace-separated term; every term must match.
  _terms(q) {
    return this._norm(q).trim().split(' ').filter(Boolean).map(t =>
      new RegExp(t.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')));
  },

  attach(select, opts = {}) {
    if (!select || select._ss) return select && select._ss;
    const wrap = document.createElement('div');
    wrap.className = 'ss';
    wrap.innerHTML = `<input type="text" class="ss-input" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="false" aria-autocomplete="list">
      <span class="ss-caret" aria-hidden="true">▾</span>`;
    const list = document.createElement('div');
    list.className = 'ss-list';
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    const input = wrap.querySelector('.ss-input');
    input.placeholder = opts.placeholder || 'Type to search…';
    if (select.title) input.title = select.title;
    select.classList.add('ss-native');
    select.after(wrap);
    document.body.appendChild(list);
    const st = { select, wrap, input, list, active: -1, items: [] };
    select._ss = st;

    const current = () => select.options[select.selectedIndex];
    const showCurrent = () => { const o = current(); input.value = o && o.value ? o.textContent.trim() : ''; };
    showCurrent();

    const build = (q) => {
      const terms = this._terms(q);
      const html = [];
      st.items = [];
      const addOpt = (o) => {
        if (o.value === '' && !o.textContent.trim().startsWith('—') && !o.hasAttribute('data-ss-always')) return;
        const text = o.textContent.trim();
        if (terms.length && !o.hasAttribute('data-ss-always') && !terms.every(r => r.test(this._norm(text)))) return;
        const i = st.items.length;
        st.items.push(o);
        html.push(`<div class="ss-opt${o.value === select.value ? ' sel' : ''}${o.disabled ? ' dis' : ''}" role="option" data-i="${i}">${escHtml(text)}</div>`);
      };
      for (const child of select.children) {
        if (child.tagName === 'OPTGROUP') {
          const before = html.length;
          for (const o of child.children) addOpt(o);
          if (html.length > before) html.splice(before, 0, `<div class="ss-group">${escHtml(child.label)}</div>`);
        } else addOpt(child);
      }
      list.innerHTML = html.length ? html.join('') : '<div class="ss-empty">No matches</div>';
      st.active = st.items.findIndex(o => o.value === select.value && !terms.length);
      // Typing highlights the first real match; an always-listed entry only
      // when its own text matches (e.g. "custom" → "-- Custom --").
      if (st.active < 0 && terms.length) st.active = st.items.findIndex(o => !o.disabled && !o.hasAttribute('data-ss-always'));
      if (st.active < 0 && terms.length) st.active = st.items.findIndex(o => !o.disabled && terms.every(r => r.test(this._norm(o.textContent.trim()))));
      mark();
    };
    const mark = () => {
      list.querySelectorAll('.ss-opt').forEach(el => el.classList.toggle('act', +el.dataset.i === st.active));
      const a = list.querySelector('.ss-opt.act');
      if (a) a.scrollIntoView({ block: 'nearest' });
    };
    const place = () => {
      const r = input.getBoundingClientRect();
      const below = window.innerHeight - r.bottom - 8, above = r.top - 8;
      const h = Math.min(320, Math.max(below, above));
      const w = Math.min(Math.max(r.width, 220), window.innerWidth - 8);
      list.style.left = Math.max(4, Math.min(r.left, window.innerWidth - w - 4)) + 'px';
      list.style.width = w + 'px';
      list.style.maxHeight = h + 'px';
      if (below >= Math.min(200, above)) { list.style.top = (r.bottom + 2) + 'px'; list.style.bottom = ''; }
      else { list.style.top = ''; list.style.bottom = (window.innerHeight - r.top + 2) + 'px'; }
    };
    const open = (q = '') => {
      build(q);
      place();
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    };
    const close = (restore = true) => {
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      if (restore) showCurrent();
    };
    const pick = (i) => {
      const o = st.items[i];
      if (!o || o.disabled) return;
      close(false);
      if (select.value !== o.value) {
        select.value = o.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      showCurrent();
    };

    input.addEventListener('focus', () => { input.select(); open(''); });
    input.addEventListener('click', () => { if (list.hidden) { input.select(); open(''); } });
    input.addEventListener('input', () => { if (list.hidden) { place(); list.hidden = false; } build(input.value); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (list.hidden) { open(''); return; }
        const step = e.key === 'ArrowDown' ? 1 : -1;
        let i = st.active;
        for (let k = 0; k < st.items.length; k++) {
          i = (i + step + st.items.length) % st.items.length;
          if (!st.items[i].disabled) break;
        }
        st.active = i; mark();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (!list.hidden && st.active >= 0) pick(st.active);
      } else if (e.key === 'Escape') {
        if (!list.hidden) { e.stopPropagation(); close(); }
      } else if (e.key === 'Tab') close();
    });
    input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== input) close(); }, 150));
    // pointerdown so the pick lands before the input's blur closes the list
    list.addEventListener('pointerdown', (e) => {
      const el = e.target.closest('.ss-opt');
      e.preventDefault();
      if (el) pick(+el.dataset.i);
    });
    wrap.querySelector('.ss-caret').addEventListener('pointerdown', (e) => { e.preventDefault(); if (list.hidden) { input.focus(); } else close(); });
    const reposition = () => { if (!list.hidden) place(); };
    window.addEventListener('resize', reposition);
    document.addEventListener('scroll', reposition, true);
    // The list lives on <body>; drop it when the select leaves the DOM.
    const gone = new MutationObserver(() => {
      if (!select.isConnected) { list.remove(); gone.disconnect(); window.removeEventListener('resize', reposition); document.removeEventListener('scroll', reposition, true); }
    });
    gone.observe(document.body, { childList: true, subtree: true });
    st.refresh = showCurrent;
    // Open again with the select's current options (after a caller swapped them in).
    st.reopen = () => { input.focus(); input.select(); open(''); };
    return st;
  },
};
