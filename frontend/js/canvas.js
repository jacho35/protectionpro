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

  // State for bus resize drag
  busResize: null, // { compId, side, startX, origWidth }

  // State for dragging annotation badges
  annotationDrag: null, // { key, startX, startY, origDX, origDY }

  // State for dragging wire bend points
  bendDrag: null, // { wireId, bendIndex, startX, startY }

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

    // Double-click to add/remove wire bend points
    this.svg.addEventListener('dblclick', (e) => {
      const worldPt = this.screenToWorld(e.clientX, e.clientY);
      // Check if double-clicked on a bend point (remove it)
      const bendEl = e.target.closest('.wire-bend-point');
      if (bendEl) {
        const wireId = bendEl.dataset.wireId;
        const bendIdx = parseInt(bendEl.dataset.bendIndex);
        const wire = AppState.wires.get(wireId);
        if (wire && wire.bendPoints) {
          wire.bendPoints.splice(bendIdx, 1);
          if (wire.bendPoints.length === 0) delete wire.bendPoints;
          AppState.dirty = true;
          if (typeof UndoManager !== 'undefined') UndoManager.snapshot();
          this.render();
        }
        return;
      }
      // Check if double-clicked on a wire (add bend point)
      const wireEl = e.target.closest('.sld-wire');
      if (wireEl) {
        const wireId = wireEl.dataset.id;
        const wire = AppState.wires.get(wireId);
        if (wire) {
          if (!wire.bendPoints) wire.bendPoints = [];
          // Insert bend point at clicked position, sorted by proximity to path segments
          const snapped = { x: snapToGrid(worldPt.x), y: snapToGrid(worldPt.y) };
          // Find insertion index based on distance along the wire
          const fromComp = AppState.components.get(wire.fromComponent);
          const toComp = AppState.components.get(wire.toComponent);
          if (fromComp && toComp) {
            const from = Symbols.getPortWorldPosition(fromComp, wire.fromPort);
            const allPts = [from, ...wire.bendPoints, Symbols.getPortWorldPosition(toComp, wire.toPort)];
            let bestIdx = wire.bendPoints.length; // default: append
            let bestDist = Infinity;
            for (let i = 0; i < allPts.length - 1; i++) {
              const d = this._ptSegDist(snapped, allPts[i], allPts[i + 1]);
              if (d < bestDist) { bestDist = d; bestIdx = i; }
            }
            wire.bendPoints.splice(bestIdx, 0, snapped);
          } else {
            wire.bendPoints.push(snapped);
          }
          AppState.dirty = true;
          if (typeof UndoManager !== 'undefined') UndoManager.snapshot();
          this.render();
        }
        return;
      }
    });

    // Track coordinates in status bar
    this.svg.addEventListener('mousemove', (e) => {
      const pt = this.screenToWorld(e.clientX, e.clientY);
      document.getElementById('status-coords').textContent =
        `X: ${Math.round(pt.x)}  Y: ${Math.round(pt.y)}`;
    });
  },

  // Convert screen coords to world coords
  // Build a smooth cubic spline path through points using Catmull-Rom → cubic Bezier
  _buildSplinePath(pts) {
    if (pts.length < 2) return '';
    if (pts.length === 2) {
      const midY = (pts[0].y + pts[1].y) / 2;
      return `M${pts[0].x},${pts[0].y} C${pts[0].x},${midY} ${pts[1].x},${midY} ${pts[1].x},${pts[1].y}`;
    }
    let d = `M${pts[0].x},${pts[0].y}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(i - 1, 0)];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[Math.min(i + 2, pts.length - 1)];
      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = p2.y - (p3.y - p1.y) / 6;
      d += ` C${cp1x},${cp1y} ${cp2x},${cp2y} ${p2.x},${p2.y}`;
    }
    return d;
  },

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

    // Update mini-map viewport
    if (typeof MiniMap !== 'undefined') MiniMap.render();
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

    // Check if clicked on a wire bend point (for dragging)
    const bendEl = e.target.closest('.wire-bend-point');
    if (bendEl) {
      const wireId = bendEl.dataset.wireId;
      const bendIdx = parseInt(bendEl.dataset.bendIndex);
      this.bendDrag = { wireId, bendIndex: bendIdx, startX: worldPt.x, startY: worldPt.y };
      e.preventDefault();
      return;
    }

    // Check if clicked on a bus resize handle
    const busResizeEl = e.target.closest('[data-bus-resize]');
    if (busResizeEl) {
      const compEl = busResizeEl.closest('.sld-component');
      if (compEl) {
        const compId = compEl.dataset.id;
        const comp = AppState.components.get(compId);
        if (comp && comp.type === 'bus') {
          const side = busResizeEl.dataset.busResize; // 'left' or 'right'
          this.busResize = {
            compId,
            side,
            startX: worldPt.x,
            origWidth: comp.props.busWidth || 120,
            origCompX: comp.x,
          };
          e.preventDefault();
          return;
        }
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

    // Check if clicked on a group bounding box
    const groupEl = e.target.closest('.sld-group');
    if (groupEl && groupEl.dataset.groupId) {
      const gid = groupEl.dataset.groupId;
      if (!e.shiftKey) AppState.clearSelection();
      AppState.selectGroup(gid);
      this.render();
      return;
    }

    // Check if clicked on a component
    const compEl = e.target.closest('.sld-component');
    if (compEl) {
      const id = compEl.dataset.id;
      const comp = AppState.components.get(id);
      if (e.shiftKey) {
        AppState.toggleSelect(id);
      } else if (!AppState.selectedIds.has(id)) {
        AppState.select(id);
        // Auto-select group members
        if (comp?.groupId) AppState.selectGroup(comp.groupId);
      }
      // Start drag
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

    // Bus resize dragging
    if (this.busResize) {
      const comp = AppState.components.get(this.busResize.compId);
      if (comp) {
        const dx = worldPt.x - this.busResize.startX;
        if (this.busResize.side === 'right') {
          // Extend right: add dx to width, shift center right by dx/2
          const newWidth = snapToGrid(Math.max(60, this.busResize.origWidth + dx));
          const widthDelta = newWidth - this.busResize.origWidth;
          comp.props.busWidth = newWidth;
          comp.x = snapToGrid(this.busResize.origCompX + widthDelta / 2);
        } else {
          // Extend left: subtract dx from width, shift center left by dx/2
          const newWidth = snapToGrid(Math.max(60, this.busResize.origWidth - dx));
          const widthDelta = newWidth - this.busResize.origWidth;
          comp.props.busWidth = newWidth;
          comp.x = snapToGrid(this.busResize.origCompX - widthDelta / 2);
        }
        AppState.dirty = true;
        this.render();
      }
      return;
    }

    // Dragging wire bend points
    if (this.bendDrag) {
      const wire = AppState.wires.get(this.bendDrag.wireId);
      if (wire && wire.bendPoints && wire.bendPoints[this.bendDrag.bendIndex]) {
        wire.bendPoints[this.bendDrag.bendIndex] = {
          x: snapToGrid(worldPt.x),
          y: snapToGrid(worldPt.y),
        };
        this.render();
      }
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

    if (this.busResize) {
      AppState.dirty = true;
      if (typeof UndoManager !== 'undefined') UndoManager.snapshot();
      this.busResize = null;
      this.render();
      return;
    }

    if (this.bendDrag) {
      AppState.dirty = true;
      if (typeof UndoManager !== 'undefined') UndoManager.snapshot();
      this.bendDrag = null;
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
      if (typeof UndoManager !== 'undefined') UndoManager.snapshot();
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
    // Get page-filtered components and wires
    const pageComps = AppState.getActivePageComponents();
    const pageWires = AppState.getActivePageWires();

    // Render wires
    let wiresHtml = '';
    for (const [id, wire] of pageWires) {
      const fromComp = AppState.components.get(wire.fromComponent);
      const toComp = AppState.components.get(wire.toComponent);
      if (!fromComp || !toComp) continue;
      const from = Symbols.getPortWorldPosition(fromComp, wire.fromPort);
      const to = Symbols.getPortWorldPosition(toComp, wire.toPort);
      const selected = AppState.selectedIds.has(id) ? ' selected' : '';

      let path;
      const mode = wire.routeMode || AppState.wireRouteMode;

      if (wire.bendPoints && wire.bendPoints.length > 0) {
        const pts = [from, ...wire.bendPoints, to];
        if (mode === 'spline') {
          path = this._buildSplinePath(pts);
        } else if (mode === 'diagonal') {
          path = `M${pts[0].x},${pts[0].y}`;
          for (let i = 1; i < pts.length; i++) path += ` L${pts[i].x},${pts[i].y}`;
        } else {
          // Orthogonal: horizontal then vertical at each bend
          path = `M${pts[0].x},${pts[0].y}`;
          for (let i = 1; i < pts.length; i++) {
            path += ` L${pts[i].x},${pts[i - 1].y} L${pts[i].x},${pts[i].y}`;
          }
        }
      } else {
        if (mode === 'diagonal') {
          path = `M${from.x},${from.y} L${to.x},${to.y}`;
        } else if (mode === 'spline') {
          const midY = (from.y + to.y) / 2;
          path = `M${from.x},${from.y} C${from.x},${midY} ${to.x},${midY} ${to.x},${to.y}`;
        } else {
          // Default orthogonal routing
          const midY = (from.y + to.y) / 2;
          path = `M${from.x},${from.y} L${from.x},${midY} L${to.x},${midY} L${to.x},${to.y}`;
        }
      }
      wiresHtml += `<path class="sld-wire${selected}" data-id="${id}" d="${path}"/>`;

      // Draw bend point handles for selected wires
      if (AppState.selectedIds.has(id) && wire.bendPoints) {
        wire.bendPoints.forEach((bp, i) => {
          wiresHtml += `<circle class="wire-bend-point" data-wire-id="${id}" data-bend-index="${i}" cx="${bp.x}" cy="${bp.y}" r="5" fill="#0078d7" stroke="#fff" stroke-width="1.5" style="cursor:move"/>`;
        });
      }
    }
    this.wiresLayer.innerHTML = wiresHtml;

    // Render components (page-filtered)
    let compsHtml = '';
    // Draw group bounding boxes first (behind components)
    for (const [gid, group] of AppState.groups) {
      const bounds = AppState.getGroupBounds(gid);
      if (!bounds) continue;
      // Check if any group member is on this page
      const onPage = [...group.memberIds].some(cid => pageComps.has(cid));
      if (!onPage) continue;
      const anySelected = [...group.memberIds].some(cid => AppState.selectedIds.has(cid));
      const cls = anySelected ? 'sld-group selected' : 'sld-group';
      compsHtml += `<rect class="${cls}" data-group-id="${gid}" x="${bounds.x}" y="${bounds.y}" width="${bounds.w}" height="${bounds.h}" rx="6"/>`;
      compsHtml += `<text class="sld-group-label" x="${bounds.x + 4}" y="${bounds.y - 3}" font-size="10" fill="#6a1b9a">${group.name}</text>`;
    }
    for (const [id, comp] of pageComps) {
      compsHtml += Symbols.renderComponent(comp);
    }
    this.componentsLayer.innerHTML = compsHtml;

    // Hide visual port circles on bus components (hit areas remain active)
    for (const [id, comp] of pageComps) {
      if (comp.type !== 'bus') continue;
      const grp = this.componentsLayer.querySelector(`[data-id="${id}"]`);
      if (!grp) continue;
      for (const dot of grp.querySelectorAll('.conn-port')) {
        dot.style.display = 'none';
      }
    }

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

    // Render directional flow arrows on wires
    this.renderLoadFlowArrows();
    this.renderFaultFlowArrows();

    // Update mini-map
    if (typeof MiniMap !== 'undefined') MiniMap.render();
  },

  // Show key data labels next to cables, transformers, and other components
  renderComponentDataLabels() {
    let html = '';
    const pageComps = AppState.getActivePageComponents();
    for (const comp of pageComps.values()) {
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
        const nPar = p.num_parallel || 1;
        if (nPar > 1) sizeStr = `${nPar}× ${sizeStr}`;
        const useMeters = AppState.defaultLengthUnit === 'm' || p.length_km < 1;
        const lenStr = useMeters ? `${(p.length_km * 1000).toFixed(0)} m` : `${p.length_km} km`;
        lines.push(sizeStr);
        lines.push(lenStr);
        const totalAmps = (p.rated_amps || 0) * nPar;
        if (totalAmps) lines.push(`${totalAmps} A${nPar > 1 ? ` (${nPar}×${p.rated_amps})` : ''}`);
        // Show load flow results on cable
        if (AppState.showResultBoxes.loadflow && AppState.loadFlowResults && AppState.loadFlowResults.branches) {
          const branch = AppState.loadFlowResults.branches.find(b => b.elementId === comp.id);
          if (branch) {
            const loadColor = branch.loading_pct > 100 ? '#d32f2f' : branch.loading_pct > 80 ? '#f57c00' : '#2e7d32';
            const pStr = Math.abs(branch.p_mw) >= 1 ? `${branch.p_mw.toFixed(2)} MW` : `${(branch.p_mw * 1000).toFixed(1)} kW`;
            const qStr = Math.abs(branch.q_mvar) >= 1 ? `${branch.q_mvar.toFixed(2)} MVAr` : `${(branch.q_mvar * 1000).toFixed(1)} kVAr`;
            lines.push({text: '───────', color: loadColor});
            lines.push({text: `P: ${pStr}`, color: loadColor});
            lines.push({text: `Q: ${qStr}`, color: loadColor});
            if (branch.i_amps > 0) lines.push({text: `I: ${branch.i_amps.toFixed(1)} A`, color: loadColor});
            if (branch.loading_pct > 0) lines.push({text: `Load: ${branch.loading_pct.toFixed(1)}%`, color: loadColor});
          }
        }
        // Show fault branch contributions on cable
        if (AppState.showResultBoxes.fault) this._appendFaultBranchLines(comp, lines);
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
        // Show load flow results on transformer
        if (AppState.showResultBoxes.loadflow && AppState.loadFlowResults && AppState.loadFlowResults.branches) {
          const branch = AppState.loadFlowResults.branches.find(b => b.elementId === comp.id);
          if (branch) {
            const loadColor = branch.loading_pct > 100 ? '#d32f2f' : branch.loading_pct > 80 ? '#f57c00' : '#2e7d32';
            const pStr = Math.abs(branch.p_mw) >= 1 ? `${branch.p_mw.toFixed(2)} MW` : `${(branch.p_mw * 1000).toFixed(1)} kW`;
            lines.push({text: '───────', color: loadColor});
            lines.push({text: `P: ${pStr}`, color: loadColor});
            if (branch.i_amps > 0) lines.push({text: `I: ${branch.i_amps.toFixed(1)} A`, color: loadColor});
            if (branch.loading_pct > 0) lines.push({text: `Load: ${branch.loading_pct.toFixed(1)}%`, color: loadColor});
          }
        }
        // Show fault branch contributions on transformer
        if (AppState.showResultBoxes.fault) this._appendFaultBranchLines(comp, lines);
      } else if (['generator', 'solar_pv', 'wind_turbine'].includes(comp.type)) {
        // Show load flow output annotation for source components
        if (AppState.showResultBoxes.loadflow && AppState.loadFlowResults && AppState.loadFlowResults.branches) {
          const branch = AppState.loadFlowResults.branches.find(b => b.elementId === comp.id);
          if (branch && branch.s_mva > 0) {
            const loadColor = branch.loading_pct > 100 ? '#d32f2f' : branch.loading_pct > 80 ? '#f57c00' : '#2e7d32';
            const pStr = Math.abs(branch.p_mw) >= 1 ? `${branch.p_mw.toFixed(2)} MW` : `${(branch.p_mw * 1000).toFixed(1)} kW`;
            lines.push({text: `P: ${pStr}`, color: loadColor});
            if (branch.i_amps > 0) lines.push({text: `I: ${branch.i_amps.toFixed(1)} A`, color: loadColor});
            if (branch.loading_pct > 0) lines.push({text: `Load: ${branch.loading_pct.toFixed(1)}%`, color: loadColor});
          }
        }
        if (!lines.length) continue;
        defaultOY = 32;
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
      } else if (comp.type === 'cb' && AppState.showDeviceLabels) {
        const cbType = (p.cb_type || 'mccb').toUpperCase();
        const tripA = p.trip_rating_a || 630;
        lines.push(`${cbType} ${tripA}A`);
        if (p.breaking_capacity_ka) lines.push(`Icu ${p.breaking_capacity_ka}kA`);
        const thPu = p.thermal_pickup || 1.0;
        const magPu = p.magnetic_pickup || 10;
        lines.push(`Ir=${thPu}× Im=${magPu}×`);
        if (cbType === 'ACB' && p.short_time_pickup) {
          lines.push(`ST=${p.short_time_pickup}×`);
        }
        if (AppState.showResultBoxes.fault) this._appendFaultBranchLines(comp, lines);
      } else if (comp.type === 'fuse' && AppState.showDeviceLabels) {
        const fuseType = p.fuse_type || 'gG';
        const ratedA = p.rated_current_a || 100;
        lines.push(`${fuseType} ${ratedA}A`);
        if (p.rated_voltage_kv) lines.push(`${p.rated_voltage_kv} kV`);
        if (p.breaking_capacity_ka) lines.push(`Icu ${p.breaking_capacity_ka}kA`);
        if (AppState.showResultBoxes.fault) this._appendFaultBranchLines(comp, lines);
      } else if (AppState.showResultBoxes.fault && this._hasFaultBranchData(comp)) {
        // Switch or other element with fault branch data — show it even without device labels
        this._appendFaultBranchLines(comp, lines);
      } else {
        continue;
      }

      const ox = comp.labelOffsetX != null ? comp.labelOffsetX : defaultOX;
      const oy = comp.labelOffsetY != null ? comp.labelOffsetY : defaultOY;
      const x = comp.x + ox;
      const y = comp.y + oy;
      const lineHtml = lines.map((line, i) => {
        const text = typeof line === 'string' ? line : line.text;
        const fill = typeof line === 'object' && line.color ? ` fill="${line.color}"` : '';
        return `<tspan x="${x}" dy="${i === 0 ? 0 : 12}"${fill}>${text}</tspan>`;
      }).join('');
      html += `<text class="comp-data-label" data-comp-id="${comp.id}" x="${x}" y="${y}" font-size="9" fill="#555" font-family="var(--font-mono)" cursor="move">${lineHtml}</text>`;
    }
    this.annotationsLayer.insertAdjacentHTML('beforeend', html);
  },

  // Find fault branch contribution for a component across all faulted buses
  _findFaultBranch(comp) {
    if (!AppState.faultResults || !AppState.faultResults.buses) return null;
    // Aggregate across all buses — take the max current seen on this element
    let best = null;
    for (const busResult of Object.values(AppState.faultResults.buses)) {
      if (!busResult.branches) continue;
      for (const br of busResult.branches) {
        if (br.element_id === comp.id) {
          if (!best || br.ik_ka > best.ik_ka) best = br;
        }
      }
    }
    return best;
  },

  _hasFaultBranchData(comp) {
    return this._findFaultBranch(comp) != null;
  },

  _appendFaultBranchLines(comp, lines) {
    const br = this._findFaultBranch(comp);
    if (!br || br.ik_ka <= 0) return;
    const faultColor = '#b71c1c';
    lines.push({text: '── FAULT ──', color: faultColor});
    lines.push({text: `If: ${br.ik_ka.toFixed(2)} kA`, color: faultColor});
    if (br.contribution_pct > 0) {
      lines.push({text: `(${br.contribution_pct.toFixed(1)}%)`, color: faultColor});
    }
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

    const pageComps = AppState.getActivePageComponents();
    let html = '';
    for (const branch of AppState.loadFlowResults.branches) {
      if (!branch.loading_pct || branch.loading_pct <= 100) continue;

      const comp = pageComps.get(branch.elementId);
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
        const comp = pageComps.get(busId);
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

  // Render load flow directional arrows on wires — visible when load flow results exist
  renderLoadFlowArrows() {
    if (!AppState.loadFlowResults) return;
    const branches = AppState.loadFlowResults.branches || [];
    if (branches.length === 0) return;

    const pageWires = AppState.getActivePageWires();
    let html = '';

    for (const [id, wire] of pageWires) {
      const fromComp = AppState.components.get(wire.fromComponent);
      const toComp = AppState.components.get(wire.toComponent);
      if (!fromComp || !toComp) continue;

      const isCableOrXfmr = t => t === 'cable' || t === 'transformer';
      let branch = null;
      let forward = true; // whether wire from→to aligns with branch from_bus→to_bus

      if (isCableOrXfmr(toComp.type)) {
        branch = branches.find(b => b.elementId === toComp.id);
        if (branch) {
          if (branch.from_bus === branch.to_bus) {
            // Source-connected element (e.g. utility incomer TX): from_bus===to_bus
            // Determine direction from topology: is fromComp the bus or the source?
            if (fromComp.id === branch.from_bus) {
              forward = false; // Wire goes bus→element; power injected toward bus = reverse
            } else {
              forward = true;  // Wire goes source→element; power flows same direction
            }
          } else if (branch.from_bus === fromComp.id) {
            forward = true;
          } else if (branch.to_bus === fromComp.id) {
            forward = false;
          }
        }
      } else if (isCableOrXfmr(fromComp.type)) {
        branch = branches.find(b => b.elementId === fromComp.id);
        if (branch) {
          if (branch.from_bus === branch.to_bus) {
            // Source-connected element: determine direction from topology
            if (toComp.id === branch.from_bus) {
              forward = true;  // Wire goes element→bus; power flows same direction
            } else {
              forward = false; // Wire goes element→source; power flows reverse
            }
          } else if (branch.to_bus === toComp.id) {
            forward = true;
          } else if (branch.from_bus === toComp.id) {
            forward = false;
          }
        }
      }

      if (!branch) continue;

      // Color by loading percentage (mirrors ETAP convention)
      let color = '#22c55e'; // green  < 80 %
      if (branch.loading_pct > 100) color = '#ef4444';       // red
      else if (branch.loading_pct > 80) color = '#f97316';   // amber

      // Flip arrow when real power flows opposite to the wire's natural direction
      const isForward = branch.p_mw >= 0 ? forward : !forward;

      html += this._buildArrowSvg(id, wire, fromComp, toComp, isForward, color, 'loadflow-arrow');
    }

    if (html) {
      this.annotationsLayer.insertAdjacentHTML('beforeend', html);
    }
  },

  // Render fault current directional arrows — visible only when a specific bus is faulted
  renderFaultFlowArrows() {
    if (!AppState.faultResults || !AppState.faultedBusId) return;
    const faultedBusId = AppState.faultedBusId;
    const busResult = AppState.faultResults.buses?.[faultedBusId];
    if (!busResult || !busResult.branches || busResult.branches.length === 0) return;

    const faultBranches = busResult.branches;
    const pageWires = AppState.getActivePageWires();
    let html = '';

    for (const [id, wire] of pageWires) {
      const fromComp = AppState.components.get(wire.fromComponent);
      const toComp = AppState.components.get(wire.toComponent);
      if (!fromComp || !toComp) continue;

      const isCableOrXfmr = t => t === 'cable' || t === 'transformer';
      let faultBranch = null;
      let forward = true;

      if (isCableOrXfmr(toComp.type)) {
        faultBranch = faultBranches.find(b => b.element_id === toComp.id);
        if (faultBranch) {
          if (faultBranch.from_bus === faultBranch.to_bus) {
            // Source-connected element: determine direction from topology
            if (fromComp.id === faultBranch.from_bus) {
              forward = false;
            } else {
              forward = true;
            }
          } else if (faultBranch.from_bus === fromComp.id) {
            forward = true;
          } else if (faultBranch.to_bus === fromComp.id) {
            forward = false;
          }
        }
      } else if (isCableOrXfmr(fromComp.type)) {
        faultBranch = faultBranches.find(b => b.element_id === fromComp.id);
        if (faultBranch) {
          if (faultBranch.from_bus === faultBranch.to_bus) {
            // Source-connected element: determine direction from topology
            if (toComp.id === faultBranch.from_bus) {
              forward = true;
            } else {
              forward = false;
            }
          } else if (faultBranch.to_bus === toComp.id) {
            forward = true;
          } else if (faultBranch.from_bus === toComp.id) {
            forward = false;
          }
        }
      }

      if (!faultBranch) continue;

      // Color by contribution percentage: red for major, amber for moderate, blue for minor
      let color = '#3b82f6'; // blue  < 20 %
      if (faultBranch.contribution_pct > 50) color = '#ef4444';       // red
      else if (faultBranch.contribution_pct > 20) color = '#f97316';  // amber

      // Arrow points toward the faulted bus (current flows into the fault)
      // Determine direction: does the wire lead toward or away from the faulted bus?
      let towardFault = forward;
      // If the to_bus of the fault branch is the faulted bus, forward means toward fault
      // If the from_bus is the faulted bus, forward means away from fault (reverse it)
      if (faultBranch.to_bus === faultedBusId) {
        towardFault = forward;
      } else if (faultBranch.from_bus === faultedBusId) {
        towardFault = !forward;
      }

      // Offset the arrow slightly from center to avoid overlapping with load flow arrows
      html += this._buildArrowSvg(id, wire, fromComp, toComp, towardFault, color, 'fault-arrow', 0.35);
    }

    if (html) {
      this.annotationsLayer.insertAdjacentHTML('beforeend', html);
    }
  },

  // Build SVG polygon for a directional arrow on a wire
  _buildArrowSvg(wireId, wire, fromComp, toComp, isForward, color, cssClass, pathFraction = 0.5) {
    const fromPos = Symbols.getPortWorldPosition(fromComp, wire.fromPort);
    const toPos   = Symbols.getPortWorldPosition(toComp,   wire.toPort);
    const pts = this._getWireActualPoints(wire, fromPos, toPos);

    const mid = this._calcPathPoint(pts, pathFraction);
    if (!mid) return '';

    const angle = isForward ? mid.angle : mid.angle + Math.PI;
    const s = 7; // half-size in SVG user units
    const c = Math.cos(angle), sn = Math.sin(angle);

    // Filled triangle: tip forward, two base corners behind
    const tx = mid.x + s * c,           ty = mid.y + s * sn;
    const lx = mid.x - s * 0.6 * c + s * 0.7 * sn, ly = mid.y - s * 0.6 * sn - s * 0.7 * c;
    const rx = mid.x - s * 0.6 * c - s * 0.7 * sn, ry = mid.y - s * 0.6 * sn + s * 0.7 * c;

    return `<polygon class="flow-arrow ${cssClass}" data-wire-id="${wireId}" ` +
           `points="${tx},${ty} ${lx},${ly} ${rx},${ry}" ` +
           `fill="${color}" stroke="#fff" stroke-width="0.5" style="pointer-events:none;opacity:0.92"/>`;
  },

  // Reconstruct the actual polyline points for a wire (expanding orthogonal L-segments)
  _getWireActualPoints(wire, fromPos, toPos) {
    const mode = wire.routeMode || AppState.wireRouteMode;
    const pts = [fromPos, ...(wire.bendPoints || []), toPos];

    if (mode === 'diagonal' || mode === 'spline') {
      return pts;
    }

    // Orthogonal routing: each control point creates an L-shaped corner
    if (wire.bendPoints && wire.bendPoints.length > 0) {
      const actual = [pts[0]];
      for (let i = 1; i < pts.length; i++) {
        actual.push({ x: pts[i].x, y: pts[i - 1].y });
        actual.push(pts[i]);
      }
      return actual;
    }

    // Default orthogonal (no bend points): from → (from.x, midY) → (to.x, midY) → to
    const midY = (fromPos.y + toPos.y) / 2;
    return [
      fromPos,
      { x: fromPos.x, y: midY },
      { x: toPos.x,   y: midY },
      toPos,
    ];
  },

  // Find a point at a given fraction (0–1) of a polyline's total length and the direction angle there
  _calcPathPoint(pts, fraction = 0.5) {
    if (pts.length < 2) return null;

    const segments = [];
    let totalLen = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const dx = pts[i + 1].x - pts[i].x;
      const dy = pts[i + 1].y - pts[i].y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len > 0) segments.push({ from: pts[i], to: pts[i + 1], len, angle: Math.atan2(dy, dx) });
      totalLen += len;
    }

    if (totalLen === 0 || segments.length === 0) return null;

    let target = totalLen * fraction;
    let accumulated = 0;
    for (const seg of segments) {
      if (accumulated + seg.len >= target) {
        const t = (target - accumulated) / seg.len;
        return {
          x: seg.from.x + t * (seg.to.x - seg.from.x),
          y: seg.from.y + t * (seg.to.y - seg.from.y),
          angle: seg.angle,
        };
      }
      accumulated += seg.len;
    }

    const last = segments[segments.length - 1];
    return { x: (last.from.x + last.to.x) / 2, y: (last.from.y + last.to.y) / 2, angle: last.angle };
  },

  // Find the point at 50% of a polyline's total length and the direction angle there
  _calcPathMidpoint(pts) {
    if (pts.length < 2) return null;

    const segments = [];
    let totalLen = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const dx = pts[i + 1].x - pts[i].x;
      const dy = pts[i + 1].y - pts[i].y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len > 0) segments.push({ from: pts[i], to: pts[i + 1], len, angle: Math.atan2(dy, dx) });
      totalLen += len;
    }

    if (totalLen === 0 || segments.length === 0) return null;

    let target = totalLen / 2;
    let accumulated = 0;
    for (const seg of segments) {
      if (accumulated + seg.len >= target) {
        const t = (target - accumulated) / seg.len;
        return {
          x: seg.from.x + t * (seg.to.x - seg.from.x),
          y: seg.from.y + t * (seg.to.y - seg.from.y),
          angle: seg.angle,
        };
      }
      accumulated += seg.len;
    }

    const last = segments[segments.length - 1];
    return { x: (last.from.x + last.to.x) / 2, y: (last.from.y + last.to.y) / 2, angle: last.angle };
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
      const ports = (comp.type === 'bus') ? Symbols.getBusPorts(comp) : def.ports;
      for (const port of ports) {
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

  // Point-to-segment distance for bend point insertion
  _ptSegDist(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
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
