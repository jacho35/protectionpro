"""Tests for the reticulation MV design (radial / ring).

Hand calculation (11 kV, pf 0.95, supply 250 MVA, mini-subs A at 1 km and B at
2 km on a line, 1000 kVA each, c = 1.1):

  fault level at the supply  Ik = 1.1·11000 / (√3·(11000²/250e6)) = 14.43 kA
  50 mm² Al, 0.5 s withstand 94·50/√0.5 = 6.65 kA  → fails
  volt drop at B (50 mm², 0.641 + j0.100 Ω/km): 1.058 % + 0.529 % = 1.587 %
"""

import pytest

from backend.analysis.retic_mv_design import design_mv

LADDER = [
    {"id": "al50", "size_mm2": 50, "conductor": "Al", "r_ohm_km": 0.641, "x_ohm_km": 0.100, "rating_a": 180},
    {"id": "al95", "size_mm2": 95, "conductor": "Al", "r_ohm_km": 0.320, "x_ohm_km": 0.090, "rating_a": 270},
    {"id": "al150", "size_mm2": 150, "conductor": "Al", "r_ohm_km": 0.206, "x_ohm_km": 0.085, "rating_a": 345},
]


def _req(**kw):
    req = {"topology": "radial", "voltage_kv": 11,
           "supply": {"x": 0, "y": 0, "fault_mva": 250, "clearing_time_s": 0.5},
           "subs": [{"id": "A", "x": 1000, "y": 0, "kva": 1000}, {"id": "B", "x": 2000, "y": 0, "kva": 1000}],
           "cables": LADDER, "limits": {"vd_pct": 2.0, "pf": 0.95}}
    req.update(kw)
    return req


def _fast(req, t=0.02):
    req["supply"] = {**req["supply"], "clearing_time_s": t}
    return req


class TestRadial:
    def test_volt_drop_matches_the_hand_calculation(self):
        r = design_mv(_fast(_req(cables=LADDER[:1])))
        assert r["worst"]["vd_pct"] == pytest.approx(1.587, abs=0.005)
        assert r["worst"]["vd_at"] == "B"

    def test_fault_withstand_governs(self):
        r = design_mv(_req())
        assert r["cable"]["id"] == "al150"
        assert "fault_level" in r["governed_by"]
        assert r["worst"]["ik_ka"] == pytest.approx(14.43, abs=0.02)

    def test_a_shorter_clearing_time_allows_a_smaller_cable(self):
        # 94·95/√0.2 = 19.97 kA passes, 94·50/√0.2 = 10.5 kA does not
        r = design_mv(_req(supply={"x": 0, "y": 0, "fault_mva": 250, "clearing_time_s": 0.2}))
        assert r["cable"]["id"] == "al95"

    def test_volt_drop_governs_on_a_long_line(self):
        req = _fast(_req(subs=[{"id": "A", "x": 3000, "y": 0, "kva": 1000},
                               {"id": "B", "x": 6000, "y": 0, "kva": 1000}]), 0.05)
        r = design_mv(req)
        assert r["cable"]["id"] == "al150"
        assert r["governed_by"] == ["volt_drop"]
        assert r["worst"]["vd_pct"] <= 2.0

    def test_cable_rating_governs_a_heavy_load(self):
        req = _fast(_req(subs=[{"id": "A", "x": 100, "y": 0, "kva": 9000},
                               {"id": "B", "x": 200, "y": 0, "kva": 9000}]))
        r = design_mv(req)
        assert r["cable"] is None
        assert [c["code"] for c in r["checks"] if c["severity"] == "fail"] == ["cable_rating"]

    def test_laying_factor_reduces_the_rating(self):
        req = _fast(_req(subs=[{"id": "A", "x": 100, "y": 0, "kva": 3000},
                               {"id": "B", "x": 200, "y": 0, "kva": 3000}]))
        ok = design_mv(req)["cable"]["id"]            # 6000 kVA = 315 A: only 150 mm² (345 A)
        assert ok == "al150"
        req["laying"] = {"factor": 0.8}               # 345 × 0.8 = 276 A < 315 A
        assert design_mv(req)["cable"] is None

    def test_switchgear_rating_is_checked(self):
        r = design_mv(_fast(_req(limits={"vd_pct": 2.0, "pf": 0.95, "switchgear_ka": 12.5})))
        assert any(c["code"] == "switchgear" for c in r["checks"])

    def test_cables_follow_the_streets(self):
        req = _fast(_req(subs=[{"id": "A", "x": 1000, "y": 1000, "kva": 500}],
                         network=[[[0, 0], [1000, 0], [1000, 1000]]]))
        r = design_mv(req)
        assert r["total_length_m"] == pytest.approx(2000.0)
        assert r["sections"][0]["route"][0] == [0, 0]

    def test_a_sub_off_the_network_is_reported(self):
        req = _fast(_req(subs=[{"id": "A", "x": 1000, "y": 0, "kva": 500}],
                         network=[[[0, 0], [500, 0]], [[900, 0], [1000, 0]]]))
        r = design_mv(req)
        assert r["cable"] is None and r["checks"][0]["code"] == "unreachable"


class TestRing:
    def _ring(self, **kw):
        subs = [{"id": "A", "x": 1000, "y": 0, "kva": 500}, {"id": "B", "x": 1000, "y": 1000, "kva": 500},
                {"id": "C", "x": 0, "y": 1000, "kva": 500}]
        return _fast(_req(topology="ring", subs=subs, **kw))

    def test_ring_has_a_section_per_node_and_one_is_open(self):
        r = design_mv(self._ring())
        assert len(r["ring_sections"]) == 4
        assert r["open_point"] in (1, 2)              # opening opposite the supply balances the ring
        assert r["total_length_m"] == pytest.approx(3000.0)

    def test_the_worst_case_is_a_section_out_next_to_the_supply(self):
        r = design_mv(self._ring())
        assert r["worst"]["vd_pct"] > r["normal"]["vd_pct"]

    def test_each_half_carries_the_whole_ring(self):
        # 1500 kVA = 78.7 A through one arm when the section beside the supply is out
        r = design_mv(self._ring())
        assert r["worst"]["current_a"] == pytest.approx(1500 / (3 ** 0.5 * 11), abs=0.2)

    def test_a_ring_is_sized_for_the_outage_not_the_normal_state(self):
        # Three 500 kVA subs on a 1 km square. One arm carrying all three: 0.794 + 0.529 + 0.265 = 1.588 %
        # on 50 mm² (hand calculation as above). With the ring normally open at A-B the worst is only 0.794 %,
        # so a 1.2 % limit passes the normal state on 50 mm² and fails the outage: the ring needs 95 mm².
        loose = design_mv(self._ring())
        assert loose["cable"]["id"] == "al50"
        assert loose["worst"]["vd_pct"] == pytest.approx(1.588, abs=0.005)
        assert loose["normal"]["vd_pct"] == pytest.approx(0.794, abs=0.005)
        tight = design_mv(self._ring(limits={"vd_pct": 1.2, "pf": 0.95}))
        assert tight["cable"]["id"] == "al95"
        assert tight["governed_by"] == ["volt_drop"]

    def test_one_sub_cannot_make_a_ring(self):
        r = design_mv(_fast(_req(topology="ring", subs=[{"id": "A", "x": 1000, "y": 0, "kva": 500}])))
        assert r["topology"] == "radial"
        assert any(c["code"] == "ring_needs_two" for c in r["checks"])


class TestInput:
    def test_bad_topology(self):
        with pytest.raises(ValueError):
            design_mv(_req(topology="star"))

    def test_no_subs(self):
        with pytest.raises(ValueError):
            design_mv(_req(subs=[]))

    def test_no_cables(self):
        with pytest.raises(ValueError):
            design_mv(_req(cables=[]))
