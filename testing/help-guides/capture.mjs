// Regenerates the Help ▸ Guides screenshots (frontend/img/help/*.png).
//
// Reads HELP_GUIDES from frontend/js/help-guides.js, so a picture's setup name,
// clip and numbered callouts live next to the text that explains them. For each
// shot: open the app against a throwaway server, run the named setup, draw the
// callouts over the elements their selectors match, screenshot, write the file.
//
//   DATABASE_URL=sqlite:////tmp/guides.db python -m uvicorn backend.main:app --port 8902 &
//   node testing/help-guides/capture.mjs          # all shots
//   ONLY=db-ga-1,db-ga-3 node testing/help-guides/capture.mjs
//
// Env: BASE_URL (default http://localhost:8902), CHROMIUM_PATH, OUT_DIR.
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { launch, token, openApp, seedBoard, openBoardTab } from './lib.mjs';
import { SETUPS } from './setups.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const OUT = process.env.OUT_DIR || join(ROOT, 'frontend/img/help');
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;

const ctx = {};
vm.runInNewContext(readFileSync(join(ROOT, 'frontend/js/help-guides.js'), 'utf8')
  .replace(/^const /gm, 'var ').replace(/document\.addEventListener[\s\S]*$/, ''), ctx);
const shots = [];
for (const g of ctx.HELP_GUIDES) for (const s of g.steps) if (s.shot) shots.push({ guide: g.id, ...s.shot });

mkdirSync(OUT, { recursive: true });
const jwt = await token();
// Start from shipped libraries: an earlier run's edits live in the test user's account.
await fetch(`${process.env.BASE_URL || 'http://localhost:8902'}/api/user-libraries`, { method: 'DELETE', headers: { Authorization: `Bearer ${jwt}` } }).catch(() => {});
const browser = await launch();
let bad = 0;

for (const shot of shots) {
  const id = shot.file.replace(/\.png$/, '');
  if (ONLY && !ONLY.has(id)) continue;
  const setup = SETUPS[shot.setup];
  if (!setup) { console.log(`FAIL ${id}: no setup '${shot.setup}'`); bad++; continue; }
  const viewport = shot.phone ? { width: 390, height: 780 } : (setup.viewport || { width: 1440, height: 900 });
  const opts = shot.phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {};
  const page = await openApp(browser, jwt, viewport, opts);
  try {
    await setup.run(page, { seedBoard, openBoardTab });
    await page.waitForTimeout(400);
    // Transient toasts only belong in a picture that points at one.
    if (!(shot.callouts || []).some(c => c.sel.includes('.toast'))) await page.evaluate(() => document.querySelectorAll('.toast').forEach(t => t.remove()));
    const missing = await page.evaluate((callouts) => {
      document.querySelectorAll('.hg-callout').forEach(n => n.remove());
      const miss = [];
      let n = 0;
      for (const c of callouts) {
        const vis = [...document.querySelectorAll(c.sel)].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
        n++;
        if (!vis.length) { miss.push(c.sel); continue; }
        // `all: true` outlines the union of every match (e.g. the parts of one way on a drawing).
        const rs = (c.all ? vis : [vis[0]]).map(e => e.getBoundingClientRect());
        const x1 = Math.min(...rs.map(q => q.left)), y1 = Math.min(...rs.map(q => q.top));
        const x2 = Math.max(...rs.map(q => q.right)), y2 = Math.max(...rs.map(q => q.bottom));
        const r = { left: x1, top: y1, width: x2 - x1, height: y2 - y1 };
        const box = document.createElement('div');
        box.className = 'hg-callout';
        box.style.cssText = `position:fixed;z-index:99999;pointer-events:none;left:${r.left - 3}px;top:${r.top - 3}px;width:${r.width + 6}px;height:${r.height + 6}px;border:2px solid #d32f2f;border-radius:4px;`;
        const dot = document.createElement('div');
        dot.className = 'hg-callout';
        dot.textContent = String(n);
        dot.style.cssText = `position:fixed;z-index:100000;pointer-events:none;left:${Math.max(2, r.left - 12)}px;top:${Math.max(2, r.top - 12)}px;width:22px;height:22px;border-radius:50%;background:#d32f2f;color:#fff;font:700 13px system-ui,sans-serif;display:grid;place-items:center;box-shadow:0 0 0 2px #fff;`;
        document.body.append(box, dot);
      }
      return miss;
    }, shot.callouts || []);
    let clip;
    if (shot.clip && shot.clip !== 'viewport') {
      const r = await page.evaluate(sel => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; }, shot.clip);
      if (!r) { console.log(`FAIL ${id}: clip '${shot.clip}' not found`); bad++; await page.context().close(); continue; }
      const vw = viewport.width, vh = viewport.height;
      clip = { x: Math.max(0, r.x), y: Math.max(0, r.y), width: Math.min(r.width, vw - Math.max(0, r.x)), height: Math.min(r.height, vh - Math.max(0, r.y)) };
    }
    await page.screenshot({ path: join(OUT, shot.file), clip });
    console.log(`${missing.length ? 'WARN' : 'ok  '} ${id}${missing.length ? '  missing: ' + missing.join(' | ') : ''}${page.errors.length ? '  page errors: ' + page.errors.join(' | ') : ''}`);
    if (missing.length || page.errors.length) bad++;
  } catch (e) {
    console.log(`FAIL ${id}: ${String(e.message || e).split('\n')[0]}`);
    await page.screenshot({ path: join(OUT, '_fail_' + shot.file) }).catch(() => {});
    bad++;
  }
  await page.context().close();
}
await browser.close();
process.exit(bad ? 1 : 0);
