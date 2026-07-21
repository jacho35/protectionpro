/* ProtectionPro — SVG Canvas: Pan, Zoom, Rendering */

// Multiplicative zoom step — one tick is ~10% at any scale
const ZOOM_FACTOR = 1.1;

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

  // Touch long-press promotion for label dragging. Labels are mouse-only drag
  // targets; on touch a press-and-hold promotes to a label drag (see onMouseDown).
  _labelPress: null,      // { kind:'data'|'name', compId, sx, sy, wx, wy }
  _labelPressTimer: null, // setTimeout handle

  // State for bus resize drag
  busResize: null, // { compId, side, startX, origWidth }

  // State for dragging annotation badges
  annotationDrag: null, // { key, startX, startY, origDX, origDY }

  // State for dragging wire bend points
  bendDrag: null, // { wireId, bendIndex, startX, startY }
  wireSegDrag: null, // { wireId, grabOffset, moved } — dragging a wire's mid-run

  // Space-bar held down → left-drag pans the canvas
  spaceDown: false,

  // Touch state (the whole canvas runs on Pointer Events, one pipeline for
  // mouse and touch — no synthetic-event forwarding)
  touchPointers: new Map(), // pointerId → { x, y } for touches active on the canvas
  _pinch: null,             // { d, cx, cy } while two fingers are down
  _touchTap: null,          // { x, y } single touch on empty canvas, cleared on movement

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
    // Pointer Events drive everything — the same handlers receive mouse,
    // touch and pen input (PointerEvent extends MouseEvent, so clientX,
    // button, shiftKey and target.closest all behave identically). Touch
    // gestures (pan / pinch / tap-deselect) are routed at the top of each
    // handler; single-finger interaction with entities reuses the exact
    // desktop select/drag/wire code below.
    this.svg.addEventListener('pointerdown', (e) => this.onMouseDown(e));
    // Move/up are bound at document level so drags don't get "stuck" when the
    // pointer leaves the SVG before the button is released.
    document.addEventListener('pointermove', (e) => this.onMouseMove(e));
    document.addEventListener('pointerup', (e) => this.onMouseUp(e));
    document.addEventListener('pointercancel', (e) => this.onMouseUp(e));
    this.svg.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    // Right-click: context-sensitive menu (component / wire / canvas)
    this.svg.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (typeof ContextMenu === 'undefined') return;
      // No menu mid-gesture (wire drawing, drags, marquee)
      if (AppState.wireStart || AppState.dragState || this.busResize ||
          this.bendDrag || this.isSelecting || this.isPanning) return;

      const worldPt = this.screenToWorld(e.clientX, e.clientY);

      // Result box (draggable analysis badge) — its own menu (copy/reset/hide).
      const annotEl = e.target.closest('.draggable-annotation');
      if (annotEl && annotEl.dataset.annotationKey) {
        ContextMenu.openForResultBox(annotEl.dataset.annotationKey, e.clientX, e.clientY);
        return;
      }

      const compEl = e.target.closest('.sld-component');
      if (compEl) {
        const id = compEl.dataset.id;
        const comp = AppState.components.get(id);
        if (!comp) return;
        // Act on what's under the cursor: select it unless it's already
        // part of the current (possibly multi-) selection
        if (!AppState.selectedIds.has(id)) {
          AppState.select(id);
          if (comp.groupId) AppState.selectGroup(comp.groupId);
          this.render();
          Properties.show(id);
        }
        ContextMenu.openForComponent(comp, e.clientX, e.clientY);
        return;
      }

      const wireEl = e.target.closest('.sld-wire');
      if (wireEl) {
        const wire = AppState.wires.get(wireEl.dataset.id);
        if (!wire) return;
        if (!AppState.selectedIds.has(wire.id)) {
          AppState.select(wire.id);
          this.render();
        }
        ContextMenu.openForWire(wire, worldPt, e.clientX, e.clientY);
        return;
      }

      ContextMenu.openForCanvas(worldPt, e.clientX, e.clientY);
    });

    // Space-hold + left-drag panning
    document.addEventListener('keydown', (e) => {
      if (e.code !== 'Space' || this.spaceDown) return;
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
      this.spaceDown = true;
      this.svg.classList.add('space-pan');
      if (e.target === document.body) e.preventDefault(); // stop page scroll
    });
    document.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this.spaceDown = false;
        this.svg.classList.remove('space-pan');
      }
    });
    window.addEventListener('blur', () => {
      this.spaceDown = false;
      this.svg.classList.remove('space-pan');
    });

    // Hover highlighting: link annotation boxes to their bus components
    this.svg.addEventListener('mouseover', (e) => {
      const annot = e.target.closest('.annotation-group[data-bus-id]');
      if (annot) {
        const busId = annot.dataset.busId;
        const busEl = this.componentsLayer.querySelector(`.sld-component[data-id="${busId}"]`);
        if (busEl) busEl.classList.add('highlight-linked');
        this.svg.querySelectorAll(`.annotation-group[data-bus-id="${busId}"]`).forEach(el => el.classList.add('highlight-linked'));
        return;
      }
      const comp = e.target.closest('.sld-component');
      if (comp) {
        const compId = comp.dataset.id;
        this.svg.querySelectorAll(`.annotation-group[data-bus-id="${compId}"]`).forEach(el => el.classList.add('highlight-linked'));
        if (this.svg.querySelectorAll(`.annotation-group[data-bus-id="${compId}"]`).length > 0) {
          comp.classList.add('highlight-linked');
        }
      }
    });
    this.svg.addEventListener('mouseout', (e) => {
      const annot = e.target.closest('.annotation-group[data-bus-id]');
      const comp = e.target.closest('.sld-component');
      if (annot || comp) {
        this.svg.querySelectorAll('.highlight-linked').forEach(el => el.classList.remove('highlight-linked'));
      }
    });

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
        this.addWireBendPoint(wireEl.dataset.id, worldPt);
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

  // Pointer down handler (mouse and touch)
  onMouseDown(e) {
    if (e.pointerType === 'touch') {
      // Suppress the browser's compatibility mouse events for canvas touches
      e.preventDefault();
      this.touchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      // Route the whole gesture to the svg (never detached), not the touched
      // child node — a mid-drag render() would otherwise strand the pointer's
      // implicit capture on a removed element.
      try { this.svg.setPointerCapture(e.pointerId); } catch (_) {}
      if (this.touchPointers.size === 2) {
        // Second finger: commit whatever the first finger was doing (drag,
        // pan, wire) and switch to pinch-zoom
        this._finalizeInteraction(e);
        this._touchTap = null;
        this._pinch = this._pinchFrom();
        return;
      }
      if (this.touchPointers.size > 2) return; // ignore extra fingers
    }

    const worldPt = this.screenToWorld(e.clientX, e.clientY);

    // Middle button, Alt+left or Space+left: start panning
    if (e.button === 1 || (e.button === 0 && (e.altKey || this.spaceDown))) {
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

    // Check if clicked on a data label (for dragging). Label nudging is a
    // precision affordance — with a finger, a plain touch on a label (they
    // overlap their component and sit too small to tap precisely) must not
    // hijack the gesture, so on touch a press-and-hold promotes to a label
    // drag while a quick touch/drag falls through to pan/deselect.
    const labelEl = e.target.closest('.comp-data-label');
    if (labelEl && e.pointerType === 'touch') {
      this._armLabelLongPress('data', labelEl, e, worldPt);
      this._startTouchPan(e);
      this._touchTap = { x: e.clientX, y: e.clientY };
      return;
    }
    if (labelEl) {
      const compId = labelEl.dataset.compId;
      const comp = AppState.components.get(compId);
      if (comp) {
        const isLoad = ['static_load', 'motor_induction', 'motor_synchronous', 'distribution_board'].includes(comp.type);
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

    // Check if clicked on a name label (for dragging) — long-press on touch, as above
    const nameLabelEl = e.target.closest('.comp-name-label');
    if (nameLabelEl && e.pointerType === 'touch') {
      this._armLabelLongPress('name', nameLabelEl, e, worldPt);
      this._startTouchPan(e);
      this._touchTap = { x: e.clientX, y: e.clientY };
      return;
    }
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
          // Capture each attached wire's endpoint WORLD position so the
          // resize drag can keep connections where they are on the canvas
          const attachments = [];
          for (const wire of AppState.wires.values()) {
            const key = wire.fromComponent === compId ? 'fromPort'
              : (wire.toComponent === compId ? 'toPort' : null);
            if (!key) continue;
            attachments.push({
              wire, key,
              world: Symbols.getPortWorldPosition(comp, wire[key]),
            });
          }
          this.busResize = {
            compId,
            side,
            startX: worldPt.x,
            origWidth: comp.props.busWidth || 120,
            origCompX: comp.x,
            attachments,
          };
          e.preventDefault();
          return;
        }
      }
    }

    // Check if clicked on a component port (for wiring). Fingers are
    // imprecise: on touch in Select mode a port hit acts on its component
    // (falls through to the component branch below) instead of silently
    // starting a wire — use Wire mode to draw from ports by touch.
    const portEl = e.target.closest('[data-port]');
    if (portEl && AppState.mode === MODE.SELECT && e.pointerType !== 'touch') {
      // Start wiring from this port. Give explicit feedback since we're
      // starting a wire outside Wire mode — otherwise it looks like nothing
      // happened (or a drag) to the user.
      const compEl = portEl.closest('.sld-component');
      const compId = compEl.dataset.id;
      const portId = portEl.dataset.port;
      this.svg.classList.add('wiring');
      document.getElementById('status-info').textContent =
        'Wiring from port — click a target port to connect, or press Esc to cancel.';
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
        } else if (e.pointerType === 'touch') {
          this._startTouchPan(e);
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
        // Grabbing the horizontal mid-run of a default-routed wire starts
        // a segment drag: move it up/down to reroute the corridor.
        const seg = this._hitWireMidSegment(id, worldPt);
        if (seg) {
          this.wireSegDrag = { wireId: id, grabOffset: worldPt.y - seg.midY, moved: false };
          e.preventDefault();
        }
      }
      this.render();
      return;
    }

    // Touch on empty canvas: pan (marquee selection needs a mouse). If the
    // finger lifts without moving it was a tap — deselect on pointer-up.
    if (e.pointerType === 'touch') {
      this._startTouchPan(e);
      this._touchTap = { x: e.clientX, y: e.clientY };
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

  // Pointer move handler (mouse and touch)
  onMouseMove(e) {
    if (e.pointerType === 'touch') {
      // Only track touches that started on the canvas
      if (!this.touchPointers.has(e.pointerId)) return;
      this.touchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this._pinch) { this._pinchMove(); return; }
      if (this._touchTap &&
          Math.hypot(e.clientX - this._touchTap.x, e.clientY - this._touchTap.y) > 10) {
        this._touchTap = null; // moved too far — it's a pan, not a tap
      }
      // Moving before the hold fires means the user is panning, not grabbing
      // the label — cancel the pending long-press.
      if (this._labelPress &&
          Math.hypot(e.clientX - this._labelPress.sx, e.clientY - this._labelPress.sy) > 10) {
        this._clearLabelLongPress();
      }
    }

    // Safety net: if the button was released outside the window (we never saw
    // mouseup), finalize any active drag instead of leaving it sticky.
    const interacting = this.isPanning || this.busResize || this.bendDrag ||
        this.wireSegDrag || this.annotationDrag || this.labelDrag ||
        this.nameLabelDrag || AppState.dragState || this.isSelecting ||
        AppState.wireStart;

    if (e.buttons === 0 && interacting && !AppState.wireStart) {
      this.onMouseUp(e);
      return;
    }

    // Fast idle path: with no active interaction, only hover detection runs —
    // and that needs no world coordinates. Skipping screenToWorld here avoids a
    // forced layout (getBoundingClientRect) on every pointer move anywhere in
    // the document (the move/up listeners are bound at document level).
    if (!interacting) {
      const hoverEl = e.target.closest('.sld-component');
      AppState.hoveredId = hoverEl ? hoverEl.dataset.id : null;
      // Cursor affordance for wire mid-run dragging. Set on the wire path
      // itself (its stylesheet cursor:pointer outranks an svg-level style);
      // only computes world coordinates while actually over a wire.
      const wireHover = !hoverEl && AppState.mode === MODE.SELECT
        ? e.target.closest('.sld-wire') : null;
      if (this._wireCursorEl && this._wireCursorEl !== wireHover) {
        this._wireCursorEl.style.cursor = '';
        this._wireCursorEl = null;
      }
      if (wireHover) {
        const pt = this.screenToWorld(e.clientX, e.clientY);
        const onSeg = this._hitWireMidSegment(wireHover.dataset.id, pt);
        wireHover.style.cursor = onSeg ? 'ns-resize' : '';
        this._wireCursorEl = onSeg ? wireHover : null;
      }
      return;
    }

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
        // Anchor the FIXED edge exactly: the centre is derived from that edge
        // and the snapped new width. (Snapping the centre to the grid shifted
        // the opposite edge by half a grid on odd-grid width changes.)
        if (this.busResize.side === 'right') {
          // Extend right: the LEFT edge stays put
          const fixedLeft = this.busResize.origCompX - this.busResize.origWidth / 2;
          const newWidth = snapToGrid(Math.max(60, this.busResize.origWidth + dx));
          comp.props.busWidth = newWidth;
          comp.x = fixedLeft + newWidth / 2;
        } else {
          // Extend left: the RIGHT edge stays put
          const fixedRight = this.busResize.origCompX + this.busResize.origWidth / 2;
          const newWidth = snapToGrid(Math.max(60, this.busResize.origWidth - dx));
          comp.props.busWidth = newWidth;
          comp.x = fixedRight - newWidth / 2;
        }
        // Keep every attachment at its original WORLD position: rewrite the
        // bus-side port to 'at_<x>' relative to the moved centre (clamped to
        // the new extent). Also migrates legacy top_i/bottom_i ids in place.
        const hw = comp.props.busWidth / 2;
        const rot = -(comp.rotation || 0) * Math.PI / 180;
        for (const att of (this.busResize.attachments || [])) {
          const wx = att.world.x - comp.x;
          const wy = att.world.y - comp.y;
          const lx = wx * Math.cos(rot) - wy * Math.sin(rot);
          att.wire[att.key] = `at_${Math.round(Math.max(-hw, Math.min(hw, lx)))}`;
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

    // Dragging a wire's horizontal mid-segment: reroute its corridor.
    // Snap to half-grid so wires can run between component rows.
    if (this.wireSegDrag) {
      const wire = AppState.wires.get(this.wireSegDrag.wireId);
      if (wire) {
        wire.midY = Math.round((worldPt.y - this.wireSegDrag.grabOffset) / 10) * 10;
        this.wireSegDrag.moved = true;
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
      this._updateSnapHighlight(snap);
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

  // Pointer up / cancel handler (mouse and touch)
  onMouseUp(e) {
    // Finger lifted (or gesture cancelled) — a pending hold never completes.
    this._clearLabelLongPress();
    if (e.pointerType === 'touch') {
      if (!this.touchPointers.delete(e.pointerId)) return;
      if (this._pinch) {
        if (this.touchPointers.size >= 2) return;
        this._pinch = null;
        if (this.touchPointers.size === 1) {
          // One finger stays down: continue the gesture as a pan from here
          const p = [...this.touchPointers.values()][0];
          this.isPanning = true;
          this.panStart = { x: p.x - AppState.panX, y: p.y - AppState.panY };
          return;
        }
        // Both lifted — nothing left to finalize (pinch committed live)
        return;
      }
      if (this._touchTap) {
        // Stationary tap on empty canvas: deselect (the touch counterpart of
        // clicking empty canvas with a mouse)
        this._touchTap = null;
        this.isPanning = false;
        this.svg.classList.remove('panning-active');
        AppState.clearSelection();
        Properties.clear();
        this.render();
        return;
      }
    }
    this._finalizeInteraction(e);
  },

  // Commit / tear down whatever interaction is in flight. Shared by pointer-up
  // and by a second touch landing mid-gesture (drag commits, pinch begins).
  _finalizeInteraction(e) {
    this._clearLabelLongPress();
    if (this.isPanning) {
      this.isPanning = false;
      this.svg.classList.remove('panning-active');
      return;
    }

    if (this.busResize) {
      // If the bus size actually changed, stale results no longer match the
      // diagram — run the same commit ritual as a property edit.
      const comp = AppState.components.get(this.busResize.compId);
      if (comp && (comp.props.busWidth || 120) !== this.busResize.origWidth) {
        AppState.invalidateResults();
      }
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

    if (this.wireSegDrag) {
      if (this.wireSegDrag.moved) {
        AppState.dirty = true;
        if (typeof UndoManager !== 'undefined') UndoManager.snapshot();
      }
      this.wireSegDrag = null;
      return;
    }

    if (this.annotationDrag) {
      AppState.dirty = true;
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

  // Mouse wheel: zoom (multiplicative steps so each tick feels consistent)
  onWheel(e) {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 1 / ZOOM_FACTOR : ZOOM_FACTOR;
    const rect = this.svg.getBoundingClientRect();
    this.zoomAt(factor, e.clientX - rect.left, e.clientY - rect.top);
  },

  // ─── Touch gesture helpers ────────────────────────────────────────────────

  _startTouchPan(e) {
    this.isPanning = true;
    this.panStart = { x: e.clientX - AppState.panX, y: e.clientY - AppState.panY };
  },

  // Arm a long-press so a stationary hold on a label promotes to a label drag.
  _armLabelLongPress(kind, el, e, worldPt) {
    const compId = el.dataset.compId;
    if (!AppState.components.get(compId)) return;
    this._clearLabelLongPress();
    this._labelPress = { kind, compId, sx: e.clientX, sy: e.clientY, wx: worldPt.x, wy: worldPt.y };
    this._labelPressTimer = setTimeout(() => this._promoteLabelLongPress(), 450);
  },

  // Fired when a label hold completes: abandon the pan/tap the touch had begun
  // and hand the gesture over to the label (or name-label) drag machinery.
  _promoteLabelLongPress() {
    this._labelPressTimer = null;
    const p = this._labelPress;
    this._labelPress = null;
    if (!p) return;
    const comp = AppState.components.get(p.compId);
    if (!comp) return;
    // Cancel the pan/tap the touch started before the hold completed.
    this.isPanning = false;
    this.svg.classList.remove('panning-active');
    this._touchTap = null;
    if (p.kind === 'data') {
      const isLoad = ['static_load', 'motor_induction', 'motor_synchronous', 'distribution_board'].includes(comp.type);
      this.labelDrag = {
        compId: p.compId,
        startX: p.wx,
        startY: p.wy,
        origOX: comp.labelOffsetX != null ? comp.labelOffsetX : 22,
        origOY: comp.labelOffsetY != null ? comp.labelOffsetY : (isLoad ? 30 : 0),
      };
    } else {
      this.nameLabelDrag = {
        compId: p.compId,
        startX: p.wx,
        startY: p.wy,
        origOX: comp.nameLabelOffsetX || 0,
        origOY: comp.nameLabelOffsetY || 0,
      };
    }
    // Haptic cue that the label is now grabbed (where supported).
    if (navigator.vibrate) navigator.vibrate(15);
  },

  _clearLabelLongPress() {
    if (this._labelPressTimer) {
      clearTimeout(this._labelPressTimer);
      this._labelPressTimer = null;
    }
    this._labelPress = null;
  },

  _pinchFrom() {
    const [a, b] = [...this.touchPointers.values()];
    return {
      d: Math.hypot(a.x - b.x, a.y - b.y),
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
    };
  },

  _pinchMove() {
    if (this.touchPointers.size < 2) return;
    const p = this._pinchFrom();
    if (this._pinch.d > 0 && p.d > 0) {
      const rect = this.svg.getBoundingClientRect();
      this.zoomAt(p.d / this._pinch.d, p.cx - rect.left, p.cy - rect.top);
    }
    // Two-finger pan: follow the midpoint
    AppState.panX += p.cx - this._pinch.cx;
    AppState.panY += p.cy - this._pinch.cy;
    this.updateTransform();
    this._pinch = p;
  },

  // Zoom by a factor toward a point in SVG-local screen coords
  zoomAt(factor, mx, my) {
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, AppState.zoom * factor));
    const scale = newZoom / AppState.zoom;
    AppState.panX = mx - scale * (mx - AppState.panX);
    AppState.panY = my - scale * (my - AppState.panY);
    AppState.zoom = newZoom;
    this.updateTransform();
  },

  // Keyboard zoom — zooms about the canvas center
  zoomIn() {
    const rect = this.svg.getBoundingClientRect();
    this.zoomAt(ZOOM_FACTOR, rect.width / 2, rect.height / 2);
  },

  zoomOut() {
    const rect = this.svg.getBoundingClientRect();
    this.zoomAt(1 / ZOOM_FACTOR, rect.width / 2, rect.height / 2);
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

    // Select components whose bounding box overlaps the marquee (visible sheet only)
    const pageComps = AppState.getActivePageComponents();
    for (const [id, comp] of pageComps) {
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

    // Select wires whose any segment intersects the marquee (visible sheet only)
    for (const [id, wire] of AppState.wires) {
      const fromComp = pageComps.get(wire.fromComponent);
      const toComp = pageComps.get(wire.toComponent);
      if (!fromComp || !toComp) continue;
      const from = Symbols.getPortWorldPosition(fromComp, wire.fromPort);
      const to = Symbols.getPortWorldPosition(toComp, wire.toPort);
      const midY = this.wireMidY(id, from, to);
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

  // If worldPt lies on the draggable horizontal mid-run of a default-routed
  // wire, return {midY}; else null. Bend-point and diagonal wires are edited
  // via their handles instead.
  _hitWireMidSegment(wireId, worldPt) {
    const wire = AppState.wires.get(wireId);
    if (!wire || (wire.bendPoints && wire.bendPoints.length)) return null;
    const mode = wire.routeMode || AppState.wireRouteMode || 'orthogonal';
    if (mode === 'diagonal') return null;
    const fromComp = AppState.components.get(wire.fromComponent);
    const toComp = AppState.components.get(wire.toComponent);
    if (!fromComp || !toComp) return null;
    const from = Symbols.getPortWorldPosition(fromComp, wire.fromPort);
    const to = Symbols.getPortWorldPosition(toComp, wire.toPort);
    if (Math.abs(from.x - to.x) < 1) return null; // straight vertical
    const midY = this.wireMidY(wireId, from, to);
    const minX = Math.min(from.x, to.x) - 5;
    const maxX = Math.max(from.x, to.x) + 5;
    if (Math.abs(worldPt.y - midY) <= 8 && worldPt.x >= minX && worldPt.x <= maxX) {
      return { midY };
    }
    return null;
  },

  // Effective mid-corridor Y for a default-routed wire: an explicit
  // user-dragged wire.midY wins, else the geometric midpoint plus the
  // auto lane-separation offset (so parallel wires don't overlap).
  wireMidY(wireId, from, to) {
    const wire = AppState.wires.get(wireId);
    if (wire && typeof wire.midY === 'number') return wire.midY;
    const off = this._wireLanes ? (this._wireLanes.get(wireId) || 0) : 0;
    return (from.y + to.y) / 2 + off;
  },

  // Assign lane offsets to default-routed wires whose horizontal runs
  // share a corridor (same 20 px midY bucket, overlapping x-spans).
  // Lanes fan out around the corridor: 0, +10, −10, +20, −20 …
  _computeWireLanes(pageWires) {
    const lanes = new Map();
    const buckets = new Map();
    for (const [id, wire] of pageWires) {
      if (typeof wire.midY === 'number') continue;
      if (wire.bendPoints && wire.bendPoints.length) continue;
      const mode = wire.routeMode || AppState.wireRouteMode || 'orthogonal';
      if (mode === 'diagonal') continue;
      const fromComp = AppState.components.get(wire.fromComponent);
      const toComp = AppState.components.get(wire.toComponent);
      if (!fromComp || !toComp) continue;
      const from = Symbols.getPortWorldPosition(fromComp, wire.fromPort);
      const to = Symbols.getPortWorldPosition(toComp, wire.toPort);
      if (Math.abs(from.x - to.x) < 1) continue; // straight vertical, no corridor
      const key = Math.round((from.y + to.y) / 2 / 20);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push({
        id, minX: Math.min(from.x, to.x), maxX: Math.max(from.x, to.x),
      });
    }
    for (const group of buckets.values()) {
      if (group.length < 2) continue;
      group.sort((a, b) => a.minX - b.minX || (a.id < b.id ? -1 : 1));
      const placed = [];
      for (const item of group) {
        let lane = 0;
        while (placed.some(p => p.lane === lane && p.maxX > item.minX && p.minX < item.maxX)) lane++;
        placed.push({ ...item, lane });
        if (lane > 0) {
          lanes.set(item.id, (lane % 2 ? 1 : -1) * Math.ceil(lane / 2) * 10);
        }
      }
    }
    return lanes;
  },

  // Full re-render of all components and wires
  render() {
    // Get page-filtered components and wires
    const pageComps = AppState.getActivePageComponents();
    const pageWires = AppState.getActivePageWires();
    this._wireLanes = this._computeWireLanes(pageWires);

    // Empty-state hint: show only when the project has no components at all
    const emptyHint = document.getElementById('canvas-empty-hint');
    if (emptyHint) emptyHint.style.display = AppState.components.size === 0 ? '' : 'none';

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
          const midY = this.wireMidY(id, from, to);
          path = `M${from.x},${from.y} C${from.x},${midY} ${to.x},${midY} ${to.x},${to.y}`;
        } else {
          // Default orthogonal routing (draggable mid-corridor)
          const midY = this.wireMidY(id, from, to);
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
      compsHtml += `<text class="sld-group-label" x="${bounds.x + 4}" y="${bounds.y - 3}" font-size="10" fill="#6a1b9a">${escHtml(group.name)}</text>`;
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
        if (p.construction === 'overhead') {
          if (p.overhead_type && typeof STANDARD_OVERHEAD_LINES !== 'undefined') {
            const std = STANDARD_OVERHEAD_LINES.find(c => c.id === p.overhead_type);
            if (std) sizeStr = `${std.size_mm2}mm² ${std.material}`;
          }
        } else if (p.standard_type) {
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
            if (branch.losses_mw > 0) lines.push({text: `Loss: ${this._fmtLossLine(branch.losses_mw)}`, color: loadColor});
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
            const qStr = Math.abs(branch.q_mvar) >= 1 ? `${branch.q_mvar.toFixed(2)} MVAr` : `${(branch.q_mvar * 1000).toFixed(1)} kVAr`;
            lines.push({text: '───────', color: loadColor});
            lines.push({text: `P: ${pStr}`, color: loadColor});
            lines.push({text: `Q: ${qStr}`, color: loadColor});
            if (branch.i_amps > 0) lines.push({text: `I: ${branch.i_amps.toFixed(1)} A`, color: loadColor});
            if (branch.loading_pct > 0) lines.push({text: `Load: ${branch.loading_pct.toFixed(1)}%`, color: loadColor});
            if (branch.losses_mw > 0) lines.push({text: `Loss: ${this._fmtLossLine(branch.losses_mw)}`, color: loadColor});
          }
        }
        // Show fault branch contributions on transformer
        if (AppState.showResultBoxes.fault) this._appendFaultBranchLines(comp, lines);
      } else if (['generator', 'solar_pv', 'wind_turbine', 'battery'].includes(comp.type)) {
        // Static property labels
        if (comp.type === 'generator') {
          const ratingStr = p.rated_mva >= 1 ? `${p.rated_mva} MVA` : `${(p.rated_mva * 1000).toFixed(0)} kVA`;
          lines.push(ratingStr);
          if (p.voltage_kv) lines.push(`${p.voltage_kv} kV`);
          if (p.power_factor) lines.push(`PF ${p.power_factor}`);
        } else if (comp.type === 'solar_pv') {
          // Rating line shows the TOTAL plant size (rated kW × inverters)
          const nInv = Math.max(1, p.num_inverters || 1);
          const totalKw = (p.rated_kw || 0) * nInv;
          const fmtKw = (kw) => kw >= 1000 ? `${(kw / 1000).toFixed(1)} MW` : `${kw.toFixed(0)} kW`;
          lines.push(nInv > 1 ? `${nInv}×${fmtKw(p.rated_kw || 0)} = ${fmtKw(totalKw)}` : fmtKw(totalKw));
          const irr = p.irradiance_pct ?? 100;
          if (p.pv_array_mode === 'array') {
            // Array line: strings × panels = DC kWp; output clips at the inverter
            const strings = Math.max(1, Math.round(p.pv_strings || 1));
            const pps = Math.max(1, Math.round(p.pv_panels_per_string || 1));
            const dcKw = (p.pv_panel_w || 0) * pps * strings * nInv / 1000;
            lines.push(`${strings}S×${pps}P = ${dcKw >= 1000 ? (dcKw / 1000).toFixed(2) + ' MWp' : dcKw.toFixed(1) + ' kWp'}`);
            const rawKw = dcKw * irr / 100;
            const outKw = Math.min(rawKw, totalKw);
            if (irr < 100 || rawKw > totalKw) {
              lines.push(`@ ${irr}% → ${fmtKw(outKw)}${rawKw > totalKw ? ' (clipped)' : ''}`);
            }
          } else if (irr < 100) {
            // Show the availability-scaled output when below full irradiance
            lines.push(`@ ${irr}% → ${fmtKw(totalKw * irr / 100)}`);
          }
          if (p.voltage_kv) lines.push(`${p.voltage_kv} kV`);
        } else if (comp.type === 'wind_turbine') {
          const nTurb = Math.max(1, p.num_turbines || 1);
          const totalMva = (p.rated_mva || 0) * nTurb;
          const fmtMva = (mva) => mva >= 1 ? `${mva.toFixed(1)} MVA` : `${(mva * 1000).toFixed(0)} kVA`;
          lines.push(nTurb > 1 ? `${nTurb}×${fmtMva(p.rated_mva || 0)} = ${fmtMva(totalMva)}` : fmtMva(totalMva));
          const windPct = p.wind_speed_pct ?? 100;
          if (windPct < 100) lines.push(`@ ${windPct}% → ${fmtMva(totalMva * windPct / 100)}`);
          if (p.voltage_kv) lines.push(`${p.voltage_kv} kV`);
        } else if (comp.type === 'battery') {
          const kva = p.rated_kva || 0;
          lines.push(kva >= 1000 ? `${(kva / 1000).toFixed(1)} MVA` : `${kva.toFixed(0)} kVA`);
          const kwh = p.battery_kwh || 0;
          if (kwh > 0) lines.push(kwh >= 1000 ? `${(kwh / 1000).toFixed(1)} MWh` : `${kwh.toFixed(0)} kWh`);
          lines.push(`${p.battery_mode || 'auto'}`);
          if (p.voltage_kv) lines.push(`${p.voltage_kv} kV`);
        }
        // Show load flow output annotation for source components
        if (AppState.showResultBoxes.loadflow && AppState.loadFlowResults && AppState.loadFlowResults.branches) {
          const branch = AppState.loadFlowResults.branches.find(b => b.elementId === comp.id);
          if (branch && branch.s_mva > 0) {
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
        defaultOY = 32;
      } else if (comp.type === 'static_load') {
        if (p.name && p.name !== 'Load') lines.push(p.name);
        lines.push(`${p.rated_kva || 0} kVA`);
        lines.push(`PF ${p.power_factor || 0.85}`);
        defaultOY = 30;
      } else if (comp.type === 'distribution_board') {
        if (p.name && p.name !== 'DB') lines.push(p.name);
        const ways = (p.circuits || []).length;
        const demand = (p.rated_kva || 0) * (p.demand_factor || 1);
        lines.push(`${ways} way${ways === 1 ? '' : 's'}`);
        lines.push(`${demand.toFixed(1)} kVA demand`);
        defaultOY = 32;
      } else if (comp.type === 'dc_battery') {
        lines.push(`${p.nominal_v || 0} Vdc`);
        if (p.ah_capacity) lines.push(`${p.ah_capacity} Ah`);
        lines.push(`Ri ${p.internal_r_mohm || 0} mΩ`);
        this._appendDCLoadFlowSourceLines(comp, lines);
        defaultOY = 30;
      } else if (comp.type === 'dc_load') {
        const model = p.load_model || 'constant_power';
        if (model === 'constant_current') lines.push(`${p.load_a || 0} A`);
        else if (model === 'constant_resistance') lines.push(`${p.resistance_ohm || 0} Ω`);
        else lines.push(`${p.load_kw || 0} kW`);
        defaultOY = 26;
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
        // Trip currents in brackets (Ir = In × thermal, Im = Ir × magnetic)
        const irA = tripA * thPu;
        const imA = irA * magPu;
        const fmtA = (a) => a >= 1000 ? `${(a / 1000).toFixed(1)}kA` : `${a.toFixed(0)}A`;
        lines.push(`Ir=${thPu}× (${fmtA(irA)})`);
        lines.push(`Im=${magPu}× (${fmtA(imA)})`);
        if (cbType === 'ACB' && p.short_time_pickup) {
          lines.push(`ST=${p.short_time_pickup}×`);
        }
        // Integral earth-fault (residual) release — pickup is a PRIMARY current
        const efA = parseFloat(p.ef_pickup_a) || 0;
        if (efA > 0) {
          let efLine = `E/F ${fmtA(efA)}`;
          const efCt = p.ef_trip_ct ? AppState.getActivePageComponents().get(p.ef_trip_ct) : null;
          if (efCt && typeof parseCTRatio === 'function') {
            const ct = parseCTRatio(efCt.props?.ratio);
            if (ct.ratio > 0) efLine += ` (${(efA / ct.ratio).toFixed(2)} A sec)`;
          }
          lines.push(efLine);
        }
        if (AppState.showResultBoxes.fault) this._appendFaultBranchLines(comp, lines);
      } else if (comp.type === 'fuse' && AppState.showDeviceLabels) {
        const fuseType = p.fuse_type || 'gG';
        const ratedA = p.rated_current_a || 100;
        lines.push(`${fuseType} ${ratedA}A`);
        if (p.rated_voltage_kv) lines.push(`${p.rated_voltage_kv} kV`);
        if (p.breaking_capacity_ka) lines.push(`Icu ${p.breaking_capacity_ka}kA`);
        if (AppState.showResultBoxes.fault) this._appendFaultBranchLines(comp, lines);
      } else if (comp.type === 'ct') {
        if (p.name && p.name !== 'CT') lines.push(p.name);
        if (p.ratio) lines.push(`${p.ratio} A`);
        if (p.accuracy_class) lines.push(p.accuracy_class);
        if (p.burden_va) lines.push(`${p.burden_va} VA`);
        if (p.ct_type === 'core_balance') lines.push('Core balance');
        defaultOX = 18;
        defaultOY = 0;
      } else if (comp.type === 'pt') {
        if (p.name && p.name !== 'PT') lines.push(p.name);
        if (p.ratio) lines.push(`${p.ratio}`);
        if (p.accuracy_class) lines.push(p.accuracy_class);
        if (p.burden_va) lines.push(`${p.burden_va} VA`);
        defaultOX = 18;
        defaultOY = 0;
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
        return `<tspan x="${x}" dy="${i === 0 ? 0 : 12}"${fill}>${escHtml(text)}</tspan>`;
      }).join('');
      html += `<text class="comp-data-label" data-comp-id="${comp.id}" x="${x}" y="${y}" font-size="9" font-family="var(--font-mono)" cursor="move">${lineHtml}</text>`;
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

  // Element's own series loss (sending-end minus receiving-end power) for the
  // load-flow data label. Losses are usually well under a megawatt, so kW gets
  // two decimals (backend resolution is 0.1 kW).
  _fmtLossLine(lossMw) {
    return lossMw >= 1 ? `${lossMw.toFixed(3)} MW` : `${(lossMw * 1000).toFixed(2)} kW`;
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

  _appendDCLoadFlowSourceLines(comp, lines) {
    if (!AppState.showResultBoxes.dcLoadflow || !AppState.dcLoadFlowResults) return;
    const src = (AppState.dcLoadFlowResults.sources || []).find(s => s.source_id === comp.id);
    if (!src) return;
    const c = src.current_limited ? '#d32f2f' : (src.loading_pct > 80 ? '#f57c00' : '#2e7d32');
    lines.push({text: '───────', color: c});
    lines.push({text: `${src.voltage_v.toFixed(1)} V`, color: c});
    lines.push({text: `${src.current_a.toFixed(1)} A`, color: c});
    if (src.loading_pct > 0) lines.push({text: `Load: ${src.loading_pct.toFixed(0)}%`, color: c});
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
      // A distribution board solid-linked to a bus repeats that bus's voltage —
      // skip its flag so an out-of-range bus isn't flagged twice (see
      // Annotations._lfRedundantDbBadges).
      const lfSuppressed = Annotations._lfRedundantDbBadges(pageComps, AppState.loadFlowResults.buses);
      for (const [busId, result] of Object.entries(AppState.loadFlowResults.buses)) {
        if (result.voltage_pu >= 0.95 && result.voltage_pu <= 1.05) continue;
        if (lfSuppressed.has(busId)) continue;
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

  // Render load flow directional arrows on wires — visible when toggled on
  renderLoadFlowArrows() {
    if (!AppState.showFlowArrows.loadflow || !AppState.loadFlowResults) return;
    const branches = AppState.loadFlowResults.branches || [];
    if (branches.length === 0) return;

    // Index branches by elementId for fast lookup
    const branchByElem = new Map();
    for (const b of branches) branchByElem.set(b.elementId, b);

    const pageWires = AppState.getActivePageWires();
    let html = '';

    for (const [id, wire] of pageWires) {
      const fromComp = AppState.components.get(wire.fromComponent);
      const toComp = AppState.components.get(wire.toComponent);
      if (!fromComp || !toComp) continue;

      // Find the branch element this wire is adjacent to
      let branch = branchByElem.get(toComp.id);
      let elemIsToCmp = true;
      if (!branch) {
        branch = branchByElem.get(fromComp.id);
        elemIsToCmp = false;
      }
      if (!branch) continue;

      // Determine if wire from→to aligns with branch from_bus→to_bus
      const otherComp = elemIsToCmp ? fromComp : toComp;
      let forward;
      if (branch.from_bus === otherComp.id) {
        // The other end of this wire is the from_bus side
        forward = elemIsToCmp; // wire goes from_bus→element when elemIsToCmp
      } else if (branch.to_bus === otherComp.id) {
        // The other end of this wire is the to_bus side
        forward = !elemIsToCmp; // wire goes element→to_bus when !elemIsToCmp
      } else {
        // Neither endpoint matches from_bus/to_bus — skip
        continue;
      }

      // Color by loading percentage (mirrors ETAP convention)
      let color = '#22c55e'; // green  < 80 %
      if (branch.loading_pct > 100) color = '#ef4444';       // red
      else if (branch.loading_pct > 80) color = '#f97316';   // amber

      // Flip arrow when real power flows opposite to the branch's from→to direction
      const isForward = branch.p_mw >= 0 ? forward : !forward;

      html += this._buildArrowSvg(id, wire, fromComp, toComp, isForward, color, 'loadflow-arrow');
    }

    if (html) {
      this.annotationsLayer.insertAdjacentHTML('beforeend', html);
    }
  },

  // Render fault current directional arrows — visible only when a specific bus is faulted
  renderFaultFlowArrows() {
    if (!AppState.showFlowArrows.fault || !AppState.faultResults || !AppState.faultedBusId) return;
    const faultedBusId = AppState.faultedBusId;
    const busResult = AppState.faultResults.buses?.[faultedBusId];
    if (!busResult || !busResult.branches || busResult.branches.length === 0) return;

    // Index fault branches by element_id
    const faultByElem = new Map();
    for (const b of busResult.branches) faultByElem.set(b.element_id, b);

    const pageWires = AppState.getActivePageWires();
    let html = '';

    for (const [id, wire] of pageWires) {
      const fromComp = AppState.components.get(wire.fromComponent);
      const toComp = AppState.components.get(wire.toComponent);
      if (!fromComp || !toComp) continue;

      // Find the fault branch element this wire is adjacent to
      let faultBranch = faultByElem.get(toComp.id);
      let elemIsToCmp = true;
      if (!faultBranch) {
        faultBranch = faultByElem.get(fromComp.id);
        elemIsToCmp = false;
      }
      if (!faultBranch) continue;

      // Determine wire alignment with branch from_bus→to_bus
      const otherComp = elemIsToCmp ? fromComp : toComp;
      let forward;
      if (faultBranch.from_bus === otherComp.id) {
        forward = elemIsToCmp;
      } else if (faultBranch.to_bus === otherComp.id) {
        forward = !elemIsToCmp;
      } else {
        continue;
      }

      // Color by contribution percentage: red for major, amber for moderate, blue for minor
      let color = '#3b82f6'; // blue  < 20 %
      if (faultBranch.contribution_pct > 50) color = '#ef4444';       // red
      else if (faultBranch.contribution_pct > 20) color = '#f97316';  // amber

      // Fault current flows from source toward faulted bus
      // The branch from_bus is the source side, to_bus is the faulted bus side
      // forward=true means wire aligns with from→to, so arrow points toward fault
      const towardFault = forward;

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

  // Visual feedback while dragging a wire: glow the target bus bar (or the
  // target port dot) and show a snap dot at the exact attachment point.
  _updateSnapHighlight(snap) {
    // Clear previous highlights
    this.componentsLayer.querySelectorAll('.sld-component.wire-target')
      .forEach(el => el.classList.remove('wire-target'));
    this.componentsLayer.querySelectorAll('.conn-port.active')
      .forEach(el => el.classList.remove('active'));

    const preview = document.getElementById('wire-preview');
    let dot = document.getElementById('wire-snap-dot');
    if (!snap) {
      if (dot) dot.style.display = 'none';
      return;
    }
    const grp = this.componentsLayer.querySelector(`.sld-component[data-id="${snap.compId}"]`);
    const comp = AppState.components.get(snap.compId);
    if (grp && comp) {
      if (comp.type === 'bus') {
        grp.classList.add('wire-target');
      } else {
        const portDot = grp.querySelector(`.conn-port[data-port="${snap.portId}"]`);
        if (portDot) portDot.classList.add('active');
      }
    }
    if (!dot && preview) {
      dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.id = 'wire-snap-dot';
      dot.setAttribute('r', '5');
      preview.appendChild(dot);
    }
    if (dot) {
      dot.setAttribute('cx', snap.x);
      dot.setAttribute('cy', snap.y);
      dot.style.display = '';
    }
  },

  // Find the nearest port within snap radius (world coordinates).
  // Buses accept free-position attachments: the snap target is the nearest
  // point ON the bar (grid-snapped along it), returned as an 'at_<x>' port.
  findNearestPort(worldPt, excludeCompId) {
    const SNAP_RADIUS = 30;
    let nearest = null;
    let minDist = SNAP_RADIUS;
    // Only components on the active sheet: snapping across sheets would
    // silently wire to an invisible component at the same coordinates.
    for (const comp of AppState.getActivePageComponents().values()) {
      if (excludeCompId && comp.id === excludeCompId) continue;
      const def = COMPONENT_DEFS[comp.type];
      if (!def.ports) continue;
      if (comp.type === 'bus') {
        const hw = ((comp.props && comp.props.busWidth) || 120) / 2;
        // Transform cursor into the bus's local frame (inverse rotation)
        const rot = -(comp.rotation || 0) * Math.PI / 180;
        const dx0 = worldPt.x - comp.x;
        const dy0 = worldPt.y - comp.y;
        const lx = dx0 * Math.cos(rot) - dy0 * Math.sin(rot);
        const ly = dx0 * Math.sin(rot) + dy0 * Math.cos(rot);
        // Snap along the bar to the grid, clamp to the bar extent
        const ax = Math.max(-hw, Math.min(hw, Math.round(lx / GRID_SIZE) * GRID_SIZE));
        const portId = `at_${Math.round(ax)}`;
        const pos = Symbols.getPortWorldPosition(comp, portId);
        const dist = Math.hypot(worldPt.x - pos.x, worldPt.y - pos.y);
        if (dist < minDist) {
          minDist = dist;
          nearest = { compId: comp.id, portId, x: pos.x, y: pos.y };
        }
        continue;
      }
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

  // Insert a bend point on a wire at the given world position, placed into
  // the path segment nearest the point. Shared by dblclick and context menu.
  addWireBendPoint(wireId, worldPt) {
    const wire = AppState.wires.get(wireId);
    if (!wire) return;
    if (!wire.bendPoints) wire.bendPoints = [];
    const snapped = { x: snapToGrid(worldPt.x), y: snapToGrid(worldPt.y) };
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

  // Pan so the given component sits at the viewport centre (zoom unchanged).
  // With { onlyIfOffscreen: true }, only pans when the component is currently
  // outside the visible area — used by keyboard navigation.
  centerOnComponent(id, opts = {}) {
    const comp = AppState.components.get(id);
    if (!comp) return;
    const rect = this.svg.getBoundingClientRect();
    const z = AppState.zoom;
    if (opts.onlyIfOffscreen) {
      const screenX = comp.x * z + AppState.panX;
      const screenY = comp.y * z + AppState.panY;
      const margin = 40;
      const inView = screenX >= margin && screenX <= rect.width - margin &&
                     screenY >= margin && screenY <= rect.height - margin;
      if (inView) return;
    }
    AppState.panX = rect.width / 2 - comp.x * z;
    AppState.panY = rect.height / 2 - comp.y * z;
    this.updateTransform();
  },
};
