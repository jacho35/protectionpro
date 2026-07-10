"""Default load-class tables and correction factors for ADMD demand estimation.

Ported verbatim from Retic Builder Pro v2.0.5 (verified identical to the latest
cloud build v2.0.44). These are the *seed defaults* — a project may ship its own
editable ``loadClassLib`` which overrides these (see admd.py: resolve_classes).

Standards provenance:
  - LOAD_CLASSES        — CTEF100 Appendix A1 (CoCT-modified NRS 034-1 Table 3,
                          15-year load parameters). This is the active default set.
  - LOAD_CLASSES_NRS034 — NRS 034-1 Table 3a reference values (interior climate,
                          15-year).
  - LOAD_CLASSES_COMMERCIAL — non-residential VA/m^2 or fixed-kVA loads.
  - CORRECTION_METHODS  — ReticMaster / NRS 034-1 diversity (DCF) and phase-
                          unbalance (UCF) correction-factor formulae.

Each residential class carries the Herman-Beta parameters (a=alpha, b=beta, c
scaling) plus the derived per-consumer ADMD (kVA) and the Normal-approximation
mean (mu) and std-dev (sigma) currents in amps. ``phase`` is 1 (single-phase,
per consumer) or 3 (three-phase, parameters are per-phase).
"""

# CTEF100 Appendix A1 — CoCT Modified NRS 034-1 Table 3 (15-year). Active default.
LOAD_CLASSES = [
    {"id": "informal",      "label": "Informal Settlement",     "lsm": "3-4", "a": 0.87, "b": 4.61, "c": 40, "admd": 1.46, "mu": 6.33,  "sigma": 5.73,  "phase": 1},
    {"id": "township",      "label": "Township Area",           "lsm": "5-6", "a": 0.98, "b": 2.41, "c": 40, "admd": 2.66, "mu": 11.54, "sigma": 8.65,  "phase": 1},
    {"id": "urban1",        "label": "Urban Residential I",     "lsm": "7",   "a": 1.22, "b": 2.96, "c": 60, "admd": 4.04, "mu": 17.48, "sigma": 11.98, "phase": 1},
    {"id": "urban2",        "label": "Urban Residential II",    "lsm": "8-9", "a": 1.05, "b": 1.70, "c": 60, "admd": 5.31, "mu": 22.98, "sigma": 15.06, "phase": 1},
    {"id": "upmarket1",     "label": "Urban Upmarket I",        "lsm": "10",  "a": 0.94, "b": 1.25, "c": 60, "admd": 5.96, "mu": 25.80, "sigma": 16.64, "phase": 1},
    {"id": "upmarket1_3ph", "label": "Urban Upmarket I (3Φ)",  "lsm": "10",  "a": 0.54, "b": 3.25, "c": 60, "admd": 1.99, "mu": 8.60,  "sigma": 9.61,  "phase": 3},
    {"id": "upmarket2_3ph", "label": "Urban Upmarket II (3Φ)", "lsm": ">10", "a": 0.50, "b": 2.12, "c": 60, "admd": 2.65, "mu": 11.47, "sigma": 12.39, "phase": 3},
]

# NRS 034-1 Table 3a reference values (interior climate, 15-year).
LOAD_CLASSES_NRS034 = [
    {"id": "ruralSet",     "label": "Rural Settlement",          "lsm": "1",   "a": 0.35, "b": 2.88, "c": 20, "admd": 0.50, "mu": 2.17,  "sigma": 3.03,  "phase": 1},
    {"id": "ruralVil",     "label": "Rural Village",             "lsm": "1-2", "a": 0.48, "b": 2.13, "c": 20, "admd": 0.84, "mu": 3.65,  "sigma": 4.07,  "phase": 1},
    {"id": "informal_nrs", "label": "Informal Settlement",       "lsm": "3-4", "a": 0.91, "b": 8.80, "c": 60, "admd": 1.30, "mu": 5.65,  "sigma": 5.36,  "phase": 1},
    {"id": "township_nrs", "label": "Township Area",             "lsm": "5-6", "a": 1.22, "b": 5.86, "c": 60, "admd": 2.37, "mu": 10.30, "sigma": 7.96,  "phase": 1},
    {"id": "urban1_nrs",   "label": "Urban Residential I",       "lsm": "7",   "a": 1.25, "b": 3.55, "c": 60, "admd": 3.59, "mu": 15.61, "sigma": 10.93, "phase": 1},
    {"id": "urban2_nrs",   "label": "Urban Residential II",      "lsm": "7-8", "a": 1.42, "b": 4.10, "c": 80, "admd": 4.72, "mu": 20.52, "sigma": 13.68, "phase": 1},
    {"id": "urbanTwn_nrs", "label": "Urban Townhouse Complex",   "lsm": "8",   "a": 1.42, "b": 4.13, "c": 80, "admd": 4.70, "mu": 20.43, "sigma": 13.63, "phase": 1},
    {"id": "urbanEst_nrs", "label": "Urban Multi-Storey/Estate", "lsm": "8+",  "a": 1.37, "b": 3.39, "c": 80, "admd": 5.30, "mu": 23.04, "sigma": 15.09, "phase": 1},
]

# Non-residential loads: either VA/m^2 (area-based) or a fixed kVA.
LOAD_CLASSES_COMMERCIAL = [
    {"id": "commercial", "label": "Commercial",           "vaPerM2": 80,   "fixedKVA": None},
    {"id": "lightInd",   "label": "Light Industrial",     "vaPerM2": 40,   "fixedKVA": None},
    {"id": "industrial", "label": "Industrial",           "vaPerM2": 100,  "fixedKVA": None},
    {"id": "priSchool",  "label": "Primary School",       "vaPerM2": None, "fixedKVA": 70},
    {"id": "secSchool",  "label": "Secondary School",     "vaPerM2": None, "fixedKVA": 100},
    {"id": "church",     "label": "Church",               "vaPerM2": None, "fixedKVA": 25},
    {"id": "clinic",     "label": "Clinic / Crèche",     "vaPerM2": None, "fixedKVA": 25},
    {"id": "garage",     "label": "Garage / Service Stn", "vaPerM2": None, "fixedKVA": 70},
]

ESTIMATION_METHODS = ["Empirical", "Herman Beta"]

# Diversity Correction Factor DCF(N, admd) and Unbalance Correction Factor UCF(N).
# Only used with the Empirical method; Herman-Beta accounts for diversity/unbalance
# inherently. British DCF uses k=8 if ADMD<=5 else k=12.
CORRECTION_METHODS = {
    "AMEU":    {"dcf": lambda N, admd: 1 + 2 / N,
                "ucf": lambda N: 1 + 2.8 / (N ** 0.5)},
    "British": {"dcf": lambda N, admd: 1 + (8 if admd <= 5 else 12) / (admd * N),
                "ucf": lambda N: 1 + 4.14 / (N ** 0.5)},
    "None":    {"dcf": lambda N, admd: 1.0,
                "ucf": lambda N: 1.0},
}

# LV service voltages and default risk level.
V_1PH = 230.0            # single-phase service voltage (V)
V_3PH_LINE = 400.0       # three-phase line voltage (V)
DEFAULT_RISK_Z = 1.28    # 10% risk / 90% confidence (Herman-Beta)
DEFAULT_ADMD = 4.04      # fallback ADMD (kVA) — Urban Residential I
