// TCC review — curve gates vs the standards. Run: node testing/tcc-review/v1_gates.js
const fs = require('fs'), vm = require('vm');
const src = fs.readFileSync(__dirname + '/../../frontend/js/constants.js', 'utf8');
const ctx = { console, Math, window: {}, document: { addEventListener() {} } };
vm.createContext(ctx);
vm.runInContext(src + '\n;this.fuseTripTime=fuseTripTime;this.cbTripTime=cbTripTime;this.idmtTripTime=idmtTripTime;', ctx);

// IEC 60269-1 Table 3 gG gates: In: [Imin(10 s), Imax(5 s), Imin(0.1 s), Imax(0.1 s)]
const GATES = {16:[33,65,85,150],20:[42,85,110,200],25:[52,110,150,260],32:[75,150,200,350],
  40:[95,190,260,450],50:[125,250,350,610],63:[160,320,450,820],80:[215,425,610,1100],
  100:[290,580,820,1450],125:[355,715,1100,1910],160:[460,950,1450,2590],200:[610,1250,1910,3420],
  250:[750,1650,2590,4500],315:[1050,2200,3420,6000],400:[1420,2840,4500,8060],
  500:[1780,3800,6000,10600],630:[2200,5100,8060,14140]};
console.log('== gG pre-arcing vs IEC 60269-1 gates (t@Imin10 >= 10 s, t@Imax5 <= 5 s, t@Imin0.1 >= 0.1 s, t@Imax0.1 <= 0.1 s)');
let bad = 0;
for (const [In, g] of Object.entries(GATES)) {
  const t = g.map(i => ctx.fuseTripTime(+In, i));
  const ok = [t[0] >= 10, t[1] <= 5, t[2] >= 0.1, t[3] <= 0.1];
  if (ok.includes(false)) bad++;
  console.log(`  ${In.padStart(3)} A: ${t.map(x => x.toPrecision(3)).join(' | ')}  ${ok.map(o => o ? 'ok' : 'FAIL').join(' ')}`);
}
console.log(`  ${bad} of 17 ratings violate a gate`);

console.log('\n== MCB (IEC 60898-1 Table 7): 1.13 In no trip <1 h; 1.45 In trip <1 h; 2.55 In 1-60 s (In<=32)');
for (const cls of [10]) {
  const p = { cb_type: 'mcb', trip_rating_a: 16, thermal_pickup: 1, magnetic_pickup: 10, long_time_delay: cls };
  const t = [1.13, 1.45, 2.55].map(m => ctx.cbTripTime(p, 16 * m));
  console.log(`  class ${cls}: t(1.13)=${t[0].toFixed(0)} s ${t[0] >= 3600 ? 'ok' : 'FAIL'}  t(1.45)=${t[1].toFixed(0)} s ${t[1] < 3600 ? 'ok' : 'FAIL'}  t(2.55)=${t[2].toFixed(1)} s ${t[2] >= 1 && t[2] <= 60 ? 'ok' : 'FAIL'}`);
}
console.log('\n== MCCB (IEC 60947-2 Table 6): 1.05 Ir no trip <1-2 h; 1.30 Ir trip <1-2 h');
for (const cls of [5, 10, 20, 30]) {
  const p = { cb_type: 'mccb', trip_rating_a: 250, thermal_pickup: 1, magnetic_pickup: 10, long_time_delay: cls };
  const t = [1.05, 1.30].map(m => ctx.cbTripTime(p, 250 * m));
  console.log(`  class ${cls}: t(1.05)=${t[0].toFixed(0)} s ${t[0] >= 7200 ? 'ok' : 'FAIL'}  t(1.30)=${t[1].toFixed(0)} s ${t[1] < 7200 ? 'ok' : 'FAIL'}`);
}
console.log('\n== IDMT beyond 20x (IEC 60255-151 range 2-20 Gs; relays hold t(20) above it)');
for (const c of ['IEC Standard Inverse', 'IEC Very Inverse', 'IEC Extremely Inverse', 'IEEE Extremely Inverse']) {
  const t20 = ctx.idmtTripTime(c, 20, 0.1), t50 = ctx.idmtTripTime(c, 50, 0.1);
  console.log(`  ${c.padEnd(24)} t(20)=${t20.toFixed(4)} t(50)=${t50.toFixed(4)}  (${((t50 / t20 - 1) * 100).toFixed(0)} %)`);
}
console.log('\n== IDMT constants vs IEC 60255-151 Table 1 / IEEE C37.112 at M=10, TMS=1');
const ref = { 'IEC Standard Inverse': 0.14 / (Math.pow(10, 0.02) - 1), 'IEC Very Inverse': 13.5 / 9,
  'IEC Extremely Inverse': 80 / 99, 'IEC Long Time Inverse': 120 / 9,
  'IEEE Moderately Inverse': 0.0515 / (Math.pow(10, 0.02) - 1) + 0.114,
  'IEEE Very Inverse': 19.61 / 99 + 0.491, 'IEEE Extremely Inverse': 28.2 / 99 + 0.1217 };
for (const [c, r] of Object.entries(ref)) console.log(`  ${c.padEnd(24)} ref ${r.toFixed(4)} engine ${ctx.idmtTripTime(c, 10, 1).toFixed(4)}`);

console.log('\n== gG table parity: constants.js FUSE_CURVES_GG vs arcflash.py _FUSE_CURVES_GG');
{
  const py = fs.readFileSync(__dirname + '/../../backend/analysis/arcflash.py', 'utf8');
  const block = py.slice(py.indexOf('_FUSE_CURVES_GG = {'), py.indexOf('}', py.indexOf('_FUSE_CURVES_GG = {')));
  const pyRows = {};
  for (const m of block.matchAll(/(\d+):\s*\[(.*)\],/g)) pyRows[m[1]] = [...m[2].matchAll(/\(([\d.e+]+), ([\d.e+]+)\)/g)].map(x => [+x[1], +x[2]]);
  vm.runInContext('this.FUSE_CURVES_GG = FUSE_CURVES_GG;', ctx);
  const js = ctx.FUSE_CURVES_GG;
  const same = Object.keys(js).every(k => JSON.stringify(js[k]) === JSON.stringify(pyRows[k])) && Object.keys(pyRows).length === Object.keys(js).length;
  console.log('  ' + (same ? 'identical' : 'MISMATCH'));
}
