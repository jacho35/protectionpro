"""Raceway review fixes (reviews/RACEWAY_REVIEW.md): grouping basis and
double derating. Hand references: IEC 60364-5-52 Tables B.52.17 / B.52.19,
NEC Ch. 9 Table 1 fill limits."""
import math
import pytest

from backend.analysis.raceway import run_raceway_analysis, grouping_factor
from backend.models.schemas import RacewayRequest, RacewayDef, RacewayCable


def _rw(n=4, grouping="bunched", rated=100.0, load=0.0, included=1.0, od=20.0,
        nominal=110, name="R"):
    cables = [RacewayCable(cable_id=f"c{i}", od_mm=od, rated_amps=rated,
                           load_amps=load, included_grouping_factor=included)
              for i in range(n)]
    return RacewayDef(name=name, conduit_nominal_mm=nominal, grouping=grouping,
                      cables=cables)


def _run(rw):
    return run_raceway_analysis(RacewayRequest(raceways=[rw])).raceways[0]


def test_default_basis_is_b5217_item1():
    # B.52.17 item 1: 4 circuits 0.65, 10 -> next tabulated (12) 0.45
    assert grouping_factor(4) == 0.65
    assert grouping_factor(10) == 0.45
    assert _run(_rw(n=4)).grouping_factor == 0.65


def test_duct_basis_uses_b5219_column():
    # B.52.19 A, multicore in ducts touching: 4 cables 0.70, 10 cables 0.49
    assert grouping_factor(4, "ducts_mc_touching") == 0.70
    assert grouping_factor(10, "ducts_mc_touching") == 0.49
    r = _run(_rw(n=4, grouping="ducts_mc_touching", rated=100))
    assert r.grouping_factor == 0.70
    assert r.cables[0].derated_amps == pytest.approx(70.0)


def test_unknown_basis_falls_back_with_warning():
    r = _run(_rw(n=4, grouping="nonsense"))
    assert r.grouping_factor == 0.65 and r.grouping == "bunched"
    assert any("Unknown grouping basis" in w for w in r.warnings)


def test_grouping_not_applied_twice():
    """[RW1] A rating that already carries a 0.65 grouping factor, put in a
    4-cable raceway (0.65), is not derated again."""
    r = _run(_rw(n=4, rated=65.0, included=0.65))
    assert r.cables[0].derated_amps == pytest.approx(65.0)
    # a raceway worse than the included factor derates by the ratio only
    r = _run(_rw(n=9, rated=65.0, included=0.65))     # 9 cables: 0.50
    assert r.cables[0].derated_amps == pytest.approx(65.0 * 0.50 / 0.65, abs=0.1)
    # a better raceway never raises the rating
    r = _run(_rw(n=2, rated=65.0, included=0.65))     # 0.80 > 0.65
    assert r.cables[0].derated_amps == pytest.approx(65.0)


def test_no_rating_is_unknown_not_fail():
    """[RW2] rated_amps 0 with a load used to read 0 A < load -> fail."""
    r = _run(_rw(n=3, rated=0.0, load=50.0))
    assert r.cables[0].adequate
    assert r.status in ("pass", "warning")
    assert any("no rated current" in w for w in r.warnings)


def test_fill_limits_nec_table1():
    # one 20 mm cable in a 110 mm (ID 102.7): 0.0391 -> 3.9 %, limit 53
    one = _run(_rw(n=1))
    assert one.fill_limit_pct == 53.0
    two = _run(_rw(n=2))
    assert two.fill_limit_pct == 31.0
    three = _run(_rw(n=3))
    assert three.fill_limit_pct == 40.0
    assert one.fill_pct == pytest.approx(
        100 * (20 / 102.7) ** 2, abs=0.1)


def test_jam_ratio_hand():
    # three 30 mm cables in ID 102.7: 1.05*102.7/30 = 3.594 -> outside band
    r = _run(_rw(n=3, od=30.0))
    assert r.jam_ratio == pytest.approx(1.05 * 102.7 / 30.0, abs=0.01)
    assert not r.jam_warning
    # ID 102.7 / 1.05 / 3.0 -> OD 34.2 puts the ratio at 3.15: in the band
    r = _run(_rw(n=3, od=34.2))
    assert 2.8 <= r.jam_ratio <= 3.2 and r.jam_warning
