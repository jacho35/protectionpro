"""Aluminium PVC LV cables exist in both cable lists and agree with each other."""

import math
import re
from pathlib import Path

import pytest

from backend.analysis.cable_sizing import STANDARD_CABLES
from backend.analysis.conductor_temp import insulated_conductor_and_insulation, insulated_hot_factor

SIZES = [16, 25, 35, 50, 70, 95, 120, 150, 185, 240, 300]
IEC_60228_CU = {1.5: 12.1, 2.5: 7.41, 4: 4.61, 6: 3.08, 10: 1.83, 16: 1.15, 25: .727, 35: .524, 50: .387,
                70: .268, 95: .193, 120: .153, 150: .124, 185: .0991, 240: .0754, 300: .0601}
# IEC 60502-1:2009 Table A.1 (fictitious conductor diameter, mm) and Table 5 (PVC/A insulation, 0.6/1 kV, mm)
DL = {1.5: 1.4, 2.5: 1.8, 4: 2.3, 6: 2.8, 10: 3.6, 16: 4.5, 25: 5.6, 35: 6.7, 50: 8.0, 70: 9.4,
      95: 11.0, 120: 12.4, 150: 13.8, 185: 15.3, 240: 17.5, 300: 19.5}
T_INS = {1.5: .8, 2.5: .8, 4: 1.0, 6: 1.0, 10: 1.0, 16: 1.0, 25: 1.2, 35: 1.2, 50: 1.4, 70: 1.4,
         95: 1.6, 120: 1.6, 150: 1.8, 185: 2.0, 240: 2.2, 300: 2.4}


def iec_r70(r20, al, size, cores):
    """a.c. resistance at 70 °C, Ω/km: IEC 60228 Annex B temperature factor x IEC 60287-1-1 cl. 2.1.2-2.1.4
    skin (ys) and proximity (yp) effects, ks = kp = 1 (stranded/sector, not impregnated), 50 Hz."""
    k = 1 + (0.00403 if al else 0.00393) * 50
    x4 = (8 * math.pi * 50 / (r20 * k / 1000) * 1e-7) ** 2
    F = x4 / (192 + 0.8 * x4)
    r = DL[size] / (DL[size] + T_INS[size])
    yp = F * r * r * 2.9 if cores == 2 else (2 / 3) * F * r * r * (0.312 * r * r + 1.18 / (F + 0.27))
    return r20 * k * (1 + F + yp)


IEC_60228_AL = dict(zip(SIZES, [1.91, 1.20, 0.868, 0.641, 0.443, 0.320, 0.253, 0.206, 0.164, 0.125, 0.100]))
# SANS 10142-1:2026 Table D.1 (a.c. resistance at 70 °C, Ω/km)
SANS_AL_R = dict(zip(SIZES, [2.3, 1.44, 1.03, 0.72, 0.52, 0.38, 0.30, 0.24, 0.20, 0.156, 0.127]))
SANS_CU_R = {1.5: 14.48, 2.5: 8.87, 4: 5.52, 6: 3.69, 10: 2.19, 16: 1.4, 25: 0.88, 35: 0.63, 50: 0.44,
             70: 0.31, 95: 0.23, 120: 0.18, 150: 0.15, 185: 0.12, 240: 0.095, 300: 0.077}
# SANS 10142-1:2026 Table 6.4(a) col. 3 (Cu) - multicore PVC armoured, clipped direct
SANS_CU_AMPS = {1.5: 18, 2.5: 25, 4: 33, 6: 42, 10: 58, 16: 77, 25: 102, 35: 125, 50: 151, 70: 192,
                95: 231, 120: 267, 150: 306, 185: 348, 240: 409, 300: 469}
CONSTANTS = (Path(__file__).resolve().parents[2] / "frontend/js/constants.js").read_text()


def _frontend(cid):
    m = re.search(r"\{ id: '%s',.*?\},?\n" % re.escape(cid), CONSTANTS)
    assert m, f"{cid} missing from frontend/js/constants.js"
    row = m.group(0)
    num = lambda k: float(re.search(r"%s: ([\d.]+)" % k, row).group(1))
    return {k: num(k) for k in ("r_per_km", "x_per_km", "r0_per_km", "x0_per_km", "rated_amps")}


@pytest.mark.parametrize("size", SIZES)
def test_backend_entry_matches_frontend(size):
    cid = f"al_pvc_{size}_lv"
    be = next(c for c in STANDARD_CABLES if c["id"] == cid)
    fe = _frontend(cid)
    assert (be["conductor"], be["insulation"]) == ("Al", "PVC")
    assert be["rated_amps"] == fe["rated_amps"]
    assert be["x_per_km"] == pytest.approx(fe["x_per_km"])
    # backend stores the IEC 60228 20 °C DC value, the frontend the calculated 70 °C a.c. value
    assert be["r_per_km"] == pytest.approx(IEC_60228_AL[size], rel=1e-3)
    assert fe["r_per_km"] == pytest.approx(iec_r70(IEC_60228_AL[size], True, size, 4), rel=1e-3)
    assert fe["r0_per_km"] == pytest.approx(fe["r_per_km"] * 3.8, rel=2e-3)


@pytest.mark.parametrize("cid", [f"al_pvc_{s}_lv" for s in SIZES] + ["al_pvc_16_lv_2c"])
def test_engines_read_it_as_aluminium_pvc(cid):
    props = {"standard_type": cid}
    assert insulated_conductor_and_insulation(props) == ("Al", "PVC")
    assert insulated_hot_factor(props) == 1.2


def test_two_core_services_follow_sans_table_6_8():
    # 25/35 mm²: Table 6.8 two-core buried; 16 mm² is not in 6.8 for Al -> Table 6.7(a) col. 2
    for s, amps in ((16, 68), (25, 106), (35, 128)):
        row = re.search(r"\{ id: 'al_pvc_%d_lv_2c'.*?\},?\n" % s, CONSTANTS).group(0)
        assert "cores: 2" in row and "construction: 'armoured'" in row
        assert float(re.search(r"rated_amps: (\d+)", row).group(1)) == amps


# SANS 10142-1:2026 Table D.1 reactance (same for Cu and Al) and Table 6.7(a) col. 3 ratings
SANS_X = {1.5: .100, 2.5: .095, 4: .093, 6: .090, 10: .084, 16: .080, 25: .079, 35: .076,
          50: .076, 70: .074, 95: .073, 120: .072, 150: .072, 185: .072, 240: .072, 300: .071}
SANS_AL_AMPS = dict(zip(SIZES, [58, 76, 94, 113, 143, 174, 202, 232, 265, 312, 360]))


@pytest.mark.parametrize("size", list(SANS_X))
def test_pvc_reactance_is_sans_table_d1(size):
    sz = ("%g" % size)
    for prefix in ("cu", "al"):
        if prefix == "al" and size < 16:
            continue
        cid = f"{prefix}_pvc_{sz}_lv"
        assert _frontend(cid)["x_per_km"] == pytest.approx(SANS_X[size]), cid
        be = next(c for c in STANDARD_CABLES if c["id"] == cid)
        assert be["x_per_km"] == pytest.approx(SANS_X[size]), cid
        assert _frontend(cid)["x0_per_km"] == pytest.approx(3.2 * SANS_X[size], rel=2e-3), cid


@pytest.mark.parametrize("size", SIZES)
def test_al_pvc_rating_is_sans_table_6_7a(size):
    assert _frontend(f"al_pvc_{size}_lv")["rated_amps"] == SANS_AL_AMPS[size]


@pytest.mark.parametrize("size", list(SANS_CU_R))
def test_cu_pvc_resistance_and_rating_are_sans(size):
    cid = "cu_pvc_%s_lv" % ("%g" % size)
    fe = _frontend(cid)
    assert fe["r_per_km"] == pytest.approx(iec_r70(IEC_60228_CU[size], False, size, 4), rel=1e-3)
    # the calculation stays close to SANS Table D.1 (which differs most at 50 mm²)
    assert fe["r_per_km"] == pytest.approx(SANS_CU_R[size], rel=0.06)
    assert fe["rated_amps"] == SANS_CU_AMPS[size]
    be = next(c for c in STANDARD_CABLES if c["id"] == cid)
    assert be["rated_amps"] == SANS_CU_AMPS[size]


@pytest.mark.parametrize("size", [4, 6, 10])
def test_cu_pvc_two_core_follow_sans(size):
    fe = _frontend("cu_pvc_%d_lv_2c" % size)
    assert fe["r_per_km"] == pytest.approx(iec_r70(IEC_60228_CU[size], False, size, 2), rel=1e-3)
    assert fe["rated_amps"] == {4: 50, 6: 62, 10: 83}[size]          # Table 6.8 two-core buried


@pytest.mark.parametrize("size", [16, 25, 35])
def test_al_pvc_two_core_resistance_is_iec_calculation(size):
    fe = _frontend(f"al_pvc_{size}_lv_2c")
    assert fe["r_per_km"] == pytest.approx(iec_r70(IEC_60228_AL[size], True, size, 2), rel=1e-3)
    assert fe["r0_per_km"] == pytest.approx(fe["r_per_km"] * 3.8, rel=2e-3)


# ── Building wiring (T+E, Surfix, H07V-R): SANS 10142-1:2026 Tables 6.2(a) / 6.3(a), Table D.1 ──
BW_AMPS = {
    "h07vr_cu": {1.5: 17.5, 2.5: 24, 4: 32, 6: 41, 10: 57, 16: 76, 25: 101, 35: 125, 50: 151, 70: 192, 95: 232},  # 6.2(a) col. 3
    "te_cu": {1.5: 16.5, 2.5: 23, 4: 30, 6: 38, 10: 52, 16: 69},                                                   # 6.3(a) col. 4
    "surfix_2c": {1.5: 19.5, 2.5: 27, 4: 36, 6: 46},                                                                # 6.3(a) col. 6
    "surfix_3c": {1.5: 17.5, 2.5: 24, 4: 32},                                                                       # 6.3(a) col. 7
}


def _bw_r70(r20):
    """IEC 60228 R20 x Annex B factor x IEC 60287-1-1 skin effect (proximity <0.1 % at these sizes, neglected)."""
    k = 1 + 0.00393 * 50
    x4 = (8 * math.pi * 50 / (r20 * k / 1000) * 1e-7) ** 2
    return r20 * k * (1 + x4 / (192 + 0.8 * x4))


def _bw_cases():
    return [(pre, size, amps) for pre, tbl in BW_AMPS.items() for size, amps in tbl.items()]


@pytest.mark.parametrize("pre,size,amps", _bw_cases())
def test_building_wiring_values_trace_to_standards(pre, size, amps):
    cid = f"{pre}_{'%g' % size}"
    fe = _frontend(cid)
    assert fe["rated_amps"] == amps
    assert fe["r_per_km"] == pytest.approx(_bw_r70(IEC_60228_CU[size]), rel=1e-3)
    assert fe["x_per_km"] == pytest.approx(SANS_X[size])
    assert fe["r0_per_km"] == 0 and fe["x0_per_km"] == 0     # not tabulated
