"""Voltage Stability — P-V loadability sweep and Q-V reactive margin.

Pins: a weak network's nose is found and the loadability margin is positive and
lower for a weaker source; a stiff network reports the margin as a lower bound
(no collapse within lambda_max); P-V curve arrays stay index-aligned; the Q-V
curve is produced, is monotone in the held voltage, and is skipped for a
source-controlled bus.
"""

from backend.models.schemas import Component, ProjectData, Wire
from backend.analysis.voltage_stability import run_voltage_stability


def _c(cid, t, props):
    return Component(id=cid, type=t, x=0, y=0, props=props)


def _w(wid, a, b):
    return Wire(id=wid, fromComponent=a, fromPort="p", toComponent=b, toPort="q")


def _weak_network(fault_mva=25, length_km=8, rated_kva=3000):
    """Weak grid → long feeder → load bus. Low fault MVA / long cable = a soft
    network whose P-V nose sits at a modest λ."""
    return ProjectData(
        projectName="weak", baseMVA=100.0, frequency=50,
        components=[
            _c("utility-1", "utility", {"name": "Grid", "voltage_kv": 11,
                                        "fault_mva": fault_mva, "x_r_ratio": 5}),
            _c("bus-1", "bus", {"name": "Source Bus", "voltage_kv": 11, "bus_type": "PQ"}),
            _c("cable-1", "cable", {"name": "Feeder", "voltage_kv": 11,
                                    "r_per_km": 0.5, "x_per_km": 0.4,
                                    "length_km": length_km, "rated_amps": 200}),
            _c("bus-2", "bus", {"name": "Load Bus", "voltage_kv": 11, "bus_type": "PQ"}),
            _c("static_load-1", "static_load", {"name": "L1", "rated_kva": rated_kva,
                                                "power_factor": 0.9, "demand_factor": 1.0,
                                                "voltage_kv": 11}),
        ],
        wires=[_w("w1", "utility-1", "bus-1"), _w("w2", "bus-1", "cable-1"),
               _w("w3", "cable-1", "bus-2"), _w("w4", "bus-2", "static_load-1")],
    )


def _stiff_network():
    """Strong grid, short stiff transformer feed — nose is far away."""
    return ProjectData(
        projectName="stiff", baseMVA=100.0, frequency=50,
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


def test_weak_network_reaches_nose():
    r = run_voltage_stability(_weak_network(), lambda_max=6.0, step=0.2)
    assert r.converged
    assert r.collapsed                      # a nose was found within lambda_max
    assert r.loading_margin_pct > 0
    assert r.lambda_critical > 1.0
    assert r.critical_bus_name == "Load Bus"
    # Collapse occurs on the lower knee — weakest bus is deeply sagged.
    assert 0.4 <= r.nose_v_pu <= 0.85
    # Total demand at the nose = base load × λ_critical.
    assert abs(r.critical_load_mw - r.base_load_mw * r.lambda_critical) < 1e-3


def test_longer_feeder_has_smaller_margin():
    # The load-flow utility is an ideal swing bus, so loadability is set by the
    # network impedance: a longer (higher-impedance) feeder collapses sooner.
    short = run_voltage_stability(_weak_network(length_km=4), lambda_max=10.0, step=0.2)
    long = run_voltage_stability(_weak_network(length_km=12), lambda_max=10.0, step=0.2)
    assert long.loading_margin_pct < short.loading_margin_pct


def test_pv_curve_arrays_index_aligned():
    r = run_voltage_stability(_weak_network(), lambda_max=6.0, step=0.25)
    n = len(r.lam)
    assert n >= 3
    assert len(r.load_mw) == n
    assert len(r.min_v_pu) == n
    for bc in r.bus_curves:
        assert len(bc.v_pu) == n
    # λ is monotone increasing and load = base × λ.
    assert all(r.lam[i] < r.lam[i + 1] for i in range(n - 1))
    for lam, mw in zip(r.lam, r.load_mw):
        assert abs(mw - r.base_load_mw * lam) < 1e-2
    # Exactly one bus flagged critical (the weakest at the nose).
    assert sum(1 for bc in r.bus_curves if bc.is_critical) == 1


def test_stiff_network_margin_is_lower_bound():
    r = run_voltage_stability(_stiff_network(), lambda_max=3.0, step=0.25)
    assert r.converged
    assert not r.collapsed                   # nose not reached within the cap
    assert r.lambda_critical >= 3.0 - 1e-6
    assert "lower bound" in r.note


def test_qv_curve_produced_and_monotone():
    r = run_voltage_stability(_weak_network(), lambda_max=6.0, step=0.5)
    assert r.qv_bus_id                       # auto-picked the weakest bus
    assert len(r.qv_curve) >= 5
    # Holding a higher voltage needs more reactive injected: Q rises with V.
    qs = [p.q_mvar for p in sorted(r.qv_curve, key=lambda p: p.v_pu)]
    assert qs[-1] > qs[0]
    assert r.qv_min_mvar is not None
    assert r.qv_min_mvar <= min(qs) + 1e-6


def test_qv_skipped_for_source_bus():
    """Q-V at a bus that already has a utility on it is meaningless — skipped."""
    r = run_voltage_stability(_weak_network(), qv_bus_id="bus-1", lambda_max=4.0, step=0.5)
    assert r.qv_curve == []
    assert any("source-controlled" in w for w in r.warnings)
