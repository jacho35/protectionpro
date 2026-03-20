/* ProtectionPro — SVG Symbol Rendering */

const Symbols = {
  // Returns SVG markup for a component type's icon (used in palette and on canvas)
  // All symbols are drawn centered at (0,0) within their bounding box

  utility(w, h) {
    // Grid/utility symbol: infinite bus arrows
    const hw = w / 2, hh = h / 2;
    return `
      <g class="symbol-utility">
        <line x1="${-hw}" y1="${-hh}" x2="${hw}" y2="${-hh}"/>
        <line x1="${-hw}" y1="${-hh}" x2="0" y2="${hh * 0.4}"/>
        <line x1="${hw}" y1="${-hh}" x2="0" y2="${hh * 0.4}"/>
        <line x1="${-hw * 0.6}" y1="${-hh * 0.3}" x2="${hw * 0.6}" y2="${-hh * 0.3}"/>
        <line x1="0" y1="${hh * 0.4}" x2="0" y2="${hh}"/>
      </g>`;
  },

  generator(w, h) {
    const r = Math.min(w, h) * 0.38;
    return `
      <g class="symbol-generator">
        <circle cx="0" cy="0" r="${r}"/>
        <text x="0" y="4" text-anchor="middle" font-size="14" font-weight="bold" fill="#2e7d32" font-family="serif">G</text>
        <line x1="0" y1="${-r}" x2="0" y2="${-h / 2}"/>
      </g>`;
  },

  bus(w, h) {
    const hw = w / 2;
    return `
      <g class="symbol-bus">
        <line class="bus-bar" x1="${-hw}" y1="0" x2="${hw}" y2="0"/>
      </g>`;
  },

  transformer(w, h, comp) {
    // IEC symbol: two overlapping circles
    const r = w * 0.32;
    const dy = r * 0.7; // overlap offset — circles overlap ~40%
    const isStepUp = comp && comp.props && comp.props.winding_config === 'step_up';
    const topLabel = isStepUp ? 'LV' : 'HV';
    const botLabel = isStepUp ? 'HV' : 'LV';
    return `
      <g class="symbol-transformer">
        <circle cx="0" cy="${-dy}" r="${r}" fill="var(--bg-primary, #fff)"/>
        <circle cx="0" cy="${dy}" r="${r}" fill="var(--bg-primary, #fff)"/>
        <line x1="0" y1="${-dy - r}" x2="0" y2="${-h / 2}"/>
        <line x1="0" y1="${dy + r}" x2="0" y2="${h / 2}"/>
        <text x="${w / 2 + 2}" y="${-dy + 4}" font-size="8" fill="#888" font-family="sans-serif">${topLabel}</text>
        <text x="${w / 2 + 2}" y="${dy + 4}" font-size="8" fill="#888" font-family="sans-serif">${botLabel}</text>
      </g>`;
  },

  cable(w, h) {
    const hh = h / 2;
    return `
      <g class="symbol-cable">
        <line x1="0" y1="${-hh}" x2="0" y2="${hh}" stroke-dasharray="6,3"/>
      </g>`;
  },

  cb(w, h, comp) {
    // Circuit breaker: square with X (closed) or gap (open)
    const s = Math.min(w, h) * 0.35;
    const hh = h / 2;
    const isOpen = comp && comp.props && comp.props.state === 'open';
    if (isOpen) {
      return `
        <g class="symbol-cb symbol-open">
          <rect x="${-s}" y="${-s}" width="${s * 2}" height="${s * 2}" fill="white" stroke-dasharray="4,2"/>
          <line x1="${-s}" y1="${-s}" x2="${s}" y2="${s}" stroke-dasharray="4,2"/>
          <line x1="${s}" y1="${-s}" x2="${-s}" y2="${s}" stroke-dasharray="4,2"/>
          <line x1="0" y1="${-s}" x2="0" y2="${-hh}"/>
          <line x1="0" y1="${s}" x2="0" y2="${hh}"/>
          <line x1="${-s - 2}" y1="${-s - 1}" x2="${s + 2}" y2="${-s - 1}" stroke="red" stroke-width="2"/>
        </g>`;
    }
    return `
      <g class="symbol-cb symbol-closed">
        <rect x="${-s}" y="${-s}" width="${s * 2}" height="${s * 2}" fill="white"/>
        <line x1="${-s}" y1="${-s}" x2="${s}" y2="${s}"/>
        <line x1="${s}" y1="${-s}" x2="${-s}" y2="${s}"/>
        <line x1="0" y1="${-s}" x2="0" y2="${-hh}"/>
        <line x1="0" y1="${s}" x2="0" y2="${hh}"/>
      </g>`;
  },

  fuse(w, h) {
    const fw = w * 0.35, fh = h * 0.3;
    const hh = h / 2;
    return `
      <g class="symbol-fuse">
        <rect x="${-fw}" y="${-fh}" width="${fw * 2}" height="${fh * 2}" rx="2"/>
        <line x1="${-fw}" y1="0" x2="${fw}" y2="0"/>
        <line x1="0" y1="${-fh}" x2="0" y2="${-hh}"/>
        <line x1="0" y1="${fh}" x2="0" y2="${hh}"/>
      </g>`;
  },

  relay(w, h) {
    const s = Math.min(w, h) * 0.4;
    return `
      <g class="symbol-relay">
        <rect x="${-s}" y="${-s}" width="${s * 2}" height="${s * 2}" rx="3"/>
        <text x="0" y="4" text-anchor="middle" font-size="11" font-weight="bold" fill="#1565c0" font-family="sans-serif">R</text>
      </g>`;
  },

  switch(w, h, comp) {
    const hh = h / 2;
    const sw = w * 0.3;
    const isOpen = comp && comp.props && comp.props.state === 'open';
    if (isOpen) {
      // Open switch: blade angled away, gap visible
      return `
        <g class="symbol-switch symbol-open">
          <line x1="0" y1="${hh}" x2="0" y2="${hh * 0.2}"/>
          <line x1="0" y1="${hh * 0.2}" x2="${sw * 1.3}" y2="${-hh * 0.6}"/>
          <circle cx="0" cy="${hh * 0.2}" r="3" fill="#333"/>
          <circle cx="0" cy="${-hh * 0.4}" r="3" fill="none" stroke="#333" stroke-width="1.5"/>
          <line x1="0" y1="${-hh * 0.4}" x2="0" y2="${-hh}"/>
        </g>`;
    }
    // Closed switch: blade makes contact
    return `
      <g class="symbol-switch symbol-closed">
        <line x1="0" y1="${hh}" x2="0" y2="${hh * 0.2}"/>
        <line x1="0" y1="${hh * 0.2}" x2="0" y2="${-hh * 0.4}"/>
        <circle cx="0" cy="${hh * 0.2}" r="3" fill="#333"/>
        <circle cx="0" cy="${-hh * 0.4}" r="3" fill="#333"/>
        <line x1="0" y1="${-hh * 0.4}" x2="0" y2="${-hh}"/>
      </g>`;
  },

  ct(w, h) {
    const r = Math.min(w, h) * 0.35;
    const hh = h / 2;
    return `
      <g class="symbol-ct">
        <circle cx="0" cy="0" r="${r}"/>
        <line x1="0" y1="${-r}" x2="0" y2="${-hh}"/>
        <line x1="0" y1="${r}" x2="0" y2="${hh}"/>
      </g>`;
  },

  pt(w, h) {
    const r = Math.min(w, h) * 0.35;
    const hh = h / 2;
    return `
      <g class="symbol-pt">
        <circle cx="0" cy="0" r="${r}"/>
        <line x1="${-r * 0.5}" y1="${-r * 0.3}" x2="${r * 0.5}" y2="${-r * 0.3}"/>
        <line x1="${-r * 0.5}" y1="${r * 0.3}" x2="${r * 0.5}" y2="${r * 0.3}"/>
        <line x1="0" y1="${-r}" x2="0" y2="${-hh}"/>
        <line x1="0" y1="${r}" x2="0" y2="${hh}"/>
      </g>`;
  },

  motor_induction(w, h) {
    const r = Math.min(w, h) * 0.38;
    return `
      <g class="symbol-motor">
        <circle cx="0" cy="0" r="${r}"/>
        <text x="0" y="4" text-anchor="middle" font-size="14" font-weight="bold" fill="#6a1b9a" font-family="serif">M</text>
        <line x1="0" y1="${-r}" x2="0" y2="${-h / 2}"/>
      </g>`;
  },

  motor_synchronous(w, h) {
    const r = Math.min(w, h) * 0.38;
    return `
      <g class="symbol-motor">
        <circle cx="0" cy="0" r="${r}"/>
        <text x="0" y="4" text-anchor="middle" font-size="12" font-weight="bold" fill="#6a1b9a" font-family="serif">SM</text>
        <line x1="0" y1="${-r}" x2="0" y2="${-h / 2}"/>
      </g>`;
  },

  static_load(w, h) {
    const hw = w * 0.4, hh = h * 0.4;
    return `
      <g class="symbol-load">
        <polygon points="0,${-hh} ${hw},${hh} ${-hw},${hh}"/>
        <line x1="0" y1="${-hh}" x2="0" y2="${-h / 2}"/>
      </g>`;
  },

  capacitor_bank(w, h) {
    const hw = w * 0.4;
    const gap = 4;
    const hh = h / 2;
    return `
      <g class="symbol-capacitor">
        <line x1="${-hw}" y1="${-gap}" x2="${hw}" y2="${-gap}"/>
        <line x1="${-hw}" y1="${gap}" x2="${hw}" y2="${gap}"/>
        <line x1="0" y1="${-gap}" x2="0" y2="${-hh}"/>
        <line x1="0" y1="${gap}" x2="0" y2="${hh}"/>
      </g>`;
  },

  surge_arrester(w, h) {
    const hw = w * 0.3;
    const hh = h / 2;
    return `
      <g class="symbol-arrester">
        <line x1="0" y1="${-hh}" x2="0" y2="${-hh * 0.3}"/>
        <polyline points="${-hw},${-hh * 0.3} 0,${hh * 0.3} ${hw},${-hh * 0.3}"/>
        <line x1="${-hw}" y1="${hh * 0.4}" x2="${hw}" y2="${hh * 0.4}"/>
        <line x1="${-hw * 0.7}" y1="${hh * 0.6}" x2="${hw * 0.7}" y2="${hh * 0.6}"/>
        <line x1="${-hw * 0.4}" y1="${hh * 0.8}" x2="${hw * 0.4}" y2="${hh * 0.8}"/>
      </g>`;
  },

  // Render a component on the canvas SVG
  renderComponent(comp) {
    const def = COMPONENT_DEFS[comp.type];
    if (!def) return '';
    const { width: w, height: h } = def;
    const symbolFn = this[comp.type];
    if (!symbolFn) return '';

    const symbolSvg = symbolFn.call(this, w, h, comp);
    const portsHtml = (def.ports || []).map(p => {
      const pos = this.getPortPosition(p, w, h);
      return `<circle class="conn-port-hit" data-port="${p.id}" cx="${pos.x}" cy="${pos.y}" r="14" fill="transparent" stroke="none" cursor="crosshair"/>
              <circle class="conn-port" data-port="${p.id}" cx="${pos.x}" cy="${pos.y}"/>`;
    }).join('');

    // Name label below component (draggable via offsets)
    const nlOX = comp.nameLabelOffsetX || 0;
    const nlOY = comp.nameLabelOffsetY || 0;
    const labelY = h / 2 + 14 + nlOY;
    const label = comp.props.name || '';

    return `
      <g class="sld-component" data-id="${comp.id}" transform="translate(${comp.x},${comp.y}) rotate(${comp.rotation || 0})">
        <rect class="comp-outline" x="${-w / 2 - 4}" y="${-h / 2 - 4}" width="${w + 8}" height="${h + 8}" fill="transparent" stroke="transparent" stroke-width="1"/>
        <g class="comp-body">
          ${symbolSvg}
        </g>
        ${portsHtml}
        <text class="comp-name-label" data-comp-id="${comp.id}" x="${nlOX}" y="${labelY}" text-anchor="middle" font-size="11" fill="#333" cursor="move">${label}</text>
      </g>`;
  },

  // Calculate port position relative to component center
  getPortPosition(port, w, h) {
    switch (port.side) {
      case 'top': return { x: port.offset || 0, y: -h / 2 };
      case 'bottom': return { x: port.offset || 0, y: h / 2 };
      case 'left': return { x: -w / 2, y: port.offset || 0 };
      case 'right': return { x: w / 2, y: port.offset || 0 };
      default: return { x: 0, y: 0 };
    }
  },

  // Get port position in world (absolute) coordinates, accounting for rotation
  getPortWorldPosition(comp, portId) {
    const def = COMPONENT_DEFS[comp.type];
    const port = def.ports.find(p => p.id === portId);
    if (!port) return { x: comp.x, y: comp.y };
    const local = this.getPortPosition(port, def.width, def.height);
    // Apply component rotation to local port coordinates
    const rot = (comp.rotation || 0) * Math.PI / 180;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const rx = local.x * cos - local.y * sin;
    const ry = local.x * sin + local.y * cos;
    return { x: comp.x + rx, y: comp.y + ry };
  },

  // Render palette icon (smaller, no ports)
  renderPaletteIcon(type) {
    const def = COMPONENT_DEFS[type];
    if (!def) return '';
    const w = 32, h = 32;
    const scale = Math.min(32 / def.width, 32 / def.height) * 0.8;
    const symbolFn = this[type];
    if (!symbolFn) return '';
    const svg = symbolFn.call(this, def.width, def.height);
    return `<svg viewBox="${-20} ${-20} 40 40" width="32" height="32">
      <g transform="scale(${scale})">${svg}</g>
    </svg>`;
  },
};
