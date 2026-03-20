/* ProtectionPro — Reports: Templates, Comparison, Settings Schedule */

const Reports = {

  // ── Report Template System ──
  // Templates define which sections to include and in what order.

  defaultTemplates: [
    {
      id: 'full',
      name: 'Full Analysis Report',
      builtin: true,
      sections: ['title', 'diagram', 'fault', 'fault_branches', 'voltage_depression', 'loadflow_bus', 'loadflow_branch', 'equipment', 'arcflash'],
    },
    {
      id: 'fault_only',
      name: 'Fault Analysis Only',
      builtin: true,
      sections: ['title', 'fault', 'fault_branches', 'voltage_depression'],
    },
    {
      id: 'arcflash_report',
      name: 'Arc Flash Report',
      builtin: true,
      sections: ['title', 'arcflash'],
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
    voltage_depression: { label: 'Voltage Depression',          group: 'Fault Analysis' },
    arcflash:           { label: 'Arc Flash Summary',           group: 'Arc Flash' },
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

  async exportWithTemplate(templateId) {
    const tmpl = this._getAllTemplates().find(t => t.id === templateId);
    if (!tmpl) return;

    // Filter out 'diagram' — server-side doesn't handle diagram rasterization
    const sections = tmpl.sections.filter(s => s !== 'diagram');
    Project._statusMsg(`Generating "${tmpl.name}" PDF...`);
    try {
      const blob = await API.generateReport(sections);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${AppState.projectName || 'Untitled'}_${tmpl.id}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      Project._statusMsg(`Exported "${tmpl.name}" as PDF.`);
    } catch (e) {
      Project._statusMsg(`PDF export failed: ${e.message}`);
      console.error('Template PDF export error:', e);
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

  _renderVoltageDepression(doc, margin) {
    if (!AppState.faultResults?.buses) return;
    // Collect voltage depression data from all faulted buses
    const allEntries = [];
    for (const [busId, r] of Object.entries(AppState.faultResults.buses)) {
      if (!r.voltage_depression) continue;
      const faultBusName = AppState.components.get(busId)?.props?.name || busId;
      for (const [depId, d] of Object.entries(r.voltage_depression)) {
        if (depId === busId) continue;
        const depName = d.bus_name || AppState.components.get(depId)?.props?.name || depId;
        const vSub = d.subtransient_pu != null ? d.subtransient_pu : 1;
        const vTr = d.transient_pu != null ? d.transient_pu : vSub;
        const vSS = d.steadystate_pu != null ? d.steadystate_pu : vTr;
        const worst = Math.min(vSub, vTr, vSS);
        const status = worst >= 0.8 ? 'Normal' : worst >= 0.5 ? 'Moderate Sag' : worst >= 0.3 ? 'Severe Sag' : 'Near Collapse';
        allEntries.push([
          faultBusName, depName,
          (d.voltage_kv || 0).toFixed(1),
          (vSub * 100).toFixed(1) + '%',
          (vTr * 100).toFixed(1) + '%',
          (vSS * 100).toFixed(1) + '%',
          (d.retained_kv || 0).toFixed(2),
          status,
        ]);
      }
    }
    if (allEntries.length === 0) return;

    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.text('Voltage Depression During Fault', margin, margin + 6);
    doc.setFont('helvetica', 'normal');
    doc.autoTable({
      startY: margin + 12,
      margin: { left: margin, right: margin },
      head: [['Faulted Bus', 'Affected Bus', 'Rated kV', 'Sub-transient', 'Transient', 'Steady-state', 'Retained kV', 'Status']],
      body: allEntries,
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [0, 120, 215], textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [240, 248, 255] },
      columnStyles: {
        2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' },
        5: { halign: 'right' }, 6: { halign: 'right' },
      },
    });
  },

  _renderArcFlash(doc, margin) {
    if (!AppState.arcFlashResults?.buses) return;
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.text('Arc Flash Analysis \u2014 IEEE 1584-2018', margin, margin + 6);
    doc.setFont('helvetica', 'normal');

    const rows = [];
    for (const [busId, r] of Object.entries(AppState.arcFlashResults.buses)) {
      const name = AppState.components.get(busId)?.props?.name || busId;
      rows.push([
        name,
        r.voltage_kv != null ? Number(r.voltage_kv).toFixed(1) : '\u2014',
        r.bolted_fault_ka != null ? Number(r.bolted_fault_ka).toFixed(2) : '\u2014',
        r.arcing_current_ka != null ? Number(r.arcing_current_ka).toFixed(2) : '\u2014',
        r.incident_energy_cal != null ? Number(r.incident_energy_cal).toFixed(2) : '\u2014',
        r.ppe_category != null ? String(r.ppe_category) : '\u2014',
        r.arc_flash_boundary_mm != null ? (Number(r.arc_flash_boundary_mm) / 1000).toFixed(2) : '\u2014',
        r.working_distance_mm != null ? String(r.working_distance_mm) : '\u2014',
      ]);
    }
    doc.autoTable({
      startY: margin + 12,
      margin: { left: margin, right: margin },
      head: [['Bus', 'V (kV)', 'Ibf (kA)', 'Iarc (kA)', 'E (cal/cm\u00b2)', 'PPE Cat', 'AFB (m)', 'WD (mm)']],
      body: rows,
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [213, 0, 0], textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [255, 245, 245] },
      columnStyles: {
        1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' },
        4: { halign: 'right' }, 5: { halign: 'center' }, 6: { halign: 'right' }, 7: { halign: 'right' },
      },
    });
  },

  // ── Arc Flash Label Export (NFPA 70E) ──

  async exportArcFlashLabels() {
    if (!AppState.arcFlashResults?.buses || Object.keys(AppState.arcFlashResults.buses).length === 0) {
      Project._statusMsg('No arc flash results. Run Arc Flash analysis first.');
      return;
    }
    Project._statusMsg('Generating arc flash labels...');
    try {
      const blob = await API.generateArcFlashLabels();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${AppState.projectName || 'Untitled'}_ArcFlash_Labels.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      Project._statusMsg('Exported arc flash labels as PDF.');
    } catch (e) {
      Project._statusMsg(`Arc flash labels export failed: ${e.message}`);
    }
  },

  _drawArcFlashLabel(doc, x, y, w, h, busName, r, projName) {
    // Danger header
    const dangerH = 12;
    doc.setFillColor(213, 0, 0);
    doc.rect(x, y, w, dangerH, 'F');
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(255, 255, 255);
    doc.text('DANGER', x + w / 2, y + dangerH / 2 + 1, { align: 'center', baseline: 'middle' });
    doc.setFontSize(7);
    doc.text('ARC FLASH AND SHOCK HAZARD', x + w / 2, y + dangerH - 2, { align: 'center' });

    // Orange warning stripe
    doc.setFillColor(255, 152, 0);
    doc.rect(x, y + dangerH, w, 3, 'F');

    // Body
    const bodyY = y + dangerH + 3;
    const bodyH = h - dangerH - 3;
    doc.setFillColor(255, 255, 255);
    doc.rect(x, bodyY, w, bodyH, 'F');

    // Border
    doc.setDrawColor(0);
    doc.setLineWidth(0.5);
    doc.rect(x, y, w, h);

    doc.setTextColor(0, 0, 0);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.text(busName, x + 4, bodyY + 6);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.text(projName, x + w - 4, bodyY + 6, { align: 'right' });

    // Label data
    const lineH = 5.5;
    let ly = bodyY + 12;

    const energy = r.incident_energy_cal != null ? r.incident_energy_cal.toFixed(2) : '—';
    const ppe = r.ppe_category != null ? r.ppe_category : '—';
    const afb = r.arc_flash_boundary_mm != null ? (r.arc_flash_boundary_mm / 1000).toFixed(2) : '—';
    const iarc = r.arcing_current_ka != null ? r.arcing_current_ka.toFixed(2) : '—';
    const ibf = r.bolted_fault_ka != null ? r.bolted_fault_ka.toFixed(2) : '—';
    const wd = r.working_distance_mm != null ? r.working_distance_mm : '—';
    const vkv = r.voltage_kv != null ? r.voltage_kv : '—';

    const labelData = [
      ['Incident Energy:', `${energy} cal/cm²`],
      ['PPE Category:', `Cat ${ppe}`],
      ['Arc Flash Boundary:', `${afb} m`],
      ['Arcing Current:', `${iarc} kA`],
      ['Bolted Fault Current:', `${ibf} kA`],
      ['Working Distance:', `${wd} mm`],
      ['Nominal Voltage:', `${vkv} kV`],
    ];

    doc.setFontSize(8);
    for (const [label, value] of labelData) {
      doc.setFont('helvetica', 'bold');
      doc.text(label, x + 4, ly);
      doc.setFont('helvetica', 'normal');
      doc.text(value, x + 46, ly);
      ly += lineH;
    }

    // Footer
    doc.setFontSize(6);
    doc.setTextColor(100);
    doc.text('NFPA 70E / IEEE 1584-2018', x + 4, y + h - 2);
    doc.text(new Date().toLocaleDateString(), x + w - 4, y + h - 2, { align: 'right' });
    doc.setTextColor(0);
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
