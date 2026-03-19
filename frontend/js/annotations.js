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
        const comp = AppState.components.get(branch.elementId);
        if (!comp) continue;
        const x = comp.x + 40;
        const y = comp.y;
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
    if (result.voltage_pu != null) lines.push(`V: ${result.voltage_pu.toFixed(4)} p.u.`);
    if (result.angle_deg != null) lines.push(`δ: ${result.angle_deg.toFixed(2)}°`);

    const lineHeight = 14;
    const boxH = lines.length * lineHeight + 10;
    const boxW = 110;

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
    if (branch.p_mw != null) lines.push(`P: ${branch.p_mw.toFixed(3)} MW`);
    if (branch.q_mvar != null) lines.push(`Q: ${branch.q_mvar.toFixed(3)} MVAr`);
    if (branch.loading_pct != null) lines.push(`Load: ${branch.loading_pct.toFixed(1)}%`);

    const lineHeight = 14;
    const boxH = lines.length * lineHeight + 10;
    const boxW = 110;

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
