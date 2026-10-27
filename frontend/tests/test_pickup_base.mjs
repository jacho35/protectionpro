/* ProtectionPro — reference current of a breaker pickup (× Ir or × In).
 *
 * A manufacturer fixes the instantaneous element against the trip-unit rating
 * In (Schneider TM-D / MicroLogic Ii, ABB I3), so turning the Ir dial must not
 * move it. The REAL functions are evaluated — cbTripTime / cbElementsA from
 * frontend/js/constants.js and TripUnit from frontend/js/tripunit.js — against
 * published amps, and the same cases are pinned on the backend in
 * backend/tests/test_vendor_libraries.py (arc-flash clearing time, duty check).
 *
 * Run:  node frontend/tests/test_pickup_base.mjs   (exit code 1 on failure)
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const js = (f) => readFileSync(join(here, '..', 'js', f), 'utf8');
const lib = JSON.parse(readFileSync(join(here, '..', '..', 'testing', 'vendor-libraries', 'schneider_breakers.json'), 'utf8'));

const ctx = { console, Math, escHtml: (x) => String(x) };
vm.createContext(ctx);
const abb = JSON.parse(readFileSync(join(here, '..', '..', 'testing', 'vendor-libraries', 'abb_breakers.json'), 'utf8'));
const xt = JSON.parse(readFileSync(join(here, '..', '..', 'testing', 'vendor-libraries', 'abb_xt_breakers.json'), 'utf8'));
const exp = vm.runInContext(`${js('constants.js')}\n${js('vendor-trip-units.js')}\n${js('vendor-trip-units-abb.js')}\n${js('vendor-trip-units-abb-xt.js')}\n${js('tripunit.js')}
  for (const e of ${JSON.stringify(lib.entries.map(e => e.data))}) STANDARD_CBS.push(e);
  for (const e of ${JSON.stringify(abb.entries.map(e => e.data))}) STANDARD_CBS.push(e);
  for (const e of ${JSON.stringify(xt.entries.map(e => e.data))}) STANDARD_CBS.push(e);
  ({ cbTripTime, cbElementsA, cbPickupBase, cbPickupRefA, cbPickupLabel, cbTripExtras, cbTripBand, TripUnit, TRIP_UNITS, STANDARD_CBS });`, ctx);
const { cbTripTime, cbElementsA, cbPickupBase, cbPickupRefA, cbPickupLabel, cbTripExtras, cbTripBand, TripUnit, TRIP_UNITS, STANDARD_CBS } = exp;

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; }
  else console.log(`ok: ${msg}`);
}
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
const entry = (id) => STANDARD_CBS.find(c => c.id === id);
const breaker = (id) => {
  const e = entry(id);
  const comp = { type: 'cb', props: { cb_type: e.cb_type, standard_type: id, trip_rating_a: e.trip_rating_a } };
  TripUnit.apply(comp, e, TripUnit.defaultIdFor(e));
  return comp;
};
const params = (comp) => ({ cb_type: comp.props.cb_type, trip_rating_a: comp.props.trip_rating_a,
  thermal_pickup: comp.props.thermal_pickup, magnetic_pickup: comp.props.magnetic_pickup,
  long_time_delay: comp.props.long_time_delay, short_time_pickup: comp.props.short_time_pickup,
  short_time_delay: comp.props.short_time_delay, instantaneous_pickup: comp.props.instantaneous_pickup,
  ...cbTripExtras(comp.props) });

// ── the reference current ──────────────────────────────────────────────────
assert(cbPickupBase({}, 'instantaneous') === 'Ir', 'no pickup_base: a pickup is a multiple of Ir');
assert(cbPickupBase({ pickup_base: { instantaneous: 'In' } }, 'instantaneous') === 'In', 'pickup_base names In');
assert(cbPickupBase({ pickup_base: { instantaneous: 'In' } }, 'short_time') === 'Ir', 'a pickup not named stays Ir');
const base100 = { cb_type: 'mccb', trip_rating_a: 100, thermal_pickup: 0.5, magnetic_pickup: 15,
  long_time_delay: 16, short_time_pickup: 0, short_time_delay: 0, instantaneous_pickup: 15, trip_unit_kind: 'electronic' };
assert(near(cbElementsA(base100).ii, 750), 'legacy: Ii = 15 x Ir = 15 x 50 A = 750 A');
assert(near(cbElementsA({ ...base100, pickup_base: { instantaneous: 'In', magnetic: 'In' } }).ii, 1500),
  'Ii against In: 15 x 100 A = 1500 A, Ir dial at 0.5');
assert(cbTripTime(base100, 800) === 0.025 && cbTripTime(base100, 700) > 0.025, 'legacy trip at 750 A');
const inBase = { ...base100, pickup_base: { instantaneous: 'In', magnetic: 'In' } };
assert(cbTripTime(inBase, 1499) > 0.025 && cbTripTime(inBase, 1500) === 0.025, 'In-based Ii trips at 1500 A, not 750 A');
for (const th of [0.4, 0.7, 1.0]) {
  assert(cbTripTime({ ...inBase, thermal_pickup: th }, 1499) > 0.025 && cbTripTime({ ...inBase, thermal_pickup: th }, 1500) === 0.025,
    `Ii stays at 1500 A with the Ir dial at ${th}`);
}
assert(cbPickupLabel(inBase, 'instantaneous', 15) === '15×In' && cbPickupLabel(base100, 'instantaneous', 15) === '15×Ir', 'label names the base');
assert(cbPickupLabel({ cb_type: 'mcb' }, 'magnetic', 10) === '10×In', 'an MCB keeps the standard words (×In)');

// ── Schneider TM-D 100 A: Ir 70-100 A, Ii fixed 800 A ──────────────────────
const tm = breaker('se_nsx100n_100');
assert(tm.props.trip_unit === 'se_nsx_tmd_100', 'default trip unit of NSX100N 100 A is the TM-D');
assert(near(tm.props.magnetic_pickup, 8) && tm.props.pickup_base.magnetic === 'In', 'TM100D: Ii = 8 x In (800 A), held against In');
assert(Array.isArray(tm.props.thermal_curve.points), 'the published long-time curve is on the breaker');
const iiAt = (comp) => cbElementsA(params(comp)).im;
assert(near(iiAt(tm), 800), 'TM100D Ii = 800 A at Ir 100 A');
for (const [step, irA] of [[0.7, 70], [0.8, 80], [0.9, 90], [1.0, 100]]) {
  TripUnit.setDial(tm, 'thermal_pickup', step);
  assert(near(cbElementsA(params(tm)).ir, irA) && near(iiAt(tm), 800), `TM100D Ir ${irA} A: Ii still 800 A`);
}
assert(TripUnit.amps(tm, 'magnetic_pickup', tm.props.magnetic_pickup, TRIP_UNITS.se_nsx_tmd_100.dials.magnetic_pickup) === '800 A',
  'the panel shows Ii in amps against In');
// the curve is the published one: 400 s at 1.5 x Ir, 15 s at 6 x Ir (Ir 100 A)
TripUnit.setDial(tm, 'thermal_pickup', 1.0);
assert(near(cbTripTime(params(tm), 150), 400, 1e-3) && near(cbTripTime(params(tm), 600), 15, 1e-3), 'TM-D long-time points 400 s @1.5 Ir, 15 s @6 Ir');

// ── TM250D: adjustable Ii dial in amps ─────────────────────────────────────
const tm250 = breaker('se_nsx250n_250');
assert(TRIP_UNITS.se_nsx_tmd_250.dials.magnetic_pickup.steps.map(s => Math.round(s * 250)).join() === '1250,1500,1750,2000,2250,2500',
  'TM250D Ii dial 1250-2500 A');
TripUnit.setDial(tm250, 'magnetic_pickup', 6);
TripUnit.setDial(tm250, 'thermal_pickup', 0.7);
assert(near(cbElementsA(params(tm250)).im, 1500), 'TM250D Ii dial at 1500 A holds when Ir goes to 175 A');

// ── MicroLogic 5: Ii against In, Isd against Ir ────────────────────────────
const ml = breaker('se_nsx250n_250');
TripUnit.adopt(ml, 'se_nsx_ml567_250');
assert(ml.props.trip_unit_kind === 'electronic' && ml.props.pickup_base.instantaneous === 'In' && ml.props.pickup_base.magnetic === 'In',
  'MicroLogic: Ii and the mirrored magnetic pickup are against In');
assert(!ml.props.pickup_base.short_time, 'MicroLogic: Isd is against Ir');
assert(near(ml.props.instantaneous_pickup, 10), 'TM250D -> MicroLogic: Ii 2500 A (10 x In) is kept');
TripUnit.setDial(ml, 'thermal_pickup', 0.4);          // Ir 100 A
TripUnit.setDial(ml, 'short_time_pickup', 4);
TripUnit.setDial(ml, 'instantaneous_pickup', 6);
let e = cbElementsA(params(ml));
assert(near(e.ir, 100) && near(e.isd, 400) && near(e.ii, 1500), 'Ir 100 A, Isd 4 x Ir = 400 A, Ii 6 x In = 1500 A');
TripUnit.setDial(ml, 'thermal_pickup', 1.0);          // Ir 250 A
e = cbElementsA(params(ml));
assert(near(e.ir, 250) && near(e.isd, 1000) && near(e.ii, 1500), 'Ir 250 A: Isd follows (1000 A), Ii does not (1500 A)');

// ── switching trip units keeps the amps ────────────────────────────────────
const sw = breaker('se_nsx100n_100');                // TM-D: Ir 70 A, Ii 800 A
TripUnit.setDial(sw, 'thermal_pickup', 0.7);
TripUnit.adopt(sw, 'se_nsx_ml567_100');              // MicroLogic: Ii 800 A is 8 x In
assert(near(sw.props.instantaneous_pickup, 8) && near(cbElementsA(params(sw)).ii, 800),
  'TM-D -> MicroLogic: Ii 800 A is kept (8 x In)');
const gen = breaker('se_nsx100n_100');
TripUnit.setDial(gen, 'thermal_pickup', 0.7);        // Ir 70 A, Ii 800 A against In
TripUnit.adopt(gen, 'tm_adj');                       // generic: Im is x Ir -> 800 / 70 = 11.43 -> nearest dial step 10
assert(gen.props.pickup_base === undefined, 'a generic profile carries no pickup_base');
assert(near(gen.props.magnetic_pickup, 10) && near(cbElementsA(params(gen)).im, 700), 'In -> Ir: 800 A re-expressed x Ir, snapped to the dial (10 x 70 = 700 A)');
const gen2 = breaker('se_nsx100n_100');
TripUnit.setDial(gen2, 'thermal_pickup', 0.8);       // Ir 80 A
TripUnit.adopt(gen2, 'se_nsx_ml567_100');
TripUnit.setDial(gen2, 'instantaneous_pickup', 5);   // 5 x In = 500 A against In
TripUnit.adopt(gen2, 'etu_lsi_mccb');                // generic electronic: Ii x Ir -> 500 / 80 = 6.25 -> dial step 6
assert(gen2.props.pickup_base === undefined && near(gen2.props.instantaneous_pickup, 6), 'ML -> generic: 5 x In (500 A) at Ir 80 A is 6.25 x Ir -> 6');

// ── free settings keep the amps; a library pick does not re-base the new entry ─
const fr = breaker('se_nsx100n_100');
TripUnit.setDial(fr, 'thermal_pickup', 0.7);
TripUnit.clear(fr);
assert(fr.props.trip_unit === undefined && fr.props.pickup_base === undefined && fr.props.thermal_curve === undefined,
  'free settings: profile, pickup_base and curve dropped');
assert(near(fr.props.magnetic_pickup * 100 * fr.props.thermal_pickup, 800, 1e-3), 'free settings: Im still 800 A (= 11.43 x Ir)');
const fr2 = breaker('se_nsx100n_100');
fr2.props.magnetic_pickup = 6;                       // the next entry's own number (x Ir)
TripUnit.clear(fr2, false);
assert(fr2.props.magnetic_pickup === 6 && fr2.props.pickup_base === undefined, 'clear(keepAmps = false) leaves the numbers as written');

// ── keep-my-settings across a breaker swap ─────────────────────────────────
const old = breaker('se_nsx100n_100');
TripUnit.setDial(old, 'thermal_pickup', 0.8);        // Ir 80 A
const oldProps = { ...old.props };
const newEntry = entry('se_nsx160n_160');
const vals = TripUnit.keepInAmps(oldProps, ['thermal_pickup'], newEntry, 'se_nsx_tmd_160');
assert(near(vals.thermal_pickup * 160, 112), 'Ir is kept in amps: 80 A -> the nearest TM160D step at or above (112 A)');
const swap = TripUnit.keepInAmps({ ...oldProps, pickup_base: undefined, thermal_pickup: 0.8, magnetic_pickup: 6 },
  ['magnetic_pickup'], entry('se_nsx100n_100'), 'tm_adj');
assert(near(swap.magnetic_pickup, 6), 'a x Ir dial value copied across x Ir dials is unchanged');

// ── a library entry used as a device (Reticulation protection) ───────────────
const dp = TripUnit.deviceProps(entry('se_nsx100n_100'));
assert(dp.pickup_base && dp.pickup_base.magnetic === 'In' && Array.isArray(dp.thermal_curve.points) && dp.trip_unit === 'se_nsx_tmd_100',
  'a manufacturer entry used as a device carries its pickup base and published curve');
assert(near(cbElementsA(dp).im, 800) && dp.trip_rating_a === 100 && dp.breaking_ka === 50, 'the device keeps the entry fields and Ii = 800 A');
const generic = STANDARD_CBS.find(c => c.id === 'mccb_100a');
assert(TripUnit.deviceProps(generic) === generic, 'a generic entry is used as it is (its own numbers)');

// ── the long-time curve through the published points is smooth ───────────────
const smooth = { cb_type: 'mccb', trip_rating_a: 100, thermal_pickup: 1, magnetic_pickup: 100, long_time_delay: 16,
  thermal_curve: { points: [[1.5, 400], [6, 16], [7.2, 11]] } };
assert(near(cbTripTime(smooth, 150), 400, 1e-9) && near(cbTripTime(smooth, 600), 16, 1e-9) && near(cbTripTime(smooth, 720), 11, 1e-9),
  'smooth curve passes through every published point');
assert(near(cbTripTime(smooth, 400), 39.588037174953485, 1e-9), 'value between the points equals the backend (parity)');
assert(near(cbTripTime({ ...smooth, thermal_curve: { points: [[1.5, 400], [6, 15]] } }, 300), 72.66822153293934, 1e-9), 'two-point curve (TM-D) parity');
{
  let prev = Infinity, mono = true;
  for (let i = 0; i < 700; i++) { const t = cbTripTime(smooth, (1.5 + i * 0.01) * 100); if (!(t < prev)) mono = false; prev = t; }
  assert(mono, 'strictly falling across the published points (no overshoot)');
  const sl = (m) => { const h = 1e-5; return (Math.log(cbTripTime(smooth, m * (1 + h) * 100)) - Math.log(cbTripTime(smooth, m * (1 - h) * 100))) / (2 * h); };
  assert(Math.abs(sl(6 * (1 - 1e-4)) - sl(6 * (1 + 1e-4))) < 1e-3 && Math.abs(sl(7.2 * (1 - 1e-4)) - sl(7.2 * (1 + 1e-4))) < 1e-3, 'no kink at 6 and 7.2 x Ir');
  assert(Math.abs(sl(30) + 2) < 1e-6, 'I²t (slope -2) beyond the last point');
}

// ── published tolerances: the band, and the datasheet maximum as THE curve ───
const tolEntry = breaker('se_nsx100n_100');
TripUnit.adopt(tolEntry, 'se_nsx_ml567_100');
TripUnit.setDial(tolEntry, 'thermal_pickup', 1.0);
TripUnit.setDial(tolEntry, 'short_time_pickup', 10);
TripUnit.setDial(tolEntry, 'short_time_delay', 0.2);
TripUnit.setDial(tolEntry, 'instantaneous_pickup', 15);
TripUnit.setDial(tolEntry, 'long_time_delay', 16);
const tp = params(tolEntry);
assert(tp.trip_tol && tp.trip_tol.pickup[0] === 1.05 && tp.trip_tol.pickup[1] === 1.2, 'the breaker carries the published tolerances');
const band = (i) => cbTripBand(tp, i);
assert(band(104).tMax === Infinity && band(104).tMin === Infinity, 'below 1.05 x Ir: never operates');
assert(band(110).tMax === Infinity && isFinite(band(110).tMin), '1.05-1.20 x Ir is the pickup zone: not guaranteed (max), may operate (min)');
assert(near(band(150).tMax, 400, 1e-6) && near(band(150).tMin, 320, 1e-6), '1.5 x Ir: 400 s published maximum, 0 to -20 % -> 320 s fastest');
assert(near(band(600).tMax, 16, 1e-6) && near(band(600).tMin, 12.8, 1e-6), '6 x Ir: 16 s / 12.8 s');
assert(near(band(1100).tMax, 0.2) && near(band(1100).tMin, 0.14), 'Isd + 10 %: maximum break 200 ms, non-tripping time 140 ms (tsd 0.2)');
assert(band(1099).tMax > 1 && near(band(1099).tMin, 0.14), 'just below Isd + 10 %: not certain (long-time), but the short-time element may already act');
assert(near(band(900).tMin, 0.14) && band(899).tMin > 1, 'Isd - 10 % is where the short-time element may start');
assert(near(band(1725).tMax, 0.05) && near(band(1725).tMin, 0.01), 'Ii + 15 %: 50 ms maximum break, 10 ms non-tripping');
assert(near(band(1274).tMin, 0.14) && near(band(1275).tMin, 0.01), 'Ii - 15 % is where the instantaneous element may start');
assert(cbTripTime(tp, 1100) === band(1100).tMax && cbTripTime(tp, 1725) === band(1725).tMax, 'cbTripTime is the datasheet maximum');
for (const [tsd, brk] of [[0, 0.08], [0.1, 0.14], [0.2, 0.2], [0.3, 0.32], [0.4, 0.5]]) {
  assert(near(cbTripBand({ ...tp, short_time_delay: tsd }, 1200).tMax, brk), `tsd ${tsd} s: maximum break time ${brk * 1000} ms`);
}
assert(near(cbTripTime({ ...tp, long_time_delay: 0.5, short_time_pickup: 1.5, short_time_delay: 0.4 }, 720), 0.5),
  'above Isd the published curve is the break time (0.5 s), the long-time curve is not carried on');
assert(near(band(20000).tMax, 0.05) && near(band(20000).tMin, 0.01), 'flat above Ii: no I²t tail');
const gb = cbTripBand(base100, 1000);
assert(gb.tMin === gb.tMax && gb.tMax === cbTripTime(base100, 1000), 'a generic breaker has one curve (band = nominal)');
const tm100 = breaker('se_nsx100n_100');
const tmp = params(tm100);
assert(near(cbTripBand(tmp, 959).tMax, 15 * (6 / 9.59) ** 2, 1e-6) && cbTripBand(tmp, 960).tMax === 0.025,
  'TM-D: Ii + 20 % is where the magnetic element is certain (800 A -> 960 A)');
assert(near(cbTripBand(tmp, 150).tMin, 120, 1e-6) && near(cbTripBand(tmp, 150).tMax, 400, 1e-6), 'TM-D 1.5 x In: 120-400 s published');

// ── Acti9 MCB: the published thermal band and magnetic zone ─────────────────
const mcb = breaker('se_ic60n_c_16');
const mp = params(mcb);
assert(mcb.props.trip_unit === 'se_acti9_c_6_63' && mcb.props.cb_type === 'mcb' && mcb.props.pickup_base.magnetic === 'In', 'iC60N C16 carries its curve and a magnetic pickup against In');
{
  const b = (i) => cbTripBand(mp, i);
  assert(b(16 * 1.13).tMax === Infinity && b(16 * 1.13).tMin === Infinity, 'IEC 60898-1: no trip at 1.13 In');
  assert(b(16 * 1.46).tMax <= 3600 && b(16 * 1.46).tMax > 1000 && isFinite(b(16 * 1.46).tMin), 'trip within 1 h at 1.45 In (maximum), minimum finite');
  assert(b(16 * 2.55).tMax <= 60 && b(16 * 2.55).tMin >= 1, '2.55 In: 1 s ≤ t ≤ 60 s');
  assert(b(16 * 6.3).tMin > 0.1 && b(16 * 6.45).tMin === 0.01, 'C curve: the magnetic element may act from 6.4 x In');
  assert(b(16 * 9.59).tMax > 0.1 && b(16 * 9.6).tMax === 0.01, 'C curve: certain from 9.6 x In, less than 10 ms');
  assert(b(16 * 8).tMin < b(16 * 8).tMax, 'a band, not a line, in the magnetic zone');
  const d = params(breaker('se_ic60n_d_16'));
  assert(cbTripBand(d, 16 * 13.9).tMax > 0.1 && cbTripBand(d, 16 * 14).tMax === 0.01, 'D curve: certain from 14 x In (10-14 x In)');
}

// ── Masterpact MTZ MicroLogic X ─────────────────────────────────────────────
const mtz = breaker('se_mtz2_h1_1600');
assert(mtz.props.trip_unit === 'se_mtz_ml5x' && mtz.props.trip_unit_kind === 'electronic' && mtz.props.cb_type === 'acb', 'MTZ2 H1 1600 A defaults to 5.0 X');
assert(near(mtz.props.long_time_delay, 0.5) && near(mtz.props.short_time_pickup, 1.5) && mtz.props.short_time_delay === 0 && near(mtz.props.instantaneous_pickup, 2),
  'factory settings: tr 0.5 s, Isd 1.5 x Ir, tsd 0, Ii 2 x In');
TripUnit.setDial(mtz, 'long_time_delay', 4);
TripUnit.setDial(mtz, 'short_time_pickup', 10);
TripUnit.setDial(mtz, 'instantaneous_pickup', 15);
const mp2 = params(mtz);
assert(near(cbTripBand(mp2, 1.5 * 1600).tMax, 100) && near(cbTripBand(mp2, 1.5 * 1600).tMin, 80), 'tr 4 s: 100 s at 1.5 x Ir, accuracy -20 %');
TripUnit.setDial(mtz, 'long_time_delay', 1);
assert(near(cbTripBand(params(mtz), 6 * 1600).tMax, 1) && near(cbTripBand(params(mtz), 6 * 1600).tMin, 0.7), 'tr 1 s: accuracy -30 %');
TripUnit.setDial(mtz, 'long_time_delay', 2);
assert(near(cbTripBand(params(mtz), 6 * 1600).tMin, 1.5), 'tr 2 s: accuracy -25 %');
TripUnit.setDial(mtz, 'instantaneous_pickup', 0);   // Ii OFF: no instantaneous element at all
assert(mtz.props.magnetic_pickup === 1000 && cbTripBand(params(mtz), 100000).tMax === cbTripBand(params(mtz), 20000).tMax,
  'Ii OFF: no 10 x Ir fallback — the short-time plateau runs on');
TripUnit.adopt(mtz, 'se_mtz_ml2x');
assert(mtz.props.pickup_base.instantaneous === 'In' && mtz.props.magnetic_pickup === 1000, 'MicroLogic 2.0 X: instantaneous is Isd (S0), no separate Ii');

// ── NSXm ───────────────────────────────────────────────────────────────────
const m = breaker('se_nsxm_n_100');
assert(m.props.trip_unit === 'se_nsxm_tmd_100' && near(cbElementsA(params(m)).im, 1250), 'NSXm TM100D: Ii fixed 1250 A');
TripUnit.adopt(m, 'se_nsxm_vigi41_100');
TripUnit.setDial(m, 'thermal_pickup', 0.5);
assert(near(cbElementsA(params(m)).ir, 50) && near(cbElementsA(params(m)).ii, 1500), 'Vigi 4.1: Ii fixed 1500 A whatever the Ir dial');

// ── a manufacturer's breaker has its own functions only ──────────────────────
const optVals = (comp) => [...TripUnit._profileOptions(comp).matchAll(/<option value="([^"]*)"/g)].map(m => m[1]);
assert(optVals(tm100).join() === 'se_nsx_tmd_100,se_nsx_ml2_100,se_nsx_ml567_100', 'a Schneider NSX offers its own trip units only — no generic profile, no free settings');
assert(optVals(mcb).join() === 'se_acti9_c_6_63', 'an Acti9 MCB offers its one curve');
const generic2 = { type: 'cb', props: { cb_type: 'mccb', standard_type: 'mccb_250a', trip_rating_a: 250 } };
TripUnit.apply(generic2, STANDARD_CBS.find(c => c.id === 'mccb_250a'), 'tm_adj');
assert(optVals(generic2)[0] === '' && optVals(generic2).includes('etu_lsi_mccb'), 'a generic breaker keeps free settings and the generic profiles');

// ── ABB Emax 2 (Ekip Dip): formula long-time curve, S and I against In ──────
const ab = breaker('abb_e2_2_n_1600');
assert(ab.props.trip_unit === 'abb_emax2_dip_lsi' && ab.props.pickup_base.short_time === 'In' && ab.props.pickup_base.instantaneous === 'In',
  'Ekip Dip: S and I are multiples of In');
assert(near(ab.props.long_time_delay, 144) && near(ab.props.instantaneous_pickup, 4) && ab.props.short_time_pickup === 0, 'factory: t1 144 s, I3 4 x In, S off');
TripUnit.setDial(ab, 'long_time_delay', 24);
TripUnit.setDial(ab, 'short_time_pickup', 6);
TripUnit.setDial(ab, 'short_time_delay', 0.3);
TripUnit.setDial(ab, 'instantaneous_pickup', 10);
TripUnit.setDial(ab, 'thermal_pickup', 0.5);                 // I1 = 800 A: S and I stay at 9600 / 16000 A
let ae = cbElementsA(params(ab));
assert(near(ae.ir, 800) && near(ae.isd, 9600) && near(ae.ii, 16000), 'I1 800 A; I2 6 x In = 9600 A and I3 10 x In = 16000 A do not move');
const abp = params(ab);
assert(near(cbTripBand(abp, 3 * 800).tMax, 24 * 1.1, 1e-9) && near(cbTripBand(abp, 3 * 800).tMin, 24 * 0.9, 1e-9), 't1 24 s at 3 x I1, +/-10 %');
assert(near(cbTripBand(abp, 10 * 800).tMax, 24 * 0.09 * 1.1, 1e-9), '10 x I1 = 8000 A is 5 x In: still +/-10 %');
assert(cbTripBand(abp, 1.1 * 800).tMax === Infinity && isFinite(cbTripBand(abp, 1.1 * 800).tMin), 'pickup zone 1.05-1.2 x I1');
assert(cbTripBand(abp, 9600 * 1.069).tMax > 1 && near(cbTripBand(abp, 9600 * 1.071).tMax, 0.33, 1e-9), 'I2 +/-7 % up to 6 x In, then t2 + min(10 %, 40 ms)');
assert(near(cbTripBand(abp, 9600 * 0.93).tMin, 0.27, 1e-9), 'I2 - 7 %: the short-time element may act, 0.3 s - 30 ms');
assert(near(cbTripBand(abp, 16000 * 1.1001).tMax, 0.03, 1e-9), 'I3 + 10 %: at most 30 ms');
TripUnit.adopt(ab, 'abb_emax2_dip_li');
assert(ab.props.short_time_pickup === 0 && near(ab.props.instantaneous_pickup, 10), 'Ekip Dip LI has no S: it is blocked, not supplied by the generic model');

// ── ABB Tmax XT: TMA I3 in amps against In; Ekip Dip LS/I as two profiles ──
const x4 = breaker('abb_xt4s_250');
assert(x4.props.trip_unit === 'abb_xt_tm_xt4_250' && x4.props.trip_unit_kind === 'tm' && x4.props.pickup_base.magnetic === 'In',
  'XT4 TMA: I3 is held against In');
TripUnit.setDial(x4, 'thermal_pickup', 0.7);
const x4p = params(x4);
assert(near(cbElementsA(x4p).ir, 175) && near(cbElementsA(x4p).im, 2500), 'I1 0.7 x In = 175 A; I3 stays 2500 A');
assert(near(cbTripBand(x4p, 2500 * 1.21).tMax, 0.0157, 1e-9) && cbTripBand(x4p, 2500 * 1.19).tMax > 1, 'I3 +/-20 %, 0.016 s break');
assert(cbTripBand(x4p, 1.29 * 175).tMax === Infinity && isFinite(cbTripBand(x4p, 1.29 * 175).tMin), 'TM pickup zone 1.05-1.3 x I1');
TripUnit.adopt(x4, 'abb_xt_dip_ls_xt24');
assert(x4.props.trip_unit_kind === 'electronic' && x4.props.instantaneous_pickup === 0 && x4.props.magnetic_pickup === 1000
  && near(x4.props.short_time_pickup, 10), 'Ekip Dip LS/I set as L-S: S on, no instantaneous element');
const lsp = params(x4);
assert(near(cbTripBand(lsp, 50 * 250).tMax, 0.1 * 1.15, 1e-9), 'L-S: t2 0.1 s +/-15 % even at 50 x In');
TripUnit.adopt(x4, 'abb_xt_dip_lsi_xt24');
TripUnit.setDial(x4, 'thermal_pickup', 1.0);
assert(near(cbTripBand(params(x4), 3 * 250).tMax, 12 * 1.1, 1e-9) && near(cbTripBand(params(x4), 5 * 250).tMax, 12 * 0.36 * 1.2, 1e-9),
  'Ekip Dip: t1 12 s at 3 x I1, +/-10 % up to 4 x In, +/-20 % above');

// ── dial units name the base ───────────────────────────────────────────────
assert(TripUnit.unitOf('instantaneous_pickup', TRIP_UNITS.se_nsx_ml567_100.dials.instantaneous_pickup) === '× In', 'Ii unit reads × In');
assert(TripUnit.unitOf('short_time_pickup', TRIP_UNITS.se_nsx_ml567_100.dials.short_time_pickup) === '× Ir', 'Isd unit reads × Ir');
assert(TripUnit.unitOf('magnetic_pickup', TRIP_UNITS.tm_adj.dials.magnetic_pickup) === '× Ir', 'a generic profile keeps × Ir');

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall pickup-base checks passed');
