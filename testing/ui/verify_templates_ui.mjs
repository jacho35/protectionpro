// Headless-UI check of every Verification / Standards template.
//
// For each template: open the app, load the template through Project →
// Templates, run its analysis from the Analyse menu, and assert the headline
// numbers on the study's AppState result field — the same values
// backend/tests/test_verification_templates.py checks against the engine
// (both read EXPECTED in testing/build_verification_templates.py, via
// verification-expected.json here). This is the UI channel of the verification
// cases: template data → app → API → result stored for the badges.
//
// Needs a running full stack (backend serving the frontend) on a THROWAWAY
// database — the script registers/logs in a test user:
//
//   DATABASE_URL=sqlite:////tmp/pp-ui.db python -m uvicorn backend.main:app --port 8000 &
//   cd testing/ui && npm install && node verify_templates_ui.mjs
//
// Env: BASE_URL (default http://localhost:8000), PP_EMAIL / PP_PASSWORD,
// CHROMIUM_PATH (use a specific chromium binary), ONLY (comma-separated
// template ids), SHOTS_DIR (screenshot every template here; failures always
// screenshot to ./ui-failures). Exits 1 if any template fails.

import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE_URL = (process.env.BASE_URL || 'http://localhost:8000').replace(/\/$/, '');
const EMAIL = process.env.PP_EMAIL || 'ui-verify@test.local';
const PASSWORD = process.env.PP_PASSWORD || 'ui-verify-pass-1';
const EXPECTED = JSON.parse(readFileSync(join(HERE, 'verification-expected.json'), 'utf8'));
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const FAIL_DIR = join(HERE, 'ui-failures');

// Analysis route → the Analyse-menu button that runs it and the AppState
// field the frontend stores its response on.
const RUN = {
  'fault': ['#btn-run-fault', 'faultResults'],
  'loadflow': ['#btn-run-loadflow', 'loadFlowResults'],
  'unbalanced-loadflow': ['#btn-run-unbalanced-loadflow', 'unbalancedLoadFlowResults'],
  'cable-sizing': ['#btn-cable-sizing', 'cableSizingResults'],
  'arcflash': ['#btn-arcflash', 'arcFlashResults'],
  'grounding': ['#btn-grounding', 'groundingResults'],
  'motor-starting': ['#btn-motor-starting', 'motorStartingResults'],
  'duty-check': ['#btn-duty-check', 'dutyCheckResults'],
  'load-diversity': ['#btn-load-diversity', 'loadDiversityResults'],
  'dc-loadflow': ['#btn-dc-loadflow', 'dcLoadFlowResults'],
  'dc-shortcircuit': ['#btn-dc-shortcircuit', 'dcShortCircuitResults'],
  'dc-arcflash': ['#btn-dc-arcflash', 'dcArcFlashResults'],
};

async function token() {
  const post = (path, body) => fetch(`${BASE_URL}/api/auth/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  let res = await post('register', { email: EMAIL, password: PASSWORD, name: 'UI verify' });
  if (!res.ok) res = await post('login', { email: EMAIL, password: PASSWORD });
  if (!res.ok) throw new Error(`auth failed (${res.status}): ${await res.text()} — use a throwaway DB`);
  return (await res.json()).access_token;
}

function at(obj, path) {
  let node = obj;
  for (const key of path.split('.')) {
    if (node == null) return undefined;
    node = Array.isArray(node) ? node[Number(key)] : node[key];
  }
  return node;
}

function matches(actual, expected, rel) {
  if (typeof expected === 'number') {
    return typeof actual === 'number' && Math.abs(actual - expected) <= rel * Math.abs(expected);
  }
  return actual === expected;
}

// Accept the pre-run validation warning ("Continue Anyway") if the run shows it.
async function clearBlockers(page) {
  const proceed = page.locator('#validation-proceed');
  if (await proceed.isVisible().catch(() => false)) await proceed.click();
}

async function checkTemplate(browser, jwt, tid) {
  const { route, checks } = EXPECTED[tid];
  const [button, field] = RUN[route] || [];
  if (!button) return { tid, errors: [`no UI mapping for route '${route}'`] };

  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.addInitScript(t => { try { localStorage.setItem('protectionpro-token', t); } catch (_) {} }, jwt);
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('pageerror', e => consoleErrors.push(String(e)));

  const errors = [];
  try {
    await page.goto(BASE_URL, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof AppState !== 'undefined' && typeof NetworkTemplates !== 'undefined');

    // Project → Templates → Load Template (the real picker, not a shortcut).
    await page.click('#menu-file .toolbar-menu-btn');
    await page.click('#btn-templates');
    await page.click(`.template-load-btn[data-id="${tid}"]`);
    await page.waitForFunction(id => AppState.projectName === VerificationTemplates.meta.find(m => m.id === id).name, tid);

    // Analyse → the study's button; wait for its result field to fill.
    await page.click('#menu-analyse .toolbar-menu-btn');
    await page.click(button);
    const deadline = Date.now() + 30000;
    let done = false;
    while (Date.now() < deadline) {
      await clearBlockers(page);
      done = await page.evaluate(f => !!AppState[f], field);
      if (done) break;
      await page.waitForTimeout(250);
    }
    if (!done) {
      errors.push(`AppState.${field} never filled after clicking ${button}`);
    } else {
      const result = await page.evaluate(f => JSON.parse(JSON.stringify(AppState[f])), field);
      for (const [name, [path, expected, rel]] of Object.entries(checks)) {
        const actual = at(result, path);
        if (!matches(actual, expected, rel)) {
          errors.push(`${name} (${field}.${path}) = ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
        }
      }
      // The run must also have drawn its result badges on the diagram.
      const badges = await page.locator('.annotation-badge').count();
      if (!badges) errors.push('no result annotations rendered on the diagram');
    }
    if (consoleErrors.length) errors.push(`page errors: ${consoleErrors.join(' | ')}`);
    if (process.env.SHOTS_DIR || errors.length) {
      const dir = errors.length ? FAIL_DIR : process.env.SHOTS_DIR;
      mkdirSync(dir, { recursive: true });
      await page.screenshot({ path: join(dir, `${tid}.png`) });
    }
  } catch (e) {
    errors.push(String(e.message || e).split('\n')[0]);
    mkdirSync(FAIL_DIR, { recursive: true });
    await page.screenshot({ path: join(FAIL_DIR, `${tid}.png`) }).catch(() => {});
  } finally {
    await context.close();
  }
  return { tid, errors };
}

const jwt = await token();
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let failed = 0;
for (const tid of Object.keys(EXPECTED)) {
  if (ONLY && !ONLY.has(tid)) continue;
  const { errors } = await checkTemplate(browser, jwt, tid);
  if (errors.length) {
    failed++;
    console.log(`FAIL  ${tid}`);
    for (const e of errors) console.log(`        ${e}`);
  } else {
    console.log(`PASS  ${tid}`);
  }
}
await browser.close();
console.log(failed ? `\n${failed} template(s) failed` : '\nall templates pass');
process.exit(failed ? 1 : 0);
