/* ProtectionPro — Time-Current Curve (TCC) Chart Engine
 *
 * Renders a log-log TCC chart on an HTML5 canvas with:
 *   - IDMT relay curves (IEC 60255 / IEEE C37.112)
 *   - gG fuse pre-arcing curves (IEC 60269)
 *   - Automatic coordination / grading margin checks
 *   - Interactive device list with add/remove/highlight
 */

const TCC = {
  // Chart configuration
  canvas: null,
  ctx: null,
  devices: [],   // Array of { id, name, type, color, visible, ... }

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

  // ── Initialisation ──

  init() {
    this.canvas = document.getElementById('tcc-canvas');
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext('2d');
    this._bindEvents();
  },

  _bindEvents() {
    // Resize observer to keep canvas sharp
    const container = this.canvas.parentElement;
    const ro = new ResizeObserver(() => this.render());
    ro.observe(container);

    // Tooltip on hover
    this.canvas.addEventListener('mousemove', (e) => this._handleHover(e));
    this.canvas.addEventListener('mouseleave', () => {
      this._tooltip = null;
      this.render();
    });
  },

  // ── Open the TCC modal ──

  open() {
    this.devices = [];
    this.colorIndex = 0;
    this._loadDevicesFromNetwork();
    document.getElementById('tcc-modal').style.display = '';
    // Defer render to let the modal layout settle
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this.render();
        this._renderDeviceList();
        this._runCoordinationCheck();
      });
    });
  },

  close() {
    document.getElementById('tcc-modal').style.display = 'none';
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
            fuseRating: nearestRating,
            actualRating: ratingA,
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

    // Compute plot area
    this.plotLeft = 70;
    this.plotTop = 30;
    this.plotRight = w - 20;
    this.plotBottom = h - 40;
    this.plotWidth = this.plotRight - this.plotLeft;
    this.plotHeight = this.plotBottom - this.plotTop;

    // Background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);

    this._drawGrid(ctx);
    this._drawAxes(ctx);

    // Draw each device curve
    for (const dev of this.devices) {
      if (!dev.visible) continue;
      if (dev.deviceType === 'relay') this._drawRelayCurve(ctx, dev);
      else if (dev.deviceType === 'fuse') this._drawFuseCurve(ctx, dev);
    }

    // Draw tooltip
    if (this._tooltip) {
      this._drawTooltip(ctx, this._tooltip);
    }

    // Title
    ctx.fillStyle = '#333';
    ctx.font = 'bold 13px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Time-Current Characteristic (TCC)', w / 2, 18);
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
    // Sample current from pickup to 100x pickup
    const iStart = dev.pickup * 1.05; // Just above pickup
    const iEnd = Math.min(dev.pickup * 100, this.currentMax);
    const steps = 200;

    for (let i = 0; i <= steps; i++) {
      const logI = Math.log10(iStart) + (Math.log10(iEnd) - Math.log10(iStart)) * (i / steps);
      const current = Math.pow(10, logI);
      const M = current / dev.pickup;
      const t = idmtTripTime(dev.curveName, M, dev.tds);

      if (t <= 0 || !isFinite(t) || t > this.timeMax || t < this.timeMin) continue;

      const x = this._currentToX(current);
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
    const px = this._currentToX(dev.pickup);
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
      const lx = this._currentToX(labelI);
      const ly = this._timeToY(labelT);
      if (lx > this.plotLeft && lx < this.plotRight - 50) {
        ctx.fillStyle = dev.color;
        ctx.font = 'bold 10px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(dev.name, lx + 6, ly - 4);
      }
    }
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
      if (current < this.currentMin || current > this.currentMax) continue;
      if (time < this.timeMin || time > this.timeMax) continue;
      const x = this._currentToX(current);
      const y = this._timeToY(time);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Label near middle of curve
    const midIdx = Math.floor(points.length / 2);
    const [mI, mT] = points[midIdx];
    if (mI >= this.currentMin && mI <= this.currentMax && mT >= this.timeMin && mT <= this.timeMax) {
      const lx = this._currentToX(mI);
      const ly = this._timeToY(mT);
      ctx.fillStyle = dev.color;
      ctx.font = 'bold 10px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`${dev.name} (${dev.fuseRating}A)`, lx + 6, ly - 4);
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

    const current = this._xToCurrent(mx);
    const lines = [];
    for (const dev of this.devices) {
      if (!dev.visible) continue;
      let t = null;
      if (dev.deviceType === 'relay') {
        const M = current / dev.pickup;
        t = idmtTripTime(dev.curveName, M, dev.tds);
      } else if (dev.deviceType === 'fuse') {
        t = fuseTripTime(dev.fuseRating, current);
      }
      if (t != null && isFinite(t) && t > 0 && t <= this.timeMax) {
        lines.push({ name: dev.name, time: t, color: dev.color });
      }
    }

    if (lines.length > 0) {
      this._tooltip = { x: mx, y: my, current, lines };
    } else {
      this._tooltip = null;
    }
    this.render();
  },

  _drawTooltip(ctx, tip) {
    const lines = [`${tip.current.toFixed(1)} A`];
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

    if (this.devices.length === 0) {
      list.innerHTML = '<div class="tcc-no-devices">No overcurrent relays (50/51) or fuses in the network.<br>Add relays or fuses to the SLD to see their curves.</div>';
      return;
    }

    list.innerHTML = this.devices.map((dev, i) => {
      const typeLabel = dev.deviceType === 'relay'
        ? `${dev.curveName} | Pickup: ${dev.pickup}A | TDS: ${dev.tds}`
        : `gG Fuse ${dev.fuseRating}A`;
      return `<div class="tcc-device-item ${dev.visible ? '' : 'tcc-hidden'}" data-index="${i}">
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
        const idx = parseInt(e.target.dataset.index);
        this.devices[idx].visible = !this.devices[idx].visible;
        this._renderDeviceList();
        this.render();
        this._runCoordinationCheck();
      });
    });
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
    }
    return Infinity;
  },

  // ── Export TCC chart as PNG ──

  exportPNG() {
    if (!this.canvas) return;
    this.canvas.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${AppState.projectName || 'tcc'}_chart.png`;
      a.click();
      URL.revokeObjectURL(url);
    }, 'image/png');
  },
};
