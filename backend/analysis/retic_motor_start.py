"""Reticulation motor starting check (Demand tab).

The same checks as the static Motor Starting study (``motor_starting.py``), on
the radial supply Demand already describes: minisub transformer → kiosk
feeder legs → the motor's own supply cable. The frontend resolves every
library reference to plain numbers (as for ``retic_earth``).

Per motor (a custom load of a "motor" type on the site plan):

* starting current and kVA from the nameplate (FLC × locked-rotor multiple ×
  the starter's factor, ``starting_current_xflc``), at the bus voltage
  (``bus_voltage_ratio``, [MG9]);
* the starting load as the static study models it ([N1]): a constant
  impedance for DOL / star-delta / autotransformer, constant current for a
  soft starter, constant power for a VFD, solved behind the Thevenin impedance
  with ``_solve_start_v``;
* locked-rotor power factor from the fitted nameplate model ([N3]);
* acceptance as in the static study: terminal voltage ≥ 0.80 p.u., the motor's
  torque above the load torque all the way up (``_torque_shortfall``), voltage
  dip at the other boards on the supply path ≤ 15 % (warning), ≤ 10 % at the
  boards that carry consumers (warning).

Basis: the MV network is an ideal source unless ``mvFaultMVA`` is given; the
pre-start voltage is 1.0 p.u. at the minisub LV bus (the running-demand voltage
drop is not added); cable R is the library operating-temperature value.
"""

from __future__ import annotations

import math
from types import SimpleNamespace

from .motor_starting import (VFD_SUPPLY_PF, _STARTING_METHODS, _locked_rotor_pf,
                             _nameplate_unit, _solve_start_v, _torque_shortfall,
                             bus_voltage_ratio, starting_current_xflc)

MIN_TERMINAL_PU = 0.80
MAX_BOARD_DIP_PCT = 15.0
MAX_CONSUMER_DIP_PCT = 10.0

_METHOD_KEYS = {
    "dol": "dol", "star-delta": "star_delta", "star_delta": "star_delta",
    "autotransformer": "autotransformer", "soft starter": "soft_starter",
    "soft_starter": "soft_starter", "vfd": "vfd",
}


def _num(v, default=0.0):
    try:
        f = float(v)
        return f if math.isfinite(f) else default
    except (TypeError, ValueError):
        return default


def _tx_z(minisub):
    """Source impedance (Ω at LV): transformer plus an optional MV network."""
    tx = (minisub or {}).get("tx") or {}
    kva, zpct, xr = _num(tx.get("kva")), _num(tx.get("zPercent")), _num(tx.get("xrRatio"), 5.0)
    v_lv = _num(tx.get("vLvKv"), 0.42) * 1000.0
    if kva <= 0 or zpct <= 0 or v_lv <= 0:
        return None, v_lv / 1000.0 if v_lv > 0 else 0.4
    z_ohm = (zpct / 100.0) * v_lv * v_lv / (kva * 1000.0)
    r = z_ohm / math.sqrt(1.0 + xr * xr)
    z = complex(r, r * xr)
    mv = _num((minisub or {}).get("mvFaultMVA"))
    if mv > 0:
        zq = (v_lv * v_lv) / (mv * 1e6)
        z += complex(zq / math.sqrt(101.0), zq * 10.0 / math.sqrt(101.0))
    return z, v_lv / 1000.0


def _leg_z(cable, length_m):
    if not cable or not length_m:
        return 0j
    return complex(_num(cable.get("r_per_km")), _num(cable.get("x_per_km"))) * (length_m / 1000.0)


def _path(supply_id, kiosks, minisubs):
    """[(label, impedance Ω, has_consumers)] from the minisub to the board the
    motor hangs on, plus the minisub row. Cycle-guarded."""
    by_k = {k["id"]: k for k in kiosks}
    ms_by = {m["id"]: m for m in minisubs}
    legs, cur, seen = [], supply_id, set()
    while cur in by_k and cur not in seen:
        seen.add(cur)
        k = by_k[cur]
        f = k.get("feeder") or {}
        legs.append((k.get("name") or cur, _leg_z(f.get("cable"), _num(f.get("lengthM"))), bool(k.get("hasConsumers", True))))
        cur = k.get("fedFrom") or "source"
    legs.reverse()
    ms = ms_by.get(cur) or (minisubs[0] if minisubs else {})
    return ms, legs


def _check_motor(m, kiosks, minisubs, freq):
    name = m.get("name") or m.get("id")
    base = {"id": m.get("id"), "name": name, "supplyId": m.get("supplyId"),
            "supplyName": m.get("supplyName") or ""}
    kw = _num(m.get("kw"))
    volt = _num(m.get("volt"), 400.0)
    pf = _num(m.get("pf"), 0.85)
    eff = _num(m.get("eff"), 0.93)
    if int(_num(m.get("phases"), 3)) != 3:
        return {**base, "status": "info", "issues": [],
                "note": "Single-phase motors are not checked here — use a three-phase supply or the single-line Motor Starting study."}
    if kw <= 0 or volt <= 0 or pf <= 0 or eff <= 0:
        return {**base, "status": "info", "issues": [], "note": "Rating incomplete (kW, voltage, pf, efficiency)."}

    ms, legs = _path(m.get("supplyId"), kiosks, minisubs)
    z_src, bus_kv = _tx_z(ms)
    if z_src is None:
        return {**base, "status": "info", "issues": [],
                "note": "No transformer selected for the feeding minisub — pick one in Demand so the supply impedance is known."}

    method_key = _METHOD_KEYS.get(str(m.get("method", "DOL")).strip().lower(), "dol")
    lrc = _num(m.get("lrc"), 6.0) or 6.0
    mp = {"starting_method": method_key, "ss_current_limit_xflc": _num(m.get("ssLimit"), 3.5) or 3.5,
          "locked_rotor_pf": _num(m.get("lrPf")), "rated_kw": kw, "voltage_kv": volt / 1000.0,
          "efficiency": eff, "power_factor": pf, "locked_rotor_current": lrc,
          "locked_rotor_torque_pct": _num(m.get("lrtPct"), 150.0) or 150.0,
          "rated_speed_rpm": _num(m.get("rpm")), "name": name}
    motor_kv = volt / 1000.0
    flc_a = kw / (math.sqrt(3) * motor_kv * eff * pf)
    mult, label = starting_current_xflc(mp, lrc)
    vr = bus_kv / motor_kv if (bus_kv > 0 and motor_kv > 0) else 1.0
    start_a = flc_a * mult * vr
    s_start = motor_kv * vr * start_a * math.sqrt(3) / 1000.0           # MVA
    s_dol = motor_kv * vr * (flc_a * lrc * vr) * math.sqrt(3) / 1000.0

    # Nameplate model (stub bus + motor so the dynamic study's fit can be reused).
    motor = SimpleNamespace(id="m", type="motor_induction", props=mp)
    bus = SimpleNamespace(id="b", type="bus", props={"voltage_kv": bus_kv, "name": "Board"})
    proj = SimpleNamespace(baseMVA=1.0, frequency=freq, components=[], wires=[])
    unit = _nameplate_unit(motor, {"m": motor, "b": bus}, {"m": [("b", None)], "b": [("m", None)]}, proj)
    start_pf = _locked_rotor_pf(mp, unit)
    if method_key == "vfd":
        start_pf = VFD_SUPPLY_PF
    sin_pf = math.sqrt(max(0.0, 1.0 - start_pf ** 2))

    kind = {"soft_starter": "i", "vfd": "pq"}.get(method_key, "z")
    z_base = bus_kv * bus_kv / 1.0                       # Ω on 1 MVA, bus kV
    z_motor_cable = _leg_z(m.get("cable"), _num(m.get("lengthM")))
    z_board = z_src + sum((z for _, z, _ in legs), 0j)   # minisub bus → motor's board
    z_th = (z_board + z_motor_cable) / z_base
    s0 = s_start / 1.0 * complex(start_pf, sin_pf)
    v_pre = 1.0
    vt = _solve_start_v(kind, v_pre, z_th, s0)
    collapse = vt is None
    vt = vt or 0.0
    v_draw = vt if vt > 0 else v_pre
    s_eff = {"z": s0 * v_draw ** 2, "i": s0 * v_draw}.get(kind, s0)
    i_pu = (s_eff.conjugate() / v_draw) if v_draw > 0 else 0j

    # Voltage at each board along the path (V_pre minus Z·I to that board).
    dips, run = [], z_src
    nodes = [("Minisub LV bus", run, True)]
    for lab, z, cons in legs:
        run = run + z
        nodes.append((lab, run, cons))
    board_dip = 0.0
    consumer_dip = 0.0
    bus_dips = {}
    for i, (lab, z, cons) in enumerate(nodes):
        v = abs(complex(v_pre, 0) - (z / z_base) * i_pu) if not collapse else 0.0
        dip = max(0.0, (v_pre - v) / v_pre * 100.0)
        bus_dips[lab] = round(dip, 2)
        board_dip = max(board_dip, dip)
        if cons:
            consumer_dip = max(consumer_dip, dip)

    torque_fail = None
    if unit is not None and not collapse:
        v_dol = _solve_start_v("z", v_pre, z_th, s_dol * complex(start_pf, sin_pf))
        torque_fail = _torque_shortfall(unit, vt, v_dol or 0.0)

    voltage_ok = (not collapse) and vt >= MIN_TERMINAL_PU
    will_start = voltage_ok and torque_fail is None
    issues = []
    if collapse:
        issues.append("No starting solution — the supply is too weak for this start (voltage collapse).")
    elif not voltage_ok:
        issues.append(f"Terminal voltage {vt:.3f} p.u. < {MIN_TERMINAL_PU:.2f} p.u. — motor may not accelerate")
    if torque_fail is not None:
        issues.append(f"Motor torque at the starting voltage falls below the load torque at {torque_fail:.0f}% speed — it may not run up ({label}; voltage held at its locked-rotor value, conservative). Check with Dynamic Motor Starting.")
    if board_dip > MAX_BOARD_DIP_PCT:
        issues.append(f"Voltage dip {board_dip:.1f}% > {MAX_BOARD_DIP_PCT:.0f}% on the supply path")
    if consumer_dip > MAX_CONSUMER_DIP_PCT:
        issues.append(f"Voltage dip {consumer_dip:.1f}% > {MAX_CONSUMER_DIP_PCT:.0f}% at boards that carry consumers")
    status = "fail" if not will_start else ("warning" if issues else "pass")
    return {**base, "status": status, "issues": issues, "startingMethod": label,
            "startCurrentA": round(start_a, 1), "startKVA": round(s_start * 1000.0, 1),
            "terminalVoltagePu": round(vt, 4), "willStart": will_start,
            "maxDipPct": round(board_dip, 2), "busDips": bus_dips, "collapse": collapse,
            "torqueOk": None if unit is None else torque_fail is None,
            "startPf": round(start_pf, 3), "model": {"z": "constant impedance", "i": "constant current", "pq": "constant power"}[kind]}


def run_retic_motor_start(data: dict) -> dict:
    kiosks = data.get("kiosks") or []
    minisubs = data.get("minisubs") or []
    freq = _num((data.get("settings") or {}).get("frequency"), 50.0) or 50.0
    motors = [_check_motor(m, kiosks, minisubs, freq) for m in (data.get("motors") or [])]
    return {
        "motors": motors,
        "basis": ("Same checks as the Motor Starting study (terminal voltage ≥ 0.80 p.u., torque above the load "
                  "torque, dip ≤ 15 % / 10 % on the supply path) on the minisub transformer and kiosk feeder cables. "
                  "The MV network is an ideal source unless a fault level is given; pre-start voltage is 1.0 p.u."),
    }
