// The roof 3D view on a phone-sized touch screen (emulated: 390 x 844, touch, device pixel ratio 3): the editor opens, WebGL draws, the page
// does not scroll sideways, one finger orbits, two fingers pinch-zoom, a tap on the view cube glides to a side, a tap on a roof picks it.
// Real CDP touch events (Playwright's touchscreen cannot drag). Needs a full stack on a THROWAWAY database: node testing/solar/verify_3d_touch.mjs <output dir>
import { launch, token, BASE_URL } from '../help-guides/lib.mjs';
import { mkdirSync } from 'node:fs';
const SP = process.argv[2] || '/tmp/solar-ui'; mkdirSync(SP, { recursive: true });
let fails = 0; const check = (n, ok, x = '') => { if (!ok) fails++; console.log(ok ? 'PASS' : 'FAIL', n, x); };
const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });
const jwt = await token();
await ctx.addInitScript(t => { try { localStorage.setItem('protectionpro-token', t); localStorage.setItem('pp-open-last', '0'); } catch (_) {} }, jwt);
const page = await ctx.newPage();
page.on('pageerror', e => { fails++; console.log('pageerror', String(e).slice(0, 200)); });
await page.goto(BASE_URL, { waitUntil: 'load' });
await page.waitForFunction(() => typeof AppState !== 'undefined' && typeof StartScreen !== 'undefined' && StartScreen.settled, null, { timeout: 20000 }).catch(() => {});
await page.evaluate(() => StartScreen.close());
await page.evaluate(() => Workspaces.setType('reticulation', []));
await page.evaluate(() => switchWorkspace('plan'));
await page.waitForTimeout(900);
await page.evaluate(() => {
  AppState.planMarkup.scale = { factor: 0.05, unit: 'm' };
  PlanSolar._store().roofs = [];
  const r = PlanSolar.addRoof([{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 280 }, { x: 0, y: 280 }]);
  Object.assign(r, { name: 'Roof A', shape: 'gable', pitch: 25, azimuth: 0, setback: 0.5 });
  r.objects.push({ id: 'ch', type: 'chimney', x: 200, y: 5, w: 1.5, h: 4, d: 1.5, rot: 0 });
  Solar.set('roofShape', 'plan'); Solar.set('location', 'Johannesburg'); Solar.set('targetKwp', 30);
});
await page.evaluate(() => RoofEditor.open());
await page.waitForFunction(() => Roof3D.view && Roof3D.scene && Roof3D.scene.sun, null, { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(800);
const info = await page.evaluate(() => { const r = Roof3D.view.canvas.getBoundingClientRect(); return { gl: Roof3D.view.usesGL, w: r.width, h: r.height, sw: document.documentElement.scrollWidth, iw: window.innerWidth }; });
console.log(JSON.stringify(info));
check('the 3D view is visible on a phone screen', info.w > 150 && info.h > 150, Math.round(info.w) + ' x ' + Math.round(info.h));
check('WebGL draws on the phone profile', info.gl === true);
check('the page does not scroll sideways', info.sw <= info.iw + 1, info.sw + ' vs ' + info.iw);
await (await page.$('#re-view')).screenshot({ path: SP + '/touch-1.png' });
const cdp = await ctx.newCDPSession(page);
const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i + 1 })) });
const rect = await page.evaluate(() => { const r = Roof3D.view.canvas.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
// one finger on empty space orbits
const y0 = await page.evaluate(() => Roof3D.view.yaw);
const sx = rect.x + rect.w * 0.8, sy = rect.y + rect.h * 0.85;
await touch('touchStart', [[sx, sy]]);
for (let i = 1; i <= 8; i++) await touch('touchMove', [[sx - i * 8, sy - i * 2]]);
await touch('touchEnd', []);
await page.waitForTimeout(250);
check('one finger orbits', await page.evaluate((y) => Math.abs(Roof3D.view.yaw - y) > 10, y0), (await page.evaluate(() => Roof3D.view.yaw.toFixed(0))) + ' from ' + y0);
// two fingers pinch-zoom
const z0 = await page.evaluate(() => Roof3D.view.zoom);
const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
await touch('touchStart', [[cx - 30, cy], [cx + 30, cy]]);
for (let i = 1; i <= 8; i++) await touch('touchMove', [[cx - 30 - i * 8, cy], [cx + 30 + i * 8, cy]]);
await touch('touchEnd', []);
await page.waitForTimeout(250);
const z1 = await page.evaluate(() => Roof3D.view.zoom);
check('two fingers pinch to zoom in', z1 > z0 * 1.5, z0.toFixed(2) + ' -> ' + z1.toFixed(2));
// refit, then tap the cube's Iso button and a face
await page.evaluate(() => { Roof3D.view.setView(150, 32); Roof3D.fit(); });
await page.waitForTimeout(700);
const cube = await page.evaluate(() => { const v = Roof3D.view; v.draw(); const r = v.canvas.getBoundingClientRect(), f = v._cube.faces.find(q => q.key !== 'top'); return { x: r.left + f.poly.reduce((a, q) => a + q[0] / 4, 0), y: r.top + f.poly.reduce((a, q) => a + q[1] / 4, 0), key: f.key }; });
await touch('touchStart', [[cube.x, cube.y]]); await touch('touchEnd', []);
await page.waitForTimeout(900);
const want = { '+y': 180, '-y': 0, '+x': -90, '-x': 90 }[cube.key];
check('a tap on a view cube face glides to that side', await page.evaluate((w) => Math.abs(Roof3D.view.yaw - w) < 0.6, want), cube.key);
// a tap on the roof picks it
await page.evaluate(() => { Roof3D.view.setView(150, 32); });
await page.waitForTimeout(700);
const tap = await page.evaluate(() => { const v = Roof3D.view, it = Roof3D.scene.items[0], pl = it.pls[0], m = pl.poly.reduce((a, q) => [a[0] + q[0] / pl.poly.length, a[1] + q[1] / pl.poly.length], [0, 0]); v.draw(); const P = v.project(m[0], m[1], pl.zAt(m[0], m[1]), v._c), r = v.canvas.getBoundingClientRect(); return { x: r.left + P[0], y: r.top + P[1] }; });
await touch('touchStart', [[tap.x, tap.y]]); await touch('touchEnd', []);
await page.waitForTimeout(500);
check('a tap on the roof picks its plane', await page.evaluate(() => !!(Roof3D.sel && Roof3D.sel.roof)));
await (await page.$('#re-view')).screenshot({ path: SP + '/touch-2.png' });
await browser.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exit(fails ? 1 : 0);
