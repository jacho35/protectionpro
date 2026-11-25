// Headless check of the Solar PV Design UI (PVGIS hourly sizing, PVsyst import, annual shading, report download).
// Needs a full stack on a THROWAWAY database (see testing/help-guides/lib.mjs): node testing/solar/verify_solar_ui.mjs <output dir>
import { launch, token, openApp, BASE_URL } from '../help-guides/lib.mjs';
import { writeFileSync } from 'node:fs';
const SP = process.argv[2];
const log = (...a) => console.log(...a);
let fails = 0; const check = (name, ok, extra = '') => { if (!ok) fails++; log(ok ? 'PASS' : 'FAIL', name, extra); };
const browser = await launch();
const page = await openApp(browser, await token(), { width: 1500, height: 950 });
page.on('console', m => { if (m.type() === 'error') log('console.error', m.text().slice(0, 200)); });

// ---- 1. size with PVGIS data on a typed roof (no plan needed)
await page.evaluate(() => { Solar.open(); });
await page.waitForTimeout(800);
await page.evaluate(() => { Solar.set('location', 'Johannesburg'); Solar.set('roofShape', 'flat'); Solar.set('irrSrc', 'pvgis'); Solar.set('targetKwp', 15); Solar.render(); });
await page.waitForTimeout(300);
check('Irradiance data select present', await page.$('#sol-irrSrc') !== null);
await page.evaluate(() => Solar._act('run'));
await page.waitForFunction(() => Solar._res && !Solar._busy, null, { timeout: 90000 });
const r1 = await page.evaluate(() => ({ src: Solar._res.irradiance_source, model: Solar._res.model, clip: Solar._res.clipping_loss_pct, life: Solar._res.lifetime && Solar._res.lifetime.length, kwh: Solar._res.annual_kwh, att: Solar._res.attribution }));
log(JSON.stringify(r1));
check('hourly model used', /hourly/.test(r1.model || '') && /PVGIS/.test(r1.src || ''), r1.src);
check('clipping + 25-year table', r1.clip != null && r1.life === 25);
const txt = await page.evaluate(() => document.getElementById('solar-body').innerText);
check('modal shows attribution', /based on PVGIS/.test(txt));
check('modal shows clipping line', /Inverter clipping/.test(txt));
await page.screenshot({ path: SP + '/s1-size.png' });

// switching to the bundled table
await page.evaluate(() => { Solar.set('irrSrc', 'table'); });
await page.evaluate(() => Solar._act('run'));
await page.waitForFunction(() => Solar._res && !Solar._busy && /monthly/.test(Solar._res.model || ''), null, { timeout: 30000 });
check('table option falls back to monthly model', true);
await page.evaluate(() => { Solar.set('irrSrc', 'pvgis'); });

// ---- 2. library import
await page.evaluate(() => { Solar._tab = 'library'; Solar.render(); });
const CSV = 'name,pmax,voc,vmp,isc,imp,voc coeff,pmax coeff,length,width,max system v\nCsv Mod,500,45,38,13,12.2,-0.27,-0.36,2.2,1.1,1500\n';
writeFileSync(SP + '/m.csv', CSV);
const REAL = new URL('./pvsyst/', import.meta.url).pathname;
await page.setInputFiles('#sol-lib-import', [REAL + 'ET-M772BH550GL.PAN', REAL + 'CPS-SCH275KTL.OND', SP + '/m.csv']);
await page.waitForTimeout(800);
const lib = await page.evaluate(() => ({ p: Solar.customPanels().map(x => x.name), i: Solar.customInverters().map(x => x.name), msg: Solar._impMsg }));
log(JSON.stringify(lib));
check('PAN + CSV modules imported', lib.p.includes('ET SOLAR ET-M772BH550GL') && lib.p.includes('Csv Mod'));
check('OND inverter imported', lib.i.includes('ChintPower CPS SCH275KTL-DO/US-800'));
await page.screenshot({ path: SP + '/s2-library.png' });
await page.setInputFiles('#sol-lib-import', [REAL + 'ET-M772BH550GL.PAN']);
await page.waitForTimeout(500);
check('duplicate refused', await page.evaluate(() => /already/.test(Solar._impMsg) && Solar.customPanels().length === 2));
// the imported module is selectable and sizes
await page.evaluate(() => { Solar.set('module', Solar.customPanels()[0].id); Solar.set('inverter', Solar.customInverters()[0].id); Solar._tab = 'size'; Solar.render(); });
await page.evaluate(() => Solar._act('run'));
await page.waitForFunction(() => Solar._res && !Solar._busy && Solar._res.kwp > 0, null, { timeout: 60000 });
check('imported parts size an array', await page.evaluate(() => Solar._res.kwp > 0));
const cv = await page.evaluate(() => Solar._res.curves);
check('the manufacturer\'s incidence table and inverter curve are used', !!cv && /manufacturer/.test(cv.incidence) && /manufacturer/.test(cv.inverter), JSON.stringify(cv));
// a design saved before the irradiance source existed: the first calculation says the model changed, once
await page.evaluate(() => { Solar.set('module', 'pv_550_mono'); Solar.set('inverter', 'inv_10k_2mppt'); const st = PlanSolar._store(); delete st.irrSrc; st.location = 'Johannesburg'; Solar._res = null; });
await page.evaluate(() => Solar._act('run'));
await page.waitForFunction(() => Solar._res && !Solar._busy, null, { timeout: 90000 });
check('an older design is told the model changed, and the choice is then saved', await page.evaluate(() => /earlier monthly model/.test(Solar._res.model_note || '') && PlanSolar._store().irrSrc === 'pvgis'));
await page.evaluate(() => { Solar._res = null; });
await page.evaluate(() => Solar._act('run'));
await page.waitForFunction(() => Solar._res && !Solar._busy, null, { timeout: 90000 });
check('and not told again', await page.evaluate(() => !Solar._res.model_note));

// ---- 3. plan roof + obstruction → annual shading
await page.evaluate(() => Solar.close && Solar.close());
await page.evaluate(() => Workspaces.setType('reticulation', []));
await page.evaluate(() => switchWorkspace('plan'));
await page.waitForTimeout(800);
await page.evaluate(() => {
  AppState.planMarkup.scale = { factor: 0.05, unit: 'm' };
  const st = PlanSolar._store();
  const roof = PlanSolar.addRoof([{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 280 }, { x: 0, y: 280 }]);
  roof.name = 'Roof A'; roof.shape = 'gable'; roof.pitch = 25; roof.azimuth = 0; roof.setback = 0.5;
  roof.objects.push({ id: 'o1', type: 'chimney', x: 200, y: 5, w: 1.5, h: 4, d: 1.5, rot: 0 });
  Solar.set('roofShape', 'plan'); Solar.set('location', 'Johannesburg'); Solar.set('irrSrc', 'pvgis'); Solar.set('module', 'pv_550_mono'); Solar.set('inverter', 'inv_10k_2mppt'); Solar.set('targetKwp', 10);
});
await page.evaluate(() => Solar.open());
await page.waitForTimeout(500);
await page.evaluate(() => Solar._act('run'));
await page.waitForFunction(() => Solar._res && !Solar._busy && Solar._res.arrays, null, { timeout: 90000 }).catch(() => {});
const sz = await page.evaluate(() => Solar._res && { kwp: Solar._res.kwp, arrays: Solar._res.arrays && Solar._res.arrays.map(a => [a.name, a.modules, a.tilt_deg, a.azimuth_deg]) });
log(JSON.stringify(sz));
check('plan roof sized', sz && sz.kwp > 0);
await page.evaluate(() => { Solar._tab = 'grid'; Solar.render(); });
check('Run annual shading enabled', await page.evaluate(() => !document.querySelector('[data-act="shade"]').disabled));
const t0 = Date.now();
await page.evaluate(() => Solar._act('shade'));
await page.waitForFunction(() => Solar._shade || /Solar:/.test(document.getElementById('status-info').textContent), null, { timeout: 120000 });
const sh = await page.evaluate(() => Solar._shade && { loss: Solar._shade.loss_pct, n: Solar._shade.strings.length, mods: Solar._shade.strings.reduce((a, s) => a + s.modules, 0), samples: Solar._shade.samples, mon: Solar._shade.months.map(m => m.loss_pct) });
log(JSON.stringify(sh), (Date.now() - t0) + ' ms', await page.evaluate(() => document.getElementById('status-info').textContent));
check('annual shading ran', !!sh && sh.n > 0 && sh.loss >= 0);
check('a 4 m chimney north of the modules costs a few percent, not most of the energy', !!sh && sh.loss > 0.3 && sh.loss < 15, 'loss ' + (sh && sh.loss));
await page.evaluate(() => Solar.render());
check('result table rendered', await page.evaluate(() => /Annual shading from the 3D roofs/.test(document.getElementById('solar-body').innerText) && /Loss %/.test(document.getElementById('solar-body').innerText)));
await page.screenshot({ path: SP + '/s3-shading.png' });

// ---- 4. report
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.evaluate(() => Solar._act('report'))]);
await dl.saveAs(SP + '/ui-report.pdf');
const size = (await import('node:fs')).statSync(SP + '/ui-report.pdf').size;
check('report downloaded', size > 3000, size + ' bytes');
log('page errors:', JSON.stringify(page.errors));
check('no uncaught page errors', page.errors.length === 0);
await browser.close();
log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exit(fails ? 1 : 0);
