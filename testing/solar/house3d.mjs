import { launch, token, openApp } from '../help-guides/lib.mjs';
const [SP, tag = 'x'] = process.argv.slice(2);
const browser = await launch();
const page = await openApp(browser, await token(), { width: 1280, height: 800 });
page.on('pageerror', e => console.log('pageerror', String(e).slice(0, 300)));
page.on('console', m => { if (m.type() === 'error') console.log('console.error', m.text().slice(0, 200)); });
await page.evaluate(() => Workspaces.setType('reticulation', []));
await page.evaluate(() => switchWorkspace('plan'));
await page.waitForTimeout(800);
await page.evaluate(() => {
  AppState.planMarkup.scale = { factor: 0.05, unit: 'm' };
  const S = PlanSolar._store(); S.roofs = [];
  const add = (name, pts, shape, o = {}) => { const r = PlanSolar.addRoof(pts.map(([x, y]) => ({ x, y }))); Object.assign(r, { name, shape, pitch: 21, tilt: 1.5, azimuth: 0, setback: 0.5 }, o); return r; };
  add('West wing (hip)', [[0, 0], [150, 0], [150, 420], [0, 420]], 'hip');
  add('East wing (hip)', [[330, 0], [480, 0], [480, 330], [330, 330]], 'hip');
  add('Cross roof', [[150, 120], [330, 120], [330, 300], [150, 300]], 'hip', { pitch: 21 });
  add('Covered entrance', [[150, 300], [330, 300], [330, 360], [150, 360]], 'flat', { tilt: 1.5 });
  add('Garage', [[260, 400], [470, 400], [470, 560], [260, 560]], 'flat', { tilt: 1.5 });
  Solar.set('roofShape', 'plan'); Solar.set('location', 'Johannesburg'); Solar.set('targetKwp', 12);
});
await page.evaluate(() => RoofEditor.open());
await page.waitForTimeout(2200);
for (const [t, y, p] of [['iso', 150, 32], ['n', 0, 25], ['top', 0, 89], ['low', 60, 10]]) {
  await page.evaluate(([y, p]) => { Roof3D.view.setView(y, p); }, [y, p]);
  await page.waitForTimeout(300);
  await (await page.$('#re-view')).screenshot({ path: `${SP}/house-${tag}-${t}.png` });
}
await page.screenshot({ path: `${SP}/house-${tag}-full.png` });
await browser.close();
