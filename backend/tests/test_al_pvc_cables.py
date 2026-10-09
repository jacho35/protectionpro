"""Aluminium PVC LV cables exist in both cable lists and agree with each other."""

import re
from pathlib import Path

import pytest

from backend.analysis.cable_sizing import STANDARD_CABLES
from backend.analysis.conductor_temp import insulated_conductor_and_insulation, insulated_hot_factor

SIZES = [16, 25, 35, 50, 70, 95, 120, 150, 185, 240, 300]
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
    # frontend stores the 70 °C value (R20 × 1.20), the backend the 20 °C one
    assert fe["r_per_km"] == pytest.approx(be["r_per_km"] * 1.20, rel=2e-3)
    assert fe["r0_per_km"] == pytest.approx(fe["r_per_km"] * 3.8, rel=2e-3)


@pytest.mark.parametrize("cid", [f"al_pvc_{s}_lv" for s in SIZES] + ["al_pvc_16_lv_2c"])
def test_engines_read_it_as_aluminium_pvc(cid):
    props = {"standard_type": cid}
    assert insulated_conductor_and_insulation(props) == ("Al", "PVC")
    assert insulated_hot_factor(props) == 1.2


def test_two_core_services_exist():
    for s in (16, 25, 35):
        row = re.search(r"\{ id: 'al_pvc_%d_lv_2c'.*?\},?\n" % s, CONSTANTS).group(0)
        assert "cores: 2" in row and "construction: 'armoured'" in row
        assert _frontend(f"al_pvc_{s}_lv")["rated_amps"] == float(re.search(r"rated_amps: (\d+)", row).group(1))
