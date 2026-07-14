"""Contingency Analysis (N-1 / N-2) — element-outage security screening.

Pins: losing the sole source islands the network (insecure); a redundant source
keeps every N-1 secure; a parallel branch survives one outage but not both; N-2
pairs are enumerated only when requested; an outage that overloads the surviving
branch is flagged; undervoltage limits and lost-load accounting work.
"""

from backend.models.schemas import Component, ProjectData, Wire
from backend.analysis.contingency import run_contingency


def _c(cid, t, props):
    return Component(id=cid, type=t, x=0, y=0, props=props)


def _w(wid, a, b):
    return Wire(id=wid, fromComponent=a, fromPort="p", toComponent=b, toPort="q")


def _radial():
    return ProjectData(
        projectName="radial", baseMVA=100.0, frequency=50,
        components=[
            _c("utility-1", "utility", {"name": "Grid", "voltage_kv": 11,
                                        "fault_mva": 500, "x_r_ratio": 15}),
            _c("bus-1", "bus", {"name": "MV Bus", "voltage_kv": 11, "bus_type": "PQ"}),
            _c("transformer-1", "transformer", {"name": "TX1", "rated_mva": 2.0,
                                                "z_percent": 6.0, "x_r_ratio": 10,
                                                "voltage_hv_kv": 11, "voltage_lv_kv": 0.4}),
            _c("bus-2", "bus", {"name": "LV Bus", "voltage_kv": 0.4, "bus_type": "PQ"}),
            _c("static_load-1", "static_load", {"name": "L1", "rated_kva": 800,
                                                "power_factor": 0.9, "demand_factor": 1.0,
                                                "voltage_kv": 0.4}),
        ],
        wires=[_w("w1", "utility-1", "bus-1"), _w("w2", "bus-1", "transformer-1"),
               _w("w3", "transformer-1", "bus-2"), _w("w4", "bus-2", "static_load-1")],
    )


def _dual_source():
    """Two grids on the load bus — either alone can supply the load."""
    return ProjectData(
        projectName="dual", baseMVA=100.0, frequency=50,
        components=[
            _c("utility-1", "utility", {"name": "Grid A", "voltage_kv": 11,
                                        "fault_mva": 500, "x_r_ratio": 15}),
            _c("utility-2", "utility", {"name": "Grid B", "voltage_kv": 11,
                                        "fault_mva": 500, "x_r_ratio": 15}),
            _c("bus-1", "bus", {"name": "Bus", "voltage_kv": 11, "bus_type": "PQ"}),
            _c("static_load-1", "static_load", {"name": "L1", "rated_kva": 500,
                                                "power_factor": 0.9, "demand_factor": 1.0,
                                                "voltage_kv": 11}),
        ],
        wires=[_w("w1", "utility-1", "bus-1"), _w("w2", "utility-2", "bus-1"),
               _w("w3", "bus-1", "static_load-1")],
    )


def _parallel_cables(rated_amps=100):
    """Grid → bus1 → two parallel feeders → bus2 → load. Each feeder rated so a
    single feeder is overloaded when its twin is out."""
    return ProjectData(
        projectName="par", baseMVA=100.0, frequency=50,
        components=[
            _c("utility-1", "utility", {"name": "Grid", "voltage_kv": 11,
                                        "fault_mva": 500, "x_r_ratio": 15}),
            _c("bus-1", "bus", {"name": "Bus1", "voltage_kv": 11, "bus_type": "PQ"}),
            _c("cable-1", "cable", {"name": "Feeder A", "voltage_kv": 11,
                                    "r_per_km": 0.2, "x_per_km": 0.1, "length_km": 1,
                                    "rated_amps": rated_amps}),
            _c("cable-2", "cable", {"name": "Feeder B", "voltage_kv": 11,
                                    "r_per_km": 0.2, "x_per_km": 0.1, "length_km": 1,
                                    "rated_amps": rated_amps}),
            _c("bus-2", "bus", {"name": "Bus2", "voltage_kv": 11, "bus_type": "PQ"}),
            _c("static_load-1", "static_load", {"name": "L1", "rated_kva": 2500,
                                                "power_factor": 0.9, "demand_factor": 1.0,
                                                "voltage_kv": 11}),
        ],
        wires=[_w("w1", "utility-1", "bus-1"),
               _w("w2", "bus-1", "cable-1"), _w("w3", "cable-1", "bus-2"),
               _w("w4", "bus-1", "cable-2"), _w("w5", "cable-2", "bus-2"),
               _w("w6", "bus-2", "static_load-1")],
    )


def _by_id(res):
    return {r.id: r for r in res.contingencies}


def test_radial_loss_of_source_islands():
    res = run_contingency(_radial())
    assert res.base_converged
    assert not res.n_minus_1_secure          # losing the sole grid de-energizes
    byid = _by_id(res)
    grid = byid["utility-1"]
    assert grid.status == "islanded"
    assert any(v.kind == "deenergized" for v in grid.violations)
    assert grid.lost_load_mw > 0
    # The single transformer feeds the LV bus — losing it drops the LV load.
    assert byid["transformer-1"].status == "islanded"


def test_dual_source_is_n1_secure():
    res = run_contingency(_dual_source())
    assert res.n_minus_1_secure
    byid = _by_id(res)
    assert byid["utility-1"].status == "secure"
    assert byid["utility-2"].status == "secure"
    assert byid["utility-1"].lost_load_mw == 0


def test_parallel_branch_survives_one_not_both():
    res = run_contingency(_parallel_cables(), include_n2=True)
    byid = _by_id(res)
    # One feeder out: the twin picks up the load (may overload, but energized).
    assert byid["cable-1"].status in ("secure", "violations")
    assert byid["cable-1"].lost_load_mw == 0
    # Both feeders out (N-2): the load bus is islanded.
    both = byid.get("cable-1+cable-2")
    assert both is not None
    assert both.status == "islanded"
    assert both.order == 2


def test_overload_flagged_when_twin_out():
    # Feeders rated so a single one is overloaded carrying the whole load.
    res = run_contingency(_parallel_cables(rated_amps=100))
    byid = _by_id(res)
    c1 = byid["cable-1"]
    assert c1.max_loading_pct > 100
    assert any(v.kind == "overload" for v in c1.violations)


def test_n2_only_when_requested():
    n1 = run_contingency(_parallel_cables(), include_n2=False)
    assert all(r.order == 1 for r in n1.contingencies)
    assert n1.mode == "N-1"
    n2 = run_contingency(_parallel_cables(), include_n2=True)
    assert any(r.order == 2 for r in n2.contingencies)
    assert n2.mode == "N-1 + N-2"


def test_undervoltage_limit_triggers_violation():
    # A tight lower band flags the sagged surviving feeder even without overload.
    res = run_contingency(_parallel_cables(rated_amps=1000), v_min=0.998)
    byid = _by_id(res)
    c1 = byid["cable-1"]
    assert c1.min_v_pu < 0.998
    assert any(v.kind == "undervoltage" for v in c1.violations)


def test_worst_case_ranked_first():
    res = run_contingency(_radial())
    # The most severe outage (islanding the most load) sorts to the front.
    assert res.contingencies[0].status in ("non_converged", "islanded")
    assert res.worst_case_id in ("utility-1", "transformer-1")
