// The roof scene end to end without a browser: every roof type builds, lays modules, casts shadows and draws.   node testing/unit/roofscene.test.js
const assert = require('assert');
global.AppState = { planMarkup: { settings: {}, nameCounters: {}, scale: { factor: 0.05 } }, planGenId: (() => { let i = 0; return (p) => p + '_' + (++i); })() };
global.PlanMarkup = { nextCounter: (k, p) => p + '1', snapshot() {}, markDirty() {} };
global.PlanRoomDetect = require('../../frontend/js/plan-roomdetect.js');
const poly = (pts) => { let a = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p.x * q.y - q.x * p.y; } return Math.abs(a) / 2; };
global.PlanEngine = { view: { zoom: 1 }, requestDraw() {}, factor: () => AppState.planMarkup.scale.factor, _polyArea: poly, _distToSeg: () => 1e9 };
global.Roof3D = require('../../frontend/js/roof3d.js');
global.RoofPlanes = require('../../frontend/js/roof-planes.js');
const PS = global.PlanSolar = require('../../frontend/js/plan-solar.js');
global.Solar = { cfg: () => ({ obsH: 0, hour: 0 }), panel: () => ({ len: 1.7, wid: 1.1, w: 550, id: 'm' }), _res: null, _loc: () => ({ lat: -26 }) };
global.API = { request: async () => ({ pitch_m: 3.2 }) };
global.V3D = { box(v, c, w, d, z0, h, rot, o) { v.face({ pts: [[c[0], c[1], z0]], pick: o.pick }); } };
let n = 0; const ok = async (name, fn) => { await fn(); n++; console.log('ok', name); };
const R = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];   // plan units: 0.05 m each
const mock = () => { const items = []; return { items, radius: 10, target: [0, 0, 0], scale: () => 20, pitch: 30, face: f => items.push(f), line: l => items.push(l), glow() {}, label() {}, planeAt: () => [0, 0] }; };

(async () => {
  for (const shape of ['gable', 'hip', 'mono', 'pyramid', 'flat']) {
    await ok(shape + ': builds, lays modules, shades and draws', async () => {
      AppState.planMarkup.settings.solar = { roofs: [] };
      const r = PS.addRoof(shape === 'pyramid' ? R(0, 0, 160, 160) : R(0, 0, 240, 160)); r.shape = shape; r.pitch = 25; r.setback = 0.3; r.eave = 3.2;
      PS.addObject(r, 'vent', { x: 120, y: 80 });
      const sc = await Roof3D.build();
      assert.strictEqual(sc.items.length, 1); assert(sc.items[0].mods.length > 0, 'modules');
      assert.strictEqual(sc.objs.length, 1);
      const polys = Roof3D.shadows(sc, Roof3D.sunVec(10, 40)); assert(Array.isArray(polys));
      sc.shadowPolys = polys; Roof3D.scene = sc; Roof3D.tool = 'transform'; Roof3D.sel = { roof: r.id, obj: r.objects[0].id };
      const v = mock(); Roof3D.draw(v); assert(v.items.length > 10);
      for (const t of ['pushpull', 'ridge', 'select', 'footprint']) { Roof3D.tool = t; Roof3D.draw(mock()); }
      for (const g of ['move', 'rotate', 'scale']) { Roof3D.tool = 'transform'; Roof3D.gizmo = g; Roof3D.draw(mock()); }
    });
  }
  await ok('cross-gable L with a vent: planes carry modules on the sunny side and the scene draws', async () => {
    AppState.planMarkup.settings.solar = { roofs: [] };
    const r = PS.addRoof([{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 100 }, { x: 120, y: 100 }, { x: 120, y: 240 }, { x: 0, y: 240 }]); r.shape = 'wings'; r.pitch = 28; r.setback = 0.3;
    const sc = await Roof3D.build(); Roof3D.scene = sc;
    assert(sc.items[0].pls.length >= 6); assert(sc.items[0].mods.length > 0);
    Roof3D.shadows(sc, Roof3D.sunVec(0, 35)); Roof3D.draw(mock());
    const a = PS.arrays([r], 0.4, 0.8); assert(a.length >= 1 && a.every(x => x.area_m2 > 0 && x.azimuth_deg >= 0));
  });
  await ok('lean-to options A to D build and draw; the catslide has one plane carried on', async () => {
    for (const lean of [{ side: 'front', kind: 'under', depth: 3, pitch: 8 }, { side: 'front', kind: 'catslide', depth: 3 }, { side: 'end', kind: 'under', depth: 3, pitch: 11 }, { side: 'front', kind: 'under', depth: 3, pitch: 20 }]) {
      AppState.planMarkup.settings.solar = { roofs: [] };
      const r = PS.addRoof(R(0, 0, 240, 160)); r.shape = 'gable'; r.pitch = 24; r.lean = lean; r.setback = 0.3;
      const sc = await Roof3D.build(); Roof3D.scene = sc;
      assert(sc.items[0].mods.length > 0); assert.strictEqual(sc.items[0].pls.length, lean.kind === 'catslide' ? 2 : 3);
      Roof3D.shadows(sc, Roof3D.sunVec(0, 35)); Roof3D.draw(mock());
      assert(PS.arrays([r], 0.4, 0.8).length >= 1);
    }
  });
  await ok('typed values and rebuild: eave, pitch, object height, a distance on X', async () => {
    AppState.planMarkup.settings.solar = { roofs: [] };
    const r = PS.addRoof(R(0, 0, 240, 160)); r.shape = 'gable'; r.pitch = 25; PS.addObject(r, 'vent', { x: 100, y: 60 });
    Roof3D.scene = await Roof3D.build(); Roof3D.view = null;
    Roof3D.sel = { roof: r.id }; Roof3D.tool = 'pushpull'; assert(Roof3D.applyTyped('3.6')); assert.strictEqual(r.eave, 3.6);
    Roof3D.tool = 'ridge'; assert(Roof3D.applyTyped('30')); assert.strictEqual(r.pitch, 30);
    Roof3D.sel = { roof: r.id, obj: r.objects[0].id }; Roof3D.tool = 'object'; assert(Roof3D.applyTyped('1.4')); assert.strictEqual(r.objects[0].h, 1.4);
    Roof3D.scene = await Roof3D.build();
    Roof3D.tool = 'transform'; Roof3D.gizmo = 'move'; Roof3D.axis = 'x'; const x0 = r.objects[0].x; assert(Roof3D.applyTyped('2')); assert(Math.abs(r.objects[0].x - (x0 + 2 / 0.05)) < 1e-6);
    Roof3D.gizmo = 'rotate'; assert(Roof3D.applyTyped('30')); assert.strictEqual(r.objects[0].rot, 330);
    assert(!Roof3D.applyTyped('abc'));
  });
  console.log(n + ' passed');
})().catch(e => { console.error(e); process.exit(1); });
