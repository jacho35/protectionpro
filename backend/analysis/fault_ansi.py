"""Short-circuit fault duty per ANSI/IEEE C37.010-1979.

Alongside the IEC 60909 engine (fault.py), for US-market equipment duty
studies: is a given ANSI-rated circuit breaker (C37.06) adequately rated
for the fault duty at its location?

Method implemented — the "E/X simplified method", which is the standard's
own preferred, most-used method (both of its own worked examples use ONLY
this, never the full graphical multiplying-factor curves):

- Two reduced networks, evaluated at different times after fault inception:
  **first-cycle / momentary** (½ cycle — "closing and latching" duty) and
  **interrupting** (contact-parting time — assumed at the breaker's rated
  interrupting time). Every rotating machine contributes to both, at a
  reactance multiple of its X″d (or X′d) keyed by machine type/size —
  §5.4.1 Table (see ``_ansi_motor_induction_multiplier`` / the generator and
  synchronous-motor functions below for the exact multipliers, reproduced
  from the standard text: ANSI/IEEE C37.010-1979 §5.4.1).
- Symmetrical rms current: I_sym = E/X (reactance ONLY — resistance is
  disregarded for the current itself, a deliberate conservative
  simplification; this engine still forms a full complex R+jX nodal-style
  reduction so the local X/R ratio — needed for the 80%/15 threshold rule
  below — is exact, rather than approximated via the standard's classical
  *separate* R-network/X-network hand-reduction, itself only an
  approximation for hand calculation).
- Momentary (closing-and-latching) duty = 1.6 × I_sym at the momentary
  network. Compared against the breaker's rated closing-and-latching
  capability = 1.6 × K × rated short-circuit current (K = voltage-range
  factor, 1.0 for modern "preferred ratings" C37.06 breakers).
- Interrupting duty = I_sym at the interrupting network. The standard's own
  screening rule: if duty ≤ 80% of the breaker's interrupting capability,
  no further check is needed; if duty > 80% but system X/R ≤ 15, compare
  directly against 100% capability (still no adjustment); if duty > 80%
  AND X/R > 15, the standard requires its "more exact" E/Z method with
  AC/DC decrement curves (Figs 8-10) — genuinely graphical curves, not
  transcribed here (see BACKLOG). That combination is flagged
  ``requires_detailed_method`` rather than silently passed or failed.

Scope (v1): 3-phase symmetrical duty only — this is the calculation a
breaker's ANSI nameplate rating is actually expressed in, and the only
calculation either of the standard's own worked examples perform. SLG/LL/
LLG ANSI duty and the X/R>15-and->80% detailed E/Z method are documented
BACKLOG follow-ups. Radial/non-meshed topologies only (per-path parallel
combination) — a nodal Zbus solve for meshed ANSI networks (mirroring the
IEC engine's [PS-1] fix) is also a documented follow-up; a meshed topology
is detected and flagged rather than silently double-counting shared
impedance.

Verified against two worked examples transcribed directly from the
standard text (ANSI/IEEE C37.010-1979 §5, Figs 5-7 and Fig 16) — see
backend/tests/test_regression.py::TestAnsiFaultDuty.
"""

import math

from .fault import (
    MAX_FAULT_PATHS, MAX_FAULT_EXPANSIONS, _paths_are_meshed,
    _parallel_impedances, _transformer_far_voltage, _cable_impedance,
    _solar_pv_impedance, _battery_impedance, _wind_turbine_impedance,
)

_HP_PER_KW = 1.0 / 0.746  # 1 hp = 0.746 kW


def _ansi_hp(comp):
    """Approximate horsepower from rated_kw, for §5.4.1 size categorization."""
    return float(comp.props.get("rated_kw", 200) or 200) * _HP_PER_KW


def _ansi_motor_induction_multiplier(comp, duty):
    """Reactance multiplier (of X″d) for an induction motor, ANSI/IEEE
    C37.010-1979 §5.4.1. Returns None when the motor is neglected entirely
    (3-phase, <50 hp — the standard's own wording).

    The standard's category boundary is speed-based (>1000 hp at <=1800 rpm
    vs >250 hp at 3600 rpm) — classified here by POLE COUNT (2-pole ~ the
    3600 rpm/60 Hz class; 4-pole+ ~ the <=1800 rpm class) so classification
    is frequency-agnostic (50/60 Hz). The component's own default
    ``poles`` (0, meaning unset) is treated as the more common 4-pole+
    class.
    """
    hp = _ansi_hp(comp)
    if hp < 50.0:
        return None
    poles = float(comp.props.get("poles", 0) or 0)
    is_2pole = abs(poles - 2.0) < 0.5
    large_threshold = 250.0 if is_2pole else 1000.0
    if hp > large_threshold:
        return 1.5 if duty == "interrupting" else 1.0
    return 3.0 if duty == "interrupting" else 1.2


def _ansi_utility_z1(comp, base_mva):
    """Utility source — E/X method: no ANSI-specific correction factor (the
    standard's E/X method has no analogue of IEC 60909's voltage factor c)."""
    fault_mva = float(comp.props.get("fault_mva", 500) or 500)
    xr = float(comp.props.get("x_r_ratio", 15) or 15)
    x_pu = base_mva / max(fault_mva, 1e-9)
    r_pu = x_pu / xr if xr > 0 else 0.0
    return complex(r_pu, x_pu)


def _ansi_generator_z1(comp, base_mva, duty):
    """Synchronous generator / condenser — §5.4.1: all turbo-generators,
    hydro-generators WITH amortisseur windings, and all condensers use
    1.0 x X''d for BOTH duty networks (this is assumed for every generator
    here; the standard's separate 0.75 x X'd rule for hydro-generators
    WITHOUT amortisseur windings is a documented, rarer-case follow-up —
    see BACKLOG). No IEC-style impedance correction factor is applied."""
    rated_mva = float(comp.props.get("rated_mva", 10) or 10)
    xd_pp = float(comp.props.get("xd_pp", 0.15) or 0.15)
    xr = float(comp.props.get("x_r_ratio", 40) or 40)
    x_pu = xd_pp * base_mva / max(rated_mva, 1e-9)
    r_pu = x_pu / xr if xr > 0 else 0.0
    return complex(r_pu, x_pu)


def _ansi_motor_sync_z1(comp, base_mva, duty):
    """Synchronous motor — §5.4.1: 1.0 x X''d momentary, 1.5 x X''d
    interrupting."""
    rated_mva = float(comp.props.get("rated_kva", 500) or 500) / 1000.0
    xd_pp = float(comp.props.get("xd_pp", 0.15) or 0.15)
    xr = float(comp.props.get("x_r_ratio", 40) or 40)
    mult = 1.5 if duty == "interrupting" else 1.0
    x_pu = mult * xd_pp * base_mva / max(rated_mva, 1e-9)
    r_pu = x_pu / xr if xr > 0 else 0.0
    return complex(r_pu, x_pu)


def _ansi_motor_induction_z1(comp, base_mva, duty):
    """Induction motor — §5.4.1 size-category multiplier (see
    ``_ansi_motor_induction_multiplier``). Returns None when neglected."""
    mult = _ansi_motor_induction_multiplier(comp, duty)
    if mult is None:
        return None
    rated_kw = float(comp.props.get("rated_kw", 200) or 200)
    eff = float(comp.props.get("efficiency", 0.93) or 0.93)
    pf = float(comp.props.get("power_factor", 0.85) or 0.85)
    rated_mva = rated_kw / max(eff * pf * 1000.0, 1e-9)
    x_pp = float(comp.props.get("x_pp", 0.17) or 0.17)
    xr = float(comp.props.get("x_r_ratio", 10) or 10)
    x_pu = mult * x_pp * base_mva / max(rated_mva, 1e-9)
    r_pu = x_pu / xr if xr > 0 else 0.0
    return complex(r_pu, x_pu)


def _ansi_static_load_motor_z1(comp, base_mva, duty):
    """Motor-equivalent fraction of a lumped/static load — treated as one
    aggregate "medium" induction-motor group (3.0/1.2 x X''d) since it
    represents an unclassified mix rather than one sized machine. Mirrors
    fault.py's ``_static_load_motor_impedance`` X'' derivation
    (X'' ~= 1/LRC on the motor's own base)."""
    mf = float(comp.props.get("motor_fraction", 0) or 0)
    if mf <= 0:
        return None, 0.0
    mf = min(mf, 1.0)
    rated_kva = float(comp.props.get("rated_kva", 0) or 0)
    motor_mva = rated_kva / 1000.0 * mf
    if motor_mva <= 1e-9:
        return None, 0.0
    lrc = float(comp.props.get("motor_lrc_ratio", 6) or 6)
    x_pp = 1.0 / max(lrc, 1e-3)
    xr = float(comp.props.get("x_r_ratio", 10) or 10)
    mult = 3.0 if duty == "interrupting" else 1.2
    x_pu = mult * x_pp * base_mva / motor_mva
    r_pu = x_pu / xr if xr > 0 else 0.0
    return complex(r_pu, x_pu), motor_mva


def _ansi_wind_turbine_z1(comp, base_mva, duty):
    """Wind turbine generator — not covered by the (1979) standard. Type 4
    (full-converter) is current-limited like solar/battery (constant Z,
    reused as-is); type 1-3 (induction/DFIG) are treated like a "large"
    rotating machine (1.5/1.0 x X''d) as the closest physical analogue —
    a documented simplification, see BACKLOG."""
    turbine_type = comp.props.get("turbine_type", "type3_dfig")
    if turbine_type == "type4_frc":
        return _wind_turbine_impedance(comp, base_mva)
    rated_mva = (float(comp.props.get("rated_mva", 2.0) or 2.0)
                 * float(comp.props.get("num_turbines", 1) or 1))
    xd_pp = float(comp.props.get("xd_pp", 0.20) or 0.20)
    xr = float(comp.props.get("x_r_ratio", 30) or 30)
    mult = 1.5 if duty == "interrupting" else 1.0
    x_pu = mult * xd_pp * base_mva / max(rated_mva, 1e-9)
    r_pu = x_pu / xr if xr > 0 else 0.0
    return complex(r_pu, x_pu)


def _ansi_transformer_z1(comp, base_mva):
    """Transformer — nameplate %Z converted to system base, R/X split via
    x_r_ratio. No IEC-style impedance correction factor."""
    rated_mva = float(comp.props.get("rated_mva", 10) or 10)
    z_pct = float(comp.props.get("z_percent", 8) or 8)
    xr = float(comp.props.get("x_r_ratio", 10) or 10)
    z_pu = (z_pct / 100.0) * base_mva / max(rated_mva, 1e-9)
    x_pu = z_pu * xr / math.sqrt(1 + xr * xr)
    r_pu = x_pu / xr if xr > 0 else 0.0
    return complex(r_pu, x_pu)


def _collect_ansi_source_paths(bus_id, components, adjacency, base_mva, duty, meta=None):
    """Walk the network from a bus, collecting source paths for the given
    duty network ("momentary" or "interrupting"). Structurally mirrors
    fault.py's ``_collect_source_paths`` (same traversal/cycle-prevention
    rules), but with ANSI (uncorrected, duty-scaled) per-component
    impedances and 3-phase (positive-sequence) only.
    """
    paths = []
    expansions = [0]

    def walk(comp_id, z_path, trail, path_visited, v_kv):
        if len(paths) >= MAX_FAULT_PATHS or expansions[0] >= MAX_FAULT_EXPANSIONS:
            return
        expansions[0] += 1
        if comp_id in path_visited:
            return
        path_visited = path_visited | {comp_id}
        comp = components.get(comp_id)
        if not comp:
            return

        t = comp.type
        if t == "utility":
            z_src = _ansi_utility_z1(comp, base_mva)
            paths.append({"z_total": z_path + z_src, "trail": trail + [comp_id],
                          "source_id": comp_id, "source_type": t})
            return
        if t == "generator":
            z_src = _ansi_generator_z1(comp, base_mva, duty)
            paths.append({"z_total": z_path + z_src, "trail": trail + [comp_id],
                          "source_id": comp_id, "source_type": t})
            return
        if t == "motor_synchronous":
            z_src = _ansi_motor_sync_z1(comp, base_mva, duty)
            paths.append({"z_total": z_path + z_src, "trail": trail + [comp_id],
                          "source_id": comp_id, "source_type": t})
            return
        if t == "motor_induction":
            z_src = _ansi_motor_induction_z1(comp, base_mva, duty)
            if z_src is not None:
                paths.append({"z_total": z_path + z_src, "trail": trail + [comp_id],
                              "source_id": comp_id, "source_type": t})
            return
        if t == "solar_pv":
            z_src = _solar_pv_impedance(comp, base_mva)
            paths.append({"z_total": z_path + z_src, "trail": trail + [comp_id],
                          "source_id": comp_id, "source_type": t})
            return
        if t == "battery":
            z_src = _battery_impedance(comp, base_mva)
            paths.append({"z_total": z_path + z_src, "trail": trail + [comp_id],
                          "source_id": comp_id, "source_type": t})
            return
        if t == "wind_turbine":
            z_src = _ansi_wind_turbine_z1(comp, base_mva, duty)
            paths.append({"z_total": z_path + z_src, "trail": trail + [comp_id],
                          "source_id": comp_id, "source_type": t})
            return
        if t in ("static_load", "distribution_board"):
            z_src, _mva = _ansi_static_load_motor_z1(comp, base_mva, duty)
            if z_src is not None:
                paths.append({"z_total": z_path + z_src, "trail": trail + [comp_id],
                              "source_id": comp_id, "source_type": "motor_induction"})
            if t == "static_load":
                return
            # distribution_board also passes fault current through (in->out)

        z_element = complex(0, 0)
        v_next = v_kv
        if t == "bus":
            v_next = float(comp.props.get("voltage_kv", v_kv) or v_kv)
        elif t in ("transformer", "autotransformer"):
            z_element = _ansi_transformer_z1(comp, base_mva)
            v_next = _transformer_far_voltage(comp, v_kv)
        elif t == "cable":
            z_element = _cable_impedance(comp, base_mva, v_kv)
        elif t in ("cb", "switch"):
            if comp.props.get("state", "closed") == "open":
                return
        elif t == "fuse":
            pass

        for neighbor_id, _, _ in adjacency.get(comp_id, []):
            if neighbor_id != bus_id or comp_id == bus_id:
                walk(neighbor_id, z_path + z_element, trail + [comp_id], path_visited, v_next)

    bus_comp = components.get(bus_id)
    v_start = float(bus_comp.props.get("voltage_kv", 0.4 if bus_comp.type == "distribution_board" else 11) or 11) if bus_comp else 11.0
    for neighbor_id, _, _ in adjacency.get(bus_id, []):
        walk(neighbor_id, complex(0, 0), [], {bus_id}, v_start)

    if len(paths) >= MAX_FAULT_PATHS or expansions[0] >= MAX_FAULT_EXPANSIONS:
        if meta is not None:
            meta["truncated"] = True
    return paths


def _duty_from_paths(paths, i_base_ka):
    """(z_eq, I_sym_ka, X/R) from a set of source paths — I_sym = E/X per
    the standard's E/X method (E = 1.0 pu, reactance only; X/R from the
    engine's own full complex reduction, exact rather than the standard's
    classical separate-R/X-network approximation)."""
    if not paths:
        return complex(0, 1e9), 0.0, None
    z_eq = _parallel_impedances([p["z_total"] for p in paths])
    x_th, r_th = z_eq.imag, z_eq.real
    i_sym_ka = i_base_ka / x_th if x_th > 1e-12 else 0.0
    xr = (x_th / r_th) if r_th > 1e-12 else None
    return z_eq, i_sym_ka, xr


def _cb_capability(rated_ka, rated_max_kv, k_factor, v_kv):
    """(interrupting capability kA, closing-and-latching capability kA) for
    a C37.06 breaker at operating voltage v_kv. K=1.0 (modern "preferred
    ratings" breakers) makes the interrupting capability flat at
    rated_ka for any v_kv <= rated_max_kv; K>1 (older total-current-basis
    breakers) caps the 1/V scale-up at K x rated_ka."""
    if v_kv > 1e-9:
        cap_interrupting = min(rated_ka * rated_max_kv / v_kv, k_factor * rated_ka)
    else:
        cap_interrupting = k_factor * rated_ka
    cap_latching = 1.6 * k_factor * rated_ka
    return cap_interrupting, cap_latching


def _ansi_device_duty(project, components, bus_results):
    """Compare each CB's fault duty (at its upstream/source-side bus)
    against its C37.06 rated capability."""
    from .duty_check import _build_adjacency, _find_upstream_bus

    adj = _build_adjacency(project)
    devices = []
    for comp in project.components:
        if comp.type != "cb":
            continue
        rated_ka = float(comp.props.get("breaking_capacity_ka", 25) or 25)
        rated_max_kv = float(comp.props.get("rated_voltage_kv", 11) or 11)
        k_factor = float(comp.props.get("k_factor", 1.0) or 1.0)

        upstream = _find_upstream_bus(comp.id, adj, components)
        if not upstream:
            continue
        bus_id = upstream[0]
        br = bus_results.get(bus_id)
        if not br:
            continue

        v_kv = br["voltage_kv"] or rated_max_kv
        cap_interrupting, cap_latching = _cb_capability(rated_ka, rated_max_kv, k_factor, v_kv)
        duty_interrupting = br["i_sym_interrupting_ka"]
        duty_latching = br["i_asym_momentary_ka"]
        xr_i = br["x_r_interrupting"]

        requires_detailed = False
        if cap_interrupting <= 0:
            status_interrupting = "PASS"
        elif duty_interrupting <= 0.8 * cap_interrupting:
            status_interrupting = "PASS"
        elif xr_i is None or xr_i <= 15:
            status_interrupting = "PASS" if duty_interrupting <= cap_interrupting else "FAIL"
        else:
            requires_detailed = True
            status_interrupting = ("REVIEW — X/R > 15 and > 80% of rated capability: "
                                   "ANSI/IEEE C37.010 detailed E/Z method required "
                                   "(not implemented; see BACKLOG)")

        status_latching = "PASS" if duty_latching <= cap_latching else "FAIL"

        devices.append({
            "device_id": comp.id,
            "device_name": comp.props.get("name", comp.id),
            "bus_id": bus_id,
            "rated_max_kv": rated_max_kv,
            "rated_interrupting_ka": rated_ka,
            "k_factor": k_factor,
            "capability_interrupting_ka": round(cap_interrupting, 2),
            "capability_closing_latching_ka": round(cap_latching, 2),
            "duty_interrupting_ka": duty_interrupting,
            "duty_closing_latching_ka": duty_latching,
            "status_interrupting": status_interrupting,
            "status_closing_latching": status_latching,
            "requires_detailed_method": requires_detailed,
        })
    return devices


def run_ansi_fault_analysis(project, fault_bus_id=None):
    """Run ANSI/IEEE C37.010 3-phase fault-duty analysis.

    Returns a plain dict (mirroring duty_check.py's convention):
      {"buses": {bus_id: {...}}, "devices": [...], "warnings": [...],
       "base_mva": float, "method": "ANSI/IEEE C37.010"}
    """
    from .loadflow import insert_implicit_load_buses

    project = insert_implicit_load_buses(project)
    base_mva = project.baseMVA
    components = {c.id: c for c in project.components}

    adjacency = {}
    for w in project.wires:
        adjacency.setdefault(w.fromComponent, []).append((w.toComponent, w.fromPort, w.toPort))
        adjacency.setdefault(w.toComponent, []).append((w.fromComponent, w.toPort, w.fromPort))

    buses = [c for c in project.components
             if c.type in ("bus", "distribution_board")
             and str(c.props.get("system", "ac")).lower() != "dc"]
    if fault_bus_id:
        buses = [c for c in buses if c.id == fault_bus_id]

    warnings = []
    bus_results = {}

    for bus in buses:
        voltage_kv = float(bus.props.get("voltage_kv", 0.4 if bus.type == "distribution_board" else 11) or 11)
        i_base_ka = base_mva / (math.sqrt(3) * voltage_kv) if voltage_kv > 0 else 0.0

        meta_m, meta_i = {}, {}
        paths_m = _collect_ansi_source_paths(bus.id, components, adjacency, base_mva, "momentary", meta_m)
        paths_i = _collect_ansi_source_paths(bus.id, components, adjacency, base_mva, "interrupting", meta_i)

        bus_warn = []
        if not paths_m and not paths_i:
            bus_warn.append("No source reachable — no fault current path.")
        else:
            if meta_m.get("truncated") or meta_i.get("truncated"):
                bus_warn.append("Source-path enumeration truncated (heavily meshed network).")
            if _paths_are_meshed(paths_i, components) or _paths_are_meshed(paths_m, components):
                bus_warn.append(
                    "Meshed/parallel-path topology detected — this engine uses per-path "
                    "parallel combination only (no nodal Zbus solve, unlike the IEC 60909 "
                    "engine); shared upstream impedance may be double-counted. Treat this "
                    "bus's duty currents as approximate — see BACKLOG.")

        z_m, i_sym_m, xr_m = _duty_from_paths(paths_m, i_base_ka)
        z_i, i_sym_i, xr_i = _duty_from_paths(paths_i, i_base_ka)
        i_asym_m = 1.6 * i_sym_m

        bus_results[bus.id] = {
            "bus_id": bus.id,
            "bus_name": bus.props.get("name", bus.id),
            "voltage_kv": voltage_kv,
            "i_sym_momentary_ka": round(i_sym_m, 3),
            "i_asym_momentary_ka": round(i_asym_m, 3),
            "i_sym_interrupting_ka": round(i_sym_i, 3),
            "x_r_momentary": round(xr_m, 2) if xr_m is not None else None,
            "x_r_interrupting": round(xr_i, 2) if xr_i is not None else None,
            "warning": "; ".join(bus_warn),
        }

    devices = _ansi_device_duty(project, components, bus_results)

    return {
        "buses": bus_results,
        "devices": devices,
        "warnings": warnings,
        "base_mva": base_mva,
        "method": "ANSI/IEEE C37.010",
    }
