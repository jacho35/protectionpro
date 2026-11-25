// Solar library validation and the shipped lists (no browser).   node testing/unit/solar-library.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../../frontend/js/constants.js'), 'utf8');
const lists = new Function(src.slice(src.indexOf('const PV_PANELS'), src.indexOf('// Standard MCCB frame sizes')) + '; return { PV_PANELS, PV_INVERTERS };')();
global.escHtml = (x) => String(x);
const Solar = require('../../frontend/js/solar.js');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok', name); };

ok('every shipped module and inverter passes its own validation', () => {
  for (const p of lists.PV_PANELS) assert.strictEqual(Solar.validatePanel(p), '', p.id);
  for (const i of lists.PV_INVERTERS) assert.strictEqual(Solar.validateInverter(Object.assign({ phases: 3 }, i)), '', i.id);
  assert.strictEqual(new Set(lists.PV_PANELS.concat(lists.PV_INVERTERS).map(e => e.id)).size, lists.PV_PANELS.length + lists.PV_INVERTERS.length);
});
ok('module validation messages', () => {
  const good = Object.assign({}, lists.PV_PANELS[2]);
  assert.strictEqual(Solar.validatePanel(good), '');
  assert(/name/.test(Solar.validatePanel(Object.assign({}, good, { name: '' }))));
  assert(/below Voc/.test(Solar.validatePanel(Object.assign({}, good, { vmp: 60 }))));
  assert(/Imp/.test(Solar.validatePanel(Object.assign({}, good, { imp: 20 }))));
  assert(/negative/.test(Solar.validatePanel(Object.assign({}, good, { beta_voc: 0.3 }))));
  assert(/positive/.test(Solar.validatePanel(Object.assign({}, good, { w: NaN }))));
});
ok('inverter validation messages', () => {
  const good = Object.assign({}, lists.PV_INVERTERS[0]);
  assert.strictEqual(Solar.validateInverter(good), '');
  assert(/MPPT min/.test(Solar.validateInverter(Object.assign({}, good, { mppt_min_v: 900 }))));
  assert(/MPPT min/.test(Solar.validateInverter(Object.assign({}, good, { dc_max_v: 700 }))));
  assert(/100/.test(Solar.validateInverter(Object.assign({}, good, { eff_pct: 101 }))));
  assert(/Phases/.test(Solar.validateInverter(Object.assign({}, good, { phases: 2 }))));
});
console.log(n + ' passed');
