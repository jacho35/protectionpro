"""Cable Sizing Calculator — thermal, voltage drop, and fault withstand checks.

For every cable in the project, determines whether it is correctly sized
for the load current, voltage drop, and fault withstand energy (I²t).
Returns pass/fail per cable with recommended minimum size.
"""

import math
from ..models.schemas import ProjectData

# ─── Standard cable library (mirrored from frontend STANDARD_CABLES) ───
STANDARD_CABLES = [
    # MV XLPE Copper (11kV)
    {"id": "cu_xlpe_16_11kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 16, "voltage_kv": 11, "r_per_km": 1.15, "x_per_km": 0.119, "rated_amps": 110},
    {"id": "cu_xlpe_25_11kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 25, "voltage_kv": 11, "r_per_km": 0.727, "x_per_km": 0.113, "rated_amps": 140},
    {"id": "cu_xlpe_35_11kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 35, "voltage_kv": 11, "r_per_km": 0.524, "x_per_km": 0.110, "rated_amps": 170},
    {"id": "cu_xlpe_50_11kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 50, "voltage_kv": 11, "r_per_km": 0.387, "x_per_km": 0.107, "rated_amps": 200},
    {"id": "cu_xlpe_70_11kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 70, "voltage_kv": 11, "r_per_km": 0.268, "x_per_km": 0.104, "rated_amps": 245},
    {"id": "cu_xlpe_95_11kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 95, "voltage_kv": 11, "r_per_km": 0.193, "x_per_km": 0.101, "rated_amps": 300},
    {"id": "cu_xlpe_120_11kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 120, "voltage_kv": 11, "r_per_km": 0.153, "x_per_km": 0.099, "rated_amps": 340},
    {"id": "cu_xlpe_150_11kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 150, "voltage_kv": 11, "r_per_km": 0.124, "x_per_km": 0.097, "rated_amps": 380},
    {"id": "cu_xlpe_185_11kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 185, "voltage_kv": 11, "r_per_km": 0.0991, "x_per_km": 0.095, "rated_amps": 430},
    {"id": "cu_xlpe_240_11kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 240, "voltage_kv": 11, "r_per_km": 0.0754, "x_per_km": 0.093, "rated_amps": 500},
    {"id": "cu_xlpe_300_11kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 300, "voltage_kv": 11, "r_per_km": 0.0601, "x_per_km": 0.091, "rated_amps": 560},
    {"id": "cu_xlpe_400_11kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 400, "voltage_kv": 11, "r_per_km": 0.0470, "x_per_km": 0.089, "rated_amps": 630},
    # MV XLPE Aluminium (11kV)
    {"id": "al_xlpe_35_11kv", "conductor": "Al", "insulation": "XLPE", "size_mm2": 35, "voltage_kv": 11, "r_per_km": 0.868, "x_per_km": 0.110, "rated_amps": 130},
    {"id": "al_xlpe_50_11kv", "conductor": "Al", "insulation": "XLPE", "size_mm2": 50, "voltage_kv": 11, "r_per_km": 0.641, "x_per_km": 0.107, "rated_amps": 155},
    {"id": "al_xlpe_70_11kv", "conductor": "Al", "insulation": "XLPE", "size_mm2": 70, "voltage_kv": 11, "r_per_km": 0.443, "x_per_km": 0.104, "rated_amps": 190},
    {"id": "al_xlpe_95_11kv", "conductor": "Al", "insulation": "XLPE", "size_mm2": 95, "voltage_kv": 11, "r_per_km": 0.320, "x_per_km": 0.101, "rated_amps": 230},
    {"id": "al_xlpe_120_11kv", "conductor": "Al", "insulation": "XLPE", "size_mm2": 120, "voltage_kv": 11, "r_per_km": 0.253, "x_per_km": 0.099, "rated_amps": 265},
    {"id": "al_xlpe_150_11kv", "conductor": "Al", "insulation": "XLPE", "size_mm2": 150, "voltage_kv": 11, "r_per_km": 0.206, "x_per_km": 0.097, "rated_amps": 300},
    {"id": "al_xlpe_185_11kv", "conductor": "Al", "insulation": "XLPE", "size_mm2": 185, "voltage_kv": 11, "r_per_km": 0.164, "x_per_km": 0.095, "rated_amps": 340},
    {"id": "al_xlpe_240_11kv", "conductor": "Al", "insulation": "XLPE", "size_mm2": 240, "voltage_kv": 11, "r_per_km": 0.125, "x_per_km": 0.093, "rated_amps": 395},
    {"id": "al_xlpe_300_11kv", "conductor": "Al", "insulation": "XLPE", "size_mm2": 300, "voltage_kv": 11, "r_per_km": 0.100, "x_per_km": 0.091, "rated_amps": 445},
    {"id": "al_xlpe_400_11kv", "conductor": "Al", "insulation": "XLPE", "size_mm2": 400, "voltage_kv": 11, "r_per_km": 0.0778, "x_per_km": 0.089, "rated_amps": 505},
    # LV XLPE Copper (0.6/1kV)
    {"id": "cu_xlpe_16_lv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 16, "voltage_kv": 0.4, "r_per_km": 1.15, "x_per_km": 0.082, "rated_amps": 91},
    {"id": "cu_xlpe_25_lv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 25, "voltage_kv": 0.4, "r_per_km": 0.727, "x_per_km": 0.079, "rated_amps": 116},
    {"id": "cu_xlpe_35_lv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 35, "voltage_kv": 0.4, "r_per_km": 0.524, "x_per_km": 0.077, "rated_amps": 140},
    {"id": "cu_xlpe_50_lv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 50, "voltage_kv": 0.4, "r_per_km": 0.387, "x_per_km": 0.075, "rated_amps": 167},
    {"id": "cu_xlpe_70_lv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 70, "voltage_kv": 0.4, "r_per_km": 0.268, "x_per_km": 0.073, "rated_amps": 210},
    {"id": "cu_xlpe_95_lv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 95, "voltage_kv": 0.4, "r_per_km": 0.193, "x_per_km": 0.072, "rated_amps": 254},
    {"id": "cu_xlpe_120_lv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 120, "voltage_kv": 0.4, "r_per_km": 0.153, "x_per_km": 0.071, "rated_amps": 292},
    {"id": "cu_xlpe_150_lv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 150, "voltage_kv": 0.4, "r_per_km": 0.124, "x_per_km": 0.070, "rated_amps": 330},
    {"id": "cu_xlpe_185_lv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 185, "voltage_kv": 0.4, "r_per_km": 0.0991, "x_per_km": 0.069, "rated_amps": 375},
    {"id": "cu_xlpe_240_lv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 240, "voltage_kv": 0.4, "r_per_km": 0.0754, "x_per_km": 0.068, "rated_amps": 440},
    {"id": "cu_xlpe_300_lv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 300, "voltage_kv": 0.4, "r_per_km": 0.0601, "x_per_km": 0.067, "rated_amps": 500},
    # MV XLPE Copper (22kV)
    {"id": "cu_xlpe_35_22kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 35, "voltage_kv": 22, "r_per_km": 0.524, "x_per_km": 0.122, "rated_amps": 160},
    {"id": "cu_xlpe_50_22kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 50, "voltage_kv": 22, "r_per_km": 0.387, "x_per_km": 0.118, "rated_amps": 190},
    {"id": "cu_xlpe_70_22kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 70, "voltage_kv": 22, "r_per_km": 0.268, "x_per_km": 0.114, "rated_amps": 235},
    {"id": "cu_xlpe_95_22kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 95, "voltage_kv": 22, "r_per_km": 0.193, "x_per_km": 0.111, "rated_amps": 280},
    {"id": "cu_xlpe_120_22kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 120, "voltage_kv": 22, "r_per_km": 0.153, "x_per_km": 0.108, "rated_amps": 320},
    {"id": "cu_xlpe_150_22kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 150, "voltage_kv": 22, "r_per_km": 0.124, "x_per_km": 0.106, "rated_amps": 360},
    {"id": "cu_xlpe_185_22kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 185, "voltage_kv": 22, "r_per_km": 0.0991, "x_per_km": 0.104, "rated_amps": 410},
    {"id": "cu_xlpe_240_22kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 240, "voltage_kv": 22, "r_per_km": 0.0754, "x_per_km": 0.101, "rated_amps": 475},
    {"id": "cu_xlpe_300_22kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 300, "voltage_kv": 22, "r_per_km": 0.0601, "x_per_km": 0.099, "rated_amps": 535},
    # MV XLPE Copper (33kV)
    {"id": "cu_xlpe_50_33kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 50, "voltage_kv": 33, "r_per_km": 0.387, "x_per_km": 0.130, "rated_amps": 175},
    {"id": "cu_xlpe_70_33kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 70, "voltage_kv": 33, "r_per_km": 0.268, "x_per_km": 0.126, "rated_amps": 220},
    {"id": "cu_xlpe_95_33kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 95, "voltage_kv": 33, "r_per_km": 0.193, "x_per_km": 0.122, "rated_amps": 265},
    {"id": "cu_xlpe_120_33kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 120, "voltage_kv": 33, "r_per_km": 0.153, "x_per_km": 0.119, "rated_amps": 300},
    {"id": "cu_xlpe_150_33kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 150, "voltage_kv": 33, "r_per_km": 0.124, "x_per_km": 0.117, "rated_amps": 340},
    {"id": "cu_xlpe_185_33kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 185, "voltage_kv": 33, "r_per_km": 0.0991, "x_per_km": 0.114, "rated_amps": 385},
    {"id": "cu_xlpe_240_33kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 240, "voltage_kv": 33, "r_per_km": 0.0754, "x_per_km": 0.112, "rated_amps": 450},
    {"id": "cu_xlpe_300_33kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 300, "voltage_kv": 33, "r_per_km": 0.0601, "x_per_km": 0.109, "rated_amps": 510},
    {"id": "cu_xlpe_400_33kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 400, "voltage_kv": 33, "r_per_km": 0.0470, "x_per_km": 0.107, "rated_amps": 575},
    # LV XLPE Aluminium (0.6/1kV)
    {"id": "al_xlpe_16_lv", "conductor": "Al", "insulation": "XLPE", "size_mm2": 16, "voltage_kv": 0.4, "r_per_km": 1.91, "x_per_km": 0.082, "rated_amps": 70},
    {"id": "al_xlpe_25_lv", "conductor": "Al", "insulation": "XLPE", "size_mm2": 25, "voltage_kv": 0.4, "r_per_km": 1.20, "x_per_km": 0.079, "rated_amps": 90},
    {"id": "al_xlpe_35_lv", "conductor": "Al", "insulation": "XLPE", "size_mm2": 35, "voltage_kv": 0.4, "r_per_km": 0.868, "x_per_km": 0.077, "rated_amps": 110},
    {"id": "al_xlpe_50_lv", "conductor": "Al", "insulation": "XLPE", "size_mm2": 50, "voltage_kv": 0.4, "r_per_km": 0.641, "x_per_km": 0.075, "rated_amps": 130},
    {"id": "al_xlpe_70_lv", "conductor": "Al", "insulation": "XLPE", "size_mm2": 70, "voltage_kv": 0.4, "r_per_km": 0.443, "x_per_km": 0.073, "rated_amps": 165},
    {"id": "al_xlpe_95_lv", "conductor": "Al", "insulation": "XLPE", "size_mm2": 95, "voltage_kv": 0.4, "r_per_km": 0.320, "x_per_km": 0.072, "rated_amps": 200},
    {"id": "al_xlpe_120_lv", "conductor": "Al", "insulation": "XLPE", "size_mm2": 120, "voltage_kv": 0.4, "r_per_km": 0.253, "x_per_km": 0.071, "rated_amps": 230},
    {"id": "al_xlpe_150_lv", "conductor": "Al", "insulation": "XLPE", "size_mm2": 150, "voltage_kv": 0.4, "r_per_km": 0.206, "x_per_km": 0.070, "rated_amps": 260},
    {"id": "al_xlpe_185_lv", "conductor": "Al", "insulation": "XLPE", "size_mm2": 185, "voltage_kv": 0.4, "r_per_km": 0.164, "x_per_km": 0.069, "rated_amps": 295},
    {"id": "al_xlpe_240_lv", "conductor": "Al", "insulation": "XLPE", "size_mm2": 240, "voltage_kv": 0.4, "r_per_km": 0.125, "x_per_km": 0.068, "rated_amps": 350},
    {"id": "al_xlpe_300_lv", "conductor": "Al", "insulation": "XLPE", "size_mm2": 300, "voltage_kv": 0.4, "r_per_km": 0.100, "x_per_km": 0.067, "rated_amps": 395},
    # LV PVC Copper (0.6/1kV)
    {"id": "cu_pvc_1.5_lv", "conductor": "Cu", "insulation": "PVC", "size_mm2": 1.5, "voltage_kv": 0.4, "r_per_km": 12.1, "x_per_km": 0.094, "rated_amps": 18},
    {"id": "cu_pvc_2.5_lv", "conductor": "Cu", "insulation": "PVC", "size_mm2": 2.5, "voltage_kv": 0.4, "r_per_km": 7.41, "x_per_km": 0.090, "rated_amps": 25},
    {"id": "cu_pvc_4_lv", "conductor": "Cu", "insulation": "PVC", "size_mm2": 4, "voltage_kv": 0.4, "r_per_km": 4.61, "x_per_km": 0.087, "rated_amps": 34},
    {"id": "cu_pvc_6_lv", "conductor": "Cu", "insulation": "PVC", "size_mm2": 6, "voltage_kv": 0.4, "r_per_km": 3.08, "x_per_km": 0.084, "rated_amps": 43},
    {"id": "cu_pvc_10_lv", "conductor": "Cu", "insulation": "PVC", "size_mm2": 10, "voltage_kv": 0.4, "r_per_km": 1.83, "x_per_km": 0.080, "rated_amps": 60},
    {"id": "cu_pvc_16_lv", "conductor": "Cu", "insulation": "PVC", "size_mm2": 16, "voltage_kv": 0.4, "r_per_km": 1.15, "x_per_km": 0.079, "rated_amps": 80},
    {"id": "cu_pvc_25_lv", "conductor": "Cu", "insulation": "PVC", "size_mm2": 25, "voltage_kv": 0.4, "r_per_km": 0.727, "x_per_km": 0.077, "rated_amps": 101},
    {"id": "cu_pvc_35_lv", "conductor": "Cu", "insulation": "PVC", "size_mm2": 35, "voltage_kv": 0.4, "r_per_km": 0.524, "x_per_km": 0.075, "rated_amps": 125},
    {"id": "cu_pvc_50_lv", "conductor": "Cu", "insulation": "PVC", "size_mm2": 50, "voltage_kv": 0.4, "r_per_km": 0.387, "x_per_km": 0.073, "rated_amps": 151},
    {"id": "cu_pvc_70_lv", "conductor": "Cu", "insulation": "PVC", "size_mm2": 70, "voltage_kv": 0.4, "r_per_km": 0.268, "x_per_km": 0.072, "rated_amps": 192},
    {"id": "cu_pvc_95_lv", "conductor": "Cu", "insulation": "PVC", "size_mm2": 95, "voltage_kv": 0.4, "r_per_km": 0.193, "x_per_km": 0.071, "rated_amps": 232},
    {"id": "cu_pvc_120_lv", "conductor": "Cu", "insulation": "PVC", "size_mm2": 120, "voltage_kv": 0.4, "r_per_km": 0.153, "x_per_km": 0.070, "rated_amps": 269},
    {"id": "cu_pvc_150_lv", "conductor": "Cu", "insulation": "PVC", "size_mm2": 150, "voltage_kv": 0.4, "r_per_km": 0.124, "x_per_km": 0.069, "rated_amps": 300},
    {"id": "cu_pvc_185_lv", "conductor": "Cu", "insulation": "PVC", "size_mm2": 185, "voltage_kv": 0.4, "r_per_km": 0.0991, "x_per_km": 0.068, "rated_amps": 341},
    {"id": "cu_pvc_240_lv", "conductor": "Cu", "insulation": "PVC", "size_mm2": 240, "voltage_kv": 0.4, "r_per_km": 0.0754, "x_per_km": 0.067, "rated_amps": 400},
    {"id": "cu_pvc_300_lv", "conductor": "Cu", "insulation": "PVC", "size_mm2": 300, "voltage_kv": 0.4, "r_per_km": 0.0601, "x_per_km": 0.066, "rated_amps": 453},
]

# Adiabatic withstand constant k (A√s / mm²)
K_FACTORS = {
    ("Cu", "XLPE"): 143,
    ("Al", "XLPE"): 94,
    ("Cu", "PVC"): 115,
    ("Al", "PVC"): 76,
}

# Max conductor operating temperature (°C)
MAX_TEMP = {"XLPE": 90, "PVC": 70}

# Installation method derating factors
INSTALL_DERATING = {"trefoil": 1.0, "flat": 0.95, "buried": 0.85}

# Resistivity (Ω·mm²/m)
RESISTIVITY = {"Cu": 0.0175, "Al": 0.0282}

# ─── NEC Article 310.16 — AWG/kcmil to mm² mapping ───
_AWG_TO_MM2 = {
    '14': 2.08, '12': 3.31, '10': 5.26, '8': 8.37, '6': 13.3,
    '4': 21.2, '3': 26.7, '2': 33.6, '1': 42.4,
    '1/0': 53.5, '2/0': 67.4, '3/0': 85.0, '4/0': 107.2,
    '250': 127, '300': 152, '350': 177, '400': 203,
    '500': 253, '600': 304, '700': 355, '750': 380,
    '800': 405, '900': 456, '1000': 507,
}

# NEC Table 310.16 ampacities
_NEC_310_16 = {
    '14':   {'cu_60': 15,  'cu_75': 20,  'cu_90': 25,  'al_60': None, 'al_75': None, 'al_90': None},
    '12':   {'cu_60': 20,  'cu_75': 25,  'cu_90': 30,  'al_60': 15,   'al_75': 20,   'al_90': 25},
    '10':   {'cu_60': 30,  'cu_75': 35,  'cu_90': 40,  'al_60': 25,   'al_75': 30,   'al_90': 35},
    '8':    {'cu_60': 40,  'cu_75': 50,  'cu_90': 55,  'al_60': 35,   'al_75': 40,   'al_90': 45},
    '6':    {'cu_60': 55,  'cu_75': 65,  'cu_90': 75,  'al_60': 40,   'al_75': 50,   'al_90': 55},
    '4':    {'cu_60': 70,  'cu_75': 85,  'cu_90': 95,  'al_60': 55,   'al_75': 65,   'al_90': 75},
    '3':    {'cu_60': 85,  'cu_75': 100, 'cu_90': 115, 'al_60': 65,   'al_75': 75,   'al_90': 85},
    '2':    {'cu_60': 95,  'cu_75': 115, 'cu_90': 130, 'al_60': 75,   'al_75': 90,   'al_90': 100},
    '1':    {'cu_60': 110, 'cu_75': 130, 'cu_90': 145, 'al_60': 85,   'al_75': 100,  'al_90': 115},
    '1/0':  {'cu_60': 125, 'cu_75': 150, 'cu_90': 170, 'al_60': 100,  'al_75': 120,  'al_90': 135},
    '2/0':  {'cu_60': 145, 'cu_75': 175, 'cu_90': 195, 'al_60': 115,  'al_75': 135,  'al_90': 150},
    '3/0':  {'cu_60': 165, 'cu_75': 200, 'cu_90': 225, 'al_60': 130,  'al_75': 155,  'al_90': 175},
    '4/0':  {'cu_60': 195, 'cu_75': 230, 'cu_90': 260, 'al_60': 150,  'al_75': 180,  'al_90': 205},
    '250':  {'cu_60': 215, 'cu_75': 255, 'cu_90': 290, 'al_60': 170,  'al_75': 205,  'al_90': 230},
    '300':  {'cu_60': 240, 'cu_75': 285, 'cu_90': 320, 'al_60': 190,  'al_75': 230,  'al_90': 255},
    '350':  {'cu_60': 260, 'cu_75': 310, 'cu_90': 350, 'al_60': 210,  'al_75': 250,  'al_90': 280},
    '400':  {'cu_60': 280, 'cu_75': 335, 'cu_90': 380, 'al_60': 225,  'al_75': 270,  'al_90': 305},
    '500':  {'cu_60': 320, 'cu_75': 380, 'cu_90': 430, 'al_60': 260,  'al_75': 310,  'al_90': 350},
    '600':  {'cu_60': 355, 'cu_75': 420, 'cu_90': 475, 'al_60': 285,  'al_75': 340,  'al_90': 385},
    '700':  {'cu_60': 385, 'cu_75': 460, 'cu_90': 520, 'al_60': 310,  'al_75': 375,  'al_90': 420},
    '750':  {'cu_60': 400, 'cu_75': 475, 'cu_90': 535, 'al_60': 320,  'al_75': 385,  'al_90': 435},
    '800':  {'cu_60': 410, 'cu_75': 490, 'cu_90': 555, 'al_60': 330,  'al_75': 395,  'al_90': 450},
    '900':  {'cu_60': 435, 'cu_75': 520, 'cu_90': 585, 'al_60': 355,  'al_75': 425,  'al_90': 480},
    '1000': {'cu_60': 455, 'cu_75': 545, 'cu_90': 615, 'al_60': 375,  'al_75': 445,  'al_90': 500},
}


# NEC Table 310.15(B)(1): Ambient Temperature Correction Factors
# Keys are ambient temperature thresholds (°C), values are {temp_rating: factor}
_NEC_TEMP_CORRECTION = {
    21: {'60C': 1.08, '75C': 1.04, '90C': 1.04},
    26: {'60C': 1.00, '75C': 1.00, '90C': 1.00},
    30: {'60C': 1.00, '75C': 1.00, '90C': 1.00},
    31: {'60C': 0.91, '75C': 0.94, '90C': 0.96},
    36: {'60C': 0.91, '75C': 0.94, '90C': 0.96},
    40: {'60C': 0.82, '75C': 0.88, '90C': 0.91},
    41: {'60C': 0.82, '75C': 0.88, '90C': 0.91},
    45: {'60C': 0.71, '75C': 0.82, '90C': 0.87},
    46: {'60C': 0.71, '75C': 0.82, '90C': 0.87},
    50: {'60C': 0.58, '75C': 0.75, '90C': 0.82},
    51: {'60C': 0.58, '75C': 0.75, '90C': 0.82},
    55: {'60C': 0.41, '75C': 0.67, '90C': 0.76},
    60: {'60C': 0.00, '75C': 0.58, '90C': 0.71},
    65: {'60C': 0.00, '75C': 0.47, '90C': 0.65},
    70: {'60C': 0.00, '75C': 0.33, '90C': 0.58},
    75: {'60C': 0.00, '75C': 0.00, '90C': 0.50},
    80: {'60C': 0.00, '75C': 0.00, '90C': 0.41},
}

# NEC Table 310.15(C)(1): Conductor Count Adjustment Factors
_NEC_CONDUCTOR_ADJUSTMENT = [
    (3, 1.00),
    (6, 0.80),
    (9, 0.70),
    (20, 0.50),
    (30, 0.45),
    (40, 0.40),
    (999, 0.35),
]

# NEC Table 310.16 ampacity data (keyed by approx mm² size)
_NEC_AMPACITY = {
    2:    {'60C': {'cu': 15, 'al': None}, '75C': {'cu': 20, 'al': None}, '90C': {'cu': 25, 'al': None}},
    3.3:  {'60C': {'cu': 20, 'al': 15},   '75C': {'cu': 25, 'al': 20},   '90C': {'cu': 30, 'al': 25}},
    5.3:  {'60C': {'cu': 30, 'al': 25},   '75C': {'cu': 35, 'al': 30},   '90C': {'cu': 40, 'al': 35}},
    8.4:  {'60C': {'cu': 40, 'al': 35},   '75C': {'cu': 50, 'al': 45},   '90C': {'cu': 55, 'al': 45}},
    13.3: {'60C': {'cu': 55, 'al': 40},   '75C': {'cu': 65, 'al': 50},   '90C': {'cu': 75, 'al': 60}},
    21.2: {'60C': {'cu': 70, 'al': 55},   '75C': {'cu': 85, 'al': 65},   '90C': {'cu': 95, 'al': 75}},
    26.7: {'60C': {'cu': 85, 'al': 65},   '75C': {'cu': 100, 'al': 75},  '90C': {'cu': 115, 'al': 85}},
    33.6: {'60C': {'cu': 95, 'al': 75},   '75C': {'cu': 115, 'al': 90},  '90C': {'cu': 130, 'al': 100}},
    42.4: {'60C': {'cu': 110, 'al': 85},  '75C': {'cu': 130, 'al': 100}, '90C': {'cu': 145, 'al': 115}},
    53.5: {'60C': {'cu': 125, 'al': 100}, '75C': {'cu': 150, 'al': 120}, '90C': {'cu': 170, 'al': 135}},
    67.4: {'60C': {'cu': 145, 'al': 115}, '75C': {'cu': 175, 'al': 135}, '90C': {'cu': 195, 'al': 150}},
    85.0: {'60C': {'cu': 165, 'al': 130}, '75C': {'cu': 200, 'al': 155}, '90C': {'cu': 225, 'al': 175}},
    107:  {'60C': {'cu': 195, 'al': 150}, '75C': {'cu': 230, 'al': 180}, '90C': {'cu': 260, 'al': 205}},
    127:  {'60C': {'cu': 215, 'al': 170}, '75C': {'cu': 255, 'al': 205}, '90C': {'cu': 290, 'al': 230}},
    152:  {'60C': {'cu': 240, 'al': 190}, '75C': {'cu': 285, 'al': 230}, '90C': {'cu': 320, 'al': 255}},
    177:  {'60C': {'cu': 260, 'al': 210}, '75C': {'cu': 310, 'al': 250}, '90C': {'cu': 350, 'al': 280}},
    203:  {'60C': {'cu': 280, 'al': 225}, '75C': {'cu': 335, 'al': 270}, '90C': {'cu': 380, 'al': 305}},
    253:  {'60C': {'cu': 320, 'al': 260}, '75C': {'cu': 380, 'al': 310}, '90C': {'cu': 430, 'al': 350}},
    304:  {'60C': {'cu': 355, 'al': 285}, '75C': {'cu': 420, 'al': 340}, '90C': {'cu': 475, 'al': 385}},
    380:  {'60C': {'cu': 400, 'al': 320}, '75C': {'cu': 475, 'al': 385}, '90C': {'cu': 535, 'al': 435}},
}

_NEC_SIZE_LABELS = {
    2: '14 AWG', 3.3: '12 AWG', 5.3: '10 AWG', 8.4: '8 AWG',
    13.3: '6 AWG', 21.2: '4 AWG', 26.7: '3 AWG', 33.6: '2 AWG',
    42.4: '1 AWG', 53.5: '1/0 AWG', 67.4: '2/0 AWG', 85.0: '3/0 AWG',
    107: '4/0 AWG', 127: '250 kcmil', 152: '300 kcmil', 177: '350 kcmil',
    203: '400 kcmil', 253: '500 kcmil', 304: '600 kcmil', 380: '750 kcmil',
}


def _nec_ampacity_lookup(size_mm2, conductor='Cu', temp_rating='75C'):
    """Look up NEC 310.16 ampacity for a given cable size.

    Args:
        size_mm2: Cable cross-section in mm²
        conductor: 'Cu' or 'Al'
        temp_rating: '60C', '75C', or '90C'

    Returns:
        dict with nec_size_mm2, nec_size_label, ampacity, temp_rating or None
    """
    nec_sizes = sorted(_NEC_AMPACITY.keys())
    # Find closest NEC size >= cable size
    best = None
    for s in nec_sizes:
        if s >= size_mm2 * 0.8:  # Allow 20% tolerance for metric/AWG mismatch
            best = s
            break
    if best is None:
        best = nec_sizes[-1]

    cond_key = conductor.lower()[:2]
    entry = _NEC_AMPACITY.get(best, {}).get(temp_rating, {})
    ampacity = entry.get(cond_key)

    return {
        'nec_size_mm2': best,
        'nec_size_label': _NEC_SIZE_LABELS.get(best, f'{best}mm²'),
        'ampacity_a': ampacity,
        'temp_rating': temp_rating,
    }


def _mm2_to_awg(size_mm2):
    """Convert mm² to closest AWG/kcmil size."""
    best_awg = '10'
    best_diff = 1e6
    for awg, mm2 in _AWG_TO_MM2.items():
        diff = abs(mm2 - size_mm2)
        if diff < best_diff:
            best_diff = diff
            best_awg = awg
    return best_awg


def _nec_temp_rating(insulation):
    """Map insulation type to NEC temperature rating column."""
    # XLPE → 90°C, PVC → 60°C
    ins = insulation.upper()
    if ins == 'XLPE':
        return '90C'
    elif ins == 'PVC':
        return '60C'
    return '75C'


def _nec_temp_correction_factor(ambient_temp_c, insulation):
    """Get NEC 310.15(B)(1) ambient temperature correction factor."""
    temp_rating = _nec_temp_rating(insulation)
    # Find the correction factor for the closest temperature threshold
    # that is >= the ambient temperature
    sorted_temps = sorted(_NEC_TEMP_CORRECTION.keys())
    selected = sorted_temps[-1]  # default to highest
    for t in sorted_temps:
        if t >= ambient_temp_c:
            selected = t
            break
    factor = _NEC_TEMP_CORRECTION[selected].get(temp_rating, 1.0)
    return factor if factor > 0 else 0.0


def _nec_conductor_count_factor(num_conductors):
    """Get NEC 310.15(C)(1) conductor count adjustment factor."""
    for max_count, factor in _NEC_CONDUCTOR_ADJUSTMENT:
        if num_conductors <= max_count:
            return factor
    return 0.35


def _nec_ampacity(size_mm2, conductor='Cu', insulation='XLPE'):
    """Get NEC 310.16 ampacity for given cable parameters."""
    awg = _mm2_to_awg(size_mm2)
    entry = _NEC_310_16.get(awg, {})
    # Map insulation to temperature rating: XLPE=90°C, PVC=60°C
    temp_rating = _nec_temp_rating(insulation)
    temp = temp_rating.replace('C', '')
    cond = 'cu' if conductor.upper() == 'CU' else 'al'
    key = f'{cond}_{temp}'
    return entry.get(key) or entry.get(f'{cond}_75') or 0


# Transparent types that do not form a bus boundary
TRANSPARENT_TYPES = {"cb", "switch", "fuse", "ct", "pt", "surge_arrester"}


def _build_adjacency(project):
    """Build adjacency map from wires: component_id -> [(neighbor_id, wire)]."""
    adj = {}
    for w in project.wires:
        adj.setdefault(w.fromComponent, []).append((w.toComponent, w))
        adj.setdefault(w.toComponent, []).append((w.fromComponent, w))
    return adj


def _find_cable_buses(cable_id, adj, comp_map):
    """Walk through transparent devices from each cable port to find connected buses."""
    buses = []
    neighbors = adj.get(cable_id, [])
    for start_neighbor, _ in neighbors:
        # Walk through transparent types to find a bus
        visited = {cable_id}
        stack = [start_neighbor]
        found_bus = None
        while stack:
            nid = stack.pop()
            if nid in visited:
                continue
            visited.add(nid)
            comp = comp_map.get(nid)
            if not comp:
                continue
            if comp.type == "bus":
                found_bus = nid
                break
            if comp.type in TRANSPARENT_TYPES:
                for next_id, _ in adj.get(nid, []):
                    if next_id not in visited:
                        stack.append(next_id)
        if found_bus:
            buses.append(found_bus)
    return buses


def _get_cable_props(cable):
    """Extract cable properties with defaults."""
    p = cable.props
    std_type = p.get("standard_type", "")
    conductor = "Cu"
    insulation = "XLPE"
    size_mm2 = 0

    # Try to resolve from standard cable library
    if std_type:
        for sc in STANDARD_CABLES:
            if sc["id"] == std_type:
                conductor = sc["conductor"]
                insulation = sc["insulation"]
                size_mm2 = sc["size_mm2"]
                break

    # Override with explicit props if set
    if "conductor" in p:
        conductor = p["conductor"]
    if "insulation" in p:
        insulation = p["insulation"]

    # Derive size from r_per_km if not known
    r_per_km = float(p.get("r_per_km", 0))
    if size_mm2 == 0 and r_per_km > 0:
        rho = RESISTIVITY.get(conductor, 0.0175)
        # R/km = ρ×1000/S  →  S = ρ×1000/R
        size_mm2 = rho * 1000 / r_per_km

    return {
        "conductor": conductor,
        "insulation": insulation,
        "size_mm2": size_mm2,
        "r_per_km": r_per_km,
        "x_per_km": float(p.get("x_per_km", 0)),
        "rated_amps": float(p.get("rated_amps", 0)),
        "length_km": float(p.get("length_km", 0)),
        "voltage_kv": float(p.get("voltage_kv", 0)),
        "num_parallel": int(p.get("num_parallel", 1)),
        "standard_type": std_type,
        "ampacity_standard": p.get("ampacity_standard", "IEC"),
    }


def _find_upstream_cb(cable_id, adj, comp_map):
    """Find the nearest upstream circuit breaker or fuse for fault clearing time."""
    visited = {cable_id}
    stack = list(adj.get(cable_id, []))
    while stack:
        nid, _ = stack.pop()
        if nid in visited:
            continue
        visited.add(nid)
        comp = comp_map.get(nid)
        if not comp:
            continue
        if comp.type == "cb":
            return comp
        if comp.type == "fuse":
            return comp
        if comp.type in TRANSPARENT_TYPES or comp.type == "bus":
            for next_id, w in adj.get(nid, []):
                if next_id not in visited:
                    stack.append((next_id, w))
    return None


def _estimate_clearing_time(cb_comp):
    """Estimate CB clearing time from magnetic pickup setting."""
    if not cb_comp:
        return 0.1  # Default 100ms
    p = cb_comp.props
    if cb_comp.type == "fuse":
        return 0.01  # Fuses typically clear in <10ms
    # For CBs, use magnetic pickup to estimate instantaneous trip time
    mag = float(p.get("magnetic_pickup", 0))
    if mag > 0:
        # Instantaneous region: assume 30-50ms for MCCB, 50-80ms for ACB
        cb_type = p.get("cb_type", "mccb")
        return 0.05 if cb_type == "mccb" else 0.08
    return 0.1


def run_cable_sizing(project: ProjectData, ambient_temp_c: float = 30,
                     install_method: str = "trefoil",
                     max_voltage_drop_pct: float = 5.0):
    """Run cable sizing analysis for all cables in the project.

    Returns dict with 'cables' list and 'warnings' list.
    """
    from .loadflow import run_load_flow
    from .fault import run_fault_analysis

    comp_map = {c.id: c for c in project.components}
    adj = _build_adjacency(project)

    # Run load flow to get branch currents
    lf_results = None
    try:
        lf_results = run_load_flow(project, "newton_raphson")
    except Exception:
        pass

    # Run fault analysis to get fault currents at buses
    fault_results = None
    try:
        fault_results = run_fault_analysis(project, fault_bus_id=None, fault_type="3phase")
    except Exception:
        pass

    # Build branch current lookup from load flow
    branch_currents = {}
    if lf_results and lf_results.branches:
        for br in lf_results.branches:
            branch_currents[br.elementId] = br.i_amps

    cables = [c for c in project.components if c.type == "cable"]
    results = []
    warnings = []

    for cable in cables:
        cp = _get_cable_props(cable)
        cable_name = cable.props.get("name", cable.id)

        # Find connected buses
        bus_ids = _find_cable_buses(cable.id, adj, comp_map)
        from_bus = bus_ids[0] if len(bus_ids) > 0 else ""
        to_bus = bus_ids[1] if len(bus_ids) > 1 else ""
        from_bus_name = comp_map[from_bus].props.get("name", from_bus) if from_bus and from_bus in comp_map else from_bus
        to_bus_name = comp_map[to_bus].props.get("name", to_bus) if to_bus and to_bus in comp_map else to_bus

        # Get load current
        load_current = branch_currents.get(cable.id, 0)
        num_parallel = max(cp["num_parallel"], 1)
        current_per_cable = load_current / num_parallel

        # ── Thermal check ──
        ampacity_standard = cp["ampacity_standard"]
        rated_amps = cp["rated_amps"]
        insulation = cp["insulation"]

        if ampacity_standard == "NEC":
            # NEC 310.16 ampacity lookup
            if cp["size_mm2"] > 0:
                nec_amps = _nec_ampacity(cp["size_mm2"], cp["conductor"], cp["insulation"])
                if nec_amps > 0:
                    rated_amps = nec_amps

            # NEC 310.15(B)(1) ambient temperature correction
            temp_df = _nec_temp_correction_factor(ambient_temp_c, insulation)

            # NEC 310.15(C)(1) conductor count adjustment
            # num_parallel × 3 phases = current-carrying conductors in raceway
            num_conductors = num_parallel * 3
            conductor_df = _nec_conductor_count_factor(num_conductors)

            install_df = 1.0  # NEC uses conductor count factor instead of installation method
            derated_amps = rated_amps * temp_df * conductor_df
        else:
            # IEC derating
            install_df = INSTALL_DERATING.get(install_method, 1.0)

            # IEC ambient temperature derating
            max_temp = MAX_TEMP.get(insulation, 90)
            if ambient_temp_c != 30 and max_temp > ambient_temp_c:
                temp_df = math.sqrt((max_temp - ambient_temp_c) / (max_temp - 30))
            else:
                temp_df = 1.0

            derated_amps = rated_amps * install_df * temp_df
        thermal_ok = current_per_cable <= derated_amps if derated_amps > 0 else True
        thermal_loading_pct = (current_per_cable / derated_amps * 100) if derated_amps > 0 else 0

        # ── Voltage drop check ──
        cos_phi = 0.85  # Default power factor
        sin_phi = math.sqrt(1 - cos_phi ** 2)
        r_per_km = cp["r_per_km"] / num_parallel
        x_per_km = cp["x_per_km"] / num_parallel
        length_km = cp["length_km"]
        voltage_kv = cp["voltage_kv"]

        if voltage_kv > 0 and length_km > 0:
            v_phase = voltage_kv * 1000 / math.sqrt(3)
            vdrop_v = load_current * length_km * (r_per_km * cos_phi + x_per_km * sin_phi)
            voltage_drop_pct = (vdrop_v / v_phase) * 100 if v_phase > 0 else 0
        else:
            voltage_drop_pct = 0

        voltage_drop_ok = voltage_drop_pct <= max_voltage_drop_pct

        # ── Fault withstand check (adiabatic equation I²t ≤ k²S²) ──
        conductor = cp["conductor"]
        k = K_FACTORS.get((conductor, insulation), 143)
        size_mm2 = cp["size_mm2"]
        fault_withstand_ok = True

        # Get fault current at upstream bus
        fault_ka = 0
        for bid in bus_ids:
            if fault_results and bid in fault_results.buses:
                bus_fault = fault_results.buses[bid]
                if bus_fault.ik3 and bus_fault.ik3 > fault_ka:
                    fault_ka = bus_fault.ik3

        # Get clearing time from upstream CB
        upstream_cb = _find_upstream_cb(cable.id, adj, comp_map)
        t_clear = _estimate_clearing_time(upstream_cb)

        if fault_ka > 0 and size_mm2 > 0:
            # Required: I_fault(A) × sqrt(t) / k ≤ S
            i_fault_a = fault_ka * 1000
            min_size_for_fault = i_fault_a * math.sqrt(t_clear) / k
            fault_withstand_ok = size_mm2 >= min_size_for_fault
        else:
            min_size_for_fault = 0

        # ── Determine issues ──
        issues = []
        if not thermal_ok:
            issues.append(f"Thermal overload: {current_per_cable:.1f}A exceeds derated capacity {derated_amps:.1f}A ({thermal_loading_pct:.0f}%)")
        if not voltage_drop_ok:
            issues.append(f"Voltage drop {voltage_drop_pct:.2f}% exceeds limit {max_voltage_drop_pct}%")
        if not fault_withstand_ok:
            issues.append(f"Fault withstand: {size_mm2:.0f}mm² insufficient, need {min_size_for_fault:.0f}mm² for {fault_ka:.2f}kA / {t_clear*1000:.0f}ms")

        # ── Status ──
        if not thermal_ok or not voltage_drop_ok or not fault_withstand_ok:
            status = "fail"
        elif thermal_loading_pct > 80 or (3.0 < voltage_drop_pct <= max_voltage_drop_pct):
            status = "warning"
        else:
            status = "pass"

        # ── Warning reason (for warning status — cable passes but is near limits) ──
        warning_reasons = []
        if thermal_loading_pct > 80 and thermal_ok:
            warning_reasons.append(f"Thermal loading at {thermal_loading_pct:.0f}% (>80% of derated capacity {derated_amps:.0f}A)")
        if 3.0 < voltage_drop_pct <= max_voltage_drop_pct:
            warning_reasons.append(f"Voltage drop at {voltage_drop_pct:.1f}% (approaching {max_voltage_drop_pct}% limit)")

        # ── Recommended cable ──
        min_size_mm2 = size_mm2
        recommended_cable = ""
        if status == "fail":
            conductor_df = _nec_conductor_count_factor(num_parallel * 3) if ampacity_standard == "NEC" else 1.0
            min_size_mm2 = _find_minimum_size(
                cp, load_current, num_parallel, length_km, voltage_kv,
                cos_phi, sin_phi, max_voltage_drop_pct, fault_ka, t_clear,
                install_df, temp_df, ambient_temp_c,
                ampacity_standard=ampacity_standard, conductor_df=conductor_df,
            )
            # Find matching standard cable
            rec = _find_recommended_cable(cp["conductor"], cp["insulation"], voltage_kv, min_size_mm2)
            if rec:
                recommended_cable = f"{rec['size_mm2']:.0f}mm² {rec['conductor']} {rec['insulation']} {voltage_kv}kV"
                min_size_mm2 = rec["size_mm2"]
            else:
                recommended_cable = f"{min_size_mm2:.0f}mm² (no standard cable found)"

        results.append({
            "cable_id": cable.id,
            "cable_name": cable_name,
            "from_bus": from_bus_name,
            "to_bus": to_bus_name,
            "load_current_a": round(load_current, 2),
            "thermal_ok": thermal_ok,
            "thermal_loading_pct": round(thermal_loading_pct, 1),
            "voltage_drop_pct": round(voltage_drop_pct, 2),
            "voltage_drop_ok": voltage_drop_ok,
            "fault_withstand_ok": fault_withstand_ok,
            "min_size_mm2": round(min_size_mm2, 1),
            "recommended_cable": recommended_cable,
            "status": status,
            "issues": issues,
            "warning_reasons": warning_reasons,
            "ampacity_standard": ampacity_standard,
            "nec_rating": _nec_ampacity_lookup(cp["size_mm2"], cp["conductor"], '75C'),
        })

    return {"cables": results, "warnings": warnings}


def _find_minimum_size(cp, load_current, num_parallel, length_km, voltage_kv,
                       cos_phi, sin_phi, max_vdrop_pct, fault_ka, t_clear,
                       install_df, temp_df, ambient_temp_c,
                       ampacity_standard='IEC', conductor_df=1.0):
    """Find the minimum cable size (mm²) that satisfies all three checks."""
    conductor = cp["conductor"]
    insulation = cp["insulation"]
    k = K_FACTORS.get((conductor, insulation), 143)
    standard_sizes = [1.5, 2.5, 4, 6, 10, 16, 25, 35, 50, 70, 95, 120, 150, 185, 240, 300, 400, 500, 630]

    current_per_cable = load_current / max(num_parallel, 1)

    for size in standard_sizes:
        # Find a matching standard cable for rated_amps and impedance
        match = None
        for sc in STANDARD_CABLES:
            if (sc["conductor"] == conductor and sc["insulation"] == insulation
                    and abs(sc["voltage_kv"] - voltage_kv) < 1.0 and sc["size_mm2"] == size):
                match = sc
                break
        if not match:
            continue

        # Thermal check
        if ampacity_standard == "NEC":
            # Use NEC 310.16 ampacity for this size
            nec_amps = _nec_ampacity(size, conductor, insulation)
            base_amps = nec_amps if nec_amps > 0 else match["rated_amps"]
            derated = base_amps * temp_df * conductor_df
        else:
            derated = match["rated_amps"] * install_df * temp_df
        if current_per_cable > derated:
            continue

        # Voltage drop check
        if voltage_kv > 0 and length_km > 0:
            r = match["r_per_km"] / max(num_parallel, 1)
            x = match["x_per_km"] / max(num_parallel, 1)
            v_phase = voltage_kv * 1000 / math.sqrt(3)
            vdrop = load_current * length_km * (r * cos_phi + x * sin_phi)
            vdrop_pct = (vdrop / v_phase) * 100 if v_phase > 0 else 0
            if vdrop_pct > max_vdrop_pct:
                continue

        # Fault withstand check
        if fault_ka > 0:
            i_fault_a = fault_ka * 1000
            min_size_fault = i_fault_a * math.sqrt(t_clear) / k
            if size < min_size_fault:
                continue

        return size

    # No standard size satisfies all — return computed minimum
    return max(cp.get("size_mm2", 0), 0)


def _find_recommended_cable(conductor, insulation, voltage_kv, min_size_mm2):
    """Find the smallest standard cable matching conductor/insulation/voltage that meets min size."""
    candidates = [
        sc for sc in STANDARD_CABLES
        if sc["conductor"] == conductor
        and sc["insulation"] == insulation
        and abs(sc["voltage_kv"] - voltage_kv) < 1.0
        and sc["size_mm2"] >= min_size_mm2
    ]
    if not candidates:
        return None
    candidates.sort(key=lambda c: c["size_mm2"])
    return candidates[0]
