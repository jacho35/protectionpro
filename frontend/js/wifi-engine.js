/**
 * WifiEngine — WiFi coverage, capacity, channel plan, PoE and link budget for the Building WiFi tab
 * (pure, in metres / dBm / dB, node-testable: testing/unit/wifi-engine.test.js). No DOM.
 *
 * Model: indoor log-distance path loss plus the attenuation of every wall the straight line from the
 * access point to the point crosses —
 *
 *   RSSI = Tx + Gain − ( FSPL(1 m) + 10·n·log10(d) ) − Σ wall loss        (d ≥ 1 m)
 *   FSPL(1 m) = 20·log10(f MHz) − 27.55
 *
 * Walls are the room outlines (an edge shared by two rooms is one wall). Every wall starts as the project's
 * default material and takes a per-wall override keyed `<roomId>:<edgeIndex>`.
 *
 * The material losses, the exponent, the noise floors, the MCS table and the efficiency are PLANNING values
 * (`provisional: true`): typical published figures for 2.4 / 5 / 6 GHz, not a measurement of this building.
 * The report says so; a site survey settles it.
 */
const WifiEngine = (() => {
  const hyp = Math.hypot;

  const BANDS = {
    '2.4': { label: '2.4 GHz', mhz: 2437, widths: [20, 40], channels: { 20: [1, 6, 11], 40: [3, 11] } },
    '5':   { label: '5 GHz',   mhz: 5500, widths: [20, 40, 80, 160], channels: { 20: [36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 149, 153, 157, 161], 40: [38, 46, 54, 62, 102, 110, 118, 126, 134, 151, 159], 80: [42, 58, 106, 122, 138, 155], 160: [50, 114] } },
    '6':   { label: '6 GHz',   mhz: 6000, widths: [20, 40, 80, 160], channels: { 20: [1, 5, 9, 13, 17, 21, 25, 29, 33, 37, 41, 45], 40: [3, 11, 19, 27, 35, 43], 80: [7, 23, 39, 55, 71, 87], 160: [15, 47, 79] } },
  };
  // Dead-ahead loss per wall crossing, dB: [2.4, 5, 6 GHz]. Provisional planning values.
  const MATERIALS = {
    open:     { name: 'Open / no wall', loss: [0, 0, 0] },
    glass:    { name: 'Glass', loss: [2, 3, 4] },
    drywall:  { name: 'Drywall / partition', loss: [3, 4, 5] },
    timber:   { name: 'Timber / door', loss: [3, 4, 5] },
    brick:    { name: 'Brick', loss: [8, 10, 12] },
    concrete: { name: 'Concrete / block', loss: [12, 15, 18] },
    metal:    { name: 'Metal / lift shaft', loss: [20, 25, 30] },
  };
  const BAND_IX = { '2.4': 0, '5': 1, '6': 2 };
  // Wi-Fi 6 data rate per spatial stream at 20 MHz (0.8 µs GI) and the SNR each step needs. Provisional.
  const MCS = [[5, 8.6], [8, 17.2], [11, 25.8], [14, 34.4], [18, 51.6], [21, 68.8], [23, 77.4], [25, 86], [29, 103.2], [31, 114.7], [34, 129], [36, 143.4]];
  const WIDTH_FACTOR = { 20: 1, 40: 2.08, 80: 4.5, 160: 9 };
  const DEFAULTS = {
    band: '5', width: 80, exponent: 3.0, defaultWall: 'drywall', cell: 0.5, noise20: -95, efficiency: 0.6, streams: 2,
    txDbm: 17, gainDbi: 4, mount: 2.7,
    density: 10,          // m² per person
    devices: 2,           // devices per person
    mbps: 25,             // per user, when active
    concurrency: 0.6,
    switchPorts: 24, switchPoeW: 370, apWatts: 15.4, runLimit: 90, slack: 1.1, drop: 3,
    interfere: -82,       // an AP heard louder than this on the same channel is a co-channel neighbour
    uses: {               // room use → target RSSI (dBm) at the worst point
      general: { name: 'General / office', rssi: -67 },
      video:   { name: 'Meeting / video call', rssi: -60 },
      low:     { name: 'Low use (store, kitchen)', rssi: -72 },
      none:    { name: 'Not served', rssi: null },
    },
  };

  const bandIx = b => BAND_IX[b] != null ? BAND_IX[b] : 1;
  const noiseFloor = (width, s) => (s && s.noise20 != null ? s.noise20 : DEFAULTS.noise20) + 10 * Math.log10((width || 20) / 20);
  const fspl1 = band => 20 * Math.log10(BANDS[band].mhz) - 27.55;
  const pt = p => (Array.isArray(p) ? [p[0], p[1]] : [p.x, p.y]);
  const poly = r => (r.points || r.polygon || []).map(pt);

  // ── geometry ──
  function inside(P, x, y) {
    let c = false;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      if (((P[i][1] > y) !== (P[j][1] > y)) && x < (P[j][0] - P[i][0]) * (y - P[i][1]) / (P[j][1] - P[i][1]) + P[i][0]) c = !c;
    }
    return c;
  }
  function area(P) { let a = 0; for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; a += p[0] * q[1] - q[0] * p[1]; } return Math.abs(a) / 2; }
  // Proper crossing of segment ab with cd (touching an end does not count: a point on a wall is not behind it).
  function crosses(ax, ay, bx, by, cx, cy, dx, dy) {
    const r1 = bx - ax, r2 = by - ay, s1 = dx - cx, s2 = dy - cy, den = r1 * s2 - r2 * s1;
    if (Math.abs(den) < 1e-12) return false;
    const t = ((cx - ax) * s2 - (cy - ay) * s1) / den, u = ((cx - ax) * r2 - (cy - ay) * r1) / den;
    return t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6;
  }

  /**
   * Wall segments from the rooms (metres). rooms: [{id, points|polygon}], wallMats: { '<roomId>:<edge>': materialId }.
   * An edge lying on another room's edge (collinear, overlapping, within `tol`) is one wall: the first room's wins unless
   * only the later one was set by hand. Returns [{ax, ay, bx, by, mat, key, loss: [..]}].
   */
  function walls(rooms, wallMats = {}, defaultWall = DEFAULTS.defaultWall, tol = 0.12) {
    const out = [];
    for (const r of rooms) {
      const P = poly(r); if (P.length < 3) continue;
      for (let i = 0; i < P.length; i++) {
        const a = P[i], b = P[(i + 1) % P.length], key = r.id + ':' + i;
        const mat = wallMats[key] && MATERIALS[wallMats[key]] ? wallMats[key] : null;
        const len = hyp(b[0] - a[0], b[1] - a[1]); if (len < 1e-6) continue;
        const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len;
        const dup = out.find(w => {
          const wl = hyp(w.bx - w.ax, w.by - w.ay), wx = (w.bx - w.ax) / wl, wy = (w.by - w.ay) / wl;
          if (Math.abs(ux * wy - uy * wx) > 0.02) return false;                                   // not parallel
          const off = Math.abs((a[0] - w.ax) * wy - (a[1] - w.ay) * wx); if (off > tol) return false;   // not the same line
          const t0 = (a[0] - w.ax) * wx + (a[1] - w.ay) * wy, t1 = (b[0] - w.ax) * wx + (b[1] - w.ay) * wy;
          return Math.min(Math.max(t0, t1), wl) - Math.max(Math.min(t0, t1), 0) > Math.min(len, wl) * 0.5;   // overlap by more than half
        });
        if (dup) { if (mat && !dup.set) { dup.mat = mat; dup.set = true; dup.loss = MATERIALS[mat].loss; } continue; }
        const m = mat || defaultWall;
        out.push({ ax: a[0], ay: a[1], bx: b[0], by: b[1], mat: m, set: !!mat, key, loss: (MATERIALS[m] || MATERIALS.drywall).loss });
      }
    }
    return out;
  }

  /** Wall loss, dB, on the straight line a→b. */
  function wallLoss(segs, ax, ay, bx, by, band) {
    const ix = bandIx(band); let L = 0;
    for (const w of segs) if (crosses(ax, ay, bx, by, w.ax, w.ay, w.bx, w.by)) L += w.loss[ix];
    return L;
  }

  /** Signal from an AP ({x, y, tx, gain}) at (x, y), dBm. */
  function rssi(ap, x, y, ctx) {
    const d = Math.max(1, hyp(x - ap.x, y - ap.y));
    const pl = fspl1(ctx.band) + 10 * ctx.exponent * Math.log10(d);
    return ap.tx + ap.gain - pl - (ctx.segs ? wallLoss(ctx.segs, ap.x, ap.y, x, y, ctx.band) : 0);
  }

  /**
   * Predict the floor. input: { rooms (metres), aps: [{id, x, y, tx, gain, channel?}], band, width, exponent,
   * wallMats, defaultWall, cell }. Cells inside a room (rooms with use 'none' excluded) only.
   * Returns { x0, y0, step, nx, ny, room: Int16 (room index or -1), best: Float32 (dBm), ap: Int16 (serving AP or -1),
   * heard: Uint8 (APs ≥ `interfere` on the serving AP's channel, serving included), segs }.
   */
  function predict(input) {
    const s = Object.assign({}, DEFAULTS, input);
    const rooms = (input.rooms || []).filter(r => poly(r).length >= 3);
    const aps = input.aps || [];
    const segs = walls(rooms, s.wallMats || {}, s.defaultWall);
    const ctx = { band: s.band, exponent: s.exponent, segs };
    const polys = rooms.map(poly);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const P of polys) for (const p of P) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
    if (!isFinite(x0)) return { x0: 0, y0: 0, step: s.cell, nx: 0, ny: 0, room: new Int16Array(0), best: new Float32Array(0), ap: new Int16Array(0), heard: new Uint8Array(0), segs, rooms };
    let step = s.cell;
    while (Math.ceil((x1 - x0) / step) * Math.ceil((y1 - y0) / step) > 60000) step *= 1.25;   // cap the work on a big floor
    const nx = Math.max(1, Math.ceil((x1 - x0) / step)), ny = Math.max(1, Math.ceil((y1 - y0) / step));
    const N = nx * ny, room = new Int16Array(N).fill(-1), best = new Float32Array(N).fill(-120), apIx = new Int16Array(N).fill(-1), heard = new Uint8Array(N);
    const none = rooms.map(r => r.use === 'none');
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const x = x0 + (i + 0.5) * step, y = y0 + (j + 0.5) * step, k = j * nx + i;
      let rIx = -1;
      for (let r = polys.length - 1; r >= 0; r--) if (inside(polys[r], x, y)) { rIx = r; break; }
      if (rIx < 0 || none[rIx]) continue;
      room[k] = rIx;
      let bv = -120, bi = -1; const lv = [];
      for (let a = 0; a < aps.length; a++) { const v = rssi(aps[a], x, y, ctx); lv.push(v); if (v > bv) { bv = v; bi = a; } }
      best[k] = bv; apIx[k] = bi;
      if (bi >= 0) { const ch = aps[bi].channel; let n = 0; for (let a = 0; a < aps.length; a++) if (lv[a] >= s.interfere && (a === bi || (ch != null && aps[a].channel === ch))) n++; heard[k] = n; }
    }
    return { x0, y0, step, nx, ny, room, best, ap: apIx, heard, segs, rooms };
  }

  const snrOf = (pred, k, s) => pred.best[k] - noiseFloor(s.width, s);

  /** Per room: worst / mean RSSI, share of the room at or above its target, pass. targets: { roomId: { use, rssi } }. */
  function roomStats(pred, rooms, settings) {
    const s = Object.assign({}, DEFAULTS, settings), uses = Object.assign({}, DEFAULTS.uses, s.uses || {});
    const acc = rooms.map(() => ({ n: 0, sum: 0, worst: 1e9, worstK: -1, snrWorst: 1e9 }));
    for (let k = 0; k < pred.best.length; k++) {
      const r = pred.room[k]; if (r < 0) continue; const a = acc[r], v = pred.best[k];
      a.n++; a.sum += v; if (v < a.worst) { a.worst = v; a.worstK = k; }
    }
    return rooms.map((r, i) => {
      const a = acc[i], useId = r.use || 'general', use = uses[useId] || uses.general, target = use.rssi;
      if (!a.n || target == null) return { id: r.id, name: r.name || r.id, use: useId, target, n: a.n, area: area(poly(r)), worst: null, mean: null, pct: null, snr: null, pass: null };
      let ok = 0; for (let k = 0; k < pred.best.length; k++) if (pred.room[k] === i && pred.best[k] >= target) ok++;
      return { id: r.id, name: r.name || r.id, use: useId, target, n: a.n, area: area(poly(r)), worst: a.worst, mean: a.sum / a.n, pct: ok / a.n, snr: a.worst - noiseFloor(s.width, s), pass: a.worst >= target - 1e-9,
        worstAt: a.worstK >= 0 ? [pred.x0 + ((a.worstK % pred.nx) + 0.5) * pred.step, pred.y0 + (Math.floor(a.worstK / pred.nx) + 0.5) * pred.step] : null };
    });
  }

  /** Whole-floor coverage: share of served cells at or above each of the thresholds (dBm). */
  function coverage(pred, thresholds = [-67]) {
    let n = 0; const c = thresholds.map(() => 0);
    for (let k = 0; k < pred.best.length; k++) { if (pred.room[k] < 0) continue; n++; thresholds.forEach((t, i) => { if (pred.best[k] >= t) c[i]++; }); }
    return thresholds.map((t, i) => ({ rssi: t, pct: n ? c[i] / n : 0 }));
  }

  /** The rate (Mbps, one spatial stream, 20 MHz) a client at this SNR gets, or 0 below the lowest step. */
  function rate1(snr) { let r = 0; for (const [need, mbps] of MCS) if (snr >= need) r = mbps; return r; }

  /**
   * Capacity per AP. persons by room: { roomId: n } else area / density. Each room's clients go to the APs that serve its
   * cells in proportion. Capacity = efficiency × the rate at the median SNR of the AP's served cells (shared airtime).
   * Returns [{id, cells, area, clients, demand, snrMedian, phy, capacity, load, pass}].
   */
  function capacity(pred, rooms, aps, settings) {
    const s = Object.assign({}, DEFAULTS, settings), fw = WIDTH_FACTOR[s.width] || 1;
    const cellArea = pred.step * pred.step, per = aps.map(() => ({ cells: 0, snrs: [], clients: 0 }));
    const roomCells = rooms.map(() => aps.map(() => 0)), roomN = rooms.map(() => 0);
    for (let k = 0; k < pred.best.length; k++) {
      const r = pred.room[k], a = pred.ap[k]; if (r < 0 || a < 0) continue;
      per[a].cells++; per[a].snrs.push(snrOf(pred, k, s)); roomCells[r][a]++; roomN[r]++;
    }
    rooms.forEach((r, i) => {
      if (!roomN[i]) return;
      const persons = (s.persons && s.persons[r.id] != null) ? s.persons[r.id] : area(poly(r)) / Math.max(0.5, s.density);
      for (let a = 0; a < aps.length; a++) per[a].clients += persons * s.devices * roomCells[i][a] / roomN[i];
    });
    return aps.map((ap, a) => {
      const p = per[a], sn = p.snrs.sort((x, y) => x - y), med = sn.length ? sn[sn.length >> 1] : null;
      const phy = med == null ? 0 : rate1(med) * fw * s.streams, cap = phy * s.efficiency;
      const demand = p.clients * s.mbps * s.concurrency;
      return { id: ap.id, cells: p.cells, area: p.cells * cellArea, clients: p.clients, demand, snrMedian: med, phy, capacity: cap, load: cap > 0 ? demand / cap : (demand > 0 ? Infinity : 0), pass: demand <= cap + 1e-9 };
    });
  }

  /** Channels: greedy colouring, loudest neighbours first. aps: [{id, x, y, tx, gain, channel?, fixed?}] → [{id, channel}] and the neighbour pairs. */
  function channels(aps, settings, segs) {
    const s = Object.assign({}, DEFAULTS, settings), list = (BANDS[s.band].channels[s.width] || BANDS[s.band].channels[20]).slice();
    const ctx = { band: s.band, exponent: s.exponent, segs };
    const w = aps.map(() => aps.map(() => 0)), pairs = [];
    for (let i = 0; i < aps.length; i++) for (let j = i + 1; j < aps.length; j++) {
      const v = Math.max(rssi(aps[i], aps[j].x, aps[j].y, ctx), rssi(aps[j], aps[i].x, aps[i].y, ctx));
      if (v >= s.interfere) { w[i][j] = w[j][i] = Math.pow(10, v / 10); pairs.push({ a: aps[i].id, b: aps[j].id, rssi: v }); }
    }
    const order = aps.map((_, i) => i).sort((a, b) => w[b].reduce((x, y) => x + y, 0) - w[a].reduce((x, y) => x + y, 0));
    const pick = new Array(aps.length).fill(null);
    for (const i of order) {
      if (aps[i].fixed && aps[i].channel != null) { pick[i] = aps[i].channel; continue; }
      let bestC = list[0], bestCost = Infinity;
      for (const c of list) {
        let cost = 0; for (let j = 0; j < aps.length; j++) if (pick[j] === c) cost += w[i][j];
        if (cost < bestCost - 1e-18) { bestCost = cost; bestC = c; }
      }
      pick[i] = bestC;
    }
    const clash = pairs.filter(p => pick[aps.findIndex(a => a.id === p.a)] === pick[aps.findIndex(a => a.id === p.b)]);
    return { channels: aps.map((a, i) => ({ id: a.id, channel: pick[i] })), pairs, clash, list };
  }

  /** Cable run, m: Manhattan to the rack on the plan + a drop at each end, with slack. */
  function cableRun(from, to, settings) {
    const s = Object.assign({}, DEFAULTS, settings);
    return (Math.abs(from.x - to.x) + Math.abs(from.y - to.y) + 2 * s.drop) * s.slack;
  }

  /** PoE and ports. items: [{id, kind: 'ap'|'dp', watts?, run}]. Returns the switches needed and the budget used. */
  function poe(items, settings) {
    const s = Object.assign({}, DEFAULTS, settings);
    const ports = items.length, switches = Math.max(ports ? 1 : 0, Math.ceil(ports / s.switchPorts));
    const watts = items.filter(i => i.kind === 'ap').reduce((t, i) => t + (i.watts || s.apWatts), 0);
    const longest = items.reduce((m, i) => Math.max(m, i.run || 0), 0);
    return { ports, switches, watts, budget: switches * s.switchPoeW, longest, limit: s.runLimit, tooLong: items.filter(i => (i.run || 0) > s.runLimit).map(i => i.id),
      pass: watts <= switches * s.switchPoeW + 1e-9 && longest <= s.runLimit + 1e-9 };
  }

  /**
   * Point-to-point link (free space, outdoors). { dist (m), freqGhz, tx, gainA, gainB, sens (dBm), obstruct (m above the line, <0 = clear below),
   * losses (dB cable + misc) }. Fresnel zone radius F1 = 8.656·√(d km / f GHz); clearance = share of F1 clear of the obstruction.
   * Returns { fspl, rx, fade, f1, clear, rate, pass }.
   */
  function link(p) {
    const f = p.freqGhz || 5.5, d = Math.max(1, p.dist), dkm = d / 1000;
    const fspl = 20 * Math.log10(dkm) + 20 * Math.log10(f * 1000) + 32.44;
    const rx = (p.tx != null ? p.tx : 23) + (p.gainA != null ? p.gainA : 23) + (p.gainB != null ? p.gainB : 23) - fspl - (p.losses != null ? p.losses : 2);
    const sens = p.sens != null ? p.sens : -75, fade = rx - sens;
    const f1 = 8.656 * Math.sqrt(dkm / f), h = p.obstruct != null ? p.obstruct : -1e9;
    const clear = h <= -1e8 ? 1 : Math.max(0, Math.min(1, (f1 - h) / f1));
    const snr = rx - (p.noise != null ? p.noise : -95), rate = rate1(snr) * (WIDTH_FACTOR[p.width || 40] || 1) * 2 * 0.7;
    return { fspl, rx, fade, f1, clear, snr, rate, pass: fade >= (p.fadeMin != null ? p.fadeMin : 15) && clear >= 0.6 };
  }


  /**
   * Fewest APs that bring every sampled point of every served room to its target, by greedy cover: candidates on a grid
   * (+ each room's centre) inside the rooms, samples on a coarser grid; the RSSI of every candidate at every sample is
   * worked out once, then the candidate that newly covers most samples is taken until none is left (or `max`).
   * input: { rooms (metres, with .use), existing: [{x, y, tx, gain}], band, exponent, wallMats, defaultWall, tx, gain, targets (use table), candStep, sampleStep, max }
   * → { aps: [{x, y}], uncovered: n, samples: n }
   */
  function autoPlace(input) {
    const s = Object.assign({}, DEFAULTS, input), uses = Object.assign({}, DEFAULTS.uses, s.uses || {});
    const rooms = (input.rooms || []).filter(r => poly(r).length >= 3 && r.use !== 'none' && ((uses[r.use || 'general'] || uses.general).rssi != null));
    const polys = rooms.map(poly), segs = walls(input.rooms || [], s.wallMats || {}, s.defaultWall), ctx = { band: s.band, exponent: s.exponent, segs };
    const grid = (step, edge) => {
      const out = [];
      rooms.forEach((r, ri) => {
        const P = polys[ri]; let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const p of P) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
        for (let y = y0 + step / 2; y < y1; y += step) for (let x = x0 + step / 2; x < x1; x += step) if (inside(P, x, y)) out.push({ x, y, ri });
        if (edge) { const cx = P.reduce((t, p) => t + p[0], 0) / P.length, cy = P.reduce((t, p) => t + p[1], 0) / P.length; if (inside(P, cx, cy)) out.push({ x: cx, y: cy, ri }); }
      });
      return out;
    };
    const samples = grid(s.sampleStep || 1.5, false), cands = grid(s.candStep || 2.5, true);
    const need = samples.map(p => (uses[rooms[p.ri].use || 'general'] || uses.general).rssi);
    const have = samples.map(() => -200);
    for (const e of (input.existing || [])) samples.forEach((p, i) => { const v = rssi({ x: e.x, y: e.y, tx: e.tx != null ? e.tx : s.txDbm, gain: e.gain != null ? e.gain : s.gainDbi }, p.x, p.y, ctx); if (v > have[i]) have[i] = v; });
    const ap0 = { tx: s.txDbm, gain: s.gainDbi };
    const M = cands.map(c => samples.map(p => rssi({ x: c.x, y: c.y, tx: ap0.tx, gain: ap0.gain }, p.x, p.y, ctx)));
    const out = []; let open = samples.map((_, i) => have[i] < need[i]);
    for (let it = 0; it < (s.max || 60); it++) {
      let bi = -1, bn = 0;
      for (let c = 0; c < cands.length; c++) { let n = 0; for (let i = 0; i < samples.length; i++) if (open[i] && M[c][i] >= need[i]) n++; if (n > bn) { bn = n; bi = c; } }
      if (bi < 0) break;
      out.push({ x: cands[bi].x, y: cands[bi].y });
      for (let i = 0; i < samples.length; i++) if (open[i] && M[bi][i] >= need[i]) open[i] = false;
      if (!open.some(Boolean)) break;
    }
    return { aps: out, uncovered: open.filter(Boolean).length, samples: samples.length };
  }

  /** Heat colour for an RSSI: [r, g, b]. Same five steps as the legend. */
  const STEPS = [[-55, [46, 158, 91], 'Excellent'], [-65, [141, 190, 74], 'Good'], [-70, [227, 178, 60], 'Fair'], [-75, [224, 123, 57], 'Weak'], [-200, [201, 74, 74], 'Dead zone']];
  function colour(v) { for (const [t, c] of STEPS) if (v >= t) return c; return STEPS[STEPS.length - 1][1]; }

  return { BANDS, MATERIALS, DEFAULTS, MCS, STEPS, walls, wallLoss, rssi, predict, roomStats, coverage, capacity, channels, cableRun, poe, link, autoPlace, rate1, noiseFloor, fspl1, colour, inside, area };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = WifiEngine;
