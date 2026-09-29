import { chromium } from 'playwright'; import fs from 'fs';
const b = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const page = await b.newPage();
const out = {};
for (const t of process.argv.slice(2)) {
  await page.goto((t.includes('/') ? 'https://www.ti-soft.com/en/support/help/electricaldesign/standards/iec-60364-5-52/' + t : 'https://www.ti-soft.com/en/support/help/electricaldesign/standards/iec-60364-5-52/current-carrying-capacity/' + t), { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(2500);
  out[t] = await page.evaluate(() => ({
    title: document.querySelector('h1,h2')?.innerText || '',
    tables: [...document.querySelectorAll('table')].map(tb => [...tb.querySelectorAll('tr')].map(r => [...r.querySelectorAll('th,td')].map(c => c.innerText.trim())))
  }));
}
fs.writeFileSync(process.env.OUT, JSON.stringify(out, null, 1));
for (const [k,v] of Object.entries(out)) console.log(k, v.title, v.tables.length, 'tables', v.tables.map(t=>t.length+' rows').join(','));
await b.close();
