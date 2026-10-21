/* ProtectionPro — cascading (back-up protection, IEC 60947-2 Annex A).
 *
 * Runs the REAL frontend/js/cascading.js, dbcoord.js and compliance.js against
 * the Schneider table (vendor-cascading.js, LVPED318033EN). The anchors are the
 * guide's own worked example (A-194: NSX250S > NSX100B > iC60N = 50 / 30 / 20 kA);
 * backend/tests/test_cascading.py pins the same numbers on cascading.py.
 *
 * Run:  node frontend/tests/test_cascading.mjs   (exit code 1 on failure)
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const js = (f) => readFileSync(join(here, '..', 'js', f), 'utf8');
const lib = JSON.parse(readFileSync(join(here, '..', '..', 'testing', 'vendor-libraries', 'schneider_breakers.json'), 'utf8'));

const ctx = { console, Math, window: {}, document: { addEventListener() {} },
  Components: { validate: () => ({ errors: [], warnings: [] }) }, escHtml: (x) => String(x) };
vm.createContext(ctx);
const { Cascading, DbCoord, Compliance, STANDARD_CBS } = vm.runInContext(`${js('constants.js')}
${js('vendor-cascading.js')}\n${js('cascading.js')}\n${js('dbcoord.js')}\n${js('compliance.js')}
  for (const e of ${JSON.stringify(lib.entries.map(e => e.data))}) STANDARD_CBS.push(e);
  ({ Cascading, DbCoord, Compliance, STANDARD_CBS });`, ctx);

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; }
  else console.log(`ok: ${msg}`);
}
const R = (model, a) => ({ maker: 'Schneider Electric', model, rating_a: a });

// ─── table lookup ───
assert(Cascading.reinforcedKa(R('NSX250S', 250), R('NSX100B', 100)) === 50, 'NSX250S + NSX100B = 50 kA (A-194)');
assert(Cascading.reinforcedKa(R('NSX250S', 250), R('iC60N', 20)) === 30, 'NSX250S + iC60N = 30 kA (A-194)');
assert(Cascading.reinforcedKa(R('NSX100B', 100), R('iC60N', 20)) === 20, 'NSX100B + iC60N = 20 kA (A-194)');
assert(Cascading.reinforcedKa(R('iC60L', 20), R('iC60N', 16)) === 25, 'upstream iC60L <= 25 A band: 25 kA (A-197)');
assert(Cascading.reinforcedKa(R('iC60L', 40), R('iC60N', 16)) === 20, 'upstream iC60L 32-40 A band: 20 kA (A-197)');
assert(Cascading.reinforcedKa(R('MTZ1 H1', 1000), R('NSX250F', 250)) == null, 'MTZ1 H1 is not a tested upstream');
assert(Cascading.reinforcedKa({ ...R('NSX250S', 250), maker: 'ABB' }, R('iC60N', 20)) == null, 'no mixing makers');

// ─── the three-level rule ───
const c = { ref: R('iC60N', 20), capacityKa: 10, dutyKa: 24 };
const b = { ref: R('NSX100B', 100), capacityKa: 25, dutyKa: 40 };
const a = { ref: R('NSX250S', 250), capacityKa: 100, dutyKa: 80 };
const hit = Cascading.cover([c, b, a]);
assert(hit && hit.by === 2 && hit.reinforcedKa === 30, 'iC60N covered by A + C although B + C is only 20 kA');
assert(Cascading.cover([{ ...c, dutyKa: 31 }, b, a]) == null, 'no cover above the 30 kA combination');
assert(Cascading.cover([c, b, { ...a, capacityKa: 50 }]) == null, 'an upstream breaker failing at its own terminals backs nothing up');

// ─── DB schedule chain ───
const entry = (id) => STANDARD_CBS.find(e => e.id === id);
const item = (label, id, ikA) => ({ label, ikA, dev: { name: entry(id).name, lib: true, entry: entry(id), breakingKa: entry(id).breaking_ka } });
const board = { props: { voltage_kv: 0.4 } };
const items = [item('Way 1', 'se_ic60n_c_20', 18000), item('DB incoming', 'se_nsx250f_250', 18000)];
const dc = DbCoord.cascade(items, 0, board);
assert(dc && dc.reinforcedKa === 25 && dc.up.label === 'DB incoming', 'DbCoord: iC60N behind NSX250F at 18 kA, 25 kA');
assert(DbCoord.cascade([items[0], { ...items[1], ikA: null }], 0, board) == null, 'DbCoord: upstream fault level unknown — no credit');
assert(DbCoord.cascade(items, 0, { props: { voltage_kv: 0.525 } }) == null, 'DbCoord: 525 V is outside the table Ue');
ctx.AppState = { cascading: false };
assert(DbCoord.cascade(items, 0, board) == null, 'DbCoord: cascading switched off');

// ─── compliance on the diagram ───
const comp = (id, type, props) => [id, { id, type, x: 0, y: 0, props }];
const wire = (id, f, t) => [id, { id, fromComponent: f, toComponent: t }];
function net(extra = []) {
  ctx.AppState = {
    cascading: true, frequency: 50,
    components: new Map([
      comp('u', 'utility', { name: 'Grid' }), comp('b2', 'bus', { name: 'LV', voltage_kv: 0.4 }),
      comp('inc', 'cb', { name: 'Incomer', standard_type: 'se_nsx250f_250', breaking_capacity_ka: 36 }),
      comp('b3', 'bus', { name: 'DB', voltage_kv: 0.4 }),
      comp('d', 'cb', { name: 'Way 1', standard_type: 'se_ic60n_c_20', breaking_capacity_ka: 6 }),
      comp('b4', 'bus', { name: 'Load', voltage_kv: 0.4 }), ...extra.filter(x => x[1].type)]),
    wires: new Map([wire('1', 'u', 'b2'), wire('2', 'b2', 'inc'), wire('3', 'inc', 'b3'), wire('4', 'b3', 'd'),
      wire('5', 'd', 'b4'), ...extra.filter(x => !x[1].type)]),
    faultResults: { buses: { b2: { ik3: 20, voltage_kv: 0.4 }, b3: { ik3: 19.5, voltage_kv: 0.4 }, b4: { ik3: 12, voltage_kv: 0.4 } } },
  };
  Compliance._adj = null;
}
net();
const cv = Compliance._cascadeCover('d');
assert(cv && cv.reinforcedKa === 25 && cv.upstreamName === 'Incomer', 'compliance: iC60N 6 kA at 19.5 kA covered by the NSX250F, 25 kA');
net([comp('g', 'generator', { name: 'G' }), wire('6', 'g', 'b3')]);
assert(Compliance._cascadeCover('d') == null, 'compliance: a second infeed on the board — no credit');
net(); ctx.AppState.cascading = false;
assert(Compliance._cascadeCover('d') == null, 'compliance: cascading switched off');

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall cascading checks passed');
