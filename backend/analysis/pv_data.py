"""Default PV module and inverter library (generic reference parts, not named products).

Read by the solar engine and served to the UI by GET /api/analysis/solar-library.
Users edit their own copies in the frontend library (saved like the cable library);
these are the "Reset to defaults" values.
"""

PV_MODULES = [
    # Mirrors PV_PANELS in frontend/js/constants.js (the app's single module list; tests keep them in step).
    # pmax W, STC electrical, temperature coefficients in %/degC, size in m, NOCT degC
    {"id": "pv_330_poly", "name": "330 W Poly 72-cell", "pmax_w": 330, "voc_v": 45.9, "vmp_v": 37.8,
     "isc_a": 9.15, "imp_a": 8.73, "k_voc_pct": -0.29, "k_vmp_pct": -0.37, "k_pmax_pct": -0.40,
     "length_m": 1.96, "width_m": 0.99, "noct_c": 45, "max_system_v": 1000},
    {"id": "pv_450_mono", "name": "450 W Mono PERC", "pmax_w": 450, "voc_v": 41.5, "vmp_v": 34.5,
     "isc_a": 13.9, "imp_a": 13.05, "k_voc_pct": -0.27, "k_vmp_pct": -0.35, "k_pmax_pct": -0.35,
     "length_m": 1.91, "width_m": 1.13, "noct_c": 44, "max_system_v": 1500},
    {"id": "pv_550_mono", "name": "550 W Mono PERC", "pmax_w": 550, "voc_v": 49.9, "vmp_v": 41.95,
     "isc_a": 14.0, "imp_a": 13.12, "k_voc_pct": -0.26, "k_vmp_pct": -0.34, "k_pmax_pct": -0.35,
     "length_m": 2.28, "width_m": 1.13, "noct_c": 44, "max_system_v": 1500},
    {"id": "pv_600_ntype", "name": "600 W N-type Bifacial", "pmax_w": 600, "voc_v": 45.6, "vmp_v": 38.0,
     "isc_a": 16.7, "imp_a": 15.8, "k_voc_pct": -0.25, "k_vmp_pct": -0.30, "k_pmax_pct": -0.30,
     "length_m": 2.38, "width_m": 1.30, "noct_c": 43, "max_system_v": 1500},
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
