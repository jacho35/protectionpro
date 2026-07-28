"""Standards-anchored tests for backend/analysis/pt_model.py — the PT
(potential/voltage transformer) burden-and-accuracy model, the voltage-side
analogue of ct_model.py, added for [PS-16 residual] "PT parameters are used
in no calculation".

Hand-calculation anchor (11000/110 PT, class 0.5, 30 VA rated burden,
15 VA connected burden):
  ratio = 100, class 0.5 -> ratio error +-0.5%, phase +-20'
  loading_pct = 15/30 * 100 = 50% -> within the IEC 61869-3 25-100% band

Run with:  python -m pytest backend/tests/test_pt_model.py -v
"""

import pytest

from backend.analysis.pt_model import (
    parse_pt_ratio,
    parse_pt_accuracy_limits,
    pt_burden_adequacy,
)


class TestParsers:
    def test_parse_pt_ratio_valid(self):
        r = parse_pt_ratio("11000/110")
        assert r == {"primary": 11000.0, "secondary": 110.0, "ratio": 100.0}

    def test_parse_pt_ratio_defaults_on_bad_input(self):
        for bad in (None, "", "garbage", "11000", "0/110", "11000/0", "a/b"):
            assert parse_pt_ratio(bad) == {"primary": 11000.0, "secondary": 110.0, "ratio": 100.0}

    def test_parse_pt_accuracy_limits_measuring_classes(self):
        assert parse_pt_accuracy_limits("0.1") == {"class": "0.1", "ratio_error_pct": 0.1, "phase_error_min": 5.0}
        assert parse_pt_accuracy_limits("0.2") == {"class": "0.2", "ratio_error_pct": 0.2, "phase_error_min": 10.0}
        assert parse_pt_accuracy_limits("0.5") == {"class": "0.5", "ratio_error_pct": 0.5, "phase_error_min": 20.0}
        assert parse_pt_accuracy_limits("1.0") == {"class": "1.0", "ratio_error_pct": 1.0, "phase_error_min": 40.0}
        c3 = parse_pt_accuracy_limits("3.0")
        assert c3["ratio_error_pct"] == 3.0 and c3["phase_error_min"] is None

    def test_parse_pt_accuracy_limits_protective_classes(self):
        assert parse_pt_accuracy_limits("3P") == {"class": "3P", "ratio_error_pct": 3.0, "phase_error_min": 120.0}
        assert parse_pt_accuracy_limits("6P") == {"class": "6P", "ratio_error_pct": 6.0, "phase_error_min": 240.0}
        # case-insensitive
        assert parse_pt_accuracy_limits("3p")["ratio_error_pct"] == 3.0

    def test_parse_pt_accuracy_limits_defaults_on_bad_input(self):
        for bad in (None, "", "garbage", "9.9"):
            limits = parse_pt_accuracy_limits(bad)
            assert limits["ratio_error_pct"] == 0.5
            assert limits["phase_error_min"] == 20.0


class TestBurdenAdequacyHandCalc:
    """11000/110, class 0.5, 30 VA rated — see module docstring anchor."""

    BASE_PROPS = {"ratio": "11000/110", "accuracy_class": "0.5", "burden_va": 30}

    def test_absent_connected_burden_skips_check(self):
        assert pt_burden_adequacy(self.BASE_PROPS) is None

    def test_zero_connected_burden_skips_check(self):
        assert pt_burden_adequacy({**self.BASE_PROPS, "connected_burden_va": 0}) is None

    def test_within_band_50pct_loading(self):
        r = pt_burden_adequacy({**self.BASE_PROPS, "connected_burden_va": 15})
        assert r["ratio"] == pytest.approx(100.0)
        assert r["rated_burden_va"] == pytest.approx(30.0)
        assert r["connected_burden_va"] == pytest.approx(15.0)
        assert r["loading_pct"] == pytest.approx(50.0)
        assert r["qualified_min_va"] == pytest.approx(7.5)
        assert r["qualified_max_va"] == pytest.approx(30.0)
        assert r["within_qualified_band"] is True
        assert r["accuracy_class"] == "0.5"
        assert r["ratio_error_pct"] == pytest.approx(0.5)
        assert r["phase_error_min"] == pytest.approx(20.0)

    def test_at_100pct_still_within_band(self):
        r = pt_burden_adequacy({**self.BASE_PROPS, "connected_burden_va": 30})
        assert r["loading_pct"] == pytest.approx(100.0)
        assert r["within_qualified_band"] is True

    def test_overburden_exceeds_100pct(self):
        r = pt_burden_adequacy({**self.BASE_PROPS, "connected_burden_va": 36})
        assert r["loading_pct"] == pytest.approx(120.0)
        assert r["within_qualified_band"] is False

    def test_underburden_below_25pct(self):
        r = pt_burden_adequacy({**self.BASE_PROPS, "connected_burden_va": 5})
        assert r["loading_pct"] == pytest.approx(5.0 / 30.0 * 100.0)
        assert r["within_qualified_band"] is False

    def test_at_exactly_25pct_is_within_band(self):
        r = pt_burden_adequacy({**self.BASE_PROPS, "connected_burden_va": 7.5})
        assert r["within_qualified_band"] is True

    def test_missing_rated_burden_falls_back_to_default(self):
        props = {"ratio": "11000/110", "accuracy_class": "0.5", "connected_burden_va": 15}
        r = pt_burden_adequacy(props)
        assert r["rated_burden_va"] == pytest.approx(30.0)  # default
        assert r["loading_pct"] == pytest.approx(50.0)
