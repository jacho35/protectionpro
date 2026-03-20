/* ProtectionPro — Properties Panel */

const Properties = {
  contentEl: null,
  calcInfoEl: null,
  currentId: null,
  unitSelections: {}, // track chosen unit per field, e.g. { 'rated_mva': 'kVA' }

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
    this._currentCompType = comp.type;
    document.getElementById('properties-title').textContent = def.name;

    // Dismiss any open info popup when switching components
    this._dismissInfoPopup();

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
      // Conditional visibility: skip fields whose showWhen condition isn't met
      if (field.showWhen) {
        const depVal = comp.props[field.showWhen.field] || '';
        if (field.showWhen.match) {
          // Regex match against dependency value
          if (!field.showWhen.match.test(depVal)) continue;
          // For LV-side grounding, check the LV portion of vector group
          if (field.showWhen.side === 'lv') {
            const vg = depVal.toLowerCase();
            // LV is grounded if the lowercase portion after first uppercase has 'n' (e.g., Dy*n*, Y*yn*, Yz*n*)
            const lvPart = vg.slice(vg.search(/[a-z]/));
            if (!lvPart.includes('n')) continue;
          }
        } else if (field.showWhen.values) {
          if (!field.showWhen.values.includes(depVal)) continue;
        }
      }
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

    // Always show calc info button if component has calculable data
    const hasCalc = ['utility', 'generator', 'transformer', 'cable',
      'motor_induction', 'motor_synchronous', 'bus', 'static_load', 'capacitor_bank'].includes(comp.type);
    this.calcInfoEl.style.display = hasCalc ? '' : 'none';

    // Bind change events
    this.contentEl.querySelectorAll('input, select').forEach(input => {
      input.addEventListener('change', (e) => this.onFieldChange(e, comp));
      if (!input.classList.contains('unit-select')) {
        input.addEventListener('input', (e) => {
          // Live update for text/number fields
          if (e.target.type === 'text' || e.target.type === 'number') {
            this.onFieldChange(e, comp);
          }
        });
      }
    });

    // Bind info button popups
    this.contentEl.querySelectorAll('.prop-info-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const key = btn.dataset.infoKey;
        const text = FIELD_INFO[key];
        if (text) this._showInfoPopup(btn, text);
      });
    });
  },

  // Dismiss any open info popup
  _dismissInfoPopup() {
    const existing = document.querySelector('.prop-info-popup');
    if (existing) existing.remove();
  },

  // Show info popup next to the ⓘ button
  _showInfoPopup(btn, text) {
    this._dismissInfoPopup();
    const popup = document.createElement('div');
    popup.className = 'prop-info-popup';
    popup.innerHTML = `<button class="info-close">&times;</button>${text}`;
    document.body.appendChild(popup);

    // Position relative to button
    const rect = btn.getBoundingClientRect();
    popup.style.top = (rect.bottom + 6) + 'px';
    popup.style.right = (window.innerWidth - rect.right) + 'px';

    // Close on button click or outside click
    popup.querySelector('.info-close').addEventListener('click', () => popup.remove());
    setTimeout(() => {
      const handler = (e) => {
        if (!popup.contains(e.target) && e.target !== btn) {
          popup.remove();
          document.removeEventListener('mousedown', handler);
        }
      };
      document.addEventListener('mousedown', handler);
    }, 0);
  },

  renderField(field, value, compId) {
    let inputHtml = '';
    let unitHtml = '';

    if (field.type === 'standard_select') {
      // Standard type selector (cable, transformer, cb, or fuse library)
      const library = field.library === 'cable' ? STANDARD_CABLES
        : field.library === 'transformer' ? STANDARD_TRANSFORMERS
        : field.library === 'cb' ? STANDARD_CBS
        : field.library === 'fuse' ? STANDARD_FUSES
        : [];
      const options = library.map(item =>
        `<option value="${item.id}" ${value === item.id ? 'selected' : ''}>${item.name}</option>`
      ).join('');
      inputHtml = `<select data-field="${field.key}" data-library="${field.library}">
        <option value="">-- Custom --</option>${options}</select>`;
    } else if (field.type === 'select') {
      const options = field.options.map(opt =>
        `<option value="${opt}" ${value === opt ? 'selected' : ''}>${opt}</option>`
      ).join('');
      inputHtml = `<select data-field="${field.key}">${options}</select>`;
    } else {
      // Number or text input — handle unit conversion for display
      let displayValue = value;
      if (field.unitOptions) {
        let defaultUnit = field.unitOptions[0].label;
        // Use project setting for cable length unit
        if (field.key === 'length_km' && AppState.defaultLengthUnit) {
          defaultUnit = AppState.defaultLengthUnit;
        }
        const selectedUnit = this.unitSelections[field.key] || defaultUnit;
        const unitOpt = field.unitOptions.find(u => u.label === selectedUnit);
        if (unitOpt && unitOpt.mult !== 1) {
          displayValue = value / unitOpt.mult;
        }
        // Round to avoid floating point noise
        if (typeof displayValue === 'number') {
          displayValue = parseFloat(displayValue.toPrecision(10));
        }
      }
      inputHtml = `<input type="${field.type}" data-field="${field.key}" value="${displayValue}" step="any">`;
    }

    // Unit display: selectable dropdown if unitOptions, else static text
    if (field.unitOptions) {
      let defaultUnit = field.unitOptions[0].label;
      if (field.key === 'length_km' && AppState.defaultLengthUnit) defaultUnit = AppState.defaultLengthUnit;
      const selectedUnit = this.unitSelections[field.key] || defaultUnit;
      const opts = field.unitOptions.map(u =>
        `<option value="${u.label}" ${u.label === selectedUnit ? 'selected' : ''}>${u.label}</option>`
      ).join('');
      unitHtml = `<select class="unit-select" data-unit-for="${field.key}">${opts}</select>`;
    } else if (field.unit) {
      unitHtml = `<span class="unit">${field.unit}</span>`;
    }

    // Info button for fields with source documentation
    const infoKey = `${this._currentCompType}.${field.key}`;
    const hasInfo = FIELD_INFO && FIELD_INFO[infoKey];
    const infoHtml = hasInfo ? `<button class="prop-info-btn" data-info-key="${infoKey}" title="Default value info">i</button>` : '';

    return `
      <div class="prop-row">
        <label>${field.label}</label>
        ${inputHtml}
        ${unitHtml}
        ${infoHtml}
      </div>`;
  },

  onFieldChange(e, comp) {
    const field = e.target.dataset.field;
    let value = e.target.value;

    // Unit selector changed — convert display and re-render
    if (e.target.classList.contains('unit-select')) {
      const forField = e.target.dataset.unitFor;
      this.unitSelections[forField] = value;
      this.show(comp.id); // re-render with new unit
      return;
    }

    // Standard type selector — auto-fill fields from library
    if (e.target.dataset.library) {
      comp.props[field] = value;
      if (value) {
        this.applyStandardType(comp, e.target.dataset.library, value);
      }
      AppState.dirty = true;
      AppState.clearResults();
      Canvas.render();
      this.show(comp.id); // re-render to show filled values
      return;
    }

    // Position/rotation are special
    if (field === '__x') {
      comp.x = snapToGrid(parseFloat(value) || 0);
    } else if (field === '__y') {
      comp.y = snapToGrid(parseFloat(value) || 0);
    } else if (field === '__rotation') {
      comp.rotation = parseInt(value) || 0;
    } else {
      // Type coerce numbers, applying unit conversion
      if (e.target.type === 'number') {
        value = parseFloat(value);
        if (isNaN(value)) return;
        // Convert from display unit back to base unit
        const def = COMPONENT_DEFS[comp.type];
        const fieldDef = def.fields.find(f => f.key === field);
        if (fieldDef && fieldDef.unitOptions) {
          let defaultUnit = fieldDef.unitOptions[0].label;
          if (field === 'length_km' && AppState.defaultLengthUnit) defaultUnit = AppState.defaultLengthUnit;
          const selectedUnit = this.unitSelections[field] || defaultUnit;
          const unitOpt = fieldDef.unitOptions.find(u => u.label === selectedUnit);
          if (unitOpt) value = value * unitOpt.mult;
        }
      }
      comp.props[field] = value;
    }

    AppState.dirty = true;
    AppState.clearResults();
    Canvas.render();

    // Update component label if name changed
    if (field === 'name') {
      const label = document.querySelector(`.sld-component[data-id="${comp.id}"] .comp-name-label`);
      if (label) label.textContent = value;
    }

    // When vector group changes, auto-set grounding defaults to match
    if (field === 'vector_group' && comp.type === 'transformer') {
      const vg = value || 'Dyn11';
      const lvPart = vg.replace(/^[A-Z]+/, '');
      const hvIsGrounded = /^(YN|ZN)/i.test(vg.toUpperCase());
      const lvIsGrounded = /^(yn|zn)/.test(lvPart.toLowerCase());
      // Set grounding to solidly_grounded if winding is grounded star,
      // ungrounded if it's delta or ungrounded star
      comp.props.grounding_hv = hvIsGrounded ? 'solidly_grounded' : 'ungrounded';
      comp.props.grounding_lv = lvIsGrounded ? 'solidly_grounded' : 'ungrounded';
    }

    // Re-render properties when fields with conditional dependents change
    if (['vector_group', 'grounding_hv', 'grounding_lv', 'cb_type'].includes(field)) {
      this.show(comp.id);
    }
  },

  // Auto-fill component properties from a standard library entry
  applyStandardType(comp, libraryType, typeId) {
    if (libraryType === 'cable') {
      const cable = STANDARD_CABLES.find(c => c.id === typeId);
      if (cable) {
        comp.props.r_per_km = cable.r_per_km;
        comp.props.x_per_km = cable.x_per_km;
        comp.props.rated_amps = cable.rated_amps;
        comp.props.voltage_kv = cable.voltage_kv;
      }
    } else if (libraryType === 'transformer') {
      const xfmr = STANDARD_TRANSFORMERS.find(t => t.id === typeId);
      if (xfmr) {
        comp.props.rated_mva = xfmr.rated_mva;
        comp.props.voltage_hv_kv = xfmr.voltage_hv_kv;
        comp.props.voltage_lv_kv = xfmr.voltage_lv_kv;
        comp.props.z_percent = xfmr.z_percent;
        comp.props.x_r_ratio = xfmr.x_r_ratio;
        comp.props.vector_group = xfmr.vector_group;
      }
    } else if (libraryType === 'cb') {
      const cb = STANDARD_CBS.find(c => c.id === typeId);
      if (cb) {
        comp.props.cb_type = cb.cb_type;
        comp.props.trip_rating_a = cb.trip_rating_a;
        comp.props.rated_current_a = cb.trip_rating_a;
        comp.props.rated_voltage_kv = cb.rated_voltage_kv;
        comp.props.breaking_capacity_ka = cb.breaking_ka;
        comp.props.thermal_pickup = cb.thermal_pickup;
        comp.props.magnetic_pickup = cb.magnetic_pickup;
        comp.props.long_time_delay = cb.long_time_delay;
        comp.props.short_time_pickup = cb.short_time_pickup || 0;
        comp.props.short_time_delay = cb.short_time_delay || 0;
        comp.props.instantaneous_pickup = cb.instantaneous_pickup || 0;
      }
    } else if (libraryType === 'fuse') {
      const fuse = STANDARD_FUSES.find(f => f.id === typeId);
      if (fuse) {
        comp.props.fuse_type = fuse.fuse_type;
        comp.props.rated_current_a = fuse.rated_current_a;
        comp.props.rated_voltage_kv = fuse.rated_voltage_kv;
        comp.props.breaking_capacity_ka = fuse.breaking_ka;
      }
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

    // Per-unit calculation steps
    html += this.renderCalcSteps(comp);

    // Find the bus this component connects to (for showing results)
    const connectedBusIds = this._getConnectedBusIds(comp.id);

    // --- Fault Results ---
    if (AppState.faultResults && AppState.faultResults.buses) {
      // If component IS a bus, show its own results
      // Otherwise show results for connected bus(es)
      const busIds = comp.type === 'bus' ? [comp.id] : connectedBusIds;

      for (const busId of busIds) {
        const busResult = AppState.faultResults.buses[busId];
        if (!busResult) continue;
        const busComp = AppState.components.get(busId);
        const busName = busComp?.props?.name || busId;
        const vkv = busResult.voltage_kv || 11;
        const iBaseKA = AppState.baseMVA / (Math.sqrt(3) * vkv);
        const cFactor = vkv < 1.0 ? 1.05 : 1.1;
        const zBase = (vkv * vkv) / AppState.baseMVA;

        // Z_eq display
        const hasZeq = busResult.z_eq_mag != null;
        const zeqR = busResult.z_eq_real || 0;
        const zeqX = busResult.z_eq_imag || 0;
        const zeqMag = busResult.z_eq_mag || 0;
        const zeqOhm = zeqMag * zBase;

        html += `
          <div class="calc-step">
            <div class="calc-step-title">Fault Analysis — ${busName} (${vkv} kV)</div>
            <div class="calc-formula">Method: IEC 60909 (Symmetrical)
Base MVA = ${AppState.baseMVA} MVA
Z_base = V²/S = ${vkv}² / ${AppState.baseMVA} = ${zBase.toFixed(4)} Ω
I_base = S_base / (√3 × V_n) = ${AppState.baseMVA} / (√3 × ${vkv}) = ${iBaseKA.toFixed(4)} kA
c-factor = ${cFactor} (${vkv < 1.0 ? 'LV ≤ 1kV' : 'MV/HV > 1kV'})
${hasZeq ? `
─── Equivalent Impedance (Z_eq) ───
Z_eq = ${zeqR.toFixed(6)} + j${zeqX.toFixed(6)} p.u.
|Z_eq| = ${zeqMag.toFixed(6)} p.u. = ${zeqOhm.toFixed(6)} Ω` : ''}

─── Three-Phase Fault (I"k3) ───
I"k3 = c × V_n / (√3 × |Z_eq|)${hasZeq ? ` = ${cFactor} / ${zeqMag.toFixed(6)} × ${iBaseKA.toFixed(4)}` : ''}
I"k3 = ${busResult.ik3?.toFixed(3) || 'N/A'} kA
${busResult.ik3 ? `S"k3 = √3 × ${vkv} × ${busResult.ik3.toFixed(3)} = ${(Math.sqrt(3) * vkv * busResult.ik3).toFixed(2)} MVA` : ''}
${busResult.ik3 ? `i_p (peak) ≈ ${(busResult.ik3 * Math.sqrt(2) * 1.8).toFixed(3)} kA (κ ≈ 1.8)` : ''}
${busResult.ik3 ? `I_b (breaking) ≈ ${busResult.ik3.toFixed(3)} kA` : ''}

─── Zero-Sequence Impedance (Z0) ───
${busResult.z0_mag != null ? `Z0 = ${busResult.z0_real?.toFixed(6)} + j${busResult.z0_imag?.toFixed(6)} p.u.
|Z0| = ${busResult.z0_mag?.toFixed(6)} p.u.
Z0 sources: ${busResult.z0_source_count || 0} path(s)` : `No zero-sequence path found (Z0 → ∞)
(Bus-side winding is delta or ungrounded star, or no
grounded transformer provides a Z0 return path)`}
${(busResult.z0_sources_detail || []).map((d, i) =>
  `  Path ${i + 1}: ${d}`
).join('\n')}
${busResult.z0_mag != null ? `
Z0 model per IEC 60909:
• Z1 = Z2 = Z_eq (positive = negative seq for static equipment)
• Dyn / YNd: far-side Δ provides Z0 circulation → Xfmr is Z0 source
  Z0_xfmr = Z_t(leakage) + 3×Z_n(grounding)
• YNyn: Z0 passes through — walk continues to find grounded source
• Yyn / Dd: no Z0 path (ungrounded star or delta on bus side)` : ''}

─── Single Line-to-Ground Fault (I"k1) ───
I"k1 = 3c × V_n / (√3 × |Z1 + Z2 + Z0|)
${busResult.z0_mag != null && busResult.ik1 != null ? `Z_SLG = Z1 + Z2 + Z0 = 2×Z_eq + Z0
     = 2×${zeqMag.toFixed(6)} + ${busResult.z0_mag?.toFixed(6)}
     = ${(2 * zeqMag + busResult.z0_mag).toFixed(6)} p.u.
I"k1 = 3 × ${cFactor} / ${(2 * zeqMag + busResult.z0_mag).toFixed(6)} × ${iBaseKA.toFixed(4)}` : busResult.ik1 === 0 ? `No Z0 path → I"k1 = 0 (zero-sequence current cannot return)` : ''}
I"k1 = ${busResult.ik1?.toFixed(3) || 'N/A'} kA
${busResult.ik1 ? `S"k1 = √3 × ${vkv} × ${busResult.ik1.toFixed(3)} = ${(Math.sqrt(3) * vkv * busResult.ik1).toFixed(2)} MVA` : ''}

─── Line-to-Line Fault (I"kLL) ───
I"kLL = c × √3 × V_n / (√3 × |Z1 + Z2|)
I"kLL = ${busResult.ikLL?.toFixed(3) || 'N/A'} kA
${busResult.ikLL ? `S"kLL = √3 × ${vkv} × ${busResult.ikLL.toFixed(3)} = ${(Math.sqrt(3) * vkv * busResult.ikLL).toFixed(2)} MVA` : ''}

─── Double Line-to-Ground Fault (I"kLLG) ───
I"kLLG = √3 × c × V_n / (√3 × |Z1 + Z2‖Z0|)
${busResult.z0_mag != null ? `Z2‖Z0 = Z2×Z0 / (Z2+Z0) = Z_eq×Z0 / (Z_eq+Z0)` : `No Z0 path → degenerates to LL fault`}
I"kLLG = ${busResult.ikLLG?.toFixed(3) || 'N/A'} kA
${busResult.ikLLG ? `S"kLLG = √3 × ${vkv} × ${busResult.ikLLG.toFixed(3)} = ${(Math.sqrt(3) * vkv * busResult.ikLLG).toFixed(2)} MVA` : ''}</div>
          </div>`;

        // Branch contributions table
        if (busResult.branches && busResult.branches.length > 0) {
          html += `
          <div class="calc-step">
            <div class="calc-step-title">Branch Fault Current Contributions — ${busName}</div>
            <div class="calc-formula" style="overflow-x:auto">
<table style="border-collapse:collapse;font-size:11px;font-family:var(--font-mono);width:100%">
<tr style="border-bottom:2px solid #666">
  <th style="text-align:left;padding:2px 6px">Element</th>
  <th style="text-align:left;padding:2px 6px">Type</th>
  <th style="text-align:right;padding:2px 6px">If (kA)</th>
  <th style="text-align:right;padding:2px 6px">%</th>
  <th style="text-align:right;padding:2px 6px">|Z_path| (p.u.)</th>
  <th style="text-align:left;padding:2px 6px">Source</th>
</tr>
${busResult.branches.map(br => {
  const elComp = AppState.components.get(br.element_id);
  const elName = elComp?.props?.name || br.element_name || br.element_id;
  const typeLabel = (br.element_type || '').replace('_', ' ');
  return `<tr style="border-bottom:1px solid #ddd">
  <td style="padding:2px 6px">${elName}</td>
  <td style="padding:2px 6px">${typeLabel}</td>
  <td style="text-align:right;padding:2px 6px;font-weight:bold;color:#b71c1c">${br.ik_ka.toFixed(3)}</td>
  <td style="text-align:right;padding:2px 6px">${br.contribution_pct.toFixed(1)}%</td>
  <td style="text-align:right;padding:2px 6px">${br.z_path_mag.toFixed(6)}</td>
  <td style="padding:2px 6px">${br.source_name || '—'}</td>
</tr>`;
}).join('')}
</table></div>
          </div>`;
        }
      }
    }

    // --- Load Flow Results ---
    if (AppState.loadFlowResults) {
      const lf = AppState.loadFlowResults;
      const busIds = comp.type === 'bus' ? [comp.id] : connectedBusIds;

      for (const busId of busIds) {
        const busLF = lf.buses?.[busId];
        if (!busLF) continue;
        const busComp = AppState.components.get(busId);
        const busName = busComp?.props?.name || busId;
        const nomV = busComp?.props?.voltage_kv || 11;
        const sMVA = Math.sqrt(busLF.p_mw ** 2 + busLF.q_mvar ** 2);
        const pf = sMVA > 0 ? Math.abs(busLF.p_mw) / sMVA : 1;
        const iCalc = (sMVA * 1000) / (Math.sqrt(3) * nomV);

        html += `
          <div class="calc-step">
            <div class="calc-step-title">Load Flow — ${busName}</div>
            <div class="calc-formula">Method: ${lf.method === 'newton_raphson' ? 'Newton-Raphson' : 'Gauss-Seidel'}
Converged: ${lf.converged ? 'Yes' : 'NO — results may be inaccurate'}
Iterations: ${lf.iterations}

─── Bus Voltage ───
|V| = ${busLF.voltage_pu?.toFixed(6)} p.u.
V   = ${busLF.voltage_kv?.toFixed(4)} kV  (nominal ${nomV} kV)
δ   = ${busLF.angle_deg?.toFixed(4)}°
${Math.abs(busLF.voltage_pu - 1.0) > 0.05 ? `⚠ Voltage deviation: ${((busLF.voltage_pu - 1.0) * 100).toFixed(2)}% from nominal` : ''}

─── Power ───
P = ${busLF.p_mw?.toFixed(4)} MW  (${(busLF.p_mw * 1000).toFixed(1)} kW)  [${busLF.p_mw >= 0 ? 'generation' : 'consumption'}]
Q = ${busLF.q_mvar?.toFixed(4)} MVAr  (${(busLF.q_mvar * 1000).toFixed(1)} kVAr)  [${busLF.q_mvar >= 0 ? 'capacitive/gen' : 'inductive/load'}]
S = ${sMVA.toFixed(4)} MVA  (${(sMVA * 1000).toFixed(1)} kVA)
PF = ${pf.toFixed(4)}
I = S / (√3 × V) = ${iCalc.toFixed(2)} A</div>
          </div>`;
      }

      // Branch flow for this component (if it's a branch element)
      if (['transformer', 'cable', 'cb', 'switch', 'fuse'].includes(comp.type) && lf.branches) {
        for (const br of lf.branches) {
          if (br.elementId !== comp.id) continue;
          const fromBus = AppState.components.get(br.from_bus);
          const toBus = AppState.components.get(br.to_bus);
          const sMVA = br.s_mva || Math.sqrt(br.p_mw ** 2 + br.q_mvar ** 2);

          html += `
            <div class="calc-step">
              <div class="calc-step-title">Branch Power Flow — ${comp.props.name}</div>
              <div class="calc-formula">From: ${fromBus?.props?.name || br.from_bus}
To:   ${toBus?.props?.name || br.to_bus}

P = ${br.p_mw?.toFixed(4)} MW  (${(br.p_mw * 1000).toFixed(1)} kW)  ${br.p_mw >= 0 ? '→' : '←'}
Q = ${br.q_mvar?.toFixed(4)} MVAr  (${(br.q_mvar * 1000).toFixed(1)} kVAr)
S = ${sMVA.toFixed(4)} MVA  (${(sMVA * 1000).toFixed(1)} kVA)
I = ${br.i_amps?.toFixed(1) || '—'} A
${br.loading_pct > 0 ? `Loading = ${br.loading_pct.toFixed(1)}%${br.loading_pct > 100 ? '  ⚠ OVERLOADED' : br.loading_pct > 80 ? '  ⚠ Heavy loading' : ''}` : ''}
${br.losses_mw ? `Losses = ${(br.losses_mw * 1000).toFixed(2)} kW` : ''}</div>
            </div>`;
        }
      }
    }

    if (!html) {
      html = '<p>No calculation data available for this component. Run Fault Analysis or Load Flow to see results.</p>';
    }

    document.getElementById('calc-modal-title').textContent =
      `Calculations — ${comp.props.name || comp.type}`;
    document.getElementById('calc-modal-body').innerHTML = html;
    document.getElementById('calc-modal').style.display = '';
  },

  // Find bus IDs connected to a component via wires
  _getConnectedBusIds(compId) {
    const busIds = [];
    for (const wire of AppState.wires.values()) {
      let otherId = null;
      if (wire.fromComponent === compId) otherId = wire.toComponent;
      if (wire.toComponent === compId) otherId = wire.fromComponent;
      if (otherId) {
        const other = AppState.components.get(otherId);
        if (other && other.type === 'bus') busIds.push(other.id);
      }
    }
    return busIds;
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
      const vkv = comp.props.voltage_kv || 33;
      const Zpu = base / fmva;
      const Xpu = Zpu * xr / Math.sqrt(1 + xr * xr);
      const Rpu = Xpu / xr;
      const Zbase = (vkv * vkv) / base;
      const Rohm = Rpu * Zbase;
      const Xohm = Xpu * Zbase;
      html += `
        <div class="calc-step">
          <div class="calc-step-title">Per-Unit Impedance (Utility Source)</div>
          <div class="calc-formula">Base MVA = ${base} MVA
Fault Level = ${fmva} MVA
X/R Ratio = ${xr}
Voltage = ${vkv} kV

Z_pu = Base_MVA / Fault_MVA
Z_pu = ${base} / ${fmva} = ${Zpu.toFixed(6)} p.u.

X_pu = Z_pu × (X/R) / √(1 + (X/R)²)
X_pu = ${Zpu.toFixed(6)} × ${xr} / √(1 + ${xr}²) = ${Xpu.toFixed(6)} p.u.

R_pu = X_pu / (X/R)
R_pu = ${Xpu.toFixed(6)} / ${xr} = ${Rpu.toFixed(6)} p.u.

─── Actual Impedance ───
Z_base = V² / S_base = ${vkv}² / ${base} = ${Zbase.toFixed(4)} Ω
R = ${Rohm.toFixed(4)} Ω,  X = ${Xohm.toFixed(4)} Ω</div>
        </div>`;

    } else if (comp.type === 'generator') {
      const rated = comp.props.rated_mva || 10;
      const vkv = comp.props.voltage_kv || 11;
      const xdpp = comp.props.xd_pp || 0.15;
      const xdp = comp.props.xd_p || 0.25;
      const xd = comp.props.xd || 1.2;
      const xr = comp.props.x_r_ratio || 40;
      const Xpu = xdpp * base / rated;
      const Rpu = Xpu / xr;
      const Zbase = (vkv * vkv) / base;
      const iRated = (rated * 1000) / (Math.sqrt(3) * vkv);
      html += `
        <div class="calc-step">
          <div class="calc-step-title">Per-Unit Impedance (Generator)</div>
          <div class="calc-formula">Base MVA = ${base} MVA
Rated = ${rated} MVA at ${vkv} kV
I_rated = S / (√3 × V) = ${iRated.toFixed(2)} A

─── Reactances (on machine base) ───
X"d (sub-transient) = ${xdpp} p.u.
X'd (transient)     = ${xdp} p.u.
Xd  (synchronous)   = ${xd} p.u.

─── On System Base (${base} MVA) ───
X"d_pu = X"d × (Base_MVA / Rated_MVA)
X"d_pu = ${xdpp} × (${base} / ${rated}) = ${Xpu.toFixed(6)} p.u.

R_pu = X"d_pu / (X/R) = ${Xpu.toFixed(6)} / ${xr} = ${Rpu.toFixed(6)} p.u.

─── Actual Impedance ───
Z_base = ${vkv}² / ${base} = ${Zbase.toFixed(4)} Ω
X"d = ${(Xpu * Zbase).toFixed(4)} Ω</div>
        </div>`;

    } else if (comp.type === 'transformer') {
      const rated = comp.props.rated_mva || 10;
      const hvkv = comp.props.voltage_hv_kv || 33;
      const lvkv = comp.props.voltage_lv_kv || 11;
      const zPct = comp.props.z_percent || 8;
      const xr = comp.props.x_r_ratio || 10;
      const tap = comp.props.tap_percent || 0;
      const Zpu = (zPct / 100) * base / rated;
      const Xpu = Zpu * xr / Math.sqrt(1 + xr * xr);
      const Rpu = Xpu / xr;
      const ZbaseHV = (hvkv * hvkv) / base;
      const ZbaseLV = (lvkv * lvkv) / base;
      const iHV = (rated * 1000) / (Math.sqrt(3) * hvkv);
      const iLV = (rated * 1000) / (Math.sqrt(3) * lvkv);
      html += `
        <div class="calc-step">
          <div class="calc-step-title">Per-Unit Impedance (Transformer)</div>
          <div class="calc-formula">Base MVA = ${base} MVA
Rated = ${rated} MVA
Configuration: ${comp.props.winding_config === 'step_up' ? 'Step Up' : 'Step Down'}
${comp.props.winding_config === 'step_up' ? `LV: ${lvkv} kV  →  HV: ${hvkv} kV  (Primary=LV, Secondary=HV)` : `HV: ${hvkv} kV  →  LV: ${lvkv} kV  (Primary=HV, Secondary=LV)`}
Vector Group: ${comp.props.vector_group || 'Dyn11'}
Tap: ${tap}%

I_HV = ${iHV.toFixed(2)} A,  I_LV = ${iLV.toFixed(2)} A
Turns ratio = ${hvkv} / ${lvkv} = ${(hvkv / lvkv).toFixed(4)}

Z_pu = (Z% / 100) × (Base_MVA / Rated_MVA)
Z_pu = (${zPct} / 100) × (${base} / ${rated}) = ${Zpu.toFixed(6)} p.u.

X_pu = Z_pu × (X/R) / √(1 + (X/R)²)
X_pu = ${Xpu.toFixed(6)} p.u.

R_pu = X_pu / (X/R) = ${Rpu.toFixed(6)} p.u.

─── Referred to HV side ───
Z_base(HV) = ${hvkv}² / ${base} = ${ZbaseHV.toFixed(4)} Ω
R = ${(Rpu * ZbaseHV).toFixed(4)} Ω,  X = ${(Xpu * ZbaseHV).toFixed(4)} Ω

─── Referred to LV side ───
Z_base(LV) = ${lvkv}² / ${base} = ${ZbaseLV.toFixed(4)} Ω
R = ${(Rpu * ZbaseLV).toFixed(4)} Ω,  X = ${(Xpu * ZbaseLV).toFixed(4)} Ω</div>
        </div>`;

    } else if (comp.type === 'cable') {
      const Vkv = comp.props.voltage_kv || 11;
      const len = comp.props.length_km || 1;
      const rpk = comp.props.r_per_km || 0;
      const xpk = comp.props.x_per_km || 0;
      const Zbase = (Vkv * Vkv) / base;
      const R = rpk * len;
      const X = xpk * len;
      const Rpu = R / Zbase;
      const Xpu = X / Zbase;
      const Zpu = Math.sqrt(Rpu * Rpu + Xpu * Xpu);
      const rated = comp.props.rated_amps || 400;
      const ratedMVA = Math.sqrt(3) * Vkv * rated / 1000;
      html += `
        <div class="calc-step">
          <div class="calc-step-title">Per-Unit Impedance (Cable)</div>
          <div class="calc-formula">Base MVA = ${base} MVA
Voltage = ${Vkv} kV
Length = ${len} km
R = ${rpk} Ω/km,  X = ${xpk} Ω/km
Rated current = ${rated} A  (S_rated = ${ratedMVA.toFixed(3)} MVA)

Z_base = V² / Base_MVA = ${Vkv}² / ${base} = ${Zbase.toFixed(4)} Ω

R_total = ${rpk} × ${len} = ${R.toFixed(4)} Ω
X_total = ${xpk} × ${len} = ${X.toFixed(4)} Ω
Z_total = √(R² + X²) = ${Math.sqrt(R * R + X * X).toFixed(4)} Ω

R_pu = ${R.toFixed(4)} / ${Zbase.toFixed(4)} = ${Rpu.toFixed(6)} p.u.
X_pu = ${X.toFixed(4)} / ${Zbase.toFixed(4)} = ${Xpu.toFixed(6)} p.u.
Z_pu = ${Zpu.toFixed(6)} p.u.

Voltage drop (at rated) ≈ ${(Rpu * rated / (ratedMVA * 1000 / (Math.sqrt(3) * Vkv)) * 100).toFixed(2)}% (R only)</div>
        </div>`;

    } else if (comp.type === 'motor_induction') {
      const kw = comp.props.rated_kw || 200;
      const vkv = comp.props.voltage_kv || 0.4;
      const eff = comp.props.efficiency || 0.93;
      const pf = comp.props.power_factor || 0.85;
      const xpp = comp.props.x_pp || 0.17;
      const lrc = comp.props.locked_rotor_current || 6;
      const kva = kw / eff;
      const mva = kva / 1000;
      const Xpu = xpp * base / mva;
      const iRated = (kva) / (Math.sqrt(3) * vkv * 1000);
      const iStart = iRated * lrc;
      html += `
        <div class="calc-step">
          <div class="calc-step-title">Per-Unit Impedance (Induction Motor)</div>
          <div class="calc-formula">Base MVA = ${base} MVA
Rated = ${kw} kW at ${vkv} kV
Efficiency = ${(eff * 100).toFixed(1)}%
Power Factor = ${pf}

Input kVA = P / η = ${kw} / ${eff} = ${kva.toFixed(1)} kVA (${mva.toFixed(4)} MVA)
I_rated = ${(iRated * 1000).toFixed(2)} A
I_start = ${lrc} × I_rated = ${(iStart * 1000).toFixed(2)} A

X"_pu (on system base) = X" × (Base_MVA / Rated_MVA)
X"_pu = ${xpp} × (${base} / ${mva.toFixed(4)}) = ${Xpu.toFixed(4)} p.u.

─── Power Consumption ───
P = ${(mva * pf).toFixed(4)} MW
Q = ${(mva * Math.sqrt(1 - pf * pf)).toFixed(4)} MVAr</div>
        </div>`;

    } else if (comp.type === 'motor_synchronous') {
      const kva = comp.props.rated_kva || 500;
      const vkv = comp.props.voltage_kv || 3.3;
      const pf = comp.props.power_factor || 0.9;
      const xdpp = comp.props.xd_pp || 0.15;
      const mva = kva / 1000;
      const Xpu = xdpp * base / mva;
      const iRated = kva / (Math.sqrt(3) * vkv * 1000);
      html += `
        <div class="calc-step">
          <div class="calc-step-title">Per-Unit Impedance (Synchronous Motor)</div>
          <div class="calc-formula">Base MVA = ${base} MVA
Rated = ${kva} kVA at ${vkv} kV
Power Factor = ${pf}
I_rated = ${(iRated * 1000).toFixed(2)} A

X"d_pu (on system base) = X"d × (Base_MVA / Rated_MVA)
X"d_pu = ${xdpp} × (${base} / ${mva.toFixed(4)}) = ${Xpu.toFixed(4)} p.u.

─── Power Consumption ───
P = ${(mva * pf).toFixed(4)} MW
Q = ${(mva * Math.sqrt(1 - pf * pf)).toFixed(4)} MVAr</div>
        </div>`;

    } else if (comp.type === 'static_load') {
      const kva = comp.props.rated_kva || 100;
      const vkv = comp.props.voltage_kv || 0.4;
      const pf = comp.props.power_factor || 0.85;
      const mva = kva / 1000;
      const iRated = kva / (Math.sqrt(3) * vkv * 1000);
      html += `
        <div class="calc-step">
          <div class="calc-step-title">Load Summary (Static Load)</div>
          <div class="calc-formula">Rated = ${kva} kVA at ${vkv} kV
Power Factor = ${pf}
Load Type = ${comp.props.load_type || 'constant_power'}

I_rated = S / (√3 × V) = ${(iRated * 1000).toFixed(2)} A

P = S × PF = ${(mva * pf).toFixed(4)} MW (${(mva * pf * 1000).toFixed(1)} kW)
Q = S × sin(φ) = ${(mva * Math.sqrt(1 - pf * pf)).toFixed(4)} MVAr

P_pu = ${(mva * pf / base).toFixed(6)} p.u.
Q_pu = ${(mva * Math.sqrt(1 - pf * pf) / base).toFixed(6)} p.u.</div>
        </div>`;

    } else if (comp.type === 'capacitor_bank') {
      const kvar = comp.props.rated_kvar || 100;
      const vkv = comp.props.voltage_kv || 11;
      const mvar = kvar / 1000;
      const iRated = kvar / (Math.sqrt(3) * vkv * 1000);
      html += `
        <div class="calc-step">
          <div class="calc-step-title">Capacitor Bank Data</div>
          <div class="calc-formula">Rated = ${kvar} kVAr at ${vkv} kV
Steps = ${comp.props.steps || 1}

I = Q / (√3 × V) = ${(iRated * 1000).toFixed(2)} A
Q_pu = ${(mvar / base).toFixed(6)} p.u. (injected)</div>
        </div>`;

    } else if (comp.type === 'bus') {
      const vkv = comp.props.voltage_kv || 11;
      const Zbase = (vkv * vkv) / base;
      const Ibase = (base * 1000) / (Math.sqrt(3) * vkv);
      html += `
        <div class="calc-step">
          <div class="calc-step-title">Bus Base Values</div>
          <div class="calc-formula">Bus Type: ${comp.props.bus_type || 'PQ'}
Voltage = ${vkv} kV
Base MVA = ${base} MVA

Z_base = V² / S_base = ${vkv}² / ${base} = ${Zbase.toFixed(4)} Ω
I_base = S_base / (√3 × V) = ${base * 1000} / (√3 × ${vkv}) = ${Ibase.toFixed(2)} A</div>
        </div>`;
    }

    return html;
  },

  // Clear properties panel
  clear() {
    this.currentId = null;
    this._dismissInfoPopup();
    document.getElementById('properties-title').textContent = 'Properties';
    this.contentEl.innerHTML = '<div class="no-selection"><p>Select a component to view its properties</p></div>';
    this.calcInfoEl.style.display = 'none';
  },
};
