"""IEC 60909 Short-Circuit Current Calculation.

Implements the full IEC 60909-0 fault current characterisation:
- I"k: Initial symmetrical short-circuit current (3Φ, SLG, LL, LLG)
- ip:  Peak short-circuit current (κ × √2 × I"k)
- Ib:  Symmetrical breaking current (μ/q decay factors)
- Ik:  Steady-state short-circuit current (synchronous reactance)

Includes motor contribution per IEC 60909-0 §13:
- Induction motors contribute sub-transient current that decays
- Synchronous motors contribute like generators (sustained)

Per-unit method on a common MVA base.
"""

import math
import re
from typing import Optional

import numpy as np
from ..models.schemas import ProjectData, FaultResults, FaultBranchContribution
from ..models.schemas import FaultResultBus as _FaultResultBusSchema


# IEC 60909-0 Table 1 voltage factor c_max: 1.10 for MV/HV, and 1.10 for LV
# systems with +10% voltage tolerance (modern standard practice; 1.05 applies
# only to legacy +6% LV systems). There is no project-level tolerance setting
# yet, so the +10% value is used everywhere — both in the fault equations and
# in the network-feeder equivalent impedance (IEC 60909-0 Eq. 15).
C_MAX = 1.10


class FaultResultBus(_FaultResultBusSchema):
    """Per-bus fault result extended with the 2026-07 audit-fix fields.

    Extends the schema model here (schemas.py is concurrently owned by
    another workstream). NOTE: for these fields to survive FastAPI's
    response_model serialization the same Optional fields must also be
    declared on schemas.FaultResultBus — in-process consumers (arc flash,
    duty check, cable sizing, grounding, tests) see them regardless.
    """
    # [EE-7 contract] frontend SLG calc-display inputs
    z2_mag: Optional[float] = None      # |Z2| used for Ik1/IkLL (p.u.)
    z_slg_mag: Optional[float] = None   # |Z1 + Z2 + Z0| complex sum in the Ik1 denominator (p.u.)
    # [EE-11] Thermal-equivalent short-circuit current Ith = Ik″·√(m+n)
    ith_ka: Optional[float] = None


def thermal_m_factor(kappa, duration_s, freq_hz=50.0):
    """DC heat-effect factor m per IEC 60909-0 §12 (thermal equivalent
    short-circuit current Ith = Ik″·√(m + n)):

        m = (1 / (2·f·Tk·ln(κ−1))) · (e^(4·f·Tk·ln(κ−1)) − 1)

    where κ is the IEC 60909 peak factor (1.02 ≤ κ < 2.0) and Tk the fault
    duration. Guards:
      - κ ≤ 1 (fully damped DC component), Tk ≤ 0 or f ≤ 0 → m = 0
      - κ → 2 (ln(κ−1) → 0): analytic limit m → 2

    Shared helper: used for the per-bus Ith report here (EE-11) and by
    cable_sizing.py's adiabatic fault-withstand check (EE-5).
    """
    if not kappa or kappa <= 1.0 + 1e-9 or duration_s <= 0 or freq_hz <= 0:
        return 0.0
    x = math.log(min(kappa, 2.0) - 1.0)  # ln(κ−1) ≤ 0
    if abs(x) < 1e-9:
        return 2.0  # κ → 2 analytic limit
    ft = freq_hz * duration_s
    return (math.exp(4.0 * ft * x) - 1.0) / (2.0 * ft * x)


def run_fault_analysis(project: ProjectData, fault_bus_id: str = None, fault_type: str = None,
                       thermal_duration_s: float = 1.0, voltage_factor: float = None,
                       conductor_temperature_c: float = None) -> FaultResults:
    """Run IEC 60909 fault analysis.

    Args:
        project: The project data.
        fault_bus_id: If set, only compute fault on this bus.
        fault_type: "3phase", "slg", "ll", "llg", or None for all types.
        thermal_duration_s: Fault duration Tk (s) for the thermal-equivalent
            current Ith = Ik″·√(m+n) — IEC 60909-0 §12 convention, 1.0 s default.
        voltage_factor: IEC 60909-0 Table 1 voltage factor c to apply in the
            fault equations AND the network-feeder equivalent impedance
            (Eq. 15). None → C_MAX (1.10). Set to 1.0 to reproduce results
            that omit the voltage factor (e.g. bolted-fault / V=1.0 studies).
            NOTE: the transformer correction factor K_T always uses c_max=1.10
            internally per §6.3.3 regardless of this value.
        conductor_temperature_c: [PS-3] Conductor temperature (°C) for a
            MINIMUM short-circuit study per IEC 60909-0 §5.3.1: every cable's
            resistance (r_per_km and, when set, r0_per_km) is scaled by
            1 + 0.004·(θ − 20) before the study. Combine with
            voltage_factor = 0.95 (c_min) so disconnection/protection-reach
            checks are made against the current that may actually flow.
            None or 20 → unchanged (maximum-current convention).
    """
    # Resolve the voltage factor once; a positive override wins, else C_MAX.
    c_resolved = voltage_factor if (voltage_factor is not None and voltage_factor > 0) else C_MAX

    # [PS-3] Minimum-current mode: hot-conductor cable resistance.
    if conductor_temperature_c is not None and abs(conductor_temperature_c - 20.0) > 1e-9:
        import json as _json
        temp_factor = 1.0 + 0.004 * (float(conductor_temperature_c) - 20.0)
        if temp_factor > 0:
            _data = _json.loads(project.model_dump_json())
            for _c in _data.get("components", []):
                if _c.get("type") == "cable":
                    _props = _c.setdefault("props", {})
                    # 0.1 Ω/km is the engine default when the prop is absent —
                    # materialize it so the correction still applies.
                    _r = _props.get("r_per_km", 0.1)
                    try:
                        _props["r_per_km"] = float(_r) * temp_factor
                    except (TypeError, ValueError):
                        pass
                    _r0 = _props.get("r0_per_km")
                    if _r0:
                        try:
                            _props["r0_per_km"] = float(_r0) * temp_factor
                        except (TypeError, ValueError):
                            pass
            project = ProjectData(**_data)

    # Give any load wired behind a cable/transformer a terminal bus, so a fault
    # level is reported at that terminal too (as if the user had drawn a bus
    # there). Idempotent; leaves well-modelled networks unchanged. Unlike load
    # flow, these nodes are kept in the results — the terminal fault level is
    # the useful output. A single-bus fault (fault_bus_id set to a real bus)
    # never computes them, since the bus filter below drops them.
    from .loadflow import insert_implicit_load_buses
    project = insert_implicit_load_buses(project)

    base_mva = project.baseMVA
    components = {c.id: c for c in project.components}
    wires = project.wires

    # Build adjacency: which components connect to which
    adjacency = {}  # component_id -> [(connected_id, from_port, to_port)]
    for w in wires:
        adjacency.setdefault(w.fromComponent, []).append(
            (w.toComponent, w.fromPort, w.toPort))
        adjacency.setdefault(w.toComponent, []).append(
            (w.fromComponent, w.toPort, w.fromPort))

    # Identify buses — filter to selected bus if specified
    # distribution_board is treated as a bus-like node (busbar + lumped load),
    # so a fault level IS computed at each board and the walk passes through a
    # board to reach sub-boards and upstream sources (EE-1).
    buses = [c for c in project.components
             if c.type in ("bus", "distribution_board")
             and str(c.props.get("system", "ac")).lower() != "dc"]
    all_buses = list(buses)  # full bus set — used for nodal/Zbus solutions
    if fault_bus_id:
        buses = [c for c in buses if c.id == fault_bus_id]

    # [PS-1] Bus-level sequence networks, built lazily on the first meshed
    # fault location (radial networks never need them).
    net_cache = None

    # For each bus, compute equivalent impedance seen from that bus
    results = {}
    for bus in buses:
        voltage_kv = bus.props.get("voltage_kv", 0.4 if bus.type == "distribution_board" else 11)
        i_base_ka = base_mva / (math.sqrt(3) * voltage_kv)  # kA

        # Collect all source paths with component trail
        paths_meta = {}
        source_paths = _collect_source_paths(bus.id, components, adjacency, base_mva,
                                             c=c_resolved, meta=paths_meta)

        if not source_paths:
            # No sources connected — infinite impedance (no fault current)
            results[bus.id] = FaultResultBus(
                bus_id=bus.id,
                bus_name=bus.props.get("name", bus.id),
                voltage_kv=voltage_kv,
                ik3=0, ik1=0, ikLL=0, ikLLG=0
            )
            continue

        z_sources = [p["z_total"] for p in source_paths]
        z2_sources = [p.get("z2_total", p["z_total"]) for p in source_paths]

        # Separate motor and network source paths
        motor_paths = [p for p in source_paths if p.get("is_motor")]
        network_paths = [p for p in source_paths if not p.get("is_motor")]

        # Parallel combination of all source impedances — exact for radial
        # topologies (no element shared between paths)
        z_eq_paths = _parallel_impedances(z_sources)
        # Negative-sequence equivalent impedance (may differ from Z1 for generators/motors)
        z2_eq_paths = _parallel_impedances(z2_sources)
        z_eq, z2_eq = z_eq_paths, z2_eq_paths

        # [PS-1] Meshed/parallel-path topology: per-path parallel combination
        # double-counts shared upstream impedance — solve the Thevenin
        # impedance nodally (Zbus) instead. meshed_scale re-anchors the
        # current-summing quantities (Ib, Ik_steady, motor split) that are
        # built from per-path currents.
        study_warnings = []
        if paths_meta.get("truncated"):
            study_warnings.append(
                "Source-path enumeration truncated (heavily meshed network) — "
                "per-path detail (branch contributions, Ib weighting) may omit paths.")
        meshed = _paths_are_meshed(source_paths, components)
        meshed_scale = 1.0
        if meshed:
            if net_cache is None:
                net_cache = _build_bus_network(all_buses, components, adjacency,
                                               base_mva, c_resolved)
                net_cache["shunts1"] = {bid: [t[0] for t in lst]
                                        for bid, lst in net_cache["shunts12"].items()}
                net_cache["shunts2"] = {bid: [t[1] for t in lst]
                                        for bid, lst in net_cache["shunts12"].items()}
            z1_kk = _nodal_thevenin(net_cache["bus_ids"], net_cache["branches1"],
                                    net_cache["shunts1"], bus.id)
            z2_kk = _nodal_thevenin(net_cache["bus_ids"], net_cache["branches1"],
                                    net_cache["shunts2"], bus.id)
            if z1_kk is not None:
                if abs(z_eq_paths) > 1e-15:
                    meshed_scale = abs(z_eq_paths) / abs(z1_kk)
                z_eq = z1_kk
                z2_eq = z2_kk if z2_kk is not None else z1_kk
                study_warnings.append(
                    "Meshed/parallel-path topology: Thevenin impedance solved "
                    "nodally (Zbus); per-branch contributions remain "
                    "path-divider approximations.")
            else:
                study_warnings.append(
                    "Meshed topology detected but the nodal solution failed — "
                    "falling back to per-path parallel combination, which "
                    "OVERSTATES fault current when paths share impedance.")

        # IEC 60909-0 Table 1 voltage factor (see C_MAX above; overridable per request)
        c_factor = c_resolved

        ik3_ka = None
        ik1_ka = None
        ikLL_ka = None
        ikLLG_ka = None

        ik3_angle = None
        ik1_angle = None
        ikLL_angle = None
        ikLLG_angle = None

        # Three-phase fault: I"k3 = c * V_n / (sqrt(3) * |Z_eq|)
        if not fault_type or fault_type == "3phase":
            ik3_pu = c_factor / abs(z_eq) if abs(z_eq) > 1e-10 else 0
            ik3_ka = round(ik3_pu * i_base_ka, 3)
            ik3_angle = round(-math.degrees(math.atan2(z_eq.imag, z_eq.real)), 2) if abs(z_eq) > 1e-10 else None

        # Compute Z0 once for fault types that need it (SLG, LLG)
        needs_z0 = not fault_type or fault_type in ("slg", "llg")
        z0 = complex(1e10, 0)  # Default: no zero-sequence path
        has_z0_path = False
        z0_detail = []  # descriptive strings for each Z0 source path
        if needs_z0:
            z0_source_tuples = _collect_zero_seq_impedances(bus.id, components, adjacency, base_mva, c=c_resolved)
            if z0_source_tuples:
                z0_impedances = [t[0] for t in z0_source_tuples]
                z0_detail = [t[1] for t in z0_source_tuples]
                z0 = _parallel_impedances(z0_impedances)
                has_z0_path = True
            # [PS-1] Meshed topology: the zero-sequence path enumeration has
            # the same shared-element defect — use the nodal Z0 when solvable.
            if meshed and net_cache is not None:
                z0_kk = _nodal_thevenin(net_cache["bus_ids"], net_cache["branches0"],
                                        net_cache["shunts0"], bus.id)
                if z0_kk is not None:
                    z0 = z0_kk
                    has_z0_path = True

        # SLG fault: I"k1 = 3 * c * V_n / (sqrt(3) * |Z1 + Z2 + Z0|)
        if not fault_type or fault_type == "slg":
            if has_z0_path:
                z_slg = z_eq + z2_eq + z0  # Z1 + Z2 + Z0
                ik1_pu = 3 * c_factor / abs(z_slg) if abs(z_slg) > 1e-10 else 0
                ik1_ka = round(ik1_pu * i_base_ka, 3)
                ik1_angle = round(-math.degrees(math.atan2(z_slg.imag, z_slg.real)), 2) if abs(z_slg) > 1e-10 else None
            else:
                # No zero-sequence path exists (e.g. bus between delta windings)
                # Z0 → ∞, so SLG fault current ≈ 0
                ik1_ka = 0.0

        # Line-to-line fault: I"kLL = c * V_n / |Z1 + Z2|
        if not fault_type or fault_type == "ll":
            z_ll = z_eq + z2_eq
            ikLL_pu = c_factor * math.sqrt(3) / abs(z_ll) if abs(z_ll) > 1e-10 else 0
            ikLL_ka = round(ikLL_pu * i_base_ka, 3)
            ikLL_angle = round(-math.degrees(math.atan2(z_ll.imag, z_ll.real)) - 30, 2) if abs(z_ll) > 1e-10 else None

        # Double line-to-ground fault (IEC 60909 earth fault current):
        # Ia1 = c / (Z1 + Z2‖Z0),  Ia0 = -Ia1 × Z2 / (Z2 + Z0)
        # I"kE2E = |3 × Ia0| = 3c × Z2 / |Z2 × (Z1 + Z2 + Z0) + Z1 × Z0|
        if not fault_type or fault_type == "llg":
            if has_z0_path:
                # Z2 parallel Z0
                z2_par_z0 = (z2_eq * z0) / (z2_eq + z0) if abs(z2_eq + z0) > 1e-15 else complex(0, 0)
                # Ia1 = c / (Z1 + Z2‖Z0)
                z_llg_a1 = z_eq + z2_par_z0
                ia1 = c_factor / z_llg_a1 if abs(z_llg_a1) > 1e-10 else complex(0, 0)
                # Ia0 = -Ia1 × Z2 / (Z2 + Z0)
                ia0 = -ia1 * z2_eq / (z2_eq + z0) if abs(z2_eq + z0) > 1e-15 else complex(0, 0)
                # I"kE2E = |3 × Ia0|
                i_llg = 3 * ia0
                ikLLG_pu = abs(i_llg)
                ikLLG_ka = round(ikLLG_pu * i_base_ka, 3)
                ikLLG_angle = round(math.degrees(math.atan2(i_llg.imag, i_llg.real)), 2) if ikLLG_pu > 1e-10 else None
            else:
                # No zero-sequence path: Z0 → ∞, Z2‖Z0 → Z2
                # Degenerates to line-to-line fault
                z_ll_deg = z_eq + z2_eq
                ikLLG_pu = c_factor * math.sqrt(3) / abs(z_ll_deg) if abs(z_ll_deg) > 1e-10 else 0
                ikLLG_ka = round(ikLLG_pu * i_base_ka, 3)
                ikLLG_angle = round(-math.degrees(math.atan2(z_ll_deg.imag, z_ll_deg.real)), 2) if abs(z_ll_deg) > 1e-10 else None

        # Compute branch contributions using current divider
        # For selected fault type, determine total fault current in p.u.
        # When no specific fault type, default to 3-phase for branch display
        active_type = fault_type or "3phase"
        if active_type == "slg":
            z_slg_br = z_eq + z2_eq + z0
            ik_total_pu = 3 * c_factor / abs(z_slg_br) if abs(z_slg_br) > 1e-10 else 0
        elif active_type == "ll":
            z_ll_br = z_eq + z2_eq
            ik_total_pu = c_factor * math.sqrt(3) / abs(z_ll_br) if abs(z_ll_br) > 1e-10 else 0
        elif active_type == "llg":
            z2_par_z0_br = (z2_eq * z0) / (z2_eq + z0) if abs(z2_eq + z0) > 1e-15 else complex(0, 0)
            z_llg_a1_br = z_eq + z2_par_z0_br
            ia1_br = c_factor / z_llg_a1_br if abs(z_llg_a1_br) > 1e-10 else complex(0, 0)
            ia0_br = -ia1_br * z2_eq / (z2_eq + z0) if abs(z2_eq + z0) > 1e-15 else complex(0, 0)
            ik_total_pu = abs(3 * ia0_br)
        else:
            ik_total_pu = c_factor / abs(z_eq) if abs(z_eq) > 1e-10 else 0

        ik_total_ka = ik_total_pu * i_base_ka

        # Branch shares use the per-path parallel z_eq (admittance weighting)
        # anchored to the corrected bus total — for a shared-source parallel
        # feeder this reproduces the physical 50/50 cable split.
        branches = _compute_branch_contributions(
            source_paths, z_eq_paths, c_factor, i_base_ka, ik_total_ka, components, active_type, bus.id,
            base_mva=base_mva, faulted_bus_voltage_kv=voltage_kv
        )

        # Motor contribution summary (3-phase current split)
        motor_count = len(motor_paths)
        ik3_motor = None
        ik3_network = None
        if motor_count > 0 and ik3_ka and ik3_ka > 0:
            # Sum motor contributions via current divider: I_motor = c / |Z_motor_path|
            # ([PS-1] × meshed_scale when the per-path currents overstate)
            motor_pu = sum(
                c_factor / abs(p["z_total"]) for p in motor_paths if abs(p["z_total"]) > 1e-15
            ) * meshed_scale
            network_pu = sum(
                c_factor / abs(p["z_total"]) for p in network_paths if abs(p["z_total"]) > 1e-15
            ) * meshed_scale
            ik3_motor = round(motor_pu * i_base_ka, 3)
            ik3_network = round(network_pu * i_base_ka, 3)

        # IEC 60909 time-varying fault currents (3-phase)
        freq = project.frequency or 50  # Hz
        ip_ka, kappa = _compute_peak_current(ik3_ka, z_eq, meshed=meshed, voltage_kv=voltage_kv)
        ib_ka = _compute_breaking_current(ik3_ka, source_paths, c_factor, i_base_ka, base_mva)
        ik_steady_ka = _compute_steady_state_current(source_paths, c_factor, i_base_ka, base_mva, voltage_kv)
        # [PS-1] Per-path current sums inherit the shared-impedance overstatement
        if meshed_scale != 1.0:
            if ib_ka is not None:
                ib_ka = round(ib_ka * meshed_scale, 3)
            if ik_steady_ka is not None:
                ik_steady_ka = round(ik_steady_ka * meshed_scale, 3)

        # [EE-11] Thermal-equivalent short-circuit current per IEC 60909-0 §12:
        #   Ith = Ik″ × √(m + n)
        # m: DC heat-effect factor from the bus κ and the fault duration Tk
        #    (thermal_duration_s, default 1.0 s);
        # n: AC decay factor — n = 1 assumed (far-from-generator, Ik = Ik″),
        #    which is the conservative upper bound (n ≤ 1).
        ith_ka = None
        if ik3_ka and kappa:
            m_dc = thermal_m_factor(kappa, thermal_duration_s, freq)
            ith_ka = round(ik3_ka * math.sqrt(m_dc + 1.0), 3)

        # Asymmetric breaking current: Ib_asym = √(Ib² + (2fτ × ip × e^(-t/τ))²)
        # Simplified per IEC 60909-0 §9.1.3: use DC component at t_min
        ib_asym_ka = None
        if ib_ka and ip_ka and kappa:
            # DC decay time constant τ ≈ X/(2πfR), approximate from R/X
            r_x = abs(z_eq.real / z_eq.imag) if abs(z_eq.imag) > 1e-15 else 1.0
            tau = 1 / (2 * math.pi * freq * r_x) if r_x > 1e-10 else 0.1
            t_min = 0.1  # 100ms default breaking time
            i_dc = math.sqrt(2) * ik3_ka * math.exp(-t_min / tau)
            ib_asym_ka = round(math.sqrt(ib_ka ** 2 + i_dc ** 2), 3)

        results[bus.id] = FaultResultBus(
            bus_id=bus.id,
            bus_name=bus.props.get("name", bus.id),
            voltage_kv=voltage_kv,
            ik3=ik3_ka,
            ik3_angle=ik3_angle,
            ik1=ik1_ka,
            ik1_angle=ik1_angle,
            ikLL=ikLL_ka,
            ikLL_angle=ikLL_angle,
            ikLLG=ikLLG_ka,
            ikLLG_angle=ikLLG_angle,
            z_eq_real=round(z_eq.real, 6),
            z_eq_imag=round(z_eq.imag, 6),
            z_eq_mag=round(abs(z_eq), 6),
            z0_real=round(z0.real, 6) if has_z0_path else None,
            z0_imag=round(z0.imag, 6) if has_z0_path else None,
            z0_mag=round(abs(z0), 6) if has_z0_path else None,
            # [EE-7] |Z2| actually used and the COMPLEX-sum SLG denominator
            # |Z1+Z2+Z0| — so the frontend calc display can show the complex-
            # magnitude step instead of summing magnitudes arithmetically.
            z2_mag=round(abs(z2_eq), 6),
            z_slg_mag=round(abs(z_eq + z2_eq + z0), 6) if has_z0_path else None,
            z0_source_count=len(z0_detail) if z0_detail else None,
            z0_sources_detail=z0_detail if z0_detail else None,
            motor_count=motor_count,
            ik3_motor=ik3_motor,
            ik3_network=ik3_network,
            ip=ip_ka,
            kappa=kappa,
            ib=ib_ka,
            ith_ka=ith_ka,
            ib_asymmetric=ib_asym_ka,
            ik_steady=ik_steady_ka,
            branches=branches,
            network_topology="meshed" if meshed else "radial",
            topology_warnings=study_warnings or None,
        )

    # ── Voltage Depression Calculation (IEC 60909 §3.6) ──
    # Build Zbus matrix for all buses and compute retained voltage at each bus
    # during a fault at each faulted bus: V_j = 1 - Z_jk / Z_kk
    # (all_buses computed above — full bus set regardless of fault_bus_id)
    if len(all_buses) >= 2:
        try:
            _compute_voltage_depression(
                all_buses, components, adjacency, wires, base_mva, results
            )
        except Exception:
            pass  # Non-critical — don't fail fault analysis if voltage depression fails

    return FaultResults(
        buses=results,
        base_mva=base_mva,
        method="IEC 60909 (symmetrical)"
    )


# Cap on enumerated source/Z0 paths to avoid exponential blowup on heavily
# meshed networks (per-path DFS enumerates all simple paths).
MAX_FAULT_PATHS = 200
# Hard cap on DFS node expansions. The path-count cap alone does NOT bound work:
# on a meshed/source-free region almost every branch dead-ends on the per-path
# cycle check without ever appending a path, so len(paths) never advances while
# recursion grows exponentially. This budget bounds the traversal itself.
MAX_FAULT_EXPANSIONS = 20000


def _transformer_far_voltage(comp, v_near):
    """Voltage (kV) of the transformer winding OPPOSITE the side entered at
    voltage v_near — used to track the voltage zone across a walk."""
    hv = float(comp.props.get("voltage_hv_kv", 11) or 0)
    lv = float(comp.props.get("voltage_lv_kv", 0.4) or 0)
    if hv > 0 and lv > 0:
        return hv if abs(v_near - lv) < abs(v_near - hv) else lv
    return v_near


def _collect_source_paths(bus_id, components, adjacency, base_mva, c=C_MAX, meta=None):
    """Walk the network from a bus and collect source paths with component trails.

    Uses a per-path visited set (one copy per recursion branch) so that
    parallel/ring paths to the same source are each enumerated — a single
    shared visited set would silently drop every path after the first,
    understating fault current. Cycle prevention is per-path: a component
    may appear in many paths but never twice in the same path.

    [EE-12] The walk tracks the voltage zone (from bus props, flipped at
    transformer windings) and uses it as the per-unit base for cable
    impedances — the cable's own voltage_kv prop is never trusted here,
    mirroring loadflow.py's convention.
    """
    paths = []
    expansions = [0]

    def walk(comp_id, z_path, trail, path_visited, v_kv):
        if len(paths) >= MAX_FAULT_PATHS or expansions[0] >= MAX_FAULT_EXPANSIONS:
            return
        expansions[0] += 1
        if comp_id in path_visited:
            return  # Cycle on this path
        path_visited = path_visited | {comp_id}
        comp = components.get(comp_id)
        if not comp:
            return

        # If we hit a source, record the complete path
        if comp.type == "utility":
            z_src = _utility_impedance(comp, base_mva, c)
            z2_src = _source_z2(comp, z_src, base_mva)
            paths.append({
                "z_total": z_path + z_src,
                "z2_total": z_path + z2_src,
                "trail": trail + [comp_id],
                "source_id": comp_id,
                "source_type": "utility",
            })
            return
        if comp.type == "generator":
            z_src = _generator_impedance(comp, base_mva, v_kv)
            rated_mva = comp.props.get("rated_mva", 10)
            z2_src = _source_z2(comp, z_src, base_mva)
            paths.append({
                "z_total": z_path + z_src,
                "z2_total": z_path + z2_src,
                "trail": trail + [comp_id],
                "source_id": comp_id,
                "source_type": "generator",
                "xd_pp": comp.props.get("xd_pp", 0.15),
                "xd_p": comp.props.get("xd_p", 0.25),
                "xd": comp.props.get("xd", 1.2),
                "rated_mva": rated_mva,
            })
            return

        # Motors contribute sub-transient fault current (IEC 60909-0 §13)
        if comp.type == "motor_induction":
            z_src = _motor_induction_impedance(comp, base_mva)
            rated_kw = comp.props.get("rated_kw", 200)
            eff = comp.props.get("efficiency", 0.93)
            pf = comp.props.get("power_factor", 0.85)
            # IEC 60909-0 §3.8: S_rM = P_rM / (η × cosφ)
            motor_mva = rated_kw / (eff * pf * 1000)
            z2_src = _source_z2(comp, z_src, base_mva)
            paths.append({
                "z_total": z_path + z_src,
                "z2_total": z_path + z2_src,
                "trail": trail + [comp_id],
                "source_id": comp_id,
                "source_type": "motor_induction",
                "is_motor": True,
                "rated_mva": motor_mva,
            })
            return
        if comp.type == "motor_synchronous":
            z_src = _motor_synchronous_impedance(comp, base_mva)
            rated_kva = comp.props.get("rated_kva", 500)
            z2_src = _source_z2(comp, z_src, base_mva)
            paths.append({
                "z_total": z_path + z_src,
                "z2_total": z_path + z2_src,
                "trail": trail + [comp_id],
                "source_id": comp_id,
                "source_type": "motor_synchronous",
                "is_motor": True,
                "xd_pp": comp.props.get("xd_pp", 0.15),
                "xd_p": comp.props.get("xd_p", 0.25),
                "rated_mva": rated_kva / 1000,
            })
            return

        # Solar PV inverter-based source (IEC 60909-0 §11 / IEC TR 60909-4)
        if comp.type == "solar_pv":
            z_src = _solar_pv_impedance(comp, base_mva)
            rated_kw = comp.props.get("rated_kw", 100)
            n_inv = comp.props.get("num_inverters", 1)
            paths.append({
                "z_total": z_path + z_src,
                "z2_total": z_path + z_src,
                "trail": trail + [comp_id],
                "source_id": comp_id,
                "source_type": "solar_pv",
                "rated_mva": rated_kw * n_inv / 1000,
            })
            return

        # Battery storage inverter (BESS) — current-limited like solar PV
        if comp.type == "battery":
            z_src = _battery_impedance(comp, base_mva)
            paths.append({
                "z_total": z_path + z_src,
                "z2_total": z_path + z_src,
                "trail": trail + [comp_id],
                "source_id": comp_id,
                "source_type": "battery",
                "rated_mva": comp.props.get("rated_kva", 100) / 1000,
            })
            return

        # Wind turbine generator
        if comp.type == "wind_turbine":
            z_src = _wind_turbine_impedance(comp, base_mva)
            rated_mva = comp.props.get("rated_mva", 2.0)
            n_turb = comp.props.get("num_turbines", 1)
            t_type = comp.props.get("turbine_type", "type3_dfig")
            paths.append({
                "z_total": z_path + z_src,
                "z2_total": z_path + z_src,
                "trail": trail + [comp_id],
                "source_id": comp_id,
                "source_type": "wind_turbine",
                "rated_mva": rated_mva * n_turb,
                "turbine_type": t_type,
            })
            return

        # Static/lumped load with a rotating fraction ([gap #2]) — back-feeds
        # the fault as an induction-motor equivalent (decays for Ib like any
        # induction motor via source_type "motor_induction").
        if comp.type in ("static_load", "distribution_board"):
            z_src, motor_mva = _static_load_motor_impedance(comp, base_mva)
            if z_src is not None:
                paths.append({
                    "z_total": z_path + z_src,
                    "z2_total": z_path + z_src,
                    "trail": trail + [comp_id],
                    "source_id": comp_id,
                    "source_type": "motor_induction",
                    "is_motor": True,
                    "rated_mva": motor_mva,
                })
            if comp.type == "static_load":
                return
            # A distribution board also passes fault current through (in→out) as
            # a near-zero-impedance busbar, so upstream sources beyond the board
            # and downstream sub-boards are still reached (EE-1). Fall through to
            # the branch-walk below with zero added impedance rather than
            # terminating the walk here.

        # Accumulate impedance through branch elements, tracking the
        # voltage zone for cable per-unit conversion ([EE-12])
        z_element = complex(0, 0)
        v_next = v_kv
        if comp.type == "bus":
            v_next = float(comp.props.get("voltage_kv", v_kv) or v_kv)
        elif comp.type in ("transformer", "autotransformer"):
            z_element = _transformer_impedance(comp, base_mva)
            v_next = _transformer_far_voltage(comp, v_kv)
        elif comp.type == "cable":
            z_element = _cable_impedance(comp, base_mva, v_kv)
        elif comp.type in ("cb", "switch"):
            state = comp.props.get("state", "closed")
            if state == "open":
                return  # Open device blocks fault current
        elif comp.type == "fuse":
            pass  # Zero impedance for fault calc

        # Continue walking
        for neighbor_id, _, _ in adjacency.get(comp_id, []):
            if neighbor_id != bus_id or comp_id == bus_id:
                walk(neighbor_id, z_path + z_element, trail + [comp_id], path_visited, v_next)

    # Start from bus's neighbors at the faulted bus's voltage
    _bus_comp = components.get(bus_id)
    _v_start = float(_bus_comp.props.get("voltage_kv", 0.4 if _bus_comp.type == "distribution_board" else 11) or 11) if _bus_comp else 11.0
    for neighbor_id, _, _ in adjacency.get(bus_id, []):
        walk(neighbor_id, complex(0, 0), [], {bus_id}, _v_start)

    if len(paths) >= MAX_FAULT_PATHS or expansions[0] >= MAX_FAULT_EXPANSIONS:
        print(f"[fault] Warning: source path enumeration truncated for bus {bus_id} "
              f"({len(paths)} paths, {expansions[0]} expansions) — heavily meshed "
              f"network, results may omit paths")
        if meta is not None:
            meta["truncated"] = True

    return paths


def _compute_branch_contributions(source_paths, z_eq, c_factor, i_base_ka, ik_total_ka, components, fault_type, faulted_bus_id="",
                                   base_mva=None, faulted_bus_voltage_kv=None):
    """Compute fault current contribution through each branch element.

    Uses current divider: I_path = V_fault / Z_path
    where V_fault = c (in p.u.), so I_path_pu = c / |Z_path|

    Each element's actual kA is converted using the base current at its own
    voltage level, not the faulted bus voltage.  This correctly accounts for
    transformer turns ratios when displaying branch fault currents.
    """
    if not source_paths or ik_total_ka < 1e-10:
        return []

    # Per-unit total fault current (for contribution % calculation)
    ik_total_pu = ik_total_ka / i_base_ka if i_base_ka > 1e-15 else 0

    # For each path, compute the per-unit current it carries.
    # Each path takes its positive-sequence current-divider share of the
    # ACTUAL bus fault current for the selected fault type:
    #   share = |y_path / Σy| = |z_eq / z_path|,  i_path = share × Ik_total
    # This keeps per-branch contributions consistent with the bus total for
    # all fault types (3ph/SLG/LL/LLG) — for 3-phase it reduces exactly to
    # the previous c/|z_path| divider.
    # NOTE: shares are applied as magnitudes (arithmetic sum) because full
    # per-path phase information is not available in this radial path model;
    # contributions may not sum to exactly 100% when path impedance angles
    # differ between parallel paths.
    path_currents_pu = []
    for path in source_paths:
        z_path = path["z_total"]
        if abs(z_path) > 1e-15:
            i_path_pu = abs(z_eq / z_path) * ik_total_pu
        else:
            i_path_pu = 0
        path_currents_pu.append(i_path_pu)

    # Aggregate per-unit current per branch element across all paths
    # Element may appear in multiple paths — sum contributions
    element_current_pu = {}  # element_id -> total per-unit current
    element_z_path = {}   # element_id -> z_path of first path containing it (for display)
    element_source = {}   # element_id -> source names
    element_voltage = {}  # element_id -> operating voltage in kV
    # Track from_bus (source side) and to_bus (faulted bus side) for each element
    # Trail is ordered from faulted bus outward, so trail[k-1] is toward the fault
    element_from_bus = {}  # element_id -> source-side neighbor
    element_to_bus = {}    # element_id -> faulted-bus-side neighbor

    for i, path in enumerate(source_paths):
        trail = path["trail"]
        i_pu = path_currents_pu[i]
        source_id = path["source_id"]
        source_comp = components.get(source_id)
        source_name = source_comp.props.get("name", source_id) if source_comp else source_id

        # Determine voltage zone for each element along this trail.
        # Walk from faulted bus outward, tracking voltage through transformers.
        current_voltage = faulted_bus_voltage_kv or 0
        trail_voltages = {}
        for k, elem_id in enumerate(trail):
            comp = components.get(elem_id)
            if not comp:
                trail_voltages[elem_id] = current_voltage
                continue
            if comp.type == "bus":
                current_voltage = comp.props.get("voltage_kv", current_voltage)
                trail_voltages[elem_id] = current_voltage
            elif comp.type in ("transformer", "autotransformer"):
                # Determine which winding faces the fault side vs the source side
                hv = comp.props.get("voltage_hv_kv", 11)
                lv = comp.props.get("voltage_lv_kv", 0.4)
                # Current voltage is the fault-side winding; source side is the other
                if abs(current_voltage - lv) < abs(current_voltage - hv):
                    source_side_voltage = hv
                else:
                    source_side_voltage = lv
                # Show transformer current at source side (upstream of fault)
                trail_voltages[elem_id] = source_side_voltage
                current_voltage = source_side_voltage
            else:
                trail_voltages[elem_id] = current_voltage

        for k, elem_id in enumerate(trail):
            if elem_id not in element_current_pu:
                element_current_pu[elem_id] = 0
                element_z_path[elem_id] = path["z_total"]
                element_source[elem_id] = set()
                element_voltage[elem_id] = trail_voltages.get(elem_id, faulted_bus_voltage_kv or 0)
                # to_bus: faulted-bus side (trail[k-1] or faulted_bus_id if first in trail)
                element_to_bus[elem_id] = trail[k - 1] if k > 0 else faulted_bus_id
                # from_bus: source side (trail[k+1] or source_id if last in trail)
                element_from_bus[elem_id] = trail[k + 1] if k < len(trail) - 1 else source_id
            element_current_pu[elem_id] += i_pu
            element_source[elem_id].add(source_name)

    # Build branch contribution objects
    branches = []
    for elem_id, ik_pu in element_current_pu.items():
        comp = components.get(elem_id)
        if not comp:
            continue
        # Skip buses from branch display — they aren't "branches"
        if comp.type in ("bus",):
            continue

        z_path = element_z_path[elem_id]
        contribution_pct = (ik_pu / ik_total_pu * 100) if ik_total_pu > 1e-10 else 0

        # Convert per-unit current to actual kA at element's voltage level
        elem_v = element_voltage.get(elem_id, faulted_bus_voltage_kv or 0)
        if base_mva and elem_v and elem_v > 1e-6:
            i_base_elem = base_mva / (math.sqrt(3) * elem_v)
        else:
            i_base_elem = i_base_ka  # fallback to faulted bus base
        ik_ka = ik_pu * i_base_elem

        branches.append(FaultBranchContribution(
            element_id=elem_id,
            element_name=comp.props.get("name", elem_id),
            element_type=comp.type,
            from_bus=element_from_bus.get(elem_id, ""),
            to_bus=element_to_bus.get(elem_id, ""),
            ik_ka=round(ik_ka, 3),
            z_path_real=round(z_path.real, 6),
            z_path_imag=round(z_path.imag, 6),
            z_path_mag=round(abs(z_path), 6),
            contribution_pct=round(contribution_pct, 1),
            # map(str, …) guards against non-string names (schemas.py coerces
            # digit-string props to numbers, so a name like "123" arrives as int)
            source_name=", ".join(sorted(map(str, element_source[elem_id]))),
        ))

    # Sort by current descending
    branches.sort(key=lambda b: b.ik_ka, reverse=True)
    return branches


def _utility_impedance(comp, base_mva, c=C_MAX):
    """Utility (network feeder) per-unit impedance per IEC 60909-0 §6.2, Eq. 15.

    Z_Q = c × U_nQ² / S″_kQ  →  on a common MVA base: z_pu = c × S_base / S″_kQ.

    The voltage factor c (the same c the fault equations use, [EE-4]) must be
    INCLUDED here so that I″k = c·U_n/(√3·|Z_Q|) computed at the connection
    point reproduces the utility's declared fault level exactly — omitting it
    returned 1.1× the declared level. c defaults to c_max = 1.10 but is
    overridable per request (e.g. c = 1.0 for V=1.0 / bolted-fault studies).
    """
    fault_mva = comp.props.get("fault_mva", 500)
    xr = comp.props.get("x_r_ratio", 15)
    z_pu = c * base_mva / fault_mva
    x_pu = z_pu * xr / math.sqrt(1 + xr * xr)
    r_pu = x_pu / xr
    return complex(r_pu, x_pu)


def _generator_impedance(comp, base_mva, v_system_kv=None):
    """Generator sub-transient impedance in per-unit, corrected per
    IEC 60909-0 §6.6.1:

        Z_GK = K_G × (R_G + jX″d),
        K_G  = (U_n / U_rG) × c_max / (1 + x″d · sin φ_rG)     (Eq. 18)

    [PS-6] U_n is the nominal system voltage at the connection point — the
    caller's bus-inferred voltage zone when available, else assumed equal to
    the machine rated voltage U_rG (K_G voltage ratio = 1). φ_rG is the rated
    power-factor angle (props ``power_factor``, default 0.85).

    R_G: an explicit ``x_r_ratio`` prop wins; otherwise the fictitious
    resistances of §6.6.1 are used (they set the correct κ decay, not the
    winding loss): R_G = 0.05·X″d (U_rG > 1 kV, S_rG ≥ 100 MVA),
    0.07·X″d (U_rG > 1 kV, S_rG < 100 MVA), 0.15·X″d (U_rG ≤ 1 kV).
    """
    rated_mva = comp.props.get("rated_mva", 10)
    xd_pp = comp.props.get("xd_pp", 0.15)
    x_pu = xd_pp * base_mva / rated_mva

    u_rg = float(comp.props.get("voltage_kv", 0) or 0)
    xr_prop = comp.props.get("x_r_ratio", None)
    try:
        xr = float(xr_prop) if xr_prop is not None else 0.0
    except (TypeError, ValueError):
        xr = 0.0
    if xr > 0:
        r_pu = x_pu / xr
    else:
        # IEC 60909-0 §6.6.1 fictitious resistance classes
        if 0 < u_rg <= 1.0:
            r_pu = 0.15 * x_pu
        elif rated_mva >= 100:
            r_pu = 0.05 * x_pu
        else:
            r_pu = 0.07 * x_pu

    # Impedance correction factor K_G (Eq. 18); c_max = 1.10 per Table 1.
    pf = float(comp.props.get("power_factor", 0.85) or 0.85)
    pf = min(max(pf, 0.0), 1.0)
    sin_phi = math.sqrt(max(0.0, 1.0 - pf * pf))
    u_ratio = (v_system_kv / u_rg) if (v_system_kv and u_rg > 0) else 1.0
    k_g = u_ratio * 1.10 / (1.0 + xd_pp * sin_phi)
    return complex(r_pu, x_pu) * k_g


def _source_z2(comp, z1_src, base_mva):
    """Negative-sequence source impedance — shared by the path walker and the
    nodal (meshed) network builder so the two can never drift ([PS-1]).

    Utility: Z2 = Z1 × z2_z1_ratio (legacy "x2_ratio"), default Z1.
    Machines: the x2 prop (legacy "x2_pu" for motors) on the machine base wins;
    otherwise Z2 = Z1. Inverter sources: Z2 = Z1 (current-limited either way).
    """
    t = comp.type
    if t == "utility":
        z2_z1 = float(comp.props.get("z2_z1_ratio", 0) or comp.props.get("x2_ratio", 0))
        return z1_src * z2_z1 if z2_z1 > 0 else z1_src
    if t == "generator":
        x2_val = float(comp.props.get("x2", 0))
        if x2_val > 0:
            rated_mva = comp.props.get("rated_mva", 10)
            xr = comp.props.get("x_r_ratio", 40)
            x2_pu = x2_val * base_mva / rated_mva
            return complex(x2_pu / xr, x2_pu)
        return z1_src
    if t == "motor_induction":
        x2_val = float(comp.props.get("x2", 0) or comp.props.get("x2_pu", 0))
        if x2_val > 0:
            rated_kw = comp.props.get("rated_kw", 200)
            eff = comp.props.get("efficiency", 0.93)
            pf = comp.props.get("power_factor", 0.85)
            motor_mva = rated_kw / (eff * pf * 1000)  # IEC 60909-0 §3.8
            xr = comp.props.get("x_r_ratio", 10)
            x2_pu = x2_val * base_mva / motor_mva
            return complex(x2_pu / xr, x2_pu)
        return z1_src
    if t == "motor_synchronous":
        x2_val = float(comp.props.get("x2", 0) or comp.props.get("x2_pu", 0))
        if x2_val > 0:
            rated_mva = comp.props.get("rated_kva", 500) / 1000
            xr = comp.props.get("x_r_ratio", 40)
            x2_pu = x2_val * base_mva / rated_mva
            return complex(x2_pu / xr, x2_pu)
        return z1_src
    return z1_src


# Component types that carry series impedance or source internal impedance.
# A component of one of these types appearing in MORE THAN ONE enumerated
# source path means parallel paths share an impedance element — paralleling
# per-path totals then double-counts the shared impedance ([PS-1]).
_IMPEDANCE_TYPES = frozenset((
    "cable", "transformer", "autotransformer",
    "utility", "generator", "motor_induction", "motor_synchronous",
    "solar_pv", "battery", "wind_turbine",
))


def _paths_are_meshed(source_paths, components):
    """True when any impedance-carrying component (or source) is shared by two
    or more enumerated source paths ([PS-1]). Shared zero-impedance elements
    (buses, closed CBs/switches/fuses, board pass-throughs) do not invalidate
    the per-path parallel combination and are ignored.
    """
    first_path_of = {}
    for i, p in enumerate(source_paths):
        for cid in set(p["trail"]):
            comp = components.get(cid)
            if not comp or comp.type not in _IMPEDANCE_TYPES:
                continue
            if cid in first_path_of and first_path_of[cid] != i:
                return True
            first_path_of.setdefault(cid, i)
    return False


_UNGROUNDED_VALUES = ("ungrounded", "isolated", "none", "unearthed", "")


def _machine_neutral_z(comp, v_kv, base_mva):
    """Neutral earthing impedance Zn (per-unit) of a machine star point,
    from its ``grounding`` prop ([PS-2]). Returns None when the star point is
    unearthed (no zero-sequence path), complex(0,0) when solidly earthed."""
    grounding = str(comp.props.get("grounding", "solidly")).lower()
    if grounding in _UNGROUNDED_VALUES:
        return None
    v = float(comp.props.get("voltage_kv", 0) or 0) or (v_kv or 11.0)
    z_base = (v ** 2) / base_mva if v > 0 else 1.0
    r_ohm = float(comp.props.get("grounding_resistance_ohm",
                                 comp.props.get("grounding_resistance", 0)) or 0)
    x_ohm = float(comp.props.get("grounding_reactance_ohm",
                                 comp.props.get("grounding_reactance", 0)) or 0)
    return complex(r_ohm / z_base, x_ohm / z_base)


def _cable_z0(comp, base_mva, v_kv):
    """Cable zero-sequence per-unit impedance — the walker's math, factored
    out so the nodal Z0 network builder uses the identical formula ([PS-1]).
    Explicit r0/x0 props win; fallback is 3.5× the positive-sequence
    per-km values (or 3× the composite Z1 when neither r0 nor x0 is set)."""
    r0_per_km = float(comp.props.get("r0_per_km", 0))
    x0_per_km = float(comp.props.get("x0_per_km", 0))
    if r0_per_km > 0 or x0_per_km > 0:
        z_base = (v_kv ** 2) / base_mva
        length = comp.props.get("length_km", 1)
        n_par = max(1, int(comp.props.get("num_parallel", 1)))
        r0 = (r0_per_km if r0_per_km > 0 else comp.props.get("r_per_km", 0.1) * 3.5) * length
        x0 = (x0_per_km if x0_per_km > 0 else comp.props.get("x_per_km", 0.08) * 3.5) * length
        return complex(r0 / z_base, x0 / z_base) / n_par
    return _cable_impedance(comp, base_mva, v_kv) * 3


def _transformer_impedance(comp, base_mva):
    """Transformer per-unit impedance with IEC 60909 correction factor K_T.

    K_T = 0.95 × c_max / (1 + 0.6 × x_T)  per IEC 60909-0 §6.3.3
    where x_T is the transformer reactance p.u. on its own rating.
    """
    rated_mva = comp.props.get("rated_mva", 10)
    z_pct = comp.props.get("z_percent", 8)
    xr = comp.props.get("x_r_ratio", 10)

    # Uncorrected impedance on system base
    z_pu = (z_pct / 100) * base_mva / rated_mva
    x_pu = z_pu * xr / math.sqrt(1 + xr * xr)
    r_pu = x_pu / xr

    # IEC 60909 impedance correction factor K_T
    # x_T is reactance p.u. on transformer's own rating
    x_t = (z_pct / 100) * xr / math.sqrt(1 + xr * xr)
    # IEC 60909-0 §6.3.3: c_max is taken from the LOW-voltage side nominal
    # voltage of the transformer (not the HV side). Per Table 1 we use
    # c_max = 1.10 for LV systems with +10% voltage tolerance (modern
    # standard practice) as well as for MV/HV.
    c_max = 1.10
    k_t = 0.95 * c_max / (1 + 0.6 * x_t)

    return complex(r_pu * k_t, x_pu * k_t)


def _cable_impedance(comp, base_mva, v_kv=None):
    """Cable per-unit impedance (accounts for parallel cables).

    [EE-12] Callers that walk the network pass the BUS-inferred voltage of
    the zone the cable sits in (v_kv) as the per-unit base — the cable's own
    voltage_kv prop may be stale/defaulted (e.g. 11 kV left on a 0.4 kV run,
    which near-zeroes its fault-path impedance by (11/0.4)² ≈ 756×). This is
    the same convention loadflow.py uses for cables in transformer chains.
    The prop is only a fallback when no network context is available.
    """
    if v_kv is None or v_kv <= 0:
        v_kv = comp.props.get("voltage_kv", 11)
    z_base = (v_kv ** 2) / base_mva
    r = comp.props.get("r_per_km", 0.1) * comp.props.get("length_km", 1)
    x = comp.props.get("x_per_km", 0.08) * comp.props.get("length_km", 1)
    n = max(1, int(comp.props.get("num_parallel", 1)))
    return complex(r / z_base, x / z_base) / n


def _motor_induction_impedance(comp, base_mva):
    """Induction motor sub-transient impedance per IEC 60909-0 §13.

    Uses X" (locked-rotor reactance) on motor base, converted to system base.
    Motor MVA = rated_kW / (efficiency × power factor) per IEC 60909-0 §3.8.
    """
    rated_kw = comp.props.get("rated_kw", 200)
    efficiency = comp.props.get("efficiency", 0.93)
    pf = comp.props.get("power_factor", 0.85)
    x_pp = comp.props.get("x_pp", 0.17)  # Sub-transient reactance p.u. on motor base
    xr = comp.props.get("x_r_ratio", 10)

    rated_mva = rated_kw / (efficiency * pf * 1000)  # Input apparent power (MVA)
    x_pu = x_pp * base_mva / rated_mva
    r_pu = x_pu / xr
    return complex(r_pu, x_pu)


def _static_load_motor_impedance(comp, base_mva):
    """Motor-equivalent sub-transient impedance for the rotating fraction of a
    static/lumped load, per IEC 60909-0 §13 ([gap #2]).

    Returns (z_src, motor_mva) or (None, 0) when no motor fraction is set.
    The rotating share (motor_fraction × rated_kVA) is modelled as an
    induction motor with X" ≈ 1/LRC (locked-rotor current ratio) on its own
    base, so lumped loads with a motor component back-feed the fault instead
    of being ignored.
    """
    mf = float(comp.props.get("motor_fraction", 0) or 0)
    if mf <= 0:
        return None, 0.0
    mf = min(mf, 1.0)
    rated_kva = float(comp.props.get("rated_kva", 0) or 0)
    motor_mva = rated_kva / 1000.0 * mf
    if motor_mva <= 1e-9:
        return None, 0.0
    lrc = float(comp.props.get("motor_lrc_ratio", 6) or 6)  # locked-rotor / FLC
    x_pp = 1.0 / max(lrc, 1e-3)                              # p.u. on motor base
    xr = float(comp.props.get("x_r_ratio", 10) or 10)
    x_pu = x_pp * base_mva / motor_mva
    r_pu = x_pu / xr
    return complex(r_pu, x_pu), motor_mva


def _motor_synchronous_impedance(comp, base_mva):
    """Synchronous motor sub-transient impedance per IEC 60909-0 §13.

    Uses X"d (sub-transient reactance) on motor base, converted to system base.
    Treated identically to a synchronous generator for fault contribution.
    """
    rated_kva = comp.props.get("rated_kva", 500)
    xd_pp = comp.props.get("xd_pp", 0.15)
    xr = comp.props.get("x_r_ratio", 40)

    rated_mva = rated_kva / 1000
    x_pu = xd_pp * base_mva / rated_mva
    r_pu = x_pu / xr
    return complex(r_pu, x_pu)


def _solar_pv_impedance(comp, base_mva):
    """Solar PV inverter fault impedance per IEC TR 60909-4.

    Inverter-based sources are current-limited. Fault contribution is modeled as:
      I_fault = fault_contribution_pu × I_rated
    The equivalent impedance is derived so that V/Z gives the correct current.

    Z_pv = V_rated / (fault_contribution × I_rated) in p.u. on system base
    """
    rated_kw = comp.props.get("rated_kw", 100)
    num_inv = comp.props.get("num_inverters", 1)
    voltage_kv = comp.props.get("voltage_kv", 0.4)
    fault_pu = comp.props.get("fault_contribution_pu", 1.1)
    eff = comp.props.get("inverter_eff", 0.97)

    # Total rated apparent power (assume PF=1 for sizing)
    total_kw = rated_kw * num_inv
    rated_mva = total_kw / (eff * 1000)

    if rated_mva < 1e-10:
        return complex(1e6, 1e6)  # Effectively infinite impedance

    # Equivalent reactance: X = 1 / fault_contribution (p.u. on machine base)
    # Then convert to system base
    x_machine_pu = 1.0 / max(fault_pu, 0.1)
    x_pu = x_machine_pu * base_mva / rated_mva

    # Inverters are predominantly reactive (high X/R ≈ 10)
    xr = 10
    r_pu = x_pu / xr
    return complex(r_pu, x_pu)


def _battery_impedance(comp, base_mva):
    """BESS inverter fault impedance — current-limited like solar PV
    (IEC TR 60909-4): I_fault = fault_contribution_pu × I_rated, X/R ≈ 10.
    The inverter contributes regardless of charge/discharge state — a fault
    collapses the terminal voltage and the converter feeds its current limit."""
    rated_mva = float(comp.props.get("rated_kva", 100) or 0) / 1000
    fault_pu = comp.props.get("fault_contribution_pu", 1.1)
    if rated_mva < 1e-10:
        return complex(1e6, 1e6)  # Effectively infinite impedance
    x_pu = (1.0 / max(fault_pu, 0.1)) * base_mva / rated_mva
    xr = 10
    return complex(x_pu / xr, x_pu)


def _wind_turbine_impedance(comp, base_mva):
    """Wind turbine generator fault impedance.

    Type 1/2 (SCIG/WRIG): Modeled like induction motors with Xd'' on machine base.
    Type 3 (DFIG): Crowbar-protected, contributes ~3-5× rated current; uses Xd''.
    Type 4 (Full converter): Current-limited like solar PV inverters (~1.1× rated).
    """
    rated_mva = comp.props.get("rated_mva", 2.0)
    num_turbines = comp.props.get("num_turbines", 1)
    turbine_type = comp.props.get("turbine_type", "type3_dfig")
    xr = comp.props.get("x_r_ratio", 30)

    total_mva = rated_mva * num_turbines
    if total_mva < 1e-10:
        return complex(1e6, 1e6)

    if turbine_type == "type4_frc":
        # Full converter: current-limited like inverter
        fault_pu = comp.props.get("fault_contribution_pu", 1.1)
        x_machine_pu = 1.0 / max(fault_pu, 0.1)
        x_pu = x_machine_pu * base_mva / total_mva
        xr = 10  # Converter X/R
    else:
        # Type 1/2/3: Use sub-transient reactance
        xd_pp = comp.props.get("xd_pp", 0.20)
        x_pu = xd_pp * base_mva / total_mva

    r_pu = x_pu / xr
    return complex(r_pu, x_pu)


def _collect_zero_seq_impedances(bus_id, components, adjacency, base_mva, c=C_MAX):
    """Collect zero-sequence impedances from sources feeding a bus.

    Zero-sequence current can only flow through grounded transformer windings.
    The zero-sequence impedance depends on vector group and grounding method.
    The winding facing the fault bus must provide a zero-sequence path — a
    delta winding on the bus side blocks zero-sequence regardless of the
    other winding's grounding.

    Returns a list of (z0_impedance, detail_string) tuples.

    Uses a per-path visited set (one copy per recursion branch) so parallel/
    ring zero-sequence paths are each found; capped at MAX_FAULT_PATHS.
    """
    z0_sources = []  # list of (complex, str)
    expansions = [0]

    def _comp_name(comp):
        return comp.props.get("name", comp.id) if comp else "?"

    def walk(comp_id, z0_path, trail, entry_port=None, path_visited=frozenset(), v_kv=11.0):
        if len(z0_sources) >= MAX_FAULT_PATHS or expansions[0] >= MAX_FAULT_EXPANSIONS:
            return
        expansions[0] += 1
        if comp_id in path_visited:
            return  # Cycle on this path
        path_visited = path_visited | {comp_id}
        comp = components.get(comp_id)
        if not comp:
            return

        if comp.type == "utility":
            # A zero-sequence source only exists if the utility neutral is
            # grounded (IEC 60909-0 §6.4). An ungrounded/isolated neutral has
            # Z0 → ∞ and must NOT feed an SLG/LLG fault — otherwise the earth-
            # fault current is overstated (non-conservative for relay reach).
            # Default "solidly" preserves prior behaviour; users model
            # impedance grounding by raising z0_z1_ratio. Mirrors the
            # transformer neutral gating and the unbalanced-LF utility check.
            grounding = str(comp.props.get("grounding", "solidly")).lower()
            if grounding in ("ungrounded", "isolated", "none", "unearthed"):
                return
            z_src = _utility_impedance(comp, base_mva, c)
            # Use z0_z1_ratio to derive Z0 from Z1, with legacy "x0_ratio" fallback
            z0_z1 = float(comp.props.get("z0_z1_ratio", 0) or comp.props.get("x0_ratio", 0))
            z0_src = z_src * z0_z1 if z0_z1 > 0 else z_src
            z_total = z0_path + z0_src
            desc = " → ".join(trail + [f"Utility '{_comp_name(comp)}' (Z0_src={abs(z0_src):.4f})"])
            z0_sources.append((z_total, desc))
            return

        if comp.type == "generator":
            # [PS-2] A machine sources zero-sequence current only if its star
            # point is earthed (IEC 60909-0 §6.4) — mirror the utility gate.
            # The `grounding` prop is authoritative; default "solidly"
            # preserves legacy results. An impedance-earthed neutral adds
            # 3·Zn to the zero-sequence loop.
            zn = _machine_neutral_z(comp, v_kv, base_mva)
            if zn is None:
                return  # unearthed star point — no Z0 path
            z_src = _generator_impedance(comp, base_mva, v_kv)
            x0_val = float(comp.props.get("x0", 0))
            if x0_val > 0:
                rated_mva = comp.props.get("rated_mva", 10)
                xr = comp.props.get("x_r_ratio", 40)
                x0_pu = x0_val * base_mva / rated_mva
                r0_pu = x0_pu / xr
                z0_src = complex(r0_pu, x0_pu)
            else:
                z0_src = z_src
            z0_src = z0_src + 3 * zn
            z_total = z0_path + z0_src
            desc = " → ".join(trail + [f"Generator '{_comp_name(comp)}' (Z0_src={abs(z0_src):.4f})"])
            z0_sources.append((z_total, desc))
            return

        if comp.type in ("solar_pv", "battery", "wind_turbine"):
            # [PS-2] Inverter-coupled sources present NO zero-sequence path by
            # default: 3-wire or delta/ungrounded-star coupled converters (and
            # Type 1–3 wind machine stators) have Z0 → ∞ per IEC 60909-0 §6.4
            # — the previous positive-sequence fallback fabricated earth-fault
            # current that the real installation cannot deliver. An
            # installation with an effectively earthed neutral (e.g. an
            # earthed-star coupling winding) can opt in by setting the
            # `grounding` prop to an earthed value; Z0 then uses the x0 prop
            # (machine base) if given, else the positive-sequence impedance,
            # plus 3·Zn. DELIBERATE BEHAVIOUR CHANGE (2026-07 verification):
            # SLG results on PV/BESS/wind-fed buses previously reported
            # phantom current.
            grounding = str(comp.props.get("grounding", "ungrounded")).lower()
            if grounding in _UNGROUNDED_VALUES:
                return
            zn = _machine_neutral_z(comp, v_kv, base_mva)
            if zn is None:
                return
            if comp.type == "solar_pv":
                z_src = _solar_pv_impedance(comp, base_mva)
                label = "Solar PV"
            elif comp.type == "battery":
                z_src = _battery_impedance(comp, base_mva)
                label = "BESS"
            else:
                z_src = _wind_turbine_impedance(comp, base_mva)
                label = "Wind Turbine"
            x0_val = float(comp.props.get("x0", 0))
            if x0_val > 0:
                rated = {
                    "solar_pv": comp.props.get("rated_kw", 100) * comp.props.get("num_inverters", 1) / 1000,
                    "battery": comp.props.get("rated_kva", 100) / 1000,
                    "wind_turbine": comp.props.get("rated_mva", 2.0) * comp.props.get("num_turbines", 1),
                }[comp.type]
                if rated > 1e-9:
                    x0_pu = x0_val * base_mva / rated
                    z_src = complex(x0_pu / 10, x0_pu)
            z0_src = z_src + 3 * zn
            z_total = z0_path + z0_src
            desc = " → ".join(trail + [f"{label} '{_comp_name(comp)}' (Z0_src={abs(z0_src):.4f}, earthed)"])
            z0_sources.append((z_total, desc))
            return

        if comp.type == "transformer":
            z_xfmr = _transformer_impedance(comp, base_mva)
            z_gnd, far_side = _transformer_zero_seq(comp, base_mva, entry_port)
            vg = comp.props.get("vector_group", "Dyn11")
            name = _comp_name(comp)
            if z_gnd is None:
                return  # No zero-sequence path through this transformer
            z0_element = z_xfmr + z_gnd
            es_lv = str(comp.props.get("earthing_system", "") or "").upper()
            es_tag = f", {es_lv}" if es_lv == 'TT' and comp.props.get("voltage_lv_kv", 11) <= 1.0 else ""
            xfmr_label = f"Xfmr '{name}' ({vg}{es_tag}, Z0={abs(z0_element):.4f})"
            if far_side == 'delta':
                # Delta/zigzag on far side provides Z0 circulation —
                # transformer itself is a Z0 source (e.g. Dyn11 from yn side).
                z_total = z0_path + z0_element
                desc = " → ".join(trail + [xfmr_label + " [Δ provides Z0 return]"])
                z0_sources.append((z_total, desc))
            elif far_side == 'magnetizing':
                # Single-earthed star-star (one neutral earthed, the other
                # floating, no delta): the far winding cannot pass I0, so the
                # earthed neutral is a LOCAL earth-fault source limited by the
                # transformer's zero-sequence magnetising reactance Z0m (core
                # dependent — folded into z_gnd). Three-limb cores give a
                # finite Z0m (tank phantom-delta); five-limb/shell/bank cores
                # approach open-circuit and are reported as blocked instead.
                z_total = z0_path + z0_element
                desc = " → ".join(trail + [xfmr_label + " [single-earthed: Z0 via core magnetising path]"])
                z0_sources.append((z_total, desc))
            elif far_side == 'grounded':
                # Grounded star on far side — Z0 passes through,
                # continue walking to find source (e.g. YNyn0).
                new_trail = trail + [xfmr_label + " [YN pass-through]"]
                v_far = _transformer_far_voltage(comp, v_kv)
                for neighbor_id, local_port, _ in adjacency.get(comp_id, []):
                    if neighbor_id != bus_id or comp_id == bus_id:
                        walk(neighbor_id, z0_path + z0_element, new_trail, None, path_visited, v_far)
            # else far_side == 'blocked': ungrounded star, no Z0 path
            return

        if comp.type == "autotransformer":
            # Autotransformer: the series + common winding form a metallic
            # connection, so zero-sequence passes HV↔LV (unlike a two-winding
            # transformer, which needs a grounded-star/delta path). Screening
            # model — Z0 ≈ the positive-sequence impedance, continue through
            # it with the winding voltage transformation.
            z0_element = _transformer_impedance(comp, base_mva)
            v_far = _transformer_far_voltage(comp, v_kv)
            new_trail = trail + [f"AutoXfmr '{_comp_name(comp)}' (Z0≈{abs(z0_element):.4f})"]
            for neighbor_id, _lp, _ in adjacency.get(comp_id, []):
                if neighbor_id != bus_id or comp_id == bus_id:
                    walk(neighbor_id, z0_path + z0_element, new_trail, None, path_visited, v_far)
            return

        if comp.type == "cable":
            # [EE-12] per-unit base from the bus-inferred voltage zone,
            # not the cable's own voltage_kv prop
            z_cable = _cable_z0(comp, base_mva, v_kv)
            new_trail = trail + [f"Cable '{_comp_name(comp)}' (Z0={abs(z_cable):.4f})"]
            # Forward the far-end port (the port by which the neighbor is
            # entered) exactly as the transparent-element branch does — a
            # transformer reached through a cable must still know which
            # winding faces the fault, otherwise it falls into the
            # "port unknown" fallback and a Dyn unit behind a cable becomes
            # a phantom Z0 source as seen from its delta side.
            for neighbor_id, _, remote_port in adjacency.get(comp_id, []):
                walk(neighbor_id, z0_path + z_cable, new_trail, remote_port, path_visited, v_kv)
            return

        if comp.type in ("cb", "switch"):
            state = comp.props.get("state", "closed")
            if state == "open":
                return
        # Transparent elements (CB, fuse, bus, etc.)
        v_next = v_kv
        if comp.type == "bus":
            v_next = float(comp.props.get("voltage_kv", v_kv) or v_kv)
        for neighbor_id, _, remote_port in adjacency.get(comp_id, []):
            if neighbor_id != bus_id or comp_id == bus_id:
                walk(neighbor_id, z0_path, trail, remote_port, path_visited, v_next)

    _bus_comp = components.get(bus_id)
    _v_start = float(_bus_comp.props.get("voltage_kv", 0.4 if _bus_comp.type == "distribution_board" else 11) or 11) if _bus_comp else 11.0
    for neighbor_id, _, remote_port in adjacency.get(bus_id, []):
        walk(neighbor_id, complex(0, 0), [], remote_port, frozenset({bus_id}), _v_start)

    if len(z0_sources) >= MAX_FAULT_PATHS or expansions[0] >= MAX_FAULT_EXPANSIONS:
        print(f"[fault] Warning: zero-sequence path enumeration truncated for bus "
              f"{bus_id} ({len(z0_sources)} paths, {expansions[0]} expansions)")

    return z0_sources


def _transformer_zero_seq(comp, base_mva, entry_port=None):
    """Compute zero-sequence grounding impedance contribution.

    Returns (z_gnd, far_side) tuple:
      - z_gnd: grounding impedance in per-unit, or None if Z0 is blocked.
      - far_side: 'delta' if the far winding provides Z0 circulation
        (transformer is itself a Z0 source), 'grounded' if Z0 can pass
        through to the far-side network, or 'blocked' if the far side
        has no Z0 path (ungrounded star).

    The entry_port parameter indicates which transformer port faces the
    fault bus ('primary' = top port, 'secondary' = bottom port).
    For step-down transformers: primary=HV, secondary=LV.
    For step-up transformers: primary=LV, secondary=HV.
    """
    vg = comp.props.get("vector_group", "Dyn11")
    grounding_hv = comp.props.get("grounding_hv", "ungrounded")
    grounding_lv = comp.props.get("grounding_lv", "solidly_grounded")
    is_step_up = comp.props.get("winding_config") == "step_up"

    # Parse vector group — strip uppercase HV designation to find LV part
    # HV winding: leading uppercase letters (D, Y, YN, Z, ZN)
    lv_part = re.sub(r'^[A-Z]+', '', vg)  # e.g. "Dyn11" → "yn11", "YNyn0" → "yn0"

    hv_delta = vg[0].upper() == 'D'
    hv_is_delta_or_zigzag = vg[0].upper() in ('D', 'Z')
    lv_delta = lv_part.lower().startswith("d")
    lv_is_delta_or_zigzag = len(lv_part) > 0 and lv_part[0].lower() in ('d', 'z')

    # The vector-group 'n' letter gives only the LEGACY grounded interpretation.
    _vg_hv_grounded = vg.upper().startswith("YN") or vg.upper().startswith("ZN")
    _vg_lv_grounded = lv_part.lower().startswith("yn") or lv_part.lower().startswith("zn")

    # The grounding_* prop is AUTHORITATIVE for a star winding: whether its
    # neutral is earthed is what decides if it can carry/pass zero-sequence
    # current, not the vector-group letters. A YNyn0 with one neutral left
    # ungrounded (and no delta) is a single-earthed star-star — it cannot pass
    # I0 through the floating winding. A delta/zigzag winding circulates I0
    # internally regardless of earthing, so it is never a grounded-star path.
    # When the prop is absent (legacy projects that set only the vector group)
    # we fall back to the vector-group letter so existing studies are unchanged.
    def _star_grounded(prop_key, vg_grounded):
        val = comp.props.get(prop_key, None)
        if val is None:
            return vg_grounded
        return str(val).lower() not in ("ungrounded", "isolated", "none", "unearthed")

    hv_grounded = (not hv_is_delta_or_zigzag) and _star_grounded("grounding_hv", _vg_hv_grounded)
    lv_grounded = (not lv_is_delta_or_zigzag) and _star_grounded("grounding_lv", _vg_lv_grounded)

    # Map port to winding side, accounting for step-up inversion
    # step_down (default): primary(top)=HV, secondary(bottom)=LV
    # step_up: primary(top)=LV, secondary(bottom)=HV
    if entry_port == 'primary':
        bus_side = 'lv' if is_step_up else 'hv'
    elif entry_port == 'secondary':
        bus_side = 'hv' if is_step_up else 'lv'
    else:
        bus_side = None  # Unknown — check both

    if bus_side == 'hv':
        bus_side_delta = hv_delta
        bus_side_grounded = hv_grounded
        far_delta_or_zigzag = lv_is_delta_or_zigzag
        far_grounded = lv_grounded
    elif bus_side == 'lv':
        bus_side_delta = lv_delta
        bus_side_grounded = lv_grounded
        far_delta_or_zigzag = hv_is_delta_or_zigzag
        far_grounded = hv_grounded
    else:
        # Port unknown — fall back to checking both sides
        bus_side_delta = False
        bus_side_grounded = hv_grounded or lv_grounded
        far_delta_or_zigzag = hv_is_delta_or_zigzag or lv_is_delta_or_zigzag
        far_grounded = hv_grounded or lv_grounded

    # A delta winding on the bus side presents infinite zero-sequence
    # impedance to the fault bus — zero-sequence current cannot enter.
    if bus_side_delta:
        return None, 'blocked'

    # The bus-side winding must be grounded star for Z0 to flow
    if not bus_side_grounded:
        return None, 'blocked'  # Ungrounded star — no zero-sequence path

    # Determine far-side behaviour:
    # - Delta/zigzag: provides zero-sequence circulation — transformer
    #   is itself a Z0 source.  Walk stops here.
    # - Grounded star: Z0 passes through — walk continues to far side.
    # - Ungrounded star + no delta (single-earthed star-star): the far
    #   winding cannot pass I0, but the earthed bus-side neutral is still a
    #   LOCAL earth-fault source limited by the core zero-sequence magnetising
    #   reactance Z0m — finite on a three-limb core, ≈ open on five-limb/
    #   shell/bank (then blocked).
    z0m = None
    if far_delta_or_zigzag:
        far_side = 'delta'
    elif far_grounded:
        far_side = 'grounded'
    else:
        z0m = _zero_seq_magnetizing(comp, base_mva)
        far_side = 'magnetizing' if z0m is not None else 'blocked'

    # Compute grounding impedance from the user-specified grounding config.
    # The grounding prop is authoritative — if the user sets "ungrounded",
    # Z0 is blocked even when the vector group says YN/yn.
    v_hv = comp.props.get("voltage_hv_kv", 33)
    v_lv = comp.props.get("voltage_lv_kv", 11)
    z_base_hv = (v_hv ** 2) / base_mva
    z_base_lv = (v_lv ** 2) / base_mva

    def _get_grounding(side):
        """Get grounding impedance for a winding side."""
        grounding_cfg = grounding_hv if side == 'hv' else grounding_lv
        z_b = z_base_hv if side == 'hv' else z_base_lv
        return _grounding_impedance(grounding_cfg, comp, side, z_b)

    if bus_side:
        z_gnd = _get_grounding(bus_side)
    elif lv_grounded:
        z_gnd = _get_grounding('lv')
    elif hv_grounded:
        z_gnd = _get_grounding('hv')
    else:
        z_gnd = None

    if z_gnd is None:
        return None, 'blocked'

    # LV earthing-system arrangement (IEC 60364-1 §312.2 / SANS 10142-1).
    # Only meaningful for an LV winding (≤1 kV) facing the fault — the system
    # earthing (TN/TT/IT) is defined on the LV side of the source. MV/HV faults
    # and legacy projects without the field are unaffected (es == '').
    es = str(comp.props.get("earthing_system", "") or "").upper()
    lv_faces_fault = (bus_side == 'lv') or (bus_side is None and lv_grounded)
    if es and lv_faces_fault and v_lv <= 1.0:
        if es == 'IT':
            # Source unearthed / high-impedance: no zero-sequence return for the
            # first earth fault, so Ik1 ≈ 0 (insulation-monitoring territory).
            return None, 'blocked'
        if es == 'TT':
            # The fault current returns through soil, not a metallic PE. Add the
            # source (R_B) and installation (R_A) earth-electrode resistances.
            # An earth-return resistance appears as 3·Z_E in the zero-sequence
            # network — the ×3 below supplies that factor, so add R_A+R_B here.
            r_b = float(comp.props.get("earth_electrode_r_source", 0) or 0)
            r_a = float(comp.props.get("earth_electrode_r_installation", 0) or 0)
            z_gnd = z_gnd + complex((r_a + r_b) / z_base_lv, 0)

    # 3*Zn appears in the zero-sequence circuit
    z0_seq = z_gnd * 3
    # Single-earthed star-star: add the core zero-sequence magnetising branch
    # (Z0m is already a zero-sequence impedance — no ×3), so the earthed
    # neutral sources a finite, limited earth-fault current instead of zero.
    if far_side == 'magnetizing' and z0m is not None:
        z0_seq = z0_seq + z0m
    return z0_seq, far_side


def _zero_seq_magnetizing(comp, base_mva):
    """Zero-sequence magnetising impedance of a single-earthed star-star
    transformer (one neutral earthed, the other floating, no delta), in
    per-unit on the study base — or None if the core presents an effectively
    open zero-sequence path.

    A three-limb core forces the (in-phase) zero-sequence flux out through the
    tank and air — a lossy "phantom delta" — giving a finite Z0m (~0.3–1.0 pu
    on the unit base) that lets the earthed neutral drive a limited earth-fault
    current. Five-limb, shell and single-phase-bank cores have an iron return
    path, so Z0m approaches open circuit and the earthed neutral sources
    negligible earth-fault current (returned as None → blocked). An explicit
    ``z0m_pu`` prop (e.g. the datasheet open-circuit zero-sequence impedance)
    overrides the core-type default for any construction.
    """
    override = comp.props.get("z0m_pu", None)
    core = str(comp.props.get("core_construction", "three_limb")).lower().replace("-", "_")
    if override not in (None, "", 0, 0.0):
        z0m_own = float(override)
    elif core in ("three_limb", "3_limb"):
        z0m_own = 0.6  # representative tank-return value; override with datasheet X0
    else:
        return None  # five-limb / shell / single-phase bank ≈ open circuit
    if z0m_own <= 0:
        return None
    # per-unit on the unit MVA base → study base
    rated_mva = float(comp.props.get("rated_mva", 1.0) or 1.0)
    z0m_study = z0m_own * base_mva / max(rated_mva, 1e-9)
    xr = float(comp.props.get("x_r_ratio", 10) or 10)
    x = z0m_study
    r = x / xr if xr > 0 else 0.0
    return complex(r, x)


def _grounding_impedance(grounding_type, comp, side, z_base):
    """Convert grounding configuration to per-unit impedance.

    Returns None for ungrounded (no zero-sequence path).
    """
    if grounding_type == "ungrounded":
        return None
    if grounding_type == "solidly_grounded":
        return complex(0, 0)

    r_key = f"grounding_{side}_resistance"
    x_key = f"grounding_{side}_reactance"

    if grounding_type in ("low_resistance", "high_resistance"):
        r_ohm = comp.props.get(r_key, 0)
        return complex(r_ohm / z_base, 0)
    if grounding_type == "reactance_grounded":
        x_ohm = comp.props.get(x_key, 0)
        return complex(0, x_ohm / z_base)

    return complex(0, 0)


def _parallel_impedances(impedances):
    """Parallel combination of complex impedances."""
    if len(impedances) == 0:
        return complex(1e10, 0)
    if len(impedances) == 1:
        return impedances[0]
    y_total = sum(1 / z for z in impedances if abs(z) > 1e-15)
    if abs(y_total) < 1e-15:
        return complex(1e10, 0)
    return 1 / y_total


# ─── [PS-1] Nodal (Zbus) sequence networks for meshed topologies ─────────────
#
# Paralleling per-path impedance totals is exact ONLY when parallel paths share
# no element. On ring / parallel-feeder / bus-coupler networks the shared
# upstream impedance is duplicated into each path and then halved by the
# parallel combination, overstating fault currents (measured +58 % on two
# parallel feeders from one utility). When _paths_are_meshed() detects sharing,
# the headline Thevenin impedances (Z1, Z2, Z0) are instead taken from the bus
# impedance matrix Z_kk of a nodally-built network. Radial networks never
# enter this code path, keeping legacy results byte-identical.


def _build_bus_network(net_buses, components, adjacency, base_mva, c):
    """Build bus-level sequence networks: series branches between bus-like
    nodes and source shunts at each node, for the positive/negative and zero
    sequence. Source shunts INCLUDE the series impedance accumulated between
    the bus and the source (a generator behind a cable keeps its cable).

    Returns a dict with bus ids, branch lists and per-bus shunt lists.
    """
    bus_ids = [b.id for b in net_buses]
    bus_set = set(bus_ids)
    branches1 = []                      # (from_bus, to_bus, z1) — z2 identical for static elements
    shunts12 = {bid: [] for bid in bus_ids}  # (z1_total, z2_total, source_id, source_type)
    branches0 = []                      # (from_bus, to_bus, z0)
    shunts0 = {bid: [] for bid in bus_ids}   # z0_total

    def walk1(comp_id, z_path, visited, from_bus_id, v_kv):
        if comp_id in visited:
            return
        visited.add(comp_id)
        comp = components.get(comp_id)
        if not comp:
            return

        if comp_id in bus_set:
            if comp_id != from_bus_id:
                z = z_path if abs(z_path) > 1e-15 else complex(1e-6, 1e-6)
                branches1.append((from_bus_id, comp_id, z))
            return

        t = comp.type
        if t == "utility":
            z_src = _utility_impedance(comp, base_mva, c)
            shunts12[from_bus_id].append((z_path + z_src, z_path + _source_z2(comp, z_src, base_mva), comp_id, t))
            return
        if t == "generator":
            z_src = _generator_impedance(comp, base_mva, v_kv)
            shunts12[from_bus_id].append((z_path + z_src, z_path + _source_z2(comp, z_src, base_mva), comp_id, t))
            return
        if t == "motor_induction":
            z_src = _motor_induction_impedance(comp, base_mva)
            shunts12[from_bus_id].append((z_path + z_src, z_path + _source_z2(comp, z_src, base_mva), comp_id, t))
            return
        if t == "motor_synchronous":
            z_src = _motor_synchronous_impedance(comp, base_mva)
            shunts12[from_bus_id].append((z_path + z_src, z_path + _source_z2(comp, z_src, base_mva), comp_id, t))
            return
        if t == "solar_pv":
            z_src = _solar_pv_impedance(comp, base_mva)
            shunts12[from_bus_id].append((z_path + z_src, z_path + z_src, comp_id, t))
            return
        if t == "battery":
            z_src = _battery_impedance(comp, base_mva)
            shunts12[from_bus_id].append((z_path + z_src, z_path + z_src, comp_id, t))
            return
        if t == "wind_turbine":
            z_src = _wind_turbine_impedance(comp, base_mva)
            shunts12[from_bus_id].append((z_path + z_src, z_path + z_src, comp_id, t))
            return
        if t == "static_load":
            z_src, _mva = _static_load_motor_impedance(comp, base_mva)
            if z_src is not None:
                # motor-equivalent fraction — classified as a motor infeed
                shunts12[from_bus_id].append((z_path + z_src, z_path + z_src, comp_id, "motor_induction"))
            return

        z_element = complex(0, 0)
        v_next = v_kv
        if t in ("transformer", "autotransformer"):
            z_element = _transformer_impedance(comp, base_mva)
            v_next = _transformer_far_voltage(comp, v_kv)
        elif t == "cable":
            z_element = _cable_impedance(comp, base_mva, v_kv)
        elif t in ("cb", "switch"):
            if comp.props.get("state", "closed") == "open":
                return
        for neighbor_id, _, _ in adjacency.get(comp_id, []):
            walk1(neighbor_id, z_path + z_element, visited, from_bus_id, v_next)

    def walk0(comp_id, z0_path, visited, from_bus_id, entry_port, v_kv):
        if comp_id in visited:
            return
        visited.add(comp_id)
        comp = components.get(comp_id)
        if not comp:
            return

        if comp_id in bus_set:
            if comp_id != from_bus_id:
                z = z0_path if abs(z0_path) > 1e-15 else complex(1e-6, 1e-6)
                branches0.append((from_bus_id, comp_id, z))
            return

        t = comp.type
        if t == "utility":
            grounding = str(comp.props.get("grounding", "solidly")).lower()
            if grounding in _UNGROUNDED_VALUES:
                return
            z_src = _utility_impedance(comp, base_mva, c)
            z0_z1 = float(comp.props.get("z0_z1_ratio", 0) or comp.props.get("x0_ratio", 0))
            z0_src = z_src * z0_z1 if z0_z1 > 0 else z_src
            shunts0[from_bus_id].append(z0_path + z0_src)
            return
        if t == "generator":
            zn = _machine_neutral_z(comp, v_kv, base_mva)
            if zn is None:
                return
            z_src = _generator_impedance(comp, base_mva, v_kv)
            x0_val = float(comp.props.get("x0", 0))
            if x0_val > 0:
                rated_mva = comp.props.get("rated_mva", 10)
                xr = comp.props.get("x_r_ratio", 40)
                x0_pu = x0_val * base_mva / rated_mva
                z_src = complex(x0_pu / xr, x0_pu)
            shunts0[from_bus_id].append(z0_path + z_src + 3 * zn)
            return
        if t in ("solar_pv", "battery", "wind_turbine"):
            # [PS-2] blocked unless explicitly earthed (see the path walker)
            grounding = str(comp.props.get("grounding", "ungrounded")).lower()
            if grounding in _UNGROUNDED_VALUES:
                return
            zn = _machine_neutral_z(comp, v_kv, base_mva)
            if zn is None:
                return
            if t == "solar_pv":
                z_src = _solar_pv_impedance(comp, base_mva)
            elif t == "battery":
                z_src = _battery_impedance(comp, base_mva)
            else:
                z_src = _wind_turbine_impedance(comp, base_mva)
            shunts0[from_bus_id].append(z0_path + z_src + 3 * zn)
            return
        if t == "transformer":
            z_gnd, far_side = _transformer_zero_seq(comp, base_mva, entry_port)
            if z_gnd is None:
                return
            z0_element = _transformer_impedance(comp, base_mva) + z_gnd
            if far_side in ("delta", "magnetizing"):
                shunts0[from_bus_id].append(z0_path + z0_element)
                return
            # 'grounded' — Z0 passes through to the far-side network
            v_far = _transformer_far_voltage(comp, v_kv)
            for neighbor_id, _, remote_port in adjacency.get(comp_id, []):
                walk0(neighbor_id, z0_path + z0_element, visited, from_bus_id, remote_port, v_far)
            return
        if t == "autotransformer":
            z0_element = _transformer_impedance(comp, base_mva)
            v_far = _transformer_far_voltage(comp, v_kv)
            for neighbor_id, _, remote_port in adjacency.get(comp_id, []):
                walk0(neighbor_id, z0_path + z0_element, visited, from_bus_id, remote_port, v_far)
            return
        if t == "cable":
            z_cable = _cable_z0(comp, base_mva, v_kv)
            for neighbor_id, _, remote_port in adjacency.get(comp_id, []):
                walk0(neighbor_id, z0_path + z_cable, visited, from_bus_id, remote_port, v_kv)
            return
        if t in ("cb", "switch"):
            if comp.props.get("state", "closed") == "open":
                return
        # Transparent element (closed CB/switch, fuse, CT/PT, …)
        for neighbor_id, _, remote_port in adjacency.get(comp_id, []):
            walk0(neighbor_id, z0_path, visited, from_bus_id, remote_port, v_kv)

    for b in net_buses:
        v_start = float(b.props.get("voltage_kv", 0.4 if b.type == "distribution_board" else 11) or 11)
        for neighbor_id, _, remote_port in adjacency.get(b.id, []):
            walk1(neighbor_id, complex(0, 0), {b.id}, b.id, v_start)
            walk0(neighbor_id, complex(0, 0), {b.id}, b.id, remote_port, v_start)
        # A distribution board's own rotating load fraction is a shunt at the
        # node itself (the path walker models it the same way).
        if b.type == "distribution_board":
            z_src, _mva = _static_load_motor_impedance(b, base_mva)
            if z_src is not None:
                shunts12[b.id].append((z_src, z_src, b.id, "motor_induction"))

    def _dedupe(branch_list):
        # Each physical chain is discovered once from each endpoint — keep the
        # lower-ordered discovery, preserving genuinely parallel branches.
        unique, kept_pairs = [], set()
        for bi, bj, z in branch_list:
            if bi < bj:
                unique.append((bi, bj, z))
                kept_pairs.add((bi, bj))
        for bi, bj, z in branch_list:
            if bi > bj and (bj, bi) not in kept_pairs:
                unique.append((bj, bi, z))
        return unique

    return {
        "bus_ids": bus_ids,
        "branches1": _dedupe(branches1),
        "shunts12": shunts12,
        "branches0": _dedupe(branches0),
        "shunts0": shunts0,
    }


def _nodal_thevenin(bus_ids, branches, shunts, faulted_id):
    """Thevenin impedance Z_kk at faulted_id from a nodal network solution.

    Restricts the solve to the connected component containing the faulted bus
    (isolated islands would make Ybus singular). Returns None when the faulted
    bus has no source in its component or the solve fails — callers fall back
    to the per-path result.
    """
    if faulted_id not in set(bus_ids):
        return None
    # Connected component of the faulted bus over the branch graph
    adj = {}
    for bi, bj, _z in branches:
        adj.setdefault(bi, set()).add(bj)
        adj.setdefault(bj, set()).add(bi)
    comp_nodes, frontier = {faulted_id}, [faulted_id]
    while frontier:
        nxt = frontier.pop()
        for nb in adj.get(nxt, ()):
            if nb not in comp_nodes:
                comp_nodes.add(nb)
                frontier.append(nb)
    nodes = [bid for bid in bus_ids if bid in comp_nodes]
    if not any(shunts.get(n) for n in nodes):
        return None  # no source reachable — no fault current path
    idx = {bid: i for i, bid in enumerate(nodes)}
    n = len(nodes)
    ybus = np.zeros((n, n), dtype=complex)
    for bi, bj, z in branches:
        if bi not in idx or bj not in idx or bi == bj:
            continue
        if abs(z) < 1e-15:
            z = complex(1e-6, 1e-6)
        y = 1.0 / z
        i, j = idx[bi], idx[bj]
        ybus[i, i] += y
        ybus[j, j] += y
        ybus[i, j] -= y
        ybus[j, i] -= y
    for bid in nodes:
        for z_src in shunts.get(bid, []):
            if abs(z_src) > 1e-15:
                ybus[idx[bid], idx[bid]] += 1.0 / z_src
    try:
        zbus = np.linalg.inv(ybus)
    except np.linalg.LinAlgError:
        return None
    z_kk = zbus[idx[faulted_id], idx[faulted_id]]
    if not np.isfinite(z_kk) or abs(z_kk) < 1e-15 or abs(z_kk) > 1e9:
        return None
    return complex(z_kk)


def thevenin_z1_at_bus(project, bus_id, c=1.0, exclude_motor_paths=True,
                       exclude_source_ids=()):
    """Positive-sequence Thevenin impedance at a bus (p.u. on the system base
    at the bus voltage zone), for voltage-dip / motor-starting studies.

    Radial topologies use the per-path parallel combination (exact); meshed
    topologies are solved nodally so shared upstream impedance is not
    double-counted ([PS-1]). Motor infeeds (including the motor-equivalent
    fraction of lumped loads) are excluded by default — they are loads, not
    sustaining sources, for a starting study. Returns None when no
    qualifying source feeds the bus.
    """
    components = {comp.id: comp for comp in project.components}
    adjacency = {}
    for w in project.wires:
        adjacency.setdefault(w.fromComponent, []).append(
            (w.toComponent, w.fromPort, w.toPort))
        adjacency.setdefault(w.toComponent, []).append(
            (w.fromComponent, w.toPort, w.fromPort))

    excluded = set(exclude_source_ids)

    def _path_ok(p):
        if p.get("source_id") in excluded:
            return False
        if exclude_motor_paths and (
                p.get("is_motor")
                or p.get("source_type") in ("motor_induction", "motor_synchronous")):
            return False
        return True

    paths = _collect_source_paths(bus_id, components, adjacency,
                                  project.baseMVA, c=c)
    keep = [p for p in paths if _path_ok(p)]
    if not keep:
        return None
    z_paths = _parallel_impedances([p["z_total"] for p in keep])
    if not _paths_are_meshed(keep, components):
        return z_paths

    net_buses = [comp for comp in project.components
                 if comp.type in ("bus", "distribution_board")
                 and str(comp.props.get("system", "ac")).lower() != "dc"]
    net = _build_bus_network(net_buses, components, adjacency,
                             project.baseMVA, c)
    shunts = {}
    for bid, lst in net["shunts12"].items():
        shunts[bid] = [z1 for (z1, _z2, sid, st) in lst
                       if sid not in excluded
                       and not (exclude_motor_paths
                                and st in ("motor_induction", "motor_synchronous"))]
    z_kk = _nodal_thevenin(net["bus_ids"], net["branches1"], shunts, bus_id)
    return z_kk if z_kk is not None else z_paths


# ─── IEC 60909 Time-Varying Fault Currents ───────────────────────────────────


def _compute_kappa(r_over_x):
    """Compute peak factor κ per IEC 60909-0 §8.1, Eq. (55).

    κ = 1.02 + 0.98 × e^(−3 × R/X)
    Range: 1.02 (pure R) to 2.0 (pure X).
    """
    return 1.02 + 0.98 * math.exp(-3 * r_over_x)


def _compute_peak_current(ik3_ka, z_eq, meshed=False, voltage_kv=None):
    """Compute peak short-circuit current ip per IEC 60909-0 §8.1.

    ip = κ × √2 × I"k3

    The R/X ratio is taken from the complex equivalent impedance Z_eq at the
    fault point (R_eq/X_eq). For radial networks this is exact (single-path
    κ). [PS-5] For MESHED networks IEC 60909-0 §8.1.2.2 Method b requires
    κ_b = 1.15 × κ(R/X), capped at 1.8 for LV networks (U_n ≤ 1 kV) and 2.0
    for HV — applied when the caller detected a meshed topology. (Method c,
    the equivalent-frequency procedure, remains future work.)

    Returns (ip_ka, kappa) — kappa is the effective (capped) value used.
    """
    if ik3_ka is None or ik3_ka < 1e-10 or abs(z_eq) < 1e-15:
        return None, None

    r = z_eq.real
    x = z_eq.imag
    r_over_x = abs(r / x) if abs(x) > 1e-15 else 10.0  # High R/X → low κ
    kappa = _compute_kappa(r_over_x)
    if meshed:
        cap = 1.8 if (voltage_kv is not None and voltage_kv <= 1.0) else 2.0
        kappa = min(1.15 * kappa, cap)
    ip_ka = kappa * math.sqrt(2) * ik3_ka
    return round(ip_ka, 3), round(kappa, 3)


def _compute_breaking_current(ik3_ka, source_paths, c_factor, i_base_ka, base_mva, t_min=0.1):
    """Compute symmetrical breaking current Ib per IEC 60909-0 §9.1.

    For near-to-generator faults:
      Ib = μ × I"k   (per source contribution)

    Factor μ depends on I"k/I_rG ratio and minimum breaking time t_min.
    Per IEC 60909-0 §9.1.1, Eq. (70):
      μ = 0.84 + 0.26 × e^(−0.26 × I"kG/I_rG)  for t_min = 0.02s
      μ = 0.71 + 0.51 × e^(−0.30 × I"kG/I_rG)  for t_min = 0.05s
      μ = 0.62 + 0.72 × e^(−0.32 × I"kG/I_rG)  for t_min = 0.10s
      μ = 0.56 + 0.94 × e^(−0.38 × I"kG/I_rG)  for t_min ≥ 0.25s

    For far-from-generator faults (utility sources): μ = 1 (no decay).
    For induction motors: μ determined by I"k/I_rM and t_min per §13.
    Motor q factor: q = 1.03 + 0.12 × ln(m) for t_min = 0.02s, etc.

    Returns Ib in kA.
    """
    if ik3_ka is None or ik3_ka < 1e-10:
        return None

    ib_total = 0

    for path in source_paths:
        z_path = path["z_total"]
        if abs(z_path) < 1e-15:
            continue

        ik_path_pu = c_factor / abs(z_path)
        ik_path_ka = ik_path_pu * i_base_ka
        source_type = path.get("source_type", "utility")

        if source_type == "utility":
            # Far-from-generator: no decay, μ = 1
            ib_total += ik_path_ka

        elif source_type == "generator":
            # I"kG/IrG evaluated at the FAULT POINT per IEC 60909-0 §9.1.1:
            # the p.u. fault current on the system base, referred to the
            # machine's rated current (× base_mva/rated_mva). This accounts
            # for the external impedance between the machine and the fault
            # (for a terminal fault it reduces to c/x"d). Using the machine-
            # terminal ratio c/x"d overstates the ratio for remote faults,
            # giving too small a μ and understating Ib.
            rated_mva = path.get("rated_mva", 10)
            ik_over_ir = (ik_path_pu * base_mva / rated_mva if rated_mva > 1e-6
                          else c_factor / path.get("xd_pp", 0.15))
            mu = _mu_factor(ik_over_ir, t_min)
            ib_total += mu * ik_path_ka

        elif source_type == "motor_synchronous":
            # Synchronous motors: same fault-point ratio as the generator branch.
            rated_mva = path.get("rated_mva", 0.5)
            ik_over_ir = (ik_path_pu * base_mva / rated_mva if rated_mva > 1e-6
                          else c_factor / path.get("xd_pp", 0.15))
            mu = _mu_factor(ik_over_ir, t_min)
            ib_total += mu * ik_path_ka

        elif source_type == "motor_induction":
            # Induction motors: current decays rapidly
            # Per IEC 60909-0 §13.2, use μ × q factor
            rated_mva = path.get("rated_mva", 0.2)
            # For LV motors, per-unit ratio based on locked-rotor.
            # SIMPLIFICATION: the q factor argument per IEC 60909-0 §9.1.2
            # should be m = rated active power (MW) per pole pair; the motor
            # pole count is not modelled, so the I"kM/IrM current ratio is
            # used as a proxy. This is an approximation of the standard.
            ik_over_ir = ik_path_pu * base_mva / rated_mva if rated_mva > 1e-6 else 6
            mu = _mu_factor(ik_over_ir, t_min)
            q = _q_factor(ik_over_ir, t_min)
            ib_total += mu * q * ik_path_ka

        elif source_type in ("solar_pv", "battery"):
            # Inverter-based: no decay, current-limited at fault contribution level
            ib_total += ik_path_ka

        elif source_type == "wind_turbine":
            t_type = path.get("turbine_type", "type3_dfig")
            if t_type == "type4_frc":
                # Full converter: no decay, current-limited
                ib_total += ik_path_ka
            elif t_type in ("type1_scig", "type2_wrig"):
                # Induction-machine based: decays like induction motor
                rated_mva = path.get("rated_mva", 2.0)
                ik_over_ir = ik_path_pu * base_mva / rated_mva if rated_mva > 1e-6 else 5
                mu = _mu_factor(ik_over_ir, t_min)
                q = _q_factor(ik_over_ir, t_min)
                ib_total += mu * q * ik_path_ka
            else:
                # Type 3 DFIG: partial converter, use μ factor like generator
                # with the fault-point I"k/Ir ratio (see the generator branch).
                rated_mva = path.get("rated_mva", 2.0)
                ik_over_ir = (ik_path_pu * base_mva / rated_mva if rated_mva > 1e-6
                              else c_factor / path.get("xd_pp", 0.20))
                mu = _mu_factor(ik_over_ir, t_min)
                ib_total += mu * ik_path_ka

    return round(ib_total, 3)


def _mu_factor(ik_over_ir, t_min):
    """Decay factor μ per IEC 60909-0 §9.1.1, Eq. (70)-(73).

    Interpolates between standard breaking times.
    """
    if ik_over_ir < 2:
        return 1.0  # Far from generator — no significant decay

    if t_min <= 0.02:
        mu = 0.84 + 0.26 * math.exp(-0.26 * ik_over_ir)
    elif t_min <= 0.05:
        mu = 0.71 + 0.51 * math.exp(-0.30 * ik_over_ir)
    elif t_min <= 0.10:
        mu = 0.62 + 0.72 * math.exp(-0.32 * ik_over_ir)
    else:  # t_min >= 0.25
        mu = 0.56 + 0.94 * math.exp(-0.38 * ik_over_ir)

    return min(mu, 1.0)  # μ ≤ 1


def _q_factor(ik_over_ir, t_min):
    """Motor decay factor q per IEC 60909-0 §13.2.

    For induction motors, accounts for faster current decay.
    q approaches 0 for small motors at longer breaking times.
    """
    if ik_over_ir < 1:
        return 1.0

    m = ik_over_ir
    if t_min <= 0.02:
        q = 1.03 + 0.12 * math.log(m) if m > 0 else 1.0
    elif t_min <= 0.05:
        q = 0.79 + 0.12 * math.log(m) if m > 0 else 0.79
    elif t_min <= 0.10:
        q = 0.57 + 0.12 * math.log(m) if m > 0 else 0.57
    else:
        q = 0.26 + 0.10 * math.log(m) if m > 0 else 0.26

    return max(min(q, 1.0), 0.0)  # 0 ≤ q ≤ 1


def _compute_steady_state_current(source_paths, c_factor, i_base_ka, base_mva, voltage_kv):
    """Compute steady-state short-circuit current Ik per IEC 60909-0 §10.

    Ik depends on source type:
    - Utility/network: Ik = I"k (no decay for far-from-generator faults)
    - Generator: Ik = c × V / (√3 × Xd × Z_base) — uses synchronous Xd
    - Synchronous motor: similar to generator with Xd
    - Induction motor: Ik = 0 (current decays to zero within ~200ms)

    Returns Ik in kA.
    """
    ik_total = 0

    for path in source_paths:
        z_path = path["z_total"]
        if abs(z_path) < 1e-15:
            continue

        ik_path_pu = c_factor / abs(z_path)
        ik_path_ka = ik_path_pu * i_base_ka
        source_type = path.get("source_type", "utility")

        if source_type == "utility":
            # Network source: Ik = I"k (sustained)
            ik_total += ik_path_ka

        elif source_type == "generator":
            # Generator: steady-state uses Xd (synchronous reactance)
            xd = path.get("xd", 1.2)
            xd_pp = path.get("xd_pp", 0.15)
            rated_mva = path.get("rated_mva", 10)
            # Scale: Ik_gen = I"k × (X"d / Xd) approximately
            # More precisely: Ik = c / (Xd × base_mva/rated_mva) × i_base
            xd_sys = xd * base_mva / rated_mva
            ik_steady_pu = c_factor / xd_sys if xd_sys > 1e-10 else 0
            ik_total += ik_steady_pu * i_base_ka

        elif source_type == "motor_synchronous":
            # Synchronous motor: reduced steady-state contribution
            xd_p = path.get("xd_p", 0.25)
            rated_mva = path.get("rated_mva", 0.5)
            # Use transient reactance for conservative steady-state estimate
            xd_p_sys = xd_p * base_mva / rated_mva
            ik_steady_pu = c_factor / xd_p_sys if xd_p_sys > 1e-10 else 0
            ik_total += ik_steady_pu * i_base_ka

        elif source_type == "motor_induction":
            # Induction motor: current decays to zero — no steady-state contribution
            pass

    return round(ik_total, 3) if ik_total > 1e-10 else None


# ─── Voltage Depression (IEC 60909 §3.6 / Zbus Method) ──────────────────────


def _compute_voltage_depression(all_buses, components, adjacency, wires, base_mva, results):
    """Compute voltage depression at all buses during fault at each faulted bus.

    Builds the bus admittance matrix (Ybus) from branch impedances and source
    shunt admittances, inverts to get the bus impedance matrix (Zbus), then
    applies: V_j = 1 - Z_jk / Z_kk  (retained voltage at bus j for fault at bus k).

    Three impedance modes are computed:
      - Sub-transient: generators use Xd'', motors use X''
      - Transient: generators use Xd', motors decayed (removed)
      - Steady-state: generators use Xd, motors removed

    Motor reacceleration recovery is computed for buses with connected motors.
    """
    bus_ids = [b.id for b in all_buses]
    n = len(bus_ids)
    if n < 2:
        return
    bus_idx = {bid: i for i, bid in enumerate(bus_ids)}
    bus_voltage = {b.id: b.props.get("voltage_kv", 11) for b in all_buses}

    # Build adjacency info: find branches between buses and sources at buses
    branches = []   # (bus_i_id, bus_j_id, z_branch)
    bus_shunts = {bid: [] for bid in bus_ids}  # bus_id -> [(z_source, source_type, comp)]

    # Find bus-to-bus connections through transformers/cables
    # Walk from each bus to find directly connected buses via branch elements
    for bus in all_buses:
        _find_bus_branches(bus.id, bus_ids, components, adjacency, branches, bus_shunts, base_mva)

    # Deduplicate branches: each physical branch is discovered once from each
    # endpoint, so keep only the entries found from the lower-ordered bus.
    # Unlike a bus-pair keyed dedup, this preserves genuinely PARALLEL
    # branches between the same bus pair — their admittances are summed
    # into Ybus below.
    unique_branches = []
    kept_pairs = set()
    for bi, bj, z in branches:
        if bi < bj:
            unique_branches.append((bi, bj, z))
            kept_pairs.add((bi, bj))
    # Defensive: keep reverse-direction entries whose pair was never seen
    # from the lower-ordered side (asymmetric discovery).
    for bi, bj, z in branches:
        if bi > bj and (bj, bi) not in kept_pairs:
            unique_branches.append((bi, bj, z))

    # Build Ybus and compute Zbus for three impedance modes
    modes = ["subtransient", "transient", "steadystate"]
    for mode in modes:
        ybus = np.zeros((n, n), dtype=complex)

        # Add branch admittances
        for bi, bj, z in unique_branches:
            if bi not in bus_idx or bj not in bus_idx:
                continue
            i, j = bus_idx[bi], bus_idx[bj]
            if abs(z) < 1e-15:
                z = complex(1e-6, 1e-6)  # Avoid division by zero
            y = 1.0 / z
            ybus[i, i] += y
            ybus[j, j] += y
            ybus[i, j] -= y
            ybus[j, i] -= y

        # Add source shunt admittances (mode-dependent)
        for bid in bus_ids:
            i = bus_idx[bid]
            for z_src, src_type, comp in bus_shunts[bid]:
                z_mode = _get_mode_impedance(z_src, src_type, comp, base_mva, mode)
                if z_mode is not None and abs(z_mode) > 1e-15:
                    ybus[i, i] += 1.0 / z_mode

        # Invert Ybus to get Zbus
        try:
            zbus = np.linalg.inv(ybus)
        except np.linalg.LinAlgError:
            continue  # Singular matrix — skip this mode

        # Compute retained voltage: V_j = 1 - Z_jk / Z_kk
        for faulted_bus_id, fault_result in results.items():
            if faulted_bus_id not in bus_idx:
                continue
            k = bus_idx[faulted_bus_id]
            z_kk = zbus[k, k]
            if abs(z_kk) < 1e-15:
                continue

            if fault_result.voltage_depression is None:
                fault_result.voltage_depression = {}

            # NOTE: retained voltage uses the 1.0 p.u. prefault convention
            # (V_j = 1 − Z_jk/Z_kk). The IEC 60909 c-factor is deliberately
            # NOT applied here: scaling the fault current by c would show a
            # nonzero retained voltage at the bolted-fault bus itself.

            for other_bus in all_buses:
                j = bus_idx[other_bus.id]
                z_jk = zbus[j, k]
                v_retained_pu = abs(1.0 - z_jk / z_kk)
                # Clamp to [0, 1.2] — can exceed 1.0 due to voltage factor
                v_retained_pu = max(0.0, min(v_retained_pu, 1.2))
                v_kv = bus_voltage.get(other_bus.id, 11)

                key = other_bus.id
                if key not in fault_result.voltage_depression:
                    fault_result.voltage_depression[key] = {
                        "bus_name": other_bus.props.get("name", other_bus.id),
                        "voltage_kv": v_kv,
                    }
                fault_result.voltage_depression[key][f"{mode}_pu"] = round(v_retained_pu, 4)
                fault_result.voltage_depression[key]["retained_kv"] = round(
                    v_retained_pu * v_kv, 3
                )

    # Motor reacceleration recovery for each faulted bus
    for faulted_bus_id, fault_result in results.items():
        if faulted_bus_id not in bus_idx:
            continue
        motor_data = _collect_motor_data(faulted_bus_id, all_buses, components, adjacency, base_mva)
        if motor_data:
            clearing_time = 0.1  # Default 100ms
            # Try to get from arc flash or CB data
            for nid, _, _ in adjacency.get(faulted_bus_id, []):
                comp = components.get(nid)
                if comp and comp.type == "cb":
                    lt_delay = comp.props.get("long_time_delay", 10)
                    if lt_delay <= 5:
                        clearing_time = 0.05
                    elif lt_delay <= 10:
                        clearing_time = 0.1
                    break

            fault_result.motor_recovery = _calc_motor_reacceleration(
                motor_data, bus_shunts, bus_idx, faulted_bus_id,
                all_buses, base_mva, clearing_time
            )


def _find_bus_branches(start_bus_id, all_bus_ids, components, adjacency, branches, bus_shunts, base_mva):
    """Walk from a bus to find connected buses (through transformers/cables) and sources."""
    bus_set = set(all_bus_ids)

    def walk(comp_id, z_path, visited, from_bus_id, v_kv):
        if comp_id in visited:
            return
        visited.add(comp_id)
        comp = components.get(comp_id)
        if not comp:
            return

        # Hit another bus-like node (bus or distribution board) — record branch
        if comp_id in bus_set and comp_id != from_bus_id:
            if abs(z_path) > 1e-15:
                branches.append((from_bus_id, comp_id, z_path))
            else:
                # Direct bus coupler — very low impedance
                branches.append((from_bus_id, comp_id, complex(1e-6, 1e-6)))
            return

        # Source — record as shunt on the originating bus
        if comp.type == "utility":
            z_src = _utility_impedance(comp, base_mva)
            bus_shunts[from_bus_id].append((z_src, "utility", comp))
            return
        if comp.type == "generator":
            z_src = _generator_impedance(comp, base_mva, v_kv)
            bus_shunts[from_bus_id].append((z_src, "generator", comp))
            return
        if comp.type == "solar_pv":
            z_src = _solar_pv_impedance(comp, base_mva)
            bus_shunts[from_bus_id].append((z_src, "solar_pv", comp))
            return
        if comp.type == "battery":
            z_src = _battery_impedance(comp, base_mva)
            bus_shunts[from_bus_id].append((z_src, "battery", comp))
            return
        if comp.type == "wind_turbine":
            z_src = _wind_turbine_impedance(comp, base_mva)
            bus_shunts[from_bus_id].append((z_src, "wind_turbine", comp))
            return
        if comp.type in ("motor_induction", "motor_synchronous"):
            if comp.type == "motor_induction":
                z_src = _motor_induction_impedance(comp, base_mva)
            else:
                z_src = _motor_synchronous_impedance(comp, base_mva)
            bus_shunts[from_bus_id].append((z_src, comp.type, comp))
            return
        if comp.type in ("static_load", "distribution_board"):
            # [gap #2] rotating fraction of a lumped load contributes like a
            # motor to the fault-induced voltage depression
            z_src, _mva = _static_load_motor_impedance(comp, base_mva)
            if z_src is not None:
                bus_shunts[from_bus_id].append((z_src, "motor_induction", comp))
            return

        # Accumulate impedance through branch elements, tracking the voltage
        # zone for cable per-unit conversion ([EE-12])
        z_element = complex(0, 0)
        v_next = v_kv
        if comp.type in ("transformer", "autotransformer"):
            z_element = _transformer_impedance(comp, base_mva)
            v_next = _transformer_far_voltage(comp, v_kv)
        elif comp.type == "cable":
            z_element = _cable_impedance(comp, base_mva, v_kv)
        elif comp.type in ("cb", "switch"):
            state = comp.props.get("state", "closed")
            if state == "open":
                return
        # Continue walking
        for neighbor_id, _, _ in adjacency.get(comp_id, []):
            walk(neighbor_id, z_path + z_element, visited, from_bus_id, v_next)

    visited = {start_bus_id}
    _start_comp = components.get(start_bus_id)
    _v_start = float(_start_comp.props.get("voltage_kv", 0.4 if _start_comp.type == "distribution_board" else 11) or 11) if _start_comp else 11.0
    for neighbor_id, _, _ in adjacency.get(start_bus_id, []):
        walk(neighbor_id, complex(0, 0), set(visited), start_bus_id, _v_start)


def _get_mode_impedance(z_subtransient, source_type, comp, base_mva, mode):
    """Get source impedance for the given time period (mode).

    Sub-transient: Xd'' (generators), X'' (motors)
    Transient: Xd' (generators), motors removed
    Steady-state: Xd (generators), motors removed
    """
    if source_type == "utility":
        return z_subtransient  # Utility impedance doesn't change with time

    if source_type == "solar_pv":
        return z_subtransient  # Inverter-limited, constant

    if source_type == "wind_turbine":
        t_type = comp.props.get("turbine_type", "type3_dfig") if comp else "type3_dfig"
        if t_type == "type4_frc":
            return z_subtransient  # Converter-limited, constant
        # Type 1-3: like generators/motors below

    if source_type in ("generator", "motor_synchronous", "wind_turbine"):
        if mode == "subtransient":
            return z_subtransient  # Already Xd''
        elif mode == "transient":
            # Use Xd' instead of Xd''
            xd_p = comp.props.get("xd_p", 0.25) if comp else 0.25
            xd_pp = comp.props.get("xd_pp", 0.15) if comp else 0.15
            if abs(xd_pp) > 1e-10:
                ratio = xd_p / xd_pp
                return z_subtransient * ratio
            return z_subtransient
        else:  # steadystate
            xd = comp.props.get("xd", 1.2) if comp else 1.2
            xd_pp = comp.props.get("xd_pp", 0.15) if comp else 0.15
            if abs(xd_pp) > 1e-10:
                ratio = xd / xd_pp
                return z_subtransient * ratio
            return z_subtransient

    if source_type == "motor_induction":
        if mode == "subtransient":
            return z_subtransient  # Motors contribute during sub-transient
        else:
            return None  # Motors decayed — remove from network

    return z_subtransient


def _collect_motor_data(faulted_bus_id, all_buses, components, adjacency, base_mva):
    """Collect motor data for reacceleration calculation."""
    motors = []
    for bus in all_buses:
        for nid, _, _ in adjacency.get(bus.id, []):
            comp = components.get(nid)
            if not comp:
                continue
            if comp.type == "motor_induction":
                rated_kw = comp.props.get("rated_kw", 200)
                eff = comp.props.get("efficiency", 0.93)
                pf = comp.props.get("power_factor", 0.85)
                # IEC 60909-0 §3.8: S_rM = P_rM / (η × cosφ)
                rated_mva = rated_kw / (eff * pf * 1000)
                lra_mult = comp.props.get("lra_multiplier", 6.0)
                h_constant = comp.props.get("h_constant", 0.5)  # Inertia constant (s)
                motors.append({
                    "bus_id": bus.id,
                    "comp_id": comp.id,
                    "rated_mva": rated_mva,
                    "lra_multiplier": lra_mult,
                    "h_constant": max(h_constant, 0.1),
                    "type": "induction",
                })
            elif comp.type == "motor_synchronous":
                rated_kva = comp.props.get("rated_kva", 500)
                rated_mva = rated_kva / 1000
                h_constant = comp.props.get("h_constant", 1.0)
                motors.append({
                    "bus_id": bus.id,
                    "comp_id": comp.id,
                    "rated_mva": rated_mva,
                    "lra_multiplier": comp.props.get("lra_multiplier", 5.0),
                    "h_constant": max(h_constant, 0.1),
                    "type": "synchronous",
                })
    return motors


def _calc_motor_reacceleration(motor_data, bus_shunts, bus_idx, faulted_bus_id,
                                all_buses, base_mva, clearing_time):
    """Calculate post-fault voltage recovery considering motor reacceleration.

    During fault: motors decelerate (speed drops based on H constant and voltage).
    After clearing: motors draw high reacceleration current (near LRA),
    which decays exponentially as they recover speed.

    Returns list of {t_ms, v_pu} points for 0 to 5 seconds post-clearing.
    """
    if not motor_data:
        return None

    # Total motor reacceleration current at t=0 (post-clearing)
    # I_reaccel(0) ≈ LRA × (1 - speed_remaining)
    # Speed drop during fault: Δω/ω ≈ t_fault / (2H) for voltage ≈ 0 at motor
    total_motor_mva = sum(m["rated_mva"] for m in motor_data)
    if total_motor_mva < 1e-6:
        return None

    # Calculate aggregate reacceleration current envelope
    # Motor reacceleration time constant τ ≈ 2H × V² / (T_load)
    # Simplified: τ = 2H (seconds) for full-voltage restart
    profile = []
    dt_ms = 50  # 50ms steps
    max_t_ms = 5000  # 5 seconds

    for t_ms in range(0, max_t_ms + dt_ms, dt_ms):
        t_s = t_ms / 1000.0
        total_i_reaccel_pu = 0

        for motor in motor_data:
            h = motor["h_constant"]
            lra = motor["lra_multiplier"]
            s_motor = motor["rated_mva"]

            # Speed drop during fault: Δω ≈ clearing_time / (2H)
            speed_drop = min(clearing_time / (2 * h), 0.8)  # Cap at 80% speed loss
            # Reacceleration current decays as motor regains speed
            # τ_reaccel ≈ 2H (time to recover speed)
            tau = 2 * h
            i_reaccel = lra * speed_drop * math.exp(-t_s / tau) * (s_motor / base_mva)
            total_i_reaccel_pu += i_reaccel

        # Voltage depression from reacceleration current
        # V ≈ 1.0 - Z_network × I_reaccel (simplified)
        # Use average network impedance (from bus shunts)
        # For a more accurate calc, would use Zbus diagonal at faulted bus
        # Approximate Z_network from source shunts
        z_net_pu = complex(0, 0)
        if faulted_bus_id in bus_shunts:
            shunt_y = sum(
                1.0 / z for z, st, _ in bus_shunts[faulted_bus_id]
                if st == "utility" and abs(z) > 1e-15
            )
            if abs(shunt_y) > 1e-15:
                z_net_pu = 1.0 / shunt_y

        v_drop = abs(z_net_pu) * total_i_reaccel_pu
        v_pu = max(0.0, min(1.0 - v_drop, 1.05))

        profile.append({"t_ms": t_ms, "v_pu": round(v_pu, 4)})

        # Stop early if voltage has recovered to >0.98 p.u.
        if t_ms > 500 and v_pu >= 0.98:
            # Add final point at full recovery
            profile.append({"t_ms": t_ms + dt_ms, "v_pu": 1.0})
            break

    return profile
