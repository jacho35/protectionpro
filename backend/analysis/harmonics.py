"""Harmonic analysis — frequency-domain current-injection penetration study.

Non-linear loads (chiefly Variable Frequency Drives) are modelled as
**harmonic current sources**: at each characteristic harmonic order ``h`` the
drive injects a current ``I_h = (I_h/I_1) · I_1`` into its bus. The network is
re-solved at each harmonic frequency (all reactances scaled by ``h``) with a
nodal admittance solve ``Y_h · V_h = I_h`` to obtain the harmonic voltage that
appears on every bus. From the harmonic voltage spectrum we report:

  * per-bus voltage total harmonic distortion (THD_V) and individual harmonic
    distortion (IHD),
  * point-of-common-coupling (PCC) current THD / total demand distortion (TDD),
  * IEEE 519-2014 compliance verdicts (voltage + current limits).

Modelling choices (documented so results are defensible):
  * VFD current spectra are typical manufacturer values keyed by rectifier
    pulse number and input-reactor size (see ``VFD_SPECTRA``). Multi-pulse
    rectifiers cancel the lower characteristic harmonics (12-pulse cancels
    5th/7th, 18-pulse the 11th/13th, …); an active front end (AFE) is a
    low-distortion PWM rectifier.
  * Sources (utility, generator) and rotating machines are shunt
    sub-transient / short-circuit impedances to ground, reactance scaled by h.
  * Capacitor banks are shunt susceptances scaled by h — the usual driver of
    parallel resonance.
  * Static loads use the parallel R–L ("CIGRÉ type-2") model, providing
    frequency-dependent damping.
  * Multiple harmonic sources of the same order are summed in phase (no
    diversity) — the conservative screening assumption.
  * Transformer/line series impedance uses the leakage reactance without the
    off-nominal tap ratio (standard harmonic-penetration simplification).

This module reuses the load-flow topology walkers so the harmonic network
matches the fundamental network the user drew.
"""

from __future__ import annotations

import math
import numpy as np

from . import loadflow as _lf


# ── VFD characteristic-harmonic current spectra (I_h / I_1, per-unit) ─────────
# Typical values for line-commutated (diode) drives, keyed by the amount of
# series AC line reactor / DC-link choke. THD of each set is in brackets.
_SPECTRA_6P_NO_REACTOR = {5: 0.65, 7: 0.48, 11: 0.14, 13: 0.09,
                          17: 0.057, 19: 0.045, 23: 0.037, 25: 0.033}   # ITHD ~84%
_SPECTRA_6P_3PCT = {5: 0.35, 7: 0.12, 11: 0.075, 13: 0.05,
                    17: 0.031, 19: 0.025, 23: 0.020, 25: 0.018}          # ITHD ~39%
_SPECTRA_6P_5PCT = {5: 0.28, 7: 0.093, 11: 0.063, 13: 0.041,
                    17: 0.026, 19: 0.021, 23: 0.017, 25: 0.015}          # ITHD ~31%
# 12-pulse: 5th/7th (and 17th/19th) ideally cancel; small residual left in.
_SPECTRA_12P = {5: 0.026, 7: 0.016, 11: 0.083, 13: 0.053,
                23: 0.022, 25: 0.017}                                    # ITHD ~11%
# 18-pulse: 11th/13th cancel too — dominant pair is 17/19.
_SPECTRA_18P = {11: 0.023, 13: 0.015, 17: 0.036, 19: 0.028,
                35: 0.010, 37: 0.009}                                    # ITHD ~6%
# 24-pulse: dominant pair 23/25.
_SPECTRA_24P = {17: 0.012, 19: 0.010, 23: 0.026, 25: 0.020,
                47: 0.007, 49: 0.006}                                    # ITHD ~4%
# Active front end (PWM rectifier): low broadband low-order distortion.
_SPECTRA_AFE = {5: 0.020, 7: 0.015, 11: 0.030, 13: 0.025, 17: 0.010, 19: 0.008}


def vfd_current_spectrum(comp) -> dict[int, float]:
    """Return {harmonic order: I_h/I_1} for a VFD component."""
    p = comp.props or {}
    if str(p.get("front_end", "diode")).lower() == "afe":
        return dict(_SPECTRA_AFE)
    pulses = int(p.get("pulse_number", 6) or 6)
    if pulses >= 24:
        return dict(_SPECTRA_24P)
    if pulses >= 18:
        return dict(_SPECTRA_18P)
    if pulses >= 12:
        return dict(_SPECTRA_12P)
    # 6-pulse — pick the reactor bracket
    reactor = float(p.get("input_reactor_pct", 3) or 0)
    if reactor <= 0.5:
        return dict(_SPECTRA_6P_NO_REACTOR)
    if reactor < 4:
        return dict(_SPECTRA_6P_3PCT)
    return dict(_SPECTRA_6P_5PCT)


# ── IEEE 519-2014 limits ──────────────────────────────────────────────────────
def _voltage_limits(v_kv: float) -> tuple[float, float]:
    """(individual harmonic %, total THD %) voltage limits by bus voltage
    (IEEE 519-2014 Table 1)."""
    if v_kv <= 1.0:
        return 5.0, 8.0
    if v_kv <= 69.0:
        return 3.0, 5.0
    if v_kv <= 161.0:
        return 1.5, 2.5
    return 1.0, 1.5


# [H1][H5] IEEE 519-2014 Tables 2, 3 and 4 — maximum harmonic current
# distortion in % of I_L. Each row: (Isc/IL upper bound, individual ODD-order
# limits for the bands 3≤h<11, 11≤h<17, 17≤h<23, 23≤h<35, 35≤h≤50, TDD).
# Even orders are limited to 25 % of the odd limit of their band (note b).
# Table 4 (> 161 kV) has its own rows at 25 / 50 — it is not a scaled Table 2.
_INF = float("inf")
_IEEE519_T2 = ((20, (4.0, 2.0, 1.5, 0.6, 0.3), 5.0),          # 120 V – 69 kV
               (50, (7.0, 3.5, 2.5, 1.0, 0.5), 8.0),
               (100, (10.0, 4.5, 4.0, 1.5, 0.7), 12.0),
               (1000, (12.0, 5.5, 5.0, 2.0, 1.0), 15.0),
               (_INF, (15.0, 7.0, 6.0, 2.5, 1.4), 20.0))
_IEEE519_T3 = ((20, (2.0, 1.0, 0.75, 0.3, 0.15), 2.5),        # 69 – 161 kV
               (50, (3.5, 1.75, 1.25, 0.5, 0.25), 4.0),
               (100, (5.0, 2.25, 2.0, 0.75, 0.35), 6.0),
               (1000, (6.0, 2.75, 2.5, 1.0, 0.5), 7.5),
               (_INF, (7.5, 3.5, 3.0, 1.25, 0.7), 10.0))
_IEEE519_T4 = ((25, (1.0, 0.5, 0.38, 0.15, 0.1), 1.5),        # > 161 kV
               (50, (2.0, 1.0, 0.75, 0.3, 0.15), 2.5),
               (_INF, (3.0, 1.5, 1.15, 0.45, 0.22), 3.75))


def _ieee519_current_row(isc_il: float, v_kv: float):
    table = (_IEEE519_T2 if v_kv <= 69.0 else
             _IEEE519_T3 if v_kv <= 161.0 else _IEEE519_T4)
    for bound, individual, tdd in table:
        if isc_il < bound:
            return individual, tdd
    return table[-1][1], table[-1][2]


def _tdd_limit(isc_il: float, v_kv: float) -> float:
    """Total demand distortion (current) limit % at the PCC — IEEE 519-2014
    Table 2 (≤ 69 kV), Table 3 (69–161 kV) or Table 4 (> 161 kV)."""
    return _ieee519_current_row(isc_il, v_kv)[1]


def _current_limit(h: int, isc_il: float, v_kv: float) -> float | None:
    """[H1] Individual harmonic current limit (% of I_L) at order h; even
    orders 25 % of the odd limit. None above h = 50 (outside the tables)."""
    if h > 50:
        return None
    individual = _ieee519_current_row(isc_il, v_kv)[0]
    band = 0 if h < 11 else 1 if h < 17 else 2 if h < 23 else 3 if h < 35 else 4
    lim = individual[band]
    return lim * 0.25 if h % 2 == 0 else lim


# ── IEC voltage limits ────────────────────────────────────────────────────────
# Offered as the alternative basis (study setting harmonicsLimits = "iec").
#   LV (≤ 1 kV): IEC 61000-2-4 Class 2 compatibility levels (the same values
#     as IEC 61000-2-2 for public LV networks) — Table 2 / 3 / 4, THD 8 %.
#   MV (1–35 kV) and HV-EHV (> 35 kV): IEC 61000-3-6:2008 Table 2 indicative
#     planning levels, THD 6.5 % (MV) / 3 % (HV-EHV).
# No licensed IEC 61000 copy was available to the 2026-09-29 review; these
# are the published values as the reviewer read them (HARMONICS_REVIEW.md).
def _iec_ihd_limit(h: int, v_kv: float) -> float:
    if v_kv <= 1.0:                                   # IEC 61000-2-4 Class 2
        if h % 2 == 0:
            return {2: 2.0, 4: 1.0, 6: 0.5, 8: 0.5}.get(h, 0.25 * 10 / h + 0.25)
        if h % 3 == 0:
            return {3: 5.0, 9: 1.5, 15: 0.4, 21: 0.3}.get(h, 0.2)
        return {5: 6.0, 7: 5.0, 11: 3.5, 13: 3.0}.get(h, 2.27 * 17 / h - 0.27)
    if v_kv <= 35.0:                                  # IEC 61000-3-6 MV
        if h % 2 == 0:
            return {2: 1.8, 4: 1.0, 6: 0.5}.get(h, 0.25 * 10 / h + 0.22)
        if h % 3 == 0:
            return {3: 4.0, 9: 1.2, 15: 0.3, 21: 0.2}.get(h, 0.2)
        return {5: 5.0, 7: 4.0, 11: 3.0, 13: 2.5}.get(h, 1.9 * 17 / h - 0.2)
    if h % 2 == 0:                                    # IEC 61000-3-6 HV-EHV
        return {2: 1.4, 4: 0.8, 6: 0.4}.get(h, 0.19 * 10 / h + 0.16)
    if h % 3 == 0:
        return {3: 2.0, 9: 1.0, 15: 0.3, 21: 0.2}.get(h, 0.2)
    return {5: 2.0, 7: 2.0, 11: 1.5, 13: 1.5}.get(h, 1.2 * 17 / h)


def _iec_thd_limit(v_kv: float) -> float:
    return 8.0 if v_kv <= 1.0 else 6.5 if v_kv <= 35.0 else 3.0


def _iec_basis(v_kv: float) -> str:
    if v_kv <= 1.0:
        return "IEC 61000-2-4 Class 2"
    return "IEC 61000-3-6 " + ("MV" if v_kv <= 35.0 else "HV-EHV") + " planning"


def _bus_voltage_limits(h: int, v_kv: float, standard: str) -> float:
    return (_iec_ihd_limit(h, v_kv) if standard == "iec"
            else _voltage_limits(v_kv)[0])


def _num(p, key, default):
    """A numeric prop where an explicit 0 means 0 ([H6]: `or default` turned
    demand_factor 0 into 1 here while the load flow read it as 0)."""
    v = p.get(key)
    if v in (None, ""):
        return float(default)
    try:
        return float(v)
    except (TypeError, ValueError):
        return float(default)


# ── Network impedance helpers (fundamental R + X, per-unit on system base) ─────
def _source_rx(comp, base_mva) -> complex | None:
    """Shunt R+jX (pu) of a grounded source, at fundamental. None = not a shunt."""
    p = comp.props or {}
    if comp.type == "utility":
        fault_mva = p.get("fault_mva", 500) or 500
        xr = p.get("x_r_ratio", 15) or 15
        z = base_mva / fault_mva
        x = z * xr / math.sqrt(1 + xr * xr)
        return complex(x / xr, x)
    if comp.type == "generator":
        rated = p.get("rated_mva", 10) or 10
        xdpp = p.get("xd_pp", 0.15) or 0.15
        xr = p.get("x_r_ratio", 20) or 20
        x = xdpp * base_mva / rated
        return complex(x / xr, x)
    return None


def _machine_rx(comp, base_mva) -> complex | None:
    """Shunt R+jX (pu) of a rotating machine load (harmonic sink)."""
    p = comp.props or {}
    if comp.type == "motor_induction":
        kw = p.get("rated_kw", 200) or 200
        eff = p.get("efficiency", 0.93) or 0.93
        pf = p.get("power_factor", 0.85) or 0.85
        rated_mva = kw / (eff * pf * 1000) if pf > 0 else kw / (eff * 1000)
        xr = p.get("x_r_ratio", 2.4) or 2.4
        from .fault import induction_motor_x_pp
        xpp = induction_motor_x_pp(p, xr)   # [N8] explicit x_pp or 1/LRC
        x = xpp * base_mva / rated_mva if rated_mva > 0 else 0
        return complex(x / xr, x) if x > 0 else None
    if comp.type == "motor_synchronous":
        kva = p.get("rated_kva", 500) or 500
        rated_mva = kva / 1000
        xpp = p.get("x_pp", 0.15) or 0.15
        xr = p.get("x_r_ratio", 15) or 15
        x = xpp * base_mva / rated_mva if rated_mva > 0 else 0
        return complex(x / xr, x) if x > 0 else None
    return None


def _lumped_load_admittance(p, base_mva, h) -> complex:
    """Shunt admittance of a lumped load (static load or a distribution
    board's own load) at harmonic order h (pu).

    The static share is the parallel R–L model: R from P (constant), L from Q
    (reactance × h). [L3] A rotating share (``motor_fraction``, the prop the
    fault study already reads) is an induction-motor equivalent X″ = 1/LRC on
    its own kVA — a harmonic sink, the same model as a drawn motor — instead of
    the R–L branch. Demand factor scales both, as in the load flow."""
    kva = _num(p, "rated_kva", 100)
    pf = p.get("power_factor", 0.85) or 0.85
    df = _num(p, "demand_factor", 1.0)
    s = (kva / 1000) * df / base_mva
    if s <= 0:
        return complex(0, 0)
    mf = min(1.0, max(0.0, _num(p, "motor_fraction", 0)))
    y = complex(0, 0)
    if mf > 0:
        lrc = _num(p, "motor_lrc_ratio", 6) or 6
        xr = _num(p, "x_r_ratio", 10) or 10
        x = (1.0 / max(lrc, 1e-3)) / (s * mf)          # X″ on the system base
        y += 1 / complex(x / xr, h * x)
    s_static = s * (1 - mf)
    pmw = s_static * pf
    qmw = s_static * math.sqrt(max(0.0, 1 - pf * pf))
    if pmw > 0:
        y += pmw                                  # G = P (V ≈ 1 pu)
    if qmw > 0:
        y += 1 / complex(0, h / qmw)              # X_L = 1/Q at fundamental
    return y


def _shunt_admittance_at_h(comp, base_mva, h, solved_q_mvar=None) -> complex:
    """Shunt admittance to ground of one component at harmonic order h (pu).

    ``solved_q_mvar`` — an SVC's reactive output from the fundamental load
    flow (voltage-regulating mode has no fixed Q of its own)."""
    p = comp.props or {}
    # Grounded sources & rotating machines: series R + jX, reactance × h
    rx = _source_rx(comp, base_mva) or _machine_rx(comp, base_mva)
    if rx is not None:
        z = complex(rx.real, rx.imag * h)
        return 1 / z if abs(z) > 1e-12 else complex(0, 0)
    if comp.type == "capacitor_bank":
        # Susceptance × h — the resonance driver. Honour a switched bank's
        # steps_in_service (absent ⇒ whole bank, legacy-identical).
        kvar = p.get("rated_kvar", 100) or 0
        steps = max(1, int(p.get("steps", 1) or 1))
        sis = p.get("steps_in_service")
        if sis not in (None, ""):
            kvar = kvar * min(steps, max(0, int(sis))) / steps
        b1 = (kvar / 1000) / base_mva            # capacitive susceptance (pu)
        # A tuned_order > 0 makes the bank a SINGLE-TUNED FILTER: series
        # C-L-R sized so the net fundamental compensation still equals the
        # rated kvar (the load flow sees the same bank), with the series
        # resonance at h_t and damping from the quality factor Q:
        #   X_C = X_eff·h_t²/(h_t²−1),  X_L = X_C/h_t²,  R = (X_C/h_t)/Q.
        h_t = float(p.get("tuned_order", 0) or 0)
        if h_t > 1.0 and b1 > 0:
            q_fact = max(1.0, float(p.get("quality_factor", 30) or 30))
            x_eff = 1.0 / b1                               # pu, net at h=1
            x_c = x_eff * h_t * h_t / (h_t * h_t - 1.0)
            x_l = x_c / (h_t * h_t)
            r = (x_c / h_t) / q_fact
            z = complex(r, h * x_l - x_c / h)
            return 1.0 / z if abs(z) > 1e-12 else complex(0, 0)
        return complex(0, h * b1)
    if comp.type in ("svc", "statcom"):
        mode = str(p.get("device_mode", "statcom") or "statcom").lower()
        if comp.type == "statcom" or mode == "statcom":
            # [H3] A STATCOM is a voltage-source converter: at harmonic
            # frequencies it is its coupling reactance (phase reactor +
            # transformer) to an internal source that holds no harmonic
            # voltage — an inductive shunt X·h, whatever its fundamental Q.
            # It was modelled as a capacitor of its whole rating (a default
            # STATCOM = a 50 Mvar bank), fabricating a parallel resonance.
            # Rating from the Q limits the user edits; rated_mvar is a hidden
            # palette value (50) that only seeds them, as in the load flow.
            rated = (max(abs(_num(p, "q_max_mvar", 0)), abs(_num(p, "q_min_mvar", 0)))
                     or abs(_num(p, "rated_mvar", 0)))
            x_c = _num(p, "coupling_x_pu", 0.15)
            if rated <= 0 or x_c <= 0:
                return complex(0, 0)
            return 1 / complex(0, h * x_c * base_mva / rated)
        # SVC (thyristor-controlled): its net susceptance at the operating
        # point — capacitive behaves like a capacitor bank (× h), inductive
        # like a reactor (÷ h). [H3] Voltage-regulating mode takes the output
        # the load flow solved, never the rating ("assume full capacitive").
        if solved_q_mvar is not None:
            q = float(solved_q_mvar)
        elif str(p.get("control_mode", "") or "").lower() == "fixed_q":
            q = _num(p, "q_output_mvar", 0)
        else:
            q = 0.0
        b1 = q / base_mva
        if b1 >= 0:
            return complex(0, h * b1)
        return complex(0, b1 / h)
    if comp.type == "static_load":
        return _lumped_load_admittance(p, base_mva, h)
    return complex(0, 0)


def bus_shunt_admittance(bus, comps_at_bus, base_mva, h, svc_q=None) -> complex:
    """Total shunt admittance at one bus at order h: every shunt component
    found at the bus plus — [H2] — a distribution board's OWN lumped load
    (the board is a node, so the component walk never finds it; the load flow
    injects it explicitly the same way). VFDs are current sources, not
    shunts. Shared with the frequency scan so both see the same network."""
    acc = complex(0, 0)
    if bus.type == "distribution_board":
        # An older board without rated_kva reads 100 kVA, as in the load flow.
        acc += _lumped_load_admittance(bus.props or {}, base_mva, h)
    svc_q = svc_q or {}
    for comp in comps_at_bus:
        if comp.type == "vfd":
            continue
        acc += _shunt_admittance_at_h(comp, base_mva, h, svc_q.get(comp.id))
    return acc


def _branch_chains(project, base_mva):
    """Replicate the load-flow branch-chain discovery, returning
    [(bus_a, bus_b, R_pu, X_pu)] with R/X separated so X can be scaled by h.
    Also returns (buses, bus_idx, adjacency, components)."""
    components = {c.id: c for c in project.components}
    buses = [c for c in project.components
             if c.type in ("bus", "distribution_board")
             and str(c.props.get("system", "ac")).lower() != "dc"]
    bus_idx = {b.id: i for i, b in enumerate(buses)}
    adjacency = {}
    for w in project.wires:
        adjacency.setdefault(w.fromComponent, []).append(w.toComponent)
        adjacency.setdefault(w.toComponent, []).append(w.fromComponent)
    bus_of = _lf._build_bus_groups(buses, adjacency, components, bus_idx)

    branch_types = ("cable", "transformer", "autotransformer")
    chains = []
    processed = set()
    for comp in project.components:
        if comp.type not in branch_types or comp.id in bus_of:
            continue
        if comp.id in {eid for key in processed for eid in key}:
            continue
        results = _lf._find_bus_paths(comp.id, adjacency, components, bus_of)
        if len(results) < 2:
            continue
        bus_a, path_a = results[0]
        bus_b, path_b = results[1]
        if bus_a == bus_b:
            continue
        all_elems = {}
        for _, path in results[:2]:
            for e in path:
                all_elems[e.id] = e
        key = frozenset(all_elems.keys())
        if key in processed:
            continue
        processed.add(key)

        has_xfmr = any(e.type in ("transformer", "autotransformer")
                       for e in all_elems.values())
        ba = components.get(bus_a)
        bb = components.get(bus_b)
        va = ba.props.get("voltage_kv", 11) if ba else 11
        vb = bb.props.get("voltage_kv", 11) if bb else 11
        # Zone by chain POSITION, not walk-path membership (which depends on
        # the seed element — see loadflow._walk_chain_zones). A transformer's
        # entry is its LV zone, to which its nameplate z% is re-based.
        zones = (_lf.chain_element_zones(_lf.chain_order_from_paths(path_a, path_b), va, vb)
                 if has_xfmr else {})
        z_total = complex(0, 0)
        for e in all_elems.values():
            if e.type == "cable":
                if has_xfmr:
                    v_kv = zones[e.id]
                else:
                    # No transformer ⇒ one voltage zone, bounded by these
                    # buses. The cable's own voltage_kv prop must NOT win: a
                    # present-but-stale 11 kV default (the palette value) would
                    # otherwise set the per-unit base for a 0.4 kV run
                    # ([EE-12 mirror], see loadflow._get_impedance).
                    v_kv = va
                z_base = (v_kv ** 2) / base_mva if v_kv > 0 else 1.0
                r = e.props.get("r_per_km", 0.1) * e.props.get("length_km", 1)
                x = e.props.get("x_per_km", 0.08) * e.props.get("length_km", 1)
                npar = max(1, int(e.props.get("num_parallel", 1) or 1))
                z_total += complex(r / z_base, x / z_base) / npar
            else:
                z_total += _lf._get_impedance(e, base_mva, v_lv_kv=zones.get(e.id))
        if abs(z_total) < 1e-12:
            z_total = complex(0, 1e-6)
        chains.append((bus_a, bus_b, z_total.real, z_total.imag))

    # Solid links through transparent (closed) devices — near-short at all h.
    linked = set()
    for bus in buses:
        visited = {bus.id}
        queue = list(adjacency.get(bus.id, []))
        while queue:
            nid = queue.pop(0)
            if nid in visited:
                continue
            visited.add(nid)
            if nid in bus_idx:
                linked.add(tuple(sorted([bus.id, nid])))
                continue
            comp = components.get(nid)
            if comp and _lf._is_transparent_and_closed(comp):
                for nb in adjacency.get(nid, []):
                    if nb not in visited:
                        queue.append(nb)
    for a, b in linked:
        chains.append((a, b, 0.0, 1e-6))   # tiny series reactance

    return chains, buses, bus_idx, adjacency, components, bus_of


def _build_yh(chains, shunts, bus_idx, h):
    """Assemble the n×n harmonic admittance matrix at order h."""
    n = len(bus_idx)
    Y = np.zeros((n, n), dtype=complex)
    for bus_a, bus_b, r, x in chains:
        z = complex(r, x * h)
        y = 1 / z if abs(z) > 1e-12 else complex(0, -1e6)
        i, j = bus_idx[bus_a], bus_idx[bus_b]
        Y[i, i] += y
        Y[j, j] += y
        Y[i, j] -= y
        Y[j, i] -= y
    for bus_id, y in shunts(h).items():
        Y[bus_idx[bus_id], bus_idx[bus_id]] += y
    return Y


_METHOD = {
    "ieee519": "Frequency-domain harmonic current-injection (IEEE 519-2014)",
    "iec": ("Frequency-domain harmonic current-injection (IEC 61000-3-6 "
            "planning levels / IEC 61000-2-4 Class 2)"),
}


def _limits_standard(value) -> str:
    return "iec" if str(value or "").lower() == "iec" else "ieee519"


def _lumped_kva(p, default_kva=100.0) -> float:
    return _num(p, "rated_kva", default_kva) * _num(p, "demand_factor", 1.0)


def run_harmonics(project, method: str = "newton_raphson", limits: str | None = None):
    """Run the harmonic penetration study. Returns a dict matching
    HarmonicsResults.

    limits — "ieee519" (default) or "iec"; None reads the project's
    ``harmonicsLimits`` setting."""
    standard = _limits_standard(limits if limits is not None
                                else getattr(project, "harmonicsLimits", None))
    base_mva = project.baseMVA or 100.0
    # Same topology pre-passes as the load flow: a node at every cable tee
    # the drawing left without a bus, then load/source terminal buses.
    project = _lf.insert_junction_buses(project)
    project = _lf.insert_implicit_load_buses(project)

    # 1. Fundamental load flow → per-bus fundamental voltage magnitude,
    #    which buses are live, and each SVC's solved reactive output.
    v1 = {}
    energized = {}
    svc_q = {}
    fundamental_converged = False
    try:
        lf = _lf.run_load_flow(project, method, include_synthetic=True)
        fundamental_converged = bool(lf.converged)
        for bid, b in (lf.buses or {}).items():
            v1[bid] = float(abs(b.voltage_pu)) if getattr(b, "voltage_pu", None) else 1.0
            energized[bid] = bool(getattr(b, "energized", True))
        for u in (lf.svc or []):
            if u.get("id") is not None and u.get("q_mvar") is not None:
                # As a susceptance: Q at 1 pu = Q / V² (the shunt model is B).
                vu = float(u.get("v_pu") or 1.0) or 1.0
                svc_q[u["id"]] = float(u["q_mvar"]) / (vu * vu)
    except Exception:
        fundamental_converged = False

    def live(bus_id):
        # [H4] A bus in a sourceless island carries no fundamental current,
        # so no drive on it runs and it is not a harmonic study result. Absent
        # (load flow failed) ⇒ treat as live, the legacy behaviour.
        return energized.get(bus_id, True)

    chains, buses, bus_idx, adjacency, components, bus_of = _branch_chains(project, base_mva)
    n = len(buses)
    warnings = []
    if n == 0:
        return _empty_result("No AC buses in the network.", standard)
    comps_at = {b.id: _lf._find_components_at_bus(b.id, adjacency, components)
                for b in buses}

    # 2. Locate VFD sources + their fundamental current, grouped by bus.
    vfds = [c for c in project.components if c.type == "vfd"]
    vfd_infos = []
    inj_by_bus_order = {}          # bus_id -> {order: summed current (pu)}
    dead_vfds = []
    total_load_mva = 0.0
    for comp in vfds:
        # which bus does this VFD sit on?
        bus_id = next((b.id for b in buses if comp in comps_at[b.id]), None)
        if bus_id is None:
            continue
        p = comp.props or {}
        if not live(bus_id):
            dead_vfds.append(str(p.get("name", comp.id)))
            continue
        rated_kw = p.get("rated_kw", 200) or 200
        eff = p.get("efficiency", 0.96) or 0.96
        load = float(p.get("load_pct", 100) or 0) / 100.0
        dpf = float(p.get("displacement_pf", 0.98) or 0.98)
        df = _num(p, "demand_factor", 1.0)
        p_mw = rated_kw * load / (eff * 1000)
        s_mva = p_mw / dpf if dpf > 0 else p_mw
        s_pu = s_mva * df / base_mva
        total_load_mva += s_mva * df
        vbus = v1.get(bus_id, 1.0) or 1.0
        i1 = s_pu / vbus if vbus > 0 else s_pu    # fundamental current (pu)
        spectrum = vfd_current_spectrum(comp)
        d = inj_by_bus_order.setdefault(bus_id, {})
        for order, ratio in spectrum.items():
            d[order] = d.get(order, 0.0) + i1 * ratio       # in-phase sum
        vfd_infos.append({
            "id": comp.id, "name": p.get("name", comp.id),
            "bus_id": bus_id, "p_mw": round(p_mw, 4),
            "pulse_number": int(p.get("pulse_number", 6) or 6),
            "front_end": str(p.get("front_end", "diode")),
            "i1_pu": round(i1, 5),
            "spectrum": {str(k): round(v, 4) for k, v in sorted(spectrum.items())},
            "current_thd_pct": round(
                100 * math.sqrt(sum(v * v for v in spectrum.values())), 1),
        })
    if dead_vfds:
        warnings.append("De-energised (no source reaches the bus), not "
                        "modelled as harmonic sources: " + ", ".join(dead_vfds) + ".")

    if not vfd_infos:
        return _empty_result("No energised VFD (harmonic-source) components in "
                             "the network." if dead_vfds else
                             "No VFD (harmonic-source) components in the network.",
                             standard, warnings)

    orders = sorted({o for d in inj_by_bus_order.values() for o in d})

    # Every live load's demand for I_L (the maximum-demand current basis):
    # demand-factored, as the load flow applies it.
    for b in buses:
        if not live(b.id):
            continue
        if b.type == "distribution_board":            # [H2] the board's own load
            total_load_mva += _lumped_kva(b.props or {}) / 1000
        for comp in comps_at[b.id]:
            p = comp.props or {}
            if comp.type == "static_load":
                total_load_mva += _lumped_kva(p, 0) / 1000
            elif comp.type == "motor_induction":
                total_load_mva += (p.get("rated_kw", 0) or 0) / ((p.get("efficiency", 0.93) or 0.93) * (p.get("power_factor", 0.85) or 0.85) * 1000) * _num(p, "demand_factor", 1.0)
            elif comp.type == "motor_synchronous":
                total_load_mva += (p.get("rated_kva", 0) or 0) / 1000 * _num(p, "demand_factor", 1.0)

    # 3. Shunt-admittance provider (per harmonic order).
    def shunts(h):
        out = {}
        for b in buses:
            acc = bus_shunt_admittance(b, comps_at[b.id], base_mva, h, svc_q)
            if acc != 0:
                out[b.id] = acc
        return out

    # PCC: the utility connection bus. [L2] With several utilities the first
    # one drawn is evaluated and the others are named in a warning.
    utilities = [(b.id, comp) for b in buses for comp in comps_at[b.id]
                 if comp.type == "utility"]
    pcc_bus, pcc_util = (utilities[0] if utilities else (None, None))
    isc_pu = ((pcc_util.props.get("fault_mva", 500) or 500) / base_mva
              if pcc_util is not None else 0.0)
    if len(utilities) > 1:
        warnings.append("Several utility connections — the PCC current is "
                        f"evaluated at '{pcc_util.props.get('name', pcc_util.id)}' "
                        "only.")
    il_pu = (total_load_mva / base_mva) if total_load_mva > 0 else 1e-6

    # 4. Solve at each harmonic order.
    bus_ihd = {b.id: {} for b in buses}      # bus -> {order: |V_h| pu}
    pcc_i_h = {}                             # order -> |I| into utility (pu)
    for h in orders:
        Yh = _build_yh(chains, shunts, bus_idx, h)
        Ih = np.zeros(n, dtype=complex)
        for bus_id, d in inj_by_bus_order.items():
            if h in d:
                Ih[bus_idx[bus_id]] = d[h]
        # regularise a possibly-singular matrix (isolated island w/o ground)
        try:
            Vh = np.linalg.solve(Yh, Ih)
        except np.linalg.LinAlgError:
            Yh = Yh + np.eye(n) * 1e-9
            try:
                Vh = np.linalg.solve(Yh, Ih)
            except np.linalg.LinAlgError:
                warnings.append(f"Harmonic order {h}: singular network, skipped.")
                continue
        for b in buses:
            bus_ihd[b.id][h] = float(abs(Vh[bus_idx[b.id]]))
        if pcc_util is not None:
            # [L1] The PCC current is what flows into the UTILITY — a
            # generator on the same bus is on the customer's side of it.
            ys = _shunt_admittance_at_h(pcc_util, base_mva, h)
            pcc_i_h[h] = float(abs(Vh[bus_idx[pcc_bus]] * ys))

    # 5. Per-bus THD_V + voltage compliance.
    bus_results = []
    worst = {"thd": -1.0, "id": "", "name": ""}
    overall_compliant = True
    for b in buses:
        if _lf.is_synthetic_bus(b.id) or not live(b.id):
            continue
        vf = v1.get(b.id, 1.0) or 1.0
        v_kv = b.props.get("voltage_kv", 11) or 11
        ihd, ihd_lims = {}, {}
        ss = 0.0
        crit_h, crit_ratio = None, -1.0
        for h, vmag in bus_ihd[b.id].items():
            pct = float(100 * vmag / vf) if vf > 0 else 0.0
            lim = _bus_voltage_limits(h, v_kv, standard)
            ihd[str(h)] = round(pct, 3)
            ihd_lims[str(h)] = round(lim, 3)
            ss += pct * pct
            ratio = pct / lim if lim > 0 else 0.0
            if ratio > crit_ratio:
                crit_h, crit_ratio = h, ratio
        thd = math.sqrt(ss)
        thd_lim = _iec_thd_limit(v_kv) if standard == "iec" else _voltage_limits(v_kv)[1]
        max_ihd = float(max(ihd.values(), default=0.0))
        compliant = bool(thd <= thd_lim + 1e-6 and crit_ratio <= 1.0 + 1e-6)
        overall_compliant = bool(overall_compliant and compliant)
        bus_results.append({
            "id": b.id, "name": b.props.get("name", b.id),
            "voltage_kv": v_kv, "v1_pu": round(vf, 4),
            "thd_v_pct": round(thd, 2), "max_ihd_pct": round(max_ihd, 2),
            "ihd": ihd, "ihd_limits": ihd_lims, "thd_limit_pct": thd_lim,
            # The order nearest its own limit (IEC limits vary by order).
            "critical_order": crit_h,
            "critical_ihd_pct": ihd.get(str(crit_h), 0.0) if crit_h else 0.0,
            "ihd_limit_pct": ihd_lims.get(str(crit_h), 0.0) if crit_h else
                             round(_bus_voltage_limits(5, v_kv, standard), 3),
            "limit_basis": (_iec_basis(v_kv) if standard == "iec"
                            else "IEEE 519-2014 Table 1"),
            "compliant": compliant,
        })
        if thd > worst["thd"]:
            worst = {"thd": thd, "id": b.id, "name": b.props.get("name", b.id)}

    bus_results.sort(key=lambda r: r["thd_v_pct"], reverse=True)

    # 6. PCC current TDD + individual harmonic currents.
    pcc = None
    if pcc_bus is not None and pcc_i_h:
        i_thd_num = math.sqrt(sum(v * v for v in pcc_i_h.values()))
        tdd = 100 * i_thd_num / il_pu if il_pu > 0 else 0.0
        isc_il = isc_pu / il_pu if il_pu > 0 else 0.0
        pb = components.get(pcc_bus)
        v_kv = pb.props.get("voltage_kv", 11) if pb else 11
        pcc_name = pb.props.get("name", pcc_bus) if pb else pcc_bus
        harm_pct = {h: 100 * i / il_pu for h, i in sorted(pcc_i_h.items())}
        pcc = {
            "bus_id": pcc_bus, "name": pcc_name, "voltage_kv": v_kv,
            "i_tdd_pct": round(tdd, 2), "isc_il": round(isc_il, 1),
            "harmonics": {str(h): round(v, 3) for h, v in harm_pct.items()},
        }
        if standard == "ieee519":
            tdd_lim = _tdd_limit(isc_il, v_kv)
            # [H1] Table 2/3/4 limit each order, not just the total: a
            # 12-pulse drive's 11th can exceed its 5.5 % while TDD passes.
            lims = {h: _current_limit(h, isc_il, v_kv) for h in harm_pct}
            over = [h for h, v in harm_pct.items()
                    if lims[h] is not None and v > lims[h] + 1e-6]
            i_compliant = bool(tdd <= tdd_lim + 1e-6 and not over)
            overall_compliant = bool(overall_compliant and i_compliant)
            pcc.update({
                "tdd_limit_pct": tdd_lim, "compliant": i_compliant,
                "harmonic_limits": {str(h): l for h, l in lims.items() if l is not None},
                "exceeding_orders": over,
            })
        else:
            # IEC 61000-3-6 allocates emission to each customer from planning
            # data (agreed power, supply capacity, transfer coefficients) the
            # model does not hold; the current is reported, the verdict rests
            # on the voltage levels.
            pcc.update({"tdd_limit_pct": None, "compliant": None,
                        "harmonic_limits": {}, "exceeding_orders": []})
    else:
        warnings.append("No utility source found — PCC current TDD not evaluated.")

    if not fundamental_converged:
        warnings.append("Fundamental load flow did not converge; harmonic "
                        "voltages use nominal (1.0 pu) references.")

    return {
        "converged": True,
        "fundamental_converged": fundamental_converged,
        "orders": orders,
        "buses": bus_results,
        "worst_thd_pct": round(max(worst["thd"], 0.0), 2),
        "worst_bus_id": worst["id"],
        "worst_bus_name": worst["name"],
        "pcc": pcc,
        "vfd_sources": vfd_infos,
        "compliant": overall_compliant,
        "limits_standard": standard,
        "method": _METHOD[standard],
        "warnings": warnings,
        "note": "",
    }


def _empty_result(note, standard="ieee519", warnings=None):
    return {
        "converged": False, "fundamental_converged": False, "orders": [],
        "buses": [], "worst_thd_pct": 0.0, "worst_bus_id": "", "worst_bus_name": "",
        "pcc": None, "vfd_sources": [], "compliant": True,
        "limits_standard": standard, "method": _METHOD[standard],
        "warnings": list(warnings or []), "note": note,
    }
