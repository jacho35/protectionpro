/* ProtectionPro — Time-Current Curve (TCC) Chart Engine
 *
 * Renders a log-log TCC chart on an HTML5 canvas with:
 *   - IDMT relay curves (IEC 60255 / IEEE C37.112)
 *   - gG fuse pre-arcing curves (IEC 60269)
 *   - CB trip curves (MCCB/ACB)
 *   - Transformer & cable thermal damage curves
 *   - Multi-tab views (auto by voltage + custom)
 *   - Voltage reference: all currents referred to selectable base voltage
 *   - Interactive curve dragging (relay pickup/TDS, CB settings)
 *   - Per-tab export: PNG, PDF, CSV
 *   - Automatic coordination / grading margin checks
 */

const TCC = {
  // Chart configuration
  canvas: null,
  ctx: null,
  devices: [],   // Array of { id, name, type, color, visible, voltage_kv, tabId, ... }

  // Log-log axis ranges
  currentMin: 1,       // Amps
  currentMax: 100000,  // Amps
  timeMin: 0.001,      // Seconds (1ms)
  timeMax: 1000,       // Seconds

  // Chart drawing area (set on render)
  plotLeft: 70,
  plotTop: 30,
  plotRight: 0,   // computed
  plotBottom: 0,   // computed
  plotWidth: 0,
  plotHeight: 0,

  // Device colors (assigned round-robin)
  palette: [
    '#d32f2f', '#1565c0', '#2e7d32', '#f57c00', '#6a1b9a',
    '#00838f', '#c62828', '#283593', '#1b5e20', '#e65100',
  ],
  colorIndex: 0,

  // Coordination settings
  gradingMargin: 0.3,  // seconds

  // ── Tab system ──
  tabs: [],        // Array of { id, name, isVoltageTab, voltage_kv }
  activeTabId: null,
  referenceVoltage: null, // kV — null means no voltage scaling

  // ── Selected device for settings panel ──
  selectedDeviceIndex: -1,

  // ── Fault current markers ──
  showFaultMarkers: true,

  // ── Comparison mode ──
  compareMode: false,
  compareTabId: null, // second tab ID for comparison

  // ── Curve drag state ──
  _curveDrag: null,  // { devIndex, mode: 'pickup'|'tds'|'magnetic', startX, startY, origValue }
  _curveHandles: [], // { devIndex, mode, x, y, r } for hit-testing

  // ── Initialisation ──

  init() {
    this.canvas = document.getElementById('tcc-canvas');
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext('2d');
    this._bindEvents();
  },

  // Label drag state
  _labelRects: [],    // Array of { devIndex, x, y, w, h } for hit-testing
  _labelDrag: null,   // { devIndex, startX, startY, origOX, origOY }

  _bindEvents() {
    // Resize observer to keep canvas sharp
    const container = this.canvas.parentElement;
    const ro = new ResizeObserver(() => this.render());
    ro.observe(container);

    // Tooltip on hover + curve drag move
    this.canvas.addEventListener('mousemove', (e) => {
      if (this._curveDrag) {
        this._handleCurveDragMove(e);
      } else if (this._labelDrag) {
        this._handleLabelDragMove(e);
      } else {
        this._handleHover(e);
      }
    });
    this.canvas.addEventListener('mouseleave', () => {
      this._tooltip = null;
      this._labelDrag = null;
      this._curveDrag = null;
      this.render();
    });

    // Mouse down: curve drag, label drag, or select curve
    this.canvas.addEventListener('mousedown', (e) => {
      if (!this._handleCurveDragStart(e)) {
        this._handleLabelDragStart(e);
        if (!this._labelDrag) {
          this._handleCurveSelect(e);
        }
      }
    });
    this.canvas.addEventListener('mouseup', () => {
      if (this._curveDrag) {
        this._finishCurveDrag();
        this._curveDrag = null;
        this.canvas.style.cursor = '';
      }
      if (this._labelDrag) {
        this._labelDrag = null;
        this.canvas.style.cursor = '';
      }
    });
  },

  _handleLabelDragStart(e) {
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    // Check if click is on a label
    for (const lr of this._labelRects) {
      if (mx >= lr.x && mx <= lr.x + lr.w && my >= lr.y && my <= lr.y + lr.h) {
        const dev = this.devices[lr.devIndex];
        this._labelDrag = {
          devIndex: lr.devIndex,
          startX: mx,
          startY: my,
          origOX: dev.labelOffsetX || 0,
          origOY: dev.labelOffsetY || 0,
        };
        this.canvas.style.cursor = 'grabbing';
        e.preventDefault();
        return;
      }
    }
  },

  _handleLabelDragMove(e) {
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const drag = this._labelDrag;

    const dev = this.devices[drag.devIndex];
    dev.labelOffsetX = drag.origOX + (mx - drag.startX);
    dev.labelOffsetY = drag.origOY + (my - drag.startY);
    this.render();
  },

  // ── Interactive curve dragging (relay pickup/TDS, CB magnetic/thermal) ──

  _handleCurveDragStart(e) {
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    for (const h of this._curveHandles) {
      let hit = false;
      const dx = mx - h.x, dy = my - h.y;
      if (dx * dx + dy * dy <= h.r * h.r) {
        hit = true;
      } else if (h.hitRect) {
        // Extended hit zone along a line segment
        const hr = h.hitRect;
        if (mx >= hr.x1 && mx <= hr.x2 && Math.abs(my - hr.y) <= hr.tolerance) {
          hit = true;
        }
      }
      if (hit) {
        const dev = this.devices[h.devIndex];
        let origValue;
        if (h.mode === 'pickup') origValue = dev.pickup;
        else if (h.mode === 'tds') origValue = dev.tds;
        else if (h.mode === 'magnetic') origValue = dev.cbParams.magnetic_pickup;
        else if (h.mode === 'thermal') origValue = dev.cbParams.thermal_pickup;
        this._curveDrag = { devIndex: h.devIndex, mode: h.mode, startX: mx, startY: my, origValue };
        this.canvas.style.cursor = h.mode === 'pickup' || h.mode === 'magnetic' || h.mode === 'thermal' ? 'ew-resize' : 'ns-resize';
        e.preventDefault();
        return true;
      }
    }
    return false;
  },

  _handleCurveDragMove(e) {
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const drag = this._curveDrag;
    const dev = this.devices[drag.devIndex];

    if (drag.mode === 'pickup') {
      // Horizontal drag → change relay pickup current
      const newCurrent = this._xToCurrent(mx);
      dev.pickup = Math.max(1, Math.round(newCurrent));
    } else if (drag.mode === 'tds') {
      // Vertical drag → change TDS (up = higher TDS = slower)
      const deltaY = drag.startY - my; // positive = dragged up
      const newTDS = drag.origValue + deltaY * 0.01;
      dev.tds = Math.max(0.05, Math.min(10, Math.round(newTDS * 20) / 20));
    } else if (drag.mode === 'magnetic') {
      // Horizontal drag → change CB magnetic pickup multiplier
      const newCurrent = this._xToCurrent(mx);
      const Ir = (dev.cbParams.trip_rating_a || 630) * (dev.cbParams.thermal_pickup || 1.0);
      dev.cbParams.magnetic_pickup = Math.max(2, Math.min(20, Math.round(newCurrent / Ir * 2) / 2));
    } else if (drag.mode === 'thermal') {
      // Horizontal drag → change CB thermal pickup multiplier
      const newCurrent = this._xToCurrent(mx);
      const Irated = dev.cbParams.trip_rating_a || 630;
      dev.cbParams.thermal_pickup = Math.max(0.4, Math.min(1.3, Math.round(newCurrent / Irated * 20) / 20));
    }
    this.render();
    this._renderDeviceList();
  },

  _finishCurveDrag() {
    // Sync dragged settings back to the SLD component
    const drag = this._curveDrag;
    const dev = this.devices[drag.devIndex];
    const comp = AppState.components.get(dev.id);
    if (!comp) return;

    if (drag.mode === 'pickup' && comp.props) {
      comp.props.pickup_a = dev.pickup;
    } else if (drag.mode === 'tds' && comp.props) {
      comp.props.time_dial = dev.tds;
    } else if (drag.mode === 'magnetic' && comp.props) {
      comp.props.magnetic_pickup = dev.cbParams.magnetic_pickup;
    } else if (drag.mode === 'thermal' && comp.props) {
      comp.props.thermal_pickup = dev.cbParams.thermal_pickup;
    }
    this._runCoordinationCheck();
  },

  // ── Persisted display state across open/close ──
  _savedDisplayState: {}, // keyed by device id: { visible, color, labelOffsetX, labelOffsetY }

  _saveDisplayState() {
    for (const dev of this.devices) {
      this._savedDisplayState[dev.id] = {
        visible: dev.visible,
        color: dev.color,
        labelOffsetX: dev.labelOffsetX || 0,
        labelOffsetY: dev.labelOffsetY || 0,
      };
    }
  },

  _restoreDisplayState() {
    for (const dev of this.devices) {
      const saved = this._savedDisplayState[dev.id];
      if (saved) {
        dev.visible = saved.visible;
        dev.color = saved.color;
        dev.labelOffsetX = saved.labelOffsetX;
        dev.labelOffsetY = saved.labelOffsetY;
      }
    }
  },

  // ── Open the TCC modal ──

  open() {
    // Save state before rebuilding
    if (this.devices.length > 0) {
      this._saveDisplayState();
    }
    this.devices = [];
    this.colorIndex = 0;
    this.selectedDeviceIndex = -1;
    this._loadDevicesFromNetwork();
    this._restoreDisplayState();
    this._buildTabs();
    document.getElementById('tcc-modal').style.display = '';
    // Defer render to let the modal layout settle
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this._renderTabs();
        this._renderVoltageSelector();
        this.render();
        this._renderDeviceList();
        this._renderSelectedDeviceSettings();
        this._runCoordinationCheck();
      });
    });
  },

  close() {
    this._saveDisplayState();
    document.getElementById('tcc-modal').style.display = 'none';
  },

  // ── Resolve voltage at a component by tracing wires to a bus ──

  _resolveDeviceVoltage(compId) {
    // BFS through wires to find the nearest bus/transformer with a known voltage
    const visited = new Set([compId]);
    const queue = [compId];
    while (queue.length > 0) {
      const cur = queue.shift();
      const comp = AppState.components.get(cur);
      if (!comp) continue;
      // Bus with explicit voltage
      if (comp.type === 'bus' && comp.props?.voltage_kv) return comp.props.voltage_kv;
      // Transformer — return LV side voltage (most common TCC reference)
      if (comp.type === 'transformer') {
        return comp.props?.voltage_lv_kv || comp.props?.voltage_hv_kv || null;
      }
      // Generator / utility
      if ((comp.type === 'generator' || comp.type === 'utility') && comp.props?.voltage_kv) return comp.props.voltage_kv;
      // Follow wires
      for (const [, wire] of AppState.wires || []) {
        let neighbor = null;
        if (wire.fromComponent === cur) neighbor = wire.toComponent;
        else if (wire.toComponent === cur) neighbor = wire.fromComponent;
        if (neighbor && !visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    return null;
  },

  // ── Load relays and fuses from the SLD ──

  _loadDevicesFromNetwork() {
    for (const [id, comp] of AppState.components) {
      if (comp.type === 'relay' && (comp.props?.relay_type === '50/51' || comp.props?.relay_type === '50N/51N')) {
        this.devices.push({
          id,
          name: comp.props?.name || id,
          deviceType: 'relay',
          color: this.palette[this.colorIndex++ % this.palette.length],
          visible: true,
          voltage_kv: this._resolveDeviceVoltage(id),
          // Relay params
          curveName: comp.props?.curve || 'IEC Standard Inverse',
          pickup: comp.props?.pickup_a || 100,
          tds: comp.props?.time_dial || 1.0,
        });
      } else if (comp.type === 'fuse') {
        const ratingA = comp.props?.rated_current_a || 100;
        // Only plot if we have curve data for this rating
        const nearestRating = this._nearestFuseRating(ratingA);
        if (nearestRating) {
          this.devices.push({
            id,
            name: comp.props?.name || id,
            deviceType: 'fuse',
            color: this.palette[this.colorIndex++ % this.palette.length],
            visible: true,
            voltage_kv: this._resolveDeviceVoltage(id),
            fuseRating: nearestRating,
            actualRating: ratingA,
          });
        }
      } else if (comp.type === 'cb') {
        this.devices.push({
          id,
          name: comp.props?.name || id,
          deviceType: 'cb',
          color: this.palette[this.colorIndex++ % this.palette.length],
          visible: true,
          voltage_kv: this._resolveDeviceVoltage(id),
          cbParams: {
            cb_type: comp.props?.cb_type || 'mccb',
            trip_rating_a: comp.props?.trip_rating_a || comp.props?.rated_current_a || 630,
            thermal_pickup: comp.props?.thermal_pickup || 1.0,
            magnetic_pickup: comp.props?.magnetic_pickup || 10,
            long_time_delay: comp.props?.long_time_delay || 10,
            short_time_pickup: comp.props?.short_time_pickup || 0,
            short_time_delay: comp.props?.short_time_delay || 0,
            instantaneous_pickup: comp.props?.instantaneous_pickup || 0,
          },
        });
      } else if (comp.type === 'transformer') {
        // Transformer thermal damage curve (ANSI/IEEE C57.109)
        const mva = comp.props?.rated_mva || 1;
        const hvKv = comp.props?.voltage_hv_kv || 11;
        const lvKv = comp.props?.voltage_lv_kv || 0.42;
        // Rated current on LV side (higher current side)
        const ratedA = (mva * 1000) / (Math.sqrt(3) * lvKv);
        if (ratedA > 0) {
          this.devices.push({
            id,
            name: (comp.props?.name || id) + ' (thermal)',
            deviceType: 'xfmr_thermal',
            color: this.palette[this.colorIndex++ % this.palette.length],
            visible: true,
            voltage_kv: lvKv,
            ratedA,
            mva,
            zPercent: comp.props?.z_percent || 8,
          });
        }
      } else if (comp.type === 'cable') {
        // Cable thermal damage curve (IEC 60364 adiabatic: I²t = k²S²)
        const sizeStr = comp.props?.standard_type || '';
        const stdCable = STANDARD_CABLES.find(c => c.id === sizeStr);
        const sizeMm2 = stdCable ? stdCable.size_mm2 : (comp.props?.size_mm2 || 0);
        const ratedAmps = comp.props?.rated_amps || (stdCable ? stdCable.rated_amps : 0);
        const conductor = stdCable ? stdCable.conductor : (comp.props?.conductor || 'Cu');
        if (ratedAmps > 0 && sizeMm2 > 0) {
          // k factor: Cu XLPE=143, Cu PVC=115, Al XLPE=94, Al PVC=76
          const insulation = stdCable ? stdCable.insulation : (comp.props?.insulation || 'XLPE');
          let kFactor = 143; // Cu XLPE default
          if (conductor === 'Cu' && insulation === 'PVC') kFactor = 115;
          else if (conductor === 'Al' && insulation === 'XLPE') kFactor = 94;
          else if (conductor === 'Al' && insulation === 'PVC') kFactor = 76;
          this.devices.push({
            id,
            name: (comp.props?.name || id) + ' (thermal)',
            deviceType: 'cable_thermal',
            color: this.palette[this.colorIndex++ % this.palette.length],
            visible: true,
            voltage_kv: this._resolveDeviceVoltage(id),
            ratedAmps,
            sizeMm2,
            kFactor,
          });
        }
      }
    }
  },

  _nearestFuseRating(ratingA) {
    // Find closest gG fuse rating
    let best = null;
    let bestDist = Infinity;
    for (const r of FUSE_RATINGS_GG) {
      const dist = Math.abs(r - ratingA);
      if (dist < bestDist) { bestDist = dist; best = r; }
    }
    // Only accept if within 20% of a standard rating
    if (best && Math.abs(best - ratingA) / ratingA < 0.2) return best;
    return best; // Still return nearest even if not exact
  },

  // ── Tab system: auto-group by voltage + custom tabs ──

  _buildTabs() {
    this.tabs = [];
    // "All" tab always first
    this.tabs.push({ id: 'all', name: 'All Devices', isVoltageTab: false, voltage_kv: null });

    // Collect unique voltages
    const voltages = new Set();
    for (const dev of this.devices) {
      if (dev.voltage_kv && dev.voltage_kv > 0) voltages.add(dev.voltage_kv);
    }

    // Sort voltages descending (HV first)
    const sorted = [...voltages].sort((a, b) => b - a);
    for (const v of sorted) {
      this.tabs.push({
        id: `v_${v}`,
        name: `${v} kV`,
        isVoltageTab: true,
        voltage_kv: v,
      });
    }

    // Assign devices to voltage tabs
    for (const dev of this.devices) {
      if (dev.voltage_kv) {
        dev.tabId = `v_${dev.voltage_kv}`;
      } else {
        dev.tabId = null; // shown in "All" only
      }
    }

    this.activeTabId = 'all';

    // Collect voltage options for reference selector
    this._voltageOptions = sorted;
    this.referenceVoltage = null;
  },

  _getVisibleDevicesForTab() {
    if (this.activeTabId === 'all') return this.devices;
    return this.devices.filter(d => d.tabId === this.activeTabId || d.tabId === null);
  },

  addCustomTab(name) {
    const id = 'custom_' + Date.now();
    this.tabs.push({ id, name: name || 'Custom', isVoltageTab: false, voltage_kv: null });
    this._renderTabs();
  },

  // ── Voltage reference scaling ──

  _scaleCurrent(amps, dev) {
    if (!this.referenceVoltage || !dev || !dev.voltage_kv) return amps;
    // Refer current to reference voltage: I_ref = I_actual × (V_actual / V_ref)
    return amps * (dev.voltage_kv / this.referenceVoltage);
  },

  _scaleCurrentInverse(amps, dev) {
    // Inverse: from reference voltage back to device voltage
    if (!this.referenceVoltage || !dev || !dev.voltage_kv) return amps;
    return amps * (this.referenceVoltage / dev.voltage_kv);
  },

  // ── Coordinate mapping (log-log) ──

  _currentToX(amps) {
    const logMin = Math.log10(this.currentMin);
    const logMax = Math.log10(this.currentMax);
    const logVal = Math.log10(Math.max(amps, this.currentMin));
    return this.plotLeft + (logVal - logMin) / (logMax - logMin) * this.plotWidth;
  },

  _timeToY(seconds) {
    const logMin = Math.log10(this.timeMin);
    const logMax = Math.log10(this.timeMax);
    const logVal = Math.log10(Math.max(seconds, this.timeMin));
    // Y is inverted (top = max time, bottom = min time)... actually TCC convention:
    // top = long time, bottom = short time, so top=max, bottom=min
    return this.plotTop + (1 - (logVal - logMin) / (logMax - logMin)) * this.plotHeight;
  },

  _xToCurrent(x) {
    const logMin = Math.log10(this.currentMin);
    const logMax = Math.log10(this.currentMax);
    const frac = (x - this.plotLeft) / this.plotWidth;
    return Math.pow(10, logMin + frac * (logMax - logMin));
  },

  _yToTime(y) {
    const logMin = Math.log10(this.timeMin);
    const logMax = Math.log10(this.timeMax);
    const frac = 1 - (y - this.plotTop) / this.plotHeight;
    return Math.pow(10, logMin + frac * (logMax - logMin));
  },

  // ── Rendering ──

  render() {
    if (!this.canvas || !this.ctx) return;

    const container = this.canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    const w = container.clientWidth;
    const h = container.clientHeight;

    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';

    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);

    if (this.compareMode && this.compareTabId) {
      // ── Comparison mode: two charts side-by-side ──
      this._renderCompareMode(ctx, w, h);
    } else {
      // ── Normal single-chart mode ──
      this._renderSingleChart(ctx, w, h, this.activeTabId);
    }
  },

  _renderSingleChart(ctx, w, h, tabId, offsetX, chartWidth) {
    const ox = offsetX || 0;
    const cw = chartWidth || w;

    // Compute plot area
    this.plotLeft = ox + 70;
    this.plotTop = 30;
    this.plotRight = ox + cw - 20;
    this.plotBottom = h - 40;
    this.plotWidth = this.plotRight - this.plotLeft;
    this.plotHeight = this.plotBottom - this.plotTop;

    this._drawGrid(ctx);
    this._drawAxes(ctx);

    // Draw each device curve (filtered by tab)
    this._labelRects = [];
    this._curveHandles = [];
    const savedTabId = this.activeTabId;
    this.activeTabId = tabId;
    const tabDevices = this._getVisibleDevicesForTab();

    // Dim non-selected curves when a device is selected
    const selIdx = this.selectedDeviceIndex;
    const hasSelection = selIdx >= 0 && selIdx < this.devices.length;

    for (const dev of tabDevices) {
      if (!dev.visible) continue;
      const isSelected = this.devices.indexOf(dev) === selIdx;
      ctx.globalAlpha = hasSelection && !isSelected ? 0.3 : 1.0;
      if (dev.deviceType === 'relay') this._drawRelayCurve(ctx, dev);
      else if (dev.deviceType === 'fuse') this._drawFuseCurve(ctx, dev);
      else if (dev.deviceType === 'cb') this._drawCBCurve(ctx, dev);
      else if (dev.deviceType === 'xfmr_thermal') this._drawXfmrThermal(ctx, dev);
      else if (dev.deviceType === 'cable_thermal') this._drawCableThermal(ctx, dev);
    }
    ctx.globalAlpha = 1.0;
    this.activeTabId = savedTabId;

    // Draw interactive curve handles
    this._drawCurveHandles(ctx);

    // Draw fault current markers
    this._drawFaultMarkers(ctx);

    // Draw tooltip
    if (this._tooltip) {
      this._drawTooltip(ctx, this._tooltip);
    }

    // Title
    ctx.fillStyle = '#333';
    ctx.font = 'bold 13px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'center';
    let title = 'Time-Current Characteristic (TCC)';
    const tab = this.tabs.find(t => t.id === tabId);
    if (tab && tab.id !== 'all') title += ` — ${tab.name}`;
    if (this.referenceVoltage) title += ` @ ${this.referenceVoltage} kV ref`;
    ctx.fillText(title, ox + cw / 2, 18);
  },

  _renderCompareMode(ctx, w, h) {
    const halfW = Math.floor(w / 2);

    // Draw divider line
    ctx.strokeStyle = '#999';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(halfW, 0);
    ctx.lineTo(halfW, h);
    ctx.stroke();

    // Left chart: active tab
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, halfW, h);
    ctx.clip();
    this._renderSingleChart(ctx, w, h, this.activeTabId, 0, halfW);
    ctx.restore();

    // Right chart: compare tab
    ctx.save();
    ctx.beginPath();
    ctx.rect(halfW, 0, halfW, h);
    ctx.clip();
    this._renderSingleChart(ctx, w, h, this.compareTabId, halfW, halfW);
    ctx.restore();

    // Compare label
    ctx.fillStyle = '#555';
    ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'center';
    const leftTab = this.tabs.find(t => t.id === this.activeTabId);
    const rightTab = this.tabs.find(t => t.id === this.compareTabId);
    ctx.fillText(leftTab?.name || 'Left', halfW / 2, h - 5);
    ctx.fillText(rightTab?.name || 'Right', halfW + halfW / 2, h - 5);
  },

  _drawGrid(ctx) {
    ctx.strokeStyle = '#e8e8e8';
    ctx.lineWidth = 0.5;

    // Vertical grid (current)
    const logCMin = Math.log10(this.currentMin);
    const logCMax = Math.log10(this.currentMax);
    for (let decade = Math.floor(logCMin); decade <= Math.ceil(logCMax); decade++) {
      for (let sub = 1; sub <= 9; sub++) {
        const val = sub * Math.pow(10, decade);
        if (val < this.currentMin || val > this.currentMax) continue;
        const x = this._currentToX(val);
        ctx.strokeStyle = sub === 1 ? '#ccc' : '#e8e8e8';
        ctx.lineWidth = sub === 1 ? 0.8 : 0.4;
        ctx.beginPath();
        ctx.moveTo(x, this.plotTop);
        ctx.lineTo(x, this.plotBottom);
        ctx.stroke();
      }
    }

    // Horizontal grid (time)
    const logTMin = Math.log10(this.timeMin);
    const logTMax = Math.log10(this.timeMax);
    for (let decade = Math.floor(logTMin); decade <= Math.ceil(logTMax); decade++) {
      for (let sub = 1; sub <= 9; sub++) {
        const val = sub * Math.pow(10, decade);
        if (val < this.timeMin || val > this.timeMax) continue;
        const y = this._timeToY(val);
        ctx.strokeStyle = sub === 1 ? '#ccc' : '#e8e8e8';
        ctx.lineWidth = sub === 1 ? 0.8 : 0.4;
        ctx.beginPath();
        ctx.moveTo(this.plotLeft, y);
        ctx.lineTo(this.plotRight, y);
        ctx.stroke();
      }
    }
  },

  _drawAxes(ctx) {
    // Plot border
    ctx.strokeStyle = '#999';
    ctx.lineWidth = 1;
    ctx.strokeRect(this.plotLeft, this.plotTop, this.plotWidth, this.plotHeight);

    ctx.fillStyle = '#555';
    ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';

    // X axis labels (current)
    ctx.textAlign = 'center';
    const logCMin = Math.log10(this.currentMin);
    const logCMax = Math.log10(this.currentMax);
    for (let decade = Math.ceil(logCMin); decade <= Math.floor(logCMax); decade++) {
      const val = Math.pow(10, decade);
      const x = this._currentToX(val);
      ctx.fillText(this._formatValue(val, 'A'), x, this.plotBottom + 14);
    }

    // X axis title
    ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText('Current (A)', (this.plotLeft + this.plotRight) / 2, this.plotBottom + 30);

    // Y axis labels (time)
    ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'right';
    const logTMin = Math.log10(this.timeMin);
    const logTMax = Math.log10(this.timeMax);
    for (let decade = Math.ceil(logTMin); decade <= Math.floor(logTMax); decade++) {
      const val = Math.pow(10, decade);
      const y = this._timeToY(val);
      ctx.fillText(this._formatValue(val, 's'), this.plotLeft - 6, y + 3);
    }

    // Y axis title
    ctx.save();
    ctx.translate(14, (this.plotTop + this.plotBottom) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText('Time (s)', 0, 0);
    ctx.restore();
  },

  _formatValue(val, unit) {
    if (val >= 1000) return (val / 1000) + 'k' + unit;
    if (val >= 1) return val + unit;
    if (val >= 0.001) return (val * 1000).toFixed(0) + 'ms';
    return val.toExponential(0) + unit;
  },

  _drawRelayCurve(ctx, dev) {
    ctx.strokeStyle = dev.color;
    ctx.lineWidth = 2;
    ctx.beginPath();

    let started = false;
    // Sample current from pickup to 100x pickup (in device amps, then scale for display)
    const iStart = dev.pickup * 1.05; // Just above pickup
    const iEnd = Math.min(dev.pickup * 100, this._scaleCurrentInverse(this.currentMax, dev));
    const steps = 200;

    for (let i = 0; i <= steps; i++) {
      const logI = Math.log10(iStart) + (Math.log10(iEnd) - Math.log10(iStart)) * (i / steps);
      const current = Math.pow(10, logI); // actual device amps
      const M = current / dev.pickup;
      const t = idmtTripTime(dev.curveName, M, dev.tds);

      if (t <= 0 || !isFinite(t) || t > this.timeMax || t < this.timeMin) continue;

      const x = this._currentToX(this._scaleCurrent(current, dev));
      const y = this._timeToY(t);

      if (x < this.plotLeft || x > this.plotRight || y < this.plotTop || y > this.plotBottom) continue;

      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Draw pickup line (vertical dashed line at pickup current)
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = dev.color;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.5;
    const px = this._currentToX(this._scaleCurrent(dev.pickup, dev));
    if (px >= this.plotLeft && px <= this.plotRight) {
      ctx.beginPath();
      ctx.moveTo(px, this.plotTop);
      ctx.lineTo(px, this.plotBottom);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1.0;

    // Label
    const labelI = dev.pickup * 3;
    const labelT = idmtTripTime(dev.curveName, 3, dev.tds);
    if (isFinite(labelT) && labelT > this.timeMin && labelT < this.timeMax) {
      this._drawLabel(ctx, dev, this._currentToX(this._scaleCurrent(labelI, dev)), this._timeToY(labelT), dev.name);
    }

    // Register drag handles
    this._registerRelayHandles(dev);
  },

  _drawFuseCurve(ctx, dev) {
    const points = FUSE_CURVES_GG[dev.fuseRating];
    if (!points || points.length < 2) return;

    ctx.strokeStyle = dev.color;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 3]);
    ctx.beginPath();

    let started = false;
    for (const [current, time] of points) {
      const scaledI = this._scaleCurrent(current, dev);
      if (scaledI < this.currentMin || scaledI > this.currentMax) continue;
      if (time < this.timeMin || time > this.timeMax) continue;
      const x = this._currentToX(scaledI);
      const y = this._timeToY(time);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Label near middle of curve
    const midIdx = Math.floor(points.length / 2);
    const [mI, mT] = points[midIdx];
    const scaledMI = this._scaleCurrent(mI, dev);
    if (scaledMI >= this.currentMin && scaledMI <= this.currentMax && mT >= this.timeMin && mT <= this.timeMax) {
      this._drawLabel(ctx, dev, this._currentToX(scaledMI), this._timeToY(mT), `${dev.name} (${dev.fuseRating}A)`);
    }
  },

  _drawCBCurve(ctx, dev) {
    const p = dev.cbParams;
    const Ir = (p.trip_rating_a || 630) * (p.thermal_pickup || 1.0);
    const Im = Ir * (p.magnetic_pickup || 10);
    const sc = (amps) => this._scaleCurrent(amps, dev); // shorthand for voltage scaling

    // --- Thermal (long-time inverse) region ---
    ctx.strokeStyle = dev.color;
    ctx.lineWidth = 2.5;
    ctx.beginPath();

    let started = false;
    const iStart = Ir * 1.05;
    const iEnd = Math.min(Im, this._scaleCurrentInverse(this.currentMax, dev));
    const steps = 200;

    for (let i = 0; i <= steps; i++) {
      const logI = Math.log10(iStart) + (Math.log10(iEnd) - Math.log10(iStart)) * (i / steps);
      const current = Math.pow(10, logI);
      const t = cbTripTime(p, current);

      if (t <= 0 || !isFinite(t) || t > this.timeMax || t < this.timeMin) continue;

      const x = this._currentToX(sc(current));
      const y = this._timeToY(t);

      if (x < this.plotLeft || x > this.plotRight || y < this.plotTop || y > this.plotBottom) continue;

      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // --- Magnetic (instantaneous) region: vertical drop + horizontal line ---
    const magTime = 0.02;  // 20ms
    const magTimeACB = p.cb_type === 'acb' && p.short_time_pickup > 0 ? p.short_time_delay : magTime;

    // Draw the vertical drop at magnetic pickup
    ctx.beginPath();
    ctx.lineWidth = 2.5;
    const thermalTimeAtIm = cbTripTime({ ...p, magnetic_pickup: 9999, short_time_pickup: 0, instantaneous_pickup: 0 }, Im);
    const xMag = this._currentToX(sc(Im));
    if (xMag >= this.plotLeft && xMag <= this.plotRight) {
      const yTop = this._timeToY(Math.min(thermalTimeAtIm, this.timeMax));
      const yBot = this._timeToY(magTime);
      if (yTop >= this.plotTop && yBot <= this.plotBottom) {
        ctx.moveTo(xMag, yTop);
        ctx.lineTo(xMag, yBot);
      }
    }
    ctx.stroke();

    // Horizontal line at magnetic trip time from Im to max current
    ctx.beginPath();
    const yMag = this._timeToY(magTime);
    if (yMag >= this.plotTop && yMag <= this.plotBottom) {
      const xStart = this._currentToX(sc(Im));
      const xEnd = this._currentToX(sc(Math.min(this._scaleCurrentInverse(this.currentMax, dev), (p.trip_rating_a || 630) * 200)));
      ctx.moveTo(Math.max(xStart, this.plotLeft), yMag);
      ctx.lineTo(Math.min(xEnd, this.plotRight), yMag);
    }
    ctx.stroke();

    // --- ACB short-time region ---
    if (p.cb_type === 'acb' && p.short_time_pickup > 0) {
      const stCurrent = Ir * p.short_time_pickup;
      const stDelay = p.short_time_delay || 0.1;
      const xST = this._currentToX(sc(stCurrent));
      const yST = this._timeToY(stDelay);

      if (xST >= this.plotLeft && yST >= this.plotTop && yST <= this.plotBottom) {
        // Vertical drop from thermal to short-time delay
        ctx.beginPath();
        ctx.setLineDash([4, 2]);
        const thermalAtST = cbTripTime({ ...p, short_time_pickup: 0, instantaneous_pickup: 0, magnetic_pickup: 9999 }, stCurrent);
        if (isFinite(thermalAtST) && thermalAtST > stDelay) {
          ctx.moveTo(xST, this._timeToY(thermalAtST));
          ctx.lineTo(xST, yST);
        }
        ctx.stroke();
        ctx.setLineDash([]);

        // Horizontal at short-time delay
        ctx.beginPath();
        const instCurrent = p.instantaneous_pickup > 0 ? Ir * p.instantaneous_pickup : Im;
        const xEnd = this._currentToX(sc(instCurrent));
        ctx.moveTo(xST, yST);
        ctx.lineTo(Math.min(xEnd, this.plotRight), yST);
        ctx.stroke();
      }

      // ACB instantaneous drop
      if (p.instantaneous_pickup > 0) {
        const instI = Ir * p.instantaneous_pickup;
        const xInst = this._currentToX(sc(instI));
        if (xInst >= this.plotLeft && xInst <= this.plotRight) {
          ctx.beginPath();
          ctx.moveTo(xInst, this._timeToY(stDelay));
          ctx.lineTo(xInst, this._timeToY(0.02));
          ctx.stroke();
          // Horizontal at 20ms
          ctx.beginPath();
          const y20 = this._timeToY(0.02);
          ctx.moveTo(xInst, y20);
          ctx.lineTo(this.plotRight, y20);
          ctx.stroke();
        }
      }
    }

    // --- Pickup line (dashed vertical at Ir) ---
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = dev.color;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.5;
    const px = this._currentToX(sc(Ir));
    if (px >= this.plotLeft && px <= this.plotRight) {
      ctx.beginPath();
      ctx.moveTo(px, this.plotTop);
      ctx.lineTo(px, this.plotBottom);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1.0;

    // --- Label ---
    const labelI = Ir * 2.5;
    const labelT = cbTripTime(p, labelI);
    if (isFinite(labelT) && labelT > this.timeMin && labelT < this.timeMax) {
      const typeStr = (p.cb_type || 'mccb').toUpperCase();
      this._drawLabel(ctx, dev, this._currentToX(this._scaleCurrent(labelI, dev)), this._timeToY(labelT), `${dev.name} (${typeStr})`);
    }

    // Register drag handles
    this._registerCBHandles(dev);
  },

  // ── Draw label with offset + register hit rect ──
  _drawLabel(ctx, dev, baseX, baseY, text) {
    const ox = dev.labelOffsetX || 0;
    const oy = dev.labelOffsetY || 0;
    const lx = baseX + ox + 6;
    const ly = baseY + oy - 4;

    if (lx < this.plotLeft || lx > this.plotRight - 10) return;

    ctx.fillStyle = dev.color;
    ctx.font = 'bold 10px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(text, lx, ly);

    // Register for hit-testing
    const w = ctx.measureText(text).width;
    const devIndex = this.devices.indexOf(dev);
    if (devIndex >= 0) {
      this._labelRects.push({ devIndex, x: lx - 2, y: ly - 12, w: w + 4, h: 16 });
    }
  },

  // ── Interactive curve handles (drawn as circles on relay/CB curves) ──

  _drawCurveHandles(ctx) {
    for (const h of this._curveHandles) {
      if (h.hitRect) {
        // Draw a grab indicator along the flat line (arrows + highlight)
        const hr = h.hitRect;
        ctx.save();
        ctx.strokeStyle = h.color || '#333';
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.35;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(hr.x1, hr.y);
        ctx.lineTo(hr.x2, hr.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        // Draw handle circle at the left edge (the magnetic pickup point)
        ctx.beginPath();
        ctx.arc(hr.x1, hr.y, h.r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.fill();
        ctx.strokeStyle = h.color || '#333';
        ctx.lineWidth = 2;
        ctx.stroke();
        // Left-right arrows inside the handle
        ctx.beginPath();
        ctx.moveTo(hr.x1 - 3, hr.y);
        ctx.lineTo(hr.x1 + 3, hr.y);
        ctx.moveTo(hr.x1 - 2, hr.y - 2);
        ctx.lineTo(hr.x1 - 3, hr.y);
        ctx.lineTo(hr.x1 - 2, hr.y + 2);
        ctx.moveTo(hr.x1 + 2, hr.y - 2);
        ctx.lineTo(hr.x1 + 3, hr.y);
        ctx.lineTo(hr.x1 + 2, hr.y + 2);
        ctx.strokeStyle = h.color || '#333';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(h.x, h.y, h.r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.fill();
        ctx.strokeStyle = h.color || '#333';
        ctx.lineWidth = 2;
        ctx.stroke();
        // Inner dot
        ctx.beginPath();
        ctx.arc(h.x, h.y, 3, 0, Math.PI * 2);
        ctx.fillStyle = h.color || '#333';
        ctx.fill();
      }
    }
  },

  // ── Fault current markers from analysis results ──

  _drawFaultMarkers(ctx) {
    if (!this.showFaultMarkers) return;
    const fr = AppState.faultResults;
    if (!fr || !fr.buses) return;

    const markers = []; // { current_ka, label, bus, voltage_kv, color }
    for (const [busId, r] of Object.entries(fr.buses)) {
      const comp = AppState.components.get(busId);
      const busName = comp?.props?.name || busId;
      const vkv = r.voltage_kv || comp?.props?.voltage_kv || null;

      if (r.ik3 != null) markers.push({ current_ka: r.ik3, label: `${busName} 3Φ`, voltage_kv: vkv, color: '#d32f2f' });
      if (r.ik1 != null) markers.push({ current_ka: r.ik1, label: `${busName} SLG`, voltage_kv: vkv, color: '#1565c0' });
      if (r.ip != null) markers.push({ current_ka: r.ip, label: `${busName} ip`, voltage_kv: vkv, color: '#f57c00' });
    }

    if (markers.length === 0) return;

    ctx.save();
    ctx.font = '9px -apple-system, BlinkMacSystemFont, sans-serif';

    for (const m of markers) {
      let amps = m.current_ka * 1000; // kA to A
      // Apply voltage reference scaling if active
      if (this.referenceVoltage && m.voltage_kv) {
        amps = amps * (m.voltage_kv / this.referenceVoltage);
      }
      if (amps < this.currentMin || amps > this.currentMax) continue;

      const x = this._currentToX(amps);
      if (x < this.plotLeft || x > this.plotRight) continue;

      // Dashed vertical line
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = m.color;
      ctx.lineWidth = 1.2;
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.moveTo(x, this.plotTop);
      ctx.lineTo(x, this.plotBottom);
      ctx.stroke();

      // Label at top (rotated)
      ctx.globalAlpha = 0.85;
      ctx.setLineDash([]);
      ctx.save();
      ctx.translate(x + 3, this.plotTop + 4);
      ctx.rotate(Math.PI / 2);
      ctx.textAlign = 'left';
      ctx.fillStyle = m.color;
      ctx.fillText(`${m.label} ${m.current_ka.toFixed(2)} kA`, 0, 0);
      ctx.restore();
    }

    ctx.restore();
  },

  _registerRelayHandles(dev) {
    const devIndex = this.devices.indexOf(dev);
    if (devIndex < 0) return;

    // Pickup handle: on the pickup line at the middle of the chart
    const pickupI = this._scaleCurrent(dev.pickup, dev);
    const px = this._currentToX(pickupI);
    const midT = Math.sqrt(this.timeMin * this.timeMax); // geometric mean
    const py = this._timeToY(midT);
    if (px >= this.plotLeft && px <= this.plotRight && py >= this.plotTop && py <= this.plotBottom) {
      this._curveHandles.push({ devIndex, mode: 'pickup', x: px, y: py, r: 7, color: dev.color });
    }

    // TDS handle: on the curve at 3× pickup
    const tdsI = dev.pickup * 3;
    const tdsT = idmtTripTime(dev.curveName, 3, dev.tds);
    if (isFinite(tdsT) && tdsT > this.timeMin && tdsT < this.timeMax) {
      const scaledI = this._scaleCurrent(tdsI, dev);
      const tx = this._currentToX(scaledI);
      const ty = this._timeToY(tdsT);
      if (tx >= this.plotLeft && tx <= this.plotRight && ty >= this.plotTop && ty <= this.plotBottom) {
        this._curveHandles.push({ devIndex, mode: 'tds', x: tx, y: ty, r: 7, color: dev.color });
      }
    }
  },

  _registerCBHandles(dev) {
    const devIndex = this.devices.indexOf(dev);
    if (devIndex < 0) return;
    const p = dev.cbParams;
    const Ir = (p.trip_rating_a || 630) * (p.thermal_pickup || 1.0);
    const Im = Ir * (p.magnetic_pickup || 10);

    // Thermal pickup handle: at Ir on the thermal curve
    const thermalI = Ir * 2;
    const thermalT = cbTripTime(p, thermalI);
    if (isFinite(thermalT) && thermalT > this.timeMin && thermalT < this.timeMax) {
      const scaledI = this._scaleCurrent(thermalI, dev);
      const tx = this._currentToX(scaledI);
      const ty = this._timeToY(thermalT);
      if (tx >= this.plotLeft && tx <= this.plotRight && ty >= this.plotTop && ty <= this.plotBottom) {
        this._curveHandles.push({ devIndex, mode: 'thermal', x: tx, y: ty, r: 7, color: dev.color });
      }
    }

    // Magnetic pickup handle: midway up the vertical drop at Im
    const magTime = (p.cb_type === 'mccb') ? 0.02 : 0.01;
    const scaledIm = this._scaleCurrent(Im, dev);
    const mx = this._currentToX(scaledIm);
    // Compute vertical drop range: from thermal curve down to magnetic flat line
    const thermalTimeAtIm = cbTripTime({ ...p, magnetic_pickup: 9999, short_time_pickup: 0, instantaneous_pickup: 0 }, Im);
    const yDropTop = this._timeToY(Math.min(isFinite(thermalTimeAtIm) ? thermalTimeAtIm : this.timeMax, this.timeMax));
    const yDropBot = this._timeToY(magTime);
    const yMid = (yDropTop + yDropBot) / 2; // midpoint of vertical drop

    if (mx >= this.plotLeft && mx <= this.plotRight && yMid >= this.plotTop && yMid <= this.plotBottom) {
      // Hit zone spans the vertical drop and the flat instantaneous line
      const yFlat = this._timeToY(magTime);
      this._curveHandles.push({
        devIndex, mode: 'magnetic',
        x: mx, y: yMid, r: 7, color: dev.color,
        hitRect: {
          x1: mx - 8,
          x2: Math.min(this.plotRight, this._currentToX(this._scaleCurrent(Ir * 200, dev))),
          y: yFlat,
          tolerance: 8
        }
      });
    }
  },

  // ── Transformer Thermal Damage Curve (ANSI/IEEE C57.109) ──
  _drawXfmrThermal(ctx, dev) {
    const Ir = dev.ratedA;
    const zPct = dev.zPercent || 8;
    const Imax = Ir * (100 / zPct);
    const I2t = Ir * Ir * 1250;
    const sc = (amps) => this._scaleCurrent(amps, dev);

    ctx.strokeStyle = dev.color;
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 4]);
    ctx.beginPath();

    let started = false;
    const steps = 200;
    const iStart = Ir * 2;
    const iEnd = Math.min(Imax * 1.2, this._scaleCurrentInverse(this.currentMax, dev));

    for (let i = 0; i <= steps; i++) {
      const logI = Math.log10(iStart) + (Math.log10(iEnd) - Math.log10(iStart)) * (i / steps);
      const current = Math.pow(10, logI);
      const t = I2t / (current * current);

      if (t < this.timeMin || t > this.timeMax) continue;
      const x = this._currentToX(sc(current));
      const y = this._timeToY(t);
      if (x < this.plotLeft || x > this.plotRight || y < this.plotTop || y > this.plotBottom) continue;

      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Vertical line at max through-fault current
    const xMax = this._currentToX(sc(Imax));
    if (xMax >= this.plotLeft && xMax <= this.plotRight) {
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.moveTo(xMax, this.plotTop);
      ctx.lineTo(xMax, this.plotBottom);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1.0;
    }

    // Label
    const labelI = Ir * 4;
    const labelT = I2t / (labelI * labelI);
    if (isFinite(labelT) && labelT > this.timeMin && labelT < this.timeMax) {
      this._drawLabel(ctx, dev, this._currentToX(sc(labelI)), this._timeToY(labelT), dev.name);
    }
  },

  // ── Cable Thermal Damage Curve (IEC 60364 adiabatic) ──
  _drawCableThermal(ctx, dev) {
    const kS = dev.kFactor * dev.sizeMm2;
    const I2t = kS * kS;
    const sc = (amps) => this._scaleCurrent(amps, dev);

    ctx.strokeStyle = dev.color;
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 4]);
    ctx.beginPath();

    let started = false;
    const steps = 200;
    const iStart = dev.ratedAmps * 1.5;
    const iEnd = Math.min(Math.sqrt(I2t / this.timeMin), this._scaleCurrentInverse(this.currentMax, dev));

    if (iEnd <= iStart) { ctx.setLineDash([]); return; }

    for (let i = 0; i <= steps; i++) {
      const logI = Math.log10(iStart) + (Math.log10(iEnd) - Math.log10(iStart)) * (i / steps);
      const current = Math.pow(10, logI);
      const t = I2t / (current * current);

      if (t < this.timeMin || t > this.timeMax) continue;
      const x = this._currentToX(sc(current));
      const y = this._timeToY(t);
      if (x < this.plotLeft || x > this.plotRight || y < this.plotTop || y > this.plotBottom) continue;

      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Rated current vertical line
    const xRated = this._currentToX(sc(dev.ratedAmps));
    if (xRated >= this.plotLeft && xRated <= this.plotRight) {
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.moveTo(xRated, this.plotTop);
      ctx.lineTo(xRated, this.plotBottom);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1.0;
    }

    // Label
    const labelI = dev.ratedAmps * 4;
    const labelT = I2t / (labelI * labelI);
    if (isFinite(labelT) && labelT > this.timeMin && labelT < this.timeMax) {
      this._drawLabel(ctx, dev, this._currentToX(sc(labelI)), this._timeToY(labelT), dev.name);
    }
  },

  // ── Tooltip on hover ──
  _tooltip: null,

  _handleHover(e) {
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    if (mx < this.plotLeft || mx > this.plotRight || my < this.plotTop || my > this.plotBottom) {
      this._tooltip = null;
      this.render();
      return;
    }

    const displayCurrent = this._xToCurrent(mx); // current in reference voltage frame
    const lines = [];
    const tabDevices = this._getVisibleDevicesForTab();
    for (const dev of tabDevices) {
      if (!dev.visible) continue;
      // Convert display current back to device's actual amps
      const current = this._scaleCurrentInverse(displayCurrent, dev);
      let t = null;
      if (dev.deviceType === 'relay') {
        const M = current / dev.pickup;
        t = idmtTripTime(dev.curveName, M, dev.tds);
      } else if (dev.deviceType === 'fuse') {
        t = fuseTripTime(dev.fuseRating, current);
      } else if (dev.deviceType === 'cb') {
        t = cbTripTime(dev.cbParams, current);
      } else if (dev.deviceType === 'xfmr_thermal') {
        const I2t = dev.ratedA * dev.ratedA * 1250;
        t = current > dev.ratedA * 2 ? I2t / (current * current) : null;
      } else if (dev.deviceType === 'cable_thermal') {
        const kS = dev.kFactor * dev.sizeMm2;
        t = current > dev.ratedAmps ? (kS * kS) / (current * current) : null;
      }
      if (t != null && isFinite(t) && t > 0 && t <= this.timeMax) {
        lines.push({ name: dev.name, time: t, color: dev.color });
      }
    }

    if (lines.length > 0) {
      this._tooltip = { x: mx, y: my, current: displayCurrent, lines };
    } else {
      this._tooltip = null;
    }

    // Cursor hint for curve handles and draggable labels
    let cursor = '';
    for (const h of this._curveHandles) {
      let hovering = false;
      const dx = mx - h.x, dy = my - h.y;
      if (dx * dx + dy * dy <= h.r * h.r) {
        hovering = true;
      } else if (h.hitRect) {
        const hr = h.hitRect;
        if (mx >= hr.x1 && mx <= hr.x2 && Math.abs(my - hr.y) <= hr.tolerance) {
          hovering = true;
        }
      }
      if (hovering) {
        cursor = (h.mode === 'pickup' || h.mode === 'magnetic' || h.mode === 'thermal') ? 'ew-resize' : 'ns-resize';
        break;
      }
    }
    if (!cursor) {
      for (const lr of this._labelRects) {
        if (mx >= lr.x && mx <= lr.x + lr.w && my >= lr.y && my <= lr.y + lr.h) {
          cursor = 'grab';
          break;
        }
      }
    }
    this.canvas.style.cursor = cursor;

    this.render();
  },

  _drawTooltip(ctx, tip) {
    let currentLabel = `${tip.current.toFixed(1)} A`;
    if (this.referenceVoltage) currentLabel += ` @ ${this.referenceVoltage} kV`;
    const lines = [currentLabel];
    for (const l of tip.lines) {
      lines.push(`${l.name}: ${l.time >= 1 ? l.time.toFixed(2) + 's' : (l.time * 1000).toFixed(1) + 'ms'}`);
    }

    ctx.font = '10px "SF Mono", Consolas, monospace';
    const maxW = Math.max(...lines.map(l => ctx.measureText(l).width));
    const pad = 6;
    const lineH = 14;
    const boxW = maxW + pad * 2;
    const boxH = lines.length * lineH + pad * 2;
    let tx = tip.x + 12;
    let ty = tip.y - boxH / 2;
    if (tx + boxW > this.plotRight) tx = tip.x - boxW - 8;
    if (ty < this.plotTop) ty = this.plotTop;

    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    ctx.beginPath();
    ctx.roundRect(tx, ty, boxW, boxH, 4);
    ctx.fill();

    ctx.textAlign = 'left';
    for (let i = 0; i < lines.length; i++) {
      ctx.fillStyle = i === 0 ? '#ddd' : (tip.lines[i - 1]?.color || '#fff');
      ctx.fillText(lines[i], tx + pad, ty + pad + (i + 1) * lineH - 3);
    }
  },

  // ── Device List UI ──

  _renderDeviceList() {
    const list = document.getElementById('tcc-device-list');
    if (!list) return;

    const tabDevices = this._getVisibleDevicesForTab();

    if (tabDevices.length === 0) {
      list.innerHTML = '<div class="tcc-no-devices">No protection devices, transformers, or cables in the network.<br>Add components to the SLD to see their curves.</div>';
      return;
    }

    list.innerHTML = tabDevices.map((dev, _) => {
      const i = this.devices.indexOf(dev);
      let typeLabel;
      if (dev.deviceType === 'relay') {
        typeLabel = `${dev.curveName} | Pickup: ${dev.pickup}A | TDS: ${dev.tds}`;
      } else if (dev.deviceType === 'fuse') {
        typeLabel = `gG Fuse ${dev.fuseRating}A`;
      } else if (dev.deviceType === 'cb') {
        const p = dev.cbParams;
        typeLabel = `${(p.cb_type || 'mccb').toUpperCase()} ${p.trip_rating_a}A | Mag: ${p.magnetic_pickup}×In`;
      } else if (dev.deviceType === 'xfmr_thermal') {
        typeLabel = `Thermal damage | ${dev.mva} MVA | Ir: ${dev.ratedA.toFixed(0)}A`;
      } else if (dev.deviceType === 'cable_thermal') {
        typeLabel = `Thermal limit | ${dev.sizeMm2}mm² | k=${dev.kFactor} | Ir: ${dev.ratedAmps}A`;
      } else {
        typeLabel = '';
      }
      const selected = i === this.selectedDeviceIndex;
      return `<div class="tcc-device-item ${dev.visible ? '' : 'tcc-hidden'} ${selected ? 'tcc-selected' : ''}" data-index="${i}">
        <div class="tcc-device-color" style="background:${dev.color}"></div>
        <div class="tcc-device-info">
          <div class="tcc-device-name">${dev.name}</div>
          <div class="tcc-device-detail">${typeLabel}</div>
        </div>
        <button class="tcc-device-toggle" data-index="${i}" title="Toggle visibility">${dev.visible ? '\u25CF' : '\u25CB'}</button>
      </div>`;
    }).join('');

    // Toggle visibility
    list.querySelectorAll('.tcc-device-toggle').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(e.target.dataset.index);
        this.devices[idx].visible = !this.devices[idx].visible;
        this._renderDeviceList();
        this.render();
        this._runCoordinationCheck();
      });
    });

    // Click to select device
    list.querySelectorAll('.tcc-device-item').forEach(item => {
      item.addEventListener('click', () => {
        const idx = parseInt(item.dataset.index);
        this.selectDevice(idx);
      });
    });
  },

  selectDevice(idx) {
    this.selectedDeviceIndex = (idx === this.selectedDeviceIndex) ? -1 : idx;
    this._renderDeviceList();
    this._renderSelectedDeviceSettings();
    this.render();
  },

  // ── Curve click-to-select on canvas ──

  _handleCurveSelect(e) {
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    if (mx < this.plotLeft || mx > this.plotRight || my < this.plotTop || my > this.plotBottom) {
      return;
    }

    const clickCurrent = this._xToCurrent(mx);
    const tabDevices = this._getVisibleDevicesForTab().filter(d => d.visible);
    let bestIdx = -1;
    let bestDist = 20; // pixel threshold

    for (const dev of tabDevices) {
      const globalIdx = this.devices.indexOf(dev);
      const current = this._scaleCurrentInverse(clickCurrent, dev);
      const t = this._deviceTripTime(dev, current);
      if (!isFinite(t) || t <= 0) continue;

      const curveY = this._timeToY(t);
      const dist = Math.abs(my - curveY);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = globalIdx;
      }
    }

    this.selectDevice(bestIdx >= 0 ? bestIdx : -1);
  },

  // ── Selected device settings panel ──

  _renderSelectedDeviceSettings() {
    const section = document.getElementById('tcc-selected-section');
    const container = document.getElementById('tcc-selected-settings');
    const title = document.getElementById('tcc-selected-title');
    if (!section || !container) return;

    if (this.selectedDeviceIndex < 0 || this.selectedDeviceIndex >= this.devices.length) {
      section.style.display = 'none';
      return;
    }

    const dev = this.devices[this.selectedDeviceIndex];
    section.style.display = '';
    title.textContent = dev.name;

    let html = '';
    const idx = this.selectedDeviceIndex;

    if (dev.deviceType === 'relay') {
      html = `
        <div class="tcc-form-row">
          <label>Curve</label>
          <select data-sel-field="curveName">
            ${['IEC Standard Inverse','IEC Very Inverse','IEC Extremely Inverse','IEC Long Time Inverse',
               'IEEE Moderately Inverse','IEEE Very Inverse','IEEE Extremely Inverse']
              .map(c => `<option value="${c}" ${c === dev.curveName ? 'selected' : ''}>${c}</option>`).join('')}
          </select>
        </div>
        <div class="tcc-form-row">
          <label>Pickup (A)</label>
          <input type="number" data-sel-field="pickup" value="${dev.pickup}" min="1" step="1">
        </div>
        <div class="tcc-form-row">
          <label>Time Dial (TDS)</label>
          <input type="number" data-sel-field="tds" value="${dev.tds}" min="0.05" max="10" step="0.05">
        </div>`;
    } else if (dev.deviceType === 'fuse') {
      html = `
        <div class="tcc-form-row">
          <label>Rating (A)</label>
          <select data-sel-field="fuseRating">
            ${[16,20,25,32,40,50,63,80,100,125,160,200,250,315,400,500,630]
              .map(r => `<option value="${r}" ${r === dev.fuseRating ? 'selected' : ''}>${r}A</option>`).join('')}
          </select>
        </div>`;
    } else if (dev.deviceType === 'cb') {
      const p = dev.cbParams;
      const isACB = p.cb_type === 'acb';
      html = `
        <div class="tcc-form-row">
          <label>Type</label>
          <select data-sel-field="cb.cb_type">
            <option value="mccb" ${p.cb_type === 'mccb' ? 'selected' : ''}>MCCB</option>
            <option value="acb" ${p.cb_type === 'acb' ? 'selected' : ''}>ACB</option>
          </select>
        </div>
        <div class="tcc-form-row">
          <label>Trip Rating (A)</label>
          <input type="number" data-sel-field="cb.trip_rating_a" value="${p.trip_rating_a}" min="1" step="1">
        </div>
        <div class="tcc-form-row">
          <label>Thermal Pickup (×In)</label>
          <input type="number" data-sel-field="cb.thermal_pickup" value="${p.thermal_pickup}" min="0.4" max="1.3" step="0.05">
        </div>
        <div class="tcc-form-row">
          <label>Magnetic Pickup (×In)</label>
          <input type="number" data-sel-field="cb.magnetic_pickup" value="${p.magnetic_pickup}" min="2" max="20" step="0.5">
        </div>
        <div class="tcc-form-row">
          <label>LT Delay Class</label>
          <select data-sel-field="cb.long_time_delay">
            ${[5,10,20,30].map(v => `<option value="${v}" ${p.long_time_delay === v ? 'selected' : ''}>${v}</option>`).join('')}
          </select>
        </div>
        <div class="tcc-sel-acb-fields" style="display:${isACB ? '' : 'none'}">
          <div class="tcc-form-row">
            <label>ST Pickup (×In)</label>
            <input type="number" data-sel-field="cb.short_time_pickup" value="${p.short_time_pickup || 0}" min="0" max="20" step="0.5">
          </div>
          <div class="tcc-form-row">
            <label>ST Delay (s)</label>
            <input type="number" data-sel-field="cb.short_time_delay" value="${p.short_time_delay || 0}" min="0.02" max="1" step="0.01">
          </div>
          <div class="tcc-form-row">
            <label>Instantaneous (×In)</label>
            <input type="number" data-sel-field="cb.instantaneous_pickup" value="${p.instantaneous_pickup || 0}" min="0" max="25" step="0.5">
          </div>
        </div>`;
    } else if (dev.deviceType === 'xfmr_thermal') {
      html = `
        <div class="tcc-form-row">
          <label>MVA Rating</label>
          <input type="number" data-sel-field="mva" value="${dev.mva}" min="0.01" step="0.01" readonly>
        </div>
        <div class="tcc-form-row">
          <label>Z (%)</label>
          <input type="number" data-sel-field="zPercent" value="${dev.zPercent || 8}" min="1" max="30" step="0.5">
        </div>`;
    } else if (dev.deviceType === 'cable_thermal') {
      html = `
        <div class="tcc-form-row">
          <label>Size (mm²)</label>
          <input type="number" data-sel-field="sizeMm2" value="${dev.sizeMm2}" min="1" step="0.5" readonly>
        </div>
        <div class="tcc-form-row">
          <label>k Factor</label>
          <input type="number" data-sel-field="kFactor" value="${dev.kFactor}" min="50" max="250" step="1">
        </div>
        <div class="tcc-form-row">
          <label>Rated (A)</label>
          <input type="number" data-sel-field="ratedAmps" value="${dev.ratedAmps}" min="1" step="1">
        </div>`;
    }

    container.innerHTML = html;

    // Wire up change events
    container.querySelectorAll('[data-sel-field]').forEach(el => {
      const handler = () => this._applySelectedDeviceSetting(el);
      el.addEventListener('change', handler);
      if (el.tagName === 'INPUT') el.addEventListener('input', handler);
    });
  },

  _applySelectedDeviceSetting(el) {
    const field = el.dataset.selField;
    const dev = this.devices[this.selectedDeviceIndex];
    if (!dev) return;

    const val = el.type === 'number' ? parseFloat(el.value) : el.value;

    if (field.startsWith('cb.')) {
      const cbField = field.slice(3);
      dev.cbParams[cbField] = val;
      // Show/hide ACB fields when type changes
      if (cbField === 'cb_type') {
        const acbFields = el.closest('#tcc-selected-settings').querySelector('.tcc-sel-acb-fields');
        if (acbFields) acbFields.style.display = val === 'acb' ? '' : 'none';
      }
    } else {
      dev[field] = val;
      // For fuse, recalculate nearest standard rating
      if (field === 'fuseRating') {
        dev.fuseRating = parseInt(val);
        dev.actualRating = parseInt(val);
      }
    }

    // Sync to SLD component
    const comp = AppState.components.get(dev.id);
    if (comp && comp.props) {
      if (dev.deviceType === 'relay') {
        comp.props.pickup_a = dev.pickup;
        comp.props.time_dial = dev.tds;
        comp.props.curve_type = dev.curveName;
      } else if (dev.deviceType === 'cb') {
        Object.assign(comp.props, dev.cbParams);
      } else if (dev.deviceType === 'xfmr_thermal') {
        comp.props.z_percent = dev.zPercent;
      } else if (dev.deviceType === 'cable_thermal') {
        comp.props.k_factor = dev.kFactor;
        comp.props.rated_amps = dev.ratedAmps;
      }
    }

    this._renderDeviceList();
    this.render();
    this._runCoordinationCheck();
  },

  // ── Add custom device ──

  addCustomRelay(name, pickup, tds, curveName) {
    this.devices.push({
      id: 'custom_' + Date.now(),
      name: name || `Relay ${this.devices.length + 1}`,
      deviceType: 'relay',
      color: this.palette[this.colorIndex++ % this.palette.length],
      visible: true,
      curveName: curveName || 'IEC Standard Inverse',
      pickup: pickup || 100,
      tds: tds || 1.0,
    });
    this._renderDeviceList();
    this.render();
    this._runCoordinationCheck();
  },

  addCustomFuse(name, ratingA) {
    const nearest = this._nearestFuseRating(ratingA || 100);
    this.devices.push({
      id: 'custom_' + Date.now(),
      name: name || `Fuse ${this.devices.length + 1}`,
      deviceType: 'fuse',
      color: this.palette[this.colorIndex++ % this.palette.length],
      visible: true,
      fuseRating: nearest,
      actualRating: ratingA || 100,
    });
    this._renderDeviceList();
    this.render();
    this._runCoordinationCheck();
  },

  addCustomCB(name, cbParams) {
    this.devices.push({
      id: 'custom_' + Date.now(),
      name: name || `CB ${this.devices.length + 1}`,
      deviceType: 'cb',
      color: this.palette[this.colorIndex++ % this.palette.length],
      visible: true,
      cbParams: {
        cb_type: cbParams.cb_type || 'mccb',
        trip_rating_a: cbParams.trip_rating_a || 630,
        thermal_pickup: cbParams.thermal_pickup || 1.0,
        magnetic_pickup: cbParams.magnetic_pickup || 10,
        long_time_delay: cbParams.long_time_delay || 10,
        short_time_pickup: cbParams.short_time_pickup || 0,
        short_time_delay: cbParams.short_time_delay || 0,
        instantaneous_pickup: cbParams.instantaneous_pickup || 0,
      },
    });
    this._renderDeviceList();
    this.render();
    this._runCoordinationCheck();
  },

  // ── Coordination / Grading Check ──

  _runCoordinationCheck() {
    const resultsDiv = document.getElementById('tcc-coord-results');
    if (!resultsDiv) return;

    const visible = this.devices.filter(d => d.visible);
    if (visible.length < 2) {
      resultsDiv.innerHTML = '<div class="tcc-coord-info">Add at least 2 visible devices to check coordination.</div>';
      return;
    }

    // Test coordination at several fault current levels
    const testCurrents = [500, 1000, 2000, 5000, 10000, 20000];
    const issues = [];
    const passes = [];

    for (let i = 0; i < visible.length; i++) {
      for (let j = i + 1; j < visible.length; j++) {
        const devA = visible[i];
        const devB = visible[j];

        for (const testI of testCurrents) {
          const tA = this._deviceTripTime(devA, testI);
          const tB = this._deviceTripTime(devB, testI);

          if (!isFinite(tA) || !isFinite(tB) || tA <= 0 || tB <= 0) continue;

          const faster = tA < tB ? devA : devB;
          const slower = tA < tB ? devB : devA;
          const margin = Math.abs(tA - tB);
          const tFast = Math.min(tA, tB);
          const tSlow = Math.max(tA, tB);

          if (margin < this.gradingMargin && tFast < 10) {
            issues.push({
              devA: faster.name,
              devB: slower.name,
              current: testI,
              margin: margin,
              tFast: tFast,
              tSlow: tSlow,
            });
          }
        }
      }
    }

    // Deduplicate issues (keep worst per pair)
    const pairMap = new Map();
    for (const iss of issues) {
      const key = `${iss.devA}|${iss.devB}`;
      const existing = pairMap.get(key);
      if (!existing || iss.margin < existing.margin) {
        pairMap.set(key, iss);
      }
    }

    let html = '';
    if (pairMap.size === 0) {
      html = `<div class="tcc-coord-pass">All visible device pairs have adequate grading margin (&ge; ${this.gradingMargin}s).</div>`;
    } else {
      html = `<div class="tcc-coord-title">Coordination Issues (margin &lt; ${this.gradingMargin}s)</div>`;
      html += '<table class="tcc-coord-table"><thead><tr><th>Downstream</th><th>Upstream</th><th>At Current</th><th>Margin</th></tr></thead><tbody>';
      for (const [, iss] of pairMap) {
        html += `<tr>
          <td>${iss.devA} (${iss.tFast >= 1 ? iss.tFast.toFixed(2) + 's' : (iss.tFast * 1000).toFixed(0) + 'ms'})</td>
          <td>${iss.devB} (${iss.tSlow >= 1 ? iss.tSlow.toFixed(2) + 's' : (iss.tSlow * 1000).toFixed(0) + 'ms'})</td>
          <td>${iss.current}A</td>
          <td class="tcc-margin-fail">${iss.margin >= 1 ? iss.margin.toFixed(2) + 's' : (iss.margin * 1000).toFixed(0) + 'ms'}</td>
        </tr>`;
      }
      html += '</tbody></table>';
    }

    resultsDiv.innerHTML = html;
  },

  _deviceTripTime(dev, currentA) {
    if (dev.deviceType === 'relay') {
      const M = currentA / dev.pickup;
      return idmtTripTime(dev.curveName, M, dev.tds);
    } else if (dev.deviceType === 'fuse') {
      return fuseTripTime(dev.fuseRating, currentA) || Infinity;
    } else if (dev.deviceType === 'cb') {
      return cbTripTime(dev.cbParams, currentA);
    } else if (dev.deviceType === 'xfmr_thermal') {
      if (currentA <= dev.ratedA * 2) return Infinity;
      return (dev.ratedA * dev.ratedA * 1250) / (currentA * currentA);
    } else if (dev.deviceType === 'cable_thermal') {
      if (currentA <= dev.ratedAmps) return Infinity;
      const kS = dev.kFactor * dev.sizeMm2;
      return (kS * kS) / (currentA * currentA);
    }
    return Infinity;
  },

  // ── Tab & Voltage Reference UI ──

  _renderTabs() {
    const container = document.getElementById('tcc-tab-bar');
    if (!container) return;
    if (this.tabs.length <= 1) {
      container.style.display = 'none';
      return;
    }
    container.style.display = '';
    container.innerHTML = this.tabs.map(tab =>
      `<button class="tcc-view-tab ${tab.id === this.activeTabId ? 'active' : ''}" data-tab-id="${tab.id}">${tab.name}</button>`
    ).join('') + '<button class="tcc-view-tab tcc-add-custom-tab" title="Add custom tab">+</button>';

    container.querySelectorAll('.tcc-view-tab:not(.tcc-add-custom-tab)').forEach(btn => {
      btn.addEventListener('click', (e) => {
        this.activeTabId = e.target.dataset.tabId;
        this._renderTabs();
        this._renderDeviceList();
        this.render();
        this._runCoordinationCheck();
      });
    });
    const addBtn = container.querySelector('.tcc-add-custom-tab');
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        const name = prompt('Tab name:');
        if (name) this.addCustomTab(name);
      });
    }
  },

  _renderVoltageSelector() {
    const container = document.getElementById('tcc-voltage-ref');
    if (!container) return;
    if (!this._voltageOptions || this._voltageOptions.length === 0) {
      container.style.display = 'none';
      return;
    }
    container.style.display = '';
    const options = ['<option value="">No scaling</option>'];
    for (const v of this._voltageOptions) {
      const sel = this.referenceVoltage === v ? ' selected' : '';
      options.push(`<option value="${v}"${sel}>${v} kV</option>`);
    }
    container.innerHTML = `<label for="tcc-voltage-select">Ref. Voltage</label>
      <select id="tcc-voltage-select">${options.join('')}</select>`;
    document.getElementById('tcc-voltage-select').addEventListener('change', (e) => {
      const val = parseFloat(e.target.value);
      this.referenceVoltage = isNaN(val) ? null : val;
      this.render();
    });
  },

  _renderCompareSelector() {
    const sel = document.getElementById('tcc-compare-tab');
    if (!sel) return;
    sel.innerHTML = this.tabs.map(t =>
      `<option value="${t.id}" ${t.id === this.compareTabId ? 'selected' : ''}>${t.name}</option>`
    ).join('');
  },

  // ── Export: PNG, PDF, CSV (per-tab) ──

  exportPNG() {
    if (!this.canvas) return;
    const tabName = (this.tabs.find(t => t.id === this.activeTabId) || {}).name || 'all';
    this.canvas.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${AppState.projectName || 'tcc'}_${tabName.replace(/\s+/g, '_')}.png`;
      a.click();
      URL.revokeObjectURL(url);
    }, 'image/png');
  },

  exportPDF() {
    if (!this.canvas) return;
    const tabName = (this.tabs.find(t => t.id === this.activeTabId) || {}).name || 'all';
    // Use canvas data URL in a printable window
    const dataUrl = this.canvas.toDataURL('image/png');
    const win = window.open('', '_blank');
    if (!win) return;
    win.document.write(`<!DOCTYPE html><html><head><title>TCC - ${tabName}</title>
      <style>@media print { body { margin: 0; } img { width: 100%; max-height: 100vh; } }</style>
      </head><body><img src="${dataUrl}" onload="window.print(); window.close();"></body></html>`);
    win.document.close();
  },

  exportCSV() {
    const tabDevices = this._getVisibleDevicesForTab().filter(d => d.visible);
    if (tabDevices.length === 0) return;

    // Sample currents across the range
    const currents = [];
    for (let decade = Math.floor(Math.log10(this.currentMin)); decade <= Math.ceil(Math.log10(this.currentMax)); decade++) {
      for (const mult of [1, 1.5, 2, 3, 5, 7]) {
        const val = mult * Math.pow(10, decade);
        if (val >= this.currentMin && val <= this.currentMax) currents.push(val);
      }
    }

    // Header
    const header = ['Current (A)', ...tabDevices.map(d => `${d.name} Time (s)`)];
    const rows = [header.join(',')];

    for (const I of currents) {
      const row = [I.toFixed(1)];
      for (const dev of tabDevices) {
        const t = this._deviceTripTime(dev, I);
        row.push(isFinite(t) && t > 0 ? t.toFixed(4) : '');
      }
      rows.push(row.join(','));
    }

    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const tabName = (this.tabs.find(t => t.id === this.activeTabId) || {}).name || 'all';
    a.href = url;
    a.download = `${AppState.projectName || 'tcc'}_${tabName.replace(/\s+/g, '_')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  },
};
