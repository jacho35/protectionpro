/**
 * ReticTcc — mini time-current plot for the Reticulation › Demand earth-fault
 * check. For one string breaker it draws the device's own curve (the same
 * cbTripTime / fuseTripTime models the TCC and the backend check use) and puts
 * every erf of the string on it at its calculated minimum earth-fault current
 * and the time that current takes to clear. Read-only: it plots what
 * /retic-earth-check returned (AppState.reticResults.earth), it never solves.
 */
const ReticTcc = {
  W: 600, H: 420, X0: 60, X1: 600, Y0: 20, Y1: 380,
  T_MIN: 0.01, T_MAX: 1000,
  COLORS: ['var(--accent)', '#7b1fa2', '#00838f', '#ef6c00', '#5d4037', '#c2185b'],

  open(headId) {
    const modal = this._ensure();
    const d = this._data(headId);
    modal.querySelector('#rtcc-title').textContent = d
      ? (d.devices.length > 1 ? 'Earth-fault check — breaker curves vs fault current'
        : `Earth-fault check — ${d.device.name} vs fault current`) : 'Earth-fault check';
    modal.querySelector('#rtcc-body').innerHTML = d ? this._render(d)
      : '<div class="rtcc-empty">Select the string breaker and run the Demand calculation to see its curve against each erf\'s earth-fault current.</div>';
    modal.style.display = '';
  },

  close() {
    const m = document.getElementById('retic-tcc-modal');
    if (m) m.style.display = 'none';
  },

  _ensure() {
    let m = document.getElementById('retic-tcc-modal');
    if (m) return m;
    m = document.createElement('div');
    m.id = 'retic-tcc-modal';
    m.className = 'modal';
    m.setAttribute('role', 'dialog');
    m.setAttribute('aria-modal', 'true');
    m.setAttribute('aria-labelledby', 'rtcc-title');
    m.style.display = 'none';
    m.innerHTML = `<div class="modal-content modal-wide">
      <div class="modal-header"><h3 id="rtcc-title"></h3>
        <button class="modal-close" data-rtcc="close" aria-label="Close">&times;</button></div>
      <div class="modal-body" id="rtcc-body"></div></div>`;
    document.body.appendChild(m);
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.closest('[data-rtcc="close"]')) this.close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && m.style.display !== 'none') this.close();
    });
    return m;
  },

  // ─── Data ───
  _data(headId) {
    const head = Retic.kioskById(headId);
    const earth = AppState.reticResults && AppState.reticResults.earth;
    const device = head ? Retic._protectionDevice(head) : null;
    if (!head || !earth || !device) return null;
    const strKiosks = Retic.kiosks.filter(k => Retic._stringHead(k) === head);
    const inString = new Set(strKiosks.map(k => k.id));
    const devices = [{ name: device.name, device, color: this.COLORS[0] }];
    const rows = [];
    let tAllow = 5, ia = null;
    for (const kr of earth.kiosks) {
      if (!inString.has(kr.kioskId)) continue;
      const kiosk = strKiosks.find(k => k.id === kr.kioskId);
      for (const e of kr.erfs) {
        const l = e.loop;
        if (!l || l.ifA == null) continue;
        tAllow = l.tAllowS || tAllow;
        // The erf's own way (or its kiosk's default), else the string breaker.
        const erfObj = kiosk && kiosk.erfs.find(x => x.id === e.erfId);
        const ed = kiosk && erfObj ? Retic._erfDevice(kiosk, erfObj).device : null;
        let dv = devices[0];
        if (ed) {
          dv = devices.find(x => x.name === ed.name);
          if (!dv) { dv = { name: ed.name, device: ed, color: this.COLORS[devices.length % this.COLORS.length] }; devices.push(dv); }
        }
        if (dv === devices[0] && l.iaA != null) ia = l.iaA;
        rows.push({ kiosk: kr.name || '', erf: e.erfNumber || e.erfId, ifA: l.ifA, tS: l.tS, ok: l.status === 'pass', dev: dv });
      }
    }
    if (!rows.length) return null;
    return { device, devices, rows, tAllow, ia, strSize: inString.size };
  },

  _rating(device) {
    const p = device.props || {};
    return device.kind === 'fuse' ? Number(p.rated_current_a) || 0 : Number(p.trip_rating_a) || 0;
  },

  // Total clearing time of the device at I amps; Infinity = does not operate.
  _time(device, I) {
    const p = device.props || {};
    if (device.kind === 'fuse') {
      const t = fuseTripTime(Number(p.rated_current_a), I);
      if (t == null || t === Infinity) return Infinity;
      return Math.max(t * 1.2, 0.004);          // total clearing, as the backend check
    }
    return cbTripTime(p, I);
  },

  // Currents worth a sample of their own: where the curve steps.
  _steps(device) {
    const p = device.props || {};
    if (device.kind === 'fuse') return [];
    const ir = (Number(p.trip_rating_a) || 0) * (Number(p.thermal_pickup) || 1);
    const out = [ir * (Number(p.magnetic_pickup) || 10)];
    if (typeof cbHasElectronicTrip === 'function' && cbHasElectronicTrip(p)) {
      if (p.short_time_pickup > 0) out.push(p.short_time_pickup * ir);
      if (p.instantaneous_pickup > 0) out.push(p.instantaneous_pickup * ir);
    }
    return out.filter(v => v > 0);
  },

  // ─── Plot ───
  _render(d) {
    const ratings = d.devices.map(v => this._rating(v.device)).filter(v => v > 0);
    const ifs = d.rows.map(r => r.ifA).filter(v => v > 0);
    const steps = d.devices.flatMap(v => this._steps(v.device));
    const lo = Math.min(...ratings.map(r => r * 0.5), Math.min(...ifs) * 0.7);
    const hi = Math.max(Math.max(...ifs) * 1.3, ...steps.map(s => s * 1.5), Math.max(...ratings) * 4);
    const dec0 = Math.floor(Math.log10(lo)), dec1 = Math.ceil(Math.log10(hi));
    const xmin = Math.pow(10, dec0), xmax = Math.pow(10, Math.max(dec1, dec0 + 1));
    const lx = Math.log10(xmin), span = Math.log10(xmax) - lx;
    const X = (i) => this.X0 + (this.X1 - this.X0) * (Math.log10(i) - lx) / span;
    const lt0 = Math.log10(this.T_MIN), ltSpan = Math.log10(this.T_MAX) - lt0;
    const Y = (t) => this.Y0 + (this.Y1 - this.Y0) * (1 - (Math.log10(Math.min(Math.max(t, this.T_MIN), this.T_MAX)) - lt0) / ltSpan);
    const f = (n) => n.toFixed(1);
    const fmtI = (v) => v >= 1000 ? (v / 1000 % 1 === 0 ? (v / 1000) + 'k' : (v / 1000).toFixed(1) + 'k') : String(v);

    // Grid + ticks
    let grid = '', ticks = '';
    for (let dpow = Math.log10(xmin); dpow < Math.log10(xmax) + 1e-9; dpow++) {
      const base = Math.pow(10, Math.round(dpow));
      for (let m = 1; m <= 9; m++) {
        const v = base * m;
        if (v > xmax * 1.0001) break;
        const x = f(X(v));
        grid += `<path class="${m === 1 ? 'rtcc-major' : 'rtcc-minor'}" d="M${x} ${this.Y0}V${this.Y1}"/>`;
      }
      if (base <= xmax) ticks += `<text class="rtcc-tick" x="${f(X(base))}" y="${this.Y1 + 18}" text-anchor="middle">${fmtI(base)}</text>`;
    }
    for (let p = -2; p <= 3; p++) {
      const y = f(Y(Math.pow(10, p)));
      grid += `<path class="rtcc-major" d="M${this.X0} ${y}H${this.X1}"/>`;
      ticks += `<text class="rtcc-tick" x="${this.X0 - 6}" y="${(+y + 4).toFixed(1)}" text-anchor="end">${Math.pow(10, p)}</text>`;
    }

    // Device curve: dense log samples + both sides of every step.
    const N = 240;
    const curveFor = (dev) => {
      const pts = [];
      for (let n = 0; n <= N; n++) pts.push(xmin * Math.pow(xmax / xmin, n / N));
      this._steps(dev).forEach(s => { if (s > xmin && s < xmax) { pts.push(s * 0.9999, s); } });
      pts.sort((a, b) => a - b);
      let path = '', pen = false;
      for (const I of pts) {
        const t = this._time(dev, I);
        if (!(t <= this.T_MAX)) { pen = false; continue; }      // not operating / off the top
        path += `${pen ? 'L' : 'M'}${f(X(I))} ${f(Y(t))}`;
        pen = true;
      }
      return path;
    };
    const curves = d.devices.map((v, i) =>
      `<path class="rtcc-curve" style="stroke:${v.color}${i ? ';stroke-dasharray:none' : ''}" d="${curveFor(v.device)}"><title>${escHtml(v.name)}</title></path>`).join('');

    // Erf points
    let marks = '';
    for (const r of d.rows) {
      const clears = r.tS != null;
      const x = X(r.ifA), y = clears ? Y(r.tS) : this.Y0;
      const tip = `${r.kiosk ? r.kiosk + ' · ' : ''}${r.erf}: ${Math.round(r.ifA)} A, `
        + (clears ? `clears in ${r.tS < 1 ? r.tS.toFixed(3) : r.tS.toFixed(1)} s` : 'does not clear');
      marks += r.ok
        ? `<circle class="rtcc-pass" cx="${f(x)}" cy="${f(y)}" r="5"><title>${escHtml(tip)}</title></circle>`
        : `<path class="rtcc-fail" d="M${f(x - 4)} ${f(y - 4)}L${f(x + 4)} ${f(y + 4)}M${f(x + 4)} ${f(y - 4)}L${f(x - 4)} ${f(y + 4)}"><title>${escHtml(tip)}</title></path>`;
    }

    const yLim = f(Y(d.tAllow));
    const iaLine = d.devices.length === 1 && d.ia && d.ia > xmin && d.ia < xmax
      ? `<path class="rtcc-ia" d="M${f(X(d.ia))} ${this.Y0}V${this.Y1}"/>`
        + `<text class="rtcc-note" x="${f(X(d.ia) - 5)}" y="${this.Y0 + 14}" text-anchor="end">Ia ${Math.round(d.ia).toLocaleString('en-US')} A — smallest current that clears in ${d.tAllow} s</text>` : '';

    const svg = `<svg class="rtcc-plot" viewBox="0 0 ${this.W} ${this.H}" width="${this.W}" height="${this.H}" role="img"
        aria-label="Time-current plot of ${escHtml(d.devices.map(v => v.name).join(', '))} with the earth-fault current of each erf marked">
      <rect class="rtcc-frame" x="${this.X0}" y="${this.Y0}" width="${this.X1 - this.X0}" height="${this.Y1 - this.Y0}"/>
      ${grid}${ticks}
      <text class="rtcc-axis" x="${(this.X0 + this.X1) / 2}" y="${this.H - 4}" text-anchor="middle">Earth-fault current (A)</text>
      <text class="rtcc-axis" x="14" y="${(this.Y0 + this.Y1) / 2}" text-anchor="middle" transform="rotate(-90 14 ${(this.Y0 + this.Y1) / 2})">Clearing time (s)</text>
      <path class="rtcc-limit" d="M${this.X0} ${yLim}H${this.X1}"/>
      <text class="rtcc-limit-t" x="${this.X1 - 4}" y="${(+yLim - 6).toFixed(1)}" text-anchor="end">${d.tAllow} s limit (IEC 60364-4-41)</text>
      ${iaLine}
      ${curves}
      ${marks}
    </svg>`;

    const sorted = d.rows.slice().sort((a, b) => (a.ok - b.ok) || (a.ifA - b.ifA));
    const nOk = d.rows.filter(r => r.ok).length;
    const tFmt = (t) => t == null ? 'does not clear' : (t < 1 ? t.toFixed(3) : t.toFixed(1)) + ' s';
    const multi = d.devices.length > 1;
    const rowsHtml = sorted.map(r => `<tr class="${r.ok ? '' : 'rtcc-bad'}">
        <td>${escHtml(r.kiosk ? r.kiosk + ' · ' : '')}${escHtml(String(r.erf))}${multi ? `<br><span class="rtcc-dev" style="color:${r.dev.color}">${escHtml(r.dev.name)}</span>` : ''}</td>
        <td class="num">${Math.round(r.ifA).toLocaleString('en-US')} A</td>
        <td class="num">${tFmt(r.tS)}</td>
        <td class="${r.ok ? 'rtcc-ok-t' : 'rtcc-fail-t'}">${r.ok ? '✓ pass' : '✕ fail'}</td></tr>`).join('');

    const specOf = (dev) => {
      const r = this._rating(dev), q = dev.props || {};
      return dev.kind === 'fuse'
        ? `${r} A fuse, total clearing = pre-arcing × 1.2`
        : `In ${r} A · Ir ${Math.round(r * (Number(q.thermal_pickup) || 1))} A · Im ${Math.round(r * (Number(q.thermal_pickup) || 1) * (Number(q.magnetic_pickup) || 10))} A · class ${Number(q.long_time_delay) || 10}`;
    };
    const spec = multi ? `${d.devices.length} protective devices (string breaker + outgoing ways)` : specOf(d.device);
    const devLegend = multi ? `<div class="rtcc-devs">${d.devices.map((v, i) =>
      `<div><i class="rtcc-sw" style="background:${v.color}"></i><b>${escHtml(v.name)}</b> <span>${i === 0 ? 'string breaker · ' : 'outgoing way · '}${escHtml(specOf(v.device))}</span></div>`).join('')}</div>` : '';

    return `<div class="rtcc">
      <div class="rtcc-sub">${escHtml(spec)} · protects ${d.strSize} kiosk${d.strSize === 1 ? '' : 's'} · ${nOk} of ${d.rows.length} erven clear within ${d.tAllow} s</div>
      <div class="rtcc-grid">
        <div class="rtcc-plotwrap">${svg}</div>
        <div class="rtcc-side">
          ${devLegend}
          <div class="rtcc-legend"><span><i class="rtcc-dot"></i> Clears within ${d.tAllow} s</span><span><b class="rtcc-x">×</b> Too slow / won't clear</span></div>
          <div class="rtcc-tablewrap"><table class="rtcc-table">
            <thead><tr><th>Erf</th><th class="num">Fault current</th><th class="num">Clears in</th><th>Result</th></tr></thead>
            <tbody>${rowsHtml}</tbody></table></div>
        </div>
      </div>
      <div class="rtcc-foot">If = 0.95 · 230 V / |Zs| (minimum current, conductors hot). Each erf is plotted on the curve of the device that protects its service cable (its own pick, else the kiosk default, else the string breaker); curves are the library models; no discrimination between devices in series is checked.</div>
    </div>`;
  },
};
