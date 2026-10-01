"""Conductor-temperature review — regression tests for CT1, CT2, L1, L2.

Each test reproduces the ORIGINAL defect against a reference taken from the
standard itself — IEC 60909-0:2001 §2.4 (maximum currents: line resistance at
20 °C), §2.5 eq. (3) (minimum currents: R_L = [1 + 0.004(θe − 20)]·R_L20),
IEC 60364-4-43 Table 43A (final short-circuit temperatures) — or from the
IEC 60228 20 °C conductor resistances, never from the engine's earlier output.
IDs match the ``[CTn]`` / ``[Ln]`` markers in ``backend/analysis/fault.py`` and
``backend/analysis/conductor_temp.py``. Write-up: reviews/CONDUCTOR_TEMP_REVIEW.md.
"""

import math

import pytest

from backend.models.schemas import Component, ProjectData, Wire
from backend.analysis import conductor_temp as CT
from backend.analysis.fault import run_fault_analysis
from backend.analysis.dc_shortcircuit import _r20_per_km


def _c(cid, ctype, props):
    return Component(id=cid, type=ctype, x=0, y=0, props=props)


def _w(wid, a, b):
    return Wire(id=wid, fromComponent=a, fromPort="o", toComponent=b, toPort="i")


L_KM = 0.1


def _net(cable_props):
    """Grid 250 MVA → 11 kV → 1 MVA 6 % Dyn11 → 0.4 kV → 100 m line → bus."""
    props = {"length_km": L_KM, "voltage_kv": 0.4, "rated_amps": 250}
    props.update(cable_props)
    return ProjectData(projectName="t", baseMVA=100, frequency=50, components=[
        _c("u", "utility", {"voltage_kv": 11, "fault_mva": 250, "x_r_ratio": 15}),
        _c("b1", "bus", {"voltage_kv": 11}),
        _c("t1", "transformer", {"rated_mva": 1.0, "z_percent": 6, "x_r_ratio": 8,
                                 "voltage_hv_kv": 11, "voltage_lv_kv": 0.4,
                                 "vector_group": "Dyn11"}),
        _c("b2", "bus", {"voltage_kv": 0.4}),
        _c("k1", "cable", props),
        _c("b3", "bus", {"voltage_kv": 0.4}),
    ], wires=[_w("1", "u", "b1"), _w("2", "b1", "t1"), _w("3", "t1", "b2"),
              _w("4", "b2", "k1"), _w("5", "k1", "b3")])


def _hand_ik3(r_line_ohm, x_line_ohm, c=1.10):
    """IEC 60909-0 hand calculation at the 0.4 kV far-end bus: Z_Q (eq. 15)
    referred to LV, K_T (eq. 12a, c_max per §6.3.3), plus the line."""
    zq = c * 11 ** 2 / 250 * (0.4 / 11) ** 2
    xq = zq / math.sqrt(1 + 1 / 15 ** 2)
    rq = xq / 15
    zt = 0.06 * 0.4 ** 2 / 1.0
    rt = zt / math.sqrt(1 + 8 ** 2)
    xt = rt * 8
    kt = 0.95 * 1.10 / (1 + 0.6 * xt / 0.4 ** 2)
    z = complex(rq + kt * rt + r_line_ohm, xq + kt * xt + x_line_ohm)
    return c * 0.4 / (math.sqrt(3) * abs(z))


# (library id, library r_per_km (hot), IEC 60228 R20, x_per_km, extra props)
_LIB = [
    ("cu_xlpe_16_lv", 1.466, 1.15, 0.082, {}),
    ("cu_xlpe_95_lv", 0.2461, 0.193, 0.080, {}),
    ("al_xlpe_95_lv", 0.4102, 0.320, 0.080, {}),
    ("cu_pvc_16_lv", 1.38, 1.15, 0.082, {}),
]


class TestCT1MaximumStudyAt20C:
    """IEC 60909-0 §2.4: 'resistance R_L of lines (overhead lines and cables)
    are to be introduced at a temperature of 20 °C'. The engine used the hot
    library value (90 °C XLPE / 70 °C PVC) and overhead lines at 75 °C:
    Ik″ at the far end of 100 m of 16 mm² Cu XLPE read 1.705 kA, not 2.158 kA
    (−21 %); 95 mm² −13 %; behind an ACSR Dog line −6 %. Non-conservative for
    breaking duty, cable withstand and arc flash."""

    @pytest.mark.parametrize("sid,r_hot,r20,x,extra", _LIB)
    def test_library_cable_at_iec_60228_r20(self, sid, r_hot, r20, x, extra):
        p = _net(dict(standard_type=sid, r_per_km=r_hot, x_per_km=x, **extra))
        ik = run_fault_analysis(p, fault_type="3phase").buses["b3"].ik3
        assert ik == pytest.approx(_hand_ik3(r20 * L_KM, x * L_KM), rel=2e-3)

    def test_overhead_line_at_20c(self):
        p = _net({"construction": "overhead", "overhead_type": "acsr_dog",
                  "r_per_km": 0.2733, "x_per_km": 0.35})
        ik = run_fault_analysis(p, fault_type="3phase").buses["b3"].ik3
        # pre-fix 4.454 kA (75 °C) vs 4.742 kA
        assert ik == pytest.approx(_hand_ik3(0.2733 * L_KM, 0.35 * L_KM), rel=1e-3)

    def test_study_assumptions_disclose_20c(self):
        r = run_fault_analysis(_net({"standard_type": "cu_xlpe_16_lv", "r_per_km": 1.466,
                                     "x_per_km": 0.082}))
        assert any("20 °C" in a and "§2.4" in a for a in r.study_assumptions)

    def test_load_flow_basis_unchanged(self):
        """The fault study's copy is rebuilt; the caller's project keeps the
        hot value that load flow and volt drop use."""
        p = _net({"standard_type": "cu_xlpe_16_lv", "r_per_km": 1.466, "x_per_km": 0.082})
        run_fault_analysis(p)
        assert next(c for c in p.components if c.id == "k1").props["r_per_km"] == 1.466


class TestCT2MinimumStudyEq3:
    """IEC 60909-0 §2.5 eq. (3): R_L = [1 + 0.004(θe − 20)]·R_L20 — on the
    20 °C resistance. The engine multiplied the HOT library value, so a
    '70 °C' study ran XLPE at R20 × 1.53 (≈152 °C) and PVC at × 1.44."""

    @pytest.mark.parametrize("sid,r_hot,r20,x,extra", _LIB)
    @pytest.mark.parametrize("theta", [70.0, 160.0])
    def test_fixed_temperature(self, sid, r_hot, r20, x, extra, theta):
        p = _net(dict(standard_type=sid, r_per_km=r_hot, x_per_km=x, **extra))
        ik = run_fault_analysis(p, fault_type="3phase", voltage_factor=0.95,
                                conductor_temperature_c=theta).buses["b3"].ik3
        r = r20 * (1 + 0.004 * (theta - 20)) * L_KM
        assert ik == pytest.approx(_hand_ik3(r, x * L_KM, c=0.95), rel=2e-3)

    @pytest.mark.parametrize("sid,r_hot,r20,x,theta_e", [
        ("cu_xlpe_16_lv", 1.466, 1.15, 0.082, 250.0),
        ("al_xlpe_95_lv", 0.4102, 0.320, 0.080, 250.0),
        ("cu_pvc_16_lv", 1.38, 1.15, 0.082, 160.0),
    ])
    def test_end_of_fault_per_insulation(self, sid, r_hot, r20, x, theta_e):
        """'final': each line at its IEC 60364-4-43 Table 43A final temperature."""
        p = _net(dict(standard_type=sid, r_per_km=r_hot, x_per_km=x))
        ik = run_fault_analysis(p, fault_type="3phase", voltage_factor=0.95,
                                conductor_temperature_c=CT.END_OF_FAULT).buses["b3"].ik3
        r = r20 * (1 + 0.004 * (theta_e - 20)) * L_KM
        assert ik == pytest.approx(_hand_ik3(r, x * L_KM, c=0.95), rel=2e-3)

    def test_overhead_end_of_fault_200c_own_alpha(self):
        p = _net({"construction": "overhead", "overhead_type": "acsr_dog",
                  "r_per_km": 0.2733, "x_per_km": 0.35})
        ik = run_fault_analysis(p, fault_type="3phase", voltage_factor=0.95,
                                conductor_temperature_c="final").buses["b3"].ik3
        r = 0.2733 * (1 + 0.00403 * 180) * L_KM
        assert ik == pytest.approx(_hand_ik3(r, 0.35 * L_KM, c=0.95), rel=1e-3)

    def test_final_temperatures(self):
        assert CT.final_temp_c({"standard_type": "cu_xlpe_16_lv"}) == 250
        assert CT.final_temp_c({"standard_type": "cu_pvc_16_lv"}) == 160
        assert CT.final_temp_c({"standard_type": "te_cu_2.5"}) == 160
        assert CT.final_temp_c({"insulation": "PVC", "size_mm2": 400}) == 140
        assert CT.final_temp_c({"construction": "overhead"}) == 200
        assert CT.final_temp_c({}) == 250          # palette basis: Cu XLPE

    def test_steady_state_ik_min_in_the_maximum_study(self):
        """§4.6 Ik_min carries §2.5's conditions, so a maximum study (lines at
        20 °C) must still report it with the lines at θe."""
        p = _net({"standard_type": "cu_xlpe_16_lv", "r_per_km": 1.466, "x_per_km": 0.082})
        b = run_fault_analysis(p, fault_type="3phase").buses["b3"]
        m = run_fault_analysis(p, fault_type="3phase", voltage_factor=0.95,
                               conductor_temperature_c="final").buses["b3"]
        assert b.ik_steady_min == pytest.approx(m.ik3, rel=2e-3)
        assert b.ik_steady_min < 0.6 * b.ik3

    def test_request_accepts_final(self):
        p = ProjectData(projectName="t", components=[], wires=[], conductorTemperatureC="final")
        assert p.conductorTemperatureC == "final"
        assert ProjectData(projectName="t", components=[], wires=[],
                           conductorTemperatureC=70).conductorTemperatureC == 70.0


class TestL1OverheadMaterialFromLibraryId:
    """The panel copies r/x/rating from the overhead library, not `material`,
    so an AAAC line took aluminium's α (0.00403) instead of 0.0036: R at 75 °C
    1.222 × R20 instead of 1.198 × R20."""

    def test_aaac_alpha(self):
        p = {"construction": "overhead", "overhead_type": "aaac_100", "r_per_km": 0.3}
        CT.apply_to_props(p)
        assert p["r_per_km"] == pytest.approx(0.3 * (1 + 0.0036 * 55), rel=1e-6)

    def test_explicit_material_wins(self):
        assert CT.overhead_material({"overhead_type": "aaac_100", "material": "ACSR"}) == "ACSR"
        assert CT.overhead_material({"overhead_type": "acsr_dog"}) == "ACSR"
        assert CT.overhead_material({}) is None


class TestL2HotFactorFromLibraryId:
    """The DC engine divided every insulated cable by the Cu XLPE 1.275 — its
    `conductor` / `insulation` props are never copied from the library — so a
    PVC cable's 20 °C resistance came out 6 % low."""

    @pytest.mark.parametrize("sid,r_hot,r20", [
        ("cu_pvc_16_lv", 1.38, 1.15), ("al_xlpe_95_lv", 0.4102, 0.320),
        ("cu_xlpe_16_lv", 1.466, 1.15), ("te_cu_4", 5.5, 4.61),
    ])
    def test_dc_r20(self, sid, r_hot, r20):
        assert _r20_per_km({"standard_type": sid, "r_per_km": r_hot}) == pytest.approx(r20, rel=0.025)

    def test_explicit_props_win(self):
        assert CT.insulated_hot_factor({"conductor": "Al", "insulation": "PVC",
                                        "standard_type": "cu_xlpe_16_lv"}) == 1.20
