/* ProtectionPro — DB board accessories.
 *
 * Everything mounted in a distribution board that is not an outgoing circuit:
 * live/phase indicator lamps, surge arrestors, V/A metering and enclosure
 * utilities. They occupy no way number, carry no lumped load and are not graded
 * by the per-way circuit check — they live in `props.accessories` and are drawn
 * by DBDrawing.
 *
 * One renderer, two mount points: a collapsible section under the schedule grid
 * (`mode: 'section'`) and the side panel of the Single Line view
 * (`mode: 'panel'`). Both write straight to `comp.props.accessories` and call
 * DBSchedule._notifyEdited(), so the workspace's idle commit, undo snapshot and
 * dirty flag work exactly as they do for a way edit — `'accessories'` is in
 * DBSchedule._committedFields().
 *
 * The checks here are client-side and advisory, in the same spirit as
 * DBSchedule._wayWarnings(). The incomer they grade against comes from the SLD
 * (Components.boardIncomer), never from a rating typed onto the board twice.
 */

const DBAccessories = {
  _seq: 0,
  _openSection: false,     // remembered <details> state for the grid mount

  // ── Model ───────────────────────────────────────────────────────────
  _kinds() {
    return (typeof DB_ACCESSORY_KINDS !== 'undefined') ? DB_ACCESSORY_KINDS : [];
  },

  _kind(key) {
    return this._kinds().find(k => k.key === key) || null;
  },

  // Ids are minted lazily so a hand-edited or imported project without them
  // still edits cleanly — same approach as DBSchedule._ensureWayIds().
  list(comp) {
    if (!comp) return [];
    if (!Array.isArray(comp.props.accessories)) comp.props.accessories = [];
    for (const a of comp.props.accessories) {
      if (!a.id) a.id = 'acc' + (++this._seq) + '-' + Math.random().toString(36).slice(2, 6);
    }
    return comp.props.accessories;
  },

  // A new accessory of `kindKey`, with the SPD backup fuse pre-filled when the
  // incomer calls for one. `_fuseSuggested` marks it as the app's suggestion
  // rather than the user's number, so the editor can say so and the user can
  // confirm or clear it. It is dropped the moment the field is edited.
  newAccessory(kindKey, comp) {
    const kind = this._kind(kindKey);
    if (!kind) return null;
    const acc = { id: 'acc' + (++this._seq) + '-' + Math.random().toString(36).slice(2, 6), kind: kindKey };
    Object.assign(acc, JSON.parse(JSON.stringify(kind.defaults || {})));
    if (kindKey === 'spd') {
      const inc = this.incomer(comp);
      if (inc.rating_a != null && inc.rating_a > DB_SPD_MAX_BACKUP_FUSE_A) {
        acc.fuse_a = Math.min(DB_SPD_MAX_BACKUP_FUSE_A, inc.rating_a);
        acc.fuse_type = 'gG';
        acc._fuseSuggested = true;
      }
    }
    return acc;
  },

  add(comp, kindKey) {
    const acc = this.newAccessory(kindKey, comp);
    if (!acc) return null;
    this.list(comp).push(acc);
    return acc;
  },

  remove(comp, id) {
    const list = this.list(comp);
    const i = list.findIndex(a => a.id === id);
    if (i >= 0) list.splice(i, 1);
  },

  duplicate(comp, id) {
    const list = this.list(comp);
    const i = list.findIndex(a => a.id === id);
    if (i < 0) return;
    const copy = JSON.parse(JSON.stringify(list[i]));
    copy.id = 'acc' + (++this._seq) + '-' + Math.random().toString(36).slice(2, 6);
    list.splice(i + 1, 0, copy);
  },

  incomer(comp) {
    if (!comp || typeof Components === 'undefined' || !Components.boardIncomer) {
      return { basis: 'unknown', rating_a: null };
    }
    return Components.boardIncomer(comp.id);
  },

  // ── Checks ──────────────────────────────────────────────────────────
  // Advisory only — nothing here blocks an edit or changes a way verdict.
  warnings(acc, inc) {
    const out = [];
    const fuseA = Number(acc.fuse_a) || 0;
    const unfused = !fuseA || acc.fuse_type === 'none';
    const rating = inc && inc.rating_a != null ? inc.rating_a : null;

    if (acc.kind === 'spd') {
      if (rating == null) {
        out.push({ level: 'info', text: 'Incomer rating unknown — wire the board on the SLD (or feed it from a parent board way) for the >125 A backup-fuse rule to be evaluated.' });
      } else if (rating > DB_SPD_MAX_BACKUP_FUSE_A && unfused) {
        out.push({ level: 'warn', text: `Incomer is ${rating} A — above ${DB_SPD_MAX_BACKUP_FUSE_A} A the upstream device can no longer act as the SPD's backup protection, so a dedicated backup fuse is required (typically ${DB_SPD_MAX_BACKUP_FUSE_A} A gG).` });
      }
      if (fuseA && rating != null && fuseA > rating) {
        out.push({ level: 'warn', text: `Backup fuse ${fuseA} A is larger than the ${rating} A incomer — it can never operate first.` });
      }
      if (fuseA > DB_SPD_MAX_BACKUP_FUSE_A) {
        out.push({ level: 'warn', text: `Backup fuse ${fuseA} A exceeds the ${DB_SPD_MAX_BACKUP_FUSE_A} A a Type 2 module typically permits — check the SPD's maximum backup fuse rating.` });
      }
      if (Number(acc.spd_type) === 3 && acc.tap === 'busbar') {
        out.push({ level: 'info', text: 'A Type 3 arrestor belongs at the equipment it protects, downstream of and coordinated with a Type 2 at the board.' });
      }
    } else if (unfused) {
      out.push({ level: 'warn', text: 'No overcurrent protection — an accessory tapped off the busbar needs its own fuse or MCB (SANS 10142-1).' });
    }

    if (acc.kind !== 'spd' && fuseA && rating != null && fuseA > rating) {
      out.push({ level: 'warn', text: `Protective device ${fuseA} A is larger than the ${rating} A incomer.` });
    }
    return out;
  },

  // Every accessory's warnings for one board, flattened, plus board-level
  // coordination notes. Used by the drawing header chip and the panel summary.
  boardWarnings(comp) {
    const inc = this.incomer(comp);
    const out = [];
    const list = this.list(comp);
    for (const acc of list) {
      for (const w of this.warnings(acc, inc)) out.push({ ...w, accId: acc.id, label: acc.label || '' });
    }
    const spds = list.filter(a => a.kind === 'spd');
    if (spds.some(a => Number(a.spd_type) === 1) && !spds.some(a => Number(a.spd_type) === 2)) {
      out.push({ level: 'info', accId: null, label: '',
        text: 'A Type 1 arrestor is fitted with no Type 2 downstream — Type 1 limits the surge but its let-through Up is usually too high to protect equipment on its own.' });
    }
    return out;
  },

  // ── Rendering ───────────────────────────────────────────────────────
  // mode: 'section' (collapsible, under the schedule grid) | 'panel' (drawing view)
  render(comp, host, onChange, opts) {
    if (!host) return;
    opts = opts || {};
    const mode = opts.mode || 'section';
    if (!comp) { host.innerHTML = ''; return; }

    const list = this.list(comp);
    const inc = this.incomer(comp);
    const warns = this.boardWarnings(comp);
    const nWarn = warns.filter(w => w.level === 'warn').length;

    const rows = list.map(a => this._rowHtml(a, inc)).join('')
      || `<div class="dba-empty">No accessories yet. Add indicator lamps, a surge arrestor, metering or an enclosure utility — they appear on the single line without taking a way number.</div>`;

    const kindOpts = this._kinds()
      .map(k => `<option value="${escHtml(k.key)}">${escHtml(k.label)}</option>`).join('');
    const addBar = `
      <div class="dba-add">
        <select id="dba-kind" aria-label="Accessory type">${kindOpts}</select>
        <button class="btn-small" data-dba="add">+ Add accessory</button>
        <span class="dba-incomer">${escHtml(this.incomerCaption(inc))}</span>
      </div>`;

    const boardNotes = warns.filter(w => !w.accId)
      .map(w => `<div class="dba-note ${w.level}">${w.level === 'warn' ? '⚠' : 'ⓘ'} ${escHtml(w.text)}</div>`).join('');

    const body = `<div class="dba-body">${addBar}<div class="dba-rows">${rows}</div>${boardNotes}</div>`;

    if (mode === 'panel') {
      host.innerHTML = `
        <div class="dba-panel">
          <div class="dba-head">Board accessories
            <span class="dba-count">${list.length}</span>
            ${nWarn ? `<span class="db-el-badge st-fail">⚠ ${nWarn}</span>` : ''}
          </div>
          ${body}
        </div>`;
    } else {
      host.innerHTML = `
        <details class="db-el-details dba-details"${this._openSection ? ' open' : ''}>
          <summary>Board accessories
            <span class="db-el-count">${list.length} item${list.length === 1 ? '' : 's'}</span>
            ${nWarn ? `<span class="db-el-badge st-fail">⚠ ${nWarn} to check</span>` : ''}
            <span class="db-el-ref">Indicators · SPDs · metering · utilities — drawn on the single line, not ways</span>
          </summary>
          ${body}
        </details>`;
      const det = host.querySelector('details.dba-details');
      if (det) det.addEventListener('toggle', () => { this._openSection = det.open; });
    }

    this._bind(comp, host, onChange, opts);
  },

  incomerCaption(inc) {
    if (!inc || inc.basis === 'unknown') return 'Incomer: unknown — not wired on the SLD';
    const from = inc.source ? ` from ${inc.source.name}` : '';
    const way = inc.way ? ` way ${inc.way}` : '';
    if (inc.rating_a == null) return `Incomer${from}${way}: no protective device found`;
    return `Incomer${from}${way}: ${inc.device_label || inc.rating_a + ' A'}`;
  },

  _rowHtml(acc, inc) {
    const kind = this._kind(acc.kind);
    if (!kind) return '';
    const tapOpts = (typeof DB_ACCESSORY_TAPS !== 'undefined' ? DB_ACCESSORY_TAPS : [])
      .map(t => `<option value="${t.value}"${acc.tap === t.value ? ' selected' : ''}>${escHtml(t.label)}</option>`).join('');

    const fields = (kind.fields || []).map(f => this._fieldHtml(acc, f)).join('');
    const warns = this.warnings(acc, inc);
    const warnHtml = warns.map(w =>
      `<div class="dba-note ${w.level}">${w.level === 'warn' ? '⚠' : 'ⓘ'} ${escHtml(w.text)}</div>`).join('');
    const guide = (acc.kind === 'spd' && typeof DB_SPD_TYPE_GUIDANCE !== 'undefined')
      ? `<div class="dba-guide">${escHtml(DB_SPD_TYPE_GUIDANCE[Number(acc.spd_type)] || '')}</div>` : '';

    return `
      <div class="dba-row" data-acc="${escHtml(acc.id)}">
        <div class="dba-row-head">
          <span class="dba-kind">${escHtml(kind.label)}</span>
          <input type="text" data-k="label" value="${escHtml(acc.label || '')}"
                 class="dba-label" aria-label="Accessory label">
          <label class="dba-field">Tap
            <select data-k="tap" title="Where the accessory connects: ahead of the main switch (stays live when the board is off) or on the busbar">${tapOpts}</select>
          </label>
          <span class="dba-row-actions">
            <button class="btn-small" data-dba="dup" title="Duplicate">⧉</button>
            <button class="btn-small" data-dba="del" title="Remove">✕</button>
          </span>
        </div>
        <div class="dba-fields">${fields}</div>
        ${guide}${warnHtml}
      </div>`;
  },

  _fieldHtml(acc, f) {
    const v = acc[f.key];
    const suggested = f.key === 'fuse_a' && acc._fuseSuggested;
    const tag = suggested ? `<span class="dba-suggested" title="Suggested by the >125 A backup-fuse rule — edit or clear it">auto</span>` : '';
    if (f.type === 'select') {
      const opts = (f.options || []).map(o => {
        const val = (o && typeof o === 'object') ? o.value : o;
        const lbl = (o && typeof o === 'object') ? o.label : o;
        // Option values may be numbers (SPD type) while a JSON round-trip can
        // leave the stored value a string — compare stringified so the right
        // entry still selects.
        return `<option value="${escHtml(val)}"${String(val) === String(v) ? ' selected' : ''}>${escHtml(lbl)}</option>`;
      }).join('');
      return `<label class="dba-field">${escHtml(f.label)}${tag}<select data-k="${escHtml(f.key)}">${opts}</select></label>`;
    }
    const attrs = [
      f.type === 'number' ? 'type="number"' : 'type="text"',
      f.min != null ? `min="${f.min}"` : '',
      f.step != null ? `step="${f.step}"` : '',
    ].filter(Boolean).join(' ');
    const unit = f.unit ? `<span class="dba-unit">${escHtml(f.unit)}</span>` : '';
    return `<label class="dba-field">${escHtml(f.label)}${tag}
      <input ${attrs} data-k="${escHtml(f.key)}" value="${v == null ? '' : escHtml(v)}">${unit}</label>`;
  },

  _bind(comp, host, onChange, opts) {
    const changed = () => {
      if (typeof DBSchedule !== 'undefined' && DBSchedule._notifyEdited) DBSchedule._notifyEdited();
      if (onChange) onChange();
    };

    const addBtn = host.querySelector('[data-dba="add"]');
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        const sel = host.querySelector('#dba-kind');
        this.add(comp, sel ? sel.value : 'indicator');
        this.render(comp, host, onChange, opts);
        changed();
      });
    }

    host.querySelectorAll('.dba-row').forEach(row => {
      const id = row.dataset.acc;
      row.querySelector('[data-dba="del"]').addEventListener('click', () => {
        this.remove(comp, id);
        this.render(comp, host, onChange, opts);
        changed();
      });
      row.querySelector('[data-dba="dup"]').addEventListener('click', () => {
        this.duplicate(comp, id);
        this.render(comp, host, onChange, opts);
        changed();
      });
      row.querySelectorAll('[data-k]').forEach(el => {
        el.addEventListener('change', () => {
          const acc = this.list(comp).find(a => a.id === id);
          if (!acc) return;
          const k = el.dataset.k;
          if (el.tagName === 'SELECT') {
            const num = Number(el.value);
            acc[k] = (el.value !== '' && !Number.isNaN(num) && /^-?\d+(\.\d+)?$/.test(el.value)) ? num : el.value;
          } else if (el.type === 'number') {
            acc[k] = el.value === '' ? null : (parseFloat(el.value) || 0);
          } else {
            acc[k] = el.value;
          }
          // The user has spoken — the number is theirs now, not the rule's.
          if (k === 'fuse_a') delete acc._fuseSuggested;
          this.render(comp, host, onChange, opts);
          changed();
        });
      });
    });
  },
};
