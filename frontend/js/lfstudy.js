/* ProtectionPro — Load Flow Study Manager.
 *
 * Define several named "cases" (each a full, self-contained network snapshot),
 * edit the component attributes that drive load flow into each case, run load
 * flow for every case at once, and compare the effect on the system (bus
 * voltages, losses, overloads) side by side. A case can be applied back onto
 * the live diagram.
 *
 * A case = {id, name, baseMVA, loadFlowMethod, components:[…], wires:[…]}.
 * The live network is always shown as an implicit "Current network" case.
 * Cases persist with the project (AppState.loadFlowCases); results are transient.
 *
 * This is distinct from the batch "Study Manager" (UI: "Run All Studies").
 */

const LFStudy = {
  _activeCaseId: '__current__',   // which case the attribute grid edits
  _results: null,                 // last run: [{id, name, result, summary}]
  _method: 'newton_raphson',
  _includeCurrent: true,

  _esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },

  _cases() {
    if (!Array.isArray(AppState.loadFlowCases)) AppState.loadFlowCases = [];
    return AppState.loadFlowCases;
  },

  _activeCase() {
    if (this._activeCaseId === '__current__') return null;   // null → live network
    return this._cases().find(c => c.id === this._activeCaseId) || null;
  },

  // Field descriptor (label/type/unit/options/min/max/step) for a prop key,
  // reused from the properties panel definitions. Missing keys (e.g. the
  // numeric voltage_setpoint_pu, which has no panel field) fall back to number.
  _field(type, key) {
    const def = (typeof COMPONENT_DEFS !== 'undefined') ? COMPONENT_DEFS[type] : null;
    const f = def && Array.isArray(def.fields) ? def.fields.find(x => x.key === key) : null;
    return f || { key, label: key, type: 'number' };
  },

  _typeLabel(type) {
    const def = (typeof COMPONENT_DEFS !== 'undefined') ? COMPONENT_DEFS[type] : null;
    return (def && def.name) || type;
  },

  // Deep, serialized snapshot of the current live network.
  _snapshotCurrent() {
    const data = AppState.toJSON();
    return {
      baseMVA: data.baseMVA,
      nextId: data.nextId,
      components: JSON.parse(JSON.stringify(data.components || [])),
      wires: JSON.parse(JSON.stringify(data.wires || [])),
    };
  },

  // id → props of the current live network, for the "differs from current"
  // highlight in the grid.
  _currentPropMap() {
    const map = {};
    for (const [id, c] of AppState.components) map[id] = c.props || {};
    return map;
  },

  // Components shown/edited for the active case (live objects when Current).
  _activeComponents() {
    const c = this._activeCase();
    if (c) return c.components || [];
    return [...AppState.components.values()];
  },

  _activeBaseMVA() {
    const c = this._activeCase();
    return c ? (c.baseMVA != null ? c.baseMVA : AppState.baseMVA) : AppState.baseMVA;
  },

  // ── Open / render ──────────────────────────────────────────────────
  openManager() {
    const body = document.getElementById('lf-study-body');
    const modal = document.getElementById('lf-study-modal');
    if (!body || !modal) return;
    if (!AppState.components.size) {
      document.getElementById('status-info').textContent =
        'Add components before running a load flow study.';
      return;
    }
    // Default to a case if one exists and the previously-active id is gone.
    if (this._activeCaseId !== '__current__' && !this._activeCase()) {
      this._activeCaseId = '__current__';
    }
    this._render(body);
    modal.style.display = '';
  },

  _render(body) {
    const cases = this._cases();
    const active = this._activeCase();
    const styles = `<style>
      #lf-study-body .lf-bar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:10px;font-size:12px}
      #lf-study-body .lf-chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
      #lf-study-body .lf-chip{padding:4px 10px;border:1px solid var(--border-color,#d0d0d0);border-radius:14px;cursor:pointer;font-size:12px;background:transparent;color:inherit}
      #lf-study-body .lf-chip.active{border-color:var(--accent-color,#2a78d6);background:color-mix(in srgb,var(--accent-color,#2a78d6) 14%,transparent);font-weight:600}
      #lf-study-body .lf-caseacts{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
      #lf-study-body .lf-btn{font-size:11px;padding:3px 10px;cursor:pointer;border:1px solid var(--border-color,#d0d0d0);border-radius:4px;background:transparent;color:inherit}
      #lf-study-body .lf-btn-primary{border-color:var(--accent-color,#2a78d6);background:color-mix(in srgb,var(--accent-color,#2a78d6) 16%,transparent)}
      #lf-study-body .lf-type-title{font-size:12px;font-weight:700;margin:12px 0 4px}
      #lf-study-body table.lf-attr-table,#lf-study-body table.lf-cmp-table{border-collapse:collapse;font-size:11px;width:100%;font-variant-numeric:tabular-nums}
      #lf-study-body .lf-attr-table th,#lf-study-body .lf-attr-table td,#lf-study-body .lf-cmp-table th,#lf-study-body .lf-cmp-table td{border:1px solid var(--border-color,#e0e0e0);padding:3px 6px;text-align:left;white-space:nowrap}
      #lf-study-body .lf-attr-table th{background:var(--bg-secondary,#f4f4f7)}
      #lf-study-body .lf-unit{color:var(--text-muted,#6d6d6d);font-weight:400}
      #lf-study-body .lf-comp-name,#lf-study-body .lf-metric{font-weight:600}
      #lf-study-body .lf-attr-table input,#lf-study-body .lf-attr-table select{width:88px;font-size:11px;background:var(--bg-primary,#fff);color:inherit;border:1px solid var(--border-color,#d0d0d0);border-radius:3px;padding:2px 3px}
      #lf-study-body .lf-cell-changed{outline:2px solid var(--accent-color,#2a78d6);outline-offset:-2px}
      #lf-study-body .lf-grid-scroll,#lf-study-body .lf-results-scroll{max-height:340px;overflow:auto;margin-top:4px}
      #lf-study-body .lf-cmp-table th{background:var(--bg-secondary,#f4f4f7);vertical-align:top}
      #lf-study-body .lf-section{font-weight:700;background:var(--bg-secondary,#f4f4f7)}
      #lf-study-body .lf-note{font-size:11px;color:var(--text-muted,#6d6d6d);margin:8px 0 0}
    </style>`;

    // Toolbar
    let html = styles + `<div class="lf-bar">
      <label>Method
        <select id="lf-method">
          <option value="newton_raphson"${this._method === 'newton_raphson' ? ' selected' : ''}>Newton-Raphson</option>
          <option value="gauss_seidel"${this._method === 'gauss_seidel' ? ' selected' : ''}>Gauss-Seidel</option>
        </select></label>
      <label><input type="checkbox" id="lf-inc-current"${this._includeCurrent ? ' checked' : ''}> Include current network</label>
      <button class="lf-btn lf-btn-primary" id="lf-run">▶ Run all cases</button>
    </div>`;

    // Case chips (Current + saved)
    html += '<div class="lf-chips">';
    html += `<button class="lf-chip${this._activeCaseId === '__current__' ? ' active' : ''}" data-case="__current__">Current network</button>`;
    cases.forEach(c => {
      html += `<button class="lf-chip${this._activeCaseId === c.id ? ' active' : ''}" data-case="${this._esc(c.id)}">${this._esc(c.name)}</button>`;
    });
    html += `<button class="lf-chip" id="lf-new">+ New from current</button>`;
    html += '</div>';

    // Case actions
    html += '<div class="lf-caseacts">';
    if (active) {
      html += `<span style="font-size:12px;align-self:center">Editing <strong>${this._esc(active.name)}</strong> · Base MVA
        <input type="number" id="lf-basemva" value="${this._esc(this._activeBaseMVA())}" min="0.1" step="1" style="width:70px"></span>`;
      html += `<button class="lf-btn" id="lf-rename">Rename</button>`;
      html += `<button class="lf-btn" id="lf-dup">Duplicate</button>`;
      html += `<button class="lf-btn" id="lf-del">Delete</button>`;
      html += `<button class="lf-btn" id="lf-apply">Apply to network</button>`;
    } else {
      html += `<span style="font-size:12px;align-self:center;color:var(--text-muted,#6d6d6d)">The live network (read-only here). Base MVA ${this._esc(AppState.baseMVA)}. Create a case to edit attributes.</span>`;
    }
    html += '</div>';

    // Attribute grid
    html += `<div class="lf-grid-scroll">${this._renderGrid()}</div>`;

    // Results
    html += `<div id="lf-results">${this._renderResults()}</div>`;

    body.innerHTML = html;
    this._wire(body);
  },

  _renderGrid() {
    const comps = this._activeComponents();
    const readOnly = !this._activeCase();
    const curMap = this._currentPropMap();
    const byType = {};
    comps.forEach(c => { if (LF_ATTRS[c.type]) (byType[c.type] = byType[c.type] || []).push(c); });
    const types = Object.keys(LF_ATTRS).filter(t => byType[t] && byType[t].length);
    if (!types.length) return '<p style="font-size:12px">No load-flow components in this case.</p>';

    let html = '';
    types.forEach(type => {
      const fields = LF_ATTRS[type].map(k => ({ ...this._field(type, k), key: k }));
      html += `<div class="lf-type-title">${this._esc(this._typeLabel(type))}</div>`;
      html += '<table class="lf-attr-table"><thead><tr><th>Component</th>' +
        fields.map(f => `<th>${this._esc(f.label)}${f.unit ? ` <span class="lf-unit">(${this._esc(f.unit)})</span>` : ''}</th>`).join('') +
        '</tr></thead><tbody>';
      byType[type].forEach(c => {
        html += `<tr><td class="lf-comp-name">${this._esc((c.props && c.props.name) || c.id)}</td>` +
          fields.map(f => `<td>${this._cellInput(c, type, f, readOnly, curMap)}</td>`).join('') + '</tr>';
      });
      html += '</tbody></table>';
    });
    return html;
  },

  _cellInput(c, type, f, readOnly, curMap) {
    const val = c.props ? c.props[f.key] : undefined;
    const cur = curMap[c.id] ? curMap[c.id][f.key] : undefined;
    const changed = !readOnly && cur !== undefined && val !== undefined && String(val) !== String(cur);
    const cls = 'lf-cell' + (changed ? ' lf-cell-changed' : '');
    const dis = readOnly ? ' disabled' : '';
    const da = `data-cid="${this._esc(c.id)}" data-key="${this._esc(f.key)}"`;
    if (f.type === 'select' && Array.isArray(f.options)) {
      const opts = f.options.map(o => {
        const ov = (o && typeof o === 'object') ? o.value : o;
        const ol = (o && typeof o === 'object') ? o.label : o;
        return `<option value="${this._esc(ov)}"${String(ov) === String(val) ? ' selected' : ''}>${this._esc(ol)}</option>`;
      }).join('');
      return `<select class="${cls}" ${da}${dis}>${opts}</select>`;
    }
    if (f.type === 'number') {
      const attrs = [f.min != null ? `min="${f.min}"` : '', f.max != null ? `max="${f.max}"` : '',
                     f.step != null ? `step="${f.step}"` : ''].filter(Boolean).join(' ');
      return `<input type="number" class="${cls}" ${da} value="${this._esc(val != null ? val : '')}" ${attrs}${dis}>`;
    }
    return `<input type="text" class="${cls}" ${da} value="${this._esc(val != null ? val : '')}"${dis}>`;
  },

  _renderResults() {
    const res = this._results;
    if (!res || !res.length) return '';
    const cur = res.find(r => r.id === '__current__');
    const fmtV = v => (v != null ? v.toFixed(3) : '—');

    const metricRows = [
      ['Converged', r => r.summary.converged ? 'yes' : '<span style="color:#c62828;font-weight:700">NO</span>'],
      ['Iterations', r => r.summary.iterations],
      ['Min V (p.u.)', r => r.summary.min_v_pu != null ? `${fmtV(r.summary.min_v_pu)} <span class="lf-unit">@ ${this._esc(r.summary.min_v_bus)}</span>` : '—'],
      ['Max V (p.u.)', r => r.summary.max_v_pu != null ? `${fmtV(r.summary.max_v_pu)} <span class="lf-unit">@ ${this._esc(r.summary.max_v_bus)}</span>` : '—'],
      ['Total losses (MW)', r => r.summary.total_losses_mw.toFixed(4)],
      ['Overloaded branches', r => r.summary.overloaded_branch_count],
      ['Worst branch', r => r.summary.worst_branch_name ? `${this._esc(r.summary.worst_branch_name)} (${r.summary.worst_branch_loading_pct.toFixed(0)}%)` : '—'],
      ['De-energized buses', r => r.summary.deenergized_bus_count],
    ];

    let html = '<div class="lf-type-title">Comparison</div><div class="lf-results-scroll"><table class="lf-cmp-table"><thead><tr><th>Metric</th>' +
      res.map(r => `<th>${this._esc(r.name)}<br><button class="lf-btn lf-show" data-id="${this._esc(r.id)}">Show on diagram</button></th>`).join('') +
      '</tr></thead><tbody>';

    metricRows.forEach(([label, fn]) => {
      html += `<tr><td class="lf-metric">${label}</td>` + res.map(r => {
        if (!r.summary.converged && label !== 'Converged' && label !== 'Iterations') return '<td>—</td>';
        return `<td>${fn(r)}</td>`;
      }).join('') + '</tr>';
    });

    // Per-bus voltages (union of bus ids across cases)
    const busIds = [], seen = new Set();
    res.forEach(r => Object.keys(r.result.buses || {}).forEach(bid => {
      if (!seen.has(bid)) { seen.add(bid); busIds.push(bid); }
    }));
    if (busIds.length) {
      html += `<tr><td colspan="${res.length + 1}" class="lf-section">Bus voltages (p.u.)</td></tr>`;
      busIds.forEach(bid => {
        html += `<tr><td class="lf-metric">${this._esc(this._busName(res, bid))}</td>` + res.map(r => {
          const b = (r.result.buses || {})[bid];
          if (!b || !b.energized) return '<td>—</td>';
          let cell = b.voltage_pu.toFixed(3);
          if (cur && r.id !== '__current__') {
            const cb = (cur.result.buses || {})[bid];
            if (cb && cb.energized) {
              const d = b.voltage_pu - cb.voltage_pu;
              if (Math.abs(d) >= 0.0005) {
                const col = d > 0 ? '#2e7d32' : '#c62828';
                cell += ` <span style="color:${col};font-size:10px">${d > 0 ? '+' : ''}${d.toFixed(3)}</span>`;
              }
            }
          }
          return `<td>${cell}</td>`;
        }).join('') + '</tr>';
      });
    }
    html += '</tbody></table></div>';
    html += '<p class="lf-note">“Show on diagram” loads a case’s result onto the canvas badges/arrows — close this dialog to view. The canvas then shows a hypothetical case, not the live network.</p>';
    return html;
  },

  _busName(res, bid) {
    for (const r of res) {
      const b = (r.result.buses || {})[bid];
      if (b && b.bus_name) return b.bus_name;
    }
    return bid;
  },

  // ── Event wiring ───────────────────────────────────────────────────
  _wire(body) {
    const $ = sel => body.querySelector(sel);
    const method = $('#lf-method');
    if (method) method.addEventListener('change', () => { this._method = method.value; });
    const inc = $('#lf-inc-current');
    if (inc) inc.addEventListener('change', () => { this._includeCurrent = inc.checked; });
    const run = $('#lf-run');
    if (run) run.addEventListener('click', () => this.runAll());

    body.querySelectorAll('.lf-chip[data-case]').forEach(el =>
      el.addEventListener('click', () => { this._activeCaseId = el.dataset.case; this._render(body); }));
    const nw = $('#lf-new');
    if (nw) nw.addEventListener('click', () => this._newFromCurrent(body));

    const baseMva = $('#lf-basemva');
    if (baseMva) baseMva.addEventListener('change', () => {
      const c = this._activeCase();
      if (!c) return;
      const v = parseFloat(baseMva.value);
      if (Number.isFinite(v) && v > 0) { c.baseMVA = v; AppState.dirty = true; }
      else baseMva.value = c.baseMVA != null ? c.baseMVA : AppState.baseMVA;
    });
    const rename = $('#lf-rename');
    if (rename) rename.addEventListener('click', () => this._rename(body));
    const dup = $('#lf-dup');
    if (dup) dup.addEventListener('click', () => this._duplicate(body));
    const del = $('#lf-del');
    if (del) del.addEventListener('click', () => this._delete(body));
    const apply = $('#lf-apply');
    if (apply) apply.addEventListener('click', () => this._applyToNetwork(body));

    // Delegated grid edits
    body.querySelectorAll('.lf-grid-scroll').forEach(grid =>
      grid.addEventListener('change', e => this._onGridChange(e)));

    body.querySelectorAll('.lf-show').forEach(el =>
      el.addEventListener('click', () => this._showOnDiagram(el.dataset.id)));
  },

  _onGridChange(e) {
    const el = e.target;
    const cid = el.dataset && el.dataset.cid, key = el.dataset && el.dataset.key;
    if (!cid || !key) return;
    const c = this._activeCase();
    if (!c) return;   // Current network is read-only
    const comp = (c.components || []).find(x => x.id === cid);
    if (!comp) return;
    comp.props = comp.props || {};
    if (el.type === 'number') {
      let v = parseFloat(el.value);
      if (!Number.isFinite(v)) { el.value = comp.props[key] != null ? comp.props[key] : ''; return; }
      const f = this._field(comp.type, key);
      if (f.min != null && v < f.min) v = f.min;
      if (f.max != null && v > f.max) v = f.max;
      el.value = v;
      comp.props[key] = v;
    } else {
      comp.props[key] = el.value;
    }
    AppState.dirty = true;
    const cur = this._currentPropMap()[cid];
    const changed = cur && cur[key] !== undefined && String(comp.props[key]) !== String(cur[key]);
    el.classList.toggle('lf-cell-changed', !!changed);
  },

  // ── Case management ────────────────────────────────────────────────
  _newFromCurrent(body) {
    const snap = this._snapshotCurrent();
    const cases = this._cases();
    const id = 'lfc_' + Date.now();
    cases.push({ id, name: `Case ${cases.length + 1}`, baseMVA: snap.baseMVA,
                 loadFlowMethod: null, nextId: snap.nextId,
                 components: snap.components, wires: snap.wires });
    AppState.dirty = true;
    this._activeCaseId = id;
    this._render(body);
  },

  _rename(body) {
    const c = this._activeCase();
    if (!c) return;
    const name = (window.prompt('Rename case', c.name) || '').trim();
    if (name) { c.name = name; AppState.dirty = true; this._render(body); }
  },

  _duplicate(body) {
    const c = this._activeCase();
    if (!c) return;
    const cases = this._cases();
    const id = 'lfc_' + Date.now();
    cases.push({ id, name: `${c.name} (copy)`, baseMVA: c.baseMVA,
                 loadFlowMethod: c.loadFlowMethod || null, nextId: c.nextId,
                 components: JSON.parse(JSON.stringify(c.components || [])),
                 wires: JSON.parse(JSON.stringify(c.wires || [])) });
    AppState.dirty = true;
    this._activeCaseId = id;
    this._render(body);
  },

  _delete(body) {
    const c = this._activeCase();
    if (!c) return;
    if (!window.confirm(`Delete case “${c.name}”?`)) return;
    const cases = this._cases();
    const i = cases.findIndex(x => x.id === c.id);
    if (i >= 0) cases.splice(i, 1);
    AppState.dirty = true;
    this._activeCaseId = '__current__';
    this._render(body);
  },

  _applyToNetwork(body) {
    const c = this._activeCase();
    if (!c) return;
    if (!window.confirm(`Apply case “${c.name}” to the live diagram? This replaces the current network configuration (device names are kept).`)) return;
    AppState.applyLoadFlowCase(c);
    if (typeof UndoManager !== 'undefined' && UndoManager.clear) UndoManager.clear();
    if (typeof Canvas !== 'undefined' && Canvas.render) Canvas.render();
    if (typeof Properties !== 'undefined' && Properties.clear) Properties.clear();
    document.getElementById('status-info').textContent = `Applied case “${c.name}” to the network.`;
    this._render(body);
  },

  // ── Run ────────────────────────────────────────────────────────────
  async runAll() {
    const cases = this._cases();
    if (!cases.length && !this._includeCurrent) {
      document.getElementById('status-info').textContent =
        'No cases to run — create a case or include the current network.';
      return;
    }
    const label = 'Running load flow study cases…';
    document.getElementById('status-info').textContent = label;
    if (typeof UI !== 'undefined' && UI.setBusy) UI.setBusy(true, label);
    try {
      const resp = await API.runLoadFlowCases(cases, this._method, this._includeCurrent);
      this._results = (resp && resp.cases) || [];
      const nonconv = this._results.filter(r => !r.summary.converged).length;
      document.getElementById('status-info').textContent =
        `Load flow study complete — ${this._results.length} case(s)` +
        (nonconv ? `, ${nonconv} did not converge.` : '.');
      const body = document.getElementById('lf-study-body');
      if (body) {
        const container = document.getElementById('lf-results');
        if (container) container.innerHTML = this._renderResults();
        // Re-wire the new result buttons.
        body.querySelectorAll('.lf-show').forEach(el =>
          el.addEventListener('click', () => this._showOnDiagram(el.dataset.id)));
      }
    } catch (e) {
      console.error('Load flow study error:', e);
      document.getElementById('status-info').textContent = 'Load flow study failed.';
      if (typeof showValidationModal === 'function') {
        showValidationModal('Load Flow Study Manager — Error', [{ msg: e.message || 'Unknown error' }], [], null);
      }
    } finally {
      if (typeof UI !== 'undefined' && UI.setBusy) UI.setBusy(false);
    }
  },

  _showOnDiagram(id) {
    const r = (this._results || []).find(x => x.id === id);
    if (!r) return;
    AppState.loadFlowResults = r.result;   // result-slot accessor stamps provenance
    if (typeof Canvas !== 'undefined' && Canvas.render) Canvas.render();
    document.getElementById('status-info').textContent =
      `Load flow: showing “${r.name}” on the diagram — close this dialog to view.`;
  },
};
