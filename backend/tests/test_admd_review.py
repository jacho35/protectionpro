"""ADMD engine invariants (reviews/ADMD_REVIEW.md). These are properties of the
Herman-Beta / empirical formulae themselves, independent of the class tables,
which need NRS 034-1 / CTEF100 to confirm (see STANDARDS_NEEDED.md)."""
import math
import pytest

from backend.analysis.admd import (
    beta_params, herman_beta_demand, empirical_demand, kiosk_demand,
    feeder_demand)
from backend.analysis.admd_data import LOAD_CLASSES, LOAD_CLASSES_NRS034

URBAN1 = next(c for c in LOAD_CLASSES if c["id"] == "urban1")


@pytest.mark.parametrize("cls", LOAD_CLASSES + LOAD_CLASSES_NRS034,
                         ids=lambda c: c["id"])
def test_tabulated_mu_sigma_admd_follow_from_abc(cls):
    """Beta(a,b)*c moments reproduce the tabulated mu / sigma (to the
    rounding of a, b) and the tabulated ADMD ~ mu*230 V."""
    bp = beta_params(cls)
    assert bp["mean"] == pytest.approx(cls["mu"], rel=0.01)
    assert bp["sigma"] == pytest.approx(cls["sigma"], rel=0.01)
    assert cls["mu"] * 0.23 == pytest.approx(cls["admd"], rel=0.01)


def test_herman_beta_closed_form():
    """D(N) = N mu + z sigma sqrt(N) + (z^2-1)/6 * skew * sigma  (first-order
    Cornish-Fisher; the skew term is N-independent)."""
    bp = beta_params(URBAN1)
    z = 1.28
    for n in (1, 7, 40, 500):
        d = (n * bp["mean"] + z * bp["sigma"] * math.sqrt(n)
             + (z * z - 1) / 6 * bp["skewness"] * bp["sigma"])
        assert herman_beta_demand(n, URBAN1)["currentA"] == pytest.approx(d, abs=0.01)


def test_diversity_limits():
    """Per-customer demand falls with N toward mu*230 V (Herman) / ADMD
    (empirical); the group never exceeds the sum of its parts."""
    per = lambda n: herman_beta_demand(n, URBAN1)["totalKVA"] / n
    assert per(1) > per(10) > per(100) > per(10000) > 0
    assert per(10000) == pytest.approx(URBAN1["mu"] * 0.23, rel=0.02)
    e = lambda n: empirical_demand(n, 4.04, "AMEU")["totalKVA"] / n
    assert e(100000) == pytest.approx(4.04, rel=1e-3)
    for n1, n2 in ((10, 10), (1, 99), (50, 50)):
        assert (herman_beta_demand(n1 + n2, URBAN1)["totalKVA"]
                <= herman_beta_demand(n1, URBAN1)["totalKVA"]
                + herman_beta_demand(n2, URBAN1)["totalKVA"] + 0.01)


def test_empirical_ameu_hand():
    """N x ADMD x (1 + 2/N): 20 x 4.04 x 1.1 = 88.88 kVA."""
    assert empirical_demand(20, 4.04, "AMEU")["totalKVA"] == pytest.approx(
        20 * 4.04 * 1.1, abs=0.01)


def test_single_kiosk_feeder_equals_kiosk():
    erfs = [{"length": 1, "phase": p} for p in
            ["Red"] * 6 + ["White"] * 5 + ["Blue"] * 4 + ["3 Phase"] * 2]
    kiosk = {"id": "k1", "erfs": erfs}
    for est in ("Herman Beta", "Empirical"):
        s = {"estimationMethod": est, "loadClass": "urban1"}
        assert (feeder_demand([kiosk], s)["totalKVA"]
                == pytest.approx(kiosk_demand(kiosk, s)["totalKVA"], abs=0.02))


def _rmb_project():
    """R5421-style: 82 consumers, 15 kiosks, feeder F1 = 19 consumers 7/6/6."""
    cols = ["Red", "White", "Blue"]

    def erfs(n, start):
        return [{"phase": cols[(start + i) % 3], "length": 10} for i in range(n)]

    def chain(prefix, sizes, start):
        out, i = [], start
        for j, n in enumerate(sizes):
            out.append({"id": f"{prefix}{j}", "name": f"{prefix}{j}",
                        "fedFrom": "ms" if j == 0 else f"{prefix}{j-1}",
                        "erfs": erfs(n, i)})
            i += n
        return out

    return (chain("A", [3, 3, 6, 7], 0) + chain("B", [6, 6, 6], 19)
            + chain("C", [6, 6], 37) + chain("D", [6, 6, 6], 49)
            + chain("E", [5, 5, 5], 67))


def test_feeder_current_is_worst_phase_and_trfr_confidence():
    """ReticMaster R5421 (LV 90 % / TRFR 50 %): feeders sized on the worst
    phase (F1 163.9 A, F2 143.5 A); the transformer total is at z = 0
    (332.9 kVA, 486.7 A)."""
    from backend.analysis.admd import run_admd
    ks = _rmb_project()
    base = {"estimationMethod": "Herman Beta", "correctionMethod": "AMEU",
            "riskZ": 1.28, "loadClass": "urban1"}
    legacy = run_admd({"settings": base, "kiosks": ks,
                       "minisubs": [{"id": "ms", "name": "M"}]})
    rm = run_admd({"settings": {**base, "trfrConfidence": 50}, "kiosks": ks,
                   "minisubs": [{"id": "ms", "name": "M"}]})
    fa = {k["name"]: k["feederA"] for k in rm["kiosks"]}
    assert fa["A0"] == pytest.approx(163.9, abs=0.5)
    assert fa["B0"] == pytest.approx(143.5, abs=0.5)
    # Feeder currents don't depend on the transformer confidence.
    assert fa == {k["name"]: k["feederA"] for k in legacy["kiosks"]}
    assert rm["total"]["totalKVA"] == pytest.approx(332.9, rel=0.02)
    assert rm["total"]["currentA"] == pytest.approx(486.7, rel=0.02)
    assert rm["total"]["totalKVA"] < legacy["total"]["totalKVA"]
    assert rm["total"]["conns"] == 82 and rm["total"]["numKiosks"] == 15


def test_herman_beta_ignores_correction_method():
    from backend.analysis.admd import run_admd
    ks = _rmb_project()
    out = [run_admd({"settings": {"estimationMethod": "Herman Beta",
                                  "correctionMethod": c, "loadClass": "urban1"},
                     "kiosks": ks, "minisubs": []})["total"]["totalKVA"]
           for c in ("AMEU", "British", "None")]
    assert out[0] == out[1] == out[2]
