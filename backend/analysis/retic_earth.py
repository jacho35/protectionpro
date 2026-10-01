"""Reticulation earth-fault loop and earth-conductor (ECC) checks.

For the Reticulation › Demand tab. Every erf is reached from a minisub through
its kiosks' feeder legs and its own service cable; each LV cable carries the
earth conductor the user picked from the cable library (Cu or Al). Two checks
are made along that path, both on the IEC 60364 TN basis:

* **Earth-fault loop / automatic disconnection** (IEC 60364-4-41 §411.4,
  Table 41.1) — Zs = Ze + Σ (R1 + R2 + jX1)·L back to the minisub, with Ze the
  transformer's short-circuit impedance. The prospective earth-fault current
  If = c_min·U0 / |Zs| (c_min = 0.95, IEC 60909-0 §5.3.1: the *minimum*
  current, conductors hot) must clear the minisub's protective device inside
  the permitted time (5 s for distribution circuits — feeders and services —
  by default). The clearing time is read from the same device models the TCC
  and arc-flash studies use (``arcflash._cb_self_clearing_time`` for a breaker,
  ``arcflash._fuse_prearc_time`` × 1.2 for a gG fuse).
* **Earth conductor size** (IEC 60364-5-54) — the chosen conductor must meet
  Table 54.7 (equal to the phase conductor up to 16 mm², 16 mm² to 35 mm²,
  half above; converted by conductivity when the earth is another metal than
  the phase conductor) **or** the §543.1.2 adiabatic size S = √(I²t)/k at the
  *maximum* end-of-leg fault current (c_max = 1.10) and the time the device
  takes to clear it. Either route passes, as the standard allows.

The earthing system is set per minisub (``earthing``: TN-S, TN-C or TN-C-S,
absent ⇒ TN-S) and decides which cables carry a separate earth conductor: TN-S
every LV cable (feeders and services); TN-C none — the PEN conductor is the
return everywhere; TN-C-S the PEN runs the feeders and the earth conductor is
separate at the service cable only. A PEN leg takes its return from the cable's
own neutral (taken as the phase conductor size) and is checked against the
IEC 60364-5-54 §543.4.1 minimum (10 mm² Cu / 16 mm² Al) instead of an ECC.

Protection can be set per kiosk (``device`` on the kiosk, at the head of its
incoming feeder): the device that clears a fault is the nearest one back
towards the minisub, so a kiosk with none inherits the one above it.

Conventions, echoed on every response in ``basis``: the MV network is an ideal
source unless ``mvFaultMVA`` is given; the minisub's single LV device protects
every cable downstream of it (no discrimination with kiosk fuses is modelled);
cable R is the library's operating-temperature value; reactance is the phase
conductor's; the faulted leg is evaluated at its far end. A cable with no earth
chosen is checked with an assumed Table 54.7 conductor of the phase metal and
reported as ``info`` — never a silent pass.
"""

from __future__ import annotations

import math

from .arcflash import (_cb_self_clearing_time, _fuse_prearc_time)
from .cable_sizing import RESISTIVITY
from .db_circuit_check import (C_MAX, C_MIN, K_PE_IN_CABLE, _cond,
                               adiabatic_ecc_mm2, ecc_required_mm2)
from .iec_60364_tables import round_up_to_standard

DEFAULT_U0_V = 230.0
DEFAULT_T_ALLOW_S = 5.0          # IEC 60364-4-41 Table 41.1: distribution circuits
ADIABATIC_LIMIT_S = 5.0          # §543.1.2 validity limit
_RANK = {"pass": 0, "info": 1, "fail": 2}
# IEC 60364-5-54 §543.4.1: minimum section of a PEN conductor.
PEN_MIN_MM2 = {"Cu": 10.0, "Al": 16.0}


def _num(v, default=0.0):
    try:
        n = float(v)
    except (TypeError, ValueError):
        return default
    return default if math.isnan(n) or math.isinf(n) else n


def _worst(*statuses):
    best = "pass"
    for s in statuses:
        if s and _RANK.get(s, 0) > _RANK[best]:
            best = s
    return best


def _round(v, places=3):
    return None if v is None else round(v, places)


# ── Source impedance ─────────────────────────────────────────────────────

def _source_z(minisub):
    """Ze (complex Ω at LV) of a minisub: the transformer's impedance, plus an
    optional MV network behind it. None when no transformer is known."""
    tx = (minisub or {}).get("tx") or {}
    kva, zpct, xr = _num(tx.get("kva")), _num(tx.get("zPercent")), _num(tx.get("xrRatio"), 5.0)
    v_lv = _num(tx.get("vLvKv"), 0.42) * 1000.0
    if kva <= 0 or zpct <= 0 or v_lv <= 0:
        return None
    z_ohm = (zpct / 100.0) * v_lv * v_lv / (kva * 1000.0)
    r = z_ohm / math.sqrt(1.0 + xr * xr)
    z = complex(r, r * xr)
    mv = _num((minisub or {}).get("mvFaultMVA"))
    if mv > 0:
        zq = (v_lv * v_lv) / (mv * 1e6)
        z += complex(zq / math.sqrt(1.0 + 100.0), zq * 10.0 / math.sqrt(1.0 + 100.0))  # X/R 10
    return z


# ── Protective device ────────────────────────────────────────────────────

def _clearing_time(device, current_a):
    """Seconds for the minisub device to clear ``current_a`` (inf = never)."""
    if not device or current_a <= 0:
        return math.inf
    if device.get("kind") == "fuse":
        rating = _num((device.get("props") or {}).get("rated_current_a"))
        t = _fuse_prearc_time(rating, current_a)
        if t is None:
            return math.inf
        return t if t == math.inf else max(t * 1.2, 0.004)    # total clearing, TCC convention
    if device.get("kind") == "cb":
        t = _cb_self_clearing_time(device.get("props") or {}, current_a)
        return math.inf if t >= 10000.0 else t
    return math.inf


def _device_rating_a(device):
    p = (device or {}).get("props") or {}
    return _num(p.get("rated_current_a")) if (device or {}).get("kind") == "fuse" else _num(p.get("trip_rating_a"))


def _min_operating_current(device, t_allow):
    """Smallest current that clears the device within ``t_allow`` (log-space
    bisection; the clearing-time curve falls with current). None if it never
    does below 1000×In."""
    rating = _device_rating_a(device)
    if not device or rating <= 0:
        return None
    lo, hi = rating * 0.5, rating * 1000.0
    if _clearing_time(device, hi) > t_allow:
        return None
    for _ in range(60):
        mid = math.sqrt(lo * hi)
        if _clearing_time(device, mid) <= t_allow:
            hi = mid
        else:
            lo = mid
    return hi


# ── Conductors ───────────────────────────────────────────────────────────

def _cable(c):
    """Normalise a frontend-resolved cable: size, metal, insulation, r, x /km."""
    if not c:
        return None
    return {
        "name": c.get("name") or "",
        "size": _num(c.get("size_mm2")),
        "metal": _cond(c.get("conductor")),
        "ins": "XLPE" if str(c.get("insulation", "PVC")).upper() == "XLPE" else "PVC",
        "r": _num(c.get("r_per_km")),
        "x": _num(c.get("x_per_km")),
    }


def _r_per_km(c):
    """Library operating-temperature R, or ρ/S if the entry has none."""
    if c["r"] > 0:
        return c["r"]
    return RESISTIVITY[c["metal"]] * 1000.0 / c["size"] if c["size"] > 0 else 0.0


def _table_ecc_mm2(phase, earth_metal):
    """IEC 60364-5-54 Table 54.7 size for ``phase`` in ``earth_metal``: the
    copper-equivalent section scaled by conductivity when the metals differ."""
    base = ecc_required_mm2(phase["size"])
    if base is None:
        return None
    if earth_metal != phase["metal"]:
        base = round_up_to_standard(base * RESISTIVITY[earth_metal] / RESISTIVITY[phase["metal"]]) or base
    return float(base)


def _leg_ecc(leg, z_end, device):
    """ECC verdict for one leg, from the loop impedance ``z_end`` at its far end."""
    phase, earth, assumed = leg["phase"], leg["earth"], leg["assumed"]
    if leg.get("pen"):
        need = PEN_MIN_MM2[phase["metal"]]
        ok = phase["size"] >= need - 1e-9
        return {"pen": True, "assumed": False, "sizeMm2": phase["size"], "metal": phase["metal"],
                "minMm2": need, "status": "pass" if ok else "fail",
                "note": (f"PEN conductor {phase['size']:g} mm² {phase['metal']} meets the {need:g} mm² minimum (§543.4.1)."
                         if ok else
                         f"PEN conductor {phase['size']:g} mm² {phase['metal']} is below the {need:g} mm² minimum for a combined "
                         f"neutral/earth conductor (IEC 60364-5-54 §543.4.1).")}
    out = {"given": {"name": earth["name"], "sizeMm2": earth["size"], "metal": earth["metal"]}
           if not assumed else None}
    table = _table_ecc_mm2(phase, earth["metal"])
    z = abs(z_end)
    i_max = C_MAX * leg["u0"] / z if z > 0 else 0.0
    t = _clearing_time(device, i_max)
    capped = t > ADIABATIC_LIMIT_S
    t_use = min(t, ADIABATIC_LIMIT_S) if math.isfinite(t) else ADIABATIC_LIMIT_S
    k = K_PE_IN_CABLE[(earth["metal"], earth["ins"])]
    ad = adiabatic_ecc_mm2(i_max, t_use, k) if device else None
    size = earth["size"]
    ok_table = table is not None and size >= table - 1e-9
    ok_adiabatic = ad is not None and size >= ad - 1e-9 and not capped
    out.update({
        "assumed": assumed,
        "sizeMm2": size, "metal": earth["metal"],
        "tableMm2": table,
        "adiabaticMm2": _round(ad, 2),
        "adiabaticI": _round(i_max, 0), "adiabaticT": _round(t_use, 3), "k": k,
        "byTable": bool(ok_table), "byAdiabatic": bool(ok_adiabatic),
    })
    if table is None:
        status, note = "info", "Phase conductor size not recognised — Table 54.7 not applied."
    elif ok_table or ok_adiabatic:
        status = "info" if assumed else "pass"
        note = (f"Assumed {size:g} mm² {earth['metal']} (no earth cable chosen) — select one."
                if assumed else
                f"{size:g} mm² {earth['metal']} meets " + ("Table 54.7" if ok_table else "the §543.1.2 adiabatic size") + ".")
    else:
        status = "fail"
        need = round_up_to_standard(min(x for x in (table, ad) if x is not None)) or min(x for x in (table, ad) if x is not None)
        note = (f"{size:g} mm² {earth['metal']} is below Table 54.7 ({table:g} mm²)"
                + (f" and the adiabatic size ({ad:.1f} mm²)" if ad is not None else "")
                + f" — use at least {need:g} mm².")
    out["status"], out["note"] = status, note
    return out


# ── Run ──────────────────────────────────────────────────────────────────

def _loop_status(device, z_total, u0, t_allow):
    """(status, If_min, t, Ia, Zs_max, note) for the loop impedance at an end."""
    zs = abs(z_total)
    i_min = C_MIN * u0 / zs if zs > 0 else 0.0
    if not device:
        return "info", i_min, None, None, None, "Select the minisub's protective device to check disconnection."
    t = _clearing_time(device, i_min)
    ia = _min_operating_current(device, t_allow)
    zs_max = (C_MIN * u0 / ia) if ia else None
    ok = t <= t_allow
    if ok:
        note = f"Clears in {t:.2f} s at {i_min:.0f} A (limit {t_allow:g} s)."
    elif math.isinf(t):
        note = f"Fault current {i_min:.0f} A is below the device's operating range — it will not clear."
    else:
        note = f"Clears in {t:.1f} s at {i_min:.0f} A — over the {t_allow:g} s limit."
    return ("pass" if ok else "fail"), i_min, (None if math.isinf(t) else t), ia, zs_max, note


def run_retic_earth_check(req: dict) -> dict:
    s = req.get("settings") or {}
    u0 = _num(s.get("u0"), DEFAULT_U0_V)
    t_allow = _num(s.get("disconnectTimeS"), DEFAULT_T_ALLOW_S)
    minisubs = {m.get("id"): m for m in (req.get("minisubs") or [])}
    kiosks = {k.get("id"): k for k in (req.get("kiosks") or [])}

    def leg_of(cab, earth, length_m, pen=False):
        phase = _cable(cab)
        if not phase or phase["size"] <= 0 or length_m <= 0:
            return None
        e = _cable(earth)
        assumed = e is None or e["size"] <= 0
        if pen:
            # PEN return: the cable's own neutral, taken as the phase conductor size
            e, assumed = dict(phase), False
        elif assumed:
            size = ecc_required_mm2(phase["size"]) or phase["size"]
            e = {"name": "", "size": float(size), "metal": phase["metal"], "ins": phase["ins"],
                 "r": 0.0, "x": 0.0}
        km = length_m / 1000.0
        z = complex((_r_per_km(phase) + _r_per_km(e)) * km, phase["x"] * km)
        return {"phase": phase, "earth": e, "assumed": assumed, "pen": bool(pen), "km": km, "z": z, "u0": u0}

    leg_cache = {}

    def system_of(ms):
        sysm = str((ms or {}).get("earthing") or "TN-S").upper().replace("_", "-")
        return sysm if sysm in ("TN-S", "TN-C", "TN-C-S") else "TN-S"

    def own_leg_of(kid):
        if kid not in leg_cache:
            f = (kiosks[kid].get("feeder") or {})
            ms_id, _chain = kiosk_path(kid)
            ms = minisubs.get(ms_id) or (next(iter(minisubs.values())) if minisubs else None)
            pen = system_of(ms) in ("TN-C", "TN-C-S")          # PEN along the feeders
            leg_cache[kid] = leg_of(f.get("cable"), f.get("earth"), _num(f.get("lengthM")), pen)
        return leg_cache[kid]

    def device_for(kid, ms):
        """Nearest protective device back towards the minisub (the kiosk's own
        at the head of its incoming feeder, else an upstream kiosk's, else the
        minisub's)."""
        _ms_id, chain = kiosk_path(kid)
        for cid in reversed(chain):
            d = kiosks[cid].get("device")
            if d:
                return d
        return (ms or {}).get("device")

    def kiosk_path(kid):
        """(minisub id, [kiosk ids minisub→kiosk]) following fedFrom; cycle-safe."""
        chain, seen, cur = [], set(), kid
        while cur in kiosks and cur not in seen:
            seen.add(cur)
            chain.append(cur)
            cur = kiosks[cur].get("fedFrom") or "source"
        chain.reverse()
        return cur, chain

    out_kiosks, worst_all = [], "pass"
    for kid, k in kiosks.items():
        ms_id, chain = kiosk_path(kid)
        ms = minisubs.get(ms_id) or (next(iter(minisubs.values())) if minisubs else None)
        device = device_for(kid, ms)
        ze = _source_z(ms)
        sysm = system_of(ms)
        res = {"kioskId": kid, "name": k.get("name", ""), "minisubId": (ms or {}).get("id"),
               "earthing": sysm, "device": (device or {}).get("name")}
        own_leg = own_leg_of(kid)
        if ze is None:
            res.update({"loop": {"status": "info", "note": "The minisub has no transformer yet (no demand to size one)."},
                        "ecc": None, "erfs": []})
            out_kiosks.append(res)
            worst_all = _worst(worst_all, "info")
            continue
        z = ze
        for cid in chain:
            lg = own_leg_of(cid)
            if lg:
                z += lg["z"]
        # kiosk end
        if own_leg is not None:
            st, i_min, t, ia, zs_max, note = _loop_status(device, z, u0, t_allow)
            res["loop"] = {"status": st, "zsOhm": _round(abs(z)), "ifA": _round(i_min, 0), "tS": _round(t, 3),
                           "iaA": _round(ia, 0), "zsMaxOhm": _round(zs_max), "tAllowS": t_allow, "note": note}
            res["ecc"] = _leg_ecc(own_leg, z, device)
        else:
            res["loop"] = {"status": "info", "note": "No feeder cable or length — enter them to check this feeder."}
            res["ecc"] = None
        # erfs
        erf_out = []
        for e in (k.get("erfs") or []):
            svc = e.get("service") or {}
            sleg = leg_of(svc.get("cable"), svc.get("earth"), _num(svc.get("lengthM")), sysm == "TN-C")
            er = {"erfId": e.get("id"), "erfNumber": e.get("erfNumber", "")}
            if sleg is None:
                er["loop"] = {"status": "info", "note": "No service cable or length — enter them to check this erf."}
                er["ecc"] = None
            else:
                z_erf = z + sleg["z"]
                st, i_min, t, ia, zs_max, note = _loop_status(device, z_erf, u0, t_allow)
                er["loop"] = {"status": st, "zsOhm": _round(abs(z_erf)), "ifA": _round(i_min, 0), "tS": _round(t, 3),
                              "iaA": _round(ia, 0), "zsMaxOhm": _round(zs_max), "tAllowS": t_allow, "note": note}
                er["ecc"] = _leg_ecc(sleg, z_erf, device)
            erf_out.append(er)
            worst_all = _worst(worst_all, er["loop"]["status"], (er["ecc"] or {}).get("status"))
        res["erfs"] = erf_out
        worst_all = _worst(worst_all, res["loop"]["status"], (res["ecc"] or {}).get("status"))
        out_kiosks.append(res)

    ms_out = []
    for mid, m in minisubs.items():
        ze = _source_z(m)
        ms_out.append({"minisubId": mid, "name": m.get("name", ""),
                       "zeOhm": _round(abs(ze)) if ze is not None else None,
                       "device": (m.get("device") or {}).get("name"),
                       "earthing": system_of(m),
                       "status": "info" if (ze is None or not m.get("device")) else "pass"})

    counts = {"pass": 0, "info": 0, "fail": 0}
    for k in out_kiosks:
        for item in [k["loop"], k["ecc"]] + [x for e in k["erfs"] for x in (e["loop"], e["ecc"])]:
            if item:
                counts[item["status"]] = counts.get(item["status"], 0) + 1
    return {
        "status": worst_all, "counts": counts,
        "minisubs": ms_out, "kiosks": out_kiosks,
        "basis": [
            f"TN system, U0 = {u0:g} V; minimum fault current c_min = {C_MIN} (IEC 60909-0 §5.3.1), conductors at operating temperature.",
            f"Disconnection within {t_allow:g} s (IEC 60364-4-41 Table 41.1, distribution circuits) by the nearest protective device back to the minisub (a kiosk's own, else inherited); no discrimination between devices in series is checked.",
            "Earthing per minisub: TN-S separate earth conductor on every LV cable; TN-C PEN throughout (no ECC; PEN minimum 10 mm² Cu / 16 mm² Al); TN-C-S PEN on the feeders, separate earth conductor on the service cables only.",
            "Ze is the transformer's short-circuit impedance on its own rated base; the MV network is an ideal source unless a fault level is given.",
            "ECC: IEC 60364-5-54 Table 54.7 (converted by conductivity for another metal) or the §543.1.2 adiabatic size at c_max = 1.10 and the device's clearing time, k from Table 54.3; the leg is evaluated at its far end.",
        ],
    }
