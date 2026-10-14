// Run named setups and save full-viewport screenshots to a folder (no guides needed).
//   OUT=/tmp/x KEYS=x-ts-config,x-ts-results node testing/help-guides/explore.mjs
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch, token, openApp } from './lib.mjs';
import { SETUPS } from './setups.mjs';
const OUT = process.env.OUT || '/tmp/help-explore';
mkdirSync(OUT, { recursive: true });
const keys = (process.env.KEYS || '').split(',').filter(Boolean);
const jwt = await token(); const b = await launch();
for (const k of keys) {
  const s = SETUPS[k];
  if (!s) { console.log('no setup', k); continue; }
  const page = await openApp(b, jwt, s.viewport || { width: 1500, height: 950 });
  page.setDefaultTimeout(12000);
  try { await s.run(page, {}); await page.waitForTimeout(500); console.log('ok ', k, page.errors.length ? page.errors.join('|') : ''); }
  catch (e) { console.log('ERR', k, String(e.message).split('\n')[0]); }
  await page.screenshot({ path: join(OUT, k + '.png') }).catch(() => {});
  await page.context().close();
}
await b.close();
