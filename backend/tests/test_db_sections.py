"""Per-section supply in the DB circuit check (board compartments).

A section may declare its own source Zs (generator / UPS output) and a feed
cable; its ways are graded against that supply instead of the board's own.
A board with no sections is unchanged.
"""

from backend.analysis.db_circuit_check import run_db_circuit_check
from backend.tests.test_db_circuit_check import _board_project, _way


def _rows(project):
    return {r["way_id"]: r for r in run_db_circuit_check(project)["ways"]}


def _zs(row):
    return row.get("zs_ohm") if row.get("zs_ohm") is not None else row.get("zs")


def test_legacy_board_has_no_section_field():
    p = _board_project([_way(id="a")])
    rows = _rows(p)
    assert all("section" not in r for r in rows.values())


def test_declared_section_zs_replaces_board_supply():
    ways = [_way(id="n1", section="sN", cable_m=20),
            _way(id="e1", section="sE", cable_m=20)]
    secs = [{"id": "sN", "name": "Normal"},
            {"id": "sE", "name": "Essential", "zs_ohm": 0.9}]
    rows = _rows(_board_project(ways, {"sections": secs}))
    assert rows["n1"]["section"] == "Normal"
    assert rows["e1"]["section"] == "Essential"
    zn, ze = _zs(rows["n1"]), _zs(rows["e1"])
    assert zn is not None and ze is not None
    assert ze > zn + 0.5          # the 0.9 ohm generator dominates the loop


def test_section_feed_cable_adds_loop_impedance_and_drop():
    ways = [_way(id="a", section="s1", load_va=3000),
            _way(id="b", section="s2", load_va=3000)]
    secs = [{"id": "s1", "name": "A"},
            {"id": "s2", "name": "B", "feed_mm2": 16, "feed_m": 60}]
    rows = _rows(_board_project(ways, {"sections": secs}))
    assert _zs(rows["b"]) > _zs(rows["a"])


def test_reduced_pe_on_the_feed_raises_the_loop():
    ways = [_way(id="a", section="s1"), _way(id="b", section="s2")]
    feed = {"feed_mm2": 95, "feed_m": 80}
    secs = [{"id": "s1", "name": "Full PE", **feed},
            {"id": "s2", "name": "Reduced PE", **feed, "feed_pe_mm2": 25}]
    rows = _rows(_board_project(ways, {"sections": secs}))
    assert _zs(rows["b"]) > _zs(rows["a"])


def test_aluminium_feed_has_a_higher_loop_than_copper():
    ways = [_way(id="a", section="s1"), _way(id="b", section="s2")]
    feed = {"feed_mm2": 50, "feed_m": 80}
    secs = [{"id": "s1", "name": "Cu", **feed},
            {"id": "s2", "name": "Al", **feed, "feed_conductor": "Al"}]
    rows = _rows(_board_project(ways, {"sections": secs}))
    assert _zs(rows["b"]) > _zs(rows["a"])


def test_section_fed_from_a_section_inherits_its_source():
    # UPS-side section fed from the Essential section: it sees the generator
    # Zs plus both feed cables, not the board's own supply.
    ways = [_way(id="e", section="sE"), _way(id="d", section="sD")]
    secs = [{"id": "sN", "name": "Normal"},
            {"id": "sE", "name": "Essential", "zs_ohm": 0.9},
            {"id": "sD", "name": "Downstream", "feed": "section", "feed_from": "sE",
             "feed_mm2": 16, "feed_m": 30}]
    rows = _rows(_board_project(ways, {"sections": secs}))
    assert _zs(rows["d"]) > _zs(rows["e"]) > 0.9


def test_changeover_takes_the_worse_source():
    ways = [_way(id="n", section="sN"), _way(id="c", section="sC")]
    secs = [{"id": "sN", "name": "Normal"},
            {"id": "sG", "name": "Generator", "zs_ohm": 1.2},
            {"id": "sC", "name": "Changeover", "feed": "changeover", "feed_from": "sG"}]
    rows = _rows(_board_project(ways, {"sections": secs}))
    assert _zs(rows["c"]) >= 1.2 > _zs(rows["n"])


def test_section_feed_loop_does_not_hang():
    ways = [_way(id="a", section="s1")]
    secs = [{"id": "s1", "name": "A", "feed": "section", "feed_from": "s2"},
            {"id": "s2", "name": "B", "feed": "section", "feed_from": "s1"}]
    rows = _rows(_board_project(ways, {"sections": secs}))
    assert rows["a"]["section"] == "A"
