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
    this._initMiniSLD();
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
        else if (h.mode.startsWith('zone_')) {
          const zi = parseInt(h.mode.split('_')[1]);
          origValue = dev.zones[zi]?.reach_ohm || 1;
        }
        this._curveDrag = { devIndex: h.devIndex, mode: h.mode, startX: mx, startY: my, origValue };
        this.canvas.style.cursor = h.mode === 'pickup' || h.mode === 'magnetic' || h.mode === 'thermal' || h.mode.startsWith('zone_') ? 'ew-resize' : 'ns-resize';
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
    } else if (drag.mode.startsWith('zone_')) {
      // Horizontal drag → change distance relay zone reach
      const zi = parseInt(drag.mode.split('_')[1]);
      const newCurrent = this._scaleCurrentInverse(this._xToCurrent(mx), dev);
      // I = V_phase / Z → Z = V_phase / I
      const vPhase = (dev.voltage_kv || 11) * 1000 / Math.sqrt(3);
      const newReach = Math.max(0.1, vPhase / Math.max(1, newCurrent));
      dev.zones[zi].reach_ohm = Math.round(newReach * 10) / 10;
      dev.zones[zi].pickup_a = vPhase / dev.zones[zi].reach_ohm;
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
    } else if (drag.mode.startsWith('zone_') && comp.props) {
      // Sync zone reaches back to SLD component
      const zoneKeys = [
        ['z1_reach_ohm', 'z1_delay_s'],
        ['z2_reach_ohm', 'z2_delay_s'],
        ['z3_reach_ohm', 'z3_delay_s'],
      ];
      for (let i = 0; i < dev.zones.length && i < zoneKeys.length; i++) {
        comp.props[zoneKeys[i][0]] = dev.zones[i].reach_ohm;
        comp.props[zoneKeys[i][1]] = dev.zones[i].delay_s;
      }
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
    // Validate endpoint device index against new device list
    if (this._miniSLDEndpointDeviceIdx >= this.devices.length) {
      this._miniSLDEndpointDeviceIdx = -1;
    }
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
        this._renderMiniSLD();
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
      if (comp.type === 'relay' && (comp.props?.relay_type === '50/51' || comp.props?.relay_type === '50N/51N' || comp.props?.relay_type === '67')) {
        // If relay has an associated CT, resolve voltage from CT's location
        const ctId = comp.props?.associated_ct;
        const measureAt = ctId && AppState.components.has(ctId) ? ctId : id;
        // CT saturation modeling: load CT parameters if associated
        let ctSat = null;
        if (ctId && AppState.components.has(ctId)) {
          const ctComp = AppState.components.get(ctId);
          ctSat = ctSaturationParams(ctComp.props || {});
        }
        const isDirectional = comp.props?.relay_type === '67';
        this.devices.push({
          id,
          name: comp.props?.name || id,
          deviceType: 'relay',
          relayType: comp.props?.relay_type,
          color: this.palette[this.colorIndex++ % this.palette.length],
          visible: true,
          voltage_kv: this._resolveDeviceVoltage(measureAt),
          associated_ct: ctId || null,
          trip_cb: comp.props?.trip_cb || null,
          ctSat, // CT saturation params (null if no CT)
          // Relay params
          curveName: comp.props?.curve || 'IEC Standard Inverse',
          pickup: comp.props?.pickup_a || 100,
          tds: comp.props?.time_dial || 1.0,
          // Directional (67) params
          directional: isDirectional,
          direction: isDirectional ? (comp.props?.direction || 'forward') : null,
          charAngle: isDirectional ? (comp.props?.characteristic_angle_deg || 45) : null,
        });
      } else if (comp.type === 'relay' && comp.props?.relay_type === '21') {
        // Distance relay — zone impedance reaches converted to current thresholds
        const vkv = comp.props?.voltage_kv || this._resolveDeviceVoltage(id) || 11;
        const zones = buildDistanceRelayZones({ ...comp.props, voltage_kv: vkv });
        if (zones.length > 0) {
          this.devices.push({
            id,
            name: comp.props?.name || id,
            deviceType: 'distance_relay',
            color: this.palette[this.colorIndex++ % this.palette.length],
            visible: true,
            voltage_kv: vkv,
            zones,  // [{ name, reach_ohm, delay_s, pickup_a }]
            mho_angle: comp.props?.mho_angle_deg || 75,
          });
        }
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

  moveDeviceToTab(devIndex, targetTabId) {
    const dev = this.devices[devIndex];
    if (!dev) return;
    // "All" tab means remove custom tab assignment (device returns to its voltage tab or all-only)
    if (targetTabId === 'all') {
      if (dev.voltage_kv) {
        dev.tabId = `v_${dev.voltage_kv}`;
      } else {
        dev.tabId = null;
      }
    } else {
      dev.tabId = targetTabId;
    }
    this._renderDeviceList();
    this.render();
    this._runCoordinationCheck();
    this._renderMiniSLD();
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
      else if (dev.deviceType === 'distance_relay') this._drawDistanceRelayCurve(ctx, dev);
      else if (dev.deviceType === 'fuse') this._drawFuseCurve(ctx, dev);
      else if (dev.deviceType === 'cb') this._drawCBCurve(ctx, dev);
      else if (dev.deviceType === 'xfmr_thermal') this._drawXfmrThermal(ctx, dev);
      else if (dev.deviceType === 'cable_thermal') this._drawCableThermal(ctx, dev);
      else if (dev.deviceType === 'custom_curve') this._drawCustomCurve(ctx, dev);
    }
    ctx.globalAlpha = 1.0;
    this.activeTabId = savedTabId;

    // Draw interactive curve handles
    this._drawCurveHandles(ctx);

    // Draw fault current markers
    this._drawFaultMarkers(ctx);

    // Draw mho characteristic inset for distance relays
    this._drawMhoInset(ctx, tabDevices);

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

    // Label (with direction suffix for 67 relays)
    const labelI = dev.pickup * 3;
    const labelT = idmtTripTime(dev.curveName, 3, dev.tds);
    if (isFinite(labelT) && labelT > this.timeMin && labelT < this.timeMax) {
      let labelText = dev.name;
      if (dev.directional) {
        const dirArrow = dev.direction === 'reverse' ? '\u2190' : '\u2192';
        labelText += ` (67${dirArrow})`;
      }
      this._drawLabel(ctx, dev, this._currentToX(this._scaleCurrent(labelI, dev)), this._timeToY(labelT), labelText);
    }

    // Directional arrow indicator on the curve for 67 relays
    if (dev.directional) {
      this._drawDirectionalIndicator(ctx, dev);
    }

    // ── CT Saturation curve (dashed) ──
    // Shows how CT saturation increases relay operating time at high currents
    if (dev.ctSat && dev.ctSat.iSatPrimary < Infinity) {
      this._drawRelaySaturationCurve(ctx, dev);
    }

    // Register drag handles
    this._registerRelayHandles(dev);
  },

  /**
   * Draw the CT-saturated relay curve as a dashed line.
   * Above the CT saturation point, the relay sees reduced current,
   * so its operating time increases.
   */
  _drawRelaySaturationCurve(ctx, dev) {
    const sat = dev.ctSat;
    const iSatPri = sat.iSatPrimary;

    // Only draw if saturation onset is within the plotted range
    const satX = this._currentToX(this._scaleCurrent(iSatPri, dev));
    if (satX > this.plotRight) return; // saturation beyond plot range

    ctx.save();
    ctx.strokeStyle = dev.color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.globalAlpha = 0.7;
    ctx.beginPath();

    let started = false;
    // Draw from saturation onset to max current
    const iStart = iSatPri;
    const iEnd = Math.min(dev.pickup * 200, this._scaleCurrentInverse(this.currentMax, dev));
    const steps = 200;

    for (let i = 0; i <= steps; i++) {
      const logI = Math.log10(iStart) + (Math.log10(iEnd) - Math.log10(iStart)) * (i / steps);
      const actualCurrent = Math.pow(10, logI); // actual primary amps
      const effectiveCurrent = ctEffectiveCurrent(actualCurrent, sat);
      const M = effectiveCurrent / dev.pickup;
      const t = idmtTripTime(dev.curveName, M, dev.tds);

      if (t <= 0 || !isFinite(t) || t > this.timeMax || t < this.timeMin) continue;

      // Plot at the ACTUAL current position (x) but the SATURATED time (y)
      const x = this._currentToX(this._scaleCurrent(actualCurrent, dev));
      const y = this._timeToY(t);

      if (x < this.plotLeft || x > this.plotRight || y < this.plotTop || y > this.plotBottom) continue;

      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Draw CT saturation onset marker (vertical dotted line)
    if (satX >= this.plotLeft && satX <= this.plotRight) {
      ctx.setLineDash([2, 3]);
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.4;
      ctx.beginPath();
      ctx.moveTo(satX, this.plotTop);
      ctx.lineTo(satX, this.plotBottom);
      ctx.stroke();

      // Label the saturation onset
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.6;
      ctx.font = '9px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillStyle = dev.color;
      ctx.textAlign = 'center';
      ctx.fillText(`CT sat ${Math.round(iSatPri)}A`, satX, this.plotTop + 12);
    }

    ctx.restore();
  },

  /**
   * Draw directional arrow indicators along the relay curve for 67 relays.
   * Forward: rightward arrows (→), Reverse: leftward arrows (←)
   */
  _drawDirectionalIndicator(ctx, dev) {
    ctx.save();
    ctx.fillStyle = dev.color;
    ctx.globalAlpha = 0.7;

    // Place arrow indicators at a few current multiples along the curve
    const multiples = [2, 5, 15];
    const arrowSize = 5;
    const isForward = dev.direction !== 'reverse';

    for (const m of multiples) {
      const current = dev.pickup * m;
      const t = idmtTripTime(dev.curveName, m, dev.tds);
      if (!isFinite(t) || t <= 0 || t > this.timeMax || t < this.timeMin) continue;

      const x = this._currentToX(this._scaleCurrent(current, dev));
      const y = this._timeToY(t);
      if (x < this.plotLeft + 10 || x > this.plotRight - 10 || y < this.plotTop || y > this.plotBottom) continue;

      // Draw a small triangle arrow
      ctx.beginPath();
      if (isForward) {
        // Right-pointing arrow (forward = towards load = increasing current on TCC)
        ctx.moveTo(x + arrowSize, y);
        ctx.lineTo(x - arrowSize, y - arrowSize);
        ctx.lineTo(x - arrowSize, y + arrowSize);
      } else {
        // Left-pointing arrow (reverse = towards source)
        ctx.moveTo(x - arrowSize, y);
        ctx.lineTo(x + arrowSize, y - arrowSize);
        ctx.lineTo(x + arrowSize, y + arrowSize);
      }
      ctx.closePath();
      ctx.fill();
    }

    ctx.restore();
  },

  _drawDistanceRelayCurve(ctx, dev) {
    const zones = dev.zones; // sorted by pickup_a descending (Z1 highest current first)
    if (!zones || zones.length === 0) return;

    const sc = (amps) => this._scaleCurrent(amps, dev);

    // Draw each zone as a stepped characteristic:
    // Horizontal line at zone delay, vertical drop between zones
    ctx.strokeStyle = dev.color;
    ctx.lineWidth = 2.5;

    // Collect the step points: each zone has a pickup current and delay
    // The curve is a staircase from high current (Z1) to low current (Z3)
    const steps = []; // { current_a, time_s, name }
    for (const z of zones) {
      steps.push({ current_a: z.pickup_a, time_s: Math.max(z.delay_s, 0.001), name: z.name });
    }

    // Draw the stepped curve
    ctx.beginPath();
    let started = false;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const xStep = this._currentToX(sc(step.current_a));
      const yStep = this._timeToY(step.time_s);

      if (xStep < this.plotLeft || xStep > this.plotRight) continue;
      if (yStep < this.plotTop || yStep > this.plotBottom) continue;

      if (!started) {
        // Start: horizontal line from right edge to Z1 pickup
        const xRight = Math.min(this.plotRight, this._currentToX(sc(step.current_a * 10)));
        ctx.moveTo(xRight, yStep);
        ctx.lineTo(xStep, yStep);
        started = true;
      } else {
        // Vertical drop from previous zone delay to this zone delay
        ctx.lineTo(xStep, yStep);
        // Horizontal line at this zone delay extending to the left
      }

      // Extend horizontal line to the next zone's pickup (or to minimum current)
      if (i < steps.length - 1) {
        const nextX = this._currentToX(sc(steps[i + 1].current_a));
        ctx.lineTo(nextX, yStep);
      } else {
        // Last zone: extend to left edge or minimum visible current
        const xLeft = Math.max(this.plotLeft, this._currentToX(sc(step.current_a * 0.3)));
        ctx.lineTo(xLeft, yStep);
      }
    }
    ctx.stroke();

    // Draw zone pickup lines (vertical dashed)
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.4;
    for (const z of zones) {
      const px = this._currentToX(sc(z.pickup_a));
      if (px >= this.plotLeft && px <= this.plotRight) {
        ctx.beginPath();
        ctx.moveTo(px, this.plotTop);
        ctx.lineTo(px, this.plotBottom);
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1.0;

    // Zone labels (small text at each zone step)
    ctx.font = '9px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillStyle = dev.color;
    for (const z of zones) {
      const px = this._currentToX(sc(z.pickup_a));
      const py = this._timeToY(Math.max(z.delay_s, 0.001));
      if (px >= this.plotLeft && px <= this.plotRight - 20 && py >= this.plotTop && py <= this.plotBottom) {
        ctx.textAlign = 'left';
        const delayStr = z.delay_s >= 1 ? z.delay_s.toFixed(1) + 's' : (z.delay_s * 1000).toFixed(0) + 'ms';
        ctx.fillText(`${z.name} (${z.reach_ohm}\u03A9, ${delayStr})`, px + 4, py - 4);
      }
    }

    // Main device label
    const labelZ = zones[0]; // Z1 (highest current)
    const labelX = this._currentToX(sc(labelZ.pickup_a * 2));
    const labelY = this._timeToY(Math.max(labelZ.delay_s, 0.001));
    if (labelX >= this.plotLeft && labelX <= this.plotRight && labelY >= this.plotTop && labelY <= this.plotBottom) {
      this._drawLabel(ctx, dev, labelX, labelY, `${dev.name} (21)`);
    }

    // Register drag handles for zone reaches
    this._registerDistanceRelayHandles(dev);
  },

  _registerDistanceRelayHandles(dev) {
    const devIndex = this.devices.indexOf(dev);
    if (devIndex < 0) return;
    const sc = (amps) => this._scaleCurrent(amps, dev);

    for (let i = 0; i < dev.zones.length; i++) {
      const z = dev.zones[i];
      const px = this._currentToX(sc(z.pickup_a));
      const py = this._timeToY(Math.max(z.delay_s, 0.001));
      if (px >= this.plotLeft && px <= this.plotRight && py >= this.plotTop && py <= this.plotBottom) {
        this._curveHandles.push({
          devIndex, mode: `zone_${i}`, x: px, y: py, r: 7, color: dev.color,
        });
      }
    }
  },

  // ── Mho Characteristic Inset (R-X impedance plane) ──
  // Draws a small R-X diagram in the top-right corner of the TCC
  // showing mho circle zones for any visible distance relays.
  _drawMhoInset(ctx, tabDevices) {
    const distDevs = tabDevices.filter(d => d.visible && d.deviceType === 'distance_relay');
    if (distDevs.length === 0) return;

    // Inset dimensions and position (top-right corner of plot)
    const insetSize = Math.min(140, this.plotWidth * 0.22);
    const insetX = this.plotRight - insetSize - 8;
    const insetY = this.plotTop + 8;
    const cx = insetX + insetSize / 2; // center X
    const cy = insetY + insetSize * 0.6; // center Y (shifted down — origin at lower-center)

    // Background
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.strokeStyle = '#999';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(insetX, insetY, insetSize, insetSize, 4);
    ctx.fill();
    ctx.stroke();

    // Title
    ctx.fillStyle = '#555';
    ctx.font = '9px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('R-X Diagram (\u03A9)', cx, insetY + 11);

    // Axes
    const axLen = insetSize * 0.38;
    ctx.strokeStyle = '#aaa';
    ctx.lineWidth = 0.7;
    // R axis (horizontal)
    ctx.beginPath();
    ctx.moveTo(cx - axLen, cy);
    ctx.lineTo(cx + axLen, cy);
    ctx.stroke();
    // X axis (vertical, positive up)
    ctx.beginPath();
    ctx.moveTo(cx, cy + axLen * 0.4);
    ctx.lineTo(cx, cy - axLen);
    ctx.stroke();

    // Axis labels
    ctx.fillStyle = '#999';
    ctx.font = '8px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('R', cx + axLen - 1, cy + 10);
    ctx.textAlign = 'center';
    ctx.fillText('X', cx + 8, cy - axLen + 4);

    // Find max zone reach across all distance relays for scaling
    let maxReach = 1;
    for (const dev of distDevs) {
      for (const z of dev.zones) {
        maxReach = Math.max(maxReach, z.reach_ohm);
      }
    }
    const scale = (axLen * 0.85) / maxReach; // ohms → pixels

    // Draw mho circles for each distance relay
    for (const dev of distDevs) {
      const mhoRad = (dev.mho_angle || 75) * Math.PI / 180;

      for (let i = dev.zones.length - 1; i >= 0; i--) {
        const z = dev.zones[i];
        // Mho circle: centered at (Z/2 cos(theta), Z/2 sin(theta)) with radius Z/2
        const r = (z.reach_ohm * scale) / 2;
        const centerR = r * Math.cos(mhoRad); // R component
        const centerX = r * Math.sin(mhoRad); // X component (positive up)

        ctx.beginPath();
        ctx.arc(cx + centerR, cy - centerX, r, 0, Math.PI * 2);
        ctx.strokeStyle = dev.color;
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.4 + 0.2 * i;
        ctx.stroke();

        // Zone label
        ctx.globalAlpha = 1;
        ctx.fillStyle = dev.color;
        ctx.font = '7px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(z.name, cx + centerR, cy - centerX - r - 2);
      }
    }

    ctx.restore();
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
        // Draw handle circle at the vertical drop midpoint with left-right arrows
        ctx.save();
        ctx.globalAlpha = 1;
        // Draw handle circle
        ctx.beginPath();
        ctx.arc(h.x, h.y, h.r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.fill();
        ctx.strokeStyle = h.color || '#333';
        ctx.lineWidth = 2;
        ctx.stroke();
        // Left-right arrows inside the handle
        ctx.beginPath();
        ctx.moveTo(h.x - 3, h.y);
        ctx.lineTo(h.x + 3, h.y);
        ctx.moveTo(h.x - 2, h.y - 2);
        ctx.lineTo(h.x - 3, h.y);
        ctx.lineTo(h.x - 2, h.y + 2);
        ctx.moveTo(h.x + 2, h.y - 2);
        ctx.lineTo(h.x + 3, h.y);
        ctx.lineTo(h.x + 2, h.y + 2);
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

    // Magnetic pickup handle: on the vertical drop at Im (midpoint between thermal and instantaneous)
    const magTime = (p.cb_type === 'mccb') ? 0.02 : 0.01;
    const scaledIm = this._scaleCurrent(Im, dev);
    const mx = this._currentToX(scaledIm);
    // Compute vertical drop range: from thermal curve down to magnetic flat line
    const thermalTimeAtIm = cbTripTime({ ...p, magnetic_pickup: 9999, short_time_pickup: 0, instantaneous_pickup: 0 }, Im);
    const yDropTop = this._timeToY(Math.min(isFinite(thermalTimeAtIm) ? thermalTimeAtIm : this.timeMax, this.timeMax));
    const yDropBot = this._timeToY(magTime);
    const yMid = (yDropTop + yDropBot) / 2; // midpoint of vertical drop

    if (mx >= this.plotLeft && mx <= this.plotRight && yMid >= this.plotTop && yMid <= this.plotBottom) {
      // Handle circle on the vertical drop midpoint; hit zone spans the flat line for dragging
      this._curveHandles.push({
        devIndex, mode: 'magnetic',
        x: mx, y: yMid, r: 7, color: dev.color,
        hitRect: {
          x1: mx,
          x2: Math.min(this.plotRight, this._currentToX(this._scaleCurrent(Ir * 200, dev))),
          y: yMid,
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
        // Show saturated time if CT saturation applies
        if (dev.ctSat && current > dev.ctSat.iSatPrimary) {
          const effCurrent = ctEffectiveCurrent(current, dev.ctSat);
          const Msat = effCurrent / dev.pickup;
          const tSat = idmtTripTime(dev.curveName, Msat, dev.tds);
          if (isFinite(tSat) && tSat > 0) {
            lines.push({ name: `${dev.name} (CT sat)`, time: tSat, color: dev.color, dashed: true });
          }
        }
      } else if (dev.deviceType === 'distance_relay') {
        t = distanceRelayTripTime(dev.zones, current);
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
        let tooltipName = dev.name;
        if (dev.directional) tooltipName += ` (67${dev.direction === 'reverse' ? '\u2190' : '\u2192'})`;
        lines.push({ name: tooltipName, time: t, color: dev.color });
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
        cursor = (h.mode === 'pickup' || h.mode === 'magnetic' || h.mode === 'thermal' || h.mode.startsWith('zone_')) ? 'ew-resize' : 'ns-resize';
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
      if (i > 0 && tip.lines[i - 1]?.dashed) ctx.globalAlpha = 0.6;
      ctx.fillText(lines[i], tx + pad, ty + pad + (i + 1) * lineH - 3);
      ctx.globalAlpha = 1.0;
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
        const dirPrefix = dev.directional ? `67 ${dev.direction === 'reverse' ? '\u2190Rev' : '\u2192Fwd'} | ` : '';
        typeLabel = `${dirPrefix}${dev.curveName} | Pickup: ${dev.pickup}A | TDS: ${dev.tds}`;
        if (dev.associated_ct) {
          const ctComp = AppState.components.get(dev.associated_ct);
          typeLabel += ` | CT: ${ctComp?.props?.name || dev.associated_ct}`;
          if (dev.ctSat && dev.ctSat.iSatPrimary < Infinity) {
            typeLabel += ` (sat@${Math.round(dev.ctSat.iSatPrimary)}A)`;
          }
        }
        if (dev.trip_cb) {
          const cbComp = AppState.components.get(dev.trip_cb);
          typeLabel += ` | \u2192 ${cbComp?.props?.name || dev.trip_cb}`;
        }
      } else if (dev.deviceType === 'distance_relay') {
        const zSummary = dev.zones.map(z => `${z.name}: ${z.reach_ohm}\u03A9`).join(' | ');
        typeLabel = `Distance (21) | ${zSummary}`;
      } else if (dev.deviceType === 'fuse') {
        typeLabel = `gG Fuse ${dev.fuseRating}A`;
      } else if (dev.deviceType === 'cb') {
        const p = dev.cbParams;
        typeLabel = `${(p.cb_type || 'mccb').toUpperCase()} ${p.trip_rating_a}A | Mag: ${p.magnetic_pickup}×In`;
      } else if (dev.deviceType === 'xfmr_thermal') {
        typeLabel = `Thermal damage | ${dev.mva} MVA | Ir: ${dev.ratedA.toFixed(0)}A`;
      } else if (dev.deviceType === 'cable_thermal') {
        typeLabel = `Thermal limit | ${dev.sizeMm2}mm² | k=${dev.kFactor} | Ir: ${dev.ratedAmps}A`;
      } else if (dev.deviceType === 'custom_curve') {
        typeLabel = `Custom curve | ${dev.curvePoints.length} points`;
      } else {
        typeLabel = '';
      }
      const selected = i === this.selectedDeviceIndex;
      const isEndpoint = i === this._miniSLDEndpointDeviceIdx;
      return `<div class="tcc-device-item ${dev.visible ? '' : 'tcc-hidden'} ${selected ? 'tcc-selected' : ''}" data-index="${i}" draggable="true">
        <div class="tcc-device-color" style="background:${dev.color}"></div>
        <div class="tcc-device-info">
          <div class="tcc-device-name">${dev.name}</div>
          <div class="tcc-device-detail">${typeLabel}</div>
        </div>
        <button class="tcc-device-endpoint ${isEndpoint ? 'active' : ''}" data-index="${i}" title="${isEndpoint ? 'Clear path endpoint' : 'Set as furthest grading point — mini-SLD shows path from source to this device'}">\u21E5</button>
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
        this._renderMiniSLD();
      });
    });

    // Set/clear grading endpoint for mini-SLD path
    list.querySelectorAll('.tcc-device-endpoint').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(e.target.dataset.index);
        this._miniSLDEndpointDeviceIdx = (this._miniSLDEndpointDeviceIdx === idx) ? -1 : idx;
        this._renderDeviceList();
        this._renderMiniSLD();
      });
    });

    // Click to select device
    list.querySelectorAll('.tcc-device-item').forEach(item => {
      item.addEventListener('click', () => {
        const idx = parseInt(item.dataset.index);
        this.selectDevice(idx);
      });
    });

    // Drag device to move between tabs
    list.querySelectorAll('.tcc-device-item').forEach(item => {
      item.addEventListener('dragstart', (e) => {
        const idx = item.dataset.index;
        e.dataTransfer.setData('text/plain', idx);
        e.dataTransfer.effectAllowed = 'move';
        item.classList.add('tcc-dragging');
      });
      item.addEventListener('dragend', () => {
        item.classList.remove('tcc-dragging');
        // Remove drop highlights from tabs
        document.querySelectorAll('.tcc-view-tab').forEach(t => t.classList.remove('tcc-drop-target'));
      });
    });
  },

  selectDevice(idx) {
    this.selectedDeviceIndex = (idx === this.selectedDeviceIndex) ? -1 : idx;
    this._renderDeviceList();
    this._renderSelectedDeviceSettings();
    this.render();
    this._renderMiniSLD();
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
      let ctSatHtml = '';
      if (dev.ctSat && dev.ctSat.iSatPrimary < Infinity) {
        const s = dev.ctSat;
        ctSatHtml = `
        <div class="tcc-ct-sat-info">
          <div class="tcc-ct-sat-title">CT Saturation</div>
          <div class="tcc-ct-sat-row">Ratio: ${s.primary}/${s.secondary} (${s.ratio}:1)</div>
          <div class="tcc-ct-sat-row">Vk: ${Math.round(s.kneePointV)}V | Rct: ${s.rctOhm}\u03A9 | Rb: ${s.burdenOhm.toFixed(1)}\u03A9</div>
          <div class="tcc-ct-sat-row">Saturation onset: ${Math.round(s.iSatPrimary)}A primary</div>
        </div>`;
      }
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
        </div>` + (dev.directional ? `
        <div class="tcc-form-row">
          <label>Direction</label>
          <select data-sel-field="direction">
            <option value="forward" ${dev.direction === 'forward' ? 'selected' : ''}>Forward \u2192</option>
            <option value="reverse" ${dev.direction === 'reverse' ? 'selected' : ''}>Reverse \u2190</option>
          </select>
        </div>
        <div class="tcc-form-row">
          <label>Char. Angle (RCA)</label>
          <input type="number" data-sel-field="charAngle" value="${dev.charAngle || 45}" min="-90" max="90" step="1" unit="\u00B0">
        </div>` : '') + ctSatHtml;
    } else if (dev.deviceType === 'distance_relay') {
      html = dev.zones.map((z, i) => `
        <div class="tcc-form-row">
          <label>${z.name} Reach (\u03A9)</label>
          <input type="number" data-sel-field="zone_reach_${i}" value="${z.reach_ohm}" min="0.01" step="0.1">
        </div>
        <div class="tcc-form-row">
          <label>${z.name} Delay (s)</label>
          <input type="number" data-sel-field="zone_delay_${i}" value="${z.delay_s}" min="0" step="0.01">
        </div>`).join('') + `
        <div class="tcc-form-row">
          <label>Voltage (kV)</label>
          <input type="number" data-sel-field="voltage_kv" value="${dev.voltage_kv}" min="0.1" step="0.1">
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
    } else if (dev.deviceType === 'custom_curve') {
      html = `
        <div class="tcc-form-row">
          <label>Data Points</label>
          <span style="font-size:11px;color:var(--text-muted)">${dev.curvePoints.length} points</span>
        </div>
        <div class="tcc-form-row">
          <label>Current Range</label>
          <span style="font-size:11px;color:var(--text-muted)">${dev.curvePoints[0][0]}A – ${dev.curvePoints[dev.curvePoints.length - 1][0]}A</span>
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
    } else if (field.startsWith('zone_reach_') || field.startsWith('zone_delay_')) {
      // Distance relay zone settings
      const parts = field.split('_');
      const zoneIdx = parseInt(parts[parts.length - 1]);
      if (dev.zones && dev.zones[zoneIdx]) {
        if (field.startsWith('zone_reach_')) {
          dev.zones[zoneIdx].reach_ohm = val;
          // Recalculate pickup current
          const vLL = (dev.voltage_kv || 11) * 1000;
          dev.zones[zoneIdx].pickup_a = vLL / (Math.sqrt(3) * val);
        } else {
          dev.zones[zoneIdx].delay_s = val;
        }
      }
    } else {
      dev[field] = val;
      // For fuse, recalculate nearest standard rating
      if (field === 'fuseRating') {
        dev.fuseRating = parseInt(val);
        dev.actualRating = parseInt(val);
      }
      // For distance relay voltage change, recalculate all zone pickup currents
      if (field === 'voltage_kv' && dev.deviceType === 'distance_relay') {
        const vLL = val * 1000;
        for (const z of dev.zones) {
          z.pickup_a = vLL / (Math.sqrt(3) * z.reach_ohm);
        }
      }
    }

    // Sync to SLD component
    const comp = AppState.components.get(dev.id);
    if (comp && comp.props) {
      if (dev.deviceType === 'relay') {
        comp.props.pickup_a = dev.pickup;
        comp.props.time_dial = dev.tds;
        comp.props.curve_type = dev.curveName;
        if (dev.directional) {
          comp.props.direction = dev.direction;
          comp.props.characteristic_angle_deg = dev.charAngle;
        }
      } else if (dev.deviceType === 'distance_relay') {
        if (dev.zones[0]) { comp.props.z1_reach_ohm = dev.zones[0].reach_ohm; comp.props.z1_delay_s = dev.zones[0].delay_s; }
        if (dev.zones[1]) { comp.props.z2_reach_ohm = dev.zones[1].reach_ohm; comp.props.z2_delay_s = dev.zones[1].delay_s; }
        if (dev.zones[2]) { comp.props.z3_reach_ohm = dev.zones[2].reach_ohm; comp.props.z3_delay_s = dev.zones[2].delay_s; }
        comp.props.voltage_kv = dev.voltage_kv;
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

  // ── Custom curve: user-defined TCC data points ──

  _drawCustomCurve(ctx, dev) {
    const pts = dev.curvePoints;
    if (!pts || pts.length < 2) return;

    ctx.strokeStyle = dev.color;
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 4, 2, 4]); // dash-dot pattern for custom curves
    ctx.beginPath();

    let started = false;
    for (const [current, time] of pts) {
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
    const midIdx = Math.floor(pts.length / 2);
    const [mI, mT] = pts[midIdx];
    const scaledMI = this._scaleCurrent(mI, dev);
    if (scaledMI >= this.currentMin && scaledMI <= this.currentMax && mT >= this.timeMin && mT <= this.timeMax) {
      this._drawLabel(ctx, dev, this._currentToX(scaledMI), this._timeToY(mT), dev.name);
    }
  },

  _customCurveTripTime(dev, currentA) {
    const pts = dev.curvePoints;
    if (!pts || pts.length < 2) return Infinity;

    // Log-log interpolation between data points (sorted by current ascending)
    if (currentA <= pts[0][0]) return Infinity;
    if (currentA >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];

    for (let i = 0; i < pts.length - 1; i++) {
      const [i1, t1] = pts[i];
      const [i2, t2] = pts[i + 1];
      if (currentA >= i1 && currentA <= i2) {
        // Log-log interpolation
        const logI = Math.log10(currentA);
        const logI1 = Math.log10(i1);
        const logI2 = Math.log10(i2);
        const logT1 = Math.log10(Math.max(t1, 1e-6));
        const logT2 = Math.log10(Math.max(t2, 1e-6));
        const frac = (logI - logI1) / (logI2 - logI1);
        return Math.pow(10, logT1 + frac * (logT2 - logT1));
      }
    }
    return Infinity;
  },

  addCustomCurveFromCSV(name, csvText) {
    const lines = csvText.trim().split('\n');
    const points = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.toLowerCase().startsWith('current')) continue;
      const parts = trimmed.split(/[,;\t]+/);
      const current = parseFloat(parts[0]);
      const time = parseFloat(parts[1]);
      if (isFinite(current) && isFinite(time) && current > 0 && time > 0) {
        points.push([current, time]);
      }
    }

    if (points.length < 2) {
      alert('CSV must contain at least 2 valid data points (current, time).');
      return false;
    }

    // Sort by current ascending
    points.sort((a, b) => a[0] - b[0]);

    this.devices.push({
      id: 'custom_curve_' + Date.now(),
      name: name || `Custom ${this.devices.length + 1}`,
      deviceType: 'custom_curve',
      color: this.palette[this.colorIndex++ % this.palette.length],
      visible: true,
      curvePoints: points,
    });

    this._renderDeviceList();
    this.render();
    this._runCoordinationCheck();
    return true;
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
      // Account for CT saturation: relay sees reduced current when CT saturates
      const effectiveA = dev.ctSat ? ctEffectiveCurrent(currentA, dev.ctSat) : currentA;
      const M = effectiveA / dev.pickup;
      return idmtTripTime(dev.curveName, M, dev.tds);
    } else if (dev.deviceType === 'distance_relay') {
      return distanceRelayTripTime(dev.zones, currentA);
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
    } else if (dev.deviceType === 'custom_curve') {
      return this._customCurveTripTime(dev, currentA);
    }
    return Infinity;
  },

  // ── Topology Analysis: determine upstream/downstream device ordering ──

  /**
   * Build ordered protection paths from sources (utility/generator) to loads.
   * Returns array of paths, where each path is an ordered array of TCC device
   * objects from upstream (source-side) to downstream (load-side).
   */
  _buildProtectionPaths() {
    const wires = AppState.wires;
    if (!wires || wires.size === 0) return [];

    // Build adjacency map: compId -> [{neighbor, fromPort, toPort}]
    const adj = new Map();
    for (const [, w] of wires) {
      if (!adj.has(w.fromComponent)) adj.set(w.fromComponent, []);
      if (!adj.has(w.toComponent)) adj.set(w.toComponent, []);
      adj.get(w.fromComponent).push(w.toComponent);
      adj.get(w.toComponent).push(w.fromComponent);
    }

    // Find source components (utility, generator)
    const sources = [];
    for (const [id, comp] of AppState.components) {
      if (comp.type === 'utility' || comp.type === 'generator') {
        sources.push(id);
      }
    }
    if (sources.length === 0) return [];

    // Protection device types that appear on TCC
    const protTypes = new Set(['relay', 'fuse', 'cb']);
    const isProtDevice = (id) => {
      const comp = AppState.components.get(id);
      if (!comp) return false;
      if (comp.type === 'relay') {
        return comp.props?.relay_type === '50/51' || comp.props?.relay_type === '50N/51N' || comp.props?.relay_type === '21';
      }
      return protTypes.has(comp.type);
    };

    // Map SLD component IDs to TCC device objects
    const tccDevMap = new Map();
    for (const dev of this.devices) {
      tccDevMap.set(dev.id, dev);
    }

    // Build relay → CB trip mapping: if a relay has a trip_cb, the relay
    // effectively operates at the CB's location for coordination purposes.
    // Also include the CB's TCC entry under the relay when the relay trips it.
    const relayCbMap = new Map(); // relay TCC dev → CB TCC dev
    for (const dev of this.devices) {
      if ((dev.deviceType === 'relay' || dev.deviceType === 'distance_relay') && dev.trip_cb) {
        const cbDev = tccDevMap.get(dev.trip_cb);
        if (cbDev) relayCbMap.set(dev, cbDev);
      }
    }

    // For CBs that are tripped by relays, skip them as independent devices
    // in path building (they operate as part of the relay scheme)
    const cbsTrippedByRelay = new Set();
    for (const [, cbDev] of relayCbMap) {
      cbsTrippedByRelay.add(cbDev.id);
    }

    // DFS from each source, collecting ordered protection devices along each path
    const allPaths = [];
    for (const srcId of sources) {
      const stack = [{ node: srcId, visited: new Set([srcId]), protDevices: [] }];
      while (stack.length > 0) {
        const { node, visited, protDevices } = stack.pop();
        const neighbors = adj.get(node) || [];
        const comp = AppState.components.get(node);

        // If this is a protection device, add to current path
        // Skip CBs that are tripped by relays (relay+CB act as one device)
        let currentPath = [...protDevices];
        if (isProtDevice(node) && tccDevMap.has(node) && !cbsTrippedByRelay.has(node)) {
          currentPath.push(tccDevMap.get(node));
        }
        // If this is a CT, check if any relay uses it — add that relay's device here
        if (comp && comp.type === 'ct') {
          for (const dev of this.devices) {
            if (dev.associated_ct === node && !currentPath.includes(dev)) {
              currentPath.push(dev);
            }
          }
        }

        // If this is a load or dead-end with protection devices, record the path
        const isLoad = comp && (comp.type === 'static_load' || comp.type === 'motor_induction' ||
                                comp.type === 'motor_synchronous');
        const unvisitedNeighbors = neighbors.filter(n => !visited.has(n));

        if ((isLoad || unvisitedNeighbors.length === 0) && currentPath.length >= 2) {
          allPaths.push(currentPath);
        }

        // Continue DFS
        for (const next of unvisitedNeighbors) {
          const newVisited = new Set(visited);
          newVisited.add(next);
          stack.push({ node: next, visited: newVisited, protDevices: currentPath });
        }
      }
    }

    return allPaths;
  },

  // ── Auto-Coordination Engine ──

  /**
   * Automatically set relay TDS / CB settings so that downstream devices
   * trip faster than upstream ones by at least the grading margin.
   *
   * Strategy:
   * 1. Build protection paths from sources to loads
   * 2. Start from the most downstream device and work upstream
   * 3. For each upstream device, ensure it trips slower than the device
   *    below it by at least the grading margin at the maximum fault current
   */
  autoCoordinate() {
    const paths = this._buildProtectionPaths();
    if (paths.length === 0) {
      this._showCoordMessage('No source-to-load protection paths found. Ensure utility/generator components are connected to protection devices.');
      return;
    }

    // Get maximum fault current from analysis results (or use a default)
    let maxFaultA = 10000; // default
    const fr = AppState.faultResults;
    if (fr && fr.buses) {
      for (const [, bus] of Object.entries(fr.buses)) {
        if (bus.ik3) maxFaultA = Math.max(maxFaultA, bus.ik3 * 1000);
      }
    }

    // Test currents for grading (use fault-level-based range)
    const testCurrents = [
      maxFaultA * 0.5,
      maxFaultA * 0.75,
      maxFaultA,
    ];

    let adjustments = 0;
    const changes = [];

    for (const path of paths) {
      // path is ordered upstream to downstream: [upstream, ..., downstream]
      // Process from downstream to upstream
      for (let i = path.length - 2; i >= 0; i--) {
        const upstream = path[i];
        const downstream = path[i + 1];

        // Check grading at test currents
        for (const testI of testCurrents) {
          const tDown = this._deviceTripTime(downstream, testI);
          const tUp = this._deviceTripTime(upstream, testI);

          if (!isFinite(tDown) || tDown <= 0) continue;

          const requiredTime = tDown + this.gradingMargin;

          if (isFinite(tUp) && tUp >= requiredTime) continue; // Already coordinated

          // Need to slow down the upstream device
          if (upstream.deviceType === 'relay' && upstream.curveName) {
            // Adjust TDS so that trip time at testI >= requiredTime
            const M = testI / upstream.pickup;
            if (M <= 1) continue;
            // t = TDS * f(M) → TDS = t / f(M)
            const tAtTDS1 = idmtTripTime(upstream.curveName, M, 1.0);
            if (!isFinite(tAtTDS1) || tAtTDS1 <= 0) continue;
            const newTDS = Math.max(upstream.tds, requiredTime / tAtTDS1);
            if (newTDS > upstream.tds && newTDS <= 10) {
              const oldTDS = upstream.tds;
              upstream.tds = Math.round(newTDS * 20) / 20; // round to 0.05
              adjustments++;
              changes.push(`${upstream.name}: TDS ${oldTDS.toFixed(2)} \u2192 ${upstream.tds.toFixed(2)}`);
              // Sync to SLD
              const comp = AppState.components.get(upstream.id);
              if (comp?.props) comp.props.time_dial = upstream.tds;
            }
          } else if (upstream.deviceType === 'cb') {
            // For CBs: adjust long-time delay class upward
            const p = upstream.cbParams;
            const currentClass = p.long_time_delay || 10;
            const classes = [5, 10, 20, 30];
            // Find the smallest class that gives enough margin
            for (const cls of classes) {
              if (cls <= currentClass) continue;
              p.long_time_delay = cls;
              const newT = this._deviceTripTime(upstream, testI);
              if (isFinite(newT) && newT >= requiredTime) {
                adjustments++;
                changes.push(`${upstream.name}: LT delay class ${currentClass} \u2192 ${cls}`);
                const comp = AppState.components.get(upstream.id);
                if (comp?.props) comp.props.long_time_delay = cls;
                break;
              }
            }
          }
        }
      }
    }

    // Report results
    if (adjustments === 0) {
      this._showCoordMessage('All protection paths are already coordinated. No adjustments needed.');
    } else {
      this._showCoordMessage(
        `Auto-coordination adjusted ${adjustments} device(s):\n` +
        changes.map(c => `  \u2022 ${c}`).join('\n'),
        'success'
      );
    }

    this._renderDeviceList();
    this._renderSelectedDeviceSettings();
    this.render();
    this._runCoordinationCheck();
  },

  // ── Sequence-of-Operation Verification ──

  /**
   * Given a fault location (bus), trace and verify the expected sequence of
   * relay trips and reclosures in order (primary, backup, final).
   * Flags any device that operates out of sequence or fails to operate.
   *
   * More deterministic than miscoordination detection — it answers:
   * "did the right things trip in the right order?"
   */
  verifySequenceOfOperation() {
    const paths = this._buildProtectionPaths();
    if (paths.length === 0) {
      this._showSequenceResults(null, null, 'No source-to-load protection paths found. Connect utility/generator to protection devices.');
      return;
    }

    // Require fault results to know actual fault currents at each bus
    const fr = AppState.faultResults;
    if (!fr || !fr.buses || Object.keys(fr.buses).length === 0) {
      this._showSequenceResults(null, null, 'Run Fault Analysis first to provide fault currents at each bus.');
      return;
    }

    // Build adjacency for bus-to-device proximity mapping
    const adj = new Map();
    for (const [, w] of AppState.wires) {
      if (!adj.has(w.fromComponent)) adj.set(w.fromComponent, []);
      if (!adj.has(w.toComponent)) adj.set(w.toComponent, []);
      adj.get(w.fromComponent).push(w.toComponent);
      adj.get(w.toComponent).push(w.fromComponent);
    }

    // For each bus with fault results, find which protection paths cover it
    // A path "covers" a bus if the bus lies on the topological path between
    // the source and the load that the protection path protects.
    const busDeviceMap = this._mapBusesToProtectionDevices(paths, adj);

    const allBusResults = [];

    for (const [busId, busResult] of Object.entries(fr.buses)) {
      const faultCurrentA = (busResult.ik3 || 0) * 1000; // 3-phase fault in amps
      if (faultCurrentA <= 0) continue;

      const busName = busResult.bus_name || busId;
      const devicesOnPaths = busDeviceMap.get(busId);
      if (!devicesOnPaths || devicesOnPaths.length === 0) continue;

      // Compute trip time for each device at this fault current
      const deviceOps = [];
      for (const entry of devicesOnPaths) {
        const dev = entry.device;
        const tripTime = this._deviceTripTime(dev, faultCurrentA);
        deviceOps.push({
          device: dev,
          name: dev.name,
          deviceType: dev.deviceType,
          tripTime: tripTime,
          pathIndex: entry.pathIndex,
          positionInPath: entry.position,  // 0 = closest to source (upstream)
          pathLength: entry.pathLength,
          operates: isFinite(tripTime) && tripTime > 0,
        });
      }

      // Sort by expected sequence: primary (closest to fault / downstream) first
      // In a protection path [upstream, ..., downstream], higher position = closer to load
      // For a fault at a bus, the closest downstream device should trip first
      deviceOps.sort((a, b) => {
        // First by whether they operate at all (operating devices first)
        if (a.operates !== b.operates) return a.operates ? -1 : 1;
        // Then by trip time
        if (a.operates && b.operates) return a.tripTime - b.tripTime;
        return 0;
      });

      // Assign roles: primary (fastest), backup, final
      const operatingDevices = deviceOps.filter(d => d.operates);
      const failedDevices = deviceOps.filter(d => !d.operates);

      for (let i = 0; i < operatingDevices.length; i++) {
        if (i === 0) operatingDevices[i].role = 'primary';
        else if (i === operatingDevices.length - 1 && i > 0) operatingDevices[i].role = 'final';
        else operatingDevices[i].role = 'backup';
      }
      for (const d of failedDevices) {
        d.role = 'failed';
      }

      // Verify sequence — check for violations
      const violations = [];

      // 1. Check that primary is the most downstream device (closest to fault)
      if (operatingDevices.length > 0) {
        const primary = operatingDevices[0];
        // Find any device that is more downstream (higher position) but trips slower
        for (let i = 1; i < operatingDevices.length; i++) {
          const other = operatingDevices[i];
          if (other.positionInPath > primary.positionInPath && other.pathIndex === primary.pathIndex) {
            violations.push({
              type: 'out_of_sequence',
              severity: 'critical',
              message: `${primary.name} (${primary.role}) trips before ${other.name} — but ${other.name} is closer to the fault`,
              primaryDevice: primary.name,
              otherDevice: other.name,
              primaryTime: primary.tripTime,
              otherTime: other.tripTime,
            });
          }
        }
      }

      // 2. Check upstream-to-downstream ordering within each path
      const pathGroups = new Map();
      for (const d of operatingDevices) {
        if (!pathGroups.has(d.pathIndex)) pathGroups.set(d.pathIndex, []);
        pathGroups.get(d.pathIndex).push(d);
      }

      for (const [, devs] of pathGroups) {
        // Sort by position in path (upstream=0 to downstream=N)
        devs.sort((a, b) => a.positionInPath - b.positionInPath);

        for (let i = 0; i < devs.length - 1; i++) {
          const upstream = devs[i];
          const downstream = devs[i + 1];

          // Downstream should trip faster than upstream
          if (downstream.tripTime > upstream.tripTime) {
            violations.push({
              type: 'out_of_sequence',
              severity: 'critical',
              message: `${upstream.name} trips at ${this._fmtTime(upstream.tripTime)} before downstream ${downstream.name} at ${this._fmtTime(downstream.tripTime)}`,
              primaryDevice: upstream.name,
              otherDevice: downstream.name,
              primaryTime: upstream.tripTime,
              otherTime: downstream.tripTime,
            });
          } else if (Math.abs(downstream.tripTime - upstream.tripTime) < 0.01) {
            violations.push({
              type: 'simultaneous',
              severity: 'warning',
              message: `${upstream.name} and ${downstream.name} trip nearly simultaneously — race condition risk`,
              primaryDevice: upstream.name,
              otherDevice: downstream.name,
              primaryTime: upstream.tripTime,
              otherTime: downstream.tripTime,
            });
          }

          // Check grading margin between backup levels
          const margin = upstream.tripTime - downstream.tripTime;
          if (margin > 0 && margin < this.gradingMargin) {
            violations.push({
              type: 'insufficient_margin',
              severity: 'marginal',
              message: `Margin between ${downstream.name} and backup ${upstream.name}: ${(margin * 1000).toFixed(0)}ms < ${(this.gradingMargin * 1000).toFixed(0)}ms required`,
              primaryDevice: downstream.name,
              otherDevice: upstream.name,
              primaryTime: downstream.tripTime,
              otherTime: upstream.tripTime,
            });
          }
        }
      }

      // 3. Flag devices that fail to operate
      for (const d of failedDevices) {
        violations.push({
          type: 'failed_to_operate',
          severity: 'critical',
          message: `${d.name} does not operate at ${faultCurrentA >= 1000 ? (faultCurrentA / 1000).toFixed(1) + 'kA' : faultCurrentA + 'A'} — check pickup settings`,
          primaryDevice: d.name,
          otherDevice: null,
          primaryTime: Infinity,
          otherTime: null,
        });
      }

      allBusResults.push({
        busId,
        busName,
        faultCurrentA,
        sequence: [...operatingDevices, ...failedDevices],
        violations,
        passed: violations.length === 0,
      });
    }

    this._showSequenceResults(allBusResults, paths);
  },

  /**
   * Map each bus to the protection devices that would see a fault at that bus.
   * A device "sees" a fault if it lies on a protection path that passes through
   * or connects to the faulted bus.
   */
  _mapBusesToProtectionDevices(paths, adj) {
    const busDevMap = new Map(); // busId -> [{device, pathIndex, position, pathLength}]

    // For each protection path, find which buses lie along it
    // by checking all SLD components between the source and load
    for (let pi = 0; pi < paths.length; pi++) {
      const path = paths[pi];

      // Collect all buses that are adjacent to any device in this path
      const busesOnPath = new Set();
      for (const dev of path) {
        const neighbors = adj.get(dev.id) || [];
        for (const nId of neighbors) {
          const comp = AppState.components.get(nId);
          if (comp && comp.type === 'bus') {
            busesOnPath.add(nId);
          }
        }
        // Also check if any CT associated with the device is adjacent to a bus
        if (dev.associated_ct) {
          const ctNeighbors = adj.get(dev.associated_ct) || [];
          for (const nId of ctNeighbors) {
            const comp = AppState.components.get(nId);
            if (comp && comp.type === 'bus') {
              busesOnPath.add(nId);
            }
          }
        }
      }

      // For each bus on this path, all devices in the path can "see" it
      for (const busId of busesOnPath) {
        if (!busDevMap.has(busId)) busDevMap.set(busId, []);
        for (let pos = 0; pos < path.length; pos++) {
          const existing = busDevMap.get(busId);
          // Avoid duplicates for same device on same path
          if (!existing.some(e => e.device.id === path[pos].id && e.pathIndex === pi)) {
            existing.push({
              device: path[pos],
              pathIndex: pi,
              position: pos,
              pathLength: path.length,
            });
          }
        }
      }
    }

    return busDevMap;
  },

  _fmtTime(t) {
    if (!isFinite(t) || t <= 0) return 'N/A';
    if (t >= 1) return t.toFixed(2) + 's';
    return (t * 1000).toFixed(0) + 'ms';
  },

  _showSequenceResults(busResults, paths, errorMessage) {
    const resultsDiv = document.getElementById('tcc-seq-results');
    if (!resultsDiv) return;

    if (errorMessage) {
      resultsDiv.innerHTML = `<div class="tcc-coord-info">${errorMessage}</div>`;
      return;
    }

    if (!busResults || busResults.length === 0) {
      resultsDiv.innerHTML = '<div class="tcc-coord-info">No buses with fault results found on protection paths.</div>';
      return;
    }

    const totalViolations = busResults.reduce((s, b) => s + b.violations.length, 0);
    const passedBuses = busResults.filter(b => b.passed).length;

    let html = '';
    if (totalViolations === 0) {
      html = `<div class="tcc-coord-pass">All ${passedBuses} bus(es) verified — devices trip in correct primary → backup → final sequence.</div>`;
    } else {
      html = `<div class="tcc-seq-summary">Verified ${busResults.length} bus(es): <span class="tcc-seq-pass">${passedBuses} passed</span>, <span class="tcc-seq-fail">${busResults.length - passedBuses} failed</span> (${totalViolations} issue(s))</div>`;
    }

    const sevIcon = { critical: '\u26D4', warning: '\u26A0', marginal: '\u25B3' };
    const roleIcon = { primary: '\u2460', backup: '\u2461', final: '\u2462', failed: '\u2718' };
    const roleClass = { primary: 'tcc-role-primary', backup: 'tcc-role-backup', final: 'tcc-role-final', failed: 'tcc-role-failed' };

    for (const bus of busResults) {
      const faultStr = bus.faultCurrentA >= 1000
        ? (bus.faultCurrentA / 1000).toFixed(1) + ' kA'
        : bus.faultCurrentA + ' A';
      const statusCls = bus.passed ? 'tcc-bus-pass' : 'tcc-bus-fail';
      const statusIcon = bus.passed ? '\u2705' : '\u274C';

      html += `<div class="tcc-seq-bus ${statusCls}">`;
      html += `<div class="tcc-seq-bus-header">${statusIcon} <strong>${bus.busName}</strong> — Fault: ${faultStr}</div>`;

      // Show operation sequence
      html += '<div class="tcc-seq-timeline">';
      for (const op of bus.sequence) {
        const icon = roleIcon[op.role] || '';
        const cls = roleClass[op.role] || '';
        const timeStr = op.operates ? this._fmtTime(op.tripTime) : 'NO TRIP';
        html += `<span class="tcc-seq-device ${cls}" title="${op.deviceType}">${icon} ${op.name}: ${timeStr}</span>`;
        if (op !== bus.sequence[bus.sequence.length - 1]) {
          html += '<span class="tcc-seq-arrow">\u2192</span>';
        }
      }
      html += '</div>';

      // Show violations
      if (bus.violations.length > 0) {
        html += '<div class="tcc-seq-violations">';
        for (const v of bus.violations) {
          const icon = sevIcon[v.severity] || '';
          html += `<div class="tcc-seq-violation tcc-sev-${v.severity}">${icon} ${v.message}</div>`;
        }
        html += '</div>';
      }
      html += '</div>';
    }

    resultsDiv.innerHTML = html;
  },

  // ── Miscoordination Detection ──

  /**
   * Detect protection devices that won't trip in the correct sequence
   * for faults at each bus. Uses network topology to determine which device
   * should trip first (closest downstream device) and flags violations.
   */
  detectMiscoordination() {
    const paths = this._buildProtectionPaths();
    if (paths.length === 0) {
      this._showMiscoordResults('No source-to-load protection paths found.');
      return;
    }

    // Build test currents from fault results or defaults
    const testCurrents = new Set();
    const fr = AppState.faultResults;
    if (fr && fr.buses) {
      for (const [, bus] of Object.entries(fr.buses)) {
        if (bus.ik3) testCurrents.add(Math.round(bus.ik3 * 1000));
        if (bus.ik1) testCurrents.add(Math.round(bus.ik1 * 1000));
      }
    }
    if (testCurrents.size === 0) {
      // Use default test currents
      [500, 1000, 2000, 5000, 10000, 20000].forEach(i => testCurrents.add(i));
    }

    const violations = [];

    for (const path of paths) {
      // For each adjacent pair in the path (upstream first, downstream second)
      for (let i = 0; i < path.length - 1; i++) {
        const upstream = path[i];
        const downstream = path[i + 1];

        for (const testI of testCurrents) {
          const tUp = this._deviceTripTime(upstream, testI);
          const tDown = this._deviceTripTime(downstream, testI);

          if (!isFinite(tDown) || tDown <= 0) continue;
          if (!isFinite(tUp) || tUp <= 0) continue;

          // Violation: upstream trips before or same time as downstream
          if (tUp <= tDown) {
            violations.push({
              upstream: upstream.name,
              downstream: downstream.name,
              current: testI,
              tUpstream: tUp,
              tDownstream: tDown,
              severity: tUp < tDown * 0.9 ? 'critical' : 'warning',
              issue: tUp < tDown
                ? `${upstream.name} trips BEFORE ${downstream.name} — upstream will unnecessarily disconnect`
                : `${upstream.name} trips at SAME TIME as ${downstream.name} — race condition`,
            });
          } else if (tUp - tDown < this.gradingMargin) {
            violations.push({
              upstream: upstream.name,
              downstream: downstream.name,
              current: testI,
              tUpstream: tUp,
              tDownstream: tDown,
              severity: 'marginal',
              issue: `Insufficient margin: ${((tUp - tDown) * 1000).toFixed(0)}ms < ${(this.gradingMargin * 1000).toFixed(0)}ms required`,
            });
          }
        }
      }
    }

    // Deduplicate: keep worst violation per device pair
    const pairMap = new Map();
    for (const v of violations) {
      const key = `${v.upstream}|${v.downstream}`;
      const existing = pairMap.get(key);
      if (!existing || (v.severity === 'critical' && existing.severity !== 'critical') ||
          (v.severity === existing.severity && v.tUpstream < existing.tUpstream)) {
        pairMap.set(key, v);
      }
    }

    this._showMiscoordResults(null, [...pairMap.values()]);
  },

  _showCoordMessage(msg, type) {
    const resultsDiv = document.getElementById('tcc-coord-results');
    if (!resultsDiv) return;
    const cls = type === 'success' ? 'tcc-coord-pass' : 'tcc-coord-info';
    resultsDiv.innerHTML = `<div class="${cls}" style="white-space:pre-wrap">${msg}</div>`;
  },

  _showMiscoordResults(message, violations) {
    const resultsDiv = document.getElementById('tcc-coord-results');
    if (!resultsDiv) return;

    if (message) {
      resultsDiv.innerHTML = `<div class="tcc-coord-info">${message}</div>`;
      return;
    }

    if (!violations || violations.length === 0) {
      resultsDiv.innerHTML = '<div class="tcc-coord-pass">No miscoordination detected. All devices trip in correct upstream-to-downstream sequence.</div>';
      return;
    }

    const sevIcon = { critical: '\u26D4', warning: '\u26A0', marginal: '\u25B3' };
    const sevClass = { critical: 'tcc-sev-critical', warning: 'tcc-sev-warning', marginal: 'tcc-sev-marginal' };

    let html = `<div class="tcc-coord-title">Miscoordination: ${violations.length} issue(s) detected</div>`;
    html += '<table class="tcc-coord-table"><thead><tr><th>Sev.</th><th>Issue</th><th>At</th><th>Times</th></tr></thead><tbody>';
    for (const v of violations) {
      const fmtT = (t) => t >= 1 ? t.toFixed(2) + 's' : (t * 1000).toFixed(0) + 'ms';
      html += `<tr>
        <td class="${sevClass[v.severity] || ''}">${sevIcon[v.severity] || ''}</td>
        <td>${v.issue}</td>
        <td>${v.current >= 1000 ? (v.current / 1000).toFixed(1) + 'kA' : v.current + 'A'}</td>
        <td>\u2191${fmtT(v.tUpstream)} \u2193${fmtT(v.tDownstream)}</td>
      </tr>`;
    }
    html += '</tbody></table>';
    resultsDiv.innerHTML = html;
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
    container.innerHTML = this.tabs.map(tab => {
      const isCustom = tab.id.startsWith('custom_');
      const closeBtn = isCustom ? `<span class="tcc-tab-close" data-tab-id="${tab.id}" title="Delete tab">\u00D7</span>` : '';
      return `<button class="tcc-view-tab ${tab.id === this.activeTabId ? 'active' : ''}" data-tab-id="${tab.id}">${tab.name}${closeBtn}</button>`;
    }).join('') + '<button class="tcc-view-tab tcc-add-custom-tab" title="Add custom tab">+</button>';

    container.querySelectorAll('.tcc-view-tab:not(.tcc-add-custom-tab)').forEach(btn => {
      btn.addEventListener('click', (e) => {
        this.activeTabId = e.target.dataset.tabId;
        this._renderTabs();
        this._renderDeviceList();
        this.render();
        this._runCoordinationCheck();
        this._renderMiniSLD();
      });

      // Drop target: accept device drags onto tabs
      btn.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        btn.classList.add('tcc-drop-target');
      });
      btn.addEventListener('dragleave', () => {
        btn.classList.remove('tcc-drop-target');
      });
      btn.addEventListener('drop', (e) => {
        e.preventDefault();
        btn.classList.remove('tcc-drop-target');
        const devIdx = parseInt(e.dataTransfer.getData('text/plain'));
        const targetTabId = btn.dataset.tabId;
        if (!isNaN(devIdx) && targetTabId && this.devices[devIdx]) {
          this.moveDeviceToTab(devIdx, targetTabId);
        }
      });
    });
    // Delete custom tabs
    container.querySelectorAll('.tcc-tab-close').forEach(span => {
      span.addEventListener('click', (e) => {
        e.stopPropagation();
        const tabId = span.dataset.tabId;
        this._deleteTab(tabId);
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

  _deleteTab(tabId) {
    const idx = this.tabs.findIndex(t => t.id === tabId);
    if (idx < 0) return;
    // Reassign devices on this tab back to their voltage tab or null
    for (const dev of this.devices) {
      if (dev.tabId === tabId) {
        dev.tabId = dev.voltage_kv ? `v_${dev.voltage_kv}` : null;
      }
    }
    this.tabs.splice(idx, 1);
    // Switch to 'all' if deleted tab was active
    if (this.activeTabId === tabId) {
      this.activeTabId = 'all';
    }
    this._renderTabs();
    this._renderDeviceList();
    this.render();
    this._runCoordinationCheck();
    this._renderMiniSLD();
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

  // ══════════════════════════════════════════════════════════════════════════
  // ── Mini SLD Panel — vertical protection-path diagram alongside TCC ──
  // ══════════════════════════════════════════════════════════════════════════

  _miniSLDCollapsed: false,
  _miniSLDEndpointDeviceIdx: -1,  // TCC device index chosen as furthest downstream grading point

  _initMiniSLD() {
    const toggle = document.getElementById('btn-tcc-mini-sld-toggle');
    if (toggle) {
      toggle.addEventListener('click', () => {
        this._miniSLDCollapsed = !this._miniSLDCollapsed;
        const panel = document.getElementById('tcc-mini-sld');
        if (panel) panel.classList.toggle('collapsed', this._miniSLDCollapsed);
        toggle.textContent = this._miniSLDCollapsed ? '\u203A' : '\u2039';
        localStorage.setItem('protectionpro-tcc-mini-sld-collapsed', this._miniSLDCollapsed ? '1' : '0');
        // Re-render TCC chart since chart area size changed
        requestAnimationFrame(() => this.render());
      });
      // Restore collapsed state
      if (localStorage.getItem('protectionpro-tcc-mini-sld-collapsed') === '1') {
        this._miniSLDCollapsed = true;
        const panel = document.getElementById('tcc-mini-sld');
        if (panel) panel.classList.add('collapsed');
        toggle.textContent = '\u203A';
      }
    }
  },

  /**
   * Build the full path of components (not just protection devices) from source
   * to load, for rendering in the mini-SLD. Returns an array of nodes:
   * [{ compId, comp, tccDevice, tccDevIndex, voltage_kv, rating }]
   */
  _buildMiniSLDPaths() {
    const wires = AppState.wires;
    if (!wires || wires.size === 0) return [];

    // Build adjacency
    const adj = new Map();
    for (const [, w] of wires) {
      if (!adj.has(w.fromComponent)) adj.set(w.fromComponent, []);
      if (!adj.has(w.toComponent)) adj.set(w.toComponent, []);
      adj.get(w.fromComponent).push(w.toComponent);
      adj.get(w.toComponent).push(w.fromComponent);
    }

    // Find sources
    const sources = [];
    for (const [id, comp] of AppState.components) {
      if (comp.type === 'utility' || comp.type === 'generator') sources.push(id);
    }
    if (sources.length === 0) return [];

    // Map SLD IDs to TCC device objects and indices
    const tccDevMap = new Map();
    for (let i = 0; i < this.devices.length; i++) {
      tccDevMap.set(this.devices[i].id, { dev: this.devices[i], idx: i });
    }

    // Types we want to show in the mini-SLD
    const showTypes = new Set([
      'utility', 'generator', 'bus', 'transformer', 'cb', 'fuse', 'relay',
      'cable', 'static_load', 'motor_induction', 'motor_synchronous',
      'ct', 'solar_pv', 'wind_turbine', 'capacitor_bank'
    ]);

    // DFS from each source, collecting ALL relevant components
    const allPaths = [];
    for (const srcId of sources) {
      const stack = [{ node: srcId, visited: new Set([srcId]), path: [] }];
      while (stack.length > 0) {
        const { node, visited, path } = stack.pop();
        const comp = AppState.components.get(node);
        if (!comp) continue;

        let currentPath = [...path];
        if (showTypes.has(comp.type)) {
          const tccEntry = tccDevMap.get(node);
          const vkv = comp.props?.voltage_kv || this._resolveDeviceVoltage(node);
          currentPath.push({
            compId: node,
            comp,
            tccDevice: tccEntry?.dev || null,
            tccDevIndex: tccEntry?.idx ?? -1,
            voltage_kv: vkv,
            rating: this._getMiniSLDRating(comp, tccEntry?.dev),
          });
        }

        const neighbors = adj.get(node) || [];
        const isLoad = comp.type === 'static_load' || comp.type === 'motor_induction' || comp.type === 'motor_synchronous';
        const unvisitedNeighbors = neighbors.filter(n => !visited.has(n));

        if ((isLoad || unvisitedNeighbors.length === 0) && currentPath.length >= 2) {
          allPaths.push(currentPath);
        }

        for (const next of unvisitedNeighbors) {
          const newVisited = new Set(visited);
          newVisited.add(next);
          stack.push({ node: next, visited: newVisited, path: currentPath });
        }
      }
    }

    return allPaths;
  },

  /** Get a concise rating string for a component */
  _getMiniSLDRating(comp, tccDev) {
    const p = comp.props || {};
    switch (comp.type) {
      case 'utility':
        return p.fault_level_mva ? `${p.fault_level_mva} MVA` : '';
      case 'generator':
        return p.mva_rating ? `${p.mva_rating} MVA` : '';
      case 'bus':
        return p.voltage_kv ? `${p.voltage_kv} kV` : '';
      case 'transformer':
        return p.mva_rating ? `${p.mva_rating} MVA` : (p.kva_rating ? `${p.kva_rating} kVA` : '');
      case 'cb':
        return p.rated_current_a ? `${p.rated_current_a} A` : '';
      case 'fuse':
        return p.fuse_rating_a ? `${p.fuse_rating_a} A` : '';
      case 'relay': {
        if (tccDev) return `${tccDev.pickup || ''}A, TDS ${tccDev.tds || ''}`;
        return p.pickup_a ? `${p.pickup_a} A` : '';
      }
      case 'cable':
        return p.cable_size_mm2 ? `${p.cable_size_mm2} mm\u00B2` : '';
      case 'static_load':
        return p.kw ? `${p.kw} kW` : '';
      case 'motor_induction':
      case 'motor_synchronous':
        return p.kw_rating ? `${p.kw_rating} kW` : '';
      case 'ct':
        return p.ct_ratio ? `${p.ct_ratio}` : '';
      case 'solar_pv':
        return p.kw_peak ? `${p.kw_peak} kWp` : '';
      case 'wind_turbine':
        return p.kw_rated ? `${p.kw_rated} kW` : '';
      default:
        return '';
    }
  },

  /** Render the mini-SLD panel with vertical component strip */
  _renderMiniSLD() {
    const svg = document.getElementById('tcc-mini-sld-svg');
    const content = document.getElementById('tcc-mini-sld-content');
    if (!svg || !content) return;

    const allPaths = this._buildMiniSLDPaths();
    if (allPaths.length === 0) {
      content.innerHTML = '<div class="tcc-mini-sld-empty">No protection path found.<br>Connect sources to protection devices and loads.</div>';
      return;
    }

    // Filter paths by active tab
    let paths = allPaths;
    const activeTab = this.tabs.find(t => t.id === this.activeTabId);
    if (activeTab && activeTab.isVoltageTab && activeTab.voltage_kv) {
      // Filter to paths that contain at least one device at this voltage
      paths = allPaths.filter(path =>
        path.some(n => n.tccDevice && Math.abs((n.voltage_kv || 0) - activeTab.voltage_kv) < 0.01)
      );
      if (paths.length === 0) paths = allPaths;
    }

    // Pick the best path for display
    let displayPath = paths[0];

    if (this._miniSLDEndpointDeviceIdx >= 0 && this._miniSLDEndpointDeviceIdx < this.devices.length) {
      // Grading endpoint set — find path containing that device and truncate to it
      const endpointId = this.devices[this._miniSLDEndpointDeviceIdx].id;
      for (const p of paths) {
        const endIdx = p.findIndex(n => n.compId === endpointId);
        if (endIdx >= 0) {
          displayPath = p.slice(0, endIdx + 1);
          break;
        }
      }
      // If no path contains it, fall through to longest
      if (displayPath === paths[0] && !paths[0].some(n => n.compId === endpointId)) {
        for (const p of paths) {
          if (p.length > displayPath.length) displayPath = p;
        }
      }
    } else {
      // No endpoint — pick longest path
      for (const p of paths) {
        if (p.length > displayPath.length) displayPath = p;
      }
    }

    // Merge branch points: if other paths share a prefix, note branch-off points
    const branches = [];
    for (const p of paths) {
      if (p === displayPath) continue;
      // Find where this path diverges from the display path
      let divergeIdx = 0;
      while (divergeIdx < Math.min(p.length, displayPath.length) &&
             p[divergeIdx].compId === displayPath[divergeIdx].compId) {
        divergeIdx++;
      }
      if (divergeIdx > 0 && divergeIdx < p.length) {
        branches.push({ fromIdx: divergeIdx - 1, branchNodes: p.slice(divergeIdx) });
      }
    }

    // Layout constants
    const nodeSpacing = 65;
    const nodeSize = 28;
    const centerX = 90;
    const startY = 25;
    const svgWidth = 180;
    const mainHeight = startY + displayPath.length * nodeSpacing + 10;

    // Also render up to 2 branch arms
    let branchSvg = '';
    const maxBranches = Math.min(branches.length, 2);

    const totalHeight = mainHeight;

    svg.setAttribute('viewBox', `0 0 ${svgWidth} ${totalHeight}`);
    svg.setAttribute('width', svgWidth);
    svg.setAttribute('height', totalHeight);
    content.innerHTML = '';
    content.appendChild(svg);

    let svgContent = '';

    // Draw main path
    for (let i = 0; i < displayPath.length; i++) {
      const node = displayPath[i];
      const y = startY + i * nodeSpacing;

      // Connecting wire to next node
      if (i < displayPath.length - 1) {
        const ny = startY + (i + 1) * nodeSpacing;
        svgContent += `<line x1="${centerX}" y1="${y + nodeSize / 2 + 2}" x2="${centerX}" y2="${ny - nodeSize / 2 - 2}" stroke="var(--text-muted)" stroke-width="1.5"/>`;
      }

      // Branch indicators
      for (let bi = 0; bi < maxBranches; bi++) {
        const b = branches[bi];
        if (b.fromIdx === i) {
          const bx = centerX + 40;
          svgContent += `<line x1="${centerX + nodeSize / 2}" y1="${y}" x2="${bx}" y2="${y}" stroke="var(--text-muted)" stroke-width="1" stroke-dasharray="3,2"/>`;
          svgContent += `<text x="${bx + 3}" y="${y + 3}" font-size="8" fill="var(--text-muted)">+${b.branchNodes.length}</text>`;
        }
      }

      // Node group
      const isSelected = node.tccDevIndex >= 0 && node.tccDevIndex === this.selectedDeviceIndex;
      const isHidden = node.tccDevice && !node.tccDevice.visible;
      const curveColor = node.tccDevice ? node.tccDevice.color : null;
      const classes = ['tcc-mini-sld-node'];
      if (isSelected) classes.push('mini-sld-selected');
      if (isHidden) classes.push('mini-sld-hidden');

      svgContent += `<g class="${classes.join(' ')}" data-comp-id="${node.compId}" data-tcc-idx="${node.tccDevIndex}">`;

      // Highlight rect for selected state
      if (isSelected) {
        svgContent += `<rect class="mini-sld-highlight" x="${centerX - nodeSize / 2 - 4}" y="${y - nodeSize / 2 - 4}" width="${nodeSize + 8}" height="${nodeSize + 8}" rx="4"/>`;
      }

      // Color accent bar for TCC devices
      if (curveColor) {
        svgContent += `<rect x="${centerX - nodeSize / 2 - 6}" y="${y - nodeSize / 2 + 2}" width="3" height="${nodeSize - 4}" rx="1" fill="${curveColor}"/>`;
      }

      // Symbol
      svgContent += this._miniSLDSymbol(node.comp.type, centerX, y, nodeSize, node.comp);

      // Name label (left)
      const name = node.comp.props?.name || node.compId;
      const truncName = name.length > 12 ? name.substring(0, 11) + '\u2026' : name;
      svgContent += `<text x="${centerX - nodeSize / 2 - 10}" y="${y + 1}" font-size="9" fill="var(--text-primary)" text-anchor="end" font-weight="500">${this._escSvg(truncName)}</text>`;

      // Rating label (right)
      if (node.rating) {
        const truncRating = node.rating.length > 14 ? node.rating.substring(0, 13) + '\u2026' : node.rating;
        svgContent += `<text x="${centerX + nodeSize / 2 + 10}" y="${y + 1}" font-size="8" fill="var(--text-muted)" font-weight="400">${this._escSvg(truncRating)}</text>`;
      }

      // Invisible hit area for click
      svgContent += `<rect x="0" y="${y - nodeSpacing / 2}" width="${svgWidth}" height="${nodeSpacing}" fill="transparent" style="cursor:pointer"/>`;

      svgContent += '</g>';
    }

    svg.innerHTML = svgContent;

    // Bind click events
    svg.querySelectorAll('.tcc-mini-sld-node').forEach(g => {
      g.addEventListener('click', (e) => {
        const tccIdx = parseInt(g.dataset.tccIdx);
        if (tccIdx >= 0) {
          this.selectDevice(tccIdx);
          this._renderMiniSLD();
        }
      });
    });

    // Update footer with endpoint info
    const footer = document.getElementById('tcc-mini-sld-footer');
    if (footer) {
      if (this._miniSLDEndpointDeviceIdx >= 0 && this._miniSLDEndpointDeviceIdx < this.devices.length) {
        const epDev = this.devices[this._miniSLDEndpointDeviceIdx];
        footer.innerHTML = `<div class="mini-sld-endpoint-label">
          <span>\u21E5 ${this._escSvg(epDev.name)}</span>
          <button class="mini-sld-endpoint-clear" title="Clear endpoint">\u2715</button>
        </div>`;
        footer.querySelector('.mini-sld-endpoint-clear').addEventListener('click', () => {
          this._miniSLDEndpointDeviceIdx = -1;
          this._renderDeviceList();
          this._renderMiniSLD();
        });
        footer.style.display = '';
      } else {
        footer.innerHTML = '';
        footer.style.display = 'none';
      }
    }
  },

  /** Generate a simplified IEC symbol SVG for the mini-SLD */
  _miniSLDSymbol(type, cx, cy, size, comp) {
    const s = size / 2;
    const r = s * 0.8;
    switch (type) {
      case 'utility':
        return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--text-primary)" stroke-width="1.5"/>` +
               `<text x="${cx}" y="${cy + 3}" font-size="10" text-anchor="middle" fill="var(--text-primary)">~</text>`;
      case 'generator':
        return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--text-primary)" stroke-width="1.5"/>` +
               `<text x="${cx}" y="${cy + 3}" font-size="9" text-anchor="middle" fill="var(--text-primary)" font-weight="600">G</text>`;
      case 'solar_pv':
        return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--text-primary)" stroke-width="1.5"/>` +
               `<text x="${cx}" y="${cy + 3}" font-size="8" text-anchor="middle" fill="var(--text-primary)">PV</text>`;
      case 'wind_turbine':
        return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--text-primary)" stroke-width="1.5"/>` +
               `<text x="${cx}" y="${cy + 3}" font-size="8" text-anchor="middle" fill="var(--text-primary)">WT</text>`;
      case 'bus':
        return `<rect x="${cx - s * 1.2}" y="${cy - 2}" width="${s * 2.4}" height="4" fill="var(--text-primary)" rx="1"/>`;
      case 'transformer': {
        const ro = r * 0.7;
        return `<circle cx="${cx}" cy="${cy - ro * 0.45}" r="${ro}" fill="none" stroke="var(--text-primary)" stroke-width="1.3"/>` +
               `<circle cx="${cx}" cy="${cy + ro * 0.45}" r="${ro}" fill="none" stroke="var(--text-primary)" stroke-width="1.3"/>`;
      }
      case 'cb':
        return `<rect x="${cx - s * 0.6}" y="${cy - s * 0.6}" width="${s * 1.2}" height="${s * 1.2}" fill="none" stroke="var(--text-primary)" stroke-width="1.3" rx="1"/>` +
               `<line x1="${cx - s * 0.35}" y1="${cy - s * 0.35}" x2="${cx + s * 0.35}" y2="${cy + s * 0.35}" stroke="var(--text-primary)" stroke-width="1.2"/>` +
               `<line x1="${cx + s * 0.35}" y1="${cy - s * 0.35}" x2="${cx - s * 0.35}" y2="${cy + s * 0.35}" stroke="var(--text-primary)" stroke-width="1.2"/>`;
      case 'fuse':
        return `<rect x="${cx - s * 0.35}" y="${cy - s * 0.7}" width="${s * 0.7}" height="${s * 1.4}" fill="none" stroke="var(--text-primary)" stroke-width="1.3" rx="2"/>` +
               `<line x1="${cx}" y1="${cy - s * 0.4}" x2="${cx}" y2="${cy + s * 0.4}" stroke="var(--text-primary)" stroke-width="1.2"/>`;
      case 'relay':
        return `<rect x="${cx - s * 0.6}" y="${cy - s * 0.6}" width="${s * 1.2}" height="${s * 1.2}" fill="none" stroke="var(--text-primary)" stroke-width="1.3" rx="2"/>` +
               `<text x="${cx}" y="${cy + 3}" font-size="9" text-anchor="middle" fill="var(--text-primary)" font-weight="600">R</text>`;
      case 'cable':
        return `<line x1="${cx - s * 0.8}" y1="${cy}" x2="${cx + s * 0.8}" y2="${cy}" stroke="var(--text-primary)" stroke-width="1.5" stroke-dasharray="4,2"/>`;
      case 'ct':
        return `<circle cx="${cx}" cy="${cy}" r="${r * 0.5}" fill="none" stroke="var(--text-primary)" stroke-width="1.2"/>` +
               `<circle cx="${cx}" cy="${cy}" r="${r * 0.3}" fill="var(--text-primary)"/>`;
      case 'static_load':
        return `<polygon points="${cx},${cy - r * 0.8} ${cx + r * 0.7},${cy + r * 0.5} ${cx - r * 0.7},${cy + r * 0.5}" fill="none" stroke="var(--text-primary)" stroke-width="1.3"/>`;
      case 'motor_induction':
      case 'motor_synchronous':
        return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--text-primary)" stroke-width="1.5"/>` +
               `<text x="${cx}" y="${cy + 3}" font-size="9" text-anchor="middle" fill="var(--text-primary)" font-weight="600">M</text>`;
      case 'capacitor_bank':
        return `<line x1="${cx - s * 0.5}" y1="${cy - 3}" x2="${cx + s * 0.5}" y2="${cy - 3}" stroke="var(--text-primary)" stroke-width="2"/>` +
               `<line x1="${cx - s * 0.5}" y1="${cy + 3}" x2="${cx + s * 0.5}" y2="${cy + 3}" stroke="var(--text-primary)" stroke-width="2"/>`;
      default:
        return `<circle cx="${cx}" cy="${cy}" r="${r * 0.5}" fill="var(--text-muted)" stroke="none"/>`;
    }
  },

  _escSvg(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },
};
