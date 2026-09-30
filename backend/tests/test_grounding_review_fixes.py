"""Regression tests for the grounding-system review (GROUNDING_REVIEW.md).

Each test reproduces the ORIGINAL defect against an independent reference:
IEEE 80-2013 Annex B / Table 1 / Table 2, a hand zero-sequence current
division, or the method-of-moments reference solve
(scratchpad v3_grid_bem.py, recorded in the write-up).
"""

import pytest

from backend.models.schemas import Component, ProjectData, Wire
from backend.analysis.fault import run_fault_analysis
from backend.analysis.grounding_system import (
    _compute_conductor_size, _compute_grid_resistance, _compute_mesh_voltage,
    _compute_K_m, _compute_K_ii, _compute_K_i, _two_layer_grid_ratios,
    run_grounding_analysis,
)

KCMIL_PER_MM2 = 1.973525


def _c(cid, ctype, props):
    return Component(id=cid, type=ctype, x=0, y=0, props=props)


def _w(wid, a, b, fp, tp):
    return Wire(id=wid, fromComponent=a, fromPort=fp, toComponent=b, toPort=tp)


def _project(utility_grounding="solidly", mv_props=None, extra=None):
    """Utility 11 kV 500 MVA → MV bus → Dyn11 2 MVA → LV bus."""
    comps = [
        _c("u", "utility", {"name": "Grid", "voltage_kv": 11, "fault_mva": 500,
                            "x_r_ratio": 15, "z0_z1_ratio": 1.0, "grounding": utility_grounding}),
        _c("b1", "bus", {"name": "MV", "voltage_kv": 11, **(mv_props or {})}),
        _c("t", "transformer", {"name": "TX", "rated_mva": 2.0, "z_percent": 6.0, "x_r_ratio": 10,
                                "voltage_hv_kv": 11, "voltage_lv_kv": 0.4, "vector_group": "Dyn11",
                                "grounding_hv": "ungrounded", "grounding_lv": "solidly_grounded"}),
        _c("b2", "bus", {"name": "LV", "voltage_kv": 0.4}),
    ]
    wires = [_w("w1", "u", "b1", "out", "top"), _w("w2", "b1", "t", "bottom", "primary"),
             _w("w3", "t", "b2", "secondary", "top")]
    for comp, wire in (extra or []):
        comps.append(comp)
        wires.append(wire)
    return ProjectData(projectName="g", baseMVA=100.0, frequency=50, components=comps, wires=wires)


def _bus(result, name):
    return next(b for b in result["buses"] if b["bus_name"] == name)


# ── [G1] two-layer soil ───────────────────────────────────────────────────────

class TestG1TwoLayerSoil:
    """IEEE 80 Example 1 grid (70 × 70 m, 11 × 11, h = 0.5 m, no rods) in
    ρ1 = 400 Ω·m. Reference ratios from the independent method-of-moments
    script (4 segments per mesh side): rock below (ρ2 = 4000, h1 = 2 m)
    R × 6.262, E_m × 2.368; water table (ρ2 = 40, h1 = 5 m) R × 0.294."""

    def test_mesh_voltage_over_rock_is_raised(self):
        """The old model kept ρ1 for E_m (ratio 1.0) — 2.4× non-conservative."""
        R, Em, _ = _two_layer_grid_ratios(70, 70, 11, 11, 0.5, 0.01, 0, 0.0, 400.0, 4000.0, 2.0)
        assert R == pytest.approx(6.262, rel=0.02)
        assert Em == pytest.approx(2.368, rel=0.08)
        assert Em >= 2.368 * 0.99   # never below the reference (discretisation errs high)

    def test_resistance_over_water_table(self):
        """The old equivalent hemisphere gave F = 0.101 — R_g and GPR 2.9× low."""
        R, Em, _ = _two_layer_grid_ratios(70, 70, 11, 11, 0.5, 0.01, 0, 0.0, 400.0, 40.0, 5.0)
        assert R == pytest.approx(0.294, rel=0.02)
        assert Em == pytest.approx(0.690, rel=0.03)

    def test_pipeline_scales_uniform_ieee80_values(self):
        """End to end the uniform IEEE 80 E_m is multiplied by the E_m ratio."""
        grid = {"soil_resistivity": 400, "grid_length": 70, "grid_width": 70, "num_conductors_x": 11,
                "num_conductors_y": 11, "num_ground_rods": 0, "conductor_diameter": 0.01,
                "grid_depth": 0.5}
        uni = _bus(run_grounding_analysis(_project(mv_props=grid)), "MV")
        two = _bus(run_grounding_analysis(_project(mv_props={
            **grid, "two_layer_soil": "on", "soil_resistivity_lower": 4000, "upper_layer_thickness": 2.0})), "MV")
        assert two["mesh_voltage_v"] == pytest.approx(uni["mesh_voltage_v"] * two["two_layer_ratio_Em"], rel=2e-3)
        assert two["grid_resistance_ohm"] == pytest.approx(uni["grid_resistance_ohm"] * two["two_layer_ratio_R"], rel=1e-3)
        assert two["mesh_voltage_v"] > 2.0 * uni["mesh_voltage_v"]


# ── [G2] grid current: local neutral return and split factor ────────────────

class TestG2GridCurrent:
    def test_lv_bus_at_its_transformer_puts_no_current_into_earth(self):
        """An LV earth fault at the Dyn11's own LV bus returns through the
        transformer neutral bonded to the same grid (IEEE 80 §15.1). The old
        code drove the full 51.6 kA into the soil (GPR 86.6 kV)."""
        lv = _bus(run_grounding_analysis(_project()), "LV")
        assert lv["remote_fraction"] == 0.0
        assert lv["fault_current_ka"] == 0.0 and lv["gpr_v"] == 0.0
        # the grid conductor still carries the whole fault current
        assert lv["conductor_current_ka"] == pytest.approx(51.64, abs=0.05)
        assert any("returns through a transformer or generator neutral" in i for i in lv["notes"])

    def test_utility_fed_bus_keeps_the_full_current(self):
        mv = _bus(run_grounding_analysis(_project()), "MV")
        assert mv["remote_fraction"] == 1.0
        assert mv["fault_current_ka"] == pytest.approx(27.46, abs=0.02)

    def test_local_earthing_transformer_split_by_zero_sequence_admittance(self):
        """YNd11 5 MVA 6 % earthing transformer on the MV bus in parallel with
        the utility: Z0_u = 1.1·100/500 = 0.22 pu, Z0_t = 0.06·100/5 = 1.2 pu,
        remote share ≈ (1/0.22)/(1/0.22 + 1/1.2) = 0.845."""
        gt = _c("tg", "transformer", {"name": "GT", "rated_mva": 5.0, "z_percent": 6.0, "x_r_ratio": 10,
                                      "voltage_hv_kv": 11, "voltage_lv_kv": 0.4, "vector_group": "YNd11",
                                      "grounding_hv": "solidly_grounded", "grounding_lv": "ungrounded"})
        p = _project(extra=[(gt, _w("w9", "b1", "tg", "bottom", "primary"))])
        frac = run_fault_analysis(p, fault_bus_id=None, fault_type=None).buses["b1"].ik1_remote_fraction
        assert frac == pytest.approx(0.845, abs=0.005)

    def test_split_factor_scales_grid_current_not_conductor_current(self):
        full = _bus(run_grounding_analysis(_project()), "MV")
        half = _bus(run_grounding_analysis(_project(mv_props={"current_split_factor": 0.6})), "MV")
        assert half["fault_current_ka"] == pytest.approx(0.6 * full["fault_current_ka"], abs=0.02)
        assert half["min_conductor_mm2"] == pytest.approx(full["min_conductor_mm2"], rel=1e-9)


# ── [G3] joint temperature limit ─────────────────────────────────────────────

class TestG3JointLimit:
    def test_bolted_joint_uses_250C(self):
        """IEEE 80 Table 2: hard-drawn copper K_f = 11.78 at T_m = 250 °C
        (bolted) vs 7.06 at the 1084 °C fusing point — the old code always
        sized to fusing, 40 % under-size for a mechanical joint."""
        a = _compute_conductor_size(10_000, 1.0, "copper_hard", 40.0, "bolted")
        assert a * KCMIL_PER_MM2 / 10 == pytest.approx(11.78, rel=0.005)
        a0 = _compute_conductor_size(10_000, 1.0, "copper_hard", 40.0)
        assert a0 * KCMIL_PER_MM2 / 10 == pytest.approx(7.06, rel=0.005)

    def test_joint_limit_never_raises_a_low_melting_material(self):
        """Galvanised steel melts (zinc) at 419 °C — a 450 °C brazed limit
        leaves it at 419 °C."""
        assert (_compute_conductor_size(10_000, 1.0, "steel_galvanized", 40.0, "brazed")
                == pytest.approx(_compute_conductor_size(10_000, 1.0, "steel_galvanized", 40.0)))


# ── [G4] no earth-fault path ─────────────────────────────────────────────────

class TestG4ThreePhaseFallback:
    def test_fallback_to_three_phase_current_is_disclosed(self):
        mv = _bus(run_grounding_analysis(_project(utility_grounding="ungrounded")), "MV")
        assert mv["symmetrical_fault_ka"] == pytest.approx(26.24, abs=0.01)
        assert any("No earth-fault current at this bus" in i for i in mv["notes"])


# ── [G5] transcription ───────────────────────────────────────────────────────

class TestG5Transcription:
    def test_zinc_coated_steel_kf(self):
        """IEEE 80 Table 2 zinc-coated steel rod K_f = 28.96 (TCAP 3.93, was
        3.846 — the copper-clad value)."""
        a = _compute_conductor_size(10_000, 1.0, "steel_galvanized", 40.0)
        assert a * KCMIL_PER_MM2 / 10 == pytest.approx(28.96, rel=0.003)


# ── verified-correct anchor kept exact ───────────────────────────────────────

def test_ieee80_example1_unchanged():
    """IEEE 80 Annex B Example 1: R_g 2.78 Ω, E_m 1002 V (uniform soil path untouched)."""
    assert _compute_grid_resistance(400, 4900, 1540, 0.5) == pytest.approx(2.78, abs=0.01)
    kii = _compute_K_ii(11, False)
    em = _compute_mesh_voltage(400, 1908, _compute_K_m(7, 0.01, 0.5, 11, kii), _compute_K_i(11), 1540)
    assert em == pytest.approx(1002, rel=0.002)


def test_validity_range_note():
    mv = _bus(run_grounding_analysis(_project(mv_props={"grid_depth": 3.0})), "MV")
    assert any("outside 0.25–2.5 m" in i for i in mv["notes"])
