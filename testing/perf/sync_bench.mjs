// Sync benchmark — the work the automatic sync (UX workflow plan, item 2) will
// run after an edit, timed on generated projects of two sizes:
//
//   • Building: plan devices → DB schedule ways (PlanCircuits.syncAll — loads,
//     routed lengths, phase splits) after moving one fitting.
//     Budget: the very large building (61 boards, 11,520 devices) under 100 ms.
//   • Street lighting: the volt-drop recalculation after one pole edit
//     (StreetLight._doCompute, a server round trip). Only the edited circuit is
//     sent; budget: about the time of one circuit, not of all of them.
//
// Each run also prints a fingerprint of the results (schedule ways / circuit
// results), so the same script run on two versions shows the numbers did not
// change.
//
// Needs a running full stack (backend serving the frontend) on a THROWAWAY
// database — the script registers/logs in a test user:
//
//   DATABASE_URL=sqlite:////tmp/pp-perf.db python -m uvicorn backend.main:app --port 8000 &
//   node testing/perf/sync_bench.mjs            # report
//   node testing/perf/sync_bench.mjs --check    # exit 1 when a budget is missed
//
// Env: BASE_URL (default http://localhost:8000), PP_EMAIL / PP_PASSWORD,
// CHROMIUM_PATH, RUNS (timed repeats per measurement, default 5; the median
// is reported). Playwright resolves from testing/ui (npm install there).

import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(HERE, '..', 'ui', 'package.json'));
const { chromium } = require('playwright');

const BASE_URL = (process.env.BASE_URL || 'http://localhost:8000').replace(/\/$/, '');
const EMAIL = process.env.PP_EMAIL || 'perf-bench@test.local';
const PASSWORD = process.env.PP_PASSWORD || 'perf-bench-pass-1';
const RUNS = Number(process.env.RUNS) || 5;
const CHECK = process.argv.includes('--check');

const BUDGET = { buildingVeryLargeMs: 100, slOneCircuitFactor: 3 };

async function token() {
  const post = (path, body) => fetch(`${BASE_URL}/api/auth/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  let res = await post('register', { email: EMAIL, password: PASSWORD, name: 'Perf bench' });
  if (!res.ok) res = await post('login', { email: EMAIL, password: PASSWORD });
  if (!res.ok) throw new Error(`auth failed (${res.status}): ${await res.text()} — use a throwaway DB`);
  return (await res.json()).access_token;
}

const fp = (o) => createHash('sha1').update(JSON.stringify(o)).digest('hex').slice(0, 12);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

async function page(browser, jwt) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  await ctx.addInitScript(t => { try { localStorage.setItem('protectionpro-token', t); } catch (_) {} }, jwt);
  const p = await ctx.newPage();
  p.on('pageerror', e => console.error('page error:', e.message));
  await p.goto(BASE_URL + '/', { waitUntil: 'networkidle' });
  await p.waitForFunction(() => typeof PlanCircuits !== 'undefined' && typeof StreetLight !== 'undefined');
  await p.evaluate(() => { UI.alert = async () => {}; UI.confirm = async () => true; UI.toast = () => {}; });
  return { ctx, p };
}

// ── Building: boards, ways of chained devices, one MDB feeding every board ──
async function building(browser, jwt, size) {
  const { ctx, p } = await page(browser, jwt);
  const r = await p.evaluate(async ({ size, runs }) => {
    Workspaces.setType('building', []);
    switchWorkspace('plan');
    await new Promise(res => setTimeout(res, 300));
    const pm = AppState.planMarkup;
    pm.scale = { factor: 0.02 };
    const el = (type, x, y, name, props) => { const e = { id: AppState.planGenId('pmel'), type, x, y, rotation: 0, name, reticId: null, props: Object.assign(PLAN_DEFS.defaults(type), props || {}) }; pm.elements.push(e); return e; };
    const rt = (type, a, b) => pm.routes.push({ id: AppState.planGenId('pmrt'), type, fromId: a.id, toId: b.id, points: [{ x: a.x, y: a.y }, { x: b.x, y: b.y }], cableType: '', curved: false, props: {} });
    const mdb = el('bd_db', 0, 0, 'MDB');
    let devices = 0;
    for (let i = 0; i < size.boards; i++) {
      const db = el('bd_db', 400 + (i % 10) * 600, Math.floor(i / 10) * 800, 'DB-' + (i + 1));
      rt('feeder', mdb, db);
      for (let w = 0; w < size.ways; w++) {
        let prev = db;
        for (let d = 0; d < size.perWay; d++) {
          const dev = el(w % 2 ? 'bd_socket' : 'bd_light', db.x + w * 40, db.y + 60 + d * 30, '', { circuitDbId: db.id, circuitNo: String(w + 1) });
          rt(w % 2 ? 'circuit' : 'lighting_ckt', prev, dev); prev = dev; devices++;
        }
      }
    }
    await PlanSync.syncBuildingToSLD();          // boards, feeders and ways exist
    const lights = pm.elements.filter(e => e.type === 'bd_light');
    const times = [];
    for (let i = 0; i < runs; i++) {
      lights[(i * 37) % lights.length].x += 5;   // one fitting moved: an edit
      const a = performance.now();
      PlanCircuits.syncAll();
      times.push(performance.now() - a);
    }
    const ways = [...AppState.components.values()].filter(c => c.type === 'distribution_board')
      .sort((a, b) => String(a.props.name).localeCompare(String(b.props.name)))
      .map(c => (c.props.circuits || []).map(w => [w.way, w.load_va, w.cable_m, w.phase_va, w.plan_qty]));
    return { boards: size.boards + 1, devices, times, ways };
  }, { size, runs: RUNS });
  await ctx.close();
  return { boards: r.boards, devices: r.devices, ms: median(r.times), fingerprint: fp(r.ways) };
}

// ── Street lighting: minisubs → kiosk strings, a run of poles off each kiosk ──
async function streetLighting(browser, jwt, size) {
  const { ctx, p } = await page(browser, jwt);
  const r = await p.evaluate(async ({ size, runs }) => {
    Workspaces.setType('retic', []);
    switchWorkspace('plan');
    await new Promise(res => setTimeout(res, 300));
    const pm = AppState.planMarkup;
    pm.elements.length = 0; pm.routes.length = 0;
    pm.scale = { factor: 0.5 };
    const el = (type, x, y, name) => { const e = { id: AppState.planGenId('pmel'), type, x, y, rotation: 0, name, reticId: null, props: PLAN_DEFS.defaults(type) }; pm.elements.push(e); return e; };
    const rt = (type, a, b) => pm.routes.push({ id: AppState.planGenId('pmrt'), type, fromId: a.id, toId: b.id, points: [{ x: a.x, y: a.y }, { x: b.x, y: b.y }], cableType: '', curved: false, props: {} });
    let kn = 0, pn = 0;
    for (let m = 0; m < size.ms; m++) {
      const ms = el('minisub', m * 4000, 0, 'TX' + (m + 1));
      for (let s = 0; s < size.strings; s++) {
        let prev = ms;
        for (let i = 0; i < size.perString; i++) {
          const k = el('kiosk', m * 4000 + (i + 1) * 120, (s - 1) * 500, 'K' + (++kn));
          rt('lv', prev, k); prev = k;
          let pp = k;
          for (let j = 0; j < size.poles; j++) { const po = el('pole', k.x + 10, k.y + 100 + j * 60, 'P' + (++pn)); rt('sl', pp, po); pp = po; }
        }
      }
    }
    await PlanSync.pushToSchedules();
    await StreetLight.syncFromPlan();
    switchWorkspace('streetlight');
    // Count what each request sends.
    const sent = [];
    const orig = API.runStreetLighting.bind(API);
    API.runStreetLighting = (req) => { sent.push(req.circuits.length); return orig(req); };
    clearTimeout(StreetLight._timer);
    await StreetLight._doCompute();                 // every circuit once
    const circuits = StreetLight.circuits.filter(c => c.poles.length);
    // One pole edited per run: only that circuit is re-sent.
    const one = [], oneSent = [];
    for (let i = 0; i < runs; i++) {
      const c = circuits[(i * 7) % circuits.length];
      c.spacingM = (Number(c.spacingM) || StreetLight.defaults.spacingM) + 1;
      clearTimeout(StreetLight._timer);
      sent.length = 0;
      const a = performance.now();
      await StreetLight._doCompute();
      one.push(performance.now() - a); oneSent.push(sent.reduce((x, y) => x + y, 0));
    }
    // Reference: one request with every circuit (what each edit cost before).
    const all = [];
    for (let i = 0; i < Math.min(runs, 3); i++) {
      const a = performance.now();
      await orig({ circuits: circuits.map(c => StreetLight._payload(c)), candidateCables: StreetLight._candidateCables() });
      all.push(performance.now() - a);
    }
    const results = circuits.map(c => StreetLight._results[c.id]).map(x => x && JSON.stringify(x));
    return { circuits: circuits.length, poles: pn, one, oneSent, all, results };
  }, { size, runs: RUNS });
  await ctx.close();
  return {
    circuits: r.circuits, poles: r.poles,
    oneEditMs: median(r.one), circuitsSentPerEdit: Math.max(...r.oneSent),
    allCircuitsMs: median(r.all), fingerprint: fp(r.results),
  };
}

const jwt = await token();
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const out = {};
let fail = false;
try {
  out.building = {
    typical: await building(browser, jwt, { boards: 8, ways: 12, perWay: 6 }),
    veryLarge: await building(browser, jwt, { boards: 60, ways: 24, perWay: 8 }),
  };
  out.streetLighting = {
    typical: await streetLighting(browser, jwt, { ms: 1, strings: 3, perString: 8, poles: 4 }),
    veryLarge: await streetLighting(browser, jwt, { ms: 10, strings: 3, perString: 10, poles: 5 }),
  };
} finally {
  await browser.close();
}

const ms = v => `${v.toFixed(1)} ms`;
for (const [k, b] of Object.entries(out.building)) {
  console.log(`building ${k.padEnd(9)}  ${String(b.boards).padStart(3)} boards ${String(b.devices).padStart(6)} devices   devices→ways ${ms(b.ms).padStart(9)}   fingerprint ${b.fingerprint}`);
}
for (const [k, s] of Object.entries(out.streetLighting)) {
  console.log(`street lighting ${k.padEnd(9)} ${String(s.circuits).padStart(4)} circuits ${String(s.poles).padStart(5)} poles   one edit ${ms(s.oneEditMs).padStart(9)} (${s.circuitsSentPerEdit} sent)   all circuits ${ms(s.allCircuitsMs).padStart(9)}   fingerprint ${s.fingerprint}`);
}

const vl = out.building.veryLarge, sl = out.streetLighting.veryLarge;
const oneRef = sl.allCircuitsMs / sl.circuits;   // per-circuit share of a full request
if (vl.ms > BUDGET.buildingVeryLargeMs) { fail = true; console.log(`OVER BUDGET: very large building ${ms(vl.ms)} > ${BUDGET.buildingVeryLargeMs} ms`); }
for (const [k, s] of Object.entries(out.streetLighting)) {
  if (s.circuitsSentPerEdit !== 1) { fail = true; console.log(`OVER BUDGET: street lighting ${k} sent ${s.circuitsSentPerEdit} circuits for one edit`); }
}
if (sl.oneEditMs > Math.max(BUDGET.slOneCircuitFactor * oneRef, 100)) { fail = true; console.log(`OVER BUDGET: street lighting one edit ${ms(sl.oneEditMs)}`); }
if (CHECK && fail) process.exit(1);
