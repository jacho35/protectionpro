"""Way poles: 2P (L+N or line-to-line) and 4P (3P + N) in the DB circuit check."""
import math

from backend.analysis import db_circuit_check as d


def test_current_by_poles():
    v_ll = 400.0
    base = {"load_va": 6000, "demand_factor": 1}
    assert math.isclose(d._way_current_a({**base, "poles": "1P", "phase": "R"}, v_ll), 6000 / (v_ll / math.sqrt(3)))
    assert math.isclose(d._way_current_a({**base, "poles": "2P", "phase": "R"}, v_ll), 6000 / (v_ll / math.sqrt(3)))   # L+N
    assert math.isclose(d._way_current_a({**base, "poles": "2P", "phase": "RW"}, v_ll), 6000 / v_ll)                    # L-L
    three = 6000 / (math.sqrt(3) * v_ll)
    assert math.isclose(d._way_current_a({**base, "poles": "3P", "phase": "RWB"}, v_ll), three)
    assert math.isclose(d._way_current_a({**base, "poles": "4P", "phase": "RWB"}, v_ll), three)


def test_predicates():
    assert d._is_ll({"poles": "2P", "phase": "WB"}) and not d._is_ll({"poles": "2P", "phase": "W"})
    assert d._is_3p({"poles": "4P", "phase": "RWB"}) and not d._is_3p({"poles": "2P", "phase": "RW"})
