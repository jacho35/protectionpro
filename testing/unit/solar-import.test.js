// PVsyst .PAN / .OND and CSV import into the Solar library (no browser).   node testing/unit/solar-import.test.js
const assert = require('assert');
global.escHtml = (x) => String(x);
const Solar = require('../../frontend/js/solar.js');
const SI = require('../../frontend/js/solar-import.js');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok', name); };
const validate = (k, e) => (k === 'panel' ? Solar.validatePanel(e) : Solar.validateInverter(e));

const PAN = `PVObject_=pvModule
  Version=7.2
  PVObject_Commercial=pvCommercial
    Comment=Test
    Manufacturer=Acme Solar
    Model=AS-550M
    Width=1.134
    Height=2.278
  End of PVObject pvCommercial
  NCelS=72
  PNom=550
  Isc=14.00
  Voc=49.90
  Imp=13.12
  Vmp=41.95
  muISC=7.0
  muVocSpec=-129.7
  muPmpReq=-0.350
  VMaxIEC=1500
End of PVObject pvModule
`;
const OND = `PVObject_=pvGInverter
  Version=6.81
  PVObject_Commercial=pvCommercial
    Manufacturer=Acme Power
    Model=AP-10K
  End of PVObject pvCommercial
  Pnom=10000
  PmaxOUT=11000
  VAbsMax=1000
  VMppMin=200
  VMPPMax=800
  IMaxDC=60
  NbMPPT=2
  NbInputs=4
  EfficEuro=98.0
  EfficMax=98.4
  TPhase=TriPhase
End of PVObject pvGInverter
`;

ok('.PAN maps to a module that validates', () => {
  const m = SI.parsePan(PAN);
  assert.strictEqual(m.name, 'Acme Solar AS-550M');
  assert.deepStrictEqual([m.w, m.voc, m.vmp, m.isc, m.imp], [550, 49.9, 41.95, 14, 13.12]);
  assert.strictEqual(m.beta_voc, -0.26);               // -129.7 mV/°C / 49.9 V = -0.2599 %/°C
  assert.strictEqual(m.k_pmax, -0.35);
  assert.strictEqual(m.gamma_vmp, -0.4);       // power coeff - Isc coeff (7 mA / 14 A = 0.05 %/°C)
  assert.strictEqual(m.len, 2.278); assert.strictEqual(m.wid, 1.134);
  assert.strictEqual(m.sysv, 1500); assert.strictEqual(m.noct, 44);
  assert.strictEqual(Solar.validatePanel(m), '');
});
ok('.OND maps to an inverter that validates', () => {
  const i = SI.parseOnd(OND);
  assert.strictEqual(i.name, 'Acme Power AP-10K');
  assert.deepStrictEqual([i.ac_kw, i.phases, i.dc_max_v, i.mppt_min_v, i.mppt_max_v, i.mppt_count, i.mppt_max_a, i.eff_pct],
    [10, 3, 1000, 200, 800, 2, 30, 98]);
  assert.strictEqual(Solar.validateInverter(i), '');
});
ok('an imported part gives the engine the same inputs as the same part typed by hand', () => {
  const byHand = { name: 'Acme Solar AS-550M', w: 550, voc: 49.9, vmp: 41.95, isc: 14, imp: 13.12, beta_voc: -0.26, gamma_vmp: -0.4,
    k_pmax: -0.35, len: 2.278, wid: 1.134, noct: 44, sysv: 1500 };
  assert.deepStrictEqual(Solar.moduleBody(SI.parsePan(PAN)), Solar.moduleBody(byHand));
  const invHand = { name: 'x', ac_kw: 10, phases: 3, dc_max_v: 1000, mppt_min_v: 200, mppt_max_v: 800, mppt_count: 2, mppt_max_a: 30, eff_pct: 98, fault_x: 1.1 };
  assert.deepStrictEqual(Solar.inverterBody(SI.parseOnd(OND)), Solar.inverterBody(invHand));
});
ok('CSV: module and inverter tables, header aliases, quoted names', () => {
  const m = SI.parseCsv('Model,Pmax,Voc,Vmp,Isc,Imp,Voc coeff,Pmax coeff,Length,Width,Max system V\n"Acme, X",550,49.9,41.95,14,13.12,-0.26,-0.35,2.278,1.134,1500\n');
  assert.strictEqual(m.kind, 'panel'); assert.strictEqual(m.entries[0].name, 'Acme, X');
  assert.strictEqual(m.entries[0].gamma_vmp, -0.35); assert(m.entries[0].derived.includes('Vmp coefficient'));
  assert.strictEqual(Solar.validatePanel(m.entries[0]), '');
  const i = SI.parseCsv('name,ac_kw,dc_max_v,mppt_min_v,mppt_max_v,mppt_count,mppt_max_a,efficiency\nInv A,5,600,120,500,1,25,97.5\n');
  assert.strictEqual(i.kind, 'inv'); assert.strictEqual(i.entries[0].phases, 3);
  assert.strictEqual(Solar.validateInverter(i.entries[0]), '');
  assert.strictEqual(SI.parseCsv('a,b\n1,2\n').kind, '');
});
ok('fromFile: rejects bad entries and duplicates, never adds them', () => {
  const r = SI.fromFile('part.PAN', PAN, validate, []);
  assert.strictEqual(r.entries.length, 1);
  assert.strictEqual(SI.fromFile('part.pan', PAN, validate, ['acme solar as-550m']).entries.length, 0);
  assert(/already/.test(SI.fromFile('part.pan', PAN, validate, ['Acme Solar AS-550M']).skipped[0]));
  const bad = SI.fromFile('bad.pan', PAN.replace('Vmp=41.95', 'Vmp=60'), validate, []);
  assert.strictEqual(bad.entries.length, 0); assert(/below Voc/.test(bad.skipped[0]));
  assert(/\.pan, \.ond or \.csv/.test(SI.fromFile('x.txt', '', validate, []).skipped[0]));
  assert.strictEqual(SI.fromFile('empty.pan', '', validate, []).entries.length, 0);
});

// ── real PVsyst files (testing/solar/pvsyst, from pvlib's test data) ──
const fs = require('fs'), path = require('path');
const real = (f) => fs.readFileSync(path.join(__dirname, '../solar/pvsyst', f), f.endsWith('.PAN') ? 'latin1' : 'utf8');
ok('a real .PAN (ET Solar ET-M772BH550GL) imports with the right numbers', () => {
  const m = SI.parsePan(real('ET-M772BH550GL.PAN'));
  assert.strictEqual(m.name, 'ET SOLAR ET-M772BH550GL');
  assert.deepStrictEqual([m.w, m.voc, m.vmp, m.isc, m.imp, m.len, m.wid, m.sysv, m.k_pmax], [550, 49.9, 41.96, 14, 13.11, 2.278, 1.134, 1500, -0.34]);
  assert(Math.abs(m.beta_voc - (-128.0 / 49.9 / 10)) < 0.001);                    // -128 mV/C on 49.9 V
  assert(Math.abs(m.gamma_vmp - (-0.34 - 7.28 / 14 / 10)) < 0.001);              // power coefficient less the Isc coefficient (7.28 mA/C on 14 A)
  assert.strictEqual(Solar.validatePanel(m), '');
});
ok('a real .OND (Chint Power CPS SCH275KTL, BOM, kW units, MonoTri) imports with the right numbers', () => {
  const t = real('CPS-SCH275KTL.OND'); assert.strictEqual(t.charCodeAt(0), 0xFEFF);          // the file does start with a BOM
  const i = SI.parseOnd(t);
  assert.strictEqual(i.name, 'ChintPower CPS SCH275KTL-DO/US-800');
  assert.deepStrictEqual([i.ac_kw, i.phases, i.dc_max_v, i.mppt_min_v, i.mppt_max_v, i.mppt_count, i.mppt_max_a, i.eff_pct], [250, 3, 1500, 500, 1500, 12, 30, 98.49]);
  assert.strictEqual(Solar.validateInverter(i), '');
});
ok('real files through fromFile: added once, a second import is a duplicate', () => {
  const a = SI.fromFile('ET-M772BH550GL.PAN', real('ET-M772BH550GL.PAN'), validate, []);
  assert.strictEqual(a.entries.length, 1);
  assert(/already/.test(SI.fromFile('x.PAN', real('ET-M772BH550GL.PAN'), validate, [a.entries[0].name]).skipped[0]));
  assert.strictEqual(SI.fromFile('i.OND', real('CPS-SCH275KTL.OND'), validate, []).entries.length, 1);
});
console.log(n + ' passed');
