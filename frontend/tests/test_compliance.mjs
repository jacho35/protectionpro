/* ProtectionPro — compliance rules regression test (compliance review
 * 2026-09-29, C1–C9, L1–L5; write-up COMPLIANCE_REVIEW.md).
 *
 * Runs the REAL frontend/js/compliance.js (with constants.js for the trip
 * curves) against expectations derived from the standards, never from the
 * module's earlier output. The fault numbers below are the real fault
 * engine's maximum and minimum (c_min = 0.95, 70 °C) studies of
 * testing/compliance-review/build_fault.py:
 *   Grid 11 kV 250 MVA → 1 MVA Dyn11 11/0.42 kV → MSB 0.4 kV
 *   MSB → 160 A MCCB → 35 mm² Cu/PVC 200 m → DB-1
 *   DB-1 → 32 A type-C MCB → 4 mm² Cu/PVC 60 m → Sockets
 *
 * Run:  node frontend/tests/test_compliance.mjs   (exit code 1 on failure)
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const js = join(dirname(fileURLToPath(import.meta.url)), '..', 'js');
const ctx = { console, Math, window: {}, document: { addEventListener() {} },
  Components: { validate: () => ({ errors: [], warnings: [] }) }, escHtml: s => String(s) };
vm.createContext(ctx);
const { Compliance, cbTripTime } = vm.runInContext(
  `${readFileSync(join(js, 'constants.js'), 'utf8')}\n${readFileSync(join(js, 'compliance.js'), 'utf8')}\n;({ Compliance, cbTripTime });`, ctx);

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; }
  else console.log(`ok: ${msg}`);
}

const comp = (id, type, props) => ({ id, type, x: 0, y: 0, props });
const wire = (id, a, b, fp = 'bottom', tp = 'top') => ({ id, fromComponent: a, fromPort: fp, toComponent: b, toPort: tp });
function state(s) {
  ctx.AppState = {
    projectName: 't', baseMVA: 100, frequency: 50,
    components: new Map((s.components || []).map(c => [c.id, c])),
    wires: new Map((s.wires || []).map(w => [w.id, w])),
    faultResults: s.faultResults || null, faultResultsMin: s.faultResultsMin || null,
    loadFlowResults: s.loadFlowResults || null, dbCheckResults: null,
  };
}
const items = (re, section = null) => {
  const r = Compliance.generate();
  const out = [];
  for (const s of r.sections) {
    if (section && !s.title.startsWith(section)) continue;
    for (const i of s.items) if (re.test(`${i.component} ${i.message}`)) out.push(i);
  }
  return out;
};

const bus = (voltage_kv, ik3, ik1, ikLL, ikLLG, kappa) => ({ voltage_kv, ik3, ik1, ikLL, ikLLG, kappa, ib: ik3, ip: kappa * Math.SQRT2 * ik3 });
const FMAX = { buses: {
  b11: bus(11, 13.122, 13.122, 11.364, 13.122, 1.746), bA: bus(0.4, 26.118, 26.832, 22.619, 27.585, 1.698),
  bB: bus(0.4, 2.33, 1.415, 2.017, 1.016, 1.02), bC: bus(0.4, 0.662, 0.398, 0.573, 0.284, 1.02) } };
const FMIN = { buses: {
  b11: bus(11, 13.122, 13.122, 11.364, 13.122, 1.746), bA: bus(0.4, 22.805, 23.347, 19.749, 23.915, 1.697),
  bB: bus(0.4, 1.694, 1.026, 1.467, 0.736, 1.02), bC: bus(0.4, 0.477, 0.287, 0.413, 0.205, 1.02) } };
const cable = (name, size_mm2, r, len, amps) => ({ name, conductor: 'Cu', insulation: 'PVC', size_mm2,
  r_per_km: r, x_per_km: 0.08, length_km: len, voltage_kv: 0.4, rated_amps: amps, num_parallel: 1 });
const MCCB = { name: 'CB-SubMain', cb_type: 'mccb', rated_current_a: 160, trip_rating_a: 160, magnetic_pickup: 10,
  thermal_pickup: 1, long_time_delay: 10, rated_voltage_kv: 0.4, breaking_capacity_ka: 36, circuit_type: 'distribution' };
const MCB = { name: 'MCB-Sockets', cb_type: 'mcb', mcb_curve: 'C', rated_current_a: 32, trip_rating_a: 32, magnetic_pickup: 10,
  thermal_pickup: 1, long_time_delay: 10, rated_voltage_kv: 0.4, breaking_capacity_ka: 6, circuit_type: 'final_socket' };
function lvNet({ cF = {}, cS = {}, xf = {}, extra = [], extraWires = [] } = {}) {
  return {
    components: [
      comp('u', 'utility', { name: 'Grid', voltage_kv: 11, fault_mva: 250 }),
      comp('b11', 'bus', { name: 'MV', voltage_kv: 11 }),
      comp('t', 'transformer', { name: 'T1', rated_mva: 1, voltage_hv_kv: 11, voltage_lv_kv: 0.42, vector_group: 'Dyn11',
        grounding_lv: 'solidly_grounded', earthing_system: 'TN-S', ...xf }),
      comp('bA', 'bus', { name: 'MSB', voltage_kv: 0.4 }),
      comp('cbF', 'cb', MCCB), comp('cF', 'cable', { ...cable('C-SubMain', 35, 0.524, 0.2, 140), ...cF }),
      comp('bB', 'bus', { name: 'DB-1', voltage_kv: 0.4 }),
      comp('cbS', 'cb', MCB), comp('cS', 'cable', { ...cable('C-Sockets', 4, 4.61, 0.06, 36), ...cS }),
      comp('bC', 'bus', { name: 'Sockets', voltage_kv: 0.4 }), ...extra,
    ],
    wires: [wire('1', 'u', 'b11'), wire('2', 'b11', 't', 'bottom', 'primary'), wire('3', 't', 'bA', 'secondary', 'top'),
      wire('4', 'bA', 'cbF'), wire('5', 'cbF', 'cF'), wire('6', 'cF', 'bB'),
      wire('7', 'bB', 'cbS'), wire('8', 'cbS', 'cS'), wire('9', 'cS', 'bC'), ...extraWires],
    faultResults: FMAX, faultResultsMin: FMIN,
  };
}

// ── C1: earth-fault disconnection judged at the far end of the circuit ──
{
  state(lvNet());
  const tMcb = cbTripTime({ cb_type: 'mcb', trip_rating_a: 32, thermal_pickup: 1, magnetic_pickup: 10, long_time_delay: 10 }, 287);
  const tMccb = cbTripTime({ cb_type: 'mccb', trip_rating_a: 160, thermal_pickup: 1, magnetic_pickup: 10, long_time_delay: 10 }, 1026);
  assert(tMcb > 0.4 && tMccb > 5, `C1 reference: C32 MCB at 287 A takes ${tMcb.toFixed(2)} s (> 0.4 s); 160 A MCCB at 1026 A ${tMccb.toFixed(2)} s (> 5 s)`);
  const mcb = items(/MCB-Sockets/, 'SANS').filter(i => /clear|Disconnects|operate/.test(i.message));
  assert(mcb.length === 1 && mcb[0].status === 'fail' && /287 A at the far end Sockets/.test(mcb[0].message),
    'C1: socket MCB judged at the Sockets end (287 A) → FAIL, not at DB-1 (1026 A)');
  const mccb = items(/CB-SubMain/, 'SANS').filter(i => /clear|Disconnects|operate/.test(i.message));
  assert(mccb.length === 1 && mccb[0].status === 'fail' && /DB-1/.test(mccb[0].message),
    'C1: sub-main MCCB judged at DB-1 (1026 A, 8.7 s > 5 s) → FAIL, not at the MSB (23 kA)');
  // A shorter socket run reaches the magnetic region → PASS
  state(lvNet({ cS: { length_km: 0.02 } }));
  ctx.AppState.faultResultsMin = { buses: { ...FMIN.buses, bC: bus(0.4, 1.0, 0.8, 0.87, 0.6, 1.02) } };
  const ok = items(/MCB-Sockets/, 'SANS').filter(i => /Disconnects/.test(i.message));
  assert(ok.length === 1 && ok[0].status === 'pass', 'C1: 800 A at the far end (> 10·In) → instantaneous PASS');
  // Bus-less final circuit: the far end is the load's synthetic terminal node
  const s2 = lvNet({ extra: [comp('ld', 'static_load', { name: 'Heater', rated_kva: 5, voltage_kv: 0.4 })],
    extraWires: [wire('10', 'cS', 'ld')] });
  s2.components = s2.components.filter(c => c.id !== 'bC');
  s2.wires = s2.wires.filter(w => w.id !== '9');
  s2.faultResults = { buses: { ...FMAX.buses, __term__ld: FMAX.buses.bC } };
  s2.faultResultsMin = { buses: { ...FMIN.buses, __term__ld: FMIN.buses.bC } };
  delete s2.faultResults.buses.bC; delete s2.faultResultsMin.buses.bC;
  state(s2);
  const term = items(/MCB-Sockets/, 'SANS').filter(i => /clear/.test(i.message));
  assert(term.length === 1 && term[0].status === 'fail' && /Heater terminals/.test(term[0].message),
    'C1: a cable to a load with no bus is judged at the load terminals (__term__)');
}

// ── C2: cable withstand at the largest AND the smallest current ──
{
  state(lvNet());
  const w = items(/CB-SubMain/, 'Cable Short');
  // (a) largest: I"kLLG 27.6 kA at the MSB, 20 ms magnetic, Ith = I·√(m+1)
  const m = (k, t) => { const x = Math.log(k - 1); return (Math.exp(4 * 50 * t * x) - 1) / (2 * 50 * t * x); };
  const allow = Math.pow(115 * 35 / (27585 * Math.sqrt(m(1.698, 0.02) + 1)), 2);
  assert(allow < 0.02, `C2 reference: 35 mm² PVC withstand at 27.6 kA (Ith) = ${allow.toFixed(4)} s < 0.02 s`);
  assert(w.some(i => i.status === 'fail' && /EXCEEDS/.test(i.message)), 'C2(a): near-end largest current fails the 35 mm² sub-main (was PASS at the far-end Ik3)');
  // (b) smallest: 1026 A at DB-1 is not cleared within 5 s and the MCCB (Ir 160 A) does not give §433.1 overload protection of Iz 140 A
  assert(w.some(i => i.status === 'fail' && /Minimum far-end fault \(1026 A at DB-1\) is not cleared/.test(i.message)),
    'C2(b): far-end minimum fault not cleared in 5 s → FAIL');
  // §435.1: an overload-coordinated device covers the far end
  state(lvNet({ cF: { rated_amps: 170 } }));
  const w2 = items(/CB-SubMain/, 'Cable Short');
  assert(w2.some(i => i.status === 'pass' && /§435.1/.test(i.message)), 'C2(b): In ≤ Iz, I2 ≤ 1.45·Iz → covered by §435.1');
  // far end, cleared in time but too slowly for the conductor: 2.5 mm² sockets
  state(lvNet({ cS: { size_mm2: 2.5 } }));
  const w3 = items(/MCB-Sockets/, 'Cable Short');
  const tFar = cbTripTime({ cb_type: 'mcb', trip_rating_a: 32, thermal_pickup: 1, magnetic_pickup: 10, long_time_delay: 10 }, 287);
  assert(tFar > Math.pow(115 * 2.5 / 287, 2), `C2 reference: 2.5 mm² at 287 A allows ${Math.pow(115 * 2.5 / 287, 2).toFixed(2)} s < ${tFar.toFixed(2)} s`);
  assert(w3.some(i => i.status === 'fail' && /EXCEEDS/.test(i.message) && /1.98|1.9/.test(i.message)), 'C2(b): 2.5 mm² fails at the far-end minimum current');
  // Only the supply-side device counts
  const s4 = lvNet({ extra: [comp('cbInc', 'cb', { ...MCB, name: 'DB-Incomer', rated_current_a: 125, trip_rating_a: 125 })] });
  s4.wires = s4.wires.map(x => x.id === '6' ? wire('6', 'cF', 'cbInc') : x).concat([wire('6b', 'cbInc', 'bB')]);
  state(s4);
  assert(items(/DB-Incomer/, 'Cable Short').length === 0, 'C2: a load-side incomer is not credited with the cable\'s short-circuit protection');
  // Table 43A: PVC above 300 mm²
  assert(Compliance._kFactor('Cu', 'PVC', 400) === 103 && Compliance._kFactor('Al', 'PVC', 400) === 68
    && Compliance._kFactor('Cu', 'PVC', 300) === 115, 'C2: k = 103 Cu / 68 Al for PVC above 300 mm² (Table 43A)');
}

// ── C3: §433.1 — I2 ≤ 1.45·Iz, In = setting, parallel runs ──
{
  const net = (dev, cab = {}) => ({
    components: [comp('b1', 'bus', { name: 'B1', voltage_kv: 0.4 }), dev,
      comp('c', 'cable', { name: 'C', voltage_kv: 0.4, rated_amps: 105, size_mm2: 25, ...cab }),
      comp('b2', 'bus', { name: 'B2', voltage_kv: 0.4 })],
    wires: [wire('1', 'b1', 'f'), wire('2', 'f', 'c'), wire('3', 'c', 'b2')] });
  state(net(comp('f', 'fuse', { name: 'F100', rated_current_a: 100 })));
  const f = items(/F100/, 'SANS').filter(i => /Iz/.test(i.message));
  assert(f.length === 1 && f[0].status === 'fail' && /I2 = 1.6·In = 160 A/.test(f[0].message),
    'C3: 100 A gG on Iz 105 A — I2 160 A > 1.45·Iz 152 A → FAIL (was PASS on In ≤ Iz)');
  state(net(comp('f', 'cb', { name: 'MCCB', cb_type: 'mccb', rated_current_a: 250, trip_rating_a: 100, thermal_pickup: 1 })));
  const c = items(/MCCB/, 'SANS').filter(i => /Iz/.test(i.message));
  assert(c.length === 1 && c[0].status === 'pass', 'C3: 250 A frame set to Ir 100 A → In = Ir → PASS (was FAIL on the frame)');
  state(net(comp('f', 'cb', { name: 'ACB', cb_type: 'acb', rated_current_a: 400, trip_rating_a: 400 }), { rated_amps: 250, num_parallel: 2 }));
  const p = items(/ACB/, 'SANS').filter(i => /Iz/.test(i.message));
  assert(p.length === 1 && p[0].status === 'pass', 'C3: 400 A on 2 × 250 A parallel runs (Iz 500 A) → PASS (was FAIL on one run)');
}

// ── C4: earthing per LV installation ──
{
  // A TT transformer elsewhere no longer switches off the TN check
  state(lvNet({ extra: [comp('t2', 'transformer', { name: 'T-TT', voltage_hv_kv: 11, voltage_lv_kv: 0.42,
    vector_group: 'Dyn11', grounding_lv: 'solidly_grounded', earthing_system: 'TT', earth_electrode_r_installation: 20 })] }));
  assert(items(/MCB-Sockets/, 'SANS').some(i => /clear/.test(i.message)), 'C4: TN disconnection still checked with a TT source in another installation');
  // TT circuit itself: deferred to the earthing-system check
  state(lvNet({ xf: { earthing_system: 'TT' } }));
  assert(!items(/MCB-Sockets|CB-SubMain/, 'SANS').some(i => /clear|Disconnects/.test(i.message)), 'C4: devices in a TT installation are not judged on the TN criterion');
  // R_A·IΔn with a breaker earth-fault release at 5 A
  const tt = (efA) => ({
    components: [comp('t', 'transformer', { name: 'T-TT', voltage_hv_kv: 11, voltage_lv_kv: 0.42, vector_group: 'Dyn11',
      grounding_lv: 'solidly_grounded', earthing_system: 'TT', earth_electrode_r_installation: 20 }),
      comp('b', 'bus', { name: 'LV', voltage_kv: 0.4 }),
      comp('cb', 'cb', { name: 'CB-EF', cb_type: 'mccb', ef_trip_ct: 'ct1', ef_pickup_a: efA }), comp('ct1', 'ct', { name: 'CBCT' })],
    wires: [wire('1', 't', 'b', 'secondary', 'top'), wire('2', 'b', 'cb')] });
  state(tt(5));
  const r5 = items(/T-TT/, 'SANS').filter(i => /R_A/.test(i.message));
  assert(r5.length === 1 && r5[0].status === 'fail' && /100.0 V/.test(r5[0].message), 'C4: 20 Ω × 5 A = 100 V > 50 V → FAIL (was 20 Ω × 300 mA = 6 V PASS)');
  state(tt(2));
  assert(items(/T-TT/, 'SANS').some(i => i.status === 'pass' && /40.0 V/.test(i.message)), 'C4: 20 Ω × 2 A = 40 V → PASS');
  // An RCD in another installation does not satisfy this one
  const s = tt(2);
  s.wires = [];
  state(s);
  assert(items(/T-TT/, 'SANS').some(i => i.status === 'fail' && /without an RCD/.test(i.message)), 'C4: a residual device outside the TT installation does not count');
}

// ── C5: vector-group case (IEC 60076-1: capitals HV, lower case LV) ──
{
  const xf = (vg, g, sys = 'TN-S') => {
    state({ components: [comp('t', 'transformer', { name: 'T', voltage_hv_kv: 11, voltage_lv_kv: 0.4, vector_group: vg, grounding_lv: g, earthing_system: sys })] });
    return items(/^T /, 'SANS').filter(i => /neutral|delta/i.test(i.message))[0];
  };
  assert(xf('YNd11', 'solidly_grounded').status === 'warn', 'C5: YNd11 — LV delta, no neutral; TN-S declared → WARN (was PASS on the HV "YN")');
  assert(xf('Dy11', 'solidly_grounded').status === 'pass', 'C5: Dy11 with the LV neutral solidly earthed → PASS (grounding prop authoritative)');
  assert(xf('Dyn11', 'solidly_grounded').status === 'pass', 'C5: Dyn11 solidly earthed → PASS');
  assert(xf('Dyn11', 'ungrounded').status === 'fail', 'C5: Dyn11 ungrounded on TN-S → FAIL');
  assert(xf('Dd0', 'ungrounded', 'IT').status === 'info', 'C5: delta LV on a declared IT system → INFO');
  assert(xf('Dyn11', 'resistance_grounded').status === 'warn', 'C5: impedance-earthed LV neutral → WARN');
}

// ── C6: maximum demand reads the props loads actually have ──
{
  state({ components: [comp('t', 'transformer', { name: 'T', rated_mva: 0.1, voltage_hv_kv: 11, voltage_lv_kv: 0.4 }),
    comp('b', 'bus', { name: 'LV', voltage_kv: 0.4 }),
    comp('l', 'static_load', { name: 'L', rated_kva: 60, power_factor: 0.8, demand_factor: 1, voltage_kv: 0.4 }),
    comp('m', 'motor_induction', { name: 'M', rated_kw: 37, efficiency: 0.93, power_factor: 0.85, demand_factor: 1, voltage_kv: 0.4 })],
    wires: [wire('1', 't', 'b', 'secondary'), wire('2', 'b', 'l'), wire('3', 'b', 'm')] });
  // P = 48 + 37/0.93 = 87.8 kW; Q = 36 + 46.8·0.527 = 60.6 kvar → 106.7 kVA > 100 kVA
  const md = items(/./, 'SANS').filter(i => /transformer capacity/.test(i.message));
  assert(md.length === 1 && md[0].status === 'fail' && /0\.10[67]/.test(md[0].message), 'C6: 60 kVA + 37 kW motor (106.7 kVA) on 100 kVA → FAIL (was no result)');
}

// ── C7: MV rated voltage vs Um (IEC 62271-1) ──
{
  const v = (ur) => {
    state({ components: [comp('b', 'bus', { name: 'B11', voltage_kv: 11 }), comp('cb', 'cb', { name: 'CB11', rated_voltage_kv: ur })], wires: [wire('1', 'b', 'cb')] });
    return items(/CB11/, 'Protection').filter(i => /Rated voltage/.test(i.message))[0].status;
  };
  assert(v(11) === 'warn' && v(12) === 'pass' && v(10) === 'fail', 'C7: 11 kV bus — Ur 10 FAIL, 11 WARN (< Um 12), 12 PASS');
}

// ── C8: diagram flag uses the report's breaking basis ──
{
  const s = lvNet();
  s.components = s.components.map(c => c.id === 'cbF' ? comp('cbF', 'cb', { ...MCCB, breaking_capacity_ka: 26.5 }) : c);
  state(s);
  assert(Compliance.deviceRatingFlags().get('cbF')?.level === 'fail', 'C8: Icu 26.5 kA < Ik1 26.8 kA flags on the diagram (Ik3 26.1 kA alone did not)');
}

// ── C9: an HV device carries the HV current of a transformer branch ──
{
  state({ components: [comp('b', 'bus', { name: 'MV', voltage_kv: 11 }), comp('cb', 'cb', { name: 'CB-HV', rated_current_a: 630, rated_voltage_kv: 12 }),
    comp('t', 'transformer', { name: 'T', rated_mva: 1, voltage_hv_kv: 11, voltage_lv_kv: 0.4 }), comp('b2', 'bus', { name: 'LV', voltage_kv: 0.4 })],
    wires: [wire('1', 'b', 'cb'), wire('2', 'cb', 't', 'bottom', 'primary'), wire('3', 't', 'b2', 'secondary')],
    loadFlowResults: { converged: true, buses: { b: { voltage_pu: 1, voltage_kv: 11 } },
      branches: [{ elementId: 't', s_mva: 1.0, i_amps: 1443, loading_pct: 100 }] } });
  assert(!items(/CB-HV/, 'Protection').some(i => /EXCEEDS rated current/.test(i.message)), 'C9: 630 A HV breaker on a 1 MVA transformer (52 A) is not failed on the 1443 A LV current');
}

// ── Lesser notes ──
{
  state({ components: [comp('u', 'utility', { name: 'G', voltage_kv: 11 }), comp('b', 'bus', { name: 'B', voltage_kv: 11, bus_type: 'PQ' })], wires: [wire('1', 'u', 'b')] });
  assert(!items(/./, 'Network').some(i => /Swing/.test(i.message)), 'L1: no spurious "No Swing bus" warning — the load flow picks the slack from the sources');
  state({ components: [comp('b1', 'bus', { name: 'B1', voltage_kv: 0.4 }), comp('c', 'cable', { name: 'C', standard_type: 'cu_pvc_1.5_lv', rated_amps: 18, voltage_kv: 0.4 })],
    wires: [wire('1', 'b1', 'c')] });
  const std = ctx.AppState && vm.runInContext('STANDARD_CABLES', ctx).find(c => c.size_mm2 === 1.5);
  if (std) {
    ctx.AppState.components.get('c').props.standard_type = std.id;
    assert(items(/^C /, 'SANS').some(i => /1.5 mm²/.test(i.message)), `L2: a library cable (${std.id}) is size-checked without size_mm2 on its props`);
  }
  const trip = Compliance._deviceMagneticTripA({ type: 'cb', props: { cb_type: 'mcb', mcb_curve: 'C', rated_current_a: 16 } });
  assert(trip.a === 80, 'L4: type-C MCB is guaranteed to hold only up to 5·In (80 A for 16 A), not 10·In');
  ctx.Components.validate = () => ({ errors: [], warnings: [{ compId: 'b', msg: 'x' }] });
  state({ components: [comp('b', 'bus', { name: 'BusX', voltage_kv: 11 })] });
  assert(items(/BusX x/, 'Network').length === 1, 'L5: validation findings name their component');
  ctx.Components.validate = () => ({ errors: [], warnings: [] });
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall compliance checks passed');
