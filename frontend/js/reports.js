/* ProtectionPro — Reports: Templates, Comparison, Settings Schedule */

const Reports = {

  // ── Report Template System ──
  // Templates define which sections to include and in what order.

  defaultTemplates: [
    {
      id: 'full',
      name: 'Full Analysis Report',
      builtin: true,
      sections: ['title', 'diagram', 'fault', 'fault_branches', 'loadflow_bus', 'loadflow_branch', 'equipment'],
    },
    {
      id: 'fault_only',
      name: 'Fault Analysis Only',
      builtin: true,
      sections: ['title', 'fault', 'fault_branches'],
    },
    {
      id: 'loadflow_only',
      name: 'Load Flow Only',
      builtin: true,
      sections: ['title', 'loadflow_bus', 'loadflow_branch'],
    },
    {
      id: 'protection',
      name: 'Protection Settings Schedule',
      builtin: true,
      sections: ['title', 'settings_schedule'],
    },
    {
      id: 'executive',
      name: 'Executive Summary',
      builtin: true,
      sections: ['title', 'diagram', 'equipment'],
    },
  ],

  // All available section definitions
  sectionDefs: {
    title:           { label: 'Title Block',                   group: 'General' },
    diagram:         { label: 'Single Line Diagram',           group: 'General' },
    equipment:       { label: 'Equipment Summary',             group: 'General' },
    fault:           { label: 'Fault Currents Table',          group: 'Fault Analysis' },
    fault_branches:  { label: 'Branch Contributions',          group: 'Fault Analysis' },
    loadflow_bus:    { label: 'Bus Voltages & Power',          group: 'Load Flow' },
    loadflow_branch: { label: 'Branch Flows & Loading',        group: 'Load Flow' },
    settings_schedule: { label: 'Protection Settings Schedule', group: 'Protection' },
  },

  _userTemplates: [],

  _getAllTemplates() {
    return [...this.defaultTemplates, ...this._userTemplates];
  },

  saveUserTemplate(name, sections) {
    const tmpl = {
      id: 'user_' + Date.now(),
      name,
      builtin: false,
      sections: [...sections],
    };
    this._userTemplates.push(tmpl);
    return tmpl;
  },

  deleteUserTemplate(id) {
    this._userTemplates = this._userTemplates.filter(t => t.id !== id);
  },

  // ── Template-based PDF Export ──

  exportWithTemplate(templateId) {
    const tmpl = this._getAllTemplates().find(t => t.id === templateId);
    if (!tmpl) return;

    const { jsPDF } = window.jspdf;
    if (!jsPDF) {
      Project._statusMsg('PDF library not loaded.');
      return;
    }

    const projName = AppState.projectName || 'Untitled Project';
    const sections = tmpl.sections;
    const needsDiagram = sections.includes('diagram');

    const buildPDF = (canvas) => {
      const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
      const pageW = doc.internal.pageSize.getWidth();
      const pageH = doc.internal.pageSize.getHeight();
      const margin = 15;
      const contentW = pageW - margin * 2;

      for (let si = 0; si < sections.length; si++) {
        const sec = sections[si];
        if (si > 0 && sec !== 'title') doc.addPage();

        if (sec === 'title') {
          this._renderTitleBlock(doc, projName, margin);
        } else if (sec === 'diagram' && canvas) {
          this._renderDiagram(doc, canvas, margin, pageW, pageH, contentW);
        } else if (sec === 'fault') {
          this._renderFaultTable(doc, margin);
        } else if (sec === 'fault_branches') {
          this._renderFaultBranches(doc, margin);
        } else if (sec === 'loadflow_bus') {
          this._renderLoadFlowBus(doc, margin);
        } else if (sec === 'loadflow_branch') {
          this._renderLoadFlowBranch(doc, margin);
        } else if (sec === 'equipment') {
          this._renderEquipment(doc, margin);
        } else if (sec === 'settings_schedule') {
          this._renderSettingsSchedule(doc, margin);
        }
      }

      // Footer on all pages
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

      doc.save(`${projName}_${tmpl.id}.pdf`);
      Project._statusMsg(`Exported "${tmpl.name}" as PDF.`);
    };

    if (needsDiagram) {
      const { clone, svgW, svgH } = Project._prepareExportSVG(40);
      Project._rasterizeSVG(clone, svgW, svgH, 3, buildPDF);
    } else {
      buildPDF(null);
    }
  },

  // ── PDF Section Renderers ──

  _renderTitleBlock(doc, projName, margin) {
    doc.setFontSize(18);
    doc.setFont('helvetica', 'bold');
    doc.text('ProtectionPro \u2014 Analysis Report', margin, margin + 6);
    doc.setFontSize(11);
    doc.setFont('helvetica', 'normal');
    doc.text(`Project: ${projName}`, margin, margin + 14);
    doc.text(`Base MVA: ${AppState.baseMVA}   |   Frequency: ${AppState.frequency} Hz   |   Date: ${new Date().toLocaleDateString()}`, margin, margin + 20);
  },

  _renderDiagram(doc, canvas, margin, pageW, pageH, contentW) {
    const diagramY = margin + 28;
    try {
      const svgW = canvas.width;
      const svgH = canvas.height;
      const maxDiagH = pageH - diagramY - margin - 10;
      const aspect = svgW / svgH;
      let imgW = contentW;
      let imgH = imgW / aspect;
      if (imgH > maxDiagH) { imgH = maxDiagH; imgW = imgH * aspect; }
      const pngData = canvas.toDataURL('image/png');
      doc.setDrawColor(200);
      doc.rect(margin, diagramY, imgW, imgH);
      doc.addImage(pngData, 'PNG', margin, diagramY, imgW, imgH);
    } catch (_e) { /* skip on failure */ }
  },

  _renderFaultTable(doc, margin) {
    if (!AppState.faultResults?.buses) return;
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.text('Fault Analysis \u2014 IEC 60909', margin, margin + 6);
    doc.setFont('helvetica', 'normal');

    const rows = [];
    for (const [busId, r] of Object.entries(AppState.faultResults.buses)) {
      const comp = AppState.components.get(busId);
      const name = comp?.props?.name || busId;
      rows.push([
        name,
        r.voltage_kv != null ? Number(r.voltage_kv).toFixed(1) : '\u2014',
        r.ik3 != null ? Number(r.ik3).toFixed(3) : '\u2014',
        r.ik1 != null ? Number(r.ik1).toFixed(3) : '\u2014',
        r.ikLL != null ? Number(r.ikLL).toFixed(3) : '\u2014',
        r.ikLLG != null ? Number(r.ikLLG).toFixed(3) : '\u2014',
      ]);
    }
    doc.autoTable({
      startY: margin + 12,
      margin: { left: margin, right: margin },
      head: [['Bus', 'V (kV)', 'I"k3 (kA)', 'I"k1 (kA)', 'I"kLL (kA)', 'I"kLLG (kA)']],
      body: rows,
      styles: { fontSize: 9, cellPadding: 2 },
      headStyles: { fillColor: [0, 120, 215], textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [245, 245, 245] },
      columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' } },
    });
  },

  _renderFaultBranches(doc, margin) {
    if (!AppState.faultResults?.buses) return;
    const rows = [];
    for (const [busId, r] of Object.entries(AppState.faultResults.buses)) {
      if (!r.branches?.length) continue;
      const busName = AppState.components.get(busId)?.props?.name || busId;
      for (const br of r.branches) {
        const elName = AppState.components.get(br.element_id)?.props?.name || br.element_name || br.element_id;
        rows.push([
          busName, elName, (br.element_type || '').replace('_', ' '),
          br.ik_ka != null ? Number(br.ik_ka).toFixed(3) : '\u2014',
          br.contribution_pct != null ? Number(br.contribution_pct).toFixed(1) + '%' : '\u2014',
          br.source_name || '\u2014',
        ]);
      }
    }
    if (rows.length === 0) return;

    const startY = doc.lastAutoTable ? doc.lastAutoTable.finalY + 10 : margin + 12;
    doc.setFontSize(12);
    doc.setFont('helvetica', 'bold');
    doc.text('Branch Fault Current Contributions', margin, startY);
    doc.setFont('helvetica', 'normal');
    doc.autoTable({
      startY: startY + 4,
      margin: { left: margin, right: margin },
      head: [['Faulted Bus', 'Element', 'Type', 'If (kA)', '%', 'Source']],
      body: rows,
      styles: { fontSize: 8, cellPadding: 1.5 },
      headStyles: { fillColor: [183, 28, 28], textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [255, 245, 245] },
    });
  },

  _renderLoadFlowBus(doc, margin) {
    const lf = AppState.loadFlowResults;
    if (!lf?.buses) return;
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    const method = lf.method === 'newton_raphson' ? 'Newton-Raphson' : 'Gauss-Seidel';
    doc.text(`Load Flow \u2014 ${method} (${lf.converged ? 'Converged' : 'Not Converged'})`, margin, margin + 6);
    doc.setFont('helvetica', 'normal');

    const rows = [];
    for (const [busId, r] of Object.entries(lf.buses)) {
      const name = AppState.components.get(busId)?.props?.name || busId;
      rows.push([
        name,
        r.v_pu != null ? Number(r.v_pu).toFixed(4) : '\u2014',
        r.v_kv != null ? Number(r.v_kv).toFixed(2) : '\u2014',
        r.angle_deg != null ? Number(r.angle_deg).toFixed(2) : '\u2014',
        r.p_mw != null ? Number(r.p_mw).toFixed(4) : '\u2014',
        r.q_mvar != null ? Number(r.q_mvar).toFixed(4) : '\u2014',
      ]);
    }
    doc.autoTable({
      startY: margin + 12,
      margin: { left: margin, right: margin },
      head: [['Bus', 'V (p.u.)', 'V (kV)', 'Angle (\u00b0)', 'P (MW)', 'Q (MVAr)']],
      body: rows,
      styles: { fontSize: 9, cellPadding: 2 },
      headStyles: { fillColor: [46, 125, 50], textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [245, 255, 245] },
      columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' } },
    });
  },

  _renderLoadFlowBranch(doc, margin) {
    const lf = AppState.loadFlowResults;
    if (!lf?.branches) return;
    const rows = [];
    for (const br of lf.branches) {
      const comp = AppState.components.get(br.element_id);
      const name = comp?.props?.name || br.element_name || br.element_id;
      rows.push([
        name,
        br.from_bus || '\u2014', br.to_bus || '\u2014',
        br.p_mw != null ? Number(br.p_mw).toFixed(4) : '\u2014',
        br.q_mvar != null ? Number(br.q_mvar).toFixed(4) : '\u2014',
        br.loading_pct != null ? Number(br.loading_pct).toFixed(1) + '%' : '\u2014',
        br.i_a != null ? Number(br.i_a).toFixed(1) : '\u2014',
      ]);
    }
    if (rows.length === 0) return;

    const startY = doc.lastAutoTable ? doc.lastAutoTable.finalY + 10 : margin + 12;
    doc.setFontSize(12);
    doc.setFont('helvetica', 'bold');
    doc.text('Branch Flows', margin, startY);
    doc.setFont('helvetica', 'normal');
    doc.autoTable({
      startY: startY + 4,
      margin: { left: margin, right: margin },
      head: [['Element', 'From', 'To', 'P (MW)', 'Q (MVAr)', 'Loading (%)', 'I (A)']],
      body: rows,
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [46, 125, 50], textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [245, 245, 245] },
    });
  },

  _renderEquipment(doc, margin) {
    if (AppState.components.size === 0) return;
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.text('Equipment Summary', margin, margin + 6);
    doc.setFont('helvetica', 'normal');

    const rows = [];
    for (const [id, comp] of AppState.components) {
      const def = COMPONENT_DEFS[comp.type];
      const label = def ? def.name : comp.type;
      const eName = comp.props?.name || id;
      const params = [];
      if (comp.props?.voltage_kv != null) params.push(`${comp.props.voltage_kv} kV`);
      if (comp.props?.rated_mva != null) params.push(`${comp.props.rated_mva} MVA`);
      if (comp.props?.z_percent != null) params.push(`Z: ${comp.props.z_percent}%`);
      if (comp.props?.length_km != null) params.push(`${comp.props.length_km} km`);
      if (comp.props?.rated_current_a != null) params.push(`${comp.props.rated_current_a} A`);
      if (comp.props?.state != null) params.push(comp.props.state);
      rows.push([eName, label, params.join(', ')]);
    }
    doc.autoTable({
      startY: margin + 12,
      margin: { left: margin, right: margin },
      head: [['Name', 'Type', 'Key Parameters']],
      body: rows,
      styles: { fontSize: 9, cellPadding: 2 },
      headStyles: { fillColor: [80, 80, 80], textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [245, 245, 245] },
    });
  },

  // ── Protection Settings Schedule ──

  _renderSettingsSchedule(doc, margin) {
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.text('Protection Device Settings Schedule', margin, margin + 6);
    doc.setFont('helvetica', 'normal');

    const rows = [];
    for (const [id, comp] of AppState.components) {
      const p = comp.props || {};
      const name = p.name || id;

      if (comp.type === 'relay') {
        rows.push([
          name, 'Relay', p.relay_type || '50/51',
          `Curve: ${p.curve || 'IEC SI'}`,
          `Pickup: ${p.pickup_a || '\u2014'} A`,
          `TDS: ${p.time_dial || '\u2014'}`,
          p.voltage_kv ? `${p.voltage_kv} kV` : '\u2014',
        ]);
      } else if (comp.type === 'cb') {
        const type = (p.cb_type || 'mccb').toUpperCase();
        const details = [];
        details.push(`Thermal: ${p.thermal_pickup || 1.0}\u00d7In`);
        details.push(`Mag: ${p.magnetic_pickup || 10}\u00d7In`);
        if (p.cb_type === 'acb') {
          if (p.short_time_pickup) details.push(`ST: ${p.short_time_pickup}\u00d7In @ ${p.short_time_delay || 0.1}s`);
          if (p.instantaneous_pickup) details.push(`Inst: ${p.instantaneous_pickup}\u00d7In`);
        }
        rows.push([
          name, 'CB', type,
          `Rating: ${p.trip_rating_a || p.rated_current_a || '\u2014'} A`,
          details[0] || '\u2014',
          details.slice(1).join(', ') || '\u2014',
          p.voltage_kv ? `${p.voltage_kv} kV` : '\u2014',
        ]);
      } else if (comp.type === 'fuse') {
        rows.push([
          name, 'Fuse', p.fuse_type || 'gG',
          `Rating: ${p.rated_current_a || '\u2014'} A`,
          `Breaking: ${p.breaking_capacity_ka || '\u2014'} kA`,
          '\u2014',
          p.voltage_kv ? `${p.voltage_kv} kV` : '\u2014',
        ]);
      }
    }

    if (rows.length === 0) {
      doc.setFontSize(10);
      doc.text('No protection devices found in the network.', margin, margin + 16);
      return;
    }

    doc.autoTable({
      startY: margin + 12,
      margin: { left: margin, right: margin },
      head: [['Device', 'Type', 'Sub-Type', 'Setting 1', 'Setting 2', 'Setting 3', 'Voltage']],
      body: rows,
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [106, 27, 154], textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [248, 245, 252] },
    });
  },

  // ── Settings Schedule CSV Export ──

  exportSettingsCSV() {
    const lines = [];
    lines.push('Device,Type,Sub-Type,Pickup (A),TDS / Curve,Thermal (×In),Magnetic (×In),ST Pickup (×In),ST Delay (s),Inst (×In),Rating (A),Breaking (kA),Voltage (kV)');

    for (const [id, comp] of AppState.components) {
      const p = comp.props || {};
      const name = (p.name || id).replace(/,/g, ';');

      if (comp.type === 'relay') {
        lines.push([
          name, 'Relay', p.relay_type || '50/51',
          p.pickup_a || '', p.curve || 'IEC SI',
          '', '', '', '', '',
          '', '', p.voltage_kv || '',
        ].join(','));
      } else if (comp.type === 'cb') {
        lines.push([
          name, 'CB', (p.cb_type || 'mccb').toUpperCase(),
          '', '',
          p.thermal_pickup || 1.0, p.magnetic_pickup || 10,
          p.short_time_pickup || '', p.short_time_delay || '',
          p.instantaneous_pickup || '',
          p.trip_rating_a || p.rated_current_a || '', '',
          p.voltage_kv || '',
        ].join(','));
      } else if (comp.type === 'fuse') {
        lines.push([
          name, 'Fuse', p.fuse_type || 'gG',
          '', '', '', '', '', '', '',
          p.rated_current_a || '', p.breaking_capacity_ka || '',
          p.voltage_kv || '',
        ].join(','));
      }
    }

    if (lines.length <= 1) {
      Project._statusMsg('No protection devices to export.');
      return;
    }

    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${AppState.projectName || 'project'}_settings_schedule.csv`;
    a.click();
    URL.revokeObjectURL(url);
    Project._statusMsg('Exported settings schedule as CSV.');
  },

  // ── Scenario Comparison Report ──

  exportComparisonPDF(scenarioIdA, scenarioIdB) {
    const { jsPDF } = window.jspdf;
    if (!jsPDF) {
      Project._statusMsg('PDF library not loaded.');
      return;
    }

    const scA = AppState.scenarios.find(s => s.id === scenarioIdA);
    const scB = AppState.scenarios.find(s => s.id === scenarioIdB);
    if (!scA || !scB) {
      Project._statusMsg('Select two scenarios to compare.');
      return;
    }

    const projName = AppState.projectName || 'Untitled Project';
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const margin = 15;

    // Title
    doc.setFontSize(18);
    doc.setFont('helvetica', 'bold');
    doc.text('Scenario Comparison Report', margin, margin + 6);
    doc.setFontSize(11);
    doc.setFont('helvetica', 'normal');
    doc.text(`Project: ${projName}   |   Date: ${new Date().toLocaleDateString()}`, margin, margin + 14);
    doc.text(`Scenario A: ${scA.name}   vs   Scenario B: ${scB.name}`, margin, margin + 21);

    // Build component maps: scenario.components is an array of { id, type, props, ... }
    const mapA = new Map();
    for (const c of scA.components) mapA.set(c.id, { type: c.type, ...(c.props || {}) });
    const mapB = new Map();
    for (const c of scB.components) mapB.set(c.id, { type: c.type, ...(c.props || {}) });

    // ── Component Differences ──
    const diffRows = [];
    const allIds = new Set([...mapA.keys(), ...mapB.keys()]);

    for (const id of allIds) {
      const propsA = mapA.get(id);
      const propsB = mapB.get(id);

      if (!propsA && propsB) {
        diffRows.push([propsB.name || id, 'Added in B', '\u2014', '\u2014', '\u2014']);
        continue;
      }
      if (propsA && !propsB) {
        diffRows.push([propsA.name || id, 'Removed in B', '\u2014', '\u2014', '\u2014']);
        continue;
      }

      // Compare properties
      const allKeys = new Set([...Object.keys(propsA), ...Object.keys(propsB)]);
      for (const key of allKeys) {
        if (key === 'name' || key === 'x' || key === 'y') continue;
        const vA = propsA[key];
        const vB = propsB[key];
        if (vA !== vB && (vA != null || vB != null)) {
          const name = propsA.name || propsB.name || id;
          diffRows.push([
            name,
            key.replace(/_/g, ' '),
            vA != null ? String(vA) : '\u2014',
            vB != null ? String(vB) : '\u2014',
            this._formatDelta(vA, vB),
          ]);
        }
      }
    }

    if (diffRows.length === 0) {
      doc.setFontSize(11);
      doc.text('No differences found between the two scenarios.', margin, margin + 35);
    } else {
      doc.autoTable({
        startY: margin + 28,
        margin: { left: margin, right: margin },
        head: [['Component', 'Property', `A: ${scA.name}`, `B: ${scB.name}`, 'Delta']],
        body: diffRows,
        styles: { fontSize: 8, cellPadding: 2 },
        headStyles: { fillColor: [0, 120, 215], textColor: 255, fontStyle: 'bold' },
        alternateRowStyles: { fillColor: [240, 248, 255] },
        didParseCell: (data) => {
          if (data.section === 'body' && data.column.index === 4) {
            const val = data.cell.raw;
            if (val && val.startsWith('+')) data.cell.styles.textColor = [46, 125, 50];
            else if (val && val.startsWith('-')) data.cell.styles.textColor = [183, 28, 28];
          }
        },
      });
    }

    // ── Summary counts ──
    const compCountA = scA.components.length;
    const compCountB = scB.components.length;
    const summaryY = doc.lastAutoTable ? doc.lastAutoTable.finalY + 10 : margin + 35;
    doc.setFontSize(10);
    doc.text(`Scenario A: ${compCountA} components   |   Scenario B: ${compCountB} components   |   ${diffRows.length} differences found`, margin, summaryY);

    // Footer
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

    doc.save(`${projName}_comparison_${scA.name}_vs_${scB.name}.pdf`);
    Project._statusMsg('Exported comparison report as PDF.');
  },

  _formatDelta(a, b) {
    if (a == null || b == null) return '\u2014';
    const nA = parseFloat(a);
    const nB = parseFloat(b);
    if (isNaN(nA) || isNaN(nB)) return `${a} \u2192 ${b}`;
    const delta = nB - nA;
    const sign = delta >= 0 ? '+' : '';
    return `${sign}${delta.toFixed(4)}`;
  },

  // ── Report Template Editor Modal ──

  showTemplateEditor() {
    const modal = document.getElementById('calc-modal');
    modal.querySelector('#calc-modal-title').textContent = 'Report Templates';

    const templates = this._getAllTemplates();
    const sectionKeys = Object.keys(this.sectionDefs);

    let html = `
      <div style="display:flex;gap:16px;height:400px;">
        <div style="flex:0 0 200px;overflow-y:auto;border-right:1px solid var(--border-color);padding-right:12px;">
          <h4 style="margin-bottom:8px;">Templates</h4>
          <div id="report-tmpl-list">
            ${templates.map(t => `
              <div class="report-tmpl-item ${t.builtin ? '' : 'user'}" data-id="${t.id}" style="padding:6px 8px;border:1px solid var(--border-color);border-radius:4px;margin-bottom:4px;cursor:pointer;font-size:12px;">
                ${t.name}${t.builtin ? '' : ' <button class="btn-del-tmpl" data-id="' + t.id + '" style="float:right;border:none;background:none;color:#c00;cursor:pointer;">&times;</button>'}
              </div>
            `).join('')}
          </div>
          <div style="margin-top:8px;">
            <input type="text" id="new-tmpl-name" placeholder="New template name" style="width:100%;padding:4px 6px;font-size:12px;border:1px solid var(--border-color);border-radius:4px;">
          </div>
        </div>
        <div style="flex:1;overflow-y:auto;">
          <h4 style="margin-bottom:8px;">Sections</h4>
          <div id="report-section-checklist">
            ${sectionKeys.map(k => `
              <label style="display:flex;align-items:center;gap:6px;padding:4px 0;font-size:12px;cursor:pointer;">
                <input type="checkbox" data-section="${k}">
                <span style="font-weight:500">${this.sectionDefs[k].label}</span>
                <span style="color:var(--text-muted);font-size:10px;margin-left:auto;">${this.sectionDefs[k].group}</span>
              </label>
            `).join('')}
          </div>
          <div style="margin-top:12px;display:flex;gap:8px;">
            <button id="btn-report-save-tmpl" class="btn-small btn-primary">Save as Template</button>
            <button id="btn-report-export" class="btn-small btn-primary">Export PDF</button>
          </div>
        </div>
      </div>
    `;

    modal.querySelector('#calc-modal-body').innerHTML = html;
    modal.style.display = '';

    // Select first template
    const firstTmpl = templates[0];
    if (firstTmpl) this._selectTemplate(firstTmpl.id);

    // Template list click
    document.getElementById('report-tmpl-list').addEventListener('click', (e) => {
      const item = e.target.closest('[data-id]');
      if (!item) return;
      if (e.target.classList.contains('btn-del-tmpl')) {
        this.deleteUserTemplate(e.target.dataset.id);
        this.showTemplateEditor();
        return;
      }
      this._selectTemplate(item.dataset.id);
    });

    // Save as template
    document.getElementById('btn-report-save-tmpl').addEventListener('click', () => {
      const name = document.getElementById('new-tmpl-name').value.trim();
      if (!name) { document.getElementById('new-tmpl-name').focus(); return; }
      const sections = this._getCheckedSections();
      if (sections.length === 0) { alert('Select at least one section.'); return; }
      this.saveUserTemplate(name, sections);
      this.showTemplateEditor();
    });

    // Export PDF
    document.getElementById('btn-report-export').addEventListener('click', () => {
      const sections = this._getCheckedSections();
      if (sections.length === 0) { alert('Select at least one section.'); return; }
      // Create a temporary template and export
      const tmpId = '_tmp_' + Date.now();
      const tmpl = { id: tmpId, name: 'Custom Export', sections };
      this.defaultTemplates.push(tmpl);
      this.exportWithTemplate(tmpId);
      this.defaultTemplates.pop();
      modal.style.display = 'none';
    });
  },

  _selectTemplate(id) {
    const tmpl = this._getAllTemplates().find(t => t.id === id);
    if (!tmpl) return;

    // Highlight in list
    document.querySelectorAll('#report-tmpl-list [data-id]').forEach(el => {
      el.style.background = el.dataset.id === id ? 'rgba(0,120,215,0.1)' : '';
      el.style.borderColor = el.dataset.id === id ? 'var(--accent)' : 'var(--border-color)';
    });

    // Check the sections
    document.querySelectorAll('#report-section-checklist input[type="checkbox"]').forEach(cb => {
      cb.checked = tmpl.sections.includes(cb.dataset.section);
    });

    document.getElementById('new-tmpl-name').value = tmpl.builtin ? '' : tmpl.name;
  },

  _getCheckedSections() {
    const sections = [];
    document.querySelectorAll('#report-section-checklist input[type="checkbox"]:checked').forEach(cb => {
      sections.push(cb.dataset.section);
    });
    return sections;
  },

  // ── Scenario Comparison UI ──

  showComparisonDialog() {
    const scenarios = AppState.scenarios;
    if (scenarios.length < 2) {
      alert('Save at least 2 scenarios before comparing.');
      return;
    }

    const modal = document.getElementById('calc-modal');
    modal.querySelector('#calc-modal-title').textContent = 'Compare Scenarios';

    const options = scenarios.map(s => `<option value="${s.id}">${s.name} (${new Date(s.timestamp).toLocaleDateString()})</option>`).join('');

    modal.querySelector('#calc-modal-body').innerHTML = `
      <div style="max-width:400px;">
        <div class="tcc-form-row" style="margin-bottom:12px;">
          <label for="compare-sc-a" style="font-weight:600;">Scenario A (Before)</label>
          <select id="compare-sc-a" style="width:100%;padding:6px;font-size:12px;border:1px solid var(--border-color);border-radius:4px;">${options}</select>
        </div>
        <div class="tcc-form-row" style="margin-bottom:16px;">
          <label for="compare-sc-b" style="font-weight:600;">Scenario B (After)</label>
          <select id="compare-sc-b" style="width:100%;padding:6px;font-size:12px;border:1px solid var(--border-color);border-radius:4px;">${options}</select>
        </div>
        <button id="btn-run-comparison" class="btn-primary">Generate Comparison PDF</button>
      </div>
    `;

    // Default to second scenario for B
    if (scenarios.length >= 2) {
      document.getElementById('compare-sc-b').value = scenarios[1].id;
    }

    modal.style.display = '';

    document.getElementById('btn-run-comparison').addEventListener('click', () => {
      const idA = document.getElementById('compare-sc-a').value;
      const idB = document.getElementById('compare-sc-b').value;
      if (idA === idB) { alert('Select two different scenarios.'); return; }
      modal.style.display = 'none';
      this.exportComparisonPDF(idA, idB);
    });
  },
};
