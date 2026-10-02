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
- Symmetrical rms current: I_sym = E/X with X from a reactance-only network
  and the fault-point X/R from SEPARATE reactance-only and resistance-only
  networks, each solved nodally (Zbus) — the standard's prescription
  ([AN1], [AN2]; this used per-path parallel combination, which double-counts
  shared impedance, and a complex R+jX reduction for X/R).
- Momentary (closing-and-latching) duty = 1.6 × I_sym at the momentary
  network (the half-cycle asymmetrical rms at X/R ≈ 25; the actual half-cycle
  rms above that, [AN6]). Compared against the breaker's rated
  closing-and-latching capability = 1.6 × K × rated short-circuit current
  (K = voltage-range factor, 1.0 for modern "preferred ratings" C37.06
  breakers).
- Interrupting duty = I_sym at the interrupting network. The standard's own
  screening rule: if duty ≤ 80% of the breaker's interrupting capability,
  or X/R ≤ 15, compare directly against 100% capability. Otherwise E/X is
  multiplied by the 'remote' (dc decrement) factor for the contact parting
  time ([AN5]) — the local curves (Figs 9/10) are always lower, so this is a
  conservative bound in place of the graphical curves.
- Breakers at or below 1 kV ([AN3]) are not C37.010 breakers: their duty is
  the first-cycle current (motors < 50 hp at 1.67 X″d), multiplied up when
  the fault X/R exceeds the breaker's test X/R (IEEE C37.13 / UL 489).

Scope: 3-phase symmetrical duty only — the calculation a breaker's ANSI
nameplate rating is expressed in. SLG/LL/LLG ANSI duty is a follow-up.

Verified against two worked examples transcribed from the standard text
(ANSI/IEEE C37.010-1979 §5, Figs 5-7 and Fig 16) —
backend/tests/test_regression.py::TestAnsiFaultDuty — and, in the 2026-10
review, against hand reductions with separate R and X networks
(backend/tests/test_fault_ansi_review_fixes.py).
"""

import math

from .fault import (
    _parallel_impedances, _transformer_far_voltage, _cable_impedance,
    _zone_scale, _transformer_rated_step, _branch_ratio, _bus_kv,
    _converter_action, _nodal_thevenin,
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
        # [AN3] Low-voltage first-cycle network (IEEE C37.13 / IEEE 551
        # practice — reviewer's reading): motors below 50 hp are NOT
        # neglected, they enter at 1.67 × X″d.
        return 1.67 if duty == "lv_first_cycle" else None
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
    # [AN-L1] |Z| = base/S_sc, split by X/R like the transformer below. This
    # took X = |Z| (R added on top), so E/X was low by √(1+(R/X)²): 0.2 % at
    # X/R 15, 5 % at X/R 3.
    z_pu = base_mva / max(fault_mva, 1e-9)
    x_pu = z_pu * xr / math.sqrt(1 + xr * xr) if xr > 0 else z_pu
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
    xr = float(comp.props.get("x_r_ratio", 10) or 10)
    from .fault import induction_motor_x_pp
    x_pp = induction_motor_x_pp(comp.props, xr)   # [N8] explicit x_pp or 1/LRC
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


def _ansi_shunt(comp, base_mva, duty):
    """ANSI source impedance of a machine/source component (None = neglected)."""
    t = comp.type
    if t == "utility":
        return _ansi_utility_z1(comp, base_mva)
    if t == "generator":
        return _ansi_generator_z1(comp, base_mva, duty)
    if t == "motor_synchronous":
        return _ansi_motor_sync_z1(comp, base_mva, duty)
    if t == "motor_induction":
        return _ansi_motor_induction_z1(comp, base_mva, duty)
    if t == "solar_pv":
        return _solar_pv_impedance(comp, base_mva)
    if t == "battery":
        return _battery_impedance(comp, base_mva)
    if t == "wind_turbine":
        return _ansi_wind_turbine_z1(comp, base_mva, duty)
    return None


_MOTOR_TYPES = ("motor_induction", "motor_synchronous")


def _build_ansi_network(net_buses, components, adjacency, base_mva, duty, energized):
    """[AN1] Bus-level network for one ANSI duty network: series branches
    between bus-like nodes (with the off-nominal ratio of transformers whose
    rated ratio differs from their buses) and source shunts at each node,
    each source shunt including the series impedance between the bus and the
    source. Structurally the positive-sequence half of fault.py's
    ``_build_bus_network``, with ANSI (uncorrected, duty-multiplied)
    machine impedances.

    This replaced a per-path parallel combination of complete source paths,
    which double-counts any impedance two paths share: a motor on the HV bus
    of a transformer feeding the faulted LV bus put the transformer in
    parallel with itself (22.2 kA against 15.7 kA on the review's 3.3 kV
    case). Shared elements are routine in radial networks, not only meshes.

    [AN4] Converters follow fault._converter_action: a diode-front-end VFD or
    a rectifier blocks, an AFE drive contributes as a medium induction motor,
    a UPS/VFD output is current-limited. The walk used to pass straight
    through every converter as a closed link.
    [AN7] Motors on a de-energized island (not reached from a real source
    through closed devices) are not running and contribute nothing.
    """
    bus_ids = [b.id for b in net_buses]
    bus_set = set(bus_ids)
    branches = []
    shunts = {bid: [] for bid in bus_ids}

    def live(cid):
        return energized is None or cid in energized

    def walk(comp_id, z_path, visited, from_bus_id, v_kv, v_ref, rho, entry_port):
        if comp_id in visited:
            return
        visited.add(comp_id)
        comp = components.get(comp_id)
        if not comp:
            return
        s = _zone_scale(v_kv, rho, v_ref)

        conv = _converter_action(comp, entry_port, base_mva, 1.0)
        if conv == "block":
            return
        if isinstance(conv, dict):
            z = conv["z"]
            if conv["is_motor"]:
                if not live(comp_id):
                    return
                # AFE drive's motor equivalent: medium induction-motor class
                z = z * {"momentary": 1.2, "interrupting": 3.0,
                         "lv_first_cycle": 1.2}[duty]
            shunts[from_bus_id].append(z_path + s * z)
            return

        if comp_id in bus_set:
            if comp_id != from_bus_id:
                z = z_path if abs(z_path) > 1e-15 else complex(1e-6, 1e-6)
                branches.append((from_bus_id, comp_id, z,
                                 _branch_ratio(_bus_kv(comp), rho, v_ref)))
            return

        t = comp.type
        z_src = _ansi_shunt(comp, base_mva, duty)
        if t in ("utility", "generator", "solar_pv", "battery", "wind_turbine") + _MOTOR_TYPES:
            if z_src is not None and (t not in _MOTOR_TYPES or live(comp_id)):
                shunts[from_bus_id].append(z_path + s * z_src)
            return
        if t == "static_load":
            z_m, _mva = _ansi_static_load_motor_z1(comp, base_mva, duty)
            if z_m is not None and live(comp_id):
                shunts[from_bus_id].append(z_path + s * z_m)
            return

        z_element = complex(0, 0)
        v_next, rho_next = v_kv, rho
        if t in ("transformer", "autotransformer"):
            u_near, u_far = _transformer_rated_step(comp, v_kv)
            z_element = _ansi_transformer_z1(comp, base_mva) * _zone_scale(u_near, rho, v_ref)
            v_next = _transformer_far_voltage(comp, v_kv)
            rho_next = rho * u_near / u_far
        elif t == "cable":
            z_element = _cable_impedance(comp, base_mva, v_kv) * s
        elif t in ("cb", "switch"):
            if comp.props.get("state", "closed") == "open":
                return
        for neighbor_id, _, remote_port in adjacency.get(comp_id, []):
            walk(neighbor_id, z_path + z_element, visited, from_bus_id, v_next, v_ref,
                 rho_next, remote_port)

    for b in net_buses:
        v_start = _bus_kv(b)
        for neighbor_id, _, remote_port in adjacency.get(b.id, []):
            walk(neighbor_id, complex(0, 0), {b.id}, b.id, v_start, v_start, 1.0, remote_port)
        # A distribution board's own rotating load fraction is a shunt at the
        # node itself.
        if b.type == "distribution_board" and live(b.id):
            z_m, _mva = _ansi_static_load_motor_z1(b, base_mva, duty)
            if z_m is not None:
                shunts[b.id].append(z_m)

    # Each chain is found from both ends — keep one discovery (fault.py rule).
    unique, kept = [], set()
    for bi, bj, z, k in branches:
        if bi < bj:
            unique.append((bi, bj, z, k))
            kept.add((bi, bj))
    for bi, bj, z, k in branches:
        if bi > bj and (bj, bi) not in kept:
            unique.append((bj, bi, z / (k * k), 1.0 / k) if k != 1.0 else (bj, bi, z, 1.0))
    return {"bus_ids": bus_ids, "branches": unique, "shunts": shunts}


_TINY = 1e-9


def _thevenin_x_r(net, bus_id):
    """[AN2] (X_th, R_th) at bus_id from SEPARATE reactance-only and
    resistance-only networks — ANSI/IEEE C37.010's prescription for the
    fault-point X/R (and the X behind E/X). Each network is solved nodally.

    A complex R + jX reduction is not the same thing: with a grid at X/R 10
    in parallel with a generator at X/R 60, the complex reduction gives
    X/R 15.0 and the separate networks 29.9 — the side of the 15 threshold
    that decides whether the breaker rating needs a multiplying factor.
    Returns (None, None) when no source reaches the bus."""
    def solve(part):
        def keep(z):
            v = z.imag if part == "x" else z.real
            v = max(v, _TINY)
            return complex(0, v) if part == "x" else complex(v, 0)
        br = [(bi, bj, keep(z), k) for bi, bj, z, k in net["branches"]]
        sh = {b: [keep(z) for z in lst] for b, lst in net["shunts"].items()}
        return _nodal_thevenin(net["bus_ids"], br, sh, bus_id)
    zx = solve("x")
    zr = solve("r")
    if zx is None or zr is None:
        return None, None
    return abs(zx.imag), abs(zr.real)


def _asym_rms_factor(xr, cycles):
    """Total rms / symmetrical rms of a fully offset current after `cycles`
    cycles at a given X/R: √(1 + 2·e^(−4π·cycles/(X/R)))."""
    if xr is None or xr <= 0:
        return 1.0
    return math.sqrt(1.0 + 2.0 * math.exp(-4.0 * math.pi * cycles / xr))


def _peak_factor(xr):
    """Peak / (√2·Isym) of a fully offset current: 1 + e^(−π/(X/R))."""
    if xr is None or xr <= 0:
        return 1.0
    return 1.0 + math.exp(-math.pi / xr)


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


# [AN5] Contact parting time (cycles) by rated interrupting time, C37.010:
# 8-cycle breaker 4, 5-cycle 3, 3-cycle 2, 2-cycle 1.5.
_DEFAULT_CONTACT_PARTING_CYCLES = 3.0


def _remote_multiplying_factor(xr, cpt_cycles):
    """[AN5] ANSI/IEEE C37.010 'remote' (dc decrement only) multiplying
    factor for E/X at X/R > 15: the fully offset total current at contact
    parting relative to the breaker's asymmetry capability, which C37.04
    bases on X/R 15. The 'local' curves (ac decrement of nearby generators)
    are always lower, so the remote factor is a conservative upper bound —
    it replaces the 'detailed E/Z method required' REVIEW status."""
    if xr is None or xr <= 15.0:
        return 1.0
    return _asym_rms_factor(xr, cpt_cycles) / _asym_rms_factor(15.0, cpt_cycles)


# [AN3] Low-voltage breakers: IEEE C37.13 (power breakers) / UL 489 (moulded
# case) test X/R, from the test power factor (reviewer's reading of IEEE 551):
# LV power breaker 15 % → 6.59; MCCB > 20 kA 20 % → 4.90, 10-20 kA 30 % →
# 3.18, ≤ 10 kA 50 % → 1.73.
def _lv_test_xr(cb_type, rated_ka):
    if cb_type == "acb":
        return 6.59
    if rated_ka > 20:
        return 4.90
    if rated_ka > 10:
        return 3.18
    return 1.73


def _lv_multiplying_factor(xr, cb_type, rated_ka):
    """[AN3] Adjustment of the first-cycle symmetrical duty when the fault
    X/R exceeds the breaker's test X/R. Both the half-cycle rms and the peak
    ratio are formed and the larger taken (the guides use one or the other by
    breaker family; taking the larger is conservative). Never below 1."""
    x_test = _lv_test_xr(cb_type, rated_ka)
    if xr is None or xr <= x_test:
        return 1.0
    mf_rms = _asym_rms_factor(xr, 0.5) / _asym_rms_factor(x_test, 0.5)
    mf_peak = _peak_factor(xr) / _peak_factor(x_test)
    return max(mf_rms, mf_peak, 1.0)


def _ansi_device_duty(project, components, bus_results):
    """Compare each CB's fault duty (at its upstream/source-side bus)
    against its rating: C37.06 / C37.010 above 1 kV, the low-voltage
    first-cycle method at or below 1 kV ([AN3])."""
    from .duty_check import _build_adjacency, _find_upstream_bus

    adj = _build_adjacency(project)
    devices = []
    for comp in project.components:
        if comp.type != "cb":
            continue
        rated_ka = float(comp.props.get("breaking_capacity_ka", 25) or 25)
        rated_max_kv = float(comp.props.get("rated_voltage_kv", 11) or 11)
        k_factor = float(comp.props.get("k_factor", 1.0) or 1.0)
        cb_type = str(comp.props.get("cb_type", "mccb") or "mccb").lower()

        upstream = _find_upstream_bus(comp.id, adj, components)
        if not upstream:
            continue
        bus_id = upstream[0]
        br = bus_results.get(bus_id)
        if not br:
            continue

        v_kv = br["voltage_kv"] or rated_max_kv
        if br.get("i_sym_lv_first_cycle_ka") is not None:
            # [AN3] LV breaker: interrupts within the first cycle, so its duty
            # is the first-cycle current (small motors included at 1.67 X″d),
            # raised by the X/R multiplying factor against its test X/R. The
            # C37.010 interrupting network (motors < 50 hp neglected, others
            # at 3.0 X″d) understated it. No separate closing-latching rating.
            mf = _lv_multiplying_factor(br["x_r_lv_first_cycle"], cb_type, rated_ka)
            duty = round(br["i_sym_lv_first_cycle_ka"] * mf, 3)
            devices.append({
                "device_id": comp.id,
                "device_name": comp.props.get("name", comp.id),
                "bus_id": bus_id,
                "method": "LV first-cycle (IEEE C37.13 / UL 489)",
                "rated_max_kv": rated_max_kv,
                "rated_interrupting_ka": rated_ka,
                "k_factor": k_factor,
                "multiplying_factor": round(mf, 3),
                "test_x_r": _lv_test_xr(cb_type, rated_ka),
                "capability_interrupting_ka": round(rated_ka, 2),
                "capability_closing_latching_ka": None,
                "duty_interrupting_ka": duty,
                "duty_closing_latching_ka": None,
                "status_interrupting": "PASS" if duty <= rated_ka else "FAIL",
                "status_closing_latching": "N/A",
                "requires_detailed_method": False,
            })
            continue

        cap_interrupting, cap_latching = _cb_capability(rated_ka, rated_max_kv, k_factor, v_kv)
        duty_sym = br["i_sym_interrupting_ka"]
        duty_latching = br["i_asym_momentary_ka"]
        xr_i = br["x_r_interrupting"]
        try:
            cpt = float(comp.props.get("contact_parting_cycles", 0) or 0)
        except (TypeError, ValueError):
            cpt = 0.0
        cpt = cpt if cpt > 0 else _DEFAULT_CONTACT_PARTING_CYCLES

        # C37.010 screen: E/X ≤ 80 % of capability, or X/R ≤ 15 → E/X
        # compared directly. Otherwise [AN5] E/X × the remote multiplying
        # factor (a conservative bound on the remote/local curves).
        mf = 1.0
        if cap_interrupting > 0 and duty_sym > 0.8 * cap_interrupting:
            mf = _remote_multiplying_factor(xr_i, cpt)
        duty_interrupting = round(duty_sym * mf, 3)
        if cap_interrupting <= 0:
            status_interrupting = "PASS"
        else:
            status_interrupting = "PASS" if duty_interrupting <= cap_interrupting else "FAIL"

        status_latching = "PASS" if duty_latching <= cap_latching else "FAIL"

        devices.append({
            "device_id": comp.id,
            "device_name": comp.props.get("name", comp.id),
            "bus_id": bus_id,
            "method": "ANSI/IEEE C37.010 (E/X)",
            "rated_max_kv": rated_max_kv,
            "rated_interrupting_ka": rated_ka,
            "k_factor": k_factor,
            "multiplying_factor": round(mf, 3),
            "contact_parting_cycles": cpt,
            "capability_interrupting_ka": round(cap_interrupting, 2),
            "capability_closing_latching_ka": round(cap_latching, 2),
            "duty_interrupting_ka": duty_interrupting,
            "duty_closing_latching_ka": duty_latching,
            "status_interrupting": status_interrupting,
            "status_closing_latching": status_latching,
            "requires_detailed_method": False,
        })
    return devices


def run_ansi_fault_analysis(project, fault_bus_id=None):
    """Run ANSI/IEEE C37.010 3-phase fault-duty analysis.

    Returns a plain dict (mirroring duty_check.py's convention):
      {"buses": {bus_id: {...}}, "devices": [...], "warnings": [...],
       "base_mva": float, "method": "ANSI/IEEE C37.010"}
    """
    from .loadflow import insert_implicit_load_buses, insert_junction_buses
    from .fault import _lines_at_study_temperature, _energized_components

    # [AN-L2] Lines at 20 °C, as the IEC maximum study: the hot library
    # resistance lowered every X/R the multiplying factors key off.
    project = _lines_at_study_temperature(project, None)
    # [AN1] Cable tees without a bus get a node, as in the IEC engine.
    project = insert_junction_buses(project)
    project = insert_implicit_load_buses(project)
    base_mva = project.baseMVA
    components = {c.id: c for c in project.components}

    adjacency = {}
    for w in project.wires:
        adjacency.setdefault(w.fromComponent, []).append((w.toComponent, w.fromPort, w.toPort))
        adjacency.setdefault(w.toComponent, []).append((w.fromComponent, w.toPort, w.fromPort))

    all_buses = [c for c in project.components
                 if c.type in ("bus", "distribution_board")
                 and str(c.props.get("system", "ac")).lower() != "dc"]
    buses = [c for c in all_buses if c.id == fault_bus_id] if fault_bus_id else all_buses

    energized = _energized_components(components, adjacency)
    nets = {d: _build_ansi_network(all_buses, components, adjacency, base_mva, d, energized)
            for d in ("momentary", "interrupting")}
    if any(_bus_kv(b) <= 1.0 for b in buses):
        nets["lv_first_cycle"] = _build_ansi_network(all_buses, components, adjacency,
                                                     base_mva, "lv_first_cycle", energized)

    warnings = []
    bus_results = {}

    for bus in buses:
        voltage_kv = _bus_kv(bus)
        i_base_ka = base_mva / (math.sqrt(3) * voltage_kv) if voltage_kv > 0 else 0.0

        def duty_of(d):
            x, r = _thevenin_x_r(nets[d], bus.id)
            if not x or bus.id not in energized:
                return 0.0, None
            return i_base_ka / x, (min(x / r, 1e4) if r and r > 0 else None)

        bus_warn = []
        i_sym_m, xr_m = duty_of("momentary")
        i_sym_i, xr_i = duty_of("interrupting")
        if i_sym_m <= 0 and i_sym_i <= 0:
            bus_warn.append("De-energized or no source reachable — no fault current."
                            if bus.id not in energized else
                            "No source reachable — no fault current path.")
        # [AN6] Closing-and-latching duty: C37.010-1979's 1.6 × E/X is the
        # half-cycle asymmetrical rms at X/R ≈ 25. Above that the real
        # half-cycle rms is larger and is used instead (√(1+2e^(−2π/(X/R)))).
        asym = max(1.6, _asym_rms_factor(xr_m, 0.5))
        i_asym_m = asym * i_sym_m

        row = {
            "bus_id": bus.id,
            "bus_name": bus.props.get("name", bus.id),
            "voltage_kv": voltage_kv,
            "i_sym_momentary_ka": round(i_sym_m, 3),
            "i_asym_momentary_ka": round(i_asym_m, 3),
            "momentary_asym_factor": round(asym, 3),
            "i_sym_interrupting_ka": round(i_sym_i, 3),
            "x_r_momentary": round(xr_m, 2) if xr_m is not None else None,
            "x_r_interrupting": round(xr_i, 2) if xr_i is not None else None,
            "i_sym_lv_first_cycle_ka": None,
            "x_r_lv_first_cycle": None,
            "warning": "; ".join(bus_warn),
        }
        if voltage_kv <= 1.0:
            i_lv, xr_lv = duty_of("lv_first_cycle")
            row["i_sym_lv_first_cycle_ka"] = round(i_lv, 3)
            row["x_r_lv_first_cycle"] = round(xr_lv, 2) if xr_lv is not None else None
        bus_results[bus.id] = row

    devices = _ansi_device_duty(project, components, bus_results)

    return {
        "buses": bus_results,
        "devices": devices,
        "warnings": warnings,
        "base_mva": base_mva,
        "method": "ANSI/IEEE C37.010",
    }
