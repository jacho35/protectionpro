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
// Where M = I/Ipickup (current multiple)
const IDMT_CURVES = {
  'IEC Standard Inverse':     { std: 'IEC', k: 0.14,   a: 0.02,  c: 0 },
  'IEC Very Inverse':         { std: 'IEC', k: 13.5,   a: 1.0,   c: 0 },
  'IEC Extremely Inverse':    { std: 'IEC', k: 80.0,   a: 2.0,   c: 0 },
  'IEC Long Time Inverse':    { std: 'IEC', k: 120.0,  a: 1.0,   c: 0 },
  'IEEE Moderately Inverse':  { std: 'IEEE', A: 0.0515, p: 0.02,  B: 0.114 },
  'IEEE Very Inverse':        { std: 'IEEE', A: 19.61,  p: 2.0,   B: 0.491 },
  'IEEE Extremely Inverse':   { std: 'IEEE', A: 28.2,   p: 2.0,   B: 0.1217 },
};

// Calculate relay trip time for a given current multiple M and TDS
function idmtTripTime(curveName, M, TDS) {
  if (M <= 1) return Infinity;
  const c = IDMT_CURVES[curveName];
  if (!c) return Infinity;
  if (c.std === 'IEC') {
    return TDS * (c.k / (Math.pow(M, c.a) - 1) + c.c);
  } else {
    return TDS * (c.A / (Math.pow(M, c.p) - 1) + c.B);
  }
}

// ─── IEC 60269 Fuse Curves (gG General Purpose) ───
// Pre-arcing (minimum melting) time-current points: [current_A, time_s]
// Based on IEC 60269-1 characteristic data for gG fuses
const FUSE_CURVES_GG = {
  16:   [[25,600],[32,100],[40,30],[50,8],[80,1.5],[100,0.5],[160,0.08],[250,0.02],[400,0.008]],
  20:   [[32,600],[40,100],[50,30],[63,8],[100,1.5],[125,0.5],[200,0.08],[315,0.02],[500,0.008]],
  25:   [[40,600],[50,100],[63,30],[80,8],[125,1.5],[160,0.5],[250,0.08],[400,0.02],[630,0.008]],
  32:   [[50,600],[63,100],[80,30],[100,8],[160,1.5],[200,0.5],[315,0.08],[500,0.02],[800,0.008]],
  40:   [[63,600],[80,100],[100,30],[125,8],[200,1.5],[250,0.5],[400,0.08],[630,0.02],[1000,0.008]],
  50:   [[80,600],[100,100],[125,30],[160,8],[250,1.5],[315,0.5],[500,0.08],[800,0.02],[1250,0.008]],
  63:   [[100,600],[125,100],[160,30],[200,8],[315,1.5],[400,0.5],[630,0.08],[1000,0.02],[1600,0.008]],
  80:   [[125,600],[160,100],[200,30],[250,8],[400,1.5],[500,0.5],[800,0.08],[1250,0.02],[2000,0.008]],
  100:  [[160,600],[200,100],[250,30],[315,8],[500,1.5],[630,0.5],[1000,0.08],[1600,0.02],[2500,0.008]],
  125:  [[200,600],[250,100],[315,30],[400,8],[630,1.5],[800,0.5],[1250,0.08],[2000,0.02],[3150,0.008]],
  160:  [[250,600],[315,100],[400,30],[500,8],[800,1.5],[1000,0.5],[1600,0.08],[2500,0.02],[4000,0.008]],
  200:  [[315,600],[400,100],[500,30],[630,8],[1000,1.5],[1250,0.5],[2000,0.08],[3150,0.02],[5000,0.008]],
  250:  [[400,600],[500,100],[630,30],[800,8],[1250,1.5],[1600,0.5],[2500,0.08],[4000,0.02],[6300,0.008]],
  315:  [[500,600],[630,100],[800,30],[1000,8],[1600,1.5],[2000,0.5],[3150,0.08],[5000,0.02],[8000,0.008]],
  400:  [[630,600],[800,100],[1000,30],[1250,8],[2000,1.5],[2500,0.5],[4000,0.08],[6300,0.02],[10000,0.008]],
  500:  [[800,600],[1000,100],[1250,30],[1600,8],[2500,1.5],[3150,0.5],[5000,0.08],[8000,0.02],[12500,0.008]],
  630:  [[1000,600],[1250,100],[1600,30],[2000,8],[3150,1.5],[4000,0.5],[6300,0.08],[10000,0.02],[16000,0.008]],
};

// Get fuse trip time by log-log interpolation of the characteristic points
function fuseTripTime(ratingA, currentA) {
  const points = FUSE_CURVES_GG[ratingA];
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
// Thermal-magnetic characteristics for MCCB and ACB
//
// MCCB: thermal (I²t inverse-time) region + fixed magnetic instantaneous
// ACB:  long-time (thermal) + optional short-time + instantaneous
//
// Thermal region model: t = k / ((I/Ir)^2 - 1)
// where k = long_time_delay class factor, Ir = trip_rating × thermal_pickup
// Magnetic region: fixed trip time (typically 20ms for MCCB, configurable for ACB)

const CB_TRIP_CLASSES = {
  // Long-time delay class factors (IEC 60947-2 Annex F)
  // Higher k = slower thermal trip at same overload
  5:   { k: 80 },
  10:  { k: 200 },
  20:  { k: 500 },
  30:  { k: 1000 },
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

// Standard MCCB frame sizes for the custom device dropdown
const CB_FRAME_SIZES = [16, 20, 25, 32, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 630, 800, 1000, 1250, 1600, 2000, 2500, 3200, 4000, 5000, 6300];

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
      winding_config: 'step_down',
      grounding_hv: 'ungrounded',
      grounding_hv_resistance: 0,
      grounding_hv_reactance: 0,
      grounding_lv: 'solidly_grounded',
      grounding_lv_resistance: 0,
      grounding_lv_reactance: 0,
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'standard_type', label: 'Standard Type', type: 'standard_select', library: 'transformer' },
      { key: 'winding_config', label: 'Configuration', type: 'select', options: ['step_down', 'step_up'] },
      { key: 'rated_mva', label: 'Rating', type: 'number', unit: 'MVA', unitOptions: [{ label: 'MVA', mult: 1 }, { label: 'kVA', mult: 0.001 }] },
      { key: 'voltage_hv_kv', label: 'HV Voltage', type: 'number', unit: 'kV', unitOptions: [{ label: 'kV', mult: 1 }, { label: 'V', mult: 0.001 }] },
      { key: 'voltage_lv_kv', label: 'LV Voltage', type: 'number', unit: 'kV', unitOptions: [{ label: 'kV', mult: 1 }, { label: 'V', mult: 0.001 }] },
      { key: 'z_percent', label: 'Z%', type: 'number', unit: '%' },
      { key: 'x_r_ratio', label: 'X/R Ratio', type: 'number' },
      { key: 'tap_percent', label: 'Tap Position', type: 'number', unit: '%' },
      { key: 'vector_group', label: 'Vector Group', type: 'select', options: ['Dyn11', 'Dyn1', 'Dyn5', 'YNyn0', 'YNd11', 'YNd1', 'YNd5', 'Yyn0', 'Yzn11', 'Yzn1', 'Dd0', 'Dd6'] },
      { key: 'grounding_hv', label: 'HV Grounding', type: 'select', options: ['ungrounded', 'solidly_grounded', 'low_resistance', 'high_resistance', 'reactance_grounded'],
        showWhen: { field: 'vector_group', match: /^YN/i } },
      { key: 'grounding_hv_resistance', label: 'HV Ground R', type: 'number', unit: 'Ω',
        showWhen: { field: 'grounding_hv', values: ['low_resistance', 'high_resistance'] } },
      { key: 'grounding_hv_reactance', label: 'HV Ground X', type: 'number', unit: 'Ω',
        showWhen: { field: 'grounding_hv', values: ['reactance_grounded'] } },
      { key: 'grounding_lv', label: 'LV Grounding', type: 'select', options: ['ungrounded', 'solidly_grounded', 'low_resistance', 'high_resistance', 'reactance_grounded'],
        showWhen: { field: 'vector_group', match: /[yY][nN]|[zZ][nN]/i, side: 'lv' } },
      { key: 'grounding_lv_resistance', label: 'LV Ground R', type: 'number', unit: 'Ω',
        showWhen: { field: 'grounding_lv', values: ['low_resistance', 'high_resistance'] } },
      { key: 'grounding_lv_reactance', label: 'LV Ground X', type: 'number', unit: 'Ω',
        showWhen: { field: 'grounding_lv', values: ['reactance_grounded'] } },
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
      length_km: 0.1,
      r_per_km: 0.1,
      x_per_km: 0.08,
      rated_amps: 400,
      voltage_kv: 11,
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'standard_type', label: 'Cable Type', type: 'standard_select', library: 'cable' },
      { key: 'length_km', label: 'Length', type: 'number', unit: 'm', unitOptions: [{ label: 'm', mult: 0.001 }, { label: 'km', mult: 1 }] },
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
      cb_type: 'mccb',
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
      { key: 'rated_voltage_kv', label: 'Rated Voltage', type: 'number', unit: 'kV' },
      { key: 'rated_current_a', label: 'Rated Current', type: 'number', unit: 'A' },
      { key: 'breaking_capacity_ka', label: 'Breaking Cap.', type: 'number', unit: 'kA' },
      { key: 'state', label: 'State', type: 'select', options: ['closed', 'open'] },
      { key: 'cb_type', label: 'CB Type', type: 'select', options: ['mccb', 'acb'] },
      { key: 'trip_rating_a', label: 'Trip Rating', type: 'number', unit: 'A' },
      { key: 'thermal_pickup', label: 'Thermal Pickup', type: 'number', unit: '×In' },
      { key: 'magnetic_pickup', label: 'Magnetic Pickup', type: 'number', unit: '×In' },
      { key: 'long_time_delay', label: 'LT Delay Class', type: 'number' },
      { key: 'short_time_pickup', label: 'ST Pickup', type: 'number', unit: '×In',
        showWhen: { field: 'cb_type', values: ['acb'] } },
      { key: 'short_time_delay', label: 'ST Delay', type: 'number', unit: 's',
        showWhen: { field: 'cb_type', values: ['acb'] } },
      { key: 'instantaneous_pickup', label: 'Instantaneous', type: 'number', unit: '×In',
        showWhen: { field: 'cb_type', values: ['acb'] } },
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
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'fuse_type', label: 'Fuse Type', type: 'select', options: ['gG', 'aM'] },
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
