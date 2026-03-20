/* ProtectionPro — Compliance Report Engine
 *
 * Generates an IEC 60909 / IEC 60364 compliance report by cross-checking
 * analysis results against equipment ratings and standards limits.
 *
 * Sections:
 *   1. Network Validation
 *   2. Fault Duty Assessment (IEC 60909)
 *   3. Voltage Compliance (IEC 60038)
 *   4. Thermal Loading (IEC 60364)
 *   5. Equipment Summary
 */

const Compliance = {

  // Run all checks and return structured report data
  generate() {
    const report = {
      projectName: AppState.projectName || 'Untitled Project',
      baseMVA: AppState.baseMVA,
      frequency: AppState.frequency,
      timestamp: new Date().toISOString(),
      hasFault: !!(AppState.faultResults && AppState.faultResults.buses && Object.keys(AppState.faultResults.buses).length > 0),
      hasLoadFlow: !!(AppState.loadFlowResults && AppState.loadFlowResults.buses && Object.keys(AppState.loadFlowResults.buses).length > 0),
      sections: [],
      totals: { pass: 0, fail: 0, warn: 0, info: 0 },
    };

    report.sections.push(this._checkNetworkValidation());
    report.sections.push(this._checkFaultDuty());
    report.sections.push(this._checkVoltageCompliance());
    report.sections.push(this._checkThermalLoading());
    report.sections.push(this._checkProtectionDevices());
    report.sections.push(this._buildEquipmentSummary());

    // Tally totals
    for (const section of report.sections) {
      for (const item of section.items) {
        report.totals[item.status]++;
      }
    }

    return report;
  },

  // ── 1. Network Validation ──
  _checkNetworkValidation() {
    const section = { title: 'Network Validation', standard: 'General', items: [] };
    const { errors, warnings } = Components.validate();

    for (const e of errors) {
      section.items.push({ status: 'fail', component: e.id || '—', message: e.msg, detail: 'Must be resolved before analysis.' });
    }
    for (const w of warnings) {
      section.items.push({ status: 'warn', component: w.id || '—', message: w.msg, detail: 'May affect results accuracy.' });
    }

    if (errors.length === 0 && warnings.length === 0) {
      section.items.push({ status: 'pass', component: '—', message: 'Network topology is valid.', detail: 'All components connected, sources and buses present.' });
    }

    // Check swing bus
    let hasSwing = false;
    for (const comp of AppState.components.values()) {
      if (comp.type === 'bus' && comp.props?.bus_type === 'Swing') hasSwing = true;
    }
    if (!hasSwing) {
      section.items.push({ status: 'warn', component: '—', message: 'No Swing (slack) bus defined.', detail: 'Load flow requires a Swing bus as voltage reference. One bus will be assumed.' });
    }

    return section;
  },

  // ── 2. Fault Duty Assessment (IEC 60909) ──
  _checkFaultDuty() {
    const section = { title: 'Fault Duty Assessment', standard: 'IEC 60909', items: [] };

    if (!this._hasFault()) {
      section.items.push({ status: 'info', component: '—', message: 'Fault analysis not run.', detail: 'Run Fault Analysis to check equipment duty ratings.' });
      return section;
    }

    const faultBuses = AppState.faultResults.buses;

    // For each bus, find connected CBs, fuses, and check breaking capacity
    for (const [busId, faultResult] of Object.entries(faultBuses)) {
      const busComp = AppState.components.get(busId);
      const busName = busComp?.props?.name || busId;
      const ik3 = faultResult.ik3;
      if (ik3 == null) continue;

      // Find protection devices connected to this bus (walk through wires)
      const connectedDevices = this._findConnectedDevices(busId, ['cb', 'fuse']);

      for (const dev of connectedDevices) {
        const devComp = AppState.components.get(dev.id);
        if (!devComp) continue;
        const devName = devComp.props?.name || dev.id;
        const breakingKA = devComp.props?.breaking_capacity_ka;

        if (breakingKA == null || breakingKA <= 0) {
          section.items.push({
            status: 'warn',
            component: devName,
            message: `No breaking capacity specified for ${devComp.type === 'cb' ? 'circuit breaker' : 'fuse'}.`,
            detail: `Cannot verify fault duty at bus ${busName}.`,
          });
          continue;
        }

        if (ik3 > breakingKA) {
          section.items.push({
            status: 'fail',
            component: devName,
            message: `Fault current (${ik3.toFixed(2)} kA) EXCEEDS breaking capacity (${breakingKA} kA).`,
            detail: `At bus ${busName}. ${devComp.type === 'cb' ? 'Circuit breaker' : 'Fuse'} is under-rated for the prospective fault level. Replace with higher rated device.`,
          });
        } else {
          const margin = ((breakingKA / ik3) - 1) * 100;
          section.items.push({
            status: 'pass',
            component: devName,
            message: `Fault current (${ik3.toFixed(2)} kA) within breaking capacity (${breakingKA} kA).`,
            detail: `At bus ${busName}. Margin: ${margin.toFixed(1)}%.`,
          });
        }
      }

      // Check if bus has NO protection devices
      if (connectedDevices.length === 0) {
        section.items.push({
          status: 'warn',
          component: busName,
          message: `No circuit breaker or fuse connected to bus.`,
          detail: `I"k3 = ${ik3.toFixed(2)} kA. Consider adding protection.`,
        });
      }
    }

    return section;
  },

  // ── 3. Voltage Compliance (IEC 60038) ──
  _checkVoltageCompliance() {
    const section = { title: 'Voltage Compliance', standard: 'IEC 60038', items: [] };

    if (!this._hasLoadFlow()) {
      section.items.push({ status: 'info', component: '—', message: 'Load flow not run.', detail: 'Run Load Flow to check voltage compliance.' });
      return section;
    }

    if (!AppState.loadFlowResults.converged) {
      section.items.push({ status: 'fail', component: '—', message: 'Load flow did NOT converge.', detail: 'Results may be unreliable. Check network configuration and bus types.' });
    }

    const lfBuses = AppState.loadFlowResults.buses;

    for (const [busId, lfResult] of Object.entries(lfBuses)) {
      const busComp = AppState.components.get(busId);
      const busName = busComp?.props?.name || busId;
      const nominalKV = busComp?.props?.voltage_kv || busComp?.props?.voltage;
      const vpu = lfResult.voltage_pu;

      // IEC 60038 limits: ±5% for MV/HV, ±10% for LV allowed in some standards
      // We use ±5% as the standard compliance threshold
      const lo = 0.95;
      const hi = 1.05;

      if (vpu < lo) {
        section.items.push({
          status: 'fail',
          component: busName,
          message: `Under-voltage: ${vpu.toFixed(4)} p.u. (${lfResult.voltage_kv.toFixed(2)} kV).`,
          detail: `Below ${lo} p.u. limit. Nominal: ${nominalKV || '?'} kV. Consider reactive compensation or tap adjustment.`,
        });
      } else if (vpu > hi) {
        section.items.push({
          status: 'fail',
          component: busName,
          message: `Over-voltage: ${vpu.toFixed(4)} p.u. (${lfResult.voltage_kv.toFixed(2)} kV).`,
          detail: `Above ${hi} p.u. limit. Nominal: ${nominalKV || '?'} kV. Check tap settings and reactive sources.`,
        });
      } else {
        section.items.push({
          status: 'pass',
          component: busName,
          message: `Voltage: ${vpu.toFixed(4)} p.u. (${lfResult.voltage_kv.toFixed(2)} kV).`,
          detail: `Within ${lo}–${hi} p.u. range. Nominal: ${nominalKV || '?'} kV.`,
        });
      }
    }

    return section;
  },

  // ── 4. Thermal Loading (IEC 60364) ──
  _checkThermalLoading() {
    const section = { title: 'Thermal Loading', standard: 'IEC 60364 / IEC 60076', items: [] };

    if (!this._hasLoadFlow()) {
      section.items.push({ status: 'info', component: '—', message: 'Load flow not run.', detail: 'Run Load Flow to check equipment loading.' });
      return section;
    }

    const branches = AppState.loadFlowResults.branches || [];

    for (const br of branches) {
      const comp = AppState.components.get(br.elementId);
      if (!comp) continue;
      const name = comp.props?.name || br.elementId;
      const loading = br.loading_pct;
      const current = br.i_amps;

      if (loading == null || loading <= 0) continue;

      if (comp.type === 'cable') {
        const ratedAmps = comp.props?.rated_amps;
        if (loading > 100) {
          section.items.push({
            status: 'fail',
            component: name,
            message: `Cable OVERLOADED: ${loading.toFixed(1)}% (${current.toFixed(1)} A / ${ratedAmps} A rated).`,
            detail: `Exceeds continuous current rating per IEC 60364-5-52. Upsize cable, reduce load, or add parallel run.`,
          });
        } else if (loading > 80) {
          section.items.push({
            status: 'warn',
            component: name,
            message: `Cable heavily loaded: ${loading.toFixed(1)}% (${current.toFixed(1)} A / ${ratedAmps} A rated).`,
            detail: `Above 80% utilisation. Limited headroom for derating factors or future load growth.`,
          });
        } else {
          section.items.push({
            status: 'pass',
            component: name,
            message: `Cable loading: ${loading.toFixed(1)}% (${current.toFixed(1)} A / ${ratedAmps} A rated).`,
            detail: `Within acceptable limits.`,
          });
        }
      } else if (comp.type === 'transformer') {
        const ratedMVA = comp.props?.rated_mva || comp.props?.ratedMVA;
        if (loading > 100) {
          section.items.push({
            status: 'fail',
            component: name,
            message: `Transformer OVERLOADED: ${loading.toFixed(1)}% of ${ratedMVA} MVA rating.`,
            detail: `Exceeds nameplate rating per IEC 60076. Risk of thermal damage and reduced lifespan.`,
          });
        } else if (loading > 80) {
          section.items.push({
            status: 'warn',
            component: name,
            message: `Transformer heavily loaded: ${loading.toFixed(1)}% of ${ratedMVA} MVA rating.`,
            detail: `Above 80% utilisation. Consider ambient temperature derating per IEC 60076-7.`,
          });
        } else {
          section.items.push({
            status: 'pass',
            component: name,
            message: `Transformer loading: ${loading.toFixed(1)}% of ${ratedMVA} MVA rating.`,
            detail: `Within acceptable limits.`,
          });
        }
      }
    }

    if (branches.length === 0) {
      section.items.push({ status: 'info', component: '—', message: 'No branch flow data available.', detail: 'Ensure cables and transformers connect buses.' });
    }

    return section;
  },

  // ── 5. Protection Device Checks ──
  _checkProtectionDevices() {
    const section = { title: 'Protection Device Ratings', standard: 'IEC 62271 / IEC 60947', items: [] };

    // Check CB and fuse rated voltages match bus voltage
    for (const [id, comp] of AppState.components) {
      if (comp.type !== 'cb' && comp.type !== 'fuse' && comp.type !== 'switch') continue;
      const name = comp.props?.name || id;
      const ratedV = comp.props?.rated_voltage_kv;
      if (!ratedV) continue;

      // Find the bus this device is connected to
      const buses = this._findConnectedDevices(id, ['bus']);
      for (const b of buses) {
        const busComp = AppState.components.get(b.id);
        if (!busComp) continue;
        const busV = busComp.props?.voltage_kv || busComp.props?.voltage;
        if (!busV) continue;
        const busName = busComp.props?.name || b.id;

        if (ratedV < busV) {
          section.items.push({
            status: 'fail',
            component: name,
            message: `Rated voltage (${ratedV} kV) is BELOW bus voltage (${busV} kV).`,
            detail: `Connected to bus ${busName}. Device is under-rated for the system voltage.`,
          });
        } else {
          section.items.push({
            status: 'pass',
            component: name,
            message: `Rated voltage (${ratedV} kV) adequate for bus voltage (${busV} kV).`,
            detail: `Connected to bus ${busName}.`,
          });
          break; // One pass check per device is enough
        }
      }

      // Check rated current vs load flow current (if available)
      if (this._hasLoadFlow() && (comp.type === 'cb' || comp.type === 'fuse')) {
        const ratedI = comp.props?.rated_current_a;
        if (!ratedI) continue;

        // Find branch flow through adjacent cables/transformers
        const adjBranches = this._findAdjacentBranchCurrents(id);
        for (const ab of adjBranches) {
          if (ab.current > ratedI) {
            section.items.push({
              status: 'fail',
              component: name,
              message: `Load current (${ab.current.toFixed(1)} A) EXCEEDS rated current (${ratedI} A).`,
              detail: `Through adjacent ${ab.branchName}. Device will trip or be damaged under normal load.`,
            });
          }
        }
      }
    }

    if (section.items.length === 0) {
      section.items.push({ status: 'info', component: '—', message: 'No protection devices to check.', detail: 'Add circuit breakers or fuses to the network for protection compliance checks.' });
    }

    return section;
  },

  // ── 6. Equipment Summary ──
  _buildEquipmentSummary() {
    const section = { title: 'Equipment Inventory', standard: 'Reference', items: [] };
    const counts = {};
    for (const comp of AppState.components.values()) {
      const def = COMPONENT_DEFS[comp.type];
      const label = def ? def.label : comp.type;
      counts[label] = (counts[label] || 0) + 1;
    }
    for (const [type, count] of Object.entries(counts)) {
      section.items.push({ status: 'info', component: '—', message: `${type}: ${count}`, detail: '' });
    }
    if (AppState.components.size === 0) {
      section.items.push({ status: 'info', component: '—', message: 'No equipment in the network.', detail: '' });
    }
    return section;
  },

  // ── Helpers ──

  _hasFault() {
    return !!(AppState.faultResults && AppState.faultResults.buses && Object.keys(AppState.faultResults.buses).length > 0);
  },

  _hasLoadFlow() {
    return !!(AppState.loadFlowResults && AppState.loadFlowResults.buses && Object.keys(AppState.loadFlowResults.buses).length > 0);
  },

  // Walk through wires to find components of given types connected to a component
  _findConnectedDevices(compId, types) {
    const found = [];
    const visited = new Set();
    const queue = [compId];
    visited.add(compId);

    while (queue.length > 0) {
      const current = queue.shift();
      // Find all wires connected to current component
      for (const wire of AppState.wires.values()) {
        let neighborId = null;
        if (wire.from === current) neighborId = wire.to;
        else if (wire.to === current) neighborId = wire.from;
        if (!neighborId || visited.has(neighborId)) continue;

        // Extract component ID from port reference (format: "compId_portSide")
        const neighborCompId = this._extractCompId(neighborId);
        if (!neighborCompId || visited.has(neighborCompId)) continue;
        visited.add(neighborCompId);

        const neighborComp = AppState.components.get(neighborCompId);
        if (!neighborComp) continue;

        if (types.includes(neighborComp.type)) {
          found.push({ id: neighborCompId, type: neighborComp.type });
        }

        // Walk through transparent elements (CBs, switches, fuses, CTs, PTs, arresters)
        const transparent = ['cb', 'fuse', 'switch', 'ct', 'pt', 'surge_arrester'];
        if (transparent.includes(neighborComp.type) && !types.includes(neighborComp.type)) {
          queue.push(neighborCompId);
        }
      }
    }
    return found;
  },

  _extractCompId(portRef) {
    // Port references are like "comp_id_top" or "comp_id_bottom"
    // Component IDs contain underscores, so we match against known component IDs
    for (const id of AppState.components.keys()) {
      if (portRef.startsWith(id + '_') || portRef === id) return id;
    }
    // Fallback: strip last segment
    const parts = portRef.split('_');
    if (parts.length > 1) {
      parts.pop();
      return parts.join('_');
    }
    return portRef;
  },

  _findAdjacentBranchCurrents(deviceId) {
    if (!this._hasLoadFlow()) return [];
    const results = [];
    const branches = AppState.loadFlowResults.branches || [];

    // Find cables/transformers connected through this device
    const connBranches = this._findConnectedDevices(deviceId, ['cable', 'transformer']);
    for (const cb of connBranches) {
      const br = branches.find(b => b.elementId === cb.id);
      if (br && br.i_amps > 0) {
        const comp = AppState.components.get(cb.id);
        results.push({ branchName: comp?.props?.name || cb.id, current: br.i_amps });
      }
    }
    return results;
  },

  // ── Render to HTML ──

  renderHTML(report) {
    const statusIcon = { pass: '\u2705', fail: '\u274C', warn: '\u26A0\uFE0F', info: '\u2139\uFE0F' };
    const statusLabel = { pass: 'PASS', fail: 'FAIL', warn: 'WARNING', info: 'INFO' };

    let html = `<div class="compliance-header">
      <div class="compliance-meta">
        <strong>${report.projectName}</strong> &mdash;
        Base: ${report.baseMVA} MVA, ${report.frequency} Hz &mdash;
        Generated: ${new Date(report.timestamp).toLocaleString()}
      </div>
    </div>`;

    for (const section of report.sections) {
      const sectionCounts = { pass: 0, fail: 0, warn: 0, info: 0 };
      for (const item of section.items) sectionCounts[item.status]++;

      let badge = '';
      if (sectionCounts.fail > 0) badge = `<span class="compliance-badge badge-fail">${sectionCounts.fail} FAIL</span>`;
      else if (sectionCounts.warn > 0) badge = `<span class="compliance-badge badge-warn">${sectionCounts.warn} WARN</span>`;
      else if (sectionCounts.pass > 0) badge = `<span class="compliance-badge badge-pass">ALL PASS</span>`;
      else badge = `<span class="compliance-badge badge-info">INFO</span>`;

      html += `<div class="compliance-section">
        <div class="compliance-section-header">
          <h4>${section.title} <span class="compliance-standard">${section.standard}</span></h4>
          ${badge}
        </div>
        <table class="compliance-table">
          <thead><tr><th></th><th>Component</th><th>Check</th><th>Detail</th></tr></thead>
          <tbody>`;

      for (const item of section.items) {
        html += `<tr class="compliance-row compliance-${item.status}">
          <td class="compliance-status-cell">${statusIcon[item.status]}</td>
          <td class="compliance-comp-cell">${item.component}</td>
          <td>${item.message}</td>
          <td class="compliance-detail-cell">${item.detail}</td>
        </tr>`;
      }

      html += `</tbody></table></div>`;
    }

    return html;
  },

  // ── Export to PDF ──

  exportPDF(report) {
    const { jsPDF } = window.jspdf;
    if (!jsPDF) return;

    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const margin = 15;
    const name = report.projectName;

    // Title
    doc.setFontSize(16);
    doc.setFont('helvetica', 'bold');
    doc.text('ProtectionPro \u2014 Compliance Report', margin, margin + 6);
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.text(`Project: ${name}  |  Base MVA: ${report.baseMVA}  |  Frequency: ${report.frequency} Hz`, margin, margin + 13);
    doc.text(`Generated: ${new Date(report.timestamp).toLocaleString()}`, margin, margin + 19);

    // Summary
    const t = report.totals;
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.text('Summary', margin, margin + 28);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.text(`Pass: ${t.pass}   |   Fail: ${t.fail}   |   Warnings: ${t.warn}   |   Info: ${t.info}`, margin, margin + 34);

    let startY = margin + 42;

    const statusSymbol = { pass: 'PASS', fail: 'FAIL', warn: 'WARN', info: 'INFO' };
    const statusColor = {
      pass: [46, 125, 50],
      fail: [211, 47, 47],
      warn: [245, 124, 0],
      info: [100, 100, 100],
    };

    for (const section of report.sections) {
      // Check if we need a new page
      if (startY > pageH - 50) {
        doc.addPage();
        startY = margin + 6;
      }

      doc.setFontSize(12);
      doc.setFont('helvetica', 'bold');
      doc.text(`${section.title}  (${section.standard})`, margin, startY);
      doc.setFont('helvetica', 'normal');
      startY += 4;

      const tableData = section.items.map(item => [
        statusSymbol[item.status],
        item.component,
        item.message,
        item.detail,
      ]);

      doc.autoTable({
        startY: startY,
        margin: { left: margin, right: margin },
        head: [['Status', 'Component', 'Check', 'Detail']],
        body: tableData,
        styles: { fontSize: 7.5, cellPadding: 2, overflow: 'linebreak' },
        headStyles: { fillColor: [60, 60, 60], textColor: 255, fontStyle: 'bold', fontSize: 8 },
        columnStyles: {
          0: { cellWidth: 14, halign: 'center', fontStyle: 'bold' },
          1: { cellWidth: 28 },
          2: { cellWidth: 'auto' },
          3: { cellWidth: 55, fontSize: 7, textColor: [100, 100, 100] },
        },
        didParseCell: (data) => {
          if (data.section === 'body' && data.column.index === 0) {
            const status = data.cell.raw;
            const colorMap = { PASS: [46, 125, 50], FAIL: [211, 47, 47], WARN: [245, 124, 0], INFO: [100, 100, 100] };
            data.cell.styles.textColor = colorMap[status] || [0, 0, 0];
          }
        },
        alternateRowStyles: { fillColor: [248, 248, 248] },
      });

      startY = doc.lastAutoTable.finalY + 8;
    }

    // Footer on all pages
    const totalPages = doc.internal.getNumberOfPages();
    for (let i = 1; i <= totalPages; i++) {
      doc.setPage(i);
      doc.setFontSize(7);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(150);
      doc.text(`ProtectionPro Compliance Report \u2014 ${name}`, margin, pageH - 5);
      doc.text(`Page ${i} of ${totalPages}`, pageW - margin, pageH - 5, { align: 'right' });
      doc.setTextColor(0);
    }

    doc.save(`${name}_compliance.pdf`);
  },
};
