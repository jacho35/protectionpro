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
    // User-dragged offsets win; otherwise fall back to the auto-stacked
    // position so a drag starts from where the badge is actually drawn.
    return this.offsets.get(key) || this._stackOffsets.get(key) || { dx: 0, dy: 0 };
  },

  setOffset(key, dx, dy) {
    this.offsets.set(key, { dx, dy });
  },

  // ── Auto-stacking of badges per component (no user offset) ──
  // Badges attached to the same component stack in a single column instead
  // of overlapping at fixed offsets. User-dragged offsets stay authoritative.
  _stackOffsets: new Map(), // key → {dx, dy} effective offsets of stacked badges
  _lastBoxH: 38,            // height of the most recently rendered badge box
  _STACK_X: 70,             // column x offset from component center
  _STACK_START_Y: -10,      // y offset of the first stacked badge
  _STACK_GAP: 18,           // vertical gap between stacked badges (label space)

  _badgePos(comp, key, defaultDX, defaultDY, stacks) {
    const userOff = this.offsets.get(key);
    if (userOff) {
      return { x: comp.x + defaultDX + userOff.dx, y: comp.y + defaultDY + userOff.dy, stacked: false };
    }
    const x = comp.x + this._STACK_X;
    const y = stacks.has(comp.id) ? stacks.get(comp.id) : comp.y + this._STACK_START_Y;
    this._stackOffsets.set(key, { dx: x - (comp.x + defaultDX), dy: y - (comp.y + defaultDY) });
    return { x, y, stacked: true };
  },

  _advanceStack(stacks, comp, pos) {
    if (!pos.stacked) return;
    stacks.set(comp.id, pos.y + this._lastBoxH + this._STACK_GAP);
  },

  render() {
    if (!this.layer) return;
    let html = '';
    const pageComps = AppState.getActivePageComponents();

    // Per-component stack cursor for auto-positioned badges
    const stacks = new Map();
    this._stackOffsets.clear();

    // Fault result annotations on buses
    if (AppState.showResultBoxes.fault && AppState.faultResults && AppState.faultResults.buses) {
      for (const [busId, result] of Object.entries(AppState.faultResults.buses)) {
        // Synthetic terminal buses have no symbol of their own — anchor their
        // badge on the load they belong to (see AppState.resultBusComponent).
        const comp = AppState.resultBusComponent(busId, pageComps);
        if (!comp) continue;
        const key = `fault:${busId}`;
        const pos = this._badgePos(comp, key, 70, -10, stacks);
        html += this.renderFaultBadge(pos.x, pos.y, result, key);
        this._advanceStack(stacks, comp, pos);
      }
    }

    // Load flow annotations on buses
    if (AppState.showResultBoxes.loadflow && AppState.loadFlowResults && AppState.loadFlowResults.buses) {
      for (const [busId, result] of Object.entries(AppState.loadFlowResults.buses)) {
        const comp = pageComps.get(busId);
        if (!comp) continue;
        const key = `lf:${busId}`;
        const pos = this._badgePos(comp, key, -130, -10, stacks);
        html += this.renderLoadFlowBadge(pos.x, pos.y, result, key);
        this._advanceStack(stacks, comp, pos);
      }
    }

    // DC load flow annotations on DC buses
    if (AppState.showResultBoxes.dcLoadflow && AppState.dcLoadFlowResults && AppState.dcLoadFlowResults.buses) {
      for (const [busId, result] of Object.entries(AppState.dcLoadFlowResults.buses)) {
        const comp = pageComps.get(busId);
        if (!comp) continue;
        const key = `dclf:${busId}`;
        const pos = this._badgePos(comp, key, -140, -10, stacks);
        html += this.renderDCLoadFlowBadge(pos.x, pos.y, result, key);
        this._advanceStack(stacks, comp, pos);
      }
    }

    // DC short-circuit annotations on DC buses
    if (AppState.showResultBoxes.dcShortCircuit && AppState.dcShortCircuitResults && AppState.dcShortCircuitResults.buses) {
      for (const [busId, result] of Object.entries(AppState.dcShortCircuitResults.buses)) {
        const comp = pageComps.get(busId);
        if (!comp) continue;
        const key = `dcsc:${busId}`;
        const pos = this._badgePos(comp, key, 70, -10, stacks);
        html += this.renderDCShortCircuitBadge(pos.x, pos.y, result, key);
        this._advanceStack(stacks, comp, pos);
      }
    }

    // Branch flow badges are NOT rendered here — they are shown as inline
    // data labels on each component by Canvas.renderComponentDataLabels().

    // Unbalanced load flow annotations on buses
    if (AppState.showResultBoxes.unbalancedLF && AppState.unbalancedLoadFlowResults && AppState.unbalancedLoadFlowResults.buses) {
      for (const [busId, result] of Object.entries(AppState.unbalancedLoadFlowResults.buses)) {
        const comp = pageComps.get(busId);
        if (!comp) continue;
        const key = `ulf:${busId}`;
        const pos = this._badgePos(comp, key, -160, 20, stacks);
        html += this.renderUnbalancedLoadFlowBadge(pos.x, pos.y, result, key);
        this._advanceStack(stacks, comp, pos);
      }
    }

    // Unbalanced load flow VUF warnings
    if (AppState.showResultBoxes.unbalancedLF && AppState.unbalancedLoadFlowResults && AppState.unbalancedLoadFlowResults.warnings) {
      for (const warn of AppState.unbalancedLoadFlowResults.warnings) {
        // Only voltage-mismatch warnings carry kV data; informational
        // warnings (islanding, dispatch, VUF) belong in the results modal,
        // not as a "VOLTAGE ERROR" badge showing 0 V / 0 V.
        if (!(warn.expected_kv > 0) && !(warn.actual_kv > 0)) continue;
        const comp = pageComps.get(warn.elementId);
        if (!comp) continue;
        const key = `ulf-warn:${warn.elementId}`;
        const pos = this._badgePos(comp, key, 40, -65, stacks);
        html += this.renderVoltageMismatchBadge(pos.x, pos.y, comp, warn, key);
        this._advanceStack(stacks, comp, pos);
      }
    }

    // Voltage mismatch warnings from load flow
    if (AppState.showResultBoxes.loadflow && AppState.loadFlowResults && AppState.loadFlowResults.warnings) {
      for (const warn of AppState.loadFlowResults.warnings) {
        // Skip informational warnings (islanding, dispatch) — badge only
        // real voltage mismatches, which carry expected/actual kV values.
        if (!(warn.expected_kv > 0) && !(warn.actual_kv > 0)) continue;
        const comp = pageComps.get(warn.elementId);
        if (!comp) continue;
        const key = `warn:${warn.elementId}`;
        const pos = this._badgePos(comp, key, 40, -50, stacks);
        html += this.renderVoltageMismatchBadge(pos.x, pos.y, comp, warn, key);
        this._advanceStack(stacks, comp, pos);
      }
    }

    // Voltage depression overlays (when single-bus fault results exist)
    if (AppState.showResultBoxes.fault && AppState.faultResults && AppState.faultResults.buses) {
      const faultedBusIds = Object.keys(AppState.faultResults.buses);
      // Show voltage depression when single bus is faulted
      if (faultedBusIds.length === 1) {
        const faultResult = AppState.faultResults.buses[faultedBusIds[0]];
        if (faultResult.voltage_depression) {
          for (const [depBusId, dep] of Object.entries(faultResult.voltage_depression)) {
            if (depBusId === faultedBusIds[0]) continue; // Skip faulted bus itself
            const comp = AppState.resultBusComponent(depBusId, pageComps);
            if (!comp) continue;
            const vPu = dep.subtransient_pu != null ? dep.subtransient_pu : 1.0;
            const key = `vdep:${depBusId}`;
            const pos = this._badgePos(comp, key, 0, -30, stacks);
            html += this.renderVoltageDepBadge(pos.x, pos.y, dep, vPu, key);
            this._advanceStack(stacks, comp, pos);
          }
        }
      }
    }

    // Arc flash annotations on buses
    if (AppState.showResultBoxes.arcflash && AppState.arcFlashResults && AppState.arcFlashResults.buses) {
      for (const [busId, result] of Object.entries(AppState.arcFlashResults.buses)) {
        const comp = pageComps.get(busId);
        if (!comp) continue;
        const key = `af:${busId}`;
        const pos = this._badgePos(comp, key, 70, 50, stacks);
        html += this.renderArcFlashBadge(pos.x, pos.y, result, key);
        this._advanceStack(stacks, comp, pos);
      }
    }

    // Cable sizing annotations on cables
    if (AppState.showResultBoxes.cable && AppState.cableSizingResults && AppState.cableSizingResults.cables) {
      for (const cable of AppState.cableSizingResults.cables) {
        const comp = pageComps.get(cable.cable_id);
        if (!comp) continue;
        const key = `cs:${cable.cable_id}`;
        const pos = this._badgePos(comp, key, 30, -30, stacks);
        html += this.renderCableSizingBadge(pos.x, pos.y, cable, key);
        this._advanceStack(stacks, comp, pos);
      }
    }

    // Motor starting annotations on motors
    if (AppState.showResultBoxes.motor && AppState.motorStartingResults && AppState.motorStartingResults.motors) {
      for (const motor of AppState.motorStartingResults.motors) {
        const comp = pageComps.get(motor.motor_id);
        if (!comp) continue;
        const key = `ms:${motor.motor_id}`;
        const pos = this._badgePos(comp, key, 40, -20, stacks);
        html += this.renderMotorStartingBadge(pos.x, pos.y, motor, key);
        this._advanceStack(stacks, comp, pos);
      }
    }

    // Dynamic motor starting annotations on motors
    if (AppState.showResultBoxes.dynMotor && AppState.dynamicMotorResults && AppState.dynamicMotorResults.motors) {
      for (const motor of AppState.dynamicMotorResults.motors) {
        if (motor.status === 'not_simulated') continue;
        const comp = pageComps.get(motor.motor_id);
        if (!comp) continue;
        const key = `dynms:${motor.motor_id}`;
        const pos = this._badgePos(comp, key, 40, 20, stacks);
        html += this.renderDynamicMotorBadge(pos.x, pos.y, motor, key);
        this._advanceStack(stacks, comp, pos);
      }
    }

    // Duty check annotations on CBs/fuses
    if (AppState.showResultBoxes.duty && AppState.dutyCheckResults && AppState.dutyCheckResults.devices) {
      for (const device of AppState.dutyCheckResults.devices) {
        const comp = pageComps.get(device.device_id);
        if (!comp) continue;
        const key = `dc:${device.device_id}`;
        const pos = this._badgePos(comp, key, 30, -25, stacks);
        html += this.renderDutyCheckBadge(pos.x, pos.y, device, key);
        this._advanceStack(stacks, comp, pos);
      }
    }

    // Load diversity annotations on buses
    if (AppState.showResultBoxes.loadDiversity && AppState.loadDiversityResults && AppState.loadDiversityResults.buses) {
      for (const busResult of AppState.loadDiversityResults.buses) {
        const comp = pageComps.get(busResult.bus_id);
        if (!comp) continue;
        const key = `ld:${busResult.bus_id}`;
        const pos = this._badgePos(comp, key, -130, 40, stacks);
        html += this.renderLoadDiversityBadge(pos.x, pos.y, busResult, key);
        this._advanceStack(stacks, comp, pos);
      }
    }

    // Grounding analysis annotations on buses
    if (AppState.showResultBoxes.grounding && AppState.groundingResults && AppState.groundingResults.buses) {
      for (const busResult of AppState.groundingResults.buses) {
        const comp = pageComps.get(busResult.bus_id);
        if (!comp) continue;
        const key = `gr:${busResult.bus_id}`;
        const pos = this._badgePos(comp, key, 70, 90, stacks);
        html += this.renderGroundingBadge(pos.x, pos.y, busResult, key);
        this._advanceStack(stacks, comp, pos);
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
    this._lastBoxH = boxH;
    const maxLen = Math.max(...lines.map(l => l.length));
    const boxW = Math.max(100, maxLen * 6.5 + 14);

    let textHtml = lines.map((line, i) =>
      `<text class="annotation-text" x="${x + 6}" y="${y + 14 + i * lineHeight}">${line}</text>`
    ).join('');

    const busId = key.split(':')[1] || '';
    const busLabel = escHtml(result.bus_name || busId);
    return `
      <g class="annotation-group fault-annotation draggable-annotation" data-annotation-key="${key}" data-bus-id="${busId}" cursor="move">
        <rect class="annotation-badge annotation-hit" x="${x}" y="${y}" width="${boxW}" height="${boxH}"/>
        <text class="annotation-label" x="${x + 6}" y="${y - 3}" font-size="8">FAULT — ${busLabel}</text>
        ${textHtml}
      </g>`;
  },

  renderLoadFlowBadge(x, y, result, key) {
    const lines = [];
    if (result.voltage_kv != null) lines.push(`V: ${this.formatVoltage(result.voltage_kv)} (${result.voltage_pu.toFixed(4)} p.u. / ${(result.voltage_pu * 100).toFixed(2)}%)`);
    if (result.angle_deg != null) lines.push(`δ: ${result.angle_deg.toFixed(2)}°`);
    if (result.energized === false) {
      lines.push('DE-ENERGIZED');
    } else {
      // Power the busbar carries (through-flow + local load) — always shown.
      // Falls back to net injection for results saved before p_through_mw.
      const p = result.p_through_mw ?? result.p_mw ?? 0;
      const q = result.q_through_mvar ?? result.q_mvar ?? 0;
      const sMVA = Math.sqrt(p ** 2 + q ** 2);
      const pStr = Math.abs(p) >= 1 ? `${p.toFixed(3)} MW` : `${(p * 1000).toFixed(1)} kW`;
      const qStr = Math.abs(q) >= 1 ? `${q.toFixed(3)} MVAr` : `${(q * 1000).toFixed(1)} kVAr`;
      const sStr = sMVA >= 1 ? `${sMVA.toFixed(3)} MVA` : `${(sMVA * 1000).toFixed(1)} kVA`;
      lines.push(`P: ${pStr}`);
      lines.push(`Q: ${qStr}`);
      lines.push(`S: ${sStr}`);
      if (result.voltage_kv > 0) {
        const iAmps = (sMVA * 1000) / (Math.sqrt(3) * result.voltage_kv);
        lines.push(`I: ${iAmps.toFixed(1)} A`);
      }
    }

    const lineHeight = 14;
    const boxH = lines.length * lineHeight + 10;
    this._lastBoxH = boxH;
    const maxLen = Math.max(...lines.map(l => l.length));
    const boxW = Math.max(120, maxLen * 6.5 + 14);

    let textHtml = lines.map((line, i) =>
      `<text class="annotation-text" x="${x + 6}" y="${y + 14 + i * lineHeight}">${line}</text>`
    ).join('');

    const busId = key.split(':')[1] || '';
    const busLabel = escHtml(result.bus_name || busId);
    return `
      <g class="annotation-group loadflow-annotation draggable-annotation" data-annotation-key="${key}" data-bus-id="${busId}" cursor="move">
        <rect class="annotation-badge annotation-hit" x="${x}" y="${y}" width="${boxW}" height="${boxH}"/>
        <text class="annotation-label" x="${x + 6}" y="${y - 3}" font-size="8">LOAD FLOW — ${busLabel}</text>
        ${textHtml}
      </g>`;
  },

  renderDCLoadFlowBadge(x, y, result, key) {
    const lines = [];
    if (result.energized === false) {
      lines.push('DE-ENERGIZED');
    } else {
      lines.push(`V: ${result.voltage_v.toFixed(1)} V (${(result.voltage_pu * 100).toFixed(1)}%)`);
      lines.push(`Nom: ${result.nominal_v.toFixed(0)} V`);
      if (Math.abs(result.drop_pct) >= 0.05) lines.push(`Δ: ${result.drop_pct.toFixed(2)}%`);
      if (result.load_kw > 0) lines.push(`Load: ${result.load_kw.toFixed(2)} kW`);
    }

    const lineHeight = 14;
    const boxH = lines.length * lineHeight + 10;
    this._lastBoxH = boxH;
    const maxLen = Math.max(...lines.map(l => l.length));
    const boxW = Math.max(120, maxLen * 6.5 + 14);
    const textHtml = lines.map((line, i) =>
      `<text class="annotation-text" x="${x + 6}" y="${y + 14 + i * lineHeight}">${line}</text>`
    ).join('');
    const busId = key.split(':')[1] || '';
    const busLabel = escHtml(result.bus_name || busId);
    return `
      <g class="annotation-group loadflow-annotation draggable-annotation" data-annotation-key="${key}" data-bus-id="${busId}" cursor="move">
        <rect class="annotation-badge annotation-hit" x="${x}" y="${y}" width="${boxW}" height="${boxH}"/>
        <text class="annotation-label" x="${x + 6}" y="${y - 3}" font-size="8">DC LOAD FLOW — ${busLabel}</text>
        ${textHtml}
      </g>`;
  },

  renderDCShortCircuitBadge(x, y, result, key) {
    const lines = [];
    if (!result.contributions || result.contributions.length === 0) {
      lines.push('NO DC SOURCE');
    } else {
      lines.push(`Ik: ${result.ik_ka.toFixed(2)} kA`);
      lines.push(`ip: ${result.ip_ka.toFixed(2)} kA`);
      if (result.tp_ms > 0) lines.push(`tp: ${result.tp_ms.toFixed(1)} ms`);
      lines.push(`sources: ${result.contributions.length}`);
    }

    const lineHeight = 14;
    const boxH = lines.length * lineHeight + 10;
    this._lastBoxH = boxH;
    const maxLen = Math.max(...lines.map(l => l.length));
    const boxW = Math.max(110, maxLen * 6.5 + 14);
    const textHtml = lines.map((line, i) =>
      `<text class="annotation-text" x="${x + 6}" y="${y + 14 + i * lineHeight}">${line}</text>`
    ).join('');
    const busId = key.split(':')[1] || '';
    const busLabel = escHtml(result.bus_name || busId);
    return `
      <g class="annotation-group fault-annotation draggable-annotation" data-annotation-key="${key}" data-bus-id="${busId}" cursor="move">
        <rect class="annotation-badge annotation-hit" x="${x}" y="${y}" width="${boxW}" height="${boxH}"/>
        <text class="annotation-label" x="${x + 6}" y="${y - 3}" font-size="8">DC SC (IEC 61660) — ${busLabel}</text>
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
    this._lastBoxH = boxH;
    const maxLen = Math.max(...lines.map(l => l.length));
    const boxW = Math.max(140, maxLen * 6.2 + 14);

    const vufColor = result.vuf_pct > 2 ? '#d32f2f' : result.vuf_pct > 1 ? '#f57c00' : '#1976d2';
    const textHtml = lines.map((line, i) => {
      const color = (i === 4 && result.vuf_pct > 1) ? ` fill="${vufColor}"` : '';
      return `<text class="annotation-text"${color} x="${x + 6}" y="${y + 14 + i * lineHeight}">${line}</text>`;
    }).join('');

    const busId = key.split(':')[1] || '';
    const busLabel = escHtml(result.bus_name || busId);
    return `
      <g class="annotation-group unbalanced-lf-annotation draggable-annotation" data-annotation-key="${key}" data-bus-id="${busId}" cursor="move">
        <rect class="annotation-badge annotation-hit" x="${x}" y="${y}" width="${boxW}" height="${boxH}"/>
        <text class="annotation-label" x="${x + 6}" y="${y - 3}" font-size="8">UNBALANCED LF — ${busLabel}</text>
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
    this._lastBoxH = boxH;
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
    this._lastBoxH = boxH;
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
    this._lastBoxH = boxH;
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
    this._lastBoxH = boxH;
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

    const busId = key.split(':')[1] || '';
    const busLabel = escHtml(result.bus_name || busId);
    return `
      <g class="annotation-group arcflash-annotation draggable-annotation" data-annotation-key="${key}" data-bus-id="${busId}" cursor="move">
        <rect class="annotation-badge af-badge" x="${x}" y="${y}" width="${boxW}" height="${boxH}"
              fill="${fillColor}" fill-opacity="0.15" stroke="${fillColor}" stroke-width="1.5"/>
        <text class="annotation-label" x="${x + 6}" y="${y - 3}" font-size="8" fill="${fillColor}">ARC FLASH — ${busLabel}</text>
        ${textHtml}
      </g>`;
  },

  renderCableSizingBadge(x, y, cable, key) {
    const fillColor = cable.status === 'fail' ? '#d32f2f'
      : cable.status === 'warning' ? '#f57c00'
      : cable.status === 'unknown' ? '#9e9e9e' : '#4caf50';
    const icon = cable.status === 'pass' ? '✓'
      : cable.status === 'warning' ? '!'
      : cable.status === 'unknown' ? '?' : '✗';
    const lines = [`${icon} ${cable.thermal_loading_pct.toFixed(0)}%`];
    if (cable.voltage_drop_pct > 0) lines.push(`ΔV: ${cable.voltage_drop_pct.toFixed(1)}%`);

    const lineHeight = 14;
    const boxH = lines.length * lineHeight + 10;
    this._lastBoxH = boxH;
    const boxW = 80;

    let textHtml = lines.map((line, i) =>
      `<text class="annotation-text" x="${x + 6}" y="${y + 14 + i * lineHeight}" fill="${fillColor}">${line}</text>`
    ).join('');

    // Build tooltip explaining why (warning OR unknown both carry reasons)
    const tooltipText = (cable.status === 'warning' || cable.status === 'unknown')
      && cable.warning_reasons && cable.warning_reasons.length > 0
      ? cable.warning_reasons.join('. ')
      : cable.issues && cable.issues.length > 0 ? cable.issues.join('. ') : '';
    const titleEl = tooltipText ? `<title>${tooltipText.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</title>` : '';

    return `
      <g class="annotation-group cable-sizing-annotation draggable-annotation" data-annotation-key="${key}" cursor="move">
        ${titleEl}
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
    this._lastBoxH = boxH;
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

  renderDynamicMotorBadge(x, y, motor, key) {
    const fillColor = motor.status === 'fail' ? '#d32f2f' : motor.status === 'warning' ? '#f57c00' : '#4caf50';
    const started = motor.sim_status === 'started';
    const lines = [
      started ? `✓ ${motor.accel_time_s.toFixed(1)}s start` : (motor.sim_status === 'stalled' ? '✗ STALL' : '✗ no start'),
      `I ${motor.peak_current_xflc.toFixed(1)}× V ${(motor.min_v_motor_pu * 100).toFixed(0)}%`,
    ];

    const lineHeight = 14;
    const boxH = lines.length * lineHeight + 10;
    this._lastBoxH = boxH;
    const boxW = 96;

    let textHtml = lines.map((line, i) =>
      `<text class="annotation-text" x="${x + 6}" y="${y + 14 + i * lineHeight}" fill="${fillColor}">${line}</text>`
    ).join('');

    return `
      <g class="annotation-group dynamic-motor-annotation draggable-annotation" data-annotation-key="${key}" cursor="move">
        <rect class="annotation-badge" x="${x}" y="${y}" width="${boxW}" height="${boxH}"
              fill="${fillColor}" fill-opacity="0.12" stroke="${fillColor}" stroke-width="1.5" rx="4" ry="4"/>
        <text class="annotation-label" x="${x + 6}" y="${y - 3}" font-size="8" fill="${fillColor}">DYN START</text>
        ${textHtml}
      </g>`;
  },

  renderDutyCheckBadge(x, y, device, key) {
    const fillColor = device.status === 'fail' ? '#d32f2f' : device.status === 'warning' ? '#f57c00' : '#4caf50';
    const lines = [`${device.utilisation_pct.toFixed(0)}%${device.status === 'fail' ? ' !' : ''}`];

    const lineHeight = 14;
    const boxH = lines.length * lineHeight + 10;
    this._lastBoxH = boxH;
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
    this._lastBoxH = boxH;
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
    this._lastBoxH = boxH;
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
