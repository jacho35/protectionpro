// Tests for frontend/js/plan-bdrules.js (design-basis rule tables, no browser).
//   node testing/unit/bdrules.test.js
// Expected numbers are read from SANS 10139:2021 (Ed 4), the clause is named on each test.
const assert = require('assert');
const R = require('../../frontend/js/plan-bdrules.js');
const G = require('../../frontend/js/plan-bdgeom.js');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok', name); };
const near = (a, b) => assert(Math.abs(a - b) < 1e-9, a + ' != ' + b);

ok('8.15.3(a): smoke 7.5 m, heat 5.3 m, multi-sensor spaced as smoke, as heat if the smoke sensor can be disabled', () => {
  near(R.detector('sans', 'smoke').radius, 7.5);
  near(R.detector('sans', 'heat').radius, 5.3);
  near(R.detector('sans', 'combo').radius, 7.5);
  near(R.detector('sans', 'combo', { heatOnly: true }).radius, 5.3);
  assert.strictEqual(R.detector('sans', 'smoke').provisional, false);
});

ok('8.15.3(c): apex detectors gain 1 % per degree of slope, capped at 25 %', () => {
  near(R.slopeFactor('sans', 10), 1.10);
  near(R.slopeFactor('sans', 40), 1.25);
  near(R.detector('sans', 'smoke', { slopeDeg: 20, atApex: true }).radius, 7.5 * 1.2);
  near(R.detector('sans', 'smoke', { slopeDeg: 20 }).radius, 7.5);               // not at the apex: no gain
});

ok('8.15.3(a) note 1: corridor spacing 15 m smoke / 10.6 m heat (twice the radius)', () => {
  near(R.value('sans', 'detector.smoke.corridorSpacing').v, 15);
  near(R.value('sans', 'detector.heat.corridorSpacing').v, 10.6);
});

ok('8.15.3(e)/(h): mounting band and wall clearance', () => {
  const s = R.siting('sans', 'smoke'), h = R.siting('sans', 'heat');
  near(s.clearance, 0.5); near(s.mount.min, 0.025); near(s.mount.max, 0.6); near(h.mount.max, 0.15);
});

ok('Table 3: ceiling height limits and the 10 % allowance', () => {
  assert.strictEqual(R.ceilingCheck('sans', 'smoke', 10.5).level, 'ok');
  assert.strictEqual(R.ceilingCheck('sans', 'smoke', 11).level, 'small-sections');       // up to 12.5 m over ≤ 10 % of the area
  assert.strictEqual(R.ceilingCheck('sans', 'smoke', 11, 0.2).level, 'too-high');
  assert.strictEqual(R.ceilingCheck('sans', 'smoke', 13).ok, false);
  assert.strictEqual(R.ceilingCheck('sans', 'heat', 7.6).level, 'small-sections');       // other classes 7.5 m, small 10.5 m
  assert.strictEqual(R.ceilingCheck('sans', 'heatA1', 9).level, 'ok');
  assert.strictEqual(R.ceilingCheck('sans', 'combo', 8).level, 'small-sections');        // a multi-sensor detector is held to its heat limit
  assert.strictEqual(R.ceilingCheck('sans', 'beam', 25).level, 'ok');
  assert.strictEqual(R.ceilingCheck('sans', 'beamEnhanced', 40).level, 'ok');
});

ok('Tables 1 and 2: honeycomb and joist ceilings by height', () => {
  near(R.honeycomb('sans', 'smoke', 3), 4.5); near(R.honeycomb('sans', 'heat', 3), 3.0);
  near(R.honeycomb('sans', 'smoke', 4), 5.5); near(R.honeycomb('sans', 'heat', 5), 4.5);
  near(R.honeycomb('sans', 'smoke', 8), 6.5); near(R.honeycomb('sans', 'heat', 8), 5.0);
  near(R.joists('sans', 'smoke', 2.5), 2.3); near(R.joists('sans', 'heat', 4), 2.0);
  near(R.joists('sans', 'smoke', 6), 3.3); near(R.joists('sans', 'heat', 6), 2.5);
});

ok('8.13.2: call points 1.4 m, 45 m route / 30 m straight, 25 / 16 m when reduced', () => {
  const c = R.callPoint('sans'), c2 = R.callPoint('sans', true);
  near(c.height, 1.4); near(c.travel, 45); near(c.straight, 30); near(c2.travel, 25); near(c2.straight, 16);
});

ok('8.9.2.1: sounder level 65 dB(A), 60 in stairs / small rooms, background + 5, 75 at a bedhead', () => {
  near(R.sounderTarget('sans', { areaM2: 200 }).target, 65);
  near(R.sounderTarget('sans', { stair: true }).target, 60);
  near(R.sounderTarget('sans', { areaM2: 40 }).target, 60);
  near(R.sounderTarget('sans', { areaM2: 200, backgroundDb: 70 }).target, 75);
  near(R.sounderTarget('sans', { areaM2: 200, backgroundDb: 60 }).target, 65);          // 60 is not over 60
  near(R.sounderTarget('sans', { areaM2: 20, sleeping: true }).target, 75);
  near(R.sounderTarget('sans', { areaM2: 0.8 }).target, 0);                             // enclosures under 1 m²
  near(R.sounderTarget('sans', {}).max, 120);
});

ok('8.10.2: visual alarm above 90 dB(A) ambient, mounted at 2.1 m or more', () => {
  assert(R.needsVisual('sans', 91)); assert(!R.needsVisual('sans', 90));
  near(R.value('sans', 'visual.minHeight').v, 2.1);
});

ok('8.6.2: zone limits', () => {
  const z = R.zoneLimits('sans');
  near(z.maxAreaM2, 2000); near(z.maxAreaOpenPlanM2, 10000); near(z.searchDistance, 60); near(z.singleStoreyAboveM2, 300);
});

ok('every SANS value carries a clause and none is provisional', () => {
  assert.deepStrictEqual(R.provisional('sans'), []);
  const walk = o => { if (o && typeof o === 'object') { if ('v' in o && 'ref' in o) { assert(o.ref.length > 0); return; } Object.values(o).forEach(walk); } };
  walk(R.basis('sans'));
});

ok('an unknown basis answers null rather than guess', () => {
  assert(!R.ready('nope'));
  assert.strictEqual(R.detector('nope', 'smoke'), null);
  assert.strictEqual(R.callPoint('nope'), null);
  assert.strictEqual(R.value('nope', 'sounder.minDb'), null);
  assert.deepStrictEqual(R.bases().map(b => b.id), ['sans', 'bs5839', 'nfpa72']);
});

ok('BS 5839-1 starts from the SANS values, every one provisional and saying so', () => {
  assert(R.ready('bs5839'));
  near(R.detector('bs5839', 'smoke').radius, 7.5);
  near(R.detector('bs5839', 'heat').radius, 5.3);
  near(R.callPoint('bs5839').travel, 45);
  near(R.sounderTarget('bs5839', { areaM2: 200 }).target, 65);
  assert.strictEqual(R.detector('bs5839', 'smoke').provisional, true);
  assert(/BS 5839-1 equivalent not checked/.test(R.detector('bs5839', 'smoke').ref));
  assert(R.provisional('bs5839').length > 50);
  assert.deepStrictEqual(R.provisional('sans'), []);               // deriving did not touch the SANS table
});

ok('rules feed the geometry: a 6 x 15 m room needs two smoke detectors, not one', () => {
  const room = [[0, 0], [15, 0], [15, 6], [0, 6]];
  const rad = R.detector('sans', 'smoke').radius, clr = R.siting('sans', 'smoke').clearance;
  const L = G.layout(room, { radius: rad, clearance: clr });
  assert(L.coverage.pass && !L.stuck.length);
  assert(L.detectors.length >= 2, 'detectors: ' + L.detectors.length);
});

ok('room use → detector type: defaults, overrides, unknown use', () => {
  assert.strictEqual(R.detectorFor('office').type, 'smoke');
  assert.strictEqual(R.detectorFor('kitchen').type, 'heat');
  assert.strictEqual(R.detectorFor('sleeping').type, 'smoke');        // 8.1.1.2.5: not heat
  const o = R.detectorFor('office', { office: 'combo' });
  assert.strictEqual(o.type, 'combo'); assert(o.custom);
  assert.strictEqual(R.detectorFor('nonsense').id, 'other');
  assert(R.ROOM_USES.every(u => ['smoke', 'heat', 'combo', 'co', 'beam'].includes(u.detector)));
});

// ---- NFPA 72 (2016) ----
ok('NFPA 17.7.3.2.3.1: smoke 0.7 x 30 ft (9.1 m) = 6.37 m', () => {
  near(R.detector('nfpa72', 'smoke').radius, 0.7 * 9.1);
  near(R.detector('nfpa72', 'combo').radius, 0.7 * 9.1);
  assert.strictEqual(R.detector('nfpa72', 'smoke').provisional, false);
});

ok('NFPA 17.6.3.1.1 + Table 17.6.3.5.1: heat = 0.7 x listed spacing x ceiling height factor', () => {
  near(R.detector('nfpa72', 'heat', { listedSpacing: 15.2, ceilH: 3 }).radius, 0.7 * 15.2);                 // up to 3.0 m: 1.00
  near(R.detector('nfpa72', 'heat', { listedSpacing: 15.2, ceilH: 3.1 }).radius, 0.7 * 15.2 * 0.91);        // over 3.0 m up to 3.7 m
  near(R.detector('nfpa72', 'heat', { listedSpacing: 15.2, ceilH: 6.1 }).radius, 0.7 * 15.2 * 0.64);
  near(R.detector('nfpa72', 'heat', { listedSpacing: 15.2, ceilH: 9.1 }).radius, 0.7 * 15.2 * 0.34);
  assert.strictEqual(R.detector('nfpa72', 'heat', { listedSpacing: 15.2, ceilH: 9.2 }), null);              // table stops at 30 ft
  assert.strictEqual(R.detector('nfpa72', 'heat', { ceilH: 3 }).provisional, true);                          // spacing not given: default is flagged
  assert.strictEqual(R.detector('nfpa72', 'heat', { listedSpacing: 15.2, ceilH: 3 }).provisional, false);
});

ok('NFPA 17.6.3.5.2 (Annex A example): 15 ft listed on a 30 ft ceiling is not spaced closer than 0.4 H', () => {
  near(R.detector('nfpa72', 'heat', { listedSpacing: 4.6, ceilH: 9.1 }).radius, 0.7 * 0.4 * 9.1);
});

ok('NFPA 17.14: manual boxes 1.07-1.22 m, within 1.5 m of each exit, 61 m horizontal', () => {
  const c = R.callPoint('nfpa72');
  near(c.travel, 61); near(c.heightMin, 1.07); near(c.heightMax, 1.22); near(c.withinExit, 1.5);
});

ok('NFPA 18.4: audible levels are relative to ambient; 75 dBA at a pillow; 110 dBA ceiling', () => {
  near(R.sounderTarget('nfpa72', { backgroundDb: 55 }).target, 70);
  near(R.sounderTarget('nfpa72', { backgroundDb: 55, maxSustainedDb: 70 }).target, 75);   // 5 dB over the sustained maximum is greater
  near(R.sounderTarget('nfpa72', { backgroundDb: 55, private: true }).target, 65);
  near(R.sounderTarget('nfpa72', { backgroundDb: 50, sleeping: true }).target, 75);
  near(R.sounderTarget('nfpa72', { backgroundDb: 70, sleeping: true }).target, 85);
  const none = R.sounderTarget('nfpa72', {});
  assert.strictEqual(none.target, null); assert(none.needsAmbient);
  near(none.max, 110);
});

ok('NFPA 18.5: strobe cd by room size, wall mounted (Table 18.5.5.4.1(a))', () => {
  assert.strictEqual(R.visualRoom('nfpa72', 6.1).cd, 15);
  assert.strictEqual(R.visualRoom('nfpa72', 7.5).cd, 30);              // next row up: 8.53 m
  assert.strictEqual(R.visualRoom('nfpa72', 12.2, 1).cd, 60);
  assert.strictEqual(R.visualRoom('nfpa72', 12.2, 4).cd, 15);
  assert.strictEqual(R.visualRoom('nfpa72', 8, 4).ok, false);          // four lights not allowable in small rooms
  assert.strictEqual(R.visualRoom('nfpa72', 40).ok, false);            // larger than the table
  assert.strictEqual(R.visualRoom('sans', 10), null);
  near(R.value('nfpa72', 'visual.corridorCd').v, 15);
  near(R.value('nfpa72', 'visual.heightMin').v, 2.03);
});

ok('NFPA ceiling checks and gaps are stated, not guessed', () => {
  assert.strictEqual(R.ceilingCheck('nfpa72', 'heat', 9.1).level, 'ok');
  assert.strictEqual(R.ceilingCheck('nfpa72', 'heat', 9.5).level, 'too-high');
  assert.strictEqual(R.ceilingCheck('nfpa72', 'smoke', 12).level, 'no-limit');
  assert.strictEqual(R.zoneLimits('nfpa72'), null);
  assert.strictEqual(R.honeycomb('nfpa72', 'smoke', 3), null);
  near(R.slopeFactor('nfpa72', 20), 1);
  near(R.siting('nfpa72', 'heat').clearance, 0.1);
  assert(R.provisional('nfpa72').length > 0);
});

ok('NFPA radius feeds the geometry: 10 x 20 m room, smoke detectors', () => {
  const room = [[0, 0], [20, 0], [20, 10], [0, 10]];
  const rad = R.detector('nfpa72', 'smoke').radius;
  const Lr = G.layout(room, { radius: rad, clearance: R.siting('nfpa72', 'smoke').clearance });
  assert(Lr.coverage.pass && !Lr.stuck.length);
  const Ls = G.layout(room, { radius: R.detector('sans', 'smoke').radius, clearance: 0.5 });
  assert(Lr.detectors.length >= Ls.detectors.length - 1);
});

console.log(n + ' tests passed');
