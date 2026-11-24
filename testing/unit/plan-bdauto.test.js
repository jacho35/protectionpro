// PlanBdAuto (frontend/js/plan-bdauto.js): the request it sends to the circuiting engine and the preview it draws.
//   node testing/unit/plan-bdauto.test.js
const assert = require('assert'), fs = require('fs'), vm = require('vm'), path = require('path');
const JS = path.join(__dirname, '../../frontend/js/');
const ctx = { console, escHtml: s => String(s), AppState: {} };
vm.createContext(ctx);
const load = (f) => vm.runInContext(fs.readFileSync(JS + f, 'utf8').replace(/^const (\w+) = /gm, 'var $1 = ').replace(/if \(typeof module[^\n]*\n/, ''), ctx, { filename: f });
load('plan-circuits.js'); load('plan-bdauto.js');
const B = ctx.PlanBdAuto;
const J = (x) => JSON.parse(JSON.stringify(x));
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok -', name); };

const room = (id, x0, y0, x1, y1, extra) => ({ id, name: id, points: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }], ...extra });
const model = (over = {}) => ({
  pm: { scale: { factor: 0.05 }, rooms: [room('r1', 0, 0, 200, 100, { lighting: { ceilH: 3 } }), room('r2', 200, 0, 400, 100)],
    elements: [
      { id: 'l1', type: 'bd_light', x: 40, y: 40, props: { watts: 18 } },
      { id: 's1', type: 'bd_socket', x: 100, y: 90, props: { outlets: 'double' } },
      { id: 'l2', type: 'bd_light', x: 300, y: 50, props: {} },
      { id: 'hand', type: 'bd_light', x: 60, y: 60, props: { circuitDbId: 'db1', circuitNo: '1' } },
      { id: 'auto', type: 'bd_light', x: 70, y: 60, props: { circuitDbId: 'db1', circuitNo: '2', circuitAuto: true } },
      { id: 'sw', type: 'bd_switch', x: 80, y: 60, props: {} },
      { id: 'db1', type: 'bd_db', name: 'DB-1', x: 10, y: 10, props: {} }],
    routes: [{ id: 'rt1', type: 'cable_tray', points: [{ x: 0, y: 50 }, { x: 400, y: 50 }] }, { id: 'rt2', type: 'circuit', points: [{ x: 0, y: 0 }, { x: 5, y: 5 }] }] },
  boards: [{ el: { id: 'db1', name: 'DB-1', x: 10, y: 10 }, comp: { props: { circuits: [{ way: '1' }, { way: '4' }, { way: '9', auto: 'power' }] } } }],
  settings: B.settings({ settings: {} }), ...over });

ok('plan pixels become metres by the floor scale', () => {
  const { req } = B.buildRequest(model());
  const l1 = req.devices.find(d => d.id === 'l1');
  assert.deepStrictEqual(J([l1.x, l1.y]), [2, 2]);
  assert.deepStrictEqual(J(req.rooms[0].polygon[2]), [10, 5]);
  assert.strictEqual(req.rooms[0].ceil_h, 3);
  assert.strictEqual(req.rooms[1].ceil_h, undefined);
});

ok('devices: loads only, in their room, hand-tagged ones left out and counted', () => {
  const b = B.buildRequest(model());
  const ids = b.req.devices.map(d => d.id).sort();
  assert.deepStrictEqual(J(ids), ['auto', 'l1', 'l2', 's1']);          // the switch carries no load; "hand" is tagged by hand
  assert.strictEqual(b.handTagged, 1);
  assert.strictEqual(b.req.devices.find(d => d.id === 'l2').room_id, 'r2');
  assert.strictEqual(b.req.devices.find(d => d.id === 's1').va, 400);
});

ok('only containment routes go to the engine', () => {
  const { req } = B.buildRequest(model());
  assert.deepStrictEqual(J(req.containment), [[[0, 2.5], [20, 2.5]]]);
});

ok('a board counts its own ways, not the ones this tool made', () => {
  const { req } = B.buildRequest(model());
  assert.strictEqual(req.boards[0].ways_used, 4);           // way 9 is auto
  assert.strictEqual(req.boards[0].ways_total, undefined);
  const st = B.settings({ settings: {} }); st.ways_per_board = 24;
  assert.strictEqual(B.buildRequest(model({ settings: st })).req.boards[0].ways_total, 24);
});

ok('refuses without a scale, a board or devices', () => {
  const m = model(); m.pm.scale = null;
  assert.match(B.buildRequest(m).error, /scale/i);
  assert.match(B.buildRequest(model({ boards: [] })).error, /board/i);
  const m2 = model(); m2.pm.elements = m2.pm.elements.filter(e => e.type === 'bd_db');
  assert.match(B.buildRequest(m2).error, /No lights/);
  const m3 = model(); m3.pm.elements = m3.pm.elements.filter(e => e.id === 'hand' || e.type === 'bd_db');
  assert.match(B.buildRequest(m3).error, /already on a circuit you set/);
});

ok('settings fill every default and keep what is set', () => {
  const s = B.settings({ settings: { circuiting: { mode: 'ceiling', rules: { slack_pct: 0 } } } });
  assert.strictEqual(s.mode, 'ceiling'); assert.strictEqual(s.rules.slack_pct, 0);
  assert.strictEqual(s.rules.max_points.light, 10); assert.strictEqual(s.rules.spare_ways, 3);
  assert.strictEqual(B.settings({ settings: { circuiting: { mode: 'teleport' } } }).mode, 'walls');
});

ok('the preview colours devices by circuit and marks a failed route red', () => {
  const m = model();
  const res = { circuits: [{ id: 'db1:1', device_ids: ['l1'], route: [[0.5, 0.5], [2, 2]], status: 'ok' }, { id: 'db1:2', device_ids: ['l2'], route: null, status: 'no_route' }] };
  const svg = B.previewSvg(m.pm, res, m.boards);
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('stroke-dasharray') && svg.includes('#1f5fd1'));
  assert.ok(svg.includes('fill="#b4232c"'));
  assert.ok(svg.includes('DB-1'));
});

console.log(`${n} passed`);
