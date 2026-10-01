"""Standards-anchored tests for backend/analysis/ct_model.py — the CT
saturation model ported from frontend/js/constants.js (ctSaturationParams/
ctEffectiveCurrent) so the backend relay/TCC clearing-time evaluation sees
the same saturation-clipped current the frontend TCC chart plots.

Hand-calculation anchor (400/5 CT, 5P10, default 15 VA burden, no explicit
knee/Rct override):
  ratio = 80, ALF = 10, i_sec_rated = 5
  rct_ohm default = 0.3 (5A core), burden_ohm = 15/5^2 = 0.6
  V_sat = E_AL = 10 x 5 x (0.3+0.6) = 45 V, total_z = 0.9
  I_sat_secondary = 45/0.9 = 50 A -> I_sat_primary = 50 x 80 = 4000 A
  (= ALF x I_pn, the IEC 61869-2 class definition on rated burden).

[CT review L1] Re-baselined from 0.8 x E_AL = 36 V / 3200 A: clipping from
0.8 E_AL put a 7.4 % error at ALF x I_n where a 5P core guarantees <= 5 %.
[C1] The clipped current is the fundamental (what a numerical relay
measures), no longer the true RMS. [C3] kappa no longer derates the knee
(dc offset is simulated in the time domain) — see reviews/CT_MODEL_REVIEW.md.

Run with:  python -m pytest backend/tests/test_ct_model.py -v
"""

import math

import pytest

from backend.analysis.ct_model import (
    parse_ct_ratio,
    parse_ct_accuracy_alf,
    ct_saturation_params,
    ct_effective_current,
)


class TestParsers:
    def test_parse_ct_ratio_valid(self):
        r = parse_ct_ratio("400/5")
        assert r == {"primary": 400.0, "secondary": 5.0, "ratio": 80.0}

    def test_parse_ct_ratio_defaults_on_bad_input(self):
        for bad in (None, "", "garbage", "400", "0/5", "400/0", "a/b"):
            assert parse_ct_ratio(bad) == {"primary": 400.0, "secondary": 5.0, "ratio": 80.0}

    def test_parse_ct_accuracy_alf_valid(self):
        assert parse_ct_accuracy_alf("5P20") == 20.0
        assert parse_ct_accuracy_alf("10P10") == 10.0
        assert parse_ct_accuracy_alf("5p30") == 30.0  # case-insensitive

    def test_parse_ct_accuracy_alf_defaults_on_bad_input(self):
        for bad in (None, "", "5PX", "PX20"):
            assert parse_ct_accuracy_alf(bad) == 20.0
        # [C4] "0.5" is a measuring class: its limit factor is FS (5 assumed)
        assert parse_ct_accuracy_alf("0.5") == 5.0


class TestSaturationParamsHandCalc:
    """400/5, 5P10, default 15 VA burden — see module docstring anchor."""

    CT_PROPS = {"ratio": "400/5", "accuracy_class": "5P10"}

    def test_symmetric_no_kappa(self):
        sat = ct_saturation_params(self.CT_PROPS)
        assert sat["ratio"] == pytest.approx(80.0)
        assert sat["alf"] == pytest.approx(10.0)
        assert sat["rct_ohm"] == pytest.approx(0.3)
        assert sat["burden_ohm"] == pytest.approx(0.6)
        assert sat["knee_point_v"] == pytest.approx(45.0)
        assert sat["total_z"] == pytest.approx(0.9)
        assert sat["i_sat_primary"] == pytest.approx(4000.0, rel=1e-6)
        assert sat["i_sat_primary_symmetric"] == pytest.approx(4000.0, rel=1e-6)
        assert sat["dc_offset_factor"] == pytest.approx(1.0)

    def test_kappa_does_not_derate_threshold(self):
        """[C3] kappa is accepted for compatibility but no longer divides the
        knee — the dc offset's flux demand is 1 + X/R, not kappa."""
        for kappa in (None, 1.02, 1.8):
            sat = ct_saturation_params(self.CT_PROPS, kappa=kappa)
            assert sat["dc_offset_factor"] == pytest.approx(1.0)
            assert sat["i_sat_primary"] == pytest.approx(4000.0, rel=1e-6)

    def test_burden_and_rct_overrides(self):
        sat = ct_saturation_params({**self.CT_PROPS, "burden_va": 30,
                                     "rct_ohm": 1.0})
        assert sat["burden_ohm"] == pytest.approx(30 / 25)  # 1.2
        assert sat["rct_ohm"] == pytest.approx(1.0)

    def test_explicit_knee_point_override_wins(self):
        sat = ct_saturation_params({**self.CT_PROPS, "knee_point_v": 100})
        assert sat["knee_point_v"] == pytest.approx(100.0)


class TestEffectiveCurrent:
    CT_PROPS = {"ratio": "400/5", "accuracy_class": "5P10"}  # I_sat = 4000A

    def test_below_threshold_unclipped(self):
        sat = ct_saturation_params(self.CT_PROPS)
        assert ct_effective_current(1000, sat) == pytest.approx(1000.0)
        assert ct_effective_current(4000, sat) == pytest.approx(4000.0)  # at threshold

    def test_ks_half_exact_clean_anchor(self):
        """At I_primary = 2 x I_sat, ks is exactly 0.5 (V_sat = 45 V,
        ratio = 80, total_z = 0.9):
          i_sec_ideal = 8000/80 = 100 A, ks = 45/(100*0.9) = 0.5
          theta = arccos(0) = pi/2
          [C1] fundamental: b1 = (pi/2 - sin(pi)/2)/pi = 1/2, a1 = sin^2/pi = 1/pi
          eta1 = hypot(pi/2, 1)/pi = 0.5927 (the true RMS would be sqrt(0.5))
        """
        sat = ct_saturation_params(self.CT_PROPS)
        i_eff = ct_effective_current(8000.0, sat)
        assert i_eff == pytest.approx(8000.0 * math.hypot(math.pi / 2, 1) / math.pi, rel=1e-9)

    def test_effective_current_monotonic_and_floored(self):
        sat = ct_saturation_params(self.CT_PROPS)
        prev = ct_effective_current(4000.0, sat)
        for mult in (2, 5, 20, 100, 1000):
            cur = ct_effective_current(4000.0 * mult, sat)
            assert cur >= prev * 0.99  # never decreases (allow float noise)
            assert cur >= 4000.0 * mult * 0.05 - 1e-6  # 5% floor
            prev = cur

    def test_no_sat_params_returns_input(self):
        assert ct_effective_current(5000.0, None) == pytest.approx(5000.0)

    def test_infinite_threshold_never_clips(self):
        sat = ct_saturation_params(self.CT_PROPS)
        sat = {**sat, "i_sat_primary": math.inf}
        assert ct_effective_current(1e9, sat) == pytest.approx(1e9)
