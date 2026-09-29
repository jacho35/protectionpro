"""IEC 60364-5-52 tables review — regression tests for findings T1–T5, L1–L3.

The reference is the standard's own tables (Annex B), held in
``testing/iec-60364-tables-review/iec_60364_5_52_data.json`` and transcribed
from a published reproduction — never the engine's earlier output. IDs match
the ``[Tn]`` / ``[Ln]`` markers in ``backend/analysis/iec_60364_tables.py``.
"""

import json
import pathlib
import re

import pytest

from backend.analysis import iec_60364_tables as T
from backend.analysis.iec_60364_data import IEC_AMPACITY, IEC_GROUPING

ROOT = pathlib.Path(__file__).resolve().parents[2]
REF = json.loads((ROOT / "testing/iec-60364-tables-review/iec_60364_5_52_data.json").read_text())


# ── T1: every value is the standard's ──────────────────────────────────

class TestT1Transcription:
    def test_every_capacity_matches_reference(self):
        n = 0
        for key, by_loaded in REF["ampacity"].items():
            for loaded, by_method in by_loaded.items():
                for method, cells in by_method.items():
                    for size, amps in cells.items():
                        assert T.base_ampacity_a(float(size), method, key.split("_")[1],
                                                 key.split("_")[0], int(loaded)) == amps, \
                            (key, loaded, method, size)
                        n += 1
        assert n > 700

    @pytest.mark.parametrize("size,method,cond,ins,loaded,amps", [
        # Spot values read off the tables, including those the old table got wrong
        (16, "C", "Cu", "PVC", 2, 85),     # B.52.2 (engine had 94)
        (16, "C", "Cu", "PVC", 3, 76),     # B.52.4
        (16, "D1", "Cu", "PVC", 2, 78),    # B.52.2 (engine had 80)
        (95, "C", "Cu", "XLPE", 3, 278),   # B.52.5
        (25, "E", "Cu", "PVC", 2, 119),    # B.52.10 multi-core in air (engine "E" was F's 131)
        (25, "F", "Cu", "PVC", 3, 110),    # B.52.10 trefoil
        (25, "G", "Cu", "PVC", 3, 146),    # B.52.10 spaced horizontal
    ])
    def test_spot_values(self, size, method, cond, ins, loaded, amps):
        got = T.base_ampacity_a(size, method, cond, ins, loaded)
        ref = REF["ampacity"][f"{ins.lower()}_{cond.lower()}"][str(loaded)][method][str(float(size))]
        assert got == ref == amps

    def test_frontend_twin_identical(self):
        """frontend/js/iec-60364-data.js carries exactly the backend values."""
        js = (ROOT / "frontend/js/iec-60364-data.js").read_text()
        a = js.index("const IEC_AMPACITY = {")
        body = js[a:js.index("};", a)]
        fe, key, loaded = {}, None, None
        for line in body.splitlines():
            m = re.match(r"\s{2}(\w+): \{$", line)
            if m:
                key = m.group(1); continue
            m = re.match(r"\s{4}(\d): \{$", line)
            if m:
                loaded = int(m.group(1)); continue
            m = re.match(r"\s{6}(\w+): \{ (.*) \},$", line)
            if m:
                for s, v in re.findall(r"'([\d.]+)': ([\d.]+)", m.group(2)):
                    fe[(key, loaded, m.group(1), float(s))] = float(v)
        be = {(k, l, m, float(s)): float(v) for k, bl in IEC_AMPACITY.items()
              for l, bm in bl.items() for m, c in bm.items() for s, v in c.items()}
        assert fe == be


# ── T2: loaded conductors ──────────────────────────────────────────────

class TestT2LoadedConductors:
    def test_three_phase_is_lower(self):
        assert T.base_ampacity_a(16, "B1", "Cu", "PVC", loaded=2) == 76
        assert T.base_ampacity_a(16, "B1", "Cu", "PVC", loaded=3) == 68
        assert T.base_ampacity_a(16, "B1", "Cu", "PVC") == 68       # default = 3

    def test_db_way_uses_its_phase_count(self):
        from backend.analysis import db_circuit_check as D
        seen = []
        real = D.installed_ampacity

        def spy(*a, **k):
            seen.append(k.get("loaded"))
            return real(*a, **k)
        D.installed_ampacity = spy
        try:
            install = {"method": "B1", "conductor": "Cu", "insulation": "PVC",
                       "ambient_c": 30, "grouping": "bunched", "circuits": 1,
                       "soil_kmw": None, "depth_m": None}
            for way in ({"cable_mm2": 16, "cable_m": 10, "breaker_a": 40, "poles": "3P"},
                        {"cable_mm2": 16, "cable_m": 10, "breaker_a": 40, "poles": "1P"}):
                try:
                    D._check_way(way, None, "DB", 400, 230, install, None, "", 0, False,
                                 {}, 3, 5)
                except Exception:
                    pass   # only the ampacity call is under test
        finally:
            D.installed_ampacity = real
        assert seen[:2] == [3, 2]


# ── T3: methods ────────────────────────────────────────────────────────

class TestT3Methods:
    def test_all_reference_methods_present(self):
        assert list(T.IEC_INSTALLATION_METHODS) == ["A1", "A2", "B1", "B2", "C", "D1",
                                                    "D2", "E", "F", "G"]

    def test_method_descriptions(self):
        m = T.IEC_INSTALLATION_METHODS
        assert "Multi-core" in m["E"]["description"]            # was "single-core touching"
        assert "touching" in m["F"]["description"]
        assert "spaced" in m["G"]["description"]
        assert m["D1"]["environment"] == m["D2"]["environment"] == "ground"

    def test_g_not_tabulated_single_phase(self):
        assert T.base_ampacity_a(95, "G", "Cu", "PVC", loaded=2) is None


# ── T4: grouping ───────────────────────────────────────────────────────

class TestT4Grouping:
    @pytest.mark.parametrize("row,n,f", [
        ("bunched", 6, 0.57), ("single_layer_wall_floor", 6, 0.72),
        ("single_layer_under_ceiling", 1, 0.95), ("single_layer_perforated_tray", 6, 0.73),
        ("single_layer_ladder_cleats", 6, 0.79),
        ("buried_touching", 6, 0.50), ("buried_05m", 6, 0.80),
        ("ducts_mc_touching", 6, 0.60), ("ducts_sc_touching", 6, 0.60),
    ])
    def test_rows_match_tables(self, row, n, f):
        assert T.grouping_factor(row, n)[0] == pytest.approx(f)

    def test_legacy_names_map_to_their_iec_row(self):
        # "floor" is B.52.17 row 2 (0.72 at 6), not the perforated-tray row it held
        assert T.derating_factors("C", 30, "PVC", "single_layer_floor", 6)["grouping"] == pytest.approx(0.72)
        assert T.derating_factors("C", 30, "PVC", "trefoil_tray_touching", 1)["grouping"] == pytest.approx(1.0)

    def test_buried_methods_use_burial_tables(self):
        """6 circuits touching: B.52.18 0.50 (direct), B.52.19 0.60 (ducts) —
        not the 0.57 of the unburied 'bunched' row."""
        assert T.derating_factors("D2", 20, "PVC", "bunched", 6)["grouping"] == pytest.approx(0.50)
        assert T.derating_factors("D1", 20, "PVC", "bunched", 6)["grouping"] == pytest.approx(0.60)


# ── T5 / L1–L3 ─────────────────────────────────────────────────────────

class TestT5NoDepthFactor:
    def test_depth_ignored(self):
        a = T.installed_ampacity(95, "D2", "Cu", "XLPE", 20, "buried_touching", 1, 2.5, 0.5)
        b = T.installed_ampacity(95, "D2", "Cu", "XLPE", 20, "buried_touching", 1, 2.5, None)
        assert a["derated_a"] == b["derated_a"] == a["base_a"]


class TestL1StepUpCounts:
    def test_between_counts_takes_next_up(self):
        assert T.grouping_factor("bunched", 10)[0] == pytest.approx(0.45)   # 12-circuit value
        assert T.grouping_factor("bunched", 25) == (pytest.approx(0.38), True)
        assert T.grouping_factor("single_layer_wall_floor", 15) == (pytest.approx(0.70), False)


class TestL3AluminiumSmallSizes:
    def test_al_from_2_5(self):
        assert T.base_ampacity_a(2.5, "B1", "Al", "PVC", loaded=2) == 18.5
        assert T.base_ampacity_a(1.5, "B1", "Al", "PVC", loaded=2) is None


# ── Saved calculator blocks are recomputed by cable sizing ─────────────

class TestSavedBlockRecomputed:
    def test_stale_derated_rating_replaced(self):
        from backend.analysis.cable_sizing import run_cable_sizing
        from backend.models.schemas import ProjectData, Component, Wire
        C = lambda i, t, p: Component(id=i, type=t, x=0, y=0, props=p)
        W = lambda i, a, b: Wire(id=i, fromComponent=a, fromPort="o", toComponent=b, toPort="i")
        block = {"applied": True, "method": "C", "conductor": "cu", "insulation": "pvc",
                 "size_mm2": 16, "ambient_c": 30, "grouping": "bunched", "circuits": 1,
                 "base_a": 94, "derating": 1.0, "derated_a": 94.0}   # old-table figure
        p = ProjectData(projectName="t", baseMVA=100.0, frequency=50, components=[
            C("u", "utility", {"name": "G", "voltage_kv": 0.4, "fault_mva": 20}),
            C("b1", "bus", {"name": "B1", "voltage_kv": 0.4}),
            C("k", "cable", {"name": "K", "conductor": "Cu", "insulation": "PVC", "size_mm2": 16,
                             "r_per_km": 1.38, "x_per_km": 0.08, "rated_amps": 94,
                             "length_km": 0.02, "voltage_kv": 0.4, "ampacity": block}),
            C("b2", "bus", {"name": "B2", "voltage_kv": 0.4}),
            C("l", "static_load", {"name": "L", "rated_kva": 20, "power_factor": 0.9}),
        ], wires=[W("1", "u", "b1"), W("2", "b1", "k"), W("3", "k", "b2"), W("4", "b2", "l")])
        r = run_cable_sizing(p)["cables"][0]
        assert r["derated_ampacity_a"] == pytest.approx(76.0)     # B.52.4 C 16 mm², 3 loaded
        assert any("recomputed" in w for w in r["warning_reasons"])
