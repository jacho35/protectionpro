// Screenshots of the lighting room view and the road plan 3D view on both renderers, for side-by-side comparison (throwaway database).
import { launch, token, openApp } from '../help-guides/lib.mjs';
const SP = process.argv[2];
const browser = await launch();
const jwt = await token();
for (const mode of ['gl', '2d']) {
  const page = await openApp(browser, jwt, { width: 1400, height: 900 }, {}, { startScreen: false });
  if (mode === '2d') { await page.evaluate(() => localStorage.setItem('pp-3d-renderer', '2d')); }
  else await page.evaluate(() => localStorage.removeItem('pp-3d-renderer'));
  page.on('pageerror', e => console.log(mode, 'pageerror', String(e).slice(0, 200)));
  page.on('console', m => { if (m.type() === 'error') console.log(mode, 'console.error', m.text().slice(0, 160)); });
  // --- road plan
  try {
    await page.evaluate(() => { Workspaces.setType('reticulation', []); switchWorkspace('streetlight'); });
    await page.waitForTimeout(600);
    await page.click('[data-sl="view"][data-step="roads"]');
    await page.waitForTimeout(1200);
    await page.evaluate(async () => {
      AppState.planMarkup.scale = { factor: 0.05, unit: 'm' };
      await RoadPlan._newRoad({ mode: 'ip', ip: [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 120, y: 30 }], radius: 20 });
      RoadPlan.setView3d(true);
    });
    await page.waitForTimeout(2000);
    const rr = await page.evaluate(() => ({ gl: Road3D.view && Road3D.view.usesGL, roads: RoadPlan.roads.length }));
    console.log(mode, 'road', JSON.stringify(rr));
    const el2 = await page.$('#r3-view');
    if (el2) await el2.screenshot({ path: `${SP}/cmp-road-${mode}.png` });
  } catch (e) { console.log(mode, 'road failed', String(e).slice(0, 300)); }
  await page.close();
}
await browser.close();
