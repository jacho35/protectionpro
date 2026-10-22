// Shared helpers for the help-guide screenshot scripts.
import { createRequire } from 'node:module';
import { readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), '../ui/package.json'));
const pw = require('playwright');
export const chromium = pw.chromium;
// Playwright's pinned build is often missing; fall back to any installed headless shell.
function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const root = join(process.env.HOME || '/root', '.cache/ms-playwright');
  try {
    for (const d of readdirSync(root).sort().reverse()) {
      if (!d.startsWith('chromium_headless_shell')) continue;
      const p = join(root, d, 'chrome-headless-shell-linux64/chrome-headless-shell');
      if (existsSync(p)) return p;
    }
  } catch (_) { /* default build */ }
  return undefined;
}
export const launch = () => chromium.launch({ executablePath: findChromium() });

export const CHROMIUM = process.env.CHROMIUM_PATH || undefined;
export const BASE_URL = (process.env.BASE_URL || 'http://localhost:8902').replace(/\/$/, '');
const EMAIL = process.env.PP_EMAIL || 'guides@test.local';
const PASSWORD = process.env.PP_PASSWORD || 'guides-pass-1';

export async function token() {
  const post = (path, body) => fetch(`${BASE_URL}/api/auth/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  let res = await post('register', { email: EMAIL, password: PASSWORD, name: 'Guides' });
  if (!res.ok) res = await post('login', { email: EMAIL, password: PASSWORD });
  if (!res.ok) throw new Error(`auth failed (${res.status}) — use a throwaway database`);
  return (await res.json()).access_token;
}

export async function openApp(browser, jwt, viewport = { width: 1440, height: 900 }, opts = {}) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, ...opts });
  await context.addInitScript(t => { try { localStorage.setItem('protectionpro-token', t); } catch (_) {} }, jwt);
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(String(e)));
  await page.goto(BASE_URL, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof AppState !== 'undefined' && typeof Schedules !== 'undefined');
  return page;
}

// A realistic 3-phase distribution board, seeded in the page. Returns its id.
// `sections`: also split it into Normal / Essential / UPS compartments.
export async function seedBoard(page, { sections = false, accessories = false } = {}) {
  return page.evaluate(({ sections, accessories }) => {
    const comp = Canvas.placeComponent('distribution_board', 600, 400);
    comp.props.name = 'DB-A Workshop';
    const utility = Canvas.placeComponent('utility', 600, 120);
    const cb = Canvas.placeComponent('cb', 600, 260);
    Object.assign(cb.props, { name: 'Q1', rated_voltage_kv: 0.4, rated_current_a: 125, trip_rating_a: 125, cb_type: 'mccb', breaking_capacity_ka: 25 });
    Object.assign(utility.props, { voltage_kv: 0.4 });
    AppState.addWire(utility.id, 'out', cb.id, 'top', true);
    AppState.addWire(cb.id, 'bottom', comp.id, 'in', true);
    const W = (way, description, o) => Object.assign(DBSchedule.newWay(way - 1), { way: String(way), description }, o);
    const ways = [
      W(1, 'Lighting – workshop', { poles: '1P', breaker_a: 10, curve: 'B', cable_mm2: 1.5, ecc_mm2: 1.5, cable_m: 25, load_va: 800 }),
      W(2, 'Lighting – offices', { breaker_a: 10, curve: 'B', cable_mm2: 1.5, ecc_mm2: 1.5, cable_m: 18, load_va: 600 }),
      W(3, 'Sockets – offices', { breaker_a: 20, curve: 'B', cable_mm2: 2.5, ecc_mm2: 2.5, cable_m: 30, load_va: 2400, demand_factor: 0.4 }),
      W(4, 'Sockets – workshop', { breaker_a: 20, curve: 'B', cable_mm2: 2.5, ecc_mm2: 2.5, cable_m: 40, load_va: 3200, demand_factor: 0.4 }),
      W(5, 'Geyser', { breaker_a: 20, curve: 'C', cable_mm2: 2.5, ecc_mm2: 2.5, cable_m: 12, load_va: 3000 }),
      W(6, 'Air conditioner', { breaker_a: 20, curve: 'C', cable_mm2: 2.5, ecc_mm2: 2.5, cable_m: 22, load_va: 2500 }),
      W(7, 'Compressor', { poles: '3P', breaker_a: 32, curve: 'D', cable_mm2: 6, ecc_mm2: 6, cable_m: 35, load_va: 11000, power_factor: 0.85 }),
      W(8, 'Spare', { breaker_a: 20, curve: 'C', load_va: 0 }),
    ];
    comp.props.circuits = ways;
    if (sections) {
      const n = DBSections.create(comp, 'normal');
      const e = DBSections.create(comp, 'essential');
      const u = DBSections.create(comp, 'ups');
      n.name = 'Normal'; e.name = 'Essential'; e.source_label = 'Generator'; e.source_kva = 60; u.name = 'UPS'; u.source_label = '10 kVA UPS'; u.source_kva = 10;
      ways.forEach((w, i) => { w.section = i < 5 ? n.id : (i < 7 ? e.id : u.id); });
    }
    if (accessories) {
      comp.props.accessories = [
        { id: 'acc1', kind: 'indicator', label: 'Live indicators', tap: 'busbar', phases: 'RWB', lamp_type: 'led', lamp_v: 230, fuse_a: 2, fuse_type: 'gG' },
        { id: 'acc2', kind: 'spd', label: 'Surge arrestor' },
      ];
    }
    return comp.id;
  }, { sections, accessories });
}

export async function openBoardTab(page, id, tab) {
  await page.evaluate(() => switchWorkspace('schedules'));
  await page.waitForSelector('.sch-tab');
  await page.evaluate(i => Schedules.selectBoard ? Schedules.selectBoard(i) : (Schedules._boardId = i), id);
  await page.click(`[data-sch-tab="${tab}"]`);
  await page.waitForTimeout(500);
}


// A small reticulation plan: minisub, three kiosks in a string, nine erven. Returns nothing.
export async function seedPlan(page, { scale = 0.5 } = {}) {
  await page.evaluate(() => Workspaces.setType('reticulation', []));
  await page.evaluate(() => switchWorkspace('plan'));
  await page.waitForTimeout(600);
  await page.evaluate((scale) => {
    const pm = AppState.planMarkup;
    const el = (type, x, y, name) => { const e = { id: AppState.planGenId('pmel'), type, x, y, rotation: 0, name, reticId: null, props: PLAN_DEFS.defaults(type) }; pm.elements.push(e); return e; };
    const rt = (type, a, b, pts) => pm.routes.push({ id: AppState.planGenId('pmrt'), type, fromId: a && a.id, toId: b && b.id, points: pts.map(p => ({ x: p[0], y: p[1] })), cableType: '', curved: false, props: {} });
    const ms = el('minisub', 0, 0, 'TX1');
    const ks = [el('kiosk', 70, 0, 'K1'), el('kiosk', 140, 0, 'K2'), el('kiosk', 210, 0, 'K3')];
    rt('lv', ms, ks[0], [[0, 0], [70, 0]]); rt('lv', ks[0], ks[1], [[70, 0], [140, 0]]); rt('lv', ks[1], ks[2], [[140, 0], [210, 0]]);
    let n = 1;
    ks.forEach(k => { for (let j = 0; j < 3; j++) { const e = el('erf', k.x - 22 + j * 22, (j % 2 ? 45 : -45), 'E' + (n++)); rt('service', k, e, [[k.x, 0], [e.x, e.y]]); } });
    pm.settings.symbolScale = scale;
    const inp = document.getElementById('plan-symbol-scale'); if (inp) inp.value = String(scale);
    if (PlanMarkup.updateScaleReadout) PlanMarkup.updateScaleReadout();
    PlanEngine.zoomFit && PlanEngine.zoomFit();
    PlanEngine.requestDraw({ all: true });
  }, scale);
  await page.waitForTimeout(500);
}

// Click (or right-click) a plan element by name.
export async function planPoint(page, name) {
  return page.evaluate((nm) => {
    const e = AppState.planMarkup.elements.find(x => x.name === nm);
    const p = PlanEngine.worldToScreen(e.x, e.y);
    const r = PlanEngine.fg.getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  }, name);
}
