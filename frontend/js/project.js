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

  // Export full report as PDF (diagram + results)
  exportPDF() {
    const { jsPDF } = window.jspdf;
    if (!jsPDF) {
      this._statusMsg('PDF library not loaded. Check your internet connection.');
      return;
    }

    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const margin = 15;
    const contentW = pageW - margin * 2;
    const name = AppState.projectName || 'Untitled Project';

    // ── Title block ──
    doc.setFontSize(18);
    doc.setFont('helvetica', 'bold');
    doc.text('ProtectionPro — Analysis Report', margin, margin + 6);
    doc.setFontSize(11);
    doc.setFont('helvetica', 'normal');
    doc.text(`Project: ${name}`, margin, margin + 14);
    doc.text(`Base MVA: ${AppState.baseMVA}   |   Frequency: ${AppState.frequency} Hz   |   Date: ${new Date().toLocaleDateString()}`, margin, margin + 20);

    // ── Diagram image ──
    let diagramY = margin + 28;
    try {
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
      const pad = 40;
      minX -= pad; minY -= pad; maxX += pad; maxY += pad;
      const svgW = maxX - minX;
      const svgH = maxY - minY;

      clone.setAttribute('viewBox', `${minX} ${minY} ${svgW} ${svgH}`);
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      const grid = clone.querySelector('#grid-bg');
      if (grid) grid.remove();
      const overlay = clone.querySelector('#overlay-layer');
      if (overlay) overlay.remove();
      const diagram = clone.querySelector('#diagram-layer');
      if (diagram) diagram.setAttribute('transform', '');

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

      // Fit diagram into available space (max half the page height)
      const maxDiagH = pageH - diagramY - margin - 10;
      const aspect = svgW / svgH;
      let imgW = contentW;
      let imgH = imgW / aspect;
      if (imgH > maxDiagH) {
        imgH = maxDiagH;
        imgW = imgH * aspect;
      }

      const scale = 2;
      clone.setAttribute('width', svgW * scale);
      clone.setAttribute('height', svgH * scale);

      const svgStr = new XMLSerializer().serializeToString(clone);
      const svgBase64 = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgStr)));

      // Draw diagram border and embed as SVG
      doc.setDrawColor(200);
      doc.rect(margin, diagramY, imgW, imgH);
      doc.addSvgAsImage(svgStr, margin, diagramY, imgW, imgH);
    } catch (_e) {
      // SVG embedding may fail — continue with tables only
    }

    // ── Fault Analysis Table ──
    const hasFault = AppState.faultResults && AppState.faultResults.buses && Object.keys(AppState.faultResults.buses).length > 0;
    const hasLoadFlow = AppState.loadFlowResults && AppState.loadFlowResults.buses && Object.keys(AppState.loadFlowResults.buses).length > 0;

    if (!hasFault && !hasLoadFlow) {
      doc.addPage();
      doc.setFontSize(12);
      doc.text('No analysis results available. Run Fault Analysis or Load Flow first.', margin, margin + 10);
      doc.save(`${name}_report.pdf`);
      this._statusMsg('Exported report as PDF (no results data).');
      return;
    }

    if (hasFault) {
      doc.addPage();
      doc.setFontSize(14);
      doc.setFont('helvetica', 'bold');
      doc.text('Fault Analysis — IEC 60909 (Initial Symmetrical Short-Circuit)', margin, margin + 6);
      doc.setFont('helvetica', 'normal');

      const faultRows = [];
      for (const [busId, r] of Object.entries(AppState.faultResults.buses)) {
        const comp = AppState.components.get(busId);
        const busName = comp?.props?.name || busId;
        const vkv = r.voltage_kv != null ? Number(r.voltage_kv).toFixed(1) : '—';
        faultRows.push([
          busName,
          vkv,
          r.ik3 != null ? Number(r.ik3).toFixed(3) : '—',
          r.ik1 != null ? Number(r.ik1).toFixed(3) : '—',
          r.ikLL != null ? Number(r.ikLL).toFixed(3) : '—',
        ]);
      }

      doc.autoTable({
        startY: margin + 12,
        margin: { left: margin, right: margin },
        head: [['Bus', 'Voltage (kV)', 'I"k3 (kA)', 'I"k1 (kA)', 'I"kLL (kA)']],
        body: faultRows,
        styles: { fontSize: 9, cellPadding: 2 },
        headStyles: { fillColor: [0, 120, 215], textColor: 255, fontStyle: 'bold' },
        alternateRowStyles: { fillColor: [245, 245, 245] },
        columnStyles: {
          1: { halign: 'right' },
          2: { halign: 'right' },
          3: { halign: 'right' },
          4: { halign: 'right' },
        },
      });
    }

    if (hasLoadFlow) {
      doc.addPage();
      doc.setFontSize(14);
      doc.setFont('helvetica', 'bold');
      const lf = AppState.loadFlowResults;
      const method = lf.method === 'newton_raphson' ? 'Newton-Raphson' : 'Gauss-Seidel';
      const conv = lf.converged ? 'Converged' : 'Did NOT converge';
      doc.text(`Load Flow — ${method} (${conv}, ${lf.iterations} iterations)`, margin, margin + 6);
      doc.setFont('helvetica', 'normal');

      // Bus results
      const busRows = [];
      for (const [busId, r] of Object.entries(lf.buses)) {
        const comp = AppState.components.get(busId);
        const busName = comp?.props?.name || busId;
        busRows.push([
          busName,
          Number(r.voltage_pu).toFixed(4),
          Number(r.voltage_kv).toFixed(2),
          Number(r.angle_deg).toFixed(2),
          Number(r.p_mw).toFixed(3),
          Number(r.q_mvar).toFixed(3),
        ]);
      }

      doc.autoTable({
        startY: margin + 12,
        margin: { left: margin, right: margin },
        head: [['Bus', 'V (p.u.)', 'V (kV)', 'Angle (°)', 'P (MW)', 'Q (MVAr)']],
        body: busRows,
        styles: { fontSize: 9, cellPadding: 2 },
        headStyles: { fillColor: [46, 125, 50], textColor: 255, fontStyle: 'bold' },
        alternateRowStyles: { fillColor: [245, 245, 245] },
        columnStyles: {
          1: { halign: 'right' },
          2: { halign: 'right' },
          3: { halign: 'right' },
          4: { halign: 'right' },
          5: { halign: 'right' },
        },
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
            elName,
            br.from_bus || '—',
            br.to_bus || '—',
            br.p_mw != null ? Number(br.p_mw).toFixed(3) : '—',
            br.q_mvar != null ? Number(br.q_mvar).toFixed(3) : '—',
            br.s_mva != null ? Number(br.s_mva).toFixed(3) : '—',
            br.i_amps != null ? Number(br.i_amps).toFixed(1) : '—',
            br.loading_pct != null ? Number(br.loading_pct).toFixed(1) : '—',
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
          columnStyles: {
            3: { halign: 'right' },
            4: { halign: 'right' },
            5: { halign: 'right' },
            6: { halign: 'right' },
            7: { halign: 'right' },
          },
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
        const label = def ? def.label : comp.type;
        const name = comp.props?.name || id;
        // Build key parameters string
        const params = [];
        if (comp.props?.voltage != null) params.push(`${comp.props.voltage} kV`);
        if (comp.props?.ratedMVA != null) params.push(`${comp.props.ratedMVA} MVA`);
        if (comp.props?.ratedKVA != null) params.push(`${comp.props.ratedKVA} kVA`);
        if (comp.props?.ratedKW != null) params.push(`${comp.props.ratedKW} kW`);
        if (comp.props?.ratedKVAr != null) params.push(`${comp.props.ratedKVAr} kVAr`);
        if (comp.props?.ratedCurrent != null) params.push(`${comp.props.ratedCurrent} A`);
        if (comp.props?.faultLevel != null) params.push(`FL: ${comp.props.faultLevel} MVA`);
        if (comp.props?.zPercent != null) params.push(`Z: ${comp.props.zPercent}%`);
        if (comp.props?.length != null) params.push(`${comp.props.length} km`);
        if (comp.props?.state != null) params.push(comp.props.state);
        equipRows.push([name, label, params.join(', ')]);
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
      doc.text(`ProtectionPro — ${name}`, margin, pageH - 5);
      doc.text(`Page ${i} of ${totalPages}`, pageW - margin, pageH - 5, { align: 'right' });
      doc.setTextColor(0);
    }

    doc.save(`${name}_report.pdf`);
    this._statusMsg('Exported report as PDF.');
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
