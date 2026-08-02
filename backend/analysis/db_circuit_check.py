"""Per-way cable check for distribution-board circuit schedules.

``cable_sizing.run_cable_sizing`` only ever iterates ``type == "cable"``
components on the single-line diagram — it never sees
``distribution_board.props.circuits``. Board ways therefore had no derated
ampacity, no voltage drop, no earth-conductor sizing and no earth-fault loop
check; the only validation was a base (undegraded) ampacity-vs-breaker lookup
in the frontend editor.

This engine closes that gap. For every way of every board it evaluates:

* **Ampacity / coordination** — derated Iz from IEC 60364-5-52
  (:mod:`iec_60364_tables`) and the IEC 60364-4-43 §433.1 chain Ib <= In <= Iz.
* **Voltage drop** — over the way's own ``cable_m``, with the single-phase
  two-conductor loop handled separately from the three-phase case (the
  distinction ``cable_sizing.py``'s per-phase formula does not make), plus a
  cumulative figure including upstream drop when a load flow is available.
* **ECC** — earth continuity conductor size against the IEC 60364-5-54
  Table 54.7 / SANS 10142-1 selection rule.
* **Zs** — earth-fault loop impedance against the breaker's magnetic trip, so
  disconnection happens inside the IEC 60364-4-41 Table 41.1 time; an RCD on
  the way is accepted as the alternative compliant route.

Conventions, stated once here and echoed on every response in ``basis``:

* Disconnection is verified on the **minimum**-current basis (IEC 60909-0
  §5.3.1: c_min = 0.95, conductors at operating temperature). This matches the
  ``[PS-3]`` convention already documented in ``frontend/js/compliance.js``;
  a maximum-current basis overstates the fault current and passes circuits the
  standard fails.
* Magnetic trip uses the **upper** limit of each IEC 60898-1 band
  (B 5x, C 10x, D 20x In) — the current at which instantaneous operation is
  guaranteed rather than merely possible.
* Voltage drop is always computed on the lagging-power-factor convention, the
  same direction ``cable_sizing.py`` documents as conservative.
* Where an input is missing the verdict is ``info`` with a note on how to
  supply it — never a silent pass.
"""

from __future__ import annotations

import math

from .cable_sizing import RESISTIVITY, STANDARD_CABLES, _temp_correction
from .iec_60364_tables import (
    IEC_INSTALLATION_METHODS,
    installed_ampacity,
    round_up_to_standard,
)

# IEC 60898-1 instantaneous (magnetic) bands: B = 3-5x, C = 5-10x, D = 10-20x In.
# The UPPER limit is used — that is the current at which the standard
# guarantees instantaneous operation. Mirrors MCB_CURVE_MAGNETIC in
# frontend/js/constants.js.
MCB_CURVE_MAGNETIC = {"B": 5.0, "C": 10.0, "D": 20.0}

# IEC 60909-0 §5.3.1 minimum-fault voltage factor.
C_MIN = 0.95

# IEC 60364-4-41 Table 41.1, TN system, U0 = 230 V.
DISCONNECT_FINAL_S = 0.4        # final circuits <= 32 A
DISCONNECT_DISTRIBUTION_S = 5.0  # distribution circuits / feeders

# IEC 60364-4-41 §411.3.2: conventional touch-voltage limit for the RCD route.
TOUCH_VOLTAGE_LIMIT_V = 50.0

# SANS 10142-1 Cl. 6.6 / IEC 60364-5-52 Annex G. The standard sets a 5 % total
# limit from the point of supply; the customary design split reserves 3 % for
# lighting, which is the stricter (and therefore reported) allowance.
VD_LIMIT_LIGHTING_PCT = 3.0
VD_LIMIT_GENERAL_PCT = 5.0

_LIGHTING_WORDS = ("light", "lamp", "luminaire", "downlight")

_STATUS_RANK = {"pass": 0, "info": 1, "warn": 2, "fail": 3}


def _worst(*statuses):
    """Severity-ordered rollup: fail > warn > info > pass."""
    best = "pass"
    for s in statuses:
        if s and _STATUS_RANK.get(s, 0) > _STATUS_RANK[best]:
            best = s
    return best


def _num(value, default=0.0):
    try:
        n = float(value)
    except (TypeError, ValueError):
        return default
    return default if math.isnan(n) or math.isinf(n) else n


def _lv_cable_row(size_mm2):
    """LV Cu/PVC library row for a size — exact match, else next size up.

    Never credits a smaller entry, so a non-standard size is checked against a
    conductor at least as good as the one drawn.
    """
    lv = [c for c in STANDARD_CABLES
          if c["conductor"] == "Cu" and c["insulation"] == "PVC"
          and c["voltage_kv"] <= 1]
    exact = [c for c in lv if abs(c["size_mm2"] - size_mm2) < 1e-9]
    if exact:
        return exact[0]
    larger = sorted((c for c in lv if c["size_mm2"] > size_mm2),
                    key=lambda c: c["size_mm2"])
    return larger[0] if larger else None


def _r_hot_per_km(size_mm2, conductor="Cu", insulation="PVC"):
    """Conductor resistance (Ohm/km) at operating temperature.

    Falls back to rho/S for sizes the LV library does not carry (notably the
    1.0 mm² earth conductor of a 1.5 mm² twin-and-earth run).
    """
    size = _num(size_mm2)
    if size <= 0:
        return None
    row = _lv_cable_row(size)
    if row is not None and abs(row["size_mm2"] - size) < 1e-9:
        r20 = row["r_per_km"]
    else:
        rho = RESISTIVITY.get(str(conductor).title(), RESISTIVITY["Cu"])
        r20 = rho * 1000.0 / size          # Ohm/km at 20 °C
    return r20 * _temp_correction(conductor, insulation)


def _x_per_km(size_mm2):
    row = _lv_cable_row(_num(size_mm2))
    return row["x_per_km"] if row else 0.08


def ecc_required_mm2(phase_mm2):
    """Minimum ECC per IEC 60364-5-54 Table 54.7 / SANS 10142-1.

    S <= 16 -> S;  16 < S <= 35 -> 16;  S > 35 -> S/2, rounded up to a
    preferred conductor size.
    """
    s = _num(phase_mm2)
    if s <= 0:
        return None
    if s <= 16:
        required = s
    elif s <= 35:
        required = 16.0
    else:
        required = s / 2.0
    return round_up_to_standard(required)


def _is_lighting(description):
    d = str(description or "").lower()
    return any(w in d for w in _LIGHTING_WORDS)


def _board_install(board, req):
    """Installation conditions for a board: request > board prop > default."""
    prop = board.props.get("way_install") or {}
    if not isinstance(prop, dict):
        prop = {}

    def pick(key, default):
        if req.get(key) is not None:
            return req[key]
        if prop.get(key) not in (None, ""):
            return prop[key]
        return default

    method = str(pick("method", "B1"))
    if method not in IEC_INSTALLATION_METHODS:
        method = "B1"
    circuits = pick("circuits", None)
    if circuits in (None, "", 0):
        circuits = max(1, len(board.props.get("circuits") or []))
    return {
        "method": method,
        "ambient_c": _num(pick("ambient_c", 30.0), 30.0),
        "grouping": str(pick("grouping", "bunched")),
        "circuits": max(1, int(_num(circuits, 1))),
        "conductor": str(pick("conductor", "Cu")),
        "insulation": str(pick("insulation", "PVC")),
        "soil_kmw": pick("soil_kmw", None),
        "depth_m": pick("depth_m", None),
    }


def _way_current_a(way, v_ll):
    """Diversified design current Ib for a way.

    Mirrors ``DBSchedule._wayCurrentA`` (frontend), but referred to the board's
    own nominal voltage rather than a hard-coded 230/400 V pair. A feeder way
    carries the downstream board's demand, already computed by the plan sync.
    """
    va = _num(way.get("load_va")) * (_num(way.get("demand_factor"), 1.0) or 1.0)
    is_3p = way.get("poles") == "3P" or way.get("phase") == "RWB"
    if is_3p:
        ib = va / (math.sqrt(3) * v_ll) if v_ll > 0 else 0.0
    else:
        v_ph = v_ll / math.sqrt(3)
        ib = va / v_ph if v_ph > 0 else 0.0
    if way.get("type") == "feeder_db":
        ib = max(ib, _num(way.get("downstream_a")))
    return ib


# ─── Supply-side earth loop impedance ─────────────────────────────────────

def _thevenin_zs_ohm(project, board_id, v_ll):
    """Earth-loop impedance looking back from a board, in ohms.

    For a TN single-line-to-ground fault ``Ik1 = sqrt(3)·c·Un/|Z1+Z2+Z0|``, and
    the loop impedance the standard means is ``Zs = U0/Ik1``. Substituting
    ``U0 = Un/sqrt(3)`` gives ``Zs = |Z1+Z2+Z0|/3`` exactly — so the sequence
    sum is used directly rather than round-tripping through a reported current.
    """
    try:
        from .fault import thevenin_sequence_at_bus
        z1, z2, z0 = thevenin_sequence_at_bus(
            project, board_id, c=C_MIN, exclude_motor_paths=True)
    except Exception:
        return None, None
    if z1 is None or z0 is None:
        return None, None
    # fault.py returns complex(1e10, 0) for "no zero-sequence return path".
    if abs(z0) >= 1e9:
        return None, "no_earth_return"
    base_mva = _num(getattr(project, "baseMVA", 100.0), 100.0) or 100.0
    z_base = (v_ll / 1000.0) ** 2 / base_mva
    zs = abs(z1 + z2 + z0) / 3.0 * z_base
    if not math.isfinite(zs) or zs <= 0:
        return None, None
    return zs, None


def _board_voltage_pu(board, bus_v_pu, project):
    """Solved p.u. voltage at the board's own electrical node.

    A board wired straight onto a busbar is collapsed into that bus by the load
    flow (they are the same node), so the board id may not be a key in the
    result. Fall back to a directly-wired ``bus`` neighbour.
    """
    if board.id in bus_v_pu:
        return bus_v_pu[board.id]
    by_id = {c.id: c for c in project.components}
    for w in project.wires:
        other = None
        if w.fromComponent == board.id:
            other = w.toComponent
        elif w.toComponent == board.id:
            other = w.fromComponent
        if other and other in bus_v_pu and by_id.get(other) is not None \
                and by_id[other].type in ("bus", "distribution_board"):
            return bus_v_pu[other]
    return None


def _feeder_parent_map(boards):
    """child_board_id -> (parent_board, feeder_way) via ``feedsDbId``.

    Lets a board that is only drawn in the Plan workspace (no SLD wiring)
    inherit its supply impedance from the board that feeds it.
    """
    parents = {}
    for b in boards:
        for way in (b.props.get("circuits") or []):
            child = way.get("feedsDbId")
            if child:
                parents[child] = (b, way)
    return parents


def _resolve_supply_impedance(project, boards, req_default_ze):
    """Per-board ``(zs_ohm, basis)``, chaining feeders and cycle-guarded."""
    resolved = {}
    parents = _feeder_parent_map(boards)
    by_id = {b.id: b for b in boards}

    def board_v_ll(board):
        return _num(board.props.get("voltage_kv"), 0.4) * 1000.0

    def resolve(board_id, seen):
        if board_id in resolved:
            return resolved[board_id]
        if board_id in seen:                      # cyclic feedsDbId — give up
            resolved[board_id] = (None, "cycle")
            return resolved[board_id]
        seen.add(board_id)
        board = by_id[board_id]
        v_ll = board_v_ll(board)

        declared = board.props.get("ze_ohm")
        if declared not in (None, ""):
            out = (_num(declared), "declared")
            resolved[board_id] = out
            return out

        zs, note = _thevenin_zs_ohm(project, board_id, v_ll)
        if zs is not None:
            out = (zs, "thevenin")
            resolved[board_id] = out
            return out

        parent = parents.get(board_id)
        if parent is not None:
            p_board, p_way = parent
            p_zs, _p_basis = resolve(p_board.id, seen)
            if p_zs is not None:
                r_ph = _r_hot_per_km(p_way.get("cable_mm2")) or 0.0
                ecc = _num(p_way.get("ecc_mm2")) or ecc_required_mm2(p_way.get("cable_mm2")) or 0.0
                r_ecc = _r_hot_per_km(ecc) or 0.0
                length_km = _num(p_way.get("cable_m")) / 1000.0
                out = (p_zs + (r_ph + r_ecc) * length_km, "chained")
                resolved[board_id] = out
                return out

        if req_default_ze is not None:
            out = (_num(req_default_ze), "request_default")
            resolved[board_id] = out
            return out

        resolved[board_id] = (None, note or "unavailable")
        return resolved[board_id]

    for b in boards:
        resolve(b.id, set())
    return resolved


# ─── Main entry point ─────────────────────────────────────────────────────

def run_db_circuit_check(project, ambient_temp_c=None, install_method=None,
                         grouping=None, grouping_circuits=None,
                         vd_limit_lighting_pct=None, vd_limit_general_pct=None,
                         default_ze_ohm=None):
    """Check every way of every distribution board in the project.

    All keyword options are overrides — omitted values fall back to each
    board's own ``way_install`` prop and then to the engine defaults, so a
    project that has never set installation conditions still gets a sensible
    (and clearly labelled) result.
    """
    req = {
        "ambient_c": ambient_temp_c,
        "method": install_method,
        "grouping": grouping,
        "circuits": grouping_circuits,
    }
    vd_light = _num(vd_limit_lighting_pct, VD_LIMIT_LIGHTING_PCT) \
        if vd_limit_lighting_pct is not None else VD_LIMIT_LIGHTING_PCT
    vd_general = _num(vd_limit_general_pct, VD_LIMIT_GENERAL_PCT) \
        if vd_limit_general_pct is not None else VD_LIMIT_GENERAL_PCT

    boards = [c for c in project.components if c.type == "distribution_board"]
    warnings = []
    if not boards:
        return _envelope([], [], warnings, req, vd_light, vd_general, False)

    # One load flow for the whole run, best-effort — it only supplies the
    # upstream voltage for the cumulative drop figure.
    bus_v_pu = {}
    lf_ok = False
    try:
        from .loadflow import run_load_flow
        lf = run_load_flow(project, "newton_raphson")
        if getattr(lf, "converged", False):
            lf_ok = True
            # LoadFlowResults.buses is a dict {bus_id: LoadFlowBus}.
            for bid, b in (getattr(lf, "buses", {}) or {}).items():
                v = getattr(b, "voltage_pu", None)
                if v is not None and getattr(b, "energized", True):
                    bus_v_pu[bid] = _num(v, 1.0)
    except Exception:
        lf_ok = False
    if not lf_ok:
        warnings.append(
            "Load flow unavailable or did not converge — voltage drop is this "
            "circuit's own contribution only and excludes upstream drop.")

    supply = _resolve_supply_impedance(project, boards, default_ze_ohm)

    rows = []
    board_rows = []
    for board in boards:
        circuits = board.props.get("circuits") or []
        board_name = board.props.get("name") or board.id
        v_ll = _num(board.props.get("voltage_kv"), 0.4) * 1000.0
        v_ph = v_ll / math.sqrt(3) if v_ll > 0 else 0.0
        install = _board_install(board, req)
        z_supply, z_basis = supply.get(board.id, (None, "unavailable"))
        v_pu = _board_voltage_pu(board, bus_v_pu, project)
        vd_upstream_pct = None if v_pu is None else max(0.0, (1.0 - v_pu) * 100.0)

        el_ratings = board.props.get("el_ratings")
        el_ratings = el_ratings if isinstance(el_ratings, dict) else {}

        counts = {"pass": 0, "warn": 0, "fail": 0, "info": 0}
        for way in circuits:
            row = _check_way(way, board, board_name, v_ll, v_ph, install,
                             z_supply, z_basis, vd_upstream_pct, lf_ok,
                             el_ratings, vd_light, vd_general)
            rows.append(row)
            counts[row["status"]] = counts.get(row["status"], 0) + 1

        board_rows.append({
            "id": board.id,
            "name": board_name,
            "way_count": len(circuits),
            "counts": counts,
            "worst_status": _worst(*[r["status"] for r in rows[-len(circuits):]])
            if circuits else "pass",
            "z_supply_ohm": _round(z_supply, 4),
            "z_supply_basis": z_basis,
            "install": install,
        })

    return _envelope(rows, board_rows, warnings, req, vd_light, vd_general, lf_ok)


def _check_way(way, board, board_name, v_ll, v_ph, install, z_supply, z_basis,
               vd_upstream_pct, lf_ok, el_ratings, vd_light, vd_general):
    size = _num(way.get("cable_mm2"))
    length_m = _num(way.get("cable_m"))
    in_a = _num(way.get("breaker_a"))
    curve = str(way.get("curve") or "C").upper()
    is_3p = way.get("poles") == "3P" or way.get("phase") == "RWB"
    ib = _way_current_a(way, v_ll)
    messages = []

    # ── Ampacity + IEC 60364-4-43 §433.1 coordination ──
    amp = installed_ampacity(size, install["method"], install["conductor"],
                             install["insulation"], install["ambient_c"],
                             install["grouping"], install["circuits"],
                             install["soil_kmw"], install["depth_m"])
    iz = amp["derated_a"]
    if iz is None:
        amp_status = "info"
        amp_msg = (f"No IEC 60364-5-52 base ampacity for {size:g} mm² "
                   f"{install['insulation']}/{install['conductor']} by method "
                   f"{install['method']} — use a preferred conductor size.")
        coord_status, coord_msg = "info", amp_msg
    else:
        amp_status, amp_msg = "pass", f"Iz {iz:.1f} A ({amp['detail']})"
        if ib > in_a + 1e-6 and in_a > 0:
            coord_status = "fail"
            coord_msg = (f"Design current {ib:.1f} A exceeds the {in_a:g} A "
                         f"breaker — IEC 60364-433 requires Ib ≤ In.")
        elif in_a > iz + 1e-6:
            coord_status = "fail"
            coord_msg = (f"{size:g} mm² cable (Iz {iz:.1f} A derated) is "
                         f"undersized for the {in_a:g} A breaker — "
                         f"SANS 10142-1 / IEC 60364-433 requires In ≤ Iz.")
        elif in_a > 0.9 * iz:
            coord_status = "warn"
            coord_msg = (f"Breaker {in_a:g} A is within 10 % of the derated "
                         f"Iz {iz:.1f} A — little margin for future derating.")
        else:
            coord_status = "pass"
            coord_msg = f"Ib {ib:.1f} A ≤ In {in_a:g} A ≤ Iz {iz:.1f} A."
    if amp_status != "pass":
        messages.append(amp_msg)
    if coord_status != "pass" and coord_msg != amp_msg:
        messages.append(coord_msg)

    # ── Voltage drop ──
    # A single-phase way is a two-conductor loop (phase + neutral), hence 2x;
    # a three-phase way uses the sqrt(3) line-to-line form. cable_sizing.py's
    # per-phase formula covers only the latter.
    pf = min(1.0, max(0.05, _num(way.get("power_factor"), 0.9) or 0.9))
    sin_phi = math.sqrt(max(0.0, 1.0 - pf * pf))
    r_km = _r_hot_per_km(size, install["conductor"], install["insulation"])
    x_km = _x_per_km(size)
    length_km = length_m / 1000.0
    vd_limit = vd_light if _is_lighting(way.get("description")) else vd_general
    if r_km is None or v_ll <= 0:
        vd_v = vd_pct = vd_total = None
        vd_status = "info"
        vd_msg = "Voltage drop not evaluated — cable size or board voltage missing."
    else:
        z_eff = r_km * pf + x_km * sin_phi
        if is_3p:
            vd_v = math.sqrt(3) * ib * length_km * z_eff
            vd_pct = vd_v / v_ll * 100.0
        else:
            vd_v = 2.0 * ib * length_km * z_eff
            vd_pct = vd_v / v_ph * 100.0 if v_ph > 0 else 0.0
        vd_total = (vd_pct + vd_upstream_pct) if vd_upstream_pct is not None else None
        gate = vd_total if vd_total is not None else vd_pct
        basis_note = ("total from the point of supply" if vd_total is not None
                      else "this circuit only — run Load Flow for the cumulative figure")
        if gate > vd_limit + 1e-9:
            vd_status = "fail"
            vd_msg = (f"Voltage drop {gate:.2f} % exceeds the {vd_limit:g} % "
                      f"limit ({basis_note}) — SANS 10142-1 Cl. 6.6.")
        elif gate > 0.9 * vd_limit:
            vd_status = "warn"
            vd_msg = (f"Voltage drop {gate:.2f} % is within 10 % of the "
                      f"{vd_limit:g} % limit ({basis_note}).")
        else:
            vd_status = "pass"
            vd_msg = f"Voltage drop {gate:.2f} % of {vd_limit:g} % ({basis_note})."
    if vd_status != "pass":
        messages.append(vd_msg)

    # ── ECC (IEC 60364-5-54 Table 54.7) ──
    required = ecc_required_mm2(size)
    declared_ecc = way.get("ecc_mm2")
    has_ecc = declared_ecc not in (None, "", 0)
    ecc_val = _num(declared_ecc) if has_ecc else None
    if required is None:
        ecc_status = "info"
        ecc_msg = "ECC not evaluated — no cable size on this way."
    elif not has_ecc:
        ecc_status = "info"
        ecc_msg = (f"ECC not specified — Table 54.7 requires at least "
                   f"{required:g} mm² for a {size:g} mm² live conductor.")
    elif ecc_val + 1e-9 < required:
        ecc_status = "fail"
        ecc_msg = (f"ECC {ecc_val:g} mm² is below the {required:g} mm² required "
                   f"for a {size:g} mm² live conductor — "
                   f"SANS 10142-1 / IEC 60364-5-54 Table 54.7.")
    else:
        ecc_status = "pass"
        ecc_msg = f"ECC {ecc_val:g} mm² ≥ {required:g} mm² required."
    if ecc_status != "pass":
        messages.append(ecc_msg)

    # ── Earth-fault loop impedance / disconnection ──
    # When no ECC is declared the required minimum is assumed. That is the
    # highest-resistance compliant conductor, so it gives the WORST Zs — a pass
    # on the assumption therefore still holds for whatever is actually installed.
    ecc_effective = ecc_val if has_ecc else required
    r_phase = (_r_hot_per_km(size, install["conductor"], install["insulation"]) or 0.0) * length_km
    r_ecc = (_r_hot_per_km(ecc_effective, install["conductor"], install["insulation"]) or 0.0) * length_km \
        if ecc_effective else 0.0
    limit_s = (DISCONNECT_DISTRIBUTION_S if way.get("type") == "feeder_db"
               else DISCONNECT_FINAL_S)
    ia_mult = MCB_CURVE_MAGNETIC.get(curve, 10.0)
    ia = ia_mult * in_a
    zs = ief = zs_max = None
    zs_basis_bits = []
    if z_supply is None:
        zs_status = "info"
        zs_msg = ("Earth-fault loop impedance not evaluated — no supply "
                  "impedance for this board. Wire it to a source on the SLD, "
                  "or enter a measured Ze in the Schedules workspace.")
    elif in_a <= 0 or v_ph <= 0:
        zs_status = "info"
        zs_msg = "Earth-fault loop impedance not evaluated — breaker rating or board voltage missing."
    else:
        zs = z_supply + r_phase + r_ecc
        ief = C_MIN * v_ph / zs if zs > 0 else 0.0
        zs_max = C_MIN * v_ph / ia if ia > 0 else None
        if not has_ecc:
            zs_basis_bits.append("assumed_min_ecc")
        if ief >= ia:
            zs_status = "pass"
            zs_basis_bits.insert(0, "magnetic")
            zs_msg = (f"Zs {zs:.3f} Ω gives {ief:.0f} A ≥ {ia:.0f} A "
                      f"({curve} curve, {ia_mult:g}×In) — instantaneous trip, "
                      f"well inside the {limit_s:g} s limit.")
        else:
            idn_ma = _rcd_idn_ma(way, el_ratings)
            zs_rcd_max = (TOUCH_VOLTAGE_LIMIT_V / (idn_ma / 1000.0)) if idn_ma else None
            if zs_rcd_max is not None and zs <= zs_rcd_max:
                zs_status = "pass"
                zs_basis_bits.insert(0, "rcd")
                zs_msg = (f"Magnetic trip not reached ({ief:.0f} A < {ia:.0f} A), "
                          f"but the {idn_ma:g} mA earth-leakage unit on group "
                          f"'{way.get('el_group')}' satisfies Zs ≤ 50 V/IΔn "
                          f"({zs:.3f} ≤ {zs_rcd_max:.1f} Ω).")
            else:
                zs_status = "fail"
                zs_basis_bits.insert(0, "magnetic")
                zs_msg = (f"Zs {zs:.3f} Ω exceeds {zs_max:.3f} Ω — the {curve}-curve "
                          f"magnetic trip needs {ia:.0f} A but only {ief:.0f} A is "
                          f"available, so disconnection within {limit_s:g} s is not "
                          f"achieved (SANS 10142-1 Cl. 5.5.6 / IEC 60364-4-41).")
    if zs_status != "pass":
        messages.append(zs_msg)

    status = _worst(amp_status, coord_status, vd_status, ecc_status, zs_status)
    return {
        "board_id": board.id, "board_name": board_name,
        "way_id": way.get("id"), "way": str(way.get("way") or ""),
        "description": way.get("description") or "",
        "poles": way.get("poles") or "1P", "phase": way.get("phase") or "R",
        "curve": curve, "breaker_a": _round(in_a, 2),
        "cable_mm2": _round(size, 3), "cable_m": _round(length_m, 2),

        "ib_a": _round(ib, 2), "in_a": _round(in_a, 2),
        "iz_base_a": _round(amp["base_a"], 2),
        "iz_derated_a": _round(iz, 2),
        "derating_factor": _round(amp["derating"], 4),
        "derating_detail": amp["detail"],
        "ampacity_status": amp_status, "ampacity_message": amp_msg,
        "coordination_status": coord_status, "coordination_message": coord_msg,

        "vd_v": _round(vd_v, 3), "vd_pct": _round(vd_pct, 3),
        "vd_upstream_pct": _round(vd_upstream_pct, 3),
        "vd_total_pct": _round(vd_total, 3),
        "vd_limit_pct": _round(vd_limit, 2),
        "vd_basis": "cumulative" if vd_total is not None else "way_only",
        "vd_status": vd_status, "vd_message": vd_msg,

        "ecc_mm2": _round(ecc_val, 3), "ecc_required_mm2": _round(required, 3),
        "ecc_status": ecc_status, "ecc_message": ecc_msg,

        "z_supply_ohm": _round(z_supply, 4), "z_supply_basis": z_basis,
        "r_phase_ohm": _round(r_phase, 4), "r_ecc_ohm": _round(r_ecc, 4),
        "zs_ohm": _round(zs, 4), "zs_max_ohm": _round(zs_max, 4),
        "ia_a": _round(ia, 2), "ia_multiple": _round(ia_mult, 2),
        "ief_a": _round(ief, 2),
        "disconnect_limit_s": limit_s,
        "zs_basis": "+".join(zs_basis_bits) if zs_basis_bits else None,
        "zs_status": zs_status, "zs_message": zs_msg,

        "status": status,
        "messages": messages,
    }


def _rcd_idn_ma(way, el_ratings):
    """Rated residual current of the way's earth-leakage group, if any.

    Group resolution mirrors ``DBSchedule._leakageGroups`` — a named group with
    no stored rating defaults to 30 mA.
    """
    group = str(way.get("el_group") or "").strip()
    if not group:
        return None
    stored = _num(el_ratings.get(group))
    return stored if stored > 0 else 30.0


def _round(value, places):
    """Round to native float, or None. Guards the numpy -> Pydantic 500."""
    if value is None:
        return None
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(n) or math.isinf(n):
        return None
    return round(n, places)


def _envelope(rows, board_rows, warnings, req, vd_light, vd_general, lf_ok):
    summary = {"boards": len(board_rows), "ways": len(rows),
               "pass": 0, "warn": 0, "fail": 0, "info": 0}
    for r in rows:
        summary[r["status"]] = summary.get(r["status"], 0) + 1
    return {
        "ways": rows,
        "boards": board_rows,
        "summary": summary,
        "warnings": warnings,
        "basis": {
            "ambient_temp_c": req.get("ambient_c"),
            "install_method": req.get("method"),
            "grouping": req.get("grouping"),
            "grouping_circuits": req.get("circuits"),
            "vd_limit_lighting_pct": vd_light,
            "vd_limit_general_pct": vd_general,
            "vd_convention": (
                "SANS 10142-1 Cl. 6.6 — 5 % total from the point of supply, "
                "with a stricter 3 % design allowance applied to lighting ways."),
            "c_min": C_MIN,
            "magnetic_multiples": dict(MCB_CURVE_MAGNETIC),
            "disconnect_times_s": {"final_circuit": DISCONNECT_FINAL_S,
                                   "distribution_circuit": DISCONNECT_DISTRIBUTION_S},
            "ecc_rule": "IEC 60364-5-54 Table 54.7 / SANS 10142-1",
            "coordination_rule": (
                "IEC 60364-4-43 §433.1 Ib ≤ In ≤ Iz. For IEC 60898 MCBs "
                "I2 = 1.45·In, so I2 ≤ 1.45·Iz follows automatically."),
            "ampacity_basis": "IEC 60364-5-52 tabulated Iz with ambient, grouping, soil and depth derating",
            "fault_basis": "IEC 60909-0 §5.3.1 minimum-current (c_min = 0.95, conductors at operating temperature)",
            "load_flow_converged": bool(lf_ok),
        },
    }
