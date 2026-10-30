/* ProtectionPro — DB earth-leakage units and switched sections.
 *
 * Runs the real dbschedule.js / dbdrawing.js rules (vm sandbox, no browser):
 *  · an EL group sits wholly inside one switched section or wholly outside
 *    them (DBSchedule.elStraddles / _elBlockMsg);
 *  · phase rows keep a switched section, a pole-linked contactor and an
 *    in-line EL group together (DBDrawing._rowChunks): the contactor is in
 *    one row, never split by phase.
 *
 * Run:  node frontend/tests/test_db_el_units.mjs   (exit code 1 on failure)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert';

const js = join(dirname(fileURLToPath(import.meta.url)), '..', 'js');
const ctx = { console, Math, window: {}, document: { addEventListener() {} }, escHtml: s => String(s) };
vm.createContext(ctx);
for (const f of ['constants.js', 'dbcontrols.js', 'dbschedule.js', 'dbdrawing.js']) {
  vm.runInContext(readFileSync(join(js, f), 'utf8') + `\n;globalThis.__${f.replace(/\W/g, '_')} = 1;`, ctx, { filename: f });
}
const run = (code) => vm.runInContext(code, ctx);
const DBSchedule = run('DBSchedule'), DBDrawing = run('DBDrawing');

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log('ok', name); };

const way = (w, phase, extra = {}) => ({ id: 'w' + w, way: String(w), phase, poles: '1P', breaker_a: 20, ...extra });
const ctrl = { supplies: [], contactors: [{ id: 'k1', tag: 'K1', arrangement: 'section', poles: '4P', rating_a: 20, category: 'AC-1', switches: [] }] };
const board = (circuits) => ({ id: 'db', props: { circuits, controls: ctrl } });

ok('a group on the busbar and under K1 straddles', () => {
  const b = board([way(6, 'W', { el_group: 'EL1' }), way(14, 'W', { el_group: 'EL1', contactor: 'k1' })]);
  const st = DBSchedule.elStraddles(b);
  assert.strictEqual(st.length, 1);
  assert.strictEqual(st[0].group, 'EL1');
  assert.ok(/switched section K1/.test(DBSchedule._straddleText(st[0])));
});
ok('a group wholly inside, or wholly outside, is fine', () => {
  const b = board([way(6, 'W', { el_group: 'EL1' }), way(7, 'W', { el_group: 'EL1' }),
    way(14, 'W', { el_group: 'EL2', contactor: 'k1' }), way(15, 'W', { el_group: 'EL2', contactor: 'k1' }), way(1, 'R')]);
  assert.strictEqual(DBSchedule.elStraddles(b).length, 0);
});
ok('joining a group across the contactor is refused, without touching the board', () => {
  const b = board([way(6, 'W', { el_group: 'EL1' }), way(14, 'W', { contactor: 'k1' })]);
  const w14 = b.props.circuits[1];
  assert.ok(DBSchedule._elBlockMsg(b, w14, { el_group: 'EL1' }));
  assert.strictEqual(w14.el_group, undefined);
  assert.strictEqual(DBSchedule._elBlockMsg(b, w14, { el_group: 'EL9' }), '');
});
ok('moving a grouped way under K1 is refused; an unrelated edit is not blocked', () => {
  const b = board([way(6, 'W', { el_group: 'EL1' }), way(7, 'W', { el_group: 'EL1' })]);
  assert.ok(DBSchedule._elBlockMsg(b, b.props.circuits[0], { contactor: 'k1' }));
  assert.strictEqual(DBSchedule._elBlockMsg(b, b.props.circuits[0], { el_group: '' }), '');
});
ok('unit defaults: breaker, type A, instantaneous, rating from the ways', () => {
  const b = board([way(6, 'W', { el_group: 'EL1', breaker_a: 20 }), way(7, 'W', { el_group: 'EL1', breaker_a: 20 })]);
  const u = DBSchedule.elUnit(b, 'EL1');
  assert.deepStrictEqual([u.device, u.type, u.delay, u.idn_ma, u.poles, u.rating_a], ['breaker', 'A', '', 30, 2, 40]);
  b.props.el_units = { EL1: { device: 'isolator', type: 'B', delay: 'S', rating_a: 63 } };
  b.props.el_ratings = { EL1: 300 };
  const v = DBSchedule.elUnit(b, 'EL1');
  assert.deepStrictEqual([v.device, v.type, v.delay, v.idn_ma, v.rating_a], ['isolator', 'B', 'S', 300, 63]);
});

// Items as _items builds them: only what _rowChunks reads.
const item = (w, phase, extra = {}) => Object.assign({ kind: 'way', way: String(w), phase }, extra);
const k1 = { id: 'k1', tag: 'K1', arrangement: 'section' };
const rowsOf = (items) => DBDrawing._rowChunks(items, { phaserows: true });
const tags = (rows) => Array.from(rows, r => `${r.phase}:${Array.from(r, i => i.way).join(',')}`);

ok('phase rows: a mixed-phase section is one block in its own row, K1 not split', () => {
  const rows = rowsOf([item(1, 'R'), item(2, 'B'), item(6, 'W'),
    item(14, 'W', { ctr: k1 }), item(15, 'R', { ctr: k1 }), item(16, 'B', { ctr: k1 }), item(17, 'W', { ctr: k1 })]);
  assert.deepStrictEqual(tags(rows), ['R:1', 'W:6', 'B:2', 'SW:14,15,16,17']);
});
ok('phase rows: a single-phase section stays in its phase row', () => {
  const rows = rowsOf([item(1, 'R'), item(10, 'R', { ctr: k1 }), item(11, 'R', { ctr: k1 }), item(2, 'W')]);
  assert.deepStrictEqual(tags(rows), ['R:1,10,11', 'W:2']);
});
ok('phase rows: ways of one contactor that are far apart in the schedule come together', () => {
  const pole = { id: 'k2', tag: 'K2', arrangement: 'poles' };
  const rows = rowsOf([item(1, 'R', { ctr: pole }), item(2, 'R'), item(3, 'R', { ctr: pole })]);
  assert.deepStrictEqual(tags(rows), ['R:1,3,2']);
});
ok('phase rows: an in-line EL group is kept together', () => {
  const g = { elMode: 'device', elGroup: 'EL1' };
  const rows = rowsOf([item(6, 'RWB', g), item(1, 'R'), item(7, 'RWB', g)]);
  assert.deepStrictEqual(tags(rows), ['R:1', 'RWB:6,7']);
});
ok('a block is never cut across a full row', () => {
  const sec = Array.from({ length: 5 }, (_, i) => item(20 + i, 'W', { ctr: k1 }));
  const many = Array.from({ length: 9 }, (_, i) => item(i + 1, 'W'));
  const rows = DBDrawing._rowChunks(many.concat(sec), { phaserows: false });
  const rowOf = new Set(rows.filter(r => r.some(i => i.ctr)).map(r => rows.indexOf(r)));
  assert.strictEqual(rowOf.size, 1);
  assert.strictEqual(rows.find(r => r.some(i => i.ctr)).filter(i => i.ctr).length, 5);
});

console.log(`\n${n} checks passed`);
