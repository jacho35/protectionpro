/**
 * CctvEngine — CCTV coverage for the CCTV tab (Building floor plans and Reticulation site plans).
 * Pure, in metres / pixels per metre, node-testable (testing/unit/cctv-engine.test.js). No DOM.
 *
 * Pixel density at a point (the DORI measure, IEC 62676-4):
 *
 *   ppm = resW / (2 · z · tan(hfov / 2))        z = depth of the point along the camera axis
 *
 * A point is seen when it is inside the horizontal and vertical field of view (the camera's axis is pan / tilt) and no
 * opaque wall or building lies on the plan line between camera and point. Detect 25, Observe 62, Recognise 125,
 * Identify 250 px/m. The point is a person's face (`targetH`, 1.6 m) above the floor.
 *
 * Planning values (bitrate per megapixel and frame, the reach height, the steepest face angle, the pass share) are
 * PROVISIONAL `DEFAULTS`: typical figures, not a measurement of a site. The report says so.
 */
const CctvEngine = (() => {
  const hyp = Math.hypot, RAD = Math.PI / 180;

  const DORI = [['identify', 'Identify', 250], ['recognise', 'Recognise', 125], ['observe', 'Observe', 62], ['detect', 'Detect', 25]];
  const USES = { none: { name: 'Not covered', ppm: null }, detect: { name: 'Detect (25 px/m)', ppm: 25 }, observe: { name: 'Observe (62 px/m)', ppm: 62 },
    recognise: { name: 'Recognise (125 px/m)', ppm: 125 }, identify: { name: 'Identify (250 px/m)', ppm: 250 } };
  const WALLS = { solid: { name: 'Solid (blocks the view)', block: true }, glass: { name: 'Glass (see through)', block: false }, open: { name: 'Opening / doorway', block: false } };
  // Encoded Mbps per megapixel per frame per second. Provisional.
  const CODECS = { h264: { name: 'H.264', f: 0.10 }, h265: { name: 'H.265', f: 0.065 }, h265s: { name: 'H.265 + smart codec', f: 0.04 }, mjpeg: { name: 'MJPEG', f: 0.5 } };
  const KINDS = { dome: 'Dome', bullet: 'Bullet', ptz: 'PTZ' };
  const DEFAULTS = {
    targetH: 1.6, cell: 0.5, passPct: 0.9, defaultWall: 'solid', maxCells: 40000,
    generic: { resW: 2688, resH: 1520, hfov: 100, watts: 7, minLux: null },
    mountBuilding: 2.8, mountRetic: 6, tiltBuilding: 25, tiltRetic: 20,
    fps: 15, codec: 'h265', duty: 1, days: 30, overhead: 1.1,
    switchPorts: 24, switchPoeW: 370, runLimit: 90, slack: 1.1, drop: 3, uplinkMbps: 1000, uplinkUtil: 0.8,
    reachH: 2.4,          // lower than this and a hand can reach it
    maxDepression: 45,    // steeper than this at the Identify range and a face is not seen, only the top of a head
  };

  // ── geometry ──
  const pt = p => (Array.isArray(p) ? [p[0], p[1]] : [p.x, p.y]);
  const poly = r => (r.points || r.polygon || []).map(pt);
  function inside(P, x, y) {
    let c = false;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      if (((P[i][1] > y) !== (P[j][1] > y)) && x < (P[j][0] - P[i][0]) * (y - P[i][1]) / (P[j][1] - P[i][1]) + P[i][0]) c = !c;
    }
    return c;
  }
  function area(P) { let a = 0; for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; a += p[0] * q[1] - q[0] * p[1]; } return Math.abs(a) / 2; }
  function crosses(ax, ay, bx, by, cx, cy, dx, dy) {
    const r1 = bx - ax, r2 = by - ay, s1 = dx - cx, s2 = dy - cy, den = r1 * s2 - r2 * s1;
    if (Math.abs(den) < 1e-12) return false;
    const t = ((cx - ax) * s2 - (cy - ay) * s1) / den, u = ((cx - ax) * r2 - (cy - ay) * r1) / den;
    return t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6;
  }

  /** The edges that block the view. obstacles: [{id, points}], wallMats { '<id>:<edge>': 'solid'|'glass'|'open' }. [{ax, ay, bx, by, key}] */
  function walls(obstacles, wallMats = {}, defaultWall = DEFAULTS.defaultWall) {
    const out = [];
    for (const r of obstacles) {
      const P = poly(r); if (P.length < 3) continue;
      for (let i = 0; i < P.length; i++) {
        const a = P[i], b = P[(i + 1) % P.length], key = r.id + ':' + i, m = WALLS[wallMats[key]] ? wallMats[key] : defaultWall;
        if (!(WALLS[m] || WALLS.solid).block || hyp(b[0] - a[0], b[1] - a[1]) < 1e-6) continue;
        out.push({ ax: a[0], ay: a[1], bx: b[0], by: b[1], key });
      }
    }
    return out;
  }
  const blocked = (segs, ax, ay, bx, by) => { for (const w of segs) if (crosses(ax, ay, bx, by, w.ax, w.ay, w.bx, w.by)) return true; return false; };

  // ── the camera ──
  /** Precompute a camera's axis. cam: { x, y, pan (deg, plan frame: 0 = +x, clockwise on screen), tilt (deg below horizontal), H (mount height m), hfov (deg), resW, resH }. */
  function view(cam) {
    const pan = (cam.pan || 0) * RAD, t = (cam.tilt || 0) * RAD, th = Math.tan(cam.hfov * RAD / 2);
    const a = [Math.cos(pan) * Math.cos(t), Math.sin(pan) * Math.cos(t), -Math.sin(t)], r = [-Math.sin(pan), Math.cos(pan), 0];
    const u = [-a[2] * Math.cos(pan), -a[2] * Math.sin(pan), a[0] * Math.cos(pan) + a[1] * Math.sin(pan)];   // up in the image: a × r
    const tv = cam.vfov > 0 ? Math.tan(cam.vfov * RAD / 2) : th * cam.resH / cam.resW;
    return { cam, a, r, u, th, tv };
  }
  /** Pixel density (px/m) of camera view v at floor position (x, y); 0 when outside the field of view. Ignores walls. */
  function density(v, x, y, ht) {
    const c = v.cam, dx = x - c.x, dy = y - c.y, dz = ht - c.H;
    const z = dx * v.a[0] + dy * v.a[1] + dz * v.a[2];
    if (z < 0.2) return 0;
    const lx = dx * v.r[0] + dy * v.r[1], ly = dx * v.u[0] + dy * v.u[1] + dz * v.u[2];
    if (Math.abs(lx) > z * v.th || Math.abs(ly) > z * v.tv) return 0;
    return c.resW / (2 * z * v.th);
  }
  /** Depth (m along the axis) at which a camera gives `ppm` px/m. */
  const reach = (cam, ppm) => cam.resW / (2 * Math.tan(cam.hfov * RAD / 2) * ppm);

  /** Mounting-height and tilt checks for one camera. */
  function camChecks(cam, s) {
    s = Object.assign({}, DEFAULTS, s);
    const H = cam.H, v = view(cam), tilt = cam.tilt || 0, vh = Math.atan(v.tv) / RAD;       // half vertical FOV, deg
    const near = tilt + vh >= 89.5 ? 0 : H / Math.tan((tilt + vh) * RAD);
    const far = tilt - vh <= 0.5 ? Infinity : H / Math.tan((tilt - vh) * RAD);
    const zId = reach(cam, 250), dh = Math.max(0, H - s.targetH), dId = zId > dh ? Math.sqrt(zId * zId - dh * dh) : 0;
    const dep = dId > 0 ? Math.atan(dh / dId) / RAD : 90;
    const ranges = {}; for (const [k, , ppm] of DORI) ranges[k] = reach(cam, ppm);
    const out = { near, far, ranges, depression: dep, reachOk: H >= s.reachH, angleOk: dh <= 0.05 ? true : dep <= s.maxDepression, notes: [] };
    if (!out.reachOk) out.notes.push(`Mounted at ${H.toFixed(1)} m: within reach (keep it at ${s.reachH} m or higher, or use a vandal-resistant model)`);
    if (!out.angleOk) out.notes.push(`At the Identify range the camera looks down at ${dep.toFixed(0)}° (limit ${s.maxDepression}°): it sees heads, not faces. Mount it lower or further back, or tilt it up`);
    if (tilt > 80) out.notes.push('Tilt is almost straight down: it covers only the ground under it');
    out.pass = out.reachOk && out.angleOk;
    return out;
  }

  /**
   * Coverage grid. args: { areas: [{id, points, ppm (target px/m or null)}], cams: [cam], segs, targetH, cell, maxCells }
   * Returns { nx, ny, x0, y0, step, best (px/m), room (area index or -1: named so WifiEngine.contours can trace it), cam (best camera index) }.
   */
  function predict(args) {
    const s = Object.assign({}, DEFAULTS, args), areas = args.areas || [], cams = (args.cams || []).map(view), segs = args.segs || [];
    const polys = areas.map(poly);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const P of polys) for (const p of P) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
    if (!isFinite(x0)) return { nx: 0, ny: 0, x0: 0, y0: 0, step: s.cell, best: new Float32Array(0), room: new Int16Array(0), cam: new Int16Array(0) };
    const step = Math.max(s.cell, Math.sqrt(((x1 - x0) * (y1 - y0)) / s.maxCells));
    const nx = Math.max(1, Math.ceil((x1 - x0) / step)), ny = Math.max(1, Math.ceil((y1 - y0) / step));
    const best = new Float32Array(nx * ny), room = new Int16Array(nx * ny).fill(-1), cam = new Int16Array(nx * ny).fill(-1);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const x = x0 + (i + 0.5) * step, y = y0 + (j + 0.5) * step, k = j * nx + i;
      let ai = -1; for (let q = 0; q < polys.length; q++) if (inside(polys[q], x, y)) { ai = q; break; }
      if (ai < 0) continue;
      room[k] = ai;
      let b = 0, bi = -1;
      for (let c = 0; c < cams.length; c++) {
        const d = density(cams[c], x, y, s.targetH);
        if (d <= b) continue;
        if (segs.length && blocked(segs, cams[c].cam.x, cams[c].cam.y, x, y)) continue;
        b = d; bi = c;
      }
      best[k] = b; cam[k] = bi;
    }
    return { nx, ny, x0, y0, step, best, room, cam };
  }

  /** Per area: share of its cells at the target density, worst point, the highest DORI level reached by `passPct` of it, blind share. */
  function areaStats(pred, areas, settings) {
    const s = Object.assign({}, DEFAULTS, settings), { nx, ny, x0, y0, step, best, room } = pred;
    return areas.map((a, ai) => {
      let n = 0, ok = 0, blind = 0, worst = Infinity, wk = -1;
      const cnt = { identify: 0, recognise: 0, observe: 0, detect: 0 };
      for (let k = 0; k < room.length; k++) {
        if (room[k] !== ai) continue;
        n++; const v = best[k];
        if (v < worst) { worst = v; wk = k; }
        if (v < 25) blind++;
        for (const [id, , ppm] of DORI) if (v >= ppm) cnt[id]++;
        if (a.ppm != null && v >= a.ppm) ok++;
      }
      if (!n) return { id: a.id, name: a.name, target: a.ppm, cells: 0, pct: null, worst: null, level: null, blind: null, pass: null, worstAt: null };
      let level = null; for (const [id, name] of DORI) if (cnt[id] / n >= s.passPct) { level = name; break; }
      const wi = wk % nx, wj = Math.floor(wk / nx);
      return { id: a.id, name: a.name, target: a.ppm, cells: n, pct: ok / n, worst, level, blind: blind / n,
        pass: a.ppm == null ? null : ok / n >= s.passPct, worstAt: [x0 + (wi + 0.5) * step, y0 + (wj + 0.5) * step] };
    });
  }
  /** Share of all target cells that reach Detect, and that reach the area's own target. */
  function coverage(pred, areas) {
    let n = 0, d = 0, t = 0, tn = 0;
    for (let k = 0; k < pred.room.length; k++) {
      const ai = pred.room[k]; if (ai < 0) continue;
      n++; if (pred.best[k] >= 25) d++;
      const tg = areas[ai] && areas[ai].ppm; if (tg != null) { tn++; if (pred.best[k] >= tg) t++; }
    }
    return { detect: n ? d / n : null, target: tn ? t / tn : null, cells: n };
  }

  /** Light check: scene light (lux, lowest) against the lowest camera minimum serving the area. null = unknown. */
  function lightCheck(lux, minLuxOfCams) { return lux == null || minLuxOfCams == null ? null : lux >= minLuxOfCams; }

  // ── storage and network ──
  function bitrate(cam, s) {
    s = Object.assign({}, DEFAULTS, s);
    if (cam.mbps > 0) return cam.mbps;
    const mp = cam.resW * cam.resH / 1e6, f = (CODECS[cam.codec || s.codec] || CODECS.h265).f;
    return mp * (cam.fps || s.fps) * f;
  }
  /** cams: [{mbps? | resW, resH, fps?, codec?}]. Storage for `days` days at `duty` recording share. */
  function storage(cams, settings) {
    const s = Object.assign({}, DEFAULTS, settings), per = cams.map(c => bitrate(c, s)), total = per.reduce((a, b) => a + b, 0);
    const gbDay = per.map(m => m * 1e6 / 8 * 86400 * s.duty / 1e9);
    const tb = total * 1e6 / 8 * 86400 * s.days * s.duty * s.overhead / 1e12;
    return { per, gbDay, total, tb, uplinkLimit: s.uplinkMbps * s.uplinkUtil, uplinkPass: total <= s.uplinkMbps * s.uplinkUtil + 1e-9 };
  }

  // ── cabling, PoE and fibre ──
  const cableRun = (from, to, settings) => { const s = Object.assign({}, DEFAULTS, settings); return (Math.abs(from.x - to.x) + Math.abs(from.y - to.y) + 2 * s.drop) * s.slack; };
  /**
   * items: [{id, watts, run}]. allowFibre (site plans): a run over the copper limit goes on fibre (media converter + local power),
   * it is not a failure; otherwise it is. Copper runs share the PoE budget of 24-port switches.
   */
  function poe(items, settings, allowFibre) {
    const s = Object.assign({}, DEFAULTS, settings), cu = [], fibre = [];
    for (const i of items) (allowFibre && (i.run || 0) > s.runLimit ? fibre : cu).push(i);
    const ports = items.length, switches = Math.max(ports ? 1 : 0, Math.ceil(ports / s.switchPorts));
    const watts = cu.reduce((t, i) => t + (i.watts || DEFAULTS.generic.watts), 0), longest = cu.reduce((m, i) => Math.max(m, i.run || 0), 0);
    const fibreM = fibre.reduce((t, i) => t + (i.run || 0), 0);
    return { ports, copper: cu.length, fibre: fibre.length, fibreM, switches, watts, budget: switches * s.switchPoeW, longest, limit: s.runLimit,
      tooLong: cu.filter(i => (i.run || 0) > s.runLimit).map(i => i.id), fibreIds: fibre.map(i => i.id),
      pass: watts <= switches * s.switchPoeW + 1e-9 && longest <= s.runLimit + 1e-9 };
  }

  // ── auto-placement ──
  /**
   * Greedy cover: candidate positions × 12 pan angles, each scored by the uncovered sample points it would bring to their area's target.
   * args: { areas, segs, existing: [cam], spec: {resW, resH, hfov, vfov?, H, tilt}, candidates?: [{x, y}], inset, spacing, maxN, perSpot (default 2), targetH }
   * Returns { cams: [{x, y, pan}], uncovered, samples }.
   */
  function autoPlace(args) {
    const s = Object.assign({}, DEFAULTS, args), areas = (args.areas || []).filter(a => a.ppm != null), segs = args.segs || [], spec = args.spec;
    const polys = areas.map(poly), pans = Array.from({ length: 12 }, (_, i) => i * 30), maxN = args.maxN || 40;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const P of polys) for (const p of P) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
    if (!isFinite(x0)) return { cams: [], uncovered: 0, samples: 0 };
    const sstep = Math.max(1, Math.sqrt(((x1 - x0) * (y1 - y0)) / 1500)), S = [];
    for (let y = y0 + sstep / 2; y < y1; y += sstep) for (let x = x0 + sstep / 2; x < x1; x += sstep) {
      const ai = polys.findIndex(P => inside(P, x, y)); if (ai >= 0) S.push({ x, y, ppm: areas[ai].ppm });
    }
    const covered = new Array(S.length).fill(false);
    for (const c of (args.existing || [])) {
      const v = view(c);
      S.forEach((p, i) => { if (!covered[i] && density(v, p.x, p.y, s.targetH) >= p.ppm && !blocked(segs, c.x, c.y, p.x, p.y)) covered[i] = true; });
    }
    let cands = args.candidates ? args.candidates.map(c => ({ x: c.x, y: c.y })) : [];
    if (!cands.length) {
      const sp = args.spacing || 3, inset = args.inset == null ? 0.4 : args.inset;
      polys.forEach(P => {
        const cx = P.reduce((t, p) => t + p[0], 0) / P.length, cy = P.reduce((t, p) => t + p[1], 0) / P.length;
        for (let i = 0; i < P.length; i++) {
          const a = P[i], b = P[(i + 1) % P.length], len = hyp(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.round(len / sp));
          for (let k = 0; k < n; k++) {
            const t = k / n, x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t, d = hyp(cx - x, cy - y) || 1;
            cands.push({ x: x + (cx - x) / d * inset, y: y + (cy - y) / d * inset });
          }
        }
      });
    }
    // what every (candidate, pan) would cover, once
    const opts = [];
    for (const c of cands) for (const pan of pans) {
      const v = view(Object.assign({}, spec, { x: c.x, y: c.y, pan })), hit = [];
      S.forEach((p, i) => { if (density(v, p.x, p.y, s.targetH) >= p.ppm && !blocked(segs, c.x, c.y, p.x, p.y)) hit.push(i); });
      if (hit.length) opts.push({ x: c.x, y: c.y, pan, hit });
    }
    const out = [], perSpot = args.perSpot || 2, used = new Map();       // at most `perSpot` cameras at one spot (a pole, a corner)
    while (out.length < maxN) {
      let bi = -1, bg = 0;
      opts.forEach((o, i) => { if ((used.get(o.x + ',' + o.y) || 0) >= perSpot) return; let g = 0; for (const k of o.hit) if (!covered[k]) g++; if (g > bg) { bg = g; bi = i; } });
      if (bi < 0) break;
      const o = opts[bi], sk = o.x + ',' + o.y; used.set(sk, (used.get(sk) || 0) + 1);
      out.push({ x: o.x, y: o.y, pan: o.pan }); for (const k of o.hit) covered[k] = true;
    }
    return { cams: out, uncovered: covered.filter(c => !c).length, samples: S.length };
  }

  return { DORI, USES, WALLS, CODECS, KINDS, DEFAULTS, walls, blocked, view, density, reach, camChecks, predict, areaStats, coverage, lightCheck, bitrate, storage, cableRun, poe, autoPlace, inside, area };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CctvEngine;
