/* ProtectionPro — On-Diagram Annotations for Fault & Load Flow Results */

const Annotations = {
  layer: null,

  // Draggable offsets stored as { [key]: { dx, dy } }
  // Keys: "fault:{busId}", "lf:{busId}", "br:{elementId}" or "br:{from}_{to}"
  offsets: new Map(),

  init() {
    this.layer = document.getElementById('annotations-layer');
  },

  // Format voltage using the user's selected unit (kV or V)
  formatVoltage(kv) {
    const unit = Properties.unitSelections['voltage_kv'] || 'kV';
    if (unit === 'V') {
      return `${(kv * 1000).toFixed(1)} V`;
    }
    return `${kv.toFixed(3)} kV`;
  },

  getOffset(key) {
    return this.offsets.get(key) || { dx: 0, dy: 0 };
  },

  setOffset(key, dx, dy) {
    this.offsets.set(key, { dx, dy });
  },

  render() {
    if (!this.layer) return;
    let html = '';

    // Fault result annotations on buses
    if (AppState.faultResults && AppState.faultResults.buses) {
      for (const [busId, result] of Object.entries(AppState.faultResults.buses)) {
        const comp = AppState.components.get(busId);
        if (!comp) continue;
        const key = `fault:${busId}`;
        const off = this.getOffset(key);
        const x = comp.x + 70 + off.dx;
        const y = comp.y - 10 + off.dy;
        html += this.renderFaultBadge(x, y, result, key);
      }
    }

    // Load flow annotations on buses
    if (AppState.loadFlowResults && AppState.loadFlowResults.buses) {
      for (const [busId, result] of Object.entries(AppState.loadFlowResults.buses)) {
        const comp = AppState.components.get(busId);
        if (!comp) continue;
        const key = `lf:${busId}`;
        const off = this.getOffset(key);
        const x = comp.x - 130 + off.dx;
        const y = comp.y - 10 + off.dy;
        html += this.renderLoadFlowBadge(x, y, result, key);
      }
    }

    // Branch flow badges are NOT rendered here — they are shown as inline
    // data labels on each component by Canvas.renderComponentDataLabels().

    // Unbalanced load flow annotations on buses
    if (AppState.unbalancedLoadFlowResults && AppState.unbalancedLoadFlowResults.buses) {
      for (const [busId, result] of Object.entries(AppState.unbalancedLoadFlowResults.buses)) {
        const comp = AppState.components.get(busId);
        if (!comp) continue;
        const key = `ulf:${busId}`;
        const off = this.getOffset(key);
        const x = comp.x - 160 + off.dx;
        const y = comp.y + 20 + off.dy;
        html += this.renderUnbalancedLoadFlowBadge(x, y, result, key);
      }
    }

    // Unbalanced load flow VUF warnings
    if (AppState.unbalancedLoadFlowResults && AppState.unbalancedLoadFlowResults.warnings) {
      for (const warn of AppState.unbalancedLoadFlowResults.warnings) {
        const comp = AppState.components.get(warn.elementId);
        if (!comp) continue;
        const key = `ulf-warn:${warn.elementId}`;
        const off = this.getOffset(key);
        html += this.renderVoltageMismatchBadge(comp.x + 40 + off.dx, comp.y - 65 + off.dy, comp, warn, key);
      }
    }

    // Voltage mismatch warnings from load flow
    if (AppState.loadFlowResults && AppState.loadFlowResults.warnings) {
      for (const warn of AppState.loadFlowResults.warnings) {
        const comp = AppState.components.get(warn.elementId);
        if (!comp) continue;
        const key = `warn:${warn.elementId}`;
        const off = this.getOffset(key);
        const baseX = comp.x + 40 + off.dx;
        const baseY = comp.y - 50 + off.dy;
        html += this.renderVoltageMismatchBadge(baseX, baseY, comp, warn, key);
      }
    }

    // Voltage depression overlays (when single-bus fault results exist)
    if (AppState.faultResults && AppState.faultResults.buses) {
      const faultedBusIds = Object.keys(AppState.faultResults.buses);
      // Show voltage depression when single bus is faulted
      if (faultedBusIds.length === 1) {
        const faultResult = AppState.faultResults.buses[faultedBusIds[0]];
        if (faultResult.voltage_depression) {
          for (const [depBusId, dep] of Object.entries(faultResult.voltage_depression)) {
            if (depBusId === faultedBusIds[0]) continue; // Skip faulted bus itself
            const comp = AppState.components.get(depBusId);
            if (!comp) continue;
            const vPu = dep.subtransient_pu != null ? dep.subtransient_pu : 1.0;
            const key = `vdep:${depBusId}`;
            const off = this.getOffset(key);
            const x = comp.x + off.dx;
            const y = comp.y - 30 + off.dy;
            html += this.renderVoltageDepBadge(x, y, dep, vPu, key);
          }
        }
      }
    }

    // Arc flash annotations on buses
    if (AppState.arcFlashResults && AppState.arcFlashResults.buses) {
      for (const [busId, result] of Object.entries(AppState.arcFlashResults.buses)) {
        const comp = AppState.components.get(busId);
        if (!comp) continue;
        const key = `af:${busId}`;
        const off = this.getOffset(key);
        const x = comp.x + 70 + off.dx;
        const y = comp.y + 50 + off.dy;
        html += this.renderArcFlashBadge(x, y, result, key);
      }
    }

    // Cable sizing annotations on cables
    if (AppState.cableSizingResults && AppState.cableSizingResults.cables) {
      for (const cable of AppState.cableSizingResults.cables) {
        const comp = AppState.components.get(cable.cable_id);
        if (!comp) continue;
        const key = `cs:${cable.cable_id}`;
        const off = this.getOffset(key);
        const x = comp.x + 30 + off.dx;
        const y = comp.y - 30 + off.dy;
        html += this.renderCableSizingBadge(x, y, cable, key);
      }
    }

    // Motor starting annotations on motors
    if (AppState.motorStartingResults && AppState.motorStartingResults.motors) {
      for (const motor of AppState.motorStartingResults.motors) {
        const comp = AppState.components.get(motor.motor_id);
        if (!comp) continue;
        const key = `ms:${motor.motor_id}`;
        const off = this.getOffset(key);
        const x = comp.x + 40 + off.dx;
        const y = comp.y - 20 + off.dy;
        html += this.renderMotorStartingBadge(x, y, motor, key);
      }
    }

    // Duty check annotations on CBs/fuses
    if (AppState.dutyCheckResults && AppState.dutyCheckResults.devices) {
      for (const device of AppState.dutyCheckResults.devices) {
        const comp = AppState.components.get(device.device_id);
        if (!comp) continue;
        const key = `dc:${device.device_id}`;
        const off = this.getOffset(key);
        const x = comp.x + 30 + off.dx;
        const y = comp.y - 25 + off.dy;
        html += this.renderDutyCheckBadge(x, y, device, key);
      }
    }

    // Load diversity annotations on buses
    if (AppState.loadDiversityResults && AppState.loadDiversityResults.buses) {
      for (const busResult of AppState.loadDiversityResults.buses) {
        const comp = AppState.components.get(busResult.bus_id);
        if (!comp) continue;
        const key = `ld:${busResult.bus_id}`;
        const off = this.getOffset(key);
        const x = comp.x - 130 + off.dx;
        const y = comp.y + 40 + off.dy;
        html += this.renderLoadDiversityBadge(x, y, busResult, key);
      }
    }

    // Grounding analysis annotations on buses
    if (AppState.groundingResults && AppState.groundingResults.buses) {
      for (const busResult of AppState.groundingResults.buses) {
        const comp = AppState.components.get(busResult.bus_id);
        if (!comp) continue;
        const key = `gr:${busResult.bus_id}`;
        const off = this.getOffset(key);
        const x = comp.x + 70 + off.dx;
        const y = comp.y + 90 + off.dy;
        html += this.renderGroundingBadge(x, y, busResult, key);
      }
    }

    this.layer.innerHTML = html;
  },

  renderFaultBadge(x, y, result, key) {
    const lines = [];
    const showAngles = AppState.showFaultAngles;

    if (showAngles && result.voltage_kv != null) {
      lines.push(`V: ${result.voltage_kv} kV`);
    }
    if (result.ik3 != null) {
      let s = `3Φ: ${result.ik3.toFixed(2)} kA`;
      if (showAngles && result.ik3_angle != null) s += ` ∠${result.ik3_angle.toFixed(1)}°`;
      lines.push(s);
      if (result.ip != null) {
        lines.push(`ip: ${result.ip.toFixed(2)} kA`);
      }
    }
    if (result.ik1 != null) {
      let s = `SLG: ${result.ik1.toFixed(2)} kA`;
      if (showAngles && result.ik1_angle != null) s += ` ∠${result.ik1_angle.toFixed(1)}°`;
      lines.push(s);
    }
    if (result.ikLL != null) {
      let s = `LL: ${result.ikLL.toFixed(2)} kA`;
      if (showAngles && result.ikLL_angle != null) s += ` ∠${result.ikLL_angle.toFixed(1)}°`;
      lines.push(s);
    }
    if (result.ikLLG != null) {
      let s = `LLG: ${result.ikLLG.toFixed(2)} kA`;
      if (showAngles && result.ikLLG_angle != null) s += ` ∠${result.ikLLG_angle.toFixed(1)}°`;
      lines.push(s);
    }
    if (result.motor_count > 0 && result.ik3_motor != null) {
      lines.push(`Motors: ${result.ik3_motor.toFixed(2)} kA (${result.motor_count})`);
    }

    const lineHeight = 14;
    const boxH = lines.length * lineHeight + 10;
    const maxLen = Math.max(...lines.map(l => l.length));
    const boxW = Math.max(100, maxLen * 6.5 + 14);

    let textHtml = lines.map((line, i) =>
      `<text class="annotation-text" x="${x + 6}" y="${y + 14 + i * lineHeight}">${line}</text>`
    ).join('');

    return `
      <g class="annotation-group fault-annotation draggable-annotation" data-annotation-key="${key}" cursor="move">
        <rect class="annotation-badge annotation-hit" x="${x}" y="${y}" width="${boxW}" height="${boxH}"/>
        <text class="annotation-label" x="${x + 6}" y="${y - 3}" font-size="8">FAULT</text>
        ${textHtml}
      </g>`;
  },

  renderLoadFlowBadge(x, y, result, key) {
    const lines = [];
    if (result.voltage_kv != null) lines.push(`V: ${this.formatVoltage(result.voltage_kv)} (${result.voltage_pu.toFixed(4)} p.u. / ${(result.voltage_pu * 100).toFixed(2)}%)`);
    if (result.angle_deg != null) lines.push(`δ: ${result.angle_deg.toFixed(2)}°`);
    // Show power and current in actual units
    const sMVA = Math.sqrt((result.p_mw || 0) ** 2 + (result.q_mvar || 0) ** 2);
    if (sMVA > 0.001) {
      const pStr = Math.abs(result.p_mw) >= 1 ? `${result.p_mw.toFixed(3)} MW` : `${(result.p_mw * 1000).toFixed(1)} kW`;
      const qStr = Math.abs(result.q_mvar) >= 1 ? `${result.q_mvar.toFixed(3)} MVAr` : `${(result.q_mvar * 1000).toFixed(1)} kVAr`;
      lines.push(`P: ${pStr}`);
      lines.push(`Q: ${qStr}`);
      if (result.voltage_kv > 0) {
        const iAmps = (sMVA * 1000) / (Math.sqrt(3) * result.voltage_kv);
        lines.push(`I: ${iAmps.toFixed(1)} A`);
      }
    }

    const lineHeight = 14;
    const boxH = lines.length * lineHeight + 10;
    const maxLen = Math.max(...lines.map(l => l.length));
    const boxW = Math.max(120, maxLen * 6.5 + 14);

    let textHtml = lines.map((line, i) =>
      `<text class="annotation-text" x="${x + 6}" y="${y + 14 + i * lineHeight}">${line}</text>`
    ).join('');

    return `
      <g class="annotation-group loadflow-annotation draggable-annotation" data-annotation-key="${key}" cursor="move">
        <rect class="annotation-badge annotation-hit" x="${x}" y="${y}" width="${boxW}" height="${boxH}"/>
        <text class="annotation-label" x="${x + 6}" y="${y - 3}" font-size="8">LOAD FLOW</text>
        ${textHtml}
      </g>`;
  },

  renderUnbalancedLoadFlowBadge(x, y, result, key) {
    const fmt = (v) => v != null ? v.toFixed(4) : '—';
    const fmtKv = (v) => v != null ? (v >= 1 ? `${v.toFixed(3)} kV` : `${(v * 1000).toFixed(1)} V`) : '—';
    const lines = [
      `Va: ${fmt(result.va_pu)} p.u. ∠${result.angle_a_deg != null ? result.angle_a_deg.toFixed(1) : '—'}°`,
      `Vb: ${fmt(result.vb_pu)} p.u. ∠${result.angle_b_deg != null ? result.angle_b_deg.toFixed(1) : '—'}°`,
      `Vc: ${fmt(result.vc_pu)} p.u. ∠${result.angle_c_deg != null ? result.angle_c_deg.toFixed(1) : '—'}°`,
      `V1: ${fmt(result.v1_pu)}  V2: ${fmt(result.v2_pu)}  V0: ${fmt(result.v0_pu)}`,
      `VUF: ${result.vuf_pct != null ? result.vuf_pct.toFixed(2) : '—'}%`,
    ];

    const lineHeight = 14;
    const boxH = lines.length * lineHeight + 10;
    const maxLen = Math.max(...lines.map(l => l.length));
    const boxW = Math.max(140, maxLen * 6.2 + 14);

    const vufColor = result.vuf_pct > 2 ? '#d32f2f' : result.vuf_pct > 1 ? '#f57c00' : '#1976d2';
    const textHtml = lines.map((line, i) => {
      const color = (i === 4 && result.vuf_pct > 1) ? ` fill="${vufColor}"` : '';
      return `<text class="annotation-text"${color} x="${x + 6}" y="${y + 14 + i * lineHeight}">${line}</text>`;
    }).join('');

    return `
      <g class="annotation-group unbalanced-lf-annotation draggable-annotation" data-annotation-key="${key}" cursor="move">
        <rect class="annotation-badge annotation-hit" x="${x}" y="${y}" width="${boxW}" height="${boxH}"/>
        <text class="annotation-label" x="${x + 6}" y="${y - 3}" font-size="8">UNBALANCED LF</text>
        ${textHtml}
      </g>`;
  },

  renderBranchFlowBadge(x, y, branch, key) {
    const lines = [];
    if (branch.p_mw != null) {
      const pStr = Math.abs(branch.p_mw) >= 1 ? `${branch.p_mw.toFixed(3)} MW` : `${(branch.p_mw * 1000).toFixed(1)} kW`;
      lines.push(`P: ${pStr}`);
    }
    if (branch.q_mvar != null) {
      const qStr = Math.abs(branch.q_mvar) >= 1 ? `${branch.q_mvar.toFixed(3)} MVAr` : `${(branch.q_mvar * 1000).toFixed(1)} kVAr`;
      lines.push(`Q: ${qStr}`);
    }
    const sMVA = branch.s_mva || Math.sqrt((branch.p_mw || 0) ** 2 + (branch.q_mvar || 0) ** 2);
    const sStr = sMVA >= 1 ? `${sMVA.toFixed(3)} MVA` : `${(sMVA * 1000).toFixed(1)} kVA`;
    lines.push(`S: ${sStr}`);
    if (branch.i_amps > 0) lines.push(`I: ${branch.i_amps.toFixed(1)} A`);
    if (branch.loading_pct > 0) lines.push(`Load: ${branch.loading_pct.toFixed(1)}%`);

    const lineHeight = 14;
    const boxH = lines.length * lineHeight + 10;
    const boxW = 120;

    let textHtml = lines.map((line, i) =>
      `<text class="annotation-text" x="${x + 6}" y="${y + 14 + i * lineHeight}">${line}</text>`
    ).join('');

    return `
      <g class="annotation-group loadflow-annotation draggable-annotation" data-annotation-key="${key}" cursor="move">
        <rect class="annotation-badge annotation-hit" x="${x}" y="${y}" width="${boxW}" height="${boxH}"/>
        ${textHtml}
      </g>`;
  },

  renderVoltageMismatchBadge(x, y, comp, warn, key) {
    const expectedStr = warn.expected_kv >= 1 ? `${warn.expected_kv} kV` : `${(warn.expected_kv * 1000).toFixed(0)} V`;
    const actualStr = warn.actual_kv >= 1 ? `${warn.actual_kv} kV` : `${(warn.actual_kv * 1000).toFixed(0)} V`;
    const lines = [
      `Rated: ${actualStr}`,
      `Expected: ${expectedStr}`,
    ];

    const lineHeight = 14;
    const boxH = lines.length * lineHeight + 10;
    const boxW = 130;

    // Red highlight ring around the component symbol
    const ringX = comp.x - 18;
    const ringY = comp.y - 28;
    const ringW = 36;
    const ringH = 56;

    let textHtml = lines.map((line, i) =>
      `<text class="annotation-text" x="${x + 6}" y="${y + 14 + i * lineHeight}">${line}</text>`
    ).join('');

    return `
      <rect x="${ringX}" y="${ringY}" width="${ringW}" height="${ringH}"
            fill="none" stroke="#d32f2f" stroke-width="2.5" stroke-dasharray="5,3" rx="6" ry="6"
            class="voltage-error-ring" pointer-events="none"/>
      <g class="annotation-group error-annotation draggable-annotation" data-annotation-key="${key}" cursor="move">
        <rect class="annotation-badge annotation-hit" x="${x}" y="${y}" width="${boxW}" height="${boxH}"/>
        <text class="annotation-label" x="${x + 6}" y="${y - 3}" font-size="8">VOLTAGE ERROR</text>
        ${textHtml}
      </g>`;
  },

  renderVoltageDepBadge(x, y, dep, vPu, key) {
    const pct = (vPu * 100).toFixed(1);
    let fillColor;
    if (vPu >= 0.8) fillColor = '#4caf50';       // green — normal
    else if (vPu >= 0.5) fillColor = '#f9a825';   // yellow — moderate sag
    else if (vPu >= 0.3) fillColor = '#e65100';    // orange — severe
    else fillColor = '#d32f2f';                     // red — near collapse

    const lines = [`V: ${pct}%`];
    if (dep.retained_kv != null) lines.push(`${dep.retained_kv.toFixed(2)} kV`);
    if (dep.transient_pu != null && dep.transient_pu !== dep.subtransient_pu) {
      lines.push(`Tr: ${(dep.transient_pu * 100).toFixed(1)}%`);
    }
    if (dep.steadystate_pu != null && dep.steadystate_pu !== dep.transient_pu) {
      lines.push(`SS: ${(dep.steadystate_pu * 100).toFixed(1)}%`);
    }

    const lineHeight = 14;
    const boxH = lines.length * lineHeight + 10;
    const boxW = 90;

    let textHtml = lines.map((line, i) =>
      `<text class="annotation-text" x="${x + 6}" y="${y + 14 + i * lineHeight}" fill="${fillColor}">${line}</text>`
    ).join('');

    return `
      <g class="annotation-group vdep-annotation draggable-annotation" data-annotation-key="${key}" cursor="move">
        <rect class="annotation-badge" x="${x}" y="${y}" width="${boxW}" height="${boxH}"
              fill="${fillColor}" fill-opacity="0.12" stroke="${fillColor}" stroke-width="1.5" rx="4" ry="4"/>
        <text class="annotation-label" x="${x + 6}" y="${y - 3}" font-size="8" fill="${fillColor}">RETAINED V</text>
        ${textHtml}
      </g>`;
  },

  renderArcFlashBadge(x, y, result, key) {
    const lines = [];
    lines.push(`${result.incident_energy_cal.toFixed(2)} cal/cm²`);
    lines.push(`PPE: Cat ${result.ppe_category}`);
    lines.push(`AFB: ${(result.arc_flash_boundary_mm / 1000).toFixed(2)} m`);
    lines.push(`Iarc: ${result.arcing_current_ka.toFixed(2)} kA`);

    const lineHeight = 14;
    const boxH = lines.length * lineHeight + 10;
    const boxW = 120;

    // Color by PPE category
    let fillColor;
    if (result.ppe_category >= 4) fillColor = '#d32f2f';       // red - danger
    else if (result.ppe_category === 3) fillColor = '#e65100';  // dark orange
    else if (result.ppe_category === 2) fillColor = '#f57c00';  // orange
    else if (result.ppe_category === 1) fillColor = '#fbc02d';  // yellow
    else fillColor = '#4caf50';                                  // green

    let textHtml = lines.map((line, i) =>
      `<text class="annotation-text af-badge-text" x="${x + 6}" y="${y + 14 + i * lineHeight}">${line}</text>`
    ).join('');

    return `
      <g class="annotation-group arcflash-annotation draggable-annotation" data-annotation-key="${key}" cursor="move">
        <rect class="annotation-badge af-badge" x="${x}" y="${y}" width="${boxW}" height="${boxH}"
              fill="${fillColor}" fill-opacity="0.15" stroke="${fillColor}" stroke-width="1.5"/>
        <text class="annotation-label" x="${x + 6}" y="${y - 3}" font-size="8" fill="${fillColor}">ARC FLASH</text>
        ${textHtml}
      </g>`;
  },

  renderCableSizingBadge(x, y, cable, key) {
    const fillColor = cable.status === 'fail' ? '#d32f2f' : cable.status === 'warning' ? '#f57c00' : '#4caf50';
    const icon = cable.status === 'pass' ? '✓' : cable.status === 'warning' ? '!' : '✗';
    const lines = [`${icon} ${cable.thermal_loading_pct.toFixed(0)}%`];
    if (cable.voltage_drop_pct > 0) lines.push(`ΔV: ${cable.voltage_drop_pct.toFixed(1)}%`);

    const lineHeight = 14;
    const boxH = lines.length * lineHeight + 10;
    const boxW = 80;

    let textHtml = lines.map((line, i) =>
      `<text class="annotation-text" x="${x + 6}" y="${y + 14 + i * lineHeight}" fill="${fillColor}">${line}</text>`
    ).join('');

    return `
      <g class="annotation-group cable-sizing-annotation draggable-annotation" data-annotation-key="${key}" cursor="move">
        <rect class="annotation-badge" x="${x}" y="${y}" width="${boxW}" height="${boxH}"
              fill="${fillColor}" fill-opacity="0.12" stroke="${fillColor}" stroke-width="1.5" rx="4" ry="4"/>
        <text class="annotation-label" x="${x + 6}" y="${y - 3}" font-size="8" fill="${fillColor}">CABLE</text>
        ${textHtml}
      </g>`;
  },

  renderMotorStartingBadge(x, y, motor, key) {
    const fillColor = motor.status === 'fail' ? '#d32f2f' : motor.status === 'warning' ? '#f57c00' : '#4caf50';
    const icon = motor.motor_will_start ? '✓' : '✗';
    const lines = [`${icon} ${(motor.motor_terminal_voltage_pu * 100).toFixed(1)}%`];

    const lineHeight = 14;
    const boxH = lines.length * lineHeight + 10;
    const boxW = 80;

    let textHtml = lines.map((line, i) =>
      `<text class="annotation-text" x="${x + 6}" y="${y + 14 + i * lineHeight}" fill="${fillColor}">${line}</text>`
    ).join('');

    return `
      <g class="annotation-group motor-starting-annotation draggable-annotation" data-annotation-key="${key}" cursor="move">
        <rect class="annotation-badge" x="${x}" y="${y}" width="${boxW}" height="${boxH}"
              fill="${fillColor}" fill-opacity="0.12" stroke="${fillColor}" stroke-width="1.5" rx="4" ry="4"/>
        <text class="annotation-label" x="${x + 6}" y="${y - 3}" font-size="8" fill="${fillColor}">MOTOR START</text>
        ${textHtml}
      </g>`;
  },

  renderDutyCheckBadge(x, y, device, key) {
    const fillColor = device.status === 'fail' ? '#d32f2f' : device.status === 'warning' ? '#f57c00' : '#4caf50';
    const icon = device.status === 'pass' ? '🛡' : device.status === 'warning' ? '🛡' : '🛡!';
    const lines = [`${device.utilisation_pct.toFixed(0)}%`];

    const lineHeight = 14;
    const boxH = lines.length * lineHeight + 10;
    const boxW = 60;

    let textHtml = lines.map((line, i) =>
      `<text class="annotation-text" x="${x + 6}" y="${y + 14 + i * lineHeight}" fill="${fillColor}">${line}</text>`
    ).join('');

    return `
      <g class="annotation-group duty-check-annotation draggable-annotation" data-annotation-key="${key}" cursor="move">
        <rect class="annotation-badge" x="${x}" y="${y}" width="${boxW}" height="${boxH}"
              fill="${fillColor}" fill-opacity="0.12" stroke="${fillColor}" stroke-width="1.5" rx="4" ry="4"/>
        <text class="annotation-label" x="${x + 6}" y="${y - 3}" font-size="8" fill="${fillColor}">DUTY</text>
        ${textHtml}
      </g>`;
  },

  renderGroundingBadge(x, y, busResult, key) {
    const fillColor = busResult.status === 'fail' ? '#d32f2f'
      : busResult.status === 'warning' ? '#f57c00' : '#4caf50';
    const touchIcon = busResult.touch_ok ? '✓' : '✗';
    const stepIcon = busResult.touch_ok && busResult.step_ok ? '✓' : '✗';
    const lines = [
      `Vt: ${busResult.mesh_voltage_v}V ${touchIcon}`,
      `Vs: ${busResult.step_voltage_v}V ${stepIcon}`,
      `Rg: ${busResult.grid_resistance_ohm.toFixed(2)}Ω`,
    ];

    const lineHeight = 14;
    const boxH = lines.length * lineHeight + 10;
    const boxW = 110;

    let textHtml = lines.map((line, i) =>
      `<text class="annotation-text" x="${x + 6}" y="${y + 14 + i * lineHeight}" fill="${fillColor}">${line}</text>`
    ).join('');

    return `
      <g class="annotation-group grounding-annotation draggable-annotation" data-annotation-key="${key}" cursor="move">
        <rect class="annotation-badge" x="${x}" y="${y}" width="${boxW}" height="${boxH}"
              fill="${fillColor}" fill-opacity="0.12" stroke="${fillColor}" stroke-width="1.5" rx="4" ry="4"/>
        <text class="annotation-label" x="${x + 6}" y="${y - 3}" font-size="8" fill="${fillColor}">GROUNDING</text>
        ${textHtml}
      </g>`;
  },

  renderLoadDiversityBadge(x, y, busResult, key) {
    const df = busResult.effective_demand_factor;
    const fillColor = df >= 0.9 ? '#f57c00' : df >= 0.7 ? '#1565c0' : '#4caf50';
    const lines = [
      `DF: ${df.toFixed(2)}`,
      `${busResult.diversified_demand_kva.toFixed(0)} kVA`,
    ];

    const lineHeight = 14;
    const boxH = lines.length * lineHeight + 10;
    const boxW = 90;

    let textHtml = lines.map((line, i) =>
      `<text class="annotation-text" x="${x + 6}" y="${y + 14 + i * lineHeight}" fill="${fillColor}">${line}</text>`
    ).join('');

    return `
      <g class="annotation-group load-diversity-annotation draggable-annotation" data-annotation-key="${key}" cursor="move">
        <rect class="annotation-badge" x="${x}" y="${y}" width="${boxW}" height="${boxH}"
              fill="${fillColor}" fill-opacity="0.12" stroke="${fillColor}" stroke-width="1.5" rx="4" ry="4"/>
        <text class="annotation-label" x="${x + 6}" y="${y - 3}" font-size="8" fill="${fillColor}">DEMAND</text>
        ${textHtml}
      </g>`;
  },

  // Clear all annotations
  clear() {
    if (this.layer) this.layer.innerHTML = '';
  },
};
