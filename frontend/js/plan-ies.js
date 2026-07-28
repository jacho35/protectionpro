/* ProtectionPro — IESNA LM-63 photometric files for the lux heatmap.
 *
 * The heatmap's built-in model treats every fitting as a point source radiating
 * uniformly inside a cone (see plan-lux.js). That is fine for a first pass but
 * wrong for anything with a real optic — a downlight, an asymmetric wallwasher,
 * a floodlight — because it ignores how intensity actually varies with angle.
 *
 * This module reads the manufacturer's photometric web straight from an IES
 * file (LM-63 1986/1991/1995/2002) and hands plan-lux a candela value for any
 * (vertical, horizontal) direction, so the heatmap is driven by the luminaire's
 * measured distribution instead of a cone approximation.
 *
 * Type C photometry (the interior-lighting norm) is modelled properly. Type A/B
 * files parse and are evaluated on the same grid — their angle convention
 * differs, so they are flagged rather than silently mis-projected.
 *
 * Profiles live in `planMarkup.iesProfiles` and are resampled on import to keep
 * the project JSON small; a fitting references one by `props.iesId`.
 */

const PlanIES = {
  // Resample guard: a full 37×72 asymmetric web is ~2 700 candela values, and a
  // project can hold many profiles. Above this the web is resampled onto a
  // coarser uniform grid (still far finer than the 0.5 m lux grid it feeds).
  MAX_CELLS: 1200,
  MAX_V: 37,   // 5° steps over 0–180
  MAX_H: 25,   // 15° steps over 0–360

  // ── Library ──
  profiles() {
    const pm = AppState.planMarkup;
    if (!Array.isArray(pm.iesProfiles)) pm.iesProfiles = [];
    return pm.iesProfiles;
  },
  byId(id) {
    if (!id) return null;
    return this.profiles().find(p => p.id === id) || null;
  },

  // ── Import ──
  async importFile(file) {
    try {
      const text = await file.text();
      const prof = this.parse(text);
      prof.id = AppState.planGenId('pmies');
      prof.name = prof.name || (file.name || 'IES').replace(/\.ies$/i, '');
      // Same file twice: replace in place so fittings keep their reference.
      const lib = this.profiles();
      const dup = lib.find(p => p.name === prof.name);
      if (dup) { prof.id = dup.id; lib[lib.indexOf(dup)] = prof; }
      else lib.push(prof);

      if (typeof PlanLux !== 'undefined') PlanLux.invalidate();
      if (typeof PlanMarkup !== 'undefined') { PlanMarkup.snapshot(); PlanMarkup.markDirty(); }
      if (typeof PlanUI !== 'undefined') PlanUI.renderProps();
      if (typeof PlanEngine !== 'undefined') PlanEngine.requestDraw({ fg: true });
      const warn = prof.warning ? ` — ${prof.warning}` : '';
      UI.toast(`Loaded photometry "${prof.name}": ${Math.round(prof.lumens)} lm, ${prof.watts || '?'} W, peak ${Math.round(prof.maxCd)} cd${warn}`,
        prof.warning ? 'warning' : 'success');
    } catch (e) {
      UI.alert('IES import failed: ' + (e && e.message ? e.message : e));
    }
  },

  // ── LM-63 parser ──
  // Header keywords and the TILT line are read line-wise; everything after TILT
  // is a single whitespace-separated number stream (the standard lets values
  // wrap across lines freely, so consuming positionally is the only safe read).
  parse(text) {
    if (!text || !/\S/.test(text)) throw new Error('Empty file');
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
    const meta = {};
    let i = 0, tilt = null;
    for (; i < lines.length; i++) {
      const ln = lines[i].trim();
      if (/^TILT\s*=/i.test(ln)) { tilt = ln.split('=')[1].trim().toUpperCase(); i++; break; }
      const kw = /^\[([^\]]+)\]\s*(.*)$/.exec(ln);
      if (kw) meta[kw[1].toUpperCase()] = kw[2].trim();
    }
    if (tilt === null) throw new Error('Not an IES photometric file (no TILT line)');

    const nums = [];
    for (let j = i; j < lines.length; j++) {
      for (const tok of lines[j].split(/[\s,]+/)) {
        if (!tok) continue;
        const v = Number(tok);
        if (Number.isFinite(v)) nums.push(v);
      }
    }
    let k = 0;
    const take = (n) => {
      if (k + n > nums.length) throw new Error('File ended mid-record — truncated or malformed');
      return nums.slice(k, k += n);
    };

    // TILT=INCLUDE embeds its own table before the main record.
    if (tilt === 'INCLUDE') {
      take(1);                       // lamp-to-luminaire geometry
      const nt = take(1)[0];
      if (!(nt > 0)) throw new Error('Bad TILT table');
      take(nt); take(nt);            // angles + multiplying factors
    }

    const [numLamps, lumensPerLamp, candelaMult, nV, nH, photType, unitsType,
      width, length, height] = take(10);
    const [ballast, ballastPhoto, watts] = take(3);
    if (!(nV > 0) || !(nH > 0)) throw new Error('Bad angle counts');
    const vAngles = take(nV);
    const hAngles = take(nH);
    const raw = take(nV * nH);

    // Absolute photometry (lumens/lamp = −1) means the candela values already
    // describe the luminaire; there is no lamp flux to scale by.
    const absolute = lumensPerLamp < 0;
    const scale = (candelaMult || 1) * (ballast || 1) * (ballastPhoto || 1);
    // candela[h][v] — the file stores all vertical angles for each horizontal.
    const cd = [];
    let maxCd = 0;
    for (let h = 0; h < nH; h++) {
      const row = new Float32Array(nV);
      for (let v = 0; v < nV; v++) {
        const val = raw[h * nV + v] * scale;
        row[v] = val;
        if (val > maxCd) maxCd = val;
      }
      cd.push(row);
    }

    const prof = {
      id: null,
      name: meta.LUMINAIRE || meta.LUMCAT || meta.TEST || '',
      manufacturer: meta.MANUFAC || '',
      photType, unitsType, absolute,
      lumens: absolute ? 0 : Math.abs(numLamps || 1) * lumensPerLamp,
      watts: watts || 0,
      dims: { width, length, height },
      vAngles, hAngles, cd, maxCd,
    };
    // Absolute files have no rated flux; integrate the web so the fitting can
    // still be scaled and reported in lumens.
    if (!prof.lumens) prof.lumens = this.totalFlux(prof);
    if (photType === 2 || photType === 3) {
      prof.warning = `Type ${photType === 2 ? 'B' : 'A'} photometry — angles are evaluated on the Type C convention, so off-axis values are approximate`;
    }
    return this.compact(prof);
  },

  // Numerically integrate the web to a luminous flux (lm) — zonal-cavity style
  // sum of I·dΩ over the measured solid angle. Used for absolute photometry and
  // for the reported efficacy.
  totalFlux(prof) {
    const { vAngles, hAngles } = prof;
    const D = Math.PI / 180;
    let flux = 0;
    for (let vi = 0; vi < vAngles.length; vi++) {
      // Zone spanned by this vertical angle (half-way to each neighbour).
      const v = vAngles[vi];
      const v0 = vi === 0 ? v : (v + vAngles[vi - 1]) / 2;
      const v1 = vi === vAngles.length - 1 ? v : (v + vAngles[vi + 1]) / 2;
      const zone = 2 * Math.PI * (Math.cos(v0 * D) - Math.cos(v1 * D));
      if (!(zone > 0)) continue;
      // Mean intensity around the azimuth at this vertical angle.
      let sum = 0;
      for (let hi = 0; hi < hAngles.length; hi++) sum += prof.cd[hi][vi];
      flux += (sum / hAngles.length) * zone;
    }
    return Math.max(0, flux);
  },

  // Resample an oversized web onto a coarser uniform grid so the project JSON
  // stays small. The lux grid it feeds is 0.5 m, far coarser than 5°/15°.
  compact(prof) {
    const nV = prof.vAngles.length, nH = prof.hAngles.length;
    if (nV * nH <= this.MAX_CELLS) return this._toPlain(prof);
    const vMax = prof.vAngles[nV - 1], vMin = prof.vAngles[0];
    const hMax = prof.hAngles[nH - 1], hMin = prof.hAngles[0];
    const tv = Math.min(nV, this.MAX_V), th = Math.min(nH, this.MAX_H);
    const vA = [], hA = [];
    for (let i = 0; i < tv; i++) vA.push(vMin + (vMax - vMin) * (tv === 1 ? 0 : i / (tv - 1)));
    for (let i = 0; i < th; i++) hA.push(hMin + (hMax - hMin) * (th === 1 ? 0 : i / (th - 1)));
    const cd = [];
    for (let hi = 0; hi < th; hi++) {
      const row = new Float32Array(tv);
      for (let vi = 0; vi < tv; vi++) row[vi] = this._sample(prof, vA[vi], hA[hi]);
      cd.push(row);
    }
    const out = { ...prof, vAngles: vA, hAngles: hA, cd, resampled: true };
    return this._toPlain(out);
  },

  // Plain arrays (Float32Array does not survive JSON) + the derived numbers the
  // UI shows, so a reloaded profile needs no re-derivation.
  _toPlain(prof) {
    const cd = prof.cd.map(r => Array.from(r, v => +v.toFixed(2)));
    let maxCd = 0;
    for (const r of cd) for (const v of r) if (v > maxCd) maxCd = v;
    return {
      ...prof,
      vAngles: prof.vAngles.map(v => +v.toFixed(2)),
      hAngles: prof.hAngles.map(v => +v.toFixed(2)),
      cd, maxCd,
      lumens: +(prof.lumens || 0).toFixed(1),
    };
  },

  // ── Evaluation ──
  // Fold an azimuth into the planes the file actually measured, and return the
  // bracketing indices. LM-63 exploits luminaire symmetry: a single 0° plane is
  // axially symmetric, 0–90 quadrant symmetric, 0–180 bilateral, 0–360 fully
  // asymmetric. A full-circle file usually stops short of 360 (…, 270), so an
  // azimuth past the last plane wraps back to the first rather than clamping —
  // clamping would flatten the whole final sector onto one plane.
  _hIndex(prof, hDeg) {
    const hA = prof.hAngles, n = hA.length;
    if (n === 1) return { i: 0, j: 0, t: 0 };
    const last = hA[n - 1];
    const full = last > 180.001;
    let h = ((hDeg % 360) + 360) % 360;
    if (last <= 90.001) {
      if (h > 180) h = 360 - h;
      if (h > 90) h = 180 - h;
    } else if (!full) {
      if (h > 180) h = 360 - h;
    }
    if (h <= hA[0]) return { i: 0, j: 0, t: 0 };
    if (h >= last) {
      const span = 360 + hA[0] - last;
      if (full && span > 0.001) return { i: n - 1, j: 0, t: Math.min(1, (h - last) / span) };
      return { i: n - 1, j: n - 1, t: 0 };
    }
    return this._bracket(hA, h);
  },

  // Bracketing index + fraction for `x` in an ascending angle list.
  _bracket(arr, x) {
    if (x <= arr[0]) return { i: 0, j: 0, t: 0 };
    const n = arr.length;
    if (x >= arr[n - 1]) return { i: n - 1, j: n - 1, t: 0 };
    let i = 0;
    while (i < n - 1 && arr[i + 1] < x) i++;
    const span = arr[i + 1] - arr[i];
    return { i, j: i + 1, t: span > 0 ? (x - arr[i]) / span : 0 };
  },

  _sample(prof, vDeg, hDeg) {
    const V = this._bracket(prof.vAngles, vDeg);
    const H = this._hIndex(prof, hDeg);
    const g = (hi, vi) => prof.cd[hi][vi];
    const a = g(H.i, V.i) * (1 - V.t) + g(H.i, V.j) * V.t;
    const b = g(H.j, V.i) * (1 - V.t) + g(H.j, V.j) * V.t;
    return a * (1 - H.t) + b * H.t;
  },

  // Candela in a direction, in the luminaire's own frame.
  //   vDeg — angle from nadir (0 = straight down)
  //   hDeg — azimuth around nadir, 0 along the luminaire's own axis
  // Beyond the measured vertical range the file says nothing is emitted, so
  // return 0 rather than clamping to the last measured value (which would
  // invent uplight a downlight does not have).
  intensity(prof, vDeg, hDeg) {
    if (!prof || !prof.cd || !prof.cd.length) return 0;
    const vA = prof.vAngles;
    if (vDeg < vA[0] - 0.001 || vDeg > vA[vA.length - 1] + 0.001) return 0;
    return this._sample(prof, vDeg, hDeg);
  },
};
