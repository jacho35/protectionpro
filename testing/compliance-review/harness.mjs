// Loads the REAL frontend/js/constants.js + compliance.js into a vm context
// with a minimal AppState, so the compliance rules run exactly as in the app.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const js = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'frontend', 'js');

export function loadCompliance() {
  const ctx = { console, Math, window: {}, document: { addEventListener() {} },
    Components: { validate: () => ({ errors: [], warnings: [] }) },
    escHtml: s => String(s) };
  vm.createContext(ctx);
  const src = readFileSync(join(js, 'constants.js'), 'utf8') + '\n'
    + readFileSync(join(js, 'compliance.js'), 'utf8')
    + '\n;({ Compliance, fuseTripTime, cbTripTime, STANDARD_CABLES });';
  const api = vm.runInContext(src, ctx);
  api.setState = (s) => {
    ctx.AppState = {
      projectName: 'review', baseMVA: 100, frequency: 50,
      components: new Map((s.components || []).map(c => [c.id, c])),
      wires: new Map((s.wires || []).map(w => [w.id, w])),
      faultResults: s.faultResults || null, faultResultsMin: s.faultResultsMin || null,
      loadFlowResults: s.loadFlowResults || null, dbCheckResults: s.dbCheckResults || null,
    };
    return ctx.AppState;
  };
  return api;
}

// Items of a report whose message/detail/component match a regex
export function find(report, re) {
  const out = [];
  for (const s of report.sections) for (const i of s.items)
    if (re.test(`${i.component} ${i.message}`)) out.push({ section: s.title, ...i });
  return out;
}

export function comp(id, type, props) { return { id, type, x: 0, y: 0, props }; }
export function wire(id, a, b) { return { id, fromComponent: a, fromPort: 'bottom', toComponent: b, toPort: 'top' }; }
