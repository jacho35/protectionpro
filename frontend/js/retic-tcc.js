/**
 * ReticTcc — mini time-current plot for the Reticulation › Demand earth-fault
 * check. For one string breaker it draws the device's own curve (the same
 * cbTripTime / fuseTripTime models the TCC and the backend check use) and puts
 * every erf of the string on it at its calculated minimum earth-fault current
 * and the time that current takes to clear. Read-only: it plots what
 * /retic-earth-check returned (AppState.reticResults.earth), it never solves.
 *
 * View controls (kept for the session): show all points / kiosk feeders only /
 * erven only, the cable adiabatic withstand lines (t = k²S²/I² of each leg's
 * weakest earth-fault conductor, from the check's `withstand`), and a cursor
 * that reads the curves at any current (hover, or tap/drag on a touch screen;
 * click or Pin holds it, the slider moves it). Min / Max arrows mark the
 * lowest and highest fault current among the points shown. Export PDF prints
 * the plot exactly as displayed.
 */
const ReticTcc = {
  W: 600, H: 440, X0: 60, X1: 590, Y0: 44, Y1: 394,
  T_MIN: 0.01, T_MAX: 1000,
  ADIABATIC_S: 5,
  COLORS: ['var(--accent)', '#7b1fa2', '#00838f', '#ef6c00', '#5d4037', '#c2185b'],
  CABLE_COLORS: ['#00897b', '#c2185b', '#6d4c41', '#455a64', '#8e24aa', '#e65100'],
  MIN_COLOR: '#9a3412',
  MAX_COLOR: '#6d28d9',

  view: { filter: 'all', i2t: true },
  _cur: { i: null, pinned: false, drag: false },
  _headId: null,
  _d: null,
  _g: null,

  open(headId) {
    const modal = this._ensure();
    this._headId = headId;
    this._cur = { i: null, pinned: false, drag: false };
    const d = this._d = this._data(headId);
    modal.querySelector('#rtcc-title').textContent = d
      ? (d.devices.length > 1 ? 'Earth-fault check — breaker curves vs fault current'
        : `Earth-fault check — ${d.device.name} vs fault current`) : 'Earth-fault check';
    modal.querySelector('#rtcc-pdf').style.display = d ? '' : 'none';
    this._paint();
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
    m.innerHTML = `<div class="modal-content modal-wide rtcc-modal">
      <div class="modal-header"><h3 id="rtcc-title"></h3>
        <button class="btn-small rtcc-pdf" id="rtcc-pdf" data-rtcc="pdf">Export PDF</button>
        <button class="modal-close" data-rtcc="close" aria-label="Close">&times;</button></div>
      <div class="modal-body" id="rtcc-body"></div></div>`;
    document.body.appendChild(m);
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.closest('[data-rtcc="close"]')) { this.close(); return; }
      if (e.target.closest('[data-rtcc="pdf"]')) { this.exportPdf(); return; }
      const f = e.target.closest('[data-rtcc-filter]');
      if (f && !f.disabled) { this.view.filter = f.dataset.rtccFilter; this._paint(); return; }
      if (e.target.closest('[data-rtcc="i2t"]')) { this.view.i2t = !this.view.i2t; this._paint(); return; }
      if (e.target.closest('[data-rtcc="pin"]')) {
        this._cur.pinned = !this._cur.pinned;
        if (this._cur.i == null) this._cur.i = this._g ? this._g.iMid : null;
        this._drawCursor();
      }
    });
    m.addEventListener('input', (e) => {
      if (!e.target.matches('#rtcc-slider') || !this._g) return;
      const g = this._g;
      this._cur.i = Math.pow(10, g.lx + g.span * Number(e.target.value) / 1000);
      this._cur.pinned = true;
      this._drawCursor();
    });
    // Cursor on the plot: a mouse follows the pointer (click pins), a finger or
    // pen sets it where it touches and drags it sideways (pan-y keeps the page
    // scrolling vertically).
    const atPointer = (e) => {
      const svg = e.target.ownerSVGElement, g = this._g;
      if (!svg || !g) return null;
      const r = svg.getBoundingClientRect();
      const sx = (e.clientX - r.left) * this.W / r.width;
      return g.Iof(Math.min(Math.max(sx, this.X0), this.X1));
    };
    m.addEventListener('pointermove', (e) => {
      if (!e.target.matches('.rtcc-hit')) return;
      if (e.pointerType === 'mouse' ? this._cur.pinned : !this._cur.drag) return;
      this._cur.i = atPointer(e);
      this._drawCursor();
    });
    m.addEventListener('pointerdown', (e) => {
      if (!e.target.matches('.rtcc-hit')) return;
      this._lastPtr = e.pointerType;
      if (e.pointerType === 'mouse') return;
      this._cur = { i: atPointer(e), pinned: true, drag: true };
      this._drawCursor();
    });
    const endDrag = () => { this._cur.drag = false; };
    m.addEventListener('pointerup', endDrag);
    m.addEventListener('pointercancel', endDrag);
    m.addEventListener('pointerout', (e) => {
      if (!e.target.matches('.rtcc-hit') || e.pointerType !== 'mouse' || this._cur.pinned) return;
      this._cur.i = null;
      this._drawCursor();
    });
    m.addEventListener('click', (e) => {
      if (!e.target.matches('.rtcc-hit') || (this._lastPtr && this._lastPtr !== 'mouse')) return;
      this._cur.pinned = !this._cur.pinned;
      this._cur.i = atPointer(e);
      this._drawCursor();
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
    const cables = [];
    // One withstand line per distinct conductor (size, metal, k).
    const cableOf = (w, use) => {
      if (!w || !(w.k2s2 > 0)) return null;
      const label = `${w.sizeMm2} mm² ${w.metal} ${w.conductor === 'PEN' ? 'PEN' : w.conductor === 'earth' ? 'earth' : (w.ins || '')}`.trim();
      let c = cables.find(x => x.k2s2 === w.k2s2 && x.label === label);
      if (!c) {
        c = { label, short: `${w.sizeMm2} ${w.metal}`, k: w.k, k2s2: w.k2s2, uses: new Set(),
          color: this.CABLE_COLORS[cables.length % this.CABLE_COLORS.length] };
        cables.push(c);
      }
      c.uses.add(use);
      return c;
    };
    const rows = [];
    let tAllow = 5, ia = null;
    for (const kr of earth.kiosks) {
      if (!inString.has(kr.kioskId)) continue;
      const kiosk = strKiosks.find(k => k.id === kr.kioskId);
      // The kiosk's feeder (the LV cable from the string breaker): loop current
      // at the far end of that cable, cleared by the string breaker.
      const kl = kr.loop;
      if (kl && kl.ifA != null && kl.status !== 'info') {
        tAllow = kl.tAllowS || tAllow;
        if (kl.iaA != null) ia = kl.iaA;
        rows.push({ kiosk: kr.name || '', erf: 'feeder cable', feeder: true, ifA: kl.ifA, tS: kl.tS, ok: kl.status === 'pass',
          dev: devices[0], cable: cableOf(kl.withstand, 'kiosk feeder') });
      }
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
        rows.push({ kiosk: kr.name || '', erf: e.erfNumber || e.erfId, ifA: l.ifA, tS: l.tS, ok: l.status === 'pass', dev: dv,
          cable: cableOf(l.withstand, 'service cable') });
      }
    }
    if (!rows.length) return null;
    rows.forEach((r, i) => {
      r.id = i;
      r.tC = r.cable ? r.cable.k2s2 / (r.ifA * r.ifA) : null;          // cable withstand at this current
      r.cableOk = r.cable ? (r.tS != null && r.tS <= r.tC) : null;
    });
    return { device, devices, cables, rows, tAllow, ia, strSize: inString.size };
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
    // each element at its own reference current (Ir, or In — cbElementsA)
    const e = cbElementsA(p);
    return [e.im, e.isd, e.ii].filter(v => v > 0);
  },

  // What the current view shows: the filtered rows and the cables they use.
  _shown(d) {
    const f = this.view.filter;
    const rows = d.rows.filter(r => f === 'all' || (f === 'kiosks' ? r.feeder : !r.feeder));
    const cables = this.view.i2t ? d.cables.filter(c => rows.some(r => r.cable === c)) : [];
    return { rows, cables };
  },

  _fmtA(v) { return Math.round(v).toLocaleString('en-US') + ' A'; },
  _fmtAShort(v) { return v >= 1000 ? (v / 1000).toFixed(2).replace(/\.?0+$/, '') + ' kA' : Math.round(v) + ' A'; },
  _fmtT(t) { return t == null || t === Infinity ? 'does not clear' : (t < 1 ? t.toFixed(3) : t >= 100 ? Math.round(t) : t.toFixed(1)) + ' s'; },
  _filterName() {
    return { all: 'All kiosks and erven', kiosks: 'Kiosk feeders only', erven: 'Erven only' }[this.view.filter];
  },

  // ─── Plot ───
  // Axis scaling + the static layers (grid, limits, curves, cable lines, points,
  // min/max arrows). The cursor is drawn separately into <g class="rtcc-cur">.
  _geometry(d) {
    const ratings = d.devices.map(v => this._rating(v.device)).filter(v => v > 0);
    const ifs = d.rows.map(r => r.ifA).filter(v => v > 0);
    const steps = d.devices.flatMap(v => this._steps(v.device));
    const lo = Math.min(...ratings.map(r => r * 0.5), Math.min(...ifs) * 0.7);
    const hi = Math.max(Math.max(...ifs) * 1.3, ...steps.map(s => s * 1.5), Math.max(...ratings) * 4);
    const dec0 = Math.floor(Math.log10(lo)), dec1 = Math.ceil(Math.log10(hi));
    const xmin = Math.pow(10, dec0), xmax = Math.pow(10, Math.max(dec1, dec0 + 1));
    const lx = Math.log10(xmin), span = Math.log10(xmax) - lx;
    const X = (i) => this.X0 + (this.X1 - this.X0) * (Math.log10(i) - lx) / span;
    const Iof = (x) => Math.pow(10, lx + span * (x - this.X0) / (this.X1 - this.X0));
    const lt0 = Math.log10(this.T_MIN), ltSpan = Math.log10(this.T_MAX) - lt0;
    const Y = (t) => this.Y0 + (this.Y1 - this.Y0) * (1 - (Math.log10(Math.min(Math.max(t, this.T_MIN), this.T_MAX)) - lt0) / ltSpan);
    return { xmin, xmax, lx, span, X, Iof, Y, iMid: Math.pow(10, lx + span / 2) };
  },

  _plotSvg(d, g, sh) {
    const { xmin, xmax, X, Y } = g;
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
    grid += `<path class="rtcc-major" d="M${this.X1} ${this.Y0}V${this.Y1}"/>`;
    for (let p = -2; p <= 3; p++) {
      const y = f(Y(Math.pow(10, p)));
      grid += `<path class="rtcc-major" d="M${this.X0} ${y}H${this.X1}"/>`;
      ticks += `<text class="rtcc-tick" x="${this.X0 - 6}" y="${(+y + 4).toFixed(1)}" text-anchor="end">${Math.pow(10, p)}</text>`;
    }

    // Device curve: dense log samples + both sides of every step.
    const N = 240;
    const samples = (dev) => {
      const pts = [];
      for (let n = 0; n <= N; n++) pts.push(xmin * Math.pow(xmax / xmin, n / N));
      this._steps(dev).forEach(s => { if (s > xmin && s < xmax) { pts.push(s * 0.9999, s); } });
      return pts.sort((a, b) => a - b);
    };
    const curveFor = (dev) => {
      let path = '', pen = false;
      for (const I of samples(dev)) {
        const t = this._time(dev, I);
        if (!(t <= this.T_MAX)) { pen = false; continue; }      // not operating / off the top
        path += `${pen ? 'L' : 'M'}${f(X(I))} ${f(Y(t))}`;
        pen = true;
      }
      return path;
    };
    // A manufacturer's breaker carries its published tolerance band: shade it from the fastest to the slowest trip time and
    // dash the fastest edge. The solid line stays the slowest edge, the time the breaker is guaranteed to have cleared by.
    const bandFor = (v) => {
      const dev = v.device;
      if (dev.kind === 'fuse' || !(dev.props && dev.props.trip_tol)) return '';
      const up = [], dn = [];
      let fast = '', pen = false;
      for (const I of samples(dev)) {
        const b = cbTripBand(dev.props, I);
        if (!(b.tMax <= this.T_MAX)) { pen = false; continue; }          // slow edge off the top: no band here
        const tMin = Math.min(b.tMin, b.tMax);
        up.push([X(I), Y(b.tMax)]); dn.push([X(I), Y(tMin)]);
        fast += `${pen ? 'L' : 'M'}${f(X(I))} ${f(Y(tMin))}`; pen = true;
      }
      if (up.length < 2) return '';
      const edge = (a) => a.map(q => f(q[0]) + ' ' + f(q[1])).join('L');
      return `<path d="M${edge(up)}L${edge(dn.slice().reverse())}Z" fill="${v.color}" fill-opacity=".16" stroke="none"/>`
        + `<path class="rtcc-curve" style="stroke:${v.color};stroke-width:1.4;stroke-dasharray:5 3" d="${fast}"><title>${escHtml(v.name)}: fastest it may trip</title></path>`;
    };
    const banded = d.devices.some(v => bandFor(v));
    const curves = d.devices.map((v, i) =>
      bandFor(v) + `<path class="rtcc-curve" style="stroke:${v.color}${i ? ';stroke-dasharray:none' : ''}" d="${curveFor(v.device)}"><title>${escHtml(v.name)}${banded && v.device.props && v.device.props.trip_tol ? ': slowest it may trip (clearing time)' : ''}</title></path>`).join('');

    // Cable adiabatic withstand t = k²S²/I²: straight in log-log; solid up to
    // 5 s, dotted beyond where the adiabatic assumption no longer holds.
    const clipI = (I) => Math.min(Math.max(I, xmin), xmax);
    const labels = [];
    let cableLines = sh.cables.map(c => {
      const tAt = (I) => c.k2s2 / (I * I);
      const seg = (a, b) => b > a ? `M${f(X(a))} ${f(Y(tAt(a)))}L${f(X(b))} ${f(Y(tAt(b)))}` : '';
      const i5 = clipI(Math.sqrt(c.k2s2 / this.ADIABATIC_S));
      const iEnd = clipI(Math.sqrt(c.k2s2 / this.T_MIN));
      const solid = seg(i5, iEnd);
      const dot = seg(clipI(Math.sqrt(c.k2s2 / this.T_MAX)), i5);
      // Label just inside where the line leaves the frame (right edge or bottom).
      if (tAt(iEnd) <= this.T_MAX) labels.push({ c, x: X(iEnd) - 6, y: Y(tAt(iEnd)) - 6 });
      const tip = `${c.label} withstand: k²S² = ${Math.round(c.k2s2).toLocaleString('en-US')} A²s`;
      return (solid ? `<path class="rtcc-cable" style="stroke:${c.color}" d="${solid}"><title>${escHtml(tip)}</title></path>` : '')
        + (dot ? `<path class="rtcc-cable-dot" style="stroke:${c.color}" d="${dot}"><title>${escHtml(tip)} (beyond 5 s the adiabatic assumption no longer holds)</title></path>` : '');
    }).join('');
    // Keep labels that end up near each other from overprinting: step them up.
    labels.sort((a, b) => b.y - a.y);
    labels.forEach((l, i) => {
      for (const o of labels.slice(0, i)) if (Math.abs(o.x - l.x) < 70 && l.y > o.y - 14) l.y = o.y - 14;
      l.y = Math.max(l.y, this.Y0 + 12);
      cableLines += `<text class="rtcc-cable-t" style="fill:${l.c.color}" x="${f(l.x)}" y="${f(l.y)}" text-anchor="end">${escHtml(l.c.short)}</text>`;
    });

    // Points
    const ring = (x, y, r) => `M${f(x - r)} ${f(y)}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
    let marks = '';
    for (const r of sh.rows) {
      const clears = r.tS != null;
      const x = X(r.ifA), y = clears ? Y(r.tS) : this.Y0;
      const tip = `${r.kiosk ? r.kiosk + ' · ' : ''}${r.erf}: ${Math.round(r.ifA)} A, `
        + (clears ? `clears in ${this._fmtT(r.tS)}` : 'does not clear')
        + (this.view.i2t && r.cable ? `; ${r.cable.label} withstands ${this._fmtT(r.tC)}` : '');
      if (this.view.i2t && r.cableOk === false) {
        marks += `<path class="rtcc-i2t-ring" d="${ring(x, y, 9.5)}"><title>${escHtml(r.erf)}: ${escHtml(r.cable.label)} withstands only ${this._fmtT(r.tC)}</title></path>`;
      }
      if (r.feeder) {
        const x0 = f(x), y0 = f(y);
        const dia = `M${x0} ${f(y - 6)}L${f(x + 6)} ${y0}L${x0} ${f(y + 6)}L${f(x - 6)} ${y0}Z`;
        marks += `<path class="${r.ok ? 'rtcc-fpass' : 'rtcc-ffail'}" d="${dia}"><title>${escHtml(tip)}</title></path>`;
        continue;
      }
      marks += r.ok
        ? `<circle class="rtcc-pass" cx="${f(x)}" cy="${f(y)}" r="5"><title>${escHtml(tip)}</title></circle>`
        : `<path class="rtcc-fail" d="M${f(x - 4)} ${f(y - 4)}L${f(x + 4)} ${f(y + 4)}M${f(x + 4)} ${f(y - 4)}L${f(x - 4)} ${f(y + 4)}"><title>${escHtml(tip)}</title></path>`;
    }

    // Min / max fault current of what is shown: arrows above the frame.
    let range = '';
    if (sh.rows.length) {
      const iMin = Math.min(...sh.rows.map(r => r.ifA)), iMax = Math.max(...sh.rows.map(r => r.ifA));
      const xa = X(iMin), xb = X(iMax), close = xb - xa < 120;
      const tri = (x) => `M${f(x - 6)} ${this.Y0 - 15}L${f(x + 6)} ${this.Y0 - 15}L${f(x)} ${this.Y0 - 3}Z`;
      range = `<rect class="rtcc-range" x="${f(xa)}" y="${this.Y0}" width="${f(Math.max(xb - xa, 0.5))}" height="${this.Y1 - this.Y0}"/>`
        + `<path class="rtcc-range-b" d="M${f(xa)} ${this.Y0 - 11}H${f(xb)}"/>`
        + `<path style="stroke:${this.MIN_COLOR}" class="rtcc-range-l" d="M${f(xa)} ${this.Y0}V${this.Y1}"/>`
        + `<path style="fill:${this.MIN_COLOR}" d="${tri(xa)}"><title>Minimum fault current shown: ${this._fmtA(iMin)}</title></path>`
        + `<text class="rtcc-range-t" style="fill:${this.MIN_COLOR}" x="${f(xa)}" y="${this.Y0 - 22}" text-anchor="${close ? 'end' : 'middle'}">Min ${this._fmtA(iMin)}</text>`;
      if (iMax > iMin) {
        range += `<path style="stroke:${this.MAX_COLOR}" class="rtcc-range-l" d="M${f(xb)} ${this.Y0}V${this.Y1}"/>`
          + `<path style="fill:${this.MAX_COLOR}" d="${tri(xb)}"><title>Maximum fault current shown: ${this._fmtA(iMax)}</title></path>`
          + `<text class="rtcc-range-t" style="fill:${this.MAX_COLOR}" x="${f(xb)}" y="${this.Y0 - 22}" text-anchor="${close ? 'start' : 'middle'}">Max ${this._fmtA(iMax)}</text>`;
      }
    }

    const yLim = f(Y(d.tAllow));
    const iaLine = d.devices.length === 1 && d.ia && d.ia > xmin && d.ia < xmax
      ? `<path class="rtcc-ia" d="M${f(X(d.ia))} ${this.Y0}V${this.Y1}"/>`
        + `<text class="rtcc-note" x="${f(X(d.ia) - 5)}" y="${this.Y1 - 8}" text-anchor="end">Ia ${Math.round(d.ia).toLocaleString('en-US')} A</text>` : '';

    return `<svg xmlns="http://www.w3.org/2000/svg" class="rtcc-plot" viewBox="0 0 ${this.W} ${this.H}" width="${this.W}" height="${this.H}" role="img"
        aria-label="Time-current plot of ${escHtml(d.devices.map(v => v.name).join(', '))} with the earth-fault current of each point marked">
      <rect class="rtcc-frame" x="${this.X0}" y="${this.Y0}" width="${this.X1 - this.X0}" height="${this.Y1 - this.Y0}"/>
      ${grid}${ticks}
      <text class="rtcc-axis" x="${(this.X0 + this.X1) / 2}" y="${this.H - 4}" text-anchor="middle">Earth-fault current (A)</text>
      <text class="rtcc-axis" x="14" y="${(this.Y0 + this.Y1) / 2}" text-anchor="middle" transform="rotate(-90 14 ${(this.Y0 + this.Y1) / 2})">Clearing time (s)</text>
      <path class="rtcc-limit" d="M${this.X0} ${yLim}H${this.X1}"/>
      <text class="rtcc-limit-t" x="${this.X1 - 4}" y="${(+yLim - 6).toFixed(1)}" text-anchor="end">${d.tAllow} s limit (IEC 60364-4-41)</text>
      ${iaLine}
      ${range}
      ${cableLines}
      ${curves}
      ${marks}
      <g class="rtcc-cur" pointer-events="none">${this._cursorSvg(d, g, sh)}</g>
      <rect class="rtcc-hit" x="${this.X0}" y="${this.Y0}" width="${this.X1 - this.X0}" height="${this.Y1 - this.Y0}" fill="transparent"/>
    </svg>`;
  },

  // The point nearest the cursor (within a few px), else null.
  _near(g, sh) {
    if (this._cur.i == null) return null;
    let best = this._cur.drag ? 14 : 9, near = null;
    for (const r of sh.rows) {
      const dx = Math.abs(g.X(r.ifA) - g.X(this._cur.i));
      if (dx < best) { best = dx; near = r; }
    }
    return near;
  },

  _cursorSvg(d, g, sh) {
    const I = this._cur.i;
    if (I == null) return '';
    const { X, Y } = g;
    const f = (n) => n.toFixed(1);
    const fs = window.matchMedia && window.matchMedia('(max-width: 640px)').matches ? 1.4 : 1;   // larger text on a phone
    const lh = 16 * fs, bw = 214 * fs;
    const x = X(I), main = d.devices[0];
    const t0 = this._time(main.device, I), on = t0 <= this.T_MAX, y = on ? Y(t0) : this.Y0;
    const lines = [{ txt: `I = ${this._fmtA(I)}${this._cur.pinned ? '  · pinned' : ''}`, cls: 'rtcc-cbox-h' }];
    let dots = '';
    d.devices.forEach((v, i) => {
      const t = i ? this._time(v.device, I) : t0;
      const name = d.devices.length > 1 ? v.name : 'Breaker';
      lines.push({ txt: t === Infinity ? `${name} does not trip` : `${name} trips in ${this._fmtT(t)}${i ? '' : (t <= d.tAllow ? ` (within ${d.tAllow} s)` : ` (over ${d.tAllow} s)`)}`,
        color: d.devices.length > 1 ? v.color : null });
      if (i && t <= this.T_MAX) dots += `<circle class="rtcc-cdot" style="stroke:${v.color}" cx="${f(x)}" cy="${f(Y(t))}" r="4"/>`;
    });
    sh.cables.slice(0, 4).forEach(c => {
      const tc = c.k2s2 / (I * I);
      lines.push({ txt: `${c.short} withstands ${this._fmtT(tc)}${t0 <= tc ? ' ✓' : ' ✕'}`, color: c.color, bold: true });
      if (tc >= this.T_MIN && tc <= this.T_MAX) dots += `<circle class="rtcc-cdot" style="stroke:${c.color}" cx="${f(x)}" cy="${f(Y(tc))}" r="3.5"/>`;
    });
    if (sh.cables.length > 4) lines.push({ txt: `+ ${sh.cables.length - 4} more cables` });
    const near = this._near(g, sh);
    if (near) {
      const good = near.ok && !(this.view.i2t && near.cableOk === false);
      lines.push({ txt: `${near.kiosk ? near.kiosk + ' · ' : ''}${near.erf} — ${this._fmtA(near.ifA)} ${good ? '✓' : '✕'}`,
        cls: good ? 'rtcc-cbox-ok' : 'rtcc-cbox-bad' });
    }
    const bh = 10 * fs + lines.length * lh;
    const bx = x + 12 + bw > this.X1 ? Math.max(x - 12 - bw, 2) : x + 12;
    const by = Math.min(Math.max(y - bh - 10, this.Y0 + 4), this.Y1 - bh - 4);
    const text = lines.map((l, i) => `<text class="rtcc-cbox-t ${l.cls || ''}" x="${f(8 * fs)}" y="${f(10 * fs + (i + 0.75) * lh)}"${l.color ? ` style="fill:${l.color}"` : ''}${l.bold ? ' font-weight="600"' : ''}>${escHtml(l.txt)}</text>`).join('');
    const tagW = 66, xTag = Math.min(Math.max(x - tagW / 2, this.X0 - 20), this.X1 - tagW + 20);
    return `<path class="rtcc-cline${this._cur.pinned ? ' rtcc-pinned' : ''}" d="M${f(x)} ${this.Y0}V${this.Y1}"/>`
      + (on ? `<path class="rtcc-cline rtcc-pinned" style="stroke-dasharray:3 3" d="M${this.X0} ${f(y)}H${f(x)}"/>`
        + `<rect class="rtcc-ctag" x="2" y="${f(y - 9)}" width="56" height="18" rx="3"/>`
        + `<text class="rtcc-ctag-t" x="30" y="${f(y + 4)}" text-anchor="middle">${this._fmtT(t0)}</text>` : '')
      + (near ? `<path class="rtcc-near" d="M${f(X(near.ifA) - 12)} ${f(near.tS != null ? Y(near.tS) : this.Y0)}a12 12 0 1 0 24 0a12 12 0 1 0 -24 0"/>` : '')
      + dots
      + (on ? `<circle class="rtcc-cdot" style="stroke:${main.color}" cx="${f(x)}" cy="${f(y)}" r="4.5"/>` : '')
      + `<rect class="rtcc-ctag" x="${f(xTag)}" y="${this.Y1 + 4}" width="${tagW}" height="18" rx="3"/>`
      + `<text class="rtcc-ctag-t" x="${f(xTag + tagW / 2)}" y="${this.Y1 + 17}" text-anchor="middle">${this._fmtAShort(I)}</text>`
      + `<g transform="translate(${f(bx)} ${f(by)})"><rect class="rtcc-cbox" width="${f(bw)}" height="${f(bh)}" rx="5"/>${text}</g>`;
  },

  // Redraw the cursor layer, the slider, Pin and the highlighted table row.
  _drawCursor() {
    const m = document.getElementById('retic-tcc-modal');
    const d = this._d, g = this._g;
    if (!m || !d || !g) return;
    const sh = this._shown(d);
    const layer = m.querySelector('.rtcc-cur');
    if (layer) layer.innerHTML = this._cursorSvg(d, g, sh);
    const sl = m.querySelector('#rtcc-slider');
    if (sl) sl.value = String(Math.round(1000 * (Math.log10(this._cur.i != null ? this._cur.i : g.iMid) - g.lx) / g.span));
    const pin = m.querySelector('[data-rtcc="pin"]');
    if (pin) { pin.textContent = this._cur.pinned ? 'Unpin' : 'Pin'; pin.setAttribute('aria-pressed', String(this._cur.pinned)); }
    const near = this._near(g, sh);
    m.querySelectorAll('.rtcc-table tr[data-rid]').forEach(tr => tr.classList.toggle('rtcc-near-row', !!near && tr.dataset.rid === String(near.id)));
  },

  _paint() {
    const body = document.querySelector('#retic-tcc-modal #rtcc-body');
    if (!body) return;
    const d = this._d;
    if (!d) {
      body.innerHTML = '<div class="rtcc-empty">Select the string breaker and run the Demand calculation to see its curve against each erf\'s earth-fault current.</div>';
      return;
    }
    const counts = { all: d.rows.length, kiosks: d.rows.filter(r => r.feeder).length, erven: d.rows.filter(r => !r.feeder).length };
    if (!counts[this.view.filter]) this.view.filter = 'all';
    this._g = this._geometry(d);
    body.innerHTML = this._render(d, counts);
    this._drawCursor();
  },

  _specOf(dev) {
    const r = this._rating(dev), q = dev.props || {};
    return dev.kind === 'fuse'
      ? `${r} A fuse, total clearing = pre-arcing × 1.2`
      : `In ${r} A · Ir ${Math.round(r * (Number(q.thermal_pickup) || 1))} A · Im ${Math.round(r > 0 ? cbElementsA({ ...q, trip_rating_a: r }).im : 0)} A · class ${Number(q.long_time_delay) || 10}`;
  },

  _summary(d, sh) {
    const erfRows = d.rows.filter(r => !r.feeder);
    const nOk = erfRows.filter(r => r.ok).length;
    const multi = d.devices.length > 1;
    const spec = multi ? `${d.devices.length} protective devices (string breaker + outgoing ways)` : this._specOf(d.device);
    const nBad = sh.rows.filter(r => r.cableOk === false).length;
    return `${spec} · protects ${d.strSize} kiosk${d.strSize === 1 ? '' : 's'} · ${nOk} of ${erfRows.length} erven clear within ${d.tAllow} s`
      + (this.view.i2t && d.cables.length ? ` · ${nBad ? nBad + ' cable' + (nBad === 1 ? '' : 's') + ' not protected (I²t)' : 'every cable shown protected (I²t)'}` : '');
  },

  _render(d, counts) {
    const g = this._g, sh = this._shown(d), i2t = this.view.i2t;
    const svg = this._plotSvg(d, g, sh);
    const multi = d.devices.length > 1;
    const hasCable = d.cables.length > 0;
    const sorted = sh.rows.slice().sort((a, b) => ((a.ok && a.cableOk !== false) - (b.ok && b.cableOk !== false)) || (a.ifA - b.ifA));
    const iMin = sh.rows.length ? Math.min(...sh.rows.map(r => r.ifA)) : null;
    const iMax = sh.rows.length ? Math.max(...sh.rows.map(r => r.ifA)) : null;
    const showI2t = i2t && hasCable;
    const rowsHtml = sorted.map(r => {
      const cableBad = showI2t && r.cableOk === false;
      const good = r.ok && !cableBad;
      const tag = r.ifA === iMin ? `<b class="rtcc-tag" style="color:${this.MIN_COLOR}">MIN</b>`
        : r.ifA === iMax ? `<b class="rtcc-tag" style="color:${this.MAX_COLOR}">MAX</b>` : '';
      return `<tr data-rid="${r.id}" class="${good ? '' : 'rtcc-bad'}">
        <td>${escHtml(r.kiosk ? r.kiosk + ' · ' : '')}${r.feeder ? '<i>feeder cable</i>' : escHtml(String(r.erf))}${multi ? `<br><span class="rtcc-dev" style="color:${r.dev.color}">${escHtml(r.dev.name)}</span>` : ''}${showI2t && r.cable ? `<br><span class="rtcc-dev" style="color:${r.cable.color}">${escHtml(r.cable.label)}</span>` : ''}</td>
        <td class="num">${Math.round(r.ifA).toLocaleString('en-US')} A ${tag}</td>
        <td class="num">${this._fmtT(r.tS)}</td>
        ${showI2t ? `<td class="num ${r.cableOk == null ? '' : r.cableOk ? 'rtcc-ok-t' : 'rtcc-fail-t'}">${r.cableOk == null ? '—' : (r.cableOk ? '✓ ' : '✕ ') + this._fmtT(r.tC)}</td>` : ''}
        <td class="${good ? 'rtcc-ok-t' : 'rtcc-fail-t'}">${good ? '✓ pass' : r.ok ? '✕ I²t' : '✕ fail'}</td></tr>`;
    }).join('');

    const devLegend = multi ? `<div class="rtcc-devs">${d.devices.map((v, i) =>
      `<div><i class="rtcc-sw" style="background:${v.color}"></i><b>${escHtml(v.name)}</b> <span>${i === 0 ? 'string breaker · ' : 'outgoing way · '}${escHtml(this._specOf(v.device))}</span></div>`).join('')}</div>` : '';
    const cableLegend = sh.cables.length ? `<div class="rtcc-devs">${sh.cables.map(c =>
      `<div><svg width="22" height="6" viewBox="0 0 22 6" aria-hidden="true"><path class="rtcc-cable" style="stroke:${c.color}" d="M0 3H22"/></svg> <b>${escHtml(c.label)}</b> <span>k ${c.k} · ${[...c.uses].join(', ')}</span></div>`).join('')}</div>` : '';
    const filterBtn = (k, label) => `<button type="button" data-rtcc-filter="${k}" aria-pressed="${this.view.filter === k}" ${counts[k] ? '' : 'disabled'}>${label} <span>${counts[k]}</span></button>`;
    const range = iMin != null
      ? `<span class="rtcc-mm"><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M0 1h12L6 11z" style="fill:${this.MIN_COLOR}"/></svg><b style="color:${this.MIN_COLOR}">Min</b> ${this._fmtA(iMin)}</span>`
        + `<span class="rtcc-mm"><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M0 1h12L6 11z" style="fill:${this.MAX_COLOR}"/></svg><b style="color:${this.MAX_COLOR}">Max</b> ${this._fmtA(iMax)}</span>` : '';

    return `<div class="rtcc">
      <div class="rtcc-sub">${escHtml(this._summary(d, sh))}</div>
      <div class="rtcc-bar">
        <div class="rtcc-seg" role="group" aria-label="Show on the plot"><span class="rtcc-seg-l">Show</span>
          <div class="rtcc-seg-btns">${filterBtn('all', 'All')}${filterBtn('kiosks', 'Kiosks')}${filterBtn('erven', 'Erven')}</div></div>
        ${hasCable ? `<button type="button" class="rtcc-switch" role="switch" data-rtcc="i2t" aria-checked="${i2t}"><i aria-hidden="true"></i>Cable I²t (adiabatic)</button>` : ''}
        <div class="rtcc-mms">${range}</div>
      </div>
      <div class="rtcc-grid">
        <div class="rtcc-plotwrap">${svg}
          <div class="rtcc-curbar"><label for="rtcc-slider">Cursor</label>
            <input id="rtcc-slider" type="range" min="0" max="1000" step="1">
            <button type="button" class="btn-small" data-rtcc="pin" aria-pressed="false">Pin</button></div>
        </div>
        <div class="rtcc-side">
          ${devLegend}
          <div class="rtcc-legend"><span><i class="rtcc-dot"></i> Clears within ${d.tAllow} s</span><span><b class="rtcc-x">×</b> Too slow / won't clear</span></div>
          <div class="rtcc-legend"><span><svg width="14" height="14" viewBox="-7 -7 14 14" aria-hidden="true"><path class="rtcc-fpass" d="M0 -6L6 0L0 6L-6 0Z"/></svg> Kiosk feeder cable, clears</span><span><svg width="14" height="14" viewBox="-7 -7 14 14" aria-hidden="true"><path class="rtcc-ffail" d="M0 -6L6 0L0 6L-6 0Z"/></svg> too slow</span></div>
          ${showI2t ? `<div class="rtcc-legend"><span><svg width="18" height="18" viewBox="-9 -9 18 18" aria-hidden="true"><path class="rtcc-i2t-ring" d="M-7.5 0a7.5 7.5 0 1 0 15 0a7.5 7.5 0 1 0 -15 0"/><circle class="rtcc-pass" r="4"/></svg> Cable not protected (clears after its I²t line)</span></div>` : ''}
          ${cableLegend}
          <div class="rtcc-tablewrap"><table class="rtcc-table">
            <thead><tr><th>${{ all: 'Kiosk / erf', kiosks: 'Kiosk feeder', erven: 'Erf' }[this.view.filter]}</th><th class="num">Fault I</th><th class="num">Clears in</th>${showI2t ? '<th class="num">Cable I²t</th>' : ''}<th>Result</th></tr></thead>
            <tbody>${rowsHtml}</tbody></table></div>
        </div>
      </div>
      <div class="rtcc-foot">Hover the plot to read the curves at any current (on a touch screen tap, then drag sideways); click or Pin holds the cursor and the slider moves it. Min and Max mark the lowest and highest fault current of the points shown. If = 0.95 · 230 V / |Zs| (minimum current, conductors hot). Each erf is plotted on the curve of the device that protects its service cable (its own pick, else the kiosk default, else the string breaker); curves are the library models (a manufacturer's breaker shows its published band: shaded from the fastest to the slowest it may trip, dashed = fastest, solid = slowest, the clearing time); no discrimination between devices in series is checked.${hasCable ? ' Cable I²t: withstand t = k²S²/I² of the weakest earth-fault conductor of each cable (phase, earth or PEN; IEC 60364-4-43 §434.5.2, k from IEC 60364-5-54 Table 54.3), solid up to 5 s; the cable is protected when the device clears before its line.' : ''}</div>
    </div>`;
  },

  // ─── PDF: the plot exactly as displayed ───
  // The SVG carries the .rtcc-* rules in its own <style> with light-theme
  // colours, so it rasterises the same whatever theme the screen is in.
  _exportStyle() {
    let css = `svg{--accent:#0078d7;--bg-primary:#ffffff;--bg-tertiary:#ebedf0;--border-color:#c4c4cc;--text-primary:#1a1a2e;--text-secondary:#555555;--text-muted:#6d6d6d;--font-family:Helvetica,Arial,sans-serif;font-family:Helvetica,Arial,sans-serif}`;
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch (e) { continue; }
      for (const r of rules || []) {
        if (r.selectorText && /^\.rtcc-/.test(r.selectorText) && !/dark-mode/.test(r.selectorText)) css += r.cssText;
      }
    }
    return css;
  },

  _rgb(color) {
    const hex = color === 'var(--accent)' ? '#0078d7' : color;
    const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return [26, 26, 46];
    const n = parseInt(m[1], 16);
    return [n >> 16 & 255, n >> 8 & 255, n & 255];
  },

  // One page of the PDF: the plot as displayed plus legend and table.
  async _pdfPage(doc, d, g, title, cursorI) {
    const sh = this._shown(d);
    const str = this._plotSvg(d, g, sh).replace('<rect class="rtcc-frame"', `<style>${this._exportStyle()}</style><rect class="rtcc-frame"`);
    const node = new DOMParser().parseFromString(str, 'image/svg+xml').documentElement;
    const png = await new Promise(res => Project._rasterizeSVG(node, this.W, this.H, 3, (c) => res(c.toDataURL('image/png'))));
    const pw = doc.internal.pageSize.getWidth(), m = 12;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(15);
    doc.text(title, m, m + 5);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
    doc.setTextColor(85);
    doc.text(`Project: ${AppState.projectName || 'Untitled'}    Date: ${new Date().toLocaleDateString()}`, m, m + 11);
    doc.text(doc.splitTextToSize(this._summary(d, sh), pw - 2 * m), m, m + 16);
    const I = cursorI;
    const view = [`Showing: ${this._filterName()}`, `Cable I²t: ${this.view.i2t && d.cables.length ? 'on' : 'off'}`];
    if (I != null) view.push(`Cursor: ${this._fmtA(I)} — ${d.devices.length > 1 ? 'string breaker' : 'breaker'} ${this._fmtT(this._time(d.devices[0].device, I))}`);
    if (sh.rows.length) view.push(`Min ${this._fmtA(Math.min(...sh.rows.map(r => r.ifA)))}`, `Max ${this._fmtA(Math.max(...sh.rows.map(r => r.ifA)))}`);
    doc.setTextColor(26, 26, 46);
    doc.text(view.join('    ·    '), m, m + 25);

    const imgW = 165, imgH = imgW * this.H / this.W, top = m + 29;
    doc.addImage(png, 'PNG', m, top, imgW, imgH, 'rtcc-plot-' + doc.internal.getNumberOfPages() + '-' + Date.now(), 'FAST');   // jsPDF reuses an image by alias — one per page

    // Legend + table to the right of the plot
    const x0 = m + imgW + 6;
    let y = top + 3;
    doc.setFontSize(8);
    const key = (color, label, dash) => {
      doc.setDrawColor(...this._rgb(color)); doc.setLineWidth(0.6);
      if (dash && doc.setLineDashPattern) doc.setLineDashPattern([1.6, 0.6], 0);
      doc.line(x0, y - 1, x0 + 7, y - 1);
      if (doc.setLineDashPattern) doc.setLineDashPattern([], 0);
      doc.text(label, x0 + 9, y);
      y += 4.2;
    };
    d.devices.forEach(v => key(v.color, v.name));
    sh.cables.forEach(c => key(c.color, `${c.label} (k ${c.k}) withstand`, true));
    key('#b45309', `${d.tAllow} s limit`, true);

    const showI2t = this.view.i2t && d.cables.length > 0;
    const sorted = sh.rows.slice().sort((a, b) => ((a.ok && a.cableOk !== false) - (b.ok && b.cableOk !== false)) || (a.ifA - b.ifA));
    const head = ['Kiosk / erf', 'Fault I', 'Clears in'].concat(showI2t ? ['Cable I²t'] : [], ['Result']);
    const body = sorted.map(r => {
      const cableBad = showI2t && r.cableOk === false, good = r.ok && !cableBad;
      return [`${r.kiosk ? r.kiosk + ' · ' : ''}${r.feeder ? 'feeder cable' : r.erf}${showI2t && r.cable ? '\n' + r.cable.label : ''}`,
        this._fmtA(r.ifA), this._fmtT(r.tS)]
        .concat(showI2t ? [r.cableOk == null ? '—' : (r.cableOk ? 'ok ' : 'FAIL ') + this._fmtT(r.tC)] : [],
          [good ? 'pass' : r.ok ? 'fail (I²t)' : 'fail']);
    });
    doc.autoTable({
      startY: y + 1, head: [head], body,
      margin: { left: x0, right: m, bottom: 16 },
      styles: { fontSize: 7, cellPadding: 1.2 },
      headStyles: { fillColor: [235, 237, 240], textColor: [60, 60, 70] },
      columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' } },
      didParseCell: (c) => {
        if (c.section === 'body' && c.column.index === head.length - 1) {
          c.cell.styles.textColor = /fail/.test(c.cell.raw) ? [183, 28, 28] : [27, 94, 32];
          c.cell.styles.fontStyle = 'bold';
        }
      },
    });

  },

  _pdfFinish(doc, showI2t, filename) {
    const pw = doc.internal.pageSize.getWidth(), ph = doc.internal.pageSize.getHeight(), m = 12;
    const pages = doc.internal.getNumberOfPages();
    const note = 'If = 0.95 · 230 V / |Zs| (minimum current, conductors hot); clearing times from the library device models.'
      + (showI2t ? ' Cable withstand t = k²S²/I² of the weakest earth-fault conductor (IEC 60364-4-43 §434.5.2), solid up to 5 s; a cable is protected when the device clears before its line.' : '')
      + ' Plot exported as displayed.';
    for (let p = 1; p <= pages; p++) {
      doc.setPage(p);
      doc.setFontSize(7); doc.setTextColor(85);
      doc.text(doc.splitTextToSize(note, pw - 2 * m - 50), m, ph - 9);
      doc.text(`ProtectionPro ${typeof APP_VERSION !== 'undefined' ? APP_VERSION : ''} · page ${p} of ${pages}`, pw - m, ph - 9, { align: 'right' });
    }
    doc.save(filename);
  },


  async exportPdf() {
    const d = this._d, g = this._g;
    if (!d || !g) return;
    const Ctor = window.jspdf && window.jspdf.jsPDF;
    if (!Ctor) { UI.alert('PDF library not loaded.'); return; }
    const doc = new Ctor({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    await this._pdfPage(doc, d, g, document.getElementById('rtcc-title').textContent, this._cur.i);
    const base = String(AppState.projectName || 'project').replace(/[^a-z0-9]+/gi, '_');
    const dev = String(d.device.name || 'breaker').replace(/[^a-z0-9]+/gi, '_');
    this._pdfFinish(doc, this.view.i2t && d.cables.length > 0, `${base}_${dev}_earth_fault_tcc.pdf`);
  },

  // ─── Export every string of a minisub ───
  // One page per string (the same plot as ◔ Curve), optionally behind a summary
  // table. The view controls are set in the dialog and applied for the export
  // only; the session view of the single-string modal is put back afterwards.
  openAll(msId) {
    const ms = Retic.minisubs.find(m => m.id === msId);
    if (!ms) return;
    const heads = Retic.kiosks.filter(k => Retic._stringHead(k) === k && Retic._minisubOf(k) === ms);
    this._all = {
      ms,
      filter: this.view.filter, i2t: this.view.i2t, summary: true,
      items: heads.map(h => {
        const dev = Retic._protectionDevice(h);
        const data = dev ? this._data(h.id) : null;
        const size = Retic.kiosks.filter(k => Retic._stringHead(k) === h).length;
        return { head: h, dev, data, size, on: !!data,
          note: !dev ? 'No breaker chosen — skipped' : !data ? 'No earth-fault results — skipped' : '' };
      }),
    };
    if (!this._all.items.length) { UI.toast('This minisub has no strings yet.', 'info'); return; }
    this._paintAll();
    document.getElementById('retic-tcc-all-modal').style.display = '';
  },

  _ensureAll() {
    let m = document.getElementById('retic-tcc-all-modal');
    if (m) return m;
    m = document.createElement('div');
    m.id = 'retic-tcc-all-modal';
    m.className = 'modal';
    m.setAttribute('role', 'dialog');
    m.setAttribute('aria-modal', 'true');
    m.setAttribute('aria-labelledby', 'rtcc-all-title');
    m.style.display = 'none';
    m.innerHTML = `<div class="modal-content rtcc-all">
      <div class="modal-header"><h3 id="rtcc-all-title">Export all curves</h3>
        <button class="modal-close" data-rtcc-all="close" aria-label="Close">&times;</button></div>
      <div class="modal-body" id="rtcc-all-body"></div>
      <div class="rtcc-all-foot"><button type="button" class="btn-small" data-rtcc-all="close">Cancel</button>
        <button type="button" class="btn-small btn-primary" id="rtcc-all-go" data-rtcc-all="go">Export PDF</button></div></div>`;
    document.body.appendChild(m);
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.closest('[data-rtcc-all="close"]')) { m.style.display = 'none'; return; }
      if (e.target.closest('[data-rtcc-all="go"]')) { this.exportAll(); return; }
      const f = e.target.closest('[data-rtcc-all-filter]');
      if (f) { this._all.filter = f.dataset.rtccAllFilter; this._paintAll(); }
    });
    m.addEventListener('change', (e) => {
      const t = e.target, a = this._all;
      if (!a) return;
      if (t.dataset.rtccAllItem !== undefined) a.items[+t.dataset.rtccAllItem].on = t.checked;
      else if (t.dataset.rtccAllOpt === 'i2t') a.i2t = t.checked;
      else if (t.dataset.rtccAllOpt === 'summary') a.summary = t.checked;
      this._paintAll();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && m.style.display !== 'none') m.style.display = 'none';
    });
    return m;
  },

  _paintAll() {
    const m = this._ensureAll(), a = this._all;
    const n = a.items.filter(i => i.on).length;
    const pages = n + (a.summary && n ? 1 : 0);
    const seg = (k, l) => `<button type="button" class="rtcc-seg-b${a.filter === k ? ' on' : ''}" data-rtcc-all-filter="${k}" aria-pressed="${a.filter === k}">${l}</button>`;
    m.querySelector('#rtcc-all-title').textContent = `Export all curves — ${a.ms.name || 'Minisub'}`;
    m.querySelector('#rtcc-all-body').innerHTML = `
      <div class="rtcc-all-h"><b>Strings to include</b><span>${n} of ${a.items.length} selected</span></div>
      <div class="rtcc-all-list">${a.items.map((it, i) => `<label class="rtcc-all-row">
        <input type="checkbox" data-rtcc-all-item="${i}"${it.on ? ' checked' : ''}${it.data ? '' : ' disabled'}>
        <span class="rtcc-all-n"><b>${escHtml(it.head.name || 'Kiosk')} string</b> <span>${it.size} kiosk${it.size === 1 ? '' : 's'}${it.dev ? ' · ' + escHtml(it.dev.name) : ''}</span></span>
        ${it.note ? `<span class="rtcc-all-note">${escHtml(it.note)}</span>` : ''}</label>`).join('')}</div>
      <div class="rtcc-all-opts">
        <div><b>Points plotted</b><div class="rtcc-all-seg">${seg('all', 'All points')}${seg('kiosks', 'Kiosk feeders')}${seg('erven', 'Erven')}</div></div>
        <div><b>Layout</b>
          <label><input type="checkbox" data-rtcc-all-opt="i2t"${a.i2t ? ' checked' : ''}> Cable withstand lines (I²t)</label>
          <label><input type="checkbox" data-rtcc-all-opt="summary"${a.summary ? ' checked' : ''}> Summary table up front</label></div>
      </div>
      <div class="rtcc-all-info">One page per string, the same plot as ◔ Curve, with each erf marked at its minimum earth-fault current. ${pages} page${pages === 1 ? '' : 's'}.</div>`;
    m.querySelector('#rtcc-all-go').disabled = !n;
  },

  async exportAll() {
    const a = this._all;
    const Ctor = window.jspdf && window.jspdf.jsPDF;
    if (!a) return;
    if (!Ctor) { UI.alert('PDF library not loaded.'); return; }
    const picked = a.items.filter(i => i.on);
    if (!picked.length) return;
    const savedView = { ...this.view };
    this.view.filter = a.filter; this.view.i2t = a.i2t;
    if (UI.setBusy) UI.setBusy(true, 'Building the PDF…');
    try {
      const doc = new Ctor({ orientation: 'landscape', unit: 'mm', format: 'a4' });
      const msName = a.ms.name || 'Minisub';
      let first = true, anyI2t = false;
      if (a.summary) {
        const m = 12;
        doc.setFont('helvetica', 'bold'); doc.setFontSize(15);
        doc.text(`${msName} — earth-fault protection of every string`, m, m + 5);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(85);
        doc.text(`Project: ${AppState.projectName || 'Untitled'}    Date: ${new Date().toLocaleDateString()}`, m, m + 11);
        doc.setTextColor(26, 26, 46);
        const body = picked.map(it => {
          const rows = it.data.rows, bad = rows.filter(r => !r.ok).length;
          const worst = Math.max(...rows.map(r => (r.tS == null || r.tS === Infinity) ? Infinity : r.tS));
          return [`${it.head.name || 'Kiosk'} string`, it.dev.name, String(it.size), String(rows.length),
            this._fmtA(Math.min(...rows.map(r => r.ifA))), this._fmtT(worst), bad ? `${bad} fail` : 'pass'];
        });
        doc.autoTable({
          startY: m + 16, head: [['String', 'Breaker', 'Kiosks', 'Points', 'Lowest fault I', 'Slowest clearing', 'Result']], body,
          margin: { left: m, right: m, bottom: 16 }, styles: { fontSize: 9, cellPadding: 1.8 },
          headStyles: { fillColor: [235, 237, 240], textColor: [60, 60, 70] },
          columnStyles: { 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' } },
          didParseCell: (c) => {
            if (c.section === 'body' && c.column.index === 6) {
              c.cell.styles.textColor = /fail/.test(c.cell.raw) ? [183, 28, 28] : [27, 94, 32];
              c.cell.styles.fontStyle = 'bold';
            }
          },
        });
        first = false;
      }
      for (const it of picked) {
        const d = this._data(it.head.id);
        if (!d) continue;
        if (!first) doc.addPage();
        first = false;
        if (a.i2t && d.cables.length) anyI2t = true;
        await this._pdfPage(doc, d, this._geometry(d), `${msName} — ${it.head.name || 'Kiosk'} string: earth-fault check (${d.device.name})`, null);
      }
      const base = String(AppState.projectName || 'project').replace(/[^a-z0-9]+/gi, '_');
      const ms = String(msName).replace(/[^a-z0-9]+/gi, '_');
      this._pdfFinish(doc, anyI2t, `${base}_${ms}_all_strings_earth_fault_tcc.pdf`);
      document.getElementById('retic-tcc-all-modal').style.display = 'none';
    } catch (e) {
      UI.alert('Could not build the PDF: ' + (e && e.message ? e.message : e));
    } finally {
      this.view = savedView;
      if (UI.setBusy) UI.setBusy(false);
    }
  },
};
