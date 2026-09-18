/* ProtectionPro — Excel-style editing for every table you type into.
 *
 * GridTable.attach(root, opts) turns the inputs/selects in a table's rows into
 * a spreadsheet grid. It never replaces a table's own logic: every edit —
 * typed, pasted, filled or cleared — lands as an ordinary `input` + `change`
 * event on the cell, so each table keeps its own validation, saving and undo.
 *
 *   Click / arrows     select a cell (arrows never step a number or a select)
 *   type               replaces the value;  F2 / double-click edits inside it
 *   Enter / ⇧Enter     keep and move down / up (Enter on the last row can add one)
 *   Tab / ⇧Tab         keep and move right / left, wrapping rows
 *   Esc                restore the value the cell had when it was entered
 *   ⇧+arrows, drag     select a range;   Delete clears it
 *   Ctrl C / Ctrl V    copy / paste tab-separated blocks (to and from Excel)
 *   Ctrl D             fill down (single cell: copy the cell above)
 *
 * Numbers: pasted and filled values are cleaned ("R 1 250,50" → 1250.5,
 * "12%" → 12). Text in a number cell is refused — marked, reported, and the
 * previous value kept — never turned into 0 by a table's parseFloat(v) || 0.
 *
 * root     the <tbody> (or a <table>/container whose `tbody > tr` are the rows);
 *          attach again after every re-render — it is idempotent per element.
 * opts     cells     selector for editable cells inside a row
 *          onAddRow  (cell) => void   Enter on the last row; the table appends
 *                                     a row and focuses it itself
 *          onPaste   ({cell, row, col, rows}) => true when the table applied a
 *                                     pasted block itself (bulk-aware tables)
 */

const GridTable = {
  CELLS: 'input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=hidden]):not([type=file]), select, textarea',

  attach(root, opts = {}) {
    if (!root) return null;
    if (root._grid) { root._grid.opts = Object.assign(root._grid.opts, opts); return root._grid; }
    const g = { root, opts, anchor: null, focus: null, edit: false, orig: null, dragging: false };
    root._grid = g;
    root.classList.add('gt-grid');
    root.addEventListener('focusin', (e) => this._onFocus(g, e));
    root.addEventListener('focusout', (e) => this._onBlur(g, e));
    root.addEventListener('keydown', (e) => this._onKey(g, e));
    root.addEventListener('mousedown', (e) => this._onMouseDown(g, e));
    root.addEventListener('mouseover', (e) => this._onMouseOver(g, e));
    root.addEventListener('dblclick', (e) => this._onDblClick(g, e));
    root.addEventListener('copy', (e) => this._onCopy(g, e));
    root.addEventListener('paste', (e) => this._onPaste(g, e));
    // Capture: refuse a number cell's non-numeric entry before the table's own
    // change handler (which would read it as 0) ever sees it.
    root.addEventListener('change', (e) => this._guardChange(g, e), true);
    return g;
  },

  // ── Matrix ─────────────────────────────────────────────────────────
  _rows(g) {
    const r = g.root;
    const trs = r.tagName === 'TBODY' ? [...r.rows] : [...r.querySelectorAll('tbody > tr')];
    const sel = g.opts.cells || this.CELLS;
    return trs.map(tr => [...tr.querySelectorAll(sel)].filter(el => el.closest('tr') === tr))
      .filter(cells => cells.length);
  },
  _pos(g, el) {
    const rows = this._rows(g);
    for (let r = 0; r < rows.length; r++) {
      const c = rows[r].indexOf(el);
      if (c >= 0) return { r, c, rows };
    }
    return null;
  },
  _cellAt(g, r, c, rows) {
    rows = rows || this._rows(g);
    return (rows[r] && rows[r][Math.min(c, rows[r].length - 1)]) || null;
  },
  _isNum(el) {
    return el.tagName === 'INPUT' && (el.type === 'number' || el.inputMode === 'decimal' || el.dataset.gridNum != null);
  },
  _usable(el) { return el && !el.disabled && !el.readOnly && el.offsetParent !== null; },

  // ── Focus / selection painting ─────────────────────────────────────
  _enter(g, el, keepAnchor) {
    if (!el) return;
    el.focus();
    const p = this._pos(g, el);
    if (!p) return;
    g.focus = { r: p.r, c: p.c };
    if (!keepAnchor || !g.anchor) g.anchor = { r: p.r, c: p.c };
    g.edit = false;
    g.orig = el.value;
    if (el.select && el.tagName !== 'SELECT') el.select();
    this._paint(g, p.rows);
  },
  _onFocus(g, e) {
    const el = e.target;
    const p = this._pos(g, el);
    if (!p) return;
    const moved = !g.focus || g.focus.r !== p.r || g.focus.c !== p.c;
    if (moved && !g._extending) g.anchor = { r: p.r, c: p.c };
    g.focus = { r: p.r, c: p.c };
    g.edit = false;
    g.orig = el.value;
    if (el.select && el.tagName !== 'SELECT') el.select();
    this._paint(g, p.rows);
  },
  _onBlur(g, e) {
    // Leaving the grid entirely: drop the highlight.
    setTimeout(() => {
      if (!g.root.contains(document.activeElement) && !g.dragging) this._unpaint(g);
    }, 0);
  },
  _range(g) {
    if (!g.anchor || !g.focus) return null;
    return {
      r0: Math.min(g.anchor.r, g.focus.r), r1: Math.max(g.anchor.r, g.focus.r),
      c0: Math.min(g.anchor.c, g.focus.c), c1: Math.max(g.anchor.c, g.focus.c),
    };
  },
  _multi(g) { const rg = this._range(g); return rg && (rg.r0 !== rg.r1 || rg.c0 !== rg.c1); },
  _unpaint(g) {
    g.root.querySelectorAll('.gt-sel, .gt-act').forEach(td => td.classList.remove('gt-sel', 'gt-act'));
  },
  _paint(g, rows) {
    rows = rows || this._rows(g);
    this._unpaint(g);
    const rg = this._range(g);
    if (!rg) return;
    const multi = this._multi(g);
    for (let r = rg.r0; r <= rg.r1; r++) {
      for (let c = rg.c0; c <= rg.c1; c++) {
        const el = rows[r] && rows[r][c];
        const td = el && el.closest('td');
        if (!td) continue;
        if (multi) td.classList.add('gt-sel');
        if (r === g.focus.r && c === g.focus.c) td.classList.add('gt-act');
      }
    }
    if (typeof g.opts.onSelect === 'function') g.opts.onSelect(this.selectionInfo(g, rows));
  },
  // Count / numeric sum / average of the selected cells (for status lines).
  selectionInfo(g, rows) {
    rows = rows || this._rows(g);
    const rg = this._range(g);
    if (!rg) return null;
    let count = 0, n = 0, sum = 0;
    for (let r = rg.r0; r <= rg.r1; r++) for (let c = rg.c0; c <= rg.c1; c++) {
      const el = rows[r] && rows[r][c];
      if (!el) continue;
      count++;
      const v = this.cleanNumber(el.value);
      if (el.value !== '' && !isNaN(v)) { n++; sum += v; }
    }
    return { count, numeric: n, sum, avg: n ? sum / n : null };
  },

  // ── Keyboard ───────────────────────────────────────────────────────
  _move(g, el, dr, dc, extend) {
    const p = this._pos(g, el);
    if (!p) return;
    const rows = p.rows;
    let r = p.r, c = p.c;
    for (let guard = 0; guard < 200; guard++) {
      if (dc) {
        c += dc;
        if (c >= rows[r].length) { if (r + 1 >= rows.length) return; r += 1; c = 0; }
        else if (c < 0) { if (r === 0) return; r -= 1; c = rows[r].length - 1; }
      } else {
        r += dr;
        if (r < 0 || r >= rows.length) return;
      }
      const next = this._cellAt(g, r, c, rows);
      if (this._usable(next)) {
        g._extending = !!extend;
        if (extend) {
          g.focus = { r, c: Math.min(c, rows[r].length - 1) };
          next.focus();
          g.edit = false; g.orig = next.value;
          if (next.select && next.tagName !== 'SELECT') next.select();
          this._paint(g, rows);
        } else {
          this._enter(g, next);
        }
        g._extending = false;
        return;
      }
    }
  },

  _onKey(g, e) {
    const el = e.target;
    const p = this._pos(g, el);
    if (!p) return;
    const k = e.key, ctrl = e.ctrlKey || e.metaKey;
    const isSel = el.tagName === 'SELECT';

    if (k === 'F2') { e.preventDefault(); this._startEdit(g, el); return; }
    if (k === 'Escape') {
      if (g.orig != null && el.value !== g.orig) {
        e.preventDefault(); e.stopPropagation();
        el.value = g.orig;
        g.edit = false;
        if (el.select && !isSel) el.select();
      }
      return;
    }
    if (k === 'Enter' && !e.altKey) {
      e.preventDefault();
      const last = p.r === p.rows.length - 1;
      if (!e.shiftKey && last && typeof g.opts.onAddRow === 'function') {
        el.dispatchEvent(new Event('change', { bubbles: true }));
        g.opts.onAddRow(el);
        return;
      }
      this._move(g, el, e.shiftKey ? -1 : 1, 0);
      return;
    }
    if (k === 'Tab') { e.preventDefault(); this._move(g, el, 0, e.shiftKey ? -1 : 1); return; }
    if (k === 'ArrowUp' || k === 'ArrowDown') {
      if (isSel && e.altKey) return;                       // Alt+↓ opens the list
      e.preventDefault();                                  // never step a number / select
      this._move(g, el, k === 'ArrowUp' ? -1 : 1, 0, e.shiftKey);
      return;
    }
    if (k === 'ArrowLeft' || k === 'ArrowRight') {
      if (g.edit && !isSel && !e.shiftKey) return;         // caret moves inside the value
      e.preventDefault();
      this._move(g, el, 0, k === 'ArrowLeft' ? -1 : 1, e.shiftKey);
      return;
    }
    if ((k === 'Delete' || k === 'Backspace') && this._multi(g) && !g.edit) {
      e.preventDefault();
      this._fillRange(g, () => '');
      return;
    }
    if (ctrl && (k === 'd' || k === 'D')) { e.preventDefault(); this._fillDown(g, p); return; }
    // Typing a character in a select-all'd cell replaces it (native); from then
    // on arrows still move between cells, exactly as Excel's Enter mode.
  },
  _startEdit(g, el) {
    g.edit = true;
    if (el.setSelectionRange && el.type !== 'number') {
      const n = el.value.length; try { el.setSelectionRange(n, n); } catch (_) { /* type without caret */ }
    } else if (el.tagName === 'INPUT') {
      // number inputs have no caret API: re-select ends the select-all by
      // collapsing to the end via a value round-trip.
      const v = el.value; el.value = ''; el.value = v;
    }
  },

  // ── Mouse ──────────────────────────────────────────────────────────
  _onMouseDown(g, e) {
    const el = e.target.closest(g.opts.cells || this.CELLS);
    if (!el || !this._pos(g, el)) return;
    if (e.button !== 0) return;
    if (e.shiftKey && g.anchor) {
      e.preventDefault();
      const p = this._pos(g, el);
      g.focus = { r: p.r, c: p.c };
      g._extending = true; el.focus(); g._extending = false;
      this._paint(g, p.rows);
      return;
    }
    g.dragging = true;
    const up = () => { g.dragging = false; document.removeEventListener('mouseup', up); };
    document.addEventListener('mouseup', up);
    // Clicking an unfocused text/number cell selects the whole cell (Excel
    // single-click); a click in the cell being edited places the caret.
    if (el.tagName === 'INPUT' && document.activeElement !== el) {
      e.preventDefault();
      this._enter(g, el);
    }
  },
  _onMouseOver(g, e) {
    if (!g.dragging) return;
    const el = e.target.closest(g.opts.cells || this.CELLS);
    const p = el && this._pos(g, el);
    if (!p || !g.anchor) return;
    if (g.focus && g.focus.r === p.r && g.focus.c === p.c) return;
    g.focus = { r: p.r, c: p.c };
    this._paint(g, p.rows);
  },
  _onDblClick(g, e) {
    const el = e.target.closest(g.opts.cells || this.CELLS);
    if (el && this._pos(g, el) && el.tagName !== 'SELECT') this._startEdit(g, el);
  },

  // ── Copy / paste / fill ────────────────────────────────────────────
  _text(el) {
    if (el.tagName === 'SELECT') {
      const o = el.options[el.selectedIndex];
      return o ? o.textContent.trim() : '';
    }
    return el.value;
  },
  _onCopy(g, e) {
    if (g.edit && !this._multi(g)) return;               // copying selected text inside a cell
    const rg = this._range(g);
    if (!rg) return;
    const rows = this._rows(g);
    const lines = [];
    for (let r = rg.r0; r <= rg.r1; r++) {
      const vals = [];
      for (let c = rg.c0; c <= rg.c1; c++) {
        const el = rows[r] && rows[r][c];
        vals.push(el ? String(this._text(el)).replace(/[\t\r\n]+/g, ' ') : '');
      }
      lines.push(vals.join('\t'));
    }
    e.preventDefault();
    e.clipboardData.setData('text/plain', lines.join('\r\n'));
  },
  // Tab-separated text as Excel puts it on the clipboard (quoted cells may
  // hold tabs/newlines; "" is a literal quote).
  parseTSV(text) {
    const out = []; let row = [], cur = '', q = false;
    text = String(text).replace(/\r\n?/g, '\n');
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += ch;
      } else if (ch === '"' && cur === '') q = true;
      else if (ch === '\t') { row.push(cur); cur = ''; }
      else if (ch === '\n') { row.push(cur); out.push(row); row = []; cur = ''; }
      else cur += ch;
    }
    if (cur !== '' || row.length) { row.push(cur); out.push(row); }
    while (out.length && out[out.length - 1].every(v => v === '')) out.pop();
    return out;
  },
  _onPaste(g, e) {
    const el = e.target;
    const p = this._pos(g, el);
    if (!p) return;
    const text = (e.clipboardData || window.clipboardData).getData('text');
    if (text == null) return;
    const block = /[\t\n]/.test(text.replace(/\r?\n$/, ''));
    if (g.edit && !block) return;                        // a value pasted into the text being edited
    e.preventDefault();
    const data = this.parseTSV(text);
    if (!data.length) return;
    const rg = this._range(g);
    // One value over a selected range fills the range (Excel).
    if (!block && this._multi(g)) { this._fillRange(g, () => data[0][0]); return; }
    const start = rg ? { r: rg.r0, c: rg.c0 } : { r: p.r, c: p.c };
    const startEl = this._cellAt(g, start.r, start.c, p.rows) || el;
    if (typeof g.opts.onPaste === 'function' && g.opts.onPaste({ cell: startEl, row: start.r, col: start.c, rows: data })) return;
    let bad = 0;
    for (let i = 0; i < data.length; i++) {
      for (let j = 0; j < data[i].length; j++) {
        const rows = this._rows(g);                       // fresh: a change may re-render
        const target = rows[start.r + i] && rows[start.r + i][start.c + j];
        if (!target) continue;
        if (!this.setCell(target, data[i][j])) bad++;
      }
    }
    if (bad && typeof UI !== 'undefined' && UI.toast) UI.toast(`${bad} pasted value(s) were not numbers and were skipped. The previous values were kept.`, 'warning');
  },
  _fillRange(g, valueFor) {
    const rg = this._range(g);
    if (!rg) return;
    let bad = 0;
    for (let r = rg.r0; r <= rg.r1; r++) for (let c = rg.c0; c <= rg.c1; c++) {
      const rows = this._rows(g);
      const el = rows[r] && rows[r][c];
      if (!el) continue;
      if (el.tagName === 'SELECT' && valueFor(r, c) === '') continue;   // a list can't be blank
      if (!this.setCell(el, valueFor(r, c))) bad++;
    }
    if (bad && typeof UI !== 'undefined' && UI.toast) UI.toast(`${bad} value(s) could not be applied.`, 'warning');
  },
  _fillDown(g, p) {
    const rg = this._range(g);
    if (!rg) return;
    const rows = p.rows;
    if (rg.r0 === rg.r1) {                               // single row: copy from the row above
      if (rg.r0 === 0) return;
      for (let c = rg.c0; c <= rg.c1; c++) {
        const src = rows[rg.r0 - 1][c], dst = rows[rg.r0][c];
        if (src && dst) this.setCell(dst, this._text(src));
      }
      return;
    }
    const top = [];
    for (let c = rg.c0; c <= rg.c1; c++) top[c] = rows[rg.r0][c] ? this._text(rows[rg.r0][c]) : '';
    for (let r = rg.r0 + 1; r <= rg.r1; r++) for (let c = rg.c0; c <= rg.c1; c++) {
      const el = this._rows(g)[r] && this._rows(g)[r][c];
      if (el) this.setCell(el, top[c]);
    }
  },

  // Write one value into a cell through the table's own input/change path.
  // Returns false when the value was refused (not a number / no such option).
  setCell(el, raw) {
    if (!el || el.disabled || el.readOnly) return true;
    raw = raw == null ? '' : String(raw).trim();
    if (el.tagName === 'SELECT') {
      const low = raw.toLowerCase();
      const opt = [...el.options].find(o => o.value === raw)
        || [...el.options].find(o => o.textContent.trim().toLowerCase() === low)
        || (low && [...el.options].find(o => o.textContent.trim().toLowerCase().startsWith(low)));
      if (!opt) { this._flagBad(el, `“${raw}” is not one of the choices.`); return false; }
      if (el.value === opt.value) return true;
      el.value = opt.value;
    } else if (this._isNum(el)) {
      if (raw === '') el.value = '';
      else {
        const n = this.cleanNumber(raw);
        if (isNaN(n)) { this._flagBad(el, `“${raw}” is not a number. The previous value was kept.`); return false; }
        if (String(el.value) === String(n)) return true;
        el.value = String(n);
      }
    } else {
      if (el.value === raw) return true;
      el.value = raw;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  },

  // "R 1 250,50" → 1250.5 · "1,250.50" → 1250.5 · "12%" → 12 · "abc" → NaN.
  // A lone comma is a decimal comma unless it is followed by exactly three
  // digits (1,250 → 1250), matching how Excel exports in either locale.
  cleanNumber(s) {
    let t = String(s == null ? '' : s).trim();
    if (!t) return NaN;
    t = t.replace(/^[^\d\-+.,]+/, '').replace(/[^\d.,]+$/, '');      // currency / unit / %
    t = t.replace(/[\s   ']/g, '');                   // digit-group spaces
    const neg = /^-/.test(t);
    t = t.replace(/^[-+]/, '');
    if (!/^[\d.,]+$/.test(t)) return NaN;
    const lastDot = t.lastIndexOf('.'), lastComma = t.lastIndexOf(',');
    if (lastDot >= 0 && lastComma >= 0) {
      const dec = lastDot > lastComma ? '.' : ',';
      t = t.split(dec === '.' ? ',' : '.').join('');
      if (dec === ',') t = t.replace(',', '.');
    } else if (lastComma >= 0) {
      t = /^\d{1,3}(,\d{3})+$/.test(t) ? t.replace(/,/g, '') : t.replace(',', '.');
    }
    if ((t.match(/\./g) || []).length > 1) return NaN;
    const n = parseFloat(t);
    return isNaN(n) ? NaN : (neg ? -n : n);
  },

  _flagBad(el, msg) {
    const td = el.closest('td') || el;
    td.classList.add('gt-bad');
    td.title = msg;
    clearTimeout(td._gtBadTimer);
    td._gtBadTimer = setTimeout(() => { td.classList.remove('gt-bad'); td.removeAttribute('title'); }, 2500);
  },

  _guardChange(g, e) {
    const el = e.target;
    if (!(el.tagName === 'INPUT' && el.type === 'number')) return;
    if (el.validity && el.validity.badInput) {
      e.stopImmediatePropagation();
      el.value = g.orig != null ? g.orig : '';
      this._flagBad(el, 'That is not a number. The previous value was kept.');
      if (typeof UI !== 'undefined' && UI.toast) UI.toast('That is not a number, so the previous value was kept.', 'warning');
    }
  },

  // App-wide: numbers change only by typing or pasting — never by a stray
  // mouse wheel or arrow key (spinner arrows are hidden in CSS).
  initGlobal() {
    if (this._globalDone) return;
    this._globalDone = true;
    document.addEventListener('wheel', (e) => {
      const el = e.target;
      if (el && el.tagName === 'INPUT' && el.type === 'number' && document.activeElement === el) el.blur();
    }, { passive: true });
    document.addEventListener('keydown', (e) => {
      const el = e.target;
      if (el && el.tagName === 'INPUT' && el.type === 'number' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')
        && !(el.closest && el.closest('.gt-grid'))) e.preventDefault();
    }, true);
  },
};
