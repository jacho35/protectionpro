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
from backend.analysis.arcflash import _relay_operate_time


def _c(cid, ctype, props):
    return Component(id=cid, type=ctype, x=0, y=0, props=props)


def _w(wid, a, b):
    return Wire(id=wid, fromComponent=a, fromPort="o", toComponent=b, toPort="i")


def _smib(h=3.5, xline_pu=0.3, gen_mva=100.0, load_mw=60.0):
    """Infinite bus (+load) — line — generator bus — generator.

    The load hangs on the INFINITE-BUS side, not the generator bus. The
    equal-area closed form below is a lossless single-machine-infinite-bus
    criterion (P_e = E·V·sin δ / X), so the gen→grid transfer path has to stay
    free of conductance: a resistive load at the machine's own terminal absorbs
    real power during the swing and puts a real part into the reduced Y, and the
    closed form then over-predicts the CCT by ~11 %. At the infinite bus the
    load is bypassed by the source's ~0 internal impedance, so the anchor holds
    exactly (measured −0.25 %) while the generator still exports its full 85 MW
    through the line. (Before [D2] this did not matter, because a load on a
    machine bus was silently netted off that machine's own injection instead of
    being stamped as a network shunt at all — which is precisely the defect [D2]
    fixed, and why these anchors moved.)
    """
    return ProjectData(projectName="smib", baseMVA=100.0, frequency=50, components=[
        _c("util", "utility", {"name": "Grid", "voltage_kv": 11, "fault_mva": 1e7, "x_r_ratio": 1000}),
        _c("bus_inf", "bus", {"name": "INF", "voltage_kv": 11}),
        _c("ln", "cable", {"name": "L", "voltage_kv": 11, "r_per_km": 0.0,
                           "x_per_km": xline_pu * (11 ** 2 / 100), "length_km": 1}),
        _c("bus_gen", "bus", {"name": "GEN", "voltage_kv": 11}),
        _c("g1", "generator", {"name": "G1", "rated_mva": gen_mva, "voltage_kv": 11,
                               "xd_p": 0.3, "xd_pp": 0.2, "x_r_ratio": 1000,
                               "inertia_h_s": h, "damping_pu": 0, "dispatch_mode": "must_run",
                               # Equal-area CCT is a constant-Pm, constant-E′
                               # criterion — disable the governor and AVR so the
                               # closed form is the exact anchor.
                               "gov_mode": "none", "avr_mode": "off"}),
        _c("ld", "static_load", {"name": "LD", "voltage_kv": 11,
                                 "rated_kva": load_mw * 1000, "power_factor": 1.0}),
    ], wires=[_w("w1", "util", "bus_inf"), _w("w2", "bus_inf", "ln"), _w("w3", "ln", "bus_gen"),
              _w("w4", "bus_gen", "g1"), _w("w5", "bus_inf", "ld")])


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


def _smib_ungrounded(h=3.5, xline_pu=0.3, gen_mva=100.0, load_mw=60.0):
    """Same SMIB topology, but both the utility and the generator have an
    ungrounded neutral — no zero-sequence return path exists anywhere on the
    network (Z0 -> inf at every bus)."""
    p = _smib(h=h, xline_pu=xline_pu, gen_mva=gen_mva, load_mw=load_mw)
    for comp in p.components:
        if comp.type in ("utility", "generator"):
            comp.props["grounding"] = "ungrounded"
    return p


class TestUnbalancedFault:
    """Unbalanced (SLG/LL/LLG) dynamic faults are modelled as a positive-
    sequence shunt fault impedance Zf at the fault bus — Zf = Z2+Z0 (SLG),
    Z2 (LL), Z2‖Z0 (LLG) — reusing fault.py's own steady-state formulas via
    ``thevenin_sequence_at_bus``. Z1/Z2/Z0 are Thevenin equivalents computed
    once at fault onset; the 3-phase case is untouched (still a bolted bus
    elimination via ``grounded``, not a shunt)."""

    def test_default_fault_type_is_3phase_byte_identical(self):
        base = {"type": "fault", "bus": "bus_gen", "clear_time_s": 0.1,
                "find_cct": True, "t_end_s": 5}
        implicit = run_transient_stability(_smib(), dict(base))
        explicit = run_transient_stability(_smib(), {**base, "fault_type": "3phase"})
        assert implicit["cct_s"] == explicit["cct_s"]
        # 0.245 s, and it agrees with the equal-area closed form to 0.25 % (see
        # TestSMIBEqualArea). The old 0.6225 s baseline was pinning the [D2]
        # defect: the fixture's 60 MW load sat on the generator bus and was
        # netted off the machine, leaving P_m at 25 MW instead of 85 MW and
        # inflating the CCT 2.4x.
        assert implicit["cct_s"] == pytest.approx(0.245, rel=0.02)

    def test_severity_ordering_vs_3phase(self):
        """SLG/LL/LLG are all electrically less severe than a bolted 3-phase
        fault at the same bus (positive-sequence voltage doesn't collapse to
        zero), so each unbalanced-fault CCT must exceed the 3-phase CCT — and
        LLG (Z2‖Z0, the smallest Zf of the three) is more severe than plain
        LL or SLG."""
        base = {"type": "fault", "bus": "bus_gen", "clear_time_s": 0.05,
                "find_cct": True, "t_end_s": 3}
        cct = {}
        for ft in ("3phase", "slg", "ll", "llg"):
            res = run_transient_stability(_smib(xline_pu=2.0, gen_mva=40.0, load_mw=30.0),
                                          {**base, "fault_type": ft})
            assert res["cct_s"] is not None
            cct[ft] = res["cct_s"]
        assert cct["3phase"] < cct["llg"] < cct["ll"] < cct["slg"]

    def test_stable_below_and_unstable_above_slg_cct(self):
        base = {"type": "fault", "bus": "bus_gen", "fault_type": "slg",
                "clear_time_s": 0.05, "find_cct": True, "t_end_s": 3}
        cct = run_transient_stability(_smib(xline_pu=2.0, gen_mva=40.0, load_mw=30.0), dict(base))["cct_s"]
        assert cct is not None
        below = run_transient_stability(_smib(xline_pu=2.0, gen_mva=40.0, load_mw=30.0),
                                        {**base, "clear_time_s": cct * 0.6, "find_cct": False})
        above = run_transient_stability(_smib(xline_pu=2.0, gen_mva=40.0, load_mw=30.0),
                                        {**base, "clear_time_s": cct * 1.4, "find_cct": False})
        assert below["stable"] is True
        assert above["stable"] is False

    def test_no_zero_sequence_path_does_not_crash(self):
        """An ungrounded utility/generator gives Z0 -> inf: SLG's Zf collapses
        toward infinite (negligible fault current) and LLG degenerates to a
        plain LL fault (Z2‖Z0 -> Z2) — both fall out of the Zf formulas with
        no special-casing, matching fault.py's own has_z0_path handling. Must
        not raise or produce NaN."""
        p = _smib_ungrounded()
        for ft in ("slg", "llg", "ll"):
            res = run_transient_stability(p, {"type": "fault", "bus": "bus_gen",
                                              "fault_type": ft, "clear_time_s": 0.2,
                                              "find_cct": False, "t_end_s": 2})
            assert res["stable"] is True
            assert not any("nan" in str(w).lower() for w in res["warnings"])

    def test_fault_bus_voltage_is_finite_dip_not_zero(self):
        """Unlike a bolted 3-phase fault (bus eliminated from the reduced
        network, so its voltage effectively reads 0), an unbalanced fault's
        positive-sequence shunt leaves the bus IN the network with a real,
        finite dip."""
        res = run_transient_stability(_smib(xline_pu=2.0, gen_mva=40.0, load_mw=30.0),
                                      {"type": "fault", "bus": "bus_gen", "fault_type": "slg",
                                       "clear_time_s": 0.05, "find_cct": False, "t_end_s": 1})
        gen_v = next(b["v_pu"] for b in res["curves"]["buses"] if b["bus"] == "GEN")
        assert 0.1 < gen_v[0] < 0.95


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


class TestGovernor:
    """Turbine-governor frequency response. A load change in a grid-less genset
    island must recover (isochronous) or settle at a bounded offset (droop);
    with the governor disabled the frequency drifts without recovering."""

    def _loaded_island(self, gov_mode):
        # Two gensets on a gen bus feed a load bus through a feeder, so the sets
        # carry real power (Pm > 0) and the governor has something to regulate.
        g = lambda cid, nm: _c(cid, "generator", {
            "name": nm, "rated_mva": 0.2, "voltage_kv": 0.4, "xd_p": 0.25,
            "inertia_h_s": 2.0, "dispatch_mode": "must_run", "gov_mode": gov_mode,
            "gov_droop_pct": 4, "gov_time_const_s": 0.5, "gov_reset_time_s": 4})
        comps = [
            _c("busg", "bus", {"name": "GenBus", "voltage_kv": 0.4}),
            _c("busl", "bus", {"name": "LoadBus", "voltage_kv": 0.4}),
            _c("fdr", "cable", {"name": "F", "voltage_kv": 0.4, "r_per_km": 0.1,
                                "x_per_km": 0.07, "length_km": 0.05}),
            g("g1", "G1"), g("g2", "G2"),
            _c("ld", "static_load", {"name": "House", "voltage_kv": 0.4,
                                     "rated_kva": 200, "power_factor": 0.9, "demand_factor": 1.0}),
        ]
        wires = [_w("wf1", "busg", "fdr"), _w("wf2", "fdr", "busl"),
                 _w("w1", "g1", "busg"), _w("w2", "g2", "busg"), _w("w3", "busl", "ld")]
        return ProjectData(projectName="gov", baseMVA=100.0, frequency=50,
                           components=comps, wires=wires)

    def _stats(self, gov_mode, delta_pct=-40, t_end=25):
        r = run_transient_stability(self._loaded_island(gov_mode),
                                    {"type": "load_step", "element": "ld",
                                     "delta_pct": delta_pct, "time_s": 1, "t_end_s": t_end})
        f = r["curves"]["speed_hz"]
        gi = [i for i, n in enumerate(r["curves"]["machines"]) if n != "Utility"]
        n = len(f[gi[0]])
        q = int(n * 0.75)
        final = max(abs(f[i][-1]) for i in gi)                    # end deviation (Hz)
        peak = max(abs(v) for i in gi for v in f[i])              # worst excursion
        # how much it is STILL moving over the last quarter (settled ⇒ ~0)
        drift = max(abs(f[i][-1] - f[i][q]) for i in gi)
        return {"final": final, "peak": peak, "drift": drift, "stable": r["stable"],
                "instability": r.get("instability")}

    def test_isochronous_recovers_to_nominal(self):
        s = self._stats("isochronous")
        assert s["stable"] is True
        assert s["peak"] > 1e-3         # there WAS a frequency excursion
        assert s["final"] < 0.02        # …that recovers to ~nominal
        assert s["drift"] < 0.02        # …and has settled

    def test_none_drifts_is_frequency_unstable(self):
        # No governor ⇒ the island frequency runs away and never recovers. The
        # machines stay in step with each other (rotor-angle synchronism holds),
        # but this is now correctly reported as a FREQUENCY instability, not
        # "stable" — the machines desynchronise from nominal frequency together.
        s = self._stats("none")
        assert s["stable"] is False
        assert "frequency" in (s["instability"] or "")
        assert s["drift"] > 0.03        # still ramping at the end (never settles)

    def test_droop_settles_at_bounded_offset(self):
        iso = self._stats("isochronous")
        drp = self._stats("droop")
        assert drp["stable"] is True
        assert drp["drift"] < 0.02              # settled (bounded, unlike 'none')
        assert drp["final"] > iso["final"]      # …but at an offset (unlike isochronous)

    def test_default_mode_is_isochronous(self):
        # a generator with no gov_mode set recovers (isochronous default)
        p = self._loaded_island("isochronous")
        for c in p.components:
            if c.type == "generator":
                c.props.pop("gov_mode", None)
        r = run_transient_stability(p, {"type": "load_step", "element": "ld",
                                        "delta_pct": -40, "time_s": 1, "t_end_s": 25})
        f = r["curves"]["speed_hz"]
        gi = [i for i, n in enumerate(r["curves"]["machines"]) if n != "Utility"]
        assert max(abs(f[i][-1]) for i in gi) < 0.02


class TestAVR:
    """AVR/exciter voltage recovery. With the AVR on the field EMF is raised to
    hold the terminal voltage after a load step; with it off the voltage stays
    depressed (classical constant-EMF model)."""

    def _island(self, avr):
        g = _c("g1", "generator", {
            "name": "G1", "rated_mva": 0.5, "voltage_kv": 0.4, "xd_p": 0.25,
            "inertia_h_s": 2.0, "dispatch_mode": "must_run", "gov_mode": "isochronous",
            "avr_mode": avr, "avr_gain": 40, "avr_time_const_s": 0.1})
        comps = [
            _c("busg", "bus", {"name": "GenBus", "voltage_kv": 0.4}),
            _c("busl", "bus", {"name": "LoadBus", "voltage_kv": 0.4}),
            _c("fdr", "cable", {"name": "F", "voltage_kv": 0.4, "r_per_km": 0.3,
                                "x_per_km": 0.15, "length_km": 0.1}),
            g,
            _c("ld", "static_load", {"name": "House", "voltage_kv": 0.4,
                                     "rated_kva": 200, "power_factor": 0.85, "demand_factor": 1.0}),
        ]
        wires = [_w("wf1", "busg", "fdr"), _w("wf2", "fdr", "busl"),
                 _w("w1", "g1", "busg"), _w("w2", "busl", "ld")]
        return ProjectData(projectName="avr", baseMVA=100.0, frequency=50,
                           components=comps, wires=wires)

    def _loadbus_v(self, avr):
        r = run_transient_stability(self._island(avr),
                                    {"type": "load_step", "element": "ld",
                                     "delta_pct": 60, "time_s": 1, "t_end_s": 8})
        v = [b for b in r["curves"]["buses"] if b["bus"] == "LoadBus"][0]["v_pu"]
        return {"pre": v[0], "final": v[-1], "stable": r["stable"]}

    def test_avr_recovers_voltage(self):
        on = self._loadbus_v("on")
        off = self._loadbus_v("off")
        assert on["stable"] and off["stable"]
        # AVR-on holds the terminal voltage higher after the load step…
        assert on["final"] > off["final"] + 0.01
        # …and recovers it toward the pre-step value (off stays depressed)
        assert on["final"] > off["final"]
        assert off["final"] < off["pre"] - 0.02

    def test_avr_default_on(self):
        # no avr_mode set ⇒ AVR active (voltage higher than an explicit off)
        p = self._island("on")
        for c in p.components:
            if c.type == "generator":
                c.props.pop("avr_mode", None)
        r = run_transient_stability(p, {"type": "load_step", "element": "ld",
                                        "delta_pct": 60, "time_s": 1, "t_end_s": 8})
        v = [b for b in r["curves"]["buses"] if b["bus"] == "LoadBus"][0]["v_pu"]
        assert v[-1] > self._loadbus_v("off")["final"]


class TestDynamicLoadsMotors:
    """Dynamic load models and induction-motor slip dynamics."""

    def _weak_island(self, load_model):
        # A weak generator (AVR off) so a load increase leaves a depressed
        # voltage where the load model matters.
        return ProjectData(projectName="dl", baseMVA=100.0, frequency=50, components=[
            _c("busg", "bus", {"name": "GenBus", "voltage_kv": 0.4}),
            _c("busl", "bus", {"name": "LoadBus", "voltage_kv": 0.4}),
            _c("fdr", "cable", {"name": "F", "voltage_kv": 0.4, "r_per_km": 0.5,
                                "x_per_km": 0.4, "length_km": 0.3}),
            _c("g1", "generator", {"name": "G1", "rated_mva": 0.3, "voltage_kv": 0.4,
                                   "xd_p": 0.3, "inertia_h_s": 1.5, "dispatch_mode": "must_run",
                                   "avr_mode": "off", "gov_mode": "isochronous"}),
            _c("ld", "static_load", {"name": "House", "voltage_kv": 0.4, "rated_kva": 120,
                                     "power_factor": 0.9, "demand_factor": 1.0,
                                     "load_model": load_model}),
        ], wires=[_w("wf1", "busg", "fdr"), _w("wf2", "fdr", "busl"),
                  _w("wg", "g1", "busg"),
                  Wire(id="wl", fromComponent="ld", fromPort="in", toComponent="busl", toPort="at_0")])

    def _final_v(self, load_model):
        r = run_transient_stability(self._weak_island(load_model),
                                    {"type": "load_step", "element": "ld",
                                     "delta_pct": 40, "time_s": 1, "t_end_s": 8})
        return [b for b in r["curves"]["buses"] if b["bus"] == "LoadBus"][0]["v_pu"][-1]

    def test_constant_impedance_default_unchanged(self):
        # constant-impedance is the default classical model — voltage holds up
        assert self._final_v("constant_impedance") > 0.5

    def test_constant_current_sags_more_than_impedance(self):
        assert self._final_v("constant_current") < self._final_v("constant_impedance")

    def test_constant_power_can_collapse_voltage(self):
        # constant-power load draws more current as V falls → voltage collapse
        assert self._final_v("constant_power") < 0.3

    def test_dynamic_motor_is_modelled(self):
        p = ProjectData(projectName="dm", baseMVA=100.0, frequency=50, components=[
            _c("busg", "bus", {"name": "GenBus", "voltage_kv": 0.4}),
            _c("busl", "bus", {"name": "LoadBus", "voltage_kv": 0.4}),
            _c("fdr", "cable", {"name": "F", "voltage_kv": 0.4, "r_per_km": 0.2,
                                "x_per_km": 0.12, "length_km": 0.12}),
            _c("g1", "generator", {"name": "G1", "rated_mva": 0.6, "voltage_kv": 0.4,
                                   "xd_p": 0.25, "inertia_h_s": 1.5, "dispatch_mode": "must_run"}),
            _c("m1", "motor_induction", {"name": "IM", "voltage_kv": 0.4, "rated_kw": 110,
                                         "efficiency": 0.93, "power_factor": 0.87,
                                         "locked_rotor_current": 6.5, "load_torque_pct": 90}),
        ], wires=[_w("wf1", "busg", "fdr"), _w("wf2", "fdr", "busl"),
                  _w("wg", "g1", "busg"),
                  Wire(id="wm", fromComponent="m1", fromPort="in", toComponent="busl", toPort="at_0")])
        r = run_transient_stability(p, {"type": "fault", "bus": "busg",
                                        "clear_time_s": 0.15, "find_cct": False, "t_end_s": 5})
        assert r["curves"] is not None
        assert any("induction motor" in w and "dynamic" in w for w in r["warnings"])

    def test_motor_static_override_no_dynamic_warning(self):
        # ts_dynamic='off' freezes the motor as a constant load (no dynamic note)
        p = ProjectData(projectName="dm", baseMVA=100.0, frequency=50, components=[
            _c("busg", "bus", {"name": "GenBus", "voltage_kv": 0.4}),
            _c("g1", "generator", {"name": "G1", "rated_mva": 0.6, "voltage_kv": 0.4,
                                   "xd_p": 0.25, "inertia_h_s": 1.5, "dispatch_mode": "must_run"}),
            _c("m1", "motor_induction", {"name": "IM", "voltage_kv": 0.4, "rated_kw": 110,
                                         "efficiency": 0.93, "power_factor": 0.87,
                                         "ts_dynamic": "off"}),
        ], wires=[_w("wg", "g1", "busg"),
                  Wire(id="wm", fromComponent="m1", fromPort="in", toComponent="busg", toPort="at_0")])
        r = run_transient_stability(p, {"type": "load_step", "element": "m1",
                                        "delta_pct": 0, "time_s": 1, "t_end_s": 3})
        assert not any("modelled dynamically" in w for w in r["warnings"])


class TestProtection:
    """UFLS load shedding and generator protection tripping."""

    def _island(self, shed=False, gen_uf=False, gen_props=None):
        shed_props = {"name": "SheddableDB", "voltage_kv": 0.4, "rated_kva": 120,
                      "power_factor": 0.9, "demand_factor": 1.0}
        if shed:
            shed_props.update({"uf_shed_hz": 49.0, "uf_shed_delay_s": 0.2})
        g = lambda cid, nm: _c(cid, "generator", {
            "name": nm, "rated_mva": 0.2, "voltage_kv": 0.4, "xd_p": 0.25,
            "inertia_h_s": 2.0, "dispatch_mode": "must_run", "gov_mode": "none",
            **({"trip_uf_hz": 48.5, "trip_delay_s": 0.2} if gen_uf else {}),
            **(gen_props or {})})
        comps = [
            _c("busg", "bus", {"name": "GenBus", "voltage_kv": 0.4}),
            _c("busl", "bus", {"name": "LoadBus", "voltage_kv": 0.4}),
            _c("fdr", "cable", {"name": "F", "voltage_kv": 0.4, "r_per_km": 0.1,
                                "x_per_km": 0.07, "length_km": 0.05}),
            g("g1", "G1"), g("g2", "G2"),
            _c("firm", "static_load", {"name": "FirmDB", "voltage_kv": 0.4, "rated_kva": 150,
                                       "power_factor": 0.9, "demand_factor": 1.0}),
            _c("shed", "static_load", shed_props),
        ]
        wires = [_w("wf1", "busg", "fdr"), _w("wf2", "fdr", "busl"),
                 _w("wg1", "g1", "busg"), _w("wg2", "g2", "busg"),
                 Wire(id="wfl", fromComponent="firm", fromPort="in", toComponent="busl", toPort="at_0"),
                 Wire(id="wsh", fromComponent="shed", fromPort="in", toComponent="busl", toPort="at_0")]
        return ProjectData(projectName="p", baseMVA=100.0, frequency=50,
                           components=comps, wires=wires)

    def _min_freq(self, r):
        sp = r["curves"]["speed_hz"]
        gi = [i for i, n in enumerate(r["curves"]["machines"]) if n != "Utility"]
        return 50.0 + min(min(sp[i]) for i in gi)

    def test_no_protection_no_trips(self):
        r = run_transient_stability(self._island(shed=False),
                                    {"type": "load_step", "element": "firm",
                                     "delta_pct": 30, "time_s": 1, "t_end_s": 8})
        assert r["trips"] == []
        assert self._min_freq(r) < 45.0   # governor-off frequency collapses freely

    def test_ufls_sheds_and_arrests_decline(self):
        base = self._min_freq(run_transient_stability(self._island(shed=False),
                              {"type": "load_step", "element": "firm",
                               "delta_pct": 30, "time_s": 1, "t_end_s": 8}))
        r = run_transient_stability(self._island(shed=True),
                                    {"type": "load_step", "element": "firm",
                                     "delta_pct": 30, "time_s": 1, "t_end_s": 8})
        assert any("UFLS" in tr["reason"] and tr["element"] == "SheddableDB"
                   for tr in r["trips"])
        # shedding arrests the decline — frequency dips far less than unshed
        assert self._min_freq(r) > base + 5.0

    def test_generator_underfrequency_trip(self):
        r = run_transient_stability(self._island(gen_uf=True),
                                    {"type": "load_step", "element": "firm",
                                     "delta_pct": 30, "time_s": 1, "t_end_s": 8})
        assert any("generator trip" in tr["reason"] for tr in r["trips"])

    def test_rocof_trip(self):
        # Same governor-off islanded-genset overload as test_no_protection_no_trips
        # (frequency "collapses freely") — a low ROCOF pickup catches the fast
        # initial rate of decline well before frequency reaches its floor.
        r = run_transient_stability(
            self._island(gen_props={"trip_rocof_hzs": 0.3, "trip_delay_s": 0.1}),
            {"type": "load_step", "element": "firm", "delta_pct": 30, "time_s": 1, "t_end_s": 8})
        assert any("ROCOF" in tr["reason"] and "generator trip" in tr["reason"] for tr in r["trips"])

    def test_rocof_no_trip_when_disabled(self):
        r = run_transient_stability(self._island(), {"type": "load_step", "element": "firm",
                                                      "delta_pct": 30, "time_s": 1, "t_end_s": 8})
        assert not any("ROCOF" in tr["reason"] for tr in r["trips"])

    def test_overexcitation_vhz_trip(self):
        # Same decline as above: AVR holds terminal voltage near 1 p.u. while
        # frequency droops, so V/Hz (p.u.) rises above 1 — the over-fluxing
        # condition ANSI 24 is meant to catch.
        r = run_transient_stability(
            self._island(gen_props={"trip_vhz_pu": 1.05, "trip_delay_s": 0.1}),
            {"type": "load_step", "element": "firm", "delta_pct": 30, "time_s": 1, "t_end_s": 8})
        assert any("over-excitation" in tr["reason"] and "generator trip" in tr["reason"]
                   for tr in r["trips"])

    def test_overexcitation_no_trip_when_disabled(self):
        r = run_transient_stability(self._island(), {"type": "load_step", "element": "firm",
                                                      "delta_pct": 30, "time_s": 1, "t_end_s": 8})
        assert not any("over-excitation" in tr["reason"] for tr in r["trips"])

    def _smib_with_oos(self, oos_deg=100):
        proj = _smib()
        for comp in proj.components:
            if comp.type == "generator":
                comp.props["trip_oos_deg"] = oos_deg
                comp.props["trip_delay_s"] = 0.05
        return proj

    def test_out_of_step_trip(self):
        # A per-machine PROTECTIVE trip, distinct from the global first-swing
        # ``stable`` verdict: an above-CCT fault (already known unstable per
        # TestSMIBEqualArea, with OOS protection off) fires the out-of-step
        # relay and removes the machine BEFORE the full 180° pole-slip — so
        # the global verdict (which only judges live machines) can come back
        # ``True`` even though the generator itself has tripped off; that is
        # the point of the relay, not a contradiction.
        cct = run_transient_stability(_smib(), {"type": "fault", "bus": "bus_gen",
                                                "clear_time_s": 0.1, "find_cct": True,
                                                "t_end_s": 5})["cct_s"]
        r = run_transient_stability(self._smib_with_oos(), {"type": "fault", "bus": "bus_gen",
                                                             "clear_time_s": cct * 1.4,
                                                             "find_cct": False, "t_end_s": 5})
        assert any("out-of-step" in tr["reason"] and "generator trip" in tr["reason"]
                   for tr in r["trips"])

    def test_out_of_step_no_trip_when_stable(self):
        cct = run_transient_stability(_smib(), {"type": "fault", "bus": "bus_gen",
                                                "clear_time_s": 0.1, "find_cct": True,
                                                "t_end_s": 5})["cct_s"]
        r = run_transient_stability(self._smib_with_oos(), {"type": "fault", "bus": "bus_gen",
                                                             "clear_time_s": cct * 0.6,
                                                             "find_cct": False, "t_end_s": 5})
        assert r["stable"] is True
        assert not any("out-of-step" in tr["reason"] for tr in r["trips"])


class TestTwoAxis:
    """Two-axis (flux-decay) machine model with a field-driven exciter."""

    def _smib(self, model, avr="on", tdo=6.0):
        g = {"name": "G1", "rated_mva": 100, "voltage_kv": 11, "xd_p": 0.3,
             "xd_pp": 0.2, "x_r_ratio": 1000, "inertia_h_s": 3.5, "damping_pu": 0,
             "dispatch_mode": "must_run", "gov_mode": "none", "avr_mode": avr,
             "machine_model": model, "xd": 1.8, "xq": 1.7, "tdo_p": tdo, "tqo_p": 0.4}
        return ProjectData(projectName="s", baseMVA=100.0, frequency=50, components=[
            _c("util", "utility", {"name": "Grid", "voltage_kv": 11, "fault_mva": 1e7, "x_r_ratio": 1000}),
            _c("bi", "bus", {"name": "INF", "voltage_kv": 11}),
            _c("ln", "cable", {"name": "L", "voltage_kv": 11, "r_per_km": 0.0,
                               "x_per_km": 0.3 * (11 ** 2 / 100), "length_km": 1}),
            _c("bg", "bus", {"name": "GEN", "voltage_kv": 11}),
            _c("g1", "generator", g),
            _c("ld", "static_load", {"name": "LD", "voltage_kv": 11, "rated_kva": 60000, "power_factor": 1.0}),
        ], wires=[_w("w1", "util", "bi"), _w("w2", "bi", "ln"), _w("w3", "ln", "bg"),
                  _w("w4", "bg", "g1"), _w("w5", "bg", "ld")])

    def test_equilibrium_no_drift(self):
        # a two-axis machine at a 0% load step must hold its pre-fault angle
        r = run_transient_stability(self._smib("two_axis"),
                                    {"type": "load_step", "element": "ld",
                                     "delta_pct": 0, "time_s": 1, "t_end_s": 5})
        gi = r["curves"]["machines"].index("G1")
        dd = r["curves"]["delta_deg"][gi]
        assert max(abs(x - dd[0]) for x in dd) < 0.05

    def _cct(self, model, xq=None, **kw):
        p = self._smib(model, **kw)
        if xq is not None:
            for c in p.components:
                if c.id == "g1":
                    c.props["xq"] = xq
        return run_transient_stability(p, {"type": "fault", "bus": "bg",
                                           "clear_time_s": 0.1, "find_cct": True,
                                           "t_end_s": 5})["cct_s"]

    def test_classical_limit_reproduces_cct(self):
        """AVR off + a frozen field (T'do → ∞) ⇒ constant E′. The two models are
        then the SAME machine only when there is no transient saliency: the
        classical δ is the angle of E′ behind X′d, the two-axis δ is the angle
        of Eq behind the SYNCHRONOUS Xq. Drive Xq → X′d and they must agree
        exactly."""
        classical = self._cct("classical", xq=0.31, avr="off")
        twoax = self._cct("two_axis", xq=0.31, avr="off", tdo=1e6)
        assert classical is not None and twoax is not None
        assert twoax == pytest.approx(classical, rel=1e-6)

    def test_saliency_is_the_only_source_of_divergence(self):
        """With a real Xq the two constructions differ, and the gap closes
        monotonically as Xq → X′d — it is the rotor-angle reference, not the
        flux-decay dynamics. (This only became measurable after [D2] raised the
        fixture's machine from 0.25 pu to its true 0.85 pu loading, where the
        jXq·I term actually matters.)"""
        classical = self._cct("classical", avr="off")
        gaps = [abs(self._cct("two_axis", xq=xq, avr="off", tdo=1e6) - classical) / classical
                for xq in (1.8, 0.9, 0.35)]
        assert gaps[0] < 0.10                     # bounded even at 6:1 saliency
        assert gaps[0] > gaps[1] > gaps[2]        # and monotone in Xq
        assert gaps[2] < 1e-6

    def test_two_axis_runs_with_avr(self):
        r = run_transient_stability(self._smib("two_axis", avr="on"),
                                    {"type": "fault", "bus": "bg", "clear_time_s": 0.1,
                                     "find_cct": True, "t_end_s": 5})
        assert r["cct_s"] is not None and r["curves"] is not None


class TestSubTransient:
    """Sub-transient (d/q'') dynamics — opt-in refinement on top of two-axis.
    E''q/E''d relax toward E'q/E'd and are folded into the network EMF each
    step via an in-step fixed-point saliency (X''d != X''q) correction."""

    def _smib(self, sub=None, xq_pp=None, xd_pp=0.15, tdo_pp=0.03, tqo_pp=0.03, avr="on"):
        g = {"name": "G1", "rated_mva": 100, "voltage_kv": 11, "xd_p": 0.3,
             "xd_pp": xd_pp, "x_r_ratio": 1000, "inertia_h_s": 3.5, "damping_pu": 0,
             "dispatch_mode": "must_run", "gov_mode": "none", "avr_mode": avr,
             "machine_model": "two_axis", "xd": 1.8, "xq": 1.7, "tdo_p": 6.0, "tqo_p": 0.4}
        if sub is not None:
            g["subtransient_on"] = sub
            g["tdo_pp"] = tdo_pp
            g["tqo_pp"] = tqo_pp
            if xq_pp is not None:
                g["xq_pp"] = xq_pp
        return ProjectData(projectName="s", baseMVA=100.0, frequency=50, components=[
            _c("util", "utility", {"name": "Grid", "voltage_kv": 11, "fault_mva": 1e7, "x_r_ratio": 1000}),
            _c("bi", "bus", {"name": "INF", "voltage_kv": 11}),
            _c("ln", "cable", {"name": "L", "voltage_kv": 11, "r_per_km": 0.0,
                               "x_per_km": 0.3 * (11 ** 2 / 100), "length_km": 1}),
            _c("bg", "bus", {"name": "GEN", "voltage_kv": 11}),
            _c("g1", "generator", g),
            _c("ld", "static_load", {"name": "LD", "voltage_kv": 11, "rated_kva": 60000, "power_factor": 1.0}),
        ], wires=[_w("w1", "util", "bi"), _w("w2", "bi", "ln"), _w("w3", "ln", "bg"),
                  _w("w4", "bg", "g1"), _w("w5", "bg", "ld")])

    def _peak_angle(self, project, tc=0.3):
        r = run_transient_stability(project, {"type": "fault", "bus": "bg", "clear_time_s": tc,
                                              "find_cct": False, "t_end_s": 3})
        gi = r["curves"]["machines"].index("G1")
        return max(r["curves"]["delta_deg"][gi])

    def test_equilibrium_no_drift(self):
        # a sub-transient machine at a 0% load step must hold its pre-fault
        # angle — proves e2q0/e2d0's equilibrium derivation is exact.
        r = run_transient_stability(self._smib(sub="on", xq_pp=0.21),
                                    {"type": "load_step", "element": "ld",
                                     "delta_pct": 0, "time_s": 1, "t_end_s": 5})
        gi = r["curves"]["machines"].index("G1")
        dd = r["curves"]["delta_deg"][gi]
        assert max(abs(x - dd[0]) for x in dd) < 0.05

    def test_default_off_matches_two_axis_exactly(self):
        # subtransient_on left OFF must reproduce a plain two-axis project's
        # CCT exactly, even with unrelated sub-transient fields present and
        # set to values that would matter a lot if accidentally read.
        plain = run_transient_stability(self._smib(sub=None),
                                        {"type": "fault", "bus": "bg", "clear_time_s": 0.1,
                                         "find_cct": True, "t_end_s": 5})["cct_s"]
        off = run_transient_stability(self._smib(sub="off", xq_pp=0.4, tdo_pp=0.01, tqo_pp=0.01),
                                      {"type": "fault", "bus": "bg", "clear_time_s": 0.1,
                                       "find_cct": True, "t_end_s": 5})["cct_s"]
        assert plain is not None and off == plain

    def test_two_axis_runs_with_avr(self):
        r = run_transient_stability(self._smib(sub="on", xq_pp=0.21, avr="on"),
                                    {"type": "fault", "bus": "bg", "clear_time_s": 0.1,
                                     "find_cct": True, "t_end_s": 5})
        assert r["cct_s"] is not None and r["curves"] is not None

    def test_saliency_changes_the_swing(self):
        # Fixed Xd'', two Xq'' values (isotropic Xq''=Xd'' vs a salient-pole-
        # typical 1.4x split) at the SAME clearing time: the peak first-swing
        # angle must differ beyond numerical noise, proving the in-step
        # fixed-point saliency correction has a real, non-trivial effect
        # rather than silently collapsing to the isotropic case. (CCT itself
        # is too coarse a metric near a near-marginal case — it can plateau
        # across a parameter range even though the swing trajectory moves
        # continuously, so the peak angle is used directly.)
        iso = self._peak_angle(self._smib(sub="on", xq_pp=0.15))
        sal = self._peak_angle(self._smib(sub="on", xq_pp=0.21))
        assert abs(sal - iso) > 0.1

    def test_clamp_enforces_xpp_below_xp(self):
        # xd_pp set above xd_p must clamp rather than blow up / crash.
        r = run_transient_stability(self._smib(sub="on", xd_pp=0.5, tdo_pp=0.03, tqo_pp=0.03),
                                    {"type": "fault", "bus": "bg", "clear_time_s": 0.1,
                                     "find_cct": True, "t_end_s": 5})
        assert r["cct_s"] is not None and r["curves"] is not None


class TestGovernorModelEquilibrium:
    """Unit-level check that every advanced governor model's algebraic Pm
    output holds exactly at Pm0 (zero derivative) when every gx slot equals
    Pm0 and the droop+reset command is Pm0 — the pre-fault equilibrium
    _simulate initialises gx to, so a zero-magnitude disturbance shows no
    drift (mirrors TestTwoAxis.test_equilibrium_no_drift, at the model-math
    level instead of a full simulation)."""

    @pytest.mark.parametrize("gm,params", [
        ("degov1", {"Tg": 0.5, "td": 0.2}),
        ("gast", {"t1": 0.4, "t2": 0.1, "fuel_limit": 1.15}),
        ("tgov1", {"t1": 0.5, "t2": 2.5, "t3": 7.0}),
        ("hygov", {"Tg": 1.5, "tw": 1.0, "rt": 0.4, "dashpot_tr": 6.0}),
    ])
    def test_equilibrium_holds_pm(self, gm, params):
        from backend.analysis.transient_stability import _gov_advanced
        pm0 = 0.42
        dgx, pm_use = _gov_advanced(gm, pm0, [pm0, pm0, pm0], 0.0, 1.0, params)
        assert pm_use == pytest.approx(pm0, abs=1e-9)
        assert max(abs(x) for x in dgx) < 1e-9


class TestExciterModelEquilibrium:
    """Unit-level check that SEXS/ST1/AC hold Ef at efd_ref (zero derivative)
    at the pre-fault equilibrium (Vt = Vref, Vs = 0) — same rationale as
    TestGovernorModelEquilibrium above."""

    def test_sexs_holds_efd(self):
        from backend.analysis.transient_stability import _exc_advanced
        p = {"Ka": 25.0, "Ta": 0.2, "tb": 10.0, "tc": 1.0}
        efd_ref = 1.05
        _, de = _exc_advanced("sexs", 1.0, 1.0, 0.0, efd_ref, efd_ref, [1.0, 0.0, 0.0], p)
        assert de == pytest.approx(0.0, abs=1e-9)

    def test_st1_holds_efd(self):
        from backend.analysis.transient_stability import _exc_advanced
        p = {"Ka": 200.0, "tr": 0.02, "tb": 1.0, "tc": 1.0, "ta_st1": 0.02}
        efd_ref = 1.05
        _, de = _exc_advanced("st1", 1.0, 1.0, 0.0, efd_ref, efd_ref, [1.0, 0.0, 0.0], p)
        assert de == pytest.approx(0.0, abs=1e-9)

    def test_ac_holds_efd_and_saturates(self):
        from backend.analysis.transient_stability import _exc_advanced
        p = {"Ka": 50.0, "tr": 0.02, "ta_ac": 0.2, "ke": 1.0, "sat_a": 0.05, "sat_b": 0.8,
             "kf": 0.0, "tf": 1.0}
        efd_ref = 1.0
        se0 = p["sat_a"] * math.exp(p["sat_b"] * abs(efd_ref))
        p["ac_bias"] = (p["ke"] + se0) * efd_ref / p["Ka"]
        # At the true equilibrium (Vt=Vref, Ef=efd_ref) the derivative is zero —
        # this is the equilibrium the ac_bias term is solved to hold.
        _, de_eq = _exc_advanced("ac", 1.0, 1.0, 0.0, efd_ref, efd_ref, [1.0, efd_ref, 0.0], p)
        assert de_eq == pytest.approx(0.0, abs=1e-9)
        # Pushed well above its reference, self-excitation + saturation pull it
        # back down — the defining AC behaviour vs. ST1/SEXS's hard clip alone.
        _, de_high = _exc_advanced("ac", 1.0, 1.0, 0.0, 2.5, efd_ref, [1.0, 2.5, 0.0], p)
        assert de_high < 0


class TestAdvancedGovernors:
    """Standard governor/turbine block models (DEGOV1/GAST/TGOV1/HYGOV), full
    simulation. gov_mode (isochronous/droop/none) stays orthogonal to
    gov_model — every model must still recover frequency in isochronous mode."""

    def _loaded_island(self, gov_model, **extra):
        # Larger (MV-scale) machines than TestGovernor's LV island — this class
        # inspects pm_pu (system p.u. on the 100 MVA base) directly, which
        # needs enough absolute scale that the curve's 4-dp rounding doesn't
        # swamp the signal.
        g = lambda cid, nm: _c(cid, "generator", {
            "name": nm, "rated_mva": 10, "voltage_kv": 11, "xd_p": 0.25,
            "inertia_h_s": 2.0, "dispatch_mode": "must_run", "gov_mode": "isochronous",
            "gov_droop_pct": 4, "gov_time_const_s": 0.5, "gov_reset_time_s": 4,
            "gov_model": gov_model, **extra})
        comps = [
            _c("busg", "bus", {"name": "GenBus", "voltage_kv": 11}),
            _c("busl", "bus", {"name": "LoadBus", "voltage_kv": 11}),
            _c("fdr", "cable", {"name": "F", "voltage_kv": 11, "r_per_km": 0.2,
                                "x_per_km": 0.15, "length_km": 0.5}),
            g("g1", "G1"), g("g2", "G2"),
            _c("ld", "static_load", {"name": "Load", "voltage_kv": 11,
                                     "rated_kva": 15000, "power_factor": 0.9, "demand_factor": 1.0}),
        ]
        wires = [_w("wf1", "busg", "fdr"), _w("wf2", "fdr", "busl"),
                 _w("w1", "g1", "busg"), _w("w2", "g2", "busg"), _w("w3", "busl", "ld")]
        return ProjectData(projectName="advgov", baseMVA=100.0, frequency=50,
                           components=comps, wires=wires)

    def _run(self, gov_model, delta_pct=-40, t_end=25, **extra):
        return run_transient_stability(
            self._loaded_island(gov_model, **extra),
            {"type": "load_step", "element": "ld", "delta_pct": delta_pct, "time_s": 1, "t_end_s": t_end})

    @pytest.mark.parametrize("gov_model", ["degov1", "gast", "tgov1"])
    def test_isochronous_recovers_with_every_model(self, gov_model):
        # HYGOV is excluded here — see test_hygov_isochronous_is_sensitive_and_dips
        # below for why it gets its own, differently-scoped test.
        r = self._run(gov_model)
        f = r["curves"]["speed_hz"]
        gi = [i for i, n in enumerate(r["curves"]["machines"]) if n != "Utility"]
        assert r["stable"] is True
        assert max(abs(f[i][-1]) for i in gi) < 0.03   # recovers to ~nominal

    def test_default_gov_model_is_first_order(self):
        p = self._loaded_island("first_order")
        for c in p.components:
            if c.type == "generator":
                c.props.pop("gov_model", None)
        r = run_transient_stability(p, {"type": "load_step", "element": "ld",
                                        "delta_pct": -40, "time_s": 1, "t_end_s": 25})
        f = r["curves"]["speed_hz"]
        gi = [i for i, n in enumerate(r["curves"]["machines"]) if n != "Utility"]
        assert max(abs(f[i][-1]) for i in gi) < 0.02

    def test_degov1_delays_the_response(self):
        # DEGOV1's transport dead-time (0.2 s default) holds Pm nearer its
        # pre-step value in the first fraction of a second than first_order's
        # plain lag does, for an otherwise-identical governor.
        r_fo = self._run("first_order", delta_pct=40, t_end=6)
        r_de = self._run("degov1", delta_pct=40, t_end=6)
        gi_fo = r_fo["curves"]["machines"].index("G1")
        gi_de = r_de["curves"]["machines"].index("G1")
        t = r_fo["curves"]["t"]
        # first recorded sample at least 0.08s after the 1s step
        idx = next(i for i, tt in enumerate(t) if tt >= 1.08)
        pm_fo = r_fo["curves"]["pm_pu"][gi_fo]
        pm_de = r_de["curves"]["pm_pu"][gi_de]
        base_fo, base_de = pm_fo[0], pm_de[0]
        assert abs(pm_de[idx] - base_de) < abs(pm_fo[idx] - base_fo)

    def test_hygov_dips_before_rising(self):
        # Non-minimum-phase water column: on a load INCREASE the gate opens but
        # Pm briefly DIPS below its pre-step baseline before rising to meet the
        # higher demand — the classic hydro "power dips before it rises" shape.
        # This is HYGOV's defining, deliberately-tested behaviour. Full
        # isochronous convergence is NOT asserted for HYGOV anywhere in this
        # class (unlike DEGOV1/GAST/TGOV1 above): an isochronous integral
        # reset wrapped around a non-minimum-phase plant is a textbook-known
        # hard-to-tune combination — verified empirically across a wide
        # (temporary droop %, dashpot reset time, gate servo time) grid on
        # this aggressive small/fast test island, nothing found a
        # cleanly-converging response within a bounded window. Real hydro
        # sites lean on DROOP mode and/or site-specific tuning for exactly
        # this reason; the engine models the physics correctly (this test)
        # without claiming a universally-stable default isochronous tuning.
        r = self._run("hygov", delta_pct=60, t_end=8)
        gi = r["curves"]["machines"].index("G1")
        t = r["curves"]["t"]
        pm = r["curves"]["pm_pu"][gi]
        step_idx = next(i for i, tt in enumerate(t) if tt >= 1.0)
        baseline = pm[step_idx - 1] if step_idx > 0 else pm[0]
        window_end = next((i for i, tt in enumerate(t) if tt >= 2.5), len(t) - 1)
        dip = min(pm[step_idx:window_end])
        final = pm[-1]
        assert dip < baseline - 1e-4      # a real dip below the pre-step value
        assert final > baseline           # settles higher (load increased)


class TestAdvancedExciters:
    """Standard exciter block models (SEXS/ST1/AC), full simulation."""

    def _island(self, exc_model="first_order", **extra):
        g = _c("g1", "generator", {
            "name": "G1", "rated_mva": 0.5, "voltage_kv": 0.4, "xd_p": 0.25,
            "inertia_h_s": 2.0, "dispatch_mode": "must_run", "gov_mode": "isochronous",
            "avr_mode": "on", "avr_gain": 40, "avr_time_const_s": 0.1,
            "exc_model": exc_model, **extra})
        comps = [
            _c("busg", "bus", {"name": "GenBus", "voltage_kv": 0.4}),
            _c("busl", "bus", {"name": "LoadBus", "voltage_kv": 0.4}),
            _c("fdr", "cable", {"name": "F", "voltage_kv": 0.4, "r_per_km": 0.3,
                                "x_per_km": 0.15, "length_km": 0.1}),
            g,
            _c("ld", "static_load", {"name": "House", "voltage_kv": 0.4,
                                     "rated_kva": 200, "power_factor": 0.85, "demand_factor": 1.0}),
        ]
        wires = [_w("wf1", "busg", "fdr"), _w("wf2", "fdr", "busl"),
                 _w("w1", "g1", "busg"), _w("w2", "busl", "ld")]
        return ProjectData(projectName="advexc", baseMVA=100.0, frequency=50,
                           components=comps, wires=wires)

    def _loadbus_v(self, exc_model="first_order", **extra):
        r = run_transient_stability(self._island(exc_model, **extra),
                                    {"type": "load_step", "element": "ld",
                                     "delta_pct": 60, "time_s": 1, "t_end_s": 8})
        v = [b for b in r["curves"]["buses"] if b["bus"] == "LoadBus"][0]["v_pu"]
        return {"pre": v[0], "final": v[-1], "stable": r["stable"]}

    @pytest.mark.parametrize("exc_model", ["sexs", "st1", "ac"])
    def test_recovers_voltage_with_every_model(self, exc_model):
        s = self._loadbus_v(exc_model)
        off = self._loadbus_v("first_order", avr_mode="off")
        assert s["stable"]
        assert s["final"] > off["final"]

    def test_default_exc_model_is_first_order(self):
        p = self._island("first_order")
        for c in p.components:
            if c.type == "generator":
                c.props.pop("exc_model", None)
        r = run_transient_stability(p, {"type": "load_step", "element": "ld",
                                        "delta_pct": 60, "time_s": 1, "t_end_s": 8})
        v = [b for b in r["curves"]["buses"] if b["bus"] == "LoadBus"][0]["v_pu"]
        off = self._loadbus_v("first_order", avr_mode="off")
        assert v[-1] > off["final"]


class TestPSS:
    """Power system stabiliser: damps a lightly-damped (D=0), AVR-driven swing
    that would otherwise ring for the whole simulation window."""

    def _smib(self, pss_on, avr_gain=50):
        g = {"name": "G1", "rated_mva": 100, "voltage_kv": 11, "xd_p": 0.3,
             "xd_pp": 0.2, "x_r_ratio": 1000, "inertia_h_s": 3.5, "damping_pu": 0,
             "dispatch_mode": "must_run", "gov_mode": "none", "avr_mode": "on",
             "avr_gain": avr_gain, "avr_time_const_s": 0.05,
             "pss_on": pss_on, "pss_kstab": 15}
        return ProjectData(projectName="pss", baseMVA=100.0, frequency=50, components=[
            _c("util", "utility", {"name": "Grid", "voltage_kv": 11, "fault_mva": 1e7, "x_r_ratio": 1000}),
            _c("bi", "bus", {"name": "INF", "voltage_kv": 11}),
            _c("ln", "cable", {"name": "L", "voltage_kv": 11, "r_per_km": 0.0,
                               "x_per_km": 0.3 * (11 ** 2 / 100), "length_km": 1}),
            _c("bg", "bus", {"name": "GEN", "voltage_kv": 11}),
            _c("g1", "generator", g),
            _c("ld", "static_load", {"name": "LD", "voltage_kv": 11, "rated_kva": 60000, "power_factor": 1.0}),
        ], wires=[_w("w1", "util", "bi"), _w("w2", "bi", "ln"), _w("w3", "ln", "bg"),
                  _w("w4", "bg", "g1"), _w("w5", "bg", "ld")])

    def _envelope(self, pss_on):
        r = run_transient_stability(self._smib(pss_on),
                                    {"type": "fault", "bus": "bg", "clear_time_s": 0.08, "t_end_s": 10})
        gi = r["curves"]["machines"].index("G1")
        return r["stable"], r["curves"]["delta_deg"][gi]

    def test_pss_damps_the_swing(self):
        stable_off, dd_off = self._envelope("off")
        stable_on, dd_on = self._envelope("on")
        assert stable_off and stable_on
        half = len(dd_off) // 2
        base_off, base_on = dd_off[-1], dd_on[-1]
        env_off = max(abs(x - base_off) for x in dd_off[half:])
        env_on = max(abs(x - base_on) for x in dd_on[half:])
        assert env_on < env_off * 0.6

    def test_pss_default_off(self):
        p = self._smib("off")
        for c in p.components:
            if c.type == "generator":
                c.props.pop("pss_on", None)
        r_default = run_transient_stability(p, {"type": "fault", "bus": "bg",
                                                 "clear_time_s": 0.08, "t_end_s": 10})
        r_off = run_transient_stability(self._smib("off"), {"type": "fault", "bus": "bg",
                                                             "clear_time_s": 0.08, "t_end_s": 10})
        gi = r_default["curves"]["machines"].index("G1")
        assert r_default["curves"]["delta_deg"][gi] == r_off["curves"]["delta_deg"][gi]


class TestIBRGridForming:
    """Grid-forming inverter modelled as a virtual synchronous machine: it can
    hold an island on synthetic inertia + P-f droop, and its terminal current is
    clipped at I_max (unlike a synchronous machine's large fault contribution)."""

    def _gfm_island(self, ctrl="grid_forming", droop=5.0, h=3.0, imax=1.2):
        # BESS (grid-forming) — feeder — load bus. The load is on a SEPARATE bus
        # so a load step is seen through the network (a load on the source's own
        # bus is netted into its output and cannot be stepped).
        return ProjectData(projectName="gfm", baseMVA=100.0, frequency=50, components=[
            _c("bg", "bus", {"name": "MG", "voltage_kv": 0.4}),
            _c("bl", "bus", {"name": "LB", "voltage_kv": 0.4}),
            _c("f", "cable", {"name": "F", "voltage_kv": 0.4, "r_per_km": 0.05,
                              "x_per_km": 0.08, "length_km": 0.08}),
            _c("bat", "battery", {"name": "BESS", "rated_kva": 500, "voltage_kv": 0.4,
                                  "power_factor": 1.0, "battery_kwh": 1000,
                                  "battery_max_discharge_kw": 500, "battery_soc_pct": 100,
                                  "battery_mode": "discharging", "ibr_ctrl": ctrl,
                                  "ibr_inertia_h_s": h, "ibr_pf_droop_pct": droop,
                                  "ibr_xf_pu": 0.15, "ibr_imax_pu": imax}),
            _c("ld", "static_load", {"name": "Load", "voltage_kv": 0.4, "rated_kva": 150,
                                     "power_factor": 0.95, "demand_factor": 1.0}),
        ], wires=[_w("wb", "bat", "bg"), _w("wf1", "bg", "f"), _w("wf2", "f", "bl"),
                  _w("wl", "bl", "ld")])

    def _final_freq(self, r):
        return 50.0 + r["curves"]["speed_hz"][0][-1]

    def _early_min_freq(self, r, t=2.0):
        ts, sp = r["curves"]["t"], r["curves"]["speed_hz"][0]
        return 50.0 + min(sp[i] for i in range(len(ts)) if ts[i] <= t)

    def test_gfm_holds_island(self):
        r = run_transient_stability(self._gfm_island(),
                                    {"type": "load_step", "element": "ld",
                                     "delta_pct": 40, "time_s": 1, "t_end_s": 12})
        assert r["stable"] is True
        assert any(m["type"] == "gfm_inverter" for m in r["machines"])
        # droop control settles the island frequency at a bounded offset below
        # nominal (no secondary control returns it to 50 Hz) — it does NOT drift
        ff = self._final_freq(r)
        assert 49.0 < ff < 50.0

    def test_gfm_droop_offset_grows_with_droop(self):
        shallow = self._final_freq(run_transient_stability(
            self._gfm_island(droop=2.0), {"type": "load_step", "element": "ld",
                                          "delta_pct": 40, "time_s": 1, "t_end_s": 12}))
        steep = self._final_freq(run_transient_stability(
            self._gfm_island(droop=8.0), {"type": "load_step", "element": "ld",
                                          "delta_pct": 40, "time_s": 1, "t_end_s": 12}))
        assert steep < shallow < 50.0        # a larger droop % ⇒ a deeper offset

    def test_synthetic_inertia_shallows_the_dip(self):
        lo = run_transient_stability(self._gfm_island(h=1.0),
                                     {"type": "load_step", "element": "ld",
                                      "delta_pct": 40, "time_s": 1, "t_end_s": 6})
        hi = run_transient_stability(self._gfm_island(h=6.0),
                                     {"type": "load_step", "element": "ld",
                                      "delta_pct": 40, "time_s": 1, "t_end_s": 6})
        # more synthetic inertia ⇒ a slower rate of change of frequency ⇒ a
        # shallower initial excursion
        assert self._early_min_freq(hi) > self._early_min_freq(lo)

    def test_current_clipped_at_imax(self):
        # A close-in fault: the converter current is held at its limit, not the
        # 5–15× a synchronous machine would push.
        def peak(imax):
            r = run_transient_stability(self._gfm_island(imax=imax),
                                        {"type": "fault", "bus": "bl", "clear_time_s": 0.12,
                                         "find_cct": False, "t_end_s": 2})
            m = next(x for x in r["machines"] if x["type"] == "gfm_inverter")
            return m["peak_current_pu"]
        p_low, p_high = peak(1.1), peak(5.0)
        assert p_low == pytest.approx(1.1, abs=0.15)   # bounded right at the limit
        assert p_high > p_low + 1.0                    # a higher limit ⇒ more current

    def test_frozen_default_is_not_a_machine(self):
        # ibr_ctrl absent (frozen) ⇒ the inverter stays a constant admittance,
        # is not collected as a swing machine and raises no IBR-dynamics note.
        p = ProjectData(projectName="fz", baseMVA=100.0, frequency=50, components=[
            _c("util", "utility", {"name": "Grid", "voltage_kv": 0.4, "fault_mva": 500}),
            _c("b", "bus", {"name": "B", "voltage_kv": 0.4}),
            _c("pv", "solar_pv", {"name": "PV", "rated_kw": 100, "voltage_kv": 0.4,
                                  "num_inverters": 1, "power_factor": 1.0}),
            _c("ld", "static_load", {"name": "L", "voltage_kv": 0.4, "rated_kva": 200,
                                     "power_factor": 0.95, "demand_factor": 1.0}),
        ], wires=[_w("w1", "util", "b"), _w("wp", "pv", "b"), _w("wl", "b", "ld")])
        r = run_transient_stability(p, {"type": "load_step", "element": "ld",
                                        "delta_pct": 20, "time_s": 1, "t_end_s": 3})
        assert not any(m["type"] == "gfm_inverter" for m in r["machines"])
        assert not any("PV" == m["name"] for m in r["machines"])
        assert not any("inverter" in w for w in r["warnings"])


class TestIBRGridFollowing:
    """Grid-following inverter: a current-limited bus injection that holds its
    dispatched power with fast frequency response and rides through / trips on
    sustained under-voltage."""

    def _gfl_genset_island(self, ffr=0.0):
        # A gov-less genset (frequency drifts on its own) plus a grid-following
        # BESS with fast frequency response, feeding a separate load bus.
        return ProjectData(projectName="gfl", baseMVA=100.0, frequency=50, components=[
            _c("bg", "bus", {"name": "GB", "voltage_kv": 0.4}),
            _c("bl", "bus", {"name": "LB", "voltage_kv": 0.4}),
            _c("f", "cable", {"name": "F", "voltage_kv": 0.4, "r_per_km": 0.05,
                              "x_per_km": 0.05, "length_km": 0.05}),
            _c("g1", "generator", {"name": "G1", "rated_mva": 0.5, "voltage_kv": 0.4,
                                   "xd_p": 0.25, "inertia_h_s": 1.5,
                                   "dispatch_mode": "must_run", "gov_mode": "none"}),
            _c("bat", "battery", {"name": "BESS", "rated_kva": 300, "voltage_kv": 0.4,
                                  "power_factor": 1.0, "battery_kwh": 500,
                                  "battery_max_discharge_kw": 150, "battery_soc_pct": 100,
                                  "battery_mode": "discharging", "ibr_ctrl": "grid_following",
                                  "ibr_ffr_droop_pct": ffr, "ibr_imax_pu": 1.5}),
            _c("ld", "static_load", {"name": "Load", "voltage_kv": 0.4, "rated_kva": 250,
                                     "power_factor": 0.95, "demand_factor": 1.0}),
        ], wires=[_w("wg", "g1", "bg"), _w("wb", "bat", "bg"), _w("wf1", "bg", "f"),
                  _w("wf2", "f", "bl"), _w("wl", "bl", "ld")])

    def _min_freq(self, r):
        import itertools
        return 50.0 + min(itertools.chain(*r["curves"]["speed_hz"]))

    def test_fast_frequency_response_arrests_decline(self):
        no_ffr = run_transient_stability(self._gfl_genset_island(ffr=0.0),
                                         {"type": "load_step", "element": "ld",
                                          "delta_pct": 30, "time_s": 1, "t_end_s": 10})
        with_ffr = run_transient_stability(self._gfl_genset_island(ffr=4.0),
                                           {"type": "load_step", "element": "ld",
                                            "delta_pct": 30, "time_s": 1, "t_end_s": 10})
        # the gov-less genset alone collapses; FFR from the battery holds it up
        assert self._min_freq(with_ffr) > self._min_freq(no_ffr) + 5.0
        assert any("grid-following inverter" in w for w in with_ffr["warnings"])

    def _gfl_grid(self, uv=0.15, delay=0.5, qv=2.0):
        return ProjectData(projectName="gflf", baseMVA=100.0, frequency=50, components=[
            _c("util", "utility", {"name": "Grid", "voltage_kv": 11, "fault_mva": 500, "x_r_ratio": 10}),
            _c("bi", "bus", {"name": "POC", "voltage_kv": 11}),
            _c("tx", "transformer", {"name": "TX", "rated_mva": 5, "voltage_kv": 11,
                                     "secondary_kv": 0.4, "impedance_pct": 6, "x_r_ratio": 10}),
            _c("bl", "bus", {"name": "LV", "voltage_kv": 0.4}),
            _c("f2", "cable", {"name": "F", "voltage_kv": 0.4, "r_per_km": 0.05,
                               "x_per_km": 0.05, "length_km": 0.05}),
            _c("bp", "bus", {"name": "PVB", "voltage_kv": 0.4}),
            _c("pv", "solar_pv", {"name": "PV", "rated_kw": 1000, "voltage_kv": 0.4,
                                  "num_inverters": 1, "power_factor": 1.0,
                                  "ibr_ctrl": "grid_following", "ibr_imax_pu": 1.2,
                                  "ibr_qv_gain": qv, "ibr_uv_pu": uv, "ibr_trip_delay_s": delay}),
            _c("ld", "static_load", {"name": "L", "voltage_kv": 0.4, "rated_kva": 800,
                                     "power_factor": 0.9, "demand_factor": 1.0}),
        ], wires=[_w("w1", "util", "bi"), _w("w2", "bi", "tx"), _w("w3", "tx", "bl"),
                  _w("wl", "bl", "ld"), _w("wf1", "bl", "f2"), _w("wf2", "f2", "bp"),
                  _w("wp", "pv", "bp")])

    def test_rides_through_cleared_fault(self):
        # a ride-through window longer than the fault clearing time ⇒ no trip
        r = run_transient_stability(self._gfl_grid(uv=0.15, delay=0.5),
                                    {"type": "fault", "bus": "bl", "clear_time_s": 0.15,
                                     "find_cct": False, "t_end_s": 3})
        assert r["stable"] is True
        assert r["trips"] == []

    def test_trips_on_aggressive_ride_through(self):
        # a short delay / high threshold ⇒ the inverter drops out on the dip
        r = run_transient_stability(self._gfl_grid(uv=0.5, delay=0.05),
                                    {"type": "fault", "bus": "bl", "clear_time_s": 0.3,
                                     "find_cct": False, "t_end_s": 3})
        assert any("ride-through trip" in tr["reason"] and tr["element"] == "PV"
                   for tr in r["trips"])


class TestFrequencyStability:
    """The verdict flags a frequency collapse / run-away separately from rotor-
    angle loss of synchronism: an overloaded or governor-less island whose
    frequency runs off and does not recover is UNSTABLE even though the machines
    stay in step with each other."""

    def _island(self, gen_mva=(0.1, 0.05), load_kva=100, gov="isochronous"):
        g = lambda cid, nm, mva: _c(cid, "generator", {
            "name": nm, "rated_mva": mva, "voltage_kv": 0.4, "xd_p": 0.25,
            "inertia_h_s": 2.0, "dispatch_mode": "must_run", "gov_mode": gov})
        return ProjectData(projectName="fs", baseMVA=100.0, frequency=50, components=[
            _c("busg", "bus", {"name": "GenBus", "voltage_kv": 0.4}),
            _c("busl", "bus", {"name": "LoadBus", "voltage_kv": 0.4}),
            _c("fdr", "cable", {"name": "F", "voltage_kv": 0.4, "r_per_km": 0.05,
                                "x_per_km": 0.05, "length_km": 0.05}),
            g("g1", "G1", gen_mva[0]), g("g2", "G2", gen_mva[1]),
            _c("ld", "static_load", {"name": "House", "voltage_kv": 0.4,
                                     "rated_kva": load_kva, "power_factor": 0.9, "demand_factor": 1.0}),
        ], wires=[_w("wf1", "busg", "fdr"), _w("wf2", "fdr", "busl"),
                  _w("w1", "g1", "busg"), _w("w2", "g2", "busg"), _w("w3", "busl", "ld")])

    def test_overloaded_island_frequency_collapse_is_unstable(self):
        # 150 kVA of gensets, +100% step takes the load past their capacity: the
        # frequency collapses while the machines stay in synchronism (small δ).
        r = run_transient_stability(self._island(),
                                    {"type": "load_step", "element": "ld",
                                     "delta_pct": 100, "time_s": 1, "t_end_s": 12})
        assert r["stable"] is False
        assert r["instability"] == "frequency collapse"
        # synchronism actually held — this is a frequency, not an angle, failure
        assert max(abs(m["peak_angle_deg"]) for m in r["machines"]
                   if m["type"] == "generator") < 90.0
        assert any("frequency collapse" in w for w in r["warnings"])

    def test_governed_island_within_capacity_is_stable(self):
        # a modest step the isochronous governors can follow ⇒ recovers ⇒ stable
        r = run_transient_stability(self._island(gen_mva=(0.2, 0.1), load_kva=80),
                                    {"type": "load_step", "element": "ld",
                                     "delta_pct": 20, "time_s": 1, "t_end_s": 20})
        assert r["stable"] is True
        assert r["instability"] is None

    def test_grid_connected_fault_not_frequency_flagged(self):
        # an infinite bus anchors the frequency, so a cleared fault is judged on
        # rotor-angle synchronism only — no spurious frequency-instability verdict
        r = run_transient_stability(_smib(), {"type": "fault", "bus": "bus_gen",
                                              "clear_time_s": 0.1, "find_cct": False, "t_end_s": 5})
        assert r["stable"] is True
        assert r["instability"] is None

    def test_loss_of_synchronism_reason(self):
        # a fault cleared well beyond the CCT slips a pole ⇒ angle instability,
        # reported as "loss of synchronism" (not a frequency reason)
        r = run_transient_stability(_smib(), {"type": "fault", "bus": "bus_gen",
                                              "clear_time_s": 0.9, "find_cct": False, "t_end_s": 5})
        assert r["stable"] is False
        assert r["instability"] == "loss of synchronism"


class TestDispatchAllocation:
    """Pre-fault mechanical power follows each machine's actual load-flow
    dispatch, not an equal per-bus split — so a bus-mate the load flow leaves
    uncommitted / balancing near zero is not handed half the load it was never
    dispatched to carry."""

    def _shared_bus_island(self):
        # Two gensets parallel on ONE gen bus feeding a separate load bus. The
        # load flow commits them asymmetrically (one carries the load, one
        # balances near zero) — the equal per-bus split would have given them
        # ~half each regardless.
        g = lambda cid, nm, mode: _c(cid, "generator", {
            "name": nm, "rated_mva": 0.5, "voltage_kv": 0.4, "xd_p": 0.25,
            "inertia_h_s": 2.0, "dispatch_mode": mode, "gov_mode": "isochronous"})
        return ProjectData(projectName="da", baseMVA=100.0, frequency=50, components=[
            _c("bg", "bus", {"name": "GB", "voltage_kv": 0.4}),
            _c("bl", "bus", {"name": "LB", "voltage_kv": 0.4}),
            _c("f", "cable", {"name": "F", "voltage_kv": 0.4, "r_per_km": 0.05,
                              "x_per_km": 0.05, "length_km": 0.05}),
            g("g1", "G1", "must_run"), g("g2", "G2", "standby"),
            _c("ld", "static_load", {"name": "L", "voltage_kv": 0.4, "rated_kva": 200,
                                     "power_factor": 0.9, "demand_factor": 1.0}),
        ], wires=[_w("w1", "g1", "bg"), _w("w2", "g2", "bg"), _w("wf1", "bg", "f"),
                  _w("wf2", "f", "bl"), _w("wl", "bl", "ld")])

    def test_prefault_power_follows_dispatch_not_equal_split(self):
        r = run_transient_stability(self._shared_bus_island(),
                                    {"type": "load_step", "element": "ld",
                                     "delta_pct": 10, "time_s": 1, "t_end_s": 6})
        pms = sorted(abs(m["pm_pu"]) for m in r["machines"] if m["type"] == "generator")
        assert len(pms) == 2 and sum(pms) > 1e-4          # the island carries load
        # dispatch-driven: one set carries it, the other ~idles. An equal per-bus
        # split would have made these two nearly equal (pms[0] ≈ pms[1]).
        assert pms[0] < 0.15 * pms[1]


class TestSequencedEvents:
    """A timeline of events at absolute times: trip / reconnect a feeder, shed /
    restore / step a load, trip a generator — applied cumulatively, one element
    per step (same-time steps share a segment)."""

    def _net(self):
        # Grid + generator on a source bus; two parallel feeders to a load bus.
        return ProjectData(projectName="seq", baseMVA=100.0, frequency=50, components=[
            _c("util", "utility", {"name": "Grid", "voltage_kv": 11, "fault_mva": 800, "x_r_ratio": 10}),
            _c("bs", "bus", {"name": "Src", "voltage_kv": 11}),
            _c("g1", "generator", {"name": "G1", "rated_mva": 10, "voltage_kv": 11, "xd_p": 0.25,
                                   "inertia_h_s": 3.0, "dispatch_mode": "must_run", "gov_mode": "isochronous"}),
            _c("f1", "cable", {"name": "Feeder1", "voltage_kv": 11, "r_per_km": 0.2, "x_per_km": 0.15, "length_km": 3}),
            _c("f2", "cable", {"name": "Feeder2", "voltage_kv": 11, "r_per_km": 0.2, "x_per_km": 0.15, "length_km": 3}),
            _c("bl", "bus", {"name": "LoadBus", "voltage_kv": 11}),
            _c("ld", "static_load", {"name": "Plant", "voltage_kv": 11, "rated_kva": 3000,
                                     "power_factor": 0.9, "demand_factor": 1.0}),
        ], wires=[_w("wu", "util", "bs"), _w("wg", "g1", "bs"),
                  _w("wf1a", "bs", "f1"), _w("wf1b", "f1", "bl"),
                  _w("wf2a", "bs", "f2"), _w("wf2b", "f2", "bl"), _w("wl", "bl", "ld")])

    def _lv(self, r, tt):
        t = r["curves"]["t"]
        v = [b for b in r["curves"]["buses"] if b["bus"] == "LoadBus"][0]["v_pu"]
        return v[min(range(len(t)), key=lambda i: abs(t[i] - tt))]

    def test_load_shed_then_restore(self):
        r = run_transient_stability(self._net(), {"type": "sequence", "t_end_s": 8, "steps": [
            {"t": 1.0, "action": "trip", "element": "ld"},
            {"t": 4.0, "action": "close", "element": "ld"}]})
        assert r["stable"] is True
        assert "shed Plant" in r["event"] and "restore Plant" in r["event"]
        # shedding the load raises the load-bus voltage; restoring pulls it back
        assert self._lv(r, 2.5) > self._lv(r, 0.5) + 0.003
        assert self._lv(r, 6.0) < self._lv(r, 2.5) - 0.003

    def test_feeder_trip_and_reclose(self):
        r = run_transient_stability(self._net(), {"type": "sequence", "t_end_s": 8, "steps": [
            {"t": 1.0, "action": "trip", "element": "f1"},
            {"t": 4.0, "action": "close", "element": "f1"}]})
        assert r["stable"] is True and r["curves"] is not None
        assert "open Feeder1" in r["event"] and "close Feeder1" in r["event"]
        # losing one of two parallel feeders raises impedance ⇒ lower load-bus V;
        # reclosing restores it
        assert self._lv(r, 2.5) < self._lv(r, 0.5) - 0.003
        assert self._lv(r, 6.0) > self._lv(r, 2.5) + 0.003

    def test_generator_is_trip_only(self):
        r = run_transient_stability(self._net(), {"type": "sequence", "t_end_s": 4, "steps": [
            {"t": 1.0, "action": "close", "element": "g1"}]})
        assert any("trip-only" in w for w in r["warnings"])

    def test_sequence_auto_reclose_matches_manual(self):
        # A "trip" step with reclose_delay_s (no manual "close" step) must
        # synthesize the same segment a hand-scheduled close would — same
        # voltage-recovery signature as test_feeder_trip_and_reclose.
        r = run_transient_stability(self._net(), {"type": "sequence", "t_end_s": 8, "steps": [
            {"t": 1.0, "action": "trip", "element": "f1", "reclose_delay_s": 3.0}]})
        assert r["stable"] is True and r["curves"] is not None
        assert "open Feeder1" in r["event"] and "close Feeder1" in r["event"]
        assert self._lv(r, 2.5) < self._lv(r, 0.5) - 0.003
        assert self._lv(r, 6.0) > self._lv(r, 2.5) + 0.003

    def test_sequence_reclose_ignored_without_delay(self):
        r = run_transient_stability(self._net(), {"type": "sequence", "t_end_s": 4, "steps": [
            {"t": 1.0, "action": "trip", "element": "f1"}]})
        assert r["event"].count("Feeder1") == 1   # only the open, no synthesized close

    def test_fault_trip_and_auto_reclose(self):
        r = run_transient_stability(self._net(), {
            "type": "fault", "bus": "bs", "clear_time_s": 0.1, "trip_element": "f1",
            "reclose_delay_s": 2.0, "find_cct": False, "t_end_s": 8})
        assert "reclosing at 2100 ms" in r["event"]
        # single feeder after the fault-clearing trip ⇒ lower load-bus V than
        # after the dead-time auto-reclose restores the parallel feeder
        assert self._lv(r, 1.0) < self._lv(r, 4.0) - 0.003

    def test_fault_no_reclose_without_delay(self):
        r = run_transient_stability(self._net(), {
            "type": "fault", "bus": "bs", "clear_time_s": 0.1, "trip_element": "f1",
            "find_cct": False, "t_end_s": 8})
        assert "reclosing at" not in r["event"]

    def test_multiple_feeders_and_load_step(self):
        r = run_transient_stability(self._net(), {"type": "sequence", "t_end_s": 8, "steps": [
            {"t": 1.0, "action": "trip", "element": "f1"},
            {"t": 2.0, "action": "load_step", "element": "ld", "delta_pct": 30},
            {"t": 4.0, "action": "close", "element": "f1"}]})
        assert r["curves"] is not None
        # steps are time-ordered in the event description
        assert (r["event"].index("open Feeder1") < r["event"].index("Plant +30%")
                < r["event"].index("close Feeder1"))

    def test_simultaneous_steps_share_a_segment(self):
        r = run_transient_stability(self._net(), {"type": "sequence", "t_end_s": 5, "steps": [
            {"t": 1.0, "action": "trip", "element": "f1"},
            {"t": 1.0, "action": "trip", "element": "f2"}]})
        assert "open Feeder1" in r["event"] and "open Feeder2" in r["event"]

    def test_empty_sequence_raises(self):
        with pytest.raises(ValueError):
            run_transient_stability(self._net(), {"type": "sequence", "steps": []})


class TestOvercurrentRelay:
    """50/51/67 overcurrent relay tripping (BACKLOG #11 — the last remaining
    transient-stability protection function). A relay resolves its monitored
    branch via associated_ct (the SAME association arc-flash/TCC use) and
    accumulates an operate-time integral (dt/t_operate(I), the standard
    inverse-time-relay emulation for a current that can itself evolve during
    the run) against arcflash._relay_operate_time's IDMT curve, tripping its
    trip_cb once the accumulator reaches 1.0."""

    def _feeder(self, pickup_a=1000, curve="Definite Time", time_dial=0.3,
               relay_type="50/51", direction="forward", ct_ratio="50000/5",
               parallel_feeder=False):
        comps = [
            _c("util", "utility", {"name": "Grid", "voltage_kv": 11, "fault_mva": 1e6,
                                   "x_r_ratio": 1000}),
            _c("bus_src", "bus", {"name": "SRC", "voltage_kv": 11}),
            _c("cb1", "cb", {"name": "CB1", "state": "closed", "trip_rating_a": 630,
                             "magnetic_pickup": 100, "long_time_delay": 10}),
            _c("ct1", "ct", {"name": "CT1", "ratio": ct_ratio}),
            _c("cable1", "cable", {"name": "F1", "voltage_kv": 11, "r_per_km": 0.2,
                                   "x_per_km": 0.08, "length_km": 1}),
            _c("bus_load", "bus", {"name": "LOAD", "voltage_kv": 11}),
            _c("ld", "static_load", {"name": "LD", "voltage_kv": 11, "rated_kva": 500,
                                     "power_factor": 0.95, "demand_factor": 1.0}),
            _c("relay1", "relay", {
                "name": "R1", "relay_type": relay_type, "associated_ct": "ct1",
                "trip_cb": "cb1", "pickup_a": pickup_a, "curve": curve,
                "time_dial": time_dial, "inst_pickup_a": 0,
                "direction": direction, "characteristic_angle_deg": 45}),
        ]
        wires = [_w("w1", "util", "bus_src"), _w("w2", "bus_src", "cb1"),
                _w("w3", "cb1", "ct1"), _w("w4", "ct1", "cable1"),
                _w("w5", "cable1", "bus_load"),
                Wire(id="wl", fromComponent="ld", fromPort="in",
                     toComponent="bus_load", toPort="at_0")]
        if parallel_feeder:
            comps.append(_c("cable_par", "cable", {"name": "Fpar", "voltage_kv": 11,
                                                    "r_per_km": 0.2, "x_per_km": 0.08,
                                                    "length_km": 1}))
            wires += [_w("w6", "bus_src", "cable_par"), _w("w7", "cable_par", "bus_load")]
        return ProjectData(projectName="p", baseMVA=100.0, frequency=50,
                           components=comps, wires=wires)

    def _fault(self, extra=None):
        d = {"type": "fault", "bus": "bus_load", "clear_time_s": 5.0,
             "t_end_s": 1.0, "find_cct": False}
        d.update(extra or {})
        return d

    def test_trips_on_sustained_overcurrent(self):
        r = run_transient_stability(self._feeder(pickup_a=200), self._fault())
        assert any(tr["element"] == "CB1" and "overcurrent" in tr["reason"]
                   for tr in r["trips"])

    def test_no_trip_below_pickup(self):
        r = run_transient_stability(self._feeder(pickup_a=50000), self._fault())
        assert r["trips"] == []

    def test_idmt_operate_time_matches_closed_form(self):
        # No CT saturation at this current (50000/5 CT, well above the ~29 kA
        # fault level) so the accumulator's trip time should match
        # _relay_operate_time's closed form directly.
        proj = self._feeder(pickup_a=1000, curve="IEC Standard Inverse", time_dial=0.3)
        r = run_transient_stability(proj, self._fault({"dt_s": 0.001}))
        assert len(r["trips"]) == 1
        t_trip = r["trips"][0]["t"]
        current_a = float(r["trips"][0]["reason"].split("at ")[1].split(" A")[0])
        t_expected = _relay_operate_time(
            {"pickup_a": 1000, "curve": "IEC Standard Inverse", "time_dial": 0.3,
             "inst_pickup_a": 0}, current_a)
        assert t_trip == pytest.approx(t_expected, abs=0.01)

    def test_higher_multiple_of_pickup_trips_faster(self):
        r_close = run_transient_stability(
            self._feeder(pickup_a=200, curve="IEC Very Inverse", time_dial=0.2),
            self._fault({"dt_s": 0.001}))
        r_far = run_transient_stability(
            self._feeder(pickup_a=10000, curve="IEC Very Inverse", time_dial=0.2),
            self._fault({"dt_s": 0.001, "t_end_s": 3.0}))
        assert r_close["trips"] and r_far["trips"]
        assert r_close["trips"][0]["t"] < r_far["trips"][0]["t"]

    def test_directional_relay_blocks_reverse_flow(self):
        r = run_transient_stability(
            self._feeder(pickup_a=1000, curve="Definite Time", time_dial=0.2,
                        relay_type="67", direction="reverse"),
            self._fault())
        assert r["trips"] == []

    def test_directional_relay_trips_forward_flow(self):
        r = run_transient_stability(
            self._feeder(pickup_a=1000, curve="Definite Time", time_dial=0.2,
                        relay_type="67", direction="forward"),
            self._fault())
        assert any("overcurrent" in tr["reason"] for tr in r["trips"])

    def test_interaction_with_scripted_sequence_trip(self):
        # A scripted trip on a DIFFERENT branch (the parallel feeder) plus a
        # live relay trip on cb1's branch in the same run — validates that
        # _effective_variant's ybus_trip_cache correctly unions the segment's
        # own removed-id set with the relay-tripped CB rather than one
        # silently overwriting the other.
        proj = self._feeder(pickup_a=500, curve="Definite Time", time_dial=0.15,
                            ct_ratio="2000/5", parallel_feeder=True)
        for comp in proj.components:
            if comp.id == "ld":
                comp.props["rated_kva"] = 2000
        disturbance = {"type": "sequence", "t_end_s": 1.0, "dt_s": 0.001, "steps": [
            {"t": 0.05, "action": "trip", "element": "cable_par"},
            {"t": 0.1, "action": "load_step", "element": "ld", "delta_pct": 900}]}
        r = run_transient_stability(proj, disturbance)
        assert "open Fpar" in r["event"]
        assert any(tr["element"] == "CB1" and "overcurrent" in tr["reason"]
                   for tr in r["trips"])

    def test_unresolvable_ct_is_skipped_with_warning(self):
        # associated_ct points to a CT that isn't wired into the network at
        # all — no branch to resolve, so the relay is skipped (not fatal).
        proj = self._feeder(pickup_a=200)
        proj.components.append(_c("ct_orphan", "ct", {"name": "Orphan CT", "ratio": "400/5"}))
        for comp in proj.components:
            if comp.id == "relay1":
                comp.props["associated_ct"] = "ct_orphan"
        r = run_transient_stability(proj, self._fault())
        assert r["trips"] == []
        assert any("skipped" in w for w in r["warnings"])


class TestDistanceRelay:
    """Distance (21) relay tripping (BACKLOG #11 — the last remaining
    transient-stability protection function). Unlike the frontend TCC/arc-
    flash path, which has no complex bus voltage to work with and so
    converts each mho zone's ohmic reach to an equivalent current threshold
    (buildDistanceRelayZones in constants.js), this engine evaluates the
    real self-polarized mho characteristic (Z = V/I against a circle through
    the origin) every step, with each zone timed independently.

    Feeder: util — bus_src — cb1(+ct1) — cable1 (0.2+j0.08 Ω/km, 1 km) —
    bus_load(+load). A bolted 3-φ fault at bus_load forces bus_load to 0 V,
    so the relay's apparent impedance is exactly the cable impedance
    (Z_line ≈ 0.215 Ω ∠21.8°) — the textbook close-in-fault result for a
    radial feeder."""

    def _feeder(self, z1_reach=0.0, z1_delay=0.0, z2_reach=0.0, z2_delay=0.3,
               z3_reach=0.0, z3_delay=0.8, z3_reverse=False, mho_angle=75):
        comps = [
            _c("util", "utility", {"name": "Grid", "voltage_kv": 11, "fault_mva": 1e6,
                                   "x_r_ratio": 1000}),
            _c("bus_src", "bus", {"name": "SRC", "voltage_kv": 11}),
            _c("cb1", "cb", {"name": "CB1", "state": "closed", "trip_rating_a": 630,
                             "magnetic_pickup": 100, "long_time_delay": 10}),
            _c("ct1", "ct", {"name": "CT1", "ratio": "2000/5"}),
            _c("cable1", "cable", {"name": "F1", "voltage_kv": 11, "r_per_km": 0.2,
                                   "x_per_km": 0.08, "length_km": 1}),
            _c("bus_load", "bus", {"name": "LOAD", "voltage_kv": 11}),
            _c("ld", "static_load", {"name": "LD", "voltage_kv": 11, "rated_kva": 500,
                                     "power_factor": 0.95, "demand_factor": 1.0}),
            _c("relay1", "relay", {
                "name": "R1", "relay_type": "21", "associated_ct": "ct1",
                "trip_cb": "cb1", "voltage_kv": 11,
                "z1_reach_ohm": z1_reach, "z1_delay_s": z1_delay,
                "z2_reach_ohm": z2_reach, "z2_delay_s": z2_delay,
                "z3_reach_ohm": z3_reach, "z3_delay_s": z3_delay,
                "z3_reverse": z3_reverse, "mho_angle_deg": mho_angle}),
        ]
        wires = [_w("w1", "util", "bus_src"), _w("w2", "bus_src", "cb1"),
                _w("w3", "cb1", "ct1"), _w("w4", "ct1", "cable1"),
                _w("w5", "cable1", "bus_load"),
                Wire(id="wl", fromComponent="ld", fromPort="in",
                     toComponent="bus_load", toPort="at_0")]
        return ProjectData(projectName="p", baseMVA=100.0, frequency=50,
                           components=comps, wires=wires)

    def _fault(self, extra=None):
        d = {"type": "fault", "bus": "bus_load", "clear_time_s": 5.0,
             "t_end_s": 1.0, "find_cct": False, "dt_s": 0.005}
        d.update(extra or {})
        return d

    def test_trips_zone1_on_close_in_fault(self):
        # Z1 reach (1.0 Ω) well beyond the ~0.215 Ω apparent line impedance.
        r = run_transient_stability(self._feeder(z1_reach=1.0, z1_delay=0.0),
                                    self._fault())
        assert any(tr["element"] == "CB1" and "distance trip" in tr["reason"]
                   and "zone Z1" in tr["reason"] for tr in r["trips"])

    def test_no_trip_when_fault_beyond_all_zone_reach(self):
        # Z1 reach (0.02 Ω) far short of the ~0.215 Ω apparent impedance;
        # Z2/Z3 disabled (reach 0 ⇒ not modelled).
        r = run_transient_stability(self._feeder(z1_reach=0.02, z1_delay=0.0),
                                    self._fault())
        assert r["trips"] == []

    def test_zone2_trips_after_its_own_delay_when_beyond_zone1(self):
        r = run_transient_stability(
            self._feeder(z1_reach=0.02, z1_delay=0.0, z2_reach=1.0, z2_delay=0.3),
            self._fault())
        trips = [tr for tr in r["trips"] if tr["element"] == "CB1"]
        assert len(trips) == 1
        assert "zone Z2" in trips[0]["reason"]
        assert trips[0]["t"] == pytest.approx(0.3, abs=0.02)

    def test_forward_zone3_sees_the_fault_when_not_reversed(self):
        r = run_transient_stability(
            self._feeder(z3_reach=1.0, z3_delay=0.1, z3_reverse=False),
            self._fault())
        assert any("zone Z3" in tr["reason"] for tr in r["trips"])

    def test_reverse_zone3_does_not_see_a_forward_fault(self):
        # Same zone, aimed backward via z3_reverse — the mho circle's
        # inherent directionality (it passes through the origin) must
        # exclude a fault in front of the relay.
        r = run_transient_stability(
            self._feeder(z3_reach=1.0, z3_delay=0.1, z3_reverse=True),
            self._fault())
        assert r["trips"] == []

    def test_unresolvable_ct_is_skipped_with_warning(self):
        proj = self._feeder(z1_reach=1.0)
        proj.components.append(_c("ct_orphan", "ct", {"name": "Orphan CT", "ratio": "400/5"}))
        for comp in proj.components:
            if comp.id == "relay1":
                comp.props["associated_ct"] = "ct_orphan"
        r = run_transient_stability(proj, self._fault())
        assert r["trips"] == []
        assert any("skipped" in w for w in r["warnings"])


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
