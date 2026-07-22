/* ProtectionPro — Constants & Configuration */

// Bump on any engine change that alters analysis results — saved study
// verdicts are provenance-stamped with this (state.js) and flagged stale on
// load. V5: 2026-07 calculation-verification P3 remediation (capacitor Q∝V²,
// fuse-curve clearing, CB thermal k/(M²−1), YNyn Z0 through-path, duty-check
// asym/making, CT knee, q-factor pole pairs, GS mismatch check, …).
const APP_VERSION = 'V5';

const GRID_SIZE = 20;
const SNAP_SIZE = 20;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 5;
const ZOOM_STEP = 0.1;
const DEFAULT_BASE_MVA = 100;
const DEFAULT_FREQUENCY = 50;
// IEC 60909-0 Table 1 voltage factor c for maximum short-circuit currents.
// 1.10 is standard for MV/HV and modern +10 % LV systems; set to 1.0 to
// reproduce bolted-fault / V=1.0 studies that omit the voltage factor.
const DEFAULT_VOLTAGE_FACTOR = 1.10;

const API_BASE = '/api';

// ─── Standard Cable Library ───
// Typical MV/LV XLPE cable data per IEC 60502 / SANS 1339
// Values: AC resistance at 90°C conductor temperature (derived from IEC 60228
// 20°C DC values × temperature factor: Cu ×1.275, Al ×1.282; PVC entries at
// 70°C: ×1.20), trefoil formation. X values at 50 Hz.
const STANDARD_CABLES = [
  // MV XLPE Copper (11kV) — r0: 3.8×r1, x0: 2.8×x1 per IEC 60502 (Cu XLPE MV screened)
  { id: 'cu_xlpe_16_11kv',  name: '16mm² Cu XLPE 11kV',   conductor: 'Cu', insulation: 'XLPE', size_mm2: 16,  voltage_kv: 11,  r_per_km: 1.466,   x_per_km: 0.119, r0_per_km: 5.572, x0_per_km: 0.333, rated_amps: 110 },
  { id: 'cu_xlpe_25_11kv',  name: '25mm² Cu XLPE 11kV',   conductor: 'Cu', insulation: 'XLPE', size_mm2: 25,  voltage_kv: 11,  r_per_km: 0.9269,  x_per_km: 0.113, r0_per_km: 3.523, x0_per_km: 0.316, rated_amps: 140 },
  { id: 'cu_xlpe_35_11kv',  name: '35mm² Cu XLPE 11kV',   conductor: 'Cu', insulation: 'XLPE', size_mm2: 35,  voltage_kv: 11,  r_per_km: 0.6681,  x_per_km: 0.110, r0_per_km: 2.539, x0_per_km: 0.308, rated_amps: 170 },
  { id: 'cu_xlpe_50_11kv',  name: '50mm² Cu XLPE 11kV',   conductor: 'Cu', insulation: 'XLPE', size_mm2: 50,  voltage_kv: 11,  r_per_km: 0.4934,  x_per_km: 0.107, r0_per_km: 1.876, x0_per_km: 0.300, rated_amps: 200 },
  { id: 'cu_xlpe_70_11kv',  name: '70mm² Cu XLPE 11kV',   conductor: 'Cu', insulation: 'XLPE', size_mm2: 70,  voltage_kv: 11,  r_per_km: 0.3417,  x_per_km: 0.104, r0_per_km: 1.298, x0_per_km: 0.291, rated_amps: 245 },
  { id: 'cu_xlpe_95_11kv',  name: '95mm² Cu XLPE 11kV',   conductor: 'Cu', insulation: 'XLPE', size_mm2: 95,  voltage_kv: 11,  r_per_km: 0.2461,  x_per_km: 0.101, r0_per_km: 0.9346, x0_per_km: 0.283, rated_amps: 300 },
  { id: 'cu_xlpe_120_11kv', name: '120mm² Cu XLPE 11kV',  conductor: 'Cu', insulation: 'XLPE', size_mm2: 120, voltage_kv: 11,  r_per_km: 0.1951,  x_per_km: 0.099, r0_per_km: 0.7408, x0_per_km: 0.277, rated_amps: 340 },
  { id: 'cu_xlpe_150_11kv', name: '150mm² Cu XLPE 11kV',  conductor: 'Cu', insulation: 'XLPE', size_mm2: 150, voltage_kv: 11,  r_per_km: 0.1601,  x_per_km: 0.097, r0_per_km: 0.6084, x0_per_km: 0.272, rated_amps: 380 },
  { id: 'cu_xlpe_185_11kv', name: '185mm² Cu XLPE 11kV',  conductor: 'Cu', insulation: 'XLPE', size_mm2: 185, voltage_kv: 11,  r_per_km: 0.1289, x_per_km: 0.095, r0_per_km: 0.4898, x0_per_km: 0.266, rated_amps: 430 },
  { id: 'cu_xlpe_240_11kv', name: '240mm² Cu XLPE 11kV',  conductor: 'Cu', insulation: 'XLPE', size_mm2: 240, voltage_kv: 11,  r_per_km: 0.0994, x_per_km: 0.093, r0_per_km: 0.3777, x0_per_km: 0.260, rated_amps: 500 },
  { id: 'cu_xlpe_300_11kv', name: '300mm² Cu XLPE 11kV',  conductor: 'Cu', insulation: 'XLPE', size_mm2: 300, voltage_kv: 11,  r_per_km: 0.0807, x_per_km: 0.091, r0_per_km: 0.3067, x0_per_km: 0.255, rated_amps: 560 },
  { id: 'cu_xlpe_400_11kv', name: '400mm² Cu XLPE 11kV',  conductor: 'Cu', insulation: 'XLPE', size_mm2: 400, voltage_kv: 11,  r_per_km: 0.0649, x_per_km: 0.089, r0_per_km: 0.2466, x0_per_km: 0.249, rated_amps: 630 },
  // MV XLPE Aluminium (11kV) — r0: 3.4×r1, x0: 2.8×x1 per IEC 60502 (Al XLPE MV screened)
  { id: 'al_xlpe_35_11kv',  name: '35mm² Al XLPE 11kV',   conductor: 'Al', insulation: 'XLPE', size_mm2: 35,  voltage_kv: 11,  r_per_km: 1.113,  x_per_km: 0.110, r0_per_km: 3.783, x0_per_km: 0.308, rated_amps: 130 },
  { id: 'al_xlpe_50_11kv',  name: '50mm² Al XLPE 11kV',   conductor: 'Al', insulation: 'XLPE', size_mm2: 50,  voltage_kv: 11,  r_per_km: 0.8218,  x_per_km: 0.107, r0_per_km: 2.793, x0_per_km: 0.300, rated_amps: 155 },
  { id: 'al_xlpe_70_11kv',  name: '70mm² Al XLPE 11kV',   conductor: 'Al', insulation: 'XLPE', size_mm2: 70,  voltage_kv: 11,  r_per_km: 0.5679,  x_per_km: 0.104, r0_per_km: 1.931, x0_per_km: 0.291, rated_amps: 190 },
  { id: 'al_xlpe_95_11kv',  name: '95mm² Al XLPE 11kV',   conductor: 'Al', insulation: 'XLPE', size_mm2: 95,  voltage_kv: 11,  r_per_km: 0.4102,  x_per_km: 0.101, r0_per_km: 1.395, x0_per_km: 0.283, rated_amps: 230 },
  { id: 'al_xlpe_120_11kv', name: '120mm² Al XLPE 11kV',  conductor: 'Al', insulation: 'XLPE', size_mm2: 120, voltage_kv: 11,  r_per_km: 0.3243,  x_per_km: 0.099, r0_per_km: 1.103, x0_per_km: 0.277, rated_amps: 265 },
  { id: 'al_xlpe_150_11kv', name: '150mm² Al XLPE 11kV',  conductor: 'Al', insulation: 'XLPE', size_mm2: 150, voltage_kv: 11,  r_per_km: 0.2641,  x_per_km: 0.097, r0_per_km: 0.8974, x0_per_km: 0.272, rated_amps: 300 },
  { id: 'al_xlpe_185_11kv', name: '185mm² Al XLPE 11kV',  conductor: 'Al', insulation: 'XLPE', size_mm2: 185, voltage_kv: 11,  r_per_km: 0.2118,  x_per_km: 0.095, r0_per_km: 0.7201, x0_per_km: 0.266, rated_amps: 340 },
  { id: 'al_xlpe_240_11kv', name: '240mm² Al XLPE 11kV',  conductor: 'Al', insulation: 'XLPE', size_mm2: 240, voltage_kv: 11,  r_per_km: 0.1623,  x_per_km: 0.093, r0_per_km: 0.5518, x0_per_km: 0.260, rated_amps: 395 },
  { id: 'al_xlpe_300_11kv', name: '300mm² Al XLPE 11kV',  conductor: 'Al', insulation: 'XLPE', size_mm2: 300, voltage_kv: 11,  r_per_km: 0.1307,  x_per_km: 0.091, r0_per_km: 0.4444, x0_per_km: 0.255, rated_amps: 445 },
  { id: 'al_xlpe_400_11kv', name: '400mm² Al XLPE 11kV',  conductor: 'Al', insulation: 'XLPE', size_mm2: 400, voltage_kv: 11,  r_per_km: 0.1029, x_per_km: 0.089, r0_per_km: 0.3499, x0_per_km: 0.249, rated_amps: 505 },
  // LV XLPE Copper (0.6/1kV) — r0: 3.8×r1, x0: 2.8×x1 per IEC 60502 (Cu XLPE)
  { id: 'cu_xlpe_16_lv',  name: '16mm² Cu XLPE LV',   conductor: 'Cu', insulation: 'XLPE', size_mm2: 16,  voltage_kv: 0.4, r_per_km: 1.466,   x_per_km: 0.082, r0_per_km: 5.572, x0_per_km: 0.230, rated_amps: 91  },
  { id: 'cu_xlpe_25_lv',  name: '25mm² Cu XLPE LV',   conductor: 'Cu', insulation: 'XLPE', size_mm2: 25,  voltage_kv: 0.4, r_per_km: 0.9269,  x_per_km: 0.079, r0_per_km: 3.523, x0_per_km: 0.221, rated_amps: 116 },
  { id: 'cu_xlpe_35_lv',  name: '35mm² Cu XLPE LV',   conductor: 'Cu', insulation: 'XLPE', size_mm2: 35,  voltage_kv: 0.4, r_per_km: 0.6681,  x_per_km: 0.077, r0_per_km: 2.539, x0_per_km: 0.216, rated_amps: 140 },
  { id: 'cu_xlpe_50_lv',  name: '50mm² Cu XLPE LV',   conductor: 'Cu', insulation: 'XLPE', size_mm2: 50,  voltage_kv: 0.4, r_per_km: 0.4934,  x_per_km: 0.075, r0_per_km: 1.876, x0_per_km: 0.210, rated_amps: 167 },
  { id: 'cu_xlpe_70_lv',  name: '70mm² Cu XLPE LV',   conductor: 'Cu', insulation: 'XLPE', size_mm2: 70,  voltage_kv: 0.4, r_per_km: 0.3417,  x_per_km: 0.073, r0_per_km: 1.298, x0_per_km: 0.204, rated_amps: 210 },
  { id: 'cu_xlpe_95_lv',  name: '95mm² Cu XLPE LV',   conductor: 'Cu', insulation: 'XLPE', size_mm2: 95,  voltage_kv: 0.4, r_per_km: 0.2461,  x_per_km: 0.072, r0_per_km: 0.9346, x0_per_km: 0.202, rated_amps: 254 },
  { id: 'cu_xlpe_120_lv', name: '120mm² Cu XLPE LV',  conductor: 'Cu', insulation: 'XLPE', size_mm2: 120, voltage_kv: 0.4, r_per_km: 0.1951,  x_per_km: 0.071, r0_per_km: 0.7408, x0_per_km: 0.199, rated_amps: 292 },
  { id: 'cu_xlpe_150_lv', name: '150mm² Cu XLPE LV',  conductor: 'Cu', insulation: 'XLPE', size_mm2: 150, voltage_kv: 0.4, r_per_km: 0.1601,  x_per_km: 0.070, r0_per_km: 0.6084, x0_per_km: 0.196, rated_amps: 330 },
  { id: 'cu_xlpe_185_lv', name: '185mm² Cu XLPE LV',  conductor: 'Cu', insulation: 'XLPE', size_mm2: 185, voltage_kv: 0.4, r_per_km: 0.1289, x_per_km: 0.069, r0_per_km: 0.4898, x0_per_km: 0.193, rated_amps: 375 },
  { id: 'cu_xlpe_240_lv', name: '240mm² Cu XLPE LV',  conductor: 'Cu', insulation: 'XLPE', size_mm2: 240, voltage_kv: 0.4, r_per_km: 0.0994, x_per_km: 0.068, r0_per_km: 0.3777, x0_per_km: 0.190, rated_amps: 440 },
  { id: 'cu_xlpe_300_lv', name: '300mm² Cu XLPE LV',  conductor: 'Cu', insulation: 'XLPE', size_mm2: 300, voltage_kv: 0.4, r_per_km: 0.0807, x_per_km: 0.067, r0_per_km: 0.3067, x0_per_km: 0.188, rated_amps: 500 },
  // MV XLPE Copper (22kV) — r0: 3.8×r1, x0: 2.8×x1 per IEC 60502 (Cu XLPE MV screened)
  { id: 'cu_xlpe_35_22kv',  name: '35mm² Cu XLPE 22kV',   conductor: 'Cu', insulation: 'XLPE', size_mm2: 35,  voltage_kv: 22,  r_per_km: 0.6681,  x_per_km: 0.122, r0_per_km: 2.539, x0_per_km: 0.342, rated_amps: 160 },
  { id: 'cu_xlpe_50_22kv',  name: '50mm² Cu XLPE 22kV',   conductor: 'Cu', insulation: 'XLPE', size_mm2: 50,  voltage_kv: 22,  r_per_km: 0.4934,  x_per_km: 0.118, r0_per_km: 1.876, x0_per_km: 0.330, rated_amps: 190 },
  { id: 'cu_xlpe_70_22kv',  name: '70mm² Cu XLPE 22kV',   conductor: 'Cu', insulation: 'XLPE', size_mm2: 70,  voltage_kv: 22,  r_per_km: 0.3417,  x_per_km: 0.114, r0_per_km: 1.298, x0_per_km: 0.319, rated_amps: 235 },
  { id: 'cu_xlpe_95_22kv',  name: '95mm² Cu XLPE 22kV',   conductor: 'Cu', insulation: 'XLPE', size_mm2: 95,  voltage_kv: 22,  r_per_km: 0.2461,  x_per_km: 0.111, r0_per_km: 0.9346, x0_per_km: 0.311, rated_amps: 280 },
  { id: 'cu_xlpe_120_22kv', name: '120mm² Cu XLPE 22kV',  conductor: 'Cu', insulation: 'XLPE', size_mm2: 120, voltage_kv: 22,  r_per_km: 0.1951,  x_per_km: 0.108, r0_per_km: 0.7408, x0_per_km: 0.302, rated_amps: 320 },
  { id: 'cu_xlpe_150_22kv', name: '150mm² Cu XLPE 22kV',  conductor: 'Cu', insulation: 'XLPE', size_mm2: 150, voltage_kv: 22,  r_per_km: 0.1601,  x_per_km: 0.106, r0_per_km: 0.6084, x0_per_km: 0.297, rated_amps: 360 },
  { id: 'cu_xlpe_185_22kv', name: '185mm² Cu XLPE 22kV',  conductor: 'Cu', insulation: 'XLPE', size_mm2: 185, voltage_kv: 22,  r_per_km: 0.1289, x_per_km: 0.104, r0_per_km: 0.4898, x0_per_km: 0.291, rated_amps: 410 },
  { id: 'cu_xlpe_240_22kv', name: '240mm² Cu XLPE 22kV',  conductor: 'Cu', insulation: 'XLPE', size_mm2: 240, voltage_kv: 22,  r_per_km: 0.0994, x_per_km: 0.101, r0_per_km: 0.3777, x0_per_km: 0.283, rated_amps: 475 },
  { id: 'cu_xlpe_300_22kv', name: '300mm² Cu XLPE 22kV',  conductor: 'Cu', insulation: 'XLPE', size_mm2: 300, voltage_kv: 22,  r_per_km: 0.0807, x_per_km: 0.099, r0_per_km: 0.3067, x0_per_km: 0.277, rated_amps: 535 },
  // MV XLPE Copper (33kV) — r0: 3.8×r1, x0: 2.8×x1 per IEC 60502 (Cu XLPE MV screened)
  { id: 'cu_xlpe_50_33kv',  name: '50mm² Cu XLPE 33kV',   conductor: 'Cu', insulation: 'XLPE', size_mm2: 50,  voltage_kv: 33,  r_per_km: 0.4934,  x_per_km: 0.130, r0_per_km: 1.876, x0_per_km: 0.364, rated_amps: 175 },
  { id: 'cu_xlpe_70_33kv',  name: '70mm² Cu XLPE 33kV',   conductor: 'Cu', insulation: 'XLPE', size_mm2: 70,  voltage_kv: 33,  r_per_km: 0.3417,  x_per_km: 0.126, r0_per_km: 1.298, x0_per_km: 0.353, rated_amps: 220 },
  { id: 'cu_xlpe_95_33kv',  name: '95mm² Cu XLPE 33kV',   conductor: 'Cu', insulation: 'XLPE', size_mm2: 95,  voltage_kv: 33,  r_per_km: 0.2461,  x_per_km: 0.122, r0_per_km: 0.9346, x0_per_km: 0.342, rated_amps: 265 },
  { id: 'cu_xlpe_120_33kv', name: '120mm² Cu XLPE 33kV',  conductor: 'Cu', insulation: 'XLPE', size_mm2: 120, voltage_kv: 33,  r_per_km: 0.1951,  x_per_km: 0.119, r0_per_km: 0.7408, x0_per_km: 0.333, rated_amps: 300 },
  { id: 'cu_xlpe_150_33kv', name: '150mm² Cu XLPE 33kV',  conductor: 'Cu', insulation: 'XLPE', size_mm2: 150, voltage_kv: 33,  r_per_km: 0.1601,  x_per_km: 0.117, r0_per_km: 0.6084, x0_per_km: 0.328, rated_amps: 340 },
  { id: 'cu_xlpe_185_33kv', name: '185mm² Cu XLPE 33kV',  conductor: 'Cu', insulation: 'XLPE', size_mm2: 185, voltage_kv: 33,  r_per_km: 0.1289, x_per_km: 0.114, r0_per_km: 0.4898, x0_per_km: 0.319, rated_amps: 385 },
  { id: 'cu_xlpe_240_33kv', name: '240mm² Cu XLPE 33kV',  conductor: 'Cu', insulation: 'XLPE', size_mm2: 240, voltage_kv: 33,  r_per_km: 0.0994, x_per_km: 0.112, r0_per_km: 0.3777, x0_per_km: 0.314, rated_amps: 450 },
  { id: 'cu_xlpe_300_33kv', name: '300mm² Cu XLPE 33kV',  conductor: 'Cu', insulation: 'XLPE', size_mm2: 300, voltage_kv: 33,  r_per_km: 0.0807, x_per_km: 0.109, r0_per_km: 0.3067, x0_per_km: 0.305, rated_amps: 510 },
  { id: 'cu_xlpe_400_33kv', name: '400mm² Cu XLPE 33kV',  conductor: 'Cu', insulation: 'XLPE', size_mm2: 400, voltage_kv: 33,  r_per_km: 0.0649, x_per_km: 0.107, r0_per_km: 0.2466, x0_per_km: 0.300, rated_amps: 575 },
  // LV XLPE Aluminium (0.6/1kV) — r0: 3.4×r1, x0: 2.8×x1 per IEC 60502 (Al XLPE)
  { id: 'al_xlpe_16_lv',  name: '16mm² Al XLPE LV',   conductor: 'Al', insulation: 'XLPE', size_mm2: 16,  voltage_kv: 0.4, r_per_km: 2.449,   x_per_km: 0.082, r0_per_km: 8.325, x0_per_km: 0.230, rated_amps: 70  },
  { id: 'al_xlpe_25_lv',  name: '25mm² Al XLPE LV',   conductor: 'Al', insulation: 'XLPE', size_mm2: 25,  voltage_kv: 0.4, r_per_km: 1.538,   x_per_km: 0.079, r0_per_km: 5.231, x0_per_km: 0.221, rated_amps: 90  },
  { id: 'al_xlpe_35_lv',  name: '35mm² Al XLPE LV',   conductor: 'Al', insulation: 'XLPE', size_mm2: 35,  voltage_kv: 0.4, r_per_km: 1.113,  x_per_km: 0.077, r0_per_km: 3.783, x0_per_km: 0.216, rated_amps: 110 },
  { id: 'al_xlpe_50_lv',  name: '50mm² Al XLPE LV',   conductor: 'Al', insulation: 'XLPE', size_mm2: 50,  voltage_kv: 0.4, r_per_km: 0.8218,  x_per_km: 0.075, r0_per_km: 2.793, x0_per_km: 0.210, rated_amps: 130 },
  { id: 'al_xlpe_70_lv',  name: '70mm² Al XLPE LV',   conductor: 'Al', insulation: 'XLPE', size_mm2: 70,  voltage_kv: 0.4, r_per_km: 0.5679,  x_per_km: 0.073, r0_per_km: 1.931, x0_per_km: 0.204, rated_amps: 165 },
  { id: 'al_xlpe_95_lv',  name: '95mm² Al XLPE LV',   conductor: 'Al', insulation: 'XLPE', size_mm2: 95,  voltage_kv: 0.4, r_per_km: 0.4102,  x_per_km: 0.072, r0_per_km: 1.395, x0_per_km: 0.202, rated_amps: 200 },
  { id: 'al_xlpe_120_lv', name: '120mm² Al XLPE LV',  conductor: 'Al', insulation: 'XLPE', size_mm2: 120, voltage_kv: 0.4, r_per_km: 0.3243,  x_per_km: 0.071, r0_per_km: 1.103, x0_per_km: 0.199, rated_amps: 230 },
  { id: 'al_xlpe_150_lv', name: '150mm² Al XLPE LV',  conductor: 'Al', insulation: 'XLPE', size_mm2: 150, voltage_kv: 0.4, r_per_km: 0.2641,  x_per_km: 0.070, r0_per_km: 0.8974, x0_per_km: 0.196, rated_amps: 260 },
  { id: 'al_xlpe_185_lv', name: '185mm² Al XLPE LV',  conductor: 'Al', insulation: 'XLPE', size_mm2: 185, voltage_kv: 0.4, r_per_km: 0.2118,  x_per_km: 0.069, r0_per_km: 0.7201, x0_per_km: 0.193, rated_amps: 295 },
  { id: 'al_xlpe_240_lv', name: '240mm² Al XLPE LV',  conductor: 'Al', insulation: 'XLPE', size_mm2: 240, voltage_kv: 0.4, r_per_km: 0.1623,  x_per_km: 0.068, r0_per_km: 0.5518, x0_per_km: 0.190, rated_amps: 350 },
  { id: 'al_xlpe_300_lv', name: '300mm² Al XLPE LV',  conductor: 'Al', insulation: 'XLPE', size_mm2: 300, voltage_kv: 0.4, r_per_km: 0.1307,  x_per_km: 0.067, r0_per_km: 0.4444, x0_per_km: 0.188, rated_amps: 395 },
  // LV PVC Copper (0.6/1kV) — r0: 4.2×r1, x0: 3.2×x1 per IEC 60502 (Cu PVC)
  { id: 'cu_pvc_1.5_lv',  name: '1.5mm² Cu PVC LV',   conductor: 'Cu', insulation: 'PVC',  size_mm2: 1.5, voltage_kv: 0.4, r_per_km: 14.52,   x_per_km: 0.094, r0_per_km: 60.98, x0_per_km: 0.301, rated_amps: 18  },
  { id: 'cu_pvc_2.5_lv',  name: '2.5mm² Cu PVC LV',   conductor: 'Cu', insulation: 'PVC',  size_mm2: 2.5, voltage_kv: 0.4, r_per_km: 8.892,   x_per_km: 0.090, r0_per_km: 37.35, x0_per_km: 0.288, rated_amps: 25  },
  { id: 'cu_pvc_4_lv',    name: '4mm² Cu PVC LV',     conductor: 'Cu', insulation: 'PVC',  size_mm2: 4,   voltage_kv: 0.4, r_per_km: 5.532,   x_per_km: 0.087, r0_per_km: 23.23, x0_per_km: 0.278, rated_amps: 34  },
  { id: 'cu_pvc_6_lv',    name: '6mm² Cu PVC LV',     conductor: 'Cu', insulation: 'PVC',  size_mm2: 6,   voltage_kv: 0.4, r_per_km: 3.696,   x_per_km: 0.084, r0_per_km: 15.52, x0_per_km: 0.269, rated_amps: 43  },
  { id: 'cu_pvc_10_lv',   name: '10mm² Cu PVC LV',    conductor: 'Cu', insulation: 'PVC',  size_mm2: 10,  voltage_kv: 0.4, r_per_km: 2.196,   x_per_km: 0.080, r0_per_km: 9.223, x0_per_km: 0.256, rated_amps: 60  },
  { id: 'cu_pvc_16_lv',   name: '16mm² Cu PVC LV',    conductor: 'Cu', insulation: 'PVC',  size_mm2: 16,  voltage_kv: 0.4, r_per_km: 1.380,   x_per_km: 0.079, r0_per_km: 5.796, x0_per_km: 0.253, rated_amps: 80  },
  { id: 'cu_pvc_25_lv',   name: '25mm² Cu PVC LV',    conductor: 'Cu', insulation: 'PVC',  size_mm2: 25,  voltage_kv: 0.4, r_per_km: 0.8724,  x_per_km: 0.077, r0_per_km: 3.664, x0_per_km: 0.246, rated_amps: 101 },
  { id: 'cu_pvc_35_lv',   name: '35mm² Cu PVC LV',    conductor: 'Cu', insulation: 'PVC',  size_mm2: 35,  voltage_kv: 0.4, r_per_km: 0.6288,  x_per_km: 0.075, r0_per_km: 2.641, x0_per_km: 0.240, rated_amps: 125 },
  { id: 'cu_pvc_50_lv',   name: '50mm² Cu PVC LV',    conductor: 'Cu', insulation: 'PVC',  size_mm2: 50,  voltage_kv: 0.4, r_per_km: 0.4644,  x_per_km: 0.073, r0_per_km: 1.950, x0_per_km: 0.234, rated_amps: 151 },
  { id: 'cu_pvc_70_lv',   name: '70mm² Cu PVC LV',    conductor: 'Cu', insulation: 'PVC',  size_mm2: 70,  voltage_kv: 0.4, r_per_km: 0.3216,  x_per_km: 0.072, r0_per_km: 1.351, x0_per_km: 0.230, rated_amps: 192 },
  { id: 'cu_pvc_95_lv',   name: '95mm² Cu PVC LV',    conductor: 'Cu', insulation: 'PVC',  size_mm2: 95,  voltage_kv: 0.4, r_per_km: 0.2316,  x_per_km: 0.071, r0_per_km: 0.9732, x0_per_km: 0.227, rated_amps: 232 },
  { id: 'cu_pvc_120_lv',  name: '120mm² Cu PVC LV',   conductor: 'Cu', insulation: 'PVC',  size_mm2: 120, voltage_kv: 0.4, r_per_km: 0.1836,  x_per_km: 0.070, r0_per_km: 0.7716, x0_per_km: 0.224, rated_amps: 269 },
  { id: 'cu_pvc_150_lv',  name: '150mm² Cu PVC LV',   conductor: 'Cu', insulation: 'PVC',  size_mm2: 150, voltage_kv: 0.4, r_per_km: 0.1505,  x_per_km: 0.069, r0_per_km: 0.6321, x0_per_km: 0.221, rated_amps: 300 },
  { id: 'cu_pvc_185_lv',  name: '185mm² Cu PVC LV',   conductor: 'Cu', insulation: 'PVC',  size_mm2: 185, voltage_kv: 0.4, r_per_km: 0.1212, x_per_km: 0.068, r0_per_km: 0.509, x0_per_km: 0.218, rated_amps: 341 },
  { id: 'cu_pvc_240_lv',  name: '240mm² Cu PVC LV',   conductor: 'Cu', insulation: 'PVC',  size_mm2: 240, voltage_kv: 0.4, r_per_km: 0.0937, x_per_km: 0.067, r0_per_km: 0.3935, x0_per_km: 0.214, rated_amps: 400 },
  { id: 'cu_pvc_300_lv',  name: '300mm² Cu PVC LV',   conductor: 'Cu', insulation: 'PVC',  size_mm2: 300, voltage_kv: 0.4, r_per_km: 0.0762, x_per_km: 0.066, r0_per_km: 0.32, x0_per_km: 0.211, rated_amps: 458 },
];

// ─── Standard Overhead Line Conductor Library ───
// Bare overhead conductors selected by traditional codeword (ACSR / AAAC),
// used when a feeder's Feeder Type is set to "Overhead Line". Values are
// representative 50 Hz per-conductor figures at ~20 °C:
//   • r_per_km  — DC/AC positive-sequence resistance (Ω/km)
//   • x_per_km  — positive-sequence reactance at a typical MV flat/triangular
//                 spacing (Ω/km); higher than cables because of wide conductor
//                 spacing in air
//   • r0/x0     — zero-sequence with a lumped earth return (Carson): R0 ≈ R1+~0.15,
//                 X0 ≈ 3–3.5·X1 (no earth wire). Adjust for your tower geometry.
//   • rated_amps — steady-state thermal current in still air (~40 °C ambient,
//                 75 °C conductor). Not voltage-specific — selection does NOT
//                 overwrite the feeder voltage.
// Sources: BS 215 / IEC 61089 codeword conductors, typical utility datasheets.
const STANDARD_OVERHEAD_LINES = [
  { id: 'acsr_squirrel', name: 'ACSR Squirrel (20 mm²)', material: 'ACSR', size_mm2: 20,  r_per_km: 1.3740, x_per_km: 0.412, r0_per_km: 1.524, x0_per_km: 1.442, rated_amps: 107 },
  { id: 'acsr_gopher',   name: 'ACSR Gopher (26 mm²)',   material: 'ACSR', size_mm2: 26,  r_per_km: 1.0980, x_per_km: 0.400, r0_per_km: 1.248, x0_per_km: 1.400, rated_amps: 128 },
  { id: 'acsr_weasel',   name: 'ACSR Weasel (34 mm²)',   material: 'ACSR', size_mm2: 34,  r_per_km: 0.9116, x_per_km: 0.391, r0_per_km: 1.062, x0_per_km: 1.369, rated_amps: 150 },
  { id: 'acsr_ferret',   name: 'ACSR Ferret (42 mm²)',   material: 'ACSR', size_mm2: 42,  r_per_km: 0.6795, x_per_km: 0.383, r0_per_km: 0.830, x0_per_km: 1.341, rated_amps: 176 },
  { id: 'acsr_rabbit',   name: 'ACSR Rabbit (55 mm²)',   material: 'ACSR', size_mm2: 55,  r_per_km: 0.5449, x_per_km: 0.371, r0_per_km: 0.695, x0_per_km: 1.299, rated_amps: 208 },
  { id: 'acsr_mink',     name: 'ACSR Mink (65 mm²)',     material: 'ACSR', size_mm2: 65,  r_per_km: 0.4565, x_per_km: 0.366, r0_per_km: 0.607, x0_per_km: 1.281, rated_amps: 236 },
  { id: 'acsr_dog',      name: 'ACSR Dog (100 mm²)',     material: 'ACSR', size_mm2: 100, r_per_km: 0.2733, x_per_km: 0.350, r0_per_km: 0.424, x0_per_km: 1.225, rated_amps: 305 },
  { id: 'acsr_hare',     name: 'ACSR Hare (105 mm²)',    material: 'ACSR', size_mm2: 105, r_per_km: 0.2680, x_per_km: 0.348, r0_per_km: 0.419, x0_per_km: 1.218, rated_amps: 311 },
  { id: 'acsr_wolf',     name: 'ACSR Wolf (158 mm²)',    material: 'ACSR', size_mm2: 158, r_per_km: 0.1871, x_per_km: 0.331, r0_per_km: 0.334, x0_per_km: 1.159, rated_amps: 405 },
  { id: 'acsr_panther',  name: 'ACSR Panther (212 mm²)', material: 'ACSR', size_mm2: 212, r_per_km: 0.1390, x_per_km: 0.319, r0_per_km: 0.289, x0_per_km: 1.117, rated_amps: 480 },
  { id: 'acsr_lynx',     name: 'ACSR Lynx (226 mm²)',    material: 'ACSR', size_mm2: 226, r_per_km: 0.1441, x_per_km: 0.320, r0_per_km: 0.294, x0_per_km: 1.120, rated_amps: 490 },
  { id: 'acsr_zebra',    name: 'ACSR Zebra (428 mm²)',   material: 'ACSR', size_mm2: 428, r_per_km: 0.0674, x_per_km: 0.297, r0_per_km: 0.212, x0_per_km: 1.040, rated_amps: 730 },
  { id: 'aaac_50',       name: 'AAAC 50 mm²',            material: 'AAAC', size_mm2: 50,  r_per_km: 0.6752, x_per_km: 0.372, r0_per_km: 0.825, x0_per_km: 1.302, rated_amps: 196 },
  { id: 'aaac_100',      name: 'AAAC 100 mm²',           material: 'AAAC', size_mm2: 100, r_per_km: 0.3388, x_per_km: 0.351, r0_per_km: 0.489, x0_per_km: 1.229, rated_amps: 300 },
  { id: 'aaac_150',      name: 'AAAC 150 mm²',           material: 'AAAC', size_mm2: 150, r_per_km: 0.2222, x_per_km: 0.336, r0_per_km: 0.372, x0_per_km: 1.176, rated_amps: 385 },
  { id: 'aaac_200',      name: 'AAAC 200 mm²',           material: 'AAAC', size_mm2: 200, r_per_km: 0.1657, x_per_km: 0.325, r0_per_km: 0.316, x0_per_km: 1.138, rated_amps: 460 },
];

// ─── Standard Transformer Library ───
// Typical distribution & power transformers per IEC 60076 / SANS 780
const STANDARD_TRANSFORMERS = [
  // Distribution transformers (11/0.42 kV)
  { id: 'xfmr_16kva',    name: '16 kVA 11/0.42kV',     rated_mva: 0.016,  voltage_hv_kv: 11,  voltage_lv_kv: 0.42, z_percent: 4.0,  x_r_ratio: 1.5, vector_group: 'Dyn11' },
  { id: 'xfmr_25kva',    name: '25 kVA 11/0.42kV',     rated_mva: 0.025,  voltage_hv_kv: 11,  voltage_lv_kv: 0.42, z_percent: 4.0,  x_r_ratio: 1.8, vector_group: 'Dyn11' },
  { id: 'xfmr_50kva',    name: '50 kVA 11/0.42kV',     rated_mva: 0.05,   voltage_hv_kv: 11,  voltage_lv_kv: 0.42, z_percent: 4.0,  x_r_ratio: 2.0, vector_group: 'Dyn11' },
  { id: 'xfmr_100kva',   name: '100 kVA 11/0.42kV',    rated_mva: 0.1,    voltage_hv_kv: 11,  voltage_lv_kv: 0.42, z_percent: 4.0,  x_r_ratio: 3.0, vector_group: 'Dyn11' },
  { id: 'xfmr_200kva',   name: '200 kVA 11/0.42kV',    rated_mva: 0.2,    voltage_hv_kv: 11,  voltage_lv_kv: 0.42, z_percent: 4.0,  x_r_ratio: 4.0, vector_group: 'Dyn11' },
  { id: 'xfmr_315kva',   name: '315 kVA 11/0.42kV',    rated_mva: 0.315,  voltage_hv_kv: 11,  voltage_lv_kv: 0.42, z_percent: 4.0,  x_r_ratio: 5.0, vector_group: 'Dyn11' },
  { id: 'xfmr_500kva',   name: '500 kVA 11/0.42kV',    rated_mva: 0.5,    voltage_hv_kv: 11,  voltage_lv_kv: 0.42, z_percent: 4.5,  x_r_ratio: 6.0, vector_group: 'Dyn11' },
  { id: 'xfmr_750kva',   name: '750 kVA 11/0.42kV',    rated_mva: 0.75,   voltage_hv_kv: 11,  voltage_lv_kv: 0.42, z_percent: 5.0,  x_r_ratio: 7.0, vector_group: 'Dyn11' },
  { id: 'xfmr_1000kva',  name: '1000 kVA 11/0.42kV',   rated_mva: 1.0,    voltage_hv_kv: 11,  voltage_lv_kv: 0.42, z_percent: 5.0,  x_r_ratio: 8.0, vector_group: 'Dyn11' },
  { id: 'xfmr_1500kva',  name: '1500 kVA 11/0.42kV',   rated_mva: 1.5,    voltage_hv_kv: 11,  voltage_lv_kv: 0.42, z_percent: 5.75, x_r_ratio: 9.0, vector_group: 'Dyn11' },
  { id: 'xfmr_2000kva',  name: '2000 kVA 11/0.42kV',   rated_mva: 2.0,    voltage_hv_kv: 11,  voltage_lv_kv: 0.42, z_percent: 6.0,  x_r_ratio: 10,  vector_group: 'Dyn11' },
  // Medium voltage transformers (33/11 kV)
  { id: 'xfmr_3150kva',  name: '3.15 MVA 33/11kV',     rated_mva: 3.15,   voltage_hv_kv: 33,  voltage_lv_kv: 11,   z_percent: 7.0,  x_r_ratio: 10,  vector_group: 'Dyn11' },
  { id: 'xfmr_5mva',     name: '5 MVA 33/11kV',        rated_mva: 5,      voltage_hv_kv: 33,  voltage_lv_kv: 11,   z_percent: 7.5,  x_r_ratio: 12,  vector_group: 'Dyn11' },
  { id: 'xfmr_10mva',    name: '10 MVA 33/11kV',       rated_mva: 10,     voltage_hv_kv: 33,  voltage_lv_kv: 11,   z_percent: 8.0,  x_r_ratio: 15,  vector_group: 'Dyn11' },
  { id: 'xfmr_20mva',    name: '20 MVA 33/11kV',       rated_mva: 20,     voltage_hv_kv: 33,  voltage_lv_kv: 11,   z_percent: 10.0, x_r_ratio: 18,  vector_group: 'Dyn11' },
  // Power transformers (132/33 kV)
  // YNd11 units: the delta LV winding provides no 33 kV earth-fault source —
  // these assume a separate NECRT (neutral earthing compensator/resistor
  // transformer) earths the 33 kV network, per common utility practice.
  { id: 'xfmr_20mva_hv', name: '20 MVA 132/33kV',      rated_mva: 20,     voltage_hv_kv: 132, voltage_lv_kv: 33,   z_percent: 10.0, x_r_ratio: 20,  vector_group: 'YNd11' },
  { id: 'xfmr_40mva',    name: '40 MVA 132/33kV',      rated_mva: 40,     voltage_hv_kv: 132, voltage_lv_kv: 33,   z_percent: 12.5, x_r_ratio: 25,  vector_group: 'YNd11' },
  { id: 'xfmr_80mva',    name: '80 MVA 132/33kV',      rated_mva: 80,     voltage_hv_kv: 132, voltage_lv_kv: 33,   z_percent: 14.0, x_r_ratio: 30,  vector_group: 'YNd11' },
  // Power transformers (132/11 kV)
  { id: 'xfmr_10mva_132', name: '10 MVA 132/11kV',     rated_mva: 10,     voltage_hv_kv: 132, voltage_lv_kv: 11,   z_percent: 9.0,  x_r_ratio: 15,  vector_group: 'YNd11' },
  { id: 'xfmr_20mva_132', name: '20 MVA 132/11kV',     rated_mva: 20,     voltage_hv_kv: 132, voltage_lv_kv: 11,   z_percent: 10.0, x_r_ratio: 20,  vector_group: 'YNd11' },
];

// ─── NRS 034-1 / CTEF100 Load-Class Library (ADMD demand estimation) ───
// Residential consumer classes for After-Diversity Maximum Demand (ADMD)
// reticulation design. Herman-Beta parameters a=α, b=β, c=scaling; admd is the
// per-consumer After-Diversity Maximum Demand (kVA); mu/sigma are the Normal-
// approximation mean/std-dev currents (A). phase 1 = single-phase (per consumer),
// phase 3 = three-phase (parameters are per-phase). Editable via Settings and sent
// to the backend /api/analysis/admd engine as loadClassLib.
// Source: CTEF100 Appendix A1 (CoCT-modified NRS 034-1 Table 3, 15-year) and
// NRS 034-1 Table 3a reference values.
const STANDARD_LOAD_CLASSES = [
  // CTEF100 Appendix A1 (active default set)
  { id: 'informal',      label: 'Informal Settlement',      lsm: '3-4', a: 0.87, b: 4.61, c: 40, admd: 1.46, mu: 6.33,  sigma: 5.73,  phase: 1 },
  { id: 'township',      label: 'Township Area',            lsm: '5-6', a: 0.98, b: 2.41, c: 40, admd: 2.66, mu: 11.54, sigma: 8.65,  phase: 1 },
  { id: 'urban1',        label: 'Urban Residential I',      lsm: '7',   a: 1.22, b: 2.96, c: 60, admd: 4.04, mu: 17.48, sigma: 11.98, phase: 1 },
  { id: 'urban2',        label: 'Urban Residential II',     lsm: '8-9', a: 1.05, b: 1.70, c: 60, admd: 5.31, mu: 22.98, sigma: 15.06, phase: 1 },
  { id: 'upmarket1',     label: 'Urban Upmarket I',         lsm: '10',  a: 0.94, b: 1.25, c: 60, admd: 5.96, mu: 25.80, sigma: 16.64, phase: 1 },
  { id: 'upmarket1_3ph', label: 'Urban Upmarket I (3Φ)',    lsm: '10',  a: 0.54, b: 3.25, c: 60, admd: 1.99, mu: 8.60,  sigma: 9.61,  phase: 3 },
  { id: 'upmarket2_3ph', label: 'Urban Upmarket II (3Φ)',   lsm: '>10', a: 0.50, b: 2.12, c: 60, admd: 2.65, mu: 11.47, sigma: 12.39, phase: 3 },
  // NRS 034-1 Table 3a reference values
  { id: 'ruralSet',      label: 'Rural Settlement',         lsm: '1',   a: 0.35, b: 2.88, c: 20, admd: 0.50, mu: 2.17,  sigma: 3.03,  phase: 1 },
  { id: 'ruralVil',      label: 'Rural Village',            lsm: '1-2', a: 0.48, b: 2.13, c: 20, admd: 0.84, mu: 3.65,  sigma: 4.07,  phase: 1 },
  { id: 'urbanTwn_nrs',  label: 'Urban Townhouse Complex',  lsm: '8',   a: 1.42, b: 4.13, c: 80, admd: 4.70, mu: 20.43, sigma: 13.63, phase: 1 },
  { id: 'urbanEst_nrs',  label: 'Urban Multi-Storey/Estate',lsm: '8+',  a: 1.37, b: 3.39, c: 80, admd: 5.30, mu: 23.04, sigma: 15.09, phase: 1 },
];

// Diversity/unbalance correction-factor method names (Empirical method only).
// The actual DCF/UCF formulae live in the backend engine (admd.py).
const LOAD_CLASS_CORRECTIONS = ['AMEU', 'British', 'None'];
const ESTIMATION_METHODS = ['Empirical', 'Herman Beta'];

// ─── IEC 60364-5-52 Standards Database ───
// Reference installation methods per Table B.52.1
const IEC_INSTALLATION_METHODS = [
  { code: 'A1', description: 'Insulated conductors in conduit in thermally insulating wall', type: 'enclosed' },
  { code: 'A2', description: 'Multi-core cable in conduit in thermally insulating wall', type: 'enclosed' },
  { code: 'B1', description: 'Insulated conductors in conduit on wall or in trunking', type: 'enclosed' },
  { code: 'B2', description: 'Multi-core cable in conduit on wall or in trunking', type: 'enclosed' },
  { code: 'C',  description: 'Single-core or multi-core cable direct on wall (clipped)', type: 'open' },
  { code: 'D1', description: 'Multi-core cable in underground ducts', type: 'buried' },
  { code: 'D2', description: 'Multi-core cable direct buried', type: 'buried' },
  { code: 'E',  description: 'Single-core cables in free air on perforated tray (touching)', type: 'open' },
  { code: 'F',  description: 'Single-core cables in free air on tray (spaced)', type: 'open' },
  { code: 'G',  description: 'Single-core cables in free air spaced from wall (cleats)', type: 'open' },
];

// Base current-carrying capacity (Amps) per IEC 60364-5-52 Table B.52.2–B.52.5
// 3-phase circuits, PVC and XLPE insulation, 2 loaded conductors (single-phase) or 3 loaded (3-phase)
// Reference conditions: 30°C ambient air, 20°C ground, 2.5 K·m/W soil resistivity
// Format: { size_mm2: { method: { pvc_cu, xlpe_cu, pvc_al, xlpe_al } } }
const IEC_AMPACITY_TABLE = {
  1.5:   { A1: { pvc_cu: 14.5, xlpe_cu: 19.5, pvc_al: null,  xlpe_al: null  }, B1: { pvc_cu: 17.5, xlpe_cu: 23,   pvc_al: null,  xlpe_al: null  }, C: { pvc_cu: 22,   xlpe_cu: 26,   pvc_al: null,  xlpe_al: null  } },
  2.5:   { A1: { pvc_cu: 19.5, xlpe_cu: 27,   pvc_al: null,  xlpe_al: null  }, B1: { pvc_cu: 24,   xlpe_cu: 31,   pvc_al: null,  xlpe_al: null  }, C: { pvc_cu: 30,   xlpe_cu: 36,   pvc_al: null,  xlpe_al: null  } },
  4:     { A1: { pvc_cu: 26,   xlpe_cu: 36,   pvc_al: null,  xlpe_al: null  }, B1: { pvc_cu: 32,   xlpe_cu: 42,   pvc_al: null,  xlpe_al: null  }, C: { pvc_cu: 40,   xlpe_cu: 49,   pvc_al: null,  xlpe_al: null  } },
  6:     { A1: { pvc_cu: 34,   xlpe_cu: 46,   pvc_al: null,  xlpe_al: null  }, B1: { pvc_cu: 41,   xlpe_cu: 54,   pvc_al: null,  xlpe_al: null  }, C: { pvc_cu: 51,   xlpe_cu: 63,   pvc_al: null,  xlpe_al: null  } },
  10:    { A1: { pvc_cu: 46,   xlpe_cu: 63,   pvc_al: null,  xlpe_al: null  }, B1: { pvc_cu: 57,   xlpe_cu: 75,   pvc_al: null,  xlpe_al: null  }, C: { pvc_cu: 70,   xlpe_cu: 86,   pvc_al: null,  xlpe_al: null  } },
  16:    { A1: { pvc_cu: 61,   xlpe_cu: 85,   pvc_al: 47,    xlpe_al: 65    }, B1: { pvc_cu: 76,   xlpe_cu: 100,  pvc_al: 57,    xlpe_al: 76    }, C: { pvc_cu: 94,   xlpe_cu: 115,  pvc_al: 71,    xlpe_al: 88    }, D1: { pvc_cu: 80,  xlpe_cu: 95,  pvc_al: 62,  xlpe_al: 73 }, D2: { pvc_cu: 87,  xlpe_cu: 102, pvc_al: 67,  xlpe_al: 78 } },
  25:    { A1: { pvc_cu: 80,   xlpe_cu: 112,  pvc_al: 62,    xlpe_al: 86    }, B1: { pvc_cu: 101,  xlpe_cu: 133,  pvc_al: 78,    xlpe_al: 101   }, C: { pvc_cu: 124,  xlpe_cu: 150,  pvc_al: 95,    xlpe_al: 116   }, D1: { pvc_cu: 106, xlpe_cu: 121, pvc_al: 81,  xlpe_al: 93 }, D2: { pvc_cu: 114, xlpe_cu: 131, pvc_al: 87,  xlpe_al: 100 }, E: { pvc_cu: 131, xlpe_cu: 161, pvc_al: 100, xlpe_al: 123 }, F: { pvc_cu: 146, xlpe_cu: 182, pvc_al: 112, xlpe_al: 140 } },
  35:    { A1: { pvc_cu: 99,   xlpe_cu: 138,  pvc_al: 77,    xlpe_al: 107   }, B1: { pvc_cu: 125,  xlpe_cu: 164,  pvc_al: 96,    xlpe_al: 125   }, C: { pvc_cu: 154,  xlpe_cu: 185,  pvc_al: 118,   xlpe_al: 142   }, D1: { pvc_cu: 131, xlpe_cu: 146, pvc_al: 100, xlpe_al: 113 }, D2: { pvc_cu: 138, xlpe_cu: 157, pvc_al: 107, xlpe_al: 121 }, E: { pvc_cu: 162, xlpe_cu: 200, pvc_al: 124, xlpe_al: 153 }, F: { pvc_cu: 181, xlpe_cu: 226, pvc_al: 139, xlpe_al: 174 } },
  50:    { A1: { pvc_cu: 119,  xlpe_cu: 168,  pvc_al: 93,    xlpe_al: 130   }, B1: { pvc_cu: 151,  xlpe_cu: 198,  pvc_al: 117,   xlpe_al: 151   }, C: { pvc_cu: 188,  xlpe_cu: 225,  pvc_al: 144,   xlpe_al: 173   }, D1: { pvc_cu: 153, xlpe_cu: 173, pvc_al: 118, xlpe_al: 133 }, D2: { pvc_cu: 161, xlpe_cu: 185, pvc_al: 124, xlpe_al: 142 }, E: { pvc_cu: 196, xlpe_cu: 242, pvc_al: 150, xlpe_al: 186 }, F: { pvc_cu: 219, xlpe_cu: 275, pvc_al: 168, xlpe_al: 212 } },
  70:    { A1: { pvc_cu: 151,  xlpe_cu: 213,  pvc_al: 118,   xlpe_al: 165   }, B1: { pvc_cu: 192,  xlpe_cu: 253,  pvc_al: 149,   xlpe_al: 192   }, C: { pvc_cu: 238,  xlpe_cu: 283,  pvc_al: 183,   xlpe_al: 218   }, D1: { pvc_cu: 188, xlpe_cu: 210, pvc_al: 144, xlpe_al: 162 }, D2: { pvc_cu: 197, xlpe_cu: 225, pvc_al: 152, xlpe_al: 173 }, E: { pvc_cu: 251, xlpe_cu: 310, pvc_al: 192, xlpe_al: 237 }, F: { pvc_cu: 281, xlpe_cu: 353, pvc_al: 216, xlpe_al: 272 } },
  95:    { A1: { pvc_cu: 182,  xlpe_cu: 258,  pvc_al: 142,   xlpe_al: 200   }, B1: { pvc_cu: 232,  xlpe_cu: 306,  pvc_al: 179,   xlpe_al: 233   }, C: { pvc_cu: 289,  xlpe_cu: 344,  pvc_al: 222,   xlpe_al: 265   }, D1: { pvc_cu: 222, xlpe_cu: 249, pvc_al: 171, xlpe_al: 191 }, D2: { pvc_cu: 236, xlpe_cu: 268, pvc_al: 182, xlpe_al: 207 }, E: { pvc_cu: 304, xlpe_cu: 377, pvc_al: 233, xlpe_al: 289 }, F: { pvc_cu: 341, xlpe_cu: 430, pvc_al: 261, xlpe_al: 331 } },
  120:   { A1: { pvc_cu: 210,  xlpe_cu: 299,  pvc_al: 164,   xlpe_al: 232   }, B1: { pvc_cu: 269,  xlpe_cu: 354,  pvc_al: 206,   xlpe_al: 270   }, C: { pvc_cu: 337,  xlpe_cu: 400,  pvc_al: 259,   xlpe_al: 308   }, D1: { pvc_cu: 251, xlpe_cu: 283, pvc_al: 194, xlpe_al: 218 }, D2: { pvc_cu: 270, xlpe_cu: 306, pvc_al: 208, xlpe_al: 236 }, E: { pvc_cu: 352, xlpe_cu: 437, pvc_al: 269, xlpe_al: 335 }, F: { pvc_cu: 396, xlpe_cu: 500, pvc_al: 304, xlpe_al: 385 } },
  150:   { A1: { pvc_cu: 240,  xlpe_cu: 344,  pvc_al: 189,   xlpe_al: 265   }, B1: { pvc_cu: 309,  xlpe_cu: 407,  pvc_al: 236,   xlpe_al: 310   }, C: { pvc_cu: 388,  xlpe_cu: 459,  pvc_al: 299,   xlpe_al: 354   }, D1: { pvc_cu: 278, xlpe_cu: 316, pvc_al: 215, xlpe_al: 244 }, D2: { pvc_cu: 300, xlpe_cu: 343, pvc_al: 232, xlpe_al: 265 }, E: { pvc_cu: 406, xlpe_cu: 504, pvc_al: 311, xlpe_al: 386 }, F: { pvc_cu: 456, xlpe_cu: 577, pvc_al: 351, xlpe_al: 444 } },
  185:   { A1: { pvc_cu: 274,  xlpe_cu: 392,  pvc_al: 215,   xlpe_al: 304   }, B1: { pvc_cu: 353,  xlpe_cu: 464,  pvc_al: 271,   xlpe_al: 354   }, C: { pvc_cu: 447,  xlpe_cu: 527,  pvc_al: 344,   xlpe_al: 407   }, D1: { pvc_cu: 310, xlpe_cu: 352, pvc_al: 239, xlpe_al: 272 }, D2: { pvc_cu: 337, xlpe_cu: 384, pvc_al: 260, xlpe_al: 296 }, E: { pvc_cu: 467, xlpe_cu: 581, pvc_al: 358, xlpe_al: 446 }, F: { pvc_cu: 526, xlpe_cu: 668, pvc_al: 404, xlpe_al: 515 } },
  240:   { A1: { pvc_cu: 321,  xlpe_cu: 461,  pvc_al: 252,   xlpe_al: 358   }, B1: { pvc_cu: 415,  xlpe_cu: 546,  pvc_al: 319,   xlpe_al: 418   }, C: { pvc_cu: 530,  xlpe_cu: 621,  pvc_al: 408,   xlpe_al: 480   }, D1: { pvc_cu: 355, xlpe_cu: 406, pvc_al: 274, xlpe_al: 314 }, D2: { pvc_cu: 388, xlpe_cu: 442, pvc_al: 300, xlpe_al: 342 }, E: { pvc_cu: 553, xlpe_cu: 689, pvc_al: 424, xlpe_al: 529 }, F: { pvc_cu: 625, xlpe_cu: 795, pvc_al: 481, xlpe_al: 613 } },
  300:   { A1: { pvc_cu: 367,  xlpe_cu: 530,  pvc_al: 287,   xlpe_al: 411   }, B1: { pvc_cu: 475,  xlpe_cu: 629,  pvc_al: 365,   xlpe_al: 481   }, C: { pvc_cu: 610,  xlpe_cu: 715,  pvc_al: 470,   xlpe_al: 553   }, D1: { pvc_cu: 397, xlpe_cu: 456, pvc_al: 307, xlpe_al: 353 }, D2: { pvc_cu: 435, xlpe_cu: 498, pvc_al: 336, xlpe_al: 385 }, E: { pvc_cu: 637, xlpe_cu: 795, pvc_al: 488, xlpe_al: 611 }, F: { pvc_cu: 720, xlpe_cu: 920, pvc_al: 554, xlpe_al: 710 } },
  400:   { A1: { pvc_cu: 438,  xlpe_cu: 634,  pvc_al: 344,   xlpe_al: 492   }, B1: { pvc_cu: 571,  xlpe_cu: 754,  pvc_al: 438,   xlpe_al: 578   }, C: { pvc_cu: 739,  xlpe_cu: 860,  pvc_al: 570,   xlpe_al: 665   }, E: { pvc_cu: 772, xlpe_cu: 964, pvc_al: 591, xlpe_al: 741 }, F: { pvc_cu: 878, xlpe_cu: 1122, pvc_al: 676, xlpe_al: 866 } },
};

// Ambient temperature correction factors — IEC 60364-5-52 Table B.52.14/15
// Reference ambient: 30°C for air, 20°C for ground
const IEC_TEMP_CORRECTION = {
  air: {
    pvc:  { 10: 1.22, 15: 1.17, 20: 1.12, 25: 1.06, 30: 1.00, 35: 0.94, 40: 0.87, 45: 0.79, 50: 0.71, 55: 0.61, 60: 0.50 },
    xlpe: { 10: 1.15, 15: 1.12, 20: 1.08, 25: 1.04, 30: 1.00, 35: 0.96, 40: 0.91, 45: 0.87, 50: 0.82, 55: 0.76, 60: 0.71, 65: 0.65, 70: 0.58, 75: 0.50, 80: 0.41 },
  },
  ground: {
    pvc:  { 10: 1.10, 15: 1.05, 20: 1.00, 25: 0.95, 30: 0.89, 35: 0.84, 40: 0.77, 45: 0.71, 50: 0.63, 55: 0.55, 60: 0.45 },
    xlpe: { 10: 1.07, 15: 1.04, 20: 1.00, 25: 0.96, 30: 0.93, 35: 0.89, 40: 0.85, 45: 0.80, 50: 0.76, 55: 0.71, 60: 0.65, 65: 0.60, 70: 0.53, 75: 0.46, 80: 0.38 },
  },
};

// Grouping correction factors — IEC 60364-5-52 Table B.52.17
// Bunched cables or cables in conduits (touching, single layer)
// Key = number of circuits/multi-core cables, value = correction factor
const IEC_GROUPING_FACTORS = {
  bunched: { 1: 1.00, 2: 0.80, 3: 0.70, 4: 0.65, 5: 0.60, 6: 0.57, 7: 0.54, 8: 0.52, 9: 0.50, 10: 0.48, 12: 0.45, 14: 0.43, 16: 0.41, 18: 0.39, 20: 0.38 },
  single_layer_wall:  { 1: 1.00, 2: 0.85, 3: 0.79, 4: 0.75, 5: 0.73, 6: 0.72, 7: 0.72, 8: 0.71, 9: 0.70 },
  single_layer_floor: { 1: 1.00, 2: 0.88, 3: 0.82, 4: 0.77, 5: 0.75, 6: 0.73, 7: 0.73, 8: 0.72, 9: 0.72 },
  single_layer_tray_touching: { 1: 1.00, 2: 0.87, 3: 0.82, 4: 0.80, 5: 0.80, 6: 0.79, 7: 0.79, 8: 0.78, 9: 0.78 },
  single_layer_tray_spaced:   { 1: 1.00, 2: 0.89, 3: 0.81, 4: 0.76, 5: 0.73, 6: 0.72, 7: 0.72, 8: 0.71, 9: 0.70 },
  trefoil_tray_touching:      { 1: 1.00, 2: 0.81, 3: 0.72, 4: 0.68, 5: 0.66, 6: 0.64, 7: 0.63, 8: 0.62, 9: 0.61 },
};

// Soil thermal resistivity correction — IEC 60364-5-52 Table B.52.16
// Reference: 2.5 K·m/W
const IEC_SOIL_RESISTIVITY_FACTORS = {
  0.5: 1.28,
  0.7: 1.20,
  1.0: 1.18,
  1.5: 1.10,
  2.0: 1.05,
  2.5: 1.00,
  3.0: 0.96,
};

// Depth of laying correction factors — IEC 60364-5-52 Table B.52.18
// Reference depth: 0.7m
const IEC_DEPTH_FACTORS = {
  0.5: 1.02,
  0.6: 1.01,
  0.7: 1.00,
  0.8: 0.99,
  1.0: 0.97,
  1.2: 0.95,
  1.5: 0.93,
};

// ─── NEC Article 310 Ampacity Tables ─────────────────────────────────────────

// NEC Article 310.16 — Allowable Ampacities of Insulated Conductors
// Rated Up to and Including 2000 Volts, 60°C Through 90°C
// Not More Than 3 Current-Carrying Conductors in Raceway, Cable, or Earth
// Based on Ambient Temperature of 30°C (86°F)
// Columns: 60°C (TW, UF) | 75°C (RHW, THHW, THW, THWN, XHHW, USE, ZW) | 90°C (THHN, THHW, THW-2, THWN-2, USE-2, XHH, XHHW, XHHW-2, ZW-2)
const NEC_310_AMPACITY_TABLE = {
  // AWG/kcmil: { cu_60: A, cu_75: A, cu_90: A, al_60: A, al_75: A, al_90: A }
  '14':   { cu_60: 15,  cu_75: 20,  cu_90: 25,  al_60: null, al_75: null, al_90: null },
  '12':   { cu_60: 20,  cu_75: 25,  cu_90: 30,  al_60: 15,   al_75: 20,   al_90: 25 },
  '10':   { cu_60: 30,  cu_75: 35,  cu_90: 40,  al_60: 25,   al_75: 30,   al_90: 35 },
  '8':    { cu_60: 40,  cu_75: 50,  cu_90: 55,  al_60: 35,   al_75: 40,   al_90: 45 },
  '6':    { cu_60: 55,  cu_75: 65,  cu_90: 75,  al_60: 40,   al_75: 50,   al_90: 55 },
  '4':    { cu_60: 70,  cu_75: 85,  cu_90: 95,  al_60: 55,   al_75: 65,   al_90: 75 },
  '3':    { cu_60: 85,  cu_75: 100, cu_90: 115, al_60: 65,   al_75: 75,   al_90: 85 },
  '2':    { cu_60: 95,  cu_75: 115, cu_90: 130, al_60: 75,   al_75: 90,   al_90: 100 },
  '1':    { cu_60: 110, cu_75: 130, cu_90: 145, al_60: 85,   al_75: 100,  al_90: 115 },
  '1/0':  { cu_60: 125, cu_75: 150, cu_90: 170, al_60: 100,  al_75: 120,  al_90: 135 },
  '2/0':  { cu_60: 145, cu_75: 175, cu_90: 195, al_60: 115,  al_75: 135,  al_90: 150 },
  '3/0':  { cu_60: 165, cu_75: 200, cu_90: 225, al_60: 130,  al_75: 155,  al_90: 175 },
  '4/0':  { cu_60: 195, cu_75: 230, cu_90: 260, al_60: 150,  al_75: 180,  al_90: 205 },
  '250':  { cu_60: 215, cu_75: 255, cu_90: 290, al_60: 170,  al_75: 205,  al_90: 230 },
  '300':  { cu_60: 240, cu_75: 285, cu_90: 320, al_60: 190,  al_75: 230,  al_90: 255 },
  '350':  { cu_60: 260, cu_75: 310, cu_90: 350, al_60: 210,  al_75: 250,  al_90: 280 },
  '400':  { cu_60: 280, cu_75: 335, cu_90: 380, al_60: 225,  al_75: 270,  al_90: 305 },
  '500':  { cu_60: 320, cu_75: 380, cu_90: 430, al_60: 260,  al_75: 310,  al_90: 350 },
  '600':  { cu_60: 355, cu_75: 420, cu_90: 475, al_60: 285,  al_75: 340,  al_90: 385 },
  '700':  { cu_60: 385, cu_75: 460, cu_90: 520, al_60: 310,  al_75: 375,  al_90: 420 },
  '750':  { cu_60: 400, cu_75: 475, cu_90: 535, al_60: 320,  al_75: 385,  al_90: 435 },
  '800':  { cu_60: 410, cu_75: 490, cu_90: 555, al_60: 330,  al_75: 395,  al_90: 450 },
  '900':  { cu_60: 435, cu_75: 520, cu_90: 585, al_60: 355,  al_75: 425,  al_90: 480 },
  '1000': { cu_60: 455, cu_75: 545, cu_90: 615, al_60: 375,  al_75: 445,  al_90: 500 },
};

// NEC Table 310.15(B)(1) — Ambient Temperature Correction Factors
const NEC_TEMP_CORRECTION = {
  // ambient_temp_c: { '60C': factor, '75C': factor, '90C': factor }
  21: { '60C': 1.08, '75C': 1.04, '90C': 1.04 },
  26: { '60C': 1.00, '75C': 1.00, '90C': 1.00 },
  30: { '60C': 1.00, '75C': 1.00, '90C': 1.00 },
  31: { '60C': 0.91, '75C': 0.94, '90C': 0.96 },
  36: { '60C': 0.91, '75C': 0.94, '90C': 0.96 },
  40: { '60C': 0.82, '75C': 0.88, '90C': 0.91 },
  41: { '60C': 0.82, '75C': 0.88, '90C': 0.91 },
  45: { '60C': 0.71, '75C': 0.82, '90C': 0.87 },
  46: { '60C': 0.71, '75C': 0.82, '90C': 0.87 },
  50: { '60C': 0.58, '75C': 0.75, '90C': 0.82 },
  51: { '60C': 0.58, '75C': 0.75, '90C': 0.82 },
  55: { '60C': 0.41, '75C': 0.67, '90C': 0.76 },
  60: { '60C': null, '75C': 0.58, '90C': 0.71 },
  65: { '60C': null, '75C': 0.47, '90C': 0.65 },
  70: { '60C': null, '75C': 0.33, '90C': 0.58 },
  75: { '60C': null, '75C': null, '90C': 0.50 },
  80: { '60C': null, '75C': null, '90C': 0.41 },
};

// NEC Table 310.15(C)(1) — Conduit Fill Adjustment Factors
const NEC_CONDUIT_FILL_FACTORS = {
  1: 1.00,
  2: 1.00,
  3: 1.00,
  4: 0.80,
  5: 0.80,
  6: 0.80,
  7: 0.70,
  8: 0.70,
  9: 0.70,
  10: 0.50,
  11: 0.50,
  20: 0.50,
  21: 0.45,
  30: 0.45,
  31: 0.40,
  40: 0.40,
};

// AWG/kcmil to mm² cross-reference for NEC ↔ IEC conversion
const AWG_TO_MM2 = {
  '14': 2.08, '12': 3.31, '10': 5.26, '8': 8.37, '6': 13.3,
  '4': 21.2, '3': 26.7, '2': 33.6, '1': 42.4,
  '1/0': 53.5, '2/0': 67.4, '3/0': 85.0, '4/0': 107.2,
  '250': 127, '300': 152, '350': 177, '400': 203,
  '500': 253, '600': 304, '700': 355, '750': 380,
  '800': 405, '900': 456, '1000': 507,
};

// IEC 60909 Voltage Factors — Table 1
const IEC_60909_VOLTAGE_FACTORS = {
  lv:  { cmax: 1.05, cmin: 0.95, description: 'Low voltage (≤ 1 kV)' },
  mv:  { cmax: 1.10, cmin: 1.00, description: 'Medium voltage (1–35 kV)' },
  hv:  { cmax: 1.10, cmin: 1.00, description: 'High voltage (> 35 kV)' },
};

// Standard cable sizes (mm²) per IEC
const IEC_STANDARD_SIZES = [1.5, 2.5, 4, 6, 10, 16, 25, 35, 50, 70, 95, 120, 150, 185, 240, 300, 400];

// ─── IDMT Relay Curve Parameters ───
// IEC 60255 inverse-time curves: t = TDS * (k / (M^a - 1)) + c
// IEEE C37.112 curves: t = TDS * (A / (M^p - 1) + B)
// Definite Time: t = TDS (fixed delay for all currents above pickup)
// Where M = I/Ipickup (current multiple)
const IDMT_CURVES = {
  'IEC Standard Inverse':     { std: 'IEC', k: 0.14,   a: 0.02,  c: 0 },
  'IEC Very Inverse':         { std: 'IEC', k: 13.5,   a: 1.0,   c: 0 },
  'IEC Extremely Inverse':    { std: 'IEC', k: 80.0,   a: 2.0,   c: 0 },
  'IEC Long Time Inverse':    { std: 'IEC', k: 120.0,  a: 1.0,   c: 0 },
  'IEEE Moderately Inverse':  { std: 'IEEE', A: 0.0515, p: 0.02,  B: 0.114 },
  'IEEE Very Inverse':        { std: 'IEEE', A: 19.61,  p: 2.0,   B: 0.491 },
  'IEEE Extremely Inverse':   { std: 'IEEE', A: 28.2,   p: 2.0,   B: 0.1217 },
  'Definite Time':            { std: 'DT' },
};

// Calculate relay trip time for a given current multiple M and TDS
function idmtTripTime(curveName, M, TDS) {
  if (M <= 1) return Infinity;
  const c = IDMT_CURVES[curveName];
  if (!c) return Infinity;
  if (c.std === 'DT') {
    return TDS; // Definite time: time_dial is the fixed operate delay in seconds
  } else if (c.std === 'IEC') {
    return TDS * (c.k / (Math.pow(M, c.a) - 1) + c.c);
  } else {
    return TDS * (c.A / (Math.pow(M, c.p) - 1) + c.B);
  }
}

// ─── CT Saturation Model ───
// Models the effect of CT core saturation on the effective current seen by relays.
// Based on IEC 61869-2 accuracy limit factor (ALF) and knee-point voltage.
//
// When the CT saturates, the secondary waveform is clipped, reducing the RMS
// current the relay actually measures.  This increases relay operating time.

/**
 * Parse a CT ratio string like "400/5" → { primary: 400, secondary: 5, ratio: 80 }
 */
function parseCTRatio(ratioStr) {
  if (!ratioStr || typeof ratioStr !== 'string') return { primary: 400, secondary: 5, ratio: 80 };
  const parts = ratioStr.split('/').map(Number);
  if (parts.length === 2 && parts[0] > 0 && parts[1] > 0) {
    return { primary: parts[0], secondary: parts[1], ratio: parts[0] / parts[1] };
  }
  return { primary: 400, secondary: 5, ratio: 80 };
}

/**
 * Parse IEC 61869-2 accuracy class like "5P20" → ALF = 20
 * Format: <error%>P<ALF> (e.g. 5P20, 10P10, 5P30)
 */
function parseCTAccuracyALF(accuracyClass) {
  if (!accuracyClass || typeof accuracyClass !== 'string') return 20;
  const m = accuracyClass.match(/(\d+)P(\d+)/i);
  return m ? parseInt(m[2]) : 20;
}

/**
 * Calculate CT saturation parameters.
 * @param {object} ctProps - CT component props (ratio, accuracy_class, burden_va, knee_point_v, rct_ohm)
 * @returns {object} { ratio, iSatPrimary, kneePointV, rctOhm, burdenOhm, alf }
 */
function ctSaturationParams(ctProps) {
  const ct = parseCTRatio(ctProps.ratio);
  const alf = parseCTAccuracyALF(ctProps.accuracy_class);
  const burdenVA = parseFloat(ctProps.burden_va) || 15;
  const iSecRated = ct.secondary; // Rated secondary current (5A or 1A)
  // [PS-16] Rct defaults to a typical secondary-winding resistance for the
  // rated secondary (≈0.3 Ω for 5 A cores, ≈3 Ω for 1 A cores) instead of 0 —
  // a zero Rct overstates the saturation-free current whenever the burden is
  // small and the user supplies an explicit knee voltage.
  const rctOhm = parseFloat(ctProps.rct_ohm) || (iSecRated <= 1 ? 3.0 : 0.3);

  // Burden in ohms: Z_burden = VA / I²
  const burdenOhm = burdenVA / (iSecRated * iSecRated);

  // Knee point voltage (user override or derived from the accuracy class).
  // [PS-16] The ALF defines the ACCURACY-LIMIT voltage
  //   V_AL = ALF × I_sn × (Rct + R_burden)  [IEC 61869-2],
  // and the knee (IEC 10%-exciting-current point) of a 5P/10P protection
  // core sits below it: Vk ≈ 0.8·V_AL is the standard approximation. The
  // previous model used V_AL itself as the knee, delaying the modelled
  // saturation onset ~25% (optimistic for close-in faults). NOTE: the
  // clipping model below stays symmetric — DC offset and remanence (the
  // dominant saturation drivers at high X/R) are not modelled, so onset is
  // still somewhat optimistic for fully-offset asymmetric faults.
  let kneePointV = parseFloat(ctProps.knee_point_v);
  if (!kneePointV || kneePointV <= 0) {
    kneePointV = 0.8 * alf * iSecRated * (rctOhm + burdenOhm);
  }

  // Primary current at which CT begins to saturate
  // I_sat_sec = Vk / (Rct + R_burden)
  const totalZ = rctOhm + burdenOhm;
  const iSatSecondary = totalZ > 0 ? kneePointV / totalZ : Infinity;
  const iSatPrimary = iSatSecondary * ct.ratio;

  return { ratio: ct.ratio, primary: ct.primary, secondary: ct.secondary,
           iSatPrimary, kneePointV, rctOhm, burdenOhm, alf, totalZ };
}

/**
 * Calculate effective primary current accounting for CT saturation.
 * Below saturation knee point: I_eff = I_primary (no effect).
 * Above: waveform clipping reduces effective RMS current.
 *
 * Uses saturation angle model:
 *   Ks = Vk / (I_sec_ideal × Z_total)
 *   θ  = arccos(1 - 2·Ks)
 *   η  = √((θ - sin(2θ)/2) / π)
 *   I_eff = I_primary × η
 *
 * @param {number} iPrimary - Actual primary fault current (A)
 * @param {object} satParams - From ctSaturationParams()
 * @returns {number} Effective current the relay measures (primary A)
 */
function ctEffectiveCurrent(iPrimary, satParams) {
  if (!satParams || satParams.iSatPrimary === Infinity) return iPrimary;
  if (iPrimary <= satParams.iSatPrimary) return iPrimary;

  // Ideal secondary current
  const iSecIdeal = iPrimary / satParams.ratio;
  // Saturation factor
  const ks = satParams.kneePointV / (iSecIdeal * satParams.totalZ);
  if (ks >= 1) return iPrimary; // shouldn't happen but guard

  // Saturation angle (portion of cycle the CT is not saturated)
  const theta = Math.acos(1 - 2 * ks);
  // RMS reduction factor
  const eta = Math.sqrt((theta - Math.sin(2 * theta) / 2) / Math.PI);

  return iPrimary * Math.max(eta, 0.05); // floor at 5% to avoid zero
}

// ─── Distance Relay (21) Trip Time ───
// Converts impedance zones to equivalent current thresholds and returns
// the trip time for a given fault current.
// Zone reach (ohms) → pickup current: I = V_LL / (√3 × Z_reach)
// The relay trips at the fastest matching zone delay.
function distanceRelayTripTime(zones, currentA) {
  // zones: [{ reach_ohm, delay_s, pickup_a (pre-computed) }, ...]
  // Returns trip time for the fault current, or Infinity if below all zones
  let bestTime = Infinity;
  for (const z of zones) {
    if (currentA >= z.pickup_a) {
      bestTime = Math.min(bestTime, z.delay_s);
    }
  }
  return bestTime;
}

// Build zone array from distance relay component props
function buildDistanceRelayZones(props) {
  const vkv = props.voltage_kv || 11;
  const vLL = vkv * 1000; // Line-to-line voltage in V
  const zones = [];
  const zoneDefs = [
    { reach: props.z1_reach_ohm, delay: props.z1_delay_s, name: 'Z1' },
    { reach: props.z2_reach_ohm, delay: props.z2_delay_s, name: 'Z2' },
    { reach: props.z3_reach_ohm, delay: props.z3_delay_s, name: 'Z3' },
  ];
  for (const zd of zoneDefs) {
    if (zd.reach > 0) {
      // I = V_phase / Z = (V_LL / √3) / Z_reach
      const pickup_a = vLL / (Math.sqrt(3) * zd.reach);
      zones.push({
        name: zd.name,
        reach_ohm: zd.reach,
        delay_s: zd.delay != null ? zd.delay : 0,
        pickup_a,
      });
    }
  }
  // Sort by pickup current descending (smallest impedance = highest current = innermost zone first)
  zones.sort((a, b) => b.pickup_a - a.pickup_a);
  return zones;
}

// ─── IEC 60269 Fuse Curves (gG General Purpose) ───
// Pre-arcing (minimum melting) time-current points: [current_A, time_s].
//
// One generic gG characteristic shape scaled per rating (I/In multiples):
//   1.6→600s  2→100s  2.5→30s  3.15→8s  5→1.5s  6.3→0.5s
//   8→0.1s    10→0.04s  16→0.01s  25→0.004s
// The fast end is anchored so the pre-arcing time reaches 0.1 s at 8×In,
// satisfying the IEC 60269-1 0.1 s pre-arcing gate (e.g. a 100 A gG link
// clears in ≤0.1 s by its ~820 A gate current). The previous shape only
// reached 0.1 s near 10×In and interpolated ~0.17 s at the gate.
// NOTE: this is a single representative family, not the per-rating min/max
// gate corridor of IEC 60269-1 Table 4; use manufacturer data for precise
// grading. Currents are R10 standard values (= multiple × In rounded).
// Mirrored VERBATIM in backend/analysis/arcflash.py `_FUSE_CURVES_GG`.
const FUSE_CURVES_GG = {
  16:  [[25,600],[32,100],[40,30],[50,8],[80,1.5],[100,0.5],[125,0.1],[160,0.04],[250,0.01],[400,0.004]],
  20:  [[32,600],[40,100],[50,30],[63,8],[100,1.5],[125,0.5],[160,0.1],[200,0.04],[315,0.01],[500,0.004]],
  25:  [[40,600],[50,100],[63,30],[80,8],[125,1.5],[160,0.5],[200,0.1],[250,0.04],[400,0.01],[630,0.004]],
  32:  [[50,600],[63,100],[80,30],[100,8],[160,1.5],[200,0.5],[250,0.1],[315,0.04],[500,0.01],[800,0.004]],
  40:  [[63,600],[80,100],[100,30],[125,8],[200,1.5],[250,0.5],[315,0.1],[400,0.04],[630,0.01],[1000,0.004]],
  50:  [[80,600],[100,100],[125,30],[160,8],[250,1.5],[315,0.5],[400,0.1],[500,0.04],[800,0.01],[1250,0.004]],
  63:  [[100,600],[125,100],[160,30],[200,8],[315,1.5],[400,0.5],[500,0.1],[630,0.04],[1000,0.01],[1600,0.004]],
  80:  [[125,600],[160,100],[200,30],[250,8],[400,1.5],[500,0.5],[630,0.1],[800,0.04],[1250,0.01],[2000,0.004]],
  100: [[160,600],[200,100],[250,30],[315,8],[500,1.5],[630,0.5],[800,0.1],[1000,0.04],[1600,0.01],[2500,0.004]],
  125: [[200,600],[250,100],[315,30],[400,8],[630,1.5],[800,0.5],[1000,0.1],[1250,0.04],[2000,0.01],[3150,0.004]],
  160: [[250,600],[315,100],[400,30],[500,8],[800,1.5],[1000,0.5],[1250,0.1],[1600,0.04],[2500,0.01],[4000,0.004]],
  200: [[315,600],[400,100],[500,30],[630,8],[1000,1.5],[1250,0.5],[1600,0.1],[2000,0.04],[3150,0.01],[5000,0.004]],
  250: [[400,600],[500,100],[630,30],[800,8],[1250,1.5],[1600,0.5],[2000,0.1],[2500,0.04],[4000,0.01],[6300,0.004]],
  315: [[500,600],[630,100],[800,30],[1000,8],[1600,1.5],[2000,0.5],[2500,0.1],[3150,0.04],[5000,0.01],[8000,0.004]],
  400: [[630,600],[800,100],[1000,30],[1250,8],[2000,1.5],[2500,0.5],[3150,0.1],[4000,0.04],[6300,0.01],[10000,0.004]],
  500: [[800,600],[1000,100],[1250,30],[1600,8],[2500,1.5],[3150,0.5],[4000,0.1],[5000,0.04],[8000,0.01],[12500,0.004]],
  630: [[1000,600],[1250,100],[1600,30],[2000,8],[3150,1.5],[4000,0.5],[5000,0.1],[6300,0.04],[10000,0.01],[16000,0.004]],
};

// Get the gG pre-arcing curve points for an arbitrary rating.
// Ratings without a tabulated curve are ratio-scaled from the nearest standard
// curve (the table itself is one characteristic shape scaled per rating, so
// scaling is consistent with its construction). Returns null if rating invalid.
function fuseCurvePoints(ratingA) {
  if (FUSE_CURVES_GG[ratingA]) return FUSE_CURVES_GG[ratingA];
  if (!(ratingA > 0)) return null;
  let best = null;
  let bestDist = Infinity;
  for (const r of FUSE_RATINGS_GG) {
    const dist = Math.abs(Math.log(r / ratingA));
    if (dist < bestDist) { bestDist = dist; best = r; }
  }
  if (!best) return null;
  const scale = ratingA / best;
  return FUSE_CURVES_GG[best].map(([i, t]) => [i * scale, t]);
}

// Get fuse pre-arcing (melting) time by log-log interpolation of the characteristic points
function fuseTripTime(ratingA, currentA) {
  const points = fuseCurvePoints(ratingA);
  if (!points) return null;
  if (currentA <= points[0][0]) return Infinity; // Below minimum operating current
  if (currentA >= points[points.length - 1][0]) return points[points.length - 1][1];

  // Log-log interpolation
  for (let i = 0; i < points.length - 1; i++) {
    const [i1, t1] = points[i];
    const [i2, t2] = points[i + 1];
    if (currentA >= i1 && currentA <= i2) {
      const logI = Math.log10(currentA);
      const logI1 = Math.log10(i1);
      const logI2 = Math.log10(i2);
      const logT1 = Math.log10(t1);
      const logT2 = Math.log10(t2);
      const frac = (logI - logI1) / (logI2 - logI1);
      return Math.pow(10, logT1 + frac * (logT2 - logT1));
    }
  }
  return points[points.length - 1][1];
}

const FUSE_RATINGS_GG = [16, 20, 25, 32, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630];

// ─── Circuit Breaker Trip Curves (IEC 60947-2 / IEC 60898) ───
// Thermal-magnetic characteristics for MCB, MCCB and ACB
//
// MCB:  thermal (I²t inverse-time) region + fixed magnetic instantaneous,
//       magnetic pickup set by the IEC 60898-1 curve class (B/C/D)
// MCCB: thermal (I²t inverse-time) region + fixed magnetic instantaneous
// ACB:  long-time (thermal) + optional short-time + instantaneous
//
// Thermal region model: t = k / ((I/Ir)^2 - 1)
// where k = long_time_delay class factor, Ir = trip_rating × thermal_pickup
// Magnetic region: fixed trip time (typically 20ms for MCCB, configurable for ACB)

const CB_TRIP_CLASSES = {
  // Long-time delay band factors emulating generic electronic-trip-unit LTD bands.
  // t = k / (M² − 1), calibrated so t(6×Ir) = class seconds → k = class × (6² − 1) = class × 35.
  // Note: these are NOT the IEC 60947-4-1 motor-starter trip classes; they are
  // representative LTD time bands (class = seconds at 6× pickup).
  // Higher k = slower thermal trip at same overload.
  5:   { k: 175 },
  10:  { k: 350 },
  20:  { k: 700 },
  30:  { k: 1050 },
};

/**
 * Calculate CB trip time for a given current.
 * @param {object} params - { cb_type, trip_rating_a, thermal_pickup, magnetic_pickup,
 *                            long_time_delay, short_time_pickup, short_time_delay, instantaneous_pickup }
 * @param {number} currentA - Fault/overload current in amps
 * @returns {number} Trip time in seconds, or Infinity if below pickup
 */
function cbTripTime(params, currentA) {
  const Ir = (params.trip_rating_a || 630) * (params.thermal_pickup || 1.0);
  const Im = Ir * (params.magnetic_pickup || 10);  // Magnetic pickup in amps
  const M = currentA / Ir;  // Current as multiple of thermal pickup

  if (M <= 1.0) return Infinity;  // Below thermal pickup — no trip

  const cbType = params.cb_type || 'mccb';

  // ACB with short-time and instantaneous regions
  if (cbType === 'acb') {
    const stPickup = (params.short_time_pickup || 0) * Ir;
    const stDelay = params.short_time_delay || 0.1;
    const instPickup = (params.instantaneous_pickup || 0) * Ir;

    // Instantaneous region (highest priority)
    if (instPickup > 0 && currentA >= instPickup) {
      return 0.02;  // 20ms instantaneous
    }
    // Short-time region
    if (stPickup > 0 && currentA >= stPickup) {
      return stDelay;  // Fixed short-time delay
    }
  }

  // MCCB magnetic instantaneous
  if (currentA >= Im) {
    return 0.02;  // 20ms magnetic trip
  }

  // Thermal (long-time) region: I²t inverse-time characteristic
  const ltClass = params.long_time_delay || 10;
  const classData = CB_TRIP_CLASSES[ltClass] || CB_TRIP_CLASSES[10];
  const k = classData.k;
  const t = k / (M * M - 1);

  // Clamp to reasonable range
  return Math.min(t, 10000);
}

// IEC 60898-1 MCB instantaneous (magnetic) bands: B = 3–5×In, C = 5–10×In,
// D = 10–20×In. The single-line curve model uses the TOP of the band —
// conservative when checking that a fault level reaches the instantaneous
// region (the device is only guaranteed to trip magnetically above it).
const MCB_CURVE_MAGNETIC = { B: 5, C: 10, D: 20 };

// Typical inertia constant H (seconds, on the machine MVA base) per prime-mover
// type — used to auto-populate a generator's `inertia_h_s` when the Prime Mover
// selector changes. Mid-range representative values: reciprocating sets have the
// lowest stored energy, large steam turbo-sets the highest.
// Sources: IEEE Std 3002.3 / Kundur "Power System Stability and Control" §3.9.
// 'other' is intentionally absent — an unknown prime mover leaves H untouched.
const PRIME_MOVER_INERTIA_H = {
  diesel: 1.5,
  gas_engine: 1.0,
  gas_turbine: 4.0,
  steam_turbine: 6.0,
  hydro: 3.0,
  wind: 3.0,
};

// ─── PV Module Library ───
// Typical STC datasheet values for common module classes; voltages/currents
// per module, temperature coefficients in %/°C (negative = falls with heat).
// Used by the Solar PV array mode for string sizing per IEC 62548.
const PV_PANELS = [
  { id: 'pv_330_poly',  name: '330 W Poly 72-cell',     w: 330, voc: 45.9, vmp: 37.8,  isc: 9.15, imp: 8.73,  beta_voc: -0.29, gamma_vmp: -0.37 },
  { id: 'pv_450_mono',  name: '450 W Mono PERC',        w: 450, voc: 41.5, vmp: 34.5,  isc: 13.9, imp: 13.05, beta_voc: -0.27, gamma_vmp: -0.35 },
  { id: 'pv_550_mono',  name: '550 W Mono PERC',        w: 550, voc: 49.9, vmp: 41.95, isc: 14.0, imp: 13.12, beta_voc: -0.26, gamma_vmp: -0.34 },
  { id: 'pv_600_ntype', name: '600 W N-type Bifacial',  w: 600, voc: 45.6, vmp: 38.0,  isc: 16.7, imp: 15.8,  beta_voc: -0.25, gamma_vmp: -0.30 },
];

// Standard MCCB frame sizes for the custom device dropdown
const CB_FRAME_SIZES = [16, 20, 25, 32, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 630, 800, 1000, 1250, 1600, 2000, 2500, 3200, 4000, 5000, 6300];

// ─── Standard Circuit Breaker Library ───
// Typical MCCB/ACB ratings per IEC 60947-2
const STANDARD_CBS = [
  // MCB — Low Voltage (IEC 60898-1 / SANS 156). Icn 6 kA up to 63 A,
  // 10 kA for the 80–125 A frames; magnetic pickup = top of the curve band.
  { id: 'mcb_b6',    name: 'MCB 6A (B)',    cb_type: 'mcb', mcb_curve: 'B', trip_rating_a: 6,   frame_a: 63,  rated_voltage_kv: 0.4, breaking_ka: 6,  thermal_pickup: 1.0, magnetic_pickup: 5,  long_time_delay: 10 },
  { id: 'mcb_b10',   name: 'MCB 10A (B)',   cb_type: 'mcb', mcb_curve: 'B', trip_rating_a: 10,  frame_a: 63,  rated_voltage_kv: 0.4, breaking_ka: 6,  thermal_pickup: 1.0, magnetic_pickup: 5,  long_time_delay: 10 },
  { id: 'mcb_b16',   name: 'MCB 16A (B)',   cb_type: 'mcb', mcb_curve: 'B', trip_rating_a: 16,  frame_a: 63,  rated_voltage_kv: 0.4, breaking_ka: 6,  thermal_pickup: 1.0, magnetic_pickup: 5,  long_time_delay: 10 },
  { id: 'mcb_b20',   name: 'MCB 20A (B)',   cb_type: 'mcb', mcb_curve: 'B', trip_rating_a: 20,  frame_a: 63,  rated_voltage_kv: 0.4, breaking_ka: 6,  thermal_pickup: 1.0, magnetic_pickup: 5,  long_time_delay: 10 },
  { id: 'mcb_b25',   name: 'MCB 25A (B)',   cb_type: 'mcb', mcb_curve: 'B', trip_rating_a: 25,  frame_a: 63,  rated_voltage_kv: 0.4, breaking_ka: 6,  thermal_pickup: 1.0, magnetic_pickup: 5,  long_time_delay: 10 },
  { id: 'mcb_b32',   name: 'MCB 32A (B)',   cb_type: 'mcb', mcb_curve: 'B', trip_rating_a: 32,  frame_a: 63,  rated_voltage_kv: 0.4, breaking_ka: 6,  thermal_pickup: 1.0, magnetic_pickup: 5,  long_time_delay: 10 },
  { id: 'mcb_b40',   name: 'MCB 40A (B)',   cb_type: 'mcb', mcb_curve: 'B', trip_rating_a: 40,  frame_a: 63,  rated_voltage_kv: 0.4, breaking_ka: 6,  thermal_pickup: 1.0, magnetic_pickup: 5,  long_time_delay: 10 },
  { id: 'mcb_b63',   name: 'MCB 63A (B)',   cb_type: 'mcb', mcb_curve: 'B', trip_rating_a: 63,  frame_a: 63,  rated_voltage_kv: 0.4, breaking_ka: 6,  thermal_pickup: 1.0, magnetic_pickup: 5,  long_time_delay: 10 },
  { id: 'mcb_c6',    name: 'MCB 6A (C)',    cb_type: 'mcb', mcb_curve: 'C', trip_rating_a: 6,   frame_a: 63,  rated_voltage_kv: 0.4, breaking_ka: 6,  thermal_pickup: 1.0, magnetic_pickup: 10, long_time_delay: 10 },
  { id: 'mcb_c10',   name: 'MCB 10A (C)',   cb_type: 'mcb', mcb_curve: 'C', trip_rating_a: 10,  frame_a: 63,  rated_voltage_kv: 0.4, breaking_ka: 6,  thermal_pickup: 1.0, magnetic_pickup: 10, long_time_delay: 10 },
  { id: 'mcb_c16',   name: 'MCB 16A (C)',   cb_type: 'mcb', mcb_curve: 'C', trip_rating_a: 16,  frame_a: 63,  rated_voltage_kv: 0.4, breaking_ka: 6,  thermal_pickup: 1.0, magnetic_pickup: 10, long_time_delay: 10 },
  { id: 'mcb_c20',   name: 'MCB 20A (C)',   cb_type: 'mcb', mcb_curve: 'C', trip_rating_a: 20,  frame_a: 63,  rated_voltage_kv: 0.4, breaking_ka: 6,  thermal_pickup: 1.0, magnetic_pickup: 10, long_time_delay: 10 },
  { id: 'mcb_c25',   name: 'MCB 25A (C)',   cb_type: 'mcb', mcb_curve: 'C', trip_rating_a: 25,  frame_a: 63,  rated_voltage_kv: 0.4, breaking_ka: 6,  thermal_pickup: 1.0, magnetic_pickup: 10, long_time_delay: 10 },
  { id: 'mcb_c32',   name: 'MCB 32A (C)',   cb_type: 'mcb', mcb_curve: 'C', trip_rating_a: 32,  frame_a: 63,  rated_voltage_kv: 0.4, breaking_ka: 6,  thermal_pickup: 1.0, magnetic_pickup: 10, long_time_delay: 10 },
  { id: 'mcb_c40',   name: 'MCB 40A (C)',   cb_type: 'mcb', mcb_curve: 'C', trip_rating_a: 40,  frame_a: 63,  rated_voltage_kv: 0.4, breaking_ka: 6,  thermal_pickup: 1.0, magnetic_pickup: 10, long_time_delay: 10 },
  { id: 'mcb_c50',   name: 'MCB 50A (C)',   cb_type: 'mcb', mcb_curve: 'C', trip_rating_a: 50,  frame_a: 63,  rated_voltage_kv: 0.4, breaking_ka: 6,  thermal_pickup: 1.0, magnetic_pickup: 10, long_time_delay: 10 },
  { id: 'mcb_c63',   name: 'MCB 63A (C)',   cb_type: 'mcb', mcb_curve: 'C', trip_rating_a: 63,  frame_a: 63,  rated_voltage_kv: 0.4, breaking_ka: 6,  thermal_pickup: 1.0, magnetic_pickup: 10, long_time_delay: 10 },
  { id: 'mcb_c80',   name: 'MCB 80A (C)',   cb_type: 'mcb', mcb_curve: 'C', trip_rating_a: 80,  frame_a: 125, rated_voltage_kv: 0.4, breaking_ka: 10, thermal_pickup: 1.0, magnetic_pickup: 10, long_time_delay: 10 },
  { id: 'mcb_c100',  name: 'MCB 100A (C)',  cb_type: 'mcb', mcb_curve: 'C', trip_rating_a: 100, frame_a: 125, rated_voltage_kv: 0.4, breaking_ka: 10, thermal_pickup: 1.0, magnetic_pickup: 10, long_time_delay: 10 },
  { id: 'mcb_c125',  name: 'MCB 125A (C)',  cb_type: 'mcb', mcb_curve: 'C', trip_rating_a: 125, frame_a: 125, rated_voltage_kv: 0.4, breaking_ka: 10, thermal_pickup: 1.0, magnetic_pickup: 10, long_time_delay: 10 },
  { id: 'mcb_d16',   name: 'MCB 16A (D)',   cb_type: 'mcb', mcb_curve: 'D', trip_rating_a: 16,  frame_a: 63,  rated_voltage_kv: 0.4, breaking_ka: 6,  thermal_pickup: 1.0, magnetic_pickup: 20, long_time_delay: 10 },
  { id: 'mcb_d25',   name: 'MCB 25A (D)',   cb_type: 'mcb', mcb_curve: 'D', trip_rating_a: 25,  frame_a: 63,  rated_voltage_kv: 0.4, breaking_ka: 6,  thermal_pickup: 1.0, magnetic_pickup: 20, long_time_delay: 10 },
  { id: 'mcb_d32',   name: 'MCB 32A (D)',   cb_type: 'mcb', mcb_curve: 'D', trip_rating_a: 32,  frame_a: 63,  rated_voltage_kv: 0.4, breaking_ka: 6,  thermal_pickup: 1.0, magnetic_pickup: 20, long_time_delay: 10 },
  { id: 'mcb_d40',   name: 'MCB 40A (D)',   cb_type: 'mcb', mcb_curve: 'D', trip_rating_a: 40,  frame_a: 63,  rated_voltage_kv: 0.4, breaking_ka: 6,  thermal_pickup: 1.0, magnetic_pickup: 20, long_time_delay: 10 },
  { id: 'mcb_d63',   name: 'MCB 63A (D)',   cb_type: 'mcb', mcb_curve: 'D', trip_rating_a: 63,  frame_a: 63,  rated_voltage_kv: 0.4, breaking_ka: 6,  thermal_pickup: 1.0, magnetic_pickup: 20, long_time_delay: 10 },
  // MCCB — Low Voltage (IEC 60947-2)
  { id: 'mccb_16a',   name: 'MCCB 16A',    cb_type: 'mccb', trip_rating_a: 16,   frame_a: 100,  rated_voltage_kv: 0.4, breaking_ka: 25,  thermal_pickup: 1.0, magnetic_pickup: 10, long_time_delay: 10 },
  { id: 'mccb_25a',   name: 'MCCB 25A',    cb_type: 'mccb', trip_rating_a: 25,   frame_a: 100,  rated_voltage_kv: 0.4, breaking_ka: 25,  thermal_pickup: 1.0, magnetic_pickup: 10, long_time_delay: 10 },
  { id: 'mccb_32a',   name: 'MCCB 32A',    cb_type: 'mccb', trip_rating_a: 32,   frame_a: 100,  rated_voltage_kv: 0.4, breaking_ka: 25,  thermal_pickup: 1.0, magnetic_pickup: 10, long_time_delay: 10 },
  { id: 'mccb_40a',   name: 'MCCB 40A',    cb_type: 'mccb', trip_rating_a: 40,   frame_a: 100,  rated_voltage_kv: 0.4, breaking_ka: 25,  thermal_pickup: 1.0, magnetic_pickup: 10, long_time_delay: 10 },
  { id: 'mccb_50a',   name: 'MCCB 50A',    cb_type: 'mccb', trip_rating_a: 50,   frame_a: 100,  rated_voltage_kv: 0.4, breaking_ka: 25,  thermal_pickup: 1.0, magnetic_pickup: 10, long_time_delay: 10 },
  { id: 'mccb_63a',   name: 'MCCB 63A',    cb_type: 'mccb', trip_rating_a: 63,   frame_a: 100,  rated_voltage_kv: 0.4, breaking_ka: 25,  thermal_pickup: 1.0, magnetic_pickup: 10, long_time_delay: 10 },
  { id: 'mccb_80a',   name: 'MCCB 80A',    cb_type: 'mccb', trip_rating_a: 80,   frame_a: 100,  rated_voltage_kv: 0.4, breaking_ka: 25,  thermal_pickup: 1.0, magnetic_pickup: 10, long_time_delay: 10 },
  { id: 'mccb_100a',  name: 'MCCB 100A',   cb_type: 'mccb', trip_rating_a: 100,  frame_a: 100,  rated_voltage_kv: 0.4, breaking_ka: 25,  thermal_pickup: 1.0, magnetic_pickup: 10, long_time_delay: 10 },
  { id: 'mccb_125a',  name: 'MCCB 125A',   cb_type: 'mccb', trip_rating_a: 125,  frame_a: 160,  rated_voltage_kv: 0.4, breaking_ka: 36,  thermal_pickup: 1.0, magnetic_pickup: 10, long_time_delay: 10 },
  { id: 'mccb_160a',  name: 'MCCB 160A',   cb_type: 'mccb', trip_rating_a: 160,  frame_a: 160,  rated_voltage_kv: 0.4, breaking_ka: 36,  thermal_pickup: 1.0, magnetic_pickup: 10, long_time_delay: 10 },
  { id: 'mccb_200a',  name: 'MCCB 200A',   cb_type: 'mccb', trip_rating_a: 200,  frame_a: 250,  rated_voltage_kv: 0.4, breaking_ka: 36,  thermal_pickup: 1.0, magnetic_pickup: 10, long_time_delay: 10 },
  { id: 'mccb_250a',  name: 'MCCB 250A',   cb_type: 'mccb', trip_rating_a: 250,  frame_a: 250,  rated_voltage_kv: 0.4, breaking_ka: 36,  thermal_pickup: 1.0, magnetic_pickup: 10, long_time_delay: 10 },
  { id: 'mccb_315a',  name: 'MCCB 315A',   cb_type: 'mccb', trip_rating_a: 315,  frame_a: 400,  rated_voltage_kv: 0.4, breaking_ka: 50,  thermal_pickup: 1.0, magnetic_pickup: 10, long_time_delay: 10 },
  { id: 'mccb_400a',  name: 'MCCB 400A',   cb_type: 'mccb', trip_rating_a: 400,  frame_a: 400,  rated_voltage_kv: 0.4, breaking_ka: 50,  thermal_pickup: 1.0, magnetic_pickup: 10, long_time_delay: 10 },
  { id: 'mccb_630a',  name: 'MCCB 630A',   cb_type: 'mccb', trip_rating_a: 630,  frame_a: 630,  rated_voltage_kv: 0.4, breaking_ka: 50,  thermal_pickup: 1.0, magnetic_pickup: 10, long_time_delay: 10 },
  { id: 'mccb_800a',  name: 'MCCB 800A',   cb_type: 'mccb', trip_rating_a: 800,  frame_a: 800,  rated_voltage_kv: 0.4, breaking_ka: 65,  thermal_pickup: 1.0, magnetic_pickup: 10, long_time_delay: 10 },
  // ACB — Low Voltage (IEC 60947-2)
  { id: 'acb_630a',   name: 'ACB 630A',    cb_type: 'acb',  trip_rating_a: 630,  frame_a: 630,  rated_voltage_kv: 0.4, breaking_ka: 65,  thermal_pickup: 1.0, magnetic_pickup: 10, long_time_delay: 10, short_time_pickup: 6,  short_time_delay: 0.1, instantaneous_pickup: 12 },
  { id: 'acb_800a',   name: 'ACB 800A',    cb_type: 'acb',  trip_rating_a: 800,  frame_a: 800,  rated_voltage_kv: 0.4, breaking_ka: 65,  thermal_pickup: 1.0, magnetic_pickup: 10, long_time_delay: 10, short_time_pickup: 6,  short_time_delay: 0.1, instantaneous_pickup: 12 },
  { id: 'acb_1000a',  name: 'ACB 1000A',   cb_type: 'acb',  trip_rating_a: 1000, frame_a: 1000, rated_voltage_kv: 0.4, breaking_ka: 65,  thermal_pickup: 1.0, magnetic_pickup: 10, long_time_delay: 10, short_time_pickup: 6,  short_time_delay: 0.1, instantaneous_pickup: 12 },
  { id: 'acb_1250a',  name: 'ACB 1250A',   cb_type: 'acb',  trip_rating_a: 1250, frame_a: 1250, rated_voltage_kv: 0.4, breaking_ka: 65,  thermal_pickup: 1.0, magnetic_pickup: 10, long_time_delay: 10, short_time_pickup: 6,  short_time_delay: 0.1, instantaneous_pickup: 12 },
  { id: 'acb_1600a',  name: 'ACB 1600A',   cb_type: 'acb',  trip_rating_a: 1600, frame_a: 1600, rated_voltage_kv: 0.4, breaking_ka: 85,  thermal_pickup: 1.0, magnetic_pickup: 10, long_time_delay: 10, short_time_pickup: 6,  short_time_delay: 0.1, instantaneous_pickup: 12 },
  { id: 'acb_2000a',  name: 'ACB 2000A',   cb_type: 'acb',  trip_rating_a: 2000, frame_a: 2000, rated_voltage_kv: 0.4, breaking_ka: 85,  thermal_pickup: 1.0, magnetic_pickup: 10, long_time_delay: 10, short_time_pickup: 6,  short_time_delay: 0.1, instantaneous_pickup: 12 },
  { id: 'acb_2500a',  name: 'ACB 2500A',   cb_type: 'acb',  trip_rating_a: 2500, frame_a: 2500, rated_voltage_kv: 0.4, breaking_ka: 100, thermal_pickup: 1.0, magnetic_pickup: 10, long_time_delay: 10, short_time_pickup: 6,  short_time_delay: 0.1, instantaneous_pickup: 12 },
  { id: 'acb_3200a',  name: 'ACB 3200A',   cb_type: 'acb',  trip_rating_a: 3200, frame_a: 3200, rated_voltage_kv: 0.4, breaking_ka: 100, thermal_pickup: 1.0, magnetic_pickup: 10, long_time_delay: 10, short_time_pickup: 6,  short_time_delay: 0.1, instantaneous_pickup: 12 },
  { id: 'acb_4000a',  name: 'ACB 4000A',   cb_type: 'acb',  trip_rating_a: 4000, frame_a: 4000, rated_voltage_kv: 0.4, breaking_ka: 100, thermal_pickup: 1.0, magnetic_pickup: 10, long_time_delay: 10, short_time_pickup: 6,  short_time_delay: 0.15, instantaneous_pickup: 15 },
  // MV Vacuum Breakers (IEC 62271-100) — MCCBs are LV devices (IEC 60947-2);
  // at 11 kV vacuum/SF6 breakers are used. cb_type stays 'mccb' so the
  // existing thermal-magnetic curve model is retained (ids kept for saved projects).
  { id: 'mccb_200a_11kv', name: 'VCB 200A 11kV', cb_type: 'mccb', trip_rating_a: 200,  frame_a: 200,  rated_voltage_kv: 11,  breaking_ka: 25,  thermal_pickup: 1.0, magnetic_pickup: 10, long_time_delay: 10 },
  { id: 'mccb_400a_11kv', name: 'VCB 400A 11kV', cb_type: 'mccb', trip_rating_a: 400,  frame_a: 400,  rated_voltage_kv: 11,  breaking_ka: 25,  thermal_pickup: 1.0, magnetic_pickup: 10, long_time_delay: 10 },
  { id: 'mccb_630a_11kv', name: 'VCB 630A 11kV', cb_type: 'mccb', trip_rating_a: 630,  frame_a: 630,  rated_voltage_kv: 11,  breaking_ka: 25,  thermal_pickup: 1.0, magnetic_pickup: 10, long_time_delay: 10 },
];

// ─── Standard Fuse Library ───
// Typical gG fuse-link ratings per IEC 60269
const STANDARD_FUSES = [
  // LV gG fuses (IEC 60269-2)
  { id: 'gg_6a',    name: 'gG 6A',     fuse_type: 'gG', rated_current_a: 6,    rated_voltage_kv: 0.4, breaking_ka: 80  },
  { id: 'gg_10a',   name: 'gG 10A',    fuse_type: 'gG', rated_current_a: 10,   rated_voltage_kv: 0.4, breaking_ka: 80  },
  { id: 'gg_16a',   name: 'gG 16A',    fuse_type: 'gG', rated_current_a: 16,   rated_voltage_kv: 0.4, breaking_ka: 80  },
  { id: 'gg_20a',   name: 'gG 20A',    fuse_type: 'gG', rated_current_a: 20,   rated_voltage_kv: 0.4, breaking_ka: 80  },
  { id: 'gg_25a',   name: 'gG 25A',    fuse_type: 'gG', rated_current_a: 25,   rated_voltage_kv: 0.4, breaking_ka: 80  },
  { id: 'gg_32a',   name: 'gG 32A',    fuse_type: 'gG', rated_current_a: 32,   rated_voltage_kv: 0.4, breaking_ka: 80  },
  { id: 'gg_40a',   name: 'gG 40A',    fuse_type: 'gG', rated_current_a: 40,   rated_voltage_kv: 0.4, breaking_ka: 80  },
  { id: 'gg_50a',   name: 'gG 50A',    fuse_type: 'gG', rated_current_a: 50,   rated_voltage_kv: 0.4, breaking_ka: 80  },
  { id: 'gg_63a',   name: 'gG 63A',    fuse_type: 'gG', rated_current_a: 63,   rated_voltage_kv: 0.4, breaking_ka: 80  },
  { id: 'gg_80a',   name: 'gG 80A',    fuse_type: 'gG', rated_current_a: 80,   rated_voltage_kv: 0.4, breaking_ka: 80  },
  { id: 'gg_100a',  name: 'gG 100A',   fuse_type: 'gG', rated_current_a: 100,  rated_voltage_kv: 0.4, breaking_ka: 80  },
  { id: 'gg_125a',  name: 'gG 125A',   fuse_type: 'gG', rated_current_a: 125,  rated_voltage_kv: 0.4, breaking_ka: 80  },
  { id: 'gg_160a',  name: 'gG 160A',   fuse_type: 'gG', rated_current_a: 160,  rated_voltage_kv: 0.4, breaking_ka: 80  },
  { id: 'gg_200a',  name: 'gG 200A',   fuse_type: 'gG', rated_current_a: 200,  rated_voltage_kv: 0.4, breaking_ka: 80  },
  { id: 'gg_250a',  name: 'gG 250A',   fuse_type: 'gG', rated_current_a: 250,  rated_voltage_kv: 0.4, breaking_ka: 80  },
  { id: 'gg_315a',  name: 'gG 315A',   fuse_type: 'gG', rated_current_a: 315,  rated_voltage_kv: 0.4, breaking_ka: 80  },
  { id: 'gg_400a',  name: 'gG 400A',   fuse_type: 'gG', rated_current_a: 400,  rated_voltage_kv: 0.4, breaking_ka: 80  },
  { id: 'gg_500a',  name: 'gG 500A',   fuse_type: 'gG', rated_current_a: 500,  rated_voltage_kv: 0.4, breaking_ka: 80  },
  { id: 'gg_630a',  name: 'gG 630A',   fuse_type: 'gG', rated_current_a: 630,  rated_voltage_kv: 0.4, breaking_ka: 80  },
  // MV fuses (IEC 60282-1) — MV current-limiting fuses are class "back-up"
  // per IEC 60282-1, not gG (an LV IEC 60269 class). fuse_type stays 'gG' so
  // the existing curve model is retained (ids kept for saved projects).
  { id: 'gg_6.3a_11kv',  name: 'MV Back-up 6.3A 11kV',  fuse_type: 'gG', rated_current_a: 6.3,  rated_voltage_kv: 11, breaking_ka: 50 },
  { id: 'gg_10a_11kv',   name: 'MV Back-up 10A 11kV',   fuse_type: 'gG', rated_current_a: 10,   rated_voltage_kv: 11, breaking_ka: 50 },
  { id: 'gg_16a_11kv',   name: 'MV Back-up 16A 11kV',   fuse_type: 'gG', rated_current_a: 16,   rated_voltage_kv: 11, breaking_ka: 50 },
  { id: 'gg_25a_11kv',   name: 'MV Back-up 25A 11kV',   fuse_type: 'gG', rated_current_a: 25,   rated_voltage_kv: 11, breaking_ka: 50 },
  { id: 'gg_40a_11kv',   name: 'MV Back-up 40A 11kV',   fuse_type: 'gG', rated_current_a: 40,   rated_voltage_kv: 11, breaking_ka: 50 },
  { id: 'gg_63a_11kv',   name: 'MV Back-up 63A 11kV',   fuse_type: 'gG', rated_current_a: 63,   rated_voltage_kv: 11, breaking_ka: 50 },
  { id: 'gg_100a_11kv',  name: 'MV Back-up 100A 11kV',  fuse_type: 'gG', rated_current_a: 100,  rated_voltage_kv: 11, breaking_ka: 50 },
];

// Interaction modes
const MODE = {
  SELECT: 'select',
  WIRE: 'wire',
  PLACE: 'place',
  PAN: 'pan',
};

// Component categories for the sidebar palette
const COMPONENT_CATEGORIES = [
  {
    id: 'sources',
    name: 'Sources',
    items: ['utility', 'generator', 'solar_pv', 'wind_turbine', 'battery'],
  },
  {
    id: 'distribution',
    name: 'Distribution',
    items: ['bus', 'transformer', 'autotransformer', 'cable', 'bus_duct'],
  },
  {
    id: 'protection',
    name: 'Protection Devices',
    items: ['cb', 'fuse', 'relay', 'switch'],
  },
  {
    id: 'instruments',
    name: 'Instrument Transformers',
    items: ['ct', 'pt'],
  },
  {
    id: 'loads',
    name: 'Loads',
    items: ['motor_induction', 'motor_synchronous', 'vfd', 'static_load', 'distribution_board', 'dc_load'],
  },
  {
    id: 'dc_systems',
    name: 'DC Systems',
    items: ['ups', 'rectifier', 'charger', 'dc_battery'],
  },
  {
    id: 'other',
    name: 'Other',
    items: ['capacitor_bank', 'svc', 'surge_arrester', 'offpage_connector'],
  },
  {
    id: 'control',
    name: 'Control Circuit',
    items: ['ctl_supply', 'ctl_breaker', 'ctl_pb_no', 'ctl_pb_nc', 'ctl_switch',
            'ctl_contact_no', 'ctl_contact_nc', 'ctl_coil', 'ctl_lamp'],
  },
];

// Component types that belong to control schematics (IEC 60617), simulated
// client-side by ControlSim and ignored by all power-system analyses.
const CONTROL_TYPES = new Set([
  'ctl_supply', 'ctl_breaker', 'ctl_pb_no', 'ctl_pb_nc', 'ctl_switch',
  'ctl_contact_no', 'ctl_contact_nc', 'ctl_coil', 'ctl_lamp',
]);

// Component type definitions with default properties
// ─── Default Value Source Information ───
// Describes the standard or reference for generic/default values shown to the user via ⓘ buttons.
// Keyed by "componentType.fieldKey".
const FIELD_INFO = {
  // Bus
  'bus.bus_type': 'How the load-flow solver treats this bus:\nPQ (load bus): real and reactive power are fixed (a load, or a pure junction with none); the solver finds its voltage. Most buses are PQ.\nPV (voltage-controlled): a local generator holds the voltage magnitude by adjusting its reactive output — real power is fixed. Use for a governed/AVR-regulated generator bus.\nSwing (slack): the reference bus — it fixes both voltage magnitude AND angle (0°) and supplies whatever real+reactive power balances the network. Exactly one per energised island, and it must be backed by a real infinite source (the utility/grid).\nThe engine auto-selects the utility-connected bus as the swing, so you only need to set this by hand for a network with no utility. A bus labelled Swing but with no source of its own is only honoured when its island has no other source (else the real source is used) — so an incomer bus left as Swing after its utility is switched out will not fabricate power.\nUsed by: Load Flow.',

  // SVC / STATCOM (FACTS shunt reactive compensation)
  'svc.device_mode': 'STATCOM: a voltage-source converter — its reactive output is a roughly constant MVAr limit, largely independent of bus voltage (so it holds voltage even during a sag).\nSVC (TCR/TSC): a susceptance-based compensator — its reactive output follows Q = B·V², so support collapses as V² at low voltage.\nUsed by: Load Flow.',
  'svc.control_mode': 'Voltage regulating: holds the connected bus at the voltage setpoint by injecting/absorbing reactive power, within the Q Min/Max limits (a PV bus that reverts to fixed-Q when a limit is reached).\nFixed reactive output: injects a set MVAr (like a controllable capacitor/reactor).',
  'svc.v_setpoint_pu': 'Target voltage (per-unit) the compensator holds at its bus while it has reactive headroom. Once it hits Q Max (capacitive) or Q Min (inductive) it can no longer hold the setpoint and the bus voltage drifts.',
  'svc.q_max_mvar': 'Maximum capacitive (voltage-supporting) reactive output. For an SVC this is the full-susceptance rating at 1.0 pu — the available MVAr scales with V².',
  'svc.q_min_mvar': 'Maximum inductive (voltage-lowering) reactive absorption — usually negative. Used to hold voltage down under light load / leading conditions.',

  // Autotransformer
  'autotransformer.windings': '2-winding: a single tapped winding shares the HV and LV circuits (series + common) — lighter and cheaper than a two-winding transformer for ratios up to ~3:1, at the cost of no galvanic isolation.\n3-winding: adds a delta tertiary (voltage stabilisation / auxiliary supply / 3rd-harmonic path). Modelled in load flow as a star (T) equivalent with an internal node.',
  'autotransformer.z_percent': 'Short-circuit impedance HV↔LV on the unit MVA base. An autotransformer\'s through-impedance is lower than an equivalent two-winding transformer by the co-ratio (1 − Vlv/Vhv), which is its efficiency advantage.',
  'autotransformer.z_ht_percent': '3-winding only: measured HV↔tertiary short-circuit impedance (% on the unit base). With Z(HV-LV) and Z(LV-TV) it sets the star-equivalent leg impedances Z_H, Z_L, Z_T = ½(sum of the two involving that winding − the third).',
  'autotransformer.z_lt_percent': '3-winding only: measured LV↔tertiary short-circuit impedance (% on the unit base).',
  'autotransformer.tap_mode': 'fixed: the tap stays at the entered Tap Position.\nregulating (OLTC): an on-load tap changer steps the tap between Tap Min/Max to hold the regulated bus at the Target Voltage (load flow iterates the tap to the nearest step within a deadband).',
  'autotransformer.tap_percent': 'Tap position as a % boost/buck on the HV (series) winding — the standard model puts the tap on the HV side. +% raises the HV turns, which lowers the LV voltage; −% raises it.',
  'autotransformer.v_target_pu': 'OLTC target voltage (per-unit) for the regulated bus. The tap changer moves toward the tap step that brings the regulated-bus voltage within half a step of this value.',
  'autotransformer.regulated_side': 'Which bus the OLTC holds at the target voltage — the LV (common) bus is the usual load-side regulation point.',

  // On-load tap changer (generic — used by both the standard two-winding
  // Transformer and the Autotransformer; autotransformer.* overrides above
  // take precedence there).
  'tap_mode': 'fixed: the tap stays at the entered Tap Position.\nregulating (OLTC): an on-load tap changer steps the tap between Tap Min/Max to hold the regulated bus at the Target Voltage (load flow iterates the tap to the nearest step within a deadband).\nUsed by: Load Flow.',
  'tap_percent': 'Tap position as a % boost/buck on the HV winding — the standard model puts the tap on the HV side. +% raises the HV turns, which lowers the LV voltage; −% raises it. With OLTC regulating this value is set automatically each solve.',
  'regulated_side': 'Which bus the OLTC holds at the target voltage — the LV bus is the usual load-side regulation point.\nUsed by: Load Flow (OLTC).',
  'v_target_pu': 'OLTC target voltage (per-unit) for the regulated bus. The tap changer moves toward the tap step that brings the regulated-bus voltage within half a step of this value.\nUsed by: Load Flow (OLTC).',
  'tap_min_pct': 'Lowest tap position the OLTC may select, % boost/buck on the HV winding. Typical ±10% over ±16 physical steps.\nUsed by: Load Flow (OLTC).',
  'tap_max_pct': 'Highest tap position the OLTC may select, % boost/buck on the HV winding.\nUsed by: Load Flow (OLTC).',
  'tap_step_pct': 'Size of one physical tap step, % — sets both the regulation resolution and the ±half-step deadband the OLTC settles within. Typical 1.25% (16-step ±10% changer).\nUsed by: Load Flow (OLTC).',

  // Variable Frequency Drive (VFD)
  'vfd.rated_kw':          'Mechanical rating of the driven motor / drive output (kW). Input electrical power = kW × loading ⁄ efficiency; this sets the fundamental (50/60 Hz) current the drive draws.',
  'vfd.displacement_pf':   'Fundamental displacement power factor at the drive input. A diode-front-end VFD draws near-unity displacement PF (≈0.95–0.98) regardless of motor PF, because the DC-link decouples the two.\nNote: total (true) PF is lower once harmonic current is included.',
  'vfd.pulse_number':      'Rectifier pulse number — sets which characteristic harmonics the drive injects (orders h = k·p ± 1):\n• 6-pulse: 5, 7, 11, 13 … (worst)\n• 12-pulse: 11, 13, 23, 25 (5th/7th cancelled)\n• 18-pulse: 17, 19 …\n• 24-pulse: 23, 25 …\nHigher pulse counts cancel the lower, larger harmonics.\nUsed by: Harmonic Analysis (IEEE 519).',
  'vfd.front_end':         'diode: a 6-pulse (or multi-pulse) diode bridge — the classic line-commutated harmonic source.\nafe: active front end (IGBT / PWM rectifier) — switches at high frequency, so line-current THD is very low (≈3–5 %) and displacement PF ≈ 1.\nUsed by: Harmonic Analysis.',
  'vfd.input_reactor_pct': 'Series AC line reactor or DC-link choke impedance as a % of the drive base. A 3–5 % reactor markedly attenuates the 5th/7th harmonic current a diode drive draws. 0 % = no reactor (highest distortion).\nUsed by: Harmonic Analysis.',

  // Utility Source
  'utility.fault_mva':   'Default 500 MVA represents a typical medium-strength distribution network.\nSource: IEC 60909-0 §2.1 — network feeder fault level.',
  'utility.x_r_ratio':   'Default X/R = 15 is typical for transmission/sub-transmission networks.\nSource: IEC 60909-0 Table 1 — X/R ratios for network feeders.',
  'utility.voltage_kv':  'Default 33 kV — standard sub-transmission voltage per IEC 60038.',
  'utility.lf_grid_model': 'How the load flow models the grid connection:\nInfinite bus (ideal, default): the connection bus is the swing reference, pinned at the voltage setpoint regardless of load — the declared fault level plays no part.\nThevenin — impedance from fault level: the utility is placed behind its Thevenin source impedance Z = U²/S″k (R+jX split by the X/R ratio), so the point-of-supply voltage sags with load. Use for weak/rural grids, and for voltage-stability or contingency studies where finite source strength matters.\nFault analysis always uses the fault level either way (IEC 60909); this setting only affects load-flow-based studies.\nUsed by: Load Flow, Voltage Stability, Contingency, Motor Starting baselines.',
  'utility.v_setpoint_pu': 'Voltage the utility holds at its swing reference, per-unit (default 1.0).\nWith the ideal grid model this is the connection-bus voltage; with the Thevenin model it is the internal EMF, so the point of supply sits slightly lower under load. Set e.g. 1.02–1.05 to represent an upstream system held above nominal.\nUsed by: Load Flow.',

  // Generator
  'generator.prime_mover': 'The generator\'s driving machine. Descriptive/documentation attribute — it does not change the electrical model, but it flags typical inertia bands: reciprocating sets (diesel/gas engine) H ≈ 1–3 s, hydro 2–4 s, and large steam/gas turbo-sets 4–9 s (set H explicitly in the Stability section).',
  'generator.xd_pp':     'Default Xd″ = 0.15 p.u. is typical for salient-pole synchronous generators.\nSource: IEC 60034-4 Table 5 — sub-transient reactance range 0.10–0.25 p.u.',
  'generator.xd_p':      'Default Xd′ = 0.25 p.u. is typical transient reactance.\nSource: IEC 60034-4 Table 5 — transient reactance range 0.15–0.35 p.u.',
  'generator.xd':        'Default Xd = 1.2 p.u. is typical synchronous reactance.\nSource: IEC 60034-4 Table 5 — synchronous reactance range 0.8–1.8 p.u.',
  'generator.x_r_ratio': 'Default X/R = 40 is typical for generators.\nSource: IEC 60909-0 §3.7 — generator X/R ratios are generally high (30–60).',
  'generator.power_factor': 'Default PF = 0.85 lagging, typical industrial generator rating.\nSource: IEC 60034-1 §8 — rated power factor.',
  'generator.q_max_mvar': 'Maximum over-excited (lagging / capacitive) reactive output the machine can supply while regulating voltage on a PV bus. Leave blank to derive it automatically from the rating and rated power factor: Q = rated_MVA × sin(acos(pf)). Once the solver would demand more than this, the generator can no longer hold its setpoint — it clamps at this limit (PV→PQ) and the bus voltage drifts. Only used when the machine is on a voltage-controlled (PV) bus.\nUsed by: Load Flow.',
  'generator.q_min_mvar': 'Maximum under-excited (leading / inductive) reactive absorption — usually negative. Leave blank to default to −Q Max (a symmetric capability box); set an explicit value for an asymmetric under-excitation limit. When the machine must absorb more than this to hold its setpoint it clamps at the limit and the bus voltage rises. Only used on a voltage-controlled (PV) bus.\nUsed by: Load Flow.',
  'generator.min_load_pct': 'Default 30% — diesel sets running below ~30% of rating for extended periods suffer wet stacking (unburned fuel/carbon build-up).\nSources: engine manufacturers recommend 30–35% minimum (typical spec range 30–50%); NFPA 110 §8.4.2 requires monthly exercising at ≥30% of nameplate kW.\nThe dispatcher curtails solar/wind so a running generator carries at least this load.',
  'generator.max_load_pct': 'Default 100% — the ceiling (% of rating) a set is loaded to when it is dispatched (merit-order / must-run / standby). Lower it to hold spinning reserve or respect a site derating; demand beyond the cap flows to other sources or the island slack.\nApplies to dispatched sets — an island-slack generator still carries whatever residual the network balance requires.',

  // Dispatch (load-flow commitment) — shared by all sources via the bare-key
  // info fallback. Deliberately spells out that dispatch is NOT the stability
  // on/off switch (that is the breaker), since the two are easily conflated.
  'dispatch_mode': 'How the LOAD FLOW commits this source (economic dispatch). It does NOT switch the machine on or off in a stability study.\n• Must-run — always committed and generating.\n• Merit order — dispatched in priority order, only up to island demand (partial loading allowed).\n• Standby — held in reserve; committed only when the higher-priority sources cannot meet demand.\nStability note: whether a machine is ONLINE in Transient Stability is set by its BREAKER, not this field — a source behind an open breaker is out of the swing entirely (no inertia); a closed-breaker set the load flow leaves idle is modelled as a synchronous condenser (~0 MW). A machine\'s pre-fault output in the stability run follows the MW dispatched here.\nUsed by: Load Flow (and it sets the Transient Stability operating point).',
  'capacitor_bank.tuned_order': 'Turns the bank into a SINGLE-TUNED HARMONIC FILTER: a series reactor is added so the branch series-resonates at this harmonic order (design practice tunes a few % below the target, e.g. 4.7 for the 5th). The net fundamental kvar stays the rated value, so load flow is unchanged; harmonics and frequency-scan model the full C-L-R branch. 0 = plain capacitor.\nUsed by: Harmonics, Frequency Scan, Filter Sizing.',
  'capacitor_bank.quality_factor': 'Filter quality factor Q = X_n/R at the tuning frequency — sets the damping resistor R = (X_C/h_t)/Q. Typical 30–50 for a sharp single-tuned filter; lower Q broadens and damps the response.\nUsed by: Harmonics, Frequency Scan, Filter Sizing.',
  'capacitor_bank.steps_in_service': 'How many of the bank\'s steps are switched in (0 = bank off). The load flow, harmonics and frequency-scan engines model rated kVAr × in-service/steps; the OPF study uses this as its switched-VAR control. Leave blank/absent for the whole bank (legacy behaviour).\nUsed by: Load Flow, Harmonics, Frequency Scan, OPF.',
  'cost_per_mwh': 'Marginal generation cost (per MWh, currency-neutral) — fuel/energy cost used by the OPF study: economic dispatch is merit order by ascending marginal cost, and the optimized bill is Σ dispatched MW × cost. Typical: solar/wind 0, BESS cycling ~50, grid tariff ~120, diesel genset ~180-300.\nUsed by: Optimal Power Flow.',
  'failure_rate_per_yr': 'Sustained (permanent) failure rate λ, occurrences per year — for the utility this is upstream-grid sustained interruptions/yr. Blank = typical IEEE 493 default for the component type. Set 0 to exclude from the reliability FMEA.\nUsed by: Reliability Assessment.',
  'failure_rate_per_km_yr': 'Sustained failure rate per km-year (× route length). Blank = defaults: underground cable 0.05, overhead line 0.10.\nUsed by: Reliability Assessment.',
  'repair_time_h': 'Mean time to repair/restore, hours. Blank = type default (e.g. UG cable 26 h, OH line 5 h, transformer 72 h, grid 2 h).\nUsed by: Reliability Assessment.',
  'momentary_rate_per_km_yr': 'Momentary-interruption rate per km-year — overhead temporary faults cleared by reclosing (drives MAIFI). Blank = 0.30/km·yr for overhead lines.\nUsed by: Reliability Assessment.',
  'customers': 'Number of customers served by this load point (default 1) — the N in SAIFI/SAIDI. A distribution board counts its own customers in addition to any modelled loads.\nUsed by: Reliability Assessment.',
  'dispatch_priority': 'Merit-order rank for the load flow — 1 = dispatched first. Within an electrical island the highest-priority source that can balance acts as the slack; the rest are dispatched in order up to demand. Ties fall back to the type default (utility > generator > wind > solar/storage).\nThis is economic commitment only — it does not set stability on/off status (that is the breaker).\nUsed by: Load Flow.',
  'generator.gen_control': 'droop: all running sets share load in proportion to their ratings (isochronous/droop paralleling — the historical behaviour).\nsequential: load-demand start, like DSE/ComAp paralleling controllers — the lead set (lowest Dispatch Priority) is fully loaded before the next set starts; sets that are not needed stay off.\nSets paralleled on one bus should use the same scheme.',
  'generator.start_threshold_pct': 'Default 90% — the next set in the sequence starts when the running sets\' capacity utilisation would exceed this threshold.\nTypical load-demand start settings on paralleling controllers are 80–90% of running capacity.\nStart sequence follows Dispatch Priority (1 starts first).',

  // Transformer
  'transformer.z_percent':    'Default Z% = 8% is typical for 10 MVA distribution transformers.\nSource: IEC 60076-5 Table 2 — impedance voltage at rated current.\n• ≤630 kVA: 4–6%\n• 1–10 MVA: 6–9%\n• >10 MVA: 8–12%',
  'transformer.x_r_ratio':    'Default X/R = 10 for distribution transformers.\nSource: IEC 60076-5 — typical X/R ratios:\n• Small (<1 MVA): 3–6\n• Medium (1–10 MVA): 7–12\n• Large (>10 MVA): 15–40',
  'transformer.vector_group':  'Default Dyn11 — most common distribution transformer configuration.\nSource: IEC 60076-1 §5 — vector group designation.\nD = Delta HV, y = Star LV, n = LV neutral brought out, 11 = 30° lead.',
  'transformer.grounding_lv':  'Default: solidly grounded LV neutral. Common for Dyn transformers in TN systems.\nSource: IEC 60364-1 — system earthing arrangements.',
  'transformer.core_construction': 'Magnetic core type — sets the zero-sequence magnetising reactance Z₀ₘ, which only matters for a SINGLE-EARTHED star-star transformer (one neutral earthed, the other floating, no delta). There the earthed neutral can only source earth-fault current through the core.\n• three_limb: zero-sequence flux returns through the tank/air (lossy "phantom delta") → finite Z₀ₘ ≈ 0.3–1.0 pu → a limited but real earth-fault current the protection can see.\n• five_limb / shell / single_phase_bank: iron zero-sequence return path → Z₀ₘ ≈ open → earthed neutral sources negligible earth-fault current.\nIgnored for delta-backed (Dyn/YNd) or both-neutrals-earthed transformers, whose Z₀ path dominates.',
  'transformer.z0m_pu': 'Optional override for the zero-sequence magnetising impedance Z₀ₘ, in per-unit on the transformer MVA base (e.g. the open-circuit zero-sequence impedance from the datasheet/test report). 0 = use the Core Construction default (three-limb ≈ 0.6 pu; five-limb/shell/bank ≈ open). Only affects single-earthed star-star units.',
  'transformer.earthing_system': 'LV installation earthing arrangement (only for LV secondaries ≤1 kV).\nSource: IEC 60364-1 §312.2 / SANS 10142-1.\n• TN-S: separate N and PE throughout — metallic earth-fault return.\n• TN-C: combined PEN — no RCD permitted on the PEN.\n• TN-C-S: PEN upstream, split to N+PE at the installation (PME).\n• TT: installation earthed to a local electrode — fault returns through soil (R_A+R_B), so earth-fault current is low and an RCD is required.\n• IT: source unearthed / high-impedance — first fault ≈ 0 A, needs insulation monitoring.',
  'transformer.earth_electrode_r_source': 'TT/IT only: resistance of the SOURCE (substation) earth electrode R_B, in ohms.\nTypical 1–2 Ω. Appears as 3·R_B in the zero-sequence earth-fault loop.',
  'transformer.earth_electrode_r_installation': 'TT only: resistance of the INSTALLATION earth electrode R_A, in ohms.\nSANS 10142-1 requires R_A·IΔn ≤ 50 V for the protective RCD. Appears as 3·R_A in the zero-sequence earth-fault loop.',
  'utility.earthing_system': 'LV installation earthing arrangement (only when the supply voltage is ≤1 kV).\nSource: IEC 60364-1 §312.2 / SANS 10142-1.\nTN-S/TN-C/TN-C-S: metallic earth return. TT: soil return via local electrode (R_A+R_B) → low fault current, RCD required. IT: unearthed source, insulation monitoring required.',
  'utility.earth_electrode_r_source': 'TT/IT only: source earth electrode resistance R_B (Ω), typical 1–2 Ω. Enters the zero-sequence loop as 3·R_B.',
  'utility.earth_electrode_r_installation': 'TT only: installation earth electrode resistance R_A (Ω). SANS 10142-1 requires R_A·IΔn ≤ 50 V. Enters the zero-sequence loop as 3·R_A.',
  'transformer.voltage_hv_kv': 'Default 33 kV — standard sub-transmission voltage.\nSource: IEC 60038 — standard voltages above 1 kV.',
  'transformer.voltage_lv_kv': 'Default 11 kV — standard primary distribution voltage.\nSource: IEC 60038 — standard voltages above 1 kV.',

  // Cable
  'cable.construction': 'How this feeder is built.\n• Underground Cable — insulated Cu/Al cable; the Cable Type library and the IEC 60364-5-52 installed-ampacity calculator (installation method, ambient/grouping derating) apply.\n• Overhead Line — bare ACSR/AAAC conductor; the Conductor library provides the codeword conductor with its in-air current rating and (wider-spacing) reactance. The IEC install-method ampacity derating does not apply — the library rating is the in-air thermal limit.\nBoth types feed the same R/X/rating into the fault and load-flow engines, so switching type only changes which selector + defaults you see.',
  'cable.r_per_km':    'Default R = 0.1 Ω/km — typical for 240mm² Cu XLPE cable at 90°C.\nSource: IEC 60502-2 Table 2 — conductor resistance values.',
  'cable.x_per_km':    'Default X = 0.08 Ω/km — typical reactance for XLPE cables in trefoil.\nSource: IEC 60502-2 Annex C — cable reactance values.',
  'cable.rated_amps':  'Default 400A — typical rating for medium-voltage distribution cable.\nSource: IEC 60502 / IEC 60364-5-52 — current-carrying capacity tables.',

  // Circuit Breaker
  'cb.breaking_capacity_ka': 'Default 25 kA — typical for 11 kV distribution circuit breakers.\nSource: IEC 62271-100 — rated short-circuit breaking current.',
  'cb.thermal_pickup':       'Default 1.0×In — thermal overload pickup at rated current.\nSource: IEC 60947-2 §4.7 — thermal trip characteristics.',
  'cb.magnetic_pickup':      'Default 10×In — typical magnetic instantaneous pickup for MCCB.\nSource: IEC 60947-2 Annex F — magnetic trip range:\n• Type B: 3–5×In\n• Type C: 5–10×In\n• Type D: 10–20×In',
  'cb.long_time_delay':      'Default class 10 — standard long-time delay for motor and feeder protection.\nSource: IEC 60947-2 §4.7.1 — tripping classes:\n• Class 5: fast (motor starting)\n• Class 10: standard\n• Class 20: heavy-duty motor starts\n• Class 30: very heavy-duty.',
  'cb.ef_trip_ct':           'Core-balance CT whose residual output trips this breaker directly (integral earth-fault / shunt-trip release) — no separate relay needed.\nLeave blank for no integral earth-fault element. Common on MCCB/ACB earth-leakage releases.',
  'cb.ef_pickup_a':          'Earth-fault (residual) pickup in primary amps for the integral shunt-trip element.\nTypical sensitive-earth-fault settings: tens to a few hundred amps, well below phase pickup.',
  'cb.ef_delay_s':           'Definite-time delay of the integral earth-fault trip (s). 0 = instantaneous.\nGrade against downstream earth-fault devices at the single-line-to-ground fault current.',

  // Fuse
  'fuse.breaking_capacity_ka': 'Default 50 kA — typical for gG fuse-links.\nSource: IEC 60269-1 — rated breaking capacity for HRC fuses.',
  'fuse.fuse_type':            'Default gG — general purpose fuse for overload and short-circuit protection.\nSource: IEC 60269-1:\n• gG: general purpose full-range\n• aM: motor circuit partial-range (short-circuit only).',

  // Relay
  'relay.associated_ct': 'Select the current transformer (CT) that feeds this relay.\nThe CT measurement location determines where the relay measures fault current.\nThe relay pickup should be set in primary amps (before CT ratio).',
  'relay.trip_cb': 'Select the circuit breaker that this relay trips.\nWhen the relay operates, it sends a trip signal to this CB to isolate the fault.',
  'relay.pickup_a':  'Set in PRIMARY amps (line current before the CT), not secondary/relay-terminal amps.\nWith a phase CT linked this is the phase current; with a core-balance CT it is the net residual (earth-fault, 3I0) current through the window.\nEither way the panel shows the equivalent secondary current (pickup ÷ CT ratio) the relay actually sees.\nDefault 100A — adjust to match load current and CT ratio.\nSource: IEC 60255-151 — overcurrent relay pickup setting.',
  'relay.inst_pickup_a': 'Instantaneous (50) element pickup in PRIMARY amps (line current before the CT). 0 disables it.\nWith a measuring CT linked, the panel shows the equivalent secondary current (pickup ÷ CT ratio).\nSource: IEC 60255-151.',
  'relay.time_dial':  'Default TDS = 1.0 — middle of adjustment range.\nSource: IEC 60255-151 / IEEE C37.112 — time dial setting (0.05–10).',
  'relay.curve':      'Default IEC Standard Inverse curve.\nSource: IEC 60255-151 §5.5 — IDMT characteristics:\nt = TDS × 0.14 / (M^0.02 − 1)',
  'relay.z1_reach_ohm': 'Zone 1 forward reach in primary ohms.\nTypically set to 80% of protected line impedance for instantaneous tripping.\nSource: IEEE C37.113 / IEC 60255-121.',
  'relay.z2_reach_ohm': 'Zone 2 forward reach in primary ohms.\nTypically set to 120% of protected line impedance (overreaches into next section).\nOperates with a time delay (typically 0.3-0.5s).\nSource: IEEE C37.113.',
  'relay.z3_reach_ohm': 'Zone 3 forward reach in primary ohms.\nTypically set to cover the next line section (200%+ of protected line).\nOperates with a longer time delay (typically 0.6-1.2s) as backup.\nSource: IEEE C37.113.',
  'relay.direction': 'Operating direction for directional overcurrent (67) relay.\nForward: operates for faults downstream (current flowing from source to load).\nReverse: operates for faults upstream (reverse power flow).\nSource: IEC 60255-151 §6 — directional overcurrent relays.',
  'relay.characteristic_angle_deg': 'Relay characteristic angle (RCA) — the angle of maximum sensitivity.\nDefault 45° — typical for MV distribution feeders.\nSource: IEC 60255-151 — RCA depends on line impedance angle:\n• Cables (low X/R): 30-45°\n• Overhead lines: 45-65°\n• Transmission: 60-75°.',
  'relay.mho_angle_deg': 'Maximum torque angle (MTA) of the mho characteristic.\nTypically 60-85 degrees depending on line impedance angle.\nSource: IEC 60255-121 §5.3.',

  // CT
  'ct.ct_type':        'Phase: a per-phase measurement/protection CT feeding an overcurrent element.\nCore balance (residual): a window/toroidal CT that encircles all phase conductors and measures the residual (zero-sequence) current directly — used for sensitive earth-fault protection.\nAssociate a core-balance CT with a 50N/51N relay, or with an MCCB/ACB earth-fault (shunt-trip) release.',
  'ct.ratio':          'Default 400/5 — standard 5A secondary CT.\nSource: IEC 61869-2 — standard CT secondary current: 1A or 5A.\nCore-balance CTs use low ratios for sensitive earth fault (e.g. 100/1, 50/1).',
  'ct.accuracy_class': 'Default 5P20 — protection class.\nSource: IEC 61869-2:\n• 5P20: 5% composite error at 20× rated current\n• P = protection application.',
  'ct.burden_va':      'Default 15 VA — typical protection CT burden.\nSource: IEC 61869-2 §2 — standard rated burden values.',
  'ct.rct_ohm':        'Default 0.3 Ω — CT secondary winding resistance, typical for a 5 A secondary CT.\nSource: IEC 61869-2 — typical Rct: 0.1–0.5 Ω (5 A CTs), 1–5 Ω (1 A CTs).\nAffects saturation onset: higher Rct means earlier saturation.',
  'ct.knee_point_v':   'Leave 0 to auto-derive from the accuracy class ALF.\nVk ≈ 0.8 × ALF × I_rated × (Rct + R_burden) — the knee of a 5P/10P protection core sits below the accuracy-limit voltage V_AL.\nSource: IEC 61869-2 — knee point voltage defines CT saturation onset.\nManual entry (e.g. a PX-class rated knee) overrides the calculated value.',

  // PT
  'pt.ratio':          'Default 11000/110 — standard 110V secondary.\nSource: IEC 61869-3 — standard secondary voltage: 100V or 110V.',
  'pt.accuracy_class': 'Default 0.5 — metering grade accuracy.\nSource: IEC 61869-3 — accuracy classes: 0.1, 0.2, 0.5, 1.0, 3.0.',
  'pt.burden_va':      'Default 30 VA — typical metering PT burden.\nSource: IEC 61869-3 §2 — standard burden values.',

  // Induction Motor
  'motor_induction.efficiency':           'Default 93% — typical for IE3 200 kW motor.\nSource: IEC 60034-30-1 Table 2 — efficiency classes for induction motors.',
  'motor_induction.power_factor':         'Default PF = 0.85 — typical for medium induction motors.\nSource: IEC 60034-1 — rated power factor varies with size (0.80–0.92).',
  'motor_induction.locked_rotor_current': 'Default 6×FLC — typical locked rotor (starting) current.\nSource: IEC 60034-1 §9.7 — starting current:\n• Most motors: 5–8× FLC\n• High-efficiency: 6–7× FLC.',
  'motor_induction.starting_method': 'Starting method — reduces the current drawn from the supply during start (I ∝ V²):\n• DOL: full locked-rotor current\n• Star-Delta: ⅓ of DOL\n• Autotransformer (80% tap): 0.64×\n• Soft Starter: ≈0.5×\n• VFD: ≈ full-load current.',
  'motor_synchronous.starting_method': 'Starting method — reduces the current drawn from the supply during the asynchronous start (I ∝ V²):\n• DOL: full locked-rotor current\n• Star-Delta: ⅓ of DOL\n• Autotransformer (80% tap): 0.64×\n• Soft Starter: ≈0.5×\n• VFD: ≈ full-load current.',
  'motor_synchronous.locked_rotor_current': 'Default 5.5×FLC — synchronous motors start asynchronously through the amortisseur winding.\nSource: IEC 60034-1 — starting current typically 4–7× FLC.',
  'generator.inertia_h_s': 'Inertia constant H (seconds) on the machine MVA base — the stored rotor kinetic energy at rated speed divided by the rating (H = ½Jω²/S). Sets how fast the rotor angle swings after a disturbance. Typical: diesel/gas gensets 1–3 s, hydro 2–4 s, large steam turbo-sets 4–9 s.\nUsed by: Transient Stability.',
  'generator.damping_pu': 'Damping coefficient D (p.u. torque per p.u. speed deviation) in the swing equation. Represents damper-winding and load damping. Leave 0 for a conservative (undamped) first-swing result; 1–3 is typical when included.\nUsed by: Transient Stability.',
  'generator.machine_model': 'Synchronous-machine dynamic model.\n• Classical — a constant voltage E′ behind X′d (the AVR, if on, varies |E′| directly). Fast and standard for first-swing studies.\n• Two-axis — d/q transient EMFs E′q and E′d decay via the open-circuit time constants T′do / T′qo and the AVR drives the field voltage E_fd, so field flux dynamics and the exciter lag are represented (equal transient reactances X′q = X′d). Needs Xd, Xq, T′do, T′qo.\nUsed by: Transient Stability.',
  'generator.xq': 'Synchronous q-axis reactance Xq (p.u. on the machine base) — used by the two-axis model for the E′d equation and the rotor-angle construction. Typical: round-rotor Xq ≈ Xd; salient-pole (diesel/hydro) Xq ≈ 0.5–0.7·Xd.\nUsed by: Transient Stability (two-axis).',
  "generator.tdo_p": "d-axis transient open-circuit time constant T'do — how fast the field flux (E′q) responds to the exciter. Typical 4–8 s.\nUsed by: Transient Stability (two-axis).",
  "generator.tqo_p": "q-axis transient open-circuit time constant T'qo — decay of the q-axis transient EMF E′d. Typical 0.5–1.5 s.\nUsed by: Transient Stability (two-axis).",
  'generator.gov_mode': 'Turbine-governor control that restores frequency after a load change.\n• Isochronous — returns frequency to nominal (integral/reset control); use for a set holding island frequency.\n• Droop — settles at a small steady offset set by the droop %; the standard scheme for paralleled sets sharing load.\n• None — mechanical power stays fixed (classical constant-Pm model); an islanded frequency then drifts and does not recover.\nUsed by: Transient Stability.',
  'generator.gov_droop_pct': 'Governor speed droop R (% speed change from no-load to full-load). Sets the primary frequency-response gain and how paralleled sets share a load change. Typical 3–5% (default 4%).\nUsed by: Transient Stability.',
  'generator.gov_time_const_s': 'Combined governor + turbine time constant Tg (first-order lag from a speed error to a change in mechanical power). Typical diesel/gas sets 0.3–1 s (default 0.5 s).\nUsed by: Transient Stability.',
  'generator.gov_reset_time_s': 'Isochronous reset (secondary/integral) time Tr — how quickly frequency is driven back to nominal after the primary response. Larger = slower, smoother recovery. Typical 3–8 s (default 5 s). Only used in isochronous mode.\nUsed by: Transient Stability.',
  'generator.avr_mode': 'Automatic Voltage Regulator / exciter. On — the field EMF is varied to hold the terminal voltage at its pre-fault value, so bus voltage recovers after a fault or load change (and boosts synchronising torque, improving first-swing stability). Off — the internal EMF E′ stays fixed (classical constant-voltage-behind-X′d model).\nUsed by: Transient Stability.',
  'generator.avr_gain': 'AVR steady-state gain Ka (p.u. field EMF per p.u. terminal-voltage error). Higher = tighter voltage regulation and stronger transient support, but too high can cause voltage/rotor oscillation. Typical 20–200 (default 25).\nUsed by: Transient Stability.',
  'generator.avr_time_const_s': 'Combined AVR + exciter time constant Ta (first-order lag from a voltage error to a change in field EMF). Smaller = faster voltage response. Typical 0.02–0.5 s (default 0.2 s).\nUsed by: Transient Stability.',
  'motor_induction.dyn_role': 'How this motor appears in the shared-timeline Dynamic Motor Starting study:\n• Starts (staged) — cold-starts at its Start Time; its inrush sags every other energised motor.\n• Already running — a steady background load at its demand factor (present in the pre-start voltage and drawing running current throughout), not simulated as a start.',
  'motor_synchronous.dyn_role': 'How this motor appears in the shared-timeline Dynamic Motor Starting study:\n• Starts (staged) — cold-starts at its Start Time; its inrush sags every other energised motor.\n• Already running — a steady background load, not simulated as a start.',
  'motor_induction.start_time_s': 'When this motor energises on the shared simulation timeline (0 = at the start). Stagger start times to sequence a motor group and see how each start sags the buses the others sit on. Ignored when the Sequence Role is “Already running”.',
  'motor_synchronous.start_time_s': 'When this motor energises on the shared simulation timeline (0 = at the start). Stagger start times to sequence a motor group. Ignored when the Sequence Role is “Already running”.',
  'motor_induction.rated_speed_rpm': 'Nameplate full-load speed. Sets the rated slip s = 1 − n/n_sync used to fit the rotor circuit (1480 rpm ⇒ s = 1.33% on a 50 Hz 4-pole machine).\nUsed by: Dynamic Motor Starting.',
  'motor_induction.poles': 'Number of poles (2, 4, 6, …). When set, the breaking-current q-factor uses the IEC 60909-0 §9.1.2 argument m = rated MW per pole pair; when 0/unset the I″kM/I_rM current ratio is used as a proxy (conservative — overstates the motor Ib contribution).\nUsed by: Fault Analysis (Ib).',
  'motor_induction.accel_time_s': 'Estimated acceleration (run-up) time for the TCC starting-current overlay — the inrush segment is drawn at LRC×FLC×(starter factor) up to this time, then steps to FLC. Use the Dynamic Motor Starting study\'s accel time when known.\nUsed by: TCC motor-start overlay (relay-vs-start coordination).',
  'motor_synchronous.accel_time_s': 'Estimated acceleration (run-up) time for the TCC starting-current overlay — the inrush segment is drawn at the starting current up to this time, then steps to FLC.\nUsed by: TCC motor-start overlay (relay-vs-start coordination).',
  'cb.circuit_type': 'Circuit class for the SANS 10142-1 / IEC 60364-4-41 disconnection-time limit:\n• Final — socket outlets: Table 41.1 time (0.4 s at 230 V) up to In ≤ 63 A (§411.3.2.2)\n• Final — fixed equipment: Table 41.1 time up to In ≤ 32 A\n• Distribution / sub-main: 5 s (§411.3.2.3)\n• Auto: assumed FINAL circuit up to 63 A (conservative), 5 s above.\nUsed by: Compliance (earth-fault disconnection).',
  'fuse.circuit_type': 'Circuit class for the SANS 10142-1 / IEC 60364-4-41 disconnection-time limit:\n• Final — socket outlets: Table 41.1 time (0.4 s at 230 V) up to In ≤ 63 A (§411.3.2.2)\n• Final — fixed equipment: Table 41.1 time up to In ≤ 32 A\n• Distribution / sub-main: 5 s (§411.3.2.3)\n• Auto: assumed FINAL circuit up to 63 A (conservative), 5 s above.\nUsed by: Compliance (earth-fault disconnection).',
  'transformer.z0_z1_ratio': 'Zero-sequence to positive-sequence impedance ratio Z₀T/Z₁T from the datasheet/test report. Typical Dyn three-limb core-type units measure ≈ 0.85; five-limb/shell/bank ≈ 1.0. 0/unset = Z₀T = Z₁T (legacy screening convention).\nUsed by: Fault Analysis (SLG/LLG).',
  'motor_induction.locked_rotor_torque_pct': 'Locked-rotor (starting) torque as % of full-load torque.\nSource: IEC 60034-12 design N: typically 70–190% depending on rating; 150% is a common medium-motor value.\nUsed with LRC to fit the deep-bar rotor model.',
  'motor_induction.motor_j_kgm2': 'Rotor moment of inertia from the motor datasheet (J = GD²/4).\nLeave 0 to auto-estimate from the rating (H ≈ 0.12·P_kW^0.15 s) — the result then carries a warning.',
  'motor_induction.load_j_kgm2': 'Driven-load moment of inertia referred to the motor shaft.\nFans/large blowers: often 3–10× motor J. Pumps: ≈0.2–1× motor J. Direct-coupled loads only — refer through the gearbox ratio² if geared.',
  'motor_induction.load_torque_model': 'Load torque vs speed characteristic:\n• Quadratic — centrifugal fans/pumps, T ∝ n²\n• Linear — mixers, calenders\n• Constant — conveyors, compressors, hoists (hardest to start).',
  'motor_induction.load_torque_pct': 'Load torque at rated speed as % of motor full-load torque. 90% is a typical pump/fan sizing margin; 100% = fully loaded shaft.',
  'motor_induction.load_breakaway_pct': 'Static friction (breakaway) torque at standstill, % of the rated-speed load torque. Typical 5–20% for fans/pumps. Ignored for the constant-torque model (already 100% at standstill).',
  'motor_induction.transition_speed_pct': 'Speed (% of synchronous) at which a star-delta or autotransformer starter changes over to full voltage. Typical timers are set to fire near 75–85% speed.',
  'motor_induction.ss_current_limit_xflc': 'Soft starter current limit (×FLC). The starter holds this by reducing voltage — check the motor still develops enough torque to accelerate (T ∝ V²). Typical 2.5–4×.',
  'motor_induction.ss_ramp_s': 'Soft starter voltage ramp time from initial voltage to full voltage (if the current limit permits). Typical 5–30 s.',
  'motor_induction.ss_initial_v_pct': 'Soft starter initial (pedestal) voltage, % of supply. Typical 30–40% — must exceed the breakaway torque requirement (T ∝ V²).',
  'motor_induction.stall_time_hot_s': 'Permissible locked-rotor (stall) time from hot, from the motor thermal-limit curve.\nThe study integrates I²t over the start and reports the % of this withstand consumed.\nTypical 10–20 s.',
  'motor_induction.sim_t_max_s': 'Simulation window. Starts not completed within this time are flagged. High-inertia drives (large fans) may need 60–120 s.',
  'motor_synchronous.rated_speed_rpm': 'Synchronous speed (the machine runs at n_sync). The damper-cage start is modelled like an induction machine with an assumed 5% rated-point slip; pull-in by excitation is assumed at 95% speed.\nUsed by: Dynamic Motor Starting.',
  'motor_synchronous.locked_rotor_torque_pct': 'Amortisseur (damper) winding starting torque as % of rated torque.\nTypical 100–140% depending on damper design; check the machine data sheet.',
  'motor_synchronous.motor_j_kgm2': 'Rotor moment of inertia from the machine datasheet (J = GD²/4).\nLeave 0 to auto-estimate from the rating — the result then carries a warning.',
  'motor_synchronous.load_j_kgm2': 'Driven-load moment of inertia referred to the motor shaft. Refer through the gearbox ratio² if geared.',
  'motor_synchronous.load_torque_model': 'Load torque vs speed characteristic:\n• Quadratic — centrifugal fans/pumps, T ∝ n²\n• Linear — mixers\n• Constant — compressors, conveyors (hardest to start).',
  'motor_synchronous.load_torque_pct': 'Load torque at rated speed as % of rated torque. The damper cage must accelerate the load to ≥95% speed for excitation pull-in.',
  'motor_synchronous.load_breakaway_pct': 'Static friction (breakaway) torque at standstill, % of the rated-speed load torque. Ignored for the constant-torque model.',
  'motor_synchronous.transition_speed_pct': 'Speed (% of synchronous) at which a star-delta or autotransformer starter changes over to full voltage.',
  'motor_synchronous.ss_current_limit_xflc': 'Soft starter current limit (×FLC). Held by voltage reduction — torque falls with V².',
  'motor_synchronous.ss_ramp_s': 'Soft starter voltage ramp time from initial voltage to full voltage.',
  'motor_synchronous.ss_initial_v_pct': 'Soft starter initial (pedestal) voltage, % of supply.',
  'motor_synchronous.stall_time_hot_s': 'Permissible stall time from hot (damper thermal limit). The study integrates I²t over the start against this withstand.',
  'motor_synchronous.sim_t_max_s': 'Simulation window. Starts not reaching pull-in speed within this time are flagged.',
  'motor_induction.x_pp':                 'Default X″ = 0.17 p.u. — sub-transient reactance for fault contribution.\nSource: IEC 60909-0 Table 3 — motor sub-transient reactance 0.12–0.25 p.u.',

  // Synchronous Motor
  'generator.trip_of_hz': 'Over-frequency protection: the generator trips if its frequency stays above this for the trip delay (0 = disabled). Typical 51–52 Hz on a 50 Hz system.\nUsed by: Transient Stability.',
  'generator.trip_uf_hz': 'Under-frequency protection: the generator trips if its frequency stays below this for the trip delay (0 = disabled). Typical 47–48 Hz.\nUsed by: Transient Stability.',
  'generator.trip_uv_pu': 'Under-voltage protection: the generator trips if its terminal voltage stays below this for the trip delay (0 = disabled). Typical 0.7–0.8 p.u.\nUsed by: Transient Stability.',
  'generator.trip_delay_s': 'Definite-time delay a frequency/voltage violation must persist before the generator trips. Typical 0.1–0.5 s (default 0.2 s).\nUsed by: Transient Stability.',
  'static_load.uf_shed_hz': 'Under-frequency load shedding (UFLS): this load is disconnected when its island frequency stays below this threshold for the UFLS delay (0 = firm, never shed). Stage the site by giving successive load blocks 49.0 / 48.5 / 48.0 Hz.\nUsed by: Transient Stability.',
  'static_load.uf_shed_delay_s': 'Relay delay a UFLS under-frequency condition must persist before this load is shed. Typical 0.1–0.3 s (default 0.2 s).\nUsed by: Transient Stability.',
  'static_load.uv_trip_pu': 'Under-voltage trip: the load is disconnected if its bus voltage stays below this for the trip delay (0 = disabled). Typical 0.5–0.7 p.u.\nUsed by: Transient Stability.',
  'static_load.uv_trip_delay_s': 'Delay an under-voltage condition must persist before the load trips (default 0.2 s).\nUsed by: Transient Stability.',
  'motor_induction.uv_trip_pu': 'Contactor drop-out / under-voltage trip: the motor is disconnected if its terminal voltage stays below this for the trip delay (0 = disabled). Contactors typically drop out around 0.5–0.7 p.u.\nUsed by: Transient Stability.',
  'motor_induction.uv_trip_delay_s': 'Delay an under-voltage condition must persist before the motor trips (default 0.2 s; contactor drop-out is fast, ~0.05–0.2 s).\nUsed by: Transient Stability.',
  'static_load.load_type': 'Voltage dependence of the load in Transient Stability (load flow / fault use the rated draw).\n• Constant power — draws the same kW/kvar as voltage varies (current rises as V falls); the most onerous, can drive voltage collapse.\n• Constant current — magnitude holds, power falls with voltage.\n• Constant impedance — a fixed admittance; power falls with V² (the classical model, most benign).\nUsed by: Transient Stability.',
  'motor_induction.ts_dynamic': 'Transient-stability motor model.\n• On — a single-cage dynamic model: the motor slows on a voltage dip, drawing more current and possibly stalling (fitted from the nameplate LRC/LRT, speed, inertia and load-torque fields below).\n• Off — the motor is frozen as a constant-impedance load at its pre-fault operating point (the classical model).\nUsed by: Transient Stability.',
  'motor_synchronous.xd_pp': 'Default Xd″ = 0.15 p.u. — sub-transient reactance.\nSource: IEC 60034-4 Table 5 — synchronous motor Xd″ range 0.10–0.25 p.u.',
  'motor_synchronous.xd_p':  'Default Xd′ = 0.25 p.u. — transient reactance.\nSource: IEC 60034-4 Table 5 — synchronous motor Xd′ range 0.15–0.35 p.u.',
  'motor_synchronous.power_factor': 'Default PF = 0.9 leading — synchronous motors often operate at leading PF.\nSource: IEC 60034-1 — rated at unity or leading PF.',

  // Static Load
  'static_load.power_factor': 'Default PF = 0.85 lagging — typical mixed commercial/industrial load.\nSource: General practice — power factor range 0.7–0.95 depending on load type.',
  'static_load.demand_factor': 'Demand factor (0–1): ratio of maximum demand to installed load.\nSource: IEC 60439 / IEC 61439.\nTypical values: lighting 1.0, socket outlets 0.4, motors (group) 0.5–0.8.',
  'static_load.motor_fraction': 'Rotating share of this lumped load (0–1). When > 0 that fraction back-feeds short circuits as an induction-motor equivalent per IEC 60909-0 §13, instead of contributing nothing.\n0 = pure static load (default, unchanged). Typical mixed MCC 0.4–0.7.',
  'static_load.motor_lrc_ratio': 'Locked-rotor current ratio (LRC = I_start / I_FLC) of the motor fraction. Sets the sub-transient reactance X″ ≈ 1/LRC.\nSource: IEC 60909-0 §13. Typical DOL induction motors 5–7 (default 6).',
  'distribution_board.motor_fraction': 'Rotating share of the board load (0–1) that back-feeds short circuits as an induction-motor equivalent per IEC 60909-0 §13.\n0 = treat as pure static load (default).',
  'distribution_board.motor_lrc_ratio': 'Locked-rotor current ratio (I_start / I_FLC) of the board motor fraction; sets X″ ≈ 1/LRC per IEC 60909-0 §13. Typical 5–7 (default 6).',

  // Arc flash equipment class (IEEE 1584-2002 Table 4)
  'bus.equipment_class': 'Selects the IEEE 1584-2002 conductor gap and enclosure class.\n"auto" infers from voltage (LV = MCC/panel 25 mm). Choose lv_switchgear (32 mm) to model LV switchgear, mv_switchgear_5kv (104 mm) / 15kv (153 mm) for MV, or open_air.\nSource: IEEE 1584-2002 Table 4.',
  'bus.conductor_gap_mm': 'Explicit conductor gap override in mm (0 = use the equipment class / voltage default). Valid IEEE 1584-2002 model range 6.35–76.2 mm.\nSource: IEEE 1584-2002 §5.',

  // Cable sizing — fault-withstand basis & standalone inputs
  'cable.adiabatic_basis': 'Fault-withstand current basis.\nThermal-equiv. Iₜₕ = Ik″·√(m+n) per IEC 60909-0 §12 (default, conservative — includes the DC component).\nBare Isc uses Ik″ directly, matching the simpler adiabatic hand-calc in many design guides.',
  'cable.standalone_current_a': 'Hand-entered design (load) current for a standalone sizing check, in A. 0 = take the current from the network load flow.\nUse when checking a cable without building/solving the full network.',
  'cable.standalone_isc_ka': 'Hand-entered prospective short-circuit current for the fault-withstand check, in kA. 0 = take Ik″ from the fault study.',
  'cable.standalone_clearing_s': 'Hand-entered protective-device clearing time for the fault-withstand check, in s. 0 = estimate from the upstream breaker.',

  // Motor demand factors
  'motor_induction.demand_factor': 'Demand factor (0–1): ratio of maximum demand to installed rating.\nSource: IEC 60439 / IEC 61439.\nTypical: single largest motor 1.0, group of 2-4 motors 0.8, 5-10 motors 0.6.',

  // Grounding (IEEE 80)
  'bus.soil_resistivity': 'Soil resistivity in Ω·m.\nSource: IEEE 80 §12.2 — typical values:\n• Wet clay: 20–100\n• Sandy clay: 50–200\n• Gravel/sand: 200–3000\n• Rock: 1000–10000',
  'bus.grid_length': 'Grounding grid length in metres.\nSource: IEEE 80 — grid dimensions define the protected area.',
  'bus.grid_width': 'Grounding grid width in metres.',
  'bus.grid_depth': 'Burial depth of grid conductors (typically 0.3–1.0 m).\nSource: IEEE 80 §14.3.',
  'bus.num_conductors_x': 'Number of parallel conductors in X direction.\nMore conductors reduce mesh voltage.',
  'bus.num_conductors_y': 'Number of parallel conductors in Y direction.',
  'bus.num_ground_rods': 'Number of vertical ground rods.\nSource: IEEE 80 §14.4 — rods help reduce grid resistance.',
  'bus.ground_rod_length': 'Length of each ground rod (typically 3 m).\nSource: IEEE 80 §14.4.',
  'bus.fault_duration': 'Fault clearing time in seconds.\nSource: IEEE 80 §9.4 — determines tolerable touch/step voltages.\nTypical: 0.15–1.0 s.',
  'motor_synchronous.demand_factor': 'Demand factor (0–1): ratio of maximum demand to installed rating.\nSource: IEC 60439 / IEC 61439.',

  // Surge Arrester
  'surge_arrester.mcov_kv': 'Default MCOV = 8.4 kV (for 11 kV system, ratio ≈ 0.76).\nSource: IEC 60099-4 §5.2 — maximum continuous operating voltage.\nMCOV ≥ Um / √3 for grounded systems.',

  // Solar PV — inverter & plant
  'solar_pv.rated_kw':      'AC nameplate of ONE inverter. Total plant = rated kW × No. of Inverters.\nIn array mode the output additionally clips at this value when the DC array out-produces it.',
  'solar_pv.num_inverters': 'Number of identical inverters; multiplies the rated power, DC array and battery limits.',
  'solar_pv.inverter_eff':  'DC→AC conversion efficiency. Default 0.97 — typical peak efficiency of modern string inverters (datasheet "max efficiency" 96–98.5%).',
  'solar_pv.power_factor':  'Displacement power factor at the AC terminals. Default 1.0 — inverters normally export at unity unless the utility requires reactive support (e.g. 0.95 under grid codes).',
  'solar_pv.mppt_tracking': 'Informational: fixed-tilt vs tracking mounting. Does not change the electrical model — capture the yield difference via Irradiance %.',
  'solar_pv.irradiance_pct':'Availability scaling of the DC resource: 100% = STC full sun, 0% = night.\nUse it to study partial output (cloud, morning/evening) — in array mode output = min(DC × irradiance, inverter rating).',
  'solar_pv.inverter_type': 'grid_tied: PV only, shuts down on grid loss.\nhybrid: adds a DC-coupled battery behind the same inverter — enables the Battery Storage section and the Backup Autonomy study.',
  'var_mode': 'How the inverter controls reactive power. Its AC side is decoupled from the DC source, so it can supply/absorb VArs up to its kVA rating whether the energy comes from the PV array or the battery.\nFollow power factor (default): inject reactive to hold the set power factor, bounded by the kVA circle √(S²−P²) — so a hybrid running on battery at night still provides VArs (if the inverter has headroom above its real output).\nVoltage regulating: hold the bus voltage at the setpoint (a PV bus) up to the same reactive circle, clamping when the limit is reached.\nUnity: no reactive output.\nUsed by: Load Flow.',
  'v_setpoint_pu': 'Target bus voltage (per-unit) the inverter holds while voltage-regulating, as long as it has reactive headroom within its kVA circle. Once it hits the reactive limit it can no longer hold the setpoint and the voltage drifts.',
  'solar_pv.fault_contribution_pu': 'Inverter fault current limit as a multiple of rated current. Default 1.1×.\nSource: IEC TR 60909-4 — converter-based sources are current-limited (typ 1.0–1.5×, no decaying DC component).',

  // Inverter-based-resource transient-stability model (shared by Solar PV, BESS
  // and full-converter wind — bare keys, resolved for any IBR component).
  'ibr_ctrl': 'Converter dynamic model for Transient Stability.\n• Frozen — a constant admittance at the pre-fault operating point (the classical assumption; results unchanged).\n• Grid-following (GFL) — a current source synchronised to the grid: holds dispatched P (with optional fast frequency response) and Q (with voltage support on a dip), the total current hard-limited at I_max with reactive priority. Cannot form an island on its own — needs a grid or a grid-forming source.\n• Grid-forming (GFM) — a virtual synchronous machine: a voltage behind the coupling reactance with synthetic inertia and P-f droop, so it can hold an island and provide fast frequency response. Current is bounded by a virtual impedance.\nUsed by: Transient Stability.',
  'ibr_imax_pu': 'Converter current limit as a multiple of rated current (typ 1.1–1.3×). The defining converter trait — unlike a synchronous machine it will NOT push 5–15× fault current; it clips here.\nUsed by: Transient Stability.',
  'ibr_inertia_h_s': 'Synthetic (virtual) inertia constant H the grid-forming control emulates, seconds on the converter rating. Higher H slows the rate of change of frequency (df/dt) after a disturbance. 0–5 s typical; set low for a fast, near-droop response.\nUsed by: Transient Stability (grid-forming).',
  'ibr_pf_droop_pct': 'Active-power / frequency droop of the grid-forming control (% frequency change for 100% power change on the converter rating). Sets how the unit shares load and its steady frequency offset (Δf = −droop × ΔP). Typical 2–5%.\nUsed by: Transient Stability (grid-forming).',
  'ibr_xf_pu': 'Grid-forming coupling reactance (filter + step-up) in p.u. on the converter rating — the physical reactance the internal voltage sits behind. Typical 0.1–0.2 p.u. Not the fault-limit impedance; fault current is bounded by the current limit above.\nUsed by: Transient Stability (grid-forming).',
  'ibr_ffr_droop_pct': 'Fast-frequency-response droop of the grid-following control (% island-frequency change for 100% power change on the rating). The converter trims active power on the measured island frequency. 0 = no FFR (constant power). Typical 3–5% where a grid code requires it.\nUsed by: Transient Stability (grid-following).',
  'ibr_qv_gain': 'Dynamic voltage-support gain k (p.u. reactive current per p.u. voltage deviation) injected during a dip beyond a 0.1 p.u. deadband — grid-code reactive-current support (e.g. k≈2). 0 = constant reactive power.\nUsed by: Transient Stability (grid-following).',
  'ibr_p_headroom_pct': 'Upward active-power reserve above the dispatched output that fast frequency response may use (% of dispatched P). Default 0 — a PV/wind plant at its available power can only curtail, not raise. A BESS is bidirectional regardless.\nUsed by: Transient Stability (grid-following).',
  'ibr_uv_pu': 'Voltage ride-through: trip the inverter if its terminal voltage stays below this (p.u.) for longer than the ride-through delay. 0 disables. Set per the grid-code LVRT curve so a fault that clears in time is ridden through.\nUsed by: Transient Stability.',
  'ibr_uf_hz': 'Frequency ride-through: trip the inverter if the island frequency stays below this (Hz) for longer than the ride-through delay. 0 disables.\nUsed by: Transient Stability.',
  'ibr_of_hz': 'Frequency ride-through: trip the inverter if the island frequency stays above this (Hz) for longer than the ride-through delay. 0 disables.\nUsed by: Transient Stability.',
  'ibr_trip_delay_s': 'Ride-through time: how long a voltage/frequency violation must persist before the inverter trips. Model the grid-code ride-through window here (e.g. 0.15–0.5 s).\nUsed by: Transient Stability.',

  // Solar PV — array / DC strings (IEC 62548)
  'solar_pv.pv_array_mode': 'Rated kW (AC): enter the plant size directly (legacy behaviour).\nStrings × Panels (DC): size the array physically — output follows panels × strings × irradiance, clipped at the inverter, and IEC 62548 string checks run live in Calculated Values.',
  'solar_pv.pv_panel_type': 'Preset module classes with typical STC datasheet values (Voc, Vmp, Isc, Imp, temperature coefficients).\nPicking one fills the fields below; override any value from your module\'s datasheet.',
  'solar_pv.pv_panel_w':    'Module power at STC (1000 W/m², 25 °C cell, AM1.5). The kWp headline figure on the datasheet.',
  'solar_pv.pv_panels_per_string': 'Modules in series per string. Sets the string voltage:\n• too many → cold Voc exceeds the inverter max DC input\n• too few → hot Vmp drops out of the MPPT window.\nBoth are checked live below.',
  'solar_pv.pv_strings':    'Parallel strings per inverter. Sets the array current and DC kWp; strings are distributed across the MPPT trackers for the current check.',
  'solar_pv.pv_voc':        'Module open-circuit voltage at STC. Rises in cold weather — the coldest-morning value (checked below) must stay under the inverter\'s max DC input voltage.\nSource: IEC 62548 §7.2.',
  'solar_pv.pv_vmp':        'Module maximum-power-point voltage at STC. Falls with heat — the hot-cell value must stay inside the MPPT window for the inverter to track peak power.',
  'solar_pv.pv_isc':        'Module short-circuit current at STC. Design current per IEC 62548 §7.3 is 1.25 × Isc (irradiance can exceed STC); used for the MPPT input-current check.',
  'solar_pv.pv_imp':        'Module maximum-power-point current at STC. Informational for cable sizing; the string check uses 1.25 × Isc.',
  'solar_pv.pv_beta_voc':   'Voc temperature coefficient, %/°C (negative). Typical −0.24 to −0.30 for crystalline silicon.\nUsed to project Voc at the site minimum ambient: Voc × (1 + β(Tmin − 25)/100).',
  'solar_pv.pv_gamma_vmp':  'Vmp (or Pmax) temperature coefficient, %/°C (negative). Typically slightly more negative than β_Voc: −0.30 to −0.40.\nUsed to project Vmp at the maximum cell temperature.',
  'solar_pv.mppt_count':    'Independent MPPT trackers on the inverter (datasheet). Strings are assumed spread evenly — the current check uses ceil(strings ÷ trackers) per MPPT.',
  'solar_pv.mppt_min_v':    'Bottom of the inverter\'s MPPT operating window (datasheet "MPPT voltage range"). The hot-weather string Vmp must stay above it.',
  'solar_pv.mppt_max_v':    'Top of the MPPT operating window. The string Vmp must stay below it (Voc is checked against Max DC Input Voltage, which is usually higher).',
  'solar_pv.dc_max_v':      'Absolute maximum DC input voltage of the inverter (datasheet, typ. 600 V single-phase / 1000–1100 V three-phase).\nThe coldest-morning string Voc must never exceed it — hard equipment limit per IEC 62548 §7.2.',
  'solar_pv.mppt_max_a':    'Maximum input (or short-circuit) current per MPPT tracker from the datasheet.\nChecked against 1.25 × Isc × strings-per-MPPT.',
  'solar_pv.site_temp_min_c': 'Lowest expected ambient at the site — the worst case for Voc (record low, not average).\nDefault −5 °C suits most of South Africa; use site climate data.',
  'solar_pv.site_cell_temp_max_c': 'Highest expected CELL temperature — typically ambient + 25–35 °C for roof-mounted modules. Default 70 °C.\nWorst case for Vmp dropping out of the MPPT window.',

  // Solar PV — hybrid battery (shared with the BESS component)
  'solar_pv.battery_kwh':   'Total installed battery capacity (all units on this inverter). Usable energy = capacity × usable DoD.',
  'solar_pv.battery_dod_pct': 'Usable depth of discharge — how far the BMS lets the battery run down. LiFePO₄ typically 80–90%; the remainder is a protected reserve floor.',
  'solar_pv.battery_max_charge_kw': 'Battery-side charge power limit (BMS/inverter datasheet). Charging draws this from PV first, then the grid.',
  'solar_pv.battery_max_discharge_kw': 'Battery-side discharge power limit. In a DC-coupled hybrid the AC output is additionally capped by the inverter headroom left after PV output.',
  'solar_pv.battery_rt_eff': 'Round-trip (charge→discharge) energy efficiency. LiFePO₄ typically 0.92–0.96.\nAutonomy calculations derate stored energy by the one-way efficiency √η.',
  'solar_pv.battery_soc_pct': 'State of charge for this study snapshot. Gates behaviour: no discharge at the DoD reserve floor, no charging at 100%.',
  'solar_pv.battery_mode':  'auto: self-consumption — discharges into the site\'s renewable shortfall, charges from PV surplus (grid-following).\ncharging / discharging: force a fixed set-point.\nidle: battery inert. Only "discharging" lets the unit form an island in a grid outage.',

  // BESS (same battery parameters as the hybrid PV)
  'battery.rated_kva':      'AC nameplate of the battery inverter — caps charge and discharge power and sets the fault contribution base.',
  'battery.battery_kwh':    'Total installed battery capacity. Usable energy = capacity × usable DoD.',
  'battery.battery_dod_pct': 'Usable depth of discharge — how far the BMS lets the battery run down. LiFePO₄ typically 80–90%.',
  'battery.battery_max_charge_kw': 'Charge power limit (BMS/inverter datasheet), also capped by the inverter kVA.',
  'battery.battery_max_discharge_kw': 'Discharge power limit, also capped by the inverter kVA.',
  'battery.battery_rt_eff': 'Round-trip energy efficiency. LiFePO₄ typically 0.92–0.96; autonomy uses the one-way √η.',
  'battery.battery_chemistry': 'Cell chemistry — sets the discharge model: OCV-vs-SoC curve, 1C voltage sag (LFP 3% / NMC 5% / lead-acid 10%), low-voltage cutoff and the Peukert exponent (lead-acid k=1.25: a 2× discharge rate empties the bank in H/2^k hours, not H/2).\nUsed by: Battery Sizing & Discharge.',
  'battery.battery_nominal_v': 'Nominal DC bus voltage of the bank (e.g. 48 V). Only used to convert the required kWh into an Ah rating on the sizing report.\nUsed by: Battery Sizing & Discharge.',
  'battery.battery_hour_rating_h': 'Hour rating H the capacity is quoted at (lead-acid typically C10 = 10 h; Li-ion 1 h). The Peukert correction references this rate.\nUsed by: Battery Sizing & Discharge.',
  'battery.battery_soc_pct': 'State of charge for this study snapshot — gates charge/discharge availability.',
  'battery.battery_mode':   'auto: self-consumption (grid-following).\ncharging / discharging: fixed set-point.\nidle: inert. Only "discharging" lets the BESS act as the island reference in a grid outage.',
  'battery.fault_contribution_pu': 'Inverter fault current limit as a multiple of rated current. Default 1.1×.\nSource: IEC TR 60909-4 — converter sources are current-limited.',

  // Bus — DC system
  'bus.system': 'AC bus (default) participates in fault / load-flow / arc-flash / grounding studies.\nDC bus feeds the DC Load Flow and DC Short Circuit (IEC 61660) studies instead, and is skipped by the AC engines.',
  'bus.voltage_dc_v': 'Nominal DC voltage of the busbar (e.g. 110 / 125 / 220 Vdc). Used as the reference for DC bus voltage-drop reporting.',

  // DC Battery (IEC 61660 battery source + DC load-flow source)
  'dc_battery.nominal_v': 'Nominal DC voltage U_nB of the bank (source voltage in DC load flow). For the IEC 61660-1 short-circuit calc the EMF defaults to E_B = 1.05·U_nB unless an explicit Open-circuit EMF is entered.',
  'dc_battery.ah_capacity': 'Ampere-hour capacity (C-rating basis). Used for the default load-flow discharge cap (10 C) when Max Discharge is left at 0.',
  'dc_battery.emf_v': 'Measured open-circuit EMF E_B (V) for the IEC 61660-1 short-circuit calc. Leave 0 to use the standard estimate E_B = 1.05·U_nB when the true OCV is unknown.',
  'dc_battery.internal_r_mohm': 'Battery internal resistance R_B including cell interconnectors (mΩ). Per IEC 61660-1 the peak uses 0.9·R_B and the quasi-steady I_k the full R_B: i_p = E_B/(0.9·R_B + R_net), I_k = 0.95·E_B/(R_B + R_net).',
  'dc_battery.internal_l_uh': 'Internal + connection inductance (µH). Sets the short-circuit rise-time constant τ = L_BBr/R_BBr; when 0, the IEC 61660-1 battery time constant T_B ≈ 30 ms is used.',
  'dc_battery.max_discharge_a': 'Optional discharge current cap for load flow. 0 = auto (10 × capacity). Does not limit the short-circuit calc.',

  // DC Load
  'dc_load.load_model': 'constant_power: draws fixed kW (I = P/V — telecom/electronic loads).\nconstant_current: fixed A regardless of voltage.\nconstant_resistance: fixed Ω (heaters/lamps — I rises with voltage).',
  'dc_load.load_kw': 'Active power drawn at the DC bus (constant-power model).',
  'dc_load.load_a': 'Current drawn (constant-current model).',
  'dc_load.resistance_ohm': 'Load resistance (constant-resistance model). Current = V / R.',
  'dc_load.nominal_v': 'Nominal supply voltage for reference (display only).',
};

// ─── Distribution Board — default circuit load types ───
// Presets used by the DB circuit-schedule editor (DBSchedule) to pre-fill a
// way from a common load. `va` is the connected VA per unit; `unit` is the
// counted item (a lighting "point", a "socket", …). `df` is the per-way
// demand factor (IEC 60439/61439 typical: lighting 1.0, socket outlets 0.4,
// motor groups 0.5–0.8). `per_circuit` is the default number of units when a
// whole circuit is added at once. Breaker/curve/cable follow SANS 10142-1
// common practice for a domestic/commercial LV board.
// `leak_ma` is the typical standing earth-leakage per unit (mA) from EMC
// filter capacitors and insulation, taken from product-standard limits:
// IEC 60335-1 §13 (portable Class I ≤ 0.75 mA, heating 0.75 mA/kW capped
// at 5 mA), IEC 62368-1 (pluggable IT ≤ 3.5 mA), IEC 61851 (EV charger
// ≤ 3.5 mA on the AC side), IEC 61347 (LED drivers, typ. 0.3–0.5 mA).
// `pf` is each preset's typical circuit power factor. It seeds a new way's
// per-circuit power_factor, which DBSchedule.recompute rolls up (P/Q vector
// sum) into the board-level power_factor the analyses read.
const DB_LOAD_TYPES = [
  { key: 'lighting',   label: 'Lighting',          va: 100,  unit: 'point',   df: 1.0, poles: '1P', breaker_a: 10, curve: 'B', cable_mm2: 1.5, per_circuit: 10, leak_ma: 0.4, pf: 0.95 },
  { key: 'socket',     label: 'Socket Outlet',     va: 200,  unit: 'socket',  df: 0.4, poles: '1P', breaker_a: 20, curve: 'B', cable_mm2: 2.5, per_circuit: 6,  leak_ma: 0.75, pf: 0.9 },
  { key: 'geyser',     label: 'Geyser',            va: 3000, unit: 'geyser',  df: 1.0, poles: '1P', breaker_a: 20, curve: 'C', cable_mm2: 2.5, per_circuit: 1,  leak_ma: 2.25, pf: 1.0 },
  { key: 'stove',      label: 'Stove / Oven',      va: 6000, unit: 'stove',   df: 1.0, poles: '1P', breaker_a: 40, curve: 'C', cable_mm2: 6,   per_circuit: 1,  leak_ma: 4.5, pf: 1.0 },
  { key: 'aircon',     label: 'Air Conditioner',   va: 2500, unit: 'unit',    df: 1.0, poles: '1P', breaker_a: 20, curve: 'C', cable_mm2: 2.5, per_circuit: 1,  leak_ma: 1.5, pf: 0.85 },
  { key: 'ev_charger', label: 'EV Charger',        va: 7400, unit: 'charger', df: 1.0, poles: '1P', breaker_a: 40, curve: 'C', cable_mm2: 6,   per_circuit: 1,  leak_ma: 3.5, pf: 0.98 },
  { key: 'heat_pump',  label: 'Heat Pump',         va: 1500, unit: 'unit',    df: 1.0, poles: '1P', breaker_a: 16, curve: 'C', cable_mm2: 2.5, per_circuit: 1,  leak_ma: 1.5, pf: 0.85 },
  { key: 'motor_3ph',  label: 'Motor (3φ)',        va: 4000, unit: 'motor',   df: 0.8, poles: '3P', breaker_a: 16, curve: 'D', cable_mm2: 2.5, per_circuit: 1,  leak_ma: 2.0, pf: 0.85 },
  { key: 'spare',      label: 'Spare',             va: 0,    unit: 'way',     df: 1.0, poles: '1P', breaker_a: 20, curve: 'C', cable_mm2: 2.5, per_circuit: 1,  leak_ma: 0, pf: 1.0 },
  // Outgoing feeder to a downstream sub-board. Carries no lumped load itself
  // (the sub-board models its own demand); on the SLD it renders as an
  // outgoing bus below the board that the sub-board's incomer connects to.
  { key: 'feeder_db',  label: 'Feeder to Sub-board', va: 0,  unit: 'board',   df: 1.0, poles: '3P', breaker_a: 63, curve: 'C', cable_mm2: 25,  per_circuit: 1,  leak_ma: 0, pf: 0.9 },
];

// Standing earth-leakage of the cable itself (insulation capacitance to
// earth): ≈ 0.5 mA per 100 m for LV PVC/XLPE, added per way from cable_m.
const DB_CABLE_LEAK_MA_PER_M = 0.005;
// IEC 60364-5-53 §531.3.2: standing leakage on an RCD-protected group
// should not exceed 30% of IΔn — an RCD is permitted to trip anywhere
// between 50% and 100% of its rated residual current.
const DB_EL_STANDING_LIMIT = 0.3;
// Common earth-leakage unit rated residual currents (IΔn, mA)
const DB_EL_RATINGS_MA = [10, 30, 100, 300, 500];

const COMPONENT_DEFS = {
  // --- Sources ---
  utility: {
    name: 'Utility Source',
    category: 'sources',
    ports: [{ id: 'out', side: 'bottom', offset: 0 }],
    width: 60,
    height: 50,
    defaults: {
      name: 'Utility',
      voltage_kv: 33,
      fault_mva: 500,
      x_r_ratio: 15,
      z2_z1_ratio: 1.0,
      z0_z1_ratio: 1.0,
      dispatch_priority: 3,
      cost_per_mwh: 120,
      allow_export: 'yes',
      supply_capacity_mva: 0,
      lf_grid_model: 'infinite',
      v_setpoint_pu: 1.0,
      earthing_system: 'TN-S',
      earth_electrode_r_source: 1.0,
      earth_electrode_r_installation: 20.0,
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'voltage_kv', label: 'Voltage', type: 'number', unit: 'kV', unitOptions: [{ label: 'kV', mult: 1 }, { label: 'V', mult: 0.001 }] },
      { key: 'fault_mva', label: 'Fault Level', type: 'number', unit: 'MVA', unitOptions: [{ label: 'MVA', mult: 1 }, { label: 'kVA', mult: 0.001 }] },
      { key: 'x_r_ratio', label: 'X/R Ratio', type: 'number' },
      { key: 'z2_z1_ratio', label: 'Z₂/Z₁ Ratio', type: 'number', min: 0.5, max: 2, step: 0.1, section: 'fault' },
      { key: 'z0_z1_ratio', label: 'Z₀/Z₁ Ratio', type: 'number', min: 0.5, max: 5, step: 0.1, section: 'fault' },
      { key: 'earthing_system', label: 'Earthing System (LV)', type: 'select',
        options: ['TN-S', 'TN-C', 'TN-C-S', 'TT', 'IT'],
        showWhen: { field: 'voltage_kv', max: 1.0 }, section: 'grounding' },
      { key: 'earth_electrode_r_source', label: 'Source Earth R_B', type: 'number', unit: 'Ω',
        showWhen: { field: 'earthing_system', values: ['TT', 'IT'] }, section: 'grounding' },
      { key: 'earth_electrode_r_installation', label: 'Installation Earth R_A', type: 'number', unit: 'Ω',
        showWhen: { field: 'earthing_system', values: ['TT'] }, section: 'grounding' },
      { key: 'dispatch_priority', label: 'Dispatch Priority', type: 'number', min: 1, max: 10, step: 1, section: 'loadflow' },
      { key: 'cost_per_mwh', label: 'Marginal Cost', type: 'number', unit: '/MWh', min: 0, step: 5, section: 'loadflow' },
      { key: 'allow_export', label: 'Allow Export', type: 'select', options: ['yes', 'no'], section: 'loadflow' },
      { key: 'supply_capacity_mva', label: 'Supply Capacity (0 = unlimited)', type: 'number', unit: 'MVA', min: 0, step: 0.1, section: 'loadflow' },
      { key: 'lf_grid_model', label: 'Grid Model (Load Flow)', type: 'select',
        options: [
          { value: 'infinite', label: 'Infinite bus (ideal)' },
          { value: 'thevenin', label: 'Thevenin — impedance from fault level' },
        ], section: 'loadflow' },
      { key: 'v_setpoint_pu', label: 'Voltage Setpoint', type: 'number', unit: 'pu', min: 0.9, max: 1.1, step: 0.005, section: 'loadflow' },
      { key: 'failure_rate_per_yr', label: 'Grid Interruptions', type: 'number', unit: '/yr', min: 0, step: 0.1, section: 'reliability' },
      { key: 'repair_time_h', label: 'Mean Duration', type: 'number', unit: 'h', min: 0, step: 0.5, section: 'reliability' },
    ],
  },
  generator: {
    name: 'Generator',
    category: 'sources',
    ports: [{ id: 'out', side: 'bottom', offset: 0 }],
    width: 60,
    height: 50,
    defaults: {
      name: 'Gen',
      prime_mover: 'diesel',
      rated_mva: 10,
      voltage_kv: 11,
      xd_pp: 0.15,
      xd_p: 0.25,
      xd: 1.2,
      x_r_ratio: 40,
      power_factor: 0.85,
      x2: 0,
      x0: 0,
      dispatch_priority: 2,
      cost_per_mwh: 180,
      dispatch_mode: 'standby',
      min_load_pct: 30,
      max_load_pct: 100,
      gen_control: 'droop',
      start_threshold_pct: 90,
      inertia_h_s: 1.5,
      damping_pu: 0,
      machine_model: 'classical',
      xq: 0.7,
      tdo_p: 6.0,
      tqo_p: 1.0,
      gov_mode: 'isochronous',
      gov_droop_pct: 4,
      gov_time_const_s: 0.5,
      gov_reset_time_s: 5,
      avr_mode: 'on',
      avr_gain: 25,
      avr_time_const_s: 0.2,
      trip_of_hz: 0,
      trip_uf_hz: 0,
      trip_uv_pu: 0,
      trip_delay_s: 0.2,
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'prime_mover', label: 'Prime Mover', type: 'select', options: [
        { value: 'diesel', label: 'Diesel Engine' },
        { value: 'gas_engine', label: 'Gas Engine' },
        { value: 'gas_turbine', label: 'Gas Turbine' },
        { value: 'steam_turbine', label: 'Steam Turbine' },
        { value: 'hydro', label: 'Hydro Turbine' },
        { value: 'wind', label: 'Wind Turbine' },
        { value: 'other', label: 'Other' },
      ] },
      { key: 'rated_mva', label: 'Rating', type: 'number', unit: 'MVA', unitOptions: [{ label: 'MVA', mult: 1 }, { label: 'kVA', mult: 0.001 }] },
      { key: 'voltage_kv', label: 'Voltage', type: 'number', unit: 'kV', unitOptions: [{ label: 'kV', mult: 1 }, { label: 'V', mult: 0.001 }] },
      { key: 'power_factor', label: 'Power Factor', type: 'number' },
      { key: 'dispatch_priority', label: 'Dispatch Priority', type: 'number', min: 1, max: 10, step: 1, section: 'loadflow' },
      { key: 'cost_per_mwh', label: 'Marginal Cost', type: 'number', unit: '/MWh', min: 0, step: 5, section: 'loadflow' },
      { key: 'dispatch_mode', label: 'Dispatch Mode', type: 'select', options: ['must_run', 'merit_order', 'standby'], section: 'loadflow' },
      { key: 'min_load_pct', label: 'Minimum Load', type: 'number', unit: '%', min: 0, max: 100, step: 5, section: 'loadflow' },
      { key: 'max_load_pct', label: 'Maximum Load', type: 'number', unit: '%', min: 0, max: 100, step: 5, section: 'loadflow' },
      { key: 'gen_control', label: 'Control Scheme', type: 'select', options: ['droop', 'sequential'], section: 'loadflow' },
      { key: 'start_threshold_pct', label: 'Start Threshold', type: 'number', unit: '%', min: 50, max: 100, step: 5, section: 'loadflow', showWhen: { field: 'gen_control', values: ['sequential'] } },
      { key: 'q_max_mvar', label: 'Q Max (over-excited)', type: 'number', unit: 'MVAr', step: 0.1, placeholder: 'auto (rated pf)', clearable: true, section: 'loadflow' },
      { key: 'q_min_mvar', label: 'Q Min (under-excited)', type: 'number', unit: 'MVAr', step: 0.1, placeholder: 'auto (rated pf)', clearable: true, section: 'loadflow' },
      { key: 'xd_pp', label: "Xd''", type: 'number', unit: 'p.u.', section: 'fault' },
      { key: 'xd_p', label: "Xd'", type: 'number', unit: 'p.u.', section: 'fault' },
      { key: 'xd', label: 'Xd', type: 'number', unit: 'p.u.', section: 'fault' },
      { key: 'x2', label: 'X₂ (neg. seq.)', type: 'number', unit: 'p.u.', section: 'fault' },
      { key: 'x0', label: 'X₀ (zero seq.)', type: 'number', unit: 'p.u.', section: 'fault' },
      { key: 'x_r_ratio', label: 'X/R Ratio', type: 'number', section: 'fault' },
      { key: 'inertia_h_s', label: 'Inertia Constant H', type: 'number', unit: 's', section: 'stability', min: 0.1 },
      { key: 'damping_pu', label: 'Damping D', type: 'number', unit: 'p.u.', section: 'stability', min: 0 },
      { key: 'machine_model', label: 'Machine Model', type: 'select', options: ['classical', 'two_axis'], section: 'stability' },
      { key: 'xq', label: 'Xq (synchronous)', type: 'number', unit: 'p.u.', min: 0.1, step: 0.05, section: 'stability', showWhen: { field: 'machine_model', values: ['two_axis'] } },
      { key: 'tdo_p', label: "T'do", type: 'number', unit: 's', min: 0.1, step: 0.5, section: 'stability', showWhen: { field: 'machine_model', values: ['two_axis'] } },
      { key: 'tqo_p', label: "T'qo", type: 'number', unit: 's', min: 0.1, step: 0.5, section: 'stability', showWhen: { field: 'machine_model', values: ['two_axis'] } },
      { key: 'gov_mode', label: 'Governor', type: 'select', options: ['isochronous', 'droop', 'none'], section: 'stability' },
      { key: 'gov_droop_pct', label: 'Governor Droop', type: 'number', unit: '%', min: 0.5, max: 10, step: 0.5, section: 'stability', showWhen: { field: 'gov_mode', values: ['isochronous', 'droop'] } },
      { key: 'gov_time_const_s', label: 'Governor Time Const', type: 'number', unit: 's', min: 0.05, step: 0.05, section: 'stability', showWhen: { field: 'gov_mode', values: ['isochronous', 'droop'] } },
      { key: 'gov_reset_time_s', label: 'Isoch. Reset Time', type: 'number', unit: 's', min: 0.5, step: 0.5, section: 'stability', showWhen: { field: 'gov_mode', values: ['isochronous'] } },
      { key: 'avr_mode', label: 'AVR / Exciter', type: 'select', options: ['on', 'off'], section: 'stability' },
      { key: 'avr_gain', label: 'AVR Gain Ka', type: 'number', min: 1, step: 5, section: 'stability', showWhen: { field: 'avr_mode', values: ['on'] } },
      { key: 'avr_time_const_s', label: 'AVR Time Const', type: 'number', unit: 's', min: 0.01, step: 0.05, section: 'stability', showWhen: { field: 'avr_mode', values: ['on'] } },
      { key: 'trip_of_hz', label: 'Over-freq Trip', type: 'number', unit: 'Hz', min: 0, step: 0.1, section: 'protection' },
      { key: 'trip_uf_hz', label: 'Under-freq Trip', type: 'number', unit: 'Hz', min: 0, step: 0.1, section: 'protection' },
      { key: 'trip_uv_pu', label: 'Under-voltage Trip', type: 'number', unit: 'p.u.', min: 0, max: 1, step: 0.05, section: 'protection' },
      { key: 'trip_delay_s', label: 'Trip Delay', type: 'number', unit: 's', min: 0, step: 0.05, section: 'protection' },
    ],
  },

  solar_pv: {
    name: 'Solar PV',
    label: 'Solar PV Inverter',
    category: 'sources',
    ports: [{ id: 'out', side: 'bottom', offset: 0 }],
    width: 60,
    height: 50,
    defaults: {
      name: 'PV',
      rated_kw: 100,
      voltage_kv: 0.4,
      num_inverters: 1,
      inverter_eff: 0.97,
      power_factor: 1.0,
      var_mode: 'power_factor',
      v_setpoint_pu: 1.0,
      mppt_tracking: 'fixed',
      inverter_type: 'grid_tied',
      pv_array_mode: 'rated',
      pv_panel_type: '',
      pv_panel_w: 550,
      pv_panels_per_string: 10,
      pv_strings: 2,
      pv_voc: 49.9,
      pv_vmp: 41.95,
      pv_isc: 14.0,
      pv_imp: 13.12,
      pv_beta_voc: -0.26,
      pv_gamma_vmp: -0.34,
      mppt_min_v: 200,
      mppt_max_v: 800,
      dc_max_v: 1000,
      mppt_count: 2,
      mppt_max_a: 26,
      site_temp_min_c: -5,
      site_cell_temp_max_c: 70,
      battery_kwh: 100,
      battery_dod_pct: 90,
      battery_max_charge_kw: 50,
      battery_max_discharge_kw: 50,
      battery_rt_eff: 0.95,
      battery_soc_pct: 100,
      battery_chemistry: 'lfp',
      battery_nominal_v: 48,
      battery_hour_rating_h: 1,
      battery_mode: 'auto',
      fault_contribution_pu: 1.1,
      irradiance_pct: 100,
      dispatch_priority: 1,
      cost_per_mwh: 0,
      dispatch_mode: 'must_run',
      ibr_ctrl: 'frozen',
      ibr_imax_pu: 1.2,
      ibr_inertia_h_s: 3.0,
      ibr_pf_droop_pct: 5,
      ibr_xf_pu: 0.15,
      ibr_ffr_droop_pct: 0,
      ibr_qv_gain: 2.0,
      ibr_p_headroom_pct: 0,
      ibr_uv_pu: 0,
      ibr_uf_hz: 0,
      ibr_of_hz: 0,
      ibr_trip_delay_s: 0.2,
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'rated_kw', label: 'Rated Power (per inverter)', type: 'number', unit: 'kW', unitOptions: [{ label: 'kW', mult: 1 }, { label: 'MW', mult: 1000 }] },
      { key: 'voltage_kv', label: 'Voltage', type: 'number', unit: 'kV', unitOptions: [{ label: 'kV', mult: 1 }, { label: 'V', mult: 0.001 }] },
      { key: 'num_inverters', label: 'No. of Inverters (× rated power)', type: 'number', min: 1, step: 1 },
      { key: 'inverter_eff', label: 'Inverter Efficiency', type: 'number', unit: 'p.u.', min: 0.8, max: 1.0, step: 0.01 },
      { key: 'power_factor', label: 'Power Factor', type: 'number', min: -1, max: 1, step: 0.01 },
      { key: 'var_mode', label: 'Reactive Control', type: 'select', section: 'loadflow', options: [
        { value: 'power_factor', label: 'Follow power factor' },
        { value: 'voltage', label: 'Voltage regulating' },
        { value: 'unity', label: 'Unity (no vars)' },
      ] },
      { key: 'v_setpoint_pu', label: 'Voltage Setpoint', type: 'number', unit: 'pu', min: 0.9, max: 1.1,
        step: 0.005, section: 'loadflow', showWhen: { field: 'var_mode', values: ['voltage'] } },
      { key: 'mppt_tracking', label: 'MPPT Mode', type: 'select', options: ['fixed', 'tracking'] },
      { key: 'inverter_type', label: 'Inverter Type', type: 'select', options: ['grid_tied', 'hybrid'] },
      { key: 'pv_array_mode', label: 'PV Sizing Mode', type: 'select',
        options: [
          { value: 'rated', label: 'Rated kW (AC)' },
          { value: 'array', label: 'Strings × Panels (DC)' },
        ] },
      { key: 'pv_panel_type', label: 'Panel Module', type: 'standard_select', library: 'pv_panel',
        showWhen: { field: 'pv_array_mode', values: ['array'] }, section: 'pv' },
      { key: 'pv_panel_w', label: 'Panel Rating', type: 'number', unit: 'W', min: 50, step: 5,
        showWhen: { field: 'pv_array_mode', values: ['array'] }, section: 'pv' },
      { key: 'pv_panels_per_string', label: 'Panels per String', type: 'number', min: 1, step: 1,
        showWhen: { field: 'pv_array_mode', values: ['array'] }, section: 'pv' },
      { key: 'pv_strings', label: 'Strings (per inverter)', type: 'number', min: 1, step: 1,
        showWhen: { field: 'pv_array_mode', values: ['array'] }, section: 'pv' },
      { key: 'pv_voc', label: 'Panel Voc (STC)', type: 'number', unit: 'V', min: 0, step: 0.1,
        showWhen: { field: 'pv_array_mode', values: ['array'] }, section: 'pv' },
      { key: 'pv_vmp', label: 'Panel Vmp (STC)', type: 'number', unit: 'V', min: 0, step: 0.1,
        showWhen: { field: 'pv_array_mode', values: ['array'] }, section: 'pv' },
      { key: 'pv_isc', label: 'Panel Isc (STC)', type: 'number', unit: 'A', min: 0, step: 0.1,
        showWhen: { field: 'pv_array_mode', values: ['array'] }, section: 'pv' },
      { key: 'pv_imp', label: 'Panel Imp (STC)', type: 'number', unit: 'A', min: 0, step: 0.1,
        showWhen: { field: 'pv_array_mode', values: ['array'] }, section: 'pv' },
      { key: 'pv_beta_voc', label: 'Voc Temp Coeff', type: 'number', unit: '%/°C', min: -1, max: 0, step: 0.01,
        showWhen: { field: 'pv_array_mode', values: ['array'] }, section: 'pv' },
      { key: 'pv_gamma_vmp', label: 'Vmp Temp Coeff', type: 'number', unit: '%/°C', min: -1, max: 0, step: 0.01,
        showWhen: { field: 'pv_array_mode', values: ['array'] }, section: 'pv' },
      { key: 'mppt_count', label: 'MPPT Trackers', type: 'number', min: 1, step: 1,
        showWhen: { field: 'pv_array_mode', values: ['array'] }, section: 'pv' },
      { key: 'mppt_min_v', label: 'MPPT Min Voltage', type: 'number', unit: 'V', min: 0, step: 5,
        showWhen: { field: 'pv_array_mode', values: ['array'] }, section: 'pv' },
      { key: 'mppt_max_v', label: 'MPPT Max Voltage', type: 'number', unit: 'V', min: 0, step: 5,
        showWhen: { field: 'pv_array_mode', values: ['array'] }, section: 'pv' },
      { key: 'dc_max_v', label: 'Max DC Input Voltage', type: 'number', unit: 'V', min: 0, step: 10,
        showWhen: { field: 'pv_array_mode', values: ['array'] }, section: 'pv' },
      { key: 'mppt_max_a', label: 'Max Input Current / MPPT', type: 'number', unit: 'A', min: 0, step: 0.5,
        showWhen: { field: 'pv_array_mode', values: ['array'] }, section: 'pv' },
      { key: 'site_temp_min_c', label: 'Site Min Ambient', type: 'number', unit: '°C', min: -40, max: 25, step: 1,
        showWhen: { field: 'pv_array_mode', values: ['array'] }, section: 'pv' },
      { key: 'site_cell_temp_max_c', label: 'Max Cell Temperature', type: 'number', unit: '°C', min: 25, max: 100, step: 1,
        showWhen: { field: 'pv_array_mode', values: ['array'] }, section: 'pv' },
      { key: 'battery_kwh', label: 'Battery Capacity (total)', type: 'number', unit: 'kWh', min: 0, step: 1,
        showWhen: { field: 'inverter_type', values: ['hybrid'] }, section: 'battery' },
      { key: 'battery_dod_pct', label: 'Usable Depth of Discharge', type: 'number', unit: '%', min: 0, max: 100, step: 5,
        showWhen: { field: 'inverter_type', values: ['hybrid'] }, section: 'battery' },
      { key: 'battery_max_charge_kw', label: 'Max Charge Power', type: 'number', unit: 'kW', min: 0, step: 1,
        showWhen: { field: 'inverter_type', values: ['hybrid'] }, section: 'battery' },
      { key: 'battery_max_discharge_kw', label: 'Max Discharge Power', type: 'number', unit: 'kW', min: 0, step: 1,
        showWhen: { field: 'inverter_type', values: ['hybrid'] }, section: 'battery' },
      { key: 'battery_rt_eff', label: 'Round-trip Efficiency', type: 'number', unit: 'p.u.', min: 0.5, max: 1.0, step: 0.01,
        showWhen: { field: 'inverter_type', values: ['hybrid'] }, section: 'battery' },
      { key: 'battery_soc_pct', label: 'State of Charge', type: 'number', unit: '%', min: 0, max: 100, step: 5,
        showWhen: { field: 'inverter_type', values: ['hybrid'] }, section: 'battery' },
      { key: 'battery_chemistry', label: 'Chemistry', type: 'select',
        options: [{ value: 'lfp', label: 'LFP (LiFePO4)' }, { value: 'nmc', label: 'Li-ion NMC' }, { value: 'lead_acid', label: 'Lead-acid' }],
        showWhen: { field: 'inverter_type', values: ['hybrid'] }, section: 'battery' },
      { key: 'battery_nominal_v', label: 'Nominal DC Voltage', type: 'number', unit: 'V', min: 12, step: 1,
        showWhen: { field: 'inverter_type', values: ['hybrid'] }, section: 'battery' },
      { key: 'battery_hour_rating_h', label: 'Hour Rating', type: 'number', unit: 'h', min: 0.5, step: 0.5,
        showWhen: { field: 'inverter_type', values: ['hybrid'] }, section: 'battery' },
      { key: 'battery_mode', label: 'Battery Mode', type: 'select', options: ['auto', 'charging', 'discharging', 'idle'],
        showWhen: { field: 'inverter_type', values: ['hybrid'] }, section: 'battery' },
      { key: 'fault_contribution_pu', label: 'Fault Contribution', type: 'number', unit: '×Irated', min: 1.0, max: 2.0, step: 0.1, section: 'fault' },
      { key: 'irradiance_pct', label: 'Irradiance', type: 'number', unit: '%', min: 0, max: 100, step: 5 },
      { key: 'dispatch_priority', label: 'Dispatch Priority', type: 'number', min: 1, max: 10, step: 1, section: 'loadflow' },
      { key: 'cost_per_mwh', label: 'Marginal Cost', type: 'number', unit: '/MWh', min: 0, step: 5, section: 'loadflow' },
      { key: 'dispatch_mode', label: 'Dispatch Mode', type: 'select', options: ['must_run', 'merit_order', 'standby'], section: 'loadflow' },
      { key: 'ibr_ctrl', label: 'Converter Model (Stability)', type: 'select',
        options: [
          { value: 'frozen', label: 'Frozen (constant admittance)' },
          { value: 'grid_following', label: 'Grid-following (GFL)' },
          { value: 'grid_forming', label: 'Grid-forming (GFM)' },
        ], section: 'stability' },
      { key: 'ibr_imax_pu', label: 'Current Limit', type: 'number', unit: '×Irated', min: 1.0, max: 2.0, step: 0.05, section: 'stability',
        showWhen: { field: 'ibr_ctrl', values: ['grid_following', 'grid_forming'] } },
      { key: 'ibr_inertia_h_s', label: 'Synthetic Inertia H', type: 'number', unit: 's', min: 0, step: 0.5, section: 'stability',
        showWhen: { field: 'ibr_ctrl', values: ['grid_forming'] } },
      { key: 'ibr_pf_droop_pct', label: 'P-f Droop', type: 'number', unit: '%', min: 0.5, max: 20, step: 0.5, section: 'stability',
        showWhen: { field: 'ibr_ctrl', values: ['grid_forming'] } },
      { key: 'ibr_xf_pu', label: 'Coupling Reactance Xf', type: 'number', unit: 'p.u.', min: 0.02, max: 0.5, step: 0.01, section: 'stability',
        showWhen: { field: 'ibr_ctrl', values: ['grid_forming'] } },
      { key: 'ibr_ffr_droop_pct', label: 'Fast Freq Response Droop', type: 'number', unit: '%', min: 0, max: 20, step: 0.5, section: 'stability',
        showWhen: { field: 'ibr_ctrl', values: ['grid_following'] } },
      { key: 'ibr_qv_gain', label: 'Voltage Support Gain k', type: 'number', unit: 'p.u.', min: 0, max: 10, step: 0.5, section: 'stability',
        showWhen: { field: 'ibr_ctrl', values: ['grid_following'] } },
      { key: 'ibr_p_headroom_pct', label: 'Active Power Headroom', type: 'number', unit: '%', min: 0, max: 100, step: 5, section: 'stability',
        showWhen: { field: 'ibr_ctrl', values: ['grid_following'] } },
      { key: 'ibr_uv_pu', label: 'Ride-through UV Trip', type: 'number', unit: 'p.u.', min: 0, max: 1, step: 0.05, section: 'protection',
        showWhen: { field: 'ibr_ctrl', values: ['grid_following', 'grid_forming'] } },
      { key: 'ibr_uf_hz', label: 'IBR Under-freq Trip', type: 'number', unit: 'Hz', min: 0, step: 0.1, section: 'protection',
        showWhen: { field: 'ibr_ctrl', values: ['grid_following', 'grid_forming'] } },
      { key: 'ibr_of_hz', label: 'IBR Over-freq Trip', type: 'number', unit: 'Hz', min: 0, step: 0.1, section: 'protection',
        showWhen: { field: 'ibr_ctrl', values: ['grid_following', 'grid_forming'] } },
      { key: 'ibr_trip_delay_s', label: 'Ride-through Delay', type: 'number', unit: 's', min: 0, step: 0.05, section: 'protection',
        showWhen: { field: 'ibr_ctrl', values: ['grid_following', 'grid_forming'] } },
    ],
  },

  wind_turbine: {
    name: 'Wind Turbine',
    label: 'Wind Turbine Generator',
    category: 'sources',
    ports: [{ id: 'out', side: 'bottom', offset: 0 }],
    width: 60,
    height: 55,
    defaults: {
      name: 'WTG',
      rated_mva: 2.0,
      voltage_kv: 0.69,
      turbine_type: 'type3_dfig',
      xd_pp: 0.20,
      x_r_ratio: 30,
      power_factor: 0.95,
      num_turbines: 1,
      fault_contribution_pu: 1.1,
      wind_speed_pct: 100,
      dispatch_priority: 1,
      cost_per_mwh: 0,
      dispatch_mode: 'must_run',
      ibr_ctrl: 'frozen',
      ibr_imax_pu: 1.2,
      ibr_inertia_h_s: 3.0,
      ibr_pf_droop_pct: 5,
      ibr_xf_pu: 0.15,
      ibr_ffr_droop_pct: 0,
      ibr_qv_gain: 2.0,
      ibr_p_headroom_pct: 0,
      ibr_uv_pu: 0,
      ibr_uf_hz: 0,
      ibr_of_hz: 0,
      ibr_trip_delay_s: 0.2,
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'rated_mva', label: 'Rating (per turbine)', type: 'number', unit: 'MVA', unitOptions: [{ label: 'MVA', mult: 1 }, { label: 'kVA', mult: 0.001 }] },
      { key: 'voltage_kv', label: 'Voltage', type: 'number', unit: 'kV', unitOptions: [{ label: 'kV', mult: 1 }, { label: 'V', mult: 0.001 }] },
      { key: 'turbine_type', label: 'Turbine Type', type: 'select', options: ['type1_scig', 'type2_wrig', 'type3_dfig', 'type4_frc'] },
      { key: 'power_factor', label: 'Power Factor', type: 'number', min: -1, max: 1, step: 0.01 },
      { key: 'num_turbines', label: 'No. of Turbines (× rating)', type: 'number', min: 1, step: 1 },
      { key: 'xd_pp', label: "Xd'' (sub-transient)", type: 'number', unit: 'p.u.', min: 0.05, max: 1.0, step: 0.01, section: 'fault' },
      { key: 'x_r_ratio', label: 'X/R Ratio', type: 'number', min: 1, step: 1, section: 'fault' },
      { key: 'fault_contribution_pu', label: 'Fault Contribution', type: 'number', unit: '×Irated', min: 1.0, max: 6.0, step: 0.1, section: 'fault' },
      { key: 'wind_speed_pct', label: 'Wind Output', type: 'number', unit: '%', min: 0, max: 100, step: 5 },
      { key: 'dispatch_priority', label: 'Dispatch Priority', type: 'number', min: 1, max: 10, step: 1, section: 'loadflow' },
      { key: 'cost_per_mwh', label: 'Marginal Cost', type: 'number', unit: '/MWh', min: 0, step: 5, section: 'loadflow' },
      { key: 'dispatch_mode', label: 'Dispatch Mode', type: 'select', options: ['must_run', 'merit_order', 'standby'], section: 'loadflow' },
      { key: 'ibr_ctrl', label: 'Converter Model (Stability)', type: 'select',
        options: [
          { value: 'frozen', label: 'Frozen (constant admittance)' },
          { value: 'grid_following', label: 'Grid-following (GFL)' },
          { value: 'grid_forming', label: 'Grid-forming (GFM)' },
        ], section: 'stability', showWhen: { field: 'turbine_type', values: ['type4_frc'] } },
      { key: 'ibr_imax_pu', label: 'Current Limit', type: 'number', unit: '×Irated', min: 1.0, max: 2.0, step: 0.05, section: 'stability',
        showWhen: { field: 'ibr_ctrl', values: ['grid_following', 'grid_forming'] } },
      { key: 'ibr_inertia_h_s', label: 'Synthetic Inertia H', type: 'number', unit: 's', min: 0, step: 0.5, section: 'stability',
        showWhen: { field: 'ibr_ctrl', values: ['grid_forming'] } },
      { key: 'ibr_pf_droop_pct', label: 'P-f Droop', type: 'number', unit: '%', min: 0.5, max: 20, step: 0.5, section: 'stability',
        showWhen: { field: 'ibr_ctrl', values: ['grid_forming'] } },
      { key: 'ibr_xf_pu', label: 'Coupling Reactance Xf', type: 'number', unit: 'p.u.', min: 0.02, max: 0.5, step: 0.01, section: 'stability',
        showWhen: { field: 'ibr_ctrl', values: ['grid_forming'] } },
      { key: 'ibr_ffr_droop_pct', label: 'Fast Freq Response Droop', type: 'number', unit: '%', min: 0, max: 20, step: 0.5, section: 'stability',
        showWhen: { field: 'ibr_ctrl', values: ['grid_following'] } },
      { key: 'ibr_qv_gain', label: 'Voltage Support Gain k', type: 'number', unit: 'p.u.', min: 0, max: 10, step: 0.5, section: 'stability',
        showWhen: { field: 'ibr_ctrl', values: ['grid_following'] } },
      { key: 'ibr_p_headroom_pct', label: 'Active Power Headroom', type: 'number', unit: '%', min: 0, max: 100, step: 5, section: 'stability',
        showWhen: { field: 'ibr_ctrl', values: ['grid_following'] } },
      { key: 'ibr_uv_pu', label: 'Ride-through UV Trip', type: 'number', unit: 'p.u.', min: 0, max: 1, step: 0.05, section: 'protection',
        showWhen: { field: 'ibr_ctrl', values: ['grid_following', 'grid_forming'] } },
      { key: 'ibr_uf_hz', label: 'IBR Under-freq Trip', type: 'number', unit: 'Hz', min: 0, step: 0.1, section: 'protection',
        showWhen: { field: 'ibr_ctrl', values: ['grid_following', 'grid_forming'] } },
      { key: 'ibr_of_hz', label: 'IBR Over-freq Trip', type: 'number', unit: 'Hz', min: 0, step: 0.1, section: 'protection',
        showWhen: { field: 'ibr_ctrl', values: ['grid_following', 'grid_forming'] } },
      { key: 'ibr_trip_delay_s', label: 'Ride-through Delay', type: 'number', unit: 's', min: 0, step: 0.05, section: 'protection',
        showWhen: { field: 'ibr_ctrl', values: ['grid_following', 'grid_forming'] } },
    ],
  },

  battery: {
    name: 'Battery Storage',
    label: 'Battery Energy Storage (BESS)',
    category: 'sources',
    ports: [{ id: 'out', side: 'bottom', offset: 0 }],
    width: 60,
    height: 50,
    defaults: {
      name: 'BESS',
      rated_kva: 100,
      voltage_kv: 0.4,
      power_factor: 1.0,
      battery_kwh: 200,
      battery_dod_pct: 90,
      battery_max_charge_kw: 100,
      battery_max_discharge_kw: 100,
      battery_rt_eff: 0.95,
      battery_soc_pct: 100,
      battery_chemistry: 'lfp',
      battery_nominal_v: 48,
      battery_hour_rating_h: 1,
      battery_mode: 'auto',
      var_mode: 'power_factor',
      v_setpoint_pu: 1.0,
      fault_contribution_pu: 1.1,
      dispatch_priority: 1,
      cost_per_mwh: 50,
      ibr_ctrl: 'frozen',
      ibr_imax_pu: 1.2,
      ibr_inertia_h_s: 3.0,
      ibr_pf_droop_pct: 5,
      ibr_xf_pu: 0.15,
      ibr_ffr_droop_pct: 0,
      ibr_qv_gain: 2.0,
      ibr_uv_pu: 0,
      ibr_uf_hz: 0,
      ibr_of_hz: 0,
      ibr_trip_delay_s: 0.2,
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'rated_kva', label: 'Inverter Rating', type: 'number', unit: 'kVA', unitOptions: [{ label: 'kVA', mult: 1 }, { label: 'MVA', mult: 1000 }] },
      { key: 'voltage_kv', label: 'Voltage', type: 'number', unit: 'kV', unitOptions: [{ label: 'kV', mult: 1 }, { label: 'V', mult: 0.001 }] },
      { key: 'power_factor', label: 'Power Factor', type: 'number', min: -1, max: 1, step: 0.01 },
      { key: 'battery_kwh', label: 'Battery Capacity', type: 'number', unit: 'kWh', min: 0, step: 1, section: 'battery' },
      { key: 'battery_dod_pct', label: 'Usable Depth of Discharge', type: 'number', unit: '%', min: 0, max: 100, step: 5, section: 'battery' },
      { key: 'battery_max_charge_kw', label: 'Max Charge Power', type: 'number', unit: 'kW', min: 0, step: 1, section: 'battery' },
      { key: 'battery_max_discharge_kw', label: 'Max Discharge Power', type: 'number', unit: 'kW', min: 0, step: 1, section: 'battery' },
      { key: 'battery_rt_eff', label: 'Round-trip Efficiency', type: 'number', unit: 'p.u.', min: 0.5, max: 1.0, step: 0.01, section: 'battery' },
      { key: 'battery_soc_pct', label: 'State of Charge', type: 'number', unit: '%', min: 0, max: 100, step: 5, section: 'battery' },
      { key: 'battery_chemistry', label: 'Chemistry', type: 'select',
        options: [{ value: 'lfp', label: 'LFP (LiFePO4)' }, { value: 'nmc', label: 'Li-ion NMC' }, { value: 'lead_acid', label: 'Lead-acid' }], section: 'battery' },
      { key: 'battery_nominal_v', label: 'Nominal DC Voltage', type: 'number', unit: 'V', min: 12, step: 1, section: 'battery' },
      { key: 'battery_hour_rating_h', label: 'Hour Rating', type: 'number', unit: 'h', min: 0.5, step: 0.5, section: 'battery' },
      { key: 'battery_mode', label: 'Battery Mode', type: 'select', options: ['auto', 'charging', 'discharging', 'idle'], section: 'battery' },
      { key: 'var_mode', label: 'Reactive Control', type: 'select', section: 'loadflow', options: [
        { value: 'power_factor', label: 'Follow power factor' },
        { value: 'voltage', label: 'Voltage regulating' },
        { value: 'unity', label: 'Unity (no vars)' },
      ] },
      { key: 'v_setpoint_pu', label: 'Voltage Setpoint', type: 'number', unit: 'pu', min: 0.9, max: 1.1,
        step: 0.005, section: 'loadflow', showWhen: { field: 'var_mode', values: ['voltage'] } },
      { key: 'fault_contribution_pu', label: 'Fault Contribution', type: 'number', unit: '×Irated', min: 1.0, max: 2.0, step: 0.1, section: 'fault' },
      { key: 'dispatch_priority', label: 'Dispatch Priority', type: 'number', min: 1, max: 10, step: 1, section: 'loadflow' },
      { key: 'cost_per_mwh', label: 'Marginal Cost', type: 'number', unit: '/MWh', min: 0, step: 5, section: 'loadflow' },
      { key: 'ibr_ctrl', label: 'Converter Model (Stability)', type: 'select',
        options: [
          { value: 'frozen', label: 'Frozen (constant admittance)' },
          { value: 'grid_following', label: 'Grid-following (GFL)' },
          { value: 'grid_forming', label: 'Grid-forming (GFM)' },
        ], section: 'stability' },
      { key: 'ibr_imax_pu', label: 'Current Limit', type: 'number', unit: '×Irated', min: 1.0, max: 2.0, step: 0.05, section: 'stability',
        showWhen: { field: 'ibr_ctrl', values: ['grid_following', 'grid_forming'] } },
      { key: 'ibr_inertia_h_s', label: 'Synthetic Inertia H', type: 'number', unit: 's', min: 0, step: 0.5, section: 'stability',
        showWhen: { field: 'ibr_ctrl', values: ['grid_forming'] } },
      { key: 'ibr_pf_droop_pct', label: 'P-f Droop', type: 'number', unit: '%', min: 0.5, max: 20, step: 0.5, section: 'stability',
        showWhen: { field: 'ibr_ctrl', values: ['grid_forming'] } },
      { key: 'ibr_xf_pu', label: 'Coupling Reactance Xf', type: 'number', unit: 'p.u.', min: 0.02, max: 0.5, step: 0.01, section: 'stability',
        showWhen: { field: 'ibr_ctrl', values: ['grid_forming'] } },
      { key: 'ibr_ffr_droop_pct', label: 'Fast Freq Response Droop', type: 'number', unit: '%', min: 0, max: 20, step: 0.5, section: 'stability',
        showWhen: { field: 'ibr_ctrl', values: ['grid_following'] } },
      { key: 'ibr_qv_gain', label: 'Voltage Support Gain k', type: 'number', unit: 'p.u.', min: 0, max: 10, step: 0.5, section: 'stability',
        showWhen: { field: 'ibr_ctrl', values: ['grid_following'] } },
      { key: 'ibr_uv_pu', label: 'Ride-through UV Trip', type: 'number', unit: 'p.u.', min: 0, max: 1, step: 0.05, section: 'protection',
        showWhen: { field: 'ibr_ctrl', values: ['grid_following', 'grid_forming'] } },
      { key: 'ibr_uf_hz', label: 'IBR Under-freq Trip', type: 'number', unit: 'Hz', min: 0, step: 0.1, section: 'protection',
        showWhen: { field: 'ibr_ctrl', values: ['grid_following', 'grid_forming'] } },
      { key: 'ibr_of_hz', label: 'IBR Over-freq Trip', type: 'number', unit: 'Hz', min: 0, step: 0.1, section: 'protection',
        showWhen: { field: 'ibr_ctrl', values: ['grid_following', 'grid_forming'] } },
      { key: 'ibr_trip_delay_s', label: 'Ride-through Delay', type: 'number', unit: 's', min: 0, step: 0.05, section: 'protection',
        showWhen: { field: 'ibr_ctrl', values: ['grid_following', 'grid_forming'] } },
    ],
  },

  // --- Distribution ---
  bus: {
    name: 'Bus',
    category: 'distribution',
    ports: [
      // Base ports — additional ports are generated dynamically based on busWidth
      { id: 'top', side: 'top', offset: 0 },
      { id: 'bottom', side: 'bottom', offset: 0 },
      { id: 'left', side: 'left', offset: 0 },
      { id: 'right', side: 'right', offset: 0 },
    ],
    dynamicPorts: true, // flag indicating ports are generated at runtime
    width: 120,
    height: 10,
    defaults: {
      name: 'Bus',
      system: 'ac',
      voltage_kv: 11,
      voltage_dc_v: 125,
      bus_type: 'PQ',
      busWidth: 120,
      working_distance_mm: 455,
      equipment_class: 'auto',
      conductor_gap_mm: 0,
      electrode_config: 'VCB',
      enclosure_size_mm: 508,
      soil_resistivity: 100,
      crushed_rock_resistivity: 2500,
      crushed_rock_depth: 0.15,
      grid_length: 30,
      grid_width: 30,
      grid_depth: 0.5,
      num_conductors_x: 6,
      num_conductors_y: 6,
      ground_rod_length: 3.0,
      num_ground_rods: 20,
      fault_duration: 0.5,
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'system', label: 'System', type: 'select', options: ['ac', 'dc'] },
      { key: 'voltage_kv', label: 'Voltage', type: 'number', unit: 'kV', unitOptions: [{ label: 'kV', mult: 1 }, { label: 'V', mult: 0.001 }], showWhen: { field: 'system', values: ['ac'] } },
      { key: 'voltage_dc_v', label: 'DC Voltage', type: 'number', unit: 'Vdc', min: 0, showWhen: { field: 'system', values: ['dc'] } },
      { key: 'bus_type', label: 'Bus Type', type: 'select', options: ['PQ', 'PV', 'Swing'], showWhen: { field: 'system', values: ['ac'] } },
      { key: 'busWidth', label: 'Width', type: 'number', unit: 'px', min: 60, step: 20 },
      { key: 'working_distance_mm', label: 'Working Distance', type: 'number', unit: 'mm', min: 300, step: 5, section: 'arcflash' },
      { key: 'equipment_class', label: 'Equipment Class', type: 'select', options: ['auto', 'lv_switchgear', 'lv_mcc_panel', 'lv_cable', 'mv_switchgear_5kv', 'mv_switchgear_15kv', 'open_air'], section: 'arcflash' },
      { key: 'conductor_gap_mm', label: 'Conductor Gap (0 = auto)', type: 'number', unit: 'mm', min: 0, step: 1, section: 'arcflash' },
      { key: 'electrode_config', label: 'Electrode Config', type: 'select', options: ['VCB', 'VCBB', 'HCB', 'VOA', 'HOA'], section: 'arcflash' },
      { key: 'enclosure_size_mm', label: 'Enclosure Width', type: 'number', unit: 'mm', min: 100, step: 10, section: 'arcflash' },
      { key: 'system_grounded', label: 'System Grounding', type: 'select', options: ['unknown', 'grounded', 'ungrounded'], section: 'arcflash' },
      { key: 'soil_resistivity', label: 'Soil Resistivity', type: 'number', unit: 'Ω·m', section: 'grounding' },
      { key: 'grid_length', label: 'Grid Length', type: 'number', unit: 'm', section: 'grounding' },
      { key: 'grid_width', label: 'Grid Width', type: 'number', unit: 'm', section: 'grounding' },
      { key: 'grid_depth', label: 'Grid Depth', type: 'number', unit: 'm', section: 'grounding' },
      { key: 'num_conductors_x', label: 'Conductors (X)', type: 'number', section: 'grounding' },
      { key: 'num_conductors_y', label: 'Conductors (Y)', type: 'number', section: 'grounding' },
      { key: 'num_ground_rods', label: 'Ground Rods', type: 'number', section: 'grounding' },
      { key: 'ground_rod_length', label: 'Rod Length', type: 'number', unit: 'm', section: 'grounding' },
      { key: 'fault_duration', label: 'Fault Duration', type: 'number', unit: 's', section: 'grounding' },
    ],
  },
  transformer: {
    name: 'Transformer',
    category: 'distribution',
    ports: [
      { id: 'primary', side: 'top', offset: 0 },
      { id: 'secondary', side: 'bottom', offset: 0 },
    ],
    width: 60,
    height: 70,
    defaults: {
      name: 'Xfmr',
      standard_type: '',
      rated_mva: 10,
      voltage_hv_kv: 33,
      voltage_lv_kv: 11,
      z_percent: 8,
      x_r_ratio: 10,
      tap_mode: 'fixed',
      tap_percent: 0,
      tap_min_pct: -10,
      tap_max_pct: 10,
      tap_step_pct: 1.25,
      v_target_pu: 1.0,
      regulated_side: 'lv',
      vector_group: 'Dyn11',
      winding_config: 'step_down',
      grounding_hv: 'ungrounded',
      grounding_hv_resistance: 0,
      grounding_hv_reactance: 0,
      grounding_lv: 'solidly_grounded',
      grounding_lv_resistance: 0,
      grounding_lv_reactance: 0,
      core_construction: 'three_limb',
      z0m_pu: 0,
      z0_z1_ratio: 0,
      earthing_system: 'TN-S',
      earth_electrode_r_source: 1.0,
      earth_electrode_r_installation: 20.0,
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'standard_type', label: 'Standard Type', type: 'standard_select', library: 'transformer' },
      { key: 'winding_config', label: 'Configuration', type: 'select', options: ['step_down', 'step_up'] },
      { key: 'rated_mva', label: 'Rating', type: 'number', unit: 'MVA', unitOptions: [{ label: 'MVA', mult: 1 }, { label: 'kVA', mult: 0.001 }] },
      { key: 'voltage_hv_kv', label: 'HV Voltage', type: 'number', unit: 'kV', unitOptions: [{ label: 'kV', mult: 1 }, { label: 'V', mult: 0.001 }] },
      { key: 'voltage_lv_kv', label: 'LV Voltage', type: 'number', unit: 'kV', unitOptions: [{ label: 'kV', mult: 1 }, { label: 'V', mult: 0.001 }] },
      { key: 'z_percent', label: 'Z%', type: 'number', unit: '%', section: 'fault' },
      { key: 'x_r_ratio', label: 'X/R Ratio', type: 'number', section: 'fault' },
      { key: 'failure_rate_per_yr', label: 'Failure Rate', type: 'number', unit: '/yr', min: 0, step: 0.005, section: 'reliability' },
      { key: 'repair_time_h', label: 'Repair Time', type: 'number', unit: 'h', min: 0, step: 1, section: 'reliability' },
      { key: 'tap_mode', label: 'Tap Changer', type: 'select', options: [{ value: 'fixed', label: 'Fixed tap' }, { value: 'regulating', label: 'OLTC (regulating)' }], section: 'loadflow' },
      { key: 'tap_percent', label: 'Tap Position', type: 'number', unit: '%', section: 'loadflow' },
      { key: 'regulated_side', label: 'Regulated Side', type: 'select', options: [{ value: 'lv', label: 'LV' }, { value: 'hv', label: 'HV' }], section: 'loadflow', showWhen: { field: 'tap_mode', values: ['regulating'] } },
      { key: 'v_target_pu', label: 'Target Voltage', type: 'number', unit: 'pu', min: 0.9, max: 1.1, step: 0.005, section: 'loadflow', showWhen: { field: 'tap_mode', values: ['regulating'] } },
      { key: 'tap_min_pct', label: 'Tap Min', type: 'number', unit: '%', section: 'loadflow', showWhen: { field: 'tap_mode', values: ['regulating'] } },
      { key: 'tap_max_pct', label: 'Tap Max', type: 'number', unit: '%', section: 'loadflow', showWhen: { field: 'tap_mode', values: ['regulating'] } },
      { key: 'tap_step_pct', label: 'Tap Step', type: 'number', unit: '%', section: 'loadflow', showWhen: { field: 'tap_mode', values: ['regulating'] } },
      { key: 'vector_group', label: 'Vector Group', type: 'select', options: ['Dyn11', 'Dyn1', 'Dyn5', 'YNyn0', 'YNd11', 'YNd1', 'YNd5', 'Yyn0', 'Yzn11', 'Yzn1', 'Dd0', 'Dd6'] },
      { key: 'grounding_hv', label: 'HV Grounding', type: 'select', options: ['ungrounded', 'solidly_grounded', 'low_resistance', 'high_resistance', 'reactance_grounded'],
        showWhen: { field: 'vector_group', match: /^YN/i }, section: 'grounding' },
      { key: 'grounding_hv_resistance', label: 'HV Ground R', type: 'number', unit: 'Ω',
        showWhen: { field: 'grounding_hv', values: ['low_resistance', 'high_resistance'] }, section: 'grounding' },
      { key: 'grounding_hv_reactance', label: 'HV Ground X', type: 'number', unit: 'Ω',
        showWhen: { field: 'grounding_hv', values: ['reactance_grounded'] }, section: 'grounding' },
      { key: 'grounding_lv', label: 'LV Grounding', type: 'select', options: ['ungrounded', 'solidly_grounded', 'low_resistance', 'high_resistance', 'reactance_grounded'],
        showWhen: { field: 'vector_group', match: /[yY][nN]|[zZ][nN]/i, side: 'lv' }, section: 'grounding' },
      { key: 'grounding_lv_resistance', label: 'LV Ground R', type: 'number', unit: 'Ω',
        showWhen: { field: 'grounding_lv', values: ['low_resistance', 'high_resistance'] }, section: 'grounding' },
      { key: 'grounding_lv_reactance', label: 'LV Ground X', type: 'number', unit: 'Ω',
        showWhen: { field: 'grounding_lv', values: ['reactance_grounded'] }, section: 'grounding' },
      { key: 'core_construction', label: 'Core Construction', type: 'select',
        options: ['three_limb', 'five_limb', 'shell', 'single_phase_bank'],
        showWhen: { field: 'vector_group', match: /[yz]/i }, section: 'grounding' },
      { key: 'z0m_pu', label: 'Z₀ₘ override', type: 'number', unit: 'pu',
        showWhen: { field: 'vector_group', match: /[yz]/i }, section: 'grounding' },
      { key: 'z0_z1_ratio', label: 'Z₀/Z₁ Ratio', type: 'number', min: 0, max: 3, step: 0.05, section: 'fault' },
      { key: 'earthing_system', label: 'Earthing System (LV)', type: 'select',
        options: ['TN-S', 'TN-C', 'TN-C-S', 'TT', 'IT'],
        showWhen: { field: 'voltage_lv_kv', max: 1.0 }, section: 'grounding' },
      { key: 'earth_electrode_r_source', label: 'Source Earth R_B', type: 'number', unit: 'Ω',
        showWhen: { field: 'earthing_system', values: ['TT', 'IT'] }, section: 'grounding' },
      { key: 'earth_electrode_r_installation', label: 'Installation Earth R_A', type: 'number', unit: 'Ω',
        showWhen: { field: 'earthing_system', values: ['TT'] }, section: 'grounding' },
    ],
  },
  autotransformer: {
    name: 'Autotransformer',
    category: 'distribution',
    ports: [
      { id: 'primary', side: 'top', offset: 0 },
      { id: 'secondary', side: 'bottom', offset: 0 },
      { id: 'tertiary', side: 'right', offset: 0 },
    ],
    width: 60,
    height: 72,
    defaults: {
      name: 'AutoTX',
      windings: 2,
      rated_mva: 20,
      voltage_hv_kv: 132,
      voltage_lv_kv: 66,
      voltage_tv_kv: 11,
      z_percent: 8,
      z_ht_percent: 26,
      z_lt_percent: 16,
      x_r_ratio: 30,
      tap_mode: 'fixed',
      tap_percent: 0,
      tap_min_pct: -10,
      tap_max_pct: 10,
      tap_step_pct: 1.25,
      v_target_pu: 1.0,
      regulated_side: 'lv',
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'windings', label: 'Windings', type: 'select', options: [{ value: 2, label: '2-winding' }, { value: 3, label: '3-winding (+ tertiary)' }] },
      { key: 'rated_mva', label: 'Rating', type: 'number', unit: 'MVA', unitOptions: [{ label: 'MVA', mult: 1 }, { label: 'kVA', mult: 0.001 }] },
      { key: 'voltage_hv_kv', label: 'HV (series) Voltage', type: 'number', unit: 'kV' },
      { key: 'voltage_lv_kv', label: 'LV (common) Voltage', type: 'number', unit: 'kV' },
      { key: 'voltage_tv_kv', label: 'Tertiary Voltage', type: 'number', unit: 'kV', showWhen: { field: 'windings', values: [3, '3'] } },
      { key: 'z_percent', label: 'Z HV-LV %', type: 'number', unit: '%', section: 'fault' },
      { key: 'z_ht_percent', label: 'Z HV-TV %', type: 'number', unit: '%', section: 'fault', showWhen: { field: 'windings', values: [3, '3'] } },
      { key: 'z_lt_percent', label: 'Z LV-TV %', type: 'number', unit: '%', section: 'fault', showWhen: { field: 'windings', values: [3, '3'] } },
      { key: 'x_r_ratio', label: 'X/R Ratio', type: 'number', section: 'fault' },
      { key: 'tap_mode', label: 'Tap Changer', type: 'select', options: [{ value: 'fixed', label: 'Fixed tap' }, { value: 'regulating', label: 'OLTC (regulating)' }], section: 'loadflow' },
      { key: 'tap_percent', label: 'Tap Position', type: 'number', unit: '%', section: 'loadflow' },
      { key: 'regulated_side', label: 'Regulated Side', type: 'select', options: [{ value: 'lv', label: 'LV (common)' }, { value: 'hv', label: 'HV (series)' }], section: 'loadflow', showWhen: { field: 'tap_mode', values: ['regulating'] } },
      { key: 'v_target_pu', label: 'Target Voltage', type: 'number', unit: 'pu', min: 0.9, max: 1.1, step: 0.005, section: 'loadflow', showWhen: { field: 'tap_mode', values: ['regulating'] } },
      { key: 'tap_min_pct', label: 'Tap Min', type: 'number', unit: '%', section: 'loadflow', showWhen: { field: 'tap_mode', values: ['regulating'] } },
      { key: 'tap_max_pct', label: 'Tap Max', type: 'number', unit: '%', section: 'loadflow', showWhen: { field: 'tap_mode', values: ['regulating'] } },
      { key: 'tap_step_pct', label: 'Tap Step', type: 'number', unit: '%', section: 'loadflow', showWhen: { field: 'tap_mode', values: ['regulating'] } },
    ],
  },
  cable: {
    name: 'Cable / Feeder',
    category: 'distribution',
    ports: [
      { id: 'from', side: 'top', offset: 0 },
      { id: 'to', side: 'bottom', offset: 0 },
    ],
    width: 20,
    height: 60,
    defaults: {
      name: 'Cable',
      construction: 'cable',
      standard_type: '',
      overhead_type: '',
      length_km: 0.1,
      r_per_km: 0.1,
      x_per_km: 0.08,
      r0_per_km: 0,
      x0_per_km: 0,
      rated_amps: 400,
      voltage_kv: 11,
      num_parallel: 1,
      ampacity_standard: 'IEC',
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: '_flow_direction', label: 'Flow Direction', type: 'cable_direction' },
      { key: 'construction', label: 'Feeder Type', type: 'select', options: [{ value: 'cable', label: 'Underground Cable' }, { value: 'overhead', label: 'Overhead Line' }] },
      { key: 'standard_type', label: 'Cable Type', type: 'standard_select', library: 'cable', showWhen: { field: 'construction', values: ['cable'] } },
      { key: 'overhead_type', label: 'Conductor', type: 'standard_select', library: 'overhead', showWhen: { field: 'construction', values: ['overhead'] } },
      { key: 'length_km', label: 'Length', type: 'number', unit: 'm', unitOptions: [{ label: 'm', mult: 0.001 }, { label: 'km', mult: 1 }] },
      { key: 'voltage_kv', label: 'Voltage', type: 'number', unit: 'kV', unitOptions: [{ label: 'kV', mult: 1 }, { label: 'V', mult: 0.001 }] },
      { key: 'ampacity_standard', label: 'Ampacity Standard', type: 'select', options: ['IEC', 'NEC'], section: 'cable_sizing', showWhen: { field: 'construction', values: ['cable'] } },
      { key: 'num_parallel', label: 'Parallel Circuits', type: 'number', min: 1, max: 20, step: 1, section: 'cable_sizing' },
      { key: 'failure_rate_per_km_yr', label: 'Failure Rate', type: 'number', unit: '/km·yr', min: 0, step: 0.01, section: 'reliability' },
      { key: 'repair_time_h', label: 'Repair Time', type: 'number', unit: 'h', min: 0, step: 1, section: 'reliability' },
      { key: 'momentary_rate_per_km_yr', label: 'Momentary Rate', type: 'number', unit: '/km·yr', min: 0, step: 0.05, section: 'reliability', showWhen: { field: 'construction', values: ['overhead'] } },
      { key: 'rated_amps', label: 'Rated Current (per circuit)', type: 'number', unit: 'A', section: 'cable_sizing' },
      { key: '_ampacity_calc', label: 'Installed Ampacity', type: 'ampacity_calc', section: 'cable_sizing', showWhen: { field: 'construction', values: ['cable'] } },
      { key: 'adiabatic_basis', label: 'Fault-withstand Basis', type: 'select', options: [{ value: '', label: 'Thermal-equiv. Iₜₕ (default)' }, { value: 'bare_isc', label: 'Bare Isc (hand-calc)' }], section: 'cable_sizing' },
      { key: 'standalone_current_a', label: 'Standalone Design Current (0 = use load flow)', type: 'number', unit: 'A', min: 0, step: 1, section: 'cable_sizing' },
      { key: 'standalone_isc_ka', label: 'Standalone Isc (0 = use fault study)', type: 'number', unit: 'kA', min: 0, step: 0.1, section: 'cable_sizing' },
      { key: 'standalone_clearing_s', label: 'Standalone Clearing Time (0 = auto)', type: 'number', unit: 's', min: 0, step: 0.01, section: 'cable_sizing' },
      { key: 'r_per_km', label: 'R₁ (pos. seq.)', type: 'number', unit: 'Ω/km', min: 0, step: 0.001, section: 'fault' },
      { key: 'x_per_km', label: 'X₁ (pos. seq.)', type: 'number', unit: 'Ω/km', min: 0, step: 0.001, section: 'fault' },
      { key: 'r0_per_km', label: 'R₀ (zero seq.)', type: 'number', unit: 'Ω/km', min: 0, step: 0.001, section: 'fault' },
      { key: 'x0_per_km', label: 'X₀ (zero seq.)', type: 'number', unit: 'Ω/km', min: 0, step: 0.001, section: 'fault' },
    ],
  },

  // --- Protection Devices ---
  cb: {
    name: 'Circuit Breaker',
    category: 'protection',
    ports: [
      { id: 'top', side: 'top', offset: 0 },
      { id: 'bottom', side: 'bottom', offset: 0 },
    ],
    width: 30,
    height: 40,
    defaults: {
      name: 'CB',
      rated_voltage_kv: 11,
      rated_current_a: 630,
      breaking_capacity_ka: 25,
      circuit_type: '',
      state: 'closed',
      cb_type: 'mccb',
      mcb_curve: 'C',
      trip_rating_a: 630,
      thermal_pickup: 1.0,
      magnetic_pickup: 10,
      long_time_delay: 10,
      short_time_pickup: 0,
      short_time_delay: 0,
      instantaneous_pickup: 0,
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'standard_type', label: 'Standard CB', type: 'standard_select', library: 'cb' },
      { key: 'rated_voltage_kv', label: 'Rated Voltage', type: 'number', unit: 'kV' },
      { key: 'rated_current_a', label: 'Rated Current', type: 'number', unit: 'A' },
      { key: 'breaking_capacity_ka', label: 'Breaking Cap.', type: 'number', unit: 'kA' },
      { key: 'circuit_type', label: 'Circuit Type', type: 'select',
        options: [
          { value: '', label: 'Auto (assume final)' },
          { value: 'final_socket', label: 'Final — socket outlets' },
          { value: 'final_fixed', label: 'Final — fixed equipment' },
          { value: 'distribution', label: 'Distribution / sub-main' },
        ], section: 'protection' },
      { key: 'state', label: 'State', type: 'select', options: ['closed', 'open'] },
      { key: 'cb_type', label: 'CB Type', type: 'select', options: ['mcb', 'mccb', 'acb'] },
      { key: 'mcb_curve', label: 'Curve (IEC 60898)', type: 'select', options: ['B', 'C', 'D'],
        showWhen: { field: 'cb_type', values: ['mcb'] } },
      { key: 'trip_rating_a', label: 'Trip Rating', type: 'number', unit: 'A', section: 'protection' },
      { key: 'thermal_pickup', label: 'Thermal Pickup', type: 'number', unit: '×In', section: 'protection' },
      { key: 'magnetic_pickup', label: 'Magnetic Pickup', type: 'number', unit: '×In', section: 'protection' },
      { key: 'long_time_delay', label: 'LT Delay Class', type: 'number', section: 'protection' },
      { key: 'short_time_pickup', label: 'ST Pickup', type: 'number', unit: '×Ir',
        showWhen: { field: 'cb_type', values: ['acb'] }, section: 'protection' },
      { key: 'short_time_delay', label: 'ST Delay', type: 'number', unit: 's',
        showWhen: { field: 'cb_type', values: ['acb'] }, section: 'protection' },
      { key: 'instantaneous_pickup', label: 'Instantaneous', type: 'number', unit: '×Ir',
        showWhen: { field: 'cb_type', values: ['acb'] }, section: 'protection' },
      // Integral earth-fault (shunt-trip) release — a core-balance CT can trip
      // an MCCB/ACB directly, without a separate relay. Enabled by picking the
      // measuring CBCT; residual pickup + definite-time delay define the element.
      { key: 'ef_trip_ct', label: 'Earth-Fault CT', type: 'component_select', filter: 'ct',
        showWhen: { field: 'cb_type', values: ['mccb', 'acb'] }, section: 'protection' },
      { key: 'ef_pickup_a', label: 'E/F Pickup', type: 'number', unit: 'A', min: 0, step: 1,
        showWhen: { field: 'cb_type', values: ['mccb', 'acb'] }, section: 'protection' },
      { key: 'ef_delay_s', label: 'E/F Delay', type: 'number', unit: 's', min: 0, step: 0.01,
        showWhen: { field: 'cb_type', values: ['mccb', 'acb'] }, section: 'protection' },
    ],
  },
  fuse: {
    name: 'Fuse',
    category: 'protection',
    ports: [
      { id: 'top', side: 'top', offset: 0 },
      { id: 'bottom', side: 'bottom', offset: 0 },
    ],
    width: 20,
    height: 40,
    defaults: {
      name: 'Fuse',
      rated_voltage_kv: 11,
      rated_current_a: 100,
      breaking_capacity_ka: 50,
      fuse_type: 'gG',
      circuit_type: '',
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'standard_type', label: 'Standard Fuse', type: 'standard_select', library: 'fuse' },
      { key: 'fuse_type', label: 'Fuse Type', type: 'select', options: ['gG', 'aM'] },
      { key: 'rated_voltage_kv', label: 'Rated Voltage', type: 'number', unit: 'kV' },
      { key: 'rated_current_a', label: 'Rated Current', type: 'number', unit: 'A' },
      { key: 'breaking_capacity_ka', label: 'Breaking Cap.', type: 'number', unit: 'kA' },
      { key: 'circuit_type', label: 'Circuit Type', type: 'select',
        options: [
          { value: '', label: 'Auto (assume final)' },
          { value: 'final_socket', label: 'Final — socket outlets' },
          { value: 'final_fixed', label: 'Final — fixed equipment' },
          { value: 'distribution', label: 'Distribution / sub-main' },
        ] },
    ],
  },
  relay: {
    name: 'Relay',
    category: 'protection',
    ports: [],
    width: 36,
    height: 36,
    defaults: {
      name: 'Relay',
      relay_type: '50/51',
      associated_ct: '',
      trip_cb: '',
      pickup_a: 100,
      time_dial: 1.0,
      curve: 'IEC Standard Inverse',
      // Instantaneous (50) element: 0 = disabled
      inst_pickup_a: 0,
      inst_delay_s: 0.05,
      // Directional overcurrent (67) defaults
      direction: 'forward',
      characteristic_angle_deg: 45,
      // Distance relay (21) defaults
      voltage_kv: 11,
      z1_reach_ohm: 4.0,
      z1_delay_s: 0.0,
      z2_reach_ohm: 6.0,
      z2_delay_s: 0.3,
      z3_reach_ohm: 12.0,
      z3_delay_s: 0.8,
      z3_reverse: false,
      mho_angle_deg: 75,
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'relay_type', label: 'Type', type: 'select', options: ['50/51', '50N/51N', '67', '87', '21'] },
      { key: 'associated_ct', label: 'Measuring CT', type: 'component_select', filter: 'ct' },
      { key: 'trip_cb', label: 'Trip CB', type: 'component_select', filter: 'cb' },
      // Overcurrent (50/51, 50N/51N, 67) fields
      { key: 'pickup_a', label: 'Pickup', type: 'number', unit: 'A', showWhen: { field: 'relay_type', values: ['50/51', '50N/51N', '67'] }, section: 'protection' },
      { key: 'time_dial', label: 'Time Dial', type: 'number', showWhen: { field: 'relay_type', values: ['50/51', '50N/51N', '67'] }, section: 'protection' },
      { key: 'curve', label: 'Curve', type: 'select', options: ['IEC Standard Inverse', 'IEC Very Inverse', 'IEC Extremely Inverse', 'IEC Long Time Inverse', 'IEEE Moderately Inverse', 'IEEE Very Inverse', 'IEEE Extremely Inverse', 'Definite Time'], showWhen: { field: 'relay_type', values: ['50/51', '50N/51N', '67'] }, section: 'protection' },
      { key: 'inst_pickup_a', label: 'Inst. (50) Pickup', type: 'number', unit: 'A', min: 0, step: 1, showWhen: { field: 'relay_type', values: ['50/51', '50N/51N', '67'] }, section: 'protection' },
      { key: 'inst_delay_s', label: 'Inst. Delay', type: 'number', unit: 's', min: 0, step: 0.01, showWhen: { field: 'relay_type', values: ['50/51', '50N/51N', '67'] }, section: 'protection' },
      // Directional overcurrent (67) fields
      { key: 'direction', label: 'Direction', type: 'select', options: ['forward', 'reverse'], showWhen: { field: 'relay_type', values: ['67'] }, section: 'protection' },
      { key: 'characteristic_angle_deg', label: 'Char. Angle (RCA)', type: 'number', unit: '\u00B0', min: -90, max: 90, step: 1, showWhen: { field: 'relay_type', values: ['67'] }, section: 'protection' },
      // Distance relay (21) fields
      { key: 'voltage_kv', label: 'Voltage', type: 'number', unit: 'kV', showWhen: { field: 'relay_type', values: ['21'] }, section: 'protection' },
      { key: 'z1_reach_ohm', label: 'Z1 Reach', type: 'number', unit: '\u03A9', min: 0.01, step: 0.1, showWhen: { field: 'relay_type', values: ['21'] }, section: 'protection' },
      { key: 'z1_delay_s', label: 'Z1 Delay', type: 'number', unit: 's', min: 0, step: 0.01, showWhen: { field: 'relay_type', values: ['21'] }, section: 'protection' },
      { key: 'z2_reach_ohm', label: 'Z2 Reach', type: 'number', unit: '\u03A9', min: 0.01, step: 0.1, showWhen: { field: 'relay_type', values: ['21'] }, section: 'protection' },
      { key: 'z2_delay_s', label: 'Z2 Delay', type: 'number', unit: 's', min: 0, step: 0.01, showWhen: { field: 'relay_type', values: ['21'] }, section: 'protection' },
      { key: 'z3_reach_ohm', label: 'Z3 Reach', type: 'number', unit: '\u03A9', min: 0.01, step: 0.1, showWhen: { field: 'relay_type', values: ['21'] }, section: 'protection' },
      { key: 'z3_delay_s', label: 'Z3 Delay', type: 'number', unit: 's', min: 0, step: 0.01, showWhen: { field: 'relay_type', values: ['21'] }, section: 'protection' },
      { key: 'mho_angle_deg', label: 'Mho Angle', type: 'number', unit: '\u00B0', min: 30, max: 90, step: 1, showWhen: { field: 'relay_type', values: ['21'] }, section: 'protection' },
    ],
  },
  switch: {
    name: 'Switch',
    category: 'protection',
    ports: [
      { id: 'top', side: 'top', offset: 0 },
      { id: 'bottom', side: 'bottom', offset: 0 },
    ],
    width: 30,
    height: 40,
    defaults: {
      name: 'Switch',
      rated_voltage_kv: 11,
      rated_current_a: 630,
      state: 'closed',
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'rated_voltage_kv', label: 'Rated Voltage', type: 'number', unit: 'kV' },
      { key: 'rated_current_a', label: 'Rated Current', type: 'number', unit: 'A' },
      { key: 'state', label: 'State', type: 'select', options: ['closed', 'open'] },
    ],
  },

  // --- Instrument Transformers ---
  ct: {
    name: 'Current Transformer',
    category: 'instruments',
    ports: [
      { id: 'top', side: 'top', offset: 0 },
      { id: 'bottom', side: 'bottom', offset: 0 },
    ],
    width: 30,
    height: 30,
    defaults: {
      name: 'CT',
      ct_type: 'phase',
      ratio: '400/5',
      accuracy_class: '5P20',
      burden_va: 15,
      rct_ohm: 0.3, // typical for a 5 A secondary CT (1 A CTs run 1–5 Ω)
      knee_point_v: 0,  // 0 = auto-derive from ALF
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'ct_type', label: 'CT Type', type: 'select', options: [
        { value: 'phase', label: 'Phase (measurement)' },
        { value: 'core_balance', label: 'Core balance (residual)' },
      ] },
      { key: 'ratio', label: 'Ratio', type: 'text' },
      { key: 'accuracy_class', label: 'Accuracy', type: 'text' },
      { key: 'burden_va', label: 'Burden', type: 'number', unit: 'VA' },
      { key: 'rct_ohm', label: 'Winding Resistance', type: 'number', unit: '\u03A9', min: 0, step: 0.1 },
      { key: 'knee_point_v', label: 'Knee Point Voltage', type: 'number', unit: 'V', min: 0, step: 1, placeholder: 'Auto from ALF' },
    ],
  },
  pt: {
    name: 'Potential Transformer',
    category: 'instruments',
    ports: [
      { id: 'top', side: 'top', offset: 0 },
      { id: 'bottom', side: 'bottom', offset: 0 },
    ],
    width: 30,
    height: 30,
    defaults: {
      name: 'PT',
      ratio: '11000/110',
      accuracy_class: '0.5',
      burden_va: 30,
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'ratio', label: 'Ratio', type: 'text' },
      { key: 'accuracy_class', label: 'Accuracy', type: 'text' },
      { key: 'burden_va', label: 'Burden', type: 'number', unit: 'VA' },
    ],
  },

  // --- Loads ---
  motor_induction: {
    name: 'Induction Motor',
    category: 'loads',
    ports: [{ id: 'in', side: 'top', offset: 0 }],
    width: 50,
    height: 50,
    defaults: {
      name: 'IM',
      rated_kw: 200,
      voltage_kv: 0.4,
      efficiency: 0.93,
      power_factor: 0.85,
      locked_rotor_current: 6,
      starting_method: 'dol',
      dyn_role: 'starts',
      start_time_s: 0,
      x_pp: 0.17,
      x_r_ratio: 2.4, // IEC 60909-0: X/R ≈ 2.4 typical for LV motor groups (10 was a large-MV-motor value)
      demand_factor: 1.0,
      essential: 'yes',
      x2: 0,
      poles: 0,
      rated_speed_rpm: 1480,
      locked_rotor_torque_pct: 150,
      motor_j_kgm2: 0,
      load_j_kgm2: 0,
      load_torque_model: 'quadratic',
      load_torque_pct: 90,
      load_breakaway_pct: 10,
      transition_speed_pct: 80,
      ss_current_limit_xflc: 3.5,
      ss_ramp_s: 10,
      ss_initial_v_pct: 30,
      stall_time_hot_s: 15,
      accel_time_s: 5,
      sim_t_max_s: 30,
      ts_dynamic: 'on',
      uv_trip_pu: 0,
      uv_trip_delay_s: 0.2,
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'rated_kw', label: 'Rating', type: 'number', unit: 'kW' },
      { key: 'ts_dynamic', label: 'Stability Model', type: 'select', options: ['on', 'off'], section: 'stability' },
      { key: 'voltage_kv', label: 'Voltage', type: 'number', unit: 'kV' },
      { key: 'efficiency', label: 'Efficiency', type: 'number' },
      { key: 'power_factor', label: 'Power Factor', type: 'number' },
      { key: 'demand_factor', label: 'Demand Factor', type: 'number' },
      { key: 'customers', label: 'Customers Served', type: 'number', min: 0, step: 1, section: 'reliability' },
      { key: 'essential', label: 'Essential (Backup) Load', type: 'select', options: ['yes', 'no'], section: 'loadflow' },
      { key: 'locked_rotor_current', label: 'LRC (x FLC)', type: 'number', section: 'fault' },
      { key: 'starting_method', label: 'Starting Method', type: 'select',
        options: [
          { value: 'dol',             label: 'Direct-on-Line (DOL)' },
          { value: 'star_delta',      label: 'Star-Delta' },
          { value: 'autotransformer', label: 'Autotransformer (80%)' },
          { value: 'soft_starter',    label: 'Soft Starter' },
          { value: 'vfd',             label: 'VFD' },
        ], section: 'fault' },
      { key: 'x_pp', label: "X''", type: 'number', unit: 'p.u.', section: 'fault' },
      { key: 'x_r_ratio', label: 'X/R Ratio', type: 'number', section: 'fault' },
      { key: 'x2', label: 'X₂ (neg. seq.)', type: 'number', unit: 'p.u.', section: 'fault' },
      { key: 'poles', label: 'Poles', type: 'number', section: 'fault', min: 0, step: 2 },
      // Start staging (dyn_role / start_time_s) is configured in the Dynamic
      // Motor Starting timeline modal, not here — the props remain as data
      // defaults so older projects seed the modal on first open.
      { key: 'rated_speed_rpm', label: 'Rated Speed', type: 'number', unit: 'rpm', section: 'dynamic', min: 0 },
      { key: 'locked_rotor_torque_pct', label: 'LRT (% FLT)', type: 'number', unit: '%', section: 'dynamic', min: 20 },
      { key: 'motor_j_kgm2', label: 'Motor Inertia J', type: 'number', unit: 'kg·m²', section: 'dynamic', min: 0 },
      { key: 'load_j_kgm2', label: 'Load Inertia J', type: 'number', unit: 'kg·m²', section: 'dynamic', min: 0 },
      { key: 'load_torque_model', label: 'Load Torque Curve', type: 'select', section: 'dynamic',
        options: [
          { value: 'quadratic', label: 'Quadratic (fan / pump)' },
          { value: 'linear',    label: 'Linear (mixer)' },
          { value: 'constant',  label: 'Constant (conveyor / compressor)' },
        ] },
      { key: 'load_torque_pct', label: 'Load Torque (% FLT)', type: 'number', unit: '%', section: 'dynamic', min: 0 },
      { key: 'load_breakaway_pct', label: 'Breakaway Torque (% load)', type: 'number', unit: '%', section: 'dynamic', min: 0 },
      { key: 'transition_speed_pct', label: 'Starter Changeover Speed', type: 'number', unit: '%', section: 'dynamic', min: 10, max: 99 },
      { key: 'ss_current_limit_xflc', label: 'Soft-Start I Limit (×FLC)', type: 'number', section: 'dynamic', min: 1 },
      { key: 'ss_ramp_s', label: 'Soft-Start Ramp', type: 'number', unit: 's', section: 'dynamic', min: 0 },
      { key: 'ss_initial_v_pct', label: 'Soft-Start Initial V', type: 'number', unit: '%', section: 'dynamic', min: 0, max: 100 },
      { key: 'stall_time_hot_s', label: 'Hot Stall Time', type: 'number', unit: 's', section: 'dynamic', min: 1 },
      { key: 'accel_time_s', label: 'Accel Time (TCC)', type: 'number', unit: 's', section: 'dynamic', min: 0.1 },
      { key: 'sim_t_max_s', label: 'Max Simulation Time', type: 'number', unit: 's', section: 'dynamic', min: 1 },
      { key: 'uv_trip_pu', label: 'Under-voltage Trip', type: 'number', unit: 'p.u.', min: 0, max: 1, step: 0.05, section: 'protection' },
      { key: 'uv_trip_delay_s', label: 'U/V Trip Delay', type: 'number', unit: 's', min: 0, step: 0.05, section: 'protection', showWhen: { field: 'uv_trip_pu', min: 0.01 } },
    ],
  },
  motor_synchronous: {
    name: 'Synchronous Motor',
    category: 'loads',
    ports: [{ id: 'in', side: 'top', offset: 0 }],
    width: 50,
    height: 50,
    defaults: {
      name: 'SM',
      rated_kva: 500,
      voltage_kv: 3.3,
      power_factor: 0.9,
      xd_pp: 0.15,
      xd_p: 0.25,
      locked_rotor_current: 5.5,
      starting_method: 'dol',
      dyn_role: 'starts',
      start_time_s: 0,
      demand_factor: 1.0,
      essential: 'yes',
      x2: 0,
      x0: 0,
      rated_speed_rpm: 1500,
      locked_rotor_torque_pct: 120,
      motor_j_kgm2: 0,
      load_j_kgm2: 0,
      load_torque_model: 'quadratic',
      load_torque_pct: 90,
      load_breakaway_pct: 10,
      transition_speed_pct: 80,
      ss_current_limit_xflc: 3.5,
      ss_ramp_s: 10,
      ss_initial_v_pct: 30,
      stall_time_hot_s: 15,
      accel_time_s: 5,
      sim_t_max_s: 30,
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'rated_kva', label: 'Rating', type: 'number', unit: 'kVA' },
      { key: 'voltage_kv', label: 'Voltage', type: 'number', unit: 'kV' },
      { key: 'power_factor', label: 'Power Factor', type: 'number' },
      { key: 'demand_factor', label: 'Demand Factor', type: 'number' },
      { key: 'customers', label: 'Customers Served', type: 'number', min: 0, step: 1, section: 'reliability' },
      { key: 'essential', label: 'Essential (Backup) Load', type: 'select', options: ['yes', 'no'], section: 'loadflow' },
      { key: 'locked_rotor_current', label: 'LRC (x FLC)', type: 'number', section: 'fault' },
      { key: 'starting_method', label: 'Starting Method', type: 'select',
        options: [
          { value: 'dol',             label: 'Direct-on-Line (DOL)' },
          { value: 'star_delta',      label: 'Star-Delta' },
          { value: 'autotransformer', label: 'Autotransformer (80%)' },
          { value: 'soft_starter',    label: 'Soft Starter' },
          { value: 'vfd',             label: 'VFD' },
        ], section: 'fault' },
      { key: 'xd_pp', label: "Xd''", type: 'number', unit: 'p.u.', section: 'fault' },
      { key: 'xd_p', label: "Xd'", type: 'number', unit: 'p.u.', section: 'fault' },
      { key: 'x2', label: 'X₂ (neg. seq.)', type: 'number', unit: 'p.u.', section: 'fault' },
      { key: 'x0', label: 'X₀ (zero seq.)', type: 'number', unit: 'p.u.', section: 'fault' },
      // Start staging is configured in the Dynamic Motor Starting timeline modal
      // (see motor_induction); the dyn_role / start_time_s defaults are kept for
      // seeding older projects.
      { key: 'rated_speed_rpm', label: 'Rated Speed', type: 'number', unit: 'rpm', section: 'dynamic', min: 0 },
      { key: 'locked_rotor_torque_pct', label: 'LRT (% FLT)', type: 'number', unit: '%', section: 'dynamic', min: 20 },
      { key: 'motor_j_kgm2', label: 'Motor Inertia J', type: 'number', unit: 'kg·m²', section: 'dynamic', min: 0 },
      { key: 'load_j_kgm2', label: 'Load Inertia J', type: 'number', unit: 'kg·m²', section: 'dynamic', min: 0 },
      { key: 'load_torque_model', label: 'Load Torque Curve', type: 'select', section: 'dynamic',
        options: [
          { value: 'quadratic', label: 'Quadratic (fan / pump)' },
          { value: 'linear',    label: 'Linear (mixer)' },
          { value: 'constant',  label: 'Constant (conveyor / compressor)' },
        ] },
      { key: 'load_torque_pct', label: 'Load Torque (% FLT)', type: 'number', unit: '%', section: 'dynamic', min: 0 },
      { key: 'load_breakaway_pct', label: 'Breakaway Torque (% load)', type: 'number', unit: '%', section: 'dynamic', min: 0 },
      { key: 'transition_speed_pct', label: 'Starter Changeover Speed', type: 'number', unit: '%', section: 'dynamic', min: 10, max: 99 },
      { key: 'ss_current_limit_xflc', label: 'Soft-Start I Limit (×FLC)', type: 'number', section: 'dynamic', min: 1 },
      { key: 'ss_ramp_s', label: 'Soft-Start Ramp', type: 'number', unit: 's', section: 'dynamic', min: 0 },
      { key: 'ss_initial_v_pct', label: 'Soft-Start Initial V', type: 'number', unit: '%', section: 'dynamic', min: 0, max: 100 },
      { key: 'stall_time_hot_s', label: 'Hot Stall Time', type: 'number', unit: 's', section: 'dynamic', min: 1 },
      { key: 'accel_time_s', label: 'Accel Time (TCC)', type: 'number', unit: 's', section: 'dynamic', min: 0.1 },
      { key: 'sim_t_max_s', label: 'Max Simulation Time', type: 'number', unit: 's', section: 'dynamic', min: 1 },
    ],
  },
  static_load: {
    name: 'Static Load',
    category: 'loads',
    ports: [{ id: 'in', side: 'top', offset: 0 }],
    width: 50,
    height: 45,
    defaults: {
      name: 'Load',
      rated_kva: 100,
      voltage_kv: 0.4,
      power_factor: 0.85,
      load_type: 'constant_power',
      demand_factor: 1.0,
      essential: 'yes',
      motor_fraction: 0,
      motor_lrc_ratio: 6,
      phase_connection: '3P',
      phase_a_pct: 33.33,
      phase_b_pct: 33.33,
      phase_c_pct: 33.34,
      uf_shed_hz: 0,
      uf_shed_delay_s: 0.2,
      uv_trip_pu: 0,
      uv_trip_delay_s: 0.2,
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'rated_kva', label: 'Rating', type: 'number', unit: 'kVA' },
      { key: 'voltage_kv', label: 'Voltage', type: 'number', unit: 'kV' },
      { key: 'power_factor', label: 'Power Factor', type: 'number' },
      { key: 'demand_factor', label: 'Demand Factor', type: 'number', section: 'loadflow' },
      { key: 'customers', label: 'Customers Served', type: 'number', min: 0, step: 1, section: 'reliability' },
      { key: 'essential', label: 'Essential (Backup) Load', type: 'select', options: ['yes', 'no'], section: 'loadflow' },
      { key: 'motor_fraction', label: 'Motor Fraction (0 = none)', type: 'number', min: 0, max: 1, step: 0.05, section: 'fault' },
      { key: 'motor_lrc_ratio', label: 'Motor LRC Ratio', type: 'number', min: 1, max: 10, step: 0.5, section: 'fault' },
      { key: 'phase_connection', label: 'Phase Connection', type: 'select',
        options: [
          { value: '3P',    label: '3-Phase (A-B-C)' },
          { value: '2P-AB', label: '2-Phase (A-B)' },
          { value: '2P-BC', label: '2-Phase (B-C)' },
          { value: '2P-CA', label: '2-Phase (C-A)' },
          { value: '1P-A',  label: '1-Phase (A-N)' },
          { value: '1P-B',  label: '1-Phase (B-N)' },
          { value: '1P-C',  label: '1-Phase (C-N)' },
        ],
        section: 'loadflow' },
      { key: 'load_type', label: 'Load Model', type: 'select', options: ['constant_power', 'constant_current', 'constant_impedance'], section: 'stability' },
      { key: 'phase_a_pct', label: 'Phase A %', type: 'number', unit: '%', section: 'loadflow', showWhen: { field: 'phase_connection', values: ['3P', ''] } },
      { key: 'phase_b_pct', label: 'Phase B %', type: 'number', unit: '%', section: 'loadflow', showWhen: { field: 'phase_connection', values: ['3P', ''] } },
      { key: 'phase_c_pct', label: 'Phase C %', type: 'number', unit: '%', section: 'loadflow', showWhen: { field: 'phase_connection', values: ['3P', ''] } },
      { key: 'uf_shed_hz', label: 'UFLS Shed Freq', type: 'number', unit: 'Hz', min: 0, step: 0.1, section: 'protection' },
      { key: 'uf_shed_delay_s', label: 'UFLS Delay', type: 'number', unit: 's', min: 0, step: 0.05, section: 'protection', showWhen: { field: 'uf_shed_hz', min: 0.01 } },
      { key: 'uv_trip_pu', label: 'Under-voltage Trip', type: 'number', unit: 'p.u.', min: 0, max: 1, step: 0.05, section: 'protection' },
      { key: 'uv_trip_delay_s', label: 'U/V Trip Delay', type: 'number', unit: 's', min: 0, step: 0.05, section: 'protection', showWhen: { field: 'uv_trip_pu', min: 0.01 } },
    ],
  },

  distribution_board: {
    name: 'Distribution Board',
    label: 'Distribution Board',
    category: 'loads',
    // 'in' = incomer; 'out' = downstream feed to a sub-board (used by the Plan
    // Markup building-domain sync, which wires MDB out -> cable -> SDB in).
    ports: [{ id: 'in', side: 'top', offset: 0 }, { id: 'out', side: 'bottom', offset: 0 }],
    width: 54,
    height: 46,
    defaults: {
      name: 'DB',
      voltage_kv: 0.4,
      power_factor: 0.85,
      board_diversity: 1.0,     // overall diversity applied on top of per-way DFs
      essential: 'yes',
      motor_fraction: 0,
      motor_lrc_ratio: 6,
      circuits: [],             // circuit schedule (ways) — edited in DBSchedule
      // Derived lumped-load equivalents, recomputed by DBSchedule on save.
      // The analyses read these exactly like a static load's props.
      rated_kva: 0,
      demand_factor: 1.0,
      // power_factor is DERIVED too: the P/Q vector rollup of the per-circuit
      // power factors (DBSchedule.recompute). 0.85 is the empty-board fallback.
      load_type: 'constant_power',
      phase_connection: '3P',
      phase_a_pct: 33.33,
      phase_b_pct: 33.33,
      phase_c_pct: 33.34,
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'voltage_kv', label: 'Voltage', type: 'number', unit: 'kV' },
      // power_factor is derived per-circuit → shown read-only in Calculated
      // Values (see properties.js), not edited here.
      { key: 'board_diversity', label: 'Board Diversity', type: 'number', min: 0.1, max: 1, step: 0.05, section: 'loadflow' },
      { key: 'essential', label: 'Essential (Backup) Load', type: 'select', options: ['yes', 'no'], section: 'loadflow' },
      { key: 'motor_fraction', label: 'Motor Fraction (0 = none)', type: 'number', min: 0, max: 1, step: 0.05, section: 'fault' },
      { key: 'motor_lrc_ratio', label: 'Motor LRC Ratio', type: 'number', min: 1, max: 10, step: 0.5, section: 'fault' },
    ],
  },

  // Busway link between two switchboard bus sections — electrically transparent
  // (a low-impedance busbar), used by the Plan Markup multi-section switchboard.
  bus_duct: {
    name: 'Bus Duct',
    label: 'Bus Duct',
    category: 'distribution',
    ports: [{ id: 'from', side: 'left', offset: 0 }, { id: 'to', side: 'right', offset: 0 }],
    width: 60,
    height: 16,
    defaults: {
      name: 'BusDuct',
      rated_current_a: 800,
      length_m: 2,
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'rated_current_a', label: 'Rated Current', type: 'number', unit: 'A' },
      { key: 'length_m', label: 'Length', type: 'number', unit: 'm' },
    ],
  },

  // --- DC Systems ---
  ups: {
    name: 'UPS',
    label: 'Uninterruptible Power Supply',
    category: 'dc_systems',
    ports: [
      { id: 'ac_in', side: 'top', offset: 0 },
      { id: 'ac_out', side: 'bottom', offset: 0 },
    ],
    width: 60,
    height: 60,
    defaults: {
      name: 'UPS',
      rated_kva: 100,
      voltage_in_kv: 0.4,
      voltage_out_kv: 0.4,
      topology: 'online_double',
      efficiency: 0.94,
      power_factor: 0.9,
      battery_autonomy_min: 15,
      battery_voltage_vdc: 480,
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'rated_kva', label: 'Rating', type: 'number', unit: 'kVA', unitOptions: [{ label: 'kVA', mult: 1 }, { label: 'MVA', mult: 1000 }] },
      { key: 'voltage_in_kv', label: 'Input Voltage', type: 'number', unit: 'kV', unitOptions: [{ label: 'kV', mult: 1 }, { label: 'V', mult: 0.001 }] },
      { key: 'voltage_out_kv', label: 'Output Voltage', type: 'number', unit: 'kV', unitOptions: [{ label: 'kV', mult: 1 }, { label: 'V', mult: 0.001 }] },
      { key: 'topology', label: 'Topology', type: 'select', options: ['online_double', 'offline_standby', 'line_interactive'] },
      { key: 'efficiency', label: 'Efficiency', type: 'number', min: 0.8, max: 1.0, step: 0.01 },
      { key: 'power_factor', label: 'Power Factor', type: 'number', min: 0.5, max: 1.0, step: 0.01 },
      { key: 'battery_autonomy_min', label: 'Battery Autonomy', type: 'number', unit: 'min' },
      { key: 'battery_voltage_vdc', label: 'Battery Voltage', type: 'number', unit: 'Vdc' },
    ],
  },
  rectifier: {
    name: 'Rectifier',
    label: 'AC/DC Rectifier',
    category: 'dc_systems',
    ports: [
      { id: 'ac_in', side: 'top', offset: 0 },
      { id: 'dc_out', side: 'bottom', offset: 0 },
    ],
    width: 60,
    height: 55,
    defaults: {
      name: 'Rect',
      rated_kw: 50,
      voltage_ac_kv: 0.4,
      voltage_dc_v: 125,
      rectifier_type: 'thyristor',
      efficiency: 0.92,
      ripple_pct: 5,
      num_pulses: '6', // string to match the select options
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'rated_kw', label: 'Rating', type: 'number', unit: 'kW' },
      { key: 'voltage_ac_kv', label: 'AC Voltage', type: 'number', unit: 'kV', unitOptions: [{ label: 'kV', mult: 1 }, { label: 'V', mult: 0.001 }] },
      { key: 'voltage_dc_v', label: 'DC Voltage', type: 'number', unit: 'Vdc' },
      { key: 'rectifier_type', label: 'Type', type: 'select', options: ['diode', 'thyristor', 'igbt'] },
      { key: 'efficiency', label: 'Efficiency', type: 'number', min: 0.8, max: 1.0, step: 0.01 },
      { key: 'ripple_pct', label: 'Ripple', type: 'number', unit: '%', min: 0, max: 20, step: 0.5 },
      { key: 'num_pulses', label: 'Pulse Number', type: 'select', options: ['6', '12', '24'] },
    ],
  },
  charger: {
    name: 'Battery Charger',
    label: 'Battery Charger',
    category: 'dc_systems',
    ports: [
      { id: 'ac_in', side: 'top', offset: 0 },
      { id: 'dc_out', side: 'bottom', offset: 0 },
    ],
    width: 60,
    height: 55,
    defaults: {
      name: 'Chgr',
      rated_a: 200,
      voltage_ac_kv: 0.4,
      voltage_dc_v: 125,
      charger_type: 'float_equalize',
      float_voltage_v: 131,
      equalize_voltage_v: 140,
      efficiency: 0.90,
      current_limit_pct: 100,
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'rated_a', label: 'Rated Current', type: 'number', unit: 'A' },
      { key: 'voltage_ac_kv', label: 'AC Input Voltage', type: 'number', unit: 'kV', unitOptions: [{ label: 'kV', mult: 1 }, { label: 'V', mult: 0.001 }] },
      { key: 'voltage_dc_v', label: 'DC Output Voltage', type: 'number', unit: 'Vdc' },
      { key: 'charger_type', label: 'Charge Mode', type: 'select', options: ['float_equalize', 'float_only', 'constant_current'] },
      { key: 'float_voltage_v', label: 'Float Voltage', type: 'number', unit: 'V' },
      { key: 'equalize_voltage_v', label: 'Equalize Voltage', type: 'number', unit: 'V', showWhen: { field: 'charger_type', values: ['float_equalize'] } },
      { key: 'efficiency', label: 'Efficiency', type: 'number', min: 0.8, max: 1.0, step: 0.01 },
      { key: 'current_limit_pct', label: 'Current Limit', type: 'number', unit: '%', min: 10, max: 100, step: 5 },
    ],
  },

  dc_battery: {
    name: 'DC Battery',
    label: 'DC Battery Bank',
    category: 'dc_systems',
    ports: [{ id: 'dc', side: 'top', offset: 0 }],
    width: 50,
    height: 50,
    defaults: {
      name: 'Battery',
      nominal_v: 125,
      emf_v: 0,
      ah_capacity: 200,
      internal_r_mohm: 20,
      internal_l_uh: 0,
      max_discharge_a: 0,
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'nominal_v', label: 'Nominal Voltage', type: 'number', unit: 'Vdc', min: 0 },
      { key: 'ah_capacity', label: 'Capacity', type: 'number', unit: 'Ah', min: 0 },
      { key: 'emf_v', label: 'Open-circuit EMF (0 = 1.05·Unom)', type: 'number', unit: 'Vdc', min: 0, section: 'fault' },
      { key: 'internal_r_mohm', label: 'Internal Resistance', type: 'number', unit: 'mΩ', min: 0, step: 1, section: 'fault' },
      { key: 'internal_l_uh', label: 'Internal Inductance', type: 'number', unit: 'µH', min: 0, step: 1, section: 'fault' },
      { key: 'max_discharge_a', label: 'Max Discharge (0 = auto)', type: 'number', unit: 'A', min: 0, section: 'loadflow' },
    ],
  },
  dc_load: {
    name: 'DC Load',
    label: 'DC Load',
    category: 'loads',
    ports: [{ id: 'in', side: 'top', offset: 0 }],
    width: 40,
    height: 40,
    defaults: {
      name: 'DC Load',
      load_model: 'constant_power',
      load_kw: 1.0,
      load_a: 10,
      resistance_ohm: 10,
      nominal_v: 125,
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'load_model', label: 'Load Model', type: 'select', options: ['constant_power', 'constant_current', 'constant_resistance'] },
      { key: 'load_kw', label: 'Power', type: 'number', unit: 'kW', min: 0, step: 0.1, showWhen: { field: 'load_model', values: ['constant_power'] } },
      { key: 'load_a', label: 'Current', type: 'number', unit: 'A', min: 0, showWhen: { field: 'load_model', values: ['constant_current'] } },
      { key: 'resistance_ohm', label: 'Resistance', type: 'number', unit: 'Ω', min: 0, step: 0.1, showWhen: { field: 'load_model', values: ['constant_resistance'] } },
      { key: 'nominal_v', label: 'Nominal Voltage', type: 'number', unit: 'Vdc', min: 0 },
    ],
  },

  // --- Other ---
  vfd: {
    name: 'Variable Frequency Drive',
    category: 'loads',
    ports: [
      { id: 'in', side: 'top', offset: 0 },
      { id: 'out', side: 'bottom', offset: 0 },
    ],
    width: 50,
    height: 50,
    defaults: {
      name: 'VFD',
      rated_kw: 200,
      voltage_kv: 0.4,
      efficiency: 0.96,
      load_pct: 100,
      displacement_pf: 0.98,
      pulse_number: 6,
      front_end: 'diode',
      input_reactor_pct: 3,
      demand_factor: 1.0,
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'rated_kw', label: 'Rating', type: 'number', unit: 'kW' },
      { key: 'voltage_kv', label: 'Voltage', type: 'number', unit: 'kV', unitOptions: [{ label: 'kV', mult: 1 }, { label: 'V', mult: 0.001 }] },
      { key: 'efficiency', label: 'Efficiency', type: 'number', min: 0.5, max: 1, step: 0.01 },
      { key: 'load_pct', label: 'Loading', type: 'number', unit: '%', min: 0, max: 100 },
      { key: 'displacement_pf', label: 'Displacement PF', type: 'number', min: 0.5, max: 1, step: 0.01 },
      { key: 'demand_factor', label: 'Demand Factor', type: 'number', min: 0, max: 1, step: 0.05, section: 'loadflow' },
      { key: 'customers', label: 'Customers Served', type: 'number', min: 0, step: 1, section: 'reliability' },
      { key: 'pulse_number', label: 'Rectifier Pulses', type: 'select', options: [{ value: 6, label: '6-pulse' }, { value: 12, label: '12-pulse' }, { value: 18, label: '18-pulse' }, { value: 24, label: '24-pulse' }], section: 'harmonics' },
      { key: 'front_end', label: 'Front End', type: 'select', options: [{ value: 'diode', label: 'Diode rectifier' }, { value: 'afe', label: 'Active front end (AFE)' }], section: 'harmonics' },
      { key: 'input_reactor_pct', label: 'AC/DC Reactor', type: 'number', unit: '%', min: 0, max: 10, step: 0.5, section: 'harmonics' },
    ],
  },
  svc: {
    name: 'SVC / STATCOM',
    category: 'other',
    ports: [{ id: 'in', side: 'top', offset: 0 }],
    width: 44,
    height: 44,
    defaults: {
      name: 'SVC',
      device_mode: 'statcom',
      control_mode: 'voltage_regulating',
      voltage_kv: 33,
      v_setpoint_pu: 1.0,
      rated_mvar: 50,
      q_max_mvar: 50,
      q_min_mvar: -50,
      q_output_mvar: 0,
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'device_mode', label: 'Device', type: 'select', options: [{ value: 'statcom', label: 'STATCOM (constant Q)' }, { value: 'svc', label: 'SVC (susceptance, Q∝V²)' }] },
      { key: 'control_mode', label: 'Control', type: 'select', options: [{ value: 'voltage_regulating', label: 'Voltage regulating' }, { value: 'fixed_q', label: 'Fixed reactive output' }] },
      { key: 'voltage_kv', label: 'Voltage', type: 'number', unit: 'kV' },
      { key: 'v_setpoint_pu', label: 'Voltage Setpoint', type: 'number', unit: 'pu', min: 0.9, max: 1.1, step: 0.005, showWhen: { field: 'control_mode', values: ['voltage_regulating'] } },
      { key: 'q_output_mvar', label: 'Reactive Output', type: 'number', unit: 'MVAr', showWhen: { field: 'control_mode', values: ['fixed_q'] } },
      { key: 'q_max_mvar', label: 'Q Max (capacitive)', type: 'number', unit: 'MVAr', section: 'loadflow' },
      { key: 'q_min_mvar', label: 'Q Min (inductive)', type: 'number', unit: 'MVAr', section: 'loadflow' },
    ],
  },
  capacitor_bank: {
    name: 'Capacitor Bank',
    category: 'other',
    ports: [{ id: 'in', side: 'top', offset: 0 }],
    width: 40,
    height: 35,
    defaults: {
      name: 'Cap',
      rated_kvar: 100,
      voltage_kv: 11,
      steps: 1,
      steps_in_service: 1,
      tuned_order: 0,
      quality_factor: 30,
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'rated_kvar', label: 'Rating', type: 'number', unit: 'kVAr' },
      { key: 'voltage_kv', label: 'Voltage', type: 'number', unit: 'kV' },
      { key: 'steps', label: 'Steps', type: 'number', min: 1, step: 1 },
      { key: 'steps_in_service', label: 'Steps In Service', type: 'number', min: 0, step: 1 },
      { key: 'tuned_order', label: 'Tuned Order (0 = plain cap)', type: 'number', min: 0, step: 0.1, section: 'harmonics' },
      { key: 'quality_factor', label: 'Quality Factor', type: 'number', min: 5, max: 150, step: 5, section: 'harmonics', showWhen: { field: 'tuned_order', min: 1.01 } },
    ],
  },
  surge_arrester: {
    name: 'Surge Arrester',
    category: 'other',
    ports: [
      { id: 'top', side: 'top', offset: 0 },
      { id: 'bottom', side: 'bottom', offset: 0 },
    ],
    width: 30,
    height: 50,
    defaults: {
      name: 'SA',
      rated_voltage_kv: 11,
      mcov_kv: 8.4,
      class: 'Station',
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'rated_voltage_kv', label: 'Rated Voltage', type: 'number', unit: 'kV' },
      { key: 'mcov_kv', label: 'MCOV', type: 'number', unit: 'kV' },
      { key: 'class', label: 'Class', type: 'select', options: ['Station', 'Intermediate', 'Distribution'] },
    ],
  },

  offpage_connector: {
    name: 'Off-Page Connector',
    label: 'Off-Page Connector',
    category: 'other',
    ports: [
      { id: 'port', side: 'bottom', offset: 0 },
    ],
    width: 40,
    height: 40,
    defaults: {
      name: 'X1',
      target_page: '',
      target_label: '',
    },
    fields: [
      { key: 'name', label: 'Label', type: 'text' },
      { key: 'target_page', label: 'Target Page', type: 'text' },
      { key: 'target_label', label: 'Target Label', type: 'text' },
    ],
  },

  // ── Control circuit components (IEC 60617) ──
  // Two-terminal series devices simulated by ControlSim; contacts bind to
  // coils via the `tag` prop (contact follows the coil with the same tag).

  ctl_supply: {
    name: 'Control Supply',
    category: 'control',
    ports: [
      { id: 'l', side: 'bottom', offset: -15 },
      { id: 'n', side: 'bottom', offset: 15 },
    ],
    width: 60,
    height: 36,
    defaults: {
      name: 'CTRL',
      supply_type: '230VAC',
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'supply_type', label: 'Supply', type: 'select',
        options: ['230VAC', '110VAC', '24VDC', '110VDC'] },
    ],
  },

  ctl_breaker: {
    name: 'Control Breaker (MCB)',
    category: 'control',
    ports: [
      { id: 'top', side: 'top', offset: 0 },
      { id: 'bottom', side: 'bottom', offset: 0 },
    ],
    width: 30,
    height: 40,
    defaults: {
      name: 'Q1',
      state: 'closed',
      rating_a: 6,
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'state', label: 'State', type: 'select', options: ['closed', 'open'] },
      { key: 'rating_a', label: 'Rating', type: 'number', unit: 'A' },
    ],
  },

  ctl_pb_no: {
    name: 'Pushbutton NO',
    category: 'control',
    ports: [
      { id: 'top', side: 'top', offset: 0 },
      { id: 'bottom', side: 'bottom', offset: 0 },
    ],
    width: 30,
    height: 40,
    defaults: { name: 'S1' },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
    ],
  },

  ctl_pb_nc: {
    name: 'Pushbutton NC',
    category: 'control',
    ports: [
      { id: 'top', side: 'top', offset: 0 },
      { id: 'bottom', side: 'bottom', offset: 0 },
    ],
    width: 30,
    height: 40,
    defaults: { name: 'S0' },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
    ],
  },

  ctl_switch: {
    name: 'Selector Switch',
    category: 'control',
    ports: [
      { id: 'top', side: 'top', offset: 0 },
      { id: 'bottom', side: 'bottom', offset: 0 },
    ],
    width: 30,
    height: 40,
    defaults: {
      name: 'SA1',
      state: 'open',
      contact_type: 'no',
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'state', label: 'State', type: 'select', options: ['open', 'closed'] },
      { key: 'contact_type', label: 'Contact', type: 'select', options: ['no', 'nc'] },
    ],
  },

  ctl_contact_no: {
    name: 'Contact NO',
    category: 'control',
    ports: [
      { id: 'top', side: 'top', offset: 0 },
      { id: 'bottom', side: 'bottom', offset: 0 },
    ],
    width: 30,
    height: 40,
    defaults: {
      name: 'K1.1',
      tag: 'K1',
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'tag', label: 'Coil Tag', type: 'text' },
    ],
  },

  ctl_contact_nc: {
    name: 'Contact NC',
    category: 'control',
    ports: [
      { id: 'top', side: 'top', offset: 0 },
      { id: 'bottom', side: 'bottom', offset: 0 },
    ],
    width: 30,
    height: 40,
    defaults: {
      name: 'K1.2',
      tag: 'K1',
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'tag', label: 'Coil Tag', type: 'text' },
    ],
  },

  ctl_coil: {
    name: 'Coil / Relay',
    category: 'control',
    ports: [
      { id: 'top', side: 'top', offset: 0 },
      { id: 'bottom', side: 'bottom', offset: 0 },
    ],
    width: 34,
    height: 44,
    defaults: {
      name: 'K1',
      tag: 'K1',
      coil_type: 'contactor',
      delay_s: 1.0,
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'tag', label: 'Tag', type: 'text' },
      { key: 'coil_type', label: 'Type', type: 'select',
        options: ['contactor', 'relay', 'timer_on', 'timer_off'] },
      { key: 'delay_s', label: 'Delay', type: 'number', unit: 's',
        showWhen: { field: 'coil_type', values: ['timer_on', 'timer_off'] } },
    ],
  },

  ctl_lamp: {
    name: 'Pilot Lamp',
    category: 'control',
    ports: [
      { id: 'top', side: 'top', offset: 0 },
      { id: 'bottom', side: 'bottom', offset: 0 },
    ],
    width: 30,
    height: 40,
    defaults: {
      name: 'H1',
      color: 'green',
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'color', label: 'Color', type: 'select',
        options: ['green', 'red', 'amber', 'white', 'blue'] },
    ],
  },
};

// Component attributes that affect a (balanced) load-flow solution, per type,
// used by the Load Flow Study Manager (lfstudy.js) to build its editable
// attribute grid. Each key is resolved to its field descriptor (label / type /
// unit / options / min / max / step) in COMPONENT_DEFS[type].fields at render
// time, so labels and input kinds stay in sync with the properties panel.
const LF_ATTRS = {
  utility: ['supply_capacity_mva', 'allow_export', 'dispatch_priority', 'fault_mva',
            'lf_grid_model', 'v_setpoint_pu', 'cost_per_mwh'],
  generator: ['rated_mva', 'power_factor', 'dispatch_priority', 'dispatch_mode',
              'min_load_pct', 'max_load_pct', 'gen_control', 'start_threshold_pct',
              'voltage_setpoint_pu', 'q_max_mvar', 'q_min_mvar', 'cost_per_mwh'],
  solar_pv: ['rated_kw', 'num_inverters', 'inverter_eff', 'power_factor', 'irradiance_pct',
             'pv_array_mode', 'dispatch_priority', 'dispatch_mode', 'battery_mode',
             'battery_soc_pct', 'battery_max_discharge_kw', 'battery_max_charge_kw',
             'var_mode', 'v_setpoint_pu'],
  wind_turbine: ['rated_mva', 'num_turbines', 'power_factor', 'wind_speed_pct',
                 'dispatch_priority', 'dispatch_mode'],
  battery: ['rated_kva', 'battery_kwh', 'battery_mode', 'battery_soc_pct', 'battery_dod_pct',
            'battery_max_charge_kw', 'battery_max_discharge_kw', 'dispatch_priority',
            'var_mode', 'v_setpoint_pu'],
  bus: ['system', 'voltage_kv', 'bus_type'],
  distribution_board: ['voltage_kv', 'rated_kva', 'power_factor', 'demand_factor'],
  transformer: ['rated_mva', 'z_percent', 'x_r_ratio', 'voltage_hv_kv', 'voltage_lv_kv', 'tap_mode', 'tap_percent'],
  autotransformer: ['windings', 'rated_mva', 'z_percent', 'voltage_hv_kv', 'voltage_lv_kv', 'tap_mode', 'tap_percent'],
  cable: ['voltage_kv', 'r_per_km', 'x_per_km', 'length_km', 'num_parallel', 'rated_amps'],
  static_load: ['rated_kva', 'power_factor', 'demand_factor'],
  motor_induction: ['rated_kw', 'efficiency', 'power_factor', 'demand_factor'],
  motor_synchronous: ['rated_kva', 'power_factor', 'demand_factor'],
  vfd: ['rated_kw', 'voltage_kv', 'displacement_pf', 'pulse_number', 'front_end', 'demand_factor'],
  capacitor_bank: ['rated_kvar'],
  svc: ['device_mode', 'control_mode', 'v_setpoint_pu', 'q_max_mvar', 'q_min_mvar'],
  cb: ['state'],
  switch: ['state'],
};
