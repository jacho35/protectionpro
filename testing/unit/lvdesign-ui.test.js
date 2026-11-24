// The Auto layout's LV design end to end: the app's own JS (constants, cable library, Retic, plan sync, layout engine, Auto layout UI) in a
// node sandbox, with the three API calls (Demand's ADMD, the earth-fault check, the LV design) answered by the real Python engines.
//   node testing/unit/lvdesign-ui.test.js        (skips itself when python3 + the backend's packages are not there)
const assert = require('assert'), fs = require('fs'), vm = require('vm'), cp = require('child_process'), path = require('path');
const ROOT = path.resolve(__dirname, '../..'), JS = path.join(ROOT, 'frontend/js') + '/';
const py = cp.spawnSync('python3', ['-c', 'import numpy, scipy'], { cwd: ROOT });
if (py.status !== 0) { console.log('skipped: python3 with numpy / scipy is not available'); process.exit(0); }
let n = 0; const queue = []; const ok = (name, fn) => queue.push([name, fn]);

function sandbox() {
  const counts = { admd: 0, earth: 0, design: 0 }, toasts = [];
  const bridge = (kind, body) => JSON.parse(cp.execFileSync('python3', [path.join(__dirname, 'lvdesign-bridge.py')], { input: JSON.stringify({ kind, body }), maxBuffer: 1 << 28 }).toString());
  const el = () => new Proxy(function () {}, { get: (t, k) => k === Symbol.toPrimitive ? () => '' : el(), set: () => true, apply: () => el() });
  const ctx = { console, Map, Set, Math, JSON, Number, parseFloat, isFinite, String, Array, Object, Promise, setTimeout, clearTimeout, Date, performance: { now: () => Date.now() }, localStorage: { getItem: () => null, setItem() {} }, escHtml: x => String(x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, createElement: () => el(), body: el() }, navigator: {} };
  ctx.globalThis = ctx; ctx.window = ctx; vm.createContext(ctx);
  const load = f => vm.runInContext(fs.readFileSync(JS + f, 'utf8').replace(/^const (\w+) = /gm, 'var $1 = '), ctx, { filename: f });
  let seq = 1;
  const AS = ctx.AppState = { planMarkup: { routes: [], elements: [], settings: { domain: 'retic' }, crossings: [], trenches: [] }, reticulation: { settings: {}, minisubs: [], kiosks: [], nextId: 1 }, planGenId: p => p + '_' + (seq++), dirty: false, frequency: 50,
    reticGenMinisubId: () => 'minisub_' + (seq++), reticGenErfId: () => 'erf_' + (seq++), reticGenLoadId: () => 'load_' + (seq++), reticGenKioskId: () => 'kiosk_' + (seq++),
    planAllElements: () => AS.planMarkup.elements, planAllRoutes: () => AS.planMarkup.routes, planFloors: [], planEntityFloorMap: () => new Map(), planActiveFloor: () => null };
  ctx.UI = { toast: m => toasts.push(m), confirm: async () => true, alert: async () => {} };
  let nm = 0; ctx.PlanMarkup = { snapshot() {}, refreshProps() {}, markDirty() {}, nextName: t => t + (++nm), nextCounter: (a, b) => b + (++nm) };
  ctx.PlanEngine = { factor: () => 1, view: { zoom: 1 }, requestDraw() {}, zoomToPoints() {} }; ctx.PlanDxfImport = { list: () => [], dataOf: () => null };
  ctx.API = { request: async () => { throw new Error('no network in the sandbox'); },
    runAdmd: async (settings, kiosks, minisubs) => { counts.admd++; return bridge('admd', { settings, kiosks, minisubs }); },
    runReticEarth: async body => { counts.earth++; return bridge('earth', body); },
    runReticLvDesign: async body => { counts.design++; return bridge('design', body); } };
  for (const f of ['constants.js', 'cablelib.js', 'undonames.js', 'retic.js', 'plan-sync.js', 'plan-defs.js', 'plan-layout.js', 'plan-kerbs.js', 'plan-sections.js', 'plan-sides-ui.js', 'plan-layout-ui.js']) load(f);
  return { ctx, AS, counts, toasts };
}
const F = require('./layout-fixture.js')();

// lay the fixture out, run Demand + the design, return the sandbox
async function run(vdOpts = {}, subs = 1) {
  const S = sandbox(), { ctx, AS } = S, U = ctx.PlanLayoutUI, PL = ctx.PlanLayout;
  AS.planMarkup.elements = F.erven.map(e => ({ id: e.id, type: 'erf', name: e.id, x: 0, y: 0, reticId: null, props: {} }));
  const g = { input: F, params: Object.assign({}, PL.DEFAULTS, { subs }) };
  U._gathered = g; U.f = 1; U.ms = 300; Object.assign(U.cfg().vd, { subsMax: 1 }, vdOpts);
  U.result = PL.solve(g.input, g.params); U.result.trench = PL.trenches(U.result, U.cfg().trench);
  await U.vdRun();
  return Object.assign(S, { U, PL, r: U.result });
}

ok('the design: 80 A ways, a breaker per string, tapered cable, nothing failing, no volt-drop or rating problem', async () => {
  const { U, r } = await run(), D = r.design;
  assert(D && D.ok && D.failCount === 0, 'design ' + (D && D.failCount));
  assert.strictEqual(U._earthFails(r.earth).length, 0);
  assert(r.vd.designed && r.vd.over.length === 0 && r.vd.hotLegs.length === 0, 'volt drop and ratings');
  assert(D.taper.count > 1 && D.taper.savedPct > 0 && D.taper.totalMm2M < D.uniform.totalMm2M);
  assert(D.heads.length >= 1 && D.heads.every(h => h.device && h.device.rating >= h.amps && h.device.rating <= 2.2 * h.amps + 20));
  assert.strictEqual(JSON.stringify(Object.keys(r.prot).sort()), JSON.stringify(D.heads.map(h => h.kioskId).sort()), 'every string head has its breaker in the check');
  const ways = new Set(); for (const k of r.earth.kiosks) for (const e of k.erfs) ways.add(e.loop.device);
  assert.strictEqual(JSON.stringify([...ways]), '["MCCB 80A"]', 'every erf way is the 80 A MCCB');
});

ok('Create saves the tapered cable on each LV route and the breakers on the kiosks; the plan → Demand sync keeps them, saved and reloaded', async () => {
  const { U, AS, ctx, r } = await run(), D = r.design;
  await U.commit();
  const pm = AS.planMarkup, lv = pm.routes.filter(x => x.type === 'lv'), kioskEls = pm.elements.filter(x => x.type === 'kiosk');
  assert.strictEqual(lv.length, r.kiosks.length);
  const want = new Map(D.feeders.map(f => [f.kioskId, f.cable])), elOf = new Map(kioskEls.map((e, i) => [e.id, r.kiosks[i].id]));
  for (const rt of lv) assert.strictEqual(rt.cableType, want.get(elOf.get(rt.toId)), 'route ' + rt.toId);
  assert(new Set(lv.map(x => x.cableType)).size > 1, 'more than one size');
  assert(kioskEls.every(e => e.props.outgoingProtection === 'cb:mccb_80a'));
  AS.planMarkup = JSON.parse(JSON.stringify(pm));                                  // save, reload
  ctx.PlanSync._pushCore({});
  const rows = AS.reticulation.kiosks, byEl = new Map(AS.planMarkup.elements.filter(e => e.type === 'kiosk').map(e => [e.id, e]));
  assert.strictEqual(rows.length, r.kiosks.length);
  for (const rt of AS.planMarkup.routes.filter(x => x.type === 'lv')) {
    const row = rows.find(k => k.id === byEl.get(rt.toId).reticId);
    assert.strictEqual(row.feederCable, rt.cableType, 'the Demand row holds the tapered cable');
    assert.strictEqual(row.feederCable, want.get(elOf.get(rt.toId)));
  }
  assert(rows.every(k => k.outgoingProtection === 'cb:mccb_80a'));
  assert.strictEqual(rows.filter(k => k.protection).length, D.heads.length);
  // a recompute does not put the default back, and a size or a way set by hand is not overwritten
  ctx.PlanSync._pushCore({}); ctx.PlanSync._pushCore({});
  for (const rt of AS.planMarkup.routes.filter(x => x.type === 'lv')) assert.strictEqual(rows.find(k => k.id === byEl.get(rt.toId).reticId).feederCable, rt.cableType);
  const k0 = rows[0], elK0 = AS.planMarkup.elements.find(e => e.reticId === k0.id);
  k0.outgoingProtection = 'cb:mccb_100a'; k0.protection = 'cb:mccb_250a';
  ctx.PlanSync._pushCore({});
  assert.strictEqual(k0.outgoingProtection, 'cb:mccb_100a'); assert.strictEqual(k0.protection, 'cb:mccb_250a');
});

ok('the switches: taper off gives one size, 80 A off leaves the ways to the string breaker, both off is the old behaviour', async () => {
  const off = await run({ taper: false });
  assert(off.r.design && off.r.design.taper.on === false && new Set(off.r.design.feeders.map(f => f.cable)).size === 1);
  const no80 = await run({ way80: false });
  assert(no80.r.design); await no80.U.commit();
  assert(no80.AS.planMarkup.elements.filter(e => e.type === 'kiosk').every(e => !e.props.outgoingProtection));
  const both = await run({ taper: false, way80: false });
  assert.strictEqual(both.r.design, null, 'no design: the earlier uniform-cable path');
  assert(both.r.vd && !both.r.vd.designed);
});

ok('a design that cannot pass says why and offers the fixes; Add a mini-sub and Split the string act on the layout', async () => {
  const { U, r, ctx } = await run();
  const k = r.kiosks[3];
  r.design = Object.assign({}, r.design, { ok: false, failCount: 2, reasons: [{ head: r.kiosks[0].id, headName: 'K6', kiosks: [k.id], text: 'String K6 carries 264 A and needs a MCCB 315A. K3 clears in 5.6 s against 5 s: the cable is already the largest that suits, so a bigger one does not fix it. Add a mini-sub, or split the string at K7.',
    fixes: [{ action: 'addSub', text: 'Add a mini-sub' }, { action: 'split', kiosk: k.id, text: 'Split the string at K7' }] }] });
  const row = U.checks().find(c => /String K6/.test(c.text));
  assert(row && row.sev === 'fail' && row.ids.length === k.members.length);
  assert.strictEqual(JSON.stringify(row.acts.map(a => a.act)), '["addsub","split"]');
  assert.strictEqual(row.acts[1].val, k.id);
});

ok('the panel shows the tile, the table with the taper marks and the switches', async () => {
  const { U, r } = await run();
  U.step = 4; const el = { innerHTML: '', querySelectorAll: () => [], querySelector: () => null }; U.renderOptions(el); const h = el.innerHTML, D = r.design;
  assert(/LV design/.test(h) && new RegExp('LV cable: ' + D.taper.count + ' size').test(h), 'the tile');
  assert(h.includes(`${D.taper.minMm2} to ${D.taper.maxMm2} mm²`) && h.includes(`taper saves ${D.taper.savedPct}%`));
  assert(/<th[^>]*>Kiosk<\/th>.*<th[^>]*>Fed from<\/th>.*<th[^>]*>Cable<\/th>.*<th[^>]*>Breaker<\/th>/.test(h), 'the table');
  assert(/set by taper/.test(h), 'a feeder marked as set by the taper');
  U.step = 3; const el3 = { innerHTML: '', querySelectorAll: () => [], querySelector: () => null }; U.renderOptions(el3); const h3 = el3.innerHTML;
  for (const sw of ['way80', 'taper']) assert(new RegExp(`data-vd="${sw}"[^>]* checked`).test(h3), sw + ' on by default');
  assert(D.heads.every(x => h.includes(x.breaker)));
});

// click a button of the Checks list the way the panel does
async function clickAct(U, textRe, actName) {
  const el = { innerHTML: '', querySelectorAll: () => [], querySelector: () => null }; U.renderOptions(el);
  const i = U._ck.findIndex(c => textRe.test(c.text)), j = i < 0 ? -1 : U._ck[i].acts.findIndex(a => a.act === actName);
  assert(i >= 0 && j >= 0, `no ${actName} button on a row matching ${textRe}`);
  el.onclick({ target: { closest: () => ({ dataset: { ckact: i + ':' + j } }) } });
}

ok('a smallest and a largest LV cable: the cables stay inside, the panel offers the sizes', async () => {
  const { U, r } = await run({ minSize: 50, maxSize: 300 }), D = r.design;
  assert(D && D.ok); assert(D.feeders.every(f => f.sizeMm2 >= 50 && f.sizeMm2 <= 300), 'sizes ' + D.feeders.map(f => f.sizeMm2));
  const both = st => { U.step = st; const e = { innerHTML: '', querySelectorAll: () => [], querySelector: () => null }; U.renderOptions(e); return e.innerHTML; };
  const h = both(3) + both(4);
  assert(/data-vd="minSize"/.test(h) && /data-vd="maxSize"/.test(h) && />No limit</.test(h) && /<option value="50" selected>50 mm²/.test(h) && /<option value="300" selected>300 mm²/.test(h));
  assert(/limited to 50 to 300 mm²/.test(h), 'the tile says so');
});

ok('a largest cable that is too small: the engine names it, the Fix row offers the size that works, and one click makes it pass', async () => {
  const { U, r } = await run({ maxSize: 50 });
  assert(r.design && !r.design.ok && r.design.limits.maxNeededMm2 > 50);
  const row = U.checks().find(c => /too small/.test(c.text) && c.sev === 'fail');
  assert(row, 'a Fix row says the largest size is too small');
  const need = r.design.limits.maxNeededMm2;
  assert(row.acts.some(a => a.act === 'maxsize' && a.val === need) && row.acts.some(a => a.act === 'addsub'));
  await clickAct(U, /too small/, 'maxsize');
  assert.strictEqual(U.cfg().vd.maxSize, need);
  await U.vdRun();
  assert(U.result.design.ok, 'passes with the size allowed'); assert(U.result.design.feeders.every(f => f.sizeMm2 <= need));
});

ok('a range no cable fits is reported, with a way back, and the old check carries on', async () => {
  const { U, r } = await run({ minSize: 240, maxSize: 120 });
  assert.strictEqual(r.design, null); assert(r.designIssue && r.designIssue.reasons[0].kind === 'range');
  const row = U.checks().find(c => /no size fits/.test(c.text)); assert(row && row.sev === 'fail');
  await clickAct(U, /no size fits/, 'clearsize');
  assert.strictEqual(U.cfg().vd.minSize, 0); assert.strictEqual(U.cfg().vd.maxSize, 0);
  await U.vdRun(); assert(U.result.design && U.result.design.ok);
});

ok('kiosks the LV network does not reach: a failing check that names the cause, a warning instead of an earth-fault pass, and the tile says incomplete', async () => {
  const { U, r } = await run();
  assert(!U.checks().some(c => /not joined up|does not reach/.test(c.text)), 'a connected network says nothing about joins');
  const k = r.kiosks[2]; r.net.unreached = [k]; r.net.parts = 2;
  let ck = U.checks();
  const row = ck.find(c => /does not reach/.test(c.text)); assert(row && row.sev === 'fail' && /not joined up \(2 separate road networks\)/.test(row.text));
  assert(!ck.some(c => /checks pass, none fail/.test(c.text)), 'no earth-fault pass is quoted for a partial network');
  r.net.parts = 1; ck = U.checks();
  assert(/the roads are joined, so this is a layout fault/.test(ck.find(c => /does not reach/.test(c.text)).text), 'joined streets are never called not joined');
  U.step = 4; const el = { innerHTML: '', querySelectorAll: () => [], querySelector: () => null }; U.renderOptions(el);
  assert(/Incomplete: 1 kiosk/.test(el.innerHTML), 'the design line says incomplete, not that everything passes');
});

ok('panel: an option that is off by default is a switch, its number shows only while on; the rates option says why it is unavailable; the last run is shown with what changed since', async () => {
  const { U } = await run();
  const draw = st => { U.step = st; const e = { innerHTML: '', querySelectorAll: () => [], querySelector: () => null }; U.renderOptions(e); return e.innerHTML; };
  const p = U.cfg().params; p.strE = 0; p.subBal = 0;
  let h = draw(3);
  assert(/data-tn="strE"(?![^>]*checked)/.test(h) && !/data-p="strE"/.test(h), 'strE off: a switch, no number');
  assert(/data-tn="subBal"(?![^>]*checked)/.test(h) && !/data-p="subBal"/.test(h), 'subBal off: a switch, no number');
  assert(/Not available: the rate library has no price for/.test(h), 'the reason is in the panel, not only a tooltip');
  p.strE = 12; p.subBal = 1.3; U.cfg(); h = draw(3);
  assert(/data-tn="strE"[^>]* checked/.test(h) && /data-p="strE"[^>]*value="12"/.test(h), 'strE on: its number shows');
  assert(/data-p="subBal"[^>]*value="1.3"/.test(h));
  p.strE = 1; p.subBal = 0.4; U.cfg(); assert.strictEqual(U.cfg().params.strE, 2); assert.strictEqual(U.cfg().params.subBal, 1.1, 'a stored value is held within its range');
  U.cfg().params.strE = 0; U._ranParams = JSON.stringify(U.cfg().params);          // what run() records
  assert(/Last run: <b>\d+<\/b> kiosks/.test(draw(3)), 'the footer shows the last result'); assert(!/changed since the last run/.test(draw(3)));
  U.cfg().params.n = (U.cfg().params.n || 6) + 1;
  assert(/1 setting changed since the last run/.test(draw(3)), 'one change is counted');
});

// the layout only (no Demand / Python): for the tests of what the panel does with a result
function lay(subs = 1) {
  const S = sandbox(), { ctx, AS } = S, U = ctx.PlanLayoutUI, PL = ctx.PlanLayout;
  AS.planMarkup.elements = F.erven.map(e => ({ id: e.id, type: 'erf', name: e.id, x: 0, y: 0, reticId: null, props: {} }));
  const g = { input: F, params: Object.assign({}, PL.DEFAULTS, { subs }) };
  U._gathered = g; U.f = 1; U.result = PL.solve(g.input, g.params); U.result.trench = PL.trenches(U.result, U.cfg().trench);
  return Object.assign(S, { U, PL, r: U.result });
}

ok('ADMD is a prerequisite: Run is held until the Demand ADMD settings are confirmed, a change in Demand un-confirms them, and a value typed in Rules counts', async () => {
  const { ctx } = sandbox(); const Uu = ctx.PlanLayoutUI;
  assert(!Uu.admdOk(), 'a project that never confirmed them'); assert.strictEqual(Uu.nextAction(null, [{ x: 1, y: 1 }], false, 5, 2).act, 'goto');
  assert(/Confirm the ADMD/.test(Uu.nextAction(null, [{ x: 1, y: 1 }], false, 5, 2).label));
  Uu.admdConfirm(); assert(Uu.admdOk()); assert.strictEqual(Uu.nextAction(null, [{ x: 1, y: 1 }], false, 5, 2).act, 'run');
  ctx.Retic.settings.admd = (ctx.Retic.settings.admd || 4) + 1; assert(!Uu.admdOk(), 'Demand changed');
  Uu.setAdmd('admd', '3.5'); assert(Uu.admdOk()); assert.strictEqual(ctx.Retic.settings.admd, 3.5);
  assert(/ADMD \(load on the cables\)/.test(Uu.admdHtml()));
});

ok('moved parts: a node dragged, added or removed is applied to every line that shares it, and the lengths follow', async () => {
  const { U, PL, r } = lay(); U.admdConfirm();
  const f = U.f, L = U.cfg(), poly = r.net.lv.find(e => e.pts.length >= 3) || r.net.lv[0];
  U.applyMoves(r); const n0 = U._verts.length; assert(n0 > 0, 'nodes are listed');
  const v = U._verts.find(x => x.interior && x.k); assert(v, 'an interior node');
  const before = JSON.stringify(r.net.lv.map(e => e.pts));
  L.moves.verts[v.k] = { x: v.pos[0] + 3, y: v.pos[1] }; U.cfg();
  const again = PL.solve(U._gathered.input, U._gathered.params); U.result = again; U.applyMoves(again);
  const moved = U._polys(again).filter(pts => pts.some(q => Math.abs(q[0] - (v.pos[0] + 3)) < 1e-6 && Math.abs(q[1] - v.pos[1]) < 1e-6));
  assert(moved.length >= 1, 'the node moved'); assert(moved.length >= 1);
  assert(Math.abs(again.net.lvLen - again.net.lv.reduce((t, e) => t + e.len, 0)) < 1e-6, 'LV length follows');
  // add a node on a segment, then remove it again
  const sg = U._segs[0]; L.moves.adds.push({ id: 'n1', a: sg.a, b: sg.b, x: (sg.pa[0] + sg.pb[0]) / 2 / f, y: (sg.pa[1] + sg.pb[1]) / 2 / f + 2 / f });
  const r3 = PL.solve(U._gathered.input, U._gathered.params); U.result = r3; U.applyMoves(r3); assert(U._verts.some(x => x.add === 'n1'), 'the added node is listed');
  L.moves.adds = []; const r4 = PL.solve(U._gathered.input, U._gathered.params); U.result = r4; U.applyMoves(r4); assert(!U._verts.some(x => x.add));
});

ok('a kiosk moved by hand is pinned: the layout is solved again around it and the move is kept in the project', async () => {
  const { U, PL, r } = lay(); U.admdConfirm();
  const k = r.kiosks[0], to = PL.ptAt(k.road, Math.min(k.road.len - 1, k.s + 9), 0.002), L = U.cfg();
  L.moves.kiosks.push({ from: { x: k.x, y: k.y }, to: { x: to[0], y: to[1] } });
  const g = U._gathered; assert.strictEqual(L.moves.kiosks.length, 1);
  const r2 = PL.solve(Object.assign({}, g.input, { kioskDrops: [[k.x, k.y]], kioskPins: [[to[0], to[1]]] }), g.params); assert(r2.kiosks.some(q => Math.hypot(q.x - to[0], q.y - to[1]) < 1e-6));
  assert.strictEqual(U.edits(), 1); L.moves.kiosks[0].to.x = NaN; assert.strictEqual(U.cfg().moves.kiosks.length, 0, 'a bad stored value is dropped');
});

ok('road crossings: ends can be moved or slid, every cable at that crossing follows, the trench ends and the dashed under-road runs follow too', async () => {
  const { U, PL, r } = lay(); U.admdConfirm(); U.applyMoves(r); U._findCross(r);
  assert(U._xsegs.length > 0 && U._xsegs.some(g => g.kind === 'fi') && U._xsegs.some(g => g.kind === 'svc'), 'runs under the road are found');
  const c = r.net.cross.find(x => !x.prov && x.svc > 0 && x.fib > 0) || r.net.cross.find(x => !x.prov); assert(c && c.key, 'a crossing with a key');
  const L = U.cfg(), f = U.f, t = U._xTan(c);
  const F0 = U.crossFields(c); assert(Math.abs(F0.along - c.s) < 1e-9 && Math.abs(F0.start - (c.hA - c.st.w / 2)) < 1e-9);
  L.moves.xs[c.key] = { a: { x: t[0] * 3 / f, y: t[1] * 3 / f }, b: { x: t[0] * 3 / f, y: t[1] * 3 / f } };       // slid 3 m along the street
  const g = U._gathered, r2 = PL.solve(g.input, g.params); U.result = r2; U.applyMoves(r2); PL.smooth(r2, g.params); U._findCross(r2);
  const c2 = r2.net.cross.find(x => x.key === c.key); assert(c2 && c2.ends, 'the crossing carries its moved ends');
  const [A0, B0] = c2.ends0, [A1, B1] = c2.ends; assert(Math.abs(Math.hypot(A1[0] - A0[0], A1[1] - A0[1]) - 3) < 1e-6 && Math.abs(Math.hypot(B1[0] - B0[0], B1[1] - B0[1]) - 3) < 1e-6);
  const tr = PL.trenches(r2, U.cfg().trench), xt = tr.list.filter(q => q.kind === 'crossing').find(q => Math.hypot(q.pts[0][0] - A1[0], q.pts[0][1] - A1[1]) < 1e-6);
  assert(xt, 'the crossing trench starts at the moved start');
  const before = JSON.stringify(r.erven.filter(e => e.route).slice(0, 80).map(e => e.route)), after = JSON.stringify(r2.erven.filter(e => e.route).slice(0, 80).map(e => e.route));
  assert.notStrictEqual(before, after, 'service routes through that crossing moved');
  // the numbers: start / end distance and station round-trip
  U.setCross(c2, 'start', 1.5); const Fs = U.crossFields(c2); assert(Math.abs(Fs.start - 1.5) < 1e-9, 'start ' + Fs.start); assert(Math.abs(Fs.along - (c2.s + 3)) < 1e-9, 'the slide is kept');
  U.setCross(c2, 'along', c2.s + 5); assert(Math.abs(U.crossFields(c2).along - (c2.s + 5)) < 1e-9);
  U.result = r2; U.selX = c2.key; assert(/Start, from the road edge/.test(U.crossHtml(x => String(x))), 'the editor shows the selected crossing');
  assert.strictEqual(U.edits(), 1, 'one moved crossing is one edit');
  L.moves.xs[c.key].a.x = NaN; assert.strictEqual(Object.keys(U.cfg().moves.xs).length, 0, 'a bad stored value is dropped');
});

ok('stacked parts: the nearest is picked first, a click again at the same spot picks the next one down, and it wraps', async () => {
  const { U, r, toasts, ctx } = lay(); U.admdConfirm(); U.applyMoves(r); ctx.PlanEngine.view.zoom = 20;   // a 0.45 m pick radius
  const k = r.kiosks[0], e0 = r.erven.find(e => e.marker);
  e0.marker = [k.x + 0.3, k.y]; U._verts.push({ t: 'zz', k: 'zz', add: null, pos: [k.x, k.y + 0.4], interior: true });
  const m = [k.x, k.y], kinds = [];
  for (let i = 0; i < 4; i++) kinds.push(U._moveHit(m).kind);
  assert.deepStrictEqual(kinds, ['kiosk', 'marker', 'vert', 'kiosk'], kinds.join());
  assert(toasts.some(t => /3 parts here/.test(t)), 'it says so');
  const far = U._moveHit([k.x + 500, k.y + 500]); assert(!far || far.kind === 'seg', 'nothing near: no part');
  assert.strictEqual(U._pk, null, 'the cycle resets away from the stack');
  const lone = U._moveHit([r.kiosks[1].x, r.kiosks[1].y]); assert.strictEqual(lone.kind, 'kiosk');
});

ok('a moved crossing re-lays the runs through it: ends stay, the crossing moves square, no old bend is left, and it is counted', async () => {
  const { U, PL, r } = lay(); U.admdConfirm(); U.applyMoves(r);
  const c = r.net.cross.filter(x => !x.prov && x.svc > 1).sort((p, q) => q.svc - p.svc)[0] || r.net.cross.find(x => !x.prov && x.svc > 0); assert(c, 'a crossing with services');
  const L = U.cfg(), f = U.f, t = U._xTan(c), st = c.st;
  const crosses = pts => { for (let i = 1; i < pts.length; i++) for (let j = 1; j < st.pts.length; j++) { const h = U._segInter(pts[i - 1], pts[i], st.pts[j - 1], st.pts[j]); if (h && Math.abs(PL.project(st, h[0], h[1]).s - c.s) <= 6) return i; } return 0; };
  const before = r.erven.filter(e => e.route && crosses(e.route)).map(e => ({ id: e.id, route: e.route.map(q => q.slice()) }));
  assert(before.length >= 1, 'services cross it');
  L.moves.xs[c.key] = { a: { x: t[0] * 3 / f, y: t[1] * 3 / f }, b: { x: t[0] * 3 / f, y: t[1] * 3 / f } };
  const g = U._gathered, r2 = PL.solve(g.input, g.params); U.result = r2; U.applyMoves(r2);
  const c2 = r2.net.cross.find(x => x.key === c.key);
  for (const b of before) {
    const n = r2.erven.find(e => e.id === b.id).route, i0 = crosses(b.route), i1 = crosses(n);
    assert.deepStrictEqual(n[0], b.route[0]); assert.deepStrictEqual(n[n.length - 1], b.route[b.route.length - 1]);
    assert(n.length <= b.route.length + 2, 'no leftover bend: ' + b.route.length + ' -> ' + n.length);
    const p0 = b.route[i0 - 1], q0 = b.route[i0], p1 = n[i1 - 1], q1 = n[i1], sh = (x, y) => Math.hypot(x[0] - y[0], x[1] - y[1]);
    assert(Math.abs(sh(p0, p1) - 3) < 0.02 && Math.abs(sh(q0, q1) - 3) < 0.02, 'both ends of the crossing slid 3 m: ' + sh(p0, p1).toFixed(3) + ' / ' + sh(q0, q1).toFixed(3));
    assert(Math.abs((q1[0] - p1[0]) - (q0[0] - p0[0])) < 0.1 && Math.abs((q1[1] - p1[1]) - (q0[1] - p0[1])) < 0.1,   /* the street bends a little over 3 m */ 'still the same crossing vector: square stays square ' + [q1[0] - p1[0] - (q0[0] - p0[0]), q1[1] - p1[1] - (q0[1] - p0[1])].map(x => x.toFixed(3)));
  }
  assert.strictEqual(c2.relaid.svc, before.length, 'every service run is counted'); assert(c2.relaid.fi + c2.relaid.lv >= 0);
  // sliding it back the other way (a cut-back stretch) also leaves ends and count in order
  L.moves.xs[c.key] = { a: { x: -t[0] * 4 / f, y: -t[1] * 4 / f }, b: { x: -t[0] * 4 / f, y: -t[1] * 4 / f } };
  const r3 = PL.solve(g.input, g.params); U.result = r3; U.applyMoves(r3);
  for (const b of before) { const n = r3.erven.find(e => e.id === b.id).route; assert.deepStrictEqual(n[0], b.route[0]); assert.deepStrictEqual(n[n.length - 1], b.route[b.route.length - 1]); assert(n.length <= b.route.length + 2); }
  assert(r3.erven.every(e => !e.route || e.route.every(q => isFinite(q[0]) && isFinite(q[1]))), 'no broken points');
  // the square option
  assert.strictEqual(U.cfg().xsq, true); U.cfg().xsq = false; assert.strictEqual(U.cfg().xsq, false); U.cfg().xsq = true;
});

ok('a moved crossing never takes the cables of a crossing a few metres along the same street', async () => {
  const { U, PL, r } = lay(); U.admdConfirm(); U.applyMoves(r);
  const st = r.streets[0], s0 = 60, mk = s => (off => PL.ptAt(st, s, off).slice(0, 2)), t = U._xTan({ st, s: s0 });
  const c1 = { st, s: s0, ss: [s0], key: st.id + '|' + s0 }, c2 = { st, s: s0 + 2, ss: [s0 + 2], key: st.id + '|' + (s0 + 2) };
  const run = s => [mk(s - 15)(6), mk(s)(6), mk(s)(-6), mk(s + 15)(-6)].map(pt => ({ pt, k: null, t: null }));
  const fixed = U._fixedFn({ verts: {} }, new Set(), null), XS = [{ c: c1, a: [t[0] * 2, t[1] * 2], b: [t[0] * 2, t[1] * 2] }];
  const A = run(s0), B = run(s0 + 2), outA = U._relay(A, XS, fixed, null, [c1, c2], false), outB = U._relay(B, XS, fixed, null, [c1, c2], false);
  assert.notStrictEqual(outA, A, 'the moved crossing\'s own cable is re-laid');
  assert.strictEqual(outB, B, 'the cable of the crossing 2 m along is left alone');
  assert.strictEqual(B.every((o, i) => o.pt === B[i].pt), true);
  const moved = Math.hypot(outA[2].pt[0] - A[2].pt[0], outA[2].pt[1] - A[2].pt[1]); assert(Math.abs(moved - 2) < 0.05, 'slid 2 m: ' + moved);
});

ok('a moved crossing on streets with a carriageway: the re-laid runs are put back outside it, so they follow the verge', async () => {
  const { U, PL, r } = lay(); U.admdConfirm();
  const Fc = Object.assign({}, F, { streets: F.streets.map(s => Object.assign({}, s, { cw: 6 })) }), g = { input: Fc, params: Object.assign({}, PL.DEFAULTS, { subs: 1 }) };
  U._gathered = g; const base = PL.solve(Fc, g.params); U.result = base; U.applyMoves(base);
  const hits = res => PL.carriageHits(res).filter(h => h.kind === 'service' || h.kind === 'fibre duct').length;
  const c = base.net.cross.filter(x => !x.prov && x.svc > 1).sort((p, q) => q.svc - p.svc)[0], t = U._xTan(c), L = U.cfg(), f = U.f;
  L.moves.xs[c.key] = { a: { x: t[0] * 8 / f, y: t[1] * 8 / f }, b: { x: t[0] * 8 / f, y: t[1] * 8 / f } };           // slid 8 m
  const r2 = PL.solve(Fc, g.params); U.result = r2; U.applyMoves(r2);
  const raw = hits(r2); PL.keepOut(r2); const fixed = hits(r2);
  assert(fixed <= hits(base) + 1, 'after the slide and the keep-out: ' + fixed + ' (before the slide ' + hits(base) + ', raw ' + raw + ')');
  assert(fixed <= raw, 'keep-out never makes it worse');
  const c2 = r2.net.cross.find(x => x.key === c.key); assert(c2.ends, 'the crossing carries its moved ends');
});

(async () => {
  for (const [name, fn] of queue) { if (process.env.ONLY && !name.includes(process.env.ONLY)) continue; const t = Date.now(); await fn(); n++; console.log('ok', name, `(${((Date.now() - t) / 1000).toFixed(1)} s)`); }
  console.log(n + ' passed');
})().catch(e => { console.error(e); process.exit(1); });
