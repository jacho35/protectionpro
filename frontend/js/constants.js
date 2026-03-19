/* ProtectionPro — Constants & Configuration */

const GRID_SIZE = 20;
const SNAP_SIZE = 20;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 5;
const ZOOM_STEP = 0.1;
const DEFAULT_BASE_MVA = 100;
const DEFAULT_FREQUENCY = 50;

const API_BASE = '/api';

// ─── Standard Cable Library ───
// Typical MV/LV XLPE cable data per IEC 60502 / SANS 1339
// Values: R and X at 90°C, trefoil formation
const STANDARD_CABLES = [
  // MV XLPE Copper (11kV)
  { id: 'cu_xlpe_16_11kv',  name: '16mm² Cu XLPE 11kV',   conductor: 'Cu', insulation: 'XLPE', size_mm2: 16,  voltage_kv: 11,  r_per_km: 1.15,   x_per_km: 0.119, rated_amps: 110 },
  { id: 'cu_xlpe_25_11kv',  name: '25mm² Cu XLPE 11kV',   conductor: 'Cu', insulation: 'XLPE', size_mm2: 25,  voltage_kv: 11,  r_per_km: 0.727,  x_per_km: 0.113, rated_amps: 140 },
  { id: 'cu_xlpe_35_11kv',  name: '35mm² Cu XLPE 11kV',   conductor: 'Cu', insulation: 'XLPE', size_mm2: 35,  voltage_kv: 11,  r_per_km: 0.524,  x_per_km: 0.110, rated_amps: 170 },
  { id: 'cu_xlpe_50_11kv',  name: '50mm² Cu XLPE 11kV',   conductor: 'Cu', insulation: 'XLPE', size_mm2: 50,  voltage_kv: 11,  r_per_km: 0.387,  x_per_km: 0.107, rated_amps: 200 },
  { id: 'cu_xlpe_70_11kv',  name: '70mm² Cu XLPE 11kV',   conductor: 'Cu', insulation: 'XLPE', size_mm2: 70,  voltage_kv: 11,  r_per_km: 0.268,  x_per_km: 0.104, rated_amps: 245 },
  { id: 'cu_xlpe_95_11kv',  name: '95mm² Cu XLPE 11kV',   conductor: 'Cu', insulation: 'XLPE', size_mm2: 95,  voltage_kv: 11,  r_per_km: 0.193,  x_per_km: 0.101, rated_amps: 300 },
  { id: 'cu_xlpe_120_11kv', name: '120mm² Cu XLPE 11kV',  conductor: 'Cu', insulation: 'XLPE', size_mm2: 120, voltage_kv: 11,  r_per_km: 0.153,  x_per_km: 0.099, rated_amps: 340 },
  { id: 'cu_xlpe_150_11kv', name: '150mm² Cu XLPE 11kV',  conductor: 'Cu', insulation: 'XLPE', size_mm2: 150, voltage_kv: 11,  r_per_km: 0.124,  x_per_km: 0.097, rated_amps: 380 },
  { id: 'cu_xlpe_185_11kv', name: '185mm² Cu XLPE 11kV',  conductor: 'Cu', insulation: 'XLPE', size_mm2: 185, voltage_kv: 11,  r_per_km: 0.0991, x_per_km: 0.095, rated_amps: 430 },
  { id: 'cu_xlpe_240_11kv', name: '240mm² Cu XLPE 11kV',  conductor: 'Cu', insulation: 'XLPE', size_mm2: 240, voltage_kv: 11,  r_per_km: 0.0754, x_per_km: 0.093, rated_amps: 500 },
  { id: 'cu_xlpe_300_11kv', name: '300mm² Cu XLPE 11kV',  conductor: 'Cu', insulation: 'XLPE', size_mm2: 300, voltage_kv: 11,  r_per_km: 0.0601, x_per_km: 0.091, rated_amps: 560 },
  { id: 'cu_xlpe_400_11kv', name: '400mm² Cu XLPE 11kV',  conductor: 'Cu', insulation: 'XLPE', size_mm2: 400, voltage_kv: 11,  r_per_km: 0.0470, x_per_km: 0.089, rated_amps: 630 },
  // MV XLPE Aluminium (11kV)
  { id: 'al_xlpe_35_11kv',  name: '35mm² Al XLPE 11kV',   conductor: 'Al', insulation: 'XLPE', size_mm2: 35,  voltage_kv: 11,  r_per_km: 0.868,  x_per_km: 0.110, rated_amps: 130 },
  { id: 'al_xlpe_50_11kv',  name: '50mm² Al XLPE 11kV',   conductor: 'Al', insulation: 'XLPE', size_mm2: 50,  voltage_kv: 11,  r_per_km: 0.641,  x_per_km: 0.107, rated_amps: 155 },
  { id: 'al_xlpe_70_11kv',  name: '70mm² Al XLPE 11kV',   conductor: 'Al', insulation: 'XLPE', size_mm2: 70,  voltage_kv: 11,  r_per_km: 0.443,  x_per_km: 0.104, rated_amps: 190 },
  { id: 'al_xlpe_95_11kv',  name: '95mm² Al XLPE 11kV',   conductor: 'Al', insulation: 'XLPE', size_mm2: 95,  voltage_kv: 11,  r_per_km: 0.320,  x_per_km: 0.101, rated_amps: 230 },
  { id: 'al_xlpe_120_11kv', name: '120mm² Al XLPE 11kV',  conductor: 'Al', insulation: 'XLPE', size_mm2: 120, voltage_kv: 11,  r_per_km: 0.253,  x_per_km: 0.099, rated_amps: 265 },
  { id: 'al_xlpe_150_11kv', name: '150mm² Al XLPE 11kV',  conductor: 'Al', insulation: 'XLPE', size_mm2: 150, voltage_kv: 11,  r_per_km: 0.206,  x_per_km: 0.097, rated_amps: 300 },
  { id: 'al_xlpe_185_11kv', name: '185mm² Al XLPE 11kV',  conductor: 'Al', insulation: 'XLPE', size_mm2: 185, voltage_kv: 11,  r_per_km: 0.164,  x_per_km: 0.095, rated_amps: 340 },
  { id: 'al_xlpe_240_11kv', name: '240mm² Al XLPE 11kV',  conductor: 'Al', insulation: 'XLPE', size_mm2: 240, voltage_kv: 11,  r_per_km: 0.125,  x_per_km: 0.093, rated_amps: 395 },
  { id: 'al_xlpe_300_11kv', name: '300mm² Al XLPE 11kV',  conductor: 'Al', insulation: 'XLPE', size_mm2: 300, voltage_kv: 11,  r_per_km: 0.100,  x_per_km: 0.091, rated_amps: 445 },
  { id: 'al_xlpe_400_11kv', name: '400mm² Al XLPE 11kV',  conductor: 'Al', insulation: 'XLPE', size_mm2: 400, voltage_kv: 11,  r_per_km: 0.0778, x_per_km: 0.089, rated_amps: 505 },
  // LV XLPE Copper (0.6/1kV)
  { id: 'cu_xlpe_16_lv',  name: '16mm² Cu XLPE LV',   conductor: 'Cu', insulation: 'XLPE', size_mm2: 16,  voltage_kv: 0.4, r_per_km: 1.15,   x_per_km: 0.082, rated_amps: 91  },
  { id: 'cu_xlpe_25_lv',  name: '25mm² Cu XLPE LV',   conductor: 'Cu', insulation: 'XLPE', size_mm2: 25,  voltage_kv: 0.4, r_per_km: 0.727,  x_per_km: 0.079, rated_amps: 116 },
  { id: 'cu_xlpe_35_lv',  name: '35mm² Cu XLPE LV',   conductor: 'Cu', insulation: 'XLPE', size_mm2: 35,  voltage_kv: 0.4, r_per_km: 0.524,  x_per_km: 0.077, rated_amps: 140 },
  { id: 'cu_xlpe_50_lv',  name: '50mm² Cu XLPE LV',   conductor: 'Cu', insulation: 'XLPE', size_mm2: 50,  voltage_kv: 0.4, r_per_km: 0.387,  x_per_km: 0.075, rated_amps: 167 },
  { id: 'cu_xlpe_70_lv',  name: '70mm² Cu XLPE LV',   conductor: 'Cu', insulation: 'XLPE', size_mm2: 70,  voltage_kv: 0.4, r_per_km: 0.268,  x_per_km: 0.073, rated_amps: 210 },
  { id: 'cu_xlpe_95_lv',  name: '95mm² Cu XLPE LV',   conductor: 'Cu', insulation: 'XLPE', size_mm2: 95,  voltage_kv: 0.4, r_per_km: 0.193,  x_per_km: 0.072, rated_amps: 254 },
  { id: 'cu_xlpe_120_lv', name: '120mm² Cu XLPE LV',  conductor: 'Cu', insulation: 'XLPE', size_mm2: 120, voltage_kv: 0.4, r_per_km: 0.153,  x_per_km: 0.071, rated_amps: 292 },
  { id: 'cu_xlpe_150_lv', name: '150mm² Cu XLPE LV',  conductor: 'Cu', insulation: 'XLPE', size_mm2: 150, voltage_kv: 0.4, r_per_km: 0.124,  x_per_km: 0.070, rated_amps: 330 },
  { id: 'cu_xlpe_185_lv', name: '185mm² Cu XLPE LV',  conductor: 'Cu', insulation: 'XLPE', size_mm2: 185, voltage_kv: 0.4, r_per_km: 0.0991, x_per_km: 0.069, rated_amps: 375 },
  { id: 'cu_xlpe_240_lv', name: '240mm² Cu XLPE LV',  conductor: 'Cu', insulation: 'XLPE', size_mm2: 240, voltage_kv: 0.4, r_per_km: 0.0754, x_per_km: 0.068, rated_amps: 440 },
  { id: 'cu_xlpe_300_lv', name: '300mm² Cu XLPE LV',  conductor: 'Cu', insulation: 'XLPE', size_mm2: 300, voltage_kv: 0.4, r_per_km: 0.0601, x_per_km: 0.067, rated_amps: 500 },
  // MV XLPE Copper (22kV)
  { id: 'cu_xlpe_35_22kv',  name: '35mm² Cu XLPE 22kV',   conductor: 'Cu', insulation: 'XLPE', size_mm2: 35,  voltage_kv: 22,  r_per_km: 0.524,  x_per_km: 0.122, rated_amps: 160 },
  { id: 'cu_xlpe_50_22kv',  name: '50mm² Cu XLPE 22kV',   conductor: 'Cu', insulation: 'XLPE', size_mm2: 50,  voltage_kv: 22,  r_per_km: 0.387,  x_per_km: 0.118, rated_amps: 190 },
  { id: 'cu_xlpe_70_22kv',  name: '70mm² Cu XLPE 22kV',   conductor: 'Cu', insulation: 'XLPE', size_mm2: 70,  voltage_kv: 22,  r_per_km: 0.268,  x_per_km: 0.114, rated_amps: 235 },
  { id: 'cu_xlpe_95_22kv',  name: '95mm² Cu XLPE 22kV',   conductor: 'Cu', insulation: 'XLPE', size_mm2: 95,  voltage_kv: 22,  r_per_km: 0.193,  x_per_km: 0.111, rated_amps: 280 },
  { id: 'cu_xlpe_120_22kv', name: '120mm² Cu XLPE 22kV',  conductor: 'Cu', insulation: 'XLPE', size_mm2: 120, voltage_kv: 22,  r_per_km: 0.153,  x_per_km: 0.108, rated_amps: 320 },
  { id: 'cu_xlpe_150_22kv', name: '150mm² Cu XLPE 22kV',  conductor: 'Cu', insulation: 'XLPE', size_mm2: 150, voltage_kv: 22,  r_per_km: 0.124,  x_per_km: 0.106, rated_amps: 360 },
  { id: 'cu_xlpe_185_22kv', name: '185mm² Cu XLPE 22kV',  conductor: 'Cu', insulation: 'XLPE', size_mm2: 185, voltage_kv: 22,  r_per_km: 0.0991, x_per_km: 0.104, rated_amps: 410 },
  { id: 'cu_xlpe_240_22kv', name: '240mm² Cu XLPE 22kV',  conductor: 'Cu', insulation: 'XLPE', size_mm2: 240, voltage_kv: 22,  r_per_km: 0.0754, x_per_km: 0.101, rated_amps: 475 },
  { id: 'cu_xlpe_300_22kv', name: '300mm² Cu XLPE 22kV',  conductor: 'Cu', insulation: 'XLPE', size_mm2: 300, voltage_kv: 22,  r_per_km: 0.0601, x_per_km: 0.099, rated_amps: 535 },
  // MV XLPE Copper (33kV)
  { id: 'cu_xlpe_50_33kv',  name: '50mm² Cu XLPE 33kV',   conductor: 'Cu', insulation: 'XLPE', size_mm2: 50,  voltage_kv: 33,  r_per_km: 0.387,  x_per_km: 0.130, rated_amps: 175 },
  { id: 'cu_xlpe_70_33kv',  name: '70mm² Cu XLPE 33kV',   conductor: 'Cu', insulation: 'XLPE', size_mm2: 70,  voltage_kv: 33,  r_per_km: 0.268,  x_per_km: 0.126, rated_amps: 220 },
  { id: 'cu_xlpe_95_33kv',  name: '95mm² Cu XLPE 33kV',   conductor: 'Cu', insulation: 'XLPE', size_mm2: 95,  voltage_kv: 33,  r_per_km: 0.193,  x_per_km: 0.122, rated_amps: 265 },
  { id: 'cu_xlpe_120_33kv', name: '120mm² Cu XLPE 33kV',  conductor: 'Cu', insulation: 'XLPE', size_mm2: 120, voltage_kv: 33,  r_per_km: 0.153,  x_per_km: 0.119, rated_amps: 300 },
  { id: 'cu_xlpe_150_33kv', name: '150mm² Cu XLPE 33kV',  conductor: 'Cu', insulation: 'XLPE', size_mm2: 150, voltage_kv: 33,  r_per_km: 0.124,  x_per_km: 0.117, rated_amps: 340 },
  { id: 'cu_xlpe_185_33kv', name: '185mm² Cu XLPE 33kV',  conductor: 'Cu', insulation: 'XLPE', size_mm2: 185, voltage_kv: 33,  r_per_km: 0.0991, x_per_km: 0.114, rated_amps: 385 },
  { id: 'cu_xlpe_240_33kv', name: '240mm² Cu XLPE 33kV',  conductor: 'Cu', insulation: 'XLPE', size_mm2: 240, voltage_kv: 33,  r_per_km: 0.0754, x_per_km: 0.112, rated_amps: 450 },
  { id: 'cu_xlpe_300_33kv', name: '300mm² Cu XLPE 33kV',  conductor: 'Cu', insulation: 'XLPE', size_mm2: 300, voltage_kv: 33,  r_per_km: 0.0601, x_per_km: 0.109, rated_amps: 510 },
  { id: 'cu_xlpe_400_33kv', name: '400mm² Cu XLPE 33kV',  conductor: 'Cu', insulation: 'XLPE', size_mm2: 400, voltage_kv: 33,  r_per_km: 0.0470, x_per_km: 0.107, rated_amps: 575 },
  // LV XLPE Aluminium (0.6/1kV)
  { id: 'al_xlpe_16_lv',  name: '16mm² Al XLPE LV',   conductor: 'Al', insulation: 'XLPE', size_mm2: 16,  voltage_kv: 0.4, r_per_km: 1.91,   x_per_km: 0.082, rated_amps: 70  },
  { id: 'al_xlpe_25_lv',  name: '25mm² Al XLPE LV',   conductor: 'Al', insulation: 'XLPE', size_mm2: 25,  voltage_kv: 0.4, r_per_km: 1.20,   x_per_km: 0.079, rated_amps: 90  },
  { id: 'al_xlpe_35_lv',  name: '35mm² Al XLPE LV',   conductor: 'Al', insulation: 'XLPE', size_mm2: 35,  voltage_kv: 0.4, r_per_km: 0.868,  x_per_km: 0.077, rated_amps: 110 },
  { id: 'al_xlpe_50_lv',  name: '50mm² Al XLPE LV',   conductor: 'Al', insulation: 'XLPE', size_mm2: 50,  voltage_kv: 0.4, r_per_km: 0.641,  x_per_km: 0.075, rated_amps: 130 },
  { id: 'al_xlpe_70_lv',  name: '70mm² Al XLPE LV',   conductor: 'Al', insulation: 'XLPE', size_mm2: 70,  voltage_kv: 0.4, r_per_km: 0.443,  x_per_km: 0.073, rated_amps: 165 },
  { id: 'al_xlpe_95_lv',  name: '95mm² Al XLPE LV',   conductor: 'Al', insulation: 'XLPE', size_mm2: 95,  voltage_kv: 0.4, r_per_km: 0.320,  x_per_km: 0.072, rated_amps: 200 },
  { id: 'al_xlpe_120_lv', name: '120mm² Al XLPE LV',  conductor: 'Al', insulation: 'XLPE', size_mm2: 120, voltage_kv: 0.4, r_per_km: 0.253,  x_per_km: 0.071, rated_amps: 230 },
  { id: 'al_xlpe_150_lv', name: '150mm² Al XLPE LV',  conductor: 'Al', insulation: 'XLPE', size_mm2: 150, voltage_kv: 0.4, r_per_km: 0.206,  x_per_km: 0.070, rated_amps: 260 },
  { id: 'al_xlpe_185_lv', name: '185mm² Al XLPE LV',  conductor: 'Al', insulation: 'XLPE', size_mm2: 185, voltage_kv: 0.4, r_per_km: 0.164,  x_per_km: 0.069, rated_amps: 295 },
  { id: 'al_xlpe_240_lv', name: '240mm² Al XLPE LV',  conductor: 'Al', insulation: 'XLPE', size_mm2: 240, voltage_kv: 0.4, r_per_km: 0.125,  x_per_km: 0.068, rated_amps: 350 },
  { id: 'al_xlpe_300_lv', name: '300mm² Al XLPE LV',  conductor: 'Al', insulation: 'XLPE', size_mm2: 300, voltage_kv: 0.4, r_per_km: 0.100,  x_per_km: 0.067, rated_amps: 395 },
  // LV PVC Copper (0.6/1kV)
  { id: 'cu_pvc_1.5_lv',  name: '1.5mm² Cu PVC LV',   conductor: 'Cu', insulation: 'PVC',  size_mm2: 1.5, voltage_kv: 0.4, r_per_km: 12.1,   x_per_km: 0.094, rated_amps: 18  },
  { id: 'cu_pvc_2.5_lv',  name: '2.5mm² Cu PVC LV',   conductor: 'Cu', insulation: 'PVC',  size_mm2: 2.5, voltage_kv: 0.4, r_per_km: 7.41,   x_per_km: 0.090, rated_amps: 25  },
  { id: 'cu_pvc_4_lv',    name: '4mm² Cu PVC LV',     conductor: 'Cu', insulation: 'PVC',  size_mm2: 4,   voltage_kv: 0.4, r_per_km: 4.61,   x_per_km: 0.087, rated_amps: 34  },
  { id: 'cu_pvc_6_lv',    name: '6mm² Cu PVC LV',     conductor: 'Cu', insulation: 'PVC',  size_mm2: 6,   voltage_kv: 0.4, r_per_km: 3.08,   x_per_km: 0.084, rated_amps: 43  },
  { id: 'cu_pvc_10_lv',   name: '10mm² Cu PVC LV',    conductor: 'Cu', insulation: 'PVC',  size_mm2: 10,  voltage_kv: 0.4, r_per_km: 1.83,   x_per_km: 0.080, rated_amps: 60  },
  { id: 'cu_pvc_16_lv',   name: '16mm² Cu PVC LV',    conductor: 'Cu', insulation: 'PVC',  size_mm2: 16,  voltage_kv: 0.4, r_per_km: 1.15,   x_per_km: 0.079, rated_amps: 80  },
  { id: 'cu_pvc_25_lv',   name: '25mm² Cu PVC LV',    conductor: 'Cu', insulation: 'PVC',  size_mm2: 25,  voltage_kv: 0.4, r_per_km: 0.727,  x_per_km: 0.077, rated_amps: 101 },
  { id: 'cu_pvc_35_lv',   name: '35mm² Cu PVC LV',    conductor: 'Cu', insulation: 'PVC',  size_mm2: 35,  voltage_kv: 0.4, r_per_km: 0.524,  x_per_km: 0.075, rated_amps: 125 },
  { id: 'cu_pvc_50_lv',   name: '50mm² Cu PVC LV',    conductor: 'Cu', insulation: 'PVC',  size_mm2: 50,  voltage_kv: 0.4, r_per_km: 0.387,  x_per_km: 0.073, rated_amps: 151 },
  { id: 'cu_pvc_70_lv',   name: '70mm² Cu PVC LV',    conductor: 'Cu', insulation: 'PVC',  size_mm2: 70,  voltage_kv: 0.4, r_per_km: 0.268,  x_per_km: 0.072, rated_amps: 192 },
  { id: 'cu_pvc_95_lv',   name: '95mm² Cu PVC LV',    conductor: 'Cu', insulation: 'PVC',  size_mm2: 95,  voltage_kv: 0.4, r_per_km: 0.193,  x_per_km: 0.071, rated_amps: 232 },
  { id: 'cu_pvc_120_lv',  name: '120mm² Cu PVC LV',   conductor: 'Cu', insulation: 'PVC',  size_mm2: 120, voltage_kv: 0.4, r_per_km: 0.153,  x_per_km: 0.070, rated_amps: 269 },
  { id: 'cu_pvc_150_lv',  name: '150mm² Cu PVC LV',   conductor: 'Cu', insulation: 'PVC',  size_mm2: 150, voltage_kv: 0.4, r_per_km: 0.124,  x_per_km: 0.069, rated_amps: 300 },
  { id: 'cu_pvc_185_lv',  name: '185mm² Cu PVC LV',   conductor: 'Cu', insulation: 'PVC',  size_mm2: 185, voltage_kv: 0.4, r_per_km: 0.0991, x_per_km: 0.068, rated_amps: 341 },
  { id: 'cu_pvc_240_lv',  name: '240mm² Cu PVC LV',   conductor: 'Cu', insulation: 'PVC',  size_mm2: 240, voltage_kv: 0.4, r_per_km: 0.0754, x_per_km: 0.067, rated_amps: 400 },
  { id: 'cu_pvc_300_lv',  name: '300mm² Cu PVC LV',   conductor: 'Cu', insulation: 'PVC',  size_mm2: 300, voltage_kv: 0.4, r_per_km: 0.0601, x_per_km: 0.066, rated_amps: 458 },
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
  { id: 'xfmr_20mva',    name: '20 MVA 33/11kV',       rated_mva: 20,     voltage_hv_kv: 33,  voltage_lv_kv: 11,   z_percent: 10.0, x_r_ratio: 18,  vector_group: 'YNd11' },
  // Power transformers (132/33 kV)
  { id: 'xfmr_20mva_hv', name: '20 MVA 132/33kV',      rated_mva: 20,     voltage_hv_kv: 132, voltage_lv_kv: 33,   z_percent: 10.0, x_r_ratio: 20,  vector_group: 'YNd11' },
  { id: 'xfmr_40mva',    name: '40 MVA 132/33kV',      rated_mva: 40,     voltage_hv_kv: 132, voltage_lv_kv: 33,   z_percent: 12.5, x_r_ratio: 25,  vector_group: 'YNd11' },
  { id: 'xfmr_80mva',    name: '80 MVA 132/33kV',      rated_mva: 80,     voltage_hv_kv: 132, voltage_lv_kv: 33,   z_percent: 14.0, x_r_ratio: 30,  vector_group: 'YNd11' },
  // Power transformers (132/11 kV)
  { id: 'xfmr_10mva_132', name: '10 MVA 132/11kV',     rated_mva: 10,     voltage_hv_kv: 132, voltage_lv_kv: 11,   z_percent: 9.0,  x_r_ratio: 15,  vector_group: 'YNd11' },
  { id: 'xfmr_20mva_132', name: '20 MVA 132/11kV',     rated_mva: 20,     voltage_hv_kv: 132, voltage_lv_kv: 11,   z_percent: 10.0, x_r_ratio: 20,  vector_group: 'YNd11' },
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
    items: ['utility', 'generator'],
  },
  {
    id: 'distribution',
    name: 'Distribution',
    items: ['bus', 'transformer', 'cable'],
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
    items: ['motor_induction', 'motor_synchronous', 'static_load'],
  },
  {
    id: 'other',
    name: 'Other',
    items: ['capacitor_bank', 'surge_arrester'],
  },
];

// Component type definitions with default properties
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
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'voltage_kv', label: 'Voltage', type: 'number', unit: 'kV', unitOptions: [{ label: 'kV', mult: 1 }, { label: 'V', mult: 0.001 }] },
      { key: 'fault_mva', label: 'Fault Level', type: 'number', unit: 'MVA', unitOptions: [{ label: 'MVA', mult: 1 }, { label: 'kVA', mult: 0.001 }] },
      { key: 'x_r_ratio', label: 'X/R Ratio', type: 'number' },
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
      rated_mva: 10,
      voltage_kv: 11,
      xd_pp: 0.15,
      xd_p: 0.25,
      xd: 1.2,
      x_r_ratio: 40,
      power_factor: 0.85,
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'rated_mva', label: 'Rating', type: 'number', unit: 'MVA', unitOptions: [{ label: 'MVA', mult: 1 }, { label: 'kVA', mult: 0.001 }] },
      { key: 'voltage_kv', label: 'Voltage', type: 'number', unit: 'kV', unitOptions: [{ label: 'kV', mult: 1 }, { label: 'V', mult: 0.001 }] },
      { key: 'xd_pp', label: "Xd''", type: 'number', unit: 'p.u.' },
      { key: 'xd_p', label: "Xd'", type: 'number', unit: 'p.u.' },
      { key: 'xd', label: 'Xd', type: 'number', unit: 'p.u.' },
      { key: 'x_r_ratio', label: 'X/R Ratio', type: 'number' },
      { key: 'power_factor', label: 'Power Factor', type: 'number' },
    ],
  },

  // --- Distribution ---
  bus: {
    name: 'Bus',
    category: 'distribution',
    ports: [
      { id: 'top', side: 'top', offset: 0 },
      { id: 'bottom', side: 'bottom', offset: 0 },
      { id: 'left', side: 'left', offset: 0 },
      { id: 'right', side: 'right', offset: 0 },
    ],
    width: 120,
    height: 10,
    defaults: {
      name: 'Bus',
      voltage_kv: 11,
      bus_type: 'PQ',
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'voltage_kv', label: 'Voltage', type: 'number', unit: 'kV', unitOptions: [{ label: 'kV', mult: 1 }, { label: 'V', mult: 0.001 }] },
      { key: 'bus_type', label: 'Bus Type', type: 'select', options: ['PQ', 'PV', 'Swing'] },
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
      tap_percent: 0,
      vector_group: 'Dyn11',
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'standard_type', label: 'Standard Type', type: 'standard_select', library: 'transformer' },
      { key: 'rated_mva', label: 'Rating', type: 'number', unit: 'MVA', unitOptions: [{ label: 'MVA', mult: 1 }, { label: 'kVA', mult: 0.001 }] },
      { key: 'voltage_hv_kv', label: 'HV Voltage', type: 'number', unit: 'kV', unitOptions: [{ label: 'kV', mult: 1 }, { label: 'V', mult: 0.001 }] },
      { key: 'voltage_lv_kv', label: 'LV Voltage', type: 'number', unit: 'kV', unitOptions: [{ label: 'kV', mult: 1 }, { label: 'V', mult: 0.001 }] },
      { key: 'z_percent', label: 'Z%', type: 'number', unit: '%' },
      { key: 'x_r_ratio', label: 'X/R Ratio', type: 'number' },
      { key: 'tap_percent', label: 'Tap Position', type: 'number', unit: '%' },
      { key: 'vector_group', label: 'Vector Group', type: 'select', options: ['Dyn11', 'Dyn1', 'YNd11', 'YNd1', 'Yyn0', 'Dd0'] },
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
      standard_type: '',
      length_km: 1,
      r_per_km: 0.1,
      x_per_km: 0.08,
      rated_amps: 400,
      voltage_kv: 11,
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'standard_type', label: 'Cable Type', type: 'standard_select', library: 'cable' },
      { key: 'length_km', label: 'Length', type: 'number', unit: 'km', unitOptions: [{ label: 'km', mult: 1 }, { label: 'm', mult: 0.001 }] },
      { key: 'r_per_km', label: 'R', type: 'number', unit: 'Ω/km' },
      { key: 'x_per_km', label: 'X', type: 'number', unit: 'Ω/km' },
      { key: 'rated_amps', label: 'Rated Current', type: 'number', unit: 'A' },
      { key: 'voltage_kv', label: 'Voltage', type: 'number', unit: 'kV', unitOptions: [{ label: 'kV', mult: 1 }, { label: 'V', mult: 0.001 }] },
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
      state: 'closed',
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'rated_voltage_kv', label: 'Rated Voltage', type: 'number', unit: 'kV' },
      { key: 'rated_current_a', label: 'Rated Current', type: 'number', unit: 'A' },
      { key: 'breaking_capacity_ka', label: 'Breaking Cap.', type: 'number', unit: 'kA' },
      { key: 'state', label: 'State', type: 'select', options: ['closed', 'open'] },
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
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'rated_voltage_kv', label: 'Rated Voltage', type: 'number', unit: 'kV' },
      { key: 'rated_current_a', label: 'Rated Current', type: 'number', unit: 'A' },
      { key: 'breaking_capacity_ka', label: 'Breaking Cap.', type: 'number', unit: 'kA' },
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
      pickup_a: 100,
      time_dial: 1.0,
      curve: 'IEC Standard Inverse',
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'relay_type', label: 'Type', type: 'select', options: ['50/51', '50N/51N', '87', '21'] },
      { key: 'pickup_a', label: 'Pickup', type: 'number', unit: 'A' },
      { key: 'time_dial', label: 'Time Dial', type: 'number' },
      { key: 'curve', label: 'Curve', type: 'select', options: ['IEC Standard Inverse', 'IEC Very Inverse', 'IEC Extremely Inverse', 'IEC Long Time Inverse', 'IEEE Moderately Inverse', 'IEEE Very Inverse', 'IEEE Extremely Inverse'] },
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
      ratio: '400/5',
      accuracy_class: '5P20',
      burden_va: 15,
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'ratio', label: 'Ratio', type: 'text' },
      { key: 'accuracy_class', label: 'Accuracy', type: 'text' },
      { key: 'burden_va', label: 'Burden', type: 'number', unit: 'VA' },
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
      x_pp: 0.17,
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'rated_kw', label: 'Rating', type: 'number', unit: 'kW' },
      { key: 'voltage_kv', label: 'Voltage', type: 'number', unit: 'kV' },
      { key: 'efficiency', label: 'Efficiency', type: 'number' },
      { key: 'power_factor', label: 'Power Factor', type: 'number' },
      { key: 'locked_rotor_current', label: 'LRC (x FLC)', type: 'number' },
      { key: 'x_pp', label: "X''", type: 'number', unit: 'p.u.' },
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
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'rated_kva', label: 'Rating', type: 'number', unit: 'kVA' },
      { key: 'voltage_kv', label: 'Voltage', type: 'number', unit: 'kV' },
      { key: 'power_factor', label: 'Power Factor', type: 'number' },
      { key: 'xd_pp', label: "Xd''", type: 'number', unit: 'p.u.' },
      { key: 'xd_p', label: "Xd'", type: 'number', unit: 'p.u.' },
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
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'rated_kva', label: 'Rating', type: 'number', unit: 'kVA' },
      { key: 'voltage_kv', label: 'Voltage', type: 'number', unit: 'kV' },
      { key: 'power_factor', label: 'Power Factor', type: 'number' },
      { key: 'load_type', label: 'Type', type: 'select', options: ['constant_power', 'constant_current', 'constant_impedance'] },
    ],
  },

  // --- Other ---
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
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'rated_kvar', label: 'Rating', type: 'number', unit: 'kVAr' },
      { key: 'voltage_kv', label: 'Voltage', type: 'number', unit: 'kV' },
      { key: 'steps', label: 'Steps', type: 'number' },
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
};
