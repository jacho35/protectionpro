/* ProtectionPro — cable-resistance migration regression test (DEV-12 frontend half).
 *
 * Runs the REAL migration logic from frontend/js/state.js (the whole file is
 * evaluated in a vm sandbox with minimal stubs, so `AppState.fromJSON` /
 * `toJSON` / `_migrateCableResistances` are the production implementations,
 * not copies).
 *
 * Pins the two data-corruption classes the June/July audits found:
 *   - DEV-2 (July): v1 files that ALREADY store operating-temperature (hot)
 *     values must NOT be rescaled by the 1.275 temperature factor;
 *   - the original compounding bug: user-edited 20 °C values must scale
 *     exactly once, and a save→reload round trip (dataVersion stamping) must
 *     make the migration a no-op.
 *
 * Run:  node frontend/tests/test_migration.mjs   (exit code 1 on failure)
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const stateSrc = readFileSync(join(here, '..', 'js', 'state.js'), 'utf8');

// ── Fixture library ─────────────────────────────────────────────────────────
// Values hardcoded from frontend/js/constants.js STANDARD_CABLES (the r_per_km
// / r0_per_km figures are the corrected operating-temperature values; Cu XLPE
// temperature factor in the migration is 1.275).
const STANDARD_CABLES = [
  // constants.js entry: 'cu_xlpe_95_11kv' — 95mm² Cu XLPE 11kV
  { id: 'cu_xlpe_95_11kv', name: '95mm² Cu XLPE 11kV', conductor: 'Cu', insulation: 'XLPE',
    size_mm2: 95, voltage_kv: 11, r_per_km: 0.2461, x_per_km: 0.101,
    r0_per_km: 0.9346, x0_per_km: 0.283, rated_amps: 300 },
  // constants.js entry: 'cu_xlpe_50_11kv' — 50mm² Cu XLPE 11kV
  { id: 'cu_xlpe_50_11kv', name: '50mm² Cu XLPE 11kV', conductor: 'Cu', insulation: 'XLPE',
    size_mm2: 50, voltage_kv: 11, r_per_km: 0.4934, x_per_km: 0.107,
    r0_per_km: 1.876, x0_per_km: 0.300, rated_amps: 200 },
];

// ── Evaluate the real state.js with minimal stubs ───────────────────────────
const sandbox = {
  console,
  // constants.js globals state.js references
  DEFAULT_BASE_MVA: 100,
  DEFAULT_FREQUENCY: 50,
  SNAP_SIZE: 20,
  MODE: { SELECT: 'SELECT', WIRE: 'WIRE', PLACE: 'PLACE' },
  COMPONENT_DEFS: {},
  STANDARD_CABLES,
  // annotations.js stub (toJSON/fromJSON touch Annotations.offsets)
  Annotations: { offsets: new Map() },
  // Symbols / UndoManager / Properties / RevisionTimeline are all behind
  // `typeof X !== 'undefined'` guards in state.js — leave them undefined.
};
vm.createContext(sandbox);
const { AppState } = vm.runInContext(`${stateSrc}\n;({ AppState });`, sandbox);

// ── Helpers ──────────────────────────────────────────────────────────────────
let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}` + (ok ? '' : `  (expected ${expected}, got ${actual})`));
}

function cable(id, props) {
  return { id, type: 'cable', x: 0, y: 0, rotation: 0, pageId: 'page_1',
    props: { name: id, ...props } };
}

const F = 1.275; // Cu XLPE 20 °C → operating-temperature factor (state.js factorFor)
const round4 = (v) => Number(v.toPrecision(4));

// ── Fixture project: a v1 file (no dataVersion) with three cable classes ────
const HOT_95 = 0.2461, HOT0_95 = 0.9346;   // cu_xlpe_95_11kv library values
const HOT_50 = 0.4934, HOT0_50 = 1.876;    // cu_xlpe_50_11kv library values
const COLD_95 = round4(HOT_95 / F);        // 0.1930 — the OLD 20 °C library value
const COLD0_95 = round4(HOT0_95 / F);      // 0.7331
const EDITED = 0.30;                       // user-edited 20 °C value (matches no library figure)

const v1Project = {
  projectName: 'Migration fixture',
  baseMVA: 100,
  frequency: 50,
  nextId: 10,
  wires: [],
  components: [
    // (a) unedited library pick saved with the OLD 20 °C value → must SNAP
    cable('cable_1', { standard_type: 'cu_xlpe_95_11kv', r_per_km: COLD_95, r0_per_km: COLD0_95 }),
    // (b) v1-era file that already stores the CURRENT hot value → must NOT rescale
    cable('cable_2', { standard_type: 'cu_xlpe_50_11kv', r_per_km: HOT_50, r0_per_km: HOT0_50 }),
    // (c) user-edited 20 °C value → must scale by the factor exactly ONCE
    cable('cable_3', { standard_type: 'cu_xlpe_95_11kv', r_per_km: EDITED }),
  ],
};

// ── Run 1: load the v1 file (triggers the migration) ────────────────────────
AppState.fromJSON(JSON.parse(JSON.stringify(v1Project)));

const c1 = AppState.components.get('cable_1').props;
const c2 = AppState.components.get('cable_2').props;
const c3 = AppState.components.get('cable_3').props;

console.log('--- v1 load (migration run 1) ---');
check('20 °C library value snaps to hot library r_per_km', c1.r_per_km, HOT_95);
check('20 °C library value snaps to hot library r0_per_km', c1.r0_per_km, HOT0_95);
check('already-hot cable r_per_km NOT rescaled', c2.r_per_km, HOT_50);
check('already-hot cable r0_per_km NOT rescaled', c2.r0_per_km, HOT0_50);
check('user-edited value scaled exactly once', c3.r_per_km, round4(EDITED * F));

// ── Run 2: save → reload round trip must be a no-op ─────────────────────────
const saved = JSON.parse(JSON.stringify(AppState.toJSON()));
console.log('--- save → reload round trip (migration run 2) ---');
check('saved file is stamped dataVersion 2', saved.dataVersion, 2);

AppState.fromJSON(saved);
const d1 = AppState.components.get('cable_1').props;
const d2 = AppState.components.get('cable_2').props;
const d3 = AppState.components.get('cable_3').props;
check('round trip: snapped cable unchanged', d1.r_per_km, HOT_95);
check('round trip: already-hot cable unchanged', d2.r_per_km, HOT_50);
check('round trip: user-edited cable not scaled again', d3.r_per_km, round4(EDITED * F));

// ── Run 3: calling the migration again on migrated values (defence in depth:
// the already-hot guard must make a second pass over library-matched cables a
// no-op even without the dataVersion stamp) ──────────────────────────────────
console.log('--- direct second migration pass on library-matched cables ---');
const twice = [
  cable('cable_10', { standard_type: 'cu_xlpe_95_11kv', r_per_km: COLD_95, r0_per_km: COLD0_95 }),
];
AppState._migrateCableResistances(twice);
AppState._migrateCableResistances(twice);
check('double migration of a library cable is a no-op (r)', twice[0].props.r_per_km, HOT_95);
check('double migration of a library cable is a no-op (r0)', twice[0].props.r0_per_km, HOT0_95);

// ── Result ──────────────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`\n${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log('\nAll migration assertions passed.');
