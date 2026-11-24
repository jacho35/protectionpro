"""Tests for the Building circuiting engine and the path network under it.

Hand-checkable geometry: two 10 × 5 m rooms side by side, a board in the
left one, so every length below can be read off the plan.
"""

import math

import pytest

from backend.analysis.building_circuits import design_circuits
from backend.analysis.path_graph import PathGraph, connect


def _rect(x0, y0, x1, y1):
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]


def _req(**kw):
    req = {
        "mode": "ceiling",
        "boards": [{"id": "db1", "name": "DB-1", "x": 0.5, "y": 0.5, "floor": 1,
                    "ways_total": 24, "ways_used": 0, "mount_h": 1.8}],
        "rooms": [{"id": "r1", "name": "Office", "floor": 1, "polygon": _rect(0, 0, 10, 5), "ceil_h": 2.7},
                  {"id": "r2", "name": "Store", "floor": 1, "polygon": _rect(10, 0, 20, 5), "ceil_h": 2.7}],
        "devices": [],
        "rules": {"slack_pct": 0},
    }
    req.update(kw)
    return req


def _dev(i, room, x, y, typ="bd_light", va=100, **kw):
    d = {"id": i, "type": typ, "room_id": room, "x": x, "y": y, "va": va}
    d.update(kw)
    return d


class TestPathGraph:
    def test_crossing_lines_are_joined(self):
        g = PathGraph([[(0, 0), (10, 0)], [(5, -5), (5, 5)]])
        r = connect(g, (0, 0), (5, 5))
        assert r["length"] == pytest.approx(10.0)

    def test_drop_to_the_line_is_counted(self):
        g = PathGraph([[(0, 0), (10, 0)]])
        r = connect(g, (2, 1), (8, 3))
        assert r["length"] == pytest.approx(1 + 6 + 3)

    def test_too_far_from_containment_has_no_route(self):
        g = PathGraph([[(0, 0), (10, 0)]])
        assert connect(g, (2, 10), (8, 0), max_drop=3) is None

    def test_separate_networks_have_no_route(self):
        g = PathGraph([[(0, 0), (10, 0)], [(0, 50), (10, 50)]])
        assert connect(g, (0, 0), (10, 50)) is None


class TestGrouping:
    def test_lights_are_split_at_the_point_cap(self):
        devs = [_dev(f"l{i}", "r1", 1 + i * 0.5, 2) for i in range(12)]
        out = design_circuits(_req(devices=devs))
        lights = [c for c in out["circuits"] if c["group"] == "light"]
        assert sorted(len(c["device_ids"]) for c in lights) == [2, 10]

    def test_cap_is_a_project_rule(self):
        devs = [_dev(f"l{i}", "r1", 1 + i, 2) for i in range(6)]
        out = design_circuits(_req(devices=devs, rules={"slack_pct": 0, "max_points": {"light": 3}}))
        assert [len(c["device_ids"]) for c in out["circuits"]] == [3, 3]

    def test_load_cap_splits_a_circuit(self):
        devs = [_dev(f"s{i}", "r1", 1 + i, 2, "bd_socket", va=400) for i in range(5)]
        out = design_circuits(_req(devices=devs, rules={"slack_pct": 0, "max_va": {"socket": 1000}}))
        assert [len(c["device_ids"]) for c in out["circuits"]] == [2, 2, 1]

    def test_big_load_gets_its_own_circuit(self):
        devs = [_dev("s1", "r1", 2, 2, "bd_socket", va=400),
                _dev("geyser", "r1", 3, 2, "bd_socket", va=3000)]
        out = design_circuits(_req(devices=devs))
        by = {c["group"]: c for c in out["circuits"]}
        assert by["dedicated"]["device_ids"] == ["geyser"]
        assert by["socket"]["device_ids"] == ["s1"]

    def test_way_order_is_lights_sockets_dedicated(self):
        devs = [_dev("g", "r1", 3, 2, "bd_socket", va=3000), _dev("s", "r1", 2, 2, "bd_socket"),
                _dev("l", "r1", 1, 2)]
        out = design_circuits(_req(devices=devs))
        assert [c["group"] for c in sorted(out["circuits"], key=lambda c: c["way"])] == \
            ["light", "socket", "dedicated"]

    def test_hand_made_ways_are_kept_and_numbering_follows(self):
        req = _req(devices=[_dev("l", "r1", 1, 2)])
        req["boards"][0]["ways_used"] = 5
        assert design_circuits(req)["circuits"][0]["way"] == 6

    def test_earth_leakage_groups_share_a_phase(self):
        devs = [_dev(f"s{i}", "r1", 1 + i * 0.2, 2, "bd_socket", va=500) for i in range(48)]
        out = design_circuits(_req(devices=devs))
        socks = [c for c in out["circuits"] if c["group"] == "socket"]
        groups = {}
        for c in socks:
            groups.setdefault(c["el_group"], set()).add(c["phase"])
        assert all(len(p) == 1 for p in groups.values())
        assert len(groups) == 2
        assert max(sum(1 for c in socks if c["el_group"] == k) for k in groups) <= 4

    def test_phases_are_balanced(self):
        devs = [_dev(f"l{i}", f"r{1 + i % 2}", 1 + i, 2, va=100) for i in range(40)]
        out = design_circuits(_req(devices=devs, rules={"slack_pct": 0, "max_points": {"light": 2}}))
        assert out["boards"][0]["imbalance_pct"] < 20
        assert {c["phase"] for c in out["circuits"]} == {"R", "W", "B"}


class TestBoards:
    def _two_boards(self, **kw):
        req = _req(**kw)
        req["boards"].append({"id": "db2", "name": "DB-2", "x": 19.5, "y": 0.5, "floor": 1,
                              "ways_total": 24, "ways_used": 0})
        return req

    def test_room_goes_to_the_nearest_board(self):
        req = self._two_boards(devices=[_dev("a", "r1", 2, 2), _dev("b", "r2", 18, 2)])
        out = design_circuits(req)
        assert {a["room_id"]: a["board_id"] for a in out["assignments"]} == {"r1": "db1", "r2": "db2"}

    def test_full_board_hands_the_room_to_the_next(self):
        req = self._two_boards(devices=[_dev("a", "r1", 2, 2)])
        req["boards"][0]["ways_total"] = 1
        req["boards"][0]["ways_used"] = 1
        out = design_circuits(req)
        assert out["assignments"] == [{"room_id": "r1", "board_id": "db2"}]
        assert any(c["code"] == "board_not_nearest" for c in out["checks"])

    def test_override_is_kept(self):
        req = self._two_boards(devices=[_dev("a", "r1", 2, 2)])
        req["rooms"][0]["board_override"] = "db2"
        assert design_circuits(req)["assignments"][0]["board_id"] == "db2"

    def test_no_board_with_capacity_is_a_failure_and_none_is_added(self):
        req = _req(devices=[_dev("a", "r1", 2, 2)])
        req["boards"][0]["ways_total"] = 2
        req["boards"][0]["ways_used"] = 2
        out = design_circuits(req)
        assert out["assignments"] == [] and out["circuits"] == []
        assert [c["code"] for c in out["checks"] if c["severity"] == "fail"] == ["no_board"]

    def test_a_board_with_no_way_count_is_not_limited(self):
        req = _req(devices=[_dev(f"l{i}", "r1", 1 + i * 0.1, 2) for i in range(300)])
        req["boards"][0].pop("ways_total")
        out = design_circuits(req)
        assert len(out["circuits"]) == 30
        assert out["boards"][0]["ways_spare"] is None
        assert not any(c["code"] in ("spare_ways", "no_board") for c in out["checks"])

    def test_spare_way_rule_warns(self):
        req = _req(devices=[_dev("a", "r1", 2, 2)])
        req["boards"][0]["ways_total"] = 3
        assert any(c["code"] == "spare_ways" for c in design_circuits(req)["checks"])


class TestRoutes:
    def test_ceiling_is_straight_line_plus_drops(self):
        # board (0.5,0.5) h 1.8 → socket (3.5,4.5) h 0.3, ceiling 2.7: 5 m + 0.9 + 2.4
        req = _req(devices=[_dev("s", "r1", 3.5, 4.5, "bd_socket", va=300)])
        c = design_circuits(req)["circuits"][0]
        assert c["length_m"] == pytest.approx(5.0 + 0.9 + 2.4)

    def test_slack_is_added(self):
        req = _req(devices=[_dev("s", "r1", 3.5, 4.5, "bd_socket", va=300)], rules={"slack_pct": 10})
        assert design_circuits(req)["circuits"][0]["length_m"] == pytest.approx(8.3 * 1.1, abs=0.01)

    def test_devices_are_chained_not_each_run_home(self):
        devs = [_dev("a", "r1", 2.5, 0.5, va=100, mount_h=2.7), _dev("b", "r1", 4.5, 0.5, va=100, mount_h=2.7)]
        c = design_circuits(_req(devices=devs, rules={"slack_pct": 0, "device_mount_h": {"light": 2.7}}))["circuits"][0]
        assert c["device_ids"] == ["a", "b"]
        assert c["length_m"] == pytest.approx(2 + 2 + 0.9)  # board drop 0.9 only

    def test_walls_follow_the_room_outline(self):
        # Board at the room's corner, light at the far corner: along two walls = 10 + 5 = 15.
        req = _req(mode="walls", devices=[_dev("l", "r1", 10, 5)])
        req["boards"][0].update(x=0, y=0)
        assert design_circuits(req)["circuits"][0]["length_m"] == pytest.approx(15.0)

    def test_walls_pass_into_the_next_room_along_the_shared_wall(self):
        req = _req(mode="walls", devices=[_dev("l", "r2", 20, 0)])
        req["boards"][0].update(x=0, y=0)
        out = design_circuits(req)
        assert out["circuits"][0]["length_m"] == pytest.approx(20.0)

    def test_containment_uses_the_drawn_tray(self):
        req = _req(mode="containment", containment=[[[0, 1], [10, 1], [10, 4]]],
                   devices=[_dev("l", "r1", 10, 4)])
        req["boards"][0].update(x=0, y=0)
        # drop 1 to the tray, 10 along, 3 up the leg, 0 to the light
        assert design_circuits(req)["circuits"][0]["length_m"] == pytest.approx(1 + 10 + 3)

    def test_no_containment_is_a_failure_with_a_direct_fix(self):
        req = _req(mode="containment", devices=[_dev("l", "r1", 2, 2)])
        out = design_circuits(req)
        fail = [c for c in out["checks"] if c["code"] == "no_route"]
        assert len(fail) == 1
        assert fail[0]["fix"]["mode_override"] == {"r1:light": "ceiling"}
        assert out["circuits"][0]["route"] is None

    def test_applying_the_direct_fix_routes_that_circuit_only(self):
        devs = [_dev("l", "r1", 2, 2), _dev("s", "r1", 3, 2, "bd_socket", va=300)]
        req = _req(mode="containment", devices=devs, mode_overrides={"r1:light": "ceiling"})
        by = {c["group"]: c for c in design_circuits(req)["circuits"]}
        assert by["light"]["mode"] == "ceiling" and by["light"]["route"] is not None
        assert by["socket"]["mode"] == "containment" and by["socket"]["route"] is None

    def test_mode_per_group(self):
        devs = [_dev("l", "r1", 2, 2), _dev("s", "r1", 3, 2, "bd_socket", va=300)]
        out = design_circuits(_req(mode="containment", devices=devs, mode_by_group={"light": "ceiling", "socket": "ceiling"}))
        assert {c["mode"] for c in out["circuits"]} == {"ceiling"}

    def test_bad_mode_is_refused(self):
        with pytest.raises(ValueError):
            design_circuits(_req(mode="teleport"))

    def test_device_in_no_room_is_reported_not_dropped_silently(self):
        out = design_circuits(_req(devices=[_dev("x", "nowhere", 1, 1)]))
        assert out["unplaced_device_ids"] == ["x"]
        assert any(c["code"] == "device_no_room" for c in out["checks"])
