/* ProtectionPro — TCC curve regression test (TCC review 2026-09-29, TC1-TC3).
 *
 * Evaluates the REAL curve functions from frontend/js/constants.js against
 * the standards' own gates — never against the module's previous output:
 *   TC1  gG pre-arcing vs IEC 60269-1 Table 3 gates, 0.01 s I²t vs Table 7
 *   TC2  IDMT held at t(20 x Gs) above G_D (IEC 60255-151)
 *   TC3  MCB / MCCB thermal region vs the conventional non-tripping and
 *        tripping currents (IEC 60898-1 Table 7, IEC 60947-2 Table 6)
 *
 * Run:  node frontend/tests/test_tcc_curves.mjs   (exit code 1 on failure)
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'js', 'constants.js'), 'utf8');
const ctx = { console, Math };
vm.createContext(ctx);
const { fuseTripTime, cbTripTime, idmtTripTime, FUSE_CURVES_GG } = vm.runInContext(
  `${src}\n;({ fuseTripTime, cbTripTime, idmtTripTime, FUSE_CURVES_GG });`, ctx);

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; }
  else console.log(`ok: ${msg}`);
}

// IEC 60269-1 Table 3 gG gates: In -> [Imin(10 s), Imax(5 s), Imin(0.1 s), Imax(0.1 s)]
const GATES = {16:[33,65,85,150],20:[42,85,110,200],25:[52,110,150,260],32:[75,150,200,350],
  40:[95,190,260,450],50:[125,250,350,610],63:[160,320,450,820],80:[215,425,610,1100],
  100:[290,580,820,1450],125:[355,715,1100,1910],160:[460,950,1450,2590],200:[610,1250,1910,3420],
  250:[750,1650,2590,4500],315:[1050,2200,3420,6000],400:[1420,2840,4500,8060],
  500:[1780,3800,6000,10600],630:[2200,5100,8060,14140]};
// IEC 60269-1 Table 7: [min pre-arcing I²t, max operating I²t] at 0.01 s
const I2T = {16:[0.3e3,1.0e3],20:[0.5e3,1.8e3],25:[1.0e3,3.0e3],32:[1.8e3,5.0e3],40:[3.0e3,9.0e3],
  50:[5.0e3,16e3],63:[9.0e3,27e3],80:[16e3,46e3],100:[27e3,86e3],125:[46e3,140e3],160:[86e3,250e3],
  200:[140e3,400e3],250:[250e3,760e3],315:[400e3,1300e3],400:[760e3,2250e3],500:[1300e3,3800e3],
  630:[2250e3,7500e3]};

// ── TC1: gG gates ──────────────────────────────────────────────────────────
for (const [In, g] of Object.entries(GATES)) {
  const t = g.map(i => fuseTripTime(+In, i));
  assert(t[0] >= 10 && t[1] <= 5 && t[2] >= 0.1 && t[3] <= 0.1,
    `TC1: ${In} A gG inside all four IEC 60269-1 gates (${t.map(x => x.toPrecision(3)).join(', ')} s)`);
  const i01 = FUSE_CURVES_GG[In].find(([, tt]) => tt === 0.01)[0];
  const i2t = i01 * i01 * 0.01;
  assert(i2t >= I2T[In][0] && i2t <= I2T[In][1],
    `TC1: ${In} A pre-arcing I²t at 0.01 s = ${i2t.toPrecision(3)} inside Table 7 corridor`);
}

// ── TC2: IDMT held above 20x ──────────────────────────────────────────────
for (const c of ['IEC Standard Inverse', 'IEC Very Inverse', 'IEC Extremely Inverse',
                 'IEC Long Time Inverse', 'IEEE Moderately Inverse', 'IEEE Very Inverse',
                 'IEEE Extremely Inverse']) {
  assert(idmtTripTime(c, 50, 0.2) === idmtTripTime(c, 20, 0.2), `TC2: ${c} held at t(20x) above 20x`);
  assert(idmtTripTime(c, 50, 0.2, 0) < idmtTripTime(c, 20, 0.2, 0), `TC2: ${c} limit 0 = pure equation`);
}
// the equation itself is unchanged below the limit (IEC 60255-151 SI at M = 10)
assert(Math.abs(idmtTripTime('IEC Standard Inverse', 10, 1) - 0.14 / (Math.pow(10, 0.02) - 1)) < 1e-12,
  'TC2: SI equation exact below the limit');

// ── TC3: breaker thermal region ───────────────────────────────────────────
{
  const mcb = { cb_type: 'mcb', trip_rating_a: 16, thermal_pickup: 1, magnetic_pickup: 10, long_time_delay: 10 };
  assert(cbTripTime(mcb, 16 * 1.13) === Infinity, 'TC3: MCB does not trip at 1.13 In (IEC 60898-1)');
  assert(cbTripTime(mcb, 16 * 1.45) < 3600, 'TC3: MCB trips within 1 h at 1.45 In');
  const t255 = cbTripTime(mcb, 16 * 2.55);
  assert(t255 >= 1 && t255 <= 60, `TC3: MCB 2.55 In inside 1-60 s (${t255.toFixed(1)} s)`);
  for (const cls of [5, 10, 20, 30]) {
    const mccb = { cb_type: 'mccb', trip_rating_a: 250, thermal_pickup: 1, magnetic_pickup: 10, long_time_delay: cls };
    assert(cbTripTime(mccb, 250 * 1.05) === Infinity && cbTripTime(mccb, 250 * 1.30) < 7200,
      `TC3: MCCB class ${cls} — no trip at 1.05 Ir, trips within 2 h at 1.30 Ir (IEC 60947-2)`);
    assert(Math.abs(cbTripTime(mccb, 250 * 6) - cls) < 1e-9, `TC3: MCCB class ${cls} = ${cls} s at 6 Ir`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
} else {
  console.log('\nAll TCC curve tests passed.');
}
