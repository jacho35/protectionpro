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

  // State for selection box
  isSelecting: false,
  selBoxStart: { x: 0, y: 0 },

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

    // Check if clicked on a component port (for wiring)
    const portEl = e.target.closest('.conn-port');
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
    if (!e.shiftKey) {
      AppState.clearSelection();
      Properties.clear();
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

    // Wire preview
    if (AppState.wireStart) {
      Wiring.updatePreview(worldPt);
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

    if (AppState.dragState) {
      AppState.dragState = null;
      return;
    }

    if (AppState.wireStart) {
      const portEl = e.target.closest('.conn-port');
      if (portEl) {
        const compEl = portEl.closest('.sld-component');
        Wiring.finishWire(compEl.dataset.id, portEl.dataset.port);
      } else {
        Wiring.cancelWire();
      }
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

  // Selection box
  updateSelectionBox(start, end) {
    const box = document.getElementById('selection-box');
    const rect = box.querySelector('rect');
    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    const w = Math.abs(end.x - start.x);
    const h = Math.abs(end.y - start.y);
    rect.setAttribute('x', x);
    rect.setAttribute('y', y);
    rect.setAttribute('width', w);
    rect.setAttribute('height', h);
    box.style.display = '';

    // Select components within box
    for (const [id, comp] of AppState.components) {
      const def = COMPONENT_DEFS[comp.type];
      const cx = comp.x, cy = comp.y;
      if (cx >= x && cx <= x + w && cy >= y && cy <= y + h) {
        AppState.selectedIds.add(id);
      }
    }
    this.render();
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
