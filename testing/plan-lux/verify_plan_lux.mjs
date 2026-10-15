// Point-method check of plan-lux.js against hand values.
//   node testing/plan-lux/verify_plan_lux.mjs     (exits 1 on any FAIL)
// E = I(θ)·cosθ / d², d² = r² + h². Cone model: I0 = Φ / (2π(1 − cos(β/2))).
import fs from 'fs';
import vm from 'vm';

const src = fs.readFileSync(new URL('../../frontend/js/plan-lux.js', import.meta.url), 'utf8');
let fails = 0;
const check = (name, got, want, tol) => {
  const ok = Math.abs(got - want) <= tol * Math.abs(want);
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${got.toFixed(3)} vs ${want.toFixed(3)}`);
};

function makeLux({ factor, elements, rooms = [] }) {
  const ctx = {
    console, Math, Float32Array,
    AppState: { planMarkup: { elements, rooms } },
    PLAN_DEFS: { element: () => ({ group: 'Lighting', defaults: {} }) },
    PlanEngine: { factor: () => factor, requestDraw() {} },
    PlanIES: undefined, UI: {},
    document: { querySelector: () => null },
  };
  vm.createContext(ctx);
  vm.runInContext(src + '\nthis.PlanLux = PlanLux;', ctx);
  return ctx.PlanLux;
}

// 1. A single 3000 lm fitting, 2.5 m high, 120° cone: E under = I0 / h².
{
  const lux = makeLux({ factor: 0.01, elements: [
    { type: 'light', x: 0, y: 0, props: { lumens: 3000 } }] });
  lux.settings.resM = 0.25;
  lux._compute();
  const g = lux._grid;
  const I0 = 3000 / (2 * Math.PI * (1 - Math.cos(60 * Math.PI / 180)));
  check('peak under a cone fitting', g.max, I0 / (2.5 * 2.5), 0.02);   // cell-centre offset
}

// 2. The same fitting, a point 1.5 m off: E = I0·cos³θ / h² (cos θ = h/d).
//    A 6 m room gives the grid the extent (without rooms it is the fittings
//    plus a 1 m margin).
{
  const room = { points: [{ x: -300, y: -300 }, { x: 300, y: -300 },
                          { x: 300, y: 300 }, { x: -300, y: 300 }] };
  const lux = makeLux({ factor: 0.01, rooms: [room], elements: [
    { type: 'light', x: 0, y: 0, props: { lumens: 3000 } }] });
  lux.settings.resM = 0.1;
  lux._compute();
  const g = lux._grid;
  const I0 = 3000 / (2 * Math.PI * (1 - Math.cos(60 * Math.PI / 180)));
  const r = 1.5, h = 2.5, d = Math.hypot(r, h);
  const want = I0 * (h / d) ** 3 / (h * h);
  const i = Math.round((r / 0.01 - g.minX) / g.step - 0.5);
  const j = Math.round((0 - g.minY) / g.step - 0.5);
  check('1.5 m off axis', g.vals[j * g.cols + i], want, 0.03);
}

// 3. A very wide plan keeps its whole extent inside the 400-cell cap [LX1].
{
  const lux = makeLux({ factor: 0.05, elements: [          // 0.05 m per px
    { type: 'light', x: 0, y: 0, props: { lumens: 3000 } },
    { type: 'light', x: 8000, y: 0, props: { lumens: 3000 } }] });   // 400 m apart
  lux._compute();
  const g = lux._grid;
  const reach = (g.minX + g.cols * g.step) * 0.05;
  check('grid reaches the far fitting (m)', reach, 400 + 1, 0.02);
}

// 4. LM-63 file measured over 90-270 deg is bilateral about that plane [IES1]
{
  const ctx = { Math, Number, Float32Array, AppState: {}, UI: {} };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(new URL('../../frontend/js/plan-ies.js', import.meta.url), 'utf8') + '\nthis.PlanIES = PlanIES;', ctx);
  const prof = { vAngles: [0, 90], hAngles: [90, 180, 270], cd: [[100, 100], [300, 300], [500, 500]] };
  const I = (h) => ctx.PlanIES.intensity(prof, 0, h);
  check('h=180 measured', I(180), 300, 1e-9);
  check('h=0 mirrors to 180', I(0), 300, 1e-9);
  check('h=45 mirrors to 135', I(45), 200, 1e-9);
  check('h=315 mirrors to 225', I(315), 400, 1e-9);
}

console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
