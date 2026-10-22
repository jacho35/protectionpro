// Indoor lighting targets by standard (frontend/js/roomlighting.js, no browser).
//   node testing/unit/roomlighting.test.js
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const ctx = { AppState: { planMarkup: { settings: {} } }, escHtml: (s) => String(s) };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(__dirname + '/../../frontend/js/roomlighting.js', 'utf8') + '\nthis.RL = RoomLighting; this.TASKS = ROOM_TASKS;', ctx);
const RL = ctx.RL;
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok', name); };
const room = (t) => ({ lighting: { task: t } });
const set = (s) => { ctx.AppState.planMarkup.settings.lightingStandard = s; };

ok('default standard is EN 12464-1', () => {
  set(undefined);
  assert.strictEqual(RL.standard(), 'EN');
  const L = RL.read(room('off_filing'));
  assert.deepStrictEqual([L.em, L.uo, L.ugr, L.ra, L.ez, L.wallE, L.ceilE], [300, 0.4, 19, 80, 100, 100, 75]);
});
ok('SANS 10114-1 differs: filing UGR 22, classroom 300 lx, corridor Ra 60, stairs 150 lx', () => {
  set('SANS');
  assert.strictEqual(RL.read(room('off_filing')).ugr, 22);
  assert.strictEqual(RL.read(room('edu_class')).em, 300);
  assert.strictEqual(RL.read(room('gen_corridor')).ra, 60);
  assert.strictEqual(RL.read(room('gen_stairs')).em, 150);
  assert.strictEqual(RL.read(room('gen_parking')).ugr, 28);
});
ok('SANS keeps EN Uo / Ez / wall / ceiling and EN rows it has no row for', () => {
  set('SANS');
  const L = RL.read(room('off_writing'));
  assert.deepStrictEqual([L.em, L.uo, L.ugr, L.ra, L.ez, L.wallE, L.ceilE], [500, 0.6, 19, 80, 150, 150, 100]);
  assert.strictEqual(RL.read(room('off_archive')).em, 200);
});
ok('an unedited room follows a change of standard, an edited one keeps its targets', () => {
  const r = room('edu_class'); RL.applyTask(r, 'edu_class');
  const e = room('edu_class'); RL.applyTask(e, 'edu_class'); RL.set(e, 'em', 420);
  set('EN');
  assert.strictEqual(RL.read(r).em, 500);
  assert.strictEqual(RL.read(e).em, 420);
  set('SANS');
  assert.strictEqual(RL.read(r).em, 300);
  assert.strictEqual(RL.read(e).em, 420);
});
ok('editing wall or ceiling counts as an edit', () => {
  set('EN');
  const r = room('off_writing'); RL.applyTask(r, 'off_writing'); RL.set(r, 'wallE', 90);
  set('SANS');
  assert.strictEqual(RL.read(r).wallE, 90);
});
console.log(n + ' passed');
