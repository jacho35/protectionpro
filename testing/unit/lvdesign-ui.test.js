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
  for (const f of ['constants.js', 'cablelib.js', 'undonames.js', 'retic.js', 'plan-sync.js', 'plan-defs.js', 'plan-layout.js', 'plan-kerbs.js', 'plan-layout-ui.js']) load(f);
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

ok('1, 2 and 3 mini-subs are tried; the one that passes with the least cable is used, each reported', async () => {
  const { r, counts } = await run({ subsMax: 3 });
  assert.strictEqual(r.subsTrials.length, 3); assert.strictEqual(JSON.stringify(r.subsTrials.map(x => x.subs)), '[1,2,3]');
  const used = r.subsTrials.filter(x => x.chosen); assert.strictEqual(used.length, 1);
  const passing = r.subsTrials.filter(x => x.ok); assert(passing.length > 0);
  assert.strictEqual(used[0].total, Math.min(...passing.map(x => x.total)), 'the least cable among those that pass');
  assert.strictEqual(r.net.subs.length, used[0].subs); assert.strictEqual(counts.design, 3);
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

ok('the panel shows the tile, the table with the taper marks, the switches and the mini-sub trials', async () => {
  const { U, r } = await run({ subsMax: 3 });
  const el = { innerHTML: '' }; U.renderOptions(el); const h = el.innerHTML, D = r.design;
  assert(/LV design/.test(h) && new RegExp('LV cable: ' + D.taper.count + ' size').test(h), 'the tile');
  assert(h.includes(`${D.taper.minMm2} to ${D.taper.maxMm2} mm²`) && h.includes(`taper saves ${D.taper.savedPct}%`));
  assert(/<th[^>]*>Kiosk<\/th>.*<th[^>]*>Fed from<\/th>.*<th[^>]*>Cable<\/th>.*<th[^>]*>Breaker<\/th>/.test(h), 'the table');
  assert(/set by taper/.test(h), 'a feeder marked as set by the taper');
  for (const sw of ['way80', 'taper']) assert(new RegExp(`data-vd="${sw}"[^>]* checked`).test(h), sw + ' on by default');
  assert(/data-vd="subsMax"[^>]*value="3"/.test(h), 'most mini-subs defaults to 3');
  assert(/Mini-subs tried:/.test(h) && /\(used\)/.test(h));
  assert(D.heads.every(x => h.includes(x.breaker)));
});

// click a button of the Checks list the way the panel does
async function clickAct(U, textRe, actName) {
  const el = { innerHTML: '' }; U.renderOptions(el);
  const i = U._ck.findIndex(c => textRe.test(c.text)), j = i < 0 ? -1 : U._ck[i].acts.findIndex(a => a.act === actName);
  assert(i >= 0 && j >= 0, `no ${actName} button on a row matching ${textRe}`);
  el.onclick({ target: { closest: () => ({ dataset: { ckact: i + ':' + j } }) } });
}

ok('a smallest and a largest LV cable: the cables stay inside, the panel offers the sizes', async () => {
  const { U, r } = await run({ minSize: 50, maxSize: 300 }), D = r.design;
  assert(D && D.ok); assert(D.feeders.every(f => f.sizeMm2 >= 50 && f.sizeMm2 <= 300), 'sizes ' + D.feeders.map(f => f.sizeMm2));
  const el = { innerHTML: '' }; U.renderOptions(el); const h = el.innerHTML;
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

(async () => {
  for (const [name, fn] of queue) { const t = Date.now(); await fn(); n++; console.log('ok', name, `(${((Date.now() - t) / 1000).toFixed(1)} s)`); }
  console.log(n + ' passed');
})().catch(e => { console.error(e); process.exit(1); });
