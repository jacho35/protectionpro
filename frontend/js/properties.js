/* ProtectionPro — Properties Panel */

const SECTION_ORDER = ['General', 'pv', 'battery', 'fault', 'loadflow', 'dynamic', 'arcflash', 'grounding', 'cable_sizing', 'protection'];
const SECTION_LABELS = {
  General: 'General',
  fault: 'Fault Analysis',
  dynamic: 'Motor Starting (Dynamic)',
  loadflow: 'Load Flow',
  arcflash: 'Arc Flash',
  grounding: 'Grounding',
  cable_sizing: 'Cable Sizing',
  protection: 'Protection Settings',
  battery: 'Battery Storage',
  pv: 'PV Array / DC Strings',
};

const Properties = {
  contentEl: null,
  calcInfoEl: null,
  currentId: null,
  unitSelections: {}, // track chosen unit per field, e.g. { 'rated_mva': 'kVA' }
  collapsedSections: {}, // track collapsed state per section key
  _liveTimers: {}, // debounce timers per field for live (per-keystroke) input

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
          <div class="comp-name">${escHtml(comp.props.name || def.name)}</div>
          <div class="comp-type">${def.name} — ID: ${comp.id}</div>
        </div>
      </div>`;

    // UX-5: surface plan↔SLD linkage in the properties panel (the canvas also
    // shows a 🔗 badge). Boards/switchboard sections carry planLink; cables
    // reflected from plan feeders carry swLink.
    if (comp.planLink || comp.swLink) {
      html += `<div class="prop-linked-note">🔗 Linked to the distribution plan</div>`;
    }

    // Build editable fields grouped by section
    // 1. Filter visible fields
    const visibleFields = def.fields.filter(field => {
      if (!field.showWhen) return true;
      const depVal = comp.props[field.showWhen.field] ?? '';
      if (field.showWhen.match) {
        if (!field.showWhen.match.test(depVal)) return false;
        if (field.showWhen.side === 'lv') {
          const vg = depVal.toLowerCase();
          const lvPart = vg.slice(vg.search(/[a-z]/));
          if (!lvPart.includes('n')) return false;
        }
      } else if (field.showWhen.values) {
        if (!field.showWhen.values.includes(depVal)) return false;
      }
      return true;
    });

    // 2. Group by section
    const sectionGroups = {};
    for (const field of visibleFields) {
      const sec = field.section || 'General';
      if (!sectionGroups[sec]) sectionGroups[sec] = [];
      sectionGroups[sec].push(field);
    }

    // 3. Determine if we have multiple sections (skip collapsible UI for simple components)
    const sectionKeys = SECTION_ORDER.filter(s => sectionGroups[s] && sectionGroups[s].length > 0);
    const hasMultipleSections = sectionKeys.length > 1;

    // 4. Render each section
    for (const secKey of sectionKeys) {
      const fields = sectionGroups[secKey];
      const label = SECTION_LABELS[secKey] || secKey;
      const isGeneral = secKey === 'General';
      const isCollapsible = hasMultipleSections && !isGeneral;
      // Default: non-General sections start expanded unless user has collapsed them
      const isCollapsed = isCollapsible && (this.collapsedSections[secKey] !== undefined ? this.collapsedSections[secKey] : false);

      if (isCollapsible) {
        html += `<div class="prop-section">`;
        html += `<div class="prop-section-header${isCollapsed ? ' collapsed' : ''}" data-section="${secKey}">`;
        html += `<span class="chevron">\u25B8</span>`;
        html += `<span>${label}</span>`;
        html += `</div>`;
        html += `<div class="prop-section-body${isCollapsed ? ' collapsed' : ''}">`;
      } else {
        html += `<div class="prop-section">`;
        if (hasMultipleSections) {
          html += `<div class="prop-section-title">${label}</div>`;
        } else {
          html += `<div class="prop-section-title">Parameters</div>`;
        }
      }

      for (const field of fields) {
        const val = comp.props[field.key] ?? '';
        html += this.renderField(field, val, comp.id);
      }

      if (isCollapsible) {
        html += '</div>'; // close prop-section-body
      }
      html += '</div>'; // close prop-section
    }

    // TCC Grading button for protection devices
    if (['cb', 'fuse', 'relay'].includes(comp.type)) {
      html += `
        <div class="prop-section prop-tcc-section">
          <button class="prop-action-btn" id="btn-view-tcc" title="Open TCC chart showing this device and upstream protection for grading">
            <svg width="14" height="14" viewBox="0 0 14 14" style="vertical-align:-2px;margin-right:4px"><path d="M1 13V1h1v10.5L5 5l3 4 3-7.5V13H1z" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>
            View TCC Grading
          </button>
        </div>`;
    }

    // Circuit schedule editor for distribution boards
    if (comp.type === 'distribution_board') {
      html += `
        <div class="prop-section prop-tcc-section">
          <button class="prop-action-btn" id="btn-edit-db" title="Edit the board's circuit schedule (ways, breakers, phases, loads)">
            <svg width="14" height="14" viewBox="0 0 14 14" style="vertical-align:-2px;margin-right:4px"><rect x="1.5" y="1.5" width="11" height="11" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><line x1="1.5" y1="5" x2="12.5" y2="5" stroke="currentColor" stroke-width="1.3"/><line x1="1.5" y1="8" x2="12.5" y2="8" stroke="currentColor" stroke-width="1.3"/><line x1="1.5" y1="11" x2="12.5" y2="11" stroke="currentColor" stroke-width="1.3"/></svg>
            Edit Circuit Schedule
          </button>
        </div>`;
    }

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

    // Computed values section (per-unit impedances; rated current for loads)
    const puValues = this.computePerUnit(comp);
    if (puValues) {
      const puTitle = ['static_load', 'solar_pv', 'wind_turbine', 'generator', 'distribution_board'].includes(comp.type)
        ? 'Calculated Values'
        : `Per-Unit Values (Base: ${AppState.baseMVA} MVA)`;
      html += `
        <div class="prop-section">
          <div class="prop-section-title">${puTitle}</div>
          ${puValues}
        </div>`;
    }

    this.contentEl.innerHTML = html;

    // Always show calc info button if component has calculable data
    const hasCalc = ['utility', 'generator', 'transformer', 'cable',
      'motor_induction', 'motor_synchronous', 'bus', 'static_load', 'capacitor_bank'].includes(comp.type);
    this.calcInfoEl.style.display = hasCalc ? '' : 'none';

    // Bind TCC Grading button
    const btnTcc = this.contentEl.querySelector('#btn-view-tcc');
    if (btnTcc) {
      btnTcc.addEventListener('click', () => TCC.openForDevice(comp.id));
    }

    const btnDb = this.contentEl.querySelector('#btn-edit-db');
    if (btnDb && typeof DBSchedule !== 'undefined') {
      btnDb.addEventListener('click', () => DBSchedule.open(comp.id));
    }

    // Bind change events.
    // Live (per-keystroke) input applies the value to state/canvas debounced
    // (~400 ms) without committing; 'change' (blur/Enter/select) commits the
    // edit once: clears stale results and records a single undo step.
    this.contentEl.querySelectorAll('input, select').forEach(input => {
      input.addEventListener('change', (e) => {
        const f = e.target.dataset.field;
        if (f && this._liveTimers[f]) {
          clearTimeout(this._liveTimers[f]);
          delete this._liveTimers[f];
        }
        this.onFieldChange(e, comp);
      });
      if (!input.classList.contains('unit-select')) {
        input.addEventListener('input', (e) => {
          // Live update for text/number fields (debounced, non-committing)
          if (e.target.type === 'text' || e.target.type === 'number') {
            const f = e.target.dataset.field || '';
            if (this._liveTimers[f]) clearTimeout(this._liveTimers[f]);
            this._liveTimers[f] = setTimeout(() => {
              delete this._liveTimers[f];
              this.onFieldChange(e, comp, false);
            }, 400);
          }
        });
      }
    });

    // Initialize searchable select widgets (cable dropdown)
    this._initSearchableSelects(comp);

    // Bind info button popups
    this.contentEl.querySelectorAll('.prop-info-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const key = btn.dataset.infoKey;
        const text = FIELD_INFO[key];
        if (text) this._showInfoPopup(btn, text);
      });
    });

    // Bind cable impedance reset buttons
    this.contentEl.querySelectorAll('.prop-reset-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const fieldKey = btn.dataset.resetField;
        const resetValue = parseFloat(btn.dataset.resetValue);
        const comp = AppState.components.get(this.currentId);
        if (comp && !isNaN(resetValue)) {
          comp.props[fieldKey] = resetValue;
          AppState.dirty = true;
          this._notifyResultsCleared();
          AppState.clearResults();
          if (typeof UndoManager !== 'undefined') UndoManager.snapshot();
          Canvas.render();
          this.show(comp.id);
        }
      });
    });

    // Bind collapsible section headers
    this.contentEl.querySelectorAll('.prop-section-header').forEach(header => {
      header.addEventListener('click', () => {
        const secKey = header.dataset.section;
        const isNowCollapsed = !header.classList.contains('collapsed');
        this.collapsedSections[secKey] = isNowCollapsed;
        header.classList.toggle('collapsed', isNowCollapsed);
        const body = header.nextElementSibling;
        if (body) body.classList.toggle('collapsed', isNowCollapsed);
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

  // Fields each device library fills in from its standard selection. While a
  // standard is chosen these are locked (read-only) — pick "-- Custom --" to
  // edit them. Cable is intentionally excluded: it keeps its own
  // edit-freely-and-reset-to-default UX.
  _libraryControlledFields: {
    cb: ['cb_type', 'mcb_curve', 'trip_rating_a', 'rated_current_a', 'rated_voltage_kv',
         'breaking_capacity_ka', 'thermal_pickup', 'magnetic_pickup', 'long_time_delay',
         'short_time_pickup', 'short_time_delay', 'instantaneous_pickup'],
    transformer: ['rated_mva', 'voltage_hv_kv', 'voltage_lv_kv', 'z_percent', 'x_r_ratio', 'vector_group'],
    fuse: ['fuse_type', 'rated_current_a', 'rated_voltage_kv', 'breaking_capacity_ka'],
  },

  // A field is locked when its component has a standard type selected and the
  // field is one the standard populates (the component type doubles as the
  // library key for cb/transformer/fuse). The `state` field and anything not
  // library-derived stay editable.
  _lockedByStandard(comp, fieldKey) {
    if (!comp) return false;
    const fields = this._libraryControlledFields[comp.type];
    return !!(fields && fields.includes(fieldKey) && comp.props.standard_type);
  },

  renderField(field, value, compId) {
    let inputHtml = '';
    let unitHtml = '';

    // Lock library-derived fields while a standard type is selected.
    const _comp = AppState.components.get(compId);
    const dis = this._lockedByStandard(_comp, field.key) ? ' disabled' : '';
    const lockTitle = dis ? ' title="Set by the selected standard — choose Custom to edit"' : '';

    if (field.type === 'standard_select' && field.library === 'cable') {
      // Searchable cable selector with voltage filtering
      const voltageFilter = this._getCableVoltageFilter(compId);
      const filtered = voltageFilter ? STANDARD_CABLES.filter(voltageFilter.fn) : STANDARD_CABLES;
      const selectedCable = STANDARD_CABLES.find(c => c.id === value);
      const displayText = value ? (selectedCable ? selectedCable.name : value) : '';
      const hintHtml = voltageFilter ? `<div class="searchable-select-hint">Showing ${voltageFilter.label} cables</div>` : '';

      // Build option divs
      let optionsHtml = `<div class="searchable-select-option" data-value="">-- Custom --</div>`;
      // If selected cable is outside filter, include it as mismatch
      const filteredIds = new Set(filtered.map(c => c.id));
      if (value && selectedCable && !filteredIds.has(value)) {
        optionsHtml += `<div class="searchable-select-option mismatch selected" data-value="${escHtml(selectedCable.id)}">${escHtml(selectedCable.name)} (voltage mismatch)</div>`;
      }
      for (const cable of filtered) {
        const sel = cable.id === value ? ' selected' : '';
        optionsHtml += `<div class="searchable-select-option${sel}" data-value="${escHtml(cable.id)}">${escHtml(cable.name)}</div>`;
      }

      inputHtml = `<div class="searchable-select" data-field="${field.key}" data-library="${field.library}" data-value="${escHtml(value || '')}">
        <input type="text" class="searchable-select-input" placeholder="Search cables..." value="${escHtml(displayText)}" autocomplete="off">
        <div class="searchable-select-dropdown">${hintHtml}${optionsHtml}</div>
      </div>`;
    } else if (field.type === 'standard_select') {
      // Standard type selector (transformer, cb, or fuse library)
      const library = field.library === 'transformer' ? STANDARD_TRANSFORMERS
        : field.library === 'cb' ? STANDARD_CBS
        : field.library === 'fuse' ? STANDARD_FUSES
        : field.library === 'pv_panel' ? PV_PANELS
        : [];
      const options = library.map(item =>
        `<option value="${escHtml(item.id)}" ${value === item.id ? 'selected' : ''}>${escHtml(item.name)}</option>`
      ).join('');
      inputHtml = `<select data-field="${field.key}" data-library="${field.library}">
        <option value="">-- Custom --</option>${options}</select>`;
    } else if (field.type === 'component_select') {
      // Dynamic dropdown listing components of a specific type
      const filterType = field.filter || '';
      const options = [];
      options.push(`<option value="" ${!value ? 'selected' : ''}>-- None --</option>`);
      for (const [id, comp] of AppState.components) {
        if (filterType && comp.type !== filterType) continue;
        const name = comp.props?.name || `${comp.type} ${id}`;
        options.push(`<option value="${id}" ${value === id ? 'selected' : ''}>${escHtml(name)}</option>`);
      }
      inputHtml = `<select data-field="${field.key}">${options.join('')}</select>`;
    } else if (field.type === 'select') {
      const options = field.options.map(opt => {
        const val = typeof opt === 'object' ? opt.value : opt;
        const label = typeof opt === 'object' ? opt.label : opt;
        // Compare via String(): the backend coerces numeric-looking string
        // props to numbers on save, so a strict === would fail to re-select
        // (e.g. stored 12 vs option '12') and silently show the first option.
        return `<option value="${val}" ${String(value) === String(val) ? 'selected' : ''}>${label}</option>`;
      }).join('');
      inputHtml = `<select data-field="${field.key}"${dis}${lockTitle}>${options}</select>`;
    } else {
      // Number or text input — handle unit conversion for display
      let displayValue = value;
      let displayMult = 1;
      if (field.unitOptions) {
        let defaultUnit = field.unitOptions[0].label;
        // Use project setting for cable length unit
        if (field.key === 'length_km' && AppState.defaultLengthUnit) {
          defaultUnit = AppState.defaultLengthUnit;
        }
        const selectedUnit = this.unitSelections[field.key] || defaultUnit;
        const unitOpt = field.unitOptions.find(u => u.label === selectedUnit);
        if (unitOpt) displayMult = unitOpt.mult;
        if (displayMult !== 1) {
          displayValue = value / displayMult;
        }
        // Round to avoid floating point noise
        if (typeof displayValue === 'number') {
          displayValue = parseFloat(displayValue.toPrecision(10));
        }
      }
      // Emit declared min/max/step constraints (defined in base units —
      // convert to the selected display unit so the browser enforces them)
      let constraints = '';
      if (field.type === 'number') {
        if (field.min !== undefined) constraints += ` min="${field.min / displayMult}"`;
        if (field.max !== undefined) constraints += ` max="${field.max / displayMult}"`;
        constraints += ` step="${field.step !== undefined ? field.step / displayMult : 'any'}"`;
      }
      inputHtml = `<input type="${field.type}" data-field="${field.key}" value="${escHtml(displayValue)}"${constraints}${dis}${lockTitle}>`;
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

    // Check if this cable impedance field has been modified from its standard library default
    const cableImpedanceFields = ['r_per_km', 'x_per_km', 'r0_per_km', 'x0_per_km', 'rated_amps', 'voltage_kv'];
    let modifiedClass = '';
    let resetHtml = '';
    if (this._currentCompType === 'cable' && cableImpedanceFields.includes(field.key)) {
      const comp = AppState.components.get(this.currentId);
      if (comp && comp.props.standard_type) {
        const stdCable = STANDARD_CABLES.find(c => c.id === comp.props.standard_type);
        if (stdCable && stdCable[field.key] !== undefined) {
          const currentVal = parseFloat(value);
          const defaultVal = parseFloat(stdCable[field.key]);
          if (!isNaN(currentVal) && !isNaN(defaultVal) && Math.abs(currentVal - defaultVal) > 1e-9) {
            modifiedClass = ' prop-row--modified';
            resetHtml = `<button class="prop-reset-btn" data-reset-field="${field.key}" data-reset-value="${defaultVal}" title="Reset to ${escHtml(stdCable.name)} default (${defaultVal})">&#x21A9;</button>`;
          }
        }
      }
    }

    // CB pickup settings: show the resulting trip current in brackets
    // (TCC convention: Ir = In × thermal, Im = Ir × magnetic)
    let labelText = field.label;
    if (['thermal_pickup', 'magnetic_pickup'].includes(field.key) && this.currentId) {
      const comp = AppState.components.get(this.currentId);
      if (comp && comp.type === 'cb') {
        const inA = comp.props.trip_rating_a || 630;
        const ir = inA * (comp.props.thermal_pickup || 1.0);
        const amps = field.key === 'thermal_pickup' ? ir : ir * (comp.props.magnetic_pickup || 10);
        const ampStr = amps >= 1000 ? `${(amps / 1000).toFixed(2)} kA` : `${amps.toFixed(0)} A`;
        labelText += ` (${ampStr})`;
      }
    }

    return `
      <div class="prop-row${modifiedClass}">
        <label>${labelText}</label>
        ${inputHtml}
        ${unitHtml}
        ${infoHtml}
        ${resetHtml}
      </div>`;
  },

  // commit=false: live (debounced) keystroke update — applies the value to
  // state/canvas only. commit=true: completed edit — also clears results and
  // takes a single undo snapshot.
  onFieldChange(e, comp, commit = true) {
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
      this._notifyResultsCleared();
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
        if (isNaN(value)) {
          // Invalid text — flag the input and keep the previous value
          e.target.classList.add('input-invalid');
          e.target.style.borderColor = '#d32f2f';
          return;
        }
        e.target.classList.remove('input-invalid');
        e.target.style.borderColor = '';
        // Convert from display unit back to base unit
        const def = COMPONENT_DEFS[comp.type];
        const fieldDef = def.fields.find(f => f.key === field);
        let mult = 1;
        if (fieldDef && fieldDef.unitOptions) {
          let defaultUnit = fieldDef.unitOptions[0].label;
          if (field === 'length_km' && AppState.defaultLengthUnit) defaultUnit = AppState.defaultLengthUnit;
          const selectedUnit = this.unitSelections[field] || defaultUnit;
          const unitOpt = fieldDef.unitOptions.find(u => u.label === selectedUnit);
          if (unitOpt) {
            mult = unitOpt.mult;
            value = value * mult;
          }
        }
        // Clamp to the declared min/max (defined in base units)
        if (fieldDef) {
          const lo = fieldDef.min !== undefined ? fieldDef.min : -Infinity;
          const hi = fieldDef.max !== undefined ? fieldDef.max : Infinity;
          const clamped = Math.min(hi, Math.max(lo, value));
          if (clamped !== value) {
            value = clamped;
            // Reflect the clamped value in the input (display units) on commit
            if (commit) e.target.value = parseFloat((value / mult).toPrecision(10));
          }
        }
      }
      comp.props[field] = value;
    }

    // Voltage propagation: when bus voltage changes, propagate with confirmation
    if (typeof VoltagePropagation !== 'undefined' && comp.type === 'bus' && field === 'voltage_kv') {
      AppState.dirty = true;
      if (!commit) {
        Canvas.render();
        return;
      }
      this._notifyResultsCleared();
      AppState.clearResults();
      VoltagePropagation.propagateFromBusChange(comp.id, value, () => {
        Canvas.render();
      });
      return;
    }

    // Voltage propagation: when transformer voltage changes, propagate to connected zones
    if (commit && typeof VoltagePropagation !== 'undefined' && comp.type === 'transformer' &&
        (field === 'voltage_hv_kv' || field === 'voltage_lv_kv')) {
      VoltagePropagation.propagateFromTransformerChange(comp.id, field);
    }

    AppState.dirty = true;
    if (commit) {
      this._notifyResultsCleared();
      AppState.clearResults();
      if (typeof UndoManager !== 'undefined') UndoManager.snapshot();
    }
    Canvas.render();

    // Update component label if name changed
    if (field === 'name') {
      const label = document.querySelector(`.sld-component[data-id="${comp.id}"] .comp-name-label`);
      if (label) label.textContent = value;
    }

    // When relay type changes, re-render to show/hide conditional fields
    if (field === 'relay_type' && comp.type === 'relay') {
      this.show(comp.id);
      return;
    }

    // When vector group changes, auto-set grounding defaults to match
    if (field === 'vector_group' && comp.type === 'transformer') {
      this._applyVectorGroupGrounding(comp, value || 'Dyn11');
    }

    // MCB curve class (or switching to MCB) sets the magnetic pickup to the
    // top of the IEC 60898-1 band (B 3–5×, C 5–10×, D 10–20×In)
    if (comp.type === 'cb' &&
        (field === 'mcb_curve' || (field === 'cb_type' && value === 'mcb'))) {
      const curve = field === 'mcb_curve' ? value : (comp.props.mcb_curve || 'C');
      comp.props.magnetic_pickup = MCB_CURVE_MAGNETIC[curve] || 10;
      this.show(comp.id);
    }

    // Board diversity edits change the derived lumped-load equivalents
    if (comp.type === 'distribution_board' && field === 'board_diversity' &&
        typeof DBSchedule !== 'undefined') {
      DBSchedule.recompute(comp);
    }

    // Re-render properties when fields with conditional dependents change
    if (['vector_group', 'grounding_hv', 'grounding_lv', 'cb_type', 'inverter_type', 'pv_array_mode'].includes(field)) {
      this.show(comp.id);
    }

    // Refresh the Calculated Values section when one of its inputs commits
    // (static load current; solar/wind total plant rating & available output).
    // For static loads this also re-evaluates the phase-% showWhen fields.
    const CALC_REFRESH_FIELDS = {
      static_load: ['rated_kva', 'voltage_kv', 'power_factor', 'demand_factor', 'phase_connection'],
      solar_pv: ['rated_kw', 'num_inverters', 'irradiance_pct', 'voltage_kv', 'inverter_eff',
        'inverter_type', 'battery_kwh', 'battery_dod_pct', 'battery_soc_pct', 'battery_max_discharge_kw',
        'pv_array_mode', 'pv_panel_type', 'pv_panel_w', 'pv_panels_per_string', 'pv_strings',
        'pv_voc', 'pv_vmp', 'pv_isc', 'pv_imp', 'pv_beta_voc', 'pv_gamma_vmp',
        'mppt_count', 'mppt_min_v', 'mppt_max_v', 'dc_max_v', 'mppt_max_a',
        'site_temp_min_c', 'site_cell_temp_max_c'],
      battery: ['rated_kva', 'voltage_kv', 'battery_kwh', 'battery_dod_pct', 'battery_soc_pct',
        'battery_max_discharge_kw'],
      wind_turbine: ['rated_mva', 'num_turbines', 'wind_speed_pct', 'voltage_kv'],
      generator: ['rated_mva', 'voltage_kv', 'xd_pp'],
      cb: ['trip_rating_a', 'thermal_pickup', 'magnetic_pickup'],
      distribution_board: ['voltage_kv', 'power_factor', 'board_diversity'],
    };
    if (commit && CALC_REFRESH_FIELDS[comp.type]?.includes(field)) {
      this.show(comp.id);
    }
  },

  // Set grounding defaults from a vector group: solidly_grounded for a
  // grounded-star winding, ungrounded for delta or ungrounded star.
  // Shared by manual vector-group edits and library selection.
  _applyVectorGroupGrounding(comp, vg) {
    const lvPart = vg.replace(/^[A-Z]+/, '');
    const hvIsGrounded = /^(YN|ZN)/i.test(vg.toUpperCase());
    const lvIsGrounded = /^(yn|zn)/.test(lvPart.toLowerCase());
    comp.props.grounding_hv = hvIsGrounded ? 'solidly_grounded' : 'ungrounded';
    comp.props.grounding_lv = lvIsGrounded ? 'solidly_grounded' : 'ungrounded';
  },

  // Notify once that stale analysis results were cleared by an edit.
  // Only fires when there were results to clear, so it appears once per
  // editing session (results stay cleared until studies are re-run).
  _notifyResultsCleared() {
    const had = AppState.faultResults || AppState.loadFlowResults ||
      AppState.unbalancedLoadFlowResults || AppState.arcFlashResults ||
      AppState.dcArcFlashResults || AppState.cableSizingResults ||
      AppState.motorStartingResults || AppState.dutyCheckResults ||
      AppState.loadDiversityResults || AppState.groundingResults ||
      AppState.studyManagerResults;
    if (!had) return;
    const el = document.getElementById('status-info');
    if (el) el.textContent = 'Analysis results cleared — re-run studies after editing.';
  },

  // Auto-fill component properties from a standard library entry
  applyStandardType(comp, libraryType, typeId) {
    if (libraryType === 'cable') {
      const cable = STANDARD_CABLES.find(c => c.id === typeId);
      if (cable) {
        comp.props.r_per_km = cable.r_per_km;
        comp.props.x_per_km = cable.x_per_km;
        comp.props.r0_per_km = cable.r0_per_km;
        comp.props.x0_per_km = cable.x0_per_km;
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
        // Sync grounding props with the selected vector group (M26)
        this._applyVectorGroupGrounding(comp, xfmr.vector_group || 'Dyn11');
        // Propagate the new winding voltages to connected zones, same as a
        // manual edit of voltage_hv_kv/voltage_lv_kv would
        if (typeof VoltagePropagation !== 'undefined') {
          VoltagePropagation.propagateFromTransformerChange(comp.id, 'voltage_lv_kv');
        }
      }
    } else if (libraryType === 'cb') {
      const cb = STANDARD_CBS.find(c => c.id === typeId);
      if (cb) {
        comp.props.cb_type = cb.cb_type;
        if (cb.cb_type === 'mcb') comp.props.mcb_curve = cb.mcb_curve || 'C';
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
    } else if (libraryType === 'pv_panel') {
      const panel = PV_PANELS.find(p => p.id === typeId);
      if (panel) {
        comp.props.pv_panel_w = panel.w;
        comp.props.pv_voc = panel.voc;
        comp.props.pv_vmp = panel.vmp;
        comp.props.pv_isc = panel.isc;
        comp.props.pv_imp = panel.imp;
        comp.props.pv_beta_voc = panel.beta_voc;
        comp.props.pv_gamma_vmp = panel.gamma_vmp;
      }
    }
  },

  // Compute per-unit values for display
  computePerUnit(comp) {
    const base = AppState.baseMVA;
    let html = '';

    if (comp.type === 'utility') {
      // Z_Q = c·S_base/S"kQ per IEC 60909-0 Eq. 15 (c = c_max = 1.10, matches fault.py)
      const cQ = 1.1;
      const Zpu = cQ * base / (comp.props.fault_mva || 1);
      const xr = comp.props.x_r_ratio || 15;
      const Xpu = Zpu * xr / Math.sqrt(1 + xr * xr);
      const Rpu = Xpu / xr;
      html += `<div class="prop-row"><label>Z (p.u.) = c·S_base/S"kQ, c=${cQ}</label><span class="pu-value">${Zpu.toFixed(4)}</span></div>`;
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
      html += `<div class="prop-row"><label>X"d (p.u. @ ${base} MVA)</label><span class="pu-value">${Xpu.toFixed(4)}</span></div>`;
      // Full load current from the machine rating: I = S / (√3 × V)
      const rated = comp.props.rated_mva || 0;
      const vkv = comp.props.voltage_kv || 0;
      if (rated > 0 && vkv > 0) {
        const fla = (rated * 1000) / (Math.sqrt(3) * vkv);
        html += `<div class="prop-row"><label>Full Load Current</label><span class="pu-value">${fla.toFixed(1)} A</span></div>`;
      }
    } else if (comp.type === 'cable') {
      const Vkv = comp.props.voltage_kv || 11;
      const Zbase = (Vkv * Vkv) / base;
      const nPar = Math.max(1, comp.props.num_parallel || 1);
      const Rpu = (comp.props.r_per_km * comp.props.length_km) / Zbase / nPar;
      const Xpu = (comp.props.x_per_km * comp.props.length_km) / Zbase / nPar;
      html += `<div class="prop-row"><label>R (p.u.)</label><span class="pu-value">${Rpu.toFixed(4)}</span></div>`;
      html += `<div class="prop-row"><label>X (p.u.)</label><span class="pu-value">${Xpu.toFixed(4)}</span></div>`;
      if (nPar > 1) {
        const totalAmps = (comp.props.rated_amps || 0) * nPar;
        html += `<div class="prop-row"><label>Total Rating</label><span class="pu-value">${totalAmps} A (${nPar}×${comp.props.rated_amps})</span></div>`;
      }
    } else if (comp.type === 'motor_induction') {
      // S = P / (η·cosφ) per IEC 60909-0 §3.8 (matches the backend engines)
      const kva = (comp.props.rated_kw || 200) /
        ((comp.props.efficiency || 0.93) * (comp.props.power_factor || 0.85));
      const Xpu = (comp.props.x_pp || 0.17) * base / (kva / 1000);
      html += `<div class="prop-row"><label>X" (p.u.)</label><span class="pu-value">${Xpu.toFixed(4)}</span></div>`;
    } else if (comp.type === 'motor_synchronous') {
      const Xpu = (comp.props.xd_pp || 0.15) * base / ((comp.props.rated_kva || 500) / 1000);
      html += `<div class="prop-row"><label>X"d (p.u.)</label><span class="pu-value">${Xpu.toFixed(4)}</span></div>`;
    } else if (comp.type === 'static_load') {
      const amps = this._staticLoadRatedAmps(comp.props);
      if (amps === null) return null;
      html += `<div class="prop-row"><label>Rated Current</label><span class="pu-value">${amps.toFixed(1)} A</span></div>`;
      const df = comp.props.demand_factor;
      if (df && df !== 1) {
        html += `<div class="prop-row"><label>Demand Current</label><span class="pu-value">${(amps * df).toFixed(1)} A</span></div>`;
      }
    } else if (comp.type === 'distribution_board') {
      const circuits = comp.props.circuits || [];
      const connected = comp.props.rated_kva || 0;      // derived: Σ way VA
      const df = comp.props.demand_factor || 1;         // derived: aggregate diversity
      const demand = connected * df;
      html += `<div class="prop-row"><label>Ways</label><span class="pu-value">${circuits.length}</span></div>`;
      html += `<div class="prop-row"><label>Connected Load</label><span class="pu-value">${connected.toFixed(1)} kVA</span></div>`;
      html += `<div class="prop-row"><label>Demand (diversified)</label><span class="pu-value">${demand.toFixed(1)} kVA</span></div>`;
      const vkv = comp.props.voltage_kv || 0;
      if (vkv > 0 && demand > 0) {
        html += `<div class="prop-row"><label>Demand Current</label><span class="pu-value">${(demand / (Math.sqrt(3) * vkv)).toFixed(1)} A</span></div>`;
      }
      if (circuits.length > 0) {
        const pa = comp.props.phase_a_pct ?? 33.33;
        const pb = comp.props.phase_b_pct ?? 33.33;
        const pc = comp.props.phase_c_pct ?? 33.34;
        html += `<div class="prop-row"><label>Phase Balance R/W/B</label><span class="pu-value">${pa.toFixed(0)}/${pb.toFixed(0)}/${pc.toFixed(0)} %</span></div>`;
        // Worst EL group's standing leakage vs its 30%-of-IΔn limit
        // (IEC 60364-5-53 §531.3.2) — full breakdown lives in the schedule
        if (typeof DBSchedule !== 'undefined') {
          const { groups, ratings } = DBSchedule._leakageGroups(comp);
          let worst = null;
          for (const [g, ma] of groups) {
            const limit = ratings[g] * DB_EL_STANDING_LIMIT;
            const ratio = limit > 0 ? ma / limit : 0;
            if (!worst || ratio > worst.ratio) worst = { g, ma, limit, ratio };
          }
          if (worst) {
            const over = worst.ratio > 1;
            html += `<div class="prop-row"><label>EL Standing Leakage</label><span class="pu-value" style="${over ? 'color:#d32f2f;' : ''}">${over ? '⚠ ' : ''}EL ${escHtml(worst.g)}: ${worst.ma.toFixed(1)} / ${worst.limit.toFixed(1)} mA</span></div>`;
          }
        }
      }
    } else if (comp.type === 'solar_pv') {
      // Make the rated-power × inverter-count multiplication explicit
      const nInv = Math.max(1, comp.props.num_inverters || 1);
      const rated = comp.props.rated_kw || 0;
      const total = rated * nInv;
      if (total <= 0) return null;
      const fmtKw = (kw) => kw >= 1000 ? `${(kw / 1000).toFixed(2)} MW` : `${kw.toFixed(0)} kW`;
      const totalStr = nInv > 1 ? `${nInv} × ${fmtKw(rated)} = ${fmtKw(total)}` : fmtKw(total);
      html += `<div class="prop-row"><label>Total Plant Rating</label><span class="pu-value">${totalStr}</span></div>`;
      const irr = comp.props.irradiance_pct ?? 100;
      if (irr < 100) {
        html += `<div class="prop-row"><label>Available Output</label><span class="pu-value">${fmtKw(total * irr / 100)} @ ${irr}%</span></div>`;
      }
      // Full load current at the plant's rated apparent power (engine
      // convention: S = kW × inverters / efficiency), independent of irradiance
      const pvKv = comp.props.voltage_kv || 0;
      const eff = comp.props.inverter_eff || 0.97;
      if (pvKv > 0 && eff > 0) {
        const sKva = total / eff;
        html += `<div class="prop-row"><label>Full Load Current</label><span class="pu-value">${(sKva / (Math.sqrt(3) * pvKv)).toFixed(1)} A</span></div>`;
      }
      if (comp.props.pv_array_mode === 'array') {
        const rows = this._pvArraySummaryRows(comp.props, total);
        if (rows) html += rows;
      }
      if (comp.props.inverter_type === 'hybrid') {
        const rows = this._batterySummaryRows(comp.props, eff > 0 ? total / eff : total);
        if (rows) html += rows;
      }
    } else if (comp.type === 'wind_turbine') {
      const nTurb = Math.max(1, comp.props.num_turbines || 1);
      const rated = comp.props.rated_mva || 0;
      const total = rated * nTurb;
      if (total <= 0) return null;
      const fmtMva = (mva) => mva >= 1 ? `${mva.toFixed(2)} MVA` : `${(mva * 1000).toFixed(0)} kVA`;
      const totalStr = nTurb > 1 ? `${nTurb} × ${fmtMva(rated)} = ${fmtMva(total)}` : fmtMva(total);
      html += `<div class="prop-row"><label>Total Plant Rating</label><span class="pu-value">${totalStr}</span></div>`;
      const wind = comp.props.wind_speed_pct ?? 100;
      if (wind < 100) {
        html += `<div class="prop-row"><label>Available Output</label><span class="pu-value">${fmtMva(total * wind / 100)} @ ${wind}%</span></div>`;
      }
      const wtKv = comp.props.voltage_kv || 0;
      if (wtKv > 0) {
        html += `<div class="prop-row"><label>Full Load Current</label><span class="pu-value">${((total * 1000) / (Math.sqrt(3) * wtKv)).toFixed(1)} A</span></div>`;
      }
    } else if (comp.type === 'battery') {
      const batt = this._batterySummaryRows(comp.props, comp.props.rated_kva || 0);
      if (!batt) return null;
      html += batt;
    } else {
      return null;
    }

    return html;
  },

  // PV array sizing + IEC 62548 DC string checks, rendered live in the
  // Calculated Values section for solar_pv in array mode. `acTotalKw` is
  // the total inverter AC rating (rated_kw × inverters).
  //   Voc @ min ambient  — coldest open-circuit voltage vs max DC input
  //   Vmp @ max cell temp — hottest operating voltage vs the MPPT window
  //   String current      — 1.25 × Isc × strings-per-MPPT vs input limit
  _pvArraySummaryRows(p, acTotalKw) {
    const panelW = p.pv_panel_w || 0;
    const pps = Math.max(1, Math.round(p.pv_panels_per_string || 1));
    const strings = Math.max(1, Math.round(p.pv_strings || 1));
    const nInv = Math.max(1, p.num_inverters || 1);
    if (panelW <= 0) return null;
    const fmtKw = (kw) => kw >= 1000 ? `${(kw / 1000).toFixed(2)} MWp` : `${kw.toFixed(1)} kWp`;
    const dcKwInv = panelW * pps * strings / 1000;   // per inverter
    const dcKwTotal = dcKwInv * nInv;
    let html = `<div class="prop-row"><label>Array (DC)</label><span class="pu-value">${strings}S × ${pps}P × ${panelW} W = ${fmtKw(dcKwInv)}${nInv > 1 ? ` /inv (${fmtKw(dcKwTotal)} total)` : ''}</span></div>`;

    // DC/AC ratio against the inverter nameplate
    if (acTotalKw > 0) {
      const ratio = dcKwTotal / acTotalKw;
      const over = ratio > 1.5;
      html += `<div class="prop-row"><label>DC/AC Ratio</label><span class="pu-value" style="${over ? 'color:#f57c00;' : ''}">${ratio.toFixed(2)}${over ? ' ⚠ heavy oversizing — check inverter DC limit' : ''}</span></div>`;
      const irr = (p.irradiance_pct ?? 100) / 100;
      const outKw = Math.min(dcKwTotal * irr, acTotalKw);
      if (dcKwTotal * irr > acTotalKw) {
        html += `<div class="prop-row"><label>Clipped Output</label><span class="pu-value">${outKw.toFixed(1)} kW (inverter limit)</span></div>`;
      }
    }

    // ── DC string electrical checks (IEC 62548) ──
    const tMin = p.site_temp_min_c ?? -5;
    const tCellMax = p.site_cell_temp_max_c ?? 70;
    const vocCold = pps * (p.pv_voc || 0) * (1 + (p.pv_beta_voc || 0) / 100 * (tMin - 25));
    const vmpHot = pps * (p.pv_vmp || 0) * (1 + (p.pv_gamma_vmp || 0) / 100 * (tCellMax - 25));
    const dcMaxV = p.dc_max_v || 1000;
    const mpptMin = p.mppt_min_v || 0;
    const mpptMax = p.mppt_max_v || dcMaxV;
    const mpptCount = Math.max(1, Math.round(p.mppt_count || 1));
    const mpptMaxA = p.mppt_max_a || 0;
    const stringsPerMppt = Math.ceil(strings / mpptCount);
    const iString = stringsPerMppt * (p.pv_isc || 0) * 1.25;

    const row = (label, text, okFlag) =>
      `<div class="prop-row"><label>${label}</label><span class="pu-value" style="${okFlag ? '' : 'color:#d32f2f;font-weight:600;'}">${text} ${okFlag ? '✓' : '✗'}</span></div>`;
    if (p.pv_voc > 0) {
      html += row('String Voc @ ' + tMin + '°C',
        `${vocCold.toFixed(0)} V ≤ ${dcMaxV} V max`, vocCold <= dcMaxV);
    }
    if (p.pv_vmp > 0 && mpptMin > 0) {
      html += row('String Vmp @ ' + tCellMax + '°C',
        `${vmpHot.toFixed(0)} V in ${mpptMin}–${mpptMax} V window`,
        vmpHot >= mpptMin && vmpHot <= mpptMax);
    }
    if (p.pv_isc > 0 && mpptMaxA > 0) {
      html += row('String Current (1.25×Isc)',
        `${iString.toFixed(1)} A ≤ ${mpptMaxA} A/MPPT (${stringsPerMppt} str/MPPT)`,
        iString <= mpptMaxA);
    }
    return html;
  },

  // Battery storage calculated rows (shared by BESS and hybrid Solar PV).
  // Usable = capacity × DoD; available now additionally respects the SoC
  // above the DoD reserve floor. Autonomy is at max discharge power.
  _batterySummaryRows(props, inverterKva) {
    const kwh = props.battery_kwh || 0;
    if (kwh <= 0) return null;
    const dod = Math.min(100, Math.max(0, props.battery_dod_pct ?? 90));
    const soc = Math.min(100, Math.max(0, props.battery_soc_pct ?? 100));
    const usable = kwh * dod / 100;
    const available = kwh * Math.max(0, soc - (100 - dod)) / 100;
    const disKw = props.battery_max_discharge_kw || 0;
    const effDisKw = inverterKva > 0 ? Math.min(disKw, inverterKva) : disKw;
    let html = `<div class="prop-row"><label>Usable Energy</label><span class="pu-value">${usable.toFixed(1)} kWh (${dod}% DoD)</span></div>`;
    if (soc < 100) {
      html += `<div class="prop-row"><label>Available @ SoC</label><span class="pu-value">${available.toFixed(1)} kWh @ ${soc}%</span></div>`;
    }
    if (effDisKw > 0) {
      html += `<div class="prop-row"><label>Autonomy @ Max Discharge</label><span class="pu-value">${(available / effDisKw).toFixed(1)} h @ ${effDisKw.toFixed(0)} kW</span></div>`;
    }
    if (inverterKva > 0 && disKw > inverterKva) {
      html += `<div class="prop-row"><label>Note</label><span class="pu-value" style="color:#f57c00;">discharge limited by inverter ${inverterKva.toFixed(0)} kVA</span></div>`;
    }
    return html;
  },

  // Rated current (A) from a static load's kVA rating and phase connection:
  // 3P draws across √3·V_LL, 2P across V_LL, 1P across V_LN = V_LL/√3
  // (same connection semantics as the backend unbalanced load flow)
  _staticLoadRatedAmps(props) {
    const kva = props.rated_kva || 0;
    const vkv = props.voltage_kv || 0;
    if (kva <= 0 || vkv <= 0) return null;
    const conn = props.phase_connection || '3P';
    if (conn.startsWith('1P')) return (kva * Math.sqrt(3)) / vkv;
    if (conn.startsWith('2P')) return kva / vkv;
    return kva / (Math.sqrt(3) * vkv);
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
        // c_max per IEC 60909 Table 1: 1.10 (+10% tolerance) — matches fault.py
        const cFactor = 1.1;
        const zBase = (vkv * vkv) / AppState.baseMVA;

        // Z_eq display
        const hasZeq = busResult.z_eq_mag != null;
        const zeqR = busResult.z_eq_real || 0;
        const zeqX = busResult.z_eq_imag || 0;
        const zeqMag = busResult.z_eq_mag || 0;
        const zeqOhm = zeqMag * zBase;

        html += `
          <div class="calc-step">
            <div class="calc-step-title">Fault Analysis — ${escHtml(busName)} (${vkv} kV)</div>
            <div class="calc-formula">Method: IEC 60909 (Symmetrical)
Base MVA = ${AppState.baseMVA} MVA
Z_base = V²/S = ${vkv}² / ${AppState.baseMVA} = ${zBase.toFixed(4)} Ω
I_base = S_base / (√3 × V_n) = ${AppState.baseMVA} / (√3 × ${vkv}) = ${iBaseKA.toFixed(4)} kA
c-factor = ${cFactor} (${vkv < 1.0 ? 'LV ≤ 1kV' : 'MV/HV > 1kV'})
${hasZeq ? `
─── Equivalent Impedance (Z_eq) ───
Z_eq = ${zeqR.toFixed(6)} + j${zeqX.toFixed(6)} p.u. (${(zeqR * 100).toFixed(4)} + j${(zeqX * 100).toFixed(4)}%)
|Z_eq| = ${zeqMag.toFixed(6)} p.u. (${(zeqMag * 100).toFixed(4)}%) = ${zeqOhm.toFixed(6)} Ω
R/X = ${zeqX !== 0 ? (zeqR / zeqX).toFixed(4) : 'N/A'}    X/R = ${zeqR !== 0 ? (zeqX / zeqR).toFixed(2) : 'N/A'}` : ''}

─── Three-Phase Fault (I"k3) ── IEC 60909-0 §8–10 ───
I"k3 = c × V_n / (√3 × |Z_eq|)${hasZeq ? ` = ${cFactor} / ${zeqMag.toFixed(6)} × ${iBaseKA.toFixed(4)}` : ''}
I"k3 = ${busResult.ik3?.toFixed(3) || 'N/A'} kA (initial symmetrical)
${busResult.ik3 ? `S"k3 = √3 × ${vkv} × ${busResult.ik3.toFixed(3)} = ${(Math.sqrt(3) * vkv * busResult.ik3).toFixed(2)} MVA` : ''}
${busResult.ip != null ? `
─── Peak Current ip (§8.1) ───
ip = κ × √2 × I"k3 = ${busResult.kappa} × √2 × ${busResult.ik3.toFixed(3)}
ip = ${busResult.ip.toFixed(3)} kA    κ = ${busResult.kappa} (R/X = ${zeqX !== 0 ? Math.abs(zeqR / zeqX).toFixed(4) : 'N/A'})
κ = 1.02 + 0.98 × e^(−3 × R/X)` : ''}
${busResult.ib != null ? `
─── Breaking Current Ib (§9.1) ───
Ib = ${busResult.ib.toFixed(3)} kA (symmetrical, t_min = 0.1s)${busResult.ib_asymmetric != null ? `
Ib_asym = √(Ib² + i_DC²) = ${busResult.ib_asymmetric.toFixed(3)} kA (asymmetric)` : ''}
${busResult.ib < busResult.ik3 ? `Decay: μ/q factors applied to generator/motor contributions` : `No decay (far-from-generator fault)`}` : ''}
${busResult.ik_steady != null ? `
─── Steady-State Current Ik (§10) ───
Ik = ${busResult.ik_steady.toFixed(3)} kA
${busResult.ik_steady < busResult.ik3 ? `Generators use Xd (synchronous), induction motors contribute 0` : `Network-fed: Ik ≈ I"k (no decay)`}` : ''}
${busResult.motor_count > 0 ? `
─── Motor Contribution (§13) ───
Motors contributing: ${busResult.motor_count}
I"k3 from network: ${busResult.ik3_network?.toFixed(3) || '—'} kA
I"k3 from motors:  ${busResult.ik3_motor?.toFixed(3) || '—'} kA (${busResult.ik3 > 0 ? (busResult.ik3_motor / busResult.ik3 * 100).toFixed(1) : 0}% of total)
Induction motors: sub-transient current decays to 0 within ~200ms
Synchronous motors: sustained contribution (like generators)` : ''}

─── Zero-Sequence Impedance (Z0) ───
${busResult.z0_mag != null ? `Z0 = ${busResult.z0_real?.toFixed(6)} + j${busResult.z0_imag?.toFixed(6)} p.u. (${(busResult.z0_real * 100)?.toFixed(4)} + j${(busResult.z0_imag * 100)?.toFixed(4)}%)
|Z0| = ${busResult.z0_mag?.toFixed(6)} p.u. (${(busResult.z0_mag * 100)?.toFixed(4)}%)
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
${busResult.z0_mag != null && busResult.ik1 != null ? (busResult.z_slg_mag != null ? `|Z1| = |Z_eq| = ${zeqMag.toFixed(6)} p.u.
|Z2| = ${(busResult.z2_mag ?? zeqMag).toFixed(6)} p.u.${busResult.z2_mag != null && Math.abs(busResult.z2_mag - zeqMag) > 5e-7 ? ' (≠ Z1: rotating machines present)' : ' (= Z1 for static network)'}
|Z0| = ${busResult.z0_mag?.toFixed(6)} p.u.
Z_SLG = |Z1 + Z2 + Z0| = ${busResult.z_slg_mag.toFixed(6)} p.u. (${(busResult.z_slg_mag * 100).toFixed(4)}%)
(complex sum — impedance angles differ, so magnitudes are not additive)
I"k1 = 3 × ${cFactor} / ${busResult.z_slg_mag.toFixed(6)} × ${iBaseKA.toFixed(4)}` : `Z_SLG ≈ Z1 + Z2 + Z0 ≈ 2×|Z_eq| + |Z0|   (≈, magnitudes summed; Z2 = Z1 assumed)
     ≈ 2×${zeqMag.toFixed(6)} + ${busResult.z0_mag?.toFixed(6)}
     ≈ ${(2 * zeqMag + busResult.z0_mag).toFixed(6)} p.u. (${((2 * zeqMag + busResult.z0_mag) * 100).toFixed(4)}%)
(engine sums Z1+Z2+Z0 as complex values — re-run Fault Analysis for the exact |Z1+Z2+Z0| step)
I"k1 ≈ 3 × ${cFactor} / ${(2 * zeqMag + busResult.z0_mag).toFixed(6)} × ${iBaseKA.toFixed(4)}`) : busResult.ik1 === 0 ? `No Z0 path → I"k1 = 0 (zero-sequence current cannot return)` : ''}
I"k1 = ${busResult.ik1?.toFixed(3) || 'N/A'} kA
${busResult.ik1 ? `S"k1 = √3 × ${vkv} × ${busResult.ik1.toFixed(3)} = ${(Math.sqrt(3) * vkv * busResult.ik1).toFixed(2)} MVA` : ''}

─── Line-to-Line Fault (I"kLL) ───
I"kLL = c × √3 × V_n / (√3 × |Z1 + Z2|)
I"kLL = ${busResult.ikLL?.toFixed(3) || 'N/A'} kA
${busResult.ikLL ? `S"kLL = √3 × ${vkv} × ${busResult.ikLL.toFixed(3)} = ${(Math.sqrt(3) * vkv * busResult.ikLL).toFixed(2)} MVA` : ''}

─── Double Line-to-Ground Fault (I"kE2E) ───
Ia1 = c / (Z1 + Z2‖Z0),  Ia0 = −Ia1 × Z2 / (Z2 + Z0)
I"kE2E = |3 × Ia0| = 3c × |Z2| / |Z2×(Z1+Z2+Z0) + Z1×Z0|  (earth fault current)
${busResult.z0_mag != null ? `Evaluated with complex Z1 = Z_eq${busResult.z2_mag != null ? `, |Z2| = ${busResult.z2_mag.toFixed(6)} p.u.` : ', Z2 = Z1'}, |Z0| = ${busResult.z0_mag.toFixed(6)} p.u.
(complex arithmetic — magnitudes are not additive)` : `No Z0 path → degenerates to LL fault`}
I"kE2E = ${busResult.ikLLG?.toFixed(3) || 'N/A'} kA
${busResult.ikLLG ? `S"kLLG = √3 × ${vkv} × ${busResult.ikLLG.toFixed(3)} = ${(Math.sqrt(3) * vkv * busResult.ikLLG).toFixed(2)} MVA` : ''}</div>
          </div>`;

        // Branch contributions table
        if (busResult.branches && busResult.branches.length > 0) {
          html += `
          <div class="calc-step">
            <div class="calc-step-title">Branch Fault Current Contributions — ${escHtml(busName)}</div>
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
  const isMotor = (br.element_type || '').startsWith('motor_');
  const typeLabel = (br.element_type || '').replace('_', ' ');
  const motorTag = isMotor ? ' <span style="color:#6a1b9a;font-weight:bold" title="Motor fault contribution">[M]</span>' : '';
  return `<tr style="border-bottom:1px solid #ddd${isMotor ? ';background:#f3e5f5' : ''}">
  <td style="padding:2px 6px">${escHtml(elName)}${motorTag}</td>
  <td style="padding:2px 6px">${typeLabel}</td>
  <td style="text-align:right;padding:2px 6px;font-weight:bold;color:#b71c1c">${br.ik_ka.toFixed(3)}</td>
  <td style="text-align:right;padding:2px 6px">${br.contribution_pct.toFixed(1)}%</td>
  <td style="text-align:right;padding:2px 6px">${br.z_path_mag.toFixed(6)}</td>
  <td style="padding:2px 6px">${escHtml(br.source_name || '—')}</td>
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
            <div class="calc-step-title">Load Flow — ${escHtml(busName)}</div>
            <div class="calc-formula">Method: ${lf.method === 'newton_raphson' ? 'Newton-Raphson' : 'Gauss-Seidel'}
Converged: ${lf.converged ? 'Yes' : 'NO — results may be inaccurate'}
Iterations: ${lf.iterations}

─── Bus Voltage ───
|V| = ${busLF.voltage_pu?.toFixed(6)} p.u. (${(busLF.voltage_pu * 100)?.toFixed(4)}%)
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

      // Branch / source flow for this component
      const _branchTypes = ['transformer', 'cable', 'cb', 'switch', 'fuse', 'generator', 'solar_pv', 'wind_turbine'];
      if (_branchTypes.includes(comp.type) && lf.branches) {
        const isSource = ['generator', 'solar_pv', 'wind_turbine'].includes(comp.type);
        for (const br of lf.branches) {
          if (br.elementId !== comp.id) continue;
          const fromBus = AppState.components.get(br.from_bus);
          const sMVA = br.s_mva || Math.sqrt(br.p_mw ** 2 + br.q_mvar ** 2);

          if (isSource) {
            html += `
              <div class="calc-step">
                <div class="calc-step-title">Load Flow Output — ${escHtml(comp.props.name)}</div>
                <div class="calc-formula">Connected to: ${escHtml(fromBus?.props?.name || br.from_bus)}

P = ${br.p_mw?.toFixed(4)} MW  (${(br.p_mw * 1000).toFixed(1)} kW)  [generation]
Q = ${br.q_mvar?.toFixed(4)} MVAr  (${(br.q_mvar * 1000).toFixed(1)} kVAr)
S = ${sMVA.toFixed(4)} MVA  (${(sMVA * 1000).toFixed(1)} kVA)
I = ${br.i_amps?.toFixed(1) || '—'} A
${br.loading_pct > 0 ? `Output = ${br.loading_pct.toFixed(1)}% of rated capacity${br.loading_pct > 100 ? '  ⚠ OVERLOADED' : ''}` : ''}</div>
              </div>`;
          } else {
            const toBus = AppState.components.get(br.to_bus);
            html += `
              <div class="calc-step">
                <div class="calc-step-title">Branch Power Flow — ${escHtml(comp.props.name)}</div>
                <div class="calc-formula">From: ${escHtml(fromBus?.props?.name || br.from_bus)}
To:   ${escHtml(toBus?.props?.name || br.to_bus)}

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
    }

    // --- Unbalanced Load Flow Results ---
    if (AppState.unbalancedLoadFlowResults) {
      const ulf = AppState.unbalancedLoadFlowResults;
      const busIds = comp.type === 'bus' ? [comp.id] : connectedBusIds;

      for (const busId of busIds) {
        const br = ulf.buses?.[busId];
        if (!br) continue;
        const busComp = AppState.components.get(busId);
        const busName = busComp?.props?.name || busId;

        html += `
          <div class="calc-step">
            <div class="calc-step-title">Unbalanced Load Flow — ${escHtml(busName)}</div>
            <div class="calc-formula">Method: ${ulf.method || 'Sequence Component'}
Converged: ${ulf.converged ? 'Yes' : 'NO — results may be inaccurate'}
Iterations: ${ulf.iterations}

─── Per-Phase Voltages ───
Va = ${br.va_pu?.toFixed(4)} p.u. ∠${br.angle_a_deg?.toFixed(2)}°  =  ${br.va_kv?.toFixed(4)} kV
Vb = ${br.vb_pu?.toFixed(4)} p.u. ∠${br.angle_b_deg?.toFixed(2)}°  =  ${br.vb_kv?.toFixed(4)} kV
Vc = ${br.vc_pu?.toFixed(4)} p.u. ∠${br.angle_c_deg?.toFixed(2)}°  =  ${br.vc_kv?.toFixed(4)} kV

─── Sequence Voltages ───
V₁ (pos.) = ${br.v1_pu?.toFixed(4)} p.u.
V₂ (neg.) = ${br.v2_pu?.toFixed(4)} p.u.
V₀ (zero) = ${br.v0_pu?.toFixed(4)} p.u.

─── Voltage Unbalance Factor (IEC 61000-3-13) ───
VUF = |V₂|/|V₁| × 100 = ${br.vuf_pct?.toFixed(3)}%  ${br.vuf_pct > 2 ? '⚠ EXCEEDS 2% LIMIT' : br.vuf_pct > 1 ? '⚠ Elevated' : '✓ Within limit'}

─── Per-Phase Active Power Injections ───
Pa = ${br.pa_mw?.toFixed(4)} MW   Pb = ${br.pb_mw?.toFixed(4)} MW   Pc = ${br.pc_mw?.toFixed(4)} MW</div>
          </div>`;
      }

      // Branch results for non-bus components
      if (comp.type !== 'bus' && ulf.branches) {
        for (const br of ulf.branches) {
          if (br.elementId !== comp.id) continue;
          const fromBus = AppState.components.get(br.from_bus);
          const toBus = AppState.components.get(br.to_bus);
          html += `
            <div class="calc-step">
              <div class="calc-step-title">Unbalanced Branch Currents — ${escHtml(comp.props.name || comp.type)}</div>
              <div class="calc-formula">From: ${escHtml(fromBus?.props?.name || br.from_bus)}
To:   ${escHtml(toBus?.props?.name || br.to_bus)}

─── Per-Phase Currents ───
Ia = ${br.ia_amps?.toFixed(1)} A
Ib = ${br.ib_amps?.toFixed(1)} A
Ic = ${br.ic_amps?.toFixed(1)} A
In = ${br.in_amps?.toFixed(1)} A (neutral)

─── Sequence Currents ───
I₁ (pos.) = ${br.i1_amps?.toFixed(1)} A
I₂ (neg.) = ${br.i2_amps?.toFixed(1)} A
I₀ (zero) = ${br.i0_amps?.toFixed(1)} A
${br.loading_pct > 0 ? `Loading = ${br.loading_pct.toFixed(1)}%${br.loading_pct > 100 ? '  ⚠ OVERLOADED' : br.loading_pct > 80 ? '  ⚠ Heavy loading' : ''}` : ''}</div>
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

  // Get voltage filter for cable library based on connected bus voltages
  // and the facing winding of directly connected transformers
  _getCableVoltageFilter(compId) {
    const voltages = new Set();
    let anchors = 0; // connected buses/transformers that define a voltage

    for (const n of Components.getConnectedComponents(compId)) {
      const other = AppState.components.get(n.componentId);
      if (!other) continue;
      if (other.type === 'bus') {
        anchors++;
        if (other.props.voltage_kv) voltages.add(other.props.voltage_kv);
      } else if (other.type === 'transformer' && typeof VoltagePropagation !== 'undefined') {
        // n.port is the transformer port this cable connects to
        const side = VoltagePropagation.getTransformerSide(other, n.port);
        if (!side) continue;
        anchors++;
        const v = other.props[side.thisKey];
        if (v) voltages.add(v);
      }
    }

    if (anchors === 0) return null; // no buses/transformers — show all cables
    if (voltages.size !== 1) return null; // ambiguous — show all

    const systemVoltage = [...voltages][0];
    if (systemVoltage <= 1.0) {
      return { fn: c => c.voltage_kv <= 1.0, label: 'LV' };
    } else {
      return { fn: c => c.voltage_kv === systemVoltage, label: `${systemVoltage} kV` };
    }
  },

  // Initialize searchable select widgets for cable dropdown
  _initSearchableSelects(comp, container = this.contentEl) {
    container.querySelectorAll('.searchable-select').forEach(wrapper => {
      const input = wrapper.querySelector('.searchable-select-input');
      const dropdown = wrapper.querySelector('.searchable-select-dropdown');
      const options = dropdown.querySelectorAll('.searchable-select-option');
      const fieldKey = wrapper.dataset.field;
      const libraryType = wrapper.dataset.library;
      let highlightIdx = -1;

      const open = () => {
        wrapper.classList.add('open');
        // Show all options when opening (clear previous search filter)
        options.forEach(opt => opt.classList.remove('hidden'));
        highlightIdx = -1;
      };

      const close = () => {
        wrapper.classList.remove('open');
        // Restore display text to current selection
        const currentVal = wrapper.dataset.value;
        if (currentVal) {
          const cable = STANDARD_CABLES.find(c => c.id === currentVal);
          input.value = cable ? cable.name : currentVal;
        } else {
          input.value = '';
        }
        highlightIdx = -1;
      };

      const selectOption = (val) => {
        wrapper.dataset.value = val;
        comp.props[fieldKey] = val;
        if (val) {
          this.applyStandardType(comp, libraryType, val);
        }
        AppState.dirty = true;
        this._notifyResultsCleared();
        AppState.clearResults();
        Canvas.render();
        wrapper.classList.remove('open');
        this.show(comp.id);
        // If the edit happened in the mobile properties sheet (a listener-less
        // innerHTML mirror of this panel), refresh that mirror so the new cable
        // name and its derived r/x/rating fields show through.
        if (typeof MobileUI !== 'undefined' && MobileUI.activeSheet === 'mobile-sheet-properties') {
          MobileUI.showPropertiesSheet(comp.id);
        }
      };

      const getVisibleOptions = () => [...options].filter(o => !o.classList.contains('hidden'));

      const updateHighlight = (visibleOpts) => {
        options.forEach(o => o.classList.remove('highlighted'));
        if (highlightIdx >= 0 && highlightIdx < visibleOpts.length) {
          visibleOpts[highlightIdx].classList.add('highlighted');
          visibleOpts[highlightIdx].scrollIntoView({ block: 'nearest' });
        }
      };

      input.addEventListener('focus', open);
      input.addEventListener('click', open);

      input.addEventListener('input', () => {
        const query = input.value.toLowerCase();
        options.forEach(opt => {
          const text = opt.textContent.toLowerCase();
          const val = opt.dataset.value;
          // Always show "-- Custom --" option
          if (val === '') {
            opt.classList.remove('hidden');
          } else {
            opt.classList.toggle('hidden', !text.includes(query));
          }
        });
        highlightIdx = -1;
        if (!wrapper.classList.contains('open')) open();
      });

      input.addEventListener('keydown', (e) => {
        const visible = getVisibleOptions();
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          highlightIdx = Math.min(highlightIdx + 1, visible.length - 1);
          updateHighlight(visible);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          highlightIdx = Math.max(highlightIdx - 1, 0);
          updateHighlight(visible);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          if (highlightIdx >= 0 && highlightIdx < visible.length) {
            selectOption(visible[highlightIdx].dataset.value);
          }
        } else if (e.key === 'Escape') {
          close();
          input.blur();
        }
      });

      // Select on 'click', not 'mousedown': on touch devices a mousedown on a
      // scrollable option list is withheld by the browser while it decides
      // whether the gesture is a scroll, so taps never registered and cable
      // sizes could not be selected on mobile. 'click' fires reliably for a
      // genuine tap and is correctly suppressed during a scroll drag.
      dropdown.addEventListener('click', (e) => {
        const opt = e.target.closest('.searchable-select-option');
        if (opt) selectOption(opt.dataset.value);
      });

      // Close on outside tap. Uses pointerdown (fires for both mouse and touch)
      // so the dropdown also dismisses on mobile.
      const outsideHandler = (e) => {
        if (!wrapper.contains(e.target)) {
          close();
          document.removeEventListener('pointerdown', outsideHandler);
        }
      };
      input.addEventListener('focus', () => {
        setTimeout(() => document.addEventListener('pointerdown', outsideHandler), 0);
      });
    });
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
      // Z_Q = c·U_nQ²/S"kQ per IEC 60909-0 §6.2 Eq. 15 — in per-unit on S_base:
      // Z_pu = c·S_base/S"kQ, with c = c_max = 1.10 (matches the fault.py engine)
      const cQ = 1.1;
      const Zpu = cQ * base / fmva;
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
c-factor = ${cQ} (c_max per IEC 60909-0 Table 1)

Z_Q = c × S_base / S"_kQ    (IEC 60909-0 §6.2, Eq. 15)
Z_Q = ${cQ} × ${base} / ${fmva} = ${Zpu.toFixed(6)} p.u. (${(Zpu * 100).toFixed(4)}%)

X_pu = Z_pu × (X/R) / √(1 + (X/R)²)
X_pu = ${Zpu.toFixed(6)} × ${xr} / √(1 + ${xr}²) = ${Xpu.toFixed(6)} p.u. (${(Xpu * 100).toFixed(4)}%)

R_pu = X_pu / (X/R)
R_pu = ${Xpu.toFixed(6)} / ${xr} = ${Rpu.toFixed(6)} p.u. (${(Rpu * 100).toFixed(4)}%)

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
X"d_pu = ${xdpp} × (${base} / ${rated}) = ${Xpu.toFixed(6)} p.u. (${(Xpu * 100).toFixed(4)}%)

R_pu = X"d_pu / (X/R) = ${Xpu.toFixed(6)} / ${xr} = ${Rpu.toFixed(6)} p.u. (${(Rpu * 100).toFixed(4)}%)

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
      const Zpu_uncorr = (zPct / 100) * base / rated;
      const Xpu_uncorr = Zpu_uncorr * xr / Math.sqrt(1 + xr * xr);
      const Rpu_uncorr = Xpu_uncorr / xr;
      // IEC 60909 correction factor K_T = 0.95 × c_max / (1 + 0.6 × x_T)
      // c_max is tied to the LV-side nominal voltage (IEC 60909-0 §6.3.3)
      const xT = (zPct / 100) * xr / Math.sqrt(1 + xr * xr);
      // c_max per IEC 60909 Table 1 (+10% tolerance) — matches fault.py engine
      const cMax = 1.1;
      const KT = 0.95 * cMax / (1 + 0.6 * xT);
      const Zpu = Zpu_uncorr * KT;
      const Xpu = Xpu_uncorr * KT;
      const Rpu = Rpu_uncorr * KT;
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
Z_pu = (${zPct} / 100) × (${base} / ${rated}) = ${Zpu_uncorr.toFixed(6)} p.u. (${(Zpu_uncorr * 100).toFixed(4)}%)

X_pu = Z_pu × (X/R) / √(1 + (X/R)²)
X_pu = ${Xpu_uncorr.toFixed(6)} p.u. (${(Xpu_uncorr * 100).toFixed(4)}%)

R_pu = X_pu / (X/R) = ${Rpu_uncorr.toFixed(6)} p.u. (${(Rpu_uncorr * 100).toFixed(4)}%)

─── IEC 60909 Correction Factor (§6.3.3) ───
x_T = (Z% / 100) × (X/R) / √(1 + (X/R)²) = ${xT.toFixed(6)} p.u. (on transformer rating)
c_max = ${cMax} (LV side ${lvkv} kV ${lvkv < 1.0 ? '< 1 kV' : '≥ 1 kV'})
K_T = 0.95 × c_max / (1 + 0.6 × x_T)
K_T = 0.95 × ${cMax} / (1 + 0.6 × ${xT.toFixed(6)}) = ${KT.toFixed(6)}

─── Corrected Impedance (Z × K_T) ───
Z_pu = ${Zpu.toFixed(6)} p.u. (${(Zpu * 100).toFixed(4)}%)
X_pu = ${Xpu.toFixed(6)} p.u.,  R_pu = ${Rpu.toFixed(6)} p.u.
Z = ${Rpu.toFixed(6)} + j${Xpu.toFixed(6)} p.u.
|Z| = ${Zpu.toFixed(6)} p.u. (${(Zpu * 100).toFixed(4)}%)

─── Referred to HV side ───
Z_base(HV) = ${hvkv}² / ${base} = ${ZbaseHV.toFixed(4)} Ω
R = ${(Rpu * ZbaseHV).toFixed(4)} Ω,  X = ${(Xpu * ZbaseHV).toFixed(4)} Ω
|Z| = ${(Zpu * ZbaseHV).toFixed(4)} Ω

─── Referred to LV side ───
Z_base(LV) = ${lvkv}² / ${base} = ${ZbaseLV.toFixed(4)} Ω
R = ${(Rpu * ZbaseLV).toFixed(4)} Ω,  X = ${(Xpu * ZbaseLV).toFixed(4)} Ω
|Z| = ${(Zpu * ZbaseLV).toFixed(4)} Ω</div>
        </div>`;

    } else if (comp.type === 'cable') {
      const Vkv = comp.props.voltage_kv || 11;
      const len = comp.props.length_km || 1;
      const rpk = comp.props.r_per_km || 0;
      const xpk = comp.props.x_per_km || 0;
      const nPar = Math.max(1, comp.props.num_parallel || 1);
      const Zbase = (Vkv * Vkv) / base;
      const R = rpk * len;
      const X = xpk * len;
      const Rpu = R / Zbase / nPar;
      const Xpu = X / Zbase / nPar;
      const Zpu = Math.sqrt(Rpu * Rpu + Xpu * Xpu);
      const rated = comp.props.rated_amps || 400;
      const totalRated = rated * nPar;
      const ratedMVA = Math.sqrt(3) * Vkv * totalRated / 1000;
      const parNote = nPar > 1 ? `\nParallel cables = ${nPar}` : '';
      const parCalc = nPar > 1 ? `\n\n── Parallel cable division (÷${nPar}) ──
R_pu = ${(R / Zbase).toFixed(6)} / ${nPar} = ${Rpu.toFixed(6)} p.u.
X_pu = ${(X / Zbase).toFixed(6)} / ${nPar} = ${Xpu.toFixed(6)} p.u.
Total rated current = ${nPar} × ${rated} = ${totalRated} A` : '';
      html += `
        <div class="calc-step">
          <div class="calc-step-title">Per-Unit Impedance (Cable)</div>
          <div class="calc-formula">Base MVA = ${base} MVA
Voltage = ${Vkv} kV
Length = ${len} km
R = ${rpk} Ω/km,  X = ${xpk} Ω/km
Rated current = ${rated} A  (S_rated = ${ratedMVA.toFixed(3)} MVA)${parNote}

Z_base = V² / Base_MVA = ${Vkv}² / ${base} = ${Zbase.toFixed(4)} Ω

R_total = ${rpk} × ${len} = ${R.toFixed(4)} Ω
X_total = ${xpk} × ${len} = ${X.toFixed(4)} Ω
Z_total = √(R² + X²) = ${Math.sqrt(R * R + X * X).toFixed(4)} Ω

R_pu = ${R.toFixed(4)} / ${Zbase.toFixed(4)} = ${(R / Zbase).toFixed(6)} p.u. (${((R / Zbase) * 100).toFixed(4)}%)
X_pu = ${X.toFixed(4)} / ${Zbase.toFixed(4)} = ${(X / Zbase).toFixed(6)} p.u. (${((X / Zbase) * 100).toFixed(4)}%)${parCalc}

Z_pu(eff) = ${Zpu.toFixed(6)} p.u. (${(Zpu * 100).toFixed(4)}%)

Voltage drop (at rated) ≈ √3 × I × R_eff / V
  = √3 × ${totalRated} × ${(R / nPar).toFixed(4)} / ${(Vkv * 1000).toFixed(0)} = ${(Math.sqrt(3) * totalRated * (R / nPar) / (Vkv * 1000) * 100).toFixed(3)}% (R only)</div>
        </div>`;

    } else if (comp.type === 'motor_induction') {
      const kw = comp.props.rated_kw || 200;
      const vkv = comp.props.voltage_kv || 0.4;
      const eff = comp.props.efficiency || 0.93;
      const pf = comp.props.power_factor || 0.85;
      const xpp = comp.props.x_pp || 0.17;
      const xr = comp.props.x_r_ratio || 10;
      const lrc = comp.props.locked_rotor_current || 6;
      // S = P / (η·cosφ) per IEC 60909-0 §3.8 (matches the backend engines)
      const kva = kw / (eff * pf);
      const mva = kva / 1000;
      // Engine convention (fault.py _motor_induction_impedance): x_pp is X"
      // (locked-rotor reactance) on motor base; R is added on top via R = X/(X/R)
      const Xpu_motor = xpp;  // X" on motor rating
      const Rpu_motor = Xpu_motor / xr;
      const Zpu_motor = Xpu_motor * Math.sqrt(1 + 1 / (xr * xr));  // |Z"| = X"·√(1+1/(X/R)²)
      const Xpu = Xpu_motor * base / mva;
      const Rpu = Xpu / xr;
      const Zpu = Xpu * Math.sqrt(1 + 1 / (xr * xr));
      const Zbase = (vkv * vkv) / base;
      const iRated = (kva) / (Math.sqrt(3) * vkv * 1000);
      const iStart = iRated * lrc;
      html += `
        <div class="calc-step">
          <div class="calc-step-title">Per-Unit Impedance (Induction Motor)</div>
          <div class="calc-formula">Base MVA = ${base} MVA
Rated = ${kw} kW at ${vkv} kV
Efficiency = ${(eff * 100).toFixed(1)}%
Power Factor = ${pf}
X/R Ratio = ${xr}

Input kVA = P / (η × cosφ) = ${kw} / (${eff} × ${pf}) = ${kva.toFixed(1)} kVA (${mva.toFixed(4)} MVA)
I_rated = ${(iRated * 1000).toFixed(2)} A
I_start = ${lrc} × I_rated = ${(iStart * 1000).toFixed(2)} A

X"_pu (locked-rotor reactance, on motor rating) = ${Xpu_motor} p.u.
R" = X" / (X/R) = ${Rpu_motor.toFixed(6)} p.u.
|Z"| = X" × √(1 + 1/(X/R)²) = ${Zpu_motor.toFixed(6)} p.u.

─── On System Base ───
X"_pu = X" × (Base_MVA / Rated_MVA) = ${Xpu_motor} × (${base} / ${mva.toFixed(4)}) = ${Xpu.toFixed(4)} p.u. (${(Xpu * 100).toFixed(2)}%)
R"_pu = X"_pu / (X/R) = ${Rpu.toFixed(6)} p.u. (${(Rpu * 100).toFixed(4)}%)
|Z"_pu| = X"_pu × √(1 + 1/(X/R)²) = ${Zpu.toFixed(4)} p.u. (${(Zpu * 100).toFixed(2)}%)
Z = ${Rpu.toFixed(6)} + j${Xpu.toFixed(6)} p.u.

─── Actual Impedance ───
Z_base = ${vkv}² / ${base} = ${Zbase.toFixed(4)} Ω
R = ${(Rpu * Zbase).toFixed(4)} Ω,  X = ${(Xpu * Zbase).toFixed(4)} Ω

─── Fault Contribution (IEC 60909-0 §13) ───
I"k_motor = c / Z"_pu × I_base (at faulted bus)
Sub-transient current decays within ~100ms for induction motors.
Motor acts as a voltage source behind Z" during fault.

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
X"d_pu = ${xdpp} × (${base} / ${mva.toFixed(4)}) = ${Xpu.toFixed(4)} p.u. (${(Xpu * 100).toFixed(2)}%)

─── Fault Contribution (IEC 60909-0 §13) ───
I"k_motor = c / X"d_pu × I_base (at faulted bus)
Synchronous motors contribute sustained fault current (like generators).
Motor acts as a voltage source behind X"d during fault.

─── Power Consumption ───
P = ${(mva * pf).toFixed(4)} MW
Q = ${(mva * Math.sqrt(1 - pf * pf)).toFixed(4)} MVAr</div>
        </div>`;

    } else if (comp.type === 'static_load') {
      const kva = comp.props.rated_kva || 100;
      const vkv = comp.props.voltage_kv || 0.4;
      const pf = comp.props.power_factor || 0.85;
      const mva = kva / 1000;
      const conn = comp.props.phase_connection || '3P';
      const iRated = this._staticLoadRatedAmps(comp.props) || 0;
      const iFormula = conn.startsWith('1P') ? 'I_rated = S / V_LN (V_LN = V/√3)'
        : conn.startsWith('2P') ? 'I_rated = S / V_LL'
        : 'I_rated = S / (√3 × V)';
      html += `
        <div class="calc-step">
          <div class="calc-step-title">Load Summary (Static Load)</div>
          <div class="calc-formula">Rated = ${kva} kVA at ${vkv} kV
Power Factor = ${pf}
Load Type = ${comp.props.load_type || 'constant_power'}
Connection = ${conn}

${iFormula} = ${iRated.toFixed(2)} A

P = S × PF = ${(mva * pf).toFixed(4)} MW (${(mva * pf * 1000).toFixed(1)} kW)
Q = S × sin(φ) = ${(mva * Math.sqrt(1 - pf * pf)).toFixed(4)} MVAr

P_pu = ${(mva * pf / base).toFixed(6)} p.u. (${(mva * pf / base * 100).toFixed(4)}%)
Q_pu = ${(mva * Math.sqrt(1 - pf * pf) / base).toFixed(6)} p.u. (${(mva * Math.sqrt(1 - pf * pf) / base * 100).toFixed(4)}%)</div>
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
Q_pu = ${(mvar / base).toFixed(6)} p.u. (${(mvar / base * 100).toFixed(4)}%) (injected)</div>
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

  // Clear properties panel — show project details form
  clear() {
    this.currentId = null;
    this._dismissInfoPopup();
    document.getElementById('properties-title').textContent = 'Project Details';
    this.contentEl.innerHTML = this._renderProjectDetails();
    this.calcInfoEl.style.display = 'none';
    this._bindProjectDetailsEvents();
  },

  _renderProjectDetails() {
    const d = AppState.projectDetails;
    const pName = AppState.projectName || '';
    return `
      <div class="project-details-form">
        <div class="prop-section">
          <div class="prop-section-title">Project Information</div>
          <div class="prop-row">
            <label>Project Name</label>
            <input type="text" data-project-field="projectName" value="${this._esc(pName)}" />
          </div>
          <div class="prop-row">
            <label>Project Number</label>
            <input type="text" data-project-field="projectNumber" value="${this._esc(d.projectNumber)}" />
          </div>
          <div class="prop-row">
            <label>Client</label>
            <input type="text" data-project-field="client" value="${this._esc(d.client)}" />
          </div>
          <div class="prop-row">
            <label>Company</label>
            <input type="text" data-project-field="company" value="${this._esc(d.company)}" />
          </div>
          <div class="prop-row">
            <label>Description</label>
            <textarea data-project-field="description" rows="3">${this._esc(d.description)}</textarea>
          </div>
        </div>
        <div class="prop-section">
          <div class="prop-section-title">Personnel</div>
          <div class="prop-row">
            <label>Engineer</label>
            <input type="text" data-project-field="engineerName" value="${this._esc(d.engineerName)}" />
          </div>
          <div class="prop-row">
            <label>Checked By</label>
            <input type="text" data-project-field="checkedBy" value="${this._esc(d.checkedBy)}" />
          </div>
          <div class="prop-row">
            <label>Approved By</label>
            <input type="text" data-project-field="approvedBy" value="${this._esc(d.approvedBy)}" />
          </div>
        </div>
        <div class="prop-section">
          <div class="prop-section-title">Revision</div>
          <div class="prop-row">
            <label>Revision No.</label>
            <input type="text" data-project-field="revisionNumber" value="${this._esc(d.revisionNumber)}" />
          </div>
          <div class="prop-row">
            <label>Date</label>
            <input type="date" data-project-field="date" value="${d.date || ''}" />
          </div>
        </div>
        <div class="prop-section">
          <div class="prop-section-title">Company Logo</div>
          <div class="logo-upload-area">
            ${d.companyLogo
              ? `<div class="logo-preview"><img src="${d.companyLogo}" alt="Company Logo" /><button class="btn-remove-logo" title="Remove logo">&times;</button></div>`
              : '<div class="logo-placeholder">No logo uploaded</div>'}
            <label class="btn btn-small btn-secondary logo-upload-btn">
              ${d.companyLogo ? 'Change Logo' : 'Upload Logo'}
              <input type="file" accept="image/*" id="logo-file-input" hidden />
            </label>
          </div>
        </div>
      </div>`;
  },

  _esc(val) {
    if (!val) return '';
    return String(val).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  },

  _bindProjectDetailsEvents() {
    // Text/date field bindings
    this.contentEl.querySelectorAll('[data-project-field]').forEach(el => {
      el.addEventListener('input', () => {
        const field = el.dataset.projectField;
        if (field === 'projectName') {
          AppState.projectName = el.value;
          document.getElementById('project-name-display').textContent = el.value || 'Untitled Project';
        } else {
          AppState.projectDetails[field] = el.value;
        }
        AppState.dirty = true;
      });
    });

    // Logo upload
    const fileInput = this.contentEl.querySelector('#logo-file-input');
    if (fileInput) {
      fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (file.size > 2 * 1024 * 1024) {
          UI.toast('Logo file must be under 2 MB.', 'error');
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          AppState.projectDetails.companyLogo = reader.result;
          AppState.dirty = true;
          this.clear(); // re-render to show preview
        };
        reader.readAsDataURL(file);
      });
    }

    // Logo remove button
    const removeBtn = this.contentEl.querySelector('.btn-remove-logo');
    if (removeBtn) {
      removeBtn.addEventListener('click', () => {
        AppState.projectDetails.companyLogo = null;
        AppState.dirty = true;
        this.clear(); // re-render
      });
    }
  },
};
