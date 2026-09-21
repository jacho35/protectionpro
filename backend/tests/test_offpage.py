"""Off-page connectors — analysis/offpage.py.

A linked pair of connectors (props.linked_to, or — legacy — the same name)
must join the two halves of a network drawn on different pages, so every
engine sees one connected system. Pins load flow and fault analysis across
the join, the unlinked / dangling cases, and the Load Flow Study Manager
case snapshots.
"""

import pytest

from backend.models.schemas import Component, ProjectData, Wire
from backend.analysis.offpage import expand_offpage_links, offpage_pairs
from backend.analysis.fault import run_fault_analysis
from backend.analysis.loadflow import run_load_flow

KV = 11.0


def _comp(cid, ctype, props, page="page_1"):
    return Component(id=cid, type=ctype, x=0, y=0, props=props, pageId=page)


def _wire(wid, fc, fp, tc, tp):
    return Wire(id=wid, fromComponent=fc, fromPort=fp, toComponent=tc, toPort=tp)


def _network(link_a="op-b", link_b="op-a", name_a="X1", name_b="X1"):
    """Page 1: 500 MVA utility -> bus-1 -> connector A.
    Page 2: connector B -> bus-2 -> 1 MW load."""
    return ProjectData(
        projectName="op", baseMVA=100.0, frequency=50,
        components=[
            _comp("utility-1", "utility", {"name": "Grid", "voltage_kv": KV,
                  "fault_mva": 500.0, "x_r_ratio": 10, "z0_z1_ratio": 1.0}),
            _comp("bus-1", "bus", {"name": "Bus 1", "voltage_kv": KV}),
            _comp("op-a", "offpage_connector", {"name": name_a, "linked_to": link_a}),
            _comp("op-b", "offpage_connector", {"name": name_b, "linked_to": link_b}, "page_2"),
            _comp("bus-2", "bus", {"name": "Bus 2", "voltage_kv": KV}, "page_2"),
            _comp("load-1", "static_load", {"name": "L1", "rated_kva": 1000,
                  "power_factor": 1.0, "voltage_kv": KV}, "page_2"),
        ],
        wires=[
            _wire("w1", "utility-1", "out", "bus-1", "at_0"),
            _wire("w2", "bus-1", "at_0", "op-a", "port"),
            _wire("w3", "op-b", "port", "bus-2", "at_0"),
            _wire("w4", "bus-2", "at_0", "load-1", "in"),
        ],
    )


class TestPairs:
    def test_link_from_one_end_is_enough(self):
        p = _network(link_a="op-b", link_b="")
        assert offpage_pairs(p.components) == [("op-a", "op-b")]

    def test_same_name_pairs_only_when_unlinked(self):
        assert offpage_pairs(_network("", "").components) == [("op-a", "op-b")]
        # a link elsewhere wins over a name match
        p = _network("", "", "X1", "X1")
        p.components.append(_comp("op-c", "offpage_connector", {"name": "X1", "linked_to": "op-d"}))
        p.components.append(_comp("op-d", "offpage_connector", {"name": "Y", "linked_to": "op-c"}))
        assert ("op-c", "op-d") in offpage_pairs(p.components)
        assert ("op-a", "op-c") not in offpage_pairs(p.components)

    def test_dangling_link_pairs_nothing(self):
        assert offpage_pairs(_network("gone", "gone", "A", "B").components) == []

    def test_no_pairs_is_identity(self):
        p = _network("", "", "A", "B")
        assert expand_offpage_links(p) is p


class TestEngines:
    def test_linked_load_is_energised_and_supplied(self):
        res = run_load_flow(expand_offpage_links(_network()))
        assert res.converged
        assert res.buses["bus-2"].energized
        assert res.buses["bus-2"].voltage_pu == pytest.approx(1.0, abs=0.01)
        assert sum(d.dispatched_mw for d in res.dispatch) == pytest.approx(1.0, rel=0.02)

    def test_unlinked_far_side_is_dead(self):
        res = run_load_flow(expand_offpage_links(_network("", "", "A", "B")))
        assert not res.buses["bus-2"].energized

    def test_legacy_same_name_still_joins(self):
        res = run_load_flow(expand_offpage_links(_network("", "")))
        assert res.buses["bus-2"].energized

    def test_fault_level_seen_through_the_join(self):
        res = run_fault_analysis(expand_offpage_links(_network()))
        assert res.buses["bus-2"].ik3 == pytest.approx(res.buses["bus-1"].ik3, rel=1e-3)
