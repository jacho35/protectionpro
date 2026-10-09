"""Aluminium PVC LV cables exist in both cable lists and agree with each other."""

import re
from pathlib import Path

import pytest

from backend.analysis.cable_sizing import STANDARD_CABLES
from backend.analysis.conductor_temp import insulated_conductor_and_insulation, insulated_hot_factor

SIZES = [16, 25, 35, 50, 70, 95, 120, 150, 185, 240, 300]
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
    # backend stores the IEC 60228 20 °C DC value, the frontend the SANS Table D.1 70 °C value
    assert be["r_per_km"] == pytest.approx(IEC_60228_AL[size], rel=1e-3)
    assert fe["r_per_km"] == pytest.approx(SANS_AL_R[size])
    assert fe["r_per_km"] == pytest.approx(IEC_60228_AL[size] * 1.20, rel=0.07)  # sanity: same conductor
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
    assert fe["r_per_km"] == pytest.approx(SANS_CU_R[size])
    assert fe["rated_amps"] == SANS_CU_AMPS[size]
    be = next(c for c in STANDARD_CABLES if c["id"] == cid)
    assert be["rated_amps"] == SANS_CU_AMPS[size]


@pytest.mark.parametrize("size", [4, 6, 10])
def test_cu_pvc_two_core_follow_sans(size):
    fe = _frontend("cu_pvc_%d_lv_2c" % size)
    assert fe["r_per_km"] == pytest.approx(SANS_CU_R[size])          # Table D.1
    assert fe["rated_amps"] == {4: 50, 6: 62, 10: 83}[size]          # Table 6.8 two-core buried
