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
    """(individual harmonic %, total THD %) voltage limits by bus voltage."""
    if v_kv <= 1.0:
        return 5.0, 8.0
    if v_kv <= 69.0:
        return 3.0, 5.0
    if v_kv <= 161.0:
        return 1.5, 2.5
    return 1.0, 1.5


def _tdd_limit(isc_il: float, v_kv: float) -> float:
    """Total demand distortion (current) limit % at the PCC.

    IEEE 519-2014 Table 2 (120 V – 69 kV). Higher-voltage tables are stricter;
    we apply a conservative scale for >69 kV.
    """
    if isc_il < 20:
        base = 5.0
    elif isc_il < 50:
        base = 8.0
    elif isc_il < 100:
        base = 12.0
    elif isc_il < 1000:
        base = 15.0
    else:
        base = 20.0
    if v_kv > 161.0:
        return base * 0.25
    if v_kv > 69.0:
        return base * 0.5
    return base


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
        xpp = p.get("x_pp", 0.17) or 0.17
        xr = p.get("x_r_ratio", 2.4) or 2.4
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


def _shunt_admittance_at_h(comp, base_mva, h) -> complex:
    """Shunt admittance to ground of one component at harmonic order h (pu)."""
    p = comp.props or {}
    # Grounded sources & rotating machines: series R + jX, reactance × h
    rx = _source_rx(comp, base_mva) or _machine_rx(comp, base_mva)
    if rx is not None:
        z = complex(rx.real, rx.imag * h)
        return 1 / z if abs(z) > 1e-12 else complex(0, 0)
    if comp.type == "capacitor_bank":
        # Susceptance × h — the resonance driver.
        kvar = p.get("rated_kvar", 100) or 0
        b1 = (kvar / 1000) / base_mva            # capacitive susceptance (pu)
        return complex(0, h * b1)
    if comp.type in ("svc", "statcom"):
        # FACTS device: model its net reactive output as an equivalent shunt.
        # Capacitive (positive Q) behaves like a capacitor bank (× h); inductive
        # like a reactor (÷ h). Uses the last-solved / rated Q if present.
        q = float(p.get("q_output_mvar", 0) or 0)
        if q == 0:
            q = float(p.get("rated_mvar", 0) or 0)   # assume full capacitive
        b1 = q / base_mva
        if b1 >= 0:
            return complex(0, h * b1)
        return complex(0, b1 / h)
    if comp.type == "static_load":
        # Parallel R–L: R from P (constant), L from Q (reactance × h).
        kva = p.get("rated_kva", 100) or 0
        pf = p.get("power_factor", 0.85) or 0.85
        df = p.get("demand_factor", 1.0) or 1.0
        s = (kva / 1000) * df / base_mva
        pmw = s * pf
        qmw = s * math.sqrt(max(0.0, 1 - pf * pf))
        y = complex(0, 0)
        if pmw > 0:
            y += 1 / (1.0 / pmw)                 # G = P (V≈1 pu)
        if qmw > 0:
            xl = 1.0 / qmw                        # X_L at fundamental
            y += 1 / complex(0, h * xl)
        return y
    return complex(0, 0)


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
        path_a_ids = {e.id for e in path_a}
        z_total = complex(0, 0)
        for e in all_elems.values():
            if e.type == "cable":
                if has_xfmr:
                    v_kv = va if e.id in path_a_ids else vb
                else:
                    v_kv = e.props.get("voltage_kv", va) or va
                z_base = (v_kv ** 2) / base_mva if v_kv > 0 else 1.0
                r = e.props.get("r_per_km", 0.1) * e.props.get("length_km", 1)
                x = e.props.get("x_per_km", 0.08) * e.props.get("length_km", 1)
                npar = max(1, int(e.props.get("num_parallel", 1) or 1))
                z_total += complex(r / z_base, x / z_base) / npar
            else:
                z_total += _lf._get_impedance(e, base_mva)
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


def run_harmonics(project, method: str = "newton_raphson"):
    """Run the harmonic penetration study. Returns a dict matching
    HarmonicsResults."""
    base_mva = project.baseMVA or 100.0
    project = _lf.insert_implicit_load_buses(project)

    # 1. Fundamental load flow → per-bus fundamental voltage magnitude.
    v1 = {}
    fundamental_converged = False
    try:
        lf = _lf.run_load_flow(project, method, include_synthetic=True)
        fundamental_converged = bool(lf.converged)
        for bid, b in (lf.buses or {}).items():
            v1[bid] = float(abs(b.voltage_pu)) if getattr(b, "voltage_pu", None) else 1.0
    except Exception:
        fundamental_converged = False

    chains, buses, bus_idx, adjacency, components, bus_of = _branch_chains(project, base_mva)
    n = len(buses)
    warnings = []
    if n == 0:
        return _empty_result("No AC buses in the network.")

    # 2. Locate VFD sources + their fundamental current, grouped by bus.
    vfds = [c for c in project.components if c.type == "vfd"]
    vfd_infos = []
    inj_by_bus_order = {}          # bus_id -> {order: summed current (pu)}
    total_load_mva = 0.0
    for comp in vfds:
        # which bus does this VFD sit on?
        bus_id = None
        for b in buses:
            if comp in _lf._find_components_at_bus(b.id, adjacency, components):
                bus_id = b.id
                break
        if bus_id is None:
            continue
        p = comp.props or {}
        rated_kw = p.get("rated_kw", 200) or 200
        eff = p.get("efficiency", 0.96) or 0.96
        load = float(p.get("load_pct", 100) or 0) / 100.0
        dpf = float(p.get("displacement_pf", 0.98) or 0.98)
        df = p.get("demand_factor", 1.0) or 1.0
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

    if not vfd_infos:
        return _empty_result("No VFD (harmonic-source) components in the network.")

    orders = sorted({o for d in inj_by_bus_order.values() for o in d})

    # add every load/source's total demand for a rough IL (max-demand current).
    for b in buses:
        for comp in _lf._find_components_at_bus(b.id, adjacency, components):
            p = comp.props or {}
            if comp.type == "static_load":
                total_load_mva += (p.get("rated_kva", 0) or 0) / 1000 * (p.get("demand_factor", 1.0) or 1.0)
            elif comp.type == "motor_induction":
                total_load_mva += (p.get("rated_kw", 0) or 0) / ((p.get("efficiency", 0.93) or 0.93) * (p.get("power_factor", 0.85) or 0.85) * 1000)
            elif comp.type == "motor_synchronous":
                total_load_mva += (p.get("rated_kva", 0) or 0) / 1000

    # 3. Shunt-admittance provider (per harmonic order).
    def shunts(h):
        out = {}
        for b in buses:
            acc = complex(0, 0)
            for comp in _lf._find_components_at_bus(b.id, adjacency, components):
                if comp.type == "vfd":
                    continue
                acc += _shunt_admittance_at_h(comp, base_mva, h)
            if acc != 0:
                out[b.id] = acc
        return out

    # source (PCC) admittance at fundamental for Isc, and PCC bus id.
    pcc_bus = None
    isc_pu = 0.0
    for b in buses:
        for comp in _lf._find_components_at_bus(b.id, adjacency, components):
            if comp.type == "utility":
                pcc_bus = b.id
                isc_pu = (comp.props.get("fault_mva", 500) or 500) / base_mva
    il_pu = (total_load_mva / base_mva) if total_load_mva > 0 else 1e-6

    # 4. Solve at each harmonic order.
    bus_ihd = {b.id: {} for b in buses}      # bus -> {order: |V_h| pu}
    pcc_i_h = {}                             # order -> |I| into source (pu)
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
        if pcc_bus is not None:
            # harmonic current into the source shunt at the PCC
            ys = complex(0, 0)
            for comp in _lf._find_components_at_bus(pcc_bus, adjacency, components):
                if comp.type in ("utility", "generator"):
                    ys += _shunt_admittance_at_h(comp, base_mva, h)
            pcc_i_h[h] = float(abs(Vh[bus_idx[pcc_bus]] * ys))

    # 5. Per-bus THD_V + IEEE 519 voltage compliance.
    bus_results = []
    worst = {"thd": -1.0, "id": "", "name": ""}
    overall_compliant = True
    for b in buses:
        if _lf.is_synthetic_bus(b.id):
            continue
        vf = v1.get(b.id, 1.0) or 1.0
        ihd = {}
        ss = 0.0
        for h, vmag in bus_ihd[b.id].items():
            pct = float(100 * vmag / vf) if vf > 0 else 0.0
            ihd[str(h)] = round(pct, 3)
            ss += pct * pct
        thd = math.sqrt(ss)
        v_kv = b.props.get("voltage_kv", 11) or 11
        ihd_lim, thd_lim = _voltage_limits(v_kv)
        max_ihd = float(max(ihd.values(), default=0.0))
        compliant = bool(thd <= thd_lim + 1e-6 and max_ihd <= ihd_lim + 1e-6)
        overall_compliant = bool(overall_compliant and compliant)
        bus_results.append({
            "id": b.id, "name": b.props.get("name", b.id),
            "voltage_kv": v_kv, "v1_pu": round(vf, 4),
            "thd_v_pct": round(thd, 2), "max_ihd_pct": round(max_ihd, 2),
            "ihd": ihd, "thd_limit_pct": thd_lim, "ihd_limit_pct": ihd_lim,
            "compliant": compliant,
        })
        if thd > worst["thd"]:
            worst = {"thd": thd, "id": b.id, "name": b.props.get("name", b.id)}

    bus_results.sort(key=lambda r: r["thd_v_pct"], reverse=True)

    # 6. PCC current TDD.
    pcc = None
    if pcc_bus is not None and pcc_i_h:
        i_thd_num = math.sqrt(sum(v * v for v in pcc_i_h.values()))
        tdd = 100 * i_thd_num / il_pu if il_pu > 0 else 0.0
        isc_il = isc_pu / il_pu if il_pu > 0 else 0.0
        pb = components.get(pcc_bus)
        v_kv = pb.props.get("voltage_kv", 11) if pb else 11
        pcc_name = pb.props.get("name", pcc_bus) if pb else pcc_bus
        tdd_lim = _tdd_limit(isc_il, v_kv)
        i_compliant = bool(tdd <= tdd_lim + 1e-6)
        overall_compliant = bool(overall_compliant and i_compliant)
        pcc = {
            "bus_id": pcc_bus, "name": pcc_name, "voltage_kv": v_kv,
            "i_tdd_pct": round(tdd, 2), "isc_il": round(isc_il, 1),
            "tdd_limit_pct": tdd_lim, "compliant": i_compliant,
            "harmonics": {str(h): round(100 * i / il_pu, 3)
                          for h, i in sorted(pcc_i_h.items())},
        }
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
        "method": "Frequency-domain harmonic current-injection (IEEE 519-2014)",
        "warnings": warnings,
        "note": "",
    }


def _empty_result(note):
    return {
        "converged": False, "fundamental_converged": False, "orders": [],
        "buses": [], "worst_thd_pct": 0.0, "worst_bus_id": "", "worst_bus_name": "",
        "pcc": None, "vfd_sources": [], "compliant": True,
        "method": "Frequency-domain harmonic current-injection (IEEE 519-2014)",
        "warnings": [], "note": note,
    }
