// Headless check of the roof 3D view on both renderers (WebGL2 and the 2D fallback): picks a roof plane and an object, nothing in a corner.
// Needs a full stack on a THROWAWAY database (see testing/help-guides/lib.mjs): node testing/solar/verify_3d_ui.mjs <output dir>
import { launch, token, openApp } from '../help-guides/lib.mjs';
const SP = process.argv[2];
let fails = 0; const check = (n, ok, x = '') => { if (!ok) fails++; console.log(ok ? 'PASS' : 'FAIL', n, x); };
const browser = await launch();
for (const mode of ['gl', '2d']) {
  const page = await openApp(browser, await token(), { width: 1280, height: 800 }, mode === '2d' ? {} : {});
  if (mode === '2d') await page.addInitScript(() => { try { localStorage.setItem('pp-3d-renderer', '2d'); } catch (_) {} });
  if (mode === '2d') await page.reload({ waitUntil: 'load' });
  if (mode === '2d') { await page.waitForFunction(() => typeof AppState !== 'undefined' && typeof StartScreen !== 'undefined' && StartScreen.settled, null, { timeout: 15000 }).catch(() => {}); await page.evaluate(() => StartScreen.close()); }
  page.on('pageerror', e => { fails++; console.log('pageerror', String(e).slice(0, 200)); });
  await page.evaluate(() => Workspaces.setType('reticulation', []));
  await page.evaluate(() => switchWorkspace('plan'));
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    AppState.planMarkup.scale = { factor: 0.05, unit: 'm' };
    PlanSolar._store().roofs = [];
    const r = PlanSolar.addRoof([{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 280 }, { x: 0, y: 280 }]);
    Object.assign(r, { name: 'Roof A', shape: 'gable', pitch: 25, azimuth: 0, setback: 0.5 });
    r.objects.push({ id: 'o1', type: 'chimney', x: 200, y: 5, w: 1.5, h: 4, d: 1.5, rot: 0 });
    Solar.set('roofShape', 'plan'); Solar.set('location', 'Johannesburg'); Solar.set('targetKwp', 30);
  });
  await page.evaluate(() => RoofEditor.open());
  await page.waitForTimeout(2000);
  const info = await page.evaluate(() => {
    const v = Roof3D.view; v.setView(150, 32); v.draw();
    const sc = Roof3D.scene, it = sc.items[0], pl = it.pls[0];
    const mid = pl.poly.reduce((a, q) => [a[0] + q[0] / pl.poly.length, a[1] + q[1] / pl.poly.length, a[2] + q[2] / pl.poly.length], [0, 0, 0]);
    // a point on the plane away from modules: near the ridge side top
    const P = v.project(mid[0], mid[1], pl.zAt(mid[0], mid[1]), v._c);
    const o = sc.objs[0], O = v.project(o.c[0], o.c[1], o.z0 + o.hh / 2, v._c);
    const plane = v.pickAt(P[0], P[1]), obj = v.pickAt(O[0], O[1]), none = v.pickAt(3, 3);
    const t0 = performance.now(); for (let i = 0; i < 30; i++) v.draw(); const ms = (performance.now() - t0) / 30;
    return { gl: v.usesGL, plane, obj, none, ms };
  });
  console.log(mode, JSON.stringify(info));
  // pointer interaction: hover highlight, double-click focus, animated named view
  const pt = await page.evaluate(() => {
    const v = Roof3D.view, it = Roof3D.scene.items[0], pl = it.pls[0], m = pl.poly.reduce((a, q) => [a[0] + q[0] / pl.poly.length, a[1] + q[1] / pl.poly.length], [0, 0]);
    const P = v.project(m[0], m[1], pl.zAt(m[0], m[1]), v._c), r = v.canvas.getBoundingClientRect();
    const o = Roof3D.scene.objs[0], O = v.project(o.c[0], o.c[1], o.z0 + o.hh / 2, v._c);
    return { x: r.left + P[0], y: r.top + P[1], cx: r.left + 6, cy: r.top + 6, ox: r.left + O[0], oy: r.top + O[1] };
  });
  await page.mouse.move(pt.x - 3, pt.y - 3); await page.mouse.move(pt.x, pt.y);
  await page.waitForTimeout(300);
  check(mode + ': hover finds the roof plane', await page.evaluate(() => /^p:/.test(Roof3D.hover || '')));
  await page.mouse.move(pt.cx, pt.cy); await page.waitForTimeout(300);
  check(mode + ': hover clears off the roof', await page.evaluate(() => Roof3D.hover == null));
  const z0 = await page.evaluate(() => Roof3D.view.zoom);
  await page.mouse.dblclick(pt.ox, pt.oy);
  await page.waitForTimeout(900);
  const z1 = await page.evaluate(() => Roof3D.view.zoom);
  check(mode + ': double-click on an object zooms to it', z1 > z0 * 1.2, z0.toFixed(2) + ' -> ' + z1.toFixed(2));
  await page.mouse.dblclick(pt.cx, pt.cy);
  await page.waitForTimeout(900);
  const z2 = await page.evaluate(() => Roof3D.view.zoom);
  check(mode + ': double-click on empty space shows the whole model again', Math.abs(z2 - z0) / z0 < 0.05, z2.toFixed(2));
  await page.evaluate(() => Roof3D.setView('top'));
  await page.waitForTimeout(120);
  const mid = await page.evaluate(() => Roof3D.view.pitch);
  await page.waitForTimeout(700);
  const end = await page.evaluate(() => Roof3D.view.pitch);
  check(mode + ': named view glides (mid-way value differs from both ends)', end > 80 && mid < end - 1 && mid > 20, mid.toFixed(1) + ' -> ' + end.toFixed(1));
  check(mode + ': renderer', info.gl === (mode === 'gl'));
  check(mode + ': picks a roof plane', /^p:/.test(info.plane || ''), info.plane);
  check(mode + ': picks the chimney', info.obj === 'o:o1', info.obj);
  check(mode + ': nothing in the corner', info.none == null, info.none);
  // Push / pull handle: drag the eave handle and the roof's eave height must change
  await page.evaluate(() => { Roof3D.setTool ? Roof3D.setTool('pushpull') : (Roof3D.tool = 'pushpull'); Roof3D.view.setView(150, 32); Roof3D.view.draw(); });
  await page.waitForTimeout(500);
  const h = await page.evaluate(() => {
    const v = Roof3D.view, it = Roof3D.scene.items[0], q = it.poly[0], P = v.project(q[0], q[1], it.eave, v._c), r = v.canvas.getBoundingClientRect();
    return { x: r.left + P[0], y: r.top + P[1], eave: it.roof.eave };
  });
  await page.mouse.move(h.x, h.y); await page.mouse.down(); await page.mouse.move(h.x, h.y - 25, { steps: 5 }); await page.mouse.up();
  await page.waitForTimeout(800);
  const e1 = await page.evaluate(() => PlanSolar.roofs()[0].eave);
  check(mode + ': dragging the eave handle changes the eave height', e1 != null && Math.abs(e1 - (h.eave != null ? h.eave : 3)) > 0.05, (h.eave) + ' -> ' + e1);
  // Transform gizmo: drag the X arrow and the roof must move
  await page.evaluate(() => { Roof3D.tool = 'transform'; Roof3D.gizmo = 'move'; Roof3D.sel = { roof: PlanSolar.roofs()[0].id, plane: 0 }; Roof3D._rebuild(); });
  await page.waitForTimeout(800);
  const g = await page.evaluate(() => {
    const v = Roof3D.view; v.draw(); const t = Roof3D._target(), o = Roof3D._gizmoOrigin(t), L = Math.max(0.6, v.radius * 0.22);
    const a = v.project(o[0] + L * 0.7, o[1], o[2], v._c), r = v.canvas.getBoundingClientRect();
    return { x: r.left + a[0], y: r.top + a[1], p0: PlanSolar.roofs()[0].points[0].x };
  });
  await page.mouse.move(g.x, g.y); await page.mouse.down(); await page.mouse.move(g.x + 40, g.y + 10, { steps: 6 }); await page.mouse.up();
  await page.waitForTimeout(800);
  const p1 = await page.evaluate(() => PlanSolar.roofs()[0].points[0].x);
  check(mode + ': dragging the gizmo X arrow moves the roof', Math.abs(p1 - g.p0) > 1, g.p0.toFixed(1) + ' -> ' + p1.toFixed(1));
  // Arrow keys nudge the selected object
  await page.evaluate(() => { Roof3D.tool = 'select'; Roof3D.sel = { roof: PlanSolar.roofs()[0].id, obj: 'o1' }; Roof3D._rebuild(); });
  await page.waitForTimeout(600);
  const n0 = await page.evaluate(() => { Roof3D.view.canvas.focus(); const o = PlanSolar.roofs()[0].objects[0]; return { x: o.x, y: o.y }; });
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(500);
  await page.keyboard.press('Shift+ArrowUp'); await page.waitForTimeout(500);
  const n1 = await page.evaluate(() => { const o = PlanSolar.roofs()[0].objects[0]; return { x: o.x, y: o.y }; });
  const f = 0.05, moved = Math.hypot(n1.x - n0.x, n1.y - n0.y) * f;
  check(mode + ': arrow keys nudge the selected object (about 0.55 m after 5 cm + 50 cm)', moved > 0.4 && moved < 0.7, moved.toFixed(2) + ' m');
  await page.close();
}
await browser.close();
process.exit(fails ? 1 : 0);
