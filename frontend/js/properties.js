/* ProtectionPro — Properties Panel */

const Properties = {
  contentEl: null,
  calcInfoEl: null,
  currentId: null,

  init() {
    this.contentEl = document.getElementById('properties-content');
    this.calcInfoEl = document.getElementById('calc-info');

    // Calculation modal
    document.getElementById('btn-show-calc').addEventListener('click', () => this.showCalcModal());
    document.getElementById('btn-close-calc').addEventListener('click', () => this.hideCalcModal());
    document.getElementById('calc-modal').addEventListener('click', (e) => {
      if (e.target.id === 'calc-modal') this.hideCalcModal();
    });
  },

  // Show properties for a component
  show(id) {
    this.currentId = id;
    const comp = AppState.components.get(id);
    if (!comp) {
      this.clear();
      return;
    }
    const def = COMPONENT_DEFS[comp.type];
    document.getElementById('properties-title').textContent = def.name;

    // Build component info header
    let html = `
      <div class="component-info">
        <div class="comp-icon">${Symbols.renderPaletteIcon(comp.type)}</div>
        <div class="comp-details">
          <div class="comp-name">${comp.props.name || def.name}</div>
          <div class="comp-type">${def.name} — ID: ${comp.id}</div>
        </div>
      </div>`;

    // Build editable fields grouped by section
    html += '<div class="prop-section"><div class="prop-section-title">Parameters</div>';
    for (const field of def.fields) {
      const val = comp.props[field.key] ?? '';
      html += this.renderField(field, val, comp.id);
    }
    html += '</div>';

    // Position section
    html += `
      <div class="prop-section">
        <div class="prop-section-title">Position</div>
        <div class="prop-row">
          <label>X</label>
          <input type="number" data-field="__x" value="${comp.x}" step="${SNAP_SIZE}">
        </div>
        <div class="prop-row">
          <label>Y</label>
          <input type="number" data-field="__y" value="${comp.y}" step="${SNAP_SIZE}">
        </div>
        <div class="prop-row">
          <label>Rotation</label>
          <select data-field="__rotation">
            <option value="0" ${comp.rotation === 0 ? 'selected' : ''}>0°</option>
            <option value="90" ${comp.rotation === 90 ? 'selected' : ''}>90°</option>
            <option value="180" ${comp.rotation === 180 ? 'selected' : ''}>180°</option>
            <option value="270" ${comp.rotation === 270 ? 'selected' : ''}>270°</option>
          </select>
        </div>
      </div>`;

    // Per-unit values section
    const puValues = this.computePerUnit(comp);
    if (puValues) {
      html += `
        <div class="prop-section">
          <div class="prop-section-title">Per-Unit Values (Base: ${AppState.baseMVA} MVA)</div>
          ${puValues}
        </div>`;
    }

    this.contentEl.innerHTML = html;

    // Show calc info button if results exist
    this.calcInfoEl.style.display =
      (AppState.faultResults || AppState.loadFlowResults) ? '' : 'none';

    // Bind change events
    this.contentEl.querySelectorAll('input, select').forEach(input => {
      input.addEventListener('change', (e) => this.onFieldChange(e, comp));
      input.addEventListener('input', (e) => {
        // Live update for text/number fields
        if (e.target.type === 'text' || e.target.type === 'number') {
          this.onFieldChange(e, comp);
        }
      });
    });
  },

  renderField(field, value, compId) {
    const unitHtml = field.unit ? `<span class="unit">${field.unit}</span>` : '';
    let inputHtml = '';

    if (field.type === 'select') {
      const options = field.options.map(opt =>
        `<option value="${opt}" ${value === opt ? 'selected' : ''}>${opt}</option>`
      ).join('');
      inputHtml = `<select data-field="${field.key}">${options}</select>`;
    } else {
      inputHtml = `<input type="${field.type}" data-field="${field.key}" value="${value}" step="any">`;
    }

    return `
      <div class="prop-row">
        <label>${field.label}</label>
        ${inputHtml}
        ${unitHtml}
      </div>`;
  },

  onFieldChange(e, comp) {
    const field = e.target.dataset.field;
    let value = e.target.value;

    // Position/rotation are special
    if (field === '__x') {
      comp.x = snapToGrid(parseFloat(value) || 0);
    } else if (field === '__y') {
      comp.y = snapToGrid(parseFloat(value) || 0);
    } else if (field === '__rotation') {
      comp.rotation = parseInt(value) || 0;
    } else {
      // Type coerce numbers
      if (e.target.type === 'number') {
        value = parseFloat(value);
        if (isNaN(value)) return;
      }
      comp.props[field] = value;
    }

    AppState.dirty = true;
    AppState.clearResults();
    Canvas.render();

    // Update component label if name changed
    if (field === 'name') {
      const label = document.querySelector(`.sld-component[data-id="${comp.id}"] .comp-label`);
      if (label) label.textContent = value;
    }
  },

  // Compute per-unit values for display
  computePerUnit(comp) {
    const base = AppState.baseMVA;
    let html = '';

    if (comp.type === 'utility') {
      const Zpu = base / (comp.props.fault_mva || 1);
      const xr = comp.props.x_r_ratio || 15;
      const Xpu = Zpu * xr / Math.sqrt(1 + xr * xr);
      const Rpu = Xpu / xr;
      html += `<div class="prop-row"><label>Z (p.u.)</label><span class="pu-value">${Zpu.toFixed(4)}</span></div>`;
      html += `<div class="prop-row"><label>R (p.u.)</label><span class="pu-value">${Rpu.toFixed(4)}</span></div>`;
      html += `<div class="prop-row"><label>X (p.u.)</label><span class="pu-value">${Xpu.toFixed(4)}</span></div>`;
    } else if (comp.type === 'transformer') {
      const Zpu = (comp.props.z_percent / 100) * base / (comp.props.rated_mva || 1);
      const xr = comp.props.x_r_ratio || 10;
      const Xpu = Zpu * xr / Math.sqrt(1 + xr * xr);
      const Rpu = Xpu / xr;
      html += `<div class="prop-row"><label>Z (p.u.)</label><span class="pu-value">${Zpu.toFixed(4)}</span></div>`;
      html += `<div class="prop-row"><label>R (p.u.)</label><span class="pu-value">${Rpu.toFixed(4)}</span></div>`;
      html += `<div class="prop-row"><label>X (p.u.)</label><span class="pu-value">${Xpu.toFixed(4)}</span></div>`;
    } else if (comp.type === 'generator') {
      const Xpu = (comp.props.xd_pp || 0.15) * base / (comp.props.rated_mva || 1);
      html += `<div class="prop-row"><label>X"d (p.u.)</label><span class="pu-value">${Xpu.toFixed(4)}</span></div>`;
    } else if (comp.type === 'cable') {
      const Vkv = comp.props.voltage_kv || 11;
      const Zbase = (Vkv * Vkv) / base;
      const Rpu = (comp.props.r_per_km * comp.props.length_km) / Zbase;
      const Xpu = (comp.props.x_per_km * comp.props.length_km) / Zbase;
      html += `<div class="prop-row"><label>R (p.u.)</label><span class="pu-value">${Rpu.toFixed(4)}</span></div>`;
      html += `<div class="prop-row"><label>X (p.u.)</label><span class="pu-value">${Xpu.toFixed(4)}</span></div>`;
    } else if (comp.type === 'motor_induction') {
      const kva = (comp.props.rated_kw || 200) / (comp.props.efficiency || 0.93);
      const Xpu = (comp.props.x_pp || 0.17) * base / (kva / 1000);
      html += `<div class="prop-row"><label>X" (p.u.)</label><span class="pu-value">${Xpu.toFixed(4)}</span></div>`;
    } else if (comp.type === 'motor_synchronous') {
      const Xpu = (comp.props.xd_pp || 0.15) * base / ((comp.props.rated_kva || 500) / 1000);
      html += `<div class="prop-row"><label>X"d (p.u.)</label><span class="pu-value">${Xpu.toFixed(4)}</span></div>`;
    } else {
      return null;
    }

    return html;
  },

  // Show calculation details modal
  showCalcModal() {
    if (!this.currentId) return;
    const comp = AppState.components.get(this.currentId);
    if (!comp) return;

    let html = '';

    // Show per-unit calculation steps
    html += this.renderCalcSteps(comp);

    // Show fault results for this component's bus
    if (AppState.faultResults && comp.type === 'bus') {
      const busResult = AppState.faultResults.buses?.[comp.id];
      if (busResult) {
        html += `
          <div class="calc-step">
            <div class="calc-step-title">Fault Analysis Results</div>
            <div class="calc-formula">
Three-Phase Fault: I"k3 = ${busResult.ik3?.toFixed(2) || 'N/A'} kA
SLG Fault:         I"k1 = ${busResult.ik1?.toFixed(2) || 'N/A'} kA
Line-to-Line:      I"kLL = ${busResult.ikLL?.toFixed(2) || 'N/A'} kA</div>
          </div>`;
      }
    }

    // Show load flow results
    if (AppState.loadFlowResults && comp.type === 'bus') {
      const busLF = AppState.loadFlowResults.buses?.[comp.id];
      if (busLF) {
        html += `
          <div class="calc-step">
            <div class="calc-step-title">Load Flow Results</div>
            <div class="calc-formula">
Voltage: ${busLF.voltage_pu?.toFixed(4) || 'N/A'} p.u. (${busLF.voltage_kv?.toFixed(2) || 'N/A'} kV)
Angle:   ${busLF.angle_deg?.toFixed(2) || 'N/A'}°
P load:  ${busLF.p_mw?.toFixed(3) || 'N/A'} MW
Q load:  ${busLF.q_mvar?.toFixed(3) || 'N/A'} MVAr</div>
          </div>`;
      }
    }

    if (!html) {
      html = '<p>No calculation data available. Run Fault Analysis or Load Flow first.</p>';
    }

    document.getElementById('calc-modal-title').textContent =
      `Calculations — ${comp.props.name || comp.type}`;
    document.getElementById('calc-modal-body').innerHTML = html;
    document.getElementById('calc-modal').style.display = '';
  },

  hideCalcModal() {
    document.getElementById('calc-modal').style.display = 'none';
  },

  renderCalcSteps(comp) {
    const base = AppState.baseMVA;
    let html = '';

    if (comp.type === 'utility') {
      const fmva = comp.props.fault_mva || 500;
      const xr = comp.props.x_r_ratio || 15;
      const Zpu = base / fmva;
      const Xpu = Zpu * xr / Math.sqrt(1 + xr * xr);
      const Rpu = Xpu / xr;
      html += `
        <div class="calc-step">
          <div class="calc-step-title">Per-Unit Impedance (Utility Source)</div>
          <div class="calc-formula">
Base MVA = ${base} MVA
Fault Level = ${fmva} MVA
X/R Ratio = ${xr}

Z_pu = Base_MVA / Fault_MVA
Z_pu = ${base} / ${fmva} = ${Zpu.toFixed(6)} p.u.

X_pu = Z_pu × (X/R) / √(1 + (X/R)²)
X_pu = ${Zpu.toFixed(6)} × ${xr} / √(1 + ${xr}²)
X_pu = ${Xpu.toFixed(6)} p.u.

R_pu = X_pu / (X/R)
R_pu = ${Xpu.toFixed(6)} / ${xr}
R_pu = ${Rpu.toFixed(6)} p.u.</div>
        </div>`;
    } else if (comp.type === 'transformer') {
      const rated = comp.props.rated_mva || 10;
      const zPct = comp.props.z_percent || 8;
      const xr = comp.props.x_r_ratio || 10;
      const Zpu = (zPct / 100) * base / rated;
      const Xpu = Zpu * xr / Math.sqrt(1 + xr * xr);
      const Rpu = Xpu / xr;
      html += `
        <div class="calc-step">
          <div class="calc-step-title">Per-Unit Impedance (Transformer)</div>
          <div class="calc-formula">
Base MVA = ${base} MVA
Rated MVA = ${rated} MVA
Z% = ${zPct}%
X/R Ratio = ${xr}

Z_pu = (Z% / 100) × (Base_MVA / Rated_MVA)
Z_pu = (${zPct} / 100) × (${base} / ${rated})
Z_pu = ${Zpu.toFixed(6)} p.u.

X_pu = Z_pu × (X/R) / √(1 + (X/R)²)
X_pu = ${Xpu.toFixed(6)} × ${xr} / √(1 + ${xr}²)
X_pu = ${Xpu.toFixed(6)} p.u.

R_pu = X_pu / (X/R) = ${Rpu.toFixed(6)} p.u.</div>
        </div>`;
    } else if (comp.type === 'cable') {
      const Vkv = comp.props.voltage_kv || 11;
      const Zbase = (Vkv * Vkv) / base;
      const R = comp.props.r_per_km * comp.props.length_km;
      const X = comp.props.x_per_km * comp.props.length_km;
      html += `
        <div class="calc-step">
          <div class="calc-step-title">Per-Unit Impedance (Cable)</div>
          <div class="calc-formula">
Base MVA = ${base} MVA
Voltage = ${Vkv} kV

Z_base = V² / Base_MVA = ${Vkv}² / ${base} = ${Zbase.toFixed(4)} Ω

R_total = ${comp.props.r_per_km} × ${comp.props.length_km} = ${R.toFixed(4)} Ω
X_total = ${comp.props.x_per_km} × ${comp.props.length_km} = ${X.toFixed(4)} Ω

R_pu = R / Z_base = ${R.toFixed(4)} / ${Zbase.toFixed(4)} = ${(R / Zbase).toFixed(6)} p.u.
X_pu = X / Z_base = ${X.toFixed(4)} / ${Zbase.toFixed(4)} = ${(X / Zbase).toFixed(6)} p.u.</div>
        </div>`;
    }

    return html;
  },

  // Clear properties panel
  clear() {
    this.currentId = null;
    document.getElementById('properties-title').textContent = 'Properties';
    this.contentEl.innerHTML = '<div class="no-selection"><p>Select a component to view its properties</p></div>';
    this.calcInfoEl.style.display = 'none';
  },
};
