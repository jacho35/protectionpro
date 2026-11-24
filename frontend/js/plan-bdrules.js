/**
 * PlanBdRules — design-basis rule tables for the Building auto design (pure, node-testable:
 * testing/unit/bdrules.test.js). The geometry (plan-bdgeom.js) takes a radius as an input;
 * this file is where that radius, the mounting limits, call-point distances, sounder levels
 * and zone limits come from. Every value is { v, ref, provisional } — `ref` is the clause it
 * was read from and `provisional` is true until it has been checked against the licensed copy.
 *
 * Bases:
 *   sans    SANS 10139:2021 (Ed 4) — every value below was read from the standard's text.
 *   nfpa72  NFPA 72 (2016) — read from the standard's text; the heat detector's listed spacing is an input (the default is flagged provisional)
 *   bs5839  BS 5839-1 — SANS 10139 is based on it, so the SANS values are used with every one marked provisional until checked against the BS text
 * A basis with `pending` set has no values: `value()` returns null, `detector()` etc. return null.
 *
 * SANS 10139 gives a fixed horizontal distance per detector type (no reduction for ceiling
 * height): the height only decides whether the detector type is allowed (`ceilingCheck`).
 * Sloped ceilings at the apex lengthen the distance (`slopeFactor`).
 */
const PlanBdRules = (() => {
  const r = (v, ref, provisional = false) => ({ v, ref, provisional });

  const SANS = {
    id: 'sans',
    name: 'SANS 10139:2021',
    detector: {
      // Largest horizontal distance from any point to the nearest detector, under a flat ceiling.
      smoke: { radius: r(7.5, '8.15.3(a)(1)'), corridorSpacing: r(15, '8.15.3(a) note 1'), mount: { min: r(0.025, '8.15.3(e)(1)'), max: r(0.6, '8.15.3(e)(1)') }, apexDrop: r(0.6, '8.15.3(d)(1)') },
      heat: { radius: r(5.3, '8.15.3(a)(2)'), corridorSpacing: r(10.6, '8.15.3(a) note 1'), mount: { min: r(0.025, '8.15.3(e)(2)'), max: r(0.15, '8.15.3(e)(2)') }, apexDrop: r(0.15, '8.15.3(d)(2)') },
      // A multi-sensor detector is spaced for its least sensitive sensor (heat) when the smoke sensor can be disabled.
      combo: { radius: r(7.5, '8.15.3(a)(1)'), radiusIfHeatOnly: r(5.3, '8.15.3(a)(2) / note 2'), corridorSpacing: r(15, '8.15.3(a) note 1'), mount: { min: r(0.025, '8.15.3(e)(1)'), max: r(0.6, '8.15.3(e)(1)') } },
      co: { radius: r(7.5, '8.15.4'), corridorSpacing: r(15, '8.15.4'), mount: { min: r(0.025, '8.15.3(e)(1)'), max: r(0.6, '8.15.3(e)(1)') } },
      beam: { radius: r(7.5, '8.15.5(a)'), minHeightWhereWalked: r(2.7, '8.15.5(f)') },
      lineHeat: { radius: r(5.3, '8.15.6(a)') },
    },
    // Percent per degree of ceiling slope, for a detector at or near the apex, up to a maximum.
    slope: { perDegreePct: r(1, '8.15.3(c)'), maxPct: r(25, '8.15.3(c)') },
    // Table 3: generally applicable maximum ceiling height; and the limit for small sections (≤ 10 % of the area).
    ceiling: {
      heatA1: { max: r(9.0, 'Table 3'), small: r(10.5, 'Table 3') },
      heatOther: { max: r(7.5, 'Table 3'), small: r(10.5, 'Table 3') },
      smoke: { max: r(10.5, 'Table 3'), small: r(12.5, 'Table 3') },
      co: { max: r(10.5, 'Table 3'), small: r(12.5, 'Table 3') },
      beam: { max: r(25.0, 'Table 3'), small: r(25.0, 'Table 3') },
      beamEnhanced: { max: r(40.0, 'Table 3'), small: r(43.0, 'Table 3') },
      smallSectionShare: r(0.10, '8.15.9.1'),
    },
    // Distance from walls and obstructions (m).
    siting: {
      wallClearance: r(0.5, '8.15.3(h)'),                 // walls, partitions, beams / ductwork deeper than 250 mm
      obstructionDepthForWall: r(0.25, '8.15.3(h)'),
      attachmentClearanceFactor: r(2, '8.15.3(i)'),       // × the depth of an isolated attachment ≤ 250 mm
      partitionAsWallWithin: r(0.3, '8.15.3(j)'),         // a partition / rack within this of the ceiling counts as a wall
      beamAsWallFraction: r(0.10, '8.15.3(k)'),           // a beam deeper than this share of the ceiling height counts as a wall
      airInlet: r(1.0, '8.15.3(l)'),
      clearBelow: r(0.5, '8.15.3(o)'),
      voidMin: r(0.8, '8.15.2(d)'),                       // a void this high or more is protected
      shaftWithin: r(1.5, '8.15.2(c)'),
    },
    // Table 1 (honeycomb ceilings) and Table 2 (closely spaced joists): by overall ceiling height into the cell, smoke (heat), m.
    honeycomb: [
      { upTo: 3, smoke: r(4.5, 'Table 1'), heat: r(3.0, 'Table 1') },
      { upTo: 4, smoke: r(5.5, 'Table 1'), heat: r(4.0, 'Table 1') },
      { upTo: 5, smoke: r(6.0, 'Table 1'), heat: r(4.5, 'Table 1') },
      { upTo: Infinity, smoke: r(6.5, 'Table 1'), heat: r(5.0, 'Table 1') },
    ],
    joists: [
      { upTo: 3, smoke: r(2.3, 'Table 2'), heat: r(1.5, 'Table 2') },
      { upTo: 4, smoke: r(2.8, 'Table 2'), heat: r(2.0, 'Table 2') },
      { upTo: 5, smoke: r(3.0, 'Table 2'), heat: r(2.3, 'Table 2') },
      { upTo: Infinity, smoke: r(3.3, 'Table 2'), heat: r(2.5, 'Table 2') },
    ],
    joistCellMax: { smoke: r(10.6, '8.15.3(m)'), heat: r(7.5, '8.15.3(m)') },
    callPoint: {
      height: r(1.4, '8.13.2(i)'),
      heightTolerance: r(0.3, '8.13.2(i) note 2'),
      travel: r(45, '8.13.2(e)'),                          // along the route actually walked
      straight: r(30, '8.13.2(e)'),                        // straight line while the final layout is unknown
      travelReduced: r(25, '8.13.2(f)'),                   // limited mobility, or rapid fire development
      straightReduced: r(16, '8.13.2(f)'),
      maxDelayS: r(3, '8.13.2(c)'),
      type: r('A', '8.13.2(a)'),
    },
    sounder: {
      minDb: r(65, '8.9.2.1(a)(1)'),
      minDbReduced: r(60, '8.9.2.1(a)(1)'),                // stairways, enclosures up to about 60 m², points of limited extent
      reducedAreaM2: r(60, '8.9.2.1(a)(1)(ii)'),
      aboveBackground: r(5, '8.9.2.1(a)(2)'),              // when background noise exceeds backgroundOver
      backgroundOver: r(60, '8.9.2.1(a)(2)'),
      bedheadDb: r(75, '8.9.2.1(a)(3)'),
      maxDb: r(120, '8.9.2.1(a)(4)'),
      freq: { min: r(500, '8.9.2.1(b)'), max: r(1000, '8.9.2.1(b)') },
      skipBelowM2: r(1, '8.9.2.1(a)(1)'),                  // enclosures smaller than this are exempt
    },
    visual: {
      ambientOverDb: r(90, '8.10.2(a)'),
      flashPerMin: { min: r(30, '8.10.2(c)'), max: r(130, '8.10.2(c)') },
      minHeight: r(2.1, '8.10.2(f)'),
    },
    zone: {
      maxAreaM2: r(2000, '8.6.2.3(a)'),                    // zones with non-addressable automatic detectors; also call-point-only zones
      maxAreaOpenPlanM2: r(10000, '8.6.2.2'),              // call-point-only zone that is one open-plan area
      searchDistance: r(60, '8.6.2.3(b)'),
      singleStoreyAboveM2: r(300, '8.6.2.1(b)'),           // a building larger than this: one storey per zone
      stairwellOwnZone: r(true, '8.6.2.3(c)'),
    },
  };


  // NFPA 72 (2016 edition). Spacing is a LISTED spacing times 0.7 (17.6.3.1.1(2), 17.7.3.2.3.1(2)): every point of a smooth
  // ceiling is within 0.7 S of a detector. Smoke detectors use the nominal 30 ft (9.1 m); heat detectors use the spacing on their
  // listing (an input), reduced for ceiling height by Table 17.6.3.5.1. Metric figures are the code's own.
  // Not filled in because the clause does not give a plain figure: beams / joists / slope reductions for smoke, zone limits.
  const NFPA = {
    id: 'nfpa72',
    name: 'NFPA 72 (2016)',
    detector: {
      smoke: { spacing: r(9.1, '17.7.3.2.3.1'), factor: r(0.7, '17.7.3.2.3.1(2)'), mount: { sidewallMax: r(0.3, '17.7.3.2.1') } },
      // The listed spacing of a heat detector is on its data sheet; the default is the minimum a combination detector's heat sensor must carry.
      heat: { spacing: r(15.2, '17.6.3.6 (minimum for a combination detector) — use the detector\'s listed spacing', true), factor: r(0.7, '17.6.3.1.1(2)'), mount: { sidewallMin: r(0.1, '17.6.3.1.3.1'), sidewallMax: r(0.3, '17.6.3.1.3.1') } },
      combo: { spacing: r(9.1, '17.7.3.2.3.1'), factor: r(0.7, '17.7.3.2.3.1(2)'), heatSpacingMin: r(15.2, '17.6.3.6') },
    },
    // Table 17.6.3.5.1: heat spacing multiplier by ceiling height (m), rows are "greater than … up to and including …".
    heatHeight: [
      { over: 0, upTo: 3.0, f: r(1.00, 'Table 17.6.3.5.1') }, { over: 3.0, upTo: 3.7, f: r(0.91, 'Table 17.6.3.5.1') },
      { over: 3.7, upTo: 4.3, f: r(0.84, 'Table 17.6.3.5.1') }, { over: 4.3, upTo: 4.9, f: r(0.77, 'Table 17.6.3.5.1') },
      { over: 4.9, upTo: 5.5, f: r(0.71, 'Table 17.6.3.5.1') }, { over: 5.5, upTo: 6.1, f: r(0.64, 'Table 17.6.3.5.1') },
      { over: 6.1, upTo: 6.7, f: r(0.58, 'Table 17.6.3.5.1') }, { over: 6.7, upTo: 7.3, f: r(0.52, 'Table 17.6.3.5.1') },
      { over: 7.3, upTo: 7.9, f: r(0.46, 'Table 17.6.3.5.1') }, { over: 7.9, upTo: 8.5, f: r(0.40, 'Table 17.6.3.5.1') },
      { over: 8.5, upTo: 9.1, f: r(0.34, 'Table 17.6.3.5.1') },
    ],
    heatMinSpacingOfHeight: r(0.4, '17.6.3.5.2'),
    heatMaxHeight: r(9.1, '17.6.3.5.1'),
    callPoint: {
      heightMin: r(1.07, '17.14.5'), heightMax: r(1.22, '17.14.5'),
      withinExit: r(1.5, '17.14.8.4'),
      travel: r(61, '17.14.8.5'),                           // measured horizontally on the same floor
      groupedOpeningOver: r(12.2, '17.14.8.6'),
    },
    sounder: {
      publicAboveAmbient: r(15, '18.4.3.1'),                // or 5 dB above the maximum level lasting 60 s or more, whichever is greater
      privateAboveAmbient: r(10, '18.4.4.1'),
      aboveMaxSustained: r(5, '18.4.3.1'),
      sleepingAboveAmbient: r(15, '18.4.5.1'),
      sleepingPillowDb: r(75, '18.4.5.1'),                  // at the pillow, with doors closed (18.4.5.2)
      maxDb: r(110, '18.4.1.2'),                            // ambient plus every operating appliance, 1.5 m above the floor
      measureHeight: r(1.5, '18.4.3.1'),
    },
    visual: {
      heightMin: r(2.03, '18.5.5.1'), heightMax: r(2.44, '18.5.5.1'),
      flashHz: { min: r(1, '18.5.3.1'), max: r(2, '18.5.3.1') },
      maxCd: r(1000, '18.5.3.4'),
      corridorCd: r(15, '18.5.5.5.3'), corridorMaxWidth: r(6.1, '18.5.5.5.2'),
      corridorFromEnd: r(4.57, '18.5.5.5.5'), corridorSeparation: r(30.5, '18.5.5.5.5'),
      sleepingCd: { ceilingGap24in: r(110, 'Table 18.5.5.7.2'), lower: r(177, 'Table 18.5.5.7.2') },
      sleepingMaxFromPillow: r(4.87, '18.5.5.7.3'),
      // Table 18.5.5.4.1(a): wall-mounted, maximum square room side (m) → minimum cd, one light per room / four lights (one per wall); null = not allowable.
      room: [
        { side: 6.10, one: r(15, 'Table 18.5.5.4.1(a)'), four: null }, { side: 8.53, one: r(30, 'Table 18.5.5.4.1(a)'), four: null },
        { side: 9.14, one: r(34, 'Table 18.5.5.4.1(a)'), four: null }, { side: 12.2, one: r(60, 'Table 18.5.5.4.1(a)'), four: r(15, 'Table 18.5.5.4.1(a)') },
        { side: 13.7, one: r(75, 'Table 18.5.5.4.1(a)'), four: r(19, 'Table 18.5.5.4.1(a)') }, { side: 15.2, one: r(94, 'Table 18.5.5.4.1(a)'), four: r(30, 'Table 18.5.5.4.1(a)') },
        { side: 16.5, one: r(110, 'Table 18.5.5.4.1(a)'), four: r(30, 'Table 18.5.5.4.1(a)') }, { side: 16.8, one: r(115, 'Table 18.5.5.4.1(a)'), four: r(30, 'Table 18.5.5.4.1(a)') },
        { side: 18.3, one: r(135, 'Table 18.5.5.4.1(a)'), four: r(30, 'Table 18.5.5.4.1(a)') }, { side: 19.2, one: r(150, 'Table 18.5.5.4.1(a)'), four: r(37, 'Table 18.5.5.4.1(a)') },
        { side: 20.7, one: r(177, 'Table 18.5.5.4.1(a)'), four: r(43, 'Table 18.5.5.4.1(a)') }, { side: 21.3, one: r(184, 'Table 18.5.5.4.1(a)'), four: r(60, 'Table 18.5.5.4.1(a)') },
        { side: 24.4, one: r(240, 'Table 18.5.5.4.1(a)'), four: r(60, 'Table 18.5.5.4.1(a)') }, { side: 27.4, one: r(304, 'Table 18.5.5.4.1(a)'), four: r(95, 'Table 18.5.5.4.1(a)') },
        { side: 30.5, one: r(375, 'Table 18.5.5.4.1(a)'), four: r(95, 'Table 18.5.5.4.1(a)') }, { side: 33.5, one: r(455, 'Table 18.5.5.4.1(a)'), four: r(135, 'Table 18.5.5.4.1(a)') },
        { side: 36.6, one: r(540, 'Table 18.5.5.4.1(a)'), four: r(135, 'Table 18.5.5.4.1(a)') }, { side: 39.6, one: r(635, 'Table 18.5.5.4.1(a)'), four: r(185, 'Table 18.5.5.4.1(a)') },
      ],
    },
  };

  // SANS 10139 is based on BS 5839-1, so the BS basis starts from the SANS values. The BS text itself has not been checked:
  // every value is provisional and its ref says so, until it is compared with the BS 5839-1 copy. (EN 54 parts are product
  // standards — they set what a detector or sounder must do, not where it goes — so they add no siting values.)
  function derive(src, id, name) {
    const walk = o => {
      if (Array.isArray(o)) return o.map(walk);
      if (o && typeof o === 'object') {
        if ('v' in o && 'ref' in o) return { v: o.v, ref: 'SANS 10139 ' + o.ref + ' (BS 5839-1 equivalent not checked)', provisional: true };
        const out = {}; for (const k of Object.keys(o)) out[k] = walk(o[k]); return out;
      }
      return o;
    };
    const b = walk(src); b.id = id; b.name = name; return b;
  }

  const BASES = {
    sans: SANS,
    bs5839: derive(SANS, 'bs5839', 'BS 5839-1 (as adopted in SANS 10139)'),
    nfpa72: NFPA,
  };

  const basis = id => BASES[id || 'sans'] || null;
  const ready = id => { const b = basis(id); return !!b && !b.pending; };
  const val = x => (x && typeof x === 'object' && 'v' in x ? x.v : x);

  /** Read one value by path ('sounder.minDb') → { v, ref, provisional }, or null if the basis has no table. */
  function value(id, path) {
    const b = basis(id); if (!b || b.pending) return null;
    let o = b; for (const k of String(path).split('.')) { if (o == null) return null; o = o[k]; }
    return o && typeof o === 'object' && 'v' in o ? o : null;
  }

  /** Slope lengthening for a detector at or near the apex: 1 % per degree, at most 25 %. */
  function slopeFactor(id, slopeDeg) {
    const b = basis(id); if (!ready(id) || !b.slope) return 1;
    const pct = Math.min(val(b.slope.maxPct), Math.max(0, slopeDeg || 0) * val(b.slope.perDegreePct));
    return 1 + pct / 100;
  }

  /**
   * Horizontal coverage radius for a detector type: { radius, ref, provisional } or null.
   * opts: slopeDeg + atApex (pitched ceiling), heatOnly (multi-sensor with the smoke sensor disabled).
   */
  function detector(id, type, opts = {}) {
    if (!ready(id)) return null;
    const b = basis(id), d = b.detector[type]; if (!d) return null;
    if (d.spacing) {                                         // NFPA model: 0.7 × (listed) spacing, heat reduced for ceiling height
      let S = opts.listedSpacing != null ? opts.listedSpacing : val(d.spacing), ref = d.spacing.ref, prov = !!d.spacing.provisional && opts.listedSpacing == null;
      if (type === 'heat') {
        const H = opts.ceilH != null ? opts.ceilH : 0;
        if (H > val(b.heatMaxHeight)) return null;           // above 30 ft Table 17.6.3.5.1 gives nothing
        const row = b.heatHeight.find(x => H > x.over && H <= x.upTo) || b.heatHeight[0];
        S = Math.max(S * val(row.f), val(b.heatMinSpacingOfHeight) * H); ref += ' + Table 17.6.3.5.1 / 17.6.3.5.2';
      }
      return { radius: val(d.factor) * S, ref: d.factor.ref + ' / ' + ref, provisional: prov };
    }
    let base = d.radius;
    if (type === 'combo' && opts.heatOnly && d.radiusIfHeatOnly) base = d.radiusIfHeatOnly;
    const f = opts.atApex ? slopeFactor(id, opts.slopeDeg) : 1;
    return { radius: val(base) * f, ref: base.ref + (f > 1 ? ' + 8.15.3(c)' : ''), provisional: base.provisional };
  }

  /** Wall clearance and mounting band (m) the layout should use for a detector type. */
  function siting(id, type) {
    if (!ready(id)) return null;
    const b = basis(id), d = b.detector[type];
    if (!b.siting) {                                         // NFPA: no wall-distance rule for the ceiling; 100 mm from a sidewall for heat (17.6.3.1.3.1)
      const m = d && d.mount;
      return { clearance: type === 'heat' ? val(m.sidewallMin) : 0.1, mount: null, ref: type === 'heat' ? '17.6.3.1.3.1' : '17.7.3.2 (no wall distance stated; 100 mm used as a practical minimum)', provisional: type !== 'heat' };
    }
    return { clearance: val(b.siting.wallClearance), mount: d && d.mount ? { min: val(d.mount.min), max: val(d.mount.max) } : null, ref: b.siting.wallClearance.ref };
  }

  /**
   * Is the ceiling too high for this detector type (Table 3)? type: smoke | heat | heatA1 | co | combo | beam | beamEnhanced.
   * `smallShare` = the share of the protected area whose ceiling is above the general limit (0–1).
   * → { ok, max, small, level: 'ok' | 'small-sections' | 'too-high', ref }
   */
  function ceilingCheck(id, type, ceilH, smallShare = 0) {
    if (!ready(id)) return null;
    const b = basis(id);
    if (!b.ceiling) {                                        // NFPA: heat detectors are covered up to 30 ft by Table 17.6.3.5.1; smoke has no fixed limit (17.7.3.2.3.3)
      if (type === 'heat') { const m = val(b.heatMaxHeight); return ceilH <= m ? { ok: true, max: m, small: m, level: 'ok', ref: '17.6.3.5.1' } : { ok: false, max: m, small: m, level: 'too-high', ref: '17.6.3.5.1' }; }
      return { ok: true, max: null, small: null, level: 'no-limit', ref: '17.7.3.2.3.3' };
    }
    const c = b.ceiling;
    const key = type === 'heat' ? 'heatOther' : type === 'combo' ? 'heatOther' : type;   // a multi-sensor detector is limited by its weakest sensor
    const row = c[key]; if (!row) return null;
    const max = val(row.max), small = val(row.small), share = val(c.smallSectionShare);
    if (ceilH <= max) return { ok: true, max, small, level: 'ok', ref: row.max.ref };
    if (ceilH <= small && smallShare <= share) return { ok: true, max, small, level: 'small-sections', ref: row.max.ref + ' / 8.15.9.1' };
    return { ok: false, max, small, level: 'too-high', ref: row.max.ref };
  }

  function band(table, H, key) {
    for (const row of table) if (Math.round(H) <= row.upTo) return val(row[key]);
    return val(table[table.length - 1][key]);
  }
  /** Honeycomb ceiling (Table 1): max distance from any point to the nearest detector, by overall height into the cell. */
  function honeycomb(id, type, H) { return ready(id) && basis(id).honeycomb ? band(basis(id).honeycomb, H, type === 'heat' ? 'heat' : 'smoke') : null; }
  /** Closely spaced joists (Table 2): max spacing between detectors across the joists. */
  function joists(id, type, H) { return ready(id) && basis(id).joists ? band(basis(id).joists, H, type === 'heat' ? 'heat' : 'smoke') : null; }

  /** Call-point travel limits (m): { travel, straight, ref }; `reduced` for limited mobility or rapid fire development. */
  function callPoint(id, reduced = false) {
    if (!ready(id)) return null;
    const c = basis(id).callPoint;
    if (c.heightMin) {                                       // NFPA: one distance, measured horizontally; a height band; within 1.5 m of every exit doorway
      const t = val(c.travel);
      return { travel: t, straight: t, height: (val(c.heightMin) + val(c.heightMax)) / 2, heightMin: val(c.heightMin), heightMax: val(c.heightMax), withinExit: val(c.withinExit), ref: '17.14.8.5' };
    }
    return { travel: val(reduced ? c.travelReduced : c.travel), straight: val(reduced ? c.straightReduced : c.straight), height: val(c.height), ref: reduced ? '8.13.2(f)' : '8.13.2(e)' };
  }

  /**
   * Sounder level the alarm must reach at a point (dB(A)): the minimum for the room, raised to
   * background + 5 dB when the background is over 60 dB(A), or 75 dB(A) at a bedhead.
   * room: { areaM2, stair, sleeping, backgroundDb }. → { target, max, ref }
   */
  function sounderTarget(id, room = {}) {
    if (!ready(id)) return null;
    const s = basis(id).sounder;
    if (s.publicAboveAmbient) {                              // NFPA: relative to the measured ambient (dBA) — the code gives no absolute minimum except at a sleeper's pillow
      const above = room.sleeping ? val(s.sleepingAboveAmbient) : room.private ? val(s.privateAboveAmbient) : val(s.publicAboveAmbient);
      const ref = room.sleeping ? s.sleepingAboveAmbient.ref : room.private ? s.privateAboveAmbient.ref : s.publicAboveAmbient.ref;
      const cand = [];
      if (room.backgroundDb != null) cand.push(room.backgroundDb + above);
      if (room.maxSustainedDb != null) cand.push(room.maxSustainedDb + val(s.aboveMaxSustained));
      if (room.sleeping) cand.push(val(s.sleepingPillowDb));
      return { target: cand.length ? Math.max(...cand) : null, needsAmbient: room.backgroundDb == null, max: val(s.maxDb), ref };
    }
    if (room.areaM2 != null && room.areaM2 < val(s.skipBelowM2)) return { target: 0, max: val(s.maxDb), ref: s.skipBelowM2.ref };
    let t = val(s.minDb), ref = s.minDb.ref;
    if (room.stair || (room.areaM2 != null && room.areaM2 <= val(s.reducedAreaM2))) { t = val(s.minDbReduced); ref = s.minDbReduced.ref; }
    if (room.backgroundDb != null && room.backgroundDb > val(s.backgroundOver)) { t = Math.max(t, room.backgroundDb + val(s.aboveBackground)); ref = s.aboveBackground.ref; }
    if (room.sleeping) { t = Math.max(t, val(s.bedheadDb)); ref = s.bedheadDb.ref; }
    return { target: t, max: val(s.maxDb), ref };
  }

  /** Is a visual alarm needed for this room (ambient noise over the limit)? */
  function needsVisual(id, ambientDb) { return ready(id) && basis(id).visual.ambientOverDb && ambientDb != null && ambientDb > val(basis(id).visual.ambientOverDb); }

  /** NFPA 72 Table 18.5.5.4.1(a): minimum effective intensity (cd) for a wall-mounted strobe covering a square room of this side (m); null if the basis has no such table. */
  function visualRoom(id, sideM, lights = 1) {
    if (!ready(id) || !basis(id).visual.room) return null;
    const row = basis(id).visual.room.find(x => sideM <= x.side + 1e-9); if (!row) return { cd: null, ok: false, ref: 'Table 18.5.5.4.1(a)' };
    const v = lights >= 4 ? row.four : row.one;
    return v ? { cd: val(v), ok: true, ref: v.ref } : { cd: null, ok: false, ref: row.one.ref };
  }

  /** Zone limits as plain numbers. */
  function zoneLimits(id) {
    if (!ready(id) || !basis(id).zone) return null;
    const z = basis(id).zone;
    return { maxAreaM2: val(z.maxAreaM2), maxAreaOpenPlanM2: val(z.maxAreaOpenPlanM2), searchDistance: val(z.searchDistance), singleStoreyAboveM2: val(z.singleStoreyAboveM2) };
  }


  // ---- Detector type per room use -------------------------------------------------------------------
  // SANS 10139 has no table from room use to detector type (Annex D.1 is a blank design form), so this is
  // a PROJECT DEFAULT the user edits (planMarkup.settings.fire.useDetector overrides any row), not a clause.
  // `why` points at the guidance text the default follows.
  const ROOM_USES = [
    { id: 'office',    name: 'Office / meeting room',   detector: 'smoke', why: '8.14.1.8.10: smoke detectors respond faster than heat' },
    { id: 'corridor',  name: 'Corridor / escape route', detector: 'smoke', why: '8.14.1.8.5: optical smoke detectors suit escape routes' },
    { id: 'stair',     name: 'Stairway / lobby',        detector: 'smoke', why: '8.14.1.8.5; 8.15.2(b)' },
    { id: 'sleeping',  name: 'Sleeping accommodation',  detector: 'smoke', why: '8.1.1.2.5: heat detectors do not respond quickly enough where sleeping occupants need warning' },
    { id: 'kitchen',   name: 'Kitchen / cooking area',  detector: 'heat',  why: '8.14.1.8.2: heat has the greatest immunity to false alarms; cooking is a false-alarm source' },
    { id: 'plant',     name: 'Plant / dusty or smoky process', detector: 'heat', why: '8.14.1.8.10: where processes produce smoke, fumes or dust an alternative type is needed' },
    { id: 'workshop',  name: 'Workshop (clean)',        detector: 'smoke', why: '8.14.1.8.10' },
    { id: 'warehouse', name: 'Warehouse / storage',     detector: 'smoke', why: '8.14.1.8.10 (optical beam for high open spaces: 8.14.1.8.7)' },
    { id: 'it',        name: 'Electronic equipment room', detector: 'smoke', why: '8.14.1.8.11: high-sensitivity detection is covered by SANS 246' },
    { id: 'other',     name: 'Other',                   detector: 'smoke', why: 'default' },
  ];

  /** Detector type for a room use, with the user's overrides ({ useId: type }) applied → { type, id, why, custom }. */
  function detectorFor(use, overrides = {}) {
    const row = ROOM_USES.find(u => u.id === use) || ROOM_USES[ROOM_USES.length - 1];
    const o = overrides && overrides[row.id];
    return { id: row.id, type: o || row.detector, why: o ? 'set for this project' : row.why, custom: !!o };
  }

  /** Every provisional value of a basis, as 'path (ref)' strings — empty once all are checked. */
  function provisional(id) {
    const out = [];
    const walk = (o, path) => {
      if (Array.isArray(o)) { o.forEach((x, i) => walk(x, path + '[' + i + ']')); return; }
      if (o && typeof o === 'object') {
        if ('v' in o && 'ref' in o) { if (o.provisional) out.push(path + ' (' + o.ref + ')'); return; }
        for (const k of Object.keys(o)) walk(o[k], path ? path + '.' + k : k);
      }
    };
    const b = basis(id); if (b && !b.pending) walk(b, '');
    return out;
  }

  return { basis, ready, value, slopeFactor, detector, siting, ceilingCheck, honeycomb, joists, callPoint, sounderTarget, needsVisual, visualRoom, zoneLimits, provisional, ROOM_USES, detectorFor, bases: () => Object.values(BASES).map(b => ({ id: b.id, name: b.name, pending: b.pending || null })) };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PlanBdRules;
