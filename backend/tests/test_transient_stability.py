"""Classical transient stability — standards-anchored regression tests.

The anchor is the single-machine-infinite-bus equal-area criterion. With a
bolted fault at the generator terminal the electrical output is zero during the
fault and fully restored on clearing, so the critical clearing time has a closed
form the integrator + CCT search must reproduce:

  δr0 = δ_gen − δ_inf,   Pmax = Pm/sin(δr0)
  δcr = arccos[(π − 2δr0)·sinδr0 − cosδr0]
  t_cr = sqrt((δcr − δr0)·4H / (ω_s·Pm))
"""

import math
import pytest

from backend.models.schemas import ProjectData, Component, Wire
from backend.analysis.transient_stability import run_transient_stability


def _c(cid, ctype, props):
    return Component(id=cid, type=ctype, x=0, y=0, props=props)


def _w(wid, a, b):
    return Wire(id=wid, fromComponent=a, fromPort="o", toComponent=b, toPort="i")


def _smib(h=3.5, xline_pu=0.3, gen_mva=100.0, load_mw=60.0):
    """Infinite bus — line — generator bus (+load) — generator."""
    return ProjectData(projectName="smib", baseMVA=100.0, frequency=50, components=[
        _c("util", "utility", {"name": "Grid", "voltage_kv": 11, "fault_mva": 1e7, "x_r_ratio": 1000}),
        _c("bus_inf", "bus", {"name": "INF", "voltage_kv": 11}),
        _c("ln", "cable", {"name": "L", "voltage_kv": 11, "r_per_km": 0.0,
                           "x_per_km": xline_pu * (11 ** 2 / 100), "length_km": 1}),
        _c("bus_gen", "bus", {"name": "GEN", "voltage_kv": 11}),
        _c("g1", "generator", {"name": "G1", "rated_mva": gen_mva, "voltage_kv": 11,
                               "xd_p": 0.3, "xd_pp": 0.2, "x_r_ratio": 1000,
                               "inertia_h_s": h, "damping_pu": 0, "dispatch_mode": "must_run"}),
        _c("ld", "static_load", {"name": "LD", "voltage_kv": 11,
                                 "rated_kva": load_mw * 1000, "power_factor": 1.0}),
    ], wires=[_w("w1", "util", "bus_inf"), _w("w2", "bus_inf", "ln"), _w("w3", "ln", "bus_gen"),
              _w("w4", "bus_gen", "g1"), _w("w5", "bus_gen", "ld")])


def _closed_form_cct(res, freq=50):
    gen = next(m for m in res["machines"] if m["type"] == "generator")
    inf = next(m for m in res["machines"] if m["type"] == "infinite_bus")
    dr0 = math.radians(gen["delta0_deg"] - inf["delta0_deg"])
    Pm, H, ws = gen["pm_pu"], gen["h_s"], 2 * math.pi * freq
    inside = (math.pi - 2 * dr0) * math.sin(dr0) - math.cos(dr0)
    dcr = math.acos(max(-1.0, min(1.0, inside)))
    return math.sqrt((dcr - dr0) * 4 * H / (ws * Pm)), dr0


class TestSMIBEqualArea:
    def test_cct_matches_equal_area(self):
        res = run_transient_stability(_smib(), {"type": "fault", "bus": "bus_gen",
                                                "clear_time_s": 0.1, "find_cct": True, "t_end_s": 5})
        assert res["cct_s"] is not None
        t_cr, _ = _closed_form_cct(res)
        assert res["cct_s"] == pytest.approx(t_cr, rel=0.08)

    def test_stable_below_and_unstable_above_cct(self):
        res = run_transient_stability(_smib(), {"type": "fault", "bus": "bus_gen",
                                                "clear_time_s": 0.1, "find_cct": True, "t_end_s": 5})
        cct = res["cct_s"]
        below = run_transient_stability(_smib(), {"type": "fault", "bus": "bus_gen",
                                                  "clear_time_s": cct * 0.6, "find_cct": False, "t_end_s": 5})
        above = run_transient_stability(_smib(), {"type": "fault", "bus": "bus_gen",
                                                  "clear_time_s": cct * 1.4, "find_cct": False, "t_end_s": 5})
        assert below["stable"] is True
        assert above["stable"] is False

    def test_lower_inertia_lowers_cct(self):
        """A lighter rotor loses synchronism sooner — CCT falls with H."""
        hi = run_transient_stability(_smib(h=6.0), {"type": "fault", "bus": "bus_gen",
                                                    "clear_time_s": 0.1, "find_cct": True, "t_end_s": 5})
        lo = run_transient_stability(_smib(h=2.0), {"type": "fault", "bus": "bus_gen",
                                                    "clear_time_s": 0.1, "find_cct": True, "t_end_s": 5})
        assert lo["cct_s"] < hi["cct_s"]

    def test_prefault_electrical_matches_mechanical(self):
        """At t=0 the recorded electrical power equals the mechanical power
        (the machine starts in equilibrium)."""
        res = run_transient_stability(_smib(), {"type": "fault", "bus": "bus_gen",
                                                "clear_time_s": 0.5, "find_cct": False, "t_end_s": 3})
        # generator is machine index 1 (util first)
        gi = res["curves"]["machines"].index("G1")
        pe0 = res["curves"]["pe_pu"][gi][0]
        pm = next(m["pm_pu"] for m in res["machines"] if m["name"] == "G1")
        # fault is on at t=0 so pe already collapsed; check the immediate
        # pre-clear steady value instead via delta staying at delta0 early? Use
        # a no-op load step to read the undisturbed pre-event power.
        undis = run_transient_stability(_smib(), {"type": "load_step", "element": "ld",
                                                  "delta_pct": 0, "time_s": 2.0, "t_end_s": 1.0})
        gi2 = undis["curves"]["machines"].index("G1")
        assert undis["curves"]["pe_pu"][gi2][0] == pytest.approx(pm, abs=0.02)


class TestDisturbances:
    def test_line_trip_runs(self):
        res = run_transient_stability(_smib(), {"type": "trip", "element": "ln",
                                                "time_s": 0.1, "t_end_s": 3})
        assert res["curves"] and len(res["curves"]["t"]) > 10
        assert "Trip" in res["event"]

    def test_generator_trip_runs(self):
        # two generators so tripping one leaves a machine to assess
        p = _smib()
        p.components.append(_c("g2", "generator", {"name": "G2", "rated_mva": 80, "voltage_kv": 11,
                                                   "xd_p": 0.3, "inertia_h_s": 3, "dispatch_mode": "must_run"}))
        p.wires.append(_w("w6", "bus_gen", "g2"))
        res = run_transient_stability(p, {"type": "trip", "element": "g2",
                                          "time_s": 0.1, "t_end_s": 3})
        assert res["curves"] and "G2" in res["curves"]["machines"]

    def test_load_step_runs(self):
        res = run_transient_stability(_smib(), {"type": "load_step", "element": "ld",
                                                "delta_pct": 50, "time_s": 0.1, "t_end_s": 3})
        assert res["curves"] and "Step" in res["event"]


class TestIntegrations:
    def test_study_manager_runs_stability(self):
        from backend.analysis.study_manager import run_study_manager
        res = run_study_manager(_smib(), ["transient_stability"])
        study = res["studies"]["transient_stability"]
        assert study["name"] == "Transient Stability"
        assert study["status"] in ("pass", "fail", "warning")
        assert study["counts"]["machines"] == 2
        assert "stable" in study["counts"]

    def test_study_manager_uses_configured_disturbance(self):
        from backend.analysis.study_manager import run_study_manager
        p = _smib()
        p.stabilityDisturbance = {"type": "fault", "bus": "bus_gen",
                                  "clear_time_s": 0.2, "find_cct": True}
        res = run_study_manager(p, ["transient_stability"])
        assert res["studies"]["transient_stability"]["result"]["cct_s"] is not None

    def test_calculations_pdf_includes_stability_section(self):
        from backend.analysis.pdf_reports import generate_calculations_report
        stab = run_transient_stability(_smib(), {"type": "fault", "bus": "bus_gen",
                                                 "clear_time_s": 0.2, "find_cct": True, "t_end_s": 3})
        without = generate_calculations_report("t", 100.0, 50, components=[]).getvalue()
        with_stab = generate_calculations_report(
            "t", 100.0, 50, components=[], stability_results=stab).getvalue()
        assert with_stab.startswith(b"%PDF")
        assert len(with_stab) > len(without)


class TestIslanding:
    """Synchronism is judged per electrical island. A genset island separated
    from the grid drifts as a block after a load change (no governor in the
    classical model) — that is a frequency excursion, not loss of synchronism,
    and must not be dragged unstable by a disconnected grid's frozen angle."""

    def _islanded_gensets(self, with_open_grid=False):
        # Two gensets + load on one bus; optionally a utility fenced off behind
        # an OPEN breaker so it sits in its own island (mirrors the winery site).
        comps = [
            _c("busg", "bus", {"name": "GenBus", "voltage_kv": 0.4}),
            _c("g1", "generator", {"name": "G1", "rated_mva": 0.2, "voltage_kv": 0.4,
                                   "xd_p": 0.25, "inertia_h_s": 3.0, "dispatch_mode": "must_run"}),
            _c("g2", "generator", {"name": "G2", "rated_mva": 0.06, "voltage_kv": 0.4,
                                   "xd_p": 0.25, "inertia_h_s": 2.0, "dispatch_mode": "must_run"}),
            _c("ld", "static_load", {"name": "House", "voltage_kv": 0.4,
                                     "rated_kva": 50, "power_factor": 0.9, "demand_factor": 1.0}),
        ]
        wires = [_w("w1", "g1", "busg"), _w("w2", "g2", "busg"), _w("w3", "busg", "ld")]
        if with_open_grid:
            comps += [
                _c("busu", "bus", {"name": "GridBus", "voltage_kv": 0.4}),
                _c("util", "utility", {"name": "Grid", "voltage_kv": 0.4, "fault_mva": 500}),
                _c("tie", "cb", {"name": "SyncIncomer", "state": "open"}),
            ]
            wires += [_w("w4", "util", "busu"), _w("w5", "busu", "tie"), _w("w6", "tie", "busg")]
        return ProjectData(projectName="isl", baseMVA=100.0, frequency=50,
                           components=comps, wires=wires)

    def _by_name(self, res):
        return {m["name"]: m for m in res["machines"]}

    def test_islanded_load_step_is_stable(self):
        p = self._islanded_gensets()
        r = run_transient_stability(p, {"type": "load_step", "element": "ld",
                                        "delta_pct": -50, "time_s": 0.1, "t_end_s": 5})
        assert r["stable"] is True
        assert any("islanded generator group" in w for w in r["warnings"])

    def test_removing_tiny_load_does_not_destabilise(self):
        """The reported bug: a small load rejection on a genset island must stay
        stable — the gensets drift together, not apart."""
        p = self._islanded_gensets()
        r = run_transient_stability(p, {"type": "load_step", "element": "ld",
                                        "delta_pct": -100, "time_s": 0.1, "t_end_s": 5})
        assert r["stable"] is True
        gens = self._by_name(r)
        # relative to the island COI the swing stays well within synchronism
        assert max(gens["G1"]["peak_angle_deg"], gens["G2"]["peak_angle_deg"]) < 90.0

    def test_disconnected_grid_does_not_drag_island_unstable(self):
        """With the grid fenced off in its own island, a load step in the genset
        island is judged against the genset COI — the frozen grid angle must not
        make it look like loss of synchronism (the pre-fix failure mode)."""
        p = self._islanded_gensets(with_open_grid=True)
        r = run_transient_stability(p, {"type": "load_step", "element": "ld",
                                        "delta_pct": -100, "time_s": 0.1, "t_end_s": 5})
        assert r["stable"] is True
        assert any(m["type"] == "infinite_bus" for m in r["machines"])  # grid present but islanded


class TestEdgeCases:
    def test_no_machines(self):
        p = ProjectData(projectName="t", baseMVA=100.0, frequency=50,
                        components=[_c("b", "bus", {"name": "B", "voltage_kv": 11})], wires=[])
        res = run_transient_stability(p, {"type": "fault", "bus": "b"})
        assert res["stable"] is None
        assert res["warnings"]

    def test_fault_bus_missing(self):
        with pytest.raises(ValueError):
            run_transient_stability(_smib(), {"type": "fault", "bus": "nope"})

    def test_curves_shape(self):
        res = run_transient_stability(_smib(), {"type": "fault", "bus": "bus_gen",
                                                "clear_time_s": 0.2, "t_end_s": 3})
        c = res["curves"]
        assert len(c["machines"]) == 2
        assert len(c["delta_deg"]) == 2 and len(c["speed_hz"]) == 2
        assert all(len(s) == len(c["t"]) for s in c["delta_deg"])
        assert c["buses"] and all(len(b["v_pu"]) == len(c["t"]) for b in c["buses"])
