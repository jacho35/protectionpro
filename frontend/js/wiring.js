/* ProtectionPro — Wire/Connection System */

const Wiring = {
  previewLine: null,

  init() {
    this.previewLine = document.getElementById('wire-preview');
  },

  // Start drawing a wire from a port
  startWire(componentId, portId, worldPt) {
    const comp = AppState.components.get(componentId);
    if (!comp) return;
    const pos = Symbols.getPortWorldPosition(comp, portId);
    AppState.wireStart = {
      componentId,
      portId,
      x: pos.x,
      y: pos.y,
    };
    // Show preview
    const line = this.previewLine.querySelector('line');
    if (line) {
      line.setAttribute('x1', pos.x);
      line.setAttribute('y1', pos.y);
      line.setAttribute('x2', pos.x);
      line.setAttribute('y2', pos.y);
    }
    this.previewLine.style.display = '';
    document.getElementById('status-mode').textContent = 'Drawing Wire...';
  },

  // Update wire preview while drawing
  updatePreview(worldPt) {
    if (!AppState.wireStart) return;
    const line = this.previewLine.querySelector('line');
    if (line) {
      line.setAttribute('x2', worldPt.x);
      line.setAttribute('y2', worldPt.y);
    }
  },

  // Finish wire at target port
  finishWire(toComponentId, toPortId) {
    if (!AppState.wireStart) return;
    const { componentId: fromComp, portId: fromPort } = AppState.wireStart;

    // Don't connect to self
    if (fromComp === toComponentId && fromPort === toPortId) {
      this.cancelWire();
      return;
    }

    // Don't duplicate wires
    for (const w of AppState.wires.values()) {
      if ((w.fromComponent === fromComp && w.fromPort === fromPort &&
           w.toComponent === toComponentId && w.toPort === toPortId) ||
          (w.fromComponent === toComponentId && w.fromPort === toPortId &&
           w.toComponent === fromComp && w.toPort === fromPort)) {
        this.cancelWire();
        return;
      }
    }

    AppState.addWire(fromComp, fromPort, toComponentId, toPortId);
    this.cancelWire();
    Canvas.render();
  },

  // Cancel wire drawing
  cancelWire() {
    AppState.wireStart = null;
    this.previewLine.style.display = 'none';
    document.getElementById('status-mode').textContent =
      AppState.mode === MODE.WIRE ? 'Wire Mode' : 'Select Mode';
  },
};
