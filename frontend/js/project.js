/* ProtectionPro — Project Save/Load & Export */

const Project = {
  init() {
    document.getElementById('btn-new').addEventListener('click', () => this.newProject());
    document.getElementById('btn-save').addEventListener('click', () => this.saveProject());
    document.getElementById('btn-open').addEventListener('click', () => this.openProject());
    document.getElementById('btn-save-as').addEventListener('click', () => this.saveAsProject());

    // Export dropdown toggle
    const exportBtn = document.getElementById('btn-export');
    const exportMenu = document.getElementById('export-menu');
    exportBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      exportMenu.classList.toggle('open');
    });
    // Close dropdown on outside click
    document.addEventListener('click', () => exportMenu.classList.remove('open'));

    // Export actions
    document.getElementById('btn-export-json').addEventListener('click', () => { exportMenu.classList.remove('open'); this.exportJSON(); });
    document.getElementById('btn-export-svg').addEventListener('click', () => { exportMenu.classList.remove('open'); this.exportSVG(); });
    document.getElementById('btn-export-png').addEventListener('click', () => { exportMenu.classList.remove('open'); this.exportPNG(); });
    document.getElementById('btn-export-csv').addEventListener('click', () => { exportMenu.classList.remove('open'); this.exportResultsCSV(); });
  },

  newProject() {
    if (AppState.dirty) {
      if (!confirm('You have unsaved changes. Create new project?')) return;
    }
    AppState.reset();
    Canvas.updateTransform();
    Canvas.render();
    Properties.clear();
    document.title = 'ProtectionPro — New Project';
  },

  // Save to database (primary save action), falls back to JSON export
  async saveProject() {
    if (AppState.projectName === 'Untitled Project') {
      const name = prompt('Project name:', AppState.projectName);
      if (!name) return;
      AppState.projectName = name;
    }

    document.getElementById('status-info').textContent = 'Saving...';
    try {
      const result = await API.saveProject();
      AppState.projectId = result.id;
      AppState.dirty = false;
      document.title = `ProtectionPro — ${AppState.projectName}`;
      document.getElementById('status-info').textContent = 'Project saved.';
      setTimeout(() => {
        document.getElementById('status-info').textContent = '';
      }, 3000);
    } catch (e) {
      // Backend unavailable — fall back to JSON export
      document.getElementById('status-info').textContent = 'Database unavailable, exporting JSON...';
      this.exportJSON();
      AppState.dirty = false;
      document.title = `ProtectionPro — ${AppState.projectName}`;
    }
  },

  // Save As: prompt for new name and save as a new project
  async saveAsProject() {
    const name = prompt('Save as project name:', AppState.projectName + ' (copy)');
    if (!name) return;
    AppState.projectName = name;
    AppState.projectId = null; // Force create new project

    document.getElementById('status-info').textContent = 'Saving...';
    try {
      const result = await API.saveProject();
      AppState.projectId = result.id;
      AppState.dirty = false;
      document.title = `ProtectionPro — ${AppState.projectName}`;
      document.getElementById('status-info').textContent = 'Project saved as new copy.';
      setTimeout(() => {
        document.getElementById('status-info').textContent = '';
      }, 3000);
    } catch (e) {
      document.getElementById('status-info').textContent = 'Database unavailable, exporting JSON...';
      this.exportJSON();
      AppState.dirty = false;
      document.title = `ProtectionPro — ${AppState.projectName}`;
    }
  },

  // Export as JSON file (download)
  exportJSON() {
    const data = AppState.toJSON();
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${AppState.projectName || 'project'}.json`;
    a.click();
    URL.revokeObjectURL(url);
    this._statusMsg('Exported project as JSON.');
  },

  // Export diagram as SVG
  exportSVG() {
    const svg = document.getElementById('sld-canvas');
    // Clone the SVG to modify it for export
    const clone = svg.cloneNode(true);

    // Calculate bounding box from components
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const comp of AppState.components.values()) {
      const def = COMPONENT_DEFS[comp.type];
      const hw = (def.width || 60) / 2 + 80;
      const hh = (def.height || 60) / 2 + 80;
      minX = Math.min(minX, comp.x - hw);
      minY = Math.min(minY, comp.y - hh);
      maxX = Math.max(maxX, comp.x + hw);
      maxY = Math.max(maxY, comp.y + hh);
    }
    if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 800; maxY = 600; }

    const pad = 50;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const w = maxX - minX;
    const h = maxY - minY;

    clone.setAttribute('viewBox', `${minX} ${minY} ${w} ${h}`);
    clone.setAttribute('width', w);
    clone.setAttribute('height', h);

    // Remove the grid background and overlay layer for clean export
    const grid = clone.querySelector('#grid-bg');
    if (grid) grid.remove();
    const overlay = clone.querySelector('#overlay-layer');
    if (overlay) overlay.remove();

    // Reset diagram layer transform
    const diagram = clone.querySelector('#diagram-layer');
    if (diagram) diagram.setAttribute('transform', '');

    // Inject styles inline for standalone SVG
    const style = document.createElement('style');
    style.textContent = `
      .sld-wire { fill: none; stroke: #333; stroke-width: 2; }
      .sld-wire.selected { stroke: #0078d7; }
      .conn-port { r: 3; fill: #666; stroke: #666; }
      .conn-port-hit { display: none; }
      .symbol-bus { stroke: #222; stroke-width: 4; }
      .annotation-badge { rx: 4; ry: 4; }
      .fault-annotation .annotation-badge { fill: #fff3e0; stroke: #ff9800; stroke-width: 1; }
      .loadflow-annotation .annotation-badge { fill: #e8f5e9; stroke: #4caf50; stroke-width: 1; }
      .annotation-text { font-family: monospace; font-size: 10px; fill: #333; }
      .annotation-label { font-size: 9px; fill: #999; }
      .comp-data-label { font-family: monospace; font-size: 9px; fill: #555; }
      text { font-family: sans-serif; }
    `;
    clone.insertBefore(style, clone.firstChild);

    const svgStr = new XMLSerializer().serializeToString(clone);
    const blob = new Blob([svgStr], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${AppState.projectName || 'diagram'}.svg`;
    a.click();
    URL.revokeObjectURL(url);
    this._statusMsg('Exported diagram as SVG.');
  },

  // Export diagram as PNG
  exportPNG() {
    const svg = document.getElementById('sld-canvas');
    const clone = svg.cloneNode(true);

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const comp of AppState.components.values()) {
      const def = COMPONENT_DEFS[comp.type];
      const hw = (def.width || 60) / 2 + 80;
      const hh = (def.height || 60) / 2 + 80;
      minX = Math.min(minX, comp.x - hw);
      minY = Math.min(minY, comp.y - hh);
      maxX = Math.max(maxX, comp.x + hw);
      maxY = Math.max(maxY, comp.y + hh);
    }
    if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 800; maxY = 600; }

    const pad = 50;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const w = maxX - minX;
    const h = maxY - minY;
    const scale = 2; // 2x resolution

    clone.setAttribute('viewBox', `${minX} ${minY} ${w} ${h}`);
    clone.setAttribute('width', w * scale);
    clone.setAttribute('height', h * scale);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

    const grid = clone.querySelector('#grid-bg');
    if (grid) grid.remove();
    const overlay = clone.querySelector('#overlay-layer');
    if (overlay) overlay.remove();
    const diagram = clone.querySelector('#diagram-layer');
    if (diagram) diagram.setAttribute('transform', '');

    // Inject inline styles
    const style = document.createElement('style');
    style.textContent = `
      .sld-wire { fill: none; stroke: #333; stroke-width: 2; }
      .conn-port { r: 3; fill: #666; stroke: #666; }
      .conn-port-hit { display: none; }
      .symbol-bus { stroke: #222; stroke-width: 4; }
      .annotation-badge { rx: 4; ry: 4; }
      .fault-annotation .annotation-badge { fill: #fff3e0; stroke: #ff9800; stroke-width: 1; }
      .loadflow-annotation .annotation-badge { fill: #e8f5e9; stroke: #4caf50; stroke-width: 1; }
      .annotation-text { font-family: monospace; font-size: 10px; fill: #333; }
      .annotation-label { font-size: 9px; fill: #999; }
      .comp-data-label { font-family: monospace; font-size: 9px; fill: #555; }
      text { font-family: sans-serif; }
      * { shape-rendering: geometricPrecision; }
    `;
    clone.insertBefore(style, clone.firstChild);

    const svgStr = new XMLSerializer().serializeToString(clone);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = w * scale;
      canvas.height = h * scale;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      canvas.toBlob((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${AppState.projectName || 'diagram'}.png`;
        a.click();
        URL.revokeObjectURL(url);
        Project._statusMsg('Exported diagram as PNG.');
      }, 'image/png');
    };
    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgStr)));
  },

  // Export analysis results as CSV (client-side, no backend needed)
  exportResultsCSV() {
    const rows = [];
    const name = AppState.projectName || 'project';

    // Fault results
    if (AppState.faultResults && AppState.faultResults.buses) {
      rows.push(['=== FAULT ANALYSIS (IEC 60909) ===']);
      rows.push(['Bus ID', 'Bus Name', 'Voltage (kV)', 'I"k3 (kA)', 'I"k1 (kA)', 'I"kLL (kA)']);
      for (const [busId, r] of Object.entries(AppState.faultResults.buses)) {
        const comp = AppState.components.get(busId);
        const busName = comp?.props?.name || busId;
        rows.push([busId, busName, r.voltage_kv ?? '', r.ik3 ?? '', r.ik1 ?? '', r.ikLL ?? '']);
      }
      rows.push([]);
    }

    // Load flow bus results
    if (AppState.loadFlowResults && AppState.loadFlowResults.buses) {
      const lf = AppState.loadFlowResults;
      rows.push(['=== LOAD FLOW RESULTS ===']);
      rows.push(['Method', lf.method, 'Converged', lf.converged, 'Iterations', lf.iterations]);
      rows.push([]);
      rows.push(['Bus ID', 'Bus Name', 'V (p.u.)', 'V (kV)', 'Angle (deg)', 'P (MW)', 'Q (MVAr)']);
      for (const [busId, r] of Object.entries(lf.buses)) {
        const comp = AppState.components.get(busId);
        const busName = comp?.props?.name || busId;
        rows.push([busId, busName, r.voltage_pu, r.voltage_kv, r.angle_deg, r.p_mw, r.q_mvar]);
      }
      rows.push([]);

      // Branch flows
      if (lf.branches && lf.branches.length > 0) {
        rows.push(['=== BRANCH FLOWS ===']);
        rows.push(['Element ID', 'Element Name', 'From Bus', 'To Bus', 'P (MW)', 'Q (MVAr)', 'S (MVA)', 'I (A)', 'Loading (%)', 'Losses (MW)']);
        for (const br of lf.branches) {
          rows.push([
            br.elementId, br.element_name || '', br.from_bus, br.to_bus,
            br.p_mw, br.q_mvar, br.s_mva, br.i_amps, br.loading_pct, br.losses_mw
          ]);
        }
      }
    }

    if (rows.length === 0) {
      this._statusMsg('No analysis results to export. Run fault or load flow first.');
      return;
    }

    const csv = rows.map(row => row.map(cell => {
      const s = String(cell ?? '');
      return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(',')).join('\n');

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}_results.csv`;
    a.click();
    URL.revokeObjectURL(url);
    this._statusMsg('Exported analysis results as CSV.');
  },

  _statusMsg(msg) {
    document.getElementById('status-info').textContent = msg;
    setTimeout(() => { document.getElementById('status-info').textContent = ''; }, 3000);
  },

  // Import from JSON file
  importFromFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const data = JSON.parse(ev.target.result);
          AppState.fromJSON(data);
          AppState.projectId = null; // imported files don't have a DB id
          Canvas.updateTransform();
          Canvas.render();
          Properties.clear();
          document.title = `ProtectionPro — ${AppState.projectName}`;
          document.getElementById('status-info').textContent = 'Project imported from file.';
        } catch (err) {
          alert('Invalid project file: ' + err.message);
        }
      };
      reader.readAsText(file);
    });
    input.click();
  },

  // Open project from database, with option to import from file
  async openProject() {
    try {
      const projects = await API.listProjects();
      this.showProjectPicker(projects || []);
    } catch (e) {
      // Backend not available — show picker with just import option
      this.showProjectPicker([]);
    }
  },

  showProjectPicker(projects) {
    // Build project list HTML
    let listHtml = '';
    if (projects.length === 0) {
      listHtml = '<p style="color:#888;padding:12px;">No saved projects found.</p>';
    } else {
      listHtml = projects.map(p => `
        <div class="project-item" data-id="${p.id}">
          <div class="project-item-info">
            <strong>${p.name}</strong>
            <small>${new Date(p.updated_at).toLocaleDateString()}</small>
          </div>
          <button class="btn-delete-project" data-id="${p.id}" title="Delete project">&times;</button>
        </div>
      `).join('');
    }

    // Use a dedicated picker modal (reuse calc-modal structure)
    const modal = document.getElementById('calc-modal');
    modal.querySelector('#calc-modal-title').textContent = 'Open Project';
    modal.querySelector('#calc-modal-body').innerHTML = `
      <div class="project-list">${listHtml}</div>
      <div style="display:flex;gap:8px;margin-top:16px;">
        <button id="picker-import-json" class="btn-primary">Import from JSON file...</button>
      </div>
    `;
    modal.style.display = '';

    // Bind import button
    document.getElementById('picker-import-json').addEventListener('click', () => {
      modal.style.display = 'none';
      this.importFromFile();
    });

    // Bind project items
    modal.querySelectorAll('.project-item').forEach(el => {
      el.querySelector('.project-item-info')?.addEventListener('click', async () => {
        try {
          const data = await API.loadProject(el.dataset.id);
          AppState.fromJSON(data);
          AppState.projectId = el.dataset.id;
          Canvas.updateTransform();
          Canvas.render();
          Properties.clear();
          document.title = `ProtectionPro — ${AppState.projectName}`;
          document.getElementById('status-info').textContent = 'Project loaded.';
        } catch (err) {
          alert('Failed to load project: ' + err.message);
        }
        modal.style.display = 'none';
      });
    });

    // Bind delete buttons
    modal.querySelectorAll('.btn-delete-project').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        if (!confirm('Delete this project permanently?')) return;
        try {
          await API.deleteProject(id);
          // If we deleted the currently open project, clear the ID
          if (AppState.projectId === id) AppState.projectId = null;
          // Refresh the picker
          const updated = await API.listProjects();
          this.showProjectPicker(updated || []);
        } catch (err) {
          alert('Failed to delete: ' + err.message);
        }
      });
    });
  },
};
