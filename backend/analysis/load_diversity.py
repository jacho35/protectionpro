"""Load Diversity & Demand Factor Calculator.

Applies IEC demand factors to loads and computes actual maximum demand
vs. installed load per bus and per transformer. Provides:
  - Per-load installed kVA, demand factor, and maximum demand kVA
  - Per-bus aggregate: total installed, total max demand, diversity factor
  - Per-transformer loading: installed vs. demand-adjusted utilisation
  - IEC-recommended demand factors by load category
"""

import math
from ..models.schemas import ProjectData

# Transparent types that do not form a bus boundary
TRANSPARENT_TYPES = {"cb", "switch", "fuse", "ct", "pt", "surge_arrester"}

# IEC 61439 / IEC 60364 recommended demand factors by load category
IEC_DEMAND_FACTORS = {
    "lighting": {"description": "Lighting loads", "factor": 1.0},
    "heating": {"description": "Heating / air-conditioning", "factor": 1.0},
    "socket_outlets": {"description": "Socket outlets (general)", "factor": 0.4},
    "motor_single": {"description": "Single motor (largest)", "factor": 1.0},
    "motor_group_2_4": {"description": "Motor group (2-4 motors)", "factor": 0.8},
    "motor_group_5_10": {"description": "Motor group (5-10 motors)", "factor": 0.6},
    "motor_group_10_plus": {"description": "Motor group (>10 motors)", "factor": 0.5},
    "welding": {"description": "Welding equipment", "factor": 0.3},
    "lifts_cranes": {"description": "Lifts and cranes", "factor": 0.5},
    "cooking": {"description": "Cooking appliances", "factor": 0.8},
    "mixed_commercial": {"description": "Mixed commercial load", "factor": 0.7},
    "mixed_industrial": {"description": "Mixed industrial load", "factor": 0.6},
}

# Diversity factors applied at aggregation level (bus/feeder)
# Based on IEC 60439-1 Annex H / common practice
# Key: approximate number of loads, value: diversity factor
IEC_DIVERSITY_TABLE = [
    (1, 1.0),
    (2, 0.9),
    (3, 0.85),
    (4, 0.8),
    (5, 0.78),
    (6, 0.75),
    (7, 0.73),
    (8, 0.72),
    (10, 0.70),
    (15, 0.65),
    (20, 0.60),
    (30, 0.57),
    (40, 0.55),
    (50, 0.52),
]


def _interpolate_diversity(n_loads):
    """Interpolate IEC diversity factor for given number of loads."""
    if n_loads <= 1:
        return 1.0
    for i, (count, factor) in enumerate(IEC_DIVERSITY_TABLE):
        if n_loads <= count:
            if i == 0:
                return factor
            prev_count, prev_factor = IEC_DIVERSITY_TABLE[i - 1]
            ratio = (n_loads - prev_count) / (count - prev_count)
            return prev_factor - ratio * (prev_factor - factor)
    return IEC_DIVERSITY_TABLE[-1][1]


def _build_adjacency(project):
    """Build adjacency map: component_id -> [neighbor_id, ...]."""
    adj = {}
    for w in project.wires:
        adj.setdefault(w.fromComponent, []).append(w.toComponent)
        adj.setdefault(w.toComponent, []).append(w.fromComponent)
    return adj


def _find_components_at_bus(bus_id, adj, comp_map):
    """Walk through transparent devices from bus to find connected components."""
    visited = {bus_id}
    queue = list(adj.get(bus_id, []))
    found = []
    while queue:
        nid = queue.pop(0)
        if nid in visited:
            continue
        visited.add(nid)
        comp = comp_map.get(nid)
        if not comp:
            continue
        if comp.type in TRANSPARENT_TYPES and comp.props.get("state", "closed") == "closed":
            for next_id in adj.get(nid, []):
                if next_id not in visited:
                    queue.append(next_id)
        else:
            found.append(comp)
    return found


def _get_load_kva(comp):
    """Get installed apparent power (kVA) for a load component."""
    if comp.type == "static_load":
        return float(comp.props.get("rated_kva", 100))
    elif comp.type == "motor_induction":
        rated_kw = float(comp.props.get("rated_kw", 200))
        eff = float(comp.props.get("efficiency", 0.93))
        pf = float(comp.props.get("power_factor", 0.85))
        # Input kVA = kW / (efficiency × power_factor)
        return rated_kw / eff / pf if eff > 0 and pf > 0 else rated_kw
    elif comp.type == "motor_synchronous":
        return float(comp.props.get("rated_kva", 500))
    return 0


def _get_load_kw(comp):
    """Get installed real power (kW) for a load component."""
    if comp.type == "static_load":
        rated_kva = float(comp.props.get("rated_kva", 100))
        pf = float(comp.props.get("power_factor", 0.85))
        return rated_kva * pf
    elif comp.type == "motor_induction":
        return float(comp.props.get("rated_kw", 200))
    elif comp.type == "motor_synchronous":
        rated_kva = float(comp.props.get("rated_kva", 500))
        pf = float(comp.props.get("power_factor", 0.9))
        return rated_kva * pf
    return 0


def _find_transformers_for_bus(bus_id, adj, comp_map):
    """Find transformers connected to a bus (directly or through transparent elements)."""
    components = _find_components_at_bus(bus_id, adj, comp_map)
    return [c for c in components if c.type == "transformer"]


def run_load_diversity(project: ProjectData):
    """Run load diversity and demand factor analysis.

    Returns dict with 'buses', 'transformers', 'summary', and 'iec_demand_factors'.
    """
    comp_map = {c.id: c for c in project.components}
    adj = _build_adjacency(project)

    buses = [c for c in project.components if c.type == "bus"]
    load_types = {"static_load", "motor_induction", "motor_synchronous"}

    bus_results = []
    total_installed_kva = 0
    total_demand_kva = 0
    total_installed_kw = 0
    total_demand_kw = 0

    for bus in buses:
        bus_name = bus.props.get("name", bus.id)
        bus_voltage = float(bus.props.get("voltage_kv", 0))

        # Find all loads connected to this bus
        connected = _find_components_at_bus(bus.id, adj, comp_map)
        loads = [c for c in connected if c.type in load_types]

        if not loads:
            continue

        load_details = []
        bus_installed_kva = 0
        bus_demand_kva = 0
        bus_installed_kw = 0
        bus_demand_kw = 0
        n_loads = len(loads)

        for load in loads:
            load_name = load.props.get("name", load.id)
            df = float(load.props.get("demand_factor", 1.0))
            installed_kva = _get_load_kva(load)
            installed_kw = _get_load_kw(load)
            demand_kva = installed_kva * df
            demand_kw = installed_kw * df
            pf = float(load.props.get("power_factor", 0.85))

            load_details.append({
                "load_id": load.id,
                "load_name": load_name,
                "load_type": load.type,
                "installed_kva": round(installed_kva, 2),
                "installed_kw": round(installed_kw, 2),
                "demand_factor": round(df, 3),
                "demand_kva": round(demand_kva, 2),
                "demand_kw": round(demand_kw, 2),
                "power_factor": round(pf, 3),
            })

            bus_installed_kva += installed_kva
            bus_demand_kva += demand_kva
            bus_installed_kw += installed_kw
            bus_demand_kw += demand_kw

        # Apply group diversity factor at bus level
        diversity_factor = _interpolate_diversity(n_loads)
        diversified_demand_kva = bus_demand_kva * diversity_factor
        diversified_demand_kw = bus_demand_kw * diversity_factor

        # Effective demand factor for the bus
        bus_effective_df = diversified_demand_kva / bus_installed_kva if bus_installed_kva > 0 else 1.0

        # Current at bus voltage
        demand_current_a = 0
        if bus_voltage > 0:
            demand_current_a = diversified_demand_kva / (math.sqrt(3) * bus_voltage)

        total_installed_kva += bus_installed_kva
        total_demand_kva += diversified_demand_kva
        total_installed_kw += bus_installed_kw
        total_demand_kw += diversified_demand_kw

        bus_results.append({
            "bus_id": bus.id,
            "bus_name": bus_name,
            "voltage_kv": bus_voltage,
            "num_loads": n_loads,
            "loads": load_details,
            "installed_kva": round(bus_installed_kva, 2),
            "installed_kw": round(bus_installed_kw, 2),
            "demand_kva": round(bus_demand_kva, 2),
            "demand_kw": round(bus_demand_kw, 2),
            "diversity_factor": round(diversity_factor, 3),
            "diversified_demand_kva": round(diversified_demand_kva, 2),
            "diversified_demand_kw": round(diversified_demand_kw, 2),
            "effective_demand_factor": round(bus_effective_df, 3),
            "demand_current_a": round(demand_current_a, 1),
        })

    # ── Transformer loading analysis ──
    transformer_results = []
    transformers = [c for c in project.components if c.type == "transformer"]

    for xfmr in transformers:
        xfmr_name = xfmr.props.get("name", xfmr.id)
        rated_mva = float(xfmr.props.get("rated_mva", 1.0))
        rated_kva = rated_mva * 1000

        # Find buses connected to transformer secondary (load side)
        connected = _find_components_at_bus(xfmr.id, adj, comp_map)
        downstream_buses = [c for c in connected if c.type == "bus"]

        # Sum demand from all downstream buses
        xfmr_installed_kva = 0
        xfmr_demand_kva = 0
        fed_bus_names = []

        for db in downstream_buses:
            for br in bus_results:
                if br["bus_id"] == db.id:
                    xfmr_installed_kva += br["installed_kva"]
                    xfmr_demand_kva += br["diversified_demand_kva"]
                    fed_bus_names.append(br["bus_name"])
                    break

        installed_loading_pct = (xfmr_installed_kva / rated_kva * 100) if rated_kva > 0 else 0
        demand_loading_pct = (xfmr_demand_kva / rated_kva * 100) if rated_kva > 0 else 0

        # Status
        if demand_loading_pct > 100:
            status = "fail"
        elif demand_loading_pct > 80 or installed_loading_pct > 100:
            status = "warning"
        else:
            status = "pass"

        issues = []
        if demand_loading_pct > 100:
            issues.append(f"Demand-adjusted loading {demand_loading_pct:.0f}% exceeds transformer rating")
        elif installed_loading_pct > 100 and demand_loading_pct <= 100:
            issues.append(f"Installed load {installed_loading_pct:.0f}% exceeds rating, but demand-adjusted {demand_loading_pct:.0f}% is within limits")
        if demand_loading_pct > 80:
            issues.append(f"Transformer loading {demand_loading_pct:.0f}% — consider capacity margin")

        transformer_results.append({
            "transformer_id": xfmr.id,
            "transformer_name": xfmr_name,
            "rated_kva": round(rated_kva, 1),
            "fed_buses": fed_bus_names,
            "installed_kva": round(xfmr_installed_kva, 2),
            "demand_kva": round(xfmr_demand_kva, 2),
            "installed_loading_pct": round(installed_loading_pct, 1),
            "demand_loading_pct": round(demand_loading_pct, 1),
            "status": status,
            "issues": issues,
        })

    # Overall summary
    overall_df = total_demand_kva / total_installed_kva if total_installed_kva > 0 else 1.0
    summary = {
        "total_installed_kva": round(total_installed_kva, 2),
        "total_installed_kw": round(total_installed_kw, 2),
        "total_demand_kva": round(total_demand_kva, 2),
        "total_demand_kw": round(total_demand_kw, 2),
        "overall_demand_factor": round(overall_df, 3),
        "num_buses_with_loads": len(bus_results),
        "num_transformers": len(transformer_results),
    }

    return {
        "buses": bus_results,
        "transformers": transformer_results,
        "summary": summary,
        "iec_demand_factors": IEC_DEMAND_FACTORS,
    }
