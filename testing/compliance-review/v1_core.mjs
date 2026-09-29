// Compliance review — independent evidence. Run: node testing/compliance-review/v1_core.mjs
// (net_lv.json comes from build_fault.py — the real fault engine, max + min study.)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadCompliance, find, comp, wire } from './harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const net = JSON.parse(readFileSync(join(here, 'net_lv.json'), 'utf8'));
const C = loadCompliance();
const show = (items) => items.forEach(i => console.log(`   [${i.status.toUpperCase()}] ${i.section}: ${i.component} — ${i.message}`));

// ── Earth-fault disconnection (IEC 60364-4-41 §411.3.2, Table 41.1) ──
console.log('== Earth-fault disconnection: where is the device judged?');
C.setState({ components: net.project.components, wires: net.project.wires,
  faultResults: net.faultResults, faultResultsMin: net.faultResultsMin });
const mn = net.faultResultsMin.buses;
const thermal = (p, i) => C.cbTripTime(p, i);
const mcb = { cb_type: 'mcb', trip_rating_a: 32, thermal_pickup: 1, magnetic_pickup: 10, long_time_delay: 10 };
const mccb = { cb_type: 'mccb', trip_rating_a: 160, thermal_pickup: 1, magnetic_pickup: 10, long_time_delay: 10 };
console.log(`  MCB-Sockets C32: far end Sockets Ik1min = ${(mn.bC.ik1 * 1000).toFixed(0)} A -> t = ${thermal(mcb, mn.bC.ik1 * 1000).toFixed(2)} s vs 0.4 s  => predicted FAIL`);
console.log(`  CB-SubMain 160 A: far end DB-1  Ik1min = ${(mn.bB.ik1 * 1000).toFixed(0)} A -> t = ${thermal(mccb, mn.bB.ik1 * 1000).toFixed(2)} s vs 5 s   => predicted FAIL`);
let r = C.Compliance.generate();
console.log('  engine:');
show(find(r, /MCB-Sockets|CB-SubMain|Sockets|DB-1|MSB/).filter(i => i.section.startsWith('SANS') && /disconnect|clear|protection device/.test(i.message)));

// ── Cable short-circuit withstand (IEC 60364-4-43 §434.5.2) ──
console.log('\n== Cable withstand: k²S² >= I²t at the largest AND the smallest fault current');
const k = 115;
for (const [cab, S, dev, near, far] of [['C-SubMain', 35, mccb, 'bA', 'bB'], ['C-Sockets', 4, mcb, 'bB', 'bC']]) {
  const mxb = net.faultResults.buses[near];
  const Imax = Math.max(mxb.ik3, mxb.ik1 || 0) * 1000;
  const Imin = Math.min(mn[far].ik3, mn[far].ik1 || Infinity) * 1000;
  const tMax = thermal(dev, Imax), tMin = thermal(dev, Imin);
  console.log(`  ${cab}: near Imax ${Imax.toFixed(0)} A t=${tMax.toFixed(3)} s allow ${((k * S / Imax) ** 2).toFixed(3)} s | far Imin ${Imin.toFixed(0)} A t=${tMin.toFixed(2)} s allow ${((k * S / Imin) ** 2).toFixed(2)} s`);
}
console.log('  engine:');
show(find(r, /C-SubMain|C-Sockets/).filter(i => i.section.startsWith('Cable Short')));

// ── LV neutral: vector-group letters are case-sensitive (IEC 60076-1 §D) ──
console.log('\n== LV neutral earthing check vs vector group (upper case = HV, lower case = LV)');
for (const [vg, g, want] of [['Dyn11', 'solidly_grounded', 'pass'], ['YNd11', 'solidly_grounded', 'warn (LV delta, TN-S declared)'],
                             ['Dy11', 'solidly_grounded', 'pass (grounding prop authoritative)'], ['Yd1', 'ungrounded', 'warn (LV delta, TN-S declared)']]) {
  C.setState({ components: [comp('t', 'transformer', { name: 'T', voltage_hv_kv: 11, voltage_lv_kv: 0.4, vector_group: vg, grounding_lv: g, earthing_system: 'TN-S' })], wires: [] });
  const it = find(C.Compliance.generate(), /^T /).filter(i => /neutral/i.test(i.message))[0];
  console.log(`  ${vg.padEnd(6)} grounding_lv=${g.padEnd(16)} expected ${want.padEnd(36)} engine [${it.status}] ${it.message}`);
}

// ── §433.1: In <= Iz AND I2 <= 1.45 Iz ──
console.log('\n== Overload coordination (IEC 60364-4-43 §433.1) — gG fuse I2 = 1.6 In');
{
  const comps = [comp('b1', 'bus', { name: 'B1', voltage_kv: 0.4 }), comp('f', 'fuse', { name: 'F100', rated_current_a: 100, fuse_type: 'gG' }),
    comp('c', 'cable', { name: 'C', voltage_kv: 0.4, rated_amps: 105, size_mm2: 25 }), comp('b2', 'bus', { name: 'B2', voltage_kv: 0.4 })];
  C.setState({ components: comps, wires: [wire('1', 'b1', 'f'), wire('2', 'f', 'c'), wire('3', 'c', 'b2')] });
  console.log(`  100 A gG on Iz = 105 A: In <= Iz ok, I2 = 160 A vs 1.45 Iz = ${(1.45 * 105).toFixed(0)} A  => predicted FAIL`);
  show(find(C.Compliance.generate(), /F100/).filter(i => /Iz/.test(i.message)));
  const mc = comps.map(c => c.id === 'f' ? comp('f', 'cb', { name: 'MCCB', cb_type: 'mccb', rated_current_a: 250, trip_rating_a: 100, thermal_pickup: 1 }) : c);
  C.setState({ components: mc, wires: [wire('1', 'b1', 'f'), wire('2', 'f', 'c'), wire('3', 'c', 'b2')] });
  console.log(`  250 A-frame MCCB set to Ir = 100 A on Iz = 105 A: In = Ir = 100 A, I2 = 1.3 Ir = 130 <= 152  => predicted PASS`);
  show(find(C.Compliance.generate(), /MCCB/).filter(i => /Iz/.test(i.message)));
}

// ── Mixed earthing: one TT source must not switch off the TN check elsewhere ──
console.log('\n== Mixed TN + TT project: TN disconnection check still runs on the TN installation');
{
  const comps = [...net.project.components, comp('t2', 'transformer', { name: 'T-TT', voltage_hv_kv: 11, voltage_lv_kv: 0.42, vector_group: 'Dyn11', grounding_lv: 'solidly_grounded', earthing_system: 'TT', earth_electrode_r_installation: 20 })];
  C.setState({ components: comps, wires: net.project.wires, faultResults: net.faultResults, faultResultsMin: net.faultResultsMin });
  const rr = C.Compliance.generate();
  const disc = find(rr, /./).filter(i => i.section.startsWith('SANS') && /disconnect|Earth-fault disconnection/.test(i.message));
  show(disc);
}

// ── TT: which IΔn does R_A·IΔn use? ──
console.log('\n== TT R_A·IΔn: residual device = CB earth-fault release set at 5 A (no board EL rating)');
{
  const comps = [comp('t', 'transformer', { name: 'T-TT', voltage_hv_kv: 11, voltage_lv_kv: 0.42, vector_group: 'Dyn11', grounding_lv: 'solidly_grounded', earthing_system: 'TT', earth_electrode_r_installation: 20 }),
    comp('b', 'bus', { name: 'LV', voltage_kv: 0.4 }),
    comp('cb', 'cb', { name: 'CB-EF', cb_type: 'mccb', ef_trip_ct: 'ct1', ef_pickup_a: 5 }), comp('ct1', 'ct', { name: 'CBCT' })];
  C.setState({ components: comps, wires: [{ id: 'w1', fromComponent: 't', fromPort: 'secondary', toComponent: 'b', toPort: 'p0' }, wire('w2', 'b', 'cb')] });
  console.log(`  R_A = 20 Ω, IΔn = 5 A -> 100 V > 50 V  => predicted FAIL`);
  show(find(C.Compliance.generate(), /T-TT/).filter(i => /R_A/.test(i.message)));
}

// ── Diagram flag basis ([DU1]: largest phase current of any fault type) ──
console.log('\n== On-diagram breaking-capacity flag vs the report (Ik1 > Ik3 at the MSB)');
{
  C.setState({ components: net.project.components.map(c => c.id === 'cbF' ? { ...c, props: { ...c.props, breaking_capacity_ka: 26.5 } } : c),
    wires: net.project.wires, faultResults: net.faultResults, faultResultsMin: net.faultResultsMin });
  const rep = find(C.Compliance.generate(), /CB-SubMain/).filter(i => /Breaking duty/.test(i.message))[0];
  const flag = C.Compliance.deviceRatingFlags().get('cbF');
  console.log(`  Icu 26.5 kA, Ik3 ${net.faultResults.buses.bA.ik3.toFixed(2)} kA, Ik1 ${net.faultResults.buses.bA.ik1.toFixed(2)} kA`);
  console.log(`  report [${rep.status}]  diagram flag: ${flag ? flag.level : 'none'}`);
}

// ── Rated voltage vs Um (IEC 62271-1) ──
console.log('\n== Rated voltage: 11 kV-rated CB on an 11 kV bus (Um = 12 kV)');
{
  C.setState({ components: [comp('b', 'bus', { name: 'B11', voltage_kv: 11 }), comp('cb', 'cb', { name: 'CB11', rated_voltage_kv: 11 })], wires: [wire('1', 'b', 'cb')] });
  show(find(C.Compliance.generate(), /CB11/).filter(i => /Rated voltage/.test(i.message)));
}
