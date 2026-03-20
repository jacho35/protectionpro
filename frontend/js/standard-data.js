/* ProtectionPro — Standard Data Library Manager & Settings */

const StandardData = {
  // Working copies of libraries (editable by user)
  cables: [],
  transformers: [],

  init() {
    // Clone defaults into working copies
    this.cables = JSON.parse(JSON.stringify(STANDARD_CABLES));
    this.transformers = JSON.parse(JSON.stringify(STANDARD_TRANSFORMERS));

    this.bindTabs();
    this.bindCableTable();
    this.bindTransformerTable();
    this.bindIECStandards();
  },

  // ─── Tab Switching ───
  bindTabs() {
    document.querySelectorAll('.settings-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.settings-tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById(`settings-tab-${tab.dataset.tab}`).classList.add('active');
        // Render table when tab becomes active
        if (tab.dataset.tab === 'cables') this.renderCableTable();
        if (tab.dataset.tab === 'transformers') this.renderTransformerTable();
        if (tab.dataset.tab === 'iec-standards') this.renderIECActiveSection();
      });
    });
  },

  // ─── Cable Library Table ───
  bindCableTable() {
    document.getElementById('btn-add-cable').addEventListener('click', () => {
      const id = 'custom_cable_' + Date.now();
      this.cables.push({
        id, name: 'New Cable', conductor: 'Cu', insulation: 'XLPE',
        size_mm2: 0, voltage_kv: 11, r_per_km: 0, x_per_km: 0, rated_amps: 0,
      });
      this.renderCableTable();
      this.syncCableLibrary();
    });

    document.getElementById('btn-reset-cables').addEventListener('click', () => {
      this.cables = JSON.parse(JSON.stringify(STANDARD_CABLES));
      this.renderCableTable();
      this.syncCableLibrary();
    });
  },

  renderCableTable() {
    const tbody = document.getElementById('cable-library-body');
    tbody.innerHTML = this.cables.map((c, i) => `
      <tr data-index="${i}">
        <td><input type="text" value="${c.name}" data-key="name"></td>
        <td><select data-key="conductor">
          <option value="Cu" ${c.conductor === 'Cu' ? 'selected' : ''}>Cu</option>
          <option value="Al" ${c.conductor === 'Al' ? 'selected' : ''}>Al</option>
        </select></td>
        <td><input type="number" value="${c.size_mm2}" data-key="size_mm2" step="any"></td>
        <td><input type="number" value="${c.voltage_kv}" data-key="voltage_kv" step="any"></td>
        <td><input type="number" value="${c.r_per_km}" data-key="r_per_km" step="any"></td>
        <td><input type="number" value="${c.x_per_km}" data-key="x_per_km" step="any"></td>
        <td><input type="number" value="${c.rated_amps}" data-key="rated_amps" step="any"></td>
        <td><button class="btn-delete-row" data-index="${i}" title="Delete">&times;</button></td>
      </tr>
    `).join('');

    // Bind events
    tbody.querySelectorAll('input, select').forEach(input => {
      input.addEventListener('change', (e) => {
        const row = e.target.closest('tr');
        const idx = parseInt(row.dataset.index);
        const key = e.target.dataset.key;
        let val = e.target.value;
        if (e.target.type === 'number') val = parseFloat(val) || 0;
        this.cables[idx][key] = val;
        this.syncCableLibrary();
      });
    });

    tbody.querySelectorAll('.btn-delete-row').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt(e.target.dataset.index);
        this.cables.splice(idx, 1);
        this.renderCableTable();
        this.syncCableLibrary();
      });
    });
  },

  syncCableLibrary() {
    // Update the global STANDARD_CABLES array in-place
    STANDARD_CABLES.length = 0;
    for (const c of this.cables) STANDARD_CABLES.push(c);
  },

  // ─── Transformer Library Table ───
  bindTransformerTable() {
    document.getElementById('btn-add-xfmr').addEventListener('click', () => {
      const id = 'custom_xfmr_' + Date.now();
      this.transformers.push({
        id, name: 'New Transformer', rated_mva: 0, voltage_hv_kv: 11,
        voltage_lv_kv: 0.42, z_percent: 5, x_r_ratio: 10, vector_group: 'Dyn11',
      });
      this.renderTransformerTable();
      this.syncTransformerLibrary();
    });

    document.getElementById('btn-reset-xfmrs').addEventListener('click', () => {
      this.transformers = JSON.parse(JSON.stringify(STANDARD_TRANSFORMERS));
      this.renderTransformerTable();
      this.syncTransformerLibrary();
    });
  },

  renderTransformerTable() {
    const tbody = document.getElementById('xfmr-library-body');
    const vectors = ['Dyn11', 'Dyn1', 'YNd11', 'YNd1', 'Yyn0', 'Dd0'];
    tbody.innerHTML = this.transformers.map((t, i) => `
      <tr data-index="${i}">
        <td><input type="text" value="${t.name}" data-key="name"></td>
        <td><input type="number" value="${t.rated_mva}" data-key="rated_mva" step="any"></td>
        <td><input type="number" value="${t.voltage_hv_kv}" data-key="voltage_hv_kv" step="any"></td>
        <td><input type="number" value="${t.voltage_lv_kv}" data-key="voltage_lv_kv" step="any"></td>
        <td><input type="number" value="${t.z_percent}" data-key="z_percent" step="any"></td>
        <td><input type="number" value="${t.x_r_ratio}" data-key="x_r_ratio" step="any"></td>
        <td><select data-key="vector_group">
          ${vectors.map(v => `<option value="${v}" ${t.vector_group === v ? 'selected' : ''}>${v}</option>`).join('')}
        </select></td>
        <td><button class="btn-delete-row" data-index="${i}" title="Delete">&times;</button></td>
      </tr>
    `).join('');

    // Bind events
    tbody.querySelectorAll('input, select').forEach(input => {
      input.addEventListener('change', (e) => {
        const row = e.target.closest('tr');
        const idx = parseInt(row.dataset.index);
        const key = e.target.dataset.key;
        let val = e.target.value;
        if (e.target.type === 'number') val = parseFloat(val) || 0;
        this.transformers[idx][key] = val;
        this.syncTransformerLibrary();
      });
    });

    tbody.querySelectorAll('.btn-delete-row').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt(e.target.dataset.index);
        this.transformers.splice(idx, 1);
        this.renderTransformerTable();
        this.syncTransformerLibrary();
      });
    });
  },

  syncTransformerLibrary() {
    STANDARD_TRANSFORMERS.length = 0;
    for (const t of this.transformers) STANDARD_TRANSFORMERS.push(t);
  },

  // Open settings modal
  open() {
    document.getElementById('base-mva').value = AppState.baseMVA;
    document.getElementById('base-freq').value = AppState.frequency;
    document.getElementById('settings-modal').style.display = '';
    // Render the currently active tab's table
    const activeTab = document.querySelector('.settings-tab.active');
    if (activeTab.dataset.tab === 'cables') this.renderCableTable();
    else if (activeTab.dataset.tab === 'transformers') this.renderTransformerTable();
    else if (activeTab.dataset.tab === 'iec-standards') this.renderIECActiveSection();
  },

  // ═══════════════════════════════════════════════════════
  // ─── IEC Standards Database ───
  // ═══════════════════════════════════════════════════════

  bindIECStandards() {
    // Sub-tab switching
    document.querySelectorAll('.iec-subtab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.iec-subtab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.iec-section').forEach(s => s.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById(`iec-section-${tab.dataset.iec}`).classList.add('active');
        this.renderIECActiveSection();
      });
    });

    // Ampacity filter changes
    document.getElementById('iec-amp-conductor').addEventListener('change', () => this.renderAmpacityTable());
    document.getElementById('iec-amp-insulation').addEventListener('change', () => this.renderAmpacityTable());

    // Derating environment filter
    document.getElementById('iec-derating-env').addEventListener('change', () => this.renderTempTable());

    // Populate installation method dropdown for calculator
    const methodSelect = document.getElementById('iec-calc-method');
    for (const m of IEC_INSTALLATION_METHODS) {
      const opt = document.createElement('option');
      opt.value = m.code;
      opt.textContent = `${m.code} — ${m.description}`;
      methodSelect.appendChild(opt);
    }

    // Show/hide soil & depth fields based on method
    methodSelect.addEventListener('change', () => this._updateBuriedFields());

    // Calculator button
    document.getElementById('btn-iec-calculate').addEventListener('click', () => this.calculateCableSize());
  },

  _updateBuriedFields() {
    const method = document.getElementById('iec-calc-method').value;
    const isBuried = method.startsWith('D');
    document.getElementById('iec-soil-group').style.display = isBuried ? '' : 'none';
    document.getElementById('iec-depth-group').style.display = isBuried ? '' : 'none';
  },

  renderIECActiveSection() {
    const active = document.querySelector('.iec-subtab.active');
    if (!active) return;
    const section = active.dataset.iec;
    if (section === 'ampacity') this.renderAmpacityTable();
    else if (section === 'derating') { this.renderTempTable(); this.renderGroupTable(); this.renderSoilTable(); this.renderDepthTable(); }
    else if (section === 'voltage-factors') this.renderVoltageFactors();
  },

  // ─── Ampacity Reference Table ───
  renderAmpacityTable() {
    const conductor = document.getElementById('iec-amp-conductor').value;  // cu | al
    const insulation = document.getElementById('iec-amp-insulation').value; // xlpe | pvc
    const key = `${insulation}_${conductor}`;  // e.g. 'xlpe_cu'

    // Determine which methods have data for this combo
    const allMethods = ['A1', 'B1', 'C', 'D1', 'D2', 'E', 'F'];
    const methods = allMethods.filter(m => {
      // Check if any size has data for this method+key combo
      return Object.values(IEC_AMPACITY_TABLE).some(row => row[m] && row[m][key] != null);
    });

    // Header
    const thead = document.getElementById('iec-ampacity-head');
    thead.innerHTML = `<tr><th>Size (mm&sup2;)</th>${methods.map(m => `<th>${m}</th>`).join('')}</tr>`;

    // Body
    const tbody = document.getElementById('iec-ampacity-body');
    const rows = [];
    for (const size of IEC_STANDARD_SIZES) {
      const sizeData = IEC_AMPACITY_TABLE[size];
      if (!sizeData) continue;
      const cells = methods.map(m => {
        const val = sizeData[m] ? sizeData[m][key] : null;
        return `<td class="num-cell">${val != null ? val : '—'}</td>`;
      });
      rows.push(`<tr><td class="num-cell"><strong>${size}</strong></td>${cells.join('')}</tr>`);
    }
    tbody.innerHTML = rows.join('');
  },

  // ─── Temperature Correction Table ───
  renderTempTable() {
    const env = document.getElementById('iec-derating-env').value; // air | ground
    const data = IEC_TEMP_CORRECTION[env];

    const thead = document.getElementById('iec-temp-head');
    thead.innerHTML = `<tr><th>Ambient Temp (&deg;C)</th><th>PVC</th><th>XLPE</th></tr>`;

    const tbody = document.getElementById('iec-temp-body');
    // Collect all temperatures from both insulation types
    const temps = new Set();
    for (const t of Object.keys(data.pvc)) temps.add(Number(t));
    for (const t of Object.keys(data.xlpe)) temps.add(Number(t));
    const sorted = Array.from(temps).sort((a, b) => a - b);

    tbody.innerHTML = sorted.map(t => {
      const pvc = data.pvc[t];
      const xlpe = data.xlpe[t];
      const refClass = (env === 'air' && t === 30) || (env === 'ground' && t === 20) ? ' class="iec-ref-row"' : '';
      return `<tr${refClass}>
        <td class="num-cell">${t}</td>
        <td class="num-cell">${pvc != null ? pvc.toFixed(2) : '—'}</td>
        <td class="num-cell">${xlpe != null ? xlpe.toFixed(2) : '—'}</td>
      </tr>`;
    }).join('');
  },

  // ─── Grouping Factor Table ───
  renderGroupTable() {
    const arrangements = Object.keys(IEC_GROUPING_FACTORS);
    const labels = {
      bunched: 'Bunched / conduit',
      single_layer_wall: 'Single layer on wall',
      single_layer_floor: 'Single layer on floor',
      single_layer_tray_touching: 'Single layer tray (touching)',
      single_layer_tray_spaced: 'Single layer tray (spaced)',
      trefoil_tray_touching: 'Trefoil tray (touching)',
    };

    // Collect all circuit counts
    const counts = new Set();
    for (const arr of arrangements) {
      for (const n of Object.keys(IEC_GROUPING_FACTORS[arr])) counts.add(Number(n));
    }
    const sorted = Array.from(counts).sort((a, b) => a - b);

    const thead = document.getElementById('iec-group-head');
    thead.innerHTML = `<tr><th>Circuits</th>${arrangements.map(a => `<th>${labels[a] || a}</th>`).join('')}</tr>`;

    const tbody = document.getElementById('iec-group-body');
    tbody.innerHTML = sorted.map(n => {
      const cells = arrangements.map(a => {
        const val = IEC_GROUPING_FACTORS[a][n];
        return `<td class="num-cell">${val != null ? val.toFixed(2) : '—'}</td>`;
      });
      return `<tr><td class="num-cell">${n}</td>${cells.join('')}</tr>`;
    }).join('');
  },

  // ─── Soil Resistivity Table ───
  renderSoilTable() {
    const tbody = document.getElementById('iec-soil-body');
    tbody.innerHTML = Object.entries(IEC_SOIL_RESISTIVITY_FACTORS).map(([r, f]) => {
      const refClass = Number(r) === 2.5 ? ' class="iec-ref-row"' : '';
      return `<tr${refClass}><td class="num-cell">${r}</td><td class="num-cell">${f.toFixed(2)}</td></tr>`;
    }).join('');
  },

  // ─── Depth of Laying Table ───
  renderDepthTable() {
    const tbody = document.getElementById('iec-depth-body');
    tbody.innerHTML = Object.entries(IEC_DEPTH_FACTORS).map(([d, f]) => {
      const refClass = Number(d) === 0.7 ? ' class="iec-ref-row"' : '';
      return `<tr${refClass}><td class="num-cell">${d}</td><td class="num-cell">${f.toFixed(2)}</td></tr>`;
    }).join('');
  },

  // ─── IEC 60909 Voltage Factors ───
  renderVoltageFactors() {
    const tbody = document.getElementById('iec-vf-body');
    tbody.innerHTML = Object.entries(IEC_60909_VOLTAGE_FACTORS).map(([level, d]) => {
      const label = level === 'lv' ? 'Low Voltage' : level === 'mv' ? 'Medium Voltage' : 'High Voltage';
      return `<tr>
        <td><strong>${label}</strong></td>
        <td>${d.description}</td>
        <td class="num-cell">${d.cmax}</td>
        <td class="num-cell">${d.cmin}</td>
      </tr>`;
    }).join('');
  },

  // ═══════════════════════════════════════════════════════
  // ─── Cable Sizing Calculator ───
  // ═══════════════════════════════════════════════════════

  calculateCableSize() {
    const Ib = parseFloat(document.getElementById('iec-calc-current').value) || 0;
    const conductor = document.getElementById('iec-calc-conductor').value;
    const insulation = document.getElementById('iec-calc-insulation').value;
    const method = document.getElementById('iec-calc-method').value;
    const ambientTemp = parseFloat(document.getElementById('iec-calc-temp').value) || 30;
    const numCircuits = parseInt(document.getElementById('iec-calc-circuits').value) || 1;
    const groupArrangement = document.getElementById('iec-calc-grouping').value;
    const isBuried = method.startsWith('D');
    const soilRes = isBuried ? parseFloat(document.getElementById('iec-calc-soil').value) : 2.5;
    const depth = isBuried ? parseFloat(document.getElementById('iec-calc-depth').value) : 0.7;

    const key = `${insulation}_${conductor}`;

    // ── Calculate derating factors ──

    // 1. Temperature correction
    const env = isBuried ? 'ground' : 'air';
    const tempData = IEC_TEMP_CORRECTION[env][insulation];
    const tempFactor = this._interpolateFactor(tempData, ambientTemp);

    // 2. Grouping correction
    const groupData = IEC_GROUPING_FACTORS[groupArrangement] || IEC_GROUPING_FACTORS.bunched;
    const groupFactor = this._interpolateFactor(groupData, numCircuits);

    // 3. Soil resistivity correction (buried only)
    const soilFactor = isBuried ? this._interpolateFactor(IEC_SOIL_RESISTIVITY_FACTORS, soilRes) : 1.0;

    // 4. Depth correction (buried only)
    const depthFactor = isBuried ? this._interpolateFactor(IEC_DEPTH_FACTORS, depth) : 1.0;

    // Combined derating
    const totalDerating = tempFactor * groupFactor * soilFactor * depthFactor;

    // Required base ampacity: Iz = Ib / (k1 × k2 × k3 × k4)
    const requiredIz = Ib / totalDerating;

    // ── Find suitable cable size ──
    const results = [];
    let selectedSize = null;
    let selectedIz = null;

    for (const size of IEC_STANDARD_SIZES) {
      const sizeData = IEC_AMPACITY_TABLE[size];
      if (!sizeData || !sizeData[method]) continue;
      const baseAmpacity = sizeData[method][key];
      if (baseAmpacity == null) continue;

      const deratedAmpacity = baseAmpacity * totalDerating;
      const adequate = deratedAmpacity >= Ib;

      results.push({ size, baseAmpacity, deratedAmpacity, adequate });

      if (adequate && !selectedSize) {
        selectedSize = size;
        selectedIz = baseAmpacity;
      }
    }

    // ── Render results ──
    const resultsDiv = document.getElementById('iec-calc-results');
    resultsDiv.style.display = '';

    if (results.length === 0) {
      resultsDiv.innerHTML = `<div class="iec-calc-error">No ampacity data available for method <strong>${method}</strong> with <strong>${insulation.toUpperCase()} ${conductor === 'cu' ? 'Copper' : 'Aluminium'}</strong>. Try a different installation method.</div>`;
      return;
    }

    const factorRows = [
      ['Temperature', `${ambientTemp}°C ${env}`, tempFactor.toFixed(3)],
      ['Grouping', `${numCircuits} circuit(s), ${groupArrangement.replace(/_/g, ' ')}`, groupFactor.toFixed(3)],
    ];
    if (isBuried) {
      factorRows.push(['Soil resistivity', `${soilRes} K·m/W`, soilFactor.toFixed(3)]);
      factorRows.push(['Depth of laying', `${depth} m`, depthFactor.toFixed(3)]);
    }

    let html = `
      <h4>Derating Factors Applied</h4>
      <table class="library-table iec-ref-table iec-compact">
        <thead><tr><th>Factor</th><th>Condition</th><th>Value</th></tr></thead>
        <tbody>
          ${factorRows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td><td class="num-cell">${r[2]}</td></tr>`).join('')}
          <tr class="iec-total-row"><td><strong>Combined</strong></td><td></td><td class="num-cell"><strong>${totalDerating.toFixed(3)}</strong></td></tr>
        </tbody>
      </table>

      <div class="iec-calc-required">
        Required base ampacity: I<sub>z</sub> = ${Ib} A &divide; ${totalDerating.toFixed(3)} = <strong>${requiredIz.toFixed(1)} A</strong>
      </div>
    `;

    if (selectedSize) {
      html += `
        <div class="iec-calc-recommendation">
          Recommended cable: <strong>${selectedSize} mm&sup2; ${conductor === 'cu' ? 'Copper' : 'Aluminium'} ${insulation.toUpperCase()}</strong><br>
          Base ampacity: ${selectedIz} A &nbsp;|&nbsp; Derated: ${(selectedIz * totalDerating).toFixed(1)} A &nbsp;|&nbsp;
          Margin: ${(((selectedIz * totalDerating) / Ib - 1) * 100).toFixed(1)}%
        </div>
      `;
    } else {
      html += `<div class="iec-calc-error">No standard cable size is adequate for ${Ib} A with these conditions.<br>Consider reducing derating factors, using a different installation method, or running parallel cables.</div>`;
    }

    html += `
      <h4>All Cable Sizes — Method ${method}</h4>
      <table class="library-table iec-ref-table iec-compact">
        <thead><tr><th>Size (mm&sup2;)</th><th>Base I<sub>z</sub> (A)</th><th>Derated I<sub>z</sub> (A)</th><th>Status</th></tr></thead>
        <tbody>
          ${results.map(r => {
            const cls = r.adequate ? (r.size === selectedSize ? 'iec-selected-row' : 'iec-ok-row') : 'iec-fail-row';
            const status = r.adequate ? (r.size === selectedSize ? 'SELECTED' : 'OK') : 'Too small';
            return `<tr class="${cls}">
              <td class="num-cell">${r.size}</td>
              <td class="num-cell">${r.baseAmpacity}</td>
              <td class="num-cell">${r.deratedAmpacity.toFixed(1)}</td>
              <td>${status}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    `;

    resultsDiv.innerHTML = html;
  },

  // Linear interpolation/nearest-value lookup for factor tables
  _interpolateFactor(table, value) {
    const keys = Object.keys(table).map(Number).sort((a, b) => a - b);
    if (keys.length === 0) return 1.0;

    // Exact match
    if (table[value] != null) return table[value];

    // Below range
    if (value <= keys[0]) return table[keys[0]];
    // Above range
    if (value >= keys[keys.length - 1]) return table[keys[keys.length - 1]];

    // Interpolate between two nearest points
    let lo = keys[0], hi = keys[keys.length - 1];
    for (let i = 0; i < keys.length - 1; i++) {
      if (keys[i] <= value && keys[i + 1] >= value) {
        lo = keys[i];
        hi = keys[i + 1];
        break;
      }
    }
    const frac = (value - lo) / (hi - lo);
    return table[lo] + frac * (table[hi] - table[lo]);
  },
};
