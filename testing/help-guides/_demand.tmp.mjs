import { launch, token, openApp } from './lib.mjs';
const SCALE = +(process.argv[2] || 10);
const browser = await launch();
const page = await openApp(browser, await token(), { width: 1500, height: 950 });
await page.evaluate(() => StartScreen.openSample('retic'));
await page.waitForFunction(() => AppState.reticulation && Retic.kiosks && Retic.kiosks.length > 0, null, { timeout: 30000 });
await page.waitForTimeout(1500);
const base = await page.evaluate(() => ({ ms: Retic.minisubs.length, k: Retic.kiosks.length, e: Retic.kiosks.reduce((t, k) => t + (k.erven || []).length, 0) }));
console.log('sample', JSON.stringify(base));
// scale: copy every minisub with its kiosks SCALE times (new ids, fedFrom remapped)
await page.evaluate((N) => {
  const R = Retic.state, ms0 = JSON.parse(JSON.stringify(R.minisubs)), k0 = JSON.parse(JSON.stringify(R.kiosks));
  let n = 0; const nid = p => p + '_x' + (++n);
  for (let c = 1; c < N; c++) {
    const map = {};
    for (const m of ms0) { const id = nid('ms'); map[m.id] = id; R.minisubs.push(Object.assign(JSON.parse(JSON.stringify(m)), { id, name: m.name + '/' + c })); }
    for (const k of k0) map[k.id] = nid('k');
    for (const k of k0) { const c2 = JSON.parse(JSON.stringify(k)); c2.id = map[k.id]; c2.name = k.name + '/' + c; c2.fedFrom = map[k.fedFrom] || k.fedFrom; (c2.erven || []).forEach(e => e.id = nid('e')); R.kiosks.push(c2); }
  }
  delete R.minisubs.__x;
}, SCALE);
const big = await page.evaluate(() => ({ ms: Retic.minisubs.length, k: Retic.kiosks.length, e: Retic.kiosks.reduce((t, k) => t + (k.erven || []).length, 0) }));
console.log('scaled', JSON.stringify(big));
// open Demand and time each part
const t = await page.evaluate(async () => {
  const T = {}; const now = () => performance.now();
  let a = now(); switchWorkspace('retic'); T.openTab = now() - a;
  await new Promise(r => setTimeout(r, 2500));
  a = now(); Retic.renderKiosks(); T.renderKiosks = now() - a;
  const pl = Retic._admdPayload();
  a = now(); const res = await API.runAdmd(pl, Retic.kiosks, Retic.minisubs); T.admdApi = now() - a;
  a = now(); JSON.stringify([pl, Retic.kiosks, Retic.minisubs]); T.serialize = now() - a;
  T.reqKB = Math.round(JSON.stringify({ settings: pl, kiosks: Retic.kiosks, minisubs: Retic.minisubs }).length / 1024);
  AppState.reticResults = res;
  a = now(); Retic.updateBadges(); T.updateBadges = now() - a;
  a = now(); Retic.updateVD(); T.updateVD = now() - a;
  a = now(); Retic.renderSummary(); T.renderSummary = now() - a;
  a = now(); const ep = Retic._earthPayload(); T.earthPayload = now() - a;
  T.earthKB = Math.round(JSON.stringify(ep).length / 1024);
  a = now(); const er = await API.runReticEarth(ep); T.earthApi = now() - a;
  AppState.reticResults.earth = er;
  a = now(); Retic.updateEarth(); T.updateEarth = now() - a;
  a = now(); Retic._inputSig(); T.inputSig = now() - a;
  a = now(); await Retic._doCompute(); T.doComputeTotal = now() - a;
  // a name edit: does it recompute?
  let calls = 0; const orig = API.runAdmd.bind(API); API.runAdmd = (...x) => { calls++; return orig(...x); };
  const oe = API.runReticEarth.bind(API); let ecalls = 0; API.runReticEarth = (...x) => { ecalls++; return oe(...x); };
  Retic.recompute(); Retic.recompute(); await new Promise(r => setTimeout(r, 1500));
  T.recomputeNoChange = { admd: calls, earth: ecalls };
  return T;
});
for (const [k, v] of Object.entries(t)) console.log(k.padEnd(20), typeof v === 'number' ? v.toFixed(0) : JSON.stringify(v));
console.log('errors', page.errors.slice(0, 3));
await browser.close();
