"""Default PV module and inverter library (generic reference parts, not named products).

Read by the solar engine and served to the UI by GET /api/analysis/solar-library.
Users edit their own copies in the frontend library (saved like the cable library);
these are the "Reset to defaults" values.
"""

PV_MODULES = [
    # pmax W, STC electrical, temperature coefficients in %/degC, size in m, NOCT degC
    {"id": "pv_550_mono_144", "name": "550 W mono 144-cell", "pmax_w": 550, "voc_v": 49.5, "vmp_v": 41.5,
     "isc_a": 13.9, "imp_a": 13.25, "k_voc_pct": -0.27, "k_vmp_pct": -0.34, "k_pmax_pct": -0.35,
     "length_m": 2.28, "width_m": 1.13, "noct_c": 44, "max_system_v": 1500},
    {"id": "pv_445_mono_108", "name": "445 W mono 108-cell", "pmax_w": 445, "voc_v": 37.9, "vmp_v": 31.8,
     "isc_a": 14.0, "imp_a": 14.0, "k_voc_pct": -0.27, "k_vmp_pct": -0.34, "k_pmax_pct": -0.35,
     "length_m": 1.90, "width_m": 1.10, "noct_c": 44, "max_system_v": 1500},
    {"id": "pv_400_mono_108", "name": "400 W mono 108-cell", "pmax_w": 400, "voc_v": 37.2, "vmp_v": 31.0,
     "isc_a": 13.5, "imp_a": 12.9, "k_voc_pct": -0.28, "k_vmp_pct": -0.35, "k_pmax_pct": -0.36,
     "length_m": 1.77, "width_m": 1.10, "noct_c": 44, "max_system_v": 1500},
    {"id": "pv_600_mono_156", "name": "600 W mono 156-cell", "pmax_w": 600, "voc_v": 52.9, "vmp_v": 44.0,
     "isc_a": 14.3, "imp_a": 13.6, "k_voc_pct": -0.25, "k_vmp_pct": -0.32, "k_pmax_pct": -0.34,
     "length_m": 2.38, "width_m": 1.30, "noct_c": 44, "max_system_v": 1500},
    {"id": "pv_330_poly_120", "name": "330 W poly 120-cell", "pmax_w": 330, "voc_v": 40.6, "vmp_v": 33.8,
     "isc_a": 10.2, "imp_a": 9.8, "k_voc_pct": -0.31, "k_vmp_pct": -0.41, "k_pmax_pct": -0.40,
     "length_m": 1.96, "width_m": 0.99, "noct_c": 45, "max_system_v": 1000},
]

PV_INVERTERS = [
    # ac_kw, DC window, per-MPPT current limits, fault contribution as a multiple of rated AC current
    {"id": "inv_10k_2mppt", "name": "10 kW, 2 MPPT, 1000 V", "ac_kw": 10, "phases": 3, "max_dc_v": 1000,
     "mppt_min_v": 200, "mppt_max_v": 800, "mppt_count": 2, "max_a_per_mppt": 30, "max_isc_a_per_mppt": 38,
     "efficiency_pct": 98.0, "fault_x_rated": 1.1},
    {"id": "inv_8k_2mppt", "name": "8 kW, 2 MPPT, 1000 V", "ac_kw": 8, "phases": 3, "max_dc_v": 1000,
     "mppt_min_v": 200, "mppt_max_v": 800, "mppt_count": 2, "max_a_per_mppt": 30, "max_isc_a_per_mppt": 38,
     "efficiency_pct": 97.8, "fault_x_rated": 1.1},
    {"id": "inv_5k_1mppt", "name": "5 kW, 1 MPPT, 600 V", "ac_kw": 5, "phases": 1, "max_dc_v": 600,
     "mppt_min_v": 120, "mppt_max_v": 500, "mppt_count": 1, "max_a_per_mppt": 25, "max_isc_a_per_mppt": 32,
     "efficiency_pct": 97.5, "fault_x_rated": 1.1},
    {"id": "inv_50k_6mppt", "name": "50 kW, 6 MPPT, 1100 V", "ac_kw": 50, "phases": 3, "max_dc_v": 1100,
     "mppt_min_v": 200, "mppt_max_v": 950, "mppt_count": 6, "max_a_per_mppt": 40, "max_isc_a_per_mppt": 50,
     "efficiency_pct": 98.5, "fault_x_rated": 1.1},
    {"id": "inv_100k_10mppt", "name": "100 kW, 10 MPPT, 1100 V", "ac_kw": 100, "phases": 3, "max_dc_v": 1100,
     "mppt_min_v": 200, "mppt_max_v": 950, "mppt_count": 10, "max_a_per_mppt": 40, "max_isc_a_per_mppt": 50,
     "efficiency_pct": 98.6, "fault_x_rated": 1.1},
]

# Loss stack applied to the DC energy (fractions). Temperature loss is computed per month, not listed here.
DEFAULT_LOSSES = {
    "soiling": 0.03,
    "mismatch": 0.02,
    "dc_wiring": 0.015,
    "inverter": 0.02,       # 1 - efficiency, overridden by the inverter's efficiency when one is given
    "ac_wiring": 0.005,
    "availability": 0.01,
}
