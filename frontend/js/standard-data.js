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
  },
};
