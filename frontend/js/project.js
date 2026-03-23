/* ProtectionPro — Project Save/Load & Export */

const Project = {
  init() {
    document.getElementById('btn-new').addEventListener('click', () => this.newProject());
    document.getElementById('btn-save').addEventListener('click', () => this.saveProject());
    document.getElementById('btn-open').addEventListener('click', () => this.openProject());
    document.getElementById('btn-save-as').addEventListener('click', () => this.saveAsProject());

    // Export actions (items live inside the File menu)
    document.getElementById('btn-export-json').addEventListener('click', () => { window.closeAllToolbarMenus?.(); this.exportJSON(); });
    document.getElementById('btn-export-svg').addEventListener('click', () => { window.closeAllToolbarMenus?.(); this.exportSVG(); });
    document.getElementById('btn-export-png').addEventListener('click', () => { window.closeAllToolbarMenus?.(); this.exportPNG(); });
    document.getElementById('btn-export-csv').addEventListener('click', () => { window.closeAllToolbarMenus?.(); this.exportResultsCSV(); });
    document.getElementById('btn-export-pdf').addEventListener('click', () => { window.closeAllToolbarMenus?.(); this.exportPDF(); });
    document.getElementById('btn-export-template').addEventListener('click', () => { window.closeAllToolbarMenus?.(); Reports.showTemplateEditor(); });
    document.getElementById('btn-export-settings').addEventListener('click', () => { window.closeAllToolbarMenus?.(); Reports.exportSettingsCSV(); });
    document.getElementById('btn-export-aflabels').addEventListener('click', () => { window.closeAllToolbarMenus?.(); Reports.exportArcFlashLabels(); });
    document.getElementById('btn-export-compare').addEventListener('click', () => { window.closeAllToolbarMenus?.(); Reports.showComparisonDialog(); });
    document.getElementById('btn-export-calculations').addEventListener('click', () => { window.closeAllToolbarMenus?.(); Reports.exportCalculationsReport(); });
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

  // ── Shared export helpers ──

  // Complete CSS for standalone SVG rendering — all symbol classes,
  // annotations, wires, ports — with CSS variables resolved to literals.
  _getExportCSS() {
    return `
      /* Wires */
      .sld-wire { fill: none; stroke: #333; stroke-width: 2; }
      .sld-wire.selected { stroke: #0078d7; stroke-width: 2.5; }

      /* Ports */
      .conn-port { r: 3; fill: #666; stroke: #666; stroke-width: 1.5; }
      .conn-port-hit { display: none; }
      .conn-port.connected { fill: #555; stroke: #555; }

      /* Bus bar */
      .bus-bar { stroke: #222; stroke-width: 4; stroke-linecap: round; }

      /* ── Symbol classes (every component type) ── */
      .symbol-bus { stroke: #222; stroke-width: 4; }
      .symbol-transformer { stroke: #333; stroke-width: 1.5; fill: none; }
      .symbol-generator { stroke: #2e7d32; stroke-width: 1.5; fill: none; }
      .symbol-utility { stroke: #1565c0; stroke-width: 1.5; fill: none; }
      .symbol-motor { stroke: #6a1b9a; stroke-width: 1.5; fill: none; }
      .symbol-cable { stroke: #555; stroke-width: 2; fill: none; }
      .symbol-cb { stroke: #d32f2f; stroke-width: 1.5; }
      .symbol-switch { stroke: #333; stroke-width: 1.5; }
      .symbol-fuse { stroke: #e65100; stroke-width: 1.5; fill: none; }
      .symbol-relay { stroke: #1565c0; stroke-width: 1.5; fill: none; }
      .symbol-ct { stroke: #555; stroke-width: 1.5; fill: none; }
      .symbol-pt { stroke: #555; stroke-width: 1.5; fill: none; }
      .symbol-arrester { stroke: #2e7d32; stroke-width: 1.5; fill: none; }
      .symbol-load { stroke: #555; stroke-width: 1.5; fill: none; }
      .symbol-capacitor { stroke: #0097a7; stroke-width: 1.5; fill: none; }

      /* Selection outline (render neutral in export) */
      .comp-outline { stroke: none; fill: none; }
      .select-handle { display: none; }

      /* Annotations — CSS vars resolved to actual hex values */
      .annotation-badge { rx: 4; ry: 4; }
      .fault-annotation .annotation-badge { fill: #fff3e0; stroke: #f57c00; stroke-width: 1; }
      .loadflow-annotation .annotation-badge { fill: #e8f5e9; stroke: #2e7d32; stroke-width: 1; }
      .annotation-text { font-family: "Courier New", Courier, monospace; font-size: 10px; fill: #1a1a2e; }
      .annotation-label { font-size: 9px; fill: #888; }

      /* Data labels */
      .comp-data-label { font-family: "Courier New", Courier, monospace; font-size: 9px; fill: #555; }
      .cable-size-label { font-family: "Courier New", Courier, monospace; }

      /* Overload / warning flags */
      .overload-flag { opacity: 1; }
      .unconnected-warning { opacity: 0.8; }

      /* General text fallback */
      text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }

      /* Clean rendering */
      * { shape-rendering: geometricPrecision; }
    `;
  },

  // Clone the live SVG, strip grid/overlay, inject full CSS, resolve CSS
  // variables in inline attributes, and compute the bounding box.
  // Returns { clone, svgW, svgH, minX, minY }
  _prepareExportSVG(pad = 50) {
    const svg = document.getElementById('sld-canvas');
    const clone = svg.cloneNode(true);

    // Bounding box from component positions
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
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const svgW = maxX - minX;
    const svgH = maxY - minY;

    clone.setAttribute('viewBox', `${minX} ${minY} ${svgW} ${svgH}`);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

    // Strip non-diagram layers
    const grid = clone.querySelector('#grid-bg');
    if (grid) grid.remove();
    const overlay = clone.querySelector('#overlay-layer');
    if (overlay) overlay.remove();
    const diagram = clone.querySelector('#diagram-layer');
    if (diagram) diagram.setAttribute('transform', '');

    // Resolve CSS variables in inline attributes (e.g. var(--bg-primary, #fff))
    // This is critical — canvas/PDF renderers cannot resolve CSS vars.
    const varPattern = /var\(\s*--[^,)]+,\s*([^)]+)\)/g;
    clone.querySelectorAll('*').forEach(el => {
      for (const attr of Array.from(el.attributes)) {
        if (varPattern.test(attr.value)) {
          el.setAttribute(attr.name, attr.value.replace(varPattern, '$1'));
        }
        varPattern.lastIndex = 0;
      }
    });

    // Inject the complete export stylesheet
    const style = document.createElement('style');
    style.textContent = this._getExportCSS();
    clone.insertBefore(style, clone.firstChild);

    return { clone, svgW, svgH, minX, minY };
  },

  // Rasterize an export-ready SVG clone to a canvas and call back with it.
  // callback(canvas, imgW, imgH) — imgW/imgH are the actual pixel dims.
  _rasterizeSVG(clone, svgW, svgH, scale, callback) {
    clone.setAttribute('width', svgW * scale);
    clone.setAttribute('height', svgH * scale);

    const svgStr = new XMLSerializer().serializeToString(clone);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = svgW * scale;
      canvas.height = svgH * scale;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      callback(canvas, svgW * scale, svgH * scale);
    };
    img.onerror = () => {
      // Fallback: return blank white canvas
      const canvas = document.createElement('canvas');
      canvas.width = svgW * scale;
      canvas.height = svgH * scale;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      callback(canvas, svgW * scale, svgH * scale);
    };
    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgStr)));
  },

  // ── Export: SVG ──
  exportSVG() {
    const { clone, svgW, svgH } = this._prepareExportSVG();
    clone.setAttribute('width', svgW);
    clone.setAttribute('height', svgH);

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

  // ── Export: PNG ──
  exportPNG() {
    const { clone, svgW, svgH } = this._prepareExportSVG();
    this._rasterizeSVG(clone, svgW, svgH, 2, (canvas) => {
      canvas.toBlob((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${AppState.projectName || 'diagram'}.png`;
        a.click();
        URL.revokeObjectURL(url);
        Project._statusMsg('Exported diagram as PNG.');
      }, 'image/png');
    });
  },

  // Export analysis results as CSV (client-side, no backend needed)
  exportResultsCSV() {
    const rows = [];
    const name = AppState.projectName || 'project';

    // Fault results
    if (AppState.faultResults && AppState.faultResults.buses) {
      rows.push(['=== FAULT ANALYSIS (IEC 60909) ===']);
      rows.push(['Bus ID', 'Bus Name', 'Voltage (kV)', 'I"k3 (kA)', 'I"k1 (kA)', 'I"kLL (kA)', 'I"kLLG (kA)']);
      for (const [busId, r] of Object.entries(AppState.faultResults.buses)) {
        const comp = AppState.components.get(busId);
        const busName = comp?.props?.name || busId;
        rows.push([busId, busName, r.voltage_kv ?? '', r.ik3 ?? '', r.ik1 ?? '', r.ikLL ?? '', r.ikLLG ?? '']);
      }
      rows.push([]);

      // Fault branch contributions
      let hasBranches = false;
      for (const [busId, r] of Object.entries(AppState.faultResults.buses)) {
        if (r.branches && r.branches.length > 0) {
          if (!hasBranches) {
            rows.push(['=== FAULT BRANCH CONTRIBUTIONS ===']);
            rows.push(['Faulted Bus', 'Element', 'Type', 'If (kA)', 'Contribution (%)', '|Z_path| (p.u.)', 'Source']);
            hasBranches = true;
          }
          const busComp = AppState.components.get(busId);
          const busName = busComp?.props?.name || busId;
          for (const br of r.branches) {
            const elComp = AppState.components.get(br.element_id);
            const elName = elComp?.props?.name || br.element_name || br.element_id;
            rows.push([busName, elName, br.element_type, br.ik_ka, br.contribution_pct, br.z_path_mag, br.source_name]);
          }
        }
      }
      if (hasBranches) rows.push([]);
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

  // Export full report as PDF (diagram + results)
  // Uses canvas rasterization for the diagram (not addSvgAsImage) so that
  // Server-side PDF report generation
  async exportPDF() {
    this._statusMsg('Generating PDF report...');
    try {
      const blob = await API.generateReport();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${AppState.projectName || 'Untitled'}_report.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      this._statusMsg('Exported report as PDF.');
    } catch (e) {
      this._statusMsg(`PDF export failed: ${e.message}`);
      console.error('PDF export error:', e);
    }
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
          if (typeof renderPageTabs === 'function') renderPageTabs();
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

  // ── File Manager ──

  _fmFolders: [],
  _fmProjects: [],
  _fmCurrentFolder: null, // null = root

  async openProject() {
    try {
      const [projects, folders] = await Promise.all([
        API.listProjects(),
        API.listFolders(),
      ]);
      this._fmProjects = projects || [];
      this._fmFolders = folders || [];
      this._fmCurrentFolder = null;
      this._renderFileManager();
    } catch (e) {
      this._fmProjects = [];
      this._fmFolders = [];
      this._fmCurrentFolder = null;
      this._renderFileManager();
    }
  },

  _renderFileManager() {
    const folderId = this._fmCurrentFolder;
    const folders = this._fmFolders.filter(f => (f.parent_id || null) === folderId);
    const projects = this._fmProjects.filter(p => (p.folder_id || null) === folderId);

    // Breadcrumb
    const crumbs = this._buildBreadcrumbs(folderId);
    const breadcrumbHtml = crumbs.map((c, i) =>
      i === crumbs.length - 1
        ? `<span class="fm-crumb-current">${c.name}</span>`
        : `<a href="#" class="fm-crumb" data-folder-id="${c.id ?? ''}">${c.name}</a>`
    ).join('<span class="fm-crumb-sep">/</span>');

    let listHtml = '';

    // Folders first
    folders.sort((a, b) => a.name.localeCompare(b.name));
    for (const f of folders) {
      listHtml += `
        <div class="fm-item fm-folder" data-folder-id="${f.id}">
          <div class="fm-item-icon">
            <svg width="16" height="16" viewBox="0 0 16 16"><path d="M2 4h4l2 2h6v7a1 1 0 01-1 1H2a1 1 0 01-1-1V5a1 1 0 011-1z" fill="var(--accent, #4a9eff)" stroke="var(--accent, #4a9eff)" stroke-width="0.5" opacity="0.85"/></svg>
          </div>
          <div class="fm-item-info">
            <span class="fm-item-name">${this._esc(f.name)}</span>
          </div>
          <div class="fm-item-actions">
            <button class="fm-btn fm-btn-rename" data-type="folder" data-id="${f.id}" title="Rename">
              <svg width="12" height="12" viewBox="0 0 16 16"><path d="M11.5 1.5l3 3L5 14H2v-3z" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>
            </button>
            <button class="fm-btn fm-btn-delete" data-type="folder" data-id="${f.id}" title="Delete">
              <svg width="12" height="12" viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5"/></svg>
            </button>
          </div>
        </div>`;
    }

    // Projects
    projects.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    for (const p of projects) {
      listHtml += `
        <div class="fm-item fm-project" data-project-id="${p.id}">
          <div class="fm-item-icon">
            <svg width="16" height="16" viewBox="0 0 16 16"><path d="M3 1h7l3 3v9a2 2 0 01-2 2H3a2 2 0 01-2-2V3a2 2 0 012-2z" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M10 1v3h3" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>
          </div>
          <div class="fm-item-info">
            <span class="fm-item-name">${this._esc(p.name)}</span>
            <small class="fm-item-date">${new Date(p.updated_at).toLocaleDateString()}</small>
          </div>
          <div class="fm-item-actions">
            <button class="fm-btn fm-btn-rename" data-type="project" data-id="${p.id}" title="Rename">
              <svg width="12" height="12" viewBox="0 0 16 16"><path d="M11.5 1.5l3 3L5 14H2v-3z" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>
            </button>
            <button class="fm-btn fm-btn-move" data-type="project" data-id="${p.id}" title="Move to folder">
              <svg width="12" height="12" viewBox="0 0 16 16"><path d="M2 4h4l2 2h6v7a1 1 0 01-1 1H2a1 1 0 01-1-1V5a1 1 0 011-1z" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M6 10h4M8 8v4" stroke="currentColor" stroke-width="1.2"/></svg>
            </button>
            <button class="fm-btn fm-btn-delete" data-type="project" data-id="${p.id}" title="Delete">
              <svg width="12" height="12" viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5"/></svg>
            </button>
          </div>
        </div>`;
    }

    if (folders.length === 0 && projects.length === 0) {
      listHtml = '<p class="fm-empty">This folder is empty.</p>';
    }

    const modal = document.getElementById('calc-modal');
    modal.querySelector('#calc-modal-title').textContent = 'File Manager';
    modal.querySelector('#calc-modal-body').innerHTML = `
      <div class="fm-breadcrumb">${breadcrumbHtml}</div>
      <div class="fm-toolbar">
        <button id="fm-new-folder" class="btn-small">New Folder</button>
        <button id="fm-import-json" class="btn-small btn-primary">Import JSON...</button>
      </div>
      <div class="fm-list">${listHtml}</div>
    `;
    modal.style.display = '';

    // ── Bind events ──

    // Breadcrumbs
    modal.querySelectorAll('.fm-crumb').forEach(el => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        const id = el.dataset.folderId;
        this._fmCurrentFolder = id ? parseInt(id) : null;
        this._renderFileManager();
      });
    });

    // Navigate into folder
    modal.querySelectorAll('.fm-folder').forEach(el => {
      el.addEventListener('dblclick', () => {
        this._fmCurrentFolder = parseInt(el.dataset.folderId);
        this._renderFileManager();
      });
      // Single-click on folder name also navigates
      el.querySelector('.fm-item-info')?.addEventListener('click', () => {
        this._fmCurrentFolder = parseInt(el.dataset.folderId);
        this._renderFileManager();
      });
    });

    // Open project
    modal.querySelectorAll('.fm-project').forEach(el => {
      el.querySelector('.fm-item-info')?.addEventListener('click', async () => {
        try {
          const data = await API.loadProject(el.dataset.projectId);
          AppState.fromJSON(data);
          AppState.projectId = el.dataset.projectId;
          Canvas.updateTransform();
          if (typeof renderPageTabs === 'function') renderPageTabs();
          Canvas.render();
          Properties.clear();
          document.title = `ProtectionPro — ${AppState.projectName}`;
          this._statusMsg('Project loaded.');
        } catch (err) {
          alert('Failed to load project: ' + err.message);
        }
        modal.style.display = 'none';
      });
    });

    // New folder
    document.getElementById('fm-new-folder')?.addEventListener('click', async () => {
      const name = prompt('Folder name:', 'New Folder');
      if (!name) return;
      try {
        const folder = await API.createFolder(name, this._fmCurrentFolder);
        this._fmFolders.push(folder);
        this._renderFileManager();
      } catch (err) {
        alert('Failed to create folder: ' + err.message);
      }
    });

    // Import JSON
    document.getElementById('fm-import-json')?.addEventListener('click', () => {
      modal.style.display = 'none';
      this.importFromFile();
    });

    // Rename buttons
    modal.querySelectorAll('.fm-btn-rename').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const type = btn.dataset.type;
        const id = parseInt(btn.dataset.id);
        const current = type === 'folder'
          ? this._fmFolders.find(f => f.id === id)?.name
          : this._fmProjects.find(p => p.id === id)?.name;
        const newName = prompt(`Rename ${type}:`, current || '');
        if (!newName || newName === current) return;
        try {
          if (type === 'folder') {
            await API.updateFolder(id, { name: newName });
            const f = this._fmFolders.find(f => f.id === id);
            if (f) f.name = newName;
          } else {
            await API.renameProject(id, newName);
            const p = this._fmProjects.find(p => p.id === id);
            if (p) p.name = newName;
            // Update title if renaming current project
            if (AppState.projectId == id) {
              AppState.projectName = newName;
              document.title = `ProtectionPro — ${newName}`;
            }
          }
          this._renderFileManager();
        } catch (err) {
          alert('Rename failed: ' + err.message);
        }
      });
    });

    // Delete buttons
    modal.querySelectorAll('.fm-btn-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const type = btn.dataset.type;
        const id = parseInt(btn.dataset.id);
        const label = type === 'folder' ? 'folder (contents will be moved to root)' : 'project';
        if (!confirm(`Delete this ${label} permanently?`)) return;
        try {
          if (type === 'folder') {
            await API.deleteFolder(id);
            this._fmFolders = this._fmFolders.filter(f => f.id !== id);
            // Orphaned items moved to root by backend
            this._fmProjects.forEach(p => { if (p.folder_id === id) p.folder_id = null; });
            this._fmFolders.forEach(f => { if (f.parent_id === id) f.parent_id = null; });
          } else {
            await API.deleteProject(id);
            this._fmProjects = this._fmProjects.filter(p => p.id !== id);
            if (AppState.projectId == id) AppState.projectId = null;
          }
          this._renderFileManager();
        } catch (err) {
          alert('Delete failed: ' + err.message);
        }
      });
    });

    // Move project buttons
    modal.querySelectorAll('.fm-btn-move').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = parseInt(btn.dataset.id);
        this._showMoveDialog(id);
      });
    });
  },

  _showMoveDialog(projectId) {
    const project = this._fmProjects.find(p => p.id === projectId);
    if (!project) return;

    // Build folder options
    let options = '<option value="">Root (no folder)</option>';
    for (const f of this._fmFolders) {
      const path = this._getFolderPath(f.id);
      const selected = f.id === project.folder_id ? ' selected' : '';
      options += `<option value="${f.id}"${selected}>${this._esc(path)}</option>`;
    }

    const modal = document.getElementById('calc-modal');
    const body = modal.querySelector('#calc-modal-body');
    // Save current body so we can restore
    const prevHtml = body.innerHTML;
    modal.querySelector('#calc-modal-title').textContent = `Move "${project.name}"`;
    body.innerHTML = `
      <div style="margin-bottom:12px;">Select destination folder:</div>
      <select id="fm-move-target" style="width:100%;padding:8px;border:1px solid var(--border-color);border-radius:4px;background:var(--bg-primary);color:var(--text-primary);">
        ${options}
      </select>
      <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end;">
        <button id="fm-move-cancel" class="btn-small">Cancel</button>
        <button id="fm-move-confirm" class="btn-small btn-primary">Move</button>
      </div>
    `;

    document.getElementById('fm-move-cancel').addEventListener('click', () => {
      modal.querySelector('#calc-modal-title').textContent = 'File Manager';
      body.innerHTML = prevHtml;
      this._renderFileManager();
    });

    document.getElementById('fm-move-confirm').addEventListener('click', async () => {
      const target = document.getElementById('fm-move-target').value;
      const folderId = target ? parseInt(target) : null;
      try {
        await API.moveProject(projectId, folderId);
        project.folder_id = folderId;
        modal.querySelector('#calc-modal-title').textContent = 'File Manager';
        this._renderFileManager();
      } catch (err) {
        alert('Move failed: ' + err.message);
      }
    });
  },

  _buildBreadcrumbs(folderId) {
    const crumbs = [{ id: null, name: 'Root' }];
    let currentId = folderId;
    const chain = [];
    while (currentId !== null) {
      const folder = this._fmFolders.find(f => f.id === currentId);
      if (!folder) break;
      chain.unshift({ id: folder.id, name: folder.name });
      currentId = folder.parent_id || null;
    }
    return crumbs.concat(chain);
  },

  _getFolderPath(folderId) {
    const parts = [];
    let currentId = folderId;
    while (currentId !== null) {
      const folder = this._fmFolders.find(f => f.id === currentId);
      if (!folder) break;
      parts.unshift(folder.name);
      currentId = folder.parent_id || null;
    }
    return '/ ' + parts.join(' / ');
  },

  _esc(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  },
};
