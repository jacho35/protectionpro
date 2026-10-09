"""Cable Sizing Calculator — thermal, voltage drop, and fault withstand checks.

For every cable in the project, determines whether it is correctly sized
for the load current, voltage drop, and fault withstand energy (I²t).
Returns pass/fail per cable with recommended minimum size.
"""

import math
from ..models.schemas import ProjectData

# ─── Standard cable library (20°C DC base, IEC 60228 Class 2) ───
# NOTE: r_per_km values in THIS table are 20°C DC conductor resistances and are
# corrected to conductor operating temperature via _temp_correction() at the
# point of use (voltage-drop checks in _find_minimum_size). The frontend
# STANDARD_CABLES library now stores OPERATING-TEMPERATURE values instead, so
# the two tables are deliberately on different temperature bases — DO NOT copy
# values between them. Project-payload cable props are likewise operating-
# temperature: the frontend migrates legacy (pre-dataVersion-2) projects to the
# corrected values on load, so payload r_per_km is trusted as hot and is NOT
# corrected here.
STANDARD_CABLES = [
    # MV XLPE Copper (11kV)
    {"id": "cu_xlpe_16_11kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 16, "voltage_kv": 11, "r_per_km": 1.15, "x_per_km": 0.119, "rated_amps": 110},
    {"id": "cu_xlpe_25_11kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 25, "voltage_kv": 11, "r_per_km": 0.727, "x_per_km": 0.113, "rated_amps": 143},
    {"id": "cu_xlpe_35_11kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 35, "voltage_kv": 11, "r_per_km": 0.524, "x_per_km": 0.110, "rated_amps": 172},
    {"id": "cu_xlpe_50_11kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 50, "voltage_kv": 11, "r_per_km": 0.387, "x_per_km": 0.107, "rated_amps": 205},
    {"id": "cu_xlpe_70_11kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 70, "voltage_kv": 11, "r_per_km": 0.268, "x_per_km": 0.104, "rated_amps": 253},
    {"id": "cu_xlpe_95_11kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 95, "voltage_kv": 11, "r_per_km": 0.193, "x_per_km": 0.101, "rated_amps": 307},
    {"id": "cu_xlpe_120_11kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 120, "voltage_kv": 11, "r_per_km": 0.153, "x_per_km": 0.099, "rated_amps": 352},
    {"id": "cu_xlpe_150_11kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 150, "voltage_kv": 11, "r_per_km": 0.124, "x_per_km": 0.097, "rated_amps": 397},
    {"id": "cu_xlpe_185_11kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 185, "voltage_kv": 11, "r_per_km": 0.0991, "x_per_km": 0.095, "rated_amps": 453},
    {"id": "cu_xlpe_240_11kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 240, "voltage_kv": 11, "r_per_km": 0.0754, "x_per_km": 0.093, "rated_amps": 529},
    {"id": "cu_xlpe_300_11kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 300, "voltage_kv": 11, "r_per_km": 0.0601, "x_per_km": 0.091, "rated_amps": 599},
    {"id": "cu_xlpe_400_11kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 400, "voltage_kv": 11, "r_per_km": 0.0470, "x_per_km": 0.089, "rated_amps": 683},
    # MV XLPE Aluminium (11kV)
    {"id": "al_xlpe_35_11kv", "conductor": "Al", "insulation": "XLPE", "size_mm2": 35, "voltage_kv": 11, "r_per_km": 0.868, "x_per_km": 0.110, "rated_amps": 133},
    {"id": "al_xlpe_50_11kv", "conductor": "Al", "insulation": "XLPE", "size_mm2": 50, "voltage_kv": 11, "r_per_km": 0.641, "x_per_km": 0.107, "rated_amps": 159},
    {"id": "al_xlpe_70_11kv", "conductor": "Al", "insulation": "XLPE", "size_mm2": 70, "voltage_kv": 11, "r_per_km": 0.443, "x_per_km": 0.104, "rated_amps": 196},
    {"id": "al_xlpe_95_11kv", "conductor": "Al", "insulation": "XLPE", "size_mm2": 95, "voltage_kv": 11, "r_per_km": 0.320, "x_per_km": 0.101, "rated_amps": 238},
    {"id": "al_xlpe_120_11kv", "conductor": "Al", "insulation": "XLPE", "size_mm2": 120, "voltage_kv": 11, "r_per_km": 0.253, "x_per_km": 0.099, "rated_amps": 274},
    {"id": "al_xlpe_150_11kv", "conductor": "Al", "insulation": "XLPE", "size_mm2": 150, "voltage_kv": 11, "r_per_km": 0.206, "x_per_km": 0.097, "rated_amps": 309},
    {"id": "al_xlpe_185_11kv", "conductor": "Al", "insulation": "XLPE", "size_mm2": 185, "voltage_kv": 11, "r_per_km": 0.164, "x_per_km": 0.095, "rated_amps": 354},
    {"id": "al_xlpe_240_11kv", "conductor": "Al", "insulation": "XLPE", "size_mm2": 240, "voltage_kv": 11, "r_per_km": 0.125, "x_per_km": 0.093, "rated_amps": 415},
    {"id": "al_xlpe_300_11kv", "conductor": "Al", "insulation": "XLPE", "size_mm2": 300, "voltage_kv": 11, "r_per_km": 0.100, "x_per_km": 0.091, "rated_amps": 472},
    {"id": "al_xlpe_400_11kv", "conductor": "Al", "insulation": "XLPE", "size_mm2": 400, "voltage_kv": 11, "r_per_km": 0.0778, "x_per_km": 0.089, "rated_amps": 545},
    # LV XLPE Copper (0.6/1kV)
    {"id": "cu_xlpe_16_lv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 16, "voltage_kv": 0.4, "r_per_km": 1.15, "x_per_km": 0.080, "rated_amps": 96},
    {"id": "cu_xlpe_25_lv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 25, "voltage_kv": 0.4, "r_per_km": 0.727, "x_per_km": 0.079, "rated_amps": 119},
    {"id": "cu_xlpe_35_lv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 35, "voltage_kv": 0.4, "r_per_km": 0.524, "x_per_km": 0.076, "rated_amps": 147},
    {"id": "cu_xlpe_50_lv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 50, "voltage_kv": 0.4, "r_per_km": 0.387, "x_per_km": 0.076, "rated_amps": 179},
    {"id": "cu_xlpe_70_lv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 70, "voltage_kv": 0.4, "r_per_km": 0.268, "x_per_km": 0.074, "rated_amps": 229},
    {"id": "cu_xlpe_95_lv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 95, "voltage_kv": 0.4, "r_per_km": 0.193, "x_per_km": 0.073, "rated_amps": 278},
    {"id": "cu_xlpe_120_lv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 120, "voltage_kv": 0.4, "r_per_km": 0.153, "x_per_km": 0.072, "rated_amps": 322},
    {"id": "cu_xlpe_150_lv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 150, "voltage_kv": 0.4, "r_per_km": 0.124, "x_per_km": 0.072, "rated_amps": 371},
    {"id": "cu_xlpe_185_lv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 185, "voltage_kv": 0.4, "r_per_km": 0.0991, "x_per_km": 0.072, "rated_amps": 424},
    {"id": "cu_xlpe_240_lv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 240, "voltage_kv": 0.4, "r_per_km": 0.0754, "x_per_km": 0.072, "rated_amps": 500},
    {"id": "cu_xlpe_300_lv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 300, "voltage_kv": 0.4, "r_per_km": 0.0601, "x_per_km": 0.071, "rated_amps": 576},
    # MV XLPE Copper (22kV)
    {"id": "cu_xlpe_35_22kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 35, "voltage_kv": 22, "r_per_km": 0.524, "x_per_km": 0.122, "rated_amps": 172},
    {"id": "cu_xlpe_50_22kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 50, "voltage_kv": 22, "r_per_km": 0.387, "x_per_km": 0.118, "rated_amps": 205},
    {"id": "cu_xlpe_70_22kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 70, "voltage_kv": 22, "r_per_km": 0.268, "x_per_km": 0.114, "rated_amps": 253},
    {"id": "cu_xlpe_95_22kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 95, "voltage_kv": 22, "r_per_km": 0.193, "x_per_km": 0.111, "rated_amps": 307},
    {"id": "cu_xlpe_120_22kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 120, "voltage_kv": 22, "r_per_km": 0.153, "x_per_km": 0.108, "rated_amps": 352},
    {"id": "cu_xlpe_150_22kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 150, "voltage_kv": 22, "r_per_km": 0.124, "x_per_km": 0.106, "rated_amps": 397},
    {"id": "cu_xlpe_185_22kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 185, "voltage_kv": 22, "r_per_km": 0.0991, "x_per_km": 0.104, "rated_amps": 453},
    {"id": "cu_xlpe_240_22kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 240, "voltage_kv": 22, "r_per_km": 0.0754, "x_per_km": 0.101, "rated_amps": 529},
    {"id": "cu_xlpe_300_22kv", "conductor": "Cu", "insulation": "XLPE", "size_mm2": 300, "voltage_kv": 22, "r_per_km": 0.0601, "x_per_km": 0.099, "rated_amps": 599},
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
    {"id": "al_xlpe_16_lv", "conductor": "Al", "insulation": "XLPE", "size_mm2": 16, "voltage_kv": 0.4, "r_per_km": 1.91, "x_per_km": 0.080, "rated_amps": 76},
    {"id": "al_xlpe_25_lv", "conductor": "Al", "insulation": "XLPE", "size_mm2": 25, "voltage_kv": 0.4, "r_per_km": 1.20, "x_per_km": 0.079, "rated_amps": 90},
    {"id": "al_xlpe_35_lv", "conductor": "Al", "insulation": "XLPE", "size_mm2": 35, "voltage_kv": 0.4, "r_per_km": 0.868, "x_per_km": 0.076, "rated_amps": 112},
    {"id": "al_xlpe_50_lv", "conductor": "Al", "insulation": "XLPE", "size_mm2": 50, "voltage_kv": 0.4, "r_per_km": 0.641, "x_per_km": 0.076, "rated_amps": 136},
    {"id": "al_xlpe_70_lv", "conductor": "Al", "insulation": "XLPE", "size_mm2": 70, "voltage_kv": 0.4, "r_per_km": 0.443, "x_per_km": 0.074, "rated_amps": 174},
    {"id": "al_xlpe_95_lv", "conductor": "Al", "insulation": "XLPE", "size_mm2": 95, "voltage_kv": 0.4, "r_per_km": 0.320, "x_per_km": 0.073, "rated_amps": 211},
    {"id": "al_xlpe_120_lv", "conductor": "Al", "insulation": "XLPE", "size_mm2": 120, "voltage_kv": 0.4, "r_per_km": 0.253, "x_per_km": 0.072, "rated_amps": 245},
    {"id": "al_xlpe_150_lv", "conductor": "Al", "insulation": "XLPE", "size_mm2": 150, "voltage_kv": 0.4, "r_per_km": 0.206, "x_per_km": 0.072, "rated_amps": 283},
    {"id": "al_xlpe_185_lv", "conductor": "Al", "insulation": "XLPE", "size_mm2": 185, "voltage_kv": 0.4, "r_per_km": 0.164, "x_per_km": 0.072, "rated_amps": 323},
    {"id": "al_xlpe_240_lv", "conductor": "Al", "insulation": "XLPE", "size_mm2": 240, "voltage_kv": 0.4, "r_per_km": 0.125, "x_per_km": 0.072, "rated_amps": 382},
    {"id": "al_xlpe_300_lv", "conductor": "Al", "insulation": "XLPE", "size_mm2": 300, "voltage_kv": 0.4, "r_per_km": 0.100, "x_per_km": 0.071, "rated_amps": 440},
    # LV PVC Aluminium (0.6/1kV) — r at 20 °C (IEC 60228); x as Cu PVC; rating = SANS 10142-1 Table 6.7(a) col. 3, like the Cu PVC entries (Table 6.4(a))
    {"id": "al_pvc_16_lv", "conductor": "Al", "insulation": "PVC", "size_mm2": 16, "voltage_kv": 0.4, "r_per_km": 1.910, "x_per_km": 0.080, "rated_amps": 58},
    {"id": "al_pvc_25_lv", "conductor": "Al", "insulation": "PVC", "size_mm2": 25, "voltage_kv": 0.4, "r_per_km": 1.20, "x_per_km": 0.079, "rated_amps": 76},
    {"id": "al_pvc_35_lv", "conductor": "Al", "insulation": "PVC", "size_mm2": 35, "voltage_kv": 0.4, "r_per_km": 0.868, "x_per_km": 0.076, "rated_amps": 94},
    {"id": "al_pvc_50_lv", "conductor": "Al", "insulation": "PVC", "size_mm2": 50, "voltage_kv": 0.4, "r_per_km": 0.641, "x_per_km": 0.076, "rated_amps": 113},
    {"id": "al_pvc_70_lv", "conductor": "Al", "insulation": "PVC", "size_mm2": 70, "voltage_kv": 0.4, "r_per_km": 0.443, "x_per_km": 0.074, "rated_amps": 143},
    {"id": "al_pvc_95_lv", "conductor": "Al", "insulation": "PVC", "size_mm2": 95, "voltage_kv": 0.4, "r_per_km": 0.320, "x_per_km": 0.073, "rated_amps": 174},
    {"id": "al_pvc_120_lv", "conductor": "Al", "insulation": "PVC", "size_mm2": 120, "voltage_kv": 0.4, "r_per_km": 0.253, "x_per_km": 0.072, "rated_amps": 202},
    {"id": "al_pvc_150_lv", "conductor": "Al", "insulation": "PVC", "size_mm2": 150, "voltage_kv": 0.4, "r_per_km": 0.206, "x_per_km": 0.072, "rated_amps": 232},
    {"id": "al_pvc_185_lv", "conductor": "Al", "insulation": "PVC", "size_mm2": 185, "voltage_kv": 0.4, "r_per_km": 0.164, "x_per_km": 0.072, "rated_amps": 265},
    {"id": "al_pvc_240_lv", "conductor": "Al", "insulation": "PVC", "size_mm2": 240, "voltage_kv": 0.4, "r_per_km": 0.125, "x_per_km": 0.072, "rated_amps": 312},
    {"id": "al_pvc_300_lv", "conductor": "Al", "insulation": "PVC", "size_mm2": 300, "voltage_kv": 0.4, "r_per_km": 0.10, "x_per_km": 0.071, "rated_amps": 360},
    # LV PVC Copper (0.6/1kV)
    {"id": "cu_pvc_1.5_lv", "conductor": "Cu", "insulation": "PVC", "size_mm2": 1.5, "voltage_kv": 0.4, "r_per_km": 12.1, "x_per_km": 0.100, "rated_amps": 18},
    {"id": "cu_pvc_2.5_lv", "conductor": "Cu", "insulation": "PVC", "size_mm2": 2.5, "voltage_kv": 0.4, "r_per_km": 7.41, "x_per_km": 0.095, "rated_amps": 25},
    {"id": "cu_pvc_4_lv", "conductor": "Cu", "insulation": "PVC", "size_mm2": 4, "voltage_kv": 0.4, "r_per_km": 4.61, "x_per_km": 0.093, "rated_amps": 33},
    {"id": "cu_pvc_6_lv", "conductor": "Cu", "insulation": "PVC", "size_mm2": 6, "voltage_kv": 0.4, "r_per_km": 3.08, "x_per_km": 0.090, "rated_amps": 42},
    {"id": "cu_pvc_10_lv", "conductor": "Cu", "insulation": "PVC", "size_mm2": 10, "voltage_kv": 0.4, "r_per_km": 1.83, "x_per_km": 0.084, "rated_amps": 58},
    {"id": "cu_pvc_16_lv", "conductor": "Cu", "insulation": "PVC", "size_mm2": 16, "voltage_kv": 0.4, "r_per_km": 1.15, "x_per_km": 0.080, "rated_amps": 77},
    {"id": "cu_pvc_25_lv", "conductor": "Cu", "insulation": "PVC", "size_mm2": 25, "voltage_kv": 0.4, "r_per_km": 0.727, "x_per_km": 0.079, "rated_amps": 102},
    {"id": "cu_pvc_35_lv", "conductor": "Cu", "insulation": "PVC", "size_mm2": 35, "voltage_kv": 0.4, "r_per_km": 0.524, "x_per_km": 0.076, "rated_amps": 125},
    {"id": "cu_pvc_50_lv", "conductor": "Cu", "insulation": "PVC", "size_mm2": 50, "voltage_kv": 0.4, "r_per_km": 0.387, "x_per_km": 0.076, "rated_amps": 151},
    {"id": "cu_pvc_70_lv", "conductor": "Cu", "insulation": "PVC", "size_mm2": 70, "voltage_kv": 0.4, "r_per_km": 0.268, "x_per_km": 0.074, "rated_amps": 192},
    {"id": "cu_pvc_95_lv", "conductor": "Cu", "insulation": "PVC", "size_mm2": 95, "voltage_kv": 0.4, "r_per_km": 0.193, "x_per_km": 0.073, "rated_amps": 231},
    {"id": "cu_pvc_120_lv", "conductor": "Cu", "insulation": "PVC", "size_mm2": 120, "voltage_kv": 0.4, "r_per_km": 0.153, "x_per_km": 0.072, "rated_amps": 267},
    {"id": "cu_pvc_150_lv", "conductor": "Cu", "insulation": "PVC", "size_mm2": 150, "voltage_kv": 0.4, "r_per_km": 0.124, "x_per_km": 0.072, "rated_amps": 306},
    {"id": "cu_pvc_185_lv", "conductor": "Cu", "insulation": "PVC", "size_mm2": 185, "voltage_kv": 0.4, "r_per_km": 0.0991, "x_per_km": 0.072, "rated_amps": 348},
    {"id": "cu_pvc_240_lv", "conductor": "Cu", "insulation": "PVC", "size_mm2": 240, "voltage_kv": 0.4, "r_per_km": 0.0754, "x_per_km": 0.072, "rated_amps": 409},
    {"id": "cu_pvc_300_lv", "conductor": "Cu", "insulation": "PVC", "size_mm2": 300, "voltage_kv": 0.4, "r_per_km": 0.0601, "x_per_km": 0.071, "rated_amps": 469},
]

# [P4] Backend mirror of frontend/js/constants.js STANDARD_OVERHEAD_LINES —
# codeword ACSR/AAAC bare conductors. STANDARD_CABLES above has no BARE/
# overhead entries (it's all insulated cable), so the recommend-on-fail
# search (_find_minimum_size / _find_recommended_cable) previously could
# never suggest an overhead conductor for a failing overhead line; this
# table lets it search the right catalogue. r_per_km/x_per_km/r0_per_km/
# x0_per_km are at 20°C per the codeword-conductor convention (BS 215 /
# IEC 61089), matching conductor_temp.py's documented base — resistance_at()
# corrects to DEFAULT_OVERHEAD_TEMP_C before use, same as the main sizing
# loop's r_per_km. Keep in sync with the frontend table if it changes.
STANDARD_OVERHEAD_LINES = [
    {"id": "acsr_squirrel", "name": "ACSR Squirrel (20 mm²)", "material": "ACSR", "size_mm2": 20, "r_per_km": 1.3740, "x_per_km": 0.412, "rated_amps": 107},
    {"id": "acsr_gopher", "name": "ACSR Gopher (26 mm²)", "material": "ACSR", "size_mm2": 26, "r_per_km": 1.0980, "x_per_km": 0.400, "rated_amps": 128},
    {"id": "acsr_weasel", "name": "ACSR Weasel (34 mm²)", "material": "ACSR", "size_mm2": 34, "r_per_km": 0.9116, "x_per_km": 0.391, "rated_amps": 150},
    {"id": "acsr_ferret", "name": "ACSR Ferret (42 mm²)", "material": "ACSR", "size_mm2": 42, "r_per_km": 0.6795, "x_per_km": 0.383, "rated_amps": 176},
    {"id": "acsr_rabbit", "name": "ACSR Rabbit (55 mm²)", "material": "ACSR", "size_mm2": 55, "r_per_km": 0.5449, "x_per_km": 0.371, "rated_amps": 208},
    {"id": "acsr_mink", "name": "ACSR Mink (65 mm²)", "material": "ACSR", "size_mm2": 65, "r_per_km": 0.4565, "x_per_km": 0.366, "rated_amps": 236},
    {"id": "acsr_dog", "name": "ACSR Dog (100 mm²)", "material": "ACSR", "size_mm2": 100, "r_per_km": 0.2733, "x_per_km": 0.350, "rated_amps": 305},
    {"id": "acsr_hare", "name": "ACSR Hare (105 mm²)", "material": "ACSR", "size_mm2": 105, "r_per_km": 0.2680, "x_per_km": 0.348, "rated_amps": 311},
    {"id": "acsr_wolf", "name": "ACSR Wolf (158 mm²)", "material": "ACSR", "size_mm2": 158, "r_per_km": 0.1871, "x_per_km": 0.331, "rated_amps": 405},
    {"id": "acsr_panther", "name": "ACSR Panther (212 mm²)", "material": "ACSR", "size_mm2": 212, "r_per_km": 0.1390, "x_per_km": 0.319, "rated_amps": 480},
    {"id": "acsr_lynx", "name": "ACSR Lynx (226 mm²)", "material": "ACSR", "size_mm2": 226, "r_per_km": 0.1441, "x_per_km": 0.320, "rated_amps": 490},
    {"id": "acsr_zebra", "name": "ACSR Zebra (428 mm²)", "material": "ACSR", "size_mm2": 428, "r_per_km": 0.0674, "x_per_km": 0.297, "rated_amps": 730},
    {"id": "aaac_50", "name": "AAAC 50 mm²", "material": "AAAC", "size_mm2": 50, "r_per_km": 0.6752, "x_per_km": 0.372, "rated_amps": 196},
    {"id": "aaac_100", "name": "AAAC 100 mm²", "material": "AAAC", "size_mm2": 100, "r_per_km": 0.3388, "x_per_km": 0.351, "rated_amps": 300},
    {"id": "aaac_150", "name": "AAAC 150 mm²", "material": "AAAC", "size_mm2": 150, "r_per_km": 0.2222, "x_per_km": 0.336, "rated_amps": 385},
    {"id": "aaac_200", "name": "AAAC 200 mm²", "material": "AAAC", "size_mm2": 200, "r_per_km": 0.1657, "x_per_km": 0.325, "rated_amps": 460},
]

# Adiabatic withstand constant k (A√s / mm²)
# BARE = uninsulated overhead conductor (ACSR / AAAC / AAC). Its k is computed
# with the SAME IEC 60865 material constants as the insulated rows, but for a
# bare-conductor short-circuit temperature excursion of 80 °C (full-load) → 200 °C
# (the usual hard-drawn Al/Cu annealing-limited maximum), which is why it comes
# out below the XLPE (…→250 °C) values. Conservative: a lower k requires a
# larger area for the same fault, so overhead lines are not over-rated.
K_FACTORS = {
    ("Cu", "XLPE"): 143,
    ("Al", "XLPE"): 94,
    ("Cu", "PVC"): 115,
    ("Al", "PVC"): 76,
    ("Cu", "BARE"): 129,
    ("Al", "BARE"): 84,
}

# Max conductor operating temperature (°C). BARE overhead conductors are
# short-circuit-limited to ~200 °C (aluminium annealing) — a fault-withstand
# figure, not the continuous ampacity rating (see OVERHEAD_* below).
MAX_TEMP = {"XLPE": 90, "PVC": 70, "BARE": 200}

# [P4] Overhead ampacity ambient scaler. STANDARD_OVERHEAD_LINES.rated_amps is
# quoted at ~40°C still-air ambient / 75°C conductor (matching
# conductor_temp.DEFAULT_OVERHEAD_TEMP_C — the temperature the library's own
# rated_amps already assumes), so it was previously used as-is at ANY run
# ambient — a 45-50°C run (a realistic summer ambient) silently carried the
# same "derated" figure as a 10°C one. Apply the same sqrt derating law IEC
# 60364-5-52 uses for insulated cables, referenced to the overhead library's
# own base ambient/conductor-temperature pair instead of the insulated-cable
# 30°C/insulation-max-temp pair.
OVERHEAD_RATED_AMBIENT_C = 40.0
OVERHEAD_MAX_TEMP_C = 75.0

# [N4] The run-level installation method no longer carries a derating of its
# own: the old {"flat": 0.95, "buried": 0.85} factors were not from IEC
# 60364-5-52 (flat-touching single cores in air are rated slightly ABOVE
# trefoil there, and burial is a different reference method, not a factor).
# "buried" now only selects the ground ambient-temperature table (20 °C
# reference, Table B.52.15); grouping, soil and depth come from the per-cable
# IEC 60364-5-52 calculator (props.ampacity).
BURIED_METHODS = {"buried"}

# Resistivity at 20°C (Ω·mm²/m)
RESISTIVITY = {"Cu": 0.0175, "Al": 0.0282}


def _k_factor(conductor, insulation, size_mm2, warn=None, name=""):
    """Adiabatic k (A·√s/mm²), IEC 60364-4-43 Table 43A / 60364-5-54.

    [N2] PVC above 300 mm² has a lower final temperature (140 °C, not
    160 °C): k = 103 Cu / 68 Al. [N3] An insulation not in the table used to
    fall back to 143 — the Cu-XLPE value even for aluminium (52 % high);
    it now takes the conductor's PVC value, the lowest insulated k, and
    says so."""
    cond = "Al" if str(conductor).strip().lower().startswith("al") else "Cu"
    ins = str(insulation).strip().upper()
    if ins == "PVC" and size_mm2 and size_mm2 > 300:
        return 68.0 if cond == "Al" else 103.0
    k = K_FACTORS.get((cond, ins))
    if k is None:
        if warn is not None:
            warn.append(f"Cable '{name}': insulation '{insulation}' not in IEC "
                        f"60364-4-43 Table 43A — using the {cond}/PVC k (conservative).")
        return float(K_FACTORS[(cond, "PVC")])
    return float(k)


def _ambient_factor(insulation, ambient_c, buried):
    """[N5] Ambient-temperature correction, IEC 60364-5-52 Table B.52.14 (air,
    30 °C reference) or B.52.15 (ground, 20 °C reference), interpolated — the
    √((θmax−θa)/(θmax−θref)) law it replaces was up to 3 % optimistic (PVC,
    25 °C). 0.0 at or above the insulation's maximum temperature."""
    from .iec_60364_tables import IEC_TEMP_CORRECTION, interpolate_factor
    ins = "pvc" if str(insulation).strip().upper() == "PVC" else "xlpe"
    if ambient_c >= MAX_TEMP.get(ins.upper(), 90):
        return 0.0
    table = IEC_TEMP_CORRECTION["ground" if buried else "air"][ins]
    top = max(float(t) for t in table)
    if ambient_c > top:
        # Beyond the table: the √ law between the last row and θmax
        f_top = float(table[max(table, key=float)])
        tmax = MAX_TEMP.get(ins.upper(), 90)
        return f_top * math.sqrt(max(tmax - ambient_c, 0.0) / (tmax - top))
    return interpolate_factor(table, float(ambient_c))


def _temp_correction(conductor, insulation):
    """Resistance correction from 20°C DC to conductor operating temperature.

    R_op = R20 × [1 + α(θ_op − 20)] with α_Cu = 0.00393/K, α_Al = 0.00403/K:
      90°C (XLPE): Cu ×1.275, Al ×1.282
      70°C (PVC):  ×1.20 (both conductors)
    """
    if str(insulation).upper() == "PVC":
        return 1.20
    return 1.282 if str(conductor).upper() == "AL" else 1.275

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
TRANSPARENT_TYPES = {"cb", "switch", "fuse", "ct", "pt", "surge_arrester", "bus_duct"}
_SOURCE_TYPES = {"utility", "generator", "solar_pv", "wind_turbine"}


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
            if comp.type in ("bus", "distribution_board"):
                found_bus = nid
                break
            if comp.type in TRANSPARENT_TYPES:
                for next_id, _ in adj.get(nid, []):
                    if next_id not in visited:
                        stack.append(next_id)
        if found_bus:
            buses.append(found_bus)
    return buses


def _recompute_ampacity_block(block):
    """[T1][T2] Installed rating of a saved calculator block from the IEC
    60364-5-52 tables, or None when the block lacks the inputs or the
    standard tabulates no value. SLD cables are three-phase: 3 loaded
    conductors unless the block says otherwise."""
    from .iec_60364_tables import installed_ampacity
    try:
        size = float(block.get("size_mm2") or 0)
    except (TypeError, ValueError):
        return None
    if size <= 0 or not block.get("method"):
        return None
    try:
        amp = installed_ampacity(
            size, block.get("method"), block.get("conductor") or "cu",
            block.get("insulation") or "xlpe",
            float(block.get("ambient_c") if block.get("ambient_c") is not None else 30),
            block.get("grouping") or "bunched", int(block.get("circuits") or 1),
            block.get("soil_kmw"), block.get("depth_m"),
            loaded=int(block.get("loaded") or 3))
    except (TypeError, ValueError, KeyError):
        return None
    if amp["derated_a"] is None:
        return None
    return {"base_a": amp["base_a"], "derating": amp["derating"],
            "derated_a": amp["derated_a"]}


def _format_ampacity_conditions(amp):
    """Human-readable summary of an applied per-cable IEC 60364-5-52 ampacity
    block, for the cable-sizing result row / report."""
    method = amp.get("method", "?")
    parts = [f"IEC 60364-5-52 method {method}",
             f"{int(amp.get('loaded') or 3)} loaded conductors"]
    if amp.get("ambient_c") is not None:
        env = "ground" if str(method).startswith("D") else "air"
        parts.append(f"{float(amp['ambient_c']):g}°C {env}")
    if amp.get("circuits"):
        parts.append(f"{int(amp['circuits'])} circ")
    if amp.get("soil_kmw") is not None:
        parts.append(f"{float(amp['soil_kmw']):g} K·m/W")
    if amp.get("derating") is not None:
        parts.append(f"derate {float(amp['derating']):.2f}")
    if amp.get("base_a") is not None:
        parts.append(f"base {float(amp['base_a']):g} A")
    return " · ".join(parts)


def _get_cable_props(cable):
    """Extract cable properties with defaults."""
    p = cable.props
    is_overhead = str(p.get("construction", "")).lower() == "overhead"
    std_type = p.get("standard_type", "")
    conductor = "Cu"
    insulation = "XLPE"
    size_mm2 = 0

    if is_overhead:
        # Overhead line: bare aluminium conductor (ACSR / AAAC / AAC). The
        # payload carries r/x/rated_amps for the selected codeword conductor;
        # the size is derived from the 20 °C aluminium resistivity (the overhead
        # library stores 20 °C values, unlike the hot insulated-cable tables).
        conductor = "Al"
        insulation = "BARE"
        # The area must come from the 20 °C resistance: RESISTIVITY["Al"] is a
        # 20 °C resistivity, so feeding it the operating-temperature value that
        # conductor_temp writes into r_per_km would under-report the conductor
        # by the same ~18–22 % — and that area feeds the adiabatic
        # fault-withstand check. `base_resistance` returns the stashed 20 °C
        # figure, falling back to r_per_km when no correction was applied.
        from .conductor_temp import base_resistance
        r20_per_km = float(base_resistance(p, "r_per_km", 0.0) or 0.0)
        try:
            size_prop = float(p.get("size_mm2", 0) or 0)   # [N1]
        except (TypeError, ValueError):
            size_prop = 0.0
        if size_prop > 0:
            size_mm2 = size_prop
        elif r20_per_km > 0:
            size_mm2 = RESISTIVITY["Al"] * 1000 / r20_per_km  # S = ρ₂₀×1000/R
    else:
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

        # [N1] The cable's own nominal area wins — back-calculating it from
        # r_per_km (IEC 60228 maximum resistances) under-reported every
        # library cable the backend table lacks (95 mm² Al read as 88.1).
        try:
            size_prop = float(p.get("size_mm2", 0) or 0)
        except (TypeError, ValueError):
            size_prop = 0.0
        if size_prop > 0:
            size_mm2 = size_prop

        # Derive size from r_per_km if still not known
        r_per_km = float(p.get("r_per_km", 0))
        if size_mm2 == 0 and r_per_km > 0:
            # Payload r_per_km values are at conductor OPERATING temperature
            # (the frontend library stores 90°C XLPE / 70°C PVC values), so use
            # the hot resistivity — the derived area then matches the actual
            # conductor area used by the adiabatic withstand check.
            rho = RESISTIVITY.get(conductor, 0.0175) * _temp_correction(conductor, insulation)
            # R/km = ρ×1000/S  →  S = ρ×1000/R
            size_mm2 = rho * 1000 / r_per_km

    return {
        "conductor": conductor,
        "insulation": insulation,
        "size_mm2": size_mm2,
        "overhead": is_overhead,
        # Operating-temperature resistance — the right value for volt drop.
        # (The conductor AREA above is derived from the 20 °C base instead;
        # see the overhead branch.)
        "r_per_km": float(p.get("r_per_km", 0)),
        "x_per_km": float(p.get("x_per_km", 0)),
        "rated_amps": float(p.get("rated_amps", 0)),
        "length_km": float(p.get("length_km", 0)),
        "voltage_kv": float(p.get("voltage_kv", 0)),
        "num_parallel": int(p.get("num_parallel", 1)),
        "standard_type": std_type,
        "ampacity_standard": p.get("ampacity_standard", "IEC"),
    }


def _leads_to_source(start_id, cable_id, adj, comp_map):
    """True if a source is reachable from start_id without passing back
    through cable_id — i.e. start_id is on the source side of the cable.
    Mirrors the arcflash engine's source-side check."""
    visited = {cable_id, start_id}
    stack = [start_id]
    while stack:
        nid = stack.pop()
        comp = comp_map.get(nid)
        if not comp:
            continue
        if comp.type in _SOURCE_TYPES:
            return True
        # An open CB/switch carries no current — don't traverse through it.
        if comp.type in ("cb", "switch") and comp.props.get("state") == "open":
            continue
        for neighbor_id, _w in adj.get(nid, []):
            if neighbor_id not in visited:
                visited.add(neighbor_id)
                stack.append(neighbor_id)
    return False


def _find_upstream_cb(cable_id, adj, comp_map):
    """Find the nearest SOURCE-SIDE circuit breaker or fuse whose clearing
    time governs a fault on/beyond the cable.

    A feeder cable can carry a protective device on both ends (e.g. an
    incomer on the source side and a downstream feeder CB). Only the
    source-side device clears the cable's through-fault; the load-side
    device sees no fault current for it. The previous walk returned the
    first CB/fuse found in either direction, which could be the wrong
    (load-side) device and thus the wrong clearing time for the adiabatic
    withstand check. Prefer a device that lies on a path to a source; fall
    back to any device if none is on a resolvable source side (e.g. no
    source modelled)."""
    visited = {cable_id}
    stack = list(adj.get(cable_id, []))
    fallback = None
    while stack:
        nid, _ = stack.pop()
        if nid in visited:
            continue
        visited.add(nid)
        comp = comp_map.get(nid)
        if not comp:
            continue
        if comp.type in ("cb", "fuse"):
            if _leads_to_source(nid, cable_id, adj, comp_map):
                return comp  # source-side device governs the through-fault
            if fallback is None:
                fallback = comp  # remember; use only if no source-side device
            continue  # don't traverse past a load-side device
        if comp.type in TRANSPARENT_TYPES or comp.type in ("bus", "distribution_board"):
            for next_id, w in adj.get(nid, []):
                if next_id not in visited:
                    stack.append((next_id, w))
    return fallback


def _estimate_clearing_time(cb_comp, fault_current_a=None):
    """LEGACY — no longer used by run_cable_sizing, which takes the device's
    real curve via _device_trip_time ([CS2]). Kept for callers/tests of the
    old estimate.

    Estimate the protective device clearing time for the adiabatic check.

    [EE-14] Fuses: evaluate the generic gG curve at the ACTUAL fault current
    (total clearing = 1.2 × pre-arc, the TCC convention) instead of the old
    fixed 10 ms — which was optimistic near the melting threshold when the
    fault current is only a few ×In of a large upstream fuse. When the fuse
    never melts at the given current, the adiabatic-validity cap of 5 s is
    used (conservative for the withstand check). Without a usable current or
    rating the legacy 10 ms convention is kept. The per-cable
    ``clearing_time_s`` override still wins at the call site.
    """
    if not cb_comp:
        return 0.1  # Default 100ms
    p = cb_comp.props
    if cb_comp.type == "fuse":
        rating = float(p.get("rated_current_a", 0) or 0)
        if fault_current_a and fault_current_a > 0 and rating > 0:
            from .arcflash import _fuse_prearc_time
            t_pre = _fuse_prearc_time(rating, fault_current_a)
            if t_pre is not None:
                if t_pre == math.inf:
                    return 5.0  # never melts here — adiabatic validity cap
                return min(max(t_pre * 1.2, 0.004), 5.0)
        return 0.01  # legacy convention (bolted fault ≫ fuse rating)
    # For CBs, use magnetic pickup to estimate instantaneous trip time
    mag = float(p.get("magnetic_pickup", 0))
    if mag > 0:
        # Instantaneous region: assume 30-50ms for MCB/MCCB, 50-80ms for ACB
        cb_type = p.get("cb_type", "mccb")
        return 0.08 if cb_type == "acb" else 0.05
    return 0.1


# ─── Protection: clearing time (CS2) and overload coordination (CS3) ─────

ADIABATIC_LIMIT_S = 5.0     # IEC 60364-4-43 §434.5.2: valid up to 5 s
NO_DEVICE_CLEARING_S = 0.1  # legacy assumption when no device is modelled


def _find_protective_device(cable_id, adj, comp_map, relay_by_ct):
    """Nearest SOURCE-SIDE protective element for the cable: a CB, a fuse, or
    a CT whose associated overcurrent relay measures the path ([CS2] — the
    old walk knew only CBs and fuses, so a relay-protected feeder looked
    unprotected or took the CB's own 50 ms magnetic figure). Falls back to a
    load-side device when no source-side one is found, as before."""
    visited = {cable_id}
    stack = list(adj.get(cable_id, []))
    fallback = None
    while stack:
        nid, _ = stack.pop()
        if nid in visited:
            continue
        visited.add(nid)
        comp = comp_map.get(nid)
        if not comp:
            continue
        if comp.type in ("cb", "fuse") or (comp.type == "ct" and nid in relay_by_ct):
            if _leads_to_source(nid, cable_id, adj, comp_map):
                return comp
            if fallback is None:
                fallback = comp
            continue
        if comp.type in TRANSPARENT_TYPES or comp.type in ("bus", "distribution_board"):
            for next_id, w in adj.get(nid, []):
                if next_id not in visited:
                    stack.append((next_id, w))
    return fallback


def _device_trip_time(dev, current_a, relay_by_ct, relay_by_cb, comp_map, kappa=None):
    """[CS2] Clearing time (s) of ``dev`` at ``current_a``, from the same
    device models the arc-flash and TCC studies use: an overcurrent relay's
    IEC 60255-151 curve (through its CT) + breaker opening time, a breaker's
    own trip unit (instantaneous / short-time / I²t long-time region), a gG
    fuse's pre-arc curve × 1.2. Unlike the arc-flash evaluator it is NOT
    capped at 2 s (the IEEE 1584 limit) — the adiabatic check needs the real
    time up to its 5 s validity limit. ``math.inf`` = never operates."""
    from .arcflash import (_relay_operate_time, _cb_self_clearing_time,
                           _fuse_prearc_time, _BREAKER_OPENING_TIME_S)
    if dev is None or not current_a or current_a <= 0:
        return math.inf
    relay, ct_props = None, None
    if dev.type == "ct":
        relay, ct_props = relay_by_ct.get(dev.id), dev.props
    elif dev.type == "cb" and dev.id in relay_by_cb:
        relay = relay_by_cb[dev.id]
        ct = comp_map.get(relay.props.get("associated_ct") or "")
        ct_props = ct.props if ct else None
    if relay is not None:
        t = _relay_operate_time(relay.props, current_a, ct_props, kappa)
        return math.inf if t is None else t + _BREAKER_OPENING_TIME_S
    if dev.type == "cb":
        t = _cb_self_clearing_time(dev.props, current_a)
        return math.inf if t >= 10000.0 else t
    if dev.type == "fuse":
        rating = float(dev.props.get("rated_current_a", 0) or 0)
        t_pre = _fuse_prearc_time(rating, current_a) if rating > 0 else None
        if t_pre is None or math.isinf(t_pre):
            return math.inf
        return t_pre * 1.2
    return math.inf


def _overload_device(dev, relay_by_cb):
    """[CS3] (In, I2/In, label) of a device that gives IEC 60364-4-43 §433
    overload protection, or None when it doesn't (no device, a relay-tripped
    breaker, or no rating).

    In: a breaker's current setting Ir = trip_rating_a × thermal_pickup; a
    fuse's rated current. Conventional operating current I2 (× In):
    IEC 60898-1 MCB 1.45; IEC 60947-2 MCCB/ACB 1.30; IEC 60269 gG fuse
    1.6 (In ≥ 16 A), 1.9 (4–16 A), 2.1 (< 4 A)."""
    if dev is None:
        return None
    p = dev.props
    if dev.type == "fuse":
        i_n = float(p.get("rated_current_a", 0) or 0)
        if i_n <= 0:
            return None
        f = 1.6 if i_n >= 16 else (1.9 if i_n >= 4 else 2.1)
        return i_n, f, f"fuse {i_n:g} A"
    if dev.type == "cb" and dev.id not in relay_by_cb:
        trip = float(p.get("trip_rating_a", 0) or p.get("rated_current_a", 0) or 0)
        i_n = trip * float(p.get("thermal_pickup", 1.0) or 1.0)
        if i_n <= 0:
            return None
        cb_type = str(p.get("cb_type", "mccb")).lower()
        f = 1.45 if cb_type == "mcb" else 1.30
        return i_n, f, f"{cb_type.upper()} Ir {i_n:g} A"
    return None


# ─── Cumulative voltage drop from the origin (CS4) ────────────────────────

_ORIGIN_NEIGHBOURS = {"transformer", "autotransformer", "utility", "generator",
                      "solar_pv", "wind_turbine", "battery", "ups", "rectifier",
                      "vfd", "battery_charger"}


def _zone_origin(bus_id, adj, comp_map, lf_buses):
    """[CS4] Origin of the installation for ``bus_id``: walking the same
    voltage zone (buses joined by cables and closed switchgear, never across
    a transformer or converter), the bus that is fed directly from a source
    or transformer. With several such buses, the one at the highest load-flow
    voltage (nearest the supply) is taken."""
    from .loadflow import _is_transparent_and_closed
    seen, zone, stack = {bus_id}, [bus_id], [bus_id]
    origins = []
    while stack:
        nid = stack.pop()
        comp = comp_map.get(nid)
        if comp is not None and comp.type in ("bus", "distribution_board"):
            # fed from a source/transformer through closed switchgear only?
            inner, istack = {nid}, [nid]
            while istack:
                x = istack.pop()
                for y, _ in adj.get(x, []):
                    if y in inner:
                        continue
                    cy = comp_map.get(y)
                    if cy is None:
                        continue
                    if cy.type in _ORIGIN_NEIGHBOURS:
                        origins.append(nid)
                        istack = []
                        break
                    if _is_transparent_and_closed(cy):
                        inner.add(y); istack.append(y)
        for y, _ in adj.get(nid, []):
            if y in seen:
                continue
            cy = comp_map.get(y)
            if cy is None:
                continue
            if cy.type in ("bus", "distribution_board", "cable") or _is_transparent_and_closed(cy):
                seen.add(y); stack.append(y)
    origins = [o for o in dict.fromkeys(origins) if o in lf_buses]
    if not origins:
        return None
    return max(origins, key=lambda b: lf_buses[b].voltage_pu)


def run_cable_sizing(project: ProjectData, ambient_temp_c: float = 30,
                     install_method: str = "trefoil",
                     max_voltage_drop_pct: float = 5.0,
                     adiabatic_basis: str = "thermal_equivalent"):
    """Run cable sizing analysis for all cables in the project.

    Checks per IEC 60364: installed current-carrying capacity (5-52),
    overload protection Ib ≤ In ≤ Iz and I2 ≤ 1.45·Iz (4-43 §433.1, LV),
    voltage drop from the origin of the installation (5-52 §525 / Annex G)
    and short-circuit withstand t ≤ (k·S/I)² at the largest and the smallest
    fault current (4-43 §434.5.2).

    adiabatic_basis selects the fault-withstand current basis ([gap #4]):
      - "thermal_equivalent" (default): I_th = Ik″·√(m+n) per IEC 60909-0 §12
        (conservative — accounts for the DC component's heating).
      - "bare_isc": use Ik″ directly, matching the simpler adiabatic hand-calc
        used in many design guides.
    A cable may also carry a per-cable ``sizing_override`` block
    ({design_current_a, isc_ka, clearing_time_s}) so a standalone check can be
    run with hand-entered values instead of the network load-flow/fault solve.

    ``max_voltage_drop_pct`` is the limit from the origin of the installation
    (IEC 60364-5-52 Table G.52.1: 3 % lighting / 5 % other on a public LV
    supply; 6 % / 8 % from a private transformer).

    Returns dict with 'cables' list and 'warnings' list.
    """
    from .loadflow import run_load_flow, insert_implicit_load_buses
    from .fault import run_fault_analysis, thermal_m_factor
    from .arcflash import _build_relay_maps

    # [CS4] A cable feeding a load/motor directly gets a synthetic terminal
    # bus (as load flow does internally), so its far-end voltage — and the
    # cumulative drop from the origin — can be read from the load flow.
    project = insert_implicit_load_buses(project)
    comp_map = {c.id: c for c in project.components}
    adj = _build_adjacency(project)
    relay_by_ct, relay_by_cb = _build_relay_maps(comp_map)
    buried = str(install_method).lower() in BURIED_METHODS

    # Run load flow to get branch currents
    lf_results = None
    try:
        lf_results = run_load_flow(project, "newton_raphson", include_synthetic=True)
    except Exception:
        pass

    # [CS5] Every fault type — §434.5.2 needs the LARGEST fault current, and
    # near a Dyn transformer the earth fault can exceed the three-phase one.
    fault_results = None
    try:
        fault_results = run_fault_analysis(project, fault_bus_id=None, fault_type=None)
    except Exception:
        pass

    # [CS2] Minimum fault currents (IEC 60909-0 c_min: 0.95 LV, 1.0 MV) for
    # the far-end check — a time-inverse device is slowest there. [CT2] Each
    # line at its end-of-fault temperature (IEC 60909-0 §2.5 eq. 3 on the
    # 20 °C resistance; PVC 160 °C, XLPE 250 °C), the same basis app.js uses
    # for the compliance minimum study.
    from .conductor_temp import END_OF_FAULT
    MIN_STUDY_CONDUCTOR_C = END_OF_FAULT
    min_runs = {}

    def _min_fault(c_min):
        if c_min not in min_runs:
            try:
                min_runs[c_min] = run_fault_analysis(
                    project, fault_bus_id=None, fault_type=None, voltage_factor=c_min,
                    conductor_temperature_c=MIN_STUDY_CONDUCTOR_C)
            except Exception:
                min_runs[c_min] = None
        return min_runs[c_min]

    # Build branch current and power-factor lookups from load flow
    branch_currents = {}
    branch_pf = {}
    lf_converged = bool(lf_results and getattr(lf_results, "converged", False))
    lf_buses = (lf_results.buses if (lf_converged and lf_results.buses) else {}) or {}
    if lf_results and lf_results.branches:
        for br in lf_results.branches:
            branch_currents[br.elementId] = br.i_amps
            if br.s_mva and br.s_mva > 1e-6:
                branch_pf[br.elementId] = min(1.0, abs(br.p_mw) / br.s_mva)

    cables = [c for c in project.components if c.type == "cable"]
    results = []
    warnings = []

    for cable in cables:
        cp = _get_cable_props(cable)
        cable_name = cable.props.get("name", cable.id)

        # Find connected buses; the source-side one first
        bus_ids = _find_cable_buses(cable.id, adj, comp_map)
        if len(bus_ids) == 2 and not _leads_to_source(bus_ids[0], cable.id, adj, comp_map) \
                and _leads_to_source(bus_ids[1], cable.id, adj, comp_map):
            bus_ids = [bus_ids[1], bus_ids[0]]
        from_bus = bus_ids[0] if len(bus_ids) > 0 else ""
        to_bus = bus_ids[1] if len(bus_ids) > 1 else ""
        from_bus_name = comp_map[from_bus].props.get("name", from_bus) if from_bus and from_bus in comp_map else from_bus
        to_bus_name = comp_map[to_bus].props.get("name", to_bus) if to_bus and to_bus in comp_map else to_bus

        # [CS1] The voltage the cable RUNS at is its buses' nominal voltage.
        # Its own voltage_kv is the cable's rated class (an 11 kV-class cable
        # on a 3.3 kV feeder) or the palette default of 11 kV — dividing the
        # drop by it understated an LV cable's drop 27×.
        system_kv = 0.0
        for bid in bus_ids:
            try:
                system_kv = float(comp_map[bid].props.get("voltage_kv", 0) or 0)
            except (KeyError, TypeError, ValueError):
                system_kv = 0.0
            if system_kv > 0:
                break
        if system_kv <= 0:
            system_kv = cp["voltage_kv"]
        # Voltage CLASS for the recommendation: the chosen library type's, or
        # — for a cable never given a type (voltage_kv is then only the
        # palette default) — the system's.
        # A library type carries its own class (an 11 kV cable run on 3.3 kV
        # keeps voltage_kv at the operating 3.3), so read it from the entry.
        _std = next((sc for sc in STANDARD_CABLES if sc["id"] == cp["standard_type"]), None)
        class_kv = (_std["voltage_kv"] if _std
                    else cp["voltage_kv"] if (cp["standard_type"] and cp["voltage_kv"] > 0)
                    else system_kv)
        is_lv = 0 < system_kv <= 1.0

        # [gap #4] Standalone override
        override = cable.props.get("sizing_override") or {}
        ov_current = float(override.get("design_current_a", 0)
                           or cable.props.get("standalone_current_a", 0) or 0)
        ov_isc_ka = float(override.get("isc_ka", 0)
                          or cable.props.get("standalone_isc_ka", 0) or 0)
        ov_clear_s = float(override.get("clearing_time_s", 0)
                           or cable.props.get("standalone_clearing_s", 0) or 0)

        load_current = ov_current if ov_current > 0 else branch_currents.get(cable.id, 0)
        num_parallel = max(cp["num_parallel"], 1)
        current_per_cable = load_current / num_parallel

        # ── Thermal check ──
        ampacity_standard = cp["ampacity_standard"]
        rated_amps = cp["rated_amps"]
        insulation = cp["insulation"]
        warning_reasons = []

        amp_block = cable.props.get("ampacity")
        if not isinstance(amp_block, dict) or not amp_block.get("applied"):
            amp_block = None
        amp_derated_a = None
        amp_conditions = ""
        if amp_block and ampacity_standard != "NEC":
            try:
                amp_derated_a = float(amp_block.get("derated_a", 0) or 0)
            except (TypeError, ValueError):
                amp_derated_a = None
            # [T1][T2] Recompute the installed rating from the saved install
            # conditions with the corrected IEC 60364-5-52 tables. The saved
            # derated_a came from the old table (up to 36 % high for a three-
            # phase SLD cable) and would otherwise stay wrong in every project
            # saved before the correction.
            fresh = _recompute_ampacity_block(amp_block)
            if fresh is not None:
                if amp_derated_a and abs(fresh["derated_a"] - amp_derated_a) > 0.01 * amp_derated_a:
                    warning_reasons.append(
                        f"Installed ampacity recomputed from the IEC 60364-5-52 tables: "
                        f"{fresh['derated_a']:.1f} A (the {amp_derated_a:.1f} A saved on the "
                        f"cable came from the superseded table) — re-apply the calculator")
                amp_derated_a = fresh["derated_a"]
                amp_block = {**amp_block, "base_a": fresh["base_a"],
                             "derating": fresh["derating"], "derated_a": fresh["derated_a"]}
            elif amp_derated_a:
                warning_reasons.append(
                    "Installed ampacity: IEC 60364-5-52 tabulates no value for the saved "
                    "size/method — the saved rating is used; re-apply the calculator")
            if amp_derated_a and amp_derated_a > 0:
                amp_conditions = _format_ampacity_conditions(amp_block)

        conductor_df = 1.0
        if cp["overhead"]:
            # Library in-air rating scaled for ambient by the √ law about its
            # own 40 °C / 75 °C basis. [N6] IEC 60364-5-52 does not cover bare
            # conductors; this is an approximation of a heat-balance rating
            # (IEEE 738 / IEC TR 61597) and is disclosed as such.
            install_df = 1.0
            if ambient_temp_c >= OVERHEAD_MAX_TEMP_C:
                temp_df = 0.0
            elif ambient_temp_c != OVERHEAD_RATED_AMBIENT_C:
                temp_df = math.sqrt((OVERHEAD_MAX_TEMP_C - ambient_temp_c)
                                    / (OVERHEAD_MAX_TEMP_C - OVERHEAD_RATED_AMBIENT_C))
            else:
                temp_df = 1.0
            derated_amps = rated_amps * temp_df
            amp_conditions = (f"bare conductor: library in-air rating × √-law ambient "
                              f"factor {temp_df:.2f} (approximate — no heat-balance model)")
        elif amp_derated_a and amp_derated_a > 0:
            install_df = float(amp_block.get("derating", 1.0) or 1.0)
            temp_df = 1.0
            derated_amps = amp_derated_a
        elif ampacity_standard == "NEC":
            if cp["size_mm2"] > 0:
                nec_amps = _nec_ampacity(cp["size_mm2"], cp["conductor"], cp["insulation"])
                if nec_amps > 0:
                    rated_amps = nec_amps
            temp_df = _nec_temp_correction_factor(ambient_temp_c, insulation)
            num_conductors = num_parallel * 3
            conductor_df = _nec_conductor_count_factor(num_conductors)
            install_df = 1.0
            derated_amps = rated_amps * temp_df * conductor_df
        else:
            # [N4][N5] Library rating × the IEC ambient-temperature factor
            # (air Table B.52.14, or ground B.52.15 for "buried"). Grouping,
            # soil and depth are NOT applied on this path — the per-cable
            # IEC 60364-5-52 calculator does that.
            install_df = 1.0
            temp_df = _ambient_factor(insulation, ambient_temp_c, buried)
            derated_amps = rated_amps * temp_df
            if rated_amps > 0:
                warning_reasons.append(
                    "Installed ampacity not set — library rating × IEC ambient factor "
                    "only; installation method and grouping not applied (use the "
                    "IEC 60364-5-52 calculator on the cable)")
        thermal_ok = current_per_cable <= derated_amps if derated_amps > 0 else True
        thermal_loading_pct = (current_per_cable / derated_amps * 100) if derated_amps > 0 else 0
        ampacity_known = derated_amps > 0 or temp_df <= 0
        if temp_df <= 0:
            thermal_ok = False
            thermal_loading_pct = 999.9

        # ── Protective device ──
        device = _find_protective_device(cable.id, adj, comp_map, relay_by_ct)

        # ── [CS3] Overload protection, IEC 60364-4-43 §433.1 (LV only) ──
        # Ib ≤ In ≤ Iz and I2 ≤ 1.45·Iz, with Iz the installed rating of all
        # parallel conductors (§433.4). This is also what covers low-current
        # faults at the far end (§435.1).
        overload_ok = None
        overload_note = ""
        iz_total = derated_amps * num_parallel
        ol = _overload_device(device, relay_by_cb) if (is_lv and not cp["overhead"]) else None
        if ol is not None and iz_total > 0:
            i_n, f_i2, dev_label = ol
            i2 = f_i2 * i_n
            reasons = []
            if load_current > i_n * (1 + 1e-9):
                reasons.append(f"Ib {load_current:.1f} A > In {i_n:g} A")
            if i_n > iz_total * (1 + 1e-9):
                reasons.append(f"In {i_n:g} A > Iz {iz_total:.0f} A")
            if i2 > 1.45 * iz_total * (1 + 1e-9):
                reasons.append(f"I2 = {f_i2:g}·In = {i2:.0f} A > 1.45·Iz = {1.45 * iz_total:.0f} A")
            overload_ok = not reasons
            overload_note = (f"{dev_label}: " + "; ".join(reasons)) if reasons else \
                f"{dev_label}: Ib ≤ In ≤ Iz, I2 ≤ 1.45·Iz"

        # ── Voltage drop ──
        cos_phi = branch_pf.get(cable.id, 0.85)
        sin_phi = math.sqrt(max(0.0, 1 - cos_phi ** 2))
        r_per_km = cp["r_per_km"] / num_parallel
        x_per_km = cp["x_per_km"] / num_parallel
        length_km = cp["length_km"]
        if system_kv > 0 and length_km > 0:
            v_phase = system_kv * 1000 / math.sqrt(3)
            vdrop_v = load_current * length_km * (r_per_km * cos_phi + x_per_km * sin_phi)
            voltage_drop_pct = (vdrop_v / v_phase) * 100 if v_phase > 0 else 0
        else:
            voltage_drop_pct = 0

        # [CS4] IEC 60364-5-52 §525 limits the drop from the ORIGIN of the
        # installation to the equipment, not per cable: two cables of 2.7 %
        # and 3.2 % both passed a 5 % limit with 5.9 % at the load.
        cumulative_pct = None
        origin_name = ""
        down = to_bus if to_bus else ""
        if lf_buses and down in lf_buses:
            origin = _zone_origin(down, adj, comp_map, lf_buses)
            if origin is not None:
                cumulative_pct = max(0.0, (lf_buses[origin].voltage_pu
                                           - lf_buses[down].voltage_pu) * 100)
                origin_name = comp_map[origin].props.get("name", origin) if origin in comp_map else origin
        drop_for_limit = cumulative_pct if cumulative_pct is not None else voltage_drop_pct
        voltage_drop_ok = drop_for_limit <= max_voltage_drop_pct

        # ── Fault withstand, IEC 60364-4-43 §434.5.2: t ≤ (k·S/I)² ──
        conductor = cp["conductor"]
        size_mm2 = cp["size_mm2"]
        k = _k_factor(conductor, insulation, size_mm2, warnings, cable_name)
        freq = project.frequency or 50
        basis = str(cable.props.get("adiabatic_basis") or adiabatic_basis)

        def _ith(i_ka, kappa, t):
            if basis == "bare_isc":
                return i_ka, 1.0
            kap = kappa if kappa and kappa > 1.0 else 1.8
            f = math.sqrt(thermal_m_factor(kap, t, freq) + 1.0)
            return i_ka * f, f

        # (a) the LARGEST fault current (any type) at the cable's ends
        fault_ka = 0.0
        fault_kappa = None
        for bid in bus_ids:
            fb = fault_results.buses.get(bid) if fault_results else None
            if not fb:
                continue
            for i_ka in (fb.ik3, fb.ik1, fb.ikLL, fb.ikLLG):
                if i_ka and i_ka > fault_ka:
                    fault_ka, fault_kappa = float(i_ka), fb.kappa
        if ov_isc_ka > 0:
            fault_ka = ov_isc_ka
        if ov_clear_s > 0:
            t_clear = ov_clear_s
        elif device is None:
            t_clear = NO_DEVICE_CLEARING_S
            if fault_ka > 0:
                warning_reasons.append(
                    f"No protective device found on the source side — fault "
                    f"withstand assumes {NO_DEVICE_CLEARING_S * 1000:.0f} ms clearing")
        else:
            t_clear = _device_trip_time(device, fault_ka * 1000, relay_by_ct,
                                        relay_by_cb, comp_map, fault_kappa)

        issues = []
        min_size_for_fault = 0.0
        fault_withstand_ok = True
        s_req_max = 0.0              # area needed at the largest fault current
        far_needs_overload = False   # far end only clears via §433/§435.1
        ith_ka, sqrt_mn = fault_ka, 1.0
        if fault_ka > 0 and size_mm2 > 0:
            if t_clear >= ADIABATIC_LIMIT_S:
                fault_withstand_ok = False
                issues.append(
                    f"Fault withstand: the {fault_ka:.2f} kA fault is not cleared within "
                    f"{ADIABATIC_LIMIT_S:g} s by {device.props.get('name', device.id) if device else 'the protection'} "
                    f"(IEC 60364-4-43 §434.5.2)")
                min_size_for_fault = math.inf
            else:
                ith_ka, sqrt_mn = _ith(fault_ka, fault_kappa, t_clear)
                min_size_for_fault = ith_ka * 1000 * math.sqrt(t_clear) / k
                s_req_max = min_size_for_fault
                if size_mm2 < min_size_for_fault:
                    fault_withstand_ok = False
                    issues.append(
                        f"Fault withstand: {size_mm2:.0f}mm² insufficient, need "
                        f"{min_size_for_fault:.0f}mm² for Ith {ith_ka:.2f}kA "
                        f"(Ik {fault_ka:.2f}kA × √(m+n) = {sqrt_mn:.3f}) / {t_clear*1000:.0f}ms")

        # (b) [CS2] the SMALLEST fault current, at the far end, for a device
        # whose time depends on current (not for hand-entered overrides)
        far_ka = 0.0
        far_t = None
        if device is not None and ov_clear_s <= 0 and ov_isc_ka <= 0 and to_bus:
            mr = _min_fault(0.95 if is_lv else 1.0)
            fb = mr.buses.get(to_bus) if mr else None
            if fb:
                vals = [float(v) for v in (fb.ik3_network or fb.ik3, fb.ikLL, fb.ik1) if v and v > 0]
                far_ka = min(vals) if vals else 0.0
                far_kappa = fb.kappa
            if far_ka > 0 and size_mm2 > 0:
                far_t = _device_trip_time(device, far_ka * 1000, relay_by_ct,
                                          relay_by_cb, comp_map, far_kappa)
                if far_t >= ADIABATIC_LIMIT_S:
                    if overload_ok:
                        pass  # §435.1: coordinated overload protection covers it
                    else:
                        fault_withstand_ok = False
                        min_size_for_fault = math.inf
                        # a size that restores §433.1 also restores §435.1
                        far_needs_overload = overload_ok is False
                        issues.append(
                            f"Fault withstand: the minimum fault at the far end "
                            f"({far_ka * 1000:.0f} A, c_min, lines at end-of-fault temperature) is not cleared within "
                            f"{ADIABATIC_LIMIT_S:g} s (IEC 60364-4-43 §434.5.2)")
                else:
                    ith_far, _ = _ith(far_ka, far_kappa, far_t)
                    s_far = ith_far * 1000 * math.sqrt(far_t) / k
                    if s_far > min_size_for_fault:
                        min_size_for_fault = s_far
                    if size_mm2 < s_far:
                        fault_withstand_ok = False
                        issues.append(
                            f"Fault withstand at the far end: {size_mm2:.0f}mm² insufficient, "
                            f"need {s_far:.0f}mm² for {far_ka * 1000:.0f} A (c_min, lines at end-of-fault temperature) cleared "
                            f"in {far_t * 1000:.0f}ms")

        # ── Issues ──
        if not thermal_ok:
            if temp_df <= 0:
                _max_op_temp = OVERHEAD_MAX_TEMP_C if cp["overhead"] else MAX_TEMP.get(insulation, 90)
                issues.insert(0, f"Ambient temperature {ambient_temp_c:.0f}°C at/above conductor max operating temperature ({_max_op_temp:.0f}°C) — cable has no usable ampacity")
            else:
                issues.insert(0, f"Thermal overload: {current_per_cable:.1f}A exceeds derated capacity {derated_amps:.1f}A ({thermal_loading_pct:.0f}%)")
        if overload_ok is False:
            issues.append(f"Overload protection (IEC 60364-4-43 §433.1): {overload_note}")
        if not voltage_drop_ok:
            if cumulative_pct is not None:
                issues.append(f"Voltage drop from {origin_name} {cumulative_pct:.2f}% exceeds "
                              f"limit {max_voltage_drop_pct}% (this cable {voltage_drop_pct:.2f}%)")
            else:
                issues.append(f"Voltage drop {voltage_drop_pct:.2f}% exceeds limit {max_voltage_drop_pct}%")

        # ── Status ──
        current_known = (ov_current > 0) or (
            lf_converged and cable.id in branch_currents and load_current > 0)
        if not thermal_ok or not voltage_drop_ok or not fault_withstand_ok or overload_ok is False:
            status = "fail"
        elif not current_known or not ampacity_known:
            status = "unknown"
        elif thermal_loading_pct > 80 or (0.6 * max_voltage_drop_pct < drop_for_limit <= max_voltage_drop_pct):
            status = "warning"
        else:
            status = "pass"

        if not current_known:
            warning_reasons.insert(0,
                "Load current unknown (load flow unavailable, not converged, or zero "
                "current) — thermal and voltage-drop checks need a converged load flow")
        if not ampacity_known:
            warning_reasons.append(
                "Cable ampacity unknown (rated_amps not set or zero) — "
                "thermal check not performed")
        if thermal_loading_pct > 80 and thermal_ok:
            warning_reasons.append(f"Thermal loading at {thermal_loading_pct:.0f}% (>80% of derated capacity {derated_amps:.0f}A)")
        if 0.6 * max_voltage_drop_pct < drop_for_limit <= max_voltage_drop_pct:
            warning_reasons.append(f"Voltage drop at {drop_for_limit:.1f}% (approaching {max_voltage_drop_pct}% limit)")

        # ── Recommended cable ──
        min_size_mm2 = size_mm2
        recommended_cable = ""
        if status == "fail":
            s_req = s_req_max if far_needs_overload else min_size_for_fault
            found_size = _find_minimum_size(
                cp, load_current, num_parallel, length_km, system_kv, class_kv,
                cos_phi, sin_phi, max_voltage_drop_pct,
                s_req, temp_df, conductor_df, ampacity_standard,
                ambient_temp_c,
                other_drop_pct=((cumulative_pct - voltage_drop_pct)
                                if cumulative_pct is not None else 0.0),
                overload=(ol if overload_ok is not None else None),
                load_ib=load_current,
            )
            if found_size is None:
                min_size_mm2 = 0
                recommended_cable = ("No standard cable size satisfies all checks — "
                                     "consider parallel cables, a shorter route, a "
                                     "higher voltage level, or faster fault clearing")
            else:
                min_size_mm2 = found_size
                rec = _find_recommended_cable(cp["conductor"], cp["insulation"], class_kv,
                                              min_size_mm2, overhead=cp["overhead"])
                if rec:
                    recommended_cable = (rec["name"] if cp["overhead"] else
                                         f"{rec['size_mm2']:.0f}mm² {rec['conductor']} "
                                         f"{rec['insulation']} {class_kv:g}kV")
                    min_size_mm2 = rec["size_mm2"]
                else:
                    recommended_cable = f"{min_size_mm2:.0f}mm² (no standard cable found)"

        results.append({
            "cable_id": cable.id,
            "cable_name": cable_name,
            "from_bus": from_bus_name,
            "to_bus": to_bus_name,
            "from_bus_id": from_bus,
            "to_bus_id": to_bus,
            "load_current_a": round(load_current, 2),
            "thermal_ok": thermal_ok,
            "thermal_loading_pct": round(thermal_loading_pct, 1),
            "voltage_drop_pct": round(voltage_drop_pct, 2),
            "cumulative_voltage_drop_pct": (round(cumulative_pct, 2)
                                            if cumulative_pct is not None else None),
            "voltage_drop_origin": origin_name,
            "voltage_drop_ok": voltage_drop_ok,
            "system_kv": system_kv,
            "overload_protection_ok": overload_ok,
            "overload_protection_note": overload_note,
            "fault_withstand_ok": fault_withstand_ok,
            "clearing_time_s": (round(t_clear, 4) if math.isfinite(t_clear) else None),
            "min_size_mm2": (round(min_size_mm2, 1) if math.isfinite(min_size_mm2) else 0),
            "recommended_cable": recommended_cable,
            "status": status,
            "issues": issues,
            "warning_reasons": warning_reasons,
            "ampacity_standard": ampacity_standard,
            "nec_rating": _nec_ampacity_lookup(cp["size_mm2"], cp["conductor"], '75C'),
            "derated_ampacity_a": round(derated_amps, 1) if derated_amps else 0,
            # Per conductor set — Iz of the whole run is × num_parallel. The
            # protective device lets the breaker's trip-unit panel suggest an
            # Ir with Ib ≤ Ir ≤ Iz for the cable it protects.
            "num_parallel": num_parallel,
            "protective_device_id": device.id if device is not None else None,
            "ampacity_derated": bool(amp_derated_a and amp_derated_a > 0),
            "ampacity_conditions": amp_conditions,
        })

    return {"cables": results, "warnings": warnings}


def _find_minimum_size(cp, load_current, num_parallel, length_km, system_kv, class_kv,
                       cos_phi, sin_phi, max_vdrop_pct, s_req_fault, temp_df,
                       conductor_df, ampacity_standard, ambient_temp_c,
                       other_drop_pct=0.0, overload=None, load_ib=0.0):
    """Smallest standard size passing every check the cable failed.

    ``s_req_fault``: the area the fault-withstand check needs (already from
    the governing current, clearing time and √(m+n)); math.inf when the
    protection does not clear within 5 s — no size fixes that.
    ``other_drop_pct``: drop from the origin up to this cable ([CS4]).
    ``overload``: (In, I2/In, label) when §433.1 applies ([CS3]).
    Returns None when no standard size passes.
    """
    if not math.isfinite(s_req_fault):
        return None
    current_per_cable = load_current / max(num_parallel, 1)
    n = max(num_parallel, 1)

    def _drop_ok(r_km, x_km):
        if system_kv <= 0 or length_km <= 0:
            return True
        v_phase = system_kv * 1000 / math.sqrt(3)
        vdrop = load_current * length_km * (r_km / n * cos_phi + x_km / n * sin_phi)
        return other_drop_pct + vdrop / v_phase * 100 <= max_vdrop_pct

    def _overload_ok(derated):
        if overload is None:
            return True
        i_n, f_i2, _ = overload
        iz = derated * n
        return load_ib <= i_n and i_n <= iz and f_i2 * i_n <= 1.45 * iz

    if cp["overhead"]:
        from .conductor_temp import resistance_at, DEFAULT_OVERHEAD_TEMP_C
        for ov in sorted(STANDARD_OVERHEAD_LINES, key=lambda x: x["size_mm2"]):
            if ambient_temp_c >= OVERHEAD_MAX_TEMP_C:
                derated = 0.0
            elif ambient_temp_c != OVERHEAD_RATED_AMBIENT_C:
                derated = ov["rated_amps"] * math.sqrt(
                    (OVERHEAD_MAX_TEMP_C - ambient_temp_c)
                    / (OVERHEAD_MAX_TEMP_C - OVERHEAD_RATED_AMBIENT_C))
            else:
                derated = ov["rated_amps"]
            if current_per_cable > derated:
                continue
            if not _drop_ok(resistance_at(ov["r_per_km"], DEFAULT_OVERHEAD_TEMP_C, ov["material"]),
                            ov["x_per_km"]):
                continue
            if ov["size_mm2"] < s_req_fault:
                continue
            return ov["size_mm2"]
        return None

    conductor = cp["conductor"]
    insulation = cp["insulation"]
    standard_sizes = [1.5, 2.5, 4, 6, 10, 16, 25, 35, 50, 70, 95, 120, 150, 185, 240, 300, 400, 500, 630]
    for size in standard_sizes:
        match = None
        for sc in STANDARD_CABLES:
            if (sc["conductor"] == conductor and sc["insulation"] == insulation
                    and abs(sc["voltage_kv"] - class_kv) < 1.0 and sc["size_mm2"] == size):
                match = sc
                break
        if not match:
            continue
        if ampacity_standard == "NEC":
            nec_amps = _nec_ampacity(size, conductor, insulation)
            base_amps = nec_amps if nec_amps > 0 else match["rated_amps"]
            derated = base_amps * temp_df * conductor_df
        else:
            derated = match["rated_amps"] * temp_df
        if current_per_cable > derated or not _overload_ok(derated):
            continue
        # backend table: 20 °C DC resistance → operating temperature (H12)
        if not _drop_ok(match["r_per_km"] * _temp_correction(conductor, insulation),
                        match["x_per_km"]):
            continue
        # [N2] the size's own k (PVC > 300 mm²)
        k_here = _k_factor(conductor, insulation, size)
        k_cur = _k_factor(conductor, insulation, cp["size_mm2"])
        if size < s_req_fault * (k_cur / k_here):
            continue
        return size
    return None


def _find_recommended_cable(conductor, insulation, voltage_kv, min_size_mm2, overhead=False):
    """Find the smallest standard cable matching conductor/insulation/voltage that meets min size.

    [P4] `overhead=True` searches STANDARD_OVERHEAD_LINES instead — voltage
    isn't a selector there (an overhead codeword conductor isn't rated to a
    specific kV the way an insulated cable's voltage class is).
    """
    if overhead:
        candidates = [ov for ov in STANDARD_OVERHEAD_LINES if ov["size_mm2"] >= min_size_mm2]
        if not candidates:
            return None
        candidates.sort(key=lambda c: c["size_mm2"])
        best = candidates[0]
        return {"size_mm2": best["size_mm2"], "conductor": best["material"],
                "insulation": "BARE", "name": best["name"]}
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
