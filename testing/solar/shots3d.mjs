import { launch, token, openApp } from '../help-guides/lib.mjs';
const SP = process.argv[2];
const browser = await launch();
const page = await openApp(browser, await token(), { width: 1500, height: 950 });
page.on('pageerror', e => console.log('pageerror', String(e).slice(0, 200)));
await page.evaluate(() => Workspaces.setType('reticulation', []));
await page.evaluate(() => switchWorkspace('plan'));
await page.waitForTimeout(800);
async function scene(name, setup, views) {
  await page.evaluate(setup);
  await page.evaluate(() => RoofEditor.open());
  await page.waitForTimeout(1800);
  for (const [tag, yaw, pitch] of views) {
    await page.evaluate(([y, p]) => { Roof3D.view.setView(y, p); Roof3D.view.fit && 0; }, [yaw, pitch]);
    await page.waitForTimeout(250);
    const el = await page.$('#re-view');
    await el.screenshot({ path: `${SP}/3d-${name}-${tag}.png` });
  }
  await page.evaluate(() => RoofEditor.close());
  await page.waitForTimeout(300);
}
const seed = (shapes) => () => {
  AppState.planMarkup.scale = { factor: 0.05, unit: 'm' };
  PlanSolar._store().roofs = [];
  Solar.set('roofShape', 'plan'); Solar.set('location', 'Johannesburg'); Solar.set('module', 'pv_550_mono'); Solar.set('inverter', 'inv_10k_2mppt'); Solar.set('targetKwp', 30);
  return null;
};
const views = [['a', 150, 32], ['b', 30, 25], ['c', 230, 50], ['d', 100, 12], ['e', 180, 80]];
await scene('gable', () => {
  AppState.planMarkup.scale = { factor: 0.05, unit: 'm' };
  PlanSolar._store().roofs = [];
  const r = PlanSolar.addRoof([{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 280 }, { x: 0, y: 280 }]);
  r.name = 'Roof A'; r.shape = 'gable'; r.pitch = 25; r.azimuth = 0; r.setback = 0.5;
  r.objects.push({ id: 'o1', type: 'chimney', x: 200, y: 5, w: 1.5, h: 4, d: 1.5, rot: 0 }, { id: 'o2', type: 'vent', x: 300, y: 200, w: 0.6, h: 0.8, d: 0.6, rot: 0 });
  Solar.set('roofShape', 'plan'); Solar.set('location', 'Johannesburg'); Solar.set('targetKwp', 30);
}, views);
await scene('hip', () => {
  PlanSolar._store().roofs = [];
  const r = PlanSolar.addRoof([{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 280 }, { x: 0, y: 280 }]);
  r.name = 'Hip'; r.shape = 'hip'; r.pitch = 28; r.azimuth = 0; r.setback = 0.5;
}, views.slice(0, 3));
await scene('flat', () => {
  PlanSolar._store().roofs = [];
  const r = PlanSolar.addRoof([{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 280 }, { x: 0, y: 280 }]);
  r.name = 'Flat'; r.shape = 'flat'; r.tilt = 15; r.azimuth = 0; r.setback = 0.5;
  r.objects.push({ id: 'o3', type: 'aircon', x: 100, y: 100, w: 1.5, h: 1.2, d: 1, rot: 20 });
}, views.slice(0, 4));
await scene('multi', () => {
  PlanSolar._store().roofs = [];
  const a = PlanSolar.addRoof([{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 240 }, { x: 0, y: 240 }]); a.name = 'Main'; a.shape = 'gable'; a.pitch = 25; a.azimuth = 0;
  const b = PlanSolar.addRoof([{ x: 330, y: 60 }, { x: 460, y: 60 }, { x: 460, y: 240 }, { x: 330, y: 240 }]); b.name = 'Garage'; b.shape = 'mono'; b.pitch = 12; b.azimuth = 90;
  const c = PlanSolar.addRoof([{ x: 0, y: 270 }, { x: 200, y: 270 }, { x: 200, y: 400 }, { x: 0, y: 400 }]); c.name = 'Annex'; c.shape = 'pyramid'; c.pitch = 30;
}, views.slice(0, 3));
await browser.close();
console.log('done');
