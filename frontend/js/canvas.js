/* ProtectionPro — SVG Canvas: Pan, Zoom, Rendering */

const Canvas = {
  svg: null,
  diagramLayer: null,
  componentsLayer: null,
  wiresLayer: null,
  annotationsLayer: null,
  overlayLayer: null,
  gridBg: null,

  // State for panning
  isPanning: false,
  panStart: { x: 0, y: 0 },

  // State for selection box (marquee)
  isSelecting: false,
  selBoxStart: { x: 0, y: 0 },
  selBoxBaseIds: new Set(), // IDs selected before marquee started (for shift+drag)

  // State for dragging data labels
  labelDrag: null, // { compId, startX, startY, origOX, origOY }

  // State for dragging annotation badges
  annotationDrag: null, // { key, startX, startY, origDX, origDY }

  init() {
    this.svg = document.getElementById('sld-canvas');
    this.diagramLayer = document.getElementById('diagram-layer');
    this.componentsLayer = document.getElementById('components-layer');
    this.wiresLayer = document.getElementById('wires-layer');
    this.annotationsLayer = document.getElementById('annotations-layer');
    this.overlayLayer = document.getElementById('overlay-layer');
    this.gridBg = document.getElementById('grid-bg');

    this.bindEvents();
    this.updateTransform();
  },

  bindEvents() {
    this.svg.addEventListener('mousedown', (e) => this.onMouseDown(e));
    this.svg.addEventListener('mousemove', (e) => this.onMouseMove(e));
    this.svg.addEventListener('mouseup', (e) => this.onMouseUp(e));
    this.svg.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.svg.addEventListener('contextmenu', (e) => e.preventDefault());

    // Track coordinates in status bar
    this.svg.addEventListener('mousemove', (e) => {
      const pt = this.screenToWorld(e.clientX, e.clientY);
      document.getElementById('status-coords').textContent =
        `X: ${Math.round(pt.x)}  Y: ${Math.round(pt.y)}`;
    });
  },

  // Convert screen coords to world coords
  screenToWorld(sx, sy) {
    const rect = this.svg.getBoundingClientRect();
    return {
      x: (sx - rect.left - AppState.panX) / AppState.zoom,
      y: (sy - rect.top - AppState.panY) / AppState.zoom,
    };
  },

  // Convert world coords to screen coords
  worldToScreen(wx, wy) {
    const rect = this.svg.getBoundingClientRect();
    return {
      x: wx * AppState.zoom + AppState.panX + rect.left,
      y: wy * AppState.zoom + AppState.panY + rect.top,
    };
  },

  // Update the SVG transform for pan/zoom
  updateTransform() {
    this.diagramLayer.setAttribute('transform',
      `translate(${AppState.panX},${AppState.panY}) scale(${AppState.zoom})`);
    this.overlayLayer.setAttribute('transform',
      `translate(${AppState.panX},${AppState.panY}) scale(${AppState.zoom})`);

    // Update grid pattern scale
    const gridSmall = document.getElementById('grid-small');
    const gridLarge = document.getElementById('grid-large');
    if (gridSmall && gridLarge) {
      const s = AppState.zoom;
      gridSmall.setAttribute('width', 20 * s);
      gridSmall.setAttribute('height', 20 * s);
      gridSmall.setAttribute('patternTransform', `translate(${AppState.panX},${AppState.panY})`);
      gridLarge.setAttribute('width', 100 * s);
      gridLarge.setAttribute('height', 100 * s);
      gridLarge.setAttribute('patternTransform', `translate(${AppState.panX},${AppState.panY})`);
    }

    // Update zoom display
    document.getElementById('zoom-display').textContent =
      `${Math.round(AppState.zoom * 100)}%`;
  },

  // Mouse down handler
  onMouseDown(e) {
    const worldPt = this.screenToWorld(e.clientX, e.clientY);

    // Middle button or space+left: start panning
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      this.isPanning = true;
      this.panStart = { x: e.clientX - AppState.panX, y: e.clientY - AppState.panY };
      this.svg.classList.add('panning-active');
      e.preventDefault();
      return;
    }

    if (e.button !== 0) return;

    // Check if clicked on a draggable annotation badge
    const annotEl = e.target.closest('.draggable-annotation');
    if (annotEl) {
      const key = annotEl.dataset.annotationKey;
      if (key) {
        const off = Annotations.getOffset(key);
        this.annotationDrag = {
          key,
          startX: worldPt.x,
          startY: worldPt.y,
          origDX: off.dx,
          origDY: off.dy,
        };
        e.preventDefault();
        return;
      }
    }

    // Check if clicked on a data label (for dragging)
    const labelEl = e.target.closest('.comp-data-label');
    if (labelEl) {
      const compId = labelEl.dataset.compId;
      const comp = AppState.components.get(compId);
      if (comp) {
        const isLoad = comp.type === 'static_load' || comp.type === 'motor_induction' || comp.type === 'motor_synchronous';
        this.labelDrag = {
          compId,
          startX: worldPt.x,
          startY: worldPt.y,
          origOX: comp.labelOffsetX != null ? comp.labelOffsetX : 22,
          origOY: comp.labelOffsetY != null ? comp.labelOffsetY : (isLoad ? 30 : 0),
        };
        e.preventDefault();
        return;
      }
    }

    // Check if clicked on a name label (for dragging)
    const nameLabelEl = e.target.closest('.comp-name-label');
    if (nameLabelEl) {
      const compId = nameLabelEl.dataset.compId;
      const comp = AppState.components.get(compId);
      if (comp) {
        this.nameLabelDrag = {
          compId,
          startX: worldPt.x,
          startY: worldPt.y,
          origOX: comp.nameLabelOffsetX || 0,
          origOY: comp.nameLabelOffsetY || 0,
        };
        e.preventDefault();
        return;
      }
    }

    // Check if clicked on a component port (for wiring)
    const portEl = e.target.closest('[data-port]');
    if (portEl && AppState.mode === MODE.SELECT) {
      // Start wiring from this port
      const compEl = portEl.closest('.sld-component');
      const compId = compEl.dataset.id;
      const portId = portEl.dataset.port;
      Wiring.startWire(compId, portId, worldPt);
      return;
    }

    if (AppState.mode === MODE.WIRE) {
      if (portEl) {
        const compEl = portEl.closest('.sld-component');
        Wiring.startWire(compEl.dataset.id, portEl.dataset.port, worldPt);
      } else {
        // Snap to nearest port if close enough
        const snap = this.findNearestPort(worldPt);
        if (snap) {
          Wiring.startWire(snap.compId, snap.portId, { x: snap.x, y: snap.y });
        }
      }
      return;
    }

    // Check if clicked on a component
    const compEl = e.target.closest('.sld-component');
    if (compEl) {
      const id = compEl.dataset.id;
      if (e.shiftKey) {
        AppState.toggleSelect(id);
      } else if (!AppState.selectedIds.has(id)) {
        AppState.select(id);
      }
      // Start drag
      const comp = AppState.components.get(id);
      if (comp) {
        AppState.dragState = {
          startX: worldPt.x,
          startY: worldPt.y,
          origPositions: new Map(),
        };
        for (const sid of AppState.selectedIds) {
          const sc = AppState.components.get(sid);
          if (sc) AppState.dragState.origPositions.set(sid, { x: sc.x, y: sc.y });
        }
      }
      this.render();
      Properties.show(id);
      return;
    }

    // Check if clicked on a wire
    const wireEl = e.target.closest('.sld-wire');
    if (wireEl) {
      const id = wireEl.dataset.id;
      if (e.shiftKey) {
        AppState.toggleSelect(id);
      } else {
        AppState.select(id);
      }
      this.render();
      return;
    }

    // Click on empty canvas: start selection box or clear selection
    if (e.shiftKey) {
      // Shift+drag: remember current selection to preserve it
      this.selBoxBaseIds = new Set(AppState.selectedIds);
    } else {
      AppState.clearSelection();
      Properties.clear();
      this.selBoxBaseIds = new Set();
    }
    this.isSelecting = true;
    this.selBoxStart = worldPt;
    this.render();
  },

  // Mouse move handler
  onMouseMove(e) {
    const worldPt = this.screenToWorld(e.clientX, e.clientY);

    // Panning
    if (this.isPanning) {
      AppState.panX = e.clientX - this.panStart.x;
      AppState.panY = e.clientY - this.panStart.y;
      this.updateTransform();
      return;
    }

    // Dragging annotation badges
    if (this.annotationDrag) {
      const dx = worldPt.x - this.annotationDrag.startX;
      const dy = worldPt.y - this.annotationDrag.startY;
      Annotations.setOffset(
        this.annotationDrag.key,
        this.annotationDrag.origDX + dx,
        this.annotationDrag.origDY + dy,
      );
      Annotations.render();
      // Re-render data labels since annotations layer is cleared
      if (AppState.showCableLabels) this.renderComponentDataLabels();
      return;
    }

    // Dragging data labels
    if (this.labelDrag) {
      const dx = worldPt.x - this.labelDrag.startX;
      const dy = worldPt.y - this.labelDrag.startY;
      const comp = AppState.components.get(this.labelDrag.compId);
      if (comp) {
        comp.labelOffsetX = this.labelDrag.origOX + dx;
        comp.labelOffsetY = this.labelDrag.origOY + dy;
        this.render();
      }
      return;
    }

    // Dragging name labels
    if (this.nameLabelDrag) {
      const dx = worldPt.x - this.nameLabelDrag.startX;
      const dy = worldPt.y - this.nameLabelDrag.startY;
      const comp = AppState.components.get(this.nameLabelDrag.compId);
      if (comp) {
        comp.nameLabelOffsetX = this.nameLabelDrag.origOX + dx;
        comp.nameLabelOffsetY = this.nameLabelDrag.origOY + dy;
        this.render();
      }
      return;
    }

    // Dragging components
    if (AppState.dragState) {
      const dx = worldPt.x - AppState.dragState.startX;
      const dy = worldPt.y - AppState.dragState.startY;
      for (const [id, orig] of AppState.dragState.origPositions) {
        const comp = AppState.components.get(id);
        if (comp) {
          comp.x = snapToGrid(orig.x + dx);
          comp.y = snapToGrid(orig.y + dy);
        }
      }
      AppState.dirty = true;
      this.render();
      return;
    }

    // Wire preview with snap-to-port
    if (AppState.wireStart) {
      const snap = this.findNearestPort(worldPt, AppState.wireStart.componentId);
      AppState.wireSnapTarget = snap;
      if (snap) {
        Wiring.updatePreview({ x: snap.x, y: snap.y });
      } else {
        Wiring.updatePreview(worldPt);
      }
      return;
    }

    // Selection box
    if (this.isSelecting) {
      this.updateSelectionBox(this.selBoxStart, worldPt);
      return;
    }

    // Hover detection
    const compEl = e.target.closest('.sld-component');
    AppState.hoveredId = compEl ? compEl.dataset.id : null;
  },

  // Mouse up handler
  onMouseUp(e) {
    if (this.isPanning) {
      this.isPanning = false;
      this.svg.classList.remove('panning-active');
      return;
    }

    if (this.annotationDrag) {
      this.annotationDrag = null;
      return;
    }

    if (this.labelDrag) {
      AppState.dirty = true;
      this.labelDrag = null;
      return;
    }

    if (this.nameLabelDrag) {
      AppState.dirty = true;
      this.nameLabelDrag = null;
      return;
    }

    if (AppState.dragState) {
      AppState.dragState = null;
      return;
    }

    if (AppState.wireStart) {
      const portEl = e.target.closest('[data-port]');
      if (portEl) {
        const compEl = portEl.closest('.sld-component');
        Wiring.finishWire(compEl.dataset.id, portEl.dataset.port);
      } else if (AppState.wireSnapTarget) {
        Wiring.finishWire(AppState.wireSnapTarget.compId, AppState.wireSnapTarget.portId);
      } else {
        Wiring.cancelWire();
      }
      AppState.wireSnapTarget = null;
      return;
    }

    if (this.isSelecting) {
      this.isSelecting = false;
      this.hideSelectionBox();
      return;
    }
  },

  // Mouse wheel: zoom
  onWheel(e) {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, AppState.zoom + delta));

    // Zoom toward cursor position
    const rect = this.svg.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const scale = newZoom / AppState.zoom;
    AppState.panX = mx - scale * (mx - AppState.panX);
    AppState.panY = my - scale * (my - AppState.panY);
    AppState.zoom = newZoom;

    this.updateTransform();
  },

  // Selection box (marquee) — recalculates selection on every move
  updateSelectionBox(start, end) {
    const box = document.getElementById('selection-box');
    const rect = box.querySelector('rect');
    const bx = Math.min(start.x, end.x);
    const by = Math.min(start.y, end.y);
    const bw = Math.abs(end.x - start.x);
    const bh = Math.abs(end.y - start.y);
    rect.setAttribute('x', bx);
    rect.setAttribute('y', by);
    rect.setAttribute('width', bw);
    rect.setAttribute('height', bh);
    box.style.display = '';

    // Start from the base selection (shift+drag preserves prior selection)
    AppState.selectedIds = new Set(this.selBoxBaseIds);

    // Select components whose bounding box overlaps the marquee
    for (const [id, comp] of AppState.components) {
      const def = COMPONENT_DEFS[comp.type];
      const hw = def.width / 2;
      const hh = def.height / 2;
      const cx1 = comp.x - hw, cy1 = comp.y - hh;
      const cx2 = comp.x + hw, cy2 = comp.y + hh;
      // AABB overlap test
      if (cx2 >= bx && cx1 <= bx + bw && cy2 >= by && cy1 <= by + bh) {
        AppState.selectedIds.add(id);
      }
    }

    // Select wires whose any segment intersects the marquee
    for (const [id, wire] of AppState.wires) {
      const fromComp = AppState.components.get(wire.fromComponent);
      const toComp = AppState.components.get(wire.toComponent);
      if (!fromComp || !toComp) continue;
      const from = Symbols.getPortWorldPosition(fromComp, wire.fromPort);
      const to = Symbols.getPortWorldPosition(toComp, wire.toPort);
      const midY = (from.y + to.y) / 2;
      // Three segments of orthogonal route: vertical, horizontal, vertical
      const segments = [
        { x1: from.x, y1: from.y, x2: from.x, y2: midY },
        { x1: from.x, y1: midY, x2: to.x, y2: midY },
        { x1: to.x, y1: midY, x2: to.x, y2: to.y },
      ];
      for (const seg of segments) {
        if (this.segmentIntersectsRect(seg, bx, by, bw, bh)) {
          AppState.selectedIds.add(id);
          break;
        }
      }
    }

    this.render();
  },

  // Test if an axis-aligned line segment intersects a rectangle
  segmentIntersectsRect(seg, rx, ry, rw, rh) {
    const sx1 = Math.min(seg.x1, seg.x2), sx2 = Math.max(seg.x1, seg.x2);
    const sy1 = Math.min(seg.y1, seg.y2), sy2 = Math.max(seg.y1, seg.y2);
    return sx2 >= rx && sx1 <= rx + rw && sy2 >= ry && sy1 <= ry + rh;
  },

  hideSelectionBox() {
    document.getElementById('selection-box').style.display = 'none';
  },

  // Full re-render of all components and wires
  render() {
    // Render wires
    let wiresHtml = '';
    for (const [id, wire] of AppState.wires) {
      const fromComp = AppState.components.get(wire.fromComponent);
      const toComp = AppState.components.get(wire.toComponent);
      if (!fromComp || !toComp) continue;
      const from = Symbols.getPortWorldPosition(fromComp, wire.fromPort);
      const to = Symbols.getPortWorldPosition(toComp, wire.toPort);
      const selected = AppState.selectedIds.has(id) ? ' selected' : '';
      // Orthogonal routing: go vertical from source, horizontal, then vertical to target
      const midY = (from.y + to.y) / 2;
      const path = `M${from.x},${from.y} L${from.x},${midY} L${to.x},${midY} L${to.x},${to.y}`;
      wiresHtml += `<path class="sld-wire${selected}" data-id="${id}" d="${path}"/>`;
    }
    this.wiresLayer.innerHTML = wiresHtml;

    // Render components
    let compsHtml = '';
    for (const [id, comp] of AppState.components) {
      compsHtml += Symbols.renderComponent(comp);
    }
    this.componentsLayer.innerHTML = compsHtml;

    // Apply selection styling
    for (const id of AppState.selectedIds) {
      const el = this.componentsLayer.querySelector(`[data-id="${id}"]`);
      if (el) el.classList.add('selected');
    }

    // Render annotations if results exist
    Annotations.render();

    // Render component data labels (cables, transformers, etc.)
    if (AppState.showCableLabels) {
      this.renderComponentDataLabels();
    }

    // Render unconnected port warnings
    if (AppState.showWarnings) {
      this.renderUnconnectedWarnings();
    }

    // Render overload flags on components exceeding rated capacity
    this.renderOverloadFlags();
  },

  // Show key data labels next to cables, transformers, and other components
  renderComponentDataLabels() {
    let html = '';
    for (const comp of AppState.components.values()) {
      const p = comp.props;
      let defaultOX = 22, defaultOY = 0;
      let lines = [];

      if (comp.type === 'cable') {
        let sizeStr = '';
        if (p.standard_type) {
          const std = STANDARD_CABLES.find(c => c.id === p.standard_type);
          if (std) sizeStr = `${std.size_mm2}mm² ${std.conductor}`;
        }
        if (!sizeStr) sizeStr = `R=${p.r_per_km} Ω/km`;
        const useMeters = AppState.defaultLengthUnit === 'm' || p.length_km < 1;
        const lenStr = useMeters ? `${(p.length_km * 1000).toFixed(0)} m` : `${p.length_km} km`;
        lines.push(sizeStr);
        lines.push(lenStr);
        if (p.rated_amps) lines.push(`${p.rated_amps} A`);
      } else if (comp.type === 'transformer') {
        const ratingStr = p.rated_mva >= 1 ? `${p.rated_mva} MVA` : `${(p.rated_mva * 1000).toFixed(0)} kVA`;
        lines.push(ratingStr);
        if (p.voltage_hv_kv && p.voltage_lv_kv) {
          if (p.winding_config === 'step_up') {
            lines.push(`${p.voltage_lv_kv}→${p.voltage_hv_kv} kV`);
          } else {
            lines.push(`${p.voltage_hv_kv}→${p.voltage_lv_kv} kV`);
          }
        }
        if (p.z_percent) lines.push(`Z=${p.z_percent}%`);
      } else if (comp.type === 'static_load') {
        if (p.name && p.name !== 'Load') lines.push(p.name);
        lines.push(`${p.rated_kva || 0} kVA`);
        lines.push(`PF ${p.power_factor || 0.85}`);
        defaultOY = 30;
      } else if (comp.type === 'motor_induction') {
        if (p.name && p.name !== 'IM') lines.push(p.name);
        lines.push(`${p.rated_kw || 0} kW`);
        lines.push(`PF ${p.power_factor || 0.85}`);
        defaultOY = 32;
      } else if (comp.type === 'motor_synchronous') {
        if (p.name && p.name !== 'SM') lines.push(p.name);
        lines.push(`${p.rated_kva || 0} kVA`);
        lines.push(`PF ${p.power_factor || 0.9}`);
        defaultOY = 32;
      } else {
        continue;
      }

      const ox = comp.labelOffsetX != null ? comp.labelOffsetX : defaultOX;
      const oy = comp.labelOffsetY != null ? comp.labelOffsetY : defaultOY;
      const x = comp.x + ox;
      const y = comp.y + oy;
      const lineHtml = lines.map((line, i) =>
        `<tspan x="${x}" dy="${i === 0 ? 0 : 12}">${line}</tspan>`
      ).join('');
      html += `<text class="comp-data-label" data-comp-id="${comp.id}" x="${x}" y="${y}" font-size="9" fill="#555" font-family="var(--font-mono)" cursor="move">${lineHtml}</text>`;
    }
    this.annotationsLayer.insertAdjacentHTML('beforeend', html);
  },

  // Show red warning circles on unconnected ports
  renderUnconnectedWarnings() {
    const unconnected = Components.getUnconnectedPorts();
    if (unconnected.length === 0) return;

    let html = '';
    for (const { comp, port } of unconnected) {
      const pos = Symbols.getPortWorldPosition(comp, port.id);
      const wx = pos.x;
      const wy = pos.y;
      html += `
        <g class="unconnected-warning" transform="translate(${wx},${wy})">
          <circle r="8" fill="none" stroke="#d32f2f" stroke-width="2" stroke-dasharray="3,2"/>
          <circle r="2" fill="#d32f2f"/>
        </g>`;
    }
    this.annotationsLayer.insertAdjacentHTML('beforeend', html);
  },

  // Show red overload flags on components exceeding rated capacity
  renderOverloadFlags() {
    if (!AppState.loadFlowResults || !AppState.loadFlowResults.branches) return;

    let html = '';
    for (const branch of AppState.loadFlowResults.branches) {
      if (!branch.loading_pct || branch.loading_pct <= 100) continue;

      const comp = AppState.components.get(branch.elementId);
      if (!comp) continue;

      const x = comp.x;
      const y = comp.y - 30;
      const pct = branch.loading_pct.toFixed(0);

      html += `
        <g class="overload-flag" transform="translate(${x},${y})">
          <polygon points="-2,-12 2,-12 3,0 -3,0" fill="#d32f2f"/>
          <polygon points="-7,0 7,0 7,-4 0,-12 -7,-4" fill="#d32f2f"/>
          <rect x="-18" y="1" width="36" height="13" rx="2" fill="#d32f2f"/>
          <text x="0" y="11" text-anchor="middle" font-size="9" fill="#fff" font-weight="bold">${pct}%</text>
        </g>`;
    }

    // Also check bus voltages for under/over voltage
    if (AppState.loadFlowResults.buses) {
      for (const [busId, result] of Object.entries(AppState.loadFlowResults.buses)) {
        if (result.voltage_pu >= 0.95 && result.voltage_pu <= 1.05) continue;
        const comp = AppState.components.get(busId);
        if (!comp) continue;

        const x = comp.x;
        const y = comp.y - 30;
        const vStr = Annotations.formatVoltage(result.voltage_kv);
        const label = result.voltage_pu < 0.95 ? 'LOW' : 'HIGH';

        html += `
          <g class="overload-flag" transform="translate(${x},${y})">
            <polygon points="-2,-12 2,-12 3,0 -3,0" fill="#d32f2f"/>
            <polygon points="-7,0 7,0 7,-4 0,-12 -7,-4" fill="#d32f2f"/>
            <rect x="-28" y="1" width="56" height="13" rx="2" fill="#d32f2f"/>
            <text x="0" y="11" text-anchor="middle" font-size="8" fill="#fff" font-weight="bold">${label} ${vStr}</text>
          </g>`;
      }
    }

    if (html) {
      this.annotationsLayer.insertAdjacentHTML('beforeend', html);
    }
  },

  // Find the nearest port within snap radius (world coordinates)
  findNearestPort(worldPt, excludeCompId) {
    const SNAP_RADIUS = 30;
    let nearest = null;
    let minDist = SNAP_RADIUS;
    for (const comp of AppState.components.values()) {
      if (excludeCompId && comp.id === excludeCompId) continue;
      const def = COMPONENT_DEFS[comp.type];
      if (!def.ports) continue;
      for (const port of def.ports) {
        const pos = Symbols.getPortWorldPosition(comp, port.id);
        const dx = worldPt.x - pos.x;
        const dy = worldPt.y - pos.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < minDist) {
          minDist = dist;
          nearest = { compId: comp.id, portId: port.id, x: pos.x, y: pos.y };
        }
      }
    }
    return nearest;
  },

  // Place a component at position (for drag-drop from palette)
  placeComponent(type, screenX, screenY) {
    const worldPt = this.screenToWorld(screenX, screenY);
    const comp = AppState.addComponent(type, worldPt.x, worldPt.y);
    if (comp) {
      AppState.select(comp.id);
      this.render();
      Properties.show(comp.id);
    }
    return comp;
  },

  // Zoom to fit all components
  zoomToFit() {
    if (AppState.components.size === 0) {
      AppState.zoom = 1;
      AppState.panX = 0;
      AppState.panY = 0;
      this.updateTransform();
      return;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const comp of AppState.components.values()) {
      const def = COMPONENT_DEFS[comp.type];
      minX = Math.min(minX, comp.x - def.width / 2);
      minY = Math.min(minY, comp.y - def.height / 2);
      maxX = Math.max(maxX, comp.x + def.width / 2);
      maxY = Math.max(maxY, comp.y + def.height / 2);
    }
    const padding = 80;
    const dw = maxX - minX + padding * 2;
    const dh = maxY - minY + padding * 2;
    const rect = this.svg.getBoundingClientRect();
    const svgW = rect.width;
    const svgH = rect.height;
    const zoom = Math.min(svgW / dw, svgH / dh, MAX_ZOOM);
    AppState.zoom = zoom;
    AppState.panX = (svgW - dw * zoom) / 2 - (minX - padding) * zoom;
    AppState.panY = (svgH - dh * zoom) / 2 - (minY - padding) * zoom;
    this.updateTransform();
  },
};
