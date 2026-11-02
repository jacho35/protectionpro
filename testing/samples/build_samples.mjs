// Builds the sample projects the start screen opens (frontend/samples/*.json).
//
// Each sample is made in the real app, headless, the way a user would end up
// with it: the drawing is seeded in the page, the sync pass fills the other
// workspaces, Calculate all runs once to check it, and the project is saved
// from AppState.toJSON() with its results cleared (a sample opens unsaved and
// calculates on open, so its numbers always come from the current engines).
//
// Needs a full stack on a THROWAWAY database (it registers a test user):
//
//   DATABASE_URL=sqlite:////tmp/pp-samples.db python -m uvicorn backend.main:app --port 8000 &
//   BASE_URL=http://localhost:8000 node testing/samples/build_samples.mjs          # all four
//   ONLY=retic node testing/samples/build_samples.mjs                              # one
//
// Playwright resolves from testing/ui (npm install there), like the help-guide
// scripts this shares lib.mjs with.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, token, openApp } from '../help-guides/lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', '..', 'frontend', 'samples');
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);

const settle = (page, ms = 600) => page.waitForTimeout(ms);
const quiet = (page) => page.evaluate(() => { UI.alert = async () => {}; UI.confirm = async () => true; UI.toast = () => {}; });

// ── Reticulation: Riverside Ext 4 ────────────────────────────────────────
// A calibrated site plan: two minisubs, four kiosks in a string off each,
// twenty erven per kiosk, a row of street-light poles along each street.
// MS-2 is on a transformer too small for its erven: the one issue to find.
async function retic(page) {
  await page.evaluate(() => { Workspaces.setType('retic', []); switchWorkspace('plan'); });
  await settle(page);
  await page.evaluate(() => {
    const pm = AppState.planMarkup;
    pm.scale = { factor: 0.5 };                     // 0.5 m per plan unit
    const el = (type, x, y, name, props) => {
      const e = { id: AppState.planGenId('pmel'), type, x, y, rotation: 0, name, reticId: null, props: Object.assign(PLAN_DEFS.defaults(type), props || {}) };
      pm.elements.push(e); return e;
    };
    const rt = (type, a, b, pts) => pm.routes.push({ id: AppState.planGenId('pmrt'), type, fromId: a.id, toId: b.id,
      points: (pts || [[a.x, a.y], [b.x, b.y]]).map(p => ({ x: p[0], y: p[1] })), cableType: '', curved: false, props: {} });
    let kn = 0, en = 0, pn = 0;
    [{ name: 'MS-1 Main road', y: 0 }, { name: 'MS-2 Park street', y: 420 }].forEach((m, mi) => {
      const ms = el('minisub', 0, m.y, m.name);
      let prev = ms;
      for (let i = 0; i < 4; i++) {
        const k = el('kiosk', 120 + i * 150, m.y, `K-${mi + 1}${i + 1}`);
        rt('lv', prev, k); prev = k;
        // ten erven each side of the street
        for (let j = 0; j < 20; j++) {
          const side = j % 2 ? 1 : -1, col = Math.floor(j / 2);
          const e = el('erf', k.x - 65 + col * 14, m.y + side * 60, `Erf ${++en}`);
          rt('service', k, e, [[k.x, m.y], [e.x, m.y], [e.x, e.y]]);
        }
      }
      // street lights along the street, fed from the first kiosk
      const k1 = pm.elements.find(e => e.name === `K-${mi + 1}1`);
      let pp = k1;
      for (let j = 0; j < 12; j++) {
        const p = el('pole', 140 + j * 50, m.y + 30, `P${String(++pn).padStart(2, '0')}`);
        rt('sl', pp, p); pp = p;
      }
    });
    PlanEngine.zoomFit && PlanEngine.zoomFit();
    AppState.projectName = 'Riverside Ext 4';
    AppState.dirty = true;
  });
  await page.evaluate(() => Sync.run());
  await settle(page, 800);
  await page.evaluate(() => {
    const cab = STANDARD_CABLES.find(c => c.id === 'cu_xlpe_185_lv');
    const txs = Retic._txOptions();
    const tx = (kva) => (txs.find(o => o.kva === kva) || txs[0]).id;
    Retic.minisubs.forEach((ms, i) => { ms.txTypeId = tx(i === 0 ? 500 : 315); });
    Retic.kiosks.forEach(k => { k.feederCable = cab.name; });
    AppState.dirty = true;
  });
  await page.evaluate(() => Sync.run());
  await settle(page, 600);
  // The minisubs on the single line ("Add to the single line"), fed from an
  // 11 kV ring main supply.
  await page.evaluate(async () => {
    await Retic.addToSLD();
    const txs = [...AppState.components.values()].filter(c => c.reticRole === 'tx');
    const xs = txs.map(t => t.x);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y = Math.min(...txs.map(t => t.y)) - 160;
    const P = (t, x, y, props) => { const c = Canvas.placeComponent(t, x, y); Object.assign(c.props, props); return c; };
    const sup = P('utility', (x0 + x1) / 2, y - 120, { name: 'Utility 11 kV', voltage_kv: 11, fault_mva: 150, x_r_ratio: 8 });
    const bus = P('bus', (x0 + x1) / 2, y, { name: '11 kV ring main', voltage_kv: 11, bus_type: 'Swing' });
    if (bus.props.width != null) bus.props.width = Math.max(200, x1 - x0 + 120);
    AppState.addWire(sup.id, 'out', bus.id, 'at_0', true);
    for (const t of txs) AppState.addWire(bus.id, `at_${Math.round((t.x - bus.x) / 20) * 20}`, t.id, 'primary', true);
    for (const w of [...AppState.wires.values()]) VoltagePropagation.propagateFromWire(w.id);
    if (AppState.clearSelection) AppState.clearSelection();
    AppState.dirty = true;
  });
  await page.evaluate(() => Sync.run());
  await settle(page, 600);
  await price(page);
}

// Illustrative prices for every line the bill uses, so the Quantities card
// shows a priced total. Material by unit and size; labour a quarter of it.
async function price(page) {
  return page.evaluate(() => {
    const priceOf = (l) => {
      const k = String(l.key), d = String(l.desc || '');
      const mm = Number((/(\d+)\s*mm²/.exec(d) || [])[1]) || 0;
      if (/minisub|transformer/i.test(d)) return 385000;
      if (/kiosk/i.test(d)) return 42000;
      if (/distribution board|^DB-|board/i.test(d)) return 18500;
      if (/pole/i.test(d)) return 6800;
      if (/luminaire|fitting|light/i.test(d)) return 2400;
      if (/meter box|service connection/i.test(d)) return 1850;
      if (l.unit === 'm') return mm ? Math.round(18 + mm * 2.4) : 120;
      return 950;
    };
    let n = 0;
    for (const l of Rates.usedLines()) {
      if (l.pct || /%/.test(String(l.unit || ''))) continue;
      const m = priceOf(l);
      Rates.set(l.key, 'rate', m);
      Rates.set(l.key, 'labour', Math.round(m * 0.25));
      n++;
    }
    AppState.dirty = true;
    return n;
  });
}

// Light a room with the auto layout (the room panel's Suggest + Place), the
// first candidate that passes. A strip too narrow for a layout (a corridor)
// gets a row down its middle at 3 m centres instead.
async function lightRoom(page, name, lum) {
  await page.evaluate(async ({ name, lum }) => {
    const pm = AppState.planMarkup;
    const room = pm.rooms.find(x => x.name === name);
    await RoomCalc.suggest(room, lum);
    const lay = RoomCalc.layouts[room.id];
    if (lay && lay.cands.length) {
      const i = lay.cands.findIndex(c => c.pass);
      lay.sel = i >= 0 ? i : 0;
      await RoomCalc.place(room);
    }
    if (RoomCalc._fittingsIn(room).length) return;
    delete RoomCalc.layouts[room.id];
    const F = PlanEngine.factor();
    const xs = room.points.map(p => p.x), ys = room.points.map(p => p.y);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const along = (x1 - x0) >= (y1 - y0);
    const len = (along ? x1 - x0 : y1 - y0) * F, n = Math.max(1, Math.round(len / 3));
    const ph = PhotoLib.get(lum), base = PLAN_DEFS.defaults('bd_light');
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      pm.elements.push({ id: AppState.planGenId('pmel'), type: 'bd_light',
        x: along ? x0 + t * (x1 - x0) : (x0 + x1) / 2, y: along ? (y0 + y1) / 2 : y0 + t * (y1 - y0),
        rotation: along ? 0 : 90, name: PlanMarkup.nextName('bd_light'), reticId: null,
        props: Object.assign({}, base, { photoId: lum, watts: Math.round(ph.watts || 0), lumens: '', mount: 'recessed', fluxPct: 100 }) });
    }
    PlanMarkup.markDirty();
  }, { name, lum });
}

// ── Building: Harbour Office Block ───────────────────────────────────────
// Two floors of a 40 × 16 m office: the main board and DB-G on the ground
// floor, DB-1 upstairs fed up the riser. Rooms are lit by the app's own
// auto layout; lights and sockets are circuited to their floor's board. The
// workshop socket way upstairs is on a 32 A breaker over 2.5 mm²: the one
// failing circuit to find.
const OFFICE_ROOMS = {
  Ground: [
    { name: 'Reception', task: 'off_reception', box: [0, 0, 12, 8] },
    { name: 'Open office G', task: 'off_writing', box: [12, 0, 40, 9] },
    { name: 'Boardroom', task: 'off_meeting', box: [0, 8, 12, 16] },
    { name: 'Corridor G', task: 'gen_corridor', box: [12, 9, 40, 11] },
    { name: 'Canteen', task: 'gen_canteen', box: [12, 11, 26, 16] },
    { name: 'Plant room', task: 'gen_plant', box: [26, 11, 40, 16] },
  ],
  'First floor': [
    { name: 'Open office 1', task: 'off_writing', box: [0, 0, 28, 9] },
    { name: 'Drawing office', task: 'off_cad', box: [28, 0, 40, 9] },
    { name: 'Corridor 1', task: 'gen_corridor', box: [0, 9, 40, 11] },
    { name: 'Meeting 1', task: 'off_meeting', box: [0, 11, 14, 16] },
    { name: 'Workshop', task: 'ind_rough', box: [14, 11, 40, 16] },
  ],
};
async function building(page) {
  await page.evaluate(() => { Workspaces.setType('building', []); switchWorkspace('plan'); });
  await settle(page);
  const F = 0.05;                                   // metres per plan unit
  const lum = await page.evaluate(async (F) => {
    const pm = AppState.planMarkup;
    pm.scale = { factor: F };
    pm.floors[0].name = 'Ground';
    const up = AppState.addPlanFloor('First floor');
    up.data.scale = { factor: F };
    AppState.projectName = 'Harbour Office Block';
    return PhotoLib.addGeneric('generic_panel', 3600, 30);
  }, F);
  let floorIx = 0;
  for (const [floor, rooms] of Object.entries(OFFICE_ROOMS)) {
    await page.evaluate(({ floor, rooms, F, floorIx }) => {
      const pm = AppState.planMarkup;
      const fl = pm.floors.find(f => f.name === floor);
      AppState.switchFloor(fl.id);
      pm.scale = { factor: F };
      const u = (m) => m / F;
      const el = (type, x, y, name, props) => {
        const e = { id: AppState.planGenId('pmel'), type, x: u(x), y: u(y), rotation: 0, name, reticId: null, props: Object.assign(PLAN_DEFS.defaults(type), props || {}) };
        pm.elements.push(e); return e;
      };
      // feeders in 35 mm² four-core
      const rt = (type, a, b) => pm.routes.push({ id: AppState.planGenId('pmrt'), type, fromId: a.id, toId: b.id,
        points: [{ x: a.x, y: a.y }, { x: a.x, y: b.y }, { x: b.x, y: b.y }], cableType: '35mm² Cu XLPE LV', curved: false, props: {} });
      for (const r of rooms) {
        const [x0, y0, x1, y1] = r.box;
        const room = { id: AppState.planGenId('pmroom'), name: r.name, kind: 'room', color: '#60a5fa',
          points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => ({ x: u(x), y: u(y) })) };
        pm.rooms.push(room);
        RoomLighting.applyTask(room, r.task);
      }
      const riser = el('bd_riser', 26.5, 10, 'Riser A');
      if (floorIx === 0) {
        const mdb = el('bd_db', 27, 13, 'MDB');
        const dbg = el('bd_db', 13, 10, 'DB-G');
        rt('feeder', mdb, dbg);
        rt('feeder', mdb, riser);
      } else {
        const db1 = el('bd_db', 13, 10, 'DB-1');
        rt('feeder', riser, db1);
      }
    }, { floor, rooms, F, floorIx });
    // Light each room with the auto layout, as the room panel's Suggest + Place does.
    for (const r of rooms) await lightRoom(page, r.name, lum);
    floorIx++;
  }
  // Circuits: each room's lights on one way, two double sockets per room on another.
  await page.evaluate((F) => {
    const pm = AppState.planMarkup;
    const u = (m) => m / F;
    for (const fl of pm.floors) {
      AppState.switchFloor(fl.id);
      const db = pm.elements.find(e => e.type === 'bd_db' && e.name !== 'MDB');
      let way = 1;
      const chain = (type, list, no) => {
        let prev = db;
        for (const d of list) {
          Object.assign(d.props, { circuitDbId: db.id, circuitNo: String(no) });
          pm.routes.push({ id: AppState.planGenId('pmrt'), type, fromId: prev.id, toId: d.id,
            points: [{ x: prev.x, y: prev.y }, { x: prev.x, y: d.y }, { x: d.x, y: d.y }], cableType: '', curved: false, props: {} });
          prev = d;
        }
      };
      for (const room of pm.rooms) {
        // snake order along the rows, at most ten fittings a way
        const lights = pm.elements.filter(e => e.type === 'bd_light' && PlanEngine._pointInPoly({ x: e.x, y: e.y }, room.points));
        const rows = [...new Set(lights.map(e => Math.round(e.y)))].sort((a, b) => a - b);
        const snake = rows.flatMap((y, i) => lights.filter(e => Math.round(e.y) === y).sort((a, b) => (i % 2 ? b.x - a.x : a.x - b.x)));
        for (let i = 0; i < snake.length; i += 10) chain('lighting_ckt', snake.slice(i, i + 10), way++);
        const xs = room.points.map(p => p.x), ys = room.points.map(p => p.y);
        const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
        const n = room.name === 'Workshop' ? 6 : 2;
        const sockets = [];
        for (let i = 0; i < n; i++) {
          sockets.push(Object.assign({ id: AppState.planGenId('pmel'), type: 'bd_socket', x: x0 + (x1 - x0) * (i + 1) / (n + 1), y: y1 - u(0.3), rotation: 0,
            name: PlanMarkup.nextName('bd_socket'), reticId: null, props: PLAN_DEFS.defaults('bd_socket') }));
        }
        pm.elements.push(...sockets);
        chain('circuit', sockets, way++);
      }
    }
    AppState.switchFloor(pm.floors[0].id);
    AppState.dirty = true;
  }, F);
  await page.evaluate(() => Sync.run());
  await settle(page, 1200);
  // The supply on the single line, and how the final circuits are run.
  await page.evaluate(() => {
    const comps = [...AppState.components.values()];
    for (const c of comps) if (c.type === 'distribution_board') c.props.way_install = { method: 'C', grouping: 'bunched', circuits: 1 };
    const mdb = comps.find(c => c.type === 'distribution_board' && c.props.name === 'MDB');
    const P = (t, x, y, props) => { const c = Canvas.placeComponent(t, x, y); Object.assign(c.props, props); return c; };
    const sup = P('utility', mdb.x, mdb.y - 360, { name: 'Utility 11 kV', voltage_kv: 11, fault_mva: 250, x_r_ratio: 10 });
    const tx = P('transformer', mdb.x, mdb.y - 220, { name: 'T1 500 kVA', rated_mva: 0.5, voltage_hv_kv: 11, voltage_lv_kv: 0.4, z_percent: 4.5, x_r_ratio: 5, vector_group: 'Dyn11', grounding_lv: 'solidly_grounded' });
    const q1 = P('cb', mdb.x, mdb.y - 110, { name: 'Q1 Main', rated_voltage_kv: 0.4, rated_current_a: 800, trip_rating_a: 800, cb_type: 'acb', breaking_capacity_ka: 50 });
    const hv = P('bus', mdb.x, mdb.y - 275, { name: '11 kV intake', voltage_kv: 11, bus_type: 'Swing' });
    AppState.addWire(sup.id, 'out', hv.id, 'at_0', true);
    AppState.addWire(hv.id, 'at_0', tx.id, 'primary', true);
    AppState.addWire(tx.id, 'secondary', q1.id, 'top', true);
    AppState.addWire(q1.id, 'bottom', mdb.id, 'in', true);
    // as drawing the wires would: each wire carries its zone's voltage on
    for (const w of [...AppState.wires.values()]) VoltagePropagation.propagateFromWire(w.id);
  });
  // The workshop sockets: a 32 A breaker on 2.5 mm² cable.
  await page.evaluate(() => {
    const db1 = [...AppState.components.values()].find(c => c.type === 'distribution_board' && c.props.name === 'DB-1');
    const ws = AppState.planMarkup.floors.find(f => f.name === 'First floor').data;
    const sock = ws.elements.find(e => e.type === 'bd_socket' && PlanEngine._pointInPoly({ x: e.x, y: e.y }, ws.rooms.find(r => r.name === 'Workshop').points));
    const way = db1 && (db1.props.circuits || []).find(w => String(w.way) === String(sock.props.circuitNo));
    if (way) Object.assign(way, { description: 'Sockets – workshop', breaker_a: 32 });
    AppState.dirty = true;
  });
  await page.evaluate(() => Sync.run());
  await settle(page, 800);
  await price(page);
}

// ── Network: Kestrel 33/11 kV Substation ─────────────────────────────────
async function network(page) {
  await page.evaluate(() => {
    const data = NetworkTemplates.generate('substation_33_11');
    data.symbolSet = 'iec';
    // IEC rated voltages (Ur ≥ Um): 36 kV switchgear on 33 kV, 12 kV on 11 kV.
    for (const c of data.components) {
      if (c.type === 'cb' && c.props.rated_voltage_kv === 33) c.props.rated_voltage_kv = 36;
      if (c.type === 'cb' && c.props.rated_voltage_kv === 11) c.props.rated_voltage_kv = 12;
    }
    AppState.fromJSON(data);
    switchWorkspace('sld');
    Canvas.zoomToFit();
    AppState.projectName = 'Kestrel 33/11 kV Substation';
    Workspaces.setType('network', []);
  });
  await settle(page);
}

// ── Lighting: office floor and access road ───────────────────────────────
// An office floor lit to EN 12464-1 by the auto layout, and an access road:
// a two-lane cross-section design and an 200 m road with a bend on the road
// plan, poles laid out by the design.
const LIGHT_ROOMS = [
  { name: 'Open office', task: 'off_writing', box: [0, 0, 20, 10] },
  { name: 'Meeting room', task: 'off_meeting', box: [20, 0, 28, 6] },
  { name: 'Manager', task: 'off_writing', box: [20, 6, 28, 10] },
  { name: 'Corridor', task: 'gen_corridor', box: [0, 10, 28, 12] },
];
async function lighting(page) {
  await page.evaluate(() => { Workspaces.setType('lighting', [], { kinds: ['rooms', 'roads'], circuits: false }); switchWorkspace('lighting'); });
  await settle(page);
  const lum = await page.evaluate(async (rooms) => {
    const F = 0.05, u = (m) => m / F;
    const pm = AppState.planMarkup;
    pm.scale = { factor: F };
    AppState.projectName = 'Office floor and access road';
    for (const r of rooms) {
      const [x0, y0, x1, y1] = r.box;
      const room = { id: AppState.planGenId('pmroom'), name: r.name, kind: 'room', color: '#60a5fa',
        points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => ({ x: u(x), y: u(y) })) };
      pm.rooms.push(room);
      RoomLighting.applyTask(room, r.task);
    }
    return PhotoLib.addGeneric('generic_panel', 3600, 30);
  }, LIGHT_ROOMS);
  for (const r of LIGHT_ROOMS) await lightRoom(page, r.name, lum);
  // The road: a design on the cross-section, then the road on the road plan.
  await page.evaluate(() => switchWorkspace('streetlight'));
  await settle(page);
  await page.evaluate(async () => {
    await RoadLight.newDesign();
    const des = RoadLight.designs[RoadLight.designs.length - 1];
    des.name = 'Access road';
    await RoadPlan._newRoad({ name: 'Access road', mode: 'ip', radius: 60,
      ip: [{ x: 0, y: 0 }, { x: 110, y: 0 }, { x: 190, y: 50 }] });
    AppState.dirty = true;
  });
  await settle(page, 1500);
}

const SAMPLES = {
  retic: { file: 'retic.json', build: retic },
  building: { file: 'building.json', build: building },
  network: { file: 'network.json', build: network },
  lighting: { file: 'lighting.json', build: lighting },
};

async function run() {
  mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const jwt = await token();
  let bad = 0;
  for (const [key, s] of Object.entries(SAMPLES)) {
    if (ONLY.length && !ONLY.includes(key)) continue;
    const page = await openApp(browser, jwt, { width: 1440, height: 900 });
    await quiet(page);
    await s.build(page);
    // Calculate all once: the sample must calculate cleanly.
    const check = await page.evaluate(async () => {
      const ov = Workspaces.type() === 'lighting' ? 'lightov' : 'overview';
      switchWorkspace(ov);
      if (ov === 'overview') await Overview.calcAll(); else if (LightOverview.calcAll) await LightOverview.calcAll();
      await new Promise(r => setTimeout(r, 1500));
      Issues.refresh();
      const rooms = typeof Overview !== 'undefined' && Overview.roomRows ? Overview.roomRows().map(r => `${r.name}:${r.verdict || r.status || ''}`) : [];
      return { counts: Issues.counts(), rooms, issues: Issues.list().slice(0, 12).map(i => `${i.sev} ${i.ws}: ${i.where} — ${i.text}`) };
    });
    // Save without results: the start screen calculates on open.
    const data = await page.evaluate(() => {
      AppState.clearResults();
      const d = AppState.toJSON();
      // Demand's result is a live slot clearResults keeps: drop it too.
      for (const k of Object.keys(d)) if (/Results$/.test(k) || k === 'resultsMeta') delete d[k];
      d.lastView = { workspace: Workspaces.type() === 'lighting' ? 'lightov' : 'overview' };
      return d;
    });
    writeFileSync(join(OUT, s.file), JSON.stringify(data));
    console.log(`${key}: ${s.file} ${JSON.stringify(check.counts)}`);
    if (check.rooms.length) console.log('   rooms: ' + check.rooms.join(', '));
    for (const l of check.issues) console.log('   ' + l);
    if (page.errors.length) { bad++; console.log('   page errors:', page.errors.join(' | ')); }
    await page.context().close();
  }
  await browser.close();
  process.exit(bad ? 1 : 0);
}
run().catch(e => { console.error(e); process.exit(1); });
