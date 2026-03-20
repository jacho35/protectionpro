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
    document.getElementById('btn-export-pdf').addEventListener('click', () => { exportMenu.classList.remove('open'); this.exportPDF(); });
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
  // all CSS-styled symbols render correctly in the PDF.
  exportPDF() {
    const { jsPDF } = window.jspdf;
    if (!jsPDF) {
      this._statusMsg('PDF library not loaded. Check your internet connection.');
      return;
    }

    const projName = AppState.projectName || 'Untitled Project';

    // Prepare the SVG clone and rasterize it FIRST, then build the PDF
    // inside the callback (canvas rasterization is async).
    const { clone, svgW, svgH } = this._prepareExportSVG(40);

    this._rasterizeSVG(clone, svgW, svgH, 3, (canvas) => {
      const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
      const pageW = doc.internal.pageSize.getWidth();
      const pageH = doc.internal.pageSize.getHeight();
      const margin = 15;
      const contentW = pageW - margin * 2;

      // ── Title block ──
      doc.setFontSize(18);
      doc.setFont('helvetica', 'bold');
      doc.text('ProtectionPro \u2014 Analysis Report', margin, margin + 6);
      doc.setFontSize(11);
      doc.setFont('helvetica', 'normal');
      doc.text(`Project: ${projName}`, margin, margin + 14);
      doc.text(`Base MVA: ${AppState.baseMVA}   |   Frequency: ${AppState.frequency} Hz   |   Date: ${new Date().toLocaleDateString()}`, margin, margin + 20);

      // ── Diagram image (rasterized via canvas) ──
      const diagramY = margin + 28;
      try {
        const maxDiagH = pageH - diagramY - margin - 10;
        const aspect = svgW / svgH;
        let imgW = contentW;
        let imgH = imgW / aspect;
        if (imgH > maxDiagH) {
          imgH = maxDiagH;
          imgW = imgH * aspect;
        }

        // Convert canvas to PNG data URL and embed it
        const pngData = canvas.toDataURL('image/png');
        doc.setDrawColor(200);
        doc.rect(margin, diagramY, imgW, imgH);
        doc.addImage(pngData, 'PNG', margin, diagramY, imgW, imgH);
      } catch (_e) {
        // If image embedding fails, continue with tables only
      }

      // ── Analysis tables ──
      const hasFault = AppState.faultResults && AppState.faultResults.buses && Object.keys(AppState.faultResults.buses).length > 0;
      const hasLoadFlow = AppState.loadFlowResults && AppState.loadFlowResults.buses && Object.keys(AppState.loadFlowResults.buses).length > 0;

      if (!hasFault && !hasLoadFlow) {
        doc.addPage();
        doc.setFontSize(12);
        doc.text('No analysis results available. Run Fault Analysis or Load Flow first.', margin, margin + 10);
      }

      if (hasFault) {
        doc.addPage();
        doc.setFontSize(14);
        doc.setFont('helvetica', 'bold');
        doc.text('Fault Analysis \u2014 IEC 60909 (Initial Symmetrical Short-Circuit)', margin, margin + 6);
        doc.setFont('helvetica', 'normal');

        const faultRows = [];
        for (const [busId, r] of Object.entries(AppState.faultResults.buses)) {
          const comp = AppState.components.get(busId);
          const busName = comp?.props?.name || busId;
          const vkv = r.voltage_kv != null ? Number(r.voltage_kv).toFixed(1) : '\u2014';
          faultRows.push([
            busName, vkv,
            r.ik3 != null ? Number(r.ik3).toFixed(3) : '\u2014',
            r.ik1 != null ? Number(r.ik1).toFixed(3) : '\u2014',
            r.ikLL != null ? Number(r.ikLL).toFixed(3) : '\u2014',
            r.ikLLG != null ? Number(r.ikLLG).toFixed(3) : '\u2014',
          ]);
        }

        doc.autoTable({
          startY: margin + 12,
          margin: { left: margin, right: margin },
          head: [['Bus', 'Voltage (kV)', 'I"k3 (kA)', 'I"k1 (kA)', 'I"kLL (kA)', 'I"kLLG (kA)']],
          body: faultRows,
          styles: { fontSize: 9, cellPadding: 2 },
          headStyles: { fillColor: [0, 120, 215], textColor: 255, fontStyle: 'bold' },
          alternateRowStyles: { fillColor: [245, 245, 245] },
          columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' } },
        });

        // Fault branch contributions table
        const branchRows = [];
        for (const [busId, r] of Object.entries(AppState.faultResults.buses)) {
          if (!r.branches || r.branches.length === 0) continue;
          const busComp = AppState.components.get(busId);
          const busName = busComp?.props?.name || busId;
          for (const br of r.branches) {
            const elComp = AppState.components.get(br.element_id);
            const elName = elComp?.props?.name || br.element_name || br.element_id;
            branchRows.push([
              busName, elName, (br.element_type || '').replace('_', ' '),
              br.ik_ka != null ? Number(br.ik_ka).toFixed(3) : '\u2014',
              br.contribution_pct != null ? Number(br.contribution_pct).toFixed(1) + '%' : '\u2014',
              br.z_path_mag != null ? Number(br.z_path_mag).toFixed(6) : '\u2014',
              br.source_name || '\u2014',
            ]);
          }
        }

        if (branchRows.length > 0) {
          const branchY = doc.lastAutoTable.finalY + 10;
          doc.setFontSize(12);
          doc.setFont('helvetica', 'bold');
          doc.text('Branch Fault Current Contributions', margin, branchY);
          doc.setFont('helvetica', 'normal');

          doc.autoTable({
            startY: branchY + 4,
            margin: { left: margin, right: margin },
            head: [['Faulted Bus', 'Element', 'Type', 'If (kA)', '%', '|Z_path| (p.u.)', 'Source']],
            body: branchRows,
            styles: { fontSize: 8, cellPadding: 1.5 },
            headStyles: { fillColor: [183, 28, 28], textColor: 255, fontStyle: 'bold' },
            alternateRowStyles: { fillColor: [255, 245, 245] },
            columnStyles: { 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' } },
          });
        }
      }

      if (hasLoadFlow) {
        doc.addPage();
        doc.setFontSize(14);
        doc.setFont('helvetica', 'bold');
        const lf = AppState.loadFlowResults;
        const method = lf.method === 'newton_raphson' ? 'Newton-Raphson' : 'Gauss-Seidel';
        const conv = lf.converged ? 'Converged' : 'Did NOT converge';
        doc.text(`Load Flow \u2014 ${method} (${conv}, ${lf.iterations} iterations)`, margin, margin + 6);
        doc.setFont('helvetica', 'normal');

        const busRows = [];
        for (const [busId, r] of Object.entries(lf.buses)) {
          const comp = AppState.components.get(busId);
          const busName = comp?.props?.name || busId;
          busRows.push([
            busName,
            Number(r.voltage_pu).toFixed(4), Number(r.voltage_kv).toFixed(2),
            Number(r.angle_deg).toFixed(2), Number(r.p_mw).toFixed(3), Number(r.q_mvar).toFixed(3),
          ]);
        }

        doc.autoTable({
          startY: margin + 12,
          margin: { left: margin, right: margin },
          head: [['Bus', 'V (p.u.)', 'V (kV)', 'Angle (\u00B0)', 'P (MW)', 'Q (MVAr)']],
          body: busRows,
          styles: { fontSize: 9, cellPadding: 2 },
          headStyles: { fillColor: [46, 125, 50], textColor: 255, fontStyle: 'bold' },
          alternateRowStyles: { fillColor: [245, 245, 245] },
          columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' } },
        });

        // Branch flows
        if (lf.branches && lf.branches.length > 0) {
          const branchY = doc.lastAutoTable.finalY + 10;
          doc.setFontSize(12);
          doc.setFont('helvetica', 'bold');
          doc.text('Branch Flows', margin, branchY);
          doc.setFont('helvetica', 'normal');

          const branchRows = [];
          for (const br of lf.branches) {
            const comp = AppState.components.get(br.elementId);
            const elName = comp?.props?.name || br.elementId;
            branchRows.push([
              elName, br.from_bus || '\u2014', br.to_bus || '\u2014',
              br.p_mw != null ? Number(br.p_mw).toFixed(3) : '\u2014',
              br.q_mvar != null ? Number(br.q_mvar).toFixed(3) : '\u2014',
              br.s_mva != null ? Number(br.s_mva).toFixed(3) : '\u2014',
              br.i_amps != null ? Number(br.i_amps).toFixed(1) : '\u2014',
              br.loading_pct != null ? Number(br.loading_pct).toFixed(1) : '\u2014',
            ]);
          }

          doc.autoTable({
            startY: branchY + 4,
            margin: { left: margin, right: margin },
            head: [['Element', 'From', 'To', 'P (MW)', 'Q (MVAr)', 'S (MVA)', 'I (A)', 'Loading (%)']],
            body: branchRows,
            styles: { fontSize: 8, cellPadding: 2 },
            headStyles: { fillColor: [46, 125, 50], textColor: 255, fontStyle: 'bold' },
            alternateRowStyles: { fillColor: [245, 245, 245] },
            columnStyles: { 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' }, 6: { halign: 'right' }, 7: { halign: 'right' } },
          });
        }
      }

      // ── Equipment Summary ──
      if (AppState.components.size > 0) {
        doc.addPage();
        doc.setFontSize(14);
        doc.setFont('helvetica', 'bold');
        doc.text('Equipment Summary', margin, margin + 6);
        doc.setFont('helvetica', 'normal');

        const equipRows = [];
        for (const [id, comp] of AppState.components) {
          const def = COMPONENT_DEFS[comp.type];
          const label = def ? def.name : comp.type;
          const eName = comp.props?.name || id;
          const params = [];
          if (comp.props?.voltage_kv != null) params.push(`${comp.props.voltage_kv} kV`);
          if (comp.props?.rated_mva != null) params.push(`${comp.props.rated_mva} MVA`);
          if (comp.props?.fault_mva != null) params.push(`FL: ${comp.props.fault_mva} MVA`);
          if (comp.props?.z_percent != null) params.push(`Z: ${comp.props.z_percent}%`);
          if (comp.props?.x_r_ratio != null) params.push(`X/R: ${comp.props.x_r_ratio}`);
          if (comp.props?.vector_group != null) params.push(comp.props.vector_group);
          if (comp.props?.length_km != null) params.push(`${comp.props.length_km} km`);
          if (comp.props?.rated_current_a != null) params.push(`${comp.props.rated_current_a} A`);
          if (comp.props?.state != null) params.push(comp.props.state);
          equipRows.push([eName, label, params.join(', ')]);
        }

        doc.autoTable({
          startY: margin + 12,
          margin: { left: margin, right: margin },
          head: [['Name', 'Type', 'Key Parameters']],
          body: equipRows,
          styles: { fontSize: 9, cellPadding: 2 },
          headStyles: { fillColor: [80, 80, 80], textColor: 255, fontStyle: 'bold' },
          alternateRowStyles: { fillColor: [245, 245, 245] },
          columnStyles: { 2: { cellWidth: 'auto' } },
        });
      }

      // ── Footer on all pages ──
      const totalPages = doc.internal.getNumberOfPages();
      for (let i = 1; i <= totalPages; i++) {
        doc.setPage(i);
        doc.setFontSize(8);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(150);
        doc.text(`ProtectionPro \u2014 ${projName}`, margin, pageH - 5);
        doc.text(`Page ${i} of ${totalPages}`, pageW - margin, pageH - 5, { align: 'right' });
        doc.setTextColor(0);
      }

      doc.save(`${projName}_report.pdf`);
      Project._statusMsg('Exported report as PDF.');
    });
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
