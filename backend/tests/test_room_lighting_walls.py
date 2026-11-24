"""Per-wall illuminance (room_lighting walls.perEdge)."""
from backend.tests.test_room_lighting import _webs, _room, _lum, _run


def test_per_edge_walls_match_mean_and_count():
    webs, _ = _webs("generic_panel", 4000.0)
    lum = [_lum(x, y) for x in (1.5, 4.5) for y in (1.5, 4.5)]
    res = _run(_room([[0, 0], [6, 0], [6, 6], [0, 6]], lum), webs)
    edges = res["walls"]["perEdge"]
    assert [e["edge"] for e in edges] == [1, 2, 3, 4]
    assert all(abs(e["length"] - 6.0) < 1e-6 for e in edges)
    for e in edges:
        assert e["Emin"] <= e["Em"] <= e["Emax"]
    # all four walls equal in a symmetric room, mean equals walls.Em
    mean = sum(e["Em"] for e in edges) / 4
    assert abs(mean - res["walls"]["Em"]) < 0.5
    assert max(e["Em"] for e in edges) - min(e["Em"] for e in edges) < 2.0


def test_per_edge_walls_differ_with_off_centre_lights():
    webs, _ = _webs("generic_panel", 4000.0)
    res = _run(_room([[0, 0], [8, 0], [8, 4], [0, 4]], [_lum(1.0, 2.0)]), webs)
    e = res["walls"]["perEdge"]
    assert len(e) == 4 and e[3]["Em"] > e[1]["Em"]      # wall at x=0 (edge 4) is nearest the fitting
    total = sum(x["Em"] * x["length"] for x in e)
    assert total > 0
