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
bus's own voltage base.
"""

from __future__ import annotations

import math
import numpy as np

from . import loadflow as _lf
from .harmonics import _branch_chains, _shunt_admittance_at_h, _build_yh

# Peak/dip detection: a local extremum is a resonance only when it stands out
# from the valley floor (or ceiling) around it by this ratio — filters the
# gentle inductive rise of a capacitor-free network without missing damped
# real-world peaks.
PARALLEL_PROMINENCE = 2.0
SERIES_PROMINENCE = 2.0
MAX_SCAN_BUSES = 12          # cap the curve payload; scan buses beyond → note


def _detect_resonances(hs, z, f0):
    """Find parallel (peak) and series (dip) resonances in one |Z(h)| curve.

    Prominence is measured against the lowest valley (peaks) / highest ridge
    (dips) between the extremum and the nearer curve end, mirroring the usual
    peak-prominence definition on a smooth curve.
    """
    out = []
    n = len(z)
    for i in range(1, n - 1):
        if z[i] >= z[i - 1] and z[i] > z[i + 1]:
            left = min(z[:i + 1])
            right = min(z[i:])
            floor = max(left, right)
            if floor > 0 and z[i] / floor >= PARALLEL_PROMINENCE:
                out.append({"kind": "parallel", "i": i,
                            "prominence": z[i] / floor})
        elif z[i] <= z[i - 1] and z[i] < z[i + 1]:
            left = max(z[:i + 1])
            right = max(z[i:])
            ceil = min(left, right)
            if z[i] > 0 and ceil / z[i] >= SERIES_PROMINENCE:
                out.append({"kind": "series", "i": i,
                            "prominence": ceil / z[i]})
    for r in out:
        r["h"] = round(float(hs[r["i"]]), 3)
        r["f_hz"] = round(float(hs[r["i"]]) * f0, 1)
        r["z_ohm"] = round(float(z[r["i"]]), 4)
        r["prominence"] = round(float(r["prominence"]), 1)
        del r["i"]
    return out


def run_frequency_scan(project, bus_ids=None, h_max: float = 25.0,
                       h_step: float = 0.05):
    """Run the impedance-vs-frequency sweep. Returns a dict matching
    FrequencyScanResults."""
    base_mva = project.baseMVA or 100.0
    f0 = float(project.frequency or 50)
    h_max = max(2.0, min(100.0, float(h_max or 25.0)))
    h_step = max(0.01, min(1.0, float(h_step or 0.05)))
    project = _lf.insert_implicit_load_buses(project)

    chains, buses, bus_idx, adjacency, components, bus_of = \
        _branch_chains(project, base_mva)
    n = len(buses)
    warnings = []
    if n == 0:
        return _empty_result("No AC buses in the network.")

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
            acc = complex(0, 0)
            for comp in comps_at[b.id]:
                acc += _shunt_admittance_at_h(comp, base_mva, h)
            if acc != 0:
                out[b.id] = acc
        return out

    if not shunts(1.0):
        return _empty_result(
            "No grounded shunt elements (source, machine, load or capacitor) "
            "— the impedance scan has no reference to ground.")

    has_cap = any(c.type in ("capacitor_bank", "svc", "statcom")
                  for c in project.components)
    if not has_cap:
        warnings.append(
            "No capacitor banks / FACTS shunts in the network — the scan "
            "shows the inductive source/line rise only; parallel resonance "
            "is not expected.")

    # Scan-bus selection: requested ids, else every real (non-synthetic) bus.
    scan = [b for b in buses if not _lf.is_synthetic_bus(b.id)
            and not _lf.is_grid_bus(b.id)]
    if bus_ids:
        wanted = set(bus_ids)
        scan = [b for b in scan if b.id in wanted]
        if not scan:
            return _empty_result("None of the requested buses exist in the "
                                 "network.")
    if len(scan) > MAX_SCAN_BUSES:
        warnings.append(
            f"{len(scan)} buses in the network — scanning the first "
            f"{MAX_SCAN_BUSES}; select specific buses to scan the rest.")
        scan = scan[:MAX_SCAN_BUSES]

    hs = np.arange(1.0, h_max + h_step / 2, h_step)
    curves = {b.id: np.zeros(len(hs)) for b in scan}
    skipped = 0
    for k, h in enumerate(hs):
        Yh = _build_yh(chains, shunts, bus_idx, float(h))
        try:
            Zh = np.linalg.inv(Yh)
        except np.linalg.LinAlgError:
            try:
                Zh = np.linalg.inv(Yh + np.eye(n) * 1e-9)
            except np.linalg.LinAlgError:
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
    for b in scan:
        v_kv = b.props.get("voltage_kv", 11) or 11
        z_base = (v_kv ** 2) / base_mva
        z_ohm = np.nan_to_num(curves[b.id] * z_base, nan=0.0)
        name = str(b.props.get("name", b.id))
        found = _detect_resonances(hs, z_ohm, f0)
        for r in found:
            r["bus_id"] = b.id
            r["bus_name"] = name
            r["z_pu"] = round(r["z_ohm"] / z_base, 4) if z_base > 0 else 0.0
        resonances.extend(found)
        bus_results.append({
            "id": b.id, "name": name, "voltage_kv": v_kv,
            "z1_ohm": round(float(z_ohm[0]), 4),
            "z_ohm": [round(float(v), 5) for v in z_ohm],
        })

    # Worst amplification first: parallel peaks by driving-point ohms.
    resonances.sort(key=lambda r: (r["kind"] != "parallel", -r["z_ohm"]))
    worst = resonances[0] if resonances and resonances[0]["kind"] == "parallel" else None

    return {
        "converged": True,
        "f0_hz": f0,
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
        "method": ("Driving-point impedance sweep Z_kk(h) on the harmonic "
                   "network model (nodal inversion per frequency)"),
        "warnings": warnings,
        "note": "",
    }


def _empty_result(note):
    return {
        "converged": False, "f0_hz": 50.0, "h_max": 0.0, "h_step": 0.0,
        "h": [], "buses": [], "resonances": [],
        "worst_bus_id": "", "worst_bus_name": "", "worst_h": 0.0,
        "worst_f_hz": 0.0, "worst_z_ohm": 0.0,
        "method": ("Driving-point impedance sweep Z_kk(h) on the harmonic "
                   "network model (nodal inversion per frequency)"),
        "warnings": [], "note": note,
    }
