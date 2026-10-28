/* ProtectionPro — Size cables: the smallest cable per way that passes the
 * circuit check.
 *
 * The backend (/api/analysis/db-cable-size, size_db_cables) tries each IEC
 * preferred size from the circuit type's minimum up, judged by the circuit
 * check's own per-way check: current (Ib ≤ In ≤ Iz), volt drop from the
 * origin, earth-fault loop. This module adds the breaker's I²t against the
 * cable (DbCoord.cableProtection, the Coordination tab's check) where the
 * breaker clears in 0.1 s or more — below that a breaker's let-through energy
 * governs, which a time-current curve does not give, so the curve would
 * oversize every cable.
 *
 * A way's cable carries `cable_by` (what set its size: iz / vd / zs / i2t /
 * min) after sizing, and `cable_locked` once a size is typed in by hand —
 * sizing then leaves it alone unless asked. Typing "auto" in a cable cell
 * sizes that one way (DBSchedule._setWayField → CableSize.sizeOne).
 */

const CableSize = {
  // Settings for the session (the dialog remembers them between opens).
  _opts: {
    scope: 'all', min_lighting_mm2: 1.5, min_power_mm2: 2.5, max_mm2: 16,
    checks: { iz: true, vd: true, zs: true, i2t: true },
    keepLocked: true, noSmaller: false, setEcc: true,
  },
  TAG: { iz: 'Iz', vd: 'VD', zs: 'Zs', i2t: 'I²t', min: 'Min' },
  WHY: {
    iz: 'current — the breaker rating needs this Iz (In ≤ Iz)',
    vd: 'volt drop from the origin',
    zs: 'earth-fault loop — disconnection in time',
    i2t: 'short-circuit withstand — the breaker clears inside the cable’s I²t',
    min: 'the smallest size allowed for this circuit type',
  },
  T_CURVE_MIN_S: 0.1,

  _sizes() {
    return (typeof IEC_STANDARD_SIZES !== 'undefined')
      ? IEC_STANDARD_SIZES : [1.5, 2.5, 4, 6, 10, 16, 25, 35, 50, 70, 95, 120, 150, 185, 240, 300, 400];
  },

  // Grid cell marker: a lock for a hand-set size, else what set the size.
  cellTag(c) {
    if (c.cable_locked) {
      return `<span class="db-cab-tag db-cab-lock" title="Set by hand — Size cables leaves it. Type auto to size it again.">`
        + `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V8a4 4 0 0 1 8 0v3"></path></svg></span>`;
    }
    const t = this.TAG[c.cable_by];
    return t ? `<span class="db-cab-tag" title="Sized by Size cables. Set by ${escHtml(this.WHY[c.cable_by])}.">${t}</span>` : '';
  },

  // ── Server call + the I²t step ───────────────────────────────────────
  async _propose(comp, wayIds, o) {
    const checks = Object.keys(o.checks).filter(k => o.checks[k] && k !== 'i2t');
    const res = await API.runDbCableSize({
      board_id: comp.id, way_ids: wayIds,
      min_lighting_mm2: o.min_lighting_mm2, min_power_mm2: o.min_power_mm2, max_mm2: o.max_mm2,
      checks, set_ecc: o.setEcc,
    });
    const byId = new Map((comp.props.circuits || []).map(c => [c.id, c]));
    for (const e of res.ways || []) {
      const c = byId.get(e.way_id);
      if (c && o.checks.i2t && e.proposed_mm2) this._i2t(c, e, res, o);
    }
    return res;
  },

  // Bump a proposal until the breaker clears inside the cable's I²t wherever
  // its curve is above T_CURVE_MIN_S. Needs the board's fault level.
  _i2t(c, e, res, o) {
    const dev = typeof DbCoord !== 'undefined' ? DbCoord.wayDevice(c) : null;
    const ik = Number(res.ik3_max_a) || 0;
    if (!dev || !(ik > 0)) return;
    const k = Number(res.cable_k) || 115;
    const ok = (mm2) => {
      const r = DbCoord.cableProtection(dev, k, mm2, ik);
      return r.limitA == null || !(cbTripBand(dev.props, r.limitA).tMax >= this.T_CURVE_MIN_S);
    };
    if (ok(e.proposed_mm2)) return;
    const next = this._sizes().find(s => s > e.proposed_mm2 && s <= o.max_mm2 + 1e-9 && ok(s));
    if (next) {
      e.proposed_mm2 = next;
      e.governed_by = 'i2t';
      if (o.setEcc) e.ecc_mm2 = DBSchedule.eccRequiredMm2(next);
    } else {
      e.proposed_mm2 = null;
      e.failing = ['i2t'];
      e.message = `No size up to ${o.max_mm2} mm² is protected by the ${dev.name} — it clears too slowly for the cable’s I²t.`;
    }
  },

  // What happens to each way: up / down / same / kept / none.
  _plan(comp, res, o) {
    const byId = new Map((comp.props.circuits || []).map(c => [c.id, c]));
    return (res.ways || []).map(e => {
      const c = byId.get(e.way_id);
      const now = Number(c && c.cable_mm2) || 0;
      let kind;
      if (c && c.cable_locked && o.keepLocked) kind = 'kept';
      else if (!e.proposed_mm2) kind = 'none';
      else if (o.noSmaller && now && e.proposed_mm2 < now) { kind = 'same'; e.keptLarger = true; e.proposed_mm2 = now; }
      else kind = e.proposed_mm2 > now ? 'up' : e.proposed_mm2 < now ? 'down' : 'same';
      return { e, c, now, kind };
    });
  },

  // ── Dialog ───────────────────────────────────────────────────────────
  open(comp) {
    if (!comp) return;
    const o = this._opts;
    const failing = this._failingIds(comp);
    const selected = (comp.props.circuits || []).filter(c => DBSchedule._selected.has(c.id)).map(c => c.id);
    if (o.scope === 'selected' && !selected.length) o.scope = 'all';
    if (o.scope === 'failing' && !failing) o.scope = 'all';
    const n = (comp.props.circuits || []).length;
    const m = document.createElement('div');
    m.className = 'modal';
    m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-labelledby', 'csz-title');
    m.style.display = 'flex'; m.style.zIndex = '3000';
    const sizeOpts = (cur, list) => list.map(s => `<option value="${s}"${Number(cur) === s ? ' selected' : ''}>${s} mm²</option>`).join('');
    const chk = (k, label, sub) => `<label class="csz-chk"><input type="checkbox" data-csz-check="${k}"${o.checks[k] ? ' checked' : ''}><span>${label}<small>${sub}</small></span></label>`;
    const opt = (k, label, sub) => `<label class="csz-chk"><input type="checkbox" data-csz-opt="${k}"${o[k] ? ' checked' : ''}><span>${label}<small>${sub}</small></span></label>`;
    const seg = (k, label, count, off) => `<button type="button" data-csz-scope="${k}" aria-pressed="${o.scope === k}"${off ? ' disabled title="' + escHtml(off) + '"' : ''}>${label} <b>${count}</b></button>`;
    const inst = comp.props.way_install || {};
    m.innerHTML = `<div class="modal-content modal-wide csz" style="max-height:90vh;display:flex;flex-direction:column">
      <div class="modal-header"><h3 id="csz-title">Size cables — ${escHtml(comp.props.name || comp.id)}</h3>
        <button class="modal-close" data-csz="cancel" aria-label="Close">&times;</button></div>
      <div class="csz-body">
        <div class="csz-rules">
          <section><h4>Ways</h4>
            <div class="csz-seg" role="group" aria-label="Which ways">
              ${seg('all', 'All', n)}${seg('failing', 'Failing', failing ? failing.length : '—', failing ? '' : 'Run the circuit check first')}${seg('selected', 'Selected', selected.length, selected.length ? '' : 'Tick ways in the grid first')}
            </div></section>
          <section><h4>Each cable must pass</h4>
            ${chk('iz', 'Current: Ib ≤ In ≤ Iz', `Iz derated for ${escHtml(inst.method || 'B1')} · ${escHtml(String(inst.ambient_c ?? 30))} °C`)}
            ${chk('vd', 'Volt drop from the origin', inst.supply === 'private' ? '6 % lighting · 8 % other (private supply)' : '3 % lighting · 5 % other (public supply)')}
            ${chk('zs', 'Earth-fault loop Zs', 'Disconnection within the time limit')}
            ${chk('i2t', 'Short-circuit withstand (I²t)', 'Where the breaker takes 0.1 s or more to clear')}
          </section>
          <section><h4>Sizes</h4>
            <div class="csz-grid2">
              <label>Smallest — lighting<select data-csz-num="min_lighting_mm2">${sizeOpts(o.min_lighting_mm2, [1, 1.5, 2.5])}</select></label>
              <label>Smallest — power<select data-csz-num="min_power_mm2">${sizeOpts(o.min_power_mm2, [1.5, 2.5, 4])}</select></label>
              <label>Largest to try<select data-csz-num="max_mm2">${sizeOpts(o.max_mm2, [6, 10, 16, 25, 35, 50, 70, 95])}</select></label>
            </div></section>
          <section><h4>Leave alone</h4>
            ${opt('keepLocked', 'Cables set by hand', 'Typed into the grid — shown with a lock')}
            ${opt('noSmaller', 'Never make a cable smaller', 'Off: an oversized cable is brought down too')}
            ${opt('setEcc', 'Also set the ECC', 'Table 54.7 size for the new live conductor')}
          </section>
        </div>
        <div class="csz-preview">
          <div class="csz-sum" id="csz-sum">Sizing…</div>
          <div class="csz-table" id="csz-table"></div>
        </div>
      </div>
      <div class="modal-footer csz-foot">
        <span>Runs the circuit check afterwards. Ctrl+Z undoes it in one step.</span>
        <button class="btn-small" data-csz="cancel">Cancel</button>
        <button class="btn-small btn-primary" data-csz="apply" disabled>Apply</button></div></div>`;
    document.body.appendChild(m);

    let plan = [];
    let seq = 0;
    const run = async () => {
      const my = ++seq;
      const ids = o.scope === 'failing' ? failing : o.scope === 'selected' ? selected : null;
      m.querySelector('#csz-sum').textContent = 'Sizing…';
      try {
        const res = await this._propose(comp, ids, o);
        if (my !== seq || !m.isConnected) return;
        plan = this._plan(comp, res, o);
        this._renderPreview(m, plan, res);
      } catch (err) {
        if (my !== seq) return;
        m.querySelector('#csz-sum').textContent = `Sizing failed: ${err.message}`;
      }
    };
    const finish = () => { document.removeEventListener('keydown', onKey, true); m.remove(); };
    const onKey = (ev) => { if (ev.key === 'Escape' && !document.querySelector('.ss-pop:not([hidden])')) { ev.stopPropagation(); finish(); } };
    document.addEventListener('keydown', onKey, true);
    m.addEventListener('change', (ev) => {
      const t = ev.target;
      if (t.dataset.cszCheck) { o.checks[t.dataset.cszCheck] = t.checked; run(); }
      else if (t.dataset.cszOpt) { o[t.dataset.cszOpt] = t.checked; run(); }
      else if (t.dataset.cszNum) { o[t.dataset.cszNum] = Number(t.value); run(); }
      else if (t.dataset.cszAll != null) m.querySelectorAll('[data-csz-row]:not(:disabled)').forEach(x => { x.checked = t.checked; });
      if (t.matches('[data-csz-row], [data-csz-all]')) this._syncApply(m);
      if (t.dataset.cszChanges != null) m.querySelector('#csz-table').classList.toggle('csz-changes', t.checked);
    });
    m.addEventListener('click', (ev) => {
      if (ev.target === m) return finish();
      const sc = ev.target.closest('[data-csz-scope]');
      if (sc && !sc.disabled) {
        o.scope = sc.dataset.cszScope;
        m.querySelectorAll('[data-csz-scope]').forEach(b => b.setAttribute('aria-pressed', String(b === sc)));
        run();
        return;
      }
      const b = ev.target.closest('[data-csz]');
      if (!b) return;
      if (b.dataset.csz === 'cancel') return finish();
      if (b.dataset.csz === 'apply') {
        const on = new Set([...m.querySelectorAll('[data-csz-row]:checked')].map(x => x.dataset.cszRow));
        this._apply(comp, plan, on, o);
        finish();
      }
    });
    if (typeof SearchSelect !== 'undefined') SearchSelect.delegate(m);
    run();
  },

  // Ways the last circuit check failed on something a cable size fixes.
  _failingIds(comp) {
    const res = AppState.dbCheckResults;
    if (!res || !Array.isArray(res.ways)) return null;
    return res.ways.filter(w => w.board_id === comp.id
      && (w.coordination_status === 'fail' || w.vd_status === 'fail' || w.zs_status === 'fail')).map(w => w.way_id);
  },

  _renderPreview(m, plan, res) {
    const cnt = (k) => plan.filter(p => p.kind === k).length;
    const bits = [
      cnt('up') && `<span class="csz-up">${cnt('up')} larger</span>`,
      cnt('down') && `<span class="csz-down">${cnt('down')} smaller</span>`,
      cnt('same') && `${cnt('same')} unchanged`,
      cnt('kept') && `${cnt('kept')} kept (set by hand)`,
      cnt('none') && `<span class="csz-bad">${cnt('none')} no size fits</span>`,
    ].filter(Boolean);
    const warn = (res.warnings || []).map(w => `<div class="csz-warn">${escHtml(w)}</div>`).join('');
    m.querySelector('#csz-sum').innerHTML = `<strong>Preview</strong><span>${bits.join(' · ') || 'Nothing to size.'}</span>
      <label class="csz-chk csz-chk-inline"><input type="checkbox" data-csz-changes checked><span>Changes only</span></label>`;
    const mm = (v) => (v ? `${v} mm²` : '—');
    const rows = plan.map(p => {
      const e = p.e;
      const change = p.kind === 'up' || p.kind === 'down';
      const tag = e.governed_by ? `<span class="csz-gov${e.governed_by === 'min' ? ' min' : ''}" title="${escHtml(this.WHY[e.governed_by] || '')}">${escHtml(this.TAG[e.governed_by] || e.governed_by)}</span>` : '';
      const nw = p.kind === 'none' ? '<span class="csz-bad">—</span>'
        : p.kind === 'kept' ? '<span class="csz-muted">kept</span>'
        : `<span class="csz-${p.kind}">${mm(e.proposed_mm2)}</span>${e.keptLarger ? ' <span class="csz-muted" title="Larger than needed; Never make a cable smaller is on">kept</span>' : ''}`;
      const vd = e.vd_pct != null ? `${Number(e.vd_pct).toFixed(2)}` : '—';
      const msg = p.kind === 'none' ? `<tr class="csz-msg"><td></td><td colspan="9">${escHtml(e.message || '')}</td></tr>` : '';
      return `<tr class="${change || p.kind === 'none' ? 'csz-chg' : 'csz-same'}">
        <td><input type="checkbox" data-csz-row="${escHtml(e.way_id)}" aria-label="Apply to way ${escHtml(e.way)}"${change ? ' checked' : ' disabled'}></td>
        <td><b>${escHtml(e.way)}</b></td><td>${escHtml(e.description)}</td>
        <td class="num">${p.c ? escHtml(String(p.c.breaker_a ?? '')) + ' A' : ''}</td><td class="num">${p.c ? escHtml(String(p.c.cable_m ?? '')) + ' m' : ''}</td>
        <td class="num">${mm(p.now)}</td><td class="num">${nw}</td><td>${p.kind === 'kept' ? '' : tag}</td>
        <td class="num">${e.iz_a != null ? Number(e.iz_a).toFixed(1) : '—'}</td><td class="num">${vd}</td></tr>${msg}`;
    }).join('');
    const tbl = m.querySelector('#csz-table');
    tbl.classList.add('csz-changes');
    tbl.innerHTML = warn + `<table><thead><tr>
        <th><input type="checkbox" data-csz-all checked aria-label="Apply all"></th><th>Way</th><th>Description</th>
        <th class="num">In</th><th class="num">Length</th><th class="num">Now</th><th class="num">New</th><th>Set by</th>
        <th class="num">Iz (A)</th><th class="num">%VD</th></tr></thead><tbody>${rows}</tbody></table>
      ${!plan.some(p => p.kind === 'up' || p.kind === 'down' || p.kind === 'none') ? '<div class="csz-empty">Every cable is already the smallest that passes.</div>' : ''}`;
    this._syncApply(m);
  },

  _syncApply(m) {
    const n = m.querySelectorAll('[data-csz-row]:checked').length;
    const b = m.querySelector('[data-csz="apply"]');
    b.disabled = n === 0;
    b.textContent = n ? `Apply to ${n} way${n === 1 ? '' : 's'}` : 'Apply';
  },

  // Write the ticked sizes; every sized way (ticked or already right) gets
  // the tag saying what sets its size.
  _apply(comp, plan, on, o) {
    let changed = 0;
    for (const p of plan) {
      if (!p.c || p.kind === 'kept' || p.kind === 'none') continue;
      const e = p.e;
      if ((p.kind === 'up' || p.kind === 'down') && !on.has(e.way_id)) continue;
      if (p.kind === 'up' || p.kind === 'down') {
        p.c.cable_mm2 = e.proposed_mm2;
        if (o.setEcc && e.ecc_mm2) p.c.ecc_mm2 = e.ecc_mm2;
        changed++;
      }
      if (!e.keptLarger) p.c.cable_by = e.governed_by;
      delete p.c.cable_locked;
    }
    const none = plan.filter(p => p.kind === 'none').length;
    DBSchedule.render();
    DBSchedule._notifyEdited();
    DBSchedule._status(`Sized ${plan.length} way${plan.length === 1 ? '' : 's'}: ${changed} changed`
      + (none ? ` · ${none} with no size that passes` : '') + '.');
    if (typeof Schedules !== 'undefined' && Schedules.runCheck) Schedules.runCheck(true);
  },

  // "auto" typed in one cable cell.
  async sizeOne(comp, c) {
    const o = { ...this._opts, keepLocked: false, noSmaller: false };
    DBSchedule._status(`Sizing way ${c.way}…`);
    try {
      const res = await this._propose(comp, [c.id], o);
      const e = (res.ways || [])[0];
      if (!e || !e.proposed_mm2) {
        DBSchedule._status(`Way ${c.way}: ${(e && e.message) || 'no size passes.'}`);
        return;
      }
      c.cable_mm2 = e.proposed_mm2;
      if (o.setEcc && e.ecc_mm2) c.ecc_mm2 = e.ecc_mm2;
      c.cable_by = e.governed_by;
      delete c.cable_locked;
      DBSchedule.render();
      DBSchedule._notifyEdited();
      DBSchedule._status(`Way ${c.way}: ${e.proposed_mm2} mm², set by ${this.WHY[e.governed_by] || e.governed_by}.`);
    } catch (err) {
      DBSchedule._status(`Sizing failed: ${err.message}`);
    }
  },
};
