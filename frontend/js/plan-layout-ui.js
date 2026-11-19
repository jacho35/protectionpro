/* ProtectionPro — Plan Markup › Detect group › Auto layout.
 *
 * The plan glue for plan-layout.js: reads the erf boundaries (stored by Detect erven) and the
 * street centrelines (route type "street"), runs the layout in metres, previews it on the plan
 * and, on Create, writes real plan items: kiosks, a mini-sub, manholes, the erf markers (the
 * erf points move to their corner), service / LV / fibre routes and one crossing per
 * duct (so the BOQ counts sleeves). Everything it creates is tagged `auto: 'layout'` and is
 * replaced by the next Create; anything you drew yourself is left alone.
 *
 * Settings live in AppState.planMarkup.settings.layout and are saved with the project.
 */

const PlanLayoutUI = {
  result: null, f: null, stale: true, mode: 'front', hoverT: null, ms: 0, err: '',
  step: 1, ckFilter: 'all', _ckOpen: new Set(), _active: false,
  STEPS: ['Streets', 'Mini-subs', 'Rules', 'Review'],
  PRESET_NAMES: { standard: 'Standard', short: 'Short services', fewest: 'Fewest kiosks', crossings: 'Fewest crossings', custom: 'Custom' },
  PRESET_HINT: { standard: 'The kiosk rules most projects use.', short: 'More kiosks, so every service is short: lower volt drop and earth-fault loop.', fewest: 'Fewer, larger kiosks: the lowest kiosk count, services up to the 70 m volt-drop limit.', crossings: 'Services cross the road in as few places as possible: a crossing counts for more cable, a kiosk is kept where it saves crossings, the better side of each street is tried and markers pair up on a shared boundary.' },
  // every preset names the same settings, so choosing one puts back what another changed
  get PRESETS() {
    const D = PlanLayout.DEFAULTS, base = { n: D.n, maxc: D.maxc, worth: D.worth, xpen: D.xpen, xkiosk: D.xkiosk, kside: D.kside, corner: D.corner, xpref: D.xpref };
    return { standard: base, short: { ...base, n: 6, maxc: 50, worth: 80 }, fewest: { ...base, n: 8, maxc: 70, worth: 400 }, crossings: { ...base, xpen: 600, xkiosk: true, kside: 'try', corner: 'pair', xpref: 'few' } };
  },
  PAL: ['#2a7de1', '#d9480f', '#2b9348', '#9c36b5', '#b07800', '#0c8599', '#c2255c', '#5f3dc4'],
  SHOW: { front: true, mark: true, kiosk: true, fibre: true, lvmv: true, cross: true, trench: true },
  // trench settings: depth per cable class (m) and what shares a trench; kept apart from the layout rules (no re-solve)
  TREN: [['depth.lv', 'range', 0.4, 1.5, 0.05, 'm', 'LV, service and street-light depth'], ['depth.fi', 'range', 0.3, 1.2, 0.05, 'm', 'Fibre depth'],
    ['fibre', 'select', [['own', 'fibre in its own trench'], ['with', 'fibre in the LV trench where they run together'], ['off', 'no fibre trench']], 'Fibre'],
    ['crossings', 'check', 'A shared trench across the road at every crossing']],
  CTRL: [
    ['Marker', [['side', 'range', 1, 5, 0.5, 'm', 'From the side boundary'], ['depth', 'range', 1, 5, 0.5, 'm', 'In from the front'],
      ['corner', 'select', [['start', 'start of the street'], ['end', 'far end of the street'], ['kiosk', 'nearest its kiosk'], ['pair', 'paired on the shared boundary']], 'Front corner'],
      ['front', 'select', [['longest', 'longest street edge'], ['shortest', 'shortest street edge'], ['busy', 'the busier street']], 'A corner erf fronts its']]],
    ['Kiosks', [['kmode', 'select', [['rules', 'even runs (rule of thumb)'], ['opt', 'optimiser: fewest kiosks, then crossings, then cable']], 'Placement'],
      ['n', 'range', 4, 12, 1, '', 'Max houses per kiosk'], ['maxc', 'range', 30, 150, 5, 'm', 'Max service cable'], ['worth', 'range', 0, 600, 10, 'm', 'Extra cable accepted to save one kiosk'],
      ['kside', 'select', [['count', 'the side with more erven'], ['try', 'try both sides, keep the cheaper']], 'Kiosk side of each street'], ['xpen', 'range', 0, 600, 25, 'm', 'A road crossing counts as this much cable'], ['xkiosk', 'check', 'Keep a kiosk if removing it would add road crossings'],
      ['strN', 'range', 0, 10, 1, '', 'Most kiosks on one LV string (0 = no limit)'], ['strL', 'range', 0, 1000, 25, 'm', 'Longest LV string, mini-sub to furthest kiosk (0 = no limit)'], ['strE', 'tnum', 2, 60, 2, 'erven', 'Limit erven on one string (instead of kiosks)', 12], ['subBal', 'tnum', 1.1, 2, 0.1, '× an even share', 'Balance hand-placed mini-subs', 1.3],
      ['strMode', 'select', [['fewest', 'fewest strings'], ['even', 'strings of similar size']], 'Cut long strings into']]],
    ['Fibre', [['m', 'range', 4, 12, 1, '', 'Erven per manhole'], ['mhmerge', 'check', 'Fold a short stretch\'s manhole into its neighbour'], ['maxmh', 'range', 40, 200, 10, 'm', 'Max distance between manholes'],
      ['fibre', 'select', [['opp', 'civil side, opposite the kiosks'], ['same', 'same side as the kiosks']], 'Manholes default to the'],
      ['topo', 'select', [['ring', 'every street, closed loops'], ['spur', 'spurs with T-offs from the entry']], 'Main duct layout']]],
    ['Crossings', [['share', 'check', 'Share road crossings between services, fibre and LV'],
      ['xpref', 'select', [['near', 'at the erf\'s own boundary (cable stays on the kiosk side)'], ['few', 'at as few places as possible']], 'Services cross the road'],
      ['xmode', 'select', [['bound', 'on any erf boundary'], ['kiosk', 'only at kiosk stations']], 'Crossings may be put'],
      ['junct', 'check', 'Lay ducts across every road at all junctions, even with no cables'],
      ['j110', 'range', 0, 4, 1, '', '110 mm ducts at an empty junction'], ['j160', 'range', 0, 2, 1, '', '160 mm ducts at an empty junction'],
      ['spare', 'range', 0, 3, 1, '', 'Spare 110 mm ducts per crossing']]],
    ['Bends', [['bendFi', 'range', 0, 5, 0.25, 'm', 'Fibre duct bend radius'], ['bendLv', 'range', 0, 5, 0.25, 'm', 'LV and service cable bend radius'], ['bendMv', 'range', 0, 8, 0.25, 'm', 'MV cable bend radius']]],
    ['Corridor', [['kgeo', 'select', [['boundary', 'the erf boundary (the street line can be out)'], ['street', 'the street line (how earlier layouts were made)']], 'Kiosks and cables are placed from'],
      ['kd', 'range', 0, 4, 0.05, 'm', 'Corridor distance inside the boundary']]],
  ],

  // hover explanations for the settings that need one (native tooltip on the label and on the (?) mark)
  TIPS: {
    bendFi: 'Radius of the curve a fibre duct takes round a corner, in metres (0 = a sharp corner). The starting value is provisional: set it to your duct maker\'s minimum bend radius. A corner too tight for it gets the largest curve that fits.',
    bendLv: 'Radius of the curve an LV or service cable takes round a corner, in metres (0 = sharp). Provisional starting value: use your cable maker\'s minimum bend radius. Lengths, volt drop and quantities use the curved path.',
    bendMv: 'Radius of the curve an MV cable takes round a corner, in metres (0 = sharp). Provisional starting value: use your cable maker\'s minimum bend radius.',
    side: 'How far in from the erf\'s side boundary the service marker (where the service cable enters the erf) is placed.',
    depth: 'How far in from the front boundary the service marker is placed.',
    corner: 'Which front corner of each erf gets the marker. Start / far end of the street, or the corner nearest its kiosk. Paired puts the markers of two neighbouring erven on their shared boundary, so they share one service leg and, across the road, one crossing.',
    front: 'Which street a corner erf faces, and so where its marker and service go: the longer or the shorter of its street edges, or the busier street (the one with more erven on it).',
    kmode: 'How kiosks are placed. Even runs: a kiosk for every run of up to the maximum houses along each street. Optimiser: one solve over the whole street network, fewest kiosks first, then fewest road crossings, then least cable.',
    n: 'The most erven one kiosk may serve.',
    maxc: 'The longest service cable from a kiosk to an erf, in metres. Longer services cost more volt drop and a longer earth-fault loop, so 70 m is the usual limit. An erf beyond it is reported.',
    worth: 'How many metres of extra service cable the layout will accept to remove one kiosk. A kiosk is given up while every erf is still within the maximum service cable and the extra cable added is no more than this; a kiosk is added only if it saves more than this. Higher: fewer kiosks, longer services. 0: never trade cable for a kiosk.',
    kside: 'Which side of each street the kiosks and LV cable run along. The side with more erven is simple. Trying both sides runs the layout each way for every street and keeps the cheaper, at the cost of a slower run.',
    m: 'One fibre manhole for about this many erven along a street.',
    mhmerge: 'Where a short stretch would get its own manhole, use its neighbour\'s instead, so fewer manholes are built.',
    maxmh: 'The longest duct run between two manholes. More manholes are added where a run would be longer.',
    fibre: 'Which side of the street the fibre manholes and ducts are put by default: opposite the kiosks, or the same side.',
    topo: 'How the main fibre duct runs. Ring: every street, closed into loops. Spur: spurs with T-offs from the entry point (less duct, no second path).',
    share: 'Services, fibre and LV cable that cross the road at the same place share one crossing trench and its sleeves instead of one each.',
    xmode: 'Where a road crossing may be put: on any erf boundary, or only at kiosk stations.',
    junct: 'Lay provisional ducts across every road at every junction, even where no cable uses them yet, for later work.',
    j110: 'How many 110 mm ducts are laid at a junction crossing that carries no cable.',
    j160: 'How many 160 mm (MV size) ducts are laid at a junction crossing that carries no cable.',
    spare: 'Extra 110 mm ducts added to every crossing for future cables.',
    kgeo: 'What the kiosk, cable and manhole offsets are measured from. The erf boundary follows the plots, so a street line that is a little out moves nothing. The street line is how earlier layouts were made.',
    kd: 'How far inside the erf boundary the cables and kiosks run. Cross-sections, when switched on, set their own offsets.',
    xpref: 'Where a service for an erf across the road crosses. At the erf\'s own boundary: the cable runs along the kiosk\'s side of the road and crosses at the erf boundary nearest the erf, so the far verge only carries the last stretch. Services whose nearest boundary is the same share that crossing. At as few places as possible: fewer crossings, but the cable may cross at the kiosk and run along the far verge.',
    subBal: 'When you place the mini-subs yourself each kiosk goes to the nearest one, so one transformer can carry far more than another. Set this to cap each mini-sub at that multiple of an even share of the erven (1.3 = 30 % above even); the kiosks nearest the border move to the neighbour with room. 0 = off, nearest wins.',
    xpen: 'How many metres of cable one road crossing counts for when erven are given to kiosks. Higher keeps services on their own side of the road.',
    xkiosk: 'Giving up a kiosk is allowed while the extra service cable stays within the amount a kiosk is worth. With crossings counted, a kiosk that would add road crossings is kept unless the saving covers them (crossings counted at the figure above).',
    strE: 'The most erven carried by one string. When set, strings are cut by the erven they feed (a kiosk of six counts six) and the kiosk limit above is not used. 0 = count kiosks instead.',
    strL: 'The longest cable run from the mini-sub to the furthest kiosk on one string. Volt drop and the earth-fault loop grow with this length. Cutting a string does not shorten it (each string has its own feeder from the mini-sub along the same route), so a string over the limit is reported as a Fix: add a mini-sub nearer, or move the mini-sub. 0 = no limit.',
    strN: 'The most kiosks fed in a line from one feeder off the mini-sub. A longer street is cut into several strings, each with its own breaker and its own cable back to the mini-sub along the same route. A shorter string keeps the head breaker and the cable small and the far-end earth-fault loop short, at the price of more cable and more ways on the mini-sub board. 0 = no limit: kiosks daisy-chain along the whole street.',
    strMode: 'How a street with more kiosks than the limit is cut. Fewest strings: cut from the far end back, so as few feeders as possible leave the mini-sub, but the last string can be short (9 kiosks at a limit of 4 gives 4 + 4 + 1). Strings of similar size: the same number of feeders as the limit needs, but shared out evenly (9 kiosks gives 3 + 3 + 3), so the strings are loaded alike. On a branching network this can need more feeders.',
  },

  // ───────── settings (saved in the project, so never trusted) ─────────
  cfg() {
    const s = AppState.planMarkup.settings;
    const L = (s.layout && typeof s.layout === 'object') ? s.layout : (s.layout = {});
    const D = PlanLayout.DEFAULTS, p = L.params = (L.params && typeof L.params === 'object') ? L.params : {};
    if (Object.keys(p).length && p.xpref === undefined) p.xpref = 'few';           // a layout made before this keeps its fewest-crossings choice
    if (Object.keys(p).length && p.strN === undefined) p.strN = 0;
    if (Object.keys(p).length && p.strL === undefined) p.strL = 0;                    // a layout made before the string length limit keeps no limit                    // a layout made before strings existed keeps its one tree
    if (Object.keys(p).length && p.kgeo === undefined) p.kgeo = 'street';          // a layout set up before the boundary corridor existed keeps running the way it did
    for (const [, rows] of this.CTRL) for (const r of rows) {
      const k = r[0], v = p[k];
      if (r[1] === 'tnum') { const n = parseFloat(v); p[k] = Number.isFinite(n) && n > 0 ? Math.max(r[2], Math.min(r[3], n)) : 0; }      // 0 = off, else within the range
      else if (r[1] === 'range') { const n = parseFloat(v); p[k] = Number.isFinite(n) ? Math.max(r[2], Math.min(r[3], n)) : D[k]; }
      else if (r[1] === 'check') p[k] = typeof v === 'boolean' ? v : D[k];
      else p[k] = r[2].some(o => o[0] === v) ? v : D[k];
    }
    L.sections = PlanSections.state(L.sections);
    const T = L.trench = (L.trench && typeof L.trench === 'object') ? L.trench : {};
    const D2 = PlanLayout.TRENCH_DEFAULTS, dd = T.depth = (T.depth && typeof T.depth === 'object') ? T.depth : {};
    for (const k of ['mv', 'lv', 'fi']) { const n = parseFloat(dd[k]); dd[k] = Number.isFinite(n) ? Math.max(0.3, Math.min(3, n)) : D2.depth[k]; }
    { const n = parseFloat(dd.comb); dd.comb = Number.isFinite(n) ? Math.max(0.3, Math.min(3, n)) : null; }
    T.combine = ['separate', 'mvlv'].includes(T.combine) ? T.combine : D2.combine;
    T.fibre = ['own', 'with', 'off'].includes(T.fibre) ? T.fibre : D2.fibre;
    T.crossings = typeof T.crossings === 'boolean' ? T.crossings : D2.crossings;
    const vd = L.vd = (L.vd && typeof L.vd === 'object') ? L.vd : {};
    vd.tx = typeof vd.tx === 'string' ? vd.tx.slice(0, 80) : '';
    vd.prot = typeof vd.prot === 'string' ? vd.prot.slice(0, 80) : '';
    vd.protK = this._num(vd.protK, 1, 2, 1.2);
    vd.minSize = this._num(vd.minSize, 0, 2000, 0); vd.maxSize = this._num(vd.maxSize, 0, 2000, 0); vd.maxSizes = this._num(vd.maxSizes, 0, 20, 0); vd.autoSplit = !!vd.autoSplit;   // smallest / largest LV cable (mm², 0 = no limit)
    vd.taper = typeof vd.taper === 'boolean' ? vd.taper : true;                  // taper the LV cable (smaller feeders further out)
    vd.way80 = typeof vd.way80 === 'boolean' ? vd.way80 : true;                  // an 80 A MCCB on every erf's way
    delete vd.subsMax; delete vd.subsAuto;                                  // the mini-subs are the ones you place: there is no count to try
    vd.splits = Array.isArray(vd.splits) ? vd.splits.filter(q => q && Number.isFinite(+q.x) && Number.isFinite(+q.y)).map(q => ({ x: +q.x, y: +q.y })).slice(0, 200) : [];   // kiosks made a string head of their own
    vd.lv = typeof vd.lv === 'string' ? vd.lv.slice(0, 80) : ''; vd.svc = typeof vd.svc === 'string' ? vd.svc.slice(0, 80) : '';
    { const mv = (L.moves && typeof L.moves === 'object') ? L.moves : {}, pt = v => v && Number.isFinite(+v.x) && Number.isFinite(+v.y) ? { x: +v.x, y: +v.y } : null, key = /^-?\d+,-?\d+$/;
      L.moves = { kiosks: [], verts: {}, adds: [], cuts: [], xs: {} };                                    // parts moved by hand after a run (see "moving parts")
      (Array.isArray(mv.kiosks) ? mv.kiosks : []).slice(0, 500).forEach(m => { const a = m && pt(m.from), b = m && pt(m.to); if (a && b) L.moves.kiosks.push({ from: a, to: b }); });
      for (const [k, v] of Object.entries(mv.verts && typeof mv.verts === 'object' ? mv.verts : {}).slice(0, 5000)) { const q = pt(v); if (q && key.test(k)) L.moves.verts[k] = q; }
      (Array.isArray(mv.adds) ? mv.adds : []).slice(0, 3000).forEach(a => { const q = a && pt(a); if (q && typeof a.id === 'string' && typeof a.a === 'string' && typeof a.b === 'string') L.moves.adds.push({ id: a.id.slice(0, 20), a: a.a.slice(0, 40), b: a.b.slice(0, 40), x: q.x, y: q.y }); });
      for (const [k, v] of Object.entries(mv.xs && typeof mv.xs === 'object' ? mv.xs : {}).slice(0, 2000)) { const a = v && pt(v.a), b = v && pt(v.b); if (a && b && /^[^|]{1,80}\|-?\d+$/.test(k)) L.moves.xs[k] = { a, b }; }     // road crossings moved by hand: key = street|station, a / b = the shift of the start / end (plan points)
      L.moves.cuts = (Array.isArray(mv.cuts) ? mv.cuts : []).filter(k => typeof k === 'string' && key.test(k)).slice(0, 3000); }
    L.xsq = typeof L.xsq === 'boolean' ? L.xsq : true;                              // a moved crossing stays square to the road (both ends move along the street together)
    L.admdOk = typeof L.admdOk === 'string' ? L.admdOk.slice(0, 4000) : '';      // the Demand ADMD settings the user confirmed for the layout (a signature)
    L.sides = (L.sides && typeof L.sides === 'object') ? L.sides : {};
    L.fronts = (L.fronts && typeof L.fronts === 'object') ? L.fronts : {};
    { const mk = (L.markers && typeof L.markers === 'object') ? L.markers : {}; L.markers = {};                      // hand-placed service markers: erf id → plan point
      for (const [id, v] of Object.entries(mk).slice(0, 5000)) if (v && Number.isFinite(+v.x) && Number.isFinite(+v.y)) L.markers[String(id).slice(0, 80)] = { x: +v.x, y: +v.y }; }
    L.cuts = Array.isArray(L.cuts) ? L.cuts.filter(x => typeof x === 'string').slice(0, 500) : [];
    L.subs = Array.isArray(L.subs) ? L.subs.filter(q => q && Number.isFinite(+q.x) && Number.isFinite(+q.y)).map(q => ({ x: +q.x, y: +q.y })).slice(0, 20) : [];   // mini-subs placed by hand: free points
    if (L.sub && Number.isFinite(+L.sub.x) && Number.isFinite(+L.sub.y) && !L.subs.some(q => Math.hypot(q.x - L.sub.x, q.y - L.sub.y) < 1e-6)) L.subs.push({ x: +L.sub.x, y: +L.sub.y });   // older files held one
    delete L.sub;
    return L;
  },
  // ───────── moving parts after a run ─────────
  // A kiosk you move is pinned (the engine stands a kiosk exactly there and solves round it). Every other node (a bend or junction on a
  // cable, duct or trench route, a manhole) is a point of the result found by where it stood: `moves.verts` maps that place (metres, 5 cm
  // grid) to the new one (plan points), `adds` puts a node on a line, `cuts` takes one off. They are applied to every line that shares the
  // place, so a junction moves with all its cables. The moves are matched by position: after a rule change that moves the part they refer to, they no longer match.
  _vk(x, y) { return Math.round(x * 20) + ',' + Math.round(y * 20); },
  _polys(r) {
    const out = [], seen = new Set(), add = a => { if (Array.isArray(a) && a.length >= 2 && !seen.has(a)) { seen.add(a); out.push(a); } };
    r.erven.forEach(e => { add(e.route); add(e.duct); });
    if (r.net) { (r.net.lv || []).forEach(ed => add(ed.pts)); (r.net.lvLinks || []).forEach(l => add(l.pts)); (r.net.mv || []).forEach(ed => add(ed.pts)); }
    if (r.fibre) (r.fibre.trunks || []).concat(r.fibre.spare || []).forEach(e => add(e.pts));
    return out;
  },
  applyMoves(r) {
    this._verts = []; this._segs = [];
    const f = this.f, M = this.cfg().moves, vk = this._vk; if (!r || !f) return;
    const keep = new Set();                                                             // parts with their own way of moving: kiosks, erf markers, mini-subs
    r.kiosks.forEach(k => keep.add(vk(k.x, k.y))); r.erven.forEach(e => { if (e.marker) keep.add(vk(e.marker[0], e.marker[1])); });
    if (r.net) (r.net.subs || []).forEach(S => { keep.add(vk(S.k.x, S.k.y)); if (S.k.stub) S.k.stub.forEach(q => keep.add(vk(q[0], q[1]))); });
    const tgt = k => { const v = M.verts[k]; return v ? [v.x * f, v.y * f] : null; };
    const XS = [];                                                                      // road crossings: their ends, and the ones moved by hand
    ((r.net && r.net.cross) || []).forEach(c => {
      c.key = c.st.id + '|' + Math.round(c.s); const E = PlanLayout.crossEnds(c), mv = M.xs[c.key];
      c.ends0 = [E.a, E.b]; c.hA = E.hA; c.hB = E.hB; c.ends = null;
      if (mv) { c.ends = [[E.a[0] + mv.a.x * f, E.a[1] + mv.a.y * f], [E.b[0] + mv.b.x * f, E.b[1] + mv.b.y * f]]; XS.push({ c, a: [mv.a.x * f, mv.a.y * f], b: [mv.b.x * f, mv.b.y * f] }); }
    });
    const objs = [];                                                                    // the points that are objects, not line vertices
    if (r.fibre) { (r.fibre.mhs || []).forEach(o => objs.push(o)); (r.fibre.inter || []).forEach(o => objs.push(o)); (r.fibre.nodes || []).forEach(o => objs.push(o)); if (r.fibre.entry) objs.push(r.fibre.entry); }
    objs.forEach(o => { if (Number.isFinite(o.x) && Number.isFinite(o.y)) o.k0 = vk(o.x, o.y); });
    const objKeys = new Set(objs.map(o => o.k0).filter(Boolean)), kindOf = this._polyKinds(r);
    ((r.net && r.net.cross) || []).forEach(c => { c.relaid = { svc: 0, fi: 0, lv: 0 }; });
    const polys = this._polys(r), seenV = new Map(), seenS = new Set();
    for (const poly of polys) {
      let list = poly.map(q => ({ pt: [q[0], q[1]], k: vk(q[0], q[1]) })); list.forEach(o => { o.t = o.k; });
      for (const a of M.adds) {                                                         // a node put on a line, in the order it was made
        const out = [];
        for (let i = 0; i < list.length; i++) {
          out.push(list[i]);
          const A = list[i], B = list[i + 1];
          if (B && ((a.a === A.t && a.b === B.t) || (a.a === B.t && a.b === A.t))) out.push({ pt: [a.x * f, a.y * f], t: a.id, add: a.id });
        }
        list = out;
      }
      list = list.filter((o, i) => !(o.k && !o.add && M.cuts.includes(o.k) && !keep.has(o.k) && i > 0 && i < list.length - 1));
      list.forEach(o => { if (o.add) return; const m = !keep.has(o.k) && tgt(o.k); if (m) o.pt = m; });
      if (XS.length) list = this._relay(list, XS, this._fixedFn(M, keep, objKeys), kindOf.get(poly));
      list.forEach((o, i) => {
        const interior = i > 0 && i < list.length - 1;
        const seen = o.t ? seenV.get(o.t) : null; if (seen) { seen.interior = seen.interior || interior; }
        else if (o.t && (o.add || !keep.has(o.k))) { const v = { t: o.t, k: o.add ? null : o.k, add: o.add || null, pos: o.pt, interior }; seenV.set(o.t, v); this._verts.push(v); }
        if (i > 0 && list[i - 1].t && o.t) { const a = list[i - 1], key = a.t < o.t ? a.t + '|' + o.t : o.t + '|' + a.t; if (!seenS.has(key)) { seenS.add(key); this._segs.push({ a: a.t, b: o.t, pa: a.pt, pb: o.pt }); } }
      });
      poly.splice(0, poly.length, ...list.map(o => o.pt));
    }
    for (const o of objs) { const m = tgt(o.k0); if (m && !keep.has(o.k0)) { o.x = m[0]; o.y = m[1]; o.moved = true; } }
    r.erven.forEach(e => { if (e.fibrePt && e.duct && e.duct.length) { const q = e.duct[e.duct.length - 1]; e.fibrePt = [q[0], q[1]]; } });
    if (M.adds.length || M.cuts.length || Object.keys(M.verts).length || XS.length) PlanLayout.relength(r);          // the lengths that follow from the lines
  },
  // what is under a point (metres): a kiosk, an erf marker, a node, or a stretch of line
  // everything under a point, nearest first: kiosks, erf markers and nodes (one list, so the nearest wins and a part never hides one beside or under it)
  _moveHits(m) {
    const r = this.result; if (!r) return { pts: [], seg: null };
    const z = this.f / PlanEngine.view.zoom, tol = 9 * z, d = (x, y) => Math.hypot(x - m[0], y - m[1]), pts = [];
    const add = (o, dist, pri) => { if (dist <= tol) pts.push(Object.assign(o, { d: dist, score: dist + pri * 0.3 * tol })); };
    r.kiosks.forEach(k => add({ kind: 'kiosk', k, name: 'kiosk ' + k.id }, Math.max(0, d(k.x, k.y) - 2 * z), 0));
    r.erven.forEach(e => { if (e.marker) add({ kind: 'marker', e, name: 'erf marker' }, d(e.marker[0], e.marker[1]), 1); });
    (this._verts || []).forEach(v => add({ kind: 'vert', v, name: v.add ? 'added node' : 'node' }, d(v.pos[0], v.pos[1]), 2));
    pts.sort((a, b) => a.score - b.score);
    let seg = null;
    if (!pts.length) for (const sg of (this._segs || [])) {
      const dx = sg.pb[0] - sg.pa[0], dy = sg.pb[1] - sg.pa[1], L2 = dx * dx + dy * dy; if (!L2) continue;
      const t = Math.max(0, Math.min(1, ((m[0] - sg.pa[0]) * dx + (m[1] - sg.pa[1]) * dy) / L2)), q = d(sg.pa[0] + t * dx, sg.pa[1] + t * dy) * 1.3;
      if (q <= tol && (!seg || q < seg.d)) seg = { kind: 'seg', sg, at: [sg.pa[0] + t * dx, sg.pa[1] + t * dy], d: q };
    }
    return { pts, seg };
  },
  // parts stacked on one another: the nearest is picked first, and clicking again at the same spot picks the next one down
  _pickCycle(list, m, keyOf) {
    const tol = 9 * this.f / PlanEngine.view.zoom, prev = this._pk; let i = 0;
    if (list.length > 1 && prev && Math.hypot(prev.m[0] - m[0], prev.m[1] - m[1]) <= tol * 0.6) { const at = list.findIndex(c => keyOf(c) === prev.key); if (at >= 0) i = (at + 1) % list.length; }
    const c = list[i]; this._pk = list.length > 1 ? { m: m.slice(), key: keyOf(c) } : null; this._picked = list.length > 1 ? c : null;
    if (list.length > 1) { UI.toast(`${list.length} parts here: picked ${c.name || c.kind} (${i + 1} of ${list.length}). Click again for the next.`, 'info', 2200); }
    return c;
  },
  _moveHit(m) {
    const H = this._moveHits(m);
    if (H.pts.length) return this._pickCycle(H.pts, m, c => c.kind + ':' + (c.k ? c.k.id : c.e ? c.e.id : c.v.t));
    this._pk = null; this._picked = null; return H.seg;
  },
  moveDown(pt, ev) {
    const r = this.result, f = this.f, M = this.cfg().moves; if (!r) { UI.toast('Run the layout first.', 'info', 3000); return; }
    const m = [pt.x * f, pt.y * f], h = this._moveHit(m);
    if (!h) { if (PlanEngine && !ev.shiftKey && !ev.altKey) { PlanEngine.isPanning = true; PlanEngine.panStart = { x: ev.clientX - PlanEngine.view.panX, y: ev.clientY - PlanEngine.view.panY }; } return; }
    if (h.kind === 'seg') {
      if (!ev.shiftKey) { if (PlanEngine) { PlanEngine.isPanning = true; PlanEngine.panStart = { x: ev.clientX - PlanEngine.view.panX, y: ev.clientY - PlanEngine.view.panY }; } return; }
      const id = 'n' + Date.now().toString(36) + Math.floor(Math.random() * 1e3), a = { id, a: h.sg.a, b: h.sg.b, x: h.at[0] / f, y: h.at[1] / f };
      M.adds.push(a); this._drag = { kind: 'vert', add: id, cur: h.at, from: h.at, isNew: true }; PlanEngine.requestDraw({ fg: true }); return;
    }
    if (h.kind === 'vert') {
      if (ev.altKey) {
        if (h.v.add) { const dead = new Set([h.v.add]); for (let go = true; go;) { go = false; for (const a of M.adds) if (!dead.has(a.id) && (dead.has(a.a) || dead.has(a.b))) { dead.add(a.id); go = true; } } M.adds = M.adds.filter(a => !dead.has(a.id)); }
        else if (h.v.interior) { if (!M.cuts.includes(h.v.k)) M.cuts.push(h.v.k); delete M.verts[h.v.k]; }
        else { UI.toast('That node is the end of a line: move it, it cannot be removed.', 'info', 3000); return; }
        this.cfg().moves = M; this.touched(true); return;
      }
      this._drag = { kind: 'vert', key: h.v.k, add: h.v.add, cur: h.v.pos.slice(), from: h.v.pos.slice() }; PlanEngine.requestDraw({ fg: true }); return;
    }
    if (h.kind === 'kiosk') {
      if (ev.altKey) { const i = M.kiosks.findIndex(x => Math.hypot(x.to.x * f - h.k.x, x.to.y * f - h.k.y) < 0.5); if (i >= 0) { M.kiosks.splice(i, 1); this.touched(true); } else UI.toast('That kiosk was not moved by hand.', 'info', 2500); return; }
      this._drag = { kind: 'kiosk', k: h.k, cur: [h.k.x, h.k.y], from: [h.k.x, h.k.y] }; PlanEngine.requestDraw({ fg: true }); return;
    }
    if (h.kind === 'marker') {
      if (ev.altKey) { const L = this.cfg(); if (L.markers[h.e.id]) { delete L.markers[h.e.id]; this.touched(true); } else UI.toast('That marker was not placed by hand.', 'info', 2500); return; }
      this._drag = { kind: 'marker', e: h.e, cur: h.e.marker.slice(), from: h.e.marker.slice() }; PlanEngine.requestDraw({ fg: true });
    }
  },
  moveMove(pt) {
    const D = this._drag; if (!D) return false;
    D.cur = [pt.x * this.f, pt.y * this.f]; PlanEngine.requestDraw({ fg: true }); return true;
  },
  moveUp() {
    const D = this._drag; if (!D) return false; this._drag = null; this._picked = null;
    const f = this.f, L = this.cfg(), M = L.moves, moved = Math.hypot(D.cur[0] - D.from[0], D.cur[1] - D.from[1]) > 0.2;
    if (D.kind === 'xa' || D.kind === 'xb' || D.kind === 'xs') {
      if (!moved) { PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true }); return true; }
      const c = D.c, d = [(D.cur[0] - D.from[0]) / f, (D.cur[1] - D.from[1]) / f], mv = M.xs[c.key] || { a: { x: 0, y: 0 }, b: { x: 0, y: 0 } };
      if (D.kind === 'xs') { const t = this._xTan(c), k = d[0] * t[0] + d[1] * t[1]; mv.a = { x: mv.a.x + t[0] * k, y: mv.a.y + t[1] * k }; mv.b = { x: mv.b.x + t[0] * k, y: mv.b.y + t[1] * k }; }
      else if (L.xsq) {                                                                  // square to the road: both ends move along the street together, the dragged one also in / out
        const t = this._xTan(c), n = this._xNorm(c), dT = d[0] * t[0] + d[1] * t[1], dN = d[0] * n[0] + d[1] * n[1], e = D.kind === 'xa' ? 'a' : 'b';
        mv.a = { x: mv.a.x + t[0] * dT, y: mv.a.y + t[1] * dT }; mv.b = { x: mv.b.x + t[0] * dT, y: mv.b.y + t[1] * dT }; mv[e] = { x: mv[e].x + n[0] * dN, y: mv[e].y + n[1] * dN };
      } else { const e = D.kind === 'xa' ? 'a' : 'b'; mv[e] = { x: mv[e].x + d[0], y: mv[e].y + d[1] }; }
      M.xs[c.key] = mv; this.touched(true); return true;
    }
    if (!moved) { if (D.isNew) { M.adds = M.adds.filter(a => a.id !== D.add); } PlanEngine.requestDraw({ fg: true }); return true; }
    const q = { x: D.cur[0] / f, y: D.cur[1] / f };
    if (D.kind === 'kiosk') {
      const i = M.kiosks.findIndex(x => Math.hypot(x.to.x * f - D.k.x, x.to.y * f - D.k.y) < 0.5);
      if (i >= 0) M.kiosks[i].to = q; else M.kiosks.push({ from: { x: D.k.x / f, y: D.k.y / f }, to: q });
    } else if (D.kind === 'marker') L.markers[D.e.id] = q;
    else if (D.kind === 'vert') { if (D.add) { const a = M.adds.find(x => x.id === D.add); if (a) { a.x = q.x; a.y = q.y; } } else M.verts[D.key] = q; }
    this.touched(true); return true;
  },
  // what a crossing drag would re-lay, drawn live: the new stretches of every run through it, dashed in blue
  _relayPreview(ctx, u, W, D) {
    const r = this.result, f = this.f, c = D.c; if (!r || !f) return;
    const L = this.cfg(), t = this._xTan(c), n = this._xNorm(c), d = [D.cur[0] - D.from[0], D.cur[1] - D.from[1]], dT = d[0] * t[0] + d[1] * t[1], dN = d[0] * n[0] + d[1] * n[1];
    let a = [0, 0], b = [0, 0];
    if (D.kind === 'xs') { a = b = [t[0] * dT, t[1] * dT]; }
    else if (L.xsq) { const e = [n[0] * dN, n[1] * dN], al = [t[0] * dT, t[1] * dT]; a = [al[0] + (D.kind === 'xa' ? e[0] : 0), al[1] + (D.kind === 'xa' ? e[1] : 0)]; b = [al[0] + (D.kind === 'xb' ? e[0] : 0), al[1] + (D.kind === 'xb' ? e[1] : 0)]; }
    else if (D.kind === 'xa') a = d; else b = d;
    const F = this.crossFields(c), X = { c, a, b, s0: F.along }, fixed = this._fixedFn({ verts: {} }, new Set(), null);
    ctx.save(); ctx.setLineDash([5 * u, 3 * u]); ctx.strokeStyle = '#2563eb'; ctx.lineWidth = 2.2 * u; ctx.lineJoin = 'round';
    for (const poly of this._polys(r)) {
      const old = poly.map(q => ({ pt: q, k: null, t: null })), out = this._relay(old, [X], fixed, null); if (out === old) continue;
      const np = out.map(o => o.pt); let i0 = 0; while (i0 < np.length && i0 < poly.length && Math.hypot(np[i0][0] - poly[i0][0], np[i0][1] - poly[i0][1]) < 1e-6) i0++;
      let i1 = 0; while (i1 < np.length - i0 && i1 < poly.length - i0 && Math.hypot(np[np.length - 1 - i1][0] - poly[poly.length - 1 - i1][0], np[np.length - 1 - i1][1] - poly[poly.length - 1 - i1][1]) < 1e-6) i1++;
      const seg = np.slice(Math.max(0, i0 - 1), np.length - i1 + 1); if (seg.length < 2) continue;
      ctx.beginPath(); seg.forEach((q, i) => { const w = W(q); i ? ctx.lineTo(w[0], w[1]) : ctx.moveTo(w[0], w[1]); }); ctx.stroke();
    }
    ctx.restore();
  },
  _crossDraw(ctx, u, W) {
    const r = this.result; if (!r || !r.net || this.mode !== 'cross') return;
    ctx.save();
    for (const c of r.net.cross) {
      const [A, B] = this._xEnds(c), sel = c.key === this.selX, a = W(A), b = W(B);
      ctx.strokeStyle = sel ? '#2563eb' : 'rgba(37,99,235,.55)'; ctx.lineWidth = (sel ? 3 : 2) * u; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      for (const q of [a, b]) { ctx.fillStyle = '#fff'; ctx.strokeStyle = '#2563eb'; ctx.lineWidth = 2.2 * u; ctx.beginPath(); ctx.arc(q[0], q[1], (sel ? 7 : 5) * u, 0, 7); ctx.fill(); ctx.stroke(); if (sel) { ctx.strokeStyle = 'rgba(37,99,235,.25)'; ctx.lineWidth = 4 * u; ctx.beginPath(); ctx.arc(q[0], q[1], 11 * u, 0, 7); ctx.stroke(); } }
    }
    const D = this._drag;
    if (D && D.c) this._relayPreview(ctx, u, W, D);
    if (D && D.c) { const [A, B] = this._xEnds(D.c), k = D.kind, cur = W(D.cur), a = k === 'xa' ? cur : W(A), b = k === 'xb' ? cur : W(B), dd = k === 'xs' ? [(D.cur[0] - D.from[0]) / this.f, (D.cur[1] - D.from[1]) / this.f] : [0, 0];
      ctx.setLineDash([5 * u, 3 * u]); ctx.strokeStyle = '#2563eb'; ctx.lineWidth = 2.4 * u; ctx.beginPath(); ctx.moveTo(a[0] + dd[0], a[1] + dd[1]); ctx.lineTo(b[0] + dd[0], b[1] + dd[1]); ctx.stroke(); }
    ctx.restore();
  },
  _pickedDraw(ctx, u, W) {
    const c = this._picked; if (!c || !this.result) return; let p = null;
    if (c.kind === 'kiosk') p = [c.k.x, c.k.y]; else if (c.kind === 'marker') p = c.e.marker; else if (c.kind === 'vert') p = c.v.pos; else if (c.kind === 'xa') p = this._xEnds(c.c)[0]; else if (c.kind === 'xb') p = this._xEnds(c.c)[1];
    if (!p) return; const [x, y] = W(p); ctx.save(); ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 2.6 * u; ctx.setLineDash([4 * u, 3 * u]); ctx.beginPath(); ctx.arc(x, y, 14 * u, 0, 7); ctx.stroke(); ctx.restore();
  },
  _moveDraw(ctx, u, W) {
    const r = this.result; if (!r || this.mode !== 'move') return;
    ctx.save(); ctx.lineWidth = 1.4 * u;
    ctx.strokeStyle = '#475569'; ctx.fillStyle = '#fff';
    (this._verts || []).forEach(v => { const [x, y] = W(v.pos); ctx.beginPath(); ctx.arc(x, y, 3.2 * u, 0, 7); ctx.fill(); ctx.stroke(); });
    ctx.strokeStyle = '#2563eb'; ctx.lineWidth = 1.8 * u;
    r.kiosks.forEach(k => { const [x, y] = W([k.x, k.y]); ctx.beginPath(); ctx.arc(x, y, 11 * u, 0, 7); ctx.stroke(); });
    const D = this._drag;
    if (D) {
      const [x, y] = W(D.cur); ctx.strokeStyle = '#2563eb'; ctx.fillStyle = 'rgba(37,99,235,.25)'; ctx.lineWidth = 2 * u;
      if (D.kind === 'vert') {
        ctx.setLineDash([4 * u, 3 * u]);
        const t = D.add || D.key;
        (this._segs || []).forEach(sg => { if (sg.a === t || sg.b === t) { const o = W(sg.a === t ? sg.pb : sg.pa); ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(o[0], o[1]); ctx.stroke(); } });
        ctx.setLineDash([]);
      }
      ctx.beginPath(); ctx.arc(x, y, (D.kind === 'kiosk' ? 9 : 5) * u, 0, 7); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  },

  _segInter(a, b, c, d) {
    const r = [b[0] - a[0], b[1] - a[1]], q = [d[0] - c[0], d[1] - c[1]], den = r[0] * q[1] - r[1] * q[0]; if (Math.abs(den) < 1e-12) return null;
    const t = ((c[0] - a[0]) * q[1] - (c[1] - a[1]) * q[0]) / den, u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [a[0] + t * r[0], a[1] + t * r[1]] : null;
  },
  // the kind of every run in a result (service / fibre / LV), for counting what a crossing edit re-laid
  _polyKinds(r) {
    const m = new Map(); r.erven.forEach(e => { if (e.route) m.set(e.route, 'svc'); if (e.duct) m.set(e.duct, 'fi'); });
    if (r.net) (r.net.lv || []).forEach(ed => m.set(ed.pts, 'lv'));
    if (r.fibre) (r.fibre.trunks || []).concat(r.fibre.spare || []).forEach(e => m.set(e.pts, 'fi'));
    return m;
  },
  // a point of a run the layout may not re-lay: the ends, a kiosk / marker / manhole / mini-sub, a node you placed, and any real corner (over 30 degrees)
  _fixedFn(M, keep, objKeys) {
    return (list, f) => {
      if (f <= 0 || f >= list.length - 1) return true;
      const o = list[f]; if (o.add || (o.k && (M.verts[o.k] || keep.has(o.k) || (objKeys && objKeys.has(o.k))))) return true;
      const a = list[f - 1].pt, b = o.pt, c = list[f + 1].pt, u = [b[0] - a[0], b[1] - a[1]], v = [c[0] - b[0], c[1] - b[1]], lu = Math.hypot(u[0], u[1]), lv = Math.hypot(v[0], v[1]);
      return lu > 1e-6 && lv > 1e-6 && Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1]) / (lu * lv)))) > Math.PI / 6;
    };
  },
  // one side of a crossing: the run from its nearest fixed point to its crossing end is laid again so it reaches the NEW end along its own
  // line (extended, or cut back, by the along-the-street part of the shift), then turns square into the crossing by the lateral part. No old bend is left behind.
  _relayStretch(list, idx, step, a, fixed) {
    const ends = step < 0 ? idx === 0 : idx === list.length - 1;
    if (ends) { const o = list[idx]; return { from: idx, to: idx, objs: [{ pt: [o.pt[0] + a[0], o.pt[1] + a[1]], k: null, t: null }] }; }
    let f = idx + step; while (f > 0 && f < list.length - 1 && !fixed(list, f)) f += step;
    const S = []; if (step < 0) for (let k = f; k <= idx; k++) S.push(list[k]); else for (let k = f; k >= idx; k--) S.push(list[k]);          // from the fixed point towards the crossing end
    const n = S.length, last = S[n - 1].pt, prev = S[n - 2].pt, L0 = Math.hypot(last[0] - prev[0], last[1] - prev[1]) || 1, d = [(last[0] - prev[0]) / L0, (last[1] - prev[1]) / L0];
    const along = a[0] * d[0] + a[1] * d[1], lat = [a[0] - along * d[0], a[1] - along * d[1]];
    let out = S.slice(0, n - 1);                                                        // the run before the old end
    let end = [last[0], last[1]];
    if (along >= 0) end = [last[0] + d[0] * along, last[1] + d[1] * along];             // extended along the run
    else {                                                                              // cut back along the run
      let rem = -along, cur = last, i2 = out.length - 1; end = null;
      while (i2 >= 0) { const to = out[i2].pt, Ls = Math.hypot(cur[0] - to[0], cur[1] - to[1]); if (rem < Ls - 1e-6) { end = [cur[0] + (to[0] - cur[0]) / Ls * rem, cur[1] + (to[1] - cur[1]) / Ls * rem]; break; } rem -= Ls; cur = to; i2--; }
      if (end) out = out.slice(0, i2 + 1); else { end = [out[0].pt[0], out[0].pt[1]]; out = out.slice(0, 1); }
    }
    const res = out.slice();
    const lastKept = res.length ? res[res.length - 1].pt : null;
    if (!lastKept || Math.hypot(end[0] - lastKept[0], end[1] - lastKept[1]) > 1e-6) res.push({ pt: end, k: null, t: null });
    if (Math.hypot(lat[0], lat[1]) > 1e-6) res.push({ pt: [end[0] + lat[0], end[1] + lat[1]], k: null, t: null });
    if (!res.length) res.push({ pt: end, k: null, t: null });
    return step < 0 ? { from: f, to: idx, objs: res } : { from: idx, to: f, objs: res.slice().reverse() };
  },
  // the crossing segments of a run (those that go over a moved crossing's street near its station): both sides are re-laid, counted into the crossing
  _relay(list, XS, fixed, kind) {
    const done = new Set();
    for (let i = 1; i < list.length; i++) {
      const P = list[i - 1], Q = list[i]; if (done.has(P) || done.has(Q)) continue;
      let X = null;
      for (const x of XS) {
        const st = x.c.st; let hit = null;
        for (let j = 1; j < st.pts.length && !hit; j++) hit = this._segInter(P.pt, Q.pt, st.pts[j - 1], st.pts[j]);
        if (hit && Math.abs(PlanLayout.project(st, hit[0], hit[1]).s - (x.s0 != null ? x.s0 : x.c.s)) <= 3) { X = x; break; }
      }
      if (!X) continue;
      const plus = PlanLayout.project(X.c.st, P.pt[0], P.pt[1]).side >= 0, aP = plus ? X.a : X.b, aQ = plus ? X.b : X.a;
      const back = this._relayStretch(list, i - 1, -1, aP, fixed), fwd = this._relayStretch(list, i, 1, aQ, fixed);
      const out = list.slice(0, back.from).concat(back.objs, fwd.objs, list.slice(fwd.to + 1));
      const at = back.from + back.objs.length;
      back.objs.forEach(o => done.add(o)); fwd.objs.forEach(o => done.add(o));
      if (kind && X.c.relaid && X.c.relaid[kind] != null) X.c.relaid[kind]++;
      list = out; i = at;
    }
    return list;
  },
  // the stretches of every run that go across a street: drawn dashed, shaded, "below the road"
  _findCross(r) {
    const out = [], st = r.streets || [];
    const seg = (kind, pts) => {
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i]; if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) < 1e-6) continue;
        for (const S of st) { let hit = false; for (let j = 1; j < S.pts.length && !hit; j++) hit = !!this._segInter(a, b, S.pts[j - 1], S.pts[j]); if (hit) { out.push({ kind, a, b }); break; } }
      }
    };
    r.erven.forEach(e => { if (e.route) seg('svc', e.route); if (e.duct) seg('fi', e.duct); });
    if (r.net) (r.net.lv || []).forEach(ed => seg('lv', ed.pts));
    if (r.fibre) (r.fibre.trunks || []).concat(r.fibre.spare || []).forEach(e => seg('fi', e.pts));
    this._xsegs = out;
  },
  _xTan(c) { const p1 = PlanLayout.ptAt(c.st, Math.max(0, c.s - 1), 0), p2 = PlanLayout.ptAt(c.st, Math.min(c.st.len, c.s + 1), 0), L = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) || 1; return [(p2[0] - p1[0]) / L, (p2[1] - p1[1]) / L]; },
  _xNorm(c) { const p0 = PlanLayout.ptAt(c.st, c.s, 0), p1 = PlanLayout.ptAt(c.st, c.s, 1), L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) || 1; return [(p1[0] - p0[0]) / L, (p1[1] - p0[1]) / L]; },
  _xEnds(c) { return c.ends || c.ends0; },
  _crossHit(m) {
    const r = this.result; if (!r || !r.net) return null; const tol = 10 * this.f / PlanEngine.view.zoom, list = [];
    const take = (o, d, pri) => { if (d <= tol) list.push(Object.assign(o, { d, score: d + pri * 0.3 * tol })); };
    for (const c of r.net.cross) {
      const [A, B] = this._xEnds(c); if (!A) continue; const nm = (c.st.name || c.st.id) + ' · ' + Math.round(c.s) + ' m';
      take({ kind: 'xa', c, name: 'start of crossing ' + nm }, Math.hypot(A[0] - m[0], A[1] - m[1]), 0); take({ kind: 'xb', c, name: 'end of crossing ' + nm }, Math.hypot(B[0] - m[0], B[1] - m[1]), 0);
      const dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy, t = L2 ? Math.max(0, Math.min(1, ((m[0] - A[0]) * dx + (m[1] - A[1]) * dy) / L2)) : 0;
      take({ kind: 'xs', c, name: 'crossing ' + nm }, Math.hypot(A[0] + t * dx - m[0], A[1] + t * dy - m[1]) * 1.4, 2);
    }
    if (!list.length) { this._pk = null; this._picked = null; return null; }
    list.sort((a, b) => a.score - b.score);
    return this._pickCycle(list, m, c => c.kind + ':' + c.c.key);
  },
  crossDown(pt, ev) {
    const r = this.result, f = this.f, L = this.cfg(), M = L.moves; if (!r) { UI.toast('Run the layout first.', 'info', 3000); return; }
    const h = this._crossHit([pt.x * f, pt.y * f]);
    if (!h) { PlanEngine.isPanning = true; PlanEngine.panStart = { x: ev.clientX - PlanEngine.view.panX, y: ev.clientY - PlanEngine.view.panY }; return; }
    this.selX = h.c.key;
    if (ev.altKey) { if (M.xs[h.c.key]) { delete M.xs[h.c.key]; this.touched(true); } else { PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true }); } return; }
    const [A, B] = this._xEnds(h.c), from = h.kind === 'xa' ? A.slice() : h.kind === 'xb' ? B.slice() : [pt.x * f, pt.y * f];
    this._drag = { kind: h.kind, c: h.c, cur: from.slice(), from }; PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true });
  },
  // the editor for the selected crossing (numbers, in metres) and the list of every crossing
  crossFields(c) {
    const f = this.f, mv = this.cfg().moves.xs[c.key] || { a: { x: 0, y: 0 }, b: { x: 0, y: 0 } }, t = this._xTan(c), n = this._xNorm(c), dot = (v, u) => v[0] * u[0] + v[1] * u[1];
    const a = [mv.a.x * f, mv.a.y * f], b = [mv.b.x * f, mv.b.y * f], w2 = c.st.w / 2;
    return { t, n, aT: dot(a, t), aN: dot(a, n), bT: dot(b, t), bN: dot(b, n), start: c.hA - w2 + dot(a, n), end: c.hB - w2 - dot(b, n), along: c.s + (dot(a, t) + dot(b, t)) / 2, w2 };
  },
  setCross(c, field, val) {
    const f = this.f, F = this.crossFields(c), M = this.cfg().moves; let { aT, aN, bT, bN } = F; val = parseFloat(val); if (!isFinite(val)) return;
    if (field === 'start') aN = val - (c.hA - F.w2); else if (field === 'end') bN = -(val - (c.hB - F.w2)); else { aT = bT = val - c.s; }
    const vec = (T, N) => ({ x: (F.t[0] * T + F.n[0] * N) / f, y: (F.t[1] * T + F.n[1] * N) / f });
    M.xs[c.key] = { a: vec(aT, aN), b: vec(bT, bN) }; this.touched(true);
  },
  crossHtml(esc) {
    const r = this.result; if (!r || !r.net) return '';
    const sel = r.net.cross.find(c => c.key === this.selX), rows = r.net.cross.slice().sort((p, q) => p.st.id.localeCompare(q.st.id) || p.s - q.s).slice(0, 60);
    const num = (k, label, v) => `<label style="display:flex;flex-direction:column;gap:2px;font-size:12px;min-width:0">${label}<input type="number" step="0.1" data-xf="${k}" value="${(Math.round(v * 100) / 100)}" style="min-height:36px;width:100%;min-width:0;box-sizing:border-box;padding:0 8px"></label>`;
    let ed = '<div style="font-size:12px;color:var(--text-muted)">Click a crossing on the plan or in the list. Drag its start or end to move that end, drag the line to slide it along the street. Alt-click puts it back.</div>';
    if (sel) { const F = this.crossFields(sel), moved = !!this.cfg().moves.xs[sel.key];
      ed = `<div style="display:flex;flex-direction:column;gap:6px"><b>${esc(sel.st.name || sel.st.id)} · ${Math.round(F.along)} m</b><div style="font-size:12px;color:var(--text-muted)">${sel.svc ? sel.svc + ' service' + (sel.svc === 1 ? '' : 's') + ' · ' : ''}${sel.fib ? sel.fib + ' fibre · ' : ''}${sel.lv ? sel.lv + ' LV · ' : ''}${sel.d110} × 110 mm${sel.d160 ? ' + ' + sel.d160 + ' × 160 mm' : ''}${sel.prov ? ' (provisional, no cable yet)' : ''}</div>
        <div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:6px">${num('start', 'Start, from the road edge (m)', F.start)}${num('end', 'End, from the road edge (m)', F.end)}<div style="grid-column:span 2">${num('along', 'Along the street (m)', F.along)}</div></div>
        <label style="display:flex;gap:8px;align-items:flex-start;font-size:12px;line-height:1.4"><input type="checkbox" data-xsq${this.cfg().xsq ? ' checked' : ''} style="width:18px;height:18px;margin:0;flex:none"><span><b>Keep the crossing square to the road</b><br><span style="color:var(--text-muted)">On: the two ends move along the street together. Off: each end moves on its own and the crossing may be angled.</span></span></label>
        ${moved && sel.relaid ? `<div style="border:1px solid #bbf7d0;background:#f0fdf4;border-radius:6px;padding:6px 8px;font-size:12px;line-height:1.45"><b style="color:#166534">Re-laid ${sel.relaid.svc + sel.relaid.fi + sel.relaid.lv} run${sel.relaid.svc + sel.relaid.fi + sel.relaid.lv === 1 ? '' : 's'}</b> · ${[sel.relaid.svc && sel.relaid.svc + ' service' + (sel.relaid.svc === 1 ? '' : 's'), sel.relaid.fi && sel.relaid.fi + ' fibre', sel.relaid.lv && sel.relaid.lv + ' LV'].filter(Boolean).join(', ')} · trench ${Math.round(Math.hypot(this._xEnds(sel)[1][0] - this._xEnds(sel)[0][0], this._xEnds(sel)[1][1] - this._xEnds(sel)[0][1]) * 10) / 10} m</div>` : ''}
        <button type="button" class="plan-btn" data-act="xreset" style="min-height:36px"${moved ? '' : ' disabled'}>Put this crossing back</button></div>`; }
    const list = `<div style="max-height:150px;overflow:auto;border-top:1px solid var(--border-color,#ddd)">${rows.map(c => `<button type="button" data-xsel="${esc(c.key)}" class="plan-btn" style="display:flex;justify-content:space-between;width:100%;border:0;border-bottom:1px solid var(--border-color,#eee);border-radius:0;padding:4px 2px;font-size:12px;${c.key === this.selX ? 'font-weight:700;background:rgba(37,99,235,.1)' : ''}"><span>${esc(c.st.name || c.st.id)} · ${Math.round(c.s)} m${this.cfg().moves.xs[c.key] ? ' ●' : ''}</span><span>${c.d110 + c.d160} duct${c.d110 + c.d160 === 1 ? '' : 's'}</span></button>`).join('')}</div>`;
    return ed + list;
  },

  // the adjust tools over the plan itself (Review step, not on a phone): the same modes as the panel's card, plus a line saying what a click does
  _syncBar() {
    const stage = typeof PlanEngine !== 'undefined' && PlanEngine.stage; if (!stage) return;
    let bar = document.getElementById('pl-adjust-bar');
    const phone = window.matchMedia && window.matchMedia('(max-width: 768px)').matches;
    const show = this._active && this.step === 4 && this.result && this.result.kiosks.length && !phone;
    if (!show) { if (bar) bar.remove(); return; }
    if (getComputedStyle(stage).position === 'static') stage.style.position = 'relative';
    if (!bar) {
      bar = document.createElement('div'); bar.id = 'pl-adjust-bar';
      bar.style.cssText = 'position:absolute;left:0;right:0;top:10px;display:flex;flex-direction:column;align-items:center;gap:6px;z-index:6;pointer-events:none';
      bar.addEventListener('pointerdown', e => e.stopPropagation());
      bar.onclick = e => { const b = e.target.closest('[data-bm]'); if (!b) return; if (b.dataset.bm === 'fold') { this._barFold = !this._barFold; try { localStorage.setItem('pp-layout-bar-fold', this._barFold ? '1' : '0'); } catch (x) { /* kept for this session */ } this._syncBar(); return; } if (b.dataset.bm === 'reset') { const a = document.querySelector('#plan-props [data-act="reset"]'); if (a) a.click(); return; } this.mode = b.dataset.bm; this.markFor = null; PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true }); };
      stage.appendChild(bar);
    }
    if (this._barFold === undefined) { try { this._barFold = localStorage.getItem('pp-layout-bar-fold') === '1'; } catch (x) { this._barFold = false; } }
    if (this._barFold) { bar.innerHTML = '<div style="pointer-events:auto;align-self:flex-start;margin-left:10px"><button type="button" data-bm="fold" style="min-height:32px;padding:0 12px;border:1px solid #cbd5e1;border-radius:16px;background:#fff;font:inherit;font-size:12px;font-weight:600;cursor:pointer;box-shadow:0 2px 8px rgba(15,23,42,.16)">Adjust tools ▾</button></div>'; return; }
    const n = this.edits(), btn = (v, t) => `<button type="button" data-bm="${v}" aria-pressed="${this.mode === v}" style="min-height:36px;padding:0 12px;border:0;border-radius:7px;font:inherit;font-size:13px;cursor:pointer;${this.mode === v ? 'background:#2563eb;color:#fff;font-weight:600' : 'background:transparent;color:#334155;font-weight:500'}">${t}</button>`;
    bar.innerHTML = `<div style="pointer-events:auto;display:flex;flex-wrap:wrap;gap:2px;padding:4px;background:#fff;border:1px solid #cbd5e1;border-radius:10px;box-shadow:0 4px 14px rgba(15,23,42,.18)">${btn('front', 'Erf fronts')}${btn('marker', 'Erf markers')}${btn('trunk', 'Trunk ducts')}${btn('move', 'Move parts')}${btn('cross', 'Crossings')}<span style="width:1px;background:#cbd5e1;margin:4px 3px"></span>${btn('reset', 'Reset edits (' + n + ')')}${btn('fold', 'Hide ▴')}</div>
      <div style="pointer-events:none;padding:5px 12px;background:#0f172a;color:#f8fafc;border-radius:8px;font-size:12px;max-width:720px;text-align:center">${this.hint().replace(/^Auto layout · /, '').replace(/&/g, '&amp;').replace(/</g, '&lt;')}</div>`;
  },

  // ───────── the ADMD prerequisite: the load on every cable comes from Demand's ADMD settings, so they are confirmed before a run ─────────
  _admdSig() { if (typeof Retic === 'undefined') return ''; const o = Retic._admdPayload(); delete o.loadClassLib; return JSON.stringify(o); },
  admdOk() { return typeof Retic === 'undefined' || (this.cfg().admdOk !== '' && this.cfg().admdOk === this._admdSig()); },
  admdConfirm() { this.cfg().admdOk = this._admdSig(); },
  // a value typed in the Rules step goes to Demand's own settings (the same rules as Demand's settings bar) and counts as confirmed
  setAdmd(key, raw) {
    if (typeof Retic === 'undefined') return;
    const s = Retic.settings;
    if (['admd', 'riskZ'].includes(key)) s[key] = parseFloat(raw) || 0;
    else if (key === 'trfrConfidence') s[key] = raw === '' ? '' : (parseFloat(raw) || 0);
    else s[key] = raw;
    if (key === 'loadClass') { const cls = STANDARD_LOAD_CLASSES.find(c => c.id === raw); if (cls && cls.admd) s.admd = cls.admd; }
    if (Retic._snapshot) Retic._snapshot();
    Retic._markDirty();
    try { if (document.getElementById('retic-settings-bar')) { Retic.renderSettingsBar(); if (key === 'loadClass') Retic.renderKiosks(); } } catch (e) { /* Demand is not on screen */ }
    this.admdConfirm();
    if (this.result) this.vdRun(); else PlanMarkup.refreshProps();
  },
  admdHtml() {
    if (typeof Retic === 'undefined') return '';
    const s = Retic.settings, ok = this.admdOk(), isHB = s.estimationMethod === 'Herman Beta', esc = escHtml;
    const opt = (list, cur) => list.map(([v, t]) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(t)}</option>`).join('');
    const fld = (label, inner) => `<label style="display:flex;flex-direction:column;gap:2px;font-size:12px"><span>${label}</span>${inner}</label>`;
    const num = (k, step, extra) => `<input type="number" step="${step}" data-admd="${k}" value="${esc(s[k] == null ? '' : s[k])}" style="width:100%;box-sizing:border-box"${extra || ''}>`;
    const cls = STANDARD_LOAD_CLASSES.find(c => c.id === s.loadClass);
    const per = cls && Retic._classIs3ph && Retic._classIs3ph(cls) ? '/phase' : '';
    return `<div style="border:1px solid ${ok ? 'var(--border,#ddd)' : '#b45309'};border-radius:6px;padding:6px 8px;display:flex;flex-direction:column;gap:6px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:6px"><b>ADMD (load on the cables)</b><span style="font-size:12px;font-weight:600;color:${ok ? '#15803d' : '#b45309'}">${ok ? '✓ confirmed' : '! confirm before running'}</span></div>
      <div style="font-size:12px;color:var(--text-muted)">Every cable and breaker is sized from Demand's ADMD. These are Demand's own settings: a change here changes Demand too.</div>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:6px">
        ${fld('Estimation method', `<select data-admd="estimationMethod" style="width:100%">${opt(ESTIMATION_METHODS.map(m => [m, m]), s.estimationMethod)}</select>`)}
        ${fld('Load class', `<select data-admd="loadClass" style="width:100%">${opt(STANDARD_LOAD_CLASSES.map(c => [c.id, c.label]), s.loadClass)}</select>`)}
        ${fld('ADMD (kVA' + per + ')', num('admd', 0.01, isHB ? ' disabled title="Herman-Beta derives the ADMD from the load class"' : ''))}
        ${isHB ? fld('Risk z', num('riskZ', 0.01, ' min="0.5" max="4"')) : fld('Correction', `<select data-admd="correctionMethod" style="width:100%">${opt(LOAD_CLASS_CORRECTIONS.map(m => [m, m]), s.correctionMethod)}</select>`)}
        ${isHB ? fld('Transformer confidence (%)', num('trfrConfidence', 1, ' min="1" max="99" placeholder="= Risk z"')) : ''}
      </div>
      ${ok ? '' : '<button type="button" class="plan-btn" data-act="admdok" style="font-weight:600;padding:5px">Use these ADMD settings</button>'}</div>`;
  },
  _num(v, lo, hi, d) { const n = parseFloat(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; },

  // a street route as points (a curved one is sampled the way the plan draws it)
  _flat(r) {
    const pts = r.points.map(p => ({ x: p.x, y: p.y }));
    if (!r.curved || pts.length < 3) return pts;
    const out = [], P = [pts[0], ...pts, pts[pts.length - 1]];
    for (let i = 1; i < P.length - 2; i++) {
      const [p0, p1, p2, p3] = [P[i - 1], P[i], P[i + 1], P[i + 2]];
      for (let k = 0; k < 12; k++) { const t = k / 12, t2 = t * t, t3 = t2 * t; out.push({ x: .5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3), y: .5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3) }); }
    }
    out.push(pts[pts.length - 1]);
    return out;
  },
  // ── voltage drop ──
  // The cables the check uses: the picked ones, else a 95 mm² LV feeder and a 16 mm² 2-core service.
  vdCables() {
    const vd = this.cfg().vd, all = (typeof CableLib !== 'undefined') ? CableLib.all() : [];
    const g = (typeof CableLib !== 'undefined') ? CableLib.reticGroups() : [];
    const feeders = all.filter(c => g[0] && g[0].test(c)), services = all.filter(c => g[1] && g[1].test(c));
    const pick = (list, id, prefer) => list.find(c => c.id === id) || list.find(prefer) || list[0] || null;
    const auto = !feeders.some(c => c.id === vd.lv);                       // nothing picked: the smallest cable that keeps the drop within the limit
    const r = this.result, sized = auto && r && r.vd && r.vd.autoLv ? feeders.find(c => c.id === r.vd.autoLv) : null;
    return { feeders, services, auto, svcAuto: !services.some(c => c.id === vd.svc),
      lv: sized || pick(feeders, vd.lv, c => c.id === 'al_xlpe_95_lv' || (c.size_mm2 === 95 && c.conductor === 'Al')),
      svc: pick(services, vd.svc, c => c.size_mm2 === 16 && c.conductor === 'Cu') };
  },
  // The limits are Demand's own (Max Feeder VD, Max Service VD): one place to change them.
  vdLimits() {
    const st = (typeof Retic !== 'undefined' && Retic.settings) || {}, n = (v, d) => { const x = parseFloat(v); return Number.isFinite(x) && x > 0 ? x : d; };
    return { feeder: n(st.maxFeederVD, 7), svc: n(st.maxRunVD, 5) };
  },
  // Auto sizing tries the armoured XLPE aluminium sizes first, then copper, smallest first.
  vdCandidates(feeders) {
    const xl = feeders.filter(c => c.insulation === 'XLPE' && (c.construction || 'armoured') === 'armoured');
    const by = cond => xl.filter(c => c.conductor === cond).sort((a, b) => a.size_mm2 - b.size_mm2);
    return by('Al').concat(by('Cu'));
  },
  // Demand's own answer for one proposal (its ADMD run): the diversified current on every leg and service.
  async _demandFor(r) {
    const c = this.vdCables(), vd = this.cfg().vd, names = {}; AppState.planMarkup.elements.forEach(e => { if (e.type === 'erf') names[e.id] = e.name; });
    const input = PlanLayout.demandInput(r, { names, minisubId: 'LAYOUT_SUB', lvCable: c.lv && c.lv.name, svcCable: c.svc && c.svc.name, outgoing: vd.way80 ? 'cb:mccb_80a' : '', phases: Retic.PHASES.slice(0, 3).map(x => x.id) });
    if (!input) return null;
    const res = await API.runAdmd(Retic._admdPayload(), input.kiosks, input.minisubs);
    return { res, input, byK: new Map(input.kiosks.map(k => [k.id, k])), sig: JSON.stringify(Retic._admdPayload()) };
  },
  async vdRun() {
    const r = this.result; if (!r) return;
    r.vd = null; r.dem = null; r.design = null; r.designIssue = null; r.designErr = '';
    if (typeof Retic === 'undefined' || typeof API === 'undefined') return;
    const tok = this._vdTok = (this._vdTok || 0) + 1;
    r.vdBusy = true; PlanMarkup.refreshProps();
    try {
      const dem = await this._demandFor(r);
      if (tok !== this._vdTok || r !== this.result) return;
      if (!dem) { r.vdBusy = false; r.vd = { err: 'No LV network to check yet.' }; PlanMarkup.refreshProps(); return; }
      r.dem = dem;
      await this.designRun(r, tok);                                        // head breakers, the cable ladder, the taper
      if (tok !== this._vdTok || r !== this.result) return;
      r.vdBusy = false; this.vdDerive();
      r.earthBusy = true; PlanMarkup.refreshProps();
      await this.earthRun(tok);
      if (tok !== this._vdTok) return;
    } catch (e) {
      if (tok !== this._vdTok) return;
      r.vdBusy = false; r.vd = { err: 'Demand could not be run (' + ((e && e.message) || e) + ').' };
    }
    PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true });
  },

  // ── the LV design: 80 A ways, a breaker per string, the smallest cable that passes, tapered (backend/analysis/retic_lv_design.py) ──
  _designOn() { const vd = this.cfg().vd; return !!(vd.taper || vd.way80); },
  _deviceOf(spec) {                                                         // a library breaker as the engines take it, with its rating
    const x = Retic._protectionDevice({ protection: spec }); if (!x) return null;
    const id = String(spec).split(':')[1], e = STANDARD_CBS.find(q => q.id === id);
    return Object.assign({ id, rating: e ? Number(e.trip_rating_a) || 0 : 0 }, x);
  },
  // the cable ladder the taper chooses from: armoured XLPE aluminium, smallest first
  _ladder(c) { const all = this.vdCandidates(c.feeders), al = all.filter(x => x.conductor === 'Al'); return al.length ? al : all; },
  // What a kiosk and a road crossing are worth in metres of service cable, from the project's own rate library (material + labour):
  // price of the kiosk (EQ-KIOSK) or of one 110 mm crossing (CIV-XING-110) ÷ price per metre of the service cable. null = any of the three unpriced.
  ratesFigures() { return this.ratesCheck().fig; },
  // { fig: {worth, xpen} | null, missing: [names of what has no price] }
  ratesCheck() {
    try {
      const c = this.vdCables(), price = key => { const v = Rates.get(key); return Rates.priced(v) ? (v.rate || 0) + (v.labour || 0) : null; };
      const cab = c && c.svc ? price(Rates.cableKey(c.svc.name)) : null, ki = price('EQ-KIOSK'), xg = price(Rates.crossingKey('110'));
      const missing = [!cab && 'the service cable', !ki && 'a kiosk', !xg && 'a 110 mm road crossing'].filter(Boolean);
      return { fig: missing.length ? null : { worth: Math.round(ki / cab / 10) * 10, xpen: Math.round(xg / cab / 25) * 25 }, missing };
    } catch (e) { return { fig: null, missing: ['the rate library'] }; }
  },
  _ladderSizes() { const c = this.vdCables(), s = new Set(this._ladder(c).map(x => x.size_mm2)); return [...s].sort((a, b) => a - b); },
  _cableDict(c) { const o = Retic._cableDict(c.name), e = CableLib.byName(c.name); return o && Object.assign(o, { rated_amps: e ? e.rated_amps : 0 }); },
  // feeders that lie in the same trench: for each LV link, 1 + the other links whose cable passes the middle of its first run
  _trenchShare(r) {
    const links = (r.net && r.net.lvLinks) || [], out = {}, mid = pts => pts.length > 1 ? [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2] : null;
    const near = (m, pts) => { for (let i = 1; i < pts.length; i++) { const a = pts[i - 1], b = pts[i], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-9, t = Math.max(0, Math.min(1, ((m[0] - a[0]) * dx + (m[1] - a[1]) * dy) / L2)); if (Math.hypot(a[0] + dx * t - m[0], a[1] + dy * t - m[1]) < 0.6) return true; } return false; };
    for (const l of links) { const m = mid(l.pts); if (!m) continue; const n = links.filter(o => o === l || near(m, o.pts)).length; if (n > 1) out[l.to.id] = n; }
    return out;
  },
  _designPayload(r) {
    const d = r.dem, vd = this.cfg().vd, c = this.vdCables(), lim = this.vdLimits(), ladder = this._ladder(c);
    const { src } = this._earthSrc(ladder[ladder.length - 1] || c.lv, c.svc, null, r, true);
    const ep = Retic._earthPayload(src), byId = {}; d.res.kiosks.forEach(kr => { byId[kr.kioskId] = kr; });
    const msIds = new Set(ep.minisubs.map(m => m.id)), pinnedCables = {}, pinnedBreakers = {};
    const lv = x => !x.rated_voltage_kv || x.rated_voltage_kv <= 1;
    const breakers = STANDARD_CBS.filter(x => lv(x) && (x.cb_type === 'mccb' || x.cb_type === 'acb')).map(x => this._deviceOf('cb:' + x.id)).filter(Boolean);
    const kiosks = ep.kiosks.map(k => {
      const kr = byId[k.id] || {}, amps = kr.feederA != null ? Number(kr.feederA) : Number(kr.currentA) || 0;
      if (!c.auto && c.lv) pinnedCables[k.id] = this._cableDict(c.lv);                          // a cable picked by hand is kept on every feeder
      if (vd.prot && msIds.has(k.fedFrom)) { const pd = this._deviceOf(vd.prot); if (pd) pinnedBreakers[k.id] = pd; }
      return { id: k.id, name: k.name, fedFrom: k.fedFrom, lengthM: k.feeder.lengthM, amps, erfs: k.erfs.map(e => ({ id: e.id, erfNumber: e.erfNumber, service: e.service, device: e.device, deviceSource: e.deviceSource })) };
    });
    return { settings: { u0: ep.settings.u0, disconnectTimeS: ep.settings.disconnectTimeS, maxFeederVD: lim.feeder }, minisubs: ep.minisubs, kiosks,
      ladder: ladder.map(x => this._cableDict(x)).filter(Boolean), breakers, options: { taper: !!vd.taper, pinnedCables, pinnedBreakers, minSizeMm2: vd.minSize || 0, maxSizeMm2: vd.maxSize || 0, maxSizes: vd.maxSizes || 0, groupCircuits: this._trenchShare(r) } };
  },
  async designRun(r, tok) {
    if (!this._designOn() || !r.dem) { r.design = null; return; }
    try {
      const res = await API.runReticLvDesign(this._designPayload(r));
      if (tok !== this._vdTok) return;                                      // (a trial of another mini-sub count is not this.result yet)
      r.design = res && res.feeders && res.feeders.length ? res : null;
      r.designIssue = res && !(res.feeders && res.feeders.length) && res.reasons && res.reasons.length ? res : null;     // e.g. no cable fits the sizes allowed
      // Split strings automatically: a string that cannot clear its fault gets the split the design proposes, while that helps (at most 12 in all)
      const vd = this.cfg().vd;
      if (vd.autoSplit && r.design && !r.design.passes && vd.splits.length < 12) {
        const fx = (r.design.reasons || []).flatMap(x => x.fixes || []).find(x => x.action === 'split' && x.failsAfter < x.failsBefore);
        const k = fx && this.result && this.result.kiosks.find(q => q.id === fx.kiosk);
        if (k && !vd.splits.some(q => Math.hypot(q.x - k.x / this.f, q.y - k.y / this.f) < 1e-6)) { vd.splits.push({ x: k.x / this.f, y: k.y / this.f }); setTimeout(() => this.touched(), 0); }
      }
    } catch (e) { if (tok === this._vdTok) { r.design = null; r.designErr = (e && e.message) || String(e); } }
  },
  // kiosk id → the library cable the design gave it
  _designCables(r) {
    const m = new Map(); if (!r || !r.design) return m;
    for (const f of r.design.feeders) { const cab = CableLib.byName(f.cable); if (cab) m.set(f.kioskId, cab); }
    return m;
  },
  // From the engine's answer to the figures shown. Cable or limit changes come back here (no new request: the loads do not depend on them).
  vdDerive() {
    const r = this.result, d = r && r.dem; if (!d) return;
    const c = this.vdCables();
    if (!c.svc || !c.feeders.length) { r.vd = { err: 'Pick the LV feeder and service cables.' }; return; }
    const bad = x => x.over.length || x.hotLegs.length || x.hotSvc.length;
    let res;
    const per = this._designCables(r);
    if (r.design && per.size) { res = this._vdWith(c.lv, c.svc, per); res.designed = true; }      // the tapered cables, kiosk by kiosk
    else if (c.auto) {
      // the limits as a constraint: the smallest cable that passes (volt drop and rating); if none does, the largest, flagged
      const cands = this.vdCandidates(c.feeders);
      let pass = null;
      for (const cab of cands) { const t = this._vdWith(cab, c.svc); if (!bad(t)) { pass = { cab, v: t }; break; } }
      const first = cands.length ? this._vdWith(cands.find(x => x.id === 'al_xlpe_95_lv') || cands[0], c.svc) : null;
      if (pass) { res = pass.v; res.autoLv = pass.cab.id; res.autoFrom = first && bad(first) ? { name: first.V.lv.name, max: first.max } : null; }
      else { const big = cands[cands.length - 1] || c.lv; res = this._vdWith(big, c.svc); res.autoLv = big.id; res.unmet = true; }
    } else res = this._vdWith(c.lv, c.svc);
    res.subs = this._txRows();
    r.vd = res;
  },
  // the volt drop and the cable ratings of every erf with these two cables, from Demand's answer (`r.dem`) and Retic's own functions.
  // Nothing is written into the shared Demand input: each call works on its own copy.
  _vdWith(lvCab, svcCab, per) {
    const r = this.result, d = r.dem, lim = this.vdLimits();
    const cabOf = k => (per && per.get(k.id)) || lvCab;
    const cur = new Map(d.input.kiosks.map(k => [k.id, Object.assign({}, k, { feederCable: cabOf(k).name, erfs: k.erfs.map(e => Object.assign({}, e, { cableType: svcCab.name })) })]));
    const kioskOf = id => cur.get(id);
    const byId = {}; for (const kr of d.res.kiosks) byId[kr.kioskId] = kr;
    const net = r.net, up = new Map(net.lvLinks.map(l => [l.to, l]));
    const rateOf = name => (Retic._cableRX(name) || {}).rating || 0, lvRate = lvCab ? rateOf(lvCab.name) : 0, svcRate = rateOf(svcCab.name);
    const cum = k => { const v = Retic._cumulativeFeederVD(k.id, byId, kioskOf); return v == null ? 0 : v; };
    const legs = net.lvLinks.map(l => ({ from: l.from, to: l.to, len: (cur.get(l.to.id) || {}).feederLength || l.len, pct: Retic._legFeederVD(l.to.id, byId, kioskOf) || 0, cum: cum(l.to), amps: (byId[l.to.id] || {}).feederA || 0, rating: rateOf((cur.get(l.to.id) || {}).feederCable) }));
    const rows = [], unreached = [];
    for (const k of r.kiosks) for (const e of k.members) {
      if (!up.has(k)) { unreached.push(e); continue; }
      const dk = cur.get(k.id), de = dk.erfs.find(x => x.id === e.id), amps = Retic._erfDesignAmps(dk, de);
      const svc = Retic._vdPercent(svcCab.name, amps, de.length, Retic._erfIs3ph(dk, de)) || 0, lv = cum(k);
      rows.push({ erf: e, kiosk: k, lv, svc, total: lv + svc, amps, rating: svcRate });
    }
    const worst = rows.slice().sort((a, b) => b.total - a.total)[0] || null;
    const eps = 1e-9;
    return { V: { limF: lim.feeder, limS: lim.svc, lv: per && per.size ? { name: this._taperLabel(per), rating: 0 } : { name: lvCab.name, rating: lvRate }, svc: { name: svcCab.name, rating: svcRate } }, legs, rows, worst, unreached,
      over: rows.filter(x => x.lv > lim.feeder + eps || x.svc > lim.svc + eps),
      hotLegs: legs.filter(l => l.rating && l.amps > l.rating + eps), hotSvc: svcRate ? rows.filter(x => x.amps > svcRate + eps) : [],
      maxLv: Math.max(0, ...rows.map(x => x.lv)), maxSvc: Math.max(0, ...rows.map(x => x.svc)), max: worst ? worst.total : 0 };
  },
  _taperLabel(per) {
    const s = [...per.values()].map(c => c.size_mm2).sort((a, b) => a - b), cond = [...per.values()][0] && [...per.values()][0].conductor;
    return s.length ? (s[0] === s[s.length - 1] ? `${s[0]} mm² ${cond}` : `tapered ${s[0]} to ${s[s.length - 1]} mm² ${cond}`) : '';
  },
  // each mini-sub's demand (Demand's own diversified figure) against its transformer: the one picked here, else the smallest in the library that carries it
  _txRows() {
    const r = this.result, d = r.dem, vd = this.cfg().vd, opts = Retic._txOptions();
    return d.input.minisubs.map((m, i) => {
      const mr = d.res.minisubs.find(x => x.minisubId === m.id), kva = mr ? (+mr.totalKVA || 0) : 0;
      const t = Retic._minisubTx({ txTypeId: vd.tx }, kva);
      return { name: 'Mini-sub ' + (i + 1), kva, tx: t, over: !!t && kva > t.kva + 1e-9, picked: !!vd.tx && !!t && !t.auto, next: opts.find(o => o.kva >= kva) || null };
    });
  },
  // Demand's settings (load class, ADMD, limits…) changed after the check: it no longer describes what Demand would say
  _vdStale() {
    const r = this.result; if (!r || !r.dem || !r.vd || r.vd.err || typeof Retic === 'undefined') return false;
    const lim = this.vdLimits();
    return r.dem.sig !== JSON.stringify(Retic._admdPayload()) || r.vd.V.limF !== lim.feeder || r.vd.V.limS !== lim.svc;
  },
  // (no cable meets the limits: the largest is not written to the routes)
  _vdCableName(type) { if (type !== 'lv' && type !== 'service') return ''; const c = this.vdCables(); if (type === 'lv' && this.result && this.result.vd && this.result.vd.unmet) return ''; const x = type === 'lv' ? c.lv : c.svc; return x ? x.name : ''; },
  // a voltage-drop setting changed: only the check is worked out again
  revd() {
    if (!this.result) return; this.vdDerive(); this.flag = null; PlanMarkup.markDirty(); PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true });
    const tok = this._vdTok = (this._vdTok || 0) + 1, r = this.result;
    if (r.vd && !r.vd.err) { r.earthBusy = true; this.earthRun(tok).then(() => { if (tok === this._vdTok) { PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true }); } }); }
  },
  // ── earth-fault loop ──
  // The proposal as Demand's own earth check takes it (Retic._earthPayload, run by /analysis/retic-earth-check): the kiosks with the
  // chosen cables, a breaker on the head of each string (the one picked, else the next standard MCCB / ACB size up from protK × the string current), the
  // transformer chosen (else the one that covers the mini-sub's demand).
  _earthSrc(lvCab, svcCab, per, r = this.result, noHeads = false) {
    const d = r.dem, vd = this.cfg().vd, byId = {}; d.res.kiosks.forEach(kr => { byId[kr.kioskId] = kr; });
    const heads = new Set(d.input.minisubs.map(m => m.id)), prot = {}, way = vd.way80 ? 'cb:mccb_80a' : '';
    const chosen = new Map(((r.design && r.design.heads) || []).map(h => [h.kioskId, h.device && h.device.id ? 'cb:' + h.device.id : '']));
    const kiosks = d.input.kiosks.map(k => {
      const cab = (per && per.get(k.id)) || lvCab;
      const o = Object.assign({}, k, { feederCable: cab.name, outgoingProtection: way || k.outgoingProtection || '', erfs: k.erfs.map(e => Object.assign({}, e, { cableType: svcCab.name })) });
      if (!noHeads && heads.has(k.fedFrom)) {
        let dev = vd.prot;                                                              // picked by hand: used on every string
        if (!dev && chosen.size) dev = chosen.get(k.id) || '';                         // the design's: sized to this string
        if (!dev && !chosen.size) { const fit = Retic._fitBreaker(vd.protK * ((byId[k.id] || {}).feederA || 0)); dev = fit ? 'cb:' + fit.id : ''; }
        if (dev) { o.protection = dev; prot[k.id] = dev; }
      }
      return o;
    });
    return { src: { minisubs: d.input.minisubs.map(m => Object.assign({}, m, vd.tx ? { txTypeId: vd.tx } : {})), kiosks, res: { minisubs: d.res.minisubs } }, prot };
  },
  // what fails in an earth result: [{ kiosk, erf (or null), item }]
  _earthFails(e) {
    const out = [], bad = x => x && ((x.loop && x.loop.status === 'fail') || (x.ecc && x.ecc.status === 'fail'));
    if (!e) return out;
    for (const k of e.kiosks || []) { if (bad(k)) out.push({ kiosk: k.kioskId, erf: null, item: k }); for (const x of k.erfs || []) if (bad(x)) out.push({ kiosk: k.kioskId, erf: x.erfId, item: x }); }
    return out;
  },
  async earthRun(tok) {
    const r = this.result, d = r && r.dem; if (!d || !r.vd || r.vd.err) { if (r) { r.earth = null; r.earthBusy = false; } return; }
    r.earthErr = ''; r.earthUp = null;
    const c = this.vdCables(), ask = async (lvCab, svcCab, per) => { const { src, prot } = this._earthSrc(lvCab, svcCab, per, r); const e = await API.runReticEarth(Retic._earthPayload(src)); return { e, prot }; };
    try {
      const per = this._designCables(r);
      if (r.design && per.size) {                                                     // the designed cables and breakers, checked once more by the same engine
        const t = await ask(c.lv || [...per.values()][0], c.svc, per); if (tok !== this._vdTok || r !== this.result) return;
        r.earth = t.e; r.prot = t.prot;
        if (tok === this._vdTok) r.earthBusy = false;
        return;
      }
      let { e, prot } = await ask(c.lv, c.svc);
      if (tok !== this._vdTok) return;
      // automatic cable: when the earth loop fails, try the next sizes up (each one still has to meet the volt-drop limits and its rating)
      if (c.auto && this._earthFails(e).length) {
        const cands = this.vdCandidates(c.feeders), i0 = cands.findIndex(x => x.id === c.lv.id), from = c.lv.name;
        for (let i = i0 + 1, n = 0; i >= 1 && i < cands.length && n < 4 && this._earthFails(e).length; i++) {
          const v = this._vdWith(cands[i], c.svc); if (v.over.length || v.hotLegs.length || v.hotSvc.length) continue;
          n++; const t = await ask(cands[i], c.svc); if (tok !== this._vdTok) return;
          if (!this._earthFails(t.e).length) {                                                   // only a size that clears every earth-fault check is worth the copper
            Object.assign(v, { autoLv: cands[i].id, autoFrom: r.vd.autoFrom, subs: r.vd.subs }); r.vd = v; e = t.e; prot = t.prot; r.earthUp = { from, to: cands[i].name };
          }
        }
      }
      r.earth = e; r.prot = prot;
    } catch (err) { if (tok === this._vdTok) { r.earth = null; r.earthErr = (err && err.message) || String(err); } }
    if (tok === this._vdTok) r.earthBusy = false;
  },

  // ── streets from a drawing layer ──
  // DXF layers that hold lines or polylines, as { d, layer, n, guess } (guess = looks like street centrelines).
  dxfLayers() {
    if (typeof PlanDxfImport === 'undefined') return [];
    const out = [];
    for (const d of PlanDxfImport.list()) {
      const data = d.hidden ? null : PlanDxfImport.dataOf(d); if (!data) continue;
      const n = new Map(), keep = typeof PlanWorkArea !== 'undefined' ? PlanWorkArea.recKeeper(d) : null;
      for (const r of (data.entities || [])) if (((r.t === 'p' && r.g !== 'HATCH') || r.t === 'l') && (!keep || keep(r))) n.set(r.l, (n.get(r.l) || 0) + 1);
      for (const [layer, c] of n) {
        const named = /street|road|centre|center|strat|pad/i.test(layer) && !/name|text|label|kerb|curb/i.test(layer);
        const kerbs = /kerb|curb/i.test(layer) || ((named || c <= 800) && this.kerbLike(d, layer, c));     // lines that come in close parallel pairs are kerbs, not centrelines
        out.push({ d, layer, n: c, kerbs, guess: named && !kerbs });
      }
    }
    return out.sort((a, b) => (b.guess - a.guess) || (b.n - a.n));
  },

  // The layer's lines as kerb chains in metres (loose pieces joined where their ends meet within 5 cm).
  _kerbPieces(d, layer) {
    const data = PlanDxfImport.dataOf(d), f = PlanEngine.factor(); if (!data || !f) return null;
    const M = (x, y) => { const w = PlanDxfImport.worldOf(d, x, y); return [w.x * f, w.y * f]; }, pieces = [];
    const keep = typeof PlanWorkArea !== 'undefined' ? PlanWorkArea.recKeeper(d) : null;
    for (const r of (data.entities || [])) {
      if (r.l !== layer || (keep && !keep(r))) continue;
      if (r.t === 'l') pieces.push([M(r.p[0], r.p[1]), M(r.p[2], r.p[3])]);
      else if (r.t === 'p' && r.g !== 'HATCH') { const pts = []; for (let i = 0; i + 1 < r.p.length; i += 2) pts.push(M(r.p[i], r.p[i + 1])); if (pts.length > 1) pieces.push(pts); }
    }
    return pieces;
  },
  _kerbCache: new Map(),
  kerbLike(d, layer, count) {
    if (typeof PlanKerbs === 'undefined' || count > 4000 || !PlanEngine.factor()) return false;
    const key = [d.id, layer, count, PlanEngine.factor()].join('|');
    if (!this._kerbCache.has(key)) {
      const pieces = this._kerbPieces(d, layer);
      // Plot boundaries pair up across a street just as kerbs do, so pairing alone proves nothing. A layer of mostly closed outlines (plots) or
      // one named for plots / boundaries is not offered as kerbs; the layer's name is a hint, the closed outlines are the test.
      let kerbs = false;
      if (pieces && pieces.length > 1 && (/kerb|curb/i.test(String(layer)) || !/erf|erven|plot|stand|lot\b|parcel|cadastr|boundar|site|building/i.test(String(layer)))) {
        const chains = PlanKerbs.joinPieces(pieces), len = c => { let L = 0; for (let i = 1; i < c.pts.length; i++) L += Math.hypot(c.pts[i][0] - c.pts[i - 1][0], c.pts[i][1] - c.pts[i - 1][1]); return L; };
        const tot = chains.reduce((a, c) => a + len(c), 0) || 1, closed = chains.filter(c => c.closed).reduce((a, c) => a + len(c), 0) / tot;
        kerbs = closed < 0.5 && PlanKerbs.pairedShare(chains) >= 0.5;
      }
      this._kerbCache.set(key, kerbs);
    }
    return this._kerbCache.get(key);
  },

  // names a street from the nearest text that reads as a name (within 25 m), each text used once
  _namer(data, d, f) {
    const W = ([x, y]) => PlanDxfImport.worldOf(d, x, y);
    const texts = (data.entities || []).filter(r => r.t === 'x' && /[A-Za-z]{3,}/.test(String(r.s || '')))
      .map(r => ({ s: String(r.s).replace(/\s+/g, ' ').trim(), w: W(r.p), pri: /name|street|road/i.test(r.l) ? 0 : 1 }));
    const dist = (pt, pl) => { let best = Infinity; for (let i = 0; i + 1 < pl.length; i++) { const a = pl[i], b = pl[i + 1], dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy; const t = L2 ? Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / L2)) : 0; best = Math.min(best, Math.hypot(pt.x - a.x - t * dx, pt.y - a.y - t * dy)); } return best; };
    const used = new Set();
    const name = wp => {
      let best = null, bd = 25 / f;
      for (const t of texts) { if (used.has(t)) continue; const dd = dist(t.w, wp) + t.pri * 1e-6; if (dd < bd) { bd = dd; best = t; } }
      if (best) used.add(best);
      return best ? best.s : null;
    };
    name.used = used;
    name.peek = (wp, lim) => {                                             // the nearest name, without using it up
      let best = null, bd = (lim || 40) / f;
      for (const t of texts) { const dd = dist(t.w, wp) + t.pri * 1e-6; if (dd < bd) { bd = dd; best = t; } }
      return best ? best.s : null;
    };
    return name;
  },

  // Every polyline of the layer becomes a Street centreline (the drawn vertices, so curves stay curves),
  // named from the nearest text. Returns how many were made.
  streetsFromLayer(descId, layer) {
    const d = PlanDxfImport.byId(descId), data = d && PlanDxfImport.dataOf(d), pm = AppState.planMarkup, f = PlanEngine.factor();
    if (!data || !f) { UI.toast('Calibrate the plan first.', 'warn', 4000); return 0; }
    const lines = [], polys = [];
    const [bx0, by0, bx1, by1] = data.bbox || [0, 0, 1, 1];
    const eps = Math.max(bx1 - bx0, by1 - by0, 1e-9) * 1e-6;
    const keep = typeof PlanWorkArea !== 'undefined' ? PlanWorkArea.recKeeper(d) : null;
    for (const r of (data.entities || [])) {
      if (r.l !== layer || (keep && !keep(r))) continue;
      if (r.t === 'l') lines.push(r);
      else if (r.t === 'p' && r.g !== 'HATCH') { const pts = []; for (let i = 0; i + 1 < r.p.length; i += 2) pts.push([r.p[i], r.p[i + 1]]); if (pts.length > 1) polys.push(pts); }
    }
    if (lines.length && typeof PlanDxfManager !== 'undefined') for (const ch of PlanDxfManager._chainLines(lines, eps)) if (ch.pts.length > 1) polys.push(ch.pts);
    if (!polys.length) { UI.toast(`Layer "${layer}" has no lines or polylines.`, 'warn', 4000); return 0; }
    const W = ([x, y]) => PlanDxfImport.worldOf(d, x, y);
    const namer = this._namer(data, d, f), used = namer.used;
    let made = 0;
    PlanMarkup.snapshot();
    polys.forEach((pts, i) => {
      const wp = pts.map(W), nm = namer(wp);
      pm.routes.push({ id: AppState.planGenId('pmrt'), type: 'street', fromId: null, toId: null, points: wp, cableType: '', curved: false,
        props: { name: nm || 'Street ' + (pm.routes.filter(r => r.type === 'street').length + 1), width: 12 } });
      made++;
    });
    PlanMarkup.markDirty(); this.touched();
    UI.toast(`${made} street${made === 1 ? '' : 's'} taken from layer "${layer}"${used.size < made ? ` (${made - used.size} without a name nearby: check them)` : ''}. Width 12 m; change it in each street's properties.`, used.size < made ? 'warn' : 'success', 6000);
    return made;
  },

  // ───────── streets from kerbs: pick the kerb lines on the plan, then Create ─────────
  // Nothing is chosen at first. A click takes the whole joined kerb line under the pointer and every street it touches; Shift-click
  // one drawn piece; Alt-click (or the Subtract button) takes streets out again; Backspace takes the last pick back. The stage is
  // PlanKerbs.stage (shared with the Road plan): the streets are a replayable fold over the picks.
  kerbOpt: { wmin: 4, wmax: 20, gap: 15, oneW: 6, join: 40 },
  kerbStage: null,
  // every visible layer of every drawing as kerb chains, keyed 'descId|layer'
  _kerbPool() {
    const layers = {}, meta = {};
    for (const d of PlanDxfImport.list()) {
      const data = d.hidden ? null : PlanDxfImport.dataOf(d), f = PlanEngine.factor(); if (!data || !f) continue;
      const M = (x, y) => { const w = PlanDxfImport.worldOf(d, x, y); return [w.x * f, w.y * f]; }, by = new Map();
      const keep = typeof PlanWorkArea !== 'undefined' ? PlanWorkArea.recKeeper(d) : null;
      for (const r of (data.entities || [])) {
        if ((keep && !keep(r)) || PlanDxfImport.layerHidden(d, r.l)) continue;
        let pts = null;
        if (r.t === 'l') pts = [M(r.p[0], r.p[1]), M(r.p[2], r.p[3])];
        else if (r.t === 'p' && r.g !== 'HATCH') { pts = []; for (let i = 0; i + 1 < r.p.length; i += 2) pts.push(M(r.p[i], r.p[i + 1])); }
        if (!pts || pts.length < 2) continue;
        if (!by.has(r.l)) by.set(r.l, []); by.get(r.l).push(pts);
      }
      for (const [layer, pieces] of by) { const key = d.id + '|' + layer; layers[key] = PlanKerbs.joinPieces(pieces); meta[key] = { descId: d.id, layer }; }
    }
    return { layers, meta };
  },
  _kerbSig() {                                                             // what a pool depends on: the scale, the working area, the hidden layers
    const hid = PlanDxfImport.list().map(d => d.id + ':' + (d.hidden ? 'h' : '') + Object.keys(d.layers || {}).filter(k => d.layers[k].hidden).sort().join(',')).join('|');
    return [PlanEngine.factor(), typeof PlanWorkArea !== 'undefined' ? PlanWorkArea.sig() : '', hid].join('#');
  },
  kerbStart() {
    if (typeof PlanKerbs === 'undefined') return;
    const f = PlanEngine.factor(); if (!f) { UI.toast('Calibrate the plan first.', 'warn', 4000); return; }
    const P = this._kerbPool(); if (!Object.keys(P.layers).length) { UI.toast('The drawings have no visible lines or polylines.', 'warn', 4000); return; }
    this.centreStage = null; if (typeof PlanReserveUI !== 'undefined') PlanReserveUI.stage = null;
    this.kerbStage = Object.assign(PlanKerbs.stage(P.layers, this.kerbOpt), { f, meta: P.meta, sigNow: this._kerbSig(), namers: {}, hover: null });
    UI.toast('Click a kerb line to add it and the streets it touches. Shift-click takes one piece, Alt-click takes streets out, Backspace undoes the last pick, Enter creates.', 'info', 8000);
    this.syncHint(); PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true });
  },
  // the working area, a hidden layer or the scale changed: rebuild the kerb lines, keep the picks that still apply
  _kerbRefresh() {
    const S = this.kerbStage; if (!S || S.sigNow === this._kerbSig()) return;
    const P = this._kerbPool(); S.f = PlanEngine.factor(); S.meta = P.meta; S.sigNow = this._kerbSig(); S.namers = {};
    S.setLayers(P.layers);
    if (S.dropped) UI.toast(`${S.dropped} pick${S.dropped === 1 ? '' : 's'} dropped: the kerb line is no longer there.`, 'warn', 4000);
  },
  kerbSolve() {
    const S = this.kerbStage; if (!S) return;
    S.setOpt(this.kerbOpt);
    PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true });
  },
  kerbMode(m) { const S = this.kerbStage; if (!S) return; S.mode = m; S.one = S.pairFrom = null; this.syncHint(); PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true }); },
  // arm a lone kerb: the next click on the plan, on the road's side of it, makes the street half the set width in from the kerb
  kerbOne(layer, i) {
    const S = this.kerbStage; if (!S) return; S.arm(layer, i);
    UI.toast(`Click on the road's side of that kerb: the street goes ${this.kerbOpt.oneW} m wide beside it.`, 'info', 4000);
    this.syncHint(); PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true });
  },
  kerbPair(layer, i) {
    const S = this.kerbStage; if (!S) return; S.armPair(layer, i);
    UI.toast('Now click the kerb on the other side of that road.', 'info', 3500);
    this.syncHint(); PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true });
  },
  _kerbNamer(S, key) {                                                     // the street namer of the drawing a layer key belongs to ('*' = the first drawing with a pick)
    let m = S.meta[key];
    if (!m) { const k = S.keys().find(k => [...S.used].some(u => u.startsWith(k + '\u0000'))) || S.keys()[0]; m = S.meta[k]; }
    if (!m) return () => null;
    if (!S.namers[m.descId]) { const d = PlanDxfImport.byId(m.descId), data = d && PlanDxfImport.dataOf(d); S.namers[m.descId] = data ? this._namer(data, d, S.f) : (() => null); }
    return S.namers[m.descId];
  },
  // what a kerb chain with no partner is: its length, the nearest road name (or where it is)
  kerbInfo(l) {
    const S = this.kerbStage, k = S.info(l.layer, l.chain), f = S.f, nm = this._kerbNamer(S, l.layer);
    return { ...k, name: nm && nm.peek && nm.peek(S.layers[l.layer][l.chain].pts.map(q => ({ x: q[0] / f, y: q[1] / f }))) };
  },
  kerbCancel() { this.kerbStage = null; this.syncHint(); PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true }); },
  kerbKey(e) {                                                             // Backspace takes the last pick back (the plan must not delete a part)
    const S = this.kerbStage; if (!S) return false;
    if (e.key === 'Backspace') { if (S.undo()) { UI.toast('Last pick taken back.', 'info', 1500); this.syncHint(); PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true }); } return true; }
    if (e.key === 'Enter') { this.kerbCreate(); return true; }
    return false;
  },
  kerbClick(pt, e) {
    const S = this.kerbStage; this._kerbRefresh();
    const f = S.f, m = [pt.x * f, pt.y * f], tol = 14 * f / PlanEngine.view.zoom, ev = e || {}, mod = ev.altKey || ev.shiftKey || ev.ctrlKey || ev.metaKey;
    const redraw = () => { this.syncHint(); PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true }); };
    if (S.one && !mod) { S.place(m); redraw(); return; }                   // the road beside a lone kerb: this click says which side
    if (S.pairFrom && !mod) {                                              // the kerb across the road
      const h = S.hitAt(m, tol);
      if (!h) { S.pairFrom = null; UI.toast('Pairing cancelled: no kerb there.', 'info', 2500); }
      else { const r = S.pairWith(h.layer, h.chain); if (r === 'noroad') UI.toast('Those two kerbs do not run beside each other.', 'warn', 3500); else if (r === 'layer') UI.toast('That kerb is on another layer: tick "Look for partners on any layer".', 'warn', 4000); }
      redraw(); return;
    }
    if (ev.ctrlKey || ev.metaKey) { const h = S.hitAt(m, tol); if (!h) UI.toast('Click on a kerb line.', 'info', 2500); else this.kerbOne(h.layer, h.chain); return; }
    const h = S.hitAt(m, tol), op = ev.altKey ? 'sub' : S.mode;
    if (!h) {
      if (op === 'sub') { const i = S.streetAt(m, tol); if (i >= 0) { const r = S.subStreet(i); UI.toast(r && !r.noop ? 'Street removed.' : 'Nothing to remove there.', 'info', 2000); redraw(); return; } }
      UI.toast('Click on a kerb line.', 'info', 2500); return;
    }
    if (op === 'add' && !ev.shiftKey && S.lonely.some(l => l.layer === h.layer && l.chain === h.chain)) { this.kerbPair(h.layer, h.chain); return; }
    const r = S.addChain(h.layer, h.chain, ev.shiftKey ? h.part : null, op), n = k => `${k} street${k === 1 ? '' : 's'}`;
    if (r.noop) UI.toast(op === 'add' ? 'Already in.' : 'Nothing to remove there.', 'info', 1800);
    else if (op === 'add') UI.toast(r.added ? `Added ${n(r.added)}.` : r.lonely > 0 ? 'No partner found: shown red. Click it again, then the kerb across the road.' : 'Added.', r.added ? 'success' : 'warn', 3000);
    else UI.toast(`Removed ${n(r.removed)}.`, 'info', 2000);
    redraw();
  },
  kerbMove(pt, e) {
    const S = this.kerbStage, f = S.f, h = S.hitAt([pt.x * f, pt.y * f], 14 * f / PlanEngine.view.zoom), part = h && e && e.shiftKey ? h.part : null;
    const key = h ? h.layer + '\u0000' + h.chain + (part ? part.join(',') : '') : '';
    if (key !== S._hk) { S._hk = key; S.hover = h ? { ...h, part } : null; PlanEngine.requestDraw({ fg: true }); }
  },
  kerbCreate() {
    const S = this.kerbStage; if (!S) return 0;
    const pm = AppState.planMarkup, f = S.f;
    if (!S.streets.length) { UI.toast('No streets to create.', 'warn', 3000); return 0; }
    PlanMarkup.snapshot();
    let named = 0;
    S.streets.forEach(st => {
      const wp = st.pts.map(q => ({ x: q[0] / f, y: q[1] / f })), nm = this._kerbNamer(S, st.layer)(wp); if (nm) named++;
      pm.routes.push({ id: AppState.planGenId('pmrt'), type: 'street', fromId: null, toId: null, points: wp, cableType: '', curved: false,
        props: { name: nm || 'Street ' + (pm.routes.filter(r => r.type === 'street').length + 1), width: st.w } });
    });
    const made = S.streets.length, nets = S.networks().length; this.kerbStage = null;
    PlanMarkup.markDirty(); this.touched(); this.syncHint(); PlanEngine.requestDraw({ fg: true });
    UI.toast(`${made} street${made === 1 ? '' : 's'} made from the kerbs${named < made ? ` (${made - named} without a name nearby: check them)` : ''}.${nets > 1 ? ` They form ${nets} separate networks: the LV and fibre networks will not reach across the gaps.` : ' One connected network.'}`, named < made || nets > 1 ? 'warn' : 'success', 8000);
    return made;
  },
  kerbDraw(ctx, zoom) {
    const S = this.kerbStage; if (!S) return;
    const u = 1 / zoom, f = S.f, line = pts => { ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p[0] / f, p[1] / f) : ctx.moveTo(p[0] / f, p[1] / f)); ctx.stroke(); };
    ctx.save(); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    const lonely = new Set(S.lonely.map(l => l.layer + '\u0000' + l.chain)), armed = S.pairFrom || S.one;
    let npts = 0; for (const k of S.keys()) for (const c of S.layers[k]) npts += c.pts.length;
    for (const k of S.keys()) S.layers[k].forEach((c, i) => {
      const id = k + '\u0000' + i;
      if (armed && armed.layer === k && armed.chain === i) { ctx.strokeStyle = '#2563eb'; ctx.lineWidth = 3 * u; ctx.setLineDash([]); }
      else if (lonely.has(id)) { ctx.strokeStyle = '#dc2626'; ctx.lineWidth = 2 * u; ctx.setLineDash([5 * u, 4 * u]); }
      else if (S.used.has(id)) { ctx.strokeStyle = 'rgba(30,64,175,.75)'; ctx.lineWidth = 1.6 * u; ctx.setLineDash([]); }
      else if (npts < 150000) { ctx.strokeStyle = 'rgba(100,116,139,.4)'; ctx.lineWidth = 1 * u; ctx.setLineDash([]); }
      else return;
      line(c.pts);
    });
    if (S.hover) {                                                         // what a click would take: green to add, red to take out
      const h = S.hover, c = S.layers[h.layer] && S.layers[h.layer][h.chain];
      if (c) { ctx.setLineDash([]); ctx.strokeStyle = S.mode === 'add' ? 'rgba(22,163,74,.9)' : 'rgba(220,38,38,.9)'; ctx.lineWidth = 4 * u; line(c.pts); }
    }
    ctx.setLineDash([]); ctx.lineWidth = 3.2 * u;
    const comps = S.networks(), main = new Set(comps[0] || []);                        // streets cut off from the main network are drawn orange
    S.streets.forEach((st, si) => {
      ctx.strokeStyle = main.has(si) ? '#f59e0b' : '#ea580c'; line(st.pts);
      const a = st.pts[0], b = st.pts[st.pts.length - 1]; ctx.fillStyle = '#f59e0b';
      for (const q of [a, b]) { ctx.beginPath(); ctx.arc(q[0] / f, q[1] / f, 3 * u, 0, 6.2832); ctx.fill(); }
      const mid = st.pts[Math.floor(st.pts.length / 2)]; ctx.fillStyle = '#92400e'; ctx.font = `${11 * u}px sans-serif`; ctx.fillText(st.w.toFixed(1) + ' m', mid[0] / f + 4 * u, mid[1] / f - 4 * u);
    });
    ctx.restore();
  },

  // ───────── streets from centrelines you pick: click the lines, then Create ─────────
  // The lines come from a drawing layer (start again on another layer to add from it too). A click takes the whole
  // line the pointer is on (loose pieces joined end to end, going straight on at a junction); Shift-click takes only the
  // one drawn piece; clicking a picked line again, or Alt-click, drops it. Enter creates one street per picked line.
  centreStage: null,
  centreW: 12,
  centreStart(descId, layer) {
    const d = PlanDxfImport.byId(descId), f = PlanEngine.factor();
    if (!d || !f) { UI.toast('Calibrate the plan first.', 'warn', 4000); return; }
    const pieces = this._kerbPieces(d, layer);
    if (!pieces || !pieces.length) { UI.toast(`Layer "${layer}" has no lines or polylines.`, 'warn', 4000); return; }
    this.kerbStage = null; if (typeof PlanReserveUI !== 'undefined') PlanReserveUI.stage = null;
    let S = this.centreStage;
    if (!S || S.descId !== descId) S = this.centreStage = { descId, f, layers: [], pieces: [], chains: [], picks: [], namer: this._namer(PlanDxfImport.dataOf(d), d, f) };
    if (!S.layers.includes(layer)) {
      S.layers.push(layer);
      pieces.forEach(pts => S.pieces.push({ pts, layer }));
      (typeof PlanKerbs !== 'undefined' ? PlanKerbs.joinPieces(pieces) : pieces.map(pts => ({ pts }))).forEach(c => S.chains.push({ pts: c.pts, layer }));
    }
    UI.toast(`Click the centreline of each road in "${layer}". Click takes the whole line, Shift-click one drawn piece, Alt-click (or clicking it again) drops it, Enter creates the streets.`, 'info', 7000);
    PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true });
  },
  centreCancel() { this.centreStage = null; PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true }); },
  _centreSig(pts) { const a = pts[0], b = pts[pts.length - 1]; return [pts.length, a[0].toFixed(2), a[1].toFixed(2), b[0].toFixed(2), b[1].toFixed(2)].join('|'); },
  _centreDist(pts, m) {
    let best = Infinity;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, ((m[0] - a[0]) * dx + (m[1] - a[1]) * dy) / L2)) : 0;
      best = Math.min(best, Math.hypot(m[0] - a[0] - t * dx, m[1] - a[1] - t * dy));
    }
    return best;
  },
  centreClick(pt, e) {
    const S = this.centreStage, f = S.f, m = [pt.x * f, pt.y * f], tol = 14 * f / PlanEngine.view.zoom, redraw = () => { PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true }); };
    e = e || {};
    const near = list => { let bi = -1, bd = tol; list.forEach((c, i) => { const dd = this._centreDist(c.pts, m); if (dd <= bd) { bd = dd; bi = i; } }); return bi; };
    if (e.altKey) {                                                       // drop the picked line under the pointer
      const i = near(S.picks); if (i < 0) UI.toast('No picked line there.', 'info', 2000); else S.picks.splice(i, 1);
      redraw(); return;
    }
    const list = e.shiftKey ? S.pieces : S.chains, i = near(list);
    if (i < 0) { UI.toast('Click on a line of the layer (' + S.layers.join(', ') + '). Pick another layer in the list and press Pick centrelines to take lines from it too.', 'info', 3500); return; }
    const c = list[i], sig = this._centreSig(c.pts), at = S.picks.findIndex(p => this._centreSig(p.pts) === sig);
    if (at >= 0) S.picks.splice(at, 1); else S.picks.push({ pts: c.pts, layer: c.layer, piece: !!e.shiftKey });
    redraw();
  },
  centreLen(pts) { let L = 0; for (let i = 0; i + 1 < pts.length; i++) L += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]); return L; },
  centreCreate() {
    const S = this.centreStage; if (!S) return 0;
    if (!S.picks.length) { UI.toast('Pick at least one line first.', 'warn', 3000); return 0; }
    const pm = AppState.planMarkup, f = S.f, w = this.centreW > 0 ? this.centreW : 12;
    PlanMarkup.snapshot();
    let named = 0;
    S.picks.forEach(c => {
      const wp = c.pts.map(q => ({ x: q[0] / f, y: q[1] / f })), nm = S.namer(wp); if (nm) named++;
      pm.routes.push({ id: AppState.planGenId('pmrt'), type: 'street', fromId: null, toId: null, points: wp, cableType: '', curved: false,
        props: { name: nm || 'Street ' + (pm.routes.filter(r => r.type === 'street').length + 1), width: w } });
    });
    const made = S.picks.length; this.centreStage = null;
    PlanMarkup.markDirty(); this.touched(); PlanEngine.requestDraw({ fg: true });
    UI.toast(`${made} street${made === 1 ? '' : 's'} made from the lines you picked${named < made ? ` (${made - named} without a name nearby: check them)` : ''}. Width ${w} m; change it in each street's properties.`, named < made ? 'warn' : 'success', 6000);
    return made;
  },
  centreDraw(ctx, zoom) {
    const S = this.centreStage; if (!S) return;
    const u = 1 / zoom, f = S.f;
    ctx.save(); ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.setLineDash([]);
    S.picks.forEach(c => {
      ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 3.2 * u;
      ctx.beginPath(); c.pts.forEach((p, i) => i ? ctx.lineTo(p[0] / f, p[1] / f) : ctx.moveTo(p[0] / f, p[1] / f)); ctx.stroke();
      ctx.fillStyle = '#f59e0b';
      for (const q of [c.pts[0], c.pts[c.pts.length - 1]]) { ctx.beginPath(); ctx.arc(q[0] / f, q[1] / f, 3 * u, 0, 6.2832); ctx.fill(); }
    });
    ctx.restore();
  },

  // ───────── draw the street centrelines yourself, without leaving Auto layout ─────────
  // Uses the plan's own street route tool (snapping to the drawing's corners / ends, an end that lands on another street joins it),
  // so a street drawn here is the same Street centreline as one drawn from the Routes group.
  drawStreets: false,
  _rt() { return PlanTools._tools && PlanTools._tools.route; },
  streetDrawOn(on) {
    this.drawStreets = !!on;
    const R = this._rt(); if (!R) { this.drawStreets = false; return; }
    if (on) { this.kerbStage = null; this.centreStage = null; if (typeof PlanReserveUI !== 'undefined') PlanReserveUI.stage = null; R._type = 'street'; R._draft = null; R._hover = null; UI.toast('Click along each street centreline. Enter, or click the last point again, finishes it; Backspace takes a point back; Esc stops. A street that ends on another one joins it.', 'info', 7000); }
    else { R._draft = null; R._hover = null; }
    PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true });
  },
  streetDown(pt) {
    const R = this._rt(); R._type = 'street';
    const q = PlanTools.snap(pt, { wantElements: false });                       // a street never attaches to a part (an erf point, a kiosk), only to geometry
    const d = R._draft;
    if (d && d.points.length >= 2) {                                                // clicking the last point again finishes the street
      const last = d.points[d.points.length - 1];
      if (Math.hypot(q.x - last.x, q.y - last.y) <= 7 / PlanEngine.view.zoom) { this.streetFinish(); return; }
    }
    if (!d) R._draft = { type: 'street', fromId: null, points: [{ x: q.x, y: q.y }] };
    else if (Math.hypot(q.x - d.points[d.points.length - 1].x, q.y - d.points[d.points.length - 1].y) > 1e-9) d.points.push({ x: q.x, y: q.y });
    R._hover = q; PlanEngine.requestDraw({ fg: true });
  },
  streetFinish() {
    const R = this._rt(), before = new Set(AppState.planMarkup.routes.map(r => r.id));
    if (!R._draft || R._draft.points.length < 2) { UI.toast('A street needs at least two points.', 'warn', 2500); return true; }
    R._finalize(null);
    const made = AppState.planMarkup.routes.filter(r => !before.has(r.id) && r.type === 'street');
    made.forEach(r => { r.props = Object.assign({}, r.props, { width: this.centreW > 0 ? this.centreW : 12, name: 'Street ' + AppState.planMarkup.routes.filter(x => x.type === 'street').length }); });
    if (made.length) { UI.toast(`Street ${made.length > 1 ? 's' : ''} drawn. Width ${this.centreW} m; change it in the street's properties. Draw the next, or press Esc.`, 'success', 3500); this.touched(); }
    return true;
  },
  streetKey(e) {
    const R = this._rt(); if (!this.drawStreets || !R) return false;
    if (e.key === 'Enter') { if (R._draft) return this.streetFinish(); return false; }
    if (e.key === 'Backspace') { if (!R._draft) return false; R._draft.points.pop(); if (!R._draft.points.length) R._draft = null; PlanEngine.requestDraw({ fg: true }); return true; }
    if (e.key === 'Escape') { if (R._draft) { R._draft = null; PlanEngine.requestDraw({ fg: true }); } else this.streetDrawOn(false); return true; }
    return false;
  },

  // ───────── section lines: a polyline drawn over the street line says which cross-section applies there ─────────
  secDraw: null,                                                                     // { sec: section id, pts: [{x, y}] } while the tool is on
  _secHover: null,
  secDrawOn(on, secId) {
    if (on) { this.streetDrawOn(false); this.kerbStage = null; this.centreStage = null; this.secDraw = { sec: secId, pts: [] }; this._secHover = null; UI.toast('Click along the street line where this section applies. Enter, or click the last point again, finishes. Ends snap to the drawing; the line need not be exact.', 'info', 7000); }
    else this.secDraw = null;
    PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true });
  },
  _streetsM() { const f = PlanEngine.factor(); return this.streetsOnPlan().map(r => ({ id: r.id, w: this._num(r.props && r.props.width, 6, 40, 12), pts: this._flat(r).map(p => [p.x * f, p.y * f]) })); },
  secDown(pt) {
    const q = PlanTools.snap(pt, { wantElements: false }), d = this.secDraw; if (!d) return;
    const last = d.pts[d.pts.length - 1];
    if (last && d.pts.length >= 2 && Math.hypot(q.x - last.x, q.y - last.y) <= 7 / PlanEngine.view.zoom) { this.secFinish(); return; }
    if (!last || Math.hypot(q.x - last.x, q.y - last.y) > 1e-9) d.pts.push({ x: q.x, y: q.y });
    this._secHover = q; PlanEngine.requestDraw({ fg: true });
  },
  secFinish() {
    const d = this.secDraw, f = PlanEngine.factor(); if (!d || !f) return true;
    if (d.pts.length < 2) { UI.toast('A section line needs at least two points.', 'warn', 2500); return true; }
    const S = this.cfg().sections, made = PlanSections.linesFromPolyline(d.pts.map(p => [p.x * f, p.y * f]), this._streetsM(), d.sec);
    if (!made.length) { UI.toast('That line does not run along a street. Draw it over the street line.', 'warn', 4000); d.pts = []; PlanEngine.requestDraw({ fg: true }); return true; }
    let n = S.lines.length; const gid = 'g' + Date.now().toString(36);
    made.forEach(l => { let id; do { id = 'sl_' + (++n); } while (S.lines.some(x => x.id === id)); S.lines.push(Object.assign(l, { id, group: gid })); });
    const nm = S.list.find(x => x.id === d.sec);
    UI.toast(`"${nm ? nm.name : 'Section'}" applies to ${made.length} street${made.length === 1 ? '' : 's'}. Draw the next line, or press Esc.`, 'success', 3500);
    d.pts = []; this._secHover = null; this.touched(); return true;
  },
  secKey(e) {
    const d = this.secDraw; if (!d) return false;
    if (e.key === 'Enter') return this.secFinish();
    if (e.key === 'Backspace') { if (!d.pts.length) return false; d.pts.pop(); PlanEngine.requestDraw({ fg: true }); return true; }
    if (e.key === 'Escape') { if (d.pts.length) { d.pts = []; PlanEngine.requestDraw({ fg: true }); } else this.secDrawOn(false); return true; }
    return false;
  },
  // the stretch [s0, s1] of a street as plan points (for drawing and zooming)
  secStretch(l) {
    const f = PlanEngine.factor(), r = AppState.planMarkup.routes.find(x => x.id === l.streetId); if (!r || !f) return null;
    const pts = this._flat(r), cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) * f);
    const a = Math.min(l.s0, l.s1), b = Math.max(l.s0, l.s1), at = s => { for (let i = 1; i < pts.length; i++) if (s <= cum[i] || i === pts.length - 1) { const t = Math.max(0, Math.min(1, (s - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1))); return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t }; } return pts[0]; };
    const out = [at(a)]; for (let i = 0; i < pts.length; i++) if (cum[i] > a && cum[i] < b) out.push({ x: pts[i].x, y: pts[i].y }); out.push(at(b)); return out;
  },
  secShow(l) { const p = this.secStretch(l); if (p && p.length) PlanEngine.zoomToPoints(p); },
  SEC_PAL: ['#2563eb', '#0b6e6e', '#b4501c', '#7c3aed', '#8a6a00', '#be185d'],
  secDrawOverlay(ctx, zoom) {
    const S = this.cfg().sections, u = 1 / zoom;
    if (!S.lines.length && !this.secDraw) return;
    ctx.save(); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (const l of S.lines) {
      const p = this.secStretch(l); if (!p || p.length < 2) continue;
      const i = Math.max(0, S.list.findIndex(x => x.id === l.sec));
      ctx.strokeStyle = this.SEC_PAL[i % this.SEC_PAL.length]; ctx.globalAlpha = S.on || this.secDraw ? 0.9 : 0.45; ctx.lineWidth = 6 * u;
      ctx.beginPath(); p.forEach((q, k) => k ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const d = this.secDraw;
    if (d && d.pts.length) {
      const i = Math.max(0, S.list.findIndex(x => x.id === d.sec)), col = this.SEC_PAL[i % this.SEC_PAL.length];
      ctx.strokeStyle = col; ctx.lineWidth = 3 * u; ctx.setLineDash([8 * u, 5 * u]);
      ctx.beginPath(); d.pts.forEach((q, k) => k ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)); if (this._secHover) ctx.lineTo(this._secHover.x, this._secHover.y); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#fff'; ctx.lineWidth = 2 * u; d.pts.forEach(q => { ctx.beginPath(); ctx.arc(q.x, q.y, 4 * u, 0, 7); ctx.fill(); ctx.stroke(); });
    }
    ctx.restore();
  },

  // The mini-subs you placed, in the order they will be numbered: the layout's own points (clicked with Mini-sub), then the mini-sub
  // parts you drew on the plan. [{ x, y (plan points), src: 'layout' | 'plan', i (index in cfg().subs) }]
  placedSubs() {
    const pm = AppState.planMarkup, L = this.cfg(), out = [];
    const near = q => out.some(o => Math.hypot(o.x - q.x, o.y - q.y) < 1 / (PlanEngine.factor() || 1));
    (L.subs || []).forEach((q, i) => { if (!near(q)) out.push({ x: q.x, y: q.y, src: 'layout', i }); });
    pm.elements.filter(e => e.type === 'minisub' && e.auto !== 'layout').forEach(e => { if (!near(e)) out.push({ x: e.x, y: e.y, src: 'plan', id: e.id }); });
    return out;
  },
  // A click in Mini-sub mode: stand a mini-sub exactly there (works before any layout has been run).
  subClick(pt, ev) {
    const f = PlanEngine.factor(), L = this.cfg();
    if (!f) { UI.toast('Calibrate the plan first: the layout works in metres.', 'warn', 3500); return; }
    const m = [pt.x * f, pt.y * f], tol = 14 * f / PlanEngine.view.zoom;
    const mine = (L.subs || []).map((q, i) => ({ i, d: Math.hypot(q.x * f - m[0], q.y * f - m[1]) })).filter(x => x.d <= tol).sort((a, b) => a.d - b.d)[0];
    if (ev && ev.altKey) {                                                           // Alt-click removes the one under the pointer
      if (mine) { L.subs.splice(mine.i, 1); this.subMove = null; this.touched(true); }
      else UI.toast('No mini-sub placed by Auto layout there. A mini-sub part you drew on the plan is removed on the plan.', 'info', 3500);
      return;
    }
    if (this.subMove != null && L.subs[this.subMove]) { L.subs[this.subMove] = { x: pt.x, y: pt.y }; this.subMove = null; this.touched(true); return; }   // the second click of a move
    if (mine) { this.subMove = mine.i; UI.toast('Click where this mini-sub should stand. Alt-click it to remove it.', 'info', 3500); PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true }); return; }
    if ((L.subs || []).length >= 20) { UI.toast('That is the most mini-subs the layout takes (20).', 'warn', 3000); return; }
    L.subs.push({ x: pt.x, y: pt.y }); this.touched(true);                               // exactly where you click: no kiosk is added beside it
  },


  // ───────── the panel's steps, presets and footer button ─────────
  presetOf() { const p = this.cfg().params, P = this.PRESETS; for (const k of Object.keys(P)) if (Object.keys(P[k]).every(x => String(p[x]) === String(P[k][x]))) return k; return 'custom'; },
  setPreset(k) { const P = this.PRESETS[k]; if (!P) return; Object.assign(this.cfg().params, P); this.touched(); },
  setStep(n) {
    n = Math.max(1, Math.min(4, n | 0)); this.step = n;
    if (n !== 1) { this.streetDrawOn(false); if (this.kerbStage) this.kerbCancel(); if (this.centreStage) this.centreCancel(); if (typeof PlanReserveUI !== 'undefined' && PlanReserveUI.stage) PlanReserveUI.cancel(); }
    if (n === 2) this.mode = 'sub'; else if (this.mode === 'sub') this.mode = 'front';
    this.markFor = null; this.subMove = null; this._pk = null; this._picked = null;
    PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true });
  },
  // the step a user most likely wants when the tool opens
  firstStep() { return !this.streetsOnPlan().length ? 1 : !this.placedSubs().length ? 2 : this.result ? 4 : 3; },
  edits() { const L = this.cfg(), M = L.moves; return Object.keys(L.fronts).length + Object.keys(L.markers).length + L.cuts.length + (L.entry ? 1 : 0) + M.kiosks.length + Object.keys(M.verts).length + M.adds.length + M.cuts.length + Object.keys(M.xs).length; },
  nextAction(r, placed, noKiosks, nErv, nStreets) {
    if (!nErv) return { label: 'Detect the erven to continue', act: 'goto', s: 1, dis: true, note: 'The layout needs erf boundaries: use Detect erven.' };
    if (!nStreets) return { label: 'Add the streets to continue', act: 'goto', s: 1, dis: true, note: 'The layout needs the street centrelines.' };
    if (!placed.length) return { label: 'Place a mini-sub to continue', act: 'goto', s: 2, dis: true, note: 'The layout works from the mini-subs you place.' };
    if (!this.admdOk()) return { label: 'Confirm the ADMD to continue', act: 'goto', s: 3, note: 'Cable sizes come from the ADMD. Confirm it in Rules.' };
    if (!r || this.stale) return { label: r ? 'Re-run layout' : 'Run layout', act: 'run', note: '' };
    if (noKiosks) return { label: 'Fix the streets to continue', act: 'goto', s: 1, dis: true, note: 'No erf faces a street, so there are no kiosks to create.' };
    return { label: 'Create on plan', act: 'create', create: true, note: 'Replaces the previous auto layout. Your own items stay.' };
  },
  createCounts() {
    const r = this.result; if (!r) return {};
    const mh = ((r.fibre && r.fibre.inter) || []).length + ((r.fibre && r.fibre.mhs) || []).length;
    const m = r.trench ? Object.values(r.trench.summary).reduce((a, q) => a + q.len, 0) : 0;
    return { markers: r.erven.filter(e => e.marker).length, kiosks: `${r.kiosks.length} + ${r.erven.filter(e => e.kiosk && e.route).length}`, lv: `${r.net.subs.length} + ${r.net.lvLinks.length}`,
      fibre: String(mh), cross: String(r.stats ? r.stats.crossings : 0), trench: Math.round(m).toLocaleString('en') + ' m' };
  },
  // the line over the plan: what a click does now
  hint() {
    const r = this.result, pre = 'Auto layout · ';
    if (this.secDraw) return pre + 'Section line: click along the street line. Enter, or the last point again, finishes. Backspace takes a point back, Esc stops.';
    if (this.drawStreets) return pre + 'Streets: click along the street. Enter, or the last point again, finishes it. Backspace takes a point back, Esc stops.';
    if (this.centreStage) return pre + 'Streets: click the centreline of each road. Shift-click one piece, Alt-click drops it. Enter creates, Esc leaves.';
    if (typeof PlanReserveUI !== 'undefined' && PlanReserveUI.stage) return pre + 'Streets: ' + PlanReserveUI.hint();
    if (this.kerbStage) {
      const S = this.kerbStage;
      if (S.one) return pre + 'Streets: click on the road\'s side of that kerb. Esc leaves.';
      if (S.pairFrom) return pre + 'Streets: click the kerb on the other side of that road.';
      return pre + (S.mode === 'sub'
        ? 'Streets: Click: remove the streets of a kerb line · Shift-click: just this street · Enter: create · Backspace: undo pick · Esc: leave'
        : 'Streets: Click: add a kerb line and its streets · Shift-click: just this piece · Alt-click: subtract · Ctrl-click: lone kerb · Enter: create · Backspace: undo pick · Esc: leave');
    }
    if (this.step === 1) return pre + 'Streets: draw each street centreline, or take them from the drawing in the panel.';
    if (this.step === 2) return pre + 'Mini-subs: click where each one stands. Click a mini-sub to move it, Alt-click to remove it.';
    if (this.step === 3) return pre + 'Rules: choose the preset and the settings in the panel.';
    if (!r) return pre + 'Review: run the layout to see the kiosks, cables and checks.';
    if (!r.kiosks.length) return pre + 'Review: no kiosks were found. Draw a centreline beside the erven, or extend the nearest street.';
    if (this.mode === 'marker') return pre + (this.markFor ? 'click on the erf where its service cable should arrive.' : 'click inside an erf where its service cable should arrive. Alt-click removes a marker.');
    if (this.mode === 'cross') return pre + 'Road crossings: drag a start or end to move it · drag the line to slide it along the street · Alt-click: put it back · drag empty space: pan';
    if (this.mode === 'move') return pre + 'Drag a kiosk, manhole, erf marker or node · Shift-click a line: add a node · Alt-click a node: remove it · drag empty space: pan';
    if (this.mode === 'trunk') return pre + 'click a trunk duct section to cut it or put it back; click a junction for the fibre entry.';
    return pre + 'Review: click a check to see it on the plan. Click an erf near an edge to make it the front.';
  },
  // the panel has a lot to show: a little wider while this tool is open (not on a phone)
  widen(on) { const el = document.getElementById('plan-props'); if (el && !(window.matchMedia && window.matchMedia('(max-width: 768px)').matches)) el.style.width = on ? '360px' : ''; },
  syncHint() { if (this._active && typeof PlanMarkup !== 'undefined' && PlanMarkup.onDraftChanged) { PlanMarkup._toolMsg = this.hint(); PlanMarkup.onDraftChanged(); } },

  streetsOnPlan() { return AppState.planMarkup.routes.filter(r => r.type === 'street' && r.points && r.points.length >= 2); },

  gather(allowNoSub) {
    const pm = AppState.planMarkup, f = PlanEngine.factor(), L = this.cfg();
    if (!f) return { err: 'Calibrate the plan first: the layout works in metres.' };
    const erven = pm.elements.filter(e => e.type === 'erf' && Array.isArray(e.boundary) && e.boundary.length >= 3)
      .map(e => ({ id: e.id, poly: e.boundary.map(p => [p.x * f, p.y * f]) }));
    const sr = this.streetsOnPlan();
    if (!sr.length) return { err: 'Draw the streets first: pick Street centreline in the Routes group and click along each street.' };
    if (!erven.length) return { err: 'No erf has a boundary yet. Run Detect erven first (it keeps each erf\'s boundary).' };
    const streets = sr.map((r, i) => ({ id: r.id, name: (r.props && r.props.name) || ('Street ' + (i + 1)), w: this._num(r.props && r.props.width, 6, 40, 12), pts: this._flat(r).map(p => [p.x * f, p.y * f]) }));
    const ks = {}, fs = {}, ga = L.sides['*'] || {}; streets.forEach(s => { const sd = L.sides[s.id] || {}, pk = v => v === 1 || v === -1 ? v : null; ks[s.id] = pk(sd.k) || pk(ga.k) || 0; fs[s.id] = pk(sd.f) || pk(ga.f); });   // a street's own side overrides the all-streets one
    const subPts = this.placedSubs().map(q => [q.x * f, q.y * f]);                    // every mini-sub you placed: the layout works from them
    if (!subPts.length && !allowNoSub) return { err: 'Place your mini-subs first (step 2): click where each one stands. The layout works from them.' };
    const markers = {}; for (const [id, q] of Object.entries(L.markers)) if (erven.some(e => e.id === id)) markers[id] = [q.x * f, q.y * f];
    const splits = L.vd.splits.map(q => [q.x * f, q.y * f]);
    const kioskDrops = L.moves.kiosks.map(m => [m.from.x * f, m.from.y * f]), kioskPins = L.moves.kiosks.map(m => [m.to.x * f, m.to.y * f]);   // kiosks moved by hand
    return { f, input: { erven, streets, markers, splits, kioskDrops, kioskPins, ks, fs, overrides: L.fronts, cuts: L.cuts, subPts, entryPt: L.entry ? [L.entry.x * f, L.entry.y * f] : null, sections: L.sections.on ? L.sections : null }, params: L.params };
  },

  // The figures shown beside Run layout: what the last run came to, and how many settings were changed since it
  _runFigures(r) { return { k: r.kiosks.length, x: r.stats.crossings, c: Math.round(r.stats.cable) }; },
  changedSinceRun() {
    if (!this._ranParams) return 0; let was; try { was = JSON.parse(this._ranParams); } catch (e) { return 0; }
    const now = this.cfg().params; return Object.keys(now).filter(k => JSON.stringify(now[k]) !== JSON.stringify(was[k])).length;
  },
  lastRunHtml() {
    const r = this.result; if (!r || !r.stats) return '';
    const f = this._runFigures(r), pv = this._prevRun, n = this.changedSinceRun(), fm = v => Math.round(v).toLocaleString('en');
    const d = (a, b, unit) => a === b ? '' : ` <span style="color:var(--text-muted)">(was ${fm(b)}${unit})</span>`;
    const chip = n ? `<span style="background:#fff1dc;color:#7a3e00;border-radius:4px;padding:2px 7px;font-size:12px;font-weight:600">${n} setting${n === 1 ? '' : 's'} changed since the last run</span>` : '';
    return `<div style="font-size:12px;line-height:1.45"><div>Last run: <b>${f.k}</b> kiosks${pv ? d(f.k, pv.k, '') : ''} · <b>${f.x}</b> crossings${pv ? d(f.x, pv.x, '') : ''} · <b>${fm(f.c)} m</b> of service cable${pv ? d(f.c, pv.c, ' m') : ''}</div>${chip}</div>`;
  },

  run() {
    if (!this.admdOk()) { this.err = 'Confirm the ADMD settings in Rules first: they set the load on every cable.'; PlanMarkup.refreshProps(); UI.toast(this.err, 'warn', 5000); return; }
    const g = this.gather();
    if (g.err) { this.err = g.err; this.result = null; PlanMarkup.refreshProps(); UI.toast(g.err, 'warn', 6000); return; }
    this.err = '';
    const t0 = performance.now();
    this._gathered = g; this._prevRun = this.result && this.result.stats ? this._runFigures(this.result) : null;
    this.result = PlanLayout.solve(g.input, g.params); this._ranParams = JSON.stringify(g.params);
    this.f = g.f; this.ms = performance.now() - t0; this.stale = false; this.flag = null; this.nearHint = null;
    this.applyMoves(this.result);                                                       // nodes moved, added or removed by hand
    PlanLayout.smooth(this.result, g.params);                                           // then every corner rounded (the node handles stay on the corners)
    this._findCross(this.result);
    this.result.trench = PlanLayout.trenches(this.result, this.cfg().trench);
    this.vdRun();
    PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true });
  },
  // trench depth / sharing changed: only the trenches are worked out again
  retrench() {
    if (!this.result) return;
    this.result.trench = PlanLayout.trenches(this.result, this.cfg().trench);
    PlanMarkup.markDirty(); PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true });
  },
  // after a setting changes: re-run at once when that is quick, otherwise wait for Run
  // `force`: a deliberate single edit (a mini-sub placed, moved or removed) re-runs whatever the last solve cost; a slider drag re-runs only while the solve is quick
  touched(force) {
    PlanMarkup.markDirty();
    if (this.result && (force || this.ms < 400)) this.run();
    else { this.stale = true; PlanMarkup.refreshProps(); }
  },

  // ───────── create the plan items ─────────
  async commit() {
    const r = this.result, f = this.f; if (!r) return;
    const fix = this.checks().filter(c => c.sev === 'fail');
    if (fix.length && !(await UI.confirm(`${fix.length} item${fix.length === 1 ? ' is' : 's are'} still marked Fix:\n\n${fix.slice(0, 3).map(c => '• ' + c.text).join('\n')}${fix.length > 3 ? '\n• …' : ''}\n\nCreate the layout anyway?`))) return;
    if (r !== this.result) return;
    const pm = AppState.planMarkup, opt = this._opt;
    const removeIf = (arr, fn) => { for (let i = arr.length - 1; i >= 0; i--) if (fn(arr[i])) arr.splice(i, 1); };
    const auto = x => x.auto === 'layout';
    const ptsPx = a => a.map(p => ({ x: p[0] / f, y: p[1] / f }));
    removeIf(pm.routes, auto); removeIf(pm.crossings, auto); removeIf(pm.elements, auto); removeIf(pm.trenches, auto);
    const el = (type, x, y, extra) => { const e = Object.assign({ id: AppState.planGenId('pmel'), type, x: x / f, y: y / f, rotation: 0, name: PlanMarkup.nextName(type), reticId: null, props: PLAN_DEFS.defaults(type), auto: 'layout' }, extra || {}); pm.elements.push(e); return e; };
    const route = (type, fromId, toId, pts, cable) => { const rt = { id: AppState.planGenId('pmrt'), type, fromId: fromId || null, toId: toId || null, points: ptsPx(pts), cableType: cable || this._vdCableName(type) || PLAN_DEFS.defaults(type).cableType || ((typeof PlanSync !== 'undefined' && PlanSync.defaultCableFor(type, fromId, toId)) || ''), curved: false, props: {}, auto: 'layout' }; pm.routes.push(rt); return rt; };
    const made = { subs: 0, kiosks: 0, manholes: 0, routes: 0, crossings: 0, markers: 0, trenches: 0 };
    const erfEl = new Map(pm.elements.filter(e => e.type === 'erf').map(e => [e.id, e]));
    // erf markers: the erf point moves to its corner
    if (opt.markers) r.erven.forEach(e => { const el0 = erfEl.get(e.id); if (el0 && e.marker) { el0.x = e.marker[0] / f; el0.y = e.marker[1] / f; made.markers++; } });
    const kEl = new Map();
    const lvCab = this._designCables(r), way = this.cfg().vd.way80 ? 'cb:mccb_80a' : '';                  // the tapered cable of each feeder, the 80 A way on every erf
    if (opt.kiosks) r.kiosks.forEach(k => { const pr = r.prot && r.prot[k.id], extra = Object.assign({}, pr ? { protection: pr } : {}, way ? { outgoingProtection: way } : {}); kEl.set(k, el('kiosk', k.x, k.y, Object.keys(extra).length ? { props: Object.assign(PLAN_DEFS.defaults('kiosk'), extra) } : null)); made.kiosks++; });
    if (opt.kiosks) r.erven.forEach(e => { if (e.kiosk && e.route && kEl.get(e.kiosk) && erfEl.get(e.id)) { const pts = e.route.slice(); if (!opt.markers) pts.push([erfEl.get(e.id).x * f, erfEl.get(e.id).y * f]); route('service', kEl.get(e.kiosk).id, e.id, pts); made.routes++; } });
    const subEls = new Map();
    if (opt.lv && r.net.subs) {
      // a mini-sub part you drew yourself is kept (for the one placed there); the others are made where they stand
      const own = pm.elements.filter(e => e.type === 'minisub' && !auto(e)), tx = this.cfg().vd.tx;
      r.net.subs.forEach(Sb => {
        const k0 = Sb.k, ex = own.find(e => Math.hypot(e.x * f - k0.x, e.y * f - k0.y) < 1.5);
        const se = ex || el('minisub', k0.x, k0.y, tx ? { props: Object.assign(PLAN_DEFS.defaults('minisub'), { txTypeId: tx }) } : null);
        subEls.set(Sb, se); made.subs++;
      });
      r.net.lvLinks.forEach(l => {
        if (!kEl.get(l.to)) return;
        const Sb = r.net.subs.find(x => x.k === l.from), se = Sb && subEls.get(Sb);          // a string head: its own feeder from the mini-sub
        const lc = (lvCab.get(l.to.id) || {}).name;
        if (se) route('lv', se.id, kEl.get(l.to).id, [[se.x * f, se.y * f], ...l.pts.slice(1)], lc);
        else if (kEl.get(l.from)) route('lv', kEl.get(l.from).id, kEl.get(l.to).id, l.pts, lc);
        else return;
        made.routes++;
      });
    }
    if (opt.fibre) {
      const mEl = new Map();
      [...r.fibre.inter, ...r.fibre.mhs].forEach(m => { mEl.set(m, el('manhole', m.x, m.y)); made.manholes++; });
      r.fibre.trunks.forEach(t => { route('fibreBB', mEl.get(t.a).id, mEl.get(t.b).id, t.pts); made.routes++; });
      r.erven.forEach(e => { if (e.duct && e.mh && mEl.get(e.mh) && erfEl.get(e.id)) { const pts = e.duct.slice(); if (!opt.markers) pts.push([erfEl.get(e.id).x * f, erfEl.get(e.id).y * f]); route('fibreErf', mEl.get(e.mh).id, e.id, pts); made.routes++; } });
    }
    if (opt.cross) r.net.cross.forEach((x, xi) => {
      const uses = [], push = (n, w) => { for (let i = 0; i < n; i++) uses.push(w); };
      if (x.prov) { push(x.d110, 'junction'); } else { push(x.d110s, 'service'); push(x.d110f, 'fibre'); push(x.d110l, 'LV'); push(x.spare, 'spare'); }
      const sizes = uses.map(u => ['110', u]); for (let i = 0; i < x.d160; i++) sizes.push(['160', x.prov ? 'junction' : 'MV']);
      sizes.forEach(([size, use], i) => {
        const off = (i - (sizes.length - 1) / 2) * 0.6, a = PlanLayout.ptAt(x.st, x.s + off, x.st.w / 2), b = PlanLayout.ptAt(x.st, x.s + off, -x.st.w / 2);
        pm.crossings.push({ id: AppState.planGenId('pmcr'), name: PlanMarkup.nextCounter('_crossing', 'RC'), size, use, trench: 'X' + (xi + 1), p1: { x: a[0] / f, y: a[1] / f }, p2: { x: b[0] / f, y: b[1] / f }, auto: 'layout' }); made.crossings++;
      });
    });
    if (opt.trench && r.trench) r.trench.list.forEach(t => {
      pm.trenches.push({ id: AppState.planGenId('pmtr'), name: PlanMarkup.nextCounter('_trench', 'T'), excType: t.type, points: ptsPx(t.pts), widthOverride: null, depthOverride: t.depth, auto: 'layout' }); made.trenches++;
    });
    PlanMarkup.snapshot(); PlanMarkup.markDirty();
    PlanEngine.requestDraw({ fg: true });
    const st = AppState.planMarkup.settings;
    const crowded = made.routes > 40 && (!st.routeLabels || st.routeLabels === 'all');
    if (crowded) st.routeLabels = 'selected';
    UI.toast(`Created ${made.kiosks} kiosk(s), ${made.subs} mini-sub(s), ${made.manholes} manhole(s), ${made.routes} route(s), ${made.crossings} crossing duct(s) and ${made.trenches} trench(es); moved ${made.markers} erf marker(s).${crowded ? ' Route length labels now show for the selected route only (Layers › Route length labels).' : ''}`, 'success', 8000);
    this.result = null; this.stale = true; PlanMarkup.refreshProps();
  },
  _opt: { markers: true, kiosks: true, lv: true, fibre: true, cross: true, trench: true },
  clear() { this.result = null; this.stale = true; PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true }); },

  // ───────── an erf no street reaches: show the nearest street and extend it ─────────
  nearHint: null,
  // draw the nearest street and the proposed run on the plan, and zoom to them
  nearShow(eid) {
    const r = this.result, f = this.f, e = r && r.erven.find(x => x.id === eid); if (!e) return;
    const g = PlanLayout.reach(e.poly, r.streets, { erven: r.erven });
    if (!g) { UI.toast('There is no street on the plan to extend.', 'warn', 3500); return; }
    this.nearHint = { erf: eid, g }; this.flag = new Set([eid]);
    const pts = e.poly.map(q => ({ x: q[0] / f, y: q[1] / f })).concat([{ x: g.q[0] / f, y: g.q[1] / f }, { x: g.t[0] / f, y: g.t[1] / f }]);
    PlanEngine.zoomToPoints(pts);
    PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true });
  },
  // Run each of these erven's nearest street on to it (the street's own end, or a spur from its middle), one change to the
  // plan. Later erven see the earlier extensions. Returns how many were fixed.
  extendErven(ids) {
    const r = this.result, f = this.f, pm = AppState.planMarkup; if (!r || !ids.length) return 0;
    const work = r.streets.map(s => ({ id: s.id, name: s.name, w: s.w, pts: s.pts.map(q => q.slice()) }));
    let ext = 0, spurs = 0, skipped = 0, through = 0, snap = false;
    for (const id of ids) {
      const e = r.erven.find(x => x.id === id), g = e && PlanLayout.reach(e.poly, work, { erven: r.erven });
      const route = g && !g.near && pm.routes.find(x => x.id === g.street.id);
      if (!route) { skipped++; continue; }
      if (!snap) { PlanMarkup.snapshot(); snap = true; }
      const T = { x: g.t[0] / f, y: g.t[1] / f }, w = work.find(x => x.id === route.id);
      if (g.atEnd && !route.curved) {                                                     // the street's own end runs on
        if (g.atEnd === 'end') { route.points.push(T); w.pts.push(g.t.slice()); } else { route.points.unshift(T); w.pts.unshift(g.t.slice()); }
        ext++;
      } else {                                                                            // a spur from the street, same width
        const nm = String(g.street.name).replace(/ spur$/, '') + ' spur';
        const nr = { id: AppState.planGenId('pmrt'), type: 'street', fromId: null, toId: null, points: [{ x: g.q[0] / f, y: g.q[1] / f }, T], cableType: '', curved: false, props: { name: nm, width: g.street.w } };
        pm.routes.push(nr); work.push({ id: nr.id, name: nm, w: g.street.w, pts: [g.q.slice(), g.t.slice()] }); spurs++;
      }
      if (g.crosses) through++;
    }
    if (!snap) { UI.toast('Nothing to extend: those erven are already within reach of a street or there is none.', 'warn', 4000); return 0; }
    this.nearHint = null; this.flag = null;
    PlanMarkup.markDirty(); this.touched();
    const n = ext + spurs;
    UI.toast(`${n} ${n === 1 ? 'erf' : 'erven'} given a street: ${ext} street${ext === 1 ? '' : 's'} extended, ${spurs} spur${spurs === 1 ? '' : 's'} added${skipped ? `; ${skipped} left (already in reach, or no street)` : ''}${through ? `. ${through} run${through === 1 ? '' : 's'} pass through other erven: check the plan` : ''}. Press Run if the checks do not update.`, through || skipped ? 'warn' : 'success', 8000);
    return n;
  },

  // the next click puts this erf's service marker (the Checks row's "place marker")
  markFor: null,
  markStart(eid) {
    const r = this.result, f = this.f, e = r && r.erven.find(x => x.id === eid); if (!e) return;
    this.mode = 'marker'; this.markFor = eid; this.flag = new Set([eid]);
    const name = (AppState.planMarkup.elements.find(q => q.id === eid) || {}).name || eid;
    PlanEngine.zoomToPoints(e.poly.map(q => ({ x: q[0] / f, y: q[1] / f })));
    UI.toast(`Click on erf ${name} where its service cable should arrive. Esc leaves.`, 'info', 6000);
    PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true });
  },

  // ───────── the tool's clicks ─────────
  click(pt, ev) {
    if (this.mode === 'sub') { this.subClick(pt, ev); return; }
    if (this.mode === 'move') { this.moveDown(pt, ev); return; }
    if (this.mode === 'cross') { this.crossDown(pt, ev); return; }
    const r = this.result, f = this.f; if (!r) { UI.toast('Run the layout first.', 'info', 3000); return; }
    const L = this.cfg(), m = [pt.x * f, pt.y * f];
    const pip = (x, y, p) => { let c = false; for (let i = 0, j = p.length - 1; i < p.length; j = i++) { const a = p[i], b = p[j]; if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
    if (this.mode === 'marker') {                                                      // the service point of an erf the classifier cannot place
      const near = (q, poly) => { let b = Infinity; for (let i = 0; i < poly.length; i++) { const a = poly[i], c = poly[(i + 1) % poly.length], dx = c[0] - a[0], dy = c[1] - a[1], L2 = dx * dx + dy * dy, k = L2 ? Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / L2)) : 0; b = Math.min(b, Math.hypot(q[0] - a[0] - dx * k, q[1] - a[1] - dy * k)); } return b; };
      const under = r.erven.find(x => x.box[0] <= m[0] && m[0] <= x.box[2] && x.box[1] <= m[1] && m[1] <= x.box[3] && pip(m[0], m[1], x.poly));
      const target = this.markFor ? r.erven.find(x => x.id === this.markFor) : under, nm = x => (AppState.planMarkup.elements.find(q => q.id === x.id) || {}).name || x.id;
      if (ev && ev.altKey) { const x = under || target; if (x && L.markers[x.id]) { delete L.markers[x.id]; this.markFor = null; this.touched(); } else UI.toast('No hand-placed marker on that erf.', 'info', 2500); return; }
      if (!target) { UI.toast('Click inside the erf whose marker you want to place.', 'warn', 3500); return; }
      if (!pip(m[0], m[1], target.poly) && near(m, target.poly) > 5) { UI.toast(`Click on erf ${nm(target)} (or just beside it).`, 'warn', 3500); return; }
      L.markers[target.id] = { x: pt.x, y: pt.y }; this.markFor = null; this.touched();
      UI.toast(`Marker placed on erf ${nm(target)}: its service cable now runs to it from the nearest street.`, 'success', 3500);
      return;
    }
    if (this.mode === 'trunk') {
      const h = this._pickT(m); if (!h) return;
      if (h.node) { L.entry = { x: h.node.x / f, y: h.node.y / f }; }
      else { const i = L.cuts.indexOf(h.edge.key); if (i >= 0) L.cuts.splice(i, 1); else L.cuts.push(h.edge.key); }
      this.touched(); return;
    }
    const e = r.erven.find(q => q.box[0] <= m[0] && m[0] <= q.box[2] && q.box[1] <= m[1] && m[1] <= q.box[3] && pip(m[0], m[1], q.poly));
    if (!e) return;
    let best = null, bd = 1e9;
    for (const d of e.edges) { const dx = d.b[0] - d.a[0], dy = d.b[1] - d.a[1], t = Math.max(0, Math.min(1, ((m[0] - d.a[0]) * dx + (m[1] - d.a[1]) * dy) / (dx * dx + dy * dy))), dist = Math.hypot(d.a[0] + t * dx - m[0], d.a[1] + t * dy - m[1]); if (dist < bd) { bd = dist; best = d; } }
    if (!best.road) { UI.toast('That edge does not face a street.', 'warn', 3000); return; }
    const auto = e.edges.filter(d => d.road).sort((p, q) => (r.P.front === 'longest' ? q.len - p.len : p.len - q.len) || p.i - q.i)[0];
    if (L.fronts[e.id] === best.i || (auto && auto.i === best.i)) delete L.fronts[e.id]; else L.fronts[e.id] = best.i;
    this.touched();
  },
  _pickT(m) {
    const F = this.result && this.result.fibre; if (!F) return null;
    const tol = 9 * this.f / PlanEngine.view.zoom;
    let node = null, nd = tol;
    for (const n of F.nodes) { const d = Math.hypot(n.x - m[0], n.y - m[1]); if (d < nd) { nd = d; node = n; } }
    if (node) return { node };
    let edge = null, ed = tol * .8;
    for (const e of F.trunks.concat(F.spare)) for (let i = 1; i < e.pts.length; i++) {
      const a = e.pts[i - 1], b = e.pts[i], dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((m[0] - a[0]) * dx + (m[1] - a[1]) * dy) / ((dx * dx + dy * dy) || 1)));
      const d = Math.hypot(a[0] + t * dx - m[0], a[1] + t * dy - m[1]); if (d < ed) { ed = d; edge = e; }
    }
    return edge ? { edge } : null;
  },

  // ───────── the preview on the plan ─────────
  // ── the check list after a run ──
  // → [{ sev: 'fail' | 'warn' | 'info', text, ids: [erf ids to mark] }], worst first; [] = nothing to flag.
  checks() {
    const r = this.result; if (!r) return [];
    const P = r.P, out = [], nm = (list) => list.slice(0, 6).map(e => e.name || e.id).join(', ') + (list.length > 6 ? '…' : '');
    const names = {}; AppState.planMarkup.elements.forEach(e => { if (e.type === 'erf') names[e.id] = e.name; });
    const lab = (e) => Object.assign({}, e, { name: names[e.id] || e.id });
    const over = r.erven.filter(e => e.fe && e.cable > P.maxc + 1e-6);
    if (over.length) out.push({ sev: 'fail', text: `${over.length} erven are further than ${P.maxc} m of service cable from their kiosk (longest ${Math.round(Math.max(...over.map(e => e.cable)))} m): ${nm(over.map(lab))}.`, ids: over.map(e => e.id) });
    const nf = r.erven.filter(e => !e.fe);
    if (nf.length) {
      const rows = nf.map(e => ({ id: e.id, name: names[e.id] || e.id, g: PlanLayout.reach(e.poly, r.streets, { erven: r.erven }) }));
      out.push({ sev: 'fail', text: `${nf.length} erven do not face a street and get no kiosk, service or fibre: ${nm(nf.map(lab))}. Extend the nearest street to them, or place their markers yourself and the cable and kiosk are worked out from there.`, ids: nf.map(e => e.id), rows,
        acts: rows.filter(x => x.g && !x.g.near).length > 1 ? [{ label: 'Extend the nearest streets to all of them', act: 'extendall', val: rows.filter(x => x.g && !x.g.near).map(x => x.id) }] : [] });
    }
    if (r.net.unreached && r.net.unreached.length) out.push({ sev: 'fail', text: `The LV network does not reach ${r.net.unreached.length} ${r.net.unreached.length === 1 ? 'kiosk' : 'kiosks'} (${r.net.unreached.map(k => k.id).join(', ')}): ${(r.net.parts || 2) > 1 ? 'the streets between them are not joined up (' + r.net.parts + ' separate street networks).' : 'the streets are joined, so this is a layout fault: run the layout again and report it if it stays.'} Their erven have no LV supply, and the voltage-drop and earth-fault results leave them out. ${(r.net.parts || 2) > 1 ? 'Join the streets (Streets from kerb layer › Join networks) or add the missing street.' : ''}`, ids: r.net.unreached.flatMap(k => k.members.map(e => e.id)) });
    if (P.strL > 0 && r.net.strLens) {
      const longS = r.net.strLens.filter(x => x.len > P.strL + 1e-6).sort((a, b) => b.len - a.len);
      if (longS.length) out.push({ sev: 'fail', text: `${longS.length} LV ${longS.length === 1 ? 'string is' : 'strings are'} longer than ${P.strL} m from the mini-sub to the furthest kiosk (${longS.slice(0, 5).map(x => x.far.id + ': ' + Math.round(x.len) + ' m').join(', ')}${longS.length > 5 ? ', …' : ''}). Cutting a string does not shorten it: add a mini-sub nearer the far end, or move the mini-sub.`, ids: longS.flatMap(x => x.kiosks.flatMap(k => k.members.map(e => e.id))), acts: [{ label: 'Place another mini-sub', act: 'addsub' }] });
    }
    const hand = r.erven.filter(e => e.manual);
    if (hand.length) out.push({ sev: 'info', text: `${hand.length} ${hand.length === 1 ? 'erf uses' : 'erven use'} a marker you placed (${nm(hand.map(lab))}). The service cable, kiosk and fibre duct are worked out to it.`, ids: hand.map(e => e.id), acts: [{ label: 'Remove my markers', act: 'resetmarkers' }] });
    const unserved = r.erven.filter(e => e.fe && !e.kiosk);
    if (unserved.length) out.push({ sev: 'fail', text: `${unserved.length} erven have no kiosk: ${nm(unserved.map(lab))}.`, ids: unserved.map(e => e.id) });
    const crowd = r.kiosks.filter(k => k.members.length > P.n);
    if (crowd.length) out.push({ sev: 'fail', text: `${crowd.length} kiosks serve more than ${P.n} erven (${crowd.map(k => k.id + ': ' + k.members.length).join(', ')}).`, ids: crowd.flatMap(k => k.members.map(e => e.id)) });
    const noBoundary = AppState.planMarkup.elements.filter(e => e.type === 'erf' && !(Array.isArray(e.boundary) && e.boundary.length >= 3));
    if (noBoundary.length) out.push({ sev: 'warn', text: `${noBoundary.length} erven on the plan have no boundary, so the layout ignores them (${nm(noBoundary)}). Detect them with Detect erven.`, ids: noBoundary.map(e => e.id) });
    const vd = r.vd, canAdd = (this.cfg().subs || []).length < 20, addSub = canAdd ? [{ label: 'Place another mini-sub', act: 'addsub' }] : [];
    if (r.vdBusy) { /* the engine is still answering */ }
    else if (vd && vd.err) out.push({ sev: 'warn', text: 'Voltage drop and mini-sub loading not checked: ' + vd.err + ' Create will leave the LV and service cables at their defaults.', ids: [] });
    else if (vd) {
      const w = vd.worst, V = vd.V, nmE = id => names[id] || id;
      if (this._vdStale()) out.push({ sev: 'warn', text: "Demand's settings (load class, ADMD or the voltage-drop limits) changed after this check. Run again to check against them.", ids: [] });
      const parts = [];
      if (vd.over.length) parts.push(`${vd.over.length} erven over Demand's limits (LV feeder ${V.limF}%, service ${V.limS}%), the worst erf ${nmE(w.erf.id)} at ${w.total.toFixed(1)}% (${w.lv.toFixed(1)}% along the LV feeder to ${w.kiosk.id} + ${w.svc.toFixed(1)}% on its ${Math.round(w.erf.cable)} m service)`);
      if (vd.hotLegs.length) { const h = vd.hotLegs.slice().sort((p, q) => q.amps - p.amps)[0]; parts.push(`${vd.hotLegs.length} LV legs carry more than the ${V.lv.name} rating (${h.to.id}: ${Math.round(h.amps)} A on ${Math.round(V.lv.rating)} A)`); }
      if (vd.hotSvc.length) parts.push(`${vd.hotSvc.length} services carry more than the ${V.svc.name} rating (${Math.round(V.svc.rating)} A)`);
      const badIds = [...new Set([...vd.over.map(x => x.erf.id), ...vd.hotLegs.flatMap(l => l.to.members.map(e => e.id)), ...vd.hotSvc.map(x => x.erf.id)])];
      if (vd.unmet) out.push({ sev: 'fail', text: `Even the largest LV feeder (${V.lv.name}) does not meet Demand's limits: ${parts.join('; ')}. One mini-sub feeds too much LV network: ${canAdd ? 'place another mini-sub' : 'split the site by hand'}, or raise the limits in Demand. Create leaves the LV cable at its default.`, ids: badIds, acts: addSub });
      else {
        if (vd.autoFrom) out.push({ sev: 'info', text: `LV feeder sized to ${V.lv.name} to meet Demand's limits (${vd.autoFrom.name} would give ${vd.autoFrom.max.toFixed(1)}% or overload a leg).`, ids: [] });
        if (parts.length) out.push({ sev: 'fail', text: parts.join('; ') + '. Pick a bigger cable (or Automatic), add a kiosk, or raise the limits in Demand.', ids: badIds, acts: addSub });
      }
      if (w && !parts.length && (vd.maxLv > 0.9 * V.limF || vd.maxSvc > 0.9 * V.limS)) out.push({ sev: 'warn', text: `Close to the limits: LV feeder ${vd.maxLv.toFixed(1)}% of ${V.limF}%, service ${vd.maxSvc.toFixed(1)}% of ${V.limS}% (worst erf ${nmE(w.erf.id)}).`, ids: [w.erf.id] });
      if (vd.unreached.length) out.push({ sev: 'fail', text: `${vd.unreached.length} erven sit on a kiosk the LV network does not reach, so their voltage drop is not checked.`, ids: vd.unreached.map(e => e.id) });
      // each mini-sub against its transformer
      (vd.subs || []).forEach((t, i) => {
        const S = r.net.subs[i], ids = S ? r.kiosks.filter(k => k.subK === S.k).flatMap(k => k.members.map(e => e.id)) : [];
        if (!t.over) return;
        const acts = [...(t.picked && t.next ? [{ label: `Use ${t.next.name}`, act: 'tx', val: t.next.id }] : []), ...addSub];
        out.push({ sev: 'fail', text: t.picked
          ? `${t.name} carries ${Math.round(t.kva)} kVA, more than its ${Math.round(t.tx.kva)} kVA transformer. Choose a ${t.next ? 'larger size (' + Math.round(t.next.kva) + ' kVA)' : 'larger size (none in the library is big enough)'} or add a mini-sub to share the load.`
          : `${t.name} carries ${Math.round(t.kva)} kVA, more than the largest transformer in the library (${Math.round(t.tx.kva)} kVA). Place another mini-sub to share the load.`, ids, acts });
      });
      const ok = (vd.subs || []).filter(t => t.tx && !t.over);
      if (ok.length) out.push({ sev: ok.some(t => t.tx.util > 90) ? 'warn' : 'info', text: 'Transformer loading: ' + ok.map(t => `${t.name} ${Math.round(t.kva)} kVA on ${Math.round(t.tx.kva)} kVA (${t.tx.util}%${t.picked ? '' : ', automatic'})`).join('; ') + '.', ids: [] });
      if (r.earthErr) out.push({ sev: 'warn', text: 'Earth-fault loop not checked: ' + r.earthErr + ' Create leaves the strings without a breaker.', ids: [] });
      else if (r.earth) {
        const E = r.earth, fails = this._earthFails(E), kiosksById = new Map(r.kiosks.map(k => [k.id, k]));
        if (r.earthUp) out.push({ sev: 'info', text: `LV feeder raised from ${r.earthUp.from} to ${r.earthUp.to} so the earth-fault loop passes.`, ids: [] });
        if (fails.length) {
          const worstItem = fails.slice().sort((p, q) => ((q.item.loop || {}).zsOhm || 0) - ((p.item.loop || {}).zsOhm || 0))[0];
          const wl = worstItem.item.loop || {}, we = worstItem.item.ecc || {};
          const why = (wl.status === 'fail' ? (wl.note || 'the loop is too high to trip in time') : (we.note || 'the earth conductor is too small')).split('\n')[0];
          const ids = [...new Set(fails.flatMap(x => x.erf ? [x.erf] : ((kiosksById.get(x.kiosk) || { members: [] }).members.map(e => e.id))))];
          out.push({ sev: 'fail', text: `${fails.length} earth-fault checks fail (disconnection in 5 s and earth conductor size, Demand's own check): ${fails.filter(x => x.erf).length} services, ${fails.filter(x => !x.erf).length} LV feeders. Worst: ${worstItem.erf ? 'erf ' + (names[worstItem.erf] || worstItem.erf) : worstItem.kiosk}${wl.zsOhm != null ? ', Zs ' + wl.zsOhm + ' Ω' : ''}: ${why} Shorten the service, use a larger LV feeder or a smaller string breaker.`, ids, acts: addSub });
        }
        const noDev = Object.keys(r.prot || {}).length < ((r.net && r.net.subs) || []).length;
        if (!fails.length && noDev) out.push({ sev: 'warn', text: 'No standard breaker is big enough for a string, so its earth-fault loop is not judged. Split the load with another mini-sub.', ids: [] });
        else if (!fails.length && r.net.unreached && r.net.unreached.length) out.push({ sev: 'warn', text: `Earth-fault loop and earth conductor: no check failed, but ${r.net.unreached.reduce((a, k) => a + k.members.length, 0)} erven on ${r.net.unreached.length} kiosks the LV network does not reach were not checked. This is not a pass for the whole layout.`, ids: r.net.unreached.flatMap(k => k.members.map(e => e.id)) });
        else if (!fails.length) out.push({ sev: 'info', text: `Earth-fault loop and earth conductor: ${E.counts ? E.counts.pass : 0} checks pass, none fail (Demand's own check, 5 s disconnection).`, ids: [] });
      }
      { const cc = this.vdCables(); if (cc.svcAuto && cc.svc) out.push({ sev: 'info', text: `The service cable was not picked, so every check uses the default: ${cc.svc.name}${cc.svc.size_mm2 === 16 && cc.svc.conductor === 'Cu' ? ' (a 16 mm² copper stand-in for the real service cable)' : ''}. Pick the cable you will install under Rules › LV design, and the voltage drop and earth-fault results follow it.`, ids: [] }); }
      out.push({ sev: 'info', text: 'Cable ratings and voltage drop are checked here; fault withstand of the cables is checked in Demand.', ids: [] });
    }
    const D = r.design || r.designIssue, fixAct = x => x.action === 'split' ? { label: x.text, act: 'split', val: x.kiosk } : x.action === 'maxSize' ? { label: x.text, act: 'maxsize', val: x.size } : x.action === 'clearSize' ? { label: x.text, act: 'clearsize' } : { label: 'Place another mini-sub', act: 'addsub' };
    if (D && !D.ok) D.reasons.forEach(rs => out.push({ sev: 'fail', text: rs.text.replace(/Add a mini-sub/g, 'Place another mini-sub').replace(/add a mini-sub/g, 'place another mini-sub'), ids: r.kiosks.filter(k => rs.kiosks.includes(k.id)).flatMap(k => k.members.map(e => e.id)), acts: rs.fixes.map(fixAct) }));
    if (D && D.ok && D.limits && D.limits.minAddsPct > 0) out.push({ sev: 'info', text: `The smallest LV cable allowed (${D.limits.minMm2} mm²) adds ${D.limits.minAddsPct}% cable (size × length) over the design with no minimum.`, ids: [], acts: [{ label: 'Remove the size limits', act: 'clearsize' }] });
    if (D) D.heads.filter(h => h.noCurrent && !h.pinned).forEach(h => out.push({ sev: 'fail', text: `String ${h.name} has no current from Demand, so no breaker was chosen for it (none is guessed). Run Demand, or pick the string breaker yourself.`, ids: [] }));
    else if (D && D.taper.on && D.taper.count > 1) out.push({ sev: 'info', text: `LV cable: ${D.taper.count} sizes, ${D.taper.minMm2} to ${D.taper.maxMm2} mm² ${D.conductor}, taper saves ${D.taper.savedPct}% (cable size × length) against ${D.uniform.sizeMm2} mm² throughout. ${this.cfg().vd.way80 ? 'Every erf way is an 80 A MCCB; ' : ''}each string head has the breaker with the fewest earth-fault fails.`, ids: [] });
    const near = r.erven.filter(e => e.fe && e.kiosk && e.cable > 0.85 * P.maxc && e.cable <= P.maxc + 1e-6);
    if (near.length) out.push({ sev: 'warn', text: `${near.length} ${near.length === 1 ? 'service is' : 'services are'} within 15% of the ${P.maxc} m limit: ${nm(near.map(lab))}.`, ids: near.map(e => e.id) });
    const onRoad = new Map(); r.erven.forEach(e => { if (e.road) onRoad.set(e.road, (onRoad.get(e.road) || 0) + 1); });
    const thin = P.n >= 4 ? r.kiosks.filter(k => k.members.length <= 2 && (onRoad.get(k.road) || 0) > 2) : [];          // a street of 2 erven needs its own
    if (thin.length) out.push({ sev: thin.length > 1 ? 'warn' : 'info', text: `${thin.length} of ${r.kiosks.length} kiosks ${thin.length === 1 ? 'serves' : 'serve'} 2 erven or fewer (${thin.map(k => k.id).join(', ')}). Fine on a short street; otherwise raise the worth of a kiosk (more extra cable accepted to save one) or lower the maximum houses per kiosk.`, ids: thin.flatMap(k => k.members.map(e => e.id)) });
    const mhw = (r.fibre && r.fibre.warns) || [];
    mhw.forEach(w => out.push({ sev: 'warn', text: w, ids: [] }));
    (r.secChecks || []).forEach(c => out.push({ sev: c.sev === 'info' ? 'info' : 'warn', text: c.text, ids: [] }));
    return out;
  },

  draw(ctx, zoom) {
    this.kerbDraw(ctx, zoom);
    if (typeof PlanReserveUI !== 'undefined') PlanReserveUI.draw(ctx, zoom);
    this.centreDraw(ctx, zoom);
    this.secDrawOverlay(ctx, zoom);
    if (!this.result) {                                                                  // before a run: where the mini-subs stand
      const u0 = 1 / zoom;
      this.placedSubs().forEach(q => { ctx.save(); ctx.fillStyle = '#c92a2a'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.6 * u0; ctx.beginPath(); ctx.moveTo(q.x, q.y - 9 * u0); ctx.lineTo(q.x + 8 * u0, q.y + 6 * u0); ctx.lineTo(q.x - 8 * u0, q.y + 6 * u0); ctx.closePath(); ctx.stroke(); ctx.fill(); if (q.src === 'layout' && this.subMove === q.i) { ctx.strokeStyle = '#2563eb'; ctx.lineWidth = 2.2 * u0; ctx.beginPath(); ctx.arc(q.x, q.y, 14 * u0, 0, 6.2832); ctx.stroke(); } ctx.restore(); });
    }
    const r = this.result, f = this.f; if (!r) return;
    const u = 1 / zoom, W = p => [p[0] / f, p[1] / f], line = pts => { ctx.beginPath(); pts.forEach((p, i) => { const q = W(p); i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); }); ctx.stroke(); };
    const col = k => this.PAL[(parseInt(k.id.slice(1)) - 1) % 8], S = this.SHOW;
    ctx.save(); ctx.lineJoin = 'round'; ctx.lineCap = 'butt';
    if (S.trench && r.trench) {                                                                        // trench bands under everything else
      ctx.lineCap = 'round';
      for (const t of r.trench.list) { const d = PLAN_DEFS.trenchTypes[t.type] || { color: 'rgba(120,120,120,.4)', width: 0.5 }; ctx.strokeStyle = d.color; ctx.lineWidth = Math.max(d.width / f, 1.5 * u); line(t.pts); }
      ctx.lineCap = 'butt';
    }
    ctx.strokeStyle = 'rgba(71,85,105,.6)'; ctx.lineWidth = 1 * u;                                   // the erf boundaries the layout read
    r.erven.forEach(e => { ctx.beginPath(); e.poly.forEach((p, i) => { const q = W(p); i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); }); ctx.closePath(); ctx.stroke(); });
    if (this.nearHint) {                                                                               // the nearest street and the run proposed for one erf
      const h = this.nearHint, st = r.streets.find(x => x.id === h.g.street.id), g = h.g; ctx.save(); ctx.lineCap = 'round';
      if (st) { ctx.strokeStyle = 'rgba(245,158,11,.35)'; ctx.lineWidth = Math.max(st.w / f, 6 * u); line(st.pts); }
      if (!g.near) { ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 3 * u; ctx.setLineDash([6 * u, 4 * u]); line([g.q, g.t]); ctx.setLineDash([]); ctx.fillStyle = '#f59e0b'; for (const q of [g.q, g.t]) { ctx.beginPath(); ctx.arc(q[0] / f, q[1] / f, 4 * u, 0, 6.2832); ctx.fill(); } }
      ctx.restore();
    }
    if (this.flag && this.flag.size) {                                                                 // erven picked from the check list
      ctx.save(); ctx.strokeStyle = '#dc2626'; ctx.fillStyle = 'rgba(220,38,38,.22)'; ctx.lineWidth = 3 * u;
      r.erven.forEach(e => { if (!this.flag.has(e.id)) return; ctx.beginPath(); e.poly.forEach((p, i) => { const q = W(p); i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); }); ctx.closePath(); ctx.fill(); ctx.stroke(); });
      ctx.restore();
    }
    if (S.fibre) {
      ctx.strokeStyle = '#a21caf'; ctx.lineWidth = 1.1 * u; ctx.setLineDash([2 * u, 3 * u]);
      r.erven.forEach(e => { if (e.duct) line(e.duct); });
      ctx.setLineDash([]);
      r.fibre.spare.forEach(e => { const cut = this.cfg().cuts.includes(e.key); ctx.strokeStyle = cut ? '#dc2626' : '#94a3b8'; ctx.lineWidth = 1.4 * u; ctx.setLineDash(cut ? [3 * u, 4 * u] : [1.5 * u, 4 * u]); line(e.pts); });
      ctx.setLineDash([]); ctx.strokeStyle = '#a21caf'; ctx.lineWidth = 2.6 * u; r.fibre.trunks.forEach(e => line(e.pts));
      ctx.fillStyle = '#a21caf'; r.erven.forEach(e => { if (e.fibrePt && e.duct) { const [x, y] = W(e.fibrePt), s = 3 * u; ctx.beginPath(); ctx.moveTo(x, y - s); ctx.lineTo(x + s, y); ctx.lineTo(x, y + s); ctx.lineTo(x - s, y); ctx.closePath(); ctx.fill(); } });
    }
    if (S.lvmv && r.net) {
      ctx.setLineDash([6 * u, 3 * u]); ctx.strokeStyle = '#b45309'; ctx.lineWidth = 1.8 * u; r.net.lv.forEach(ed => line(ed.pts));
    }
    if (S.kiosk) { ctx.lineWidth = 1.1 * u; r.erven.forEach(e => { if (!e.route) return; ctx.strokeStyle = col(e.kiosk); ctx.globalAlpha = .75; line(e.route); }); ctx.globalAlpha = 1; }
    if (S.front) r.erven.forEach(e => { if (!e.fe) return; ctx.strokeStyle = e.overridden ? '#ea580c' : '#0f8f78'; ctx.lineWidth = (e.overridden ? 3.5 : 2.6) * u; const d = e.fe; ctx.beginPath(); const a = W([d.a[0] + d.inn[0] * .6, d.a[1] + d.inn[1] * .6]), b = W([d.b[0] + d.inn[0] * .6, d.b[1] + d.inn[1] * .6]); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); });
    if (S.mark) r.erven.forEach(e => {
      if (!e.marker) return; const [x, y] = W(e.marker), s = 3.4 * u, cc = e.kiosk ? col(e.kiosk) : '#64748b';
      ctx.lineWidth = 3 * u; ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.beginPath(); ctx.moveTo(x - s, y - s); ctx.lineTo(x + s, y + s); ctx.moveTo(x - s, y + s); ctx.lineTo(x + s, y - s); ctx.stroke();
      ctx.lineWidth = 1.7 * u; ctx.strokeStyle = cc; ctx.beginPath(); ctx.moveTo(x - s, y - s); ctx.lineTo(x + s, y + s); ctx.moveTo(x - s, y + s); ctx.lineTo(x + s, y - s); ctx.stroke();
      if (e.manual) { ctx.strokeStyle = '#7c3aed'; ctx.lineWidth = 2 * u; ctx.beginPath(); ctx.arc(x, y, 6 * u, 0, 7); ctx.stroke(); }                 // placed by hand
      if (e.cable > r.P.maxc + 1e-6) { ctx.strokeStyle = '#dc2626'; ctx.lineWidth = 1.8 * u; ctx.beginPath(); ctx.arc(x, y, 9 * u, 0, 7); ctx.stroke(); }
    });
    if (S.cross && r.net) {
      ctx.font = `700 ${9 * u}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      r.net.cross.forEach(x => {
        const a = W(x.ends ? x.ends[0] : PlanLayout.ptAt(x.st, x.s, x.st.w / 2)), b = W(x.ends ? x.ends[1] : PlanLayout.ptAt(x.st, x.s, -x.st.w / 2)), t = Math.min(x.d110 + x.d160, 6);
        ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = (4 + t * 1.1) * u; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
        ctx.strokeStyle = '#334155'; ctx.globalAlpha = x.prov ? .45 : 1; ctx.lineWidth = (2 + t * 1.1) * u; if (x.prov) ctx.setLineDash([4 * u, 3 * u]); ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); ctx.setLineDash([]);
        const m = x.ends ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] : W(PlanLayout.ptAt(x.st, x.s, 0)); ctx.fillStyle = '#334155'; ctx.beginPath(); ctx.arc(m[0], m[1], 6.5 * u, 0, 7); ctx.fill(); ctx.globalAlpha = 1; ctx.fillStyle = '#fff'; ctx.fillText(String(x.d110 + x.d160), m[0], m[1] + .5 * u);
      });
    }
    if (S.fibre) {
      ctx.font = `700 ${8.5 * u}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineWidth = 1.8 * u;
      r.fibre.inter.forEach(j => { const [x, y] = W([j.x, j.y]); ctx.fillStyle = '#fff'; ctx.strokeStyle = '#a21caf'; ctx.beginPath(); ctx.arc(x, y, 4 * u, 0, 7); ctx.fill(); ctx.stroke(); });
      r.fibre.mhs.forEach(m => { const [x, y] = W([m.x, m.y]); ctx.fillStyle = '#fff'; ctx.strokeStyle = m.off ? '#dc2626' : '#a21caf'; ctx.beginPath(); ctx.arc(x, y, 6.5 * u, 0, 7); ctx.fill(); ctx.stroke(); ctx.fillStyle = '#a21caf'; ctx.fillText(m.label, x, y + .5 * u); });
      if (r.fibre.entry) { const [x, y] = W([r.fibre.entry.x, r.fibre.entry.y]); ctx.fillStyle = '#a21caf'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5 * u; ctx.beginPath(); ctx.moveTo(x, y + 3 * u); ctx.lineTo(x + 7 * u, y + 15 * u); ctx.lineTo(x - 7 * u, y + 15 * u); ctx.closePath(); ctx.stroke(); ctx.fill(); }
    }
    if (S.kiosk) {
      ctx.font = `700 ${9 * u}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      r.kiosks.forEach(k => { const [x, y] = W([k.x, k.y]), s = 6 * u; ctx.fillStyle = '#16a34a'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.8 * u; ctx.fillRect(x - s, y - s, 2 * s, 2 * s); ctx.strokeRect(x - s, y - s, 2 * s, 2 * s); ctx.fillStyle = '#0f172a'; ctx.fillText(k.id, x + 15 * u, y - 10 * u); });
    }
    if (S.lvmv && r.net && r.net.subs) {
      r.net.subs.forEach(Sb => {
        const k0 = Sb.k, m = W([k0.x, k0.y]);
        if (k0.stub) { ctx.save(); ctx.setLineDash([4 * u, 3 * u]); ctx.strokeStyle = '#c92a2a'; ctx.lineWidth = 1.4 * u; line(k0.stub); ctx.restore(); }
        ctx.fillStyle = k0.manual ? '#c92a2a' : '#e8590c'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.6 * u; ctx.beginPath(); ctx.moveTo(m[0], m[1] - 9 * u); ctx.lineTo(m[0] + 8 * u, m[1] + 6 * u); ctx.lineTo(m[0] - 8 * u, m[1] + 6 * u); ctx.closePath(); ctx.stroke(); ctx.fill();
        if (this.subMove != null && (this.cfg().subs || [])[this.subMove] && Math.hypot(this.cfg().subs[this.subMove].x * this.f - k0.x, this.cfg().subs[this.subMove].y * this.f - k0.y) < 1e-6) { ctx.strokeStyle = '#2563eb'; ctx.lineWidth = 2.2 * u; ctx.beginPath(); ctx.arc(m[0], m[1], 14 * u, 0, 6.2832); ctx.stroke(); }
        if (r.net.subs.length > 1) { ctx.font = `700 ${10 * u}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#c92a2a'; ctx.fillText('S' + Sb.id, m[0], m[1] + 16 * u); }
      });
    }
    if (this.hoverT && this.hoverT.edge) { ctx.strokeStyle = 'rgba(234,88,12,.5)'; ctx.lineWidth = 6 * u; line(this.hoverT.edge.pts); }
    if (S.cross && this._xsegs) {                                                                      // runs that go under a road: shaded, dashed
      ctx.save(); ctx.lineCap = 'butt'; const col2 = { fi: '#6b21a8', lv: '#b45309', svc: '#334155' };
      for (const g of this._xsegs) { ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 5 * u; ctx.setLineDash([]); line([g.a, g.b]); }
      for (const g of this._xsegs) { ctx.strokeStyle = col2[g.kind]; ctx.lineWidth = 1.8 * u; ctx.setLineDash([5 * u, 3 * u]); line([g.a, g.b]); }
      ctx.restore();
    }
    this._moveDraw(ctx, u, W); this._crossDraw(ctx, u, W); this._pickedDraw(ctx, u, W);
    ctx.restore();
  },

  // ───────── the panel ─────────
  renderOptions(el) {
    const L = this.cfg(), p = L.params, r = this.result, st = r && r.stats, opt = this._opt;
    const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fmt = v => Math.round(v).toLocaleString('en');
    const tipOf = k => this.TIPS[k] ? ` title="${esc(this.TIPS[k])}"` : '', qm = k => this.TIPS[k] ? ` <span${tipOf(k)} style="cursor:help;color:var(--text-muted);font-size:12px">(?)</span>` : '';
    const preset = this.presetOf(), dflt = PlanLayout.DEFAULTS;
    // a setting is "changed" against the chosen preset (or the standard values when the mix is custom)
    const refOf = k => { const P = this.PRESETS[preset]; return P && Object.prototype.hasOwnProperty.call(P, k) ? P[k] : dflt[k]; };
    const isCh = k => String(p[k]) !== String(refOf(k));
    const refShow = row => { const [k, kind, a, , , unit] = row, v = refOf(k); return kind === 'check' ? (v ? 'on' : 'off') : kind === 'select' ? ((row[2].find(o => o[0] === v) || [])[1] || String(v)) : kind === 'tnum' ? (v > 0 ? v + ' ' + unit : 'off') : v + (unit ? ' ' + unit : ''); };
    const dot = k => isCh(k) ? '<span aria-label="Changed" style="display:inline-block;width:8px;height:8px;border-radius:4px;background:#b45309;margin-right:5px"></span>' : '';
    const rst = row => isCh(row[0]) ? `<button type="button" class="plan-btn" data-act="resetone" data-k="${esc(row[0])}" style="align-self:flex-start;padding:0 6px;font-size:11px">Reset to ${esc(refShow(row))}</button>` : '';
    const ctrl = (row) => {
      const [k, kind, a, b, c, unit, label, def] = row;
      if (kind === 'range') return `<div style="display:flex;flex-direction:column;gap:3px"${tipOf(k)}><div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><span>${dot(k)}${esc(label)}${qm(k)}</span><span style="display:flex;gap:4px;align-items:center;flex:none"><input type="number" data-pn="${esc(k)}" aria-label="${esc(label)}" min="${a}" max="${b}" step="${c}" value="${esc(p[k])}" style="width:64px;padding:3px 5px;text-align:right">${unit ? `<span style="color:var(--text-muted);font-size:12px">${esc(unit)}</span>` : ''}</span></div><input type="range" data-p="${esc(k)}" data-unit="${esc(unit)}" aria-label="${esc(label)}" min="${a}" max="${b}" step="${c}" value="${esc(p[k])}" style="width:100%">${rst(row)}</div>`;
      if (kind === 'tnum') {                                                       // an option that is off by default: a switch, and its number only while it is on
        const on = p[k] > 0;
        return `<div style="display:flex;flex-direction:column;gap:4px"${tipOf(k)}><label style="display:flex;gap:6px;align-items:center;min-height:28px"><input type="checkbox" data-tn="${esc(k)}" data-def="${esc(def)}"${on ? ' checked' : ''}> <span>${dot(k)}${esc(label)}${qm(k)}</span></label>${on ? `<label style="display:flex;gap:6px;align-items:center;margin-left:22px">Up to <input type="number" data-p="${esc(k)}" min="${a}" max="${b}" step="${c}" value="${esc(p[k])}" style="width:72px;padding:4px 6px"> ${esc(unit)}</label>` : ''}${rst(row)}</div>`;
      }
      if (kind === 'check') return `<div style="display:flex;flex-direction:column;gap:3px"><label style="display:flex;gap:6px;align-items:flex-start"${tipOf(k)}><input type="checkbox" data-p="${k}"${p[k] ? ' checked' : ''}> <span>${dot(k)}${esc(a)}${qm(k)}</span></label>${rst(row)}</div>`;
      return `<div style="display:flex;flex-direction:column;gap:3px"><label style="display:block"${tipOf(k)}>${dot(k)}${esc(b)}${qm(k)}<select data-p="${k}" style="width:100%">${a.map(o => `<option value="${esc(o[0])}"${p[k] === o[0] ? ' selected' : ''}>${esc(o[1])}</option>`).join('')}</select></label>${rst(row)}</div>`;
    };
    const MOST = ['n', 'maxc', 'strN', 'strL'];                                      // the two kiosk settings shown in Rules as "most used"
    const grpChanged = rows => rows.some(r => !MOST.includes(r[0]) && String(p[r[0]]) !== String(dflt[r[0]]));
    const advHead = (name, changed, key) => `<summary style="cursor:pointer;font-weight:600;margin:2px 0">${name}${changed ? ` <span style="color:#b45309;font-weight:400;font-size:12px">● changed</span>` : ''}</summary>`;
    const resetBtn = (changed, key) => changed ? `<button type="button" class="plan-btn" data-act="resetgrp" data-g="${escHtml(key)}" style="align-self:flex-start;padding:1px 8px;font-size:12px">Reset this group</button>` : '';
    const rc = this.ratesCheck(), rf = rc.fig, ratesBtn = `<button type="button" class="plan-btn" data-act="fromrates" ${rf ? '' : 'disabled'} title="${rf ? `A kiosk = ${rf.worth} m of service cable, a crossing = ${rf.xpen} m (from the rate library)` : 'Needs a price for the kiosk, a 110 mm crossing and the service cable in the rate library'}" style="align-self:flex-start;padding:1px 8px;font-size:12px">Set kiosk worth and crossing cost from my rates</button>` + (rf ? '' : `<span style="font-size:12px;color:#8f270a">Not available: the rate library has no price for ${esc(rc.missing.join(', '))}. Enter them in Quantities › Rate library.</span>`);
    const groups = this.CTRL.map(([name, rows]) => { const ch = grpChanged(rows), shown = rows.filter(r => !MOST.includes(r[0]));
      return shown.length ? `<details>${advHead(name, ch)}<div style="display:flex;flex-direction:column;gap:8px;padding:6px 0 4px">${shown.map(ctrl).join('')}${name === 'Kiosks' ? ratesBtn : ''}${resetBtn(ch, name)}</div></details>` : ''; }).join('');
    const TT = L.trench, tget = k => k.startsWith('depth.') ? TT.depth[k.slice(6)] : TT[k];
    const TTIP = { 'depth.lv': 'How deep the LV, service and street-light cable trenches are dug. Sets the trench volume in the quantities.', 'depth.fi': 'How deep the fibre duct trenches are dug.', fibre: 'Whether fibre gets its own trench, lies in the LV trench where the two run together, or has no trench drawn.', crossings: 'Draw one shared trench across the road at every crossing, so the quantities count the road cut once.' };
    const ttl = k => TTIP[k] ? ` title="${esc(TTIP[k])}"` : '';
    const tctrl = ([k, kind, a, b, c, unit, label]) => {
      if (k === 'depth.comb' && TT.depth.comb == null) return '';
      if (kind === 'range') return `<label style="display:block"${ttl(k)}>${esc(label)} <b data-tv="${k}">${(+tget(k)).toFixed(2)} ${esc(unit)}</b><input type="range" data-t="${k}" min="${a}" max="${b}" step="${c}" value="${Number(tget(k))}" style="width:100%"></label>`;
      if (kind === 'check') { const on = k === 'combOn' ? TT.depth.comb != null : TT[k]; return `<label style="display:flex;gap:6px;align-items:flex-start"${ttl(k)}><input type="checkbox" data-t="${k}"${on ? ' checked' : ''}> <span>${esc(a)}</span></label>`; }
      return `<label style="display:block"${ttl(k)}>${esc(b)}<select data-t="${k}" style="width:100%">${a.map(o => `<option value="${esc(o[0])}"${TT[k] === o[0] ? ' selected' : ''}>${esc(o[1])}</option>`).join('')}</select></label>`;
    };
    const trChanged = JSON.stringify([TT.depth.lv, TT.depth.fi, TT.fibre, TT.crossings]) !== JSON.stringify([PlanLayout.TRENCH_DEFAULTS.depth.lv, PlanLayout.TRENCH_DEFAULTS.depth.fi, PlanLayout.TRENCH_DEFAULTS.fibre, PlanLayout.TRENCH_DEFAULTS.crossings]);
    const trenchGroup = `<details>${advHead('Trenches', trChanged)}<div style="display:flex;flex-direction:column;gap:8px;padding:6px 0 4px">${this.TREN.map(tctrl).join('')}${resetBtn(trChanged, 'Trenches')}</div></details>`;
    const VDc = L.vd, cb = this.vdCables(), lim = this.vdLimits(), txOpts = (typeof Retic !== 'undefined' ? Retic._txOptions() : []), opts = (list, cur) => list.map(c => `<option value="${esc(c.id)}"${cur && cur.id === c.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
    const vdDef = { way80: true, taper: true, minSize: 0, maxSize: 0, maxSizes: 0, autoSplit: false, prot: '', protK: 1.2, svc: '' };
    const vdChanged = Object.keys(vdDef).some(k => String(VDc[k]) !== String(vdDef[k]));
    const vdTx = `<label style="display:block">Mini-sub transformer<select data-vd="tx" style="width:100%"><option value=""${VDc.tx ? '' : ' selected'}>Automatic: the smallest that carries each mini-sub</option>${txOpts.map(o => `<option value="${esc(o.id)}"${VDc.tx === o.id ? ' selected' : ''}>${esc(o.name)}</option>`).join('')}</select></label>`;
    const vdLv = `<label style="display:block">LV feeder cable<select data-vd="lv" style="width:100%"><option value=""${cb.auto ? ' selected' : ''}>Automatic: the smallest that meets the limits and the rating${cb.auto && cb.lv ? ' (now ' + esc(cb.lv.name) + ')' : ''}</option>${opts(cb.feeders, cb.auto ? null : cb.lv)}</select></label>`;
    const vdGroup = `<details>${advHead('Voltage drop and earth fault', vdChanged)}<div style="display:flex;flex-direction:column;gap:8px;padding:6px 0 4px">
        <div>Limits are Demand's: LV feeder <b>${Number(lim.feeder)} %</b>, service <b>${Number(lim.svc)} %</b>. Change them in Demand (Max Feeder VD, Max Service VD).</div>
        <label style="display:flex;gap:6px;align-items:flex-start"><input type="checkbox" data-vd="way80"${VDc.way80 ? ' checked' : ''}> <span>80 A on erven: an 80 A MCCB on every erf's way (change it per kiosk in Demand)</span></label>
        <label style="display:flex;gap:6px;align-items:flex-start"><input type="checkbox" data-vd="taper"${VDc.taper ? ' checked' : ''}> <span>Taper the LV cable: the smallest size that passes on each feeder, large near the mini-sub</span></label>
        <div style="display:flex;gap:6px"><label style="flex:1;display:block">Smallest LV cable<select data-vd="minSize" style="width:100%"><option value="0"${VDc.minSize ? '' : ' selected'}>No limit</option>${this._ladderSizes().map(x => `<option value="${x}"${VDc.minSize === x ? ' selected' : ''}>${x} mm²</option>`).join('')}</select></label>
          <label style="flex:1;display:block">Largest LV cable<select data-vd="maxSize" style="width:100%"><option value="0"${VDc.maxSize ? '' : ' selected'}>No limit</option>${this._ladderSizes().map(x => `<option value="${x}"${VDc.maxSize === x ? ' selected' : ''}>${x} mm²</option>`).join('')}</select></label></div>
        <label style="display:block">Different LV cable sizes (at most)<select data-vd="maxSizes" style="width:100%"><option value="0"${VDc.maxSizes ? '' : ' selected'}>No limit</option>${[1, 2, 3, 4].map(x => `<option value="${x}"${VDc.maxSizes === x ? ' selected' : ''}>${x}</option>`).join('')}</select></label>
        <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" data-vd="autoSplit"${VDc.autoSplit ? ' checked' : ''}> Split strings automatically when one cannot clear its fault</label>
        <label style="display:block">String breaker (earth-fault loop)<select data-vd="prot" style="width:100%">${Retic._protectionOptions(VDc.prot, this._designOn() ? 'Automatic: sized to each string (fewest earth-fault fails)' : 'Automatic: the next size up from the string current × factor')}</select></label>
        ${VDc.prot || this._designOn() ? '' : `<label style="display:block">Breaker rating at least <b data-vv="protK">${Number(VDc.protK).toFixed(2)}</b> × the string current<input type="range" data-vd="protK" min="1" max="2" step="0.05" value="${Number(VDc.protK)}" style="width:100%"></label>`}
        <label style="display:block">Service cable<select data-vd="svc" style="width:100%">${opts(cb.services, cb.svc)}</select></label>
        <div style="color:var(--text-muted)">Worked out by Demand itself: its load class and ADMD settings give the diversified current on each LV leg and on each service, and its volt-drop calculation does the rest.</div>${resetBtn(vdChanged, 'Voltage drop and earth fault')}</div></details>`;
    const sr = this.streetsOnPlan();
    const seg = (id, key, vals) => `<span class="plan-seg" style="display:inline-flex;gap:2px">${vals.map(([v, t]) => { const cur = (L.sides[id] || {})[key]; const on = (v === 0 ? (cur == null) : cur === v); return `<button type="button" class="plan-btn" data-side="${esc(id)}" data-key="${esc(key)}" data-val="${v}" aria-pressed="${on}" style="padding:2px 7px;font-size:12px${on ? ';font-weight:600;outline:2px solid var(--accent,#2563eb)' : ''}">${t}</button>`; }).join('')}</span>`;
    const GA = L.sides['*'] || {}, dName = key => GA[key] === 1 ? 'All: Left' : GA[key] === -1 ? 'All: Right' : 'Auto';          // what a street with no side of its own follows
    const allRow = `<div style="display:flex;justify-content:space-between;align-items:center;gap:6px;border-bottom:1px solid var(--border,#ddd);padding:3px 0 5px" title="The side for every street that has none of its own. A side set on a single street below overrides it."><span><b>All streets</b></span><span style="display:flex;flex-direction:column;gap:2px;align-items:flex-end"><span>Kiosks ${seg('*', 'k', [[0, 'Auto'], [1, 'Left'], [-1, 'Right']])}</span><span>Fibre ${seg('*', 'f', [[0, 'Auto'], [1, 'Left'], [-1, 'Right']])}</span></span></div>`;
    const streets = sr.length ? sr.map((s, i) => `<div style="display:flex;justify-content:space-between;align-items:center;gap:6px;border-bottom:1px solid var(--border,#ddd);padding:3px 0"><span>${esc((s.props && s.props.name) || 'Street ' + (i + 1))}</span><span style="display:flex;flex-direction:column;gap:2px;align-items:flex-end"><span>Kiosks ${seg(s.id, 'k', [[0, dName('k')], [1, 'Left'], [-1, 'Right']])}</span><span>Fibre ${seg(s.id, 'f', [[0, dName('f')], [1, 'Left'], [-1, 'Right']])}</span></span></div>`).join('') : '<div class="plan-props-empty" style="padding:4px 0">No streets yet. Draw them with Draw centrelines above, or take them from a drawing layer (pair kerbs, pick the centrelines you want, or use every line of a centreline layer). Left and right are looking along the way you drew it.</div>';
    const lyr = this.dxfLayers();
    const fromDxf = lyr.length ? `<div style="display:flex;flex-direction:column;gap:4px;margin:4px 0"><label style="display:block">Take streets from a drawing layer<select data-stl style="width:100%">${lyr.map((x, i) => `<option value="${i}"${i === 0 ? ' selected' : ''}>${esc(x.layer)} (${x.n} line${x.n === 1 ? '' : 's'})${x.kerbs ? ' · kerbs (pair them)' : x.guess ? ' ★' : ''}</option>`).join('')}</select></label><div style="display:flex;gap:4px;flex-wrap:wrap"><button type="button" class="plan-btn" data-act="kerbstreets" title="Click the kerb lines you want, on any layer: each click adds the streets between that kerb line and the kerbs across the road, with the measured width">Pick kerbs</button><button type="button" class="plan-btn" data-act="rs-start" title="Click inside the road reserves (the space between the erf boundaries, or one outline per street): the streets are made from them, with the reserve width, a carriageway and kerb returns">Streets from road reserve</button><button type="button" class="plan-btn" data-act="centrepick" title="The layer holds road centrelines among other lines: click the lines you want, one per road, then create the streets">Pick centrelines</button><button type="button" class="plan-btn" data-act="dxfstreets" title="The layer holds only road centrelines: every line of it becomes a street as drawn, width 12 m">All lines as streets</button></div><div style="font-size:12px;color:var(--text-muted)"><b>Pick kerbs</b>: you click kerb lines and the roads between them are made, with their measured width. <b>Streets from road reserve</b>: you click inside the road space between the erf boundaries. <b>Pick centrelines</b>: you click the centreline of each road. <b>All lines</b>: every line of the layer is a street as drawn.</div></div></div>` : '';
    const KS = this.kerbStage, ko = this.kerbOpt, CS = this.centreStage;
    const centreBlock = CS ? `<div style="border:2px solid #f59e0b;border-radius:6px;padding:6px 8px;margin:4px 0;display:flex;flex-direction:column;gap:5px">
        <b>Streets from centrelines: pick</b>
        <div style="font-size:12px;color:var(--text-muted)">Click the centreline of each road in ${CS.layers.map(l => '"' + esc(l) + '"').join(', ')}: the whole line is taken. Shift-click takes just the one drawn piece. Click a picked line again, or Alt-click it, to drop it. To take lines from another layer, pick it in the list below and press Pick centrelines. Enter creates, Esc leaves.</div>
        <label style="font-size:12px;display:flex;gap:6px;align-items:center">Road width <input type="number" data-copt="w" min="3" max="60" step="0.5" value="${escHtml(this.centreW)}" style="width:60px"> m (change it per street in its properties)</label>
        ${CS.picks.length ? `<div style="max-height:150px;overflow:auto">${CS.picks.map((c, i) => `<div style="display:flex;justify-content:space-between;align-items:center;gap:4px;border-bottom:1px solid var(--border,#ddd);padding:2px 0;font-size:12px"><span>${esc(CS.namer.peek(c.pts.map(q => ({ x: q[0] / CS.f, y: q[1] / CS.f }))) || 'Street ' + (i + 1))} · ${Math.round(this.centreLen(c.pts))} m${c.piece ? ' · one piece' : ''}</span><button type="button" class="plan-btn" data-act="centrerm" data-i="${i}" style="padding:1px 6px;font-size:12px">drop</button></div>`).join('')}</div>` : '<div style="color:var(--text-muted)">No lines picked yet.</div>'}
        <div style="display:flex;gap:6px"><button type="button" class="plan-btn" data-act="centrecreate" style="font-weight:600"${CS.picks.length ? '' : ' disabled'}>Create ${CS.picks.length} street${CS.picks.length === 1 ? '' : 's'}</button><button type="button" class="plan-btn" data-act="centrecancel">Cancel</button></div></div>` : '';
    const kcomps = KS ? KS.networks() : [];
    const kinfo = KS ? KS.lonely.map(l => this.kerbInfo(l)) : [];
    const kpick = (p, i) => { const n = p.op === 'all' ? 'Paired every kerb of a layer' : p.op === 'pair' ? 'Paired two kerbs by hand' : p.op === 'one' ? 'Street beside a lone kerb' : `${p.op === 'add' ? 'Added' : 'Removed'} ${p.items.length > 1 ? p.items.length + ' kerb lines' : 'a kerb line'}${p.items[0] && p.items[0].span ? ' (one piece)' : ''}`; return `<div style="display:flex;justify-content:space-between;align-items:center;gap:4px;border-bottom:1px solid var(--border,#ddd);padding:2px 0;font-size:12px"><span>${n}</span><button type="button" class="plan-btn" data-act="kerbrmpick" data-i="${i}" style="padding:0 6px;font-size:12px" title="Take this pick out">×</button></div>`; };
    const kerbBlock = KS ? `<div style="border:2px solid #f59e0b;border-radius:6px;padding:6px 8px;margin:4px 0;display:flex;flex-direction:column;gap:5px">
        <b>Streets from kerbs: pick</b>
        <div style="display:flex;gap:4px"><button type="button" class="plan-btn" data-act="kerbmode" data-m="add" aria-pressed="${KS.mode === 'add'}" style="${KS.mode === 'add' ? 'font-weight:600;outline:2px solid #16a34a' : ''}">Add</button><button type="button" class="plan-btn" data-act="kerbmode" data-m="sub" aria-pressed="${KS.mode === 'sub'}" style="${KS.mode === 'sub' ? 'font-weight:600;outline:2px solid #dc2626' : ''}">Subtract</button><button type="button" class="plan-btn" data-act="kerbundo"${KS.picks.length ? '' : ' disabled'} title="Backspace">Undo last pick</button></div>
        <div style="font-size:12px;color:var(--text-muted)">Click a kerb line (any layer) to add it and every street it touches. Shift-click takes just the one drawn piece. Alt-click subtracts for one click. Click a street (Subtract) to remove it.</div>
        <div>${KS.streets.length} street${KS.streets.length === 1 ? '' : 's'} (amber, width on each).</div>
        <div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap"><button type="button" class="plan-btn" data-act="kerbpairall" title="Pair every kerb of the layer chosen in the list below, as the old Streets from kerb layer did">Pair all on layer</button><span style="font-size:12px;color:var(--text-muted)">(the layer picked in the list below)</span></div>
        <label style="font-size:12px;display:flex;gap:6px;align-items:center"><input type="checkbox" data-kany${KS.anyLayer ? ' checked' : ''}> Look for partners on any layer</label>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:12px">Road width at least <input type="number" data-kopt="wmin" min="1" max="30" step="0.5" value="${escHtml(ko.wmin)}" style="width:52px"> at most <input type="number" data-kopt="wmax" min="5" max="60" step="0.5" value="${escHtml(ko.wmax)}" style="width:52px"> Bridge gaps up to <input type="number" data-kopt="gap" min="0" max="60" step="1" value="${escHtml(ko.gap)}" style="width:52px"> m</div>
        ${kcomps.length > 1 ? `<div style="color:#c2410c">The streets form <b>${kcomps.length} separate networks</b> (${kcomps.map(c => c.length).join(' + ')} streets; the ones cut off are orange). The LV and fibre networks do not reach across a gap. <div style="display:flex;gap:6px;align-items:center;margin-top:3px"><button type="button" class="plan-btn" data-act="kerbjoin" style="padding:2px 8px;font-size:12px">Join networks up to</button><input type="number" data-kopt="join" min="1" max="200" step="5" value="${escHtml(ko.join)}" style="width:60px"> m</div></div>` : KS.streets.length ? '<div style="color:#15803d">The streets form one connected network.</div>' : ''}
        <div style="font-size:12px;color:var(--text-muted)">Ctrl-click a kerb that has no partner, then click on the road's side: a street <input type="number" data-kopt="oneW" min="3" max="40" step="0.5" value="${escHtml(ko.oneW)}" style="width:52px"> m wide beside it. Enter creates; Esc leaves.</div>
        ${kinfo.length ? `<div style="color:#b91c1c"><b>Clicked, no partner</b> (${kinfo.length}, red dashed):<div style="max-height:150px;overflow:auto;margin-top:3px">${kinfo.map(k => `<div style="display:flex;justify-content:space-between;align-items:center;gap:4px;border-bottom:1px solid var(--border,#ddd);padding:2px 0"><span>${k.name ? esc(k.name) : 'near ' + Math.round(k.at[0]) + ', ' + Math.round(k.at[1]) + ' m'} · ${Math.round(k.len)} m</span><span style="display:flex;gap:3px"><button type="button" class="plan-btn" data-act="kerbshow" data-l="${escHtml(k.layer)}" data-i="${k.i}" style="padding:1px 6px;font-size:12px">show</button><button type="button" class="plan-btn" data-act="kerbpair" data-l="${escHtml(k.layer)}" data-i="${k.i}" style="padding:1px 6px;font-size:12px${KS.pairFrom && KS.pairFrom.layer === k.layer && KS.pairFrom.chain === k.i ? ';outline:2px solid #2563eb' : ''}" title="Then click the kerb across the road">pair…</button><button type="button" class="plan-btn" data-act="kerbone" data-l="${escHtml(k.layer)}" data-i="${k.i}" style="padding:1px 6px;font-size:12px${KS.one && KS.one.layer === k.layer && KS.one.chain === k.i ? ';outline:2px solid #2563eb' : ''}" title="A road with a kerb on this side only">one side…</button></span></div>`).join('')}</div></div>` : ''}
        ${KS.picks.length ? `<details><summary style="font-size:12px;cursor:pointer">Picks (${KS.picks.length})</summary><div style="max-height:130px;overflow:auto">${KS.picks.map((p, i) => kpick(p, i)).reverse().join('')}</div></details>` : ''}
        <div style="display:flex;gap:6px"><button type="button" class="plan-btn" data-act="kerbcreate" style="font-weight:600"${KS.streets.length ? '' : ' disabled'}>Create ${KS.streets.length} street${KS.streets.length === 1 ? '' : 's'}</button><button type="button" class="plan-btn" data-act="kerbcancel">Cancel</button></div></div>` : '';
    const tile = (b, s) => `<div style="border:1px solid var(--border,#ddd);border-radius:5px;padding:4px 6px"><b style="font-size:15px;display:block">${b}</b><span style="font-size:11px;color:var(--text-muted)">${s}</span></div>`;
    const tiles = st ? [[st.erven, 'erven'], [r.net.subs.length, 'mini-sub' + (r.net.subs.length === 1 ? '' : 's')], [st.kiosks, `kiosks · ${st.avgPer.toFixed(1)} erven each on average · ${st.small} serve 2 erven or fewer · at most ${p.n}`], [st.strings, 'LV strings off the mini-sub' + (p.strN ? ' · at most ' + p.strN + ' kiosks each' : '')], [fmt(st.cable) + ' m', 'service cable'], [fmt(st.cableMax) + ' m of ' + p.maxc + ' m', 'longest service · limit'], ...(r.vd && !r.vd.err ? [[r.vd.maxLv.toFixed(1) + '% / ' + r.vd.maxSvc.toFixed(1) + '%', 'worst LV feeder / service drop · limits ' + r.vd.V.limF + '% / ' + r.vd.V.limS + '%']] : []), [st.crossings, 'road crossings'], [st.provisional, 'junction ducts, empty'], [st.d110 + ' + ' + st.d160, '110 mm + 160 mm ducts'], [st.manholes + ' + ' + st.junctionManholes, 'manholes + junctions'], [fmt(st.trunk) + ' m', 'trunk duct'], [fmt(st.leads) + ' m', 'duct to erven'], [fmt(st.lv) + ' m', st.unreached ? `<span style="color:#c92a2a;font-weight:600">LV feeder: incomplete, ${st.unreached} kiosk${st.unreached === 1 ? '' : 's'} not reached</span>` : 'LV feeder'], [st.tOffs + ' / ' + st.spurEnds + ' / ' + st.loops, 'T-offs / spur ends / loops'], [st.baseline, 'crossings if unshared']].map(t => tile(...t)).join('') : '';
    const D = r && r.design, cfgVd = this.cfg().vd;
    const subName = id => /^LAYOUT_SUB/.test(id) ? 'Mini-sub' + (id.split('_')[2] ? ' ' + id.split('_')[2] : '') : id;
    const headOf = D ? new Map(D.heads.map(h => [h.kioskId, h])) : new Map();
    const designBlock = D ? `<div style="margin-top:6px"><b>LV design</b>
      ${tile(`LV cable: ${D.taper.count} size${D.taper.count === 1 ? '' : 's'}, ${D.taper.minMm2}${D.taper.count > 1 ? ' to ' + D.taper.maxMm2 : ''} mm² ${esc(D.conductor)}`, (cfgVd.minSize || cfgVd.maxSize ? `limited to ${cfgVd.minSize || 'any'} to ${cfgVd.maxSize || 'any'} mm² · ` : '') + (D.taper.on && D.taper.savedPct > 0 ? `taper saves ${D.taper.savedPct}% against ${D.uniform.sizeMm2} mm² throughout (size × length)` : (D.taper.on ? 'no feeder can be smaller' : 'taper off: one size throughout')))}
      <div style="font-size:12px;color:var(--text-muted);margin:3px 0">${cfgVd.way80 ? 'Every erf way: MCCB 80 A. ' : ''}${r.net.unreached && r.net.unreached.length ? `<b style="color:#c92a2a">Incomplete: ${r.net.unreached.length} kiosk${r.net.unreached.length === 1 ? '' : 's'} (${r.net.unreached.reduce((a, k) => a + k.members.length, 0)} erven) are not on the LV network, so the checks below leave them out. This is not a pass.</b>` : D.ok ? 'Every earth-fault, volt-drop and rating check passes.' : `<b style="color:#b91c1c">${D.failCount} earth-fault check${D.failCount === 1 ? '' : 's'} still fail${D.failCount === 1 ? 's' : ''}: see the Checks below.</b>`}</div>
      <div style="max-height:200px;overflow:auto"><table style="width:100%;font-size:12px;border-collapse:collapse"><thead><tr><th style="text-align:left">Kiosk</th><th style="text-align:left">Fed from</th><th style="text-align:left">Cable</th><th style="text-align:left">Breaker</th><th style="text-align:right">m</th></tr></thead><tbody>${D.feeders.map(x => { const h = headOf.get(x.kioskId); return `<tr style="border-top:1px solid var(--border,#ddd)"><td>${esc(x.name)}</td><td>${esc(subName(x.fedFrom))}</td><td>${esc(String(x.cable).replace(/ LV$/, ''))}${x.setBy === 'taper' ? ' <span title="smaller (or larger) than the one size that would pass everywhere: set by the taper" style="color:#0f8f78;font-size:11px">· set by taper</span>' : x.setBy === 'you' ? ' <span style="font-size:11px">· set by you</span>' : ''}</td><td>${h ? (h.breaker ? esc(h.breaker) + (h.pinned ? ' <span style="font-size:11px">· set by you</span>' : '') : '<span style="color:#b91c1c">no current from Demand</span>') : '—'}</td><td style="text-align:right">${Math.round(x.lengthM)}</td></tr>`; }).join('')}</tbody></table></div>
      </div>` : (r && r.designErr ? `<div style="color:#b91c1c;margin-top:6px">The LV design could not be run: ${esc(r.designErr)}</div>` : '');
    const xt = r ? r.net.cross.slice().sort((a, b) => (a.prov - b.prov) || (b.d110 + b.d160) - (a.d110 + a.d160)).slice(0, 14).map((x, i) => { const parts = x.prov ? `${x.d110}×110, ${x.d160}×160, junction` : [x.d110s && `${x.d110s}×110 service`, x.d110f && `${x.d110f}×110 fibre`, x.d110l && `${x.d110l}×110 LV`, x.d160 && `${x.d160}×160 MV`, x.spare && `${x.spare}×110 spare`].filter(Boolean).join(', '); return `<tr><td>${esc(x.st.name)}</td><td>${esc(parts)}</td></tr>`; }).join('') : '';
    const trenchRows = r && r.trench ? Object.entries(r.trench.summary).map(([type, q]) => { const d = PLAN_DEFS.trenchTypes[type] || { name: type, width: 0.5 }; const vol = q.len * d.width * q.depth; return `<div style="display:flex;justify-content:space-between;gap:8px"><span>${esc(d.name)}</span><span>${fmt(q.len)} m at ${q.depth.toFixed(2)} m · ${fmt(vol)} m³</span></div>`; }).join('') : '';
    const ck = r ? this.checks() : [], placed = this.placedSubs(), Ls = this.cfg();
    this._ck = ck;
    const sevCol = { fail: '#dc2626', warn: '#b45309', info: '#64748b' }, sevTxt = { fail: 'Fix', warn: 'Check', info: 'Note' };
    const nFix = ck.filter(c => c.sev === 'fail').length, nChk = ck.filter(c => c.sev === 'warn').length, nNote = ck.filter(c => c.sev === 'info').length;
    const noKiosks = !!(r && !r.kiosks.length);
    const sr0 = this.streetsOnPlan(), nErv = AppState.planMarkup.elements.filter(e => e.type === 'erf' && Array.isArray(e.boundary) && e.boundary.length >= 3).length;
    const f0 = PlanEngine.factor(), streetM = f0 ? sr0.reduce((a, s) => a + this.centreLen(this._flat(s).map(q => [q.x * f0, q.y * f0])), 0) : 0;
    // ── the step bar
    const sst = [
      !sr0.length || !nErv ? { c: 'todo', g: '!', t: !nErv ? 'No erven' : 'No streets' } : noKiosks ? { c: 'todo', g: '!', t: 'No kiosks' } : { c: 'ok', g: '✓', t: `${nErv} erven`, title: `${nErv} erven · ${sr0.length} street${sr0.length === 1 ? '' : 's'}` },
      placed.length ? { c: 'ok', g: '✓', t: placed.length + ' placed' } : { c: 'todo', g: '!', t: 'Place one' },
      !this.admdOk() ? { c: 'todo', g: '!', t: 'Confirm ADMD' } : { c: 'ok', g: '✓', t: this.PRESET_NAMES[preset] },
      !r ? { c: 'idle', g: '4', t: 'Not run' } : this.stale ? { c: 'stale', g: '↻', t: 'Out of date' } : noKiosks ? { c: 'todo', g: '!', t: 'Blocked' } : nFix ? { c: 'todo', g: String(nFix), t: nFix + (nFix === 1 ? ' fix' : ' fixes') } : { c: 'ok', g: '✓', t: 'Ready' }];
    const dotCol = { ok: '#16a34a', todo: '#dc2626', stale: '#b45309', idle: '#94a3b8' };
    const stepBar = `<div role="tablist" style="display:grid;grid-template-columns:repeat(4,1fr);gap:3px">${sst.map((x, i) => `<button type="button" role="tab" class="plan-btn" data-step="${i + 1}" aria-selected="${this.step === i + 1}" title="${esc(this.STEPS[i] + ': ' + (x.title || x.t))}" style="display:flex;flex-direction:column;align-items:flex-start;gap:1px;padding:4px 5px;min-width:0;text-align:left;${this.step === i + 1 ? 'outline:2px solid var(--accent,#2563eb);font-weight:600' : ''}"><span style="display:flex;align-items:center;gap:4px;font-size:12px;white-space:nowrap"><span style="display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;border-radius:50%;background:${escHtml(dotCol[x.c])};color:#fff;font-size:10px;flex:none">${esc(x.g)}</span>${this.STEPS[i]}</span><small style="font-size:10px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%">${esc(x.t)}</small></button>`).join('')}</div>`;
    const banner = (kind, html) => `<div style="border-left:4px solid ${kind === 'bad' ? '#dc2626' : '#b45309'};background:${kind === 'bad' ? 'rgba(220,38,38,.08)' : 'rgba(180,83,9,.09)'};padding:6px 8px;border-radius:4px;display:flex;flex-direction:column;gap:5px">${html}</div>`;
    const sBtn = 'padding:2px 8px;font-size:12px';
    const blocked = noKiosks ? banner('bad', `<b>No kiosks were found.</b><span>${r.erven.length} erven do not face a street, so nothing can be created. Draw a centreline beside them, or extend the nearest street.</span><span style="display:flex;gap:5px;flex-wrap:wrap"><button type="button" class="plan-btn" data-act="showerven" style="${sBtn}">Show the erven</button><button type="button" class="plan-btn" data-act="drawfix" style="${sBtn};font-weight:600">Draw centrelines</button></span>`) : '';
    // ── step 1: streets
    const found = (ok, html, act) => `<div style="display:flex;align-items:center;gap:6px;border-bottom:1px solid var(--border-color,#ddd);padding:3px 0"><span style="color:${ok ? '#16a34a' : '#dc2626'};font-weight:700">${ok ? '✓' : '!'}</span><span style="flex:1">${html}</span>${act ? `<button type="button" class="plan-btn" data-act="${act}" style="${sBtn}">Show</button>` : ''}</div>`;
    const step1 = `${blocked}
        ${found(nErv > 0, nErv ? `<b>${nErv} erven</b> with boundaries` : '<b>No erven with a boundary.</b> Use Detect erven first', nErv ? 'zoomerven' : '')}
        ${found(sr0.length > 0, sr0.length ? `<b>${sr0.length} street${sr0.length === 1 ? '' : 's'}</b>, ${fmt(streetM)} m` : '<b>No streets yet.</b> Add them below', sr0.length ? 'zoomstreets' : '')}
        ${kerbBlock}${centreBlock}${typeof PlanReserveUI !== 'undefined' ? PlanReserveUI.panelHtml() : ''}
        <div style="font-weight:600;margin-top:4px">Add or change streets</div>
        <div style="border:1px solid var(--accent,#2563eb);border-radius:6px;padding:6px 8px;display:flex;flex-direction:column;gap:4px"><div style="display:flex;justify-content:space-between"><b>Draw centrelines</b><span style="font-size:11px;color:var(--accent,#2563eb)">usual choice</span></div><span style="font-size:12px;color:var(--text-muted)">Click along each street. An end that lands on another street joins it.</span><div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap"><button type="button" class="plan-btn" data-act="streetdraw" aria-pressed="${escHtml(this.drawStreets)}" style="font-weight:600;${this.drawStreets ? 'outline:2px solid var(--accent,#2563eb)' : ''}">${this.drawStreets ? 'Stop drawing' : 'Start drawing'}</button><label style="font-size:12px;display:flex;gap:4px;align-items:center">Width <input type="number" data-copt="w" min="3" max="60" step="0.5" value="${escHtml(this.centreW)}" style="width:54px"> m</label></div>${this.drawStreets ? '<div style="font-size:12px;color:var(--text-muted)">Click along the street. Enter, or click the last point again, finishes it. Backspace takes a point back, Esc stops. Points snap to the drawing\'s corners and ends. Left and right are looking along the way you drew it.</div>' : ''}</div>
        ${fromDxf || '<div style="font-size:12px;color:var(--text-muted)">To take streets from a drawing layer, import a DXF first.</div>'}
        <details><summary style="cursor:pointer;font-weight:600">Street options <span style="font-weight:400;font-size:12px;color:var(--text-muted)">kiosk and fibre side · ${sr0.length} street${sr0.length === 1 ? '' : 's'}</span></summary>${allRow}${streets}</details>`;
    // ── step 2: mini-subs
    const subRow = (q, i) => { const S = r && r.net.subs[i], ks = S ? r.kiosks.filter(k => k.subK === S.k) : null;
      return `<div style="border:1px solid var(--border-color,#ddd);border-radius:5px;padding:4px 6px;display:flex;flex-direction:column;gap:2px"><div style="display:flex;justify-content:space-between;align-items:center;gap:4px"><b>S${i + 1}</b>${q.src === 'layout' ? `<span style="display:flex;gap:4px"><button type="button" class="plan-btn" data-act="submove" data-i="${escHtml(q.i)}" style="${sBtn}">Move</button><button type="button" class="plan-btn" data-act="subrm" data-i="${escHtml(q.i)}" style="${sBtn}">Remove</button></span>` : ''}</div><span style="font-size:12px;color:var(--text-muted)">${q.src === 'plan' ? 'Drawn on the plan. Move or remove it there. ' : ''}${f0 ? Math.round(q.x * f0) + ' m, ' + Math.round(q.y * f0) + ' m' : ''}${ks ? ` · serves ${ks.length} kiosk${ks.length === 1 ? '' : 's'}, ${ks.reduce((a, k) => a + k.members.length, 0)} erven` : ''}</span></div>`; };
    const step2 = `<div style="font-size:12px;color:var(--text-muted)">The layout works from your mini-subs. Click where each one stands, anywhere (on a street, in a block, in a park). No kiosk is added beside it: kiosks follow the erven and go to the nearest mini-sub.</div>
        <button type="button" class="plan-btn" data-mode="sub" aria-pressed="${this.mode === 'sub'}" style="font-weight:600;padding:8px;${this.mode === 'sub' ? 'outline:2px solid var(--accent,#2563eb)' : ''}">${this.mode === 'sub' ? 'Placing: click the plan' : (placed.length ? 'Place another' : 'Place a mini-sub')}</button>
        <div style="font-weight:600">Placed (${placed.length})</div>
        ${placed.length ? placed.map(subRow).join('') : banner('warn', '<span>None yet. The layout cannot run until one is placed. Where it stands decides every LV cable, so place it with care.</span>')}
        <div style="font-size:12px;color:var(--text-muted)">Click one, then click again to move it. Alt-click removes it. A mini-sub part you draw on the plan counts too.</div>`;
    // ── step 3: rules
    const pBtn = (k, t) => `<button type="button" class="plan-btn" data-preset="${k}" aria-pressed="${preset === k}" style="padding:3px 6px;font-size:12px;${preset === k ? 'font-weight:600;outline:2px solid var(--accent,#2563eb)' : ''}">${t}</button>`;
    const kRow = k => this.CTRL[1][1].find(x => x[0] === k);
    const nChanged = this.CTRL.filter(([, rows]) => grpChanged(rows)).length + (trChanged ? 1 : 0) + (vdChanged ? 1 : 0);
    const SC = L.sections, secLine = `<div style="display:flex;justify-content:space-between;align-items:center;gap:6px;font-size:12px"><span><b>Cross-sections</b> <span style="color:var(--text-muted)">off: every cable runs the Corridor distance inside the boundary</span></span><button type="button" class="plan-btn" data-act="secedit" style="padding:1px 8px;font-size:12px">Edit</button></div>`,
      secBlock = !SC.on && !SC.lines.length ? secLine : `<div style="border:1px solid var(--border,#ddd);border-radius:6px;padding:6px 8px;display:flex;flex-direction:column;gap:5px"><div style="font-weight:600">Cross-sections <span style="font-weight:400;font-size:12px;color:var(--text-muted)">${SC.on ? 'on' : 'off'} · ${SC.list.length} section${SC.list.length === 1 ? '' : 's'}${SC.lines.length ? ' · ' + SC.lines.length + ' line' + (SC.lines.length === 1 ? '' : 's') : ''}</span></div>
        <div style="font-size:12px;color:var(--text-muted)">${SC.on ? 'Offsets, depths and the kiosk and manhole sizes come from the section that applies to each stretch of street, all measured from the erf boundary.' : 'Off: every cable runs the Corridor distance inside the boundary. Switch sections on in the editor.'}</div>
        <div style="display:flex;gap:4px;flex-wrap:wrap"><button type="button" class="plan-btn" data-act="secedit">Edit sections…</button><button type="button" class="plan-btn" data-act="secdraw" aria-pressed="${!!this.secDraw}"${this.secDraw ? ' style="outline:2px solid var(--accent,#2563eb)"' : ''}>${this.secDraw ? 'Stop drawing' : 'Draw section line'}</button></div></div>`;
    const q = (this.q || '').trim().toLowerCase(), words = q.split(/\s+/).filter(Boolean);
    const hay = (gname, row) => (gname + ' ' + (row[1] === 'select' ? row[3] + ' ' + row[2].map(o => o[1]).join(' ') : row[1] === 'check' ? row[2] : row[6]) + ' ' + (this.TIPS[row[0]] || '')).toLowerCase();
    const hits = words.length ? [...this.CTRL.flatMap(([gn, rows]) => rows.filter(rw => words.every(w => hay(gn, rw).includes(w))).map(rw => ({ gn, h: ctrl(rw) }))),
      ...this.TREN.filter(rw => words.every(w => ('trenches ' + (rw[1] === 'select' ? rw[3] : rw[1] === 'check' ? rw[2] : rw[6])).toLowerCase().includes(w))).map(rw => ({ gn: 'Trenches', h: tctrl(rw) }))] : [];
    const searchBox = `<input type="search" data-q aria-label="Find a setting" placeholder="Find a setting: crossings, strings, manholes…" value="${esc(this.q || '')}" style="width:100%;box-sizing:border-box;padding:6px 8px">`;
    const searchRes = `<div style="display:flex;flex-direction:column;gap:8px">${hits.length ? hits.map(x => `<div><div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em">${esc(x.gn)}</div>${x.h}</div>`).join('') : '<div style="color:var(--text-muted)">No setting matches that.</div>'}</div>`;
    const step3 = words.length ? `${searchBox}${searchRes}` : `${searchBox}<div><div style="font-weight:600;margin-bottom:3px">What matters most</div><div style="display:grid;grid-template-columns:repeat(2,1fr);gap:3px">${Object.keys(this.PRESETS).map(k => pBtn(k, this.PRESET_NAMES[k])).join('')}${pBtn('custom', 'Custom')}</div><div style="font-size:12px;color:var(--text-muted);margin-top:3px">${preset === 'custom' ? 'Your own mix of the settings below.' : this.PRESET_HINT[preset]}</div></div>
        ${this.admdHtml()}
        ${secBlock}
        <div style="font-weight:600">Most used</div>
        <div style="display:flex;flex-direction:column;gap:8px">${ctrl(kRow('n'))}${ctrl(kRow('maxc'))}${ctrl(kRow('strN'))}${ctrl(kRow('strL'))}${vdTx}${vdLv}</div>
        <details><summary style="cursor:pointer;font-weight:600">Advanced <span style="font-weight:400;font-size:12px;color:var(--text-muted)">6 groups · ${nChanged} changed</span></summary><div style="display:flex;flex-direction:column;gap:4px;padding-top:4px">${groups}${trenchGroup}${vdGroup}</div></details>
        <div style="font-size:12px;color:var(--text-muted)">${r ? 'The layout runs again when you change a setting.' : 'Nothing is drawn while you choose.'}</div>`;
    // ── step 4: review
    const split = t => { const i = t.search(/[.:] /); if (i > 8 && i <= 150) return [t.slice(0, i), t.slice(i + 1).trim()]; return t.length <= 150 ? [t, ''] : [t.slice(0, 130) + '…', t]; };
    const seenAct = new Set(), filt = this.ckFilter || 'all';
    const rank = { fail: 0, warn: 1, info: 2 };
    const shown = ck.map((c, i) => ({ c, i })).filter(x => filt === 'all' || x.c.sev === ({ f: 'fail', w: 'warn', n: 'info' }[filt])).sort((a, b) => rank[a.c.sev] - rank[b.c.sev] || a.i - b.i);
    const rowHtml = ({ c, i }) => { const [title, detail] = split(c.text), key = c.sev + '|' + title, isOpen = this._ckOpen.has(key), col = sevCol[c.sev];
      const acts = (c.acts || []).map((a, j) => ({ a, j })).filter(({ a }) => { const k = a.label; if (c.sev === 'fail' && seenAct.has(k)) return false; seenAct.add(k); return true; });
      const rowsHtml = c.rows ? `<div style="max-height:190px;overflow:auto;margin-top:2px">${c.rows.map(x => { const g = x.g;
        const why = !g ? 'no street on the plan' : g.near ? `already within reach of ${esc(g.street.name)}: check that its edge is not blocked by another erf` : `${esc(g.street.name)}, ${Math.round(g.d)} m away: ${g.atEnd ? 'extend it' : 'a spur'} ${Math.round(g.len)} m${g.crosses ? ` · <b style="color:#b45309">passes through ${g.crosses} other ${g.crosses === 1 ? 'erf' : 'erven'}</b>` : ''}`;
        return `<div style="display:flex;justify-content:space-between;align-items:center;gap:4px;border-bottom:1px solid var(--border-color,#ddd);padding:2px 0;font-size:12px"><span>${esc(x.name)} · ${why}</span><span style="display:flex;gap:3px;flex-shrink:0"><button type="button" class="plan-btn" data-ckerf="show:${esc(x.id)}" style="padding:1px 6px;font-size:12px"${g ? '' : ' disabled'}>show</button><button type="button" class="plan-btn" data-ckerf="ext:${esc(x.id)}" style="padding:1px 6px;font-size:12px;font-weight:600"${g && !g.near ? '' : ' disabled'}>extend</button><button type="button" class="plan-btn" data-ckerf="mark:${esc(x.id)}" style="padding:1px 6px;font-size:12px;font-weight:600">place marker</button></span></div>`; }).join('')}</div>` : '';
      return `<div style="display:flex;gap:6px;align-items:flex-start;padding:4px 0;border-bottom:1px solid var(--border-color,#ddd)"><span style="flex:none;margin-top:1px;padding:0 5px;border-radius:3px;background:${col};color:#fff;font-size:11px;font-weight:600">${sevTxt[c.sev]}</span><div style="flex:1;min-width:0"><b style="font-weight:600">${esc(title)}</b>${isOpen && detail ? `<div style="font-size:12px;color:var(--text-muted);margin-top:2px">${esc(detail)}</div>` : ''}${isOpen ? rowsHtml : ''}
        <div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:3px">${detail || c.rows ? `<button type="button" class="plan-btn" data-ckopen="${i}" style="${sBtn}">${isOpen ? 'Hide detail' : 'Detail'}</button>` : ''}${c.ids.length ? `<button type="button" class="plan-btn" data-ck="${i}" style="${sBtn}">Show</button>` : ''}${acts.map(({ a, j }) => `<button type="button" class="plan-btn" data-ckact="${i}:${j}" style="${sBtn}${c.sev === 'fail' ? ';font-weight:600' : ''}">${esc(a.label)}</button>`).join('')}</div></div></div>`; };
    const chip = (k, t, on) => `<button type="button" class="plan-btn" data-cf="${k}" aria-pressed="${on}" style="padding:2px 8px;font-size:12px;${on ? 'font-weight:600;outline:2px solid var(--accent,#2563eb)' : ''}">${t}</button>`;
    const cnt = this.edits();
    const modeBtn = (v, t) => `<button type="button" class="plan-btn" data-mode="${v}" aria-pressed="${this.mode === v}" style="padding:3px 8px;font-size:12px${this.mode === v ? ';font-weight:600;outline:2px solid var(--accent,#2563eb)' : ''}">${t}</button>`;
    const served = r ? r.erven.filter(e => e.kiosk).length : 0;
    const keyTiles = st ? [[served, 'erven served'], [st.kiosks, `kiosks, ${st.avgPer.toFixed(1)} erven each`], [r.net.subs.length, 'mini-sub' + (r.net.subs.length === 1 ? '' : 's')], [fmt(st.cableMax) + ' m', 'longest service, limit ' + p.maxc], ...(r.vd && !r.vd.err ? [[r.vd.maxLv.toFixed(1) + '% / ' + r.vd.maxSvc.toFixed(1) + '%', `worst LV feeder / service volt drop, limits ${r.vd.V.limF}% / ${r.vd.V.limS}%`, true]] : [])].map(([b, s, wide]) => `<div style="border:1px solid var(--border-color,#ddd);border-radius:5px;padding:4px 6px${wide ? ';grid-column:span 2' : ''}"><b style="font-size:15px;display:block">${b}</b><span style="font-size:11px;color:var(--text-muted)">${s}</span></div>`).join('') : '';
    const verdict = !r ? '' : nFix ? `<div style="border-left:4px solid #dc2626;padding:4px 8px;font-size:13px"><b>${nFix} fix${nFix === 1 ? '' : 'es'}</b> before you create.${nChk + nNote ? ` ${nChk + nNote} other item${nChk + nNote === 1 ? '' : 's'} to read.` : ''}</div>` : `<div style="border-left:4px solid #16a34a;padding:4px 8px;font-size:13px"><b>Nothing to fix.</b>${nChk ? ` ${nChk} to check.` : ''} Ready to create.</div>`;
    const checksHtml = r ? `<div style="font-weight:600;display:flex;justify-content:space-between;align-items:center">Checks${this.flag && this.flag.size ? '<button type="button" class="plan-btn" data-act="unflag" style="padding:1px 8px;font-size:12px;font-weight:400">Clear red marks</button>' : ''}</div>
        <div style="display:flex;gap:4px;flex-wrap:wrap">${chip('all', 'All ' + ck.length, filt === 'all')}${nFix ? chip('f', nFix + ' Fix', filt === 'f') : ''}${nChk ? chip('w', nChk + ' Check', filt === 'w') : ''}${nNote ? chip('n', nNote + (nNote === 1 ? ' Note' : ' Notes'), filt === 'n') : ''}</div>
        <div>${shown.length ? shown.map(rowHtml).join('') : '<div style="color:#15803d">✓ Every erf is served, within the service limit and the kiosk size.</div>'}</div>` : '';
    const aBtn = (v, t, span) => `<button type="button" class="plan-btn" data-mode="${v}" aria-pressed="${this.mode === v}" style="min-height:40px;padding:4px 8px;font-size:13px;${span ? 'grid-column:span 2;' : ''}${this.mode === v ? 'font-weight:700;background:var(--accent,#2563eb);color:#fff;border-color:var(--accent,#2563eb)' : ''}">${t}</button>`;
    const modeText = this.mode === 'marker' ? (this.markFor ? 'Click on the erf where its service cable should arrive.' : 'Click inside an erf the layout cannot place (or one it places wrongly) where its service cable should arrive. Alt-click removes a marker. The cable, kiosk and fibre duct are worked out to it.')
      : this.mode === 'trunk' ? 'Click a trunk duct section to cut it or put it back; click a junction to make it the fibre entry.'
      : this.mode === 'move' ? 'Drag a kiosk, a manhole, an erf marker or any node on a duct or cable route. Shift-click a line to add a node, Alt-click a node to remove it (a kiosk or marker you moved: Alt-click puts it back). A kiosk you move stays where you put it and the rest is worked out around it; the checks run again.'
      : this.mode === 'cross' ? '' : 'Click an erf near the edge you want as its front.';
    const adjust = `<div style="border:2px solid var(--accent,#2563eb);border-radius:8px;padding:8px;display:flex;flex-direction:column;gap:6px;background:rgba(37,99,235,.05)">
        <div style="display:flex;justify-content:space-between;align-items:baseline"><b>Adjust on the plan</b><span style="font-size:12px;color:var(--text-muted)">${cnt} edit${cnt === 1 ? '' : 's'}</span></div>
        <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:5px">${aBtn('front', 'Erf fronts')}${aBtn('marker', 'Erf markers')}${aBtn('trunk', 'Trunk ducts')}${aBtn('move', 'Move parts')}${aBtn('cross', 'Road crossings: move start and end', true)}</div>
        ${modeText ? `<div style="font-size:12px;color:var(--text-muted)">${modeText}</div>` : ''}
        ${this.mode === 'cross' ? this.crossHtml(esc) : ''}
        <button type="button" class="plan-btn" data-act="reset" style="padding:3px 8px;font-size:12px;align-self:flex-start"${cnt ? '' : ' disabled'}>Reset my edits (${cnt})</button></div>`;
    const step4 = !r ? banner('warn', `<span>Nothing to review yet. ${placed.length ? 'Press Run layout below.' : 'Place a mini-sub first.'}</span>${this.err ? `<span style="color:#dc2626">${esc(this.err)}</span>` : ''}`)
      : `${this.stale ? banner('warn', '<span><b>↻ Changed since the last run.</b> The figures below are from before.</span><span><button type="button" class="plan-btn" data-act="run" style="' + sBtn + ';font-weight:600">Re-run</button></span>') : ''}
        ${noKiosks ? blocked : `${verdict}${adjust}<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:5px">${keyTiles}</div>
        ${checksHtml}
        <details><summary style="cursor:pointer;font-weight:600">More figures <span style="font-weight:400;font-size:12px;color:var(--text-muted)">crossings, ducts, trenches, LV design</span></summary><div style="display:flex;flex-direction:column;gap:6px;padding-top:4px"><div style="display:grid;grid-template-columns:repeat(2,1fr);gap:5px">${tiles}</div>
        ${designBlock}
        ${r.vdBusy || r.earthBusy ? '<div style="color:var(--text-muted)">Checking the voltage drop and earth-fault loop with Demand…</div>' : ''}
        ${r.vd && !r.vd.err && r.vd.worst ? `<div><b>Voltage drop</b><div>Furthest: erf ${esc(((AppState.planMarkup.elements.find(e => e.id === r.vd.worst.erf.id) || {}).name) || r.vd.worst.erf.id)}, ${r.vd.worst.total.toFixed(1)}% = ${r.vd.worst.lv.toFixed(1)}% LV (to ${esc(r.vd.worst.kiosk.id)}) + ${r.vd.worst.svc.toFixed(1)}% service</div>${r.vd.legs.slice().sort((a, b) => b.cum - a.cum).slice(0, 5).map(l => `<div style="display:flex;justify-content:space-between;gap:8px"><span>${esc(l.from.id)} → ${esc(l.to.id)} · ${Math.round(l.len)} m · ${Math.round(l.amps)} A</span><span>${l.pct.toFixed(2)}% (to here ${l.cum.toFixed(1)}%)</span></div>`).join('')}</div>` : ''}
        ${r.trench ? `<div><b>Trenches</b>${trenchRows}</div>` : ''}
        <div style="max-height:170px;overflow:auto"><table style="width:100%;font-size:12px;border-collapse:collapse"><thead><tr><th style="text-align:left">Crossing</th><th style="text-align:left">Ducts</th></tr></thead><tbody>${xt}</tbody></table></div>
        <div style="color:var(--text-muted)">Solved in ${Math.round(this.ms)} ms.</div></div></details>`}`;
    // ── the footer: one button that does the next thing
    const act = this.nextAction(r, placed, noKiosks, nErv, sr0.length), co = this.createCounts();
    const chkO = (k, t, n) => `<label style="display:flex;gap:6px;align-items:flex-start"><input type="checkbox" data-opt="${k}"${opt[k] ? ' checked' : ''}> <span>${t} <em style="font-style:normal;font-family:var(--font-mono,monospace);font-size:12px;color:var(--text-muted)">${n}</em></span></label>`;
    const nOpt = Object.values(opt).filter(Boolean).length;
    const createOpts = act.create ? `<details style="font-size:12px"><summary style="cursor:pointer;font-weight:600">What it will create <span style="font-weight:400;color:var(--text-muted)">${nOpt} of ${Object.keys(opt).length} ticked</span></summary><div style="display:flex;flex-direction:column;gap:2px;padding:4px 0">${chkO('markers', 'Erf markers moved to their corner', co.markers)}${chkO('kiosks', 'Kiosks and service cables', co.kiosks)}${chkO('lv', 'Mini-subs and LV feeders', co.lv)}${chkO('fibre', 'Fibre manholes and ducts', co.fibre)}${chkO('cross', 'Road crossings, one per duct', co.cross)}${chkO('trench', 'Trenches along the routes (depth and sharing as set)', co.trench)}</div></details>` : '';
    const footer = `<div style="position:sticky;bottom:-10px;margin:0 -10px -10px;padding:8px 10px;background:var(--bg-primary);border-top:1px solid var(--border-color,#ddd);display:flex;flex-direction:column;gap:5px;z-index:2">${this.lastRunHtml()}${createOpts}<button type="button" class="plan-btn" data-act="${escHtml(act.act)}"${act.s ? ` data-s="${act.s}"` : ''} aria-disabled="${!!act.dis}" style="font-weight:600;padding:9px;${act.dis ? 'opacity:.65' : (act.create ? 'background:var(--accent,#2563eb);color:#fff' : '')}">${esc(act.label)}</button>${act.note ? `<div style="color:var(--text-muted);font-size:12px;text-align:center">${esc(act.note)}</div>` : ''}${r ? `<button type="button" class="plan-btn" data-act="clear" style="align-self:center;padding:1px 8px;font-size:12px;font-weight:400">Clear the result</button>` : ''}</div>`;
    el.innerHTML = `<div class="plan-props-title" style="margin-bottom:6px">Auto layout</div>
      <div class="plan-props-body" style="display:flex;flex-direction:column;gap:10px;font-size:13px">
        ${stepBar}
        ${this.err && this.step !== 4 ? `<div style="color:#dc2626">${esc(this.err)}</div>` : ''}
        ${[step1, step2, step3, step4][this.step - 1]}
        ${footer}
      </div>`;
    { const qi = el.querySelector('[data-q]'); if (qi && this._qf) { this._qf = false; qi.focus(); const n = qi.value.length; qi.setSelectionRange(n, n); } }
    // the panel is redrawn after every change: keep the sections the user opened open (by their heading)
    const openSet = this._openSec || (this._openSec = new Set());
    el.querySelectorAll('details').forEach(d => {
      const sm = d.querySelector(':scope > summary'); if (!sm) return;
      const key = this.step + ':' + ((sm.firstChild && sm.firstChild.textContent) || sm.textContent).trim();
      if (openSet.has(key)) d.open = true;
      d.addEventListener('toggle', () => { if (d.open) openSet.add(key); else openSet.delete(key); });
    });
    el.onclick = (e) => {
      const b = e.target.closest('[data-act],[data-mode],[data-side],[data-ck],[data-ckact],[data-ckerf],[data-step],[data-preset],[data-cf],[data-ckopen],[data-xsel]'); if (!b) return;
      if (b.dataset.xsel) { this.selX = b.dataset.xsel; const c = this.result && this.result.net.cross.find(q => q.key === this.selX); if (c) { const [A, B] = this._xEnds(c), f2 = this.f; PlanEngine.zoomToPoints([A, B].map(q => ({ x: q[0] / f2, y: q[1] / f2 }))); } PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true }); return; }
      if (b.dataset.act === 'xreset') { const c = this.result && this.result.net.cross.find(q => q.key === this.selX); if (c && L.moves.xs[c.key]) { delete L.moves.xs[c.key]; this.touched(true); } return; }
      if (typeof PlanReserveUI !== 'undefined' && b.dataset.act && b.dataset.act.startsWith('rs-') && PlanReserveUI.act(b)) return;
      if (b.dataset.step) { this.setStep(+b.dataset.step); return; }
      if (b.dataset.preset) { this.setPreset(b.dataset.preset); return; }
      if (b.dataset.cf) { this.ckFilter = b.dataset.cf; PlanMarkup.refreshProps(); return; }
      if (b.dataset.ckopen != null) { const c = (this._ck || [])[+b.dataset.ckopen]; if (c) { const [t] = (() => { const i = c.text.search(/[.:] /); return [i > 8 && i <= 150 ? c.text.slice(0, i) : (c.text.length <= 150 ? c.text : c.text.slice(0, 130) + '…')]; })(), k = c.sev + '|' + t; if (this._ckOpen.has(k)) this._ckOpen.delete(k); else this._ckOpen.add(k); PlanMarkup.refreshProps(); } return; }
      if (b.dataset.act === 'goto') { this.setStep(+b.dataset.s); return; }
      if (b.dataset.act === 'zoomerven' || b.dataset.act === 'zoomstreets') { const pm = AppState.planMarkup, pts = []; if (b.dataset.act === 'zoomerven') pm.elements.forEach(x => { if (x.type === 'erf' && Array.isArray(x.boundary)) x.boundary.forEach(q => pts.push({ x: q.x, y: q.y })); }); else this.streetsOnPlan().forEach(x => this._flat(x).forEach(q => pts.push({ x: q.x, y: q.y }))); if (pts.length) PlanEngine.zoomToPoints(pts); return; }
      if (b.dataset.act === 'showerven') { const r0 = this.result; if (!r0) return; const ids = new Set(r0.erven.filter(x => !x.fe).map(x => x.id)); this.flag = ids; const pts = []; r0.erven.forEach(x => { if (ids.has(x.id)) x.poly.forEach(q => pts.push({ x: q[0] / this.f, y: q[1] / this.f })); }); if (pts.length) PlanEngine.zoomToPoints(pts); PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true }); return; }
      if (b.dataset.act === 'secedit') { PlanSectionsUI.open(); return; }
      if (b.dataset.act === 'secdraw') { this.secDrawOn(!this.secDraw, L.sections.def); return; }
      if (b.dataset.act === 'drawfix') { this.setStep(1); this.streetDrawOn(true); return; }
      if (b.dataset.act === 'submove') { const i = +b.dataset.i; if (L.subs[i]) { this.subMove = i; this.mode = 'sub'; UI.toast('Click where this mini-sub should stand.', 'info', 3500); PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true }); } return; }
      if (b.dataset.act === 'fromrates') { const f = this.ratesFigures(); if (f) { p.worth = f.worth; p.xpen = f.xpen; this.touched(); } return; }
      if (b.dataset.act === 'resetone') { const k = b.dataset.k; p[k] = refOf(k); this.touched(); return; }
      if (b.dataset.act === 'resetgrp') {
        const g = b.dataset.g, grp = this.CTRL.find(x => x[0] === g);
        if (grp) { grp[1].forEach(x => { if (!MOST.includes(x[0])) p[x[0]] = dflt[x[0]]; }); this.touched(); }
        else if (g === 'Trenches') { const T0 = PlanLayout.TRENCH_DEFAULTS; TT.depth.lv = T0.depth.lv; TT.depth.fi = T0.depth.fi; TT.fibre = T0.fibre; TT.crossings = T0.crossings; this.retrench(); }
        else { Object.assign(VDc, vdDef); this.vdRun(); }
        return;
      }
      if (b.dataset.ckerf != null) { const [kind, ...rest] = b.dataset.ckerf.split(':'), id = rest.join(':'); if (kind === 'show') this.nearShow(id); else if (kind === 'mark') this.markStart(id); else this.extendErven([id]); return; }
      if (b.dataset.ckact != null) {
        const [i, j] = b.dataset.ckact.split(':').map(Number), a = (((this._ck || [])[i] || {}).acts || [])[j]; if (!a) return;
        if (a.act === 'tx') { L.vd.tx = a.val; this.revd(); }
        else if (a.act === 'extendall') { this.extendErven(a.val || []); }
        else if (a.act === 'resetmarkers') { this.cfg().markers = {}; this.markFor = null; this.touched(); }
        else if (a.act === 'addsub') { this.setStep(2); UI.toast('Click where the next mini-sub should stand. The kiosks go to the nearest one.', 'info', 5000); PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true }); }
        else if (a.act === 'maxsize') { L.vd.maxSize = +a.val || 0; this.vdRun(); }
        else if (a.act === 'clearsize') { L.vd.minSize = 0; L.vd.maxSize = 0; this.vdRun(); }
        else if (a.act === 'split') { const k = this.result && this.result.kiosks.find(x => x.id === a.val); if (k) { L.vd.splits.push({ x: k.x / this.f, y: k.y / this.f }); this.touched(); } }
        return;
      }
      if (b.dataset.ck != null) {
        const c = (this._ck || [])[+b.dataset.ck], f = this.f, ids = new Set(c ? c.ids : []);
        this.flag = ids;
        const pts = []; (this.result ? this.result.erven : []).forEach(x => { if (ids.has(x.id)) x.poly.forEach(q => pts.push({ x: q[0] / f, y: q[1] / f })); });
        if (pts.length) PlanEngine.zoomToPoints(pts);
        PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true }); return;
      }
      if (b.dataset.act === 'unflag') { this.flag = null; this.nearHint = null; PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true }); return; }
      if (b.dataset.act === 'kerbstreets') { this.streetDrawOn(false); const sel = el.querySelector('[data-stl]'), x = lyr[sel ? +sel.value : 0]; this.kerbStart(); return; }
      if (b.dataset.act === 'subrm') { const L2 = this.cfg(); L2.subs.splice(+b.dataset.i, 1); this.subMove = null; this.touched(); return; }
      if (b.dataset.act === 'streetdraw') { this.streetDrawOn(!this.drawStreets); return; }
      if (b.dataset.act === 'centrepick') { this.streetDrawOn(false); const sel = el.querySelector('[data-stl]'), x = lyr[sel ? +sel.value : 0]; if (x) this.centreStart(x.d.id, x.layer); return; }
      if (b.dataset.act === 'centrecreate') { this.centreCreate(); return; }
      if (b.dataset.act === 'centrecancel') { this.centreCancel(); return; }
      if (b.dataset.act === 'centrerm') { const S = this.centreStage; if (S) { S.picks.splice(+b.dataset.i, 1); PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true }); } return; }
      if (b.dataset.act === 'kerbcreate') { this.kerbCreate(); return; }
      if (b.dataset.act === 'kerbcancel') { this.kerbCancel(); return; }
      if (b.dataset.act === 'kerbshow') { const S = this.kerbStage; if (S) { const l = b.dataset.l, ids = b.dataset.i != null ? [{ layer: l, chain: +b.dataset.i }] : S.lonely, pts = []; ids.forEach(x => S.layers[x.layer][x.chain].pts.forEach(q => pts.push({ x: q[0] / S.f, y: q[1] / S.f }))); if (pts.length) PlanEngine.zoomToPoints(pts); } return; }
      if (b.dataset.act === 'kerbone') { this.kerbOne(b.dataset.l, +b.dataset.i); return; }
      if (b.dataset.act === 'kerbpair') { this.kerbPair(b.dataset.l, +b.dataset.i); return; }
      if (b.dataset.act === 'kerbmode') { this.kerbMode(b.dataset.m); return; }
      if (b.dataset.act === 'kerbundo') { const S = this.kerbStage; if (S) S.undo(); this.syncHint(); PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true }); return; }
      if (b.dataset.act === 'kerbrmpick') { const S = this.kerbStage; if (S) S.removePick(+b.dataset.i); PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true }); return; }
      if (b.dataset.act === 'kerbpairall') {
        const S = this.kerbStage, sel = el.querySelector('[data-stl]'), x = lyr[sel ? +sel.value : 0]; if (!S || !x) return;
        const key = x.d.id + '|' + x.layer; if (!S.layers[key]) { UI.toast(`Layer "${x.layer}" has no lines.`, 'warn', 3000); return; }
        const r = S.pairAll(key); UI.toast(r.noop ? 'That layer is already paired.' : `${r.added} street${r.added === 1 ? '' : 's'} found${S.lonely.length ? `; ${S.lonely.length} kerb chain${S.lonely.length === 1 ? '' : 's'} without a partner (red)` : ''}.`, r.noop ? 'info' : 'success', 5000);
        PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true }); return;
      }
      if (b.dataset.act === 'kerbjoin') { const S = this.kerbStage; if (S) { const n = S.join(this.kerbOpt.join), c = S.networks().length; UI.toast(n ? `${n} join${n === 1 ? '' : 's'} made; ${c === 1 ? 'one connected network now' : c + ' networks remain (the gaps are wider than ' + this.kerbOpt.join + ' m)'}.` : `Nothing within ${this.kerbOpt.join} m to join.`, c === 1 ? 'success' : 'warn', 5000); PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true }); } return; }
      if (b.dataset.act === 'dxfstreets') { const sel = el.querySelector('[data-stl]'), x = lyr[sel ? +sel.value : 0]; if (x) this.streetsFromLayer(x.d.id, x.layer); }
      else if (b.dataset.act === 'run') { this.run(); if (this.result) this.setStep(4); }
      else if (b.dataset.act === 'admdok') { this.admdConfirm(); PlanMarkup.refreshProps(); }
      else if (b.dataset.act === 'create') this.commit();
      else if (b.dataset.act === 'clear') this.clear();
      else if (b.dataset.act === 'reset') { L.fronts = {}; L.markers = {}; L.cuts = []; delete L.entry; L.moves = { kiosks: [], verts: {}, adds: [], cuts: [], xs: {} }; this.selX = null; this.markFor = null; this._drag = null; this.touched(true); }
      else if (b.dataset.mode) { this.mode = b.dataset.mode; this.markFor = null; PlanMarkup.refreshProps(); }
      else if (b.dataset.side) { const o = L.sides[b.dataset.side] = L.sides[b.dataset.side] || {}, v = +b.dataset.val; if (v === 0) delete o[b.dataset.key]; else o[b.dataset.key] = v; this.touched(); }
    };
    const setT = (k, v) => { if (k.startsWith('depth.')) TT.depth[k.slice(6)] = v; else TT[k] = v; };
    el.oninput = (e) => {
      if (e.target.dataset.q != null) { this.q = e.target.value; this._qf = true; clearTimeout(this._tq); this._tq = setTimeout(() => PlanMarkup.refreshProps(), 120); return; }
      const vk = e.target.dataset.vd;
      if (vk === 'protK') { VDc.protK = this._num(e.target.value, 1, 2, 1.2); const lab = el.querySelector('[data-vv="protK"]'); if (lab) lab.textContent = VDc.protK.toFixed(2); clearTimeout(this._tv); this._tv = setTimeout(() => this.revd(), 150); return; }
      const tk = e.target.dataset.t;
      if (tk && e.target.type === 'range') { const v = parseFloat(e.target.value); setT(tk, v); const lab = el.querySelector(`[data-tv="${tk}"]`); if (lab) lab.textContent = v.toFixed(2) + ' m'; clearTimeout(this._tt); this._tt = setTimeout(() => this.retrench(), 120); return; }
      const t = e.target, k = t.dataset.p; if (!k || t.type !== 'range') return;
      p[k] = parseFloat(t.value); const nb = el.querySelector(`[data-pn="${k}"]`); if (nb) nb.value = p[k];
      clearTimeout(this._t); this._t = setTimeout(() => this.touched(), 150);
    };
    el.onchange = (e) => {
      const t = e.target;
      if (typeof PlanReserveUI !== 'undefined' && PlanReserveUI.change(t)) return;
      if (t.dataset.admd) { this.setAdmd(t.dataset.admd, t.value); return; }
      if (t.hasAttribute && t.hasAttribute('data-xsq')) { this.cfg().xsq = t.checked; PlanMarkup.markDirty(); PlanMarkup.refreshProps(); return; }
      if (t.dataset.xf) { const c = this.result && this.result.net.cross.find(q => q.key === this.selX); if (c) this.setCross(c, t.dataset.xf, t.value); return; }
      if (t.dataset.copt) { const v = parseFloat(t.value); if (isFinite(v) && v > 0) this.centreW = v; return; }
      if (t.hasAttribute && t.hasAttribute('data-kany')) { const S = this.kerbStage; if (S) { S.setAnyLayer(t.checked); PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true }); } return; }
      if (t.dataset.kopt) { const v = parseFloat(t.value); if (isFinite(v)) { this.kerbOpt[t.dataset.kopt] = v; if (this.kerbStage) { if (t.dataset.kopt === 'join' || t.dataset.kopt === 'oneW') this.kerbStage.o = Object.assign({}, this.kerbStage.o, this.kerbOpt); else this.kerbSolve(); } } return; }
      if (t.dataset.vd) {
        if (t.type === 'range') return;
        if (t.type === 'checkbox') { VDc[t.dataset.vd] = t.checked; this.vdRun(); return; }   // the design is worked out again
        VDc[t.dataset.vd] = t.value;
        if (this._designOn()) this.vdRun(); else this.revd(); return;                         // the design depends on the transformer, the breakers and the cable picked
      }
      if (t.dataset.t && t.type !== 'range') {
        const k = t.dataset.t;
        if (k === 'combOn') TT.depth.comb = t.checked ? Math.max(TT.depth.mv, TT.depth.lv) : null;
        else setT(k, t.type === 'checkbox' ? t.checked : t.value);
        this.retrench(); return;
      }
      if (t.dataset.pn) {                                                          // a number typed beside a slider
        const k = t.dataset.pn, v = parseFloat(t.value), lo = +t.min, hi = +t.max, st = +t.step || 1;
        if (!Number.isFinite(v)) { t.value = p[k]; return; }
        p[k] = Math.round(Math.max(lo, Math.min(hi, Math.round(v / st) * st)) * 1e4) / 1e4; t.value = p[k];
        const sl = el.querySelector(`input[type=range][data-p="${k}"]`); if (sl) sl.value = p[k];
        this.touched(); return;
      }
      if (t.dataset.tn) { p[t.dataset.tn] = t.checked ? +t.dataset.def : 0; this.touched(); return; }
      if (t.dataset.opt) { opt[t.dataset.opt] = t.checked; return; }
      const k = t.dataset.p; if (!k || t.type === 'range') return;
      p[k] = t.type === 'checkbox' ? t.checked : t.value; this.touched();
    };
    this.syncHint(); this._syncBar();
  },
};

if (typeof PlanTools !== 'undefined') {
  PlanTools.register({
    id: 'layout', cursor: 'crosshair',
    onActivate() {
      PlanLayoutUI._active = true; PlanLayoutUI.widen(true);
      PlanLayoutUI.step = PlanLayoutUI.firstStep();
      PlanLayoutUI.mode = PlanLayoutUI.step === 2 ? 'sub' : 'front';
      if (typeof PlanMarkup !== 'undefined') PlanMarkup.refreshProps();
    },
    onDeactivate() { { const b = document.getElementById('pl-adjust-bar'); if (b) b.remove(); } PlanLayoutUI.secDraw = null; PlanLayoutUI._active = false; PlanLayoutUI.widen(false); PlanLayoutUI.hoverT = null; PlanLayoutUI.kerbStage = null; PlanLayoutUI.centreStage = null; if (typeof PlanReserveUI !== 'undefined') PlanReserveUI.stage = null; if (PlanLayoutUI.drawStreets) PlanLayoutUI.streetDrawOn(false); },
    cancel() { PlanTools.set('select'); },
    onMove(pt, e) {
      if (PlanLayoutUI._drag && PlanLayoutUI.moveMove(pt)) return;
      if (typeof PlanReserveUI !== 'undefined' && PlanReserveUI.stage) { PlanReserveUI.move(pt, e); return; }
      if (PlanLayoutUI.kerbStage && !PlanLayoutUI.secDraw && !PlanLayoutUI.drawStreets) { PlanLayoutUI.kerbMove(pt, e); return; }
      if (PlanLayoutUI.secDraw) { PlanLayoutUI._secHover = PlanTools.snap(pt, { wantElements: false }); PlanEngine.requestDraw({ fg: true }); return; }
      if (PlanLayoutUI.drawStreets) { const R = PlanLayoutUI._rt(); if (R) { R._hover = PlanTools.snap(pt, { wantElements: false }); PlanEngine.requestDraw({ fg: true }); } return; }
      if (PlanLayoutUI.mode !== 'trunk' || !PlanLayoutUI.result) return;
      const h = PlanLayoutUI._pickT([pt.x * PlanLayoutUI.f, pt.y * PlanLayoutUI.f]);
      if ((h && h.edge) !== (PlanLayoutUI.hoverT && PlanLayoutUI.hoverT.edge)) { PlanLayoutUI.hoverT = h; PlanEngine.requestDraw({ fg: true }); }
    },
    onUp() { if (PlanLayoutUI.moveUp()) return; if (typeof PlanReserveUI !== 'undefined') PlanReserveUI.up(); },
    onDown(pt, e) { if (typeof PlanReserveUI !== 'undefined' && PlanReserveUI.stage) PlanReserveUI.down(pt, e); else if (PlanLayoutUI.secDraw) PlanLayoutUI.secDown(pt); else if (PlanLayoutUI.drawStreets) PlanLayoutUI.streetDown(pt); else if (PlanLayoutUI.centreStage) PlanLayoutUI.centreClick(pt, e); else if (PlanLayoutUI.kerbStage) PlanLayoutUI.kerbClick(pt, e); else PlanLayoutUI.click(pt, e); },
    drawOverlay(ctx, zoom) { PlanLayoutUI.draw(ctx, zoom); if (PlanLayoutUI.drawStreets) { const R = PlanLayoutUI._rt(); if (R) R.drawOverlay(ctx, zoom); } },
    keyFirst(e) { return PlanLayoutUI.secDraw ? PlanLayoutUI.secKey(e) : PlanLayoutUI.drawStreets ? PlanLayoutUI.streetKey(e) : (PlanLayoutUI.kerbStage && e.key === 'Backspace') ? PlanLayoutUI.kerbKey(e) : (typeof PlanReserveUI !== 'undefined' && PlanReserveUI.stage && (e.key === 'Backspace')) ? PlanReserveUI.key(e) : false; },
    get _draft() { const R = PlanLayoutUI.drawStreets && PlanLayoutUI._rt(); return R && R._draft ? R._draft : null; },
    onKey(e) {
      if (PlanLayoutUI.secDraw && PlanLayoutUI.secKey(e)) return true;
      if (PlanLayoutUI.drawStreets && PlanLayoutUI.streetKey(e)) return true;
      if (PlanLayoutUI.centreStage && e.key === 'Enter') { PlanLayoutUI.centreCreate(); return true; }
      if (typeof PlanReserveUI !== 'undefined' && PlanReserveUI.stage && PlanReserveUI.key(e)) return true;
      if (PlanLayoutUI.kerbStage && PlanLayoutUI.kerbKey(e)) return true;
      if (e.key === 'Escape') { if (PlanLayoutUI.centreStage) PlanLayoutUI.centreCancel(); else if (PlanLayoutUI.kerbStage) PlanLayoutUI.kerbCancel(); else if (PlanLayoutUI.markFor) { PlanLayoutUI.markFor = null; PlanLayoutUI.flag = null; PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true }); } else this.cancel(); return true; }
      return false;
    },
  });
}
