/* ProtectionPro — On-Diagram Annotations for Fault & Load Flow Results */

const Annotations = {
  layer: null,

  init() {
    this.layer = document.getElementById('annotations-layer');
  },

  render() {
    if (!this.layer) return;
    let html = '';

    // Fault result annotations on buses
    if (AppState.faultResults && AppState.faultResults.buses) {
      for (const [busId, result] of Object.entries(AppState.faultResults.buses)) {
        const comp = AppState.components.get(busId);
        if (!comp) continue;
        const x = comp.x + 70;
        const y = comp.y - 10;
        html += this.renderFaultBadge(x, y, result);
      }
    }

    // Load flow annotations on buses
    if (AppState.loadFlowResults && AppState.loadFlowResults.buses) {
      for (const [busId, result] of Object.entries(AppState.loadFlowResults.buses)) {
        const comp = AppState.components.get(busId);
        if (!comp) continue;
        const x = comp.x - 130;
        const y = comp.y - 10;
        html += this.renderLoadFlowBadge(x, y, result);
      }
    }

    // Load flow on branches
    if (AppState.loadFlowResults && AppState.loadFlowResults.branches) {
      for (const branch of AppState.loadFlowResults.branches) {
        let x, y;
        const comp = AppState.components.get(branch.elementId);
        if (comp) {
          x = comp.x + 40;
          y = comp.y;
        } else {
          // Solid link — position at midpoint between the two buses
          const fromBus = AppState.components.get(branch.from_bus);
          const toBus = AppState.components.get(branch.to_bus);
          if (!fromBus || !toBus) continue;
          x = (fromBus.x + toBus.x) / 2 + 40;
          y = (fromBus.y + toBus.y) / 2;
        }
        html += this.renderBranchFlowBadge(x, y, branch);
      }
    }

    this.layer.innerHTML = html;
  },

  renderFaultBadge(x, y, result) {
    const lines = [];
    if (result.ik3 != null) lines.push(`3Φ: ${result.ik3.toFixed(2)} kA`);
    if (result.ik1 != null) lines.push(`SLG: ${result.ik1.toFixed(2)} kA`);
    if (result.ikLL != null) lines.push(`LL: ${result.ikLL.toFixed(2)} kA`);

    const lineHeight = 14;
    const boxH = lines.length * lineHeight + 10;
    const boxW = 100;

    let textHtml = lines.map((line, i) =>
      `<text class="annotation-text" x="${x + 6}" y="${y + 14 + i * lineHeight}">${line}</text>`
    ).join('');

    return `
      <g class="annotation-group fault-annotation">
        <rect class="annotation-badge" x="${x}" y="${y}" width="${boxW}" height="${boxH}"/>
        <text class="annotation-label" x="${x + 6}" y="${y - 3}" font-size="8">FAULT</text>
        ${textHtml}
      </g>`;
  },

  renderLoadFlowBadge(x, y, result) {
    const lines = [];
    if (result.voltage_kv != null) lines.push(`V: ${result.voltage_kv.toFixed(3)} kV (${result.voltage_pu.toFixed(4)} p.u.)`);
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
      <g class="annotation-group loadflow-annotation">
        <rect class="annotation-badge" x="${x}" y="${y}" width="${boxW}" height="${boxH}"/>
        <text class="annotation-label" x="${x + 6}" y="${y - 3}" font-size="8">LOAD FLOW</text>
        ${textHtml}
      </g>`;
  },

  renderBranchFlowBadge(x, y, branch) {
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
      <g class="annotation-group loadflow-annotation">
        <rect class="annotation-badge" x="${x}" y="${y}" width="${boxW}" height="${boxH}"/>
        ${textHtml}
      </g>`;
  },

  // Clear all annotations
  clear() {
    if (this.layer) this.layer.innerHTML = '';
  },
};
