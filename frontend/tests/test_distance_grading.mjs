/* ProtectionPro — Distance (21) protection zone-grading regression test.
 *
 * Runs the REAL zone-grading logic from frontend/js/tcc.js (the whole file
 * is evaluated in a vm sandbox with minimal stubs, so TCC._analyzeDistanceRelay
 * / _computeDistanceZones / gradeDistanceZones are the production
 * implementations, not copies).
 *
 * Pins: own-line ohms from cable r_per_km/x_per_km x length; direction
 * detection (which side of a Trip CB is "protected", regardless of wire
 * order, via a source-reachability walk); Zone 1/2/3 margin arithmetic
 * against the shortest/longest downstream line; the no-next-line fallback;
 * voltage referral across a transformer; and the infeed factor computed
 * from a solved FaultResultBus.branches entry (not a topological guess).
 *
 * Run:  node frontend/tests/test_distance_grading.mjs   (exit code 1 on failure)
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const tccSrc = readFileSync(join(here, '..', 'js', 'tcc.js'), 'utf8');

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; }
  else console.log(`ok: ${msg}`);
}
function approx(a, b, tol = 1e-6) { return Math.abs(a - b) <= tol; }

// ── Build a fresh TCC instance + AppState fixture per scenario ────────────
function makeSandbox() {
  const components = new Map();
  const wires = new Map();
  const appState = {
    components,
    wires,
    faultResults: null,
    isResultStale: () => false,
  };
  const sandbox = {
    console,
    AppState: appState,
    escHtml: (s) => String(s),
    document: { getElementById: () => ({ innerHTML: '', querySelectorAll: () => [] }) },
    UI: { toast: () => {} },
  };
  vm.createContext(sandbox);
  const { TCC } = vm.runInContext(`${tccSrc}\n;({ TCC });`, sandbox);
  return { TCC, components, wires };
}

function comp(id, type, props) { return { id, type, props }; }
function wire(id, fromComponent, fromPort, toComponent, toPort) {
  return { id, fromComponent, fromPort, toComponent, toPort };
}

// ── Scenario 1: simple radial, no next line ────────────────────────────────
{
  const { TCC, components, wires } = makeSandbox();
  components.set('util1', comp('util1', 'utility', { voltage_kv: 11 }));
  components.set('bus1', comp('bus1', 'bus', { voltage_kv: 11 }));
  components.set('cb1', comp('cb1', 'cb', { state: 'closed' }));
  components.set('cable1', comp('cable1', 'cable', {
    r_per_km: 0.2, x_per_km: 0.1, length_km: 5, num_parallel: 1,
  }));
  components.set('bus2', comp('bus2', 'bus', { voltage_kv: 11 }));
  components.set('relay1', comp('relay1', 'relay', {
    relay_type: '21', voltage_kv: 11, trip_cb: 'cb1',
    z1_reach_ohm: 0.85, z2_reach_ohm: 1.2, z3_reach_ohm: 1.5,
  }));
  wires.set('w1', wire('w1', 'util1', 'out', 'bus1', 'at_0'));
  wires.set('w2', wire('w2', 'bus1', 'at_0', 'cb1', 'top'));
  wires.set('w3', wire('w3', 'cb1', 'bottom', 'cable1', 'from'));
  wires.set('w4', wire('w4', 'cable1', 'to', 'bus2', 'at_0'));

  const relay = components.get('relay1');
  const result = TCC._computeDistanceZones(relay);
  const ownR = 0.2 * 5, ownX = 0.1 * 5; // 1.0, 0.5
  const ownZ = Math.hypot(ownR, ownX);

  assert(!result.error, 'scenario 1: no error');
  assert(approx(result.ownZ, ownZ), `scenario 1: own line Z = ${ownZ.toFixed(4)} (got ${result.ownZ})`);
  assert(approx(result.z1Computed, ownZ * 0.85), `scenario 1: Z1 = 85% of own line (got ${result.z1Computed})`);
  assert(approx(result.z2Computed, ownZ * 1.2), `scenario 1: Z2 = 120% fallback, no next line (got ${result.z2Computed})`);
  assert(approx(result.z3Computed, ownZ * 1.5), `scenario 1: Z3 = 150% fallback, no next line (got ${result.z3Computed})`);
  assert(result.infeedFactor === null, 'scenario 1: no infeed factor without fault results');
}

// ── Scenario 2: shortest/longest next-line selection ────────────────────────
{
  const { TCC, components, wires } = makeSandbox();
  components.set('util1', comp('util1', 'utility', { voltage_kv: 11 }));
  components.set('bus1', comp('bus1', 'bus', { voltage_kv: 11 }));
  components.set('cb1', comp('cb1', 'cb', { state: 'closed' }));
  components.set('cable1', comp('cable1', 'cable', { r_per_km: 0.2, x_per_km: 0.1, length_km: 5 }));
  components.set('bus2', comp('bus2', 'bus', { voltage_kv: 11 }));
  // Short next line
  components.set('cableShort', comp('cableShort', 'cable', { r_per_km: 0.2, x_per_km: 0.1, length_km: 2 }));
  components.set('bus3', comp('bus3', 'bus', { voltage_kv: 11 }));
  // Long next line
  components.set('cableLong', comp('cableLong', 'cable', { r_per_km: 0.2, x_per_km: 0.1, length_km: 8 }));
  components.set('bus4', comp('bus4', 'bus', { voltage_kv: 11 }));
  components.set('relay1', comp('relay1', 'relay', {
    relay_type: '21', voltage_kv: 11, trip_cb: 'cb1',
    z1_reach_ohm: 0.85, z2_reach_ohm: 1.2, z3_reach_ohm: 1.5,
  }));
  wires.set('w1', wire('w1', 'util1', 'out', 'bus1', 'at_0'));
  wires.set('w2', wire('w2', 'bus1', 'at_0', 'cb1', 'top'));
  wires.set('w3', wire('w3', 'cb1', 'bottom', 'cable1', 'from'));
  wires.set('w4', wire('w4', 'cable1', 'to', 'bus2', 'at_0'));
  wires.set('w5', wire('w5', 'bus2', 'at_0', 'cableShort', 'from'));
  wires.set('w6', wire('w6', 'cableShort', 'to', 'bus3', 'at_0'));
  wires.set('w7', wire('w7', 'bus2', 'at_1', 'cableLong', 'from'));
  wires.set('w8', wire('w8', 'cableLong', 'to', 'bus4', 'at_0'));

  const relay = components.get('relay1');
  const result = TCC._computeDistanceZones(relay);
  const ownZ = Math.hypot(1.0, 0.5);
  const shortZ = Math.hypot(0.4, 0.2);
  const longZ = Math.hypot(1.6, 0.8);

  assert(!result.error, 'scenario 2: no error');
  assert(approx(result.shortestNextZ, shortZ), `scenario 2: shortest next line picked (got ${result.shortestNextZ}, want ${shortZ})`);
  assert(approx(result.longestNextZ, longZ), `scenario 2: longest next line picked (got ${result.longestNextZ}, want ${longZ})`);
  assert(approx(result.z2Computed, ownZ + 0.5 * shortZ), 'scenario 2: Z2 = own + 50% of shortest next line');
  assert(approx(result.z3Computed, (ownZ + 1.0 * longZ) * 1.2), 'scenario 2: Z3 = 120% of (own + 100% of longest next line)');
}

// ── Scenario 3: direction detection is order-independent ───────────────────
{
  // Same topology as scenario 1, but wires are recorded with the CB's
  // "toComponent"/"fromComponent" reversed vs. scenario 1's convention, and
  // the source-side wire drawn after the line-side wire — the protected
  // direction must still be found correctly by source-reachability, not by
  // wire insertion order or from/to labelling.
  const { TCC, components, wires } = makeSandbox();
  components.set('util1', comp('util1', 'utility', { voltage_kv: 11 }));
  components.set('bus1', comp('bus1', 'bus', { voltage_kv: 11 }));
  components.set('cb1', comp('cb1', 'cb', { state: 'closed' }));
  components.set('cable1', comp('cable1', 'cable', { r_per_km: 0.3, x_per_km: 0.15, length_km: 4 }));
  components.set('bus2', comp('bus2', 'bus', { voltage_kv: 11 }));
  components.set('relay1', comp('relay1', 'relay', {
    relay_type: '21', voltage_kv: 11, trip_cb: 'cb1',
  }));
  // Reversed from/to vs scenario 1, and line-side wire added first.
  wires.set('w1', wire('w1', 'cable1', 'from', 'cb1', 'bottom'));
  wires.set('w2', wire('w2', 'cable1', 'to', 'bus2', 'at_0'));
  wires.set('w3', wire('w3', 'cb1', 'top', 'bus1', 'at_0'));
  wires.set('w4', wire('w4', 'bus1', 'at_0', 'util1', 'out'));

  const relay = components.get('relay1');
  const result = TCC._computeDistanceZones(relay);
  assert(!result.error, 'scenario 3: no error despite reversed wire order/direction');
  assert(result.remoteBusId === 'bus2', `scenario 3: remote bus correctly identified as bus2 (got ${result.remoteBusId})`);
  assert(approx(result.ownZ, Math.hypot(1.2, 0.6)), 'scenario 3: own line Z correct regardless of wire order');
}

// ── Scenario 4: voltage referral across a transformer ───────────────────────
{
  const { TCC, components, wires } = makeSandbox();
  components.set('util1', comp('util1', 'utility', { voltage_kv: 11 }));
  components.set('bus1', comp('bus1', 'bus', { voltage_kv: 11 }));
  components.set('cb1', comp('cb1', 'cb', { state: 'closed' }));
  components.set('xf1', comp('xf1', 'transformer', {
    voltage_hv_kv: 11, voltage_lv_kv: 0.4, z_percent: 6, rated_mva: 1, x_r_ratio: 8,
  }));
  components.set('bus2', comp('bus2', 'bus', { voltage_kv: 0.4 }));
  components.set('relay1', comp('relay1', 'relay', {
    relay_type: '21', voltage_kv: 11, trip_cb: 'cb1',
  }));
  wires.set('w1', wire('w1', 'util1', 'out', 'bus1', 'at_0'));
  wires.set('w2', wire('w2', 'bus1', 'at_0', 'cb1', 'top'));
  wires.set('w3', wire('w3', 'cb1', 'bottom', 'xf1', 'primary'));
  wires.set('w4', wire('w4', 'xf1', 'secondary', 'bus2', 'at_0'));

  const relay = components.get('relay1');
  const result = TCC._computeDistanceZones(relay);
  // Nameplate |Z| at 11kV (the relay's own/local, HV entry side):
  // z_pu = (z%/100)*V^2/MVA = (6/100)*11^2/1 = 7.26 ohm — and since this
  // helper's R/X split (x=z*xr/sqrt(1+xr^2), r=x/xr) always satisfies
  // hypot(r,x) == z_pu exactly, this is also the expected ownZ directly.
  const zOhmAt11kv = (6 / 100) * (11 * 11) / 1;
  assert(!result.error, 'scenario 4: no error across a transformer');
  assert(approx(result.ownZ, zOhmAt11kv, 1e-6),
    `scenario 4: transformer referred to the relay's own (HV, entry) side (got ${result.ownZ}, want ${zOhmAt11kv})`);
}

// ── Scenario 5: infeed factor from a real solved fault-at-remote-bus result ─
{
  const components = new Map();
  const wires = new Map();
  components.set('util1', comp('util1', 'utility', { voltage_kv: 11 }));
  components.set('bus1', comp('bus1', 'bus', { voltage_kv: 11 }));
  components.set('cb1', comp('cb1', 'cb', { state: 'closed' }));
  components.set('cable1', comp('cable1', 'cable', { r_per_km: 0.2, x_per_km: 0.1, length_km: 3 }));
  components.set('bus2', comp('bus2', 'bus', { voltage_kv: 11 }));
  components.set('cableNext', comp('cableNext', 'cable', { r_per_km: 0.2, x_per_km: 0.1, length_km: 2 }));
  components.set('bus3', comp('bus3', 'bus', { voltage_kv: 11 }));
  components.set('relay1', comp('relay1', 'relay', {
    relay_type: '21', voltage_kv: 11, trip_cb: 'cb1',
    z1_reach_ohm: 0.5, z2_reach_ohm: 0.7, z3_reach_ohm: 1.0,
  }));
  wires.set('w1', wire('w1', 'util1', 'out', 'bus1', 'at_0'));
  wires.set('w2', wire('w2', 'bus1', 'at_0', 'cb1', 'top'));
  wires.set('w3', wire('w3', 'cb1', 'bottom', 'cable1', 'from'));
  wires.set('w4', wire('w4', 'cable1', 'to', 'bus2', 'at_0'));
  wires.set('w5', wire('w5', 'bus2', 'at_0', 'cableNext', 'from'));
  wires.set('w6', wire('w6', 'cableNext', 'to', 'bus3', 'at_0'));

  // Fault at bus2 (the remote/junction bus): total 10kA, only 4kA of which
  // flows through cable1 (the protected line) -> infeed factor 2.5x.
  const fr = {
    buses: {
      bus2: {
        ik3: 10.0,
        branches: [
          { element_id: 'cable1', ik_ka: 4.0 },
          { element_id: 'some_other_infeed', ik_ka: 6.0 },
        ],
      },
    },
  };
  // makeSandbox() doesn't expose the AppState it builds, and the vm
  // context's globals are fixed at eval time — so build a sandbox here with
  // faultResults present from the start, reusing this scenario's network.
  const components3 = new Map();
  const wires3 = new Map();
  for (const [id, c] of components) components3.set(id, c);
  for (const [id, w] of wires) wires3.set(id, w);
  const appState3 = { components: components3, wires: wires3, faultResults: fr, isResultStale: () => false };
  const sandbox3 = {
    console, AppState: appState3, escHtml: (s) => String(s),
    document: { getElementById: () => ({ innerHTML: '', querySelectorAll: () => [] }) },
    UI: { toast: () => {} },
  };
  vm.createContext(sandbox3);
  const { TCC: TCC3 } = vm.runInContext(`${tccSrc}\n;({ TCC });`, sandbox3);

  const relay3 = components3.get('relay1');
  const result3 = TCC3._computeDistanceZones(relay3);
  assert(!result3.error, 'scenario 5: no error');
  assert(approx(result3.infeedFactor, 2.5), `scenario 5: infeed factor = total/own = 10/4 = 2.5 (got ${result3.infeedFactor})`);
  const shortZ = Math.hypot(0.4, 0.2);
  const ownZ = Math.hypot(0.6, 0.3);
  const expectedZ2Apparent = ownZ + 2.5 * shortZ * 0.5;
  assert(approx(result3.z2Apparent, expectedZ2Apparent),
    `scenario 5: Z2 apparent reach scales the next-line term by the infeed factor (got ${result3.z2Apparent}, want ${expectedZ2Apparent})`);

  // The configured Z2 (0.7 ohm) is below the infeed-corrected apparent
  // impedance -> gradeDistanceZones must flag underreach for this relay.
  assert(result3.z2Apparent > parseFloat(relay3.props.z2_reach_ohm),
    'scenario 5: configured Z2 is below the infeed-corrected apparent impedance (underreach case)');
}

// ── Summary ──────────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
} else {
  console.log('\nAll distance-grading tests passed.');
}
