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
