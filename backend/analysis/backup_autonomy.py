"""Backup supply adequacy & battery autonomy study.

Simulates a grid outage: every utility source is removed from the network,
the remaining components are grouped into electrical islands (traversal is
blocked by OPEN breakers/switches, exactly like the load flow's source
walk), and each island's load is checked against the backup capability of
its hybrid PV inverters and BESS units:

  1. inverter capacity — island load (kVA) must fit within the summed
     inverter ratings of the backup sources (a hybrid inverter's backup
     output is limited by its rating regardless of battery size);
  2. discharge power — island load (kW) must be coverable by the summed
     battery discharge limits, reported both without PV ("night") and with
     the PV output available at the modelled irradiance;
  3. autonomy — usable battery energy (SoC above the DoD reserve floor,
     derated by one-way conversion efficiency √η_rt) divided by the net
     island load, again with and without the PV contribution. When PV
     alone covers the load the with-PV autonomy is unbounded and reported
     as null with a note.

Loads flagged essential='no' (default 'yes') are assumed shed by the
changeover during the outage: they are excluded from every check and from
the autonomy denominator, and reported per island as shed_kw.

This is a snapshot adequacy calculation, not a time-series simulation:
state of charge and irradiance are taken as modelled. Islands that carry
load but contain no battery-backed source are reported as unbacked.
"""

import math

from ..models.schemas import ProjectData
from .loadflow import _battery_params, _source_output_mva

# Traversal is blocked by these when open; everything else conducts
_SWITCHING_TYPES = ("cb", "switch")


def _island_map(project):
    """Union of connected components over the wire graph with all utility
    sources removed and open switching devices blocking. Returns
    {component_id: island_number} for every non-utility component."""
    components = {c.id: c for c in project.components}
    adjacency = {}
    for w in project.wires:
        adjacency.setdefault(w.fromComponent, []).append(w.toComponent)
        adjacency.setdefault(w.toComponent, []).append(w.fromComponent)

    def blocked(cid):
        comp = components.get(cid)
        if comp is None:
            return True
        if comp.type == "utility":
            return True   # grid outage: the utility is gone
        if (comp.type in _SWITCHING_TYPES
                and comp.props.get("state", "closed") == "open"):
            return True
        return False

    island_of = {}
    n_islands = 0
    for comp in project.components:
        if comp.type == "utility" or comp.id in island_of or blocked(comp.id):
            continue
        n_islands += 1
        queue = [comp.id]
        island_of[comp.id] = n_islands
        while queue:
            cid = queue.pop()
            for nb in adjacency.get(cid, []):
                if nb in island_of or blocked(nb):
                    continue
                island_of[nb] = n_islands
                queue.append(nb)
    return island_of


def _load_kw_kvar(comp):
    """Demand P (kW) and Q (kvar) using the load flow's conventions."""
    p = comp.props
    if comp.type in ("static_load", "distribution_board"):
        s_kva = float(p.get("rated_kva", 100) or 0) * float(p.get("demand_factor", 1.0) or 1.0)
        pf = float(p.get("power_factor", 0.85) or 0.85)
    elif comp.type == "motor_induction":
        rated_kw = float(p.get("rated_kw", 200) or 0)
        eff = float(p.get("efficiency", 0.93) or 0.93)
        pf = float(p.get("power_factor", 0.85) or 0.85)
        df = float(p.get("demand_factor", 1.0) or 1.0)
        s_kva = (rated_kw / (eff * pf) if pf > 0 else rated_kw / eff) * df
    elif comp.type == "motor_synchronous":
        s_kva = float(p.get("rated_kva", 500) or 0) * float(p.get("demand_factor", 1.0) or 1.0)
        pf = float(p.get("power_factor", 0.9) or 0.9)
    else:
        return 0.0, 0.0
    pf = min(1.0, max(0.0, abs(pf)))
    return s_kva * pf, s_kva * math.sqrt(max(0.0, 1 - pf * pf))


def run_backup_autonomy(project: ProjectData) -> dict:
    island_of = _island_map(project)
    islands = {}
    for comp in project.components:
        isl = island_of.get(comp.id)
        if isl is None:
            continue
        islands.setdefault(isl, []).append(comp)

    results = []
    for isl in sorted(islands):
        comps = islands[isl]
        buses = [c for c in comps if c.type == "bus" and str(c.props.get("system", "ac")).lower() != "dc"]

        # Only ESSENTIAL loads ride through the outage — a changeover is
        # assumed to shed anything flagged essential='no' (default 'yes')
        load_kw = load_kvar = shed_kw = 0.0
        for c in comps:
            pkw, qkvar = _load_kw_kvar(c)
            if str(c.props.get("essential", "yes")).lower() == "no":
                shed_kw += pkw
                continue
            load_kw += pkw
            load_kvar += qkvar
        load_kva = math.hypot(load_kw, load_kvar)

        # Backup sources: battery-backed inverters (BESS + hybrid solar_pv)
        sources = []
        inverter_kva = discharge_kw = energy_kwh_eff = pv_kw = 0.0
        for c in comps:
            if c.type not in ("battery", "solar_pv"):
                continue
            if c.type == "solar_pv" and str(c.props.get("inverter_type", "")) != "hybrid":
                # Grid-tied PV: contributes energy while the sun is up but
                # cannot form the island — counted only if a battery-backed
                # source exists (handled below via has_backup)
                pv_kw += _source_output_mva(c)[0] * 1000
                continue
            bp = _battery_params(c)
            if not bp:
                continue
            if c.type == "battery":
                inv_kva = float(c.props.get("rated_kva", 100) or 0)
                unit_pv = 0.0
            else:
                _p, _q, s_now, rated_full = _source_output_mva(c)
                inv_kva = rated_full * 1000
                unit_pv = min(s_now, rated_full) * 1000
                pv_kw += unit_pv
            dis_kw = bp["max_discharge_mw"] * 1000
            eta_1way = math.sqrt(min(1.0, max(0.0, float(
                c.props.get("battery_rt_eff", 0.95) or 0.95))))
            e_eff = bp["available_kwh"] * eta_1way
            inverter_kva += inv_kva
            discharge_kw += dis_kw
            energy_kwh_eff += e_eff
            sources.append({
                "id": c.id,
                "name": str(c.props.get("name", c.type)),
                "type": "hybrid_pv" if c.type == "solar_pv" else "bess",
                "inverter_kva": round(inv_kva, 2),
                "max_discharge_kw": round(dis_kw, 2),
                "available_kwh": round(bp["available_kwh"], 2),
                "pv_kw_now": round(unit_pv, 2),
                "soc_pct": float(c.props.get("battery_soc_pct", 100) or 100),
            })

        has_backup = len(sources) > 0
        if load_kva < 1e-6 and shed_kw < 1e-6 and not has_backup:
            continue   # nothing to report (e.g. an isolated instrument)

        notes = []
        if shed_kw > 1e-6:
            notes.append(f"{shed_kw:.1f} kW of non-essential load excluded "
                         "(assumed shed by the changeover).")
        if not has_backup:
            results.append({
                "island": isl,
                "bus_names": [str(b.props.get("name", b.id)) for b in buses],
                "load_kw": round(load_kw, 2),
                "load_kva": round(load_kva, 2),
                "shed_kw": round(shed_kw, 2),
                "backed_up": False,
                "sources": [],
                "notes": (["No battery-backed source — island is dark during "
                           "a grid outage."] + notes),
            })
            continue

        # 1. Inverter capacity check (kVA)
        inverter_ok = load_kva <= inverter_kva + 1e-9
        # 2. Discharge power checks (kW), night and with PV
        supply_night_kw = min(discharge_kw, inverter_kva)
        supply_pv_kw = min(discharge_kw + pv_kw, inverter_kva)
        power_ok_night = load_kw <= supply_night_kw + 1e-9
        power_ok_pv = load_kw <= supply_pv_kw + 1e-9
        # 3. Autonomy (h)
        autonomy_night_h = (energy_kwh_eff / load_kw) if load_kw > 1e-9 else None
        net_kw_pv = load_kw - min(pv_kw, load_kw)
        if load_kw <= 1e-9:
            autonomy_pv_h = None
        elif net_kw_pv <= 1e-9:
            autonomy_pv_h = None
            notes.append("PV output covers the island load — autonomy is "
                         "unbounded while the modelled irradiance holds.")
        else:
            autonomy_pv_h = energy_kwh_eff / net_kw_pv

        if not inverter_ok:
            notes.append(
                f"Island load {load_kva:.1f} kVA exceeds the backup inverter "
                f"capacity {inverter_kva:.1f} kVA — shed non-essential load or "
                "add inverter capacity.")
        if not power_ok_night:
            notes.append(
                f"Night load {load_kw:.1f} kW exceeds the battery discharge "
                f"limit {supply_night_kw:.1f} kW.")

        results.append({
            "island": isl,
            "bus_names": [str(b.props.get("name", b.id)) for b in buses],
            "load_kw": round(load_kw, 2),
            "load_kva": round(load_kva, 2),
            "shed_kw": round(shed_kw, 2),
            "backed_up": True,
            "inverter_kva": round(inverter_kva, 2),
            "discharge_kw": round(discharge_kw, 2),
            "pv_kw_available": round(pv_kw, 2),
            "usable_kwh": round(energy_kwh_eff, 2),
            "inverter_ok": inverter_ok,
            "power_ok_night": power_ok_night,
            "power_ok_pv": power_ok_pv,
            "autonomy_night_h": round(autonomy_night_h, 2) if autonomy_night_h is not None else None,
            "autonomy_pv_h": round(autonomy_pv_h, 2) if autonomy_pv_h is not None else None,
            "sources": sources,
            "notes": notes,
        })

    backed = [r for r in results if r.get("backed_up")]
    return {
        "islands": results,
        "summary": {
            "islands_total": len(results),
            "islands_backed": len(backed),
            "islands_adequate": len([r for r in backed
                                     if r["inverter_ok"] and r["power_ok_night"]]),
        },
    }
