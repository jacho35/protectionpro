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

  solar_pv(w, h, comp) {
    const r = Math.min(w, h) * 0.38;
    // Array mode: draw a small panel-array glyph (grid of cells) beside the
    // inverter circle with the string layout, so the panels read on the SLD
    let arrayGlyph = '';
    if (comp && comp.props && comp.props.pv_array_mode === 'array') {
      const strings = Math.max(1, Math.round(comp.props.pv_strings || 1));
      const pps = Math.max(1, Math.round(comp.props.pv_panels_per_string || 1));
      const gx = -r - 16, gy = -r - 2, gw = 14, gh = 10;
      arrayGlyph = `
        <g class="symbol-pv-array" stroke="currentColor" stroke-width="0.8" fill="none">
          <rect x="${gx}" y="${gy}" width="${gw}" height="${gh}"/>
          <line x1="${gx + gw / 3}" y1="${gy}" x2="${gx + gw / 3}" y2="${gy + gh}"/>
          <line x1="${gx + 2 * gw / 3}" y1="${gy}" x2="${gx + 2 * gw / 3}" y2="${gy + gh}"/>
          <line x1="${gx}" y1="${gy + gh / 2}" x2="${gx + gw}" y2="${gy + gh / 2}"/>
          <line x1="${gx + gw}" y1="${gy + gh / 2}" x2="${-r * 0.7}" y2="${-r * 0.7}"/>
          <text x="${gx + gw / 2}" y="${gy + gh + 7}" text-anchor="middle" font-size="6"
            fill="#e67700" stroke="none" font-family="sans-serif">${strings}S×${pps}P</text>
        </g>`;
    }
    return `
      <g class="symbol-solar-pv">
        ${arrayGlyph}
        <circle cx="0" cy="0" r="${r}" fill="none" stroke="currentColor" stroke-width="1.5"/>
        <line x1="${-r * 0.55}" y1="${r * 0.35}" x2="${r * 0.55}" y2="${-r * 0.35}" stroke="currentColor" stroke-width="1.3"/>
        <line x1="${-r * 0.55}" y1="${r * 0.0}" x2="${r * 0.55}" y2="${-r * 0.7}" stroke="currentColor" stroke-width="1.3"/>
        <text x="${r * 0.05}" y="${r * 0.65}" text-anchor="middle" font-size="8" font-weight="600" fill="#e67700" font-family="sans-serif">PV</text>
        <line x1="0" y1="${r}" x2="0" y2="${h / 2}"/>
      </g>`;
  },

  battery(w, h) {
    const r = Math.min(w, h) * 0.38;
    // IEC-style battery cell (long/short plates) inside the source circle
    return `
      <g class="symbol-battery">
        <circle cx="0" cy="0" r="${r}" fill="none" stroke="currentColor" stroke-width="1.5"/>
        <line x1="${-r * 0.55}" y1="${-r * 0.18}" x2="${r * 0.55}" y2="${-r * 0.18}" stroke="currentColor" stroke-width="1.6"/>
        <line x1="${-r * 0.28}" y1="${r * 0.14}" x2="${r * 0.28}" y2="${r * 0.14}" stroke="currentColor" stroke-width="1.3"/>
        <line x1="0" y1="${-r * 0.55}" x2="0" y2="${-r * 0.18}" stroke="currentColor" stroke-width="1.2"/>
        <line x1="0" y1="${r * 0.14}" x2="0" y2="${r * 0.5}" stroke="currentColor" stroke-width="1.2"/>
        <text x="${r * 0.02}" y="${r * 0.85}" text-anchor="middle" font-size="7" font-weight="600" fill="#7b1fa2" font-family="sans-serif">BESS</text>
        <line x1="0" y1="${r}" x2="0" y2="${h / 2}"/>
      </g>`;
  },

  wind_turbine(w, h) {
    const r = Math.min(w, h) * 0.38;
    // Simplified wind turbine: circle with ~ inside
    return `
      <g class="symbol-wind-turbine">
        <circle cx="0" cy="0" r="${r}" fill="none" stroke="currentColor" stroke-width="1.5"/>
        <path d="M0,${-r * 0.1} L${-r * 0.5},${r * 0.45} L${r * 0.5},${r * 0.45} Z" fill="none" stroke="currentColor" stroke-width="1.2"/>
        <line x1="0" y1="${-r * 0.1}" x2="0" y2="${-r * 0.6}" stroke="currentColor" stroke-width="1.2"/>
        <text x="0" y="${-r * 0.25}" text-anchor="middle" font-size="6" font-weight="600" fill="#1976d2" font-family="sans-serif">W</text>
        <line x1="0" y1="${r}" x2="0" y2="${h / 2 + 2}"/>
      </g>`;
  },

  bus(w, h, comp) {
    const bw = (comp && comp.props && comp.props.busWidth) || w;
    const hw = bw / 2;
    const handleOffset = 18;
    const isDC = comp && comp.props && String(comp.props.system) === 'dc';
    // DC busbars are drawn with a distinct colour and an "=" marker so they
    // read differently from AC buses at a glance.
    const dcMarker = isDC
      ? `<text x="${hw - 8}" y="-5" text-anchor="middle" font-size="9" font-weight="700" fill="#e65100" font-family="sans-serif">=</text>`
      : '';
    // Fat invisible hit line: makes the bar easy to click (select) and hover.
    // Wires attach anywhere along the bar (free-position 'at_<x>' ports).
    return `
      <g class="symbol-bus${isDC ? ' bus-dc' : ''}">
        <title>Click: select · Drag: move · Press W to draw a wire</title>
        <line class="bus-bar-hit" x1="${-hw}" y1="0" x2="${hw}" y2="0" stroke="transparent" stroke-width="14" pointer-events="stroke"/>
        <line class="bus-bar" x1="${-hw}" y1="0" x2="${hw}" y2="0"${isDC ? ' stroke="#e65100"' : ''}/>
        ${dcMarker}
        <rect class="bus-resize-handle bus-resize-left" x="${-hw - handleOffset - 12}" y="-10" width="12" height="20" rx="3" data-bus-resize="left"/>
        <rect class="bus-resize-handle bus-resize-right" x="${hw + handleOffset}" y="-10" width="12" height="20" rx="3" data-bus-resize="right"/>
      </g>`;
  },

  // Generate dynamic ports for a bus based on its width
  getBusPorts(comp) {
    const bw = (comp && comp.props && comp.props.busWidth) || 120;
    const hw = bw / 2;
    const ports = [];
    // Left and right edge ports for bus tie breakers
    ports.push({ id: 'left', side: 'left', offset: 0, _x: -hw, _y: 0 });
    ports.push({ id: 'right', side: 'right', offset: 0, _x: hw, _y: 0 });
    // Evenly spaced top/bottom ports every 40px
    const spacing = 40;
    const count = Math.max(1, Math.floor(bw / spacing));
    const startX = -hw + (bw - (count - 1) * spacing) / 2;
    for (let i = 0; i < count; i++) {
      const x = Math.round(startX + i * spacing);
      ports.push({ id: `top_${i}`, side: 'top', offset: x, _x: x, _y: -5 });
      ports.push({ id: `bottom_${i}`, side: 'bottom', offset: x, _x: x, _y: 5 });
    }
    return ports;
  },

  // Resolve a bus port id to LOCAL coordinates on the bar.
  // Free-position ids ('at_<x>', x = offset from centre) are clamped to the
  // current bar extent so resizing can never leave a connection dangling;
  // legacy generated ids (left/right/top_i/bottom_i, plus bare 'top'/'bottom')
  // resolve through getBusPorts. Returns null if unresolvable.
  getBusPortLocal(comp, portId) {
    const hw = (((comp.props && comp.props.busWidth) || 120)) / 2;
    const pid = String(portId || '');
    if (pid.startsWith('at_')) {
      const off = parseFloat(pid.slice(3));
      return { x: Math.max(-hw, Math.min(hw, isNaN(off) ? 0 : off)), y: 0 };
    }
    const ports = this.getBusPorts(comp);
    const port = ports.find(p => p.id === pid) || ports.find(p => p.id === pid + '_0');
    if (port) return { x: port._x || 0, y: port._y || 0 };
    return null;
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

  bus_duct(w, h) {
    // Busway link: a thick double bar between the left/right terminals.
    const hw = w / 2, g = Math.max(2, h * 0.18);
    return `
      <g class="symbol-bus-duct">
        <line x1="${-hw}" y1="0" x2="${hw}" y2="0" stroke-width="3"/>
        <line x1="${-hw + 4}" y1="${-g}" x2="${hw - 4}" y2="${-g}" stroke-width="1.5"/>
        <line x1="${-hw + 4}" y1="${g}" x2="${hw - 4}" y2="${g}" stroke-width="1.5"/>
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

  ct(w, h, comp) {
    const r = Math.min(w, h) * 0.35;
    const hh = h / 2;
    // Core-balance (window / toroidal) CT: a ring the conductor passes
    // straight through, measuring residual (earth-fault) current — drawn as a
    // double ring, distinct from a phase CT's single tapped circle.
    if (comp && comp.props && comp.props.ct_type === 'core_balance') {
      return `
        <g class="symbol-ct symbol-cbct">
          <circle cx="0" cy="0" r="${r}"/>
          <circle cx="0" cy="0" r="${r * 0.58}"/>
          <line x1="0" y1="${-hh}" x2="0" y2="${hh}"/>
        </g>`;
    }
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

  distribution_board(w, h) {
    const hw = w * 0.42, hh = h * 0.4;
    // Enclosure with incomer stub and way rows — reads as a DB legend card
    return `
      <g class="symbol-db">
        <line x1="0" y1="${-h / 2}" x2="0" y2="${-hh}"/>
        <rect class="symbol-fill" x="${-hw}" y="${-hh}" width="${hw * 2}" height="${hh * 2}" rx="2" fill="none"/>
        <line x1="${-hw}" y1="${-hh + 9}" x2="${hw}" y2="${-hh + 9}"/>
        <text x="0" y="${-hh + 7}" text-anchor="middle" font-size="7" font-weight="bold" class="symbol-text">DB</text>
        <line x1="${-hw + 4}" y1="${-hh + 14}" x2="${hw - 4}" y2="${-hh + 14}" stroke-width="1"/>
        <line x1="${-hw + 4}" y1="${-hh + 19}" x2="${hw - 4}" y2="${-hh + 19}" stroke-width="1"/>
        <line x1="${-hw + 4}" y1="${-hh + 24}" x2="${hw - 4}" y2="${-hh + 24}" stroke-width="1"/>
      </g>`;
  },

  // ── Control circuit symbols (IEC 60617) ──
  // All two-terminal devices draw terminal stubs to ±h/2 so ports line up.

  ctl_supply(w, h, comp) {
    const hw = w / 2, hh = h / 2;
    const type = (comp && comp.props && comp.props.supply_type) || '230VAC';
    const mark = type.endsWith('DC') ? '⎓' : '∿';
    return `
      <g class="symbol-control">
        <rect class="symbol-fill" x="${-hw}" y="${-hh}" width="${w}" height="${h - 8}" rx="3" fill="none"/>
        <text x="0" y="1" text-anchor="middle" font-size="10" class="symbol-text">${mark} ${type}</text>
        <line x1="-15" y1="${hh - 8}" x2="-15" y2="${hh}"/>
        <line x1="15" y1="${hh - 8}" x2="15" y2="${hh}"/>
        <text x="-15" y="${hh - 11}" text-anchor="middle" font-size="6" class="symbol-text">L</text>
        <text x="15" y="${hh - 11}" text-anchor="middle" font-size="6" class="symbol-text">N</text>
      </g>`;
  },

  // Contact base: fixed terminals ±8 from centre; the moving piece is a
  // group pivoted at the bottom terminal (0,8) so ControlSim can swing it
  // open/closed via CSS classes (.ctl-open / .ctl-closed) with a transition.
  // restClosed picks the de-energized rest class; ncBar draws the NC marker.
  _ctlContactBase(h, restClosed, ncBar) {
    const hh = h / 2;
    const bar = ncBar ? `<line x1="-5" y1="-8" x2="5" y2="-8"/>` : '';
    return `
      <line x1="0" y1="${-hh}" x2="0" y2="-8"/>
      <line x1="0" y1="8" x2="0" y2="${hh}"/>
      <g transform="translate(0,8)">
        <g class="ctl-moving ${restClosed ? 'ctl-mv-nc' : 'ctl-mv-no'}">
          <line x1="0" y1="0" x2="0" y2="-16"/>
        </g>
      </g>${bar}`;
  },

  ctl_pb_no(w, h) {
    // IEC momentary pushbutton, NO: open contact + operator head
    return `
      <g class="symbol-control">
        ${this._ctlContactBase(h, false, false)}
        <line x1="-2" y1="0" x2="-11" y2="0" stroke-dasharray="2,2"/>
        <line x1="-11" y1="-5" x2="-11" y2="5"/>
        <path d="M -11 -5 L -14 -5 L -14 5 L -11 5" fill="none"/>
      </g>`;
  },

  ctl_pb_nc(w, h) {
    // IEC momentary pushbutton, NC: closed contact + operator head
    return `
      <g class="symbol-control">
        ${this._ctlContactBase(h, true, true)}
        <line x1="-2" y1="0" x2="-11" y2="0" stroke-dasharray="2,2"/>
        <line x1="-11" y1="-5" x2="-11" y2="5"/>
        <path d="M -11 -5 L -14 -5 L -14 5 L -11 5" fill="none"/>
      </g>`;
  },

  ctl_switch(w, h, comp) {
    // Maintained selector switch; rest position reflects its stored state
    const p = (comp && comp.props) || {};
    const closed = p.state === 'closed';
    const restClosed = p.contact_type === 'nc' ? !closed : closed;
    return `
      <g class="symbol-control">
        ${this._ctlContactBase(h, restClosed, p.contact_type === 'nc')}
        <line x1="-2" y1="0" x2="-10" y2="0" stroke-dasharray="2,2"/>
        <circle cx="-11.5" cy="0" r="1.8" fill="currentColor" stroke="none"/>
      </g>`;
  },

  ctl_breaker(w, h, comp) {
    // IEC 60617 circuit breaker: contact with an X at the fixed terminal
    const p = (comp && comp.props) || {};
    return `
      <g class="symbol-control">
        ${this._ctlContactBase(h, p.state === 'closed', false)}
        <line x1="-3" y1="-11" x2="3" y2="-5"/>
        <line x1="-3" y1="-5" x2="3" y2="-11"/>
      </g>`;
  },

  ctl_contact_no(w, h) {
    return `<g class="symbol-control">${this._ctlContactBase(h, false, false)}</g>`;
  },

  ctl_contact_nc(w, h) {
    return `<g class="symbol-control">${this._ctlContactBase(h, true, true)}</g>`;
  },

  ctl_coil(w, h, comp) {
    const p = (comp && comp.props) || {};
    const hw = w * 0.38, hh = h / 2, bh = 11;
    // On-delay: flag above the coil box points up; off-delay: down
    let timer = '';
    if (p.coil_type === 'timer_on') {
      timer = `<path d="M -5 ${-bh - 3} L 0 ${-bh - 9} L 5 ${-bh - 3}" fill="none"/>`;
    } else if (p.coil_type === 'timer_off') {
      timer = `<path d="M -5 ${-bh - 9} L 0 ${-bh - 3} L 5 ${-bh - 9}" fill="none"/>`;
    }
    return `
      <g class="symbol-control">
        <line x1="0" y1="${-hh}" x2="0" y2="${-bh}"/>
        <line x1="0" y1="${bh}" x2="0" y2="${hh}"/>
        <rect class="symbol-fill" x="${-hw}" y="${-bh}" width="${hw * 2}" height="${bh * 2}" fill="none"/>
        <text x="0" y="3.5" text-anchor="middle" font-size="9" class="symbol-text">${(p.tag || 'K').slice(0, 4)}</text>
        ${timer}
      </g>`;
  },

  ctl_lamp(w, h, comp) {
    const r = 8, hh = h / 2;
    const color = (comp && comp.props && comp.props.color) || 'green';
    const k = r * Math.SQRT1_2;
    return `
      <g class="symbol-control" data-lamp-color="${color}">
        <line x1="0" y1="${-hh}" x2="0" y2="${-r}"/>
        <line x1="0" y1="${r}" x2="0" y2="${hh}"/>
        <circle class="symbol-fill ctl-lamp-glass" cx="0" cy="0" r="${r}" fill="none"/>
        <line x1="${-k}" y1="${-k}" x2="${k}" y2="${k}"/>
        <line x1="${k}" y1="${-k}" x2="${-k}" y2="${k}"/>
      </g>`;
  },

  svc(w, h, comp) {
    // FACTS shunt compensator: a controlled reactive source — a circle with a
    // reactance/tap arrow, tagged SVC or STATCOM, on a lead to the top port.
    const r = w * 0.36;
    const isStatcom = comp && comp.props && String(comp.props.device_mode) === 'statcom';
    const tag = isStatcom ? 'ST' : 'SVC';
    return `
      <g class="symbol-svc">
        <line x1="0" y1="${-r}" x2="0" y2="${-h / 2}"/>
        <circle cx="0" cy="0" r="${r}" fill="var(--bg-primary, #fff)"/>
        <line x1="${-r * 0.6}" y1="${r * 0.6}" x2="${r * 0.6}" y2="${-r * 0.6}"/>
        <path d="M ${r * 0.6 - 5} ${-r * 0.6 + 1} L ${r * 0.6} ${-r * 0.6} L ${r * 0.6 - 1} ${-r * 0.6 + 5} Z" fill="currentColor"/>
        <text x="0" y="${r + 9}" text-anchor="middle" font-size="8" fill="#888" font-family="sans-serif">${tag}</text>
      </g>`;
  },

  autotransformer(w, h, comp) {
    // IEC autotransformer: a single winding (one circle) tapped between the
    // HV (series) terminal and the LV (common) terminal, with a diagonal
    // arrow marking the tap. A 3-winding unit adds a delta tertiary stub.
    const r = w * 0.34;
    const is3w = comp && comp.props && (Number(comp.props.windings) === 3);
    const regulating = comp && comp.props && comp.props.tap_mode === 'regulating';
    const ax = r * 0.7;
    const arrow = `<line x1="${-ax}" y1="${ax}" x2="${ax}" y2="${-ax}"/>`
      + (regulating ? `<path d="M ${ax - 5} ${-ax + 1} L ${ax} ${-ax} L ${ax - 1} ${-ax + 5} Z" fill="currentColor"/>` : '');
    let tertiary = '';
    if (is3w) {
      tertiary = `
        <line x1="${r}" y1="0" x2="${w / 2}" y2="0"/>
        <path d="M ${w / 2} -4 L ${w / 2 + 7} 0 L ${w / 2} 4 Z" fill="none"/>`;
    }
    return `
      <g class="symbol-autotransformer">
        <circle cx="0" cy="0" r="${r}" fill="var(--bg-primary, #fff)"/>
        ${arrow}
        <line x1="0" y1="${-r}" x2="0" y2="${-h / 2}"/>
        <line x1="0" y1="${r}" x2="0" y2="${h / 2}"/>
        ${tertiary}
        <text x="${-w / 2 - 2}" y="${-r + 6}" font-size="8" fill="#888" font-family="sans-serif" text-anchor="end">HV</text>
        <text x="${-w / 2 - 2}" y="${r}" font-size="8" fill="#888" font-family="sans-serif" text-anchor="end">LV</text>
      </g>`;
  },

  vfd(w, h, comp) {
    // IEC-style power-electronic converter: a square box with a diagonal
    // (adjustable) line and AC~ / ~AC markings — the drive rectifies then
    // synthesises a variable-frequency output. A '3~' marks a multi-pulse
    // (12/18/24) input.
    const hw = w * 0.4, hh = h * 0.4;
    const multi = comp && comp.props && Number(comp.props.pulse_number) > 6;
    return `
      <g class="symbol-vfd">
        <rect x="${-hw}" y="${-hh}" width="${2 * hw}" height="${2 * hh}" rx="2" fill="var(--bg-primary, #fff)"/>
        <line x1="${-hw}" y1="${hh}" x2="${hw}" y2="${-hh}"/>
        <text x="${-hw + 3}" y="${-hh + 9}" font-size="9" fill="#888" font-family="sans-serif">${multi ? '3~' : '~'}</text>
        <text x="${hw - 3}" y="${hh - 3}" font-size="9" fill="#888" font-family="sans-serif" text-anchor="end">~f</text>
        <line x1="0" y1="${-hh}" x2="0" y2="${-h / 2}"/>
        <line x1="0" y1="${hh}" x2="0" y2="${h / 2}"/>
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

  ups(w, h) {
    // UPS: rectangle with AC~DC conversion symbol and battery indicator
    const hw = w * 0.42, hh = h * 0.38;
    const halfH = h / 2;
    return `
      <g class="symbol-ups">
        <rect x="${-hw}" y="${-hh}" width="${hw * 2}" height="${hh * 2}" rx="3" fill="var(--bg-primary, #fff)"/>
        <line x1="0" y1="${-hh}" x2="0" y2="${hh}" stroke="#999" stroke-width="0.8" stroke-dasharray="3,2"/>
        <text x="${-hw * 0.5}" y="4" text-anchor="middle" font-size="9" font-weight="600" fill="#1565c0" font-family="sans-serif">~</text>
        <text x="${hw * 0.5}" y="4" text-anchor="middle" font-size="9" font-weight="600" fill="#e65100" font-family="sans-serif">=</text>
        <line x1="${hw * 0.25}" y1="${hh + 2}" x2="${hw * 0.25}" y2="${hh + 6}" stroke="#388e3c" stroke-width="2"/>
        <line x1="${hw * 0.15}" y1="${hh + 4}" x2="${hw * 0.35}" y2="${hh + 4}" stroke="#388e3c" stroke-width="1.2"/>
        <line x1="0" y1="${-hh}" x2="0" y2="${-halfH}"/>
        <line x1="0" y1="${hh}" x2="0" y2="${halfH}"/>
      </g>`;
  },

  rectifier(w, h) {
    // Rectifier: rectangle with AC input ~ and DC output = symbols
    const hw = w * 0.42, hh = h * 0.36;
    const halfH = h / 2;
    return `
      <g class="symbol-rectifier">
        <rect x="${-hw}" y="${-hh}" width="${hw * 2}" height="${hh * 2}" rx="3" fill="var(--bg-primary, #fff)"/>
        <text x="0" y="${-hh * 0.2}" text-anchor="middle" font-size="9" font-weight="600" fill="#1565c0" font-family="sans-serif">~</text>
        <polygon points="${-hw * 0.3},${hh * 0.1} ${hw * 0.3},${hh * 0.5} ${-hw * 0.3},${hh * 0.5}" fill="none" stroke="#e65100" stroke-width="1.2"/>
        <line x1="${hw * 0.3}" y1="${hh * 0.1}" x2="${hw * 0.3}" y2="${hh * 0.5}" stroke="#e65100" stroke-width="1.2"/>
        <line x1="0" y1="${-hh}" x2="0" y2="${-halfH}"/>
        <line x1="0" y1="${hh}" x2="0" y2="${halfH}"/>
      </g>`;
  },

  charger(w, h) {
    // Battery charger: rectangle with battery + plug symbol
    const hw = w * 0.42, hh = h * 0.36;
    const halfH = h / 2;
    return `
      <g class="symbol-charger">
        <rect x="${-hw}" y="${-hh}" width="${hw * 2}" height="${hh * 2}" rx="3" fill="var(--bg-primary, #fff)"/>
        <line x1="${-hw * 0.35}" y1="${-hh * 0.15}" x2="${-hw * 0.35}" y2="${hh * 0.45}" stroke="#388e3c" stroke-width="2"/>
        <line x1="${-hw * 0.55}" y1="${hh * 0.0}" x2="${-hw * 0.15}" y2="${hh * 0.0}" stroke="#388e3c" stroke-width="1.2"/>
        <line x1="${hw * 0.15}" y1="${-hh * 0.15}" x2="${hw * 0.15}" y2="${hh * 0.45}" stroke="#e65100" stroke-width="1.5"/>
        <line x1="${hw * 0.35}" y1="${-hh * 0.15}" x2="${hw * 0.35}" y2="${hh * 0.45}" stroke="#e65100" stroke-width="1.5"/>
        <text x="${hw * 0.25}" y="${hh * 0.75}" text-anchor="middle" font-size="7" font-weight="600" fill="#e65100" font-family="sans-serif">+</text>
        <line x1="0" y1="${-hh}" x2="0" y2="${-halfH}"/>
        <line x1="0" y1="${hh}" x2="0" y2="${halfH}"/>
      </g>`;
  },

  dc_battery(w, h) {
    // Stationary DC battery bank: multiple IEC cell plate pairs + "=" marker.
    const hw = w * 0.42, hh = h * 0.34;
    const halfH = h / 2;
    const cells = [-hw * 0.5, 0, hw * 0.5];
    const plates = cells.map(cx => `
        <line x1="${cx - 5}" y1="${-hh * 0.5}" x2="${cx - 5}" y2="${hh * 0.5}" stroke="currentColor" stroke-width="1.8"/>
        <line x1="${cx + 3}" y1="${-hh * 0.25}" x2="${cx + 3}" y2="${hh * 0.25}" stroke="currentColor" stroke-width="1.2"/>`).join('');
    return `
      <g class="symbol-dc-battery">
        <rect x="${-hw}" y="${-hh}" width="${hw * 2}" height="${hh * 2}" rx="3" fill="var(--bg-primary, #fff)" stroke="currentColor" stroke-width="1"/>
        ${plates}
        <text x="${-hw + 6}" y="${-hh + 8}" text-anchor="middle" font-size="7" font-weight="700" fill="#e65100" font-family="sans-serif">=</text>
        <line x1="0" y1="${-hh}" x2="0" y2="${-halfH}"/>
      </g>`;
  },

  dc_load(w, h) {
    // DC load: box with a downward arrow and "=" marker.
    const hw = w * 0.4, hh = h * 0.34;
    const halfH = h / 2;
    return `
      <g class="symbol-dc-load">
        <rect x="${-hw}" y="${-hh}" width="${hw * 2}" height="${hh * 2}" rx="2" fill="var(--bg-primary, #fff)" stroke="currentColor" stroke-width="1.2"/>
        <text x="${-hw + 6}" y="${-hh + 8}" text-anchor="middle" font-size="7" font-weight="700" fill="#e65100" font-family="sans-serif">=</text>
        <line x1="0" y1="${-hh * 0.3}" x2="0" y2="${hh * 0.6}" stroke="currentColor" stroke-width="1.4"/>
        <polygon points="0,${hh * 0.7} ${-3},${hh * 0.3} ${3},${hh * 0.3}" fill="currentColor"/>
        <line x1="0" y1="${-hh}" x2="0" y2="${-halfH}"/>
      </g>`;
  },

  offpage_connector(w, h, comp) {
    const r = w * 0.45;
    const label = (comp && comp.props && comp.props.name) || 'X';
    return `
      <g class="symbol-offpage">
        <polygon points="0,${-r} ${r},0 0,${r} ${-r},0" class="symbol-fill" fill="white" stroke="currentColor" stroke-width="1.5"/>
        <text x="0" y="4" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">${escHtml(label)}</text>
      </g>`;
  },

  // Render a component on the canvas SVG
  renderComponent(comp) {
    const def = COMPONENT_DEFS[comp.type];
    if (!def) return '';
    const isBus = comp.type === 'bus';
    const w = isBus ? ((comp.props && comp.props.busWidth) || def.width) : def.width;
    const h = def.height;
    const symbolFn = this[comp.type];
    if (!symbolFn) return '';

    // Load-flow case preview: when a saved case is being viewed on the diagram,
    // draw circuit breakers / switches in the state configured for that case
    // (without touching the live component). Matched by component id.
    let renderComp = comp;
    let lfPreviewOverride = false;
    if ((comp.type === 'cb' || comp.type === 'switch') &&
        typeof AppState !== 'undefined' && AppState.lfPreviewCaseId &&
        Array.isArray(AppState.loadFlowCases)) {
      const pcase = AppState.loadFlowCases.find(c => c.id === AppState.lfPreviewCaseId);
      const cc = pcase && (pcase.components || []).find(x => x.id === comp.id);
      const caseState = cc && cc.props ? cc.props.state : undefined;
      if (caseState != null && caseState !== (comp.props && comp.props.state)) {
        renderComp = { ...comp, props: { ...comp.props, state: caseState } };
        lfPreviewOverride = true;
      }
    }

    const symbolSvg = symbolFn.call(this, w, h, renderComp);
    let portsHtml;
    if (isBus) {
      // Free-position attachments: no port hit-circles (they blocked bus
      // selection). Draw a small dot at each connected wire endpoint instead.
      const dots = [];
      if (typeof AppState !== 'undefined' && AppState.wires) {
        for (const wire of AppState.wires.values()) {
          const pid = wire.fromComponent === comp.id ? wire.fromPort
            : (wire.toComponent === comp.id ? wire.toPort : null);
          if (pid == null) continue;
          const loc = this.getBusPortLocal(comp, pid);
          if (loc) dots.push(`<circle class="bus-attach-dot" cx="${loc.x}" cy="${loc.y}" r="3.5"/>`);
        }
      }
      portsHtml = dots.join('');
    } else {
      portsHtml = (def.ports || []).map(p => {
        const pos = this.getPortPosition(p, w, h);
        return `<circle class="conn-port-hit" data-port="${p.id}" cx="${pos.x}" cy="${pos.y}" r="14" fill="transparent" stroke="none" cursor="crosshair"/>
              <circle class="conn-port" data-port="${p.id}" cx="${pos.x}" cy="${pos.y}"/>`;
      }).join('');
    }

    // Name label below component (draggable via offsets)
    const nlOX = comp.nameLabelOffsetX || 0;
    const nlOY = comp.nameLabelOffsetY || 0;
    const labelY = h / 2 + 14 + nlOY;
    const label = comp.props.name || '';

    // Link badge (UX-5): mark boards/cables/switchboard sections linked to the
    // Plan Markup view so the plan↔SLD bridge is visible on the diagram.
    const linked = comp.planLink || comp.swLink;
    const linkBadge = linked ? `
        <g class="comp-plan-link" transform="translate(${w / 2},${-h / 2})" pointer-events="none">
          <title>Linked to Plan Markup</title>
          <circle cx="0" cy="0" r="6.5" fill="#fff" stroke="#2563eb" stroke-width="1.2"/>
          <text x="0" y="0.5" text-anchor="middle" dominant-baseline="central" font-size="7" fill="#2563eb">\u{1F517}</text>
        </g>` : '';

    return `
      <g class="sld-component${lfPreviewOverride ? ' lf-preview-override' : ''}" data-id="${comp.id}" transform="translate(${comp.x},${comp.y}) rotate(${comp.rotation || 0})">
        <rect class="comp-outline" x="${-w / 2 - 4}" y="${-h / 2 - 4}" width="${w + 8}" height="${h + 8}" fill="transparent" stroke="transparent" stroke-width="1"/>
        <g class="comp-body">
          ${symbolSvg}
        </g>
        ${portsHtml}
        <text class="comp-name-label" data-comp-id="${comp.id}" x="${nlOX}" y="${labelY}" text-anchor="middle" font-size="11" fill="#333" cursor="move">${escHtml(label)}</text>
        ${linkBadge}
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
    const isBus = comp.type === 'bus';
    let local;

    if (isBus) {
      // Free-position 'at_<x>' attachments, with legacy generated-port fallback
      const loc = this.getBusPortLocal(comp, portId);
      if (!loc) return { x: comp.x, y: comp.y };
      local = loc;
    } else {
      const port = def.ports.find(p => p.id === portId);
      if (!port) return { x: comp.x, y: comp.y };
      local = this.getPortPosition(port, def.width, def.height);
    }

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
