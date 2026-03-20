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
    // IEC symbol: two overlapping circles with winding type indicators
    const r = w * 0.32;
    const dy = r * 0.7; // overlap offset — circles overlap ~40%
    const isStepUp = comp && comp.props && comp.props.winding_config === 'step_up';
    const topLabel = isStepUp ? 'LV' : 'HV';
    const botLabel = isStepUp ? 'HV' : 'LV';

    // Parse vector group to determine winding types
    const vg = (comp && comp.props && comp.props.vector_group) || 'Dyn11';
    const { hvType, hvGrounded, lvType, lvGrounded } = this._parseVectorGroup(vg);

    // Determine which winding is top/bottom based on step-up/down
    const topType = isStepUp ? lvType : hvType;
    const topGrounded = isStepUp ? lvGrounded : hvGrounded;
    const botType = isStepUp ? hvType : lvType;
    const botGrounded = isStepUp ? hvGrounded : lvGrounded;

    // Get grounding config for the grounded side
    const topGroundingType = isStepUp
      ? (comp?.props?.grounding_lv || 'solidly_grounded')
      : (comp?.props?.grounding_hv || 'ungrounded');
    const botGroundingType = isStepUp
      ? (comp?.props?.grounding_hv || 'ungrounded')
      : (comp?.props?.grounding_lv || 'solidly_grounded');

    // Draw winding indicators inside circles
    const topIndicator = this._windingIndicator(0, -dy, r, topType);
    const botIndicator = this._windingIndicator(0, dy, r, botType);

    // Draw grounding legs
    let groundingSvg = '';
    if (topGrounded && topGroundingType !== 'ungrounded') {
      groundingSvg += this._groundingLeg(0, -dy, r, 'top', topGroundingType);
    }
    if (botGrounded && botGroundingType !== 'ungrounded') {
      groundingSvg += this._groundingLeg(0, dy, r, 'bottom', botGroundingType);
    }

    return `
      <g class="symbol-transformer">
        <circle cx="0" cy="${-dy}" r="${r}" fill="var(--bg-primary, #fff)"/>
        <circle cx="0" cy="${dy}" r="${r}" fill="var(--bg-primary, #fff)"/>
        ${topIndicator}
        ${botIndicator}
        <line x1="0" y1="${-dy - r}" x2="0" y2="${-h / 2}"/>
        <line x1="0" y1="${dy + r}" x2="0" y2="${h / 2}"/>
        ${groundingSvg}
        <text x="${-w / 2 - 2}" y="${-dy + 4}" font-size="8" fill="#888" font-family="sans-serif" text-anchor="end">${topLabel}</text>
        <text x="${-w / 2 - 2}" y="${dy + 4}" font-size="8" fill="#888" font-family="sans-serif" text-anchor="end">${botLabel}</text>
      </g>`;
  },

  _parseVectorGroup(vg) {
    // HV winding: first uppercase letter(s)
    let hvType = 'D', hvGrounded = false;
    if (vg.startsWith('YN')) { hvType = 'Y'; hvGrounded = true; }
    else if (vg.startsWith('Y')) { hvType = 'Y'; }
    else if (vg.startsWith('D')) { hvType = 'D'; }
    else if (vg.startsWith('ZN')) { hvType = 'Z'; hvGrounded = true; }
    else if (vg.startsWith('Z')) { hvType = 'Z'; }

    // LV winding: lowercase portion after HV designation
    const lvPart = vg.replace(/^[A-Z]+/, '');
    let lvType = 'y', lvGrounded = false;
    if (lvPart.startsWith('yn')) { lvType = 'Y'; lvGrounded = true; }
    else if (lvPart.startsWith('y')) { lvType = 'Y'; }
    else if (lvPart.startsWith('d')) { lvType = 'D'; }
    else if (lvPart.startsWith('zn')) { lvType = 'Z'; lvGrounded = true; }
    else if (lvPart.startsWith('z')) { lvType = 'Z'; }

    return { hvType, hvGrounded, lvType, lvGrounded };
  },

  _windingIndicator(cx, cy, r, type) {
    const s = r * 0.45; // scale factor for indicators
    if (type === 'D') {
      // Delta: equilateral triangle
      const h = s * 0.87; // height of equilateral triangle (sqrt(3)/2 * s)
      return `<polygon points="${cx},${cy - h * 0.6} ${cx + s * 0.5},${cy + h * 0.4} ${cx - s * 0.5},${cy + h * 0.4}" fill="none" stroke="#333" stroke-width="1.2"/>`;
    }
    if (type === 'Y') {
      // Wye/Star: Y shape
      const arm = s * 0.55;
      const topY = cy - arm * 0.7;
      const midY = cy + arm * 0.1;
      const botY = cy + arm * 0.7;
      return `<g stroke="#333" stroke-width="1.2" fill="none">
        <line x1="${cx}" y1="${midY}" x2="${cx - arm * 0.6}" y2="${topY}"/>
        <line x1="${cx}" y1="${midY}" x2="${cx + arm * 0.6}" y2="${topY}"/>
        <line x1="${cx}" y1="${midY}" x2="${cx}" y2="${botY}"/>
      </g>`;
    }
    if (type === 'Z') {
      // Zigzag: Z shape
      const zw = s * 0.35;
      const zh = s * 0.55;
      return `<polyline points="${cx - zw},${cy - zh} ${cx + zw},${cy - zh} ${cx - zw},${cy + zh} ${cx + zw},${cy + zh}" fill="none" stroke="#333" stroke-width="1.2"/>`;
    }
    return '';
  },

  _groundingLeg(cx, cy, r, position, groundingType) {
    // Draw grounding symbol extending to the right of the winding circle
    const startX = cx + r;  // start from edge of circle
    const legLen = 12;      // horizontal leg length
    const endX = startX + legLen;
    const earthX = endX;

    // Earth symbol: 3 horizontal lines of decreasing width
    let earthSvg = '';
    if (groundingType === 'solidly_grounded') {
      // Solid earth: filled lines
      earthSvg = `
        <line x1="${earthX - 5}" y1="${cy + 2}" x2="${earthX + 5}" y2="${cy + 2}" stroke="#333" stroke-width="1.2"/>
        <line x1="${earthX - 3.5}" y1="${cy + 5}" x2="${earthX + 3.5}" y2="${cy + 5}" stroke="#333" stroke-width="1.2"/>
        <line x1="${earthX - 2}" y1="${cy + 8}" x2="${earthX + 2}" y2="${cy + 8}" stroke="#333" stroke-width="1.2"/>`;
    } else {
      // Impedance grounded: earth with a zigzag (resistor/reactor) inline
      const zx = startX + 3;
      const zw = legLen - 6;
      const za = zw / 4; // zigzag step width
      earthSvg = `
        <polyline points="${zx},${cy} ${zx + za},${cy - 3} ${zx + za * 2},${cy + 3} ${zx + za * 3},${cy - 3} ${zx + za * 4},${cy}" fill="none" stroke="#333" stroke-width="1"/>
        <line x1="${earthX - 4}" y1="${cy + 3}" x2="${earthX + 4}" y2="${cy + 3}" stroke="#333" stroke-width="1.2"/>
        <line x1="${earthX - 2.5}" y1="${cy + 5.5}" x2="${earthX + 2.5}" y2="${cy + 5.5}" stroke="#333" stroke-width="1.2"/>
        <line x1="${earthX - 1}" y1="${cy + 8}" x2="${earthX + 1}" y2="${cy + 8}" stroke="#333" stroke-width="1.2"/>`;
    }

    return `<g class="grounding-symbol">
      <line x1="${startX}" y1="${cy}" x2="${endX}" y2="${cy}" stroke="#333" stroke-width="1.2"/>
      ${earthSvg}
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
