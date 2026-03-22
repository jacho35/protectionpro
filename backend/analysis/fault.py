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
import numpy as np
from ..models.schemas import ProjectData, FaultResults, FaultResultBus, FaultBranchContribution


def run_fault_analysis(project: ProjectData, fault_bus_id: str = None, fault_type: str = None) -> FaultResults:
    """Run IEC 60909 fault analysis.

    Args:
        project: The project data.
        fault_bus_id: If set, only compute fault on this bus.
        fault_type: "3phase", "slg", "ll", "llg", or None for all types.
    """
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
    buses = [c for c in project.components if c.type == "bus"]
    if fault_bus_id:
        buses = [c for c in buses if c.id == fault_bus_id]

    # For each bus, compute equivalent impedance seen from that bus
    results = {}
    for bus in buses:
        voltage_kv = bus.props.get("voltage_kv", 11)
        i_base_ka = base_mva / (math.sqrt(3) * voltage_kv)  # kA

        # Collect all source paths with component trail
        source_paths = _collect_source_paths(bus.id, components, adjacency, base_mva)

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

        # Parallel combination of all source impedances
        z_eq = _parallel_impedances(z_sources)
        # Negative-sequence equivalent impedance (may differ from Z1 for generators/motors)
        z2_eq = _parallel_impedances(z2_sources)

        # IEC 60909 voltage factor c = 1.1 for MV/HV, 1.05 for LV
        c_factor = 1.05 if voltage_kv < 1.0 else 1.1

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
            z0_source_tuples = _collect_zero_seq_impedances(bus.id, components, adjacency, base_mva)
            if z0_source_tuples:
                z0_impedances = [t[0] for t in z0_source_tuples]
                z0_detail = [t[1] for t in z0_source_tuples]
                z0 = _parallel_impedances(z0_impedances)
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

        branches = _compute_branch_contributions(
            source_paths, z_eq, c_factor, i_base_ka, ik_total_ka, components, active_type
        )

        # Motor contribution summary (3-phase current split)
        motor_count = len(motor_paths)
        ik3_motor = None
        ik3_network = None
        if motor_count > 0 and ik3_ka and ik3_ka > 0:
            # Sum motor contributions via current divider: I_motor = c / |Z_motor_path|
            motor_pu = sum(
                c_factor / abs(p["z_total"]) for p in motor_paths if abs(p["z_total"]) > 1e-15
            )
            network_pu = sum(
                c_factor / abs(p["z_total"]) for p in network_paths if abs(p["z_total"]) > 1e-15
            )
            ik3_motor = round(motor_pu * i_base_ka, 3)
            ik3_network = round(network_pu * i_base_ka, 3)

        # IEC 60909 time-varying fault currents (3-phase)
        ip_ka, kappa = _compute_peak_current(ik3_ka, z_eq)
        ib_ka = _compute_breaking_current(ik3_ka, source_paths, c_factor, i_base_ka, base_mva)
        ik_steady_ka = _compute_steady_state_current(source_paths, c_factor, i_base_ka, base_mva, voltage_kv)

        # Asymmetric breaking current: Ib_asym = √(Ib² + (2fτ × ip × e^(-t/τ))²)
        # Simplified per IEC 60909-0 §9.1.3: use DC component at t_min
        ib_asym_ka = None
        if ib_ka and ip_ka and kappa:
            # DC decay time constant τ ≈ X/(2πfR), approximate from R/X
            r_x = abs(z_eq.real / z_eq.imag) if abs(z_eq.imag) > 1e-15 else 1.0
            freq = 50  # Hz — could use project.frequency
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
            z0_source_count=len(z0_detail) if z0_detail else None,
            z0_sources_detail=z0_detail if z0_detail else None,
            motor_count=motor_count,
            ik3_motor=ik3_motor,
            ik3_network=ik3_network,
            ip=ip_ka,
            kappa=kappa,
            ib=ib_ka,
            ib_asymmetric=ib_asym_ka,
            ik_steady=ik_steady_ka,
            branches=branches,
        )

    # ── Voltage Depression Calculation (IEC 60909 §3.6) ──
    # Build Zbus matrix for all buses and compute retained voltage at each bus
    # during a fault at each faulted bus: V_j = 1 - Z_jk / Z_kk
    all_buses = [c for c in project.components if c.type == "bus"]
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


def _collect_source_paths(bus_id, components, adjacency, base_mva):
    """Walk the network from a bus and collect source paths with component trails."""
    visited = set()
    paths = []

    def walk(comp_id, z_path, trail):
        if comp_id in visited:
            return
        visited.add(comp_id)
        comp = components.get(comp_id)
        if not comp:
            return

        # If we hit a source, record the complete path
        if comp.type == "utility":
            z_src = _utility_impedance(comp, base_mva)
            # Negative sequence: Z2 = Z1 * z2_z1_ratio (default 1.0)
            # Also accept legacy "x2_ratio" key for backwards compatibility
            z2_z1 = float(comp.props.get("z2_z1_ratio", 0) or comp.props.get("x2_ratio", 0))
            z2_src = z_src * z2_z1 if z2_z1 > 0 else z_src
            paths.append({
                "z_total": z_path + z_src,
                "z2_total": z_path + z2_src,
                "trail": trail + [comp_id],
                "source_id": comp_id,
                "source_type": "utility",
            })
            return
        if comp.type == "generator":
            z_src = _generator_impedance(comp, base_mva)
            rated_mva = comp.props.get("rated_mva", 10)
            # Negative sequence: use x2 prop if > 0, else Z2 = Z1
            x2_val = float(comp.props.get("x2", 0))
            if x2_val > 0:
                xr = comp.props.get("x_r_ratio", 40)
                x2_pu = x2_val * base_mva / rated_mva
                r2_pu = x2_pu / xr
                z2_src = complex(r2_pu, x2_pu)
            else:
                z2_src = z_src
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
            # Negative sequence: use x2 if > 0, else Z2 = Z1
            # Also accept legacy "x2_pu" key for backwards compatibility
            x2_val = float(comp.props.get("x2", 0) or comp.props.get("x2_pu", 0))
            if x2_val > 0:
                rated_mva = rated_kw / (eff * 1000)
                xr = comp.props.get("x_r_ratio", 10)
                x2_pu = x2_val * base_mva / rated_mva
                r2_pu = x2_pu / xr
                z2_src = complex(r2_pu, x2_pu)
            else:
                z2_src = z_src
            paths.append({
                "z_total": z_path + z_src,
                "z2_total": z_path + z2_src,
                "trail": trail + [comp_id],
                "source_id": comp_id,
                "source_type": "motor_induction",
                "is_motor": True,
                "rated_mva": rated_kw / (eff * 1000),
            })
            return
        if comp.type == "motor_synchronous":
            z_src = _motor_synchronous_impedance(comp, base_mva)
            rated_kva = comp.props.get("rated_kva", 500)
            # Negative sequence: use x2 if > 0, else Z2 = Z1
            # Also accept legacy "x2_pu" key for backwards compatibility
            x2_val = float(comp.props.get("x2", 0) or comp.props.get("x2_pu", 0))
            if x2_val > 0:
                rated_mva = rated_kva / 1000
                xr = comp.props.get("x_r_ratio", 40)
                x2_pu = x2_val * base_mva / rated_mva
                r2_pu = x2_pu / xr
                z2_src = complex(r2_pu, x2_pu)
            else:
                z2_src = z_src
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

        # Accumulate impedance through branch elements
        z_element = complex(0, 0)
        if comp.type == "transformer":
            z_element = _transformer_impedance(comp, base_mva)
        elif comp.type == "cable":
            z_element = _cable_impedance(comp, base_mva)
        elif comp.type in ("cb", "switch"):
            state = comp.props.get("state", "closed")
            if state == "open":
                return  # Open device blocks fault current
        elif comp.type == "fuse":
            pass  # Zero impedance for fault calc

        # Continue walking
        for neighbor_id, _, _ in adjacency.get(comp_id, []):
            if neighbor_id != bus_id or comp_id == bus_id:
                walk(neighbor_id, z_path + z_element, trail + [comp_id])

    # Start from bus's neighbors
    for neighbor_id, _, _ in adjacency.get(bus_id, []):
        walk(neighbor_id, complex(0, 0), [])

    return paths


def _compute_branch_contributions(source_paths, z_eq, c_factor, i_base_ka, ik_total_ka, components, fault_type):
    """Compute fault current contribution through each branch element.

    Uses current divider: I_path = V_fault / Z_path
    where V_fault = c (in p.u.), so I_path_pu = c / |Z_path|
    """
    if not source_paths or ik_total_ka < 1e-10:
        return []

    # For each path, compute the current it carries
    path_currents = []
    for path in source_paths:
        z_path = path["z_total"]
        if abs(z_path) > 1e-15:
            if fault_type in ("ll", "llg"):
                i_path_pu = c_factor * math.sqrt(3) / abs(z_path)
            else:
                i_path_pu = c_factor / abs(z_path)
            i_path_ka = i_path_pu * i_base_ka
        else:
            i_path_ka = 0
        path_currents.append(i_path_ka)

    # Aggregate current per branch element across all paths
    # Element may appear in multiple paths — sum contributions
    element_current = {}  # element_id -> total current in kA
    element_z_path = {}   # element_id -> z_path of first path containing it (for display)
    element_source = {}   # element_id -> source names

    for i, path in enumerate(source_paths):
        trail = path["trail"]
        i_ka = path_currents[i]
        source_id = path["source_id"]
        source_comp = components.get(source_id)
        source_name = source_comp.props.get("name", source_id) if source_comp else source_id

        for elem_id in trail:
            if elem_id not in element_current:
                element_current[elem_id] = 0
                element_z_path[elem_id] = path["z_total"]
                element_source[elem_id] = set()
            element_current[elem_id] += i_ka
            element_source[elem_id].add(source_name)

    # Build branch contribution objects
    branches = []
    for elem_id, ik_ka in element_current.items():
        comp = components.get(elem_id)
        if not comp:
            continue
        # Skip sources and buses from branch display — they aren't "branches"
        if comp.type in ("bus",):
            continue

        z_path = element_z_path[elem_id]
        contribution_pct = (ik_ka / ik_total_ka * 100) if ik_total_ka > 1e-10 else 0

        branches.append(FaultBranchContribution(
            element_id=elem_id,
            element_name=comp.props.get("name", elem_id),
            element_type=comp.type,
            ik_ka=round(ik_ka, 3),
            z_path_real=round(z_path.real, 6),
            z_path_imag=round(z_path.imag, 6),
            z_path_mag=round(abs(z_path), 6),
            contribution_pct=round(contribution_pct, 1),
            source_name=", ".join(sorted(element_source[elem_id])),
        ))

    # Sort by current descending
    branches.sort(key=lambda b: b.ik_ka, reverse=True)
    return branches


def _utility_impedance(comp, base_mva):
    """Utility source per-unit impedance."""
    fault_mva = comp.props.get("fault_mva", 500)
    xr = comp.props.get("x_r_ratio", 15)
    z_pu = base_mva / fault_mva
    x_pu = z_pu * xr / math.sqrt(1 + xr * xr)
    r_pu = x_pu / xr
    return complex(r_pu, x_pu)


def _generator_impedance(comp, base_mva):
    """Generator sub-transient impedance in per-unit."""
    rated_mva = comp.props.get("rated_mva", 10)
    xd_pp = comp.props.get("xd_pp", 0.15)
    xr = comp.props.get("x_r_ratio", 40)
    x_pu = xd_pp * base_mva / rated_mva
    r_pu = x_pu / xr
    return complex(r_pu, x_pu)


def _transformer_impedance(comp, base_mva):
    """Transformer per-unit impedance with IEC 60909 correction factor K_T.

    K_T = 0.95 × c_max / (1 + 0.6 × x_T)  per IEC 60909-0 §6.3.3
    where x_T is the transformer reactance p.u. on its own rating.
    """
    rated_mva = comp.props.get("rated_mva", 10)
    z_pct = comp.props.get("z_percent", 8)
    xr = comp.props.get("x_r_ratio", 10)
    voltage_hv_kv = comp.props.get("voltage_hv_kv", 33)

    # Uncorrected impedance on system base
    z_pu = (z_pct / 100) * base_mva / rated_mva
    x_pu = z_pu * xr / math.sqrt(1 + xr * xr)
    r_pu = x_pu / xr

    # IEC 60909 impedance correction factor K_T
    # x_T is reactance p.u. on transformer's own rating
    x_t = (z_pct / 100) * xr / math.sqrt(1 + xr * xr)
    c_max = 1.05 if voltage_hv_kv < 1.0 else 1.1
    k_t = 0.95 * c_max / (1 + 0.6 * x_t)

    return complex(r_pu * k_t, x_pu * k_t)


def _cable_impedance(comp, base_mva):
    """Cable per-unit impedance (accounts for parallel cables)."""
    v_kv = comp.props.get("voltage_kv", 11)
    z_base = (v_kv ** 2) / base_mva
    r = comp.props.get("r_per_km", 0.1) * comp.props.get("length_km", 1)
    x = comp.props.get("x_per_km", 0.08) * comp.props.get("length_km", 1)
    n = max(1, int(comp.props.get("num_parallel", 1)))
    return complex(r / z_base, x / z_base) / n


def _motor_induction_impedance(comp, base_mva):
    """Induction motor sub-transient impedance per IEC 60909-0 §13.

    Uses X" (locked-rotor reactance) on motor base, converted to system base.
    Motor MVA = rated_kW / efficiency.
    """
    rated_kw = comp.props.get("rated_kw", 200)
    efficiency = comp.props.get("efficiency", 0.93)
    x_pp = comp.props.get("x_pp", 0.17)  # Sub-transient reactance p.u. on motor base
    xr = comp.props.get("x_r_ratio", 10)

    rated_mva = rated_kw / (efficiency * 1000)  # Input MVA
    x_pu = x_pp * base_mva / rated_mva
    r_pu = x_pu / xr
    return complex(r_pu, x_pu)


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


def _collect_zero_seq_impedances(bus_id, components, adjacency, base_mva):
    """Collect zero-sequence impedances from sources feeding a bus.

    Zero-sequence current can only flow through grounded transformer windings.
    The zero-sequence impedance depends on vector group and grounding method.
    The winding facing the fault bus must provide a zero-sequence path — a
    delta winding on the bus side blocks zero-sequence regardless of the
    other winding's grounding.

    Returns a list of (z0_impedance, detail_string) tuples.
    """
    visited = set()
    z0_sources = []  # list of (complex, str)

    def _comp_name(comp):
        return comp.props.get("name", comp.id) if comp else "?"

    def walk(comp_id, z0_path, trail, entry_port=None):
        if comp_id in visited:
            return
        visited.add(comp_id)
        comp = components.get(comp_id)
        if not comp:
            return

        if comp.type == "utility":
            z_src = _utility_impedance(comp, base_mva)
            # Use z0_z1_ratio to derive Z0 from Z1, with legacy "x0_ratio" fallback
            z0_z1 = float(comp.props.get("z0_z1_ratio", 0) or comp.props.get("x0_ratio", 0))
            z0_src = z_src * z0_z1 * 3 if z0_z1 > 0 else z_src * 3
            z_total = z0_path + z0_src
            desc = " → ".join(trail + [f"Utility '{_comp_name(comp)}' (Z0_src={abs(z0_src):.4f})"])
            z0_sources.append((z_total, desc))
            return

        if comp.type == "generator":
            z_src = _generator_impedance(comp, base_mva)
            x0_val = float(comp.props.get("x0", 0))
            if x0_val > 0:
                rated_mva = comp.props.get("rated_mva", 10)
                xr = comp.props.get("x_r_ratio", 40)
                x0_pu = x0_val * base_mva / rated_mva
                r0_pu = x0_pu / xr
                z0_src = complex(r0_pu, x0_pu) * 3
            else:
                z0_src = z_src * 3
            z_total = z0_path + z0_src
            desc = " → ".join(trail + [f"Generator '{_comp_name(comp)}' (Z0_src={abs(z0_src):.4f})"])
            z0_sources.append((z_total, desc))
            return

        if comp.type == "solar_pv":
            z_src = _solar_pv_impedance(comp, base_mva)
            z_total = z0_path + z_src * 3
            desc = " → ".join(trail + [f"Solar PV '{_comp_name(comp)}' (Z0_src={abs(z_src * 3):.4f})"])
            z0_sources.append((z_total, desc))
            return

        if comp.type == "wind_turbine":
            z_src = _wind_turbine_impedance(comp, base_mva)
            z_total = z0_path + z_src * 3
            desc = " → ".join(trail + [f"Wind Turbine '{_comp_name(comp)}' (Z0_src={abs(z_src * 3):.4f})"])
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
            xfmr_label = f"Xfmr '{name}' ({vg}, Z0={abs(z0_element):.4f})"
            if far_side == 'delta':
                # Delta/zigzag on far side provides Z0 circulation —
                # transformer itself is a Z0 source (e.g. Dyn11 from yn side).
                z_total = z0_path + z0_element
                desc = " → ".join(trail + [xfmr_label + " [Δ provides Z0 return]"])
                z0_sources.append((z_total, desc))
            elif far_side == 'grounded':
                # Grounded star on far side — Z0 passes through,
                # continue walking to find source (e.g. YNyn0).
                new_trail = trail + [xfmr_label + " [YN pass-through]"]
                for neighbor_id, local_port, _ in adjacency.get(comp_id, []):
                    if neighbor_id != bus_id or comp_id == bus_id:
                        walk(neighbor_id, z0_path + z0_element, new_trail, None)
            # else far_side == 'blocked': ungrounded star, no Z0 path
            return

        if comp.type == "cable":
            r0_per_km = float(comp.props.get("r0_per_km", 0))
            x0_per_km = float(comp.props.get("x0_per_km", 0))
            if r0_per_km > 0 or x0_per_km > 0:
                v_kv = comp.props.get("voltage_kv", 11)
                z_base = (v_kv ** 2) / base_mva
                length = comp.props.get("length_km", 1)
                n_par = max(1, int(comp.props.get("num_parallel", 1)))
                r0 = (r0_per_km if r0_per_km > 0 else comp.props.get("r_per_km", 0.1) * 3.5) * length
                x0 = (x0_per_km if x0_per_km > 0 else comp.props.get("x_per_km", 0.08) * 3.5) * length
                z_cable = complex(r0 / z_base, x0 / z_base) / n_par
            else:
                z_cable = _cable_impedance(comp, base_mva) * 3
            new_trail = trail + [f"Cable '{_comp_name(comp)}' (Z0={abs(z_cable):.4f})"]
            for neighbor_id, _, _ in adjacency.get(comp_id, []):
                walk(neighbor_id, z0_path + z_cable, new_trail)
            return

        if comp.type in ("cb", "switch"):
            state = comp.props.get("state", "closed")
            if state == "open":
                return
        # Transparent elements (CB, fuse, bus, etc.)
        for neighbor_id, _, remote_port in adjacency.get(comp_id, []):
            if neighbor_id != bus_id or comp_id == bus_id:
                walk(neighbor_id, z0_path, trail, remote_port)

    for neighbor_id, _, remote_port in adjacency.get(bus_id, []):
        walk(neighbor_id, complex(0, 0), [], remote_port)

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

    hv_grounded = vg.upper().startswith("YN") or vg.upper().startswith("ZN")
    hv_delta = vg[0].upper() == 'D'
    hv_is_delta_or_zigzag = vg[0].upper() in ('D', 'Z')
    lv_grounded = lv_part.lower().startswith("yn") or lv_part.lower().startswith("zn")
    lv_delta = lv_part.lower().startswith("d")
    lv_is_delta_or_zigzag = len(lv_part) > 0 and lv_part[0].lower() in ('d', 'z')

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
    # - Ungrounded star: no Z0 circulation or pass-through — blocked.
    if far_delta_or_zigzag:
        far_side = 'delta'
    elif far_grounded:
        far_side = 'grounded'
    else:
        far_side = 'blocked'

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

    # 3*Zn appears in the zero-sequence circuit
    return z_gnd * 3, far_side


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


# ─── IEC 60909 Time-Varying Fault Currents ───────────────────────────────────


def _compute_kappa(r_over_x):
    """Compute peak factor κ per IEC 60909-0 §8.1, Eq. (55).

    κ = 1.02 + 0.98 × e^(−3 × R/X)
    Range: 1.02 (pure R) to 2.0 (pure X).
    """
    return 1.02 + 0.98 * math.exp(-3 * r_over_x)


def _compute_peak_current(ik3_ka, z_eq):
    """Compute peak short-circuit current ip per IEC 60909-0 §8.1.

    ip = κ × √2 × I"k3

    The R/X ratio is derived from the equivalent impedance Z_eq.
    For meshed networks, use Method C (§8.1, Eq. 56):
    R/X = R_eq / X_eq from the complex impedance at the fault point.

    Returns (ip_ka, kappa).
    """
    if ik3_ka is None or ik3_ka < 1e-10 or abs(z_eq) < 1e-15:
        return None, None

    r = z_eq.real
    x = z_eq.imag
    r_over_x = abs(r / x) if abs(x) > 1e-15 else 10.0  # High R/X → low κ
    kappa = _compute_kappa(r_over_x)
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
            rated_mva = path.get("rated_mva", 10)
            i_rg_ka = rated_mva / (math.sqrt(3) * 1)  # in p.u. terms
            # I"kG / I_rG ratio — use per-unit on generator base
            xd_pp = path.get("xd_pp", 0.15)
            ik_over_ir = c_factor / xd_pp  # ≈ 1.1/0.15 ≈ 7.3 typical
            mu = _mu_factor(ik_over_ir, t_min)
            ib_total += mu * ik_path_ka

        elif source_type == "motor_synchronous":
            # Synchronous motors: same μ formula as generators
            xd_pp = path.get("xd_pp", 0.15)
            ik_over_ir = c_factor / xd_pp
            mu = _mu_factor(ik_over_ir, t_min)
            ib_total += mu * ik_path_ka

        elif source_type == "motor_induction":
            # Induction motors: current decays rapidly
            # Per IEC 60909-0 §13.2, use μ × q factor
            rated_mva = path.get("rated_mva", 0.2)
            # For LV motors, per-unit ratio based on locked-rotor
            ik_over_ir = ik_path_pu * base_mva / rated_mva if rated_mva > 1e-6 else 6
            mu = _mu_factor(ik_over_ir, t_min)
            q = _q_factor(ik_over_ir, t_min)
            ib_total += mu * q * ik_path_ka

        elif source_type == "solar_pv":
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
                xd_pp = path.get("xd_pp", 0.20)
                ik_over_ir = c_factor / xd_pp if xd_pp > 1e-6 else 5
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

    # Deduplicate branches (each found from both sides)
    seen_branches = set()
    unique_branches = []
    for bi, bj, z in branches:
        key = tuple(sorted([bi, bj]))
        if key not in seen_branches:
            seen_branches.add(key)
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

            c_factor = 1.05 if bus_voltage.get(faulted_bus_id, 11) < 1.0 else 1.1

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

    def walk(comp_id, z_path, visited, from_bus_id):
        if comp_id in visited:
            return
        visited.add(comp_id)
        comp = components.get(comp_id)
        if not comp:
            return

        # Hit another bus — record branch
        if comp.type == "bus" and comp_id in bus_set and comp_id != from_bus_id:
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
            z_src = _generator_impedance(comp, base_mva)
            bus_shunts[from_bus_id].append((z_src, "generator", comp))
            return
        if comp.type == "solar_pv":
            z_src = _solar_pv_impedance(comp, base_mva)
            bus_shunts[from_bus_id].append((z_src, "solar_pv", comp))
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

        # Accumulate impedance through branch elements
        z_element = complex(0, 0)
        if comp.type == "transformer":
            z_element = _transformer_impedance(comp, base_mva)
        elif comp.type == "cable":
            z_element = _cable_impedance(comp, base_mva)
        elif comp.type in ("cb", "switch"):
            state = comp.props.get("state", "closed")
            if state == "open":
                return
        # Continue walking
        for neighbor_id, _, _ in adjacency.get(comp_id, []):
            walk(neighbor_id, z_path + z_element, visited, from_bus_id)

    visited = {start_bus_id}
    for neighbor_id, _, _ in adjacency.get(start_bus_id, []):
        walk(neighbor_id, complex(0, 0), set(visited), start_bus_id)


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
                rated_mva = rated_kw / (eff * 1000)
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
