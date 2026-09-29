"""Street lighting engine (analysis/street_lighting.py) — hand calculations.

Round numbers throughout: pf = 1 and X = 0 so every lamp is a real current,
and a cable of 10 Ω/km over 100 m spans gives Z = 1 Ω per span.
"""

import cmath
import math

import pytest

from backend.analysis.street_lighting import (
    U0, max_uniform_poles, run_street_lighting, smallest_cable, solve_circuit,
)

CAB = {"name": "test 10 Ω/km", "r": 10.0, "x": 0.0, "cores": 4}
LAMP_1A = {"name": "230 W", "watts": 230.0, "pf": 1.0}      # 1 A at 230 V


def _chain(n, prefix="P"):
    return [{"id": f"{prefix}{i + 1}", "name": f"{prefix}{i + 1}",
             "parent": (f"{prefix}{i}" if i else None)} for i in range(n)]


def _circuit(**kw):
    c = {"id": "c1", "name": "SL1", "system": "3ph", "cable": CAB, "luminaire": LAMP_1A,
         "spacingM": 100.0, "snakingPct": 0.0, "loopInM": 0.0, "zeOhm": 0.0,
         "supplyVdPct": 0.0, "vdLimitPct": 5.0, "cumVdLimitPct": 10.0,
         "protection": {"iaA": 0}, "poles": _chain(3)}
    c.update(kw)
    return c


def _pole(res, pid):
    return next(p for p in res["poles"] if p["id"] == pid)


class TestSinglePhase:
    def test_one_pole_is_two_z_i(self):
        r = solve_circuit(_circuit(system="1ph", poles=_chain(1)))
        # 1 A through 1 Ω out and 1 Ω back: 2 V
        assert _pole(r, "P1")["vdPct"] == pytest.approx(2 / U0 * 100, abs=1e-3)
        assert r["neutralA"] == pytest.approx(1.0)

    def test_string_sums_span_currents(self):
        # spans carry 3, 2, 1 A → 2·(3 + 2 + 1) = 12 V at the last pole
        r = solve_circuit(_circuit(system="1ph", poles=_chain(3)))
        assert _pole(r, "P3")["vdPct"] == pytest.approx(12 / U0 * 100, abs=1e-3)
        assert _pole(r, "P1")["vdPct"] == pytest.approx(6 / U0 * 100, abs=1e-3)
        assert r["worstVdPole"] == "P3"
        assert all(p["phase"] == "R" for p in r["poles"])

    def test_single_phase_choice(self):
        r = solve_circuit(_circuit(system="1ph", singlePhase="B", poles=_chain(2)))
        assert {p["phase"] for p in r["poles"]} == {"B"}
        assert r["phaseA"]["B"] == pytest.approx(2.0) and r["phaseA"]["R"] == 0


class TestThreePhase:
    def test_rotation_and_balanced_neutral(self):
        r = solve_circuit(_circuit(poles=_chain(6)))
        assert [p["phase"] for p in r["poles"]] == ["R", "W", "B", "R", "W", "B"]
        assert r["neutralA"] == pytest.approx(0.0, abs=1e-9)
        assert r["phaseA"] == {"R": 2.0, "W": 2.0, "B": 2.0}

    def test_phasor_drop_by_hand(self):
        # 3 poles R, W, B, 1 A each, 1 Ω spans.
        # Pole 1 (R): span 1 carries I_R = 1 and no neutral → U = 230 − 1.
        # Pole 2 (W): span 1 drop on W = 1∠−120°; span 2 carries I_W = 1∠−120°
        #   and neutral I_W + I_B = 1∠−120° + 1∠120° = −1, so its drop is
        #   1∠−120° − 1. U_W = 230∠−120° − (2∠−120° − 1).
        r = solve_circuit(_circuit())
        assert _pole(r, "P1")["vdPct"] == pytest.approx(1 / U0 * 100, abs=1e-3)
        a = cmath.rect(1, -2 * math.pi / 3)
        u_w = cmath.rect(U0, -2 * math.pi / 3) - (2 * a - 1)
        assert _pole(r, "P2")["vdPct"] == pytest.approx((U0 - abs(u_w)) / U0 * 100, abs=1e-3)
        # pole 2's span carries an unbalanced W+B pair → 1 A in the neutral
        assert _pole(r, "P2")["iNeutralA"] == pytest.approx(1.0)

    def test_three_phase_much_lower_than_single_phase(self):
        # 30 × 0.1 A lamps on 40 m spans of a 1 Ω/km cable (a few % either way)
        kw = dict(poles=_chain(30), spacingM=40.0, cable=dict(CAB, r=1.0),
                  luminaire={"watts": 23.0, "pf": 1.0})
        three = solve_circuit(_circuit(**kw))["worstVdPct"]
        one = solve_circuit(_circuit(system="1ph", **kw))["worstVdPct"]
        assert one == pytest.approx(2 * 0.04 * 0.1 * sum(range(1, 31)) / U0 * 100, abs=1e-3)
        # about a sixth: a third of the current per phase, no neutral drop
        assert 0.12 < three / one < 0.25

    def test_phase_override_is_kept_and_rotation_continues(self):
        poles = _chain(3)
        poles[1]["phase"] = "B"
        r = solve_circuit(_circuit(poles=poles))
        assert [p["phase"] for p in r["poles"]] == ["R", "B", "R"]


class TestSpurs:
    def test_spur_continues_rotation_from_tee_pole(self):
        poles = _chain(3) + [
            {"id": "S1", "parent": "P2"},      # tee on P2 (W) → B
            {"id": "S2", "parent": "S1"},      # → R
        ]
        r = solve_circuit(_circuit(poles=poles))
        ph = {p["id"]: p["phase"] for p in r["poles"]}
        assert ph == {"P1": "R", "P2": "W", "P3": "B", "S1": "B", "S2": "R"}

    def test_spur_load_flows_through_the_trunk(self):
        # 1Φ: P1 → P2, spur S1 off P1. Span 1 carries all 3 A.
        poles = _chain(2) + [{"id": "S1", "parent": "P1"}]
        r = solve_circuit(_circuit(system="1ph", poles=poles))
        assert _pole(r, "P1")["iSpanA"] == pytest.approx(3.0)
        # S1 = span 1 (2·3 V) + its own span (2·1 V)
        assert _pole(r, "S1")["vdPct"] == pytest.approx(8 / U0 * 100, abs=1e-3)
        assert _pole(r, "S1")["distM"] == pytest.approx(200.0)

    def test_missing_parent_is_fed_from_source(self):
        r = solve_circuit(_circuit(poles=[{"id": "A", "parent": "nope"}]))
        assert r["poleCount"] == 1 and r["warnings"]


class TestChecks:
    def test_zs_and_disconnection(self):
        # Ze 0.3 + 2 × 1 Ω = 2.3 Ω → Ik1 = 0.95 · 230 / 2.3 = 95 A
        c = _circuit(system="1ph", poles=_chain(1), zeOhm=0.3)
        r = solve_circuit(dict(c, protection={"iaA": 100}))
        p = _pole(r, "P1")
        assert p["zsOhm"] == pytest.approx(2.3)
        assert p["ik1A"] == pytest.approx(95.0, abs=0.1)
        assert not r["zsPass"] and "zs" in r["fails"]
        assert r["zsMaxAllowedOhm"] == pytest.approx(0.95 * 230 / 100, abs=1e-3)
        assert solve_circuit(dict(c, protection={"iaA": 50}))["zsPass"]

    def test_cumulative_includes_supply_drop(self):
        c = _circuit(system="1ph", poles=_chain(1), cumVdLimitPct=5.0)
        ok = solve_circuit(dict(c, supplyVdPct=4.0))          # 4 + 0.87
        bad = solve_circuit(dict(c, supplyVdPct=4.5))         # 4.5 + 0.87
        assert ok["cumVdPass"] and ok["vdPass"]
        assert ok["worstCumVdPct"] == pytest.approx(4.0 + 2 / U0 * 100, abs=1e-3)
        assert not bad["cumVdPass"] and bad["vdPass"] and bad["fails"] == ["cumVd"]

    def test_span_length_adds_snaking_and_loop_in(self):
        r = solve_circuit(_circuit(poles=_chain(1), snakingPct=3, loopInM=2))
        assert _pole(r, "P1")["spanM"] == pytest.approx(105.0)

    def test_cable_rating(self):
        r = solve_circuit(_circuit(system="1ph", poles=_chain(5), cable=dict(CAB, ratedA=4)))
        assert not r["ratingPass"]

    def test_two_core_cable_on_three_phase_warns(self):
        r = solve_circuit(_circuit(cable=dict(CAB, cores=2)))
        assert any("4-core" in w for w in r["warnings"])

    def test_no_cable_never_passes(self):
        r = solve_circuit(_circuit(cable={"name": ""}))
        assert not r["pass"] and "cable" in r["fails"]
        assert max_uniform_poles(_circuit(cable={"name": ""}))["maxPoles"] == 0

    def test_kva_to_source(self):
        r = solve_circuit(_circuit(luminaire={"watts": 95, "pf": 0.95}, poles=_chain(10)))
        assert r["totalKVA"] == pytest.approx(10 * 0.1, abs=1e-4)


class TestSolver:
    def test_max_poles_is_the_boundary(self):
        c = _circuit(system="1ph", poles=_chain(1))
        s = max_uniform_poles(c)
        n = s["maxPoles"]
        # 1 A lamps on 1 Ω spans: 2 poles → 6 V (2.6 %), 3 poles → 12 V (5.2 %)
        assert n == 2 and s["limitedBy"] == "vd"
        assert solve_circuit(dict(c, poles=_chain(n)))["pass"]
        assert not solve_circuit(dict(c, poles=_chain(n + 1)))["pass"]

    def test_zs_limited(self):
        c = _circuit(system="3ph", zeOhm=0.5, protection={"iaA": 100})
        s = max_uniform_poles(c)
        assert s["limitedBy"] == "zs"

    def test_smallest_cable(self):
        # 20 × 0.1 A on 40 m spans: drop = 2·r·0.04·0.1·210 = 1.68·r V →
        # r = 20 Ω/km 14.6 % (fails), r = 3 Ω/km 2.2 % (the smallest that passes)
        c = _circuit(system="1ph", poles=_chain(20), spacingM=40.0,
                     luminaire={"watts": 23.0, "pf": 1.0})
        cands = [{"name": "big", "r": 1.0, "x": 0, "cores": 2},
                 {"name": "small", "r": 20.0, "x": 0, "cores": 2},
                 {"name": "mid", "r": 3.0, "x": 0, "cores": 2}]
        name = smallest_cable(c, cands)
        assert name == "mid"
        assert not solve_circuit(dict(c, cable=cands[1]))["pass"]
        # a 3Φ circuit never picks a 2-core cable
        assert smallest_cable(dict(c, system="3ph"), cands) is None


class TestRoute:
    def test_route_handler_and_serialization(self):
        from fastapi.encoders import jsonable_encoder
        from backend.routes.analysis import StreetLightingRequest, street_lighting

        req = StreetLightingRequest(circuits=[_circuit()], candidateCables=[CAB])
        out = street_lighting(req)
        enc = jsonable_encoder(out)
        c = enc["circuits"][0]
        assert c["poleCount"] == 3 and "solver" in c and c["smallestCable"] == CAB["name"]

    def test_run_empty(self):
        assert run_street_lighting({}) == {"circuits": []}


class TestAdmdMinisubStreetLight:
    def test_minisub_fixed_sl_load_is_added(self):
        from backend.analysis.admd import run_admd
        base = run_admd({"kiosks": [], "minisubs": [{"id": "ms", "name": "MS"}]})
        res = run_admd({"kiosks": [], "minisubs": [{"id": "ms", "name": "MS", "streetLightKVA": 2.5}]})
        assert base["minisubs"][0]["totalKVA"] == 0
        assert res["minisubs"][0]["totalKVA"] == pytest.approx(2.5)
        assert res["minisubs"][0]["streetLightKVA"] == pytest.approx(2.5)
        assert res["total"]["streetLightKVA"] == pytest.approx(2.5)
