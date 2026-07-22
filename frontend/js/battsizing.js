/* ProtectionPro — Battery Sizing & Discharge UI.
 *
 * Setup modal (battery, duty-cycle steps, IEEE 485-style factors) → backend
 * /analysis/battery-sizing → results modal with the sizing verdict
 * (required vs installed kWh/Ah), violations, and SoC / terminal-voltage
 * discharge charts over the duty cycle.
 *
 * Results are on-demand (not persisted with the project) — re-run after edits.
 */
const BatterySizing = {
  _result: null,
  _cfg: { battery_id: '', aging: 1.25, margin: 1.10, temp_c: 25,
          duty: [{ duration_min: 120, load_kw: 10 }] },

  _esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },

  _batteries() {
    return [...AppState.components.values()]
      .filter(c => c.type === 'battery'
        || (c.type === 'solar_pv' && c.props?.inverter_type === 'hybrid'))
      .map(c => ({ id: c.id, name: c.props?.name || c.id }));
  },

  // ── Setup ──────────────────────────────────────────────────────────
  openConfig() {
    const units = this._batteries();
    if (!units.length) {
      document.getElementById('status-info').textContent =
        'Add a BESS or hybrid-PV component before running battery sizing.';
      return;
    }
    const c = this._cfg;
    const opt = units.map(o =>
      `<option value="${this._esc(o.id)}"${o.id === c.battery_id ? ' selected' : ''}>${this._esc(o.name)}</option>`).join('');
    const body = document.getElementById('bsz-config-body');
    body.innerHTML = `
      <p style="font-size:12px;color:var(--text-muted,#6d6d6d);margin:0 0 12px">
        Sizes the battery for a <strong>duty cycle</strong> using IEEE 485-style
        correction factors (inverter efficiency, usable DoD, aging, design margin,
        temperature) and simulates the discharge — state of charge and
        <strong>terminal voltage vs time</strong> from the chemistry's OCV curve,
        1C sag and (for lead-acid) Peukert's law.</p>
      <div style="display:grid;grid-template-columns:auto 1fr;gap:8px 12px;align-items:center;font-size:13px">
        <label for="bsz-batt">Battery</label>
        <select id="bsz-batt">${opt}</select>
        <label for="bsz-aging">Aging factor</label>
        <input id="bsz-aging" type="number" min="1" max="2" step="0.05" value="${c.aging}">
        <label for="bsz-margin">Design margin</label>
        <input id="bsz-margin" type="number" min="1" max="2" step="0.05" value="${c.margin}">
        <label for="bsz-temp">Electrolyte / cell temperature (°C)</label>
        <input id="bsz-temp" type="number" min="-20" max="50" step="1" value="${c.temp_c}">
      </div>
      <div style="margin-top:12px;font-size:13px"><strong>Duty cycle</strong>
        <span style="font-size:11px;color:var(--text-muted,#6d6d6d)">— leave one 0 kW row to derive from the island's essential load</span></div>
      <div id="bsz-duty-rows" style="margin-top:6px"></div>
      <button class="btn" id="bsz-add-step" type="button" style="margin-top:6px;font-size:12px">+ Add step</button>`;
    this._renderDuty();
    document.getElementById('bsz-add-step').addEventListener('click', () => {
      this._readDuty();
      this._cfg.duty.push({ duration_min: 30, load_kw: 5 });
      this._renderDuty();
    });
    document.getElementById('bsz-config-modal').style.display = '';
  },

  _renderDuty() {
    const rows = this._cfg.duty.map((s, i) => `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:4px;font-size:12px" data-duty-row="${i}">
        <span style="width:44px;color:var(--text-muted,#6d6d6d)">Step ${i + 1}</span>
        <input type="number" data-duty-min min="1" step="1" value="${s.duration_min}" style="width:90px"> min at
        <input type="number" data-duty-kw min="0" step="0.5" value="${s.load_kw}" style="width:90px"> kW
        <button class="btn" type="button" data-duty-del title="Remove step" style="font-size:11px;padding:1px 7px">✕</button>
      </div>`).join('');
    const host = document.getElementById('bsz-duty-rows');
    host.innerHTML = rows;
    host.querySelectorAll('[data-duty-del]').forEach((btn, i) => {
      btn.addEventListener('click', () => {
        this._readDuty();
        this._cfg.duty.splice(i, 1);
        if (!this._cfg.duty.length) this._cfg.duty.push({ duration_min: 120, load_kw: 0 });
        this._renderDuty();
      });
    });
  },

  _readDuty() {
    const rows = [...document.querySelectorAll('#bsz-duty-rows [data-duty-row]')];
    if (rows.length) {
      this._cfg.duty = rows.map(r => ({
        duration_min: parseFloat(r.querySelector('[data-duty-min]').value) || 0,
        load_kw: parseFloat(r.querySelector('[data-duty-kw]').value) || 0,
      })).filter(s => s.duration_min > 0);
    }
  },

  _readConfig() {
    const v = id => document.getElementById(id);
    this._readDuty();
    this._cfg.battery_id = v('bsz-batt').value || '';
    this._cfg.aging = parseFloat(v('bsz-aging').value) || 1.25;
    this._cfg.margin = parseFloat(v('bsz-margin').value) || 1.10;
    this._cfg.temp_c = parseFloat(v('bsz-temp').value);
    if (!isFinite(this._cfg.temp_c)) this._cfg.temp_c = 25;
    return this._cfg;
  },

  async runConfigured() {
    const c = this._readConfig();
    document.getElementById('bsz-config-modal').style.display = 'none';
    const label = 'Running battery sizing…';
    document.getElementById('status-info').textContent = label;
    if (typeof UI !== 'undefined' && UI.setBusy) UI.setBusy(true, label);
    try {
      const usable = c.duty.filter(s => s.load_kw > 0);
      const result = await API.runBatterySizing({
        batteryId: c.battery_id, dutyCycle: usable.length ? usable : null,
        agingFactor: c.aging, designMargin: c.margin, temperatureC: c.temp_c,
      });
      this._result = result;
      this.show(result);
      document.getElementById('status-info').textContent = result.converged
        ? (result.sized_ok
           ? `Battery sizing: OK — ${result.required_kwh} kWh required, ${result.installed_kwh} kWh installed`
           : `Battery sizing: undersized — ${result.required_kwh} kWh required vs ${result.installed_kwh} kWh installed`)
        : 'Battery sizing did not run.';
    } catch (e) {
      console.error('Battery sizing error:', e);
      document.getElementById('status-info').textContent = 'Battery sizing failed.';
      if (typeof showValidationModal === 'function') {
        showValidationModal('Battery Sizing — Error', [{ msg: e.message || 'Unknown error' }], [], null);
      }
    } finally {
      if (typeof UI !== 'undefined' && UI.setBusy) UI.setBusy(false);
    }
  },

  // ── Results ────────────────────────────────────────────────────────
  show(result) {
    this._result = result;
    const modal = document.getElementById('bsz-modal');
    const body = document.getElementById('bsz-body');
    if (!modal || !body) return;
    this._render(body);
    modal.style.display = '';
  },

  _render(body) {
    const r = this._result || {};
    let html = '';
    if ((r.warnings || []).length) {
      html += '<div class="af-warnings">' + r.warnings.map(w =>
        `<div class="af-warning-item">⚠ ${this._esc(w)}</div>`).join('') + '</div>';
    }
    if (!r.converged) {
      body.innerHTML = html + `<p style="color:#c62828"><strong>Study did not run.</strong> ${this._esc(r.note || '')}</p>`;
      return;
    }

    const bad = !r.sized_ok || (r.violations || []).length;
    const col = bad ? '#c62828' : '#2e7d32';
    const verdict = r.sized_ok
      ? `Adequately sized — ${r.required_kwh} kWh required, ${r.installed_kwh} kWh installed`
      : `Undersized — ${r.required_kwh} kWh required vs ${r.installed_kwh} kWh installed`
        + (r.units_of_installed_needed > 1 ? ` (${r.units_of_installed_needed}× the installed unit)` : '');
    html += `<div style="margin-bottom:12px;padding:10px 14px;border-radius:6px;border:1px solid ${col};background:${col}14">
      <span style="font-weight:700;color:${col}">${this._esc(verdict)}</span>
      <span style="font-size:12px;color:var(--text-muted,#6d6d6d)"> · ${this._esc(r.battery_name)} — ${this._esc(r.chemistry_label || r.chemistry)}</span>
    </div>`;

    const f = r.factors || {};
    html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:6px 14px;font-size:12px;margin-bottom:12px">'
      + `<div><strong>Duty</strong><br><span style="color:var(--text-muted,#6d6d6d)">${r.duty_kwh} kWh over ${r.duty_min} min (peak ${r.peak_kw} kW)${r.duty_derived ? ' — derived from island load' : ''}</span></div>`
      + `<div><strong>Required</strong><br><span style="color:var(--text-muted,#6d6d6d)">${r.required_kwh} kWh · ${r.required_ah} Ah @ ${r.nominal_v} V</span></div>`
      + `<div><strong>Factors</strong><br><span style="color:var(--text-muted,#6d6d6d)">η ${f.eta_inverter_1way} · DoD ${(f.dod * 100).toFixed(0)}% · age ${f.aging} · margin ${f.design_margin} · K_T ${f.k_temp}</span></div>`
      + `<div><strong>Discharge sim</strong><br><span style="color:var(--text-muted,#6d6d6d)">${r.runtime_to_floor_min != null ? `floor at ${r.runtime_to_floor_min} min` : 'duty completed'} · min V ${r.min_v_pu} pu · end SoC ${r.end_soc_pct}%</span></div>`
      + '</div>';

    if ((r.violations || []).length) {
      html += '<div class="af-warnings">' + r.violations.map(v =>
        `<div class="af-warning-item">✗ ${this._esc(v.message)}</div>`).join('') + '</div>';
    }

    html += `<div class="bsz-chart" data-chart="soc"></div><div class="bsz-chart" data-chart="v"></div>`;
    html += this._dataTable(r);
    body.innerHTML = html;
    this._hydrate(body, r);
  },

  _dataTable(r) {
    const tr = r.trajectory || {};
    if (!(tr.t_min || []).length) return '';
    const stride = Math.max(1, Math.round(tr.t_min.length / 50));
    let rows = '';
    for (let i = 0; i < tr.t_min.length; i += stride) {
      rows += `<tr><td>${tr.t_min[i].toFixed(1)}</td><td>${tr.load_kw[i].toFixed(1)}</td><td>${tr.soc_pct[i].toFixed(1)}</td><td>${tr.v_pu[i].toFixed(3)}</td></tr>`;
    }
    return `<details style="font-size:11px;margin-top:8px"><summary style="cursor:pointer">Discharge data</summary>
      <div style="max-height:220px;overflow:auto;margin-top:6px"><table class="af-table" style="font-size:10px;font-variant-numeric:tabular-nums">
      <thead><tr><th>t (min)</th><th>Load (kW)</th><th>SoC (%)</th><th>V (pu)</th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
  },

  _hydrate(root, r) {
    const tr = r.trajectory || {};
    if (!(tr.t_min || []).length) return;
    const dark = document.body.classList.contains('dark-mode');
    const P = (typeof VoltageStability !== 'undefined' && VoltageStability._palette)
      ? VoltageStability._palette(dark)
      : { pool: ['#2a78d6', '#1baf7a'], grid: '#e4e4ea', axis: '#d0d0d0',
          tickText: '#6d6d6d', ink: '#1a1a2e', inkSec: '#555' };
    const floorPct = r.factors ? (1 - r.factors.dod) * 100 : null;
    const charts = {
      soc: {
        title: 'State of charge over the duty cycle',
        xLabel: 't (min)', yLabel: 'SoC (%)', xs: tr.t_min,
        series: [{ name: 'SoC', values: tr.soc_pct, color: P.pool[0], width: 2.2 }],
        markers: r.runtime_to_floor_min != null
          ? [{ x: r.runtime_to_floor_min, label: 'DoD floor', color: dark ? '#ff5b5b' : '#c62828', dashed: true }] : [],
      },
      v: {
        title: 'Terminal voltage over the duty cycle',
        xLabel: 't (min)', yLabel: 'V (pu of nominal)', xs: tr.t_min,
        series: [{ name: 'V', values: tr.v_pu, color: P.pool[1], width: 2.2 }],
        markers: [],
      },
    };
    root.querySelectorAll('.bsz-chart').forEach(el => {
      const spec = charts[el.dataset.chart];
      if (spec && typeof VoltageStability !== 'undefined' && VoltageStability._chart) {
        VoltageStability._chart.call(VoltageStability, el, spec, P);
      }
    });
    void floorPct;
  },
};
