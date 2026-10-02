"""Regression tests for the DC arc flash review (2026-10-02, DA1-DA5 + lesser
notes).

References built here, independently of the engine: the Stokes & Oppenländer
operating point by bisection of I·R_sys + (20 + 0.534·G)·I^0.12 = V_sys, the
Ammerman/CED spherical incident energy 0.239·V_arc·I_arc·t / (4π·d²) (cal,
d in cm), and the NFPA 70E Annex D.5 arc-in-a-box factor of 3.

Run with:  python -m pytest backend/tests/test_dc_arcflash_review_fixes.py -q
"""

import math

import pytest

from backend.models.schemas import Component, ProjectData, Wire
from backend.analysis.arcflash import _fuse_prearc_time
from backend.analysis.dc_arcflash import (
    calc_dc_arc_flash_boundary, calc_dc_incident_energy, run_dc_arc_flash, solve_dc_arc,
)
from backend.analysis.dc_shortcircuit import run_dc_short_circuit


def _c(cid, ctype, props):
    return Component(id=cid, type=ctype, x=0, y=0, props=props)


def _w(k, a, ap, b, bp):
    return Wire(id=f"w{k}", fromComponent=a, fromPort=ap, toComponent=b, toPort=bp)


def _hand_arc(v, ibf, gap):
    r, a = v / ibf, 20 + 0.534 * gap
    lo, hi = 0.0, ibf
    for _ in range(300):
        m = 0.5 * (lo + hi)
        if m * r + a * m ** 0.12 > v:
            hi = m
        else:
            lo = m
    i = 0.5 * (lo + hi)
    return i, a * i ** 0.12


def _hand_e(i, v_arc, t, d_mm, box=1.0):
    return 0.239 * v_arc * i * t / (4 * math.pi * (d_mm / 10) ** 2) * box


def _dc_net(**bus_props):
    """125 V battery → DC board → 200 A fuse → 20 m cable → DC panel, plus an
    unrelated AC bus."""
    board = {"system": "dc", "voltage_dc_v": 125, "name": "DC-SWBD",
             "working_distance_mm": 455, "conductor_gap_mm": 19}
    board.update(bus_props)
    comps = [
        _c("bat", "dc_battery", {"nominal_v": 125, "internal_r_mohm": 4, "ah_capacity": 800}),
        _c("B", "bus", board),
        _c("f", "fuse", {"rated_current_a": 200}),
        _c("k", "cable", {"r_per_km": 0.32, "x_per_km": 0.08, "length_km": 0.02,
                          "voltage_kv": 0.125}),
        _c("P", "bus", {"system": "dc", "voltage_dc_v": 125, "name": "DC-PANEL",
                        "working_distance_mm": 455}),
        _c("u", "utility", {"voltage_kv": 0.4, "fault_mva": 20}),
        _c("ac", "bus", {"voltage_kv": 0.4, "name": "AC-BUS"}),
    ]
    wires = [_w(1, "bat", "dc", "B", "p0"), _w(2, "B", "p0", "f", "top"),
             _w(3, "f", "bottom", "k", "from"), _w(4, "k", "to", "P", "p0"),
             _w(5, "u", "out", "ac", "at_0")]
    return ProjectData(projectName="t", baseMVA=100, frequency=50,
                       components=comps, wires=wires)


class TestDA1DCBuses:
    """[DA1] DC buses are studied, with the IEC 61660 fault current; AC buses are not."""

    def test_dc_buses_only(self):
        res = run_dc_arc_flash(_dc_net())
        # Pre-fix: only 'ac' was studied (as if it were a 400 V DC system)
        assert set(res.buses) == {"B", "P"}

    def test_bolted_current_from_dc_short_circuit(self):
        p = _dc_net()
        ibf = run_dc_short_circuit(p).buses["B"].ik_ka * 1000
        i, v_arc = _hand_arc(125, ibf, 19)
        r = run_dc_arc_flash(p).buses["B"]
        assert r.bolted_fault_ka == pytest.approx(ibf / 1000, abs=0.006)
        assert r.dc_arcing_current_a == pytest.approx(i, abs=0.06)
        assert r.arc_voltage_v == pytest.approx(v_arc, abs=0.06)

    def test_explicit_override_wins(self):
        r = run_dc_arc_flash(_dc_net(dc_bolted_fault_ka=5.0)).buses["B"]
        assert r.bolted_fault_ka == 5.0


class TestDA2Enclosure:
    """[DA2] An arc in an enclosure: × 3 (NFPA 70E Annex D.5)."""

    def test_enclosed_is_three_times_open_air(self):
        enclosed = run_dc_arc_flash(_dc_net()).buses["B"]
        open_air = run_dc_arc_flash(_dc_net(electrode_config="VOA")).buses["B"]
        assert enclosed.incident_energy_cal == pytest.approx(3 * open_air.incident_energy_cal, rel=2e-3)
        i, v_arc = _hand_arc(125, open_air.bolted_fault_ka * 1000, 19)
        assert enclosed.incident_energy_cal == pytest.approx(
            _hand_e(i, v_arc, enclosed.clearing_time_s, 455, 3), rel=2e-3)

    def test_boundary_scales_with_root_three(self):
        i, gap, t = 6000.0, 25.0, 0.5
        assert (calc_dc_arc_flash_boundary(i, gap, t, box_factor=3.0)
                == pytest.approx(math.sqrt(3) * calc_dc_arc_flash_boundary(i, gap, t), abs=1))


class TestDA3DCDeviceWalk:
    """[DA3] The clearing time comes from the DC protective device."""

    def test_fuse_on_dc_feeder_clears(self):
        r = run_dc_arc_flash(_dc_net()).buses["P"]
        expected = min(max(1.2 * _fuse_prearc_time(200, r.dc_arcing_current_a), 0.01), 2.0)
        # Pre-fix: no DC source in the walk → device skipped → 2.0 s
        assert r.clearing_time_s == pytest.approx(expected, abs=1e-3)
        assert r.clearing_time_s < 0.1


class TestDA4Gap:
    """[DA4] The panel's conductor_gap_mm field is honoured."""

    def test_conductor_gap_field(self):
        r = run_dc_arc_flash(_dc_net(conductor_gap_mm=40)).buses["B"]
        assert r.gap_mm == 40


class TestDA5Label:
    def test_label_per_nfpa_70e(self):
        lbl = run_dc_arc_flash(_dc_net()).buses["B"].label_html
        assert "at 455 mm" in lbl
        assert "Minimum Arc Rating" in lbl
        assert "Category" not in lbl


class TestLesserNotes:
    def test_calorie_matches_published_form(self):
        """[DA-L1] 1 cal = 4.184 J (the CED/Ammerman 0.239 form). The
        verification case: 250 V, 10 kA, 25 mm, 455 mm, 2 s, open air."""
        i, v_arc = _hand_arc(250, 10000, 25)
        e = calc_dc_incident_energy(i, 25, 2.0, 455)
        assert e == pytest.approx(_hand_e(i, v_arc, 2.0, 455), rel=1e-4)

    def test_operating_point_exact_near_extinction(self):
        """[DA-L2] Arc voltage close to the system voltage: the old 30-step
        fixed point was 0.16 % off; bisection is exact."""
        i_hand, _ = _hand_arc(150, 2000, 100)
        i, _, _ = solve_dc_arc(150, 150 / 2000, 100)
        assert i == pytest.approx(i_hand, rel=1e-6)

    def test_no_dc_buses_message(self):
        p = _dc_net()
        p.components = [c for c in p.components if c.id in ("u", "ac")]
        p.wires = [w for w in p.wires if w.id == "w5"]
        res = run_dc_arc_flash(p)
        assert res.buses == {}
        assert "No DC buses" in res.warnings[0]
