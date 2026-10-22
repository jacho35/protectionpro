// Planner tests for frontend/js/roadplan-circuits.js (no browser).
//   node testing/unit/roadcircuits.test.js
const assert = require('assert');
const RC = require('../../frontend/js/roadplan-circuits.js');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok', name); };
const near = (a, b, t = 0.011) => assert(Math.abs(a - b) <= t, `${a} != ${b}`);
const poles = (pre, pts) => pts.map(([x, y], i) => ({ id: pre + (i + 1), x, y, ph: null }));

// Main Rd along x (poles every 45 m from x=10), Acacia Ave leaves it at x=100 going south.
const main = { id: 'M', name: 'Main Rd', poles: poles('m', [[10, 0], [55, 0], [100, 0], [145, 0]]), feed: { x: -20, y: -10, route: [[-20, 0]] }, parents: [] };
const acacia = (o = {}) => Object.assign({ id: 'A', name: 'Acacia Ave', poles: poles('a', [[100, -30], [100, -70], [100, -110]]), feed: null, parents: [{ main: 'M', end: 'start' }] }, o);

ok('root circuit: feeder = drawn route + 5 %, then pole to pole', () => {
  const r = RC.plan([main], {});
  const c = r.circuits[0];
  assert.strictEqual(c.poles[0].rid, 'm1');
  near(c.feeder.routeM, 10 + Math.hypot(30, 0), 0.011);       // (-20,-10)→(-20,0)→(10,0)
  near(c.feeder.lenM, 40 * 1.05); near(c.poles[0].spanM, 42);
  near(c.poles[1].spanM, 45); assert.strictEqual(c.poles[1].parent, 'm1');
});
ok('no route drawn: straight line + 15 %', () => {
  const r = RC.plan([Object.assign({}, main, { feed: { x: -20, y: 0, route: [] } })], {});
  assert.strictEqual(r.circuits[0].feeder.mode, 'straight');
  near(r.circuits[0].feeder.lenM, 30 * 1.15);
});
ok('feed nearer the far end: the chain runs from that end', () => {
  const r = RC.plan([Object.assign({}, main, { feed: { x: 170, y: 0, route: [] } })], {});
  assert.deepStrictEqual(r.circuits[0].poles.map(p => p.rid), ['m4', 'm3', 'm2', 'm1']);
});
ok('feeder to a pole mid-string: the string runs both ways from it', () => {
  const r = RC.plan([Object.assign({}, main, { feed: { x: 55, y: -20, route: [[55, -5]], poleId: 'm2' } })], {});
  const c = r.circuits[0];
  assert.deepStrictEqual(c.poles.map(p => p.rid), ['m2', 'm3', 'm4', 'm1']);
  assert.strictEqual(c.poles[0].parent, null);
  assert.strictEqual(c.poles.find(p => p.rid === 'm3').parent, 'm2');
  assert.strictEqual(c.poles.find(p => p.rid === 'm1').parent, 'm2');
  near(c.poles[0].spanM, 20 * 1.05);
});
ok('spur links pole to pole: nearest parent pole, real distance, no tee', () => {
  const r = RC.plan([main, acacia()], {});
  const c = r.circuits[0];
  assert.deepStrictEqual(c.roadIds, ['M', 'A']);
  const first = c.poles.find(p => p.rid === 'a1');
  assert.strictEqual(first.parent, 'm3'); assert(first.link);
  near(first.spanM, 30);
  near(c.poles.find(p => p.rid === 'a2').spanM, 40);
  assert.strictEqual(c.poles.find(p => p.rid === 'a2').parent, 'a1');
});
ok('spur from its far end is walked from the junction end', () => {
  const a = acacia({ poles: poles('a', [[100, -110], [100, -70], [100, -30]]), parents: [{ main: 'M', end: 'end' }] });
  const c = RC.plan([main, a], {}).circuits[0];
  assert.strictEqual(c.poles.find(p => p.link).rid, 'a3');
});
ok('no parent pole in reach → skipped with the reason', () => {
  const far = acacia({ poles: poles('a', [[100, -80]]) });
  const r = RC.plan([main, far], {});
  assert.strictEqual(r.circuits[0].roadIds.length, 1);
  assert(/within 60 m/.test(r.skipped[0].reason), r.skipped[0].reason);
  const r2 = RC.plan([main, far], { linkMaxM: 100 });
  assert.strictEqual(r2.circuits[0].roadIds.length, 2);
});
ok('a spur of a spur', () => {
  const b = { id: 'B', name: 'Protea', poles: poles('b', [[130, -110], [170, -110]]), feed: null, parents: [{ main: 'A', end: 'start' }] };
  const c = RC.plan([main, acacia(), b], {}).circuits[0];
  assert.strictEqual(c.poles.find(p => p.rid === 'b1').parent, 'a3');
  near(c.poles.find(p => p.rid === 'b1').spanM, 30);
});
ok('road without a feed point or a fed parent is skipped', () => {
  const r = RC.plan([acacia()], {});
  assert.strictEqual(r.circuits.length, 0); assert.strictEqual(r.skipped[0].roadId, 'A');
});
ok('an unticked parent leaves the spur unfed', () => {
  const r = RC.plan([acacia()].concat([]), {});
  assert(/no feed point|has no feed/.test(r.skipped[0].reason));
});
console.log(`${n} passed`);
