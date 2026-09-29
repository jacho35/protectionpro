"""Frequency scan — driving-point impedance vs frequency for resonance
identification.

Sweeps harmonic order h continuously from the fundamental to ``h_max`` and, at
each frequency, assembles the same harmonic network the IEEE 519 penetration
study uses (`harmonics._branch_chains` / `_shunt_admittance_at_h`: sources and
rotating machines as R + jhX shunts, capacitor banks as jhB, static loads as
the damping parallel R–L, series branches as R + jhX) and inverts the nodal
admittance matrix. The diagonal entry Z_kk(h) is the driving-point impedance
seen from bus k — the quantity a harmonic current source at that bus multiplies
into voltage distortion:

  * a **parallel resonance** (the L of the source/transformers against a shunt
    capacitor) appears as a sharp |Z| maximum — harmonic currents near that
    order are amplified;
  * a **series resonance** appears as an |Z| minimum — that branch sinks
    harmonic current (the basis of a tuned filter).

The classic screening hand-check falls out exactly: a capacitor bank Q_c on a
bus with short-circuit level S_sc resonates at h_r = √(S_sc / Q_c).

Results are on-demand (not persisted). Impedances are reported in ohms at each
bus's own voltage base and in per unit on the study base; resonances are
ranked in per unit ([FS1]).

The network is the one the fundamental load flow energises ([FS4]): buses in
a sourceless island are not scanned, and a voltage-regulating SVC takes the
output the load flow solved ([FS5]). The model is positive-sequence and
balanced: cable capacitance, frequency-dependent resistance and the
zero-sequence (triplen) network are not represented.
"""

from __future__ import annotations

import math
import numpy as np

from . import loadflow as _lf
from .harmonics import (_branch_chains, bus_shunt_admittance, _build_yh,
                        _shunt_admittance_at_h, fundamental_operating_point)

# Peak/dip detection: a local extremum is a resonance only when it stands out
# from the valley floor (or ceiling) around it by this ratio — filters the
# gentle inductive rise of a capacitor-free network without missing damped
# real-world peaks.
PARALLEL_PROMINENCE = 2.0
SERIES_PROMINENCE = 2.0
MAX_SCAN_BUSES = 12          # cap the curve payload; scan buses beyond → note


def _prominence(z, i, peak):
    """Topographic prominence of the extremum at i ([FS-L1]): on each side the
    col is the lowest point (highest, for a dip) between i and the nearest
    point that out-tops it — a higher peak, a deeper dip, or the curve end —
    and the reference is the higher (lower) of the two cols. Taking the col
    over the whole side instead reached past a larger neighbouring peak to
    the low fundamental-end |Z| and passed a ripple on that peak's shoulder
    as a resonance."""
    zi = z[i]
    cols = []
    for rng in (range(i - 1, -1, -1), range(i + 1, len(z))):
        col = zi
        for j in rng:
            if (z[j] > zi) if peak else (z[j] < zi):
                break
            col = min(col, z[j]) if peak else max(col, z[j])
        cols.append(col)
    if peak:
        ref = max(cols)
        return zi / ref if ref > 0 else 0.0
    ref = min(cols)
    return ref / zi if zi > 0 else 0.0


def _detect_resonances(hs, z, f0):
    """Find parallel (peak) and series (dip) resonances in one |Z(h)| curve.

    Returns [{kind, i, prominence}] — `i` is the sample index, refined to the
    true extremum by the caller ([FS2])."""
    out = []
    n = len(z)
    for i in range(1, n - 1):
        if z[i] >= z[i - 1] and z[i] > z[i + 1]:
            prom = _prominence(z, i, True)
            if prom >= PARALLEL_PROMINENCE:
                out.append({"kind": "parallel", "i": i, "prominence": prom})
        elif z[i] <= z[i - 1] and z[i] < z[i + 1]:
            prom = _prominence(z, i, False)
            if prom >= SERIES_PROMINENCE:
                out.append({"kind": "series", "i": i, "prominence": prom})
    return out


_GOLD = (math.sqrt(5.0) - 1.0) / 2.0


def _refine_extremum(f, lo, hi, peak, tol=1e-5):
    """[FS2] Golden-section search for the extremum of a unimodal f on
    [lo, hi] (the samples either side of the detected one). The sampled
    maximum sits up to h_step/2 off a resonance whose half-power width can be
    far narrower, so its |Z| can be a small fraction of the true peak."""
    sgn = -1.0 if peak else 1.0
    a, b = lo, hi
    c, d = b - _GOLD * (b - a), a + _GOLD * (b - a)
    fc, fd = sgn * f(c), sgn * f(d)
    while b - a > tol:
        if fc < fd:
            b, d, fd = d, c, fc
            c = b - _GOLD * (b - a)
            fc = sgn * f(c)
        else:
            a, c, fc = c, d, fd
            d = a + _GOLD * (b - a)
            fd = sgn * f(d)
    h = (a + b) / 2.0
    return h, f(h)


def _sig(v, digits=6):
    """Round to significant figures ([FS-L4]): an LV driving-point impedance
    is milliohms, so fixed decimals kept one or two digits of it."""
    v = float(v)
    if v == 0 or not math.isfinite(v):
        return 0.0
    return round(v, digits - 1 - int(math.floor(math.log10(abs(v)))))


def run_frequency_scan(project, bus_ids=None, h_max: float = 25.0,
                       h_step: float = 0.05):
    """Run the impedance-vs-frequency sweep. Returns a dict matching
    FrequencyScanResults."""
    base_mva = project.baseMVA or 100.0
    f0 = float(project.frequency or 50)
    h_max = max(2.0, min(100.0, float(h_max or 25.0)))
    h_step = max(0.01, min(1.0, float(h_step or 0.05)))
    project = _lf.insert_implicit_load_buses(_lf.insert_junction_buses(project))

    chains, buses, bus_idx, adjacency, components, bus_of = \
        _branch_chains(project, base_mva)
    n = len(buses)
    warnings = []
    if n == 0:
        return _empty_result("No AC buses in the network.", f0)

    # [FS4]/[FS5] The operating point the scan describes: which buses the
    # load flow energises, and what a voltage-regulating SVC is putting out
    # (it has no fixed Q of its own, so without this it contributed nothing).
    # Load flow failed ⇒ every bus live and regulating SVCs at 0, the legacy
    # behaviour.
    _conv, _v1, energized, svc_q, lf = fundamental_operating_point(project)

    def live(bus_id):
        return energized.get(bus_id, True)

    # Shunt provider (identical modelling to the harmonics study; VFDs are
    # current sources, not shunts, so they don't load the scan). The per-bus
    # component walk is hoisted out of the sweep — it is topology, not
    # frequency, and the sweep re-evaluates shunts ~500 times.
    comps_at = {b.id: [c for c in _lf._find_components_at_bus(b.id, adjacency,
                                                              components)
                       if c.type != "vfd"]
                for b in buses}

    def shunts(h):
        out = {}
        for b in buses:
            acc = bus_shunt_admittance(b, comps_at[b.id], base_mva, h, svc_q)
            if acc != 0:
                out[b.id] = acc
        return out

    if not shunts(1.0):
        return _empty_result(
            "No grounded shunt elements (source, machine, load or capacitor) "
            "— the impedance scan has no reference to ground.", f0)

    live_ids = {b.id for b in buses if live(b.id)}

    # [FS-L2] Only capacitance actually connected to the live network can
    # resonate: a bank with no steps in service, one on a dead island, or an
    # SVC the load flow leaves idle or inductive does not. (A STATCOM is an
    # inductive shunt at harmonic orders — [H3] in harmonics.py.) Capacitive
    # ⇔ the shunt susceptance grows with h, so test Im(Y) at two orders.
    def capacitive(c):
        y1 = _shunt_admittance_at_h(c, base_mva, 1.0, svc_q.get(c.id))
        y2 = _shunt_admittance_at_h(c, base_mva, 2.0, svc_q.get(c.id))
        return y2.imag > y1.imag > 0
    has_cap = any(capacitive(c) for bid in live_ids for c in comps_at[bid]
                  if c.type in ("capacitor_bank", "svc", "statcom"))
    if not has_cap:
        warnings.append(
            "No capacitor banks / FACTS shunts in service on the live network "
            "— the scan shows the inductive source/line rise only; parallel "
            "resonance is not expected.")

    # [FS-L6] A generator whose breaker is closed is part of the source
    # impedance even when the load flow leaves it idle (the app's convention:
    # the breaker, not the dispatch mode, decides whether a machine is on
    # line). It raises the short-circuit level and so moves every resonance
    # up — say so, since a standby set is usually off in normal operation.
    if lf is not None:
        idle = [d.source_name for d in (lf.dispatch or [])
                if d.source_type == "generator" and d.role in ("standby", "offline")
                and abs(d.dispatched_mw or 0) < 1e-9 and live(d.bus_id)]
        if idle:
            warnings.append(
                "Generator(s) " + ", ".join(f"'{x}'" for x in idle) + " are "
                "connected but idle in the load flow; they are counted in the "
                "source impedance, which raises the resonant order. Open "
                "their breakers to scan the grid-only case.")

    # Scan-bus selection: requested ids, else every real (non-synthetic) bus.
    scan = [b for b in buses if not _lf.is_synthetic_bus(b.id)
            and not _lf.is_grid_bus(b.id)]
    if bus_ids:
        wanted = set(bus_ids)
        scan = [b for b in scan if b.id in wanted]
        if not scan:
            return _empty_result("None of the requested buses exist in the "
                                 "network.", f0)
    # [FS4] A bus in a sourceless island (behind an open breaker) carries no
    # voltage, so it has no harmonic impedance of interest — a capacitor bank
    # parked there showed a resonance, and could head the results.
    dead = [b for b in scan if not live(b.id)]
    if dead:
        warnings.append(
            "Not scanned — de-energised in the load flow: "
            + ", ".join(str(b.props.get("name", b.id)) for b in dead) + ".")
        scan = [b for b in scan if live(b.id)]
        if not scan:
            return _empty_result("The selected bus is de-energised in the "
                                 "load flow — nothing to scan.", f0, warnings)
    if len(scan) > MAX_SCAN_BUSES:
        warnings.append(
            f"{len(scan)} buses in the network — scanning the first "
            f"{MAX_SCAN_BUSES}; select specific buses to scan the rest.")
        scan = scan[:MAX_SCAN_BUSES]

    def z_matrix(h):
        Yh = _build_yh(chains, shunts, bus_idx, float(h))
        try:
            return np.linalg.inv(Yh)
        except np.linalg.LinAlgError:
            try:
                return np.linalg.inv(Yh + np.eye(n) * 1e-9)
            except np.linalg.LinAlgError:
                return None

    hs = np.arange(1.0, h_max + h_step / 2, h_step)
    curves = {b.id: np.zeros(len(hs)) for b in scan}
    skipped = 0
    for k, h in enumerate(hs):
        Zh = z_matrix(h)
        if Zh is None:
            skipped += 1
            for b in scan:
                curves[b.id][k] = np.nan
            continue
        for b in scan:
            curves[b.id][k] = abs(Zh[bus_idx[b.id], bus_idx[b.id]])
    if skipped:
        warnings.append(f"{skipped} frequency point(s) skipped — singular "
                        "network matrix.")

    bus_results = []
    resonances = []
    rising_at_top = []
    for b in scan:
        v_kv = b.props.get("voltage_kv", 11) or 11
        z_base = (v_kv ** 2) / base_mva
        k_idx = bus_idx[b.id]
        z_pu_curve = np.nan_to_num(curves[b.id], nan=0.0)
        name = str(b.props.get("name", b.id))

        def zkk(h, k_idx=k_idx):
            Zh = z_matrix(h)
            return abs(Zh[k_idx, k_idx]) if Zh is not None else 0.0

        for r in _detect_resonances(hs, z_pu_curve, f0):
            i = r.pop("i")
            h_ref, z_ref = _refine_extremum(zkk, float(hs[i - 1]), float(hs[i + 1]),
                                            r["kind"] == "parallel")
            if (r["kind"] == "parallel") != (z_ref >= z_pu_curve[i]):
                h_ref, z_ref = float(hs[i]), float(z_pu_curve[i])   # never worse
            r.update({
                "h": round(h_ref, 3), "f_hz": round(h_ref * f0, 1),
                "z_ohm": _sig(z_ref * z_base), "z_pu": _sig(z_ref),
                "prominence": round(float(r["prominence"]), 1),
                "bus_id": b.id, "bus_name": name,
            })
            resonances.append(r)
        # [FS-L3] Still climbing at the top of the sweep on a bus that has
        # capacitance in reach: a parallel resonance may sit just above h_max.
        if has_cap and len(hs) > 2 and z_pu_curve[-1] > z_pu_curve[-2] > z_pu_curve[-3] \
                and z_pu_curve[-1] > 2 * z_pu_curve[0]:
            rising_at_top.append(name)
        bus_results.append({
            "id": b.id, "name": name, "voltage_kv": v_kv,
            "z1_ohm": _sig(z_pu_curve[0] * z_base),
            "z_ohm": [_sig(v * z_base) for v in z_pu_curve],
        })
    if rising_at_top:
        warnings.append(
            "|Z| is still rising at h = " + f"{h_max:g}" + " on "
            + ", ".join(rising_at_top) + " — a parallel resonance may lie "
            "above the scanned range; raise the maximum order.")

    # [FS1] Worst amplification first, in PER UNIT: a harmonic current I_h
    # (pu of the study base) raises V_h = Z_pu·I_h, so Z_pu compares buses of
    # different voltage; ohms ranked every MV peak above any LV one (a
    # 400 pu LV peak at the 7th lost to an 18 pu 11 kV peak at the 14th).
    resonances.sort(key=lambda r: (r["kind"] != "parallel", -r["z_pu"]))
    worst = resonances[0] if resonances and resonances[0]["kind"] == "parallel" else None

    return {
        "converged": True,
        "f0_hz": f0,
        "base_mva": base_mva,
        "h_max": h_max,
        "h_step": h_step,
        "h": [round(float(v), 3) for v in hs],
        "buses": bus_results,
        "resonances": resonances,
        "worst_bus_id": worst["bus_id"] if worst else "",
        "worst_bus_name": worst["bus_name"] if worst else "",
        "worst_h": worst["h"] if worst else 0.0,
        "worst_f_hz": worst["f_hz"] if worst else 0.0,
        "worst_z_ohm": worst["z_ohm"] if worst else 0.0,
        "worst_z_pu": worst["z_pu"] if worst else 0.0,
        "method": ("Driving-point impedance sweep Z_kk(h) on the harmonic "
                   "network model (nodal inversion per frequency)"),
        "warnings": warnings,
        "note": "",
    }


def _empty_result(note, f0=50.0, warnings=None):
    return {
        "converged": False, "f0_hz": f0, "h_max": 0.0, "h_step": 0.0,
        "h": [], "buses": [], "resonances": [],
        "worst_bus_id": "", "worst_bus_name": "", "worst_h": 0.0,
        "worst_f_hz": 0.0, "worst_z_ohm": 0.0, "worst_z_pu": 0.0,
        "method": ("Driving-point impedance sweep Z_kk(h) on the harmonic "
                   "network model (nodal inversion per frequency)"),
        "warnings": list(warnings or []), "note": note,
    }
