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
    const boxW = showAngles ? 160 : 100;

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
    const boxW = 160;

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

  // Clear all annotations
  clear() {
    if (this.layer) this.layer.innerHTML = '';
  },
};
