"""IEC 60909 Symmetrical Short-Circuit Current Calculation.

Implements initial symmetrical short-circuit current (I"k) for:
- Three-phase fault
- Single line-to-ground (SLG) fault
- Line-to-line (LL) fault

Per-unit method on a common MVA base.
"""

import math
import numpy as np
from ..models.schemas import ProjectData, FaultResults, FaultResultBus


def run_fault_analysis(project: ProjectData) -> FaultResults:
    """Run IEC 60909 fault analysis on all buses."""
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

    # Identify buses
    buses = [c for c in project.components if c.type == "bus"]

    # For each bus, compute equivalent impedance seen from that bus
    results = {}
    for bus in buses:
        voltage_kv = bus.props.get("voltage_kv", 11)
        i_base = base_mva * 1000 / (math.sqrt(3) * voltage_kv)  # kA

        # Collect all source impedances connected to this bus
        z_sources = _collect_source_impedances(bus.id, components, adjacency, base_mva)

        if not z_sources:
            # No sources connected — infinite impedance (no fault current)
            results[bus.id] = FaultResultBus(
                bus_id=bus.id,
                bus_name=bus.props.get("name", bus.id),
                voltage_kv=voltage_kv,
                ik3=0, ik1=0, ikLL=0
            )
            continue

        # Parallel combination of all source impedances
        z_eq = _parallel_impedances(z_sources)

        # Three-phase fault: I"k3 = c * V_n / (sqrt(3) * |Z_eq|)
        # IEC 60909 voltage factor c = 1.1 for MV/HV, 1.05 for LV
        c_factor = 1.05 if voltage_kv < 1.0 else 1.1
        ik3_pu = c_factor / abs(z_eq) if abs(z_eq) > 1e-10 else 0
        ik3_ka = ik3_pu * i_base

        # SLG fault: I"k1 = 3 * c * V_n / (sqrt(3) * |Z1 + Z2 + Z0|)
        # Simplified: assume Z1 = Z2 = Z_eq, Z0 = 3*Z_eq (conservative)
        z0 = z_eq * 3  # Conservative zero-sequence estimate
        z_slg = z_eq + z_eq + z0  # Z1 + Z2 + Z0
        ik1_pu = 3 * c_factor / abs(z_slg) if abs(z_slg) > 1e-10 else 0
        ik1_ka = ik1_pu * i_base

        # Line-to-line fault: I"kLL = c * V_n / |Z1 + Z2|
        # Z1 = Z2 = Z_eq
        z_ll = z_eq + z_eq
        ikLL_pu = c_factor * math.sqrt(3) / abs(z_ll) if abs(z_ll) > 1e-10 else 0
        ikLL_ka = ikLL_pu * i_base

        results[bus.id] = FaultResultBus(
            bus_id=bus.id,
            bus_name=bus.props.get("name", bus.id),
            voltage_kv=voltage_kv,
            ik3=round(ik3_ka, 3),
            ik1=round(ik1_ka, 3),
            ikLL=round(ikLL_ka, 3),
        )

    return FaultResults(
        buses=results,
        base_mva=base_mva,
        method="IEC 60909 (symmetrical)"
    )


def _collect_source_impedances(bus_id, components, adjacency, base_mva):
    """Walk the network from a bus and collect source impedances in per-unit."""
    visited = set()
    z_sources = []

    def walk(comp_id, z_path):
        if comp_id in visited:
            return
        visited.add(comp_id)
        comp = components.get(comp_id)
        if not comp:
            return

        # If we hit a source, record total impedance
        if comp.type == "utility":
            z_src = _utility_impedance(comp, base_mva)
            z_sources.append(z_path + z_src)
            return
        if comp.type == "generator":
            z_src = _generator_impedance(comp, base_mva)
            z_sources.append(z_path + z_src)
            return

        # Accumulate impedance through branch elements
        z_element = complex(0, 0)
        if comp.type == "transformer":
            z_element = _transformer_impedance(comp, base_mva)
        elif comp.type == "cable":
            z_element = _cable_impedance(comp, base_mva)
        elif comp.type in ("cb", "switch"):
            # Treat closed CB/switch as zero impedance
            state = comp.props.get("state", "closed")
            if state == "open":
                return  # Open device blocks fault current
        elif comp.type == "fuse":
            pass  # Zero impedance for fault calc

        # Continue walking
        for neighbor_id, _, _ in adjacency.get(comp_id, []):
            if neighbor_id != bus_id or comp_id == bus_id:
                walk(neighbor_id, z_path + z_element)

    # Start from bus's neighbors
    for neighbor_id, _, _ in adjacency.get(bus_id, []):
        walk(neighbor_id, complex(0, 0))

    return z_sources


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
    """Transformer per-unit impedance."""
    rated_mva = comp.props.get("rated_mva", 10)
    z_pct = comp.props.get("z_percent", 8)
    xr = comp.props.get("x_r_ratio", 10)
    z_pu = (z_pct / 100) * base_mva / rated_mva
    x_pu = z_pu * xr / math.sqrt(1 + xr * xr)
    r_pu = x_pu / xr
    return complex(r_pu, x_pu)


def _cable_impedance(comp, base_mva):
    """Cable per-unit impedance."""
    v_kv = comp.props.get("voltage_kv", 11)
    z_base = (v_kv ** 2) / base_mva
    r = comp.props.get("r_per_km", 0.1) * comp.props.get("length_km", 1)
    x = comp.props.get("x_per_km", 0.08) * comp.props.get("length_km", 1)
    return complex(r / z_base, x / z_base)


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
