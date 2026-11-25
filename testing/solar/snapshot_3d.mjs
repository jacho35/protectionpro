// Pixel snapshots of the roof 3D view (WebGL renderer): renders a few canonical scenes and compares them with the stored PNGs.
//   node testing/solar/snapshot_3d.mjs            compare (exit 1 on a difference)
//   node testing/solar/snapshot_3d.mjs --update   store the current pictures
// Needs a full stack on a THROWAWAY database (see testing/help-guides/lib.mjs). The comparison is tolerant (mean difference and the
// share of clearly different pixels) because software GL differs a little between machines; look at the diff PNGs it writes to
// <out dir> before updating.
import { launch, token, openApp } from '../help-guides/lib.mjs';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const SNAP = join(here, 'snapshots'), OUT = process.argv.find(a => !a.startsWith('-') && a !== process.argv[0] && a !== process.argv[1]) || join(here, '..', '..', 'scratch');
const update = process.argv.includes('--update');
mkdirSync(SNAP, { recursive: true }); mkdirSync(OUT, { recursive: true });
const MEAN_MAX = 2.5, BAD_MAX = 0.012;           // mean abs channel difference (0-255); share of pixels differing by > 40 in any channel

const browser = await launch();
const page = await openApp(browser, await token(), { width: 1280, height: 800 });
page.on('pageerror', e => console.log('pageerror', String(e).slice(0, 200)));
await page.evaluate(() => Workspaces.setType('reticulation', []));
await page.evaluate(() => switchWorkspace('plan'));
await page.waitForTimeout(800);

const scenes = {
  house: () => {
    AppState.planMarkup.scale = { factor: 0.05, unit: 'm' };
    PlanSolar._store().roofs = [];
    const add = (name, pts, shape, o = {}) => { const r = PlanSolar.addRoof(pts.map(([x, y]) => ({ x, y }))); Object.assign(r, { name, shape, pitch: 21, tilt: 1.5, azimuth: 0, setback: 0.5 }, o); return r; };
    add('West wing', [[0, 0], [150, 0], [150, 420], [0, 420]], 'hip');
    add('East wing', [[330, 0], [480, 0], [480, 330], [330, 330]], 'hip');
    add('Cross roof', [[150, 120], [330, 120], [330, 300], [150, 300]], 'hip');
    add('Entrance', [[150, 300], [330, 300], [330, 360], [150, 360]], 'flat');
    const g = add('Garage', [[260, 400], [470, 400], [470, 560], [260, 560]], 'flat');
    g.objects.push({ id: 'ac', type: 'aircon', x: 300, y: 450, w: 1.4, h: 1.1, d: 0.9, rot: 15 });
    Solar.set('roofShape', 'plan'); Solar.set('location', 'Johannesburg'); Solar.set('targetKwp', 12);
  },
  gable: () => {
    AppState.planMarkup.scale = { factor: 0.05, unit: 'm' };
    PlanSolar._store().roofs = [];
    const r = PlanSolar.addRoof([{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 280 }, { x: 0, y: 280 }]);
    Object.assign(r, { name: 'Roof A', shape: 'gable', pitch: 25, azimuth: 0, setback: 0.5 });
    r.objects.push({ id: 'ch', type: 'chimney', x: 200, y: 5, w: 1.5, h: 4, d: 1.5, rot: 0 });
    Solar.set('roofShape', 'plan'); Solar.set('location', 'Johannesburg'); Solar.set('targetKwp', 30);
  },
};
const views = { iso: [150, 32], low: [60, 12], top: [0, 89] };
let bad = 0;
const diffInPage = (a, b) => page.evaluate(async ([a, b]) => {
  const load = (u) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = 'data:image/png;base64,' + u; });
  const [A, B] = [await load(a), await load(b)];
  if (A.width !== B.width || A.height !== B.height) return { size: [A.width, A.height, B.width, B.height] };
  const px = (im) => { const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d'); g.drawImage(im, 0, 0); return g.getImageData(0, 0, im.width, im.height).data; };
  const da = px(A), db = px(B); let sum = 0, big = 0; const n = da.length / 4;
  for (let i = 0; i < da.length; i += 4) { let m = 0; for (let k = 0; k < 3; k++) { const d = Math.abs(da[i + k] - db[i + k]); sum += d; if (d > m) m = d; } if (m > 40) big++; }
  return { mean: sum / (n * 3), bad: big / n };
}, [a, b]);
for (const [sn, setup] of Object.entries(scenes)) {
  await page.evaluate(setup);
  await page.evaluate(() => RoofEditor.open());
  await page.waitForFunction(() => Roof3D.view && Roof3D.scene && Roof3D.scene.sun && Roof3D.view.sun, null, { timeout: 20000 });     // the sun arrives from the server: without it the picture has no shadows (a race that made earlier runs differ)
  await page.waitForTimeout(600);
  if (!(await page.evaluate(() => Roof3D.view.usesGL))) { console.log('SKIP: WebGL is not available here'); await browser.close(); process.exit(0); }
  for (const [vn, [yaw, pitch]] of Object.entries(views)) {
    await page.evaluate(([y, p]) => { Roof3D.view.setView(y, p); Roof3D.view.draw(); }, [yaw, pitch]);
    await page.waitForTimeout(300);
    const buf = await (await page.$('#re-view')).screenshot();
    const file = join(SNAP, `${sn}-${vn}.png`);
    if (update || !existsSync(file)) { writeFileSync(file, buf); console.log(update ? 'stored' : 'new (stored)', file); continue; }
    const d = await diffInPage(readFileSync(file).toString('base64'), buf.toString('base64'));
    const ok = d.size ? false : d.mean <= MEAN_MAX && d.bad <= BAD_MAX;
    if (!ok) { bad++; writeFileSync(join(OUT, `snapshot-${sn}-${vn}.png`), buf); }
    console.log(ok ? 'PASS' : 'FAIL', `${sn}-${vn}`, d.size ? 'size ' + d.size.join(',') : `mean ${d.mean.toFixed(2)} bad ${(d.bad * 100).toFixed(2)} %`);
  }
  await page.evaluate(() => RoofEditor.close());
  await page.waitForTimeout(300);
}
await browser.close();
console.log(bad ? `${bad} differ` : 'ALL MATCH');
process.exit(bad ? 1 : 0);
