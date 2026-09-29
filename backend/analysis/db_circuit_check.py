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
# [L5] IEC 60364-5-52 Table G.52.1: (lighting, other uses) from the origin —
# A: supplied from a public LV network; B: from a private LV supply
# (the installation's own transformer or generator).
VD_LIMITS_BY_SUPPLY = {"public": (3.0, 5.0), "private": (6.0, 8.0)}

# IEC 60909-0 Table 1 maximum voltage factor (LV, +10 % tolerance) — used for
# the adiabatic check, which needs the LARGEST current the circuit delivers.
C_MAX = 1.10

# [DB2] IEC 60364-5-54 Table 54.3: k for a protective conductor incorporated in
# a multi-core cable (initial = insulation operating temperature).
K_PE_IN_CABLE = {("Cu", "PVC"): 115.0, ("Cu", "XLPE"): 143.0,
                 ("Al", "PVC"): 76.0, ("Al", "XLPE"): 94.0}
# Operating time assumed for the adiabatic check: an IEC 60898 MCB in its
# instantaneous region clears within 0.1 s; an RCD (IEC 61008/61009) within
# 0.3 s at IΔn. For t < 0.1 s the standard allows the device's I²t let-through
# instead — using 0.1 s is the conservative upper bound without that data.
T_MAGNETIC_S = 0.1
T_RCD_S = 0.3

# Reduced circuit-protective conductor of flat twin-and-earth / multicore
# cables with a reduced earth (BS 6004 / SANS 1507-3 constructions).
TE_CPC_MM2 = {1.0: 1.0, 1.5: 1.0, 2.5: 1.5, 4: 1.5, 6: 2.5, 10: 4, 16: 6}

# ECC sizes tried when none is declared (1.0 mm² is the CPC of 1.5 mm² T+E).
ECC_CANDIDATES = [1.0, 1.5, 2.5, 4, 6, 10, 16, 25, 35, 50, 70, 95, 120, 150,
                  185, 240, 300]

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


def _cond(conductor):
    return "Al" if str(conductor or "Cu").strip().lower().startswith("al") else "Cu"


def _lv_cable_row(size_mm2, conductor="Cu"):
    """LV library row for a size and conductor material — exact match, else
    next size up. Never credits a smaller entry, so a non-standard size is
    checked against a conductor at least as good as the one drawn.

    [DB4] The row is taken for the way's own conductor: aluminium ways used
    the COPPER row (16 mm² Al read 1.38 Ω/km at 70 °C instead of 2.29), so
    their voltage drop and Zs were ~40 % low. The 20 °C DC resistance does
    not depend on the insulation, so any LV row of the material will do.
    """
    mat = _cond(conductor)
    lv = [c for c in STANDARD_CABLES
          if c["conductor"] == mat and c["voltage_kv"] <= 1]
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
    mat = _cond(conductor)
    row = _lv_cable_row(size, mat)
    if row is not None and abs(row["size_mm2"] - size) < 1e-9:
        r20 = row["r_per_km"]
    else:
        r20 = RESISTIVITY[mat] * 1000.0 / size          # Ohm/km at 20 °C
    return r20 * _temp_correction(mat, insulation)


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


def _k_pe(install):
    """IEC 60364-5-54 Table 54.3 k for the way's protective conductor."""
    ins = "XLPE" if str(install.get("insulation", "PVC")).upper() == "XLPE" else "PVC"
    return K_PE_IN_CABLE[(_cond(install.get("conductor")), ins)]


def _loop_z(z_supply, size, ecc, length_km, install):
    """[L3] Earth-fault loop impedance: Ze (complex) + (R1 + R2) at
    operating temperature."""
    r1 = (_r_hot_per_km(size, install["conductor"], install["insulation"]) or 0.0) * length_km
    r2 = (_r_hot_per_km(ecc, install["conductor"], install["insulation"]) or 0.0) * length_km \
        if ecc else 0.0
    return complex(z_supply) + r1 + r2, r1, r2


def _adiabatic_time(way, i_a, ia, idn_ma):
    """Operating time (s) of the way's protection at ``i_a`` for the §543.1.2
    adiabatic check, or None when it would not operate — then the check
    cannot credit the conductor at all.

    MCB instantaneous region → 0.1 s; else an earth-leakage unit → 0.3 s;
    else a manufacturer's disconnection time entered on the way ([L2])."""
    if ia > 0 and i_a >= ia:
        return T_MAGNETIC_S
    if idn_ma:
        return T_RCD_S
    t = _num(way.get("disconnect_time_s"))
    return t if t > 0 else None


def adiabatic_ecc_mm2(i_a, t_s, k):
    """IEC 60364-5-54 §543.1.2: S = √(I²t)/k."""
    return math.sqrt(i_a * i_a * t_s) / k if (i_a > 0 and t_s and k > 0) else None


def _assumed_ecc_mm2(way, z_supply, install, v_ll, idn_ma=None):
    """[DB1] ECC to assume when none is declared: the SMALLEST standard size
    that complies — by Table 54.7 or by the §543.1.2 adiabatic check at the
    current it would itself let flow. Reduced-CPC cables (twin-and-earth:
    2.5/1.5, 4/1.5, 6/2.5 …) comply by the adiabatic route, so assuming the
    Table 54.7 size (= the live conductor up to 16 mm²) understated Zs: a
    60 m 2.5 mm² C20 way passed at 1.075 Ω on the assumption and fails at
    1.413 Ω with its real 1.5 mm² CPC."""
    size = _num(way.get("cable_mm2"))
    table = ecc_required_mm2(size)
    if table is None or z_supply is None:
        return table
    in_a = _num(way.get("breaker_a"))
    ia = MCB_CURVE_MAGNETIC.get(str(way.get("curve") or "C").upper(), 10.0) * in_a
    u0 = v_ll / math.sqrt(3) if v_ll > 0 else 0.0
    k = _k_pe(install)
    length_km = _num(way.get("cable_m")) / 1000.0
    for s in ECC_CANDIDATES:
        if s >= table - 1e-9:
            break
        zs, _r1, _r2 = _loop_z(z_supply, size, s, length_km, install)
        if abs(zs) <= 0:
            continue
        i_ad = C_MAX * u0 / abs(zs)
        t = _adiabatic_time(way, i_ad, ia, idn_ma)
        need = adiabatic_ecc_mm2(i_ad, t, k)
        if need is not None and need <= s + 1e-9:
            return float(s)
    return table


def _zone_earthing(board, project):
    """[L1] Earthing system (TN-S/TN-C/TN-C-S/TT/IT) of the board's supply:
    from the LV source or transformer feeding its voltage zone (walking buses,
    boards, cables and closed switchgear, never across a transformer). TN-S
    when none is set, as the fault engine assumes."""
    from .loadflow import _is_transparent_and_closed
    by_id = {c.id: c for c in project.components}
    adj = {}
    for w in project.wires:
        adj.setdefault(w.fromComponent, []).append(w.toComponent)
        adj.setdefault(w.toComponent, []).append(w.fromComponent)
    seen, stack = {board.id}, [board.id]
    while stack:
        nid = stack.pop()
        for y in adj.get(nid, []):
            if y in seen:
                continue
            seen.add(y)
            c = by_id.get(y)
            if c is None:
                continue
            if c.type in ("transformer", "utility", "generator"):
                es = str(c.props.get("earthing_system", "") or "").upper()
                if es:
                    return es
                continue
            if c.type in ("bus", "distribution_board", "cable") or _is_transparent_and_closed(c):
                stack.append(y)
    return "TN-S"


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
        # [L5] IEC Table G.52.1 supply type: public LV network or private supply
        "supply": "private" if str(pick("supply", "public")).lower() == "private" else "public",
    }


def _way_current_a(way, v_ll):
    """Diversified design current Ib for a way.

    Mirrors ``DBSchedule._wayCurrentA`` (frontend), but referred to the board's
    own nominal voltage rather than a hard-coded 230/400 V pair. A feeder way
    carries the downstream board's demand, already computed by the plan sync.
    """
    # [L4] 0 is a real demand factor (a way switched off in this schedule);
    # only a missing value defaults to 1.0 — ``x or 1.0`` read 0 as 1.
    df_raw = way.get("demand_factor")
    df = 1.0 if df_raw in (None, "") else _num(df_raw, 1.0)
    va = _num(way.get("load_va")) * df
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
    # [L3] Kept complex so the circuit's R1 + R2 adds as an impedance, not to
    # the magnitude (|Ze| + R over-states Zs by up to a few per cent).
    zs = (z1 + z2 + z0) / 3.0 * z_base
    if not (math.isfinite(zs.real) and math.isfinite(zs.imag)) or abs(zs) <= 0:
        return None, None
    return zs, None


def _board_node(board, bus_v_pu, project):
    """The board's electrical node id in the load-flow result (its own id,
    else a directly-wired bus it is collapsed into), or None."""
    if board.id in bus_v_pu:
        return board.id
    by_id = {c.id: c for c in project.components}
    for w in project.wires:
        other = w.toComponent if w.fromComponent == board.id else (
            w.fromComponent if w.toComponent == board.id else None)
        if other and other in bus_v_pu and by_id.get(other) is not None \
                and by_id[other].type in ("bus", "distribution_board"):
            return other
    return None


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
            out = (complex(_num(declared), 0.0), "declared")
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
                p_inst = _board_install(p_board, {})
                r_ph = _r_hot_per_km(p_way.get("cable_mm2"), p_inst["conductor"],
                                     p_inst["insulation"]) or 0.0
                # [DB1] an undeclared feeder CPC: the smallest compliant one
                ecc = _num(p_way.get("ecc_mm2")) or _assumed_ecc_mm2(
                    p_way, p_zs, p_inst, _num(p_board.props.get("voltage_kv"), 0.4) * 1000.0)
                r_ecc = _r_hot_per_km(ecc, p_inst["conductor"], p_inst["insulation"]) or 0.0
                length_km = _num(p_way.get("cable_m")) / 1000.0
                out = (p_zs + (r_ph + r_ecc) * length_km, "chained")
                resolved[board_id] = out
                return out

        if req_default_ze is not None:
            out = (complex(_num(req_default_ze), 0.0), "request_default")
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
    lf_buses = {}
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
                    lf_buses[bid] = b
    except Exception:
        lf_ok = False
    from .cable_sizing import _build_adjacency, _zone_origin
    adj = _build_adjacency(project)
    comp_map = {c.id: c for c in project.components}
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
        # [DB3] Upstream drop from the ORIGIN of the installation (the bus of
        # the board's voltage zone fed by a source or transformer), not from
        # 1.0 p.u.: with the source at 1.05 p.u. a 5.9 % drop to the board
        # read as 1.1 %, and MV/transformer drop upstream of the origin was
        # counted against the installation's limit.
        node = _board_node(board, bus_v_pu, project)
        origin = _zone_origin(node, adj, comp_map, lf_buses) if node else None
        if node is not None and origin is not None:
            vd_upstream_pct = max(0.0, (lf_buses[origin].voltage_pu
                                        - lf_buses[node].voltage_pu) * 100.0)
            origin_name = comp_map[origin].props.get("name", origin) if origin in comp_map else origin
        else:
            vd_upstream_pct, origin_name = None, ""
        earthing = _zone_earthing(board, project)
        # [L5] Limits for the board's supply type, unless the request set them
        b_light, b_general = VD_LIMITS_BY_SUPPLY[install["supply"]]
        if vd_limit_lighting_pct is not None:
            b_light = vd_light
        if vd_limit_general_pct is not None:
            b_general = vd_general

        el_ratings = board.props.get("el_ratings")
        el_ratings = el_ratings if isinstance(el_ratings, dict) else {}

        counts = {"pass": 0, "warn": 0, "fail": 0, "info": 0}
        for way in circuits:
            row = _check_way(way, board, board_name, v_ll, v_ph, install,
                             z_supply, z_basis, vd_upstream_pct, lf_ok,
                             el_ratings, b_light, b_general, earthing)
            row["vd_origin"] = origin_name
            rows.append(row)
            counts[row["status"]] = counts.get(row["status"], 0) + 1

        board_rows.append({
            "id": board.id,
            "name": board_name,
            "way_count": len(circuits),
            "counts": counts,
            "worst_status": _worst(*[r["status"] for r in rows[-len(circuits):]])
            if circuits else "pass",
            "z_supply_ohm": _round(abs(z_supply) if z_supply is not None else None, 4),
            "z_supply_basis": z_basis,
            "earthing_system": earthing,
            "vd_origin": origin_name,
            "vd_limits_pct": [b_light, b_general],
            "install": install,
        })

    return _envelope(rows, board_rows, warnings, req, vd_light, vd_general, lf_ok)


def _check_way(way, board, board_name, v_ll, v_ph, install, z_supply, z_basis,
               vd_upstream_pct, lf_ok, el_ratings, vd_light, vd_general,
               earthing="TN-S"):
    size = _num(way.get("cable_mm2"))
    length_m = _num(way.get("cable_m"))
    in_a = _num(way.get("breaker_a"))
    curve = str(way.get("curve") or "C").upper()
    is_3p = way.get("poles") == "3P" or way.get("phase") == "RWB"
    ib = _way_current_a(way, v_ll)
    messages = []

    # ── Ampacity + IEC 60364-4-43 §433.1 coordination ──
    # [T2] IEC 60364-5-52 rates a single-phase way on two loaded conductors
    # (B.52.2/B.52.3) and a three-phase way on three (B.52.4/B.52.5).
    amp = installed_ampacity(size, install["method"], install["conductor"],
                             install["insulation"], install["ambient_c"],
                             install["grouping"], install["circuits"],
                             install["soil_kmw"], install["depth_m"],
                             loaded=3 if is_3p else 2)
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

    # ── ECC and earth-fault loop ──
    required = ecc_required_mm2(size)          # Table 54.7 size
    declared_ecc = way.get("ecc_mm2")
    has_ecc = declared_ecc not in (None, "", 0)
    ecc_val = _num(declared_ecc) if has_ecc else None
    idn_ma = _rcd_idn_ma(way, el_ratings)
    # [DB1] With no ECC declared, assume the smallest COMPLIANT one (Table
    # 54.7 or §543.1.2) — the highest-resistance conductor a compliant
    # installation could have, so the Zs verdict holds for what is installed.
    ecc_effective = ecc_val if has_ecc else (
        _assumed_ecc_mm2(way, z_supply, install, v_ll, idn_ma) if required is not None else None)

    limit_s = (DISCONNECT_DISTRIBUTION_S if way.get("type") == "feeder_db"
               else DISCONNECT_FINAL_S)
    ia_mult = MCB_CURVE_MAGNETIC.get(curve, 10.0)
    ia = ia_mult * in_a
    zs = ief = zs_max = None
    zs_c = None
    r_phase = r_ecc = 0.0
    zs_basis_bits = []
    if z_supply is None:
        zs_status = "info"
        zs_msg = ("Earth-fault loop impedance not evaluated — no supply "
                  "impedance for this board. Wire it to a source on the SLD, "
                  "or enter a measured Ze in the Schedules workspace.")
        r_phase = (_r_hot_per_km(size, install["conductor"], install["insulation"]) or 0.0) * length_km
    elif in_a <= 0 or v_ph <= 0:
        zs_status = "info"
        zs_msg = "Earth-fault loop impedance not evaluated — breaker rating or board voltage missing."
    else:
        zs_c, r_phase, r_ecc = _loop_z(z_supply, size, ecc_effective, length_km, install)
        zs = abs(zs_c)
        ief = C_MIN * v_ph / zs if zs > 0 else 0.0
        zs_max = C_MIN * v_ph / ia if ia > 0 else None
        if not has_ecc:
            zs_basis_bits.append("assumed_min_ecc")
        declared_t = _num(way.get("disconnect_time_s"))
        if ief >= ia:
            zs_status = "pass"
            zs_basis_bits.insert(0, "magnetic")
            zs_msg = (f"Zs {zs:.3f} Ω gives {ief:.0f} A ≥ {ia:.0f} A "
                      f"({curve} curve, {ia_mult:g}×In) — instantaneous trip, "
                      f"well inside the {limit_s:g} s limit.")
            # [DB1] A blank ECC passes only on the assumed conductor. If the
            # reduced CPC of a twin-and-earth cable of this size would not
            # reach the magnetic trip, say so — the verdict depends on what
            # is actually installed.
            te = TE_CPC_MM2.get(size)
            if not has_ecc and te is not None and ecc_effective and te < ecc_effective - 1e-9:
                zs_te = abs(_loop_z(z_supply, size, te, length_km, install)[0])
                ief_te = C_MIN * v_ph / zs_te if zs_te > 0 else 0.0
                if ief_te < ia:
                    zs_status = "warn"
                    zs_msg = (f"Passes only with an ECC of at least {ecc_effective:g} mm² "
                              f"(Zs {zs:.3f} Ω). A twin-and-earth CPC of {te:g} mm² gives "
                              f"Zs {zs_te:.3f} Ω and {ief_te:.0f} A < {ia:.0f} A — it would "
                              f"fail. Enter the installed ECC.")
        else:
            # [L1] RCD route. TN (IEC 60364-4-41 §411.4.4): Zs·Ia ≤ U0 with
            # Ia = IΔn (an RCD operates within 0.3 s at IΔn). TT (§411.5.3):
            # RA·IΔn ≤ 50 V — RA is not modelled separately, and Zs ≥ RA, so
            # testing Zs is conservative. The old code applied the TT 50 V
            # rule in TN too (1.67 kΩ instead of 7.7 kΩ at 30 mA).
            tt = earthing == "TT"
            if idn_ma:
                u_lim = TOUCH_VOLTAGE_LIMIT_V if tt else v_ph
                zs_rcd_max = u_lim / (idn_ma / 1000.0)
            else:
                zs_rcd_max = None
            if zs_rcd_max is not None and zs <= zs_rcd_max:
                zs_status = "pass"
                zs_basis_bits.insert(0, "rcd")
                rule = "RA·IΔn ≤ 50 V (TT, Zs ≥ RA)" if tt else "Zs·IΔn ≤ U0 (TN)"
                zs_msg = (f"Magnetic trip not reached ({ief:.0f} A < {ia:.0f} A), "
                          f"but the {idn_ma:g} mA earth-leakage unit on group "
                          f"'{way.get('el_group')}' satisfies {rule} "
                          f"({zs:.3f} ≤ {zs_rcd_max:.1f} Ω).")
            elif declared_t > 0 and declared_t <= limit_s + 1e-9:
                # [L2] IEC 60898-1 guarantees operation only at its conventional
                # points, so the thermal region can't be credited from the
                # standard; a time read off the manufacturer's curve can.
                zs_status = "pass"
                zs_basis_bits.insert(0, "declared_time")
                zs_msg = (f"Magnetic trip not reached ({ief:.0f} A < {ia:.0f} A); the "
                          f"declared disconnection time {declared_t:g} s (manufacturer's "
                          f"curve) is within the {limit_s:g} s limit.")
            else:
                zs_status = "fail"
                zs_basis_bits.insert(0, "magnetic")
                hint = (" Enter the device's disconnection time at this current "
                        "from its curve if it is within the limit."
                        if way.get("type") == "feeder_db" else "")
                zs_msg = (f"Zs {zs:.3f} Ω exceeds {zs_max:.3f} Ω — the {curve}-curve "
                          f"magnetic trip needs {ia:.0f} A but only {ief:.0f} A is "
                          f"available, so disconnection within {limit_s:g} s is not "
                          f"achieved (SANS 10142-1 Cl. 5.5.6 / IEC 60364-4-41).{hint}")
    if zs_status != "pass":
        messages.append(zs_msg)

    # [DB2] IEC 60364-5-54 §543.1.1: a protective conductor complies by the
    # adiabatic calculation (§543.1.2) OR by Table 54.7 (§543.1.3). Only the
    # table was tested, so a standard twin-and-earth (2.5/1.5 mm²) failed
    # although §543.1.2 needs 0.43 mm² for it.
    k_pe = _k_pe(install)
    ecc_adiabatic = None
    if required is None:
        ecc_status = "info"
        ecc_msg = "ECC not evaluated — no cable size on this way."
    elif not has_ecc:
        ecc_status = "info"
        assumed = (f"assumed {ecc_effective:g} mm², the smallest that complies"
                   if ecc_effective is not None and ecc_effective < required - 1e-9
                   else f"Table 54.7 size {required:g} mm² assumed")
        ecc_msg = (f"ECC not specified — {assumed} (Table 54.7: {required:g} mm²). "
                   f"Enter the installed ECC.")
    elif ecc_val + 1e-9 >= required:
        ecc_status = "pass"
        ecc_msg = f"ECC {ecc_val:g} mm² ≥ {required:g} mm² (Table 54.7)."
    else:
        i_ad = (C_MAX * v_ph / zs) if zs else None
        t_ad = _adiabatic_time(way, i_ad or 0.0, ia, idn_ma) if i_ad else None
        ecc_adiabatic = adiabatic_ecc_mm2(i_ad, t_ad, k_pe) if t_ad else None
        if ecc_adiabatic is not None and ecc_val + 1e-9 >= ecc_adiabatic:
            ecc_status = "pass"
            ecc_msg = (f"ECC {ecc_val:g} mm² ≥ {ecc_adiabatic:.2f} mm² by the adiabatic "
                       f"check √(I²t)/k ({i_ad:.0f} A, {t_ad:g} s, k {k_pe:g}) — "
                       f"IEC 60364-5-54 §543.1.2 (below the Table 54.7 {required:g} mm²).")
        elif ecc_adiabatic is not None:
            ecc_status = "fail"
            ecc_msg = (f"ECC {ecc_val:g} mm² is below both Table 54.7 ({required:g} mm²) and "
                       f"the adiabatic requirement {ecc_adiabatic:.2f} mm² "
                       f"({i_ad:.0f} A, {t_ad:g} s) — IEC 60364-5-54 §543.1.")
        else:
            ecc_status = "fail"
            ecc_msg = (f"ECC {ecc_val:g} mm² is below the Table 54.7 {required:g} mm², and "
                       f"the adiabatic route needs the fault to be cleared "
                       f"({'no supply impedance' if zs is None else 'the protection does not operate'})"
                       f" — IEC 60364-5-54 §543.1.")
    if ecc_status != "pass":
        messages.append(ecc_msg)

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
        "ecc_assumed_mm2": _round(ecc_effective, 3) if not has_ecc else None,
        "ecc_adiabatic_mm2": _round(ecc_adiabatic, 3),
        "ecc_status": ecc_status, "ecc_message": ecc_msg,

        "z_supply_ohm": _round(abs(z_supply) if z_supply is not None else None, 4),
        "z_supply_basis": z_basis, "earthing_system": earthing,
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
                "From the origin of the installation (the bus fed by the source or "
                "transformer): IEC 60364-5-52 Table G.52.1 — public LV supply 3 % "
                "lighting / 5 % other, private supply 6 % / 8 % (per board 'supply'); "
                "SANS 10142-1 Cl. 6.6."),
            "c_min": C_MIN,
            "magnetic_multiples": dict(MCB_CURVE_MAGNETIC),
            "disconnect_times_s": {"final_circuit": DISCONNECT_FINAL_S,
                                   "distribution_circuit": DISCONNECT_DISTRIBUTION_S},
            "ecc_rule": ("IEC 60364-5-54 §543.1: Table 54.7 OR the adiabatic check "
                         "S ≥ √(I²t)/k (k per Table 54.3; I = c_max·U0/Zs; t = 0.1 s "
                         "MCB instantaneous, 0.3 s RCD, or the declared time). A blank "
                         "ECC assumes the smallest compliant size."),
            "rcd_rule": "TN: Zs·IΔn ≤ U0 (§411.4.4); TT: RA·IΔn ≤ 50 V, tested on Zs (§411.5.3)",
            "coordination_rule": (
                "IEC 60364-4-43 §433.1 Ib ≤ In ≤ Iz. For IEC 60898 MCBs "
                "I2 = 1.45·In, so I2 ≤ 1.45·Iz follows automatically."),
            "ampacity_basis": ("IEC 60364-5-52 tabulated Iz (2 or 3 loaded conductors) with "
                               "ambient, grouping and soil derating"),
            "fault_basis": "IEC 60909-0 §5.3.1 minimum-current (c_min = 0.95, conductors at operating temperature)",
            "load_flow_converged": bool(lf_ok),
        },
    }
