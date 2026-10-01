"""Load diversity review (2026-10-01), findings LD1–LD8.

Each test reproduces the original defect against an independent hand
calculation: demand rolled up board by board with the IEC 61439 rated
diversity factor Ks, loads added as kW and kvar exactly as the load flow
injects them.
"""

import math

import pytest

from backend.models.schemas import Component, ProjectData, Wire
from backend.analysis import load_diversity as LD
from backend.analysis.load_diversity import coincidence_factor, run_load_diversity
from backend.analysis.loadflow import run_load_flow

_n = [0]


def _c(cid, ctype, **props):
    return Component(id=cid, type=ctype, x=0, y=0, props=props)


def _w(a, b, fp="bottom", tp="top"):
    _n[0] += 1
    return Wire(id=f"w{_n[0]}", fromComponent=a, fromPort=fp, toComponent=b, toPort=tp)


def _p(comps, wires):
    return ProjectData(projectName="ld-review", baseMVA=100, frequency=50,
                       components=comps, wires=wires)


def _util():
    return _c("u", "utility", name="Grid", fault_mva=500.0, voltage_kv=11.0, x_r_ratio=10)


def _tx(cid, mva=0.5):
    return _c(cid, "transformer", name=cid, rated_mva=mva, z_percent=5.0, x_r_ratio=5,
              voltage_hv_kv=11.0, voltage_lv_kv=0.4, vector_group="Dyn11")


def _bus(cid, kv=0.4):
    return _c(cid, "bus", name=cid, voltage_kv=kv)


def _cable(cid):
    return _c(cid, "cable", name=cid, r_per_km=0.1, x_per_km=0.08, length_km=0.02, voltage_kv=0.4)


def _load(cid, kva=100.0, pf=0.9, df=1.0):
    return _c(cid, "static_load", name=cid, rated_kva=kva, power_factor=pf, demand_factor=df)


def _tx_row(res, tid):
    return next(t for t in res["transformers"] if t["transformer_id"] == tid)


def _bus_row(res, bid):
    return next((b for b in res["buses"] if b["bus_id"] == bid), None)


class TestLD1TransformerThroughCable:
    def test_lv_terminal_to_cable(self):
        """[LD1] A transformer whose LV terminal goes straight into a cable
        (no bus at the terminal) read 0 kVA / PASS. Two 100 kVA loads at
        pf 0.9 on the far bus: Ks(2) = 0.9 → 180 kVA."""
        res = run_load_diversity(_p(
            [_util(), _bus("hv", 11), _tx("t"), _cable("c"), _bus("lv"), _load("a"), _load("b")],
            [_w("u", "hv"), _w("hv", "t", "bottom", "primary"), _w("t", "c", "secondary", "from"),
             _w("c", "lv", "to", "top"), _w("lv", "a"), _w("lv", "b")]))
        assert _tx_row(res, "t")["demand_kva"] == pytest.approx(180.0, rel=1e-6)

    def test_hv_side_not_drawn(self):
        """[LD1] Only the LV winding drawn: the undrawn side is the supply."""
        res = run_load_diversity(_p(
            [_tx("t"), _bus("lv"), _load("a", 300.0)],
            [_w("t", "lv", "secondary", "top"), _w("lv", "a")]))
        row = _tx_row(res, "t")
        assert row["demand_kva"] == pytest.approx(300.0, rel=1e-6)
        assert row["demand_loading_pct"] == pytest.approx(60.0, rel=1e-6)


class TestLD2ParallelUnits:
    def test_parallel_transformers_share_by_rating(self):
        """[LD2] Two units onto one LV board: the walk crossed back up through
        the twin to the HV bus and gave each unit the whole network (1600 kVA
        here). 400 kVA board shared 500:250 → 266.7 / 133.3 kVA."""
        res = run_load_diversity(_p(
            [_util(), _bus("hv", 11), _tx("t1", 0.5), _tx("t2", 0.25), _bus("lv"),
             _load("a", 400.0), _load("hvl", 900.0), _tx("t3"), _bus("lv3"), _load("c", 300.0)],
            [_w("u", "hv"), _w("hv", "t1", "bottom", "primary"), _w("hv", "t2", "bottom", "primary"),
             _w("t1", "lv", "secondary", "top"), _w("t2", "lv", "secondary", "top"), _w("lv", "a"),
             _w("hv", "hvl"), _w("hv", "t3", "bottom", "primary"), _w("t3", "lv3", "secondary", "top"),
             _w("lv3", "c")]))
        assert _tx_row(res, "t1")["demand_kva"] == pytest.approx(400 * 2 / 3, rel=1e-4)
        assert _tx_row(res, "t2")["demand_kva"] == pytest.approx(400 / 3, rel=1e-4)
        assert _tx_row(res, "t3")["demand_kva"] == pytest.approx(300.0, rel=1e-6)
        assert _tx_row(res, "t1")["shared_with"] == ["t2"]

    def test_closed_bus_coupler(self):
        """[LD2] Two boards joined by a closed coupler: each unit carries its
        own board (300 kVA), not both (600)."""
        res = run_load_diversity(_p(
            [_util(), _bus("hv", 11), _tx("t1"), _tx("t2"), _bus("A"), _bus("B"),
             _c("cb", "cb", name="cb", state="closed"), _load("a", 300.0), _load("b", 300.0)],
            [_w("u", "hv"), _w("hv", "t1", "bottom", "primary"), _w("hv", "t2", "bottom", "primary"),
             _w("t1", "A", "secondary", "top"), _w("t2", "B", "secondary", "top"),
             _w("A", "cb"), _w("cb", "B"), _w("A", "a"), _w("B", "b")]))
        assert _tx_row(res, "t1")["demand_kva"] == pytest.approx(300.0, rel=1e-6)
        assert _tx_row(res, "t2")["demand_kva"] == pytest.approx(300.0, rel=1e-6)

    def test_generator_islands_keep_transformer_direction(self):
        """[LD2] No utility, generators on both LV boards, an MV board between
        them: the MV board feeds both LV boards, so the unit to the loaded
        board carries its load (not 0)."""
        res = run_load_diversity(_p(
            [_bus("lvA"), _bus("mv", 3.3), _bus("lvB"),
             _c("gA", "generator", name="gA", rated_mva=1), _c("gB", "generator", name="gB", rated_mva=1),
             _c("tA", "transformer", name="tA", rated_mva=1, voltage_hv_kv=3.3, voltage_lv_kv=0.4),
             _c("tB", "transformer", name="tB", rated_mva=1, voltage_hv_kv=3.3, voltage_lv_kv=0.4),
             _load("l", 500.0)],
            [_w("gA", "lvA"), _w("gB", "lvB"), _w("lvA", "tA", "bottom", "secondary"),
             _w("tA", "mv", "primary", "top"), _w("mv", "tB", "bottom", "primary"),
             _w("tB", "lvB", "secondary", "top"), _w("lvB", "l")]))
        assert _tx_row(res, "tB")["demand_kva"] == pytest.approx(500.0, rel=1e-6)
        assert _tx_row(res, "tA")["demand_kva"] == 0


class TestLD3MissingLoads:
    def test_vfd_counted_as_load_flow_does(self):
        """[LD3] A drive was not a load at all. 200 kW, η 0.96, load 80 %,
        dpf 0.98: P = 200·0.8/0.96 = 166.7 kW."""
        prj = _p([_util(), _bus("hv", 11), _tx("t"), _bus("lv"),
                  _c("v", "vfd", name="v", rated_kw=200, efficiency=0.96, load_pct=80,
                     displacement_pf=0.98, demand_factor=1.0)],
                 [_w("u", "hv"), _w("hv", "t", "bottom", "primary"),
                  _w("t", "lv", "secondary", "top"), _w("lv", "v")])
        res = run_load_diversity(prj)
        p = 200 * 0.8 / 0.96
        assert _tx_row(res, "t")["demand_kw"] == pytest.approx(p, rel=1e-4)
        assert _tx_row(res, "t")["demand_kva"] == pytest.approx(p / 0.98, rel=1e-4)

    def test_motor_behind_drive_not_double_counted(self):
        """[LD3] The motor on the drive output is the drive's load."""
        res = run_load_diversity(_p(
            [_bus("lv"), _c("v", "vfd", name="v", rated_kw=100, efficiency=0.96, load_pct=100,
                            displacement_pf=0.98),
             _c("m", "motor_induction", name="m", rated_kw=90, efficiency=0.94, power_factor=0.85)],
            [_w("lv", "v", "bottom", "in"), _w("v", "m", "out", "top")]))
        assert res["buses"][0]["installed_kva"] == pytest.approx(100 / 0.96 / 0.98, rel=1e-3)
        assert res["warnings"] == []

    def test_load_behind_own_cable_and_board_chain(self):
        """[LD3] A load behind its own cable (no bus at the load) and a board
        fed from another board's out port were missing from the bus rows and
        the summary. Installed 100 + 100 + 80 + 40 = 320 kVA."""
        res = run_load_diversity(_p(
            [_util(), _bus("hv", 11), _tx("t"), _bus("lv"), _cable("c1"), _load("far"), _load("near"),
             _c("d1", "distribution_board", name="d1", rated_kva=80, power_factor=0.9, demand_factor=1.0),
             _c("d2", "distribution_board", name="d2", rated_kva=40, power_factor=0.9, demand_factor=1.0)],
            [_w("u", "hv"), _w("hv", "t", "bottom", "primary"), _w("t", "lv", "secondary", "top"),
             _w("lv", "c1", "bottom", "from"), _w("c1", "far", "to", "in"), _w("lv", "near"),
             _w("lv", "d1", "bottom", "in"), _w("d1", "d2", "out", "in")]))
        assert res["summary"]["total_installed_kva"] == pytest.approx(320.0, rel=1e-6)
        assert _bus_row(res, "lv")["installed_kva"] == pytest.approx(320.0, rel=1e-6)
        # d1: own schedule + d2 = 2 circuits → 0.9·120; lv: far, near, d1 = 3
        assert _bus_row(res, "d1")["diversified_demand_kva"] == pytest.approx(108.0, rel=1e-6)
        assert _bus_row(res, "lv")["diversified_demand_kva"] == pytest.approx(0.9 * 308.0, rel=1e-6)


class TestLD4BoardHierarchy:
    def test_main_board_rolls_up_sub_boards(self):
        """[LD4] A main board feeding sub-boards by cable had no row, and its
        Ks was never applied. Four sub-boards × three 100 kVA loads: each
        0.9·300 = 270; main board Ks(4) = 0.8 → 864 kVA, 1247 A."""
        comps = [_util(), _bus("hv", 11), _tx("t", 1.0), _bus("main")]
        wires = [_w("u", "hv"), _w("hv", "t", "bottom", "primary"), _w("t", "main", "secondary", "top")]
        for k in range(4):
            comps += [_cable(f"c{k}"), _bus(f"s{k}")]
            wires += [_w("main", f"c{k}", "bottom", "from"), _w(f"c{k}", f"s{k}", "to", "top")]
            for j in range(3):
                comps.append(_load(f"l{k}{j}"))
                wires.append(_w(f"s{k}", f"l{k}{j}"))
        res = run_load_diversity(_p(comps, wires))
        main = _bus_row(res, "main")
        assert main["num_circuits"] == 4
        assert main["diversified_demand_kva"] == pytest.approx(864.0, rel=1e-6)
        assert main["demand_current_a"] == pytest.approx(864 / (math.sqrt(3) * 0.4), abs=0.1)
        assert _tx_row(res, "t")["demand_kva"] == pytest.approx(864.0, rel=1e-6)
        assert res["summary"]["total_demand_kva"] == pytest.approx(864.0, rel=1e-6)


class TestLD5IecKsTable:
    @pytest.mark.parametrize("n, ks", [(1, 1.0), (2, 0.9), (3, 0.9), (4, 0.8), (5, 0.8),
                                       (6, 0.7), (9, 0.7), (10, 0.6), (30, 0.6), (50, 0.6)])
    def test_rated_diversity_factor(self, n, ks):
        """[LD5] IEC 61439 rated diversity factor. The old table gave 0.85 at
        3 circuits and fell to 0.52 at 50 (non-conservative)."""
        assert coincidence_factor(n) == ks

    def test_mv_board_sums_its_circuits(self):
        """[LD5] IEC 61439 covers LV assemblies; an 11 kV board with three
        circuits is not diversified."""
        res = run_load_diversity(_p(
            [_util(), _bus("hv", 11), _load("a", 1000.0), _load("b", 1000.0), _load("c", 1000.0)],
            [_w("u", "hv"), _w("hv", "a"), _w("hv", "b"), _w("hv", "c")]))
        row = _bus_row(res, "hv")
        assert row["diversity_factor"] == 1.0
        assert row["diversified_demand_kva"] == pytest.approx(3000.0, rel=1e-6)


class TestLD6PhasorSum:
    def test_capacitor_bank_reduces_kva(self):
        """[LD6] 300 kVA at pf 0.8 + 150 kvar: |240 + j(180 − 150)| = 241.9
        kVA. The arithmetic kVA sum ignored the bank (300 kVA)."""
        res = run_load_diversity(_p(
            [_util(), _bus("hv", 11), _tx("t"), _bus("lv"), _load("a", 300.0, pf=0.8),
             _c("cap", "capacitor_bank", name="cap", rated_kvar=150, voltage_kv=0.4)],
            [_w("u", "hv"), _w("hv", "t", "bottom", "primary"), _w("t", "lv", "secondary", "top"),
             _w("lv", "a"), _w("lv", "cap")]))
        assert _tx_row(res, "t")["demand_kva"] == pytest.approx(math.hypot(240, 30), rel=1e-4)

    def test_leading_synchronous_motor(self):
        """[LD6] A leading synchronous motor supplies vars: 100 kVA pf 0.8
        lagging + 100 kVA pf 0.8 leading = 160 kW, 0 kvar → Ks(2)·160."""
        res = run_load_diversity(_p(
            [_bus("lv"), _load("a", 100.0, pf=0.8),
             _c("sm", "motor_synchronous", name="sm", rated_kva=100, power_factor=0.8, pf_mode="leading")],
            [_w("lv", "a"), _w("lv", "sm")]))
        assert res["buses"][0]["diversified_demand_kva"] == pytest.approx(0.9 * 160.0, rel=1e-6)

    def test_demand_equals_load_flow(self, monkeypatch):
        """[LD6] With Ks = 1 the transformer demand kW equals the load flow's
        total load (lossless network) for every load model."""
        monkeypatch.setattr(LD, "coincidence_factor", lambda n: 1.0)
        cab = lambda i: _c(i, "cable", name=i, r_per_km=0.0, x_per_km=0.0001, length_km=0.001, voltage_kv=0.4)
        prj = _p([_util(), _bus("hv", 11),
                  _c("t", "transformer", name="t", rated_mva=2.0, z_percent=0.01, x_r_ratio=1e4,
                     voltage_hv_kv=11, voltage_lv_kv=0.4, vector_group="Dyn11"),
                  cab("c0"), _bus("main"), _load("sl", 120.0, pf=0.8, df=0.7),
                  _c("im", "motor_induction", name="im", rated_kw=75, efficiency=0.94, power_factor=0.86, demand_factor=0.9),
                  _c("sm", "motor_synchronous", name="sm", rated_kva=150, power_factor=0.9, pf_mode="leading"),
                  _c("v", "vfd", name="v", rated_kw=55, efficiency=0.96, load_pct=80, displacement_pf=0.97, demand_factor=0.9),
                  cab("c1"), _load("far", 60.0),
                  cab("c2"), _c("db", "distribution_board", name="db", rated_kva=80, power_factor=0.88, demand_factor=0.6)],
                 [_w("u", "hv"), _w("hv", "t", "bottom", "primary"), _w("t", "c0", "secondary", "from"),
                  _w("c0", "main", "to", "top"), _w("main", "sl"), _w("main", "im"), _w("main", "sm"),
                  _w("main", "v"), _w("main", "c1", "bottom", "from"), _w("c1", "far", "to", "in"),
                  _w("main", "c2", "bottom", "from"), _w("c2", "db", "to", "in")])
        lf = run_load_flow(prj)
        assert lf.converged
        assert _tx_row(run_load_diversity(prj), "t")["demand_kw"] == pytest.approx(
            lf.buses["hv"].p_mw * 1000, rel=1e-4)


class TestLD7ReferenceFactors:
    def test_no_iec_attribution_for_demand_factors(self):
        """[LD7] The per-load demand factors were shown as 'IEC reference'
        values; no IEC standard tabulates them."""
        res = run_load_diversity(_p([_bus("lv"), _load("a")], [_w("lv", "a")]))
        refs = res["reference_demand_factors"]
        assert refs and all(r["source"] for r in refs.values())
        assert not any("IEC" in r["source"] for r in refs.values())
        assert "iec_demand_factors" not in res


class TestLD8BlankInputs:
    def test_blank_demand_factor(self):
        """[LD8] A cleared demand factor ('') raised ValueError → HTTP 500."""
        res = run_load_diversity(_p(
            [_bus("lv"), _c("a", "static_load", name="a", rated_kva=100, power_factor=0.9, demand_factor="")],
            [_w("lv", "a")]))
        assert res["buses"][0]["diversified_demand_kva"] == pytest.approx(100.0)
