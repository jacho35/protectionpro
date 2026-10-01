"""Potential-transformer (PT / voltage transformer) burden-and-accuracy
model — the voltage-side analogue of ct_model.py.

[PS-16 residual] "PT parameters are used in no calculation": the PT
component (ratio, accuracy_class, burden_va) has existed on the SLD since
inception but nothing read them — purely decorative, exactly like the CT
before its [PS-16] saturation-adequacy fix. This module gives the PT
parameters the same treatment the CT got: a standards-anchored model
(IEC 61869-3, the VT counterpart of IEC 61869-2 for CTs) consumed by a
duty_check.py adequacy table ("PT Burden Adequacy").

The engineering content that makes a PT a real duty concern is different
from a CT's: a CT's failure mode under scrutiny is core SATURATION at high
fault current (a threshold vs. an external quantity — the fault duty). A
PT is not driven anywhere near saturation in service; its failure mode is
BURDEN MISMATCH — IEC 61869-3 only guarantees the declared accuracy class
(ratio error / phase displacement limits) when the actual secondary burden
sits within a qualification band of the PT's *rated* burden (the standard
values it was tested at, e.g. 10/25/50/100/200/400 VA). Above the rated
burden the core and secondary IR drop push the ratio/phase error outside
the class limits; well below it (< ~25 % of rated) the standard's test
points no longer bracket the operating condition either, so the
classification is likewise unproven at that loading. Both ends are
reported; overburden is flagged as the primary, checkable defect (it is
the direction a mis-specified or over-loaded VT circuit actually fails
in), underburden as an informational warning.

Only PTs that actually feed a protection/measurement relay (a `relay`
component whose `associated_pt` names this PT) are checked — a PT wired
only to a panel meter is not a protection duty concern, mirroring how
duty_check.py's CT check only looks at CTs with an `associated_ct` relay.

[Scope note] Distance relay (21) zone-reach conversion (frontend
constants.js buildDistanceRelayZones / tcc.js) works entirely in a
primary-referred ohms domain (a user-entered `voltage_kv` and ohms
setting) — it has no notion of a PT-measured secondary voltage to
substitute the "ideal" value for, so there is no existing consumer to
wire a PT ratio/phase correction into without inventing that distinction
from scratch. Per the calculation-verification scope, that piece is
intentionally left out here (see BACKLOG.md).

[PT review 2026-09-29] Reviewed against IEC 61869-3:2011 (Tables 301
measuring / 302 protective limits, Table 303 rated voltage factors, the
burden ranges of 5.5) and IEC 61869-1 (earth fault factor, effectively
earthed <= 1.4). Findings PT1-PT4 and notes L1-L2 are marked in code;
write-up in reviews/PT_MODEL_REVIEW.md.
"""

import cmath
import math
import re

_DEFAULT_RATIO = {"primary": 11000.0, "secondary": 110.0, "ratio": 100.0}

# [L1] IEC 61869-3 Table 301 — limits of voltage (ratio) error and phase
# displacement for MEASURING voltage transformers, at rated frequency,
# 80-120% rated voltage, over the burden range of the rated output.
# IEC 61869-3 Table 302 — limits for PROTECTIVE voltage transformers
# (classes 3P/6P), evaluated between 5% rated voltage and the rated
# voltage factor x rated voltage.
# (ratio_error_pct, phase_error_min)
_ACCURACY_LIMITS = {
    "0.1": (0.1, 5.0),
    "0.2": (0.2, 10.0),
    "0.5": (0.5, 20.0),
    "1.0": (1.0, 40.0),
    "3.0": (3.0, None),   # no phase-displacement limit specified for class 3.0
    "3P": (3.0, 120.0),
    "6P": (6.0, 240.0),
}

# Burden qualification band (fraction of rated burden) within which the
# declared accuracy class is guaranteed by IEC 61869-3.
_BURDEN_QUALIFIED_MIN_FRAC = 0.25
_BURDEN_QUALIFIED_MAX_FRAC = 1.00
# [PT4] IEC 61869-3 5.5 burden range I (rated outputs 1.0 / 2.5 / 5.0 / 10 VA
# at unity pf) is guaranteed from 0 % to 100 % of the rated output; only
# range II (10 / 25 / 50 / 100 VA at 0.8 pf lagging) has the 25 % floor.
# 10 VA exists in both ranges, so it keeps the stricter range II floor.
_BURDEN_RANGE_I_MAX_VA = 10.0

# [PT3] Measuring and protective class keys, for dual-class strings.
_MEASURING_CLASSES = ("0.1", "0.2", "0.5", "1.0", "3.0")
_PROTECTIVE_CLASSES = ("3P", "6P")

# [PT2] IEC 61869-3 5.6.201 / 5.6.202: measuring accuracy holds between 80 %
# and 120 % of rated voltage; every VT is rated 1.2 x continuous (Table 303),
# so a service voltage above 120 % of the rated primary overfluxes the core.
_V_MEAS_MIN_FRAC = 0.80
_V_CONT_MAX_FRAC = 1.20

# [PT1] IEC 61869-1 3.2.x / IEC 60071-1: a system is effectively earthed at
# the VT location when the earth fault factor does not exceed 1.4.
_EFFECTIVELY_EARTHED_MAX_K = 1.4
_A = cmath.exp(2j * math.pi / 3)


def _parse_pt_voltage(text):
    """One side of a PT ratio -> volts, or None.

    [PT2] Accepts "11000", "11kV", "110V", "11000/√3", "110/3" (the /3 of an
    open-delta residual winding), "sqrt3". A bare number below 1 is taken as
    kV (e.g. "0.11"), since no PT secondary is under 1 V.
    """
    t = text.strip().lower().replace(" ", "")
    t = t.replace("sqrt(3)", "√3").replace("sqrt3", "√3").replace("rt3", "√3")
    m = re.fullmatch(r"(\d+(?:\.\d+)?)(kv|v)?(?:/(√3|3))?", t)
    if not m:
        return None
    v = float(m.group(1))
    if m.group(2) == "kv" or (m.group(2) is None and 0 < v < 1):
        v *= 1000.0
    if m.group(3) == "√3":
        v /= math.sqrt(3)
    elif m.group(3) == "3":
        v /= 3.0
    return v if v > 0 else None


def parse_pt_ratio(ratio_str):
    """Parse a "primary/secondary" PT ratio string, e.g. "11000/110".

    Mirrors ct_model.parse_ct_ratio(): falls back to an 11000/110 default
    (IEC 61869-3 standard 110 V secondary) on any missing/malformed input,
    with "parsed": False so callers can say the ratio was not recognised.

    [PT2] Also reads the forms a VT nameplate actually uses: "11kV/110V",
    "11000:110", "11000/√3 / 110/√3" and "33000/√3/110/√3". Before this a
    "√3" or unit made the split produce the wrong number of parts and the
    PT was silently taken as 11000/110.
    """
    if not ratio_str or not isinstance(ratio_str, str):
        return dict(_DEFAULT_RATIO, parsed=False)
    t = ratio_str.strip().lower().replace(" ", "").replace(":", "/")
    t = t.replace("sqrt(3)", "√3").replace("sqrt3", "√3")
    # side = number [unit] [/√3]; the secondary may also be "/3" (residual
    # open-delta winding). One regex keeps a divisor with its own side.
    side = r"(\d+(?:\.\d+)?(?:kv|v)?)"
    m = re.fullmatch(side + r"(/√3)?/" + side + r"(/√3|/3)?", t)
    if not m:
        return dict(_DEFAULT_RATIO, parsed=False)
    sides = [m.group(1) + (m.group(2) or ""), m.group(3) + (m.group(4) or "")]
    primary, secondary = _parse_pt_voltage(sides[0]), _parse_pt_voltage(sides[1])
    if primary and secondary:
        return {"primary": primary, "secondary": secondary,
                "ratio": primary / secondary, "parsed": True}
    return dict(_DEFAULT_RATIO, parsed=False)


def _normalise_pt_class(tok):
    """'1' -> '1.0', '0.50' -> '0.5', '3p' -> '3P'; None if not a class."""
    tok = tok.strip().upper()
    if tok in _ACCURACY_LIMITS:
        return tok
    try:
        f = float(tok)
    except ValueError:
        return None
    for key in _MEASURING_CLASSES:
        if abs(float(key) - f) < 1e-9:
            return key
    return None


def parse_pt_accuracy_limits(accuracy_class, protection=True):
    """Ratio-error / phase-displacement limits for an IEC 61869-3 class.

    Accepts measuring classes 0.1/0.2/0.5/1.0/3.0 (IEC 61869-3 Table 301),
    protective classes 3P/6P (Table 302), and dual-class windings such as
    "0.5/3P" or "0.2 3P". Unrecognised/missing input falls back to class 0.5
    (the component's own default accuracy_class) with "recognised": False.

    [PT3] "1" and "3" used to miss the "1.0"/"3.0" keys and were reported as
    class 0.5; a dual "0.5/3P" was reported as class 0.5 too. For a winding
    that feeds a relay (protection=True) the governing limits of a dual
    class are the protective ones — the relay must see the fault voltage,
    which only the P class guarantees (5 % to Vf x Ur).

    Returns {"class": str, "ratio_error_pct": float, "phase_error_min":
    float|None, "recognised": bool}.
    """
    raw = str(accuracy_class).strip() if accuracy_class else ""
    body = re.sub(r"^(cl(ass)?\.?)\s*", "", raw, flags=re.I)
    toks = [t for t in re.split(r"[/,;\s]+|(?<=\d)-(?=\d*[pP]?$)", body) if t]
    keys = [_normalise_pt_class(t) for t in toks]
    if not keys or any(k is None for k in keys):
        ratio_pct, phase_min = _ACCURACY_LIMITS["0.5"]
        return {"class": "0.5", "ratio_error_pct": ratio_pct,
                "phase_error_min": phase_min, "recognised": False}
    prot = [k for k in keys if k in _PROTECTIVE_CLASSES]
    meas = [k for k in keys if k in _MEASURING_CLASSES]
    governing = (prot[0] if (prot and (protection or not meas)) else meas[0])
    ratio_pct, phase_min = _ACCURACY_LIMITS[governing]
    label = "/".join(meas[:1] + prot[:1]) if (meas and prot) else governing
    return {"class": label, "ratio_error_pct": ratio_pct,
            "phase_error_min": phase_min, "recognised": True}


def parse_pt_voltage_factor(vf):
    """Rated voltage factor -> (factor, duration_s) or None.

    [PT1] IEC 61869-3 Table 303 values: "1.2" (continuous), "1.5/30s",
    "1.9/30s", "1.9/8h". duration_s is None for continuous. Empty / absent
    -> None (not declared).
    """
    if vf is None:
        return None
    t = str(vf).strip().lower().replace(" ", "")
    if not t:
        return None
    m = re.fullmatch(r"(\d+(?:\.\d+)?)(?:[/x@,]?(\d+(?:\.\d+)?)(s|h|min)?|(cont(inuous)?))?", t)
    if not m:
        return None
    factor = float(m.group(1))
    if factor < 1.0:
        return None
    duration = None
    if m.group(2):
        d = float(m.group(2))
        duration = d * {"s": 1, "min": 60, "h": 3600, None: 1}[m.group(3)]
    return (factor, duration)


def earth_fault_factor(z1, z0, z2=None):
    """IEC 61869-1 / IEC 60071-1 earth fault factor at a bus.

    [PT1] Highest healthy-phase r.m.s. voltage during a single-line-to-earth
    fault, divided by the phase-to-earth voltage without the fault. With the
    sequence networks in series (I0 = I1 = I2 = E / (Z1 + Z2 + Z0)):
        Vb / E = a^2 - I (Z0 + a^2 Z1 + a Z2) / E,  Vc likewise with a <-> a^2.
    z0 None (no zero-sequence path: unearthed) gives sqrt(3).
    """
    if z2 is None:
        z2 = z1
    if z0 is None:
        return math.sqrt(3)
    den = z1 + z2 + z0
    if abs(den) < 1e-15:
        return 1.0
    i = 1.0 / den
    vb = _A ** 2 - i * (z0 + _A ** 2 * z1 + _A * z2)
    vc = _A - i * (z0 + _A * z1 + _A ** 2 * z2)
    return max(abs(vb), abs(vc))


def _num_or_none(val):
    """float(val) if it parses to a POSITIVE number, else None.

    Distinguishes "not specified" (None) from a valid zero-adjacent
    reading; used for the new connected_burden_va prop, where absence
    must skip the check entirely (legacy behaviour) rather than fall back
    to a fabricated typical value the way ct_model's CT-side defaults do.
    """
    try:
        f = float(val)
    except (TypeError, ValueError):
        return None
    return f if f > 0 else None


def _num_or(val, default):
    try:
        f = float(val)
    except (TypeError, ValueError):
        return default
    return f if f else default


def pt_burden_adequacy(pt_props):
    """Rated-vs-connected burden adequacy for a PT (IEC 61869-3).

    Reads: ratio, accuracy_class, burden_va (rated burden, VA — existing
    props) and connected_burden_va (new prop — the actual VA drawn by
    everything wired to the secondary: relays + meters).

    Returns None if connected_burden_va is absent/non-positive — this is
    the legacy fallback: a PT with no declared connected burden is not
    checked at all, identical to today's fully-decorative behaviour.

    Otherwise returns a dict with the rated/connected burden, loading %,
    the IEC 61869-3 accuracy-class limits, and whether the loading sits
    within the standard's 25-100%-of-rated qualification band.
    """
    connected_va = _num_or_none(pt_props.get("connected_burden_va"))
    if connected_va is None:
        return None

    rated_va = _num_or(pt_props.get("burden_va"), 30.0)
    ratio = parse_pt_ratio(pt_props.get("ratio"))
    limits = parse_pt_accuracy_limits(pt_props.get("accuracy_class"))

    loading_pct = (connected_va / rated_va * 100.0) if rated_va > 0 else None
    # [PT4] burden range I (< 10 VA rated, unity pf) is classed from 0 VA.
    min_frac = 0.0 if rated_va < _BURDEN_RANGE_I_MAX_VA else _BURDEN_QUALIFIED_MIN_FRAC
    qualified_min_va = rated_va * min_frac
    qualified_max_va = rated_va * _BURDEN_QUALIFIED_MAX_FRAC
    within_band = qualified_min_va <= connected_va <= qualified_max_va

    return {
        "ratio": ratio["ratio"], "primary": ratio["primary"], "secondary": ratio["secondary"],
        "rated_burden_va": rated_va,
        "connected_burden_va": connected_va,
        "loading_pct": loading_pct,
        "qualified_min_va": qualified_min_va,
        "qualified_max_va": qualified_max_va,
        "within_qualified_band": within_band,
        "burden_range": "I" if min_frac == 0.0 else "II",
        "accuracy_class": limits["class"],
        "ratio_error_pct": limits["ratio_error_pct"],
        "phase_error_min": limits["phase_error_min"],
    }


def pt_voltage_adequacy(pt_props, bus_kv, z1=None, z0=None, z0_known=False):
    """Rated primary voltage and rated voltage factor vs the bus (IEC 61869-3).

    [PT2] The rated primary Upr is matched to the bus line voltage Un or
    phase voltage Un/sqrt3 — whichever is nearer (a declared phase-to-phase
    `connection` is always across Un). Service voltage outside 80-120 % of
    Upr is outside the measuring accuracy range, and above 120 % exceeds the
    1.2 continuous factor every VT carries.

    [PT1] A phase-to-earth winding must also withstand the healthy-phase
    rise of an earth fault: required factor = earth fault factor x
    (service voltage / Upr), compared with the declared `voltage_factor`.
    A non-effectively earthed bus (k > 1.4) needs 1.9; a 30 s rating is
    adequate only with automatic earth-fault tripping (IEC 61869-3 Table 303).
    z1 / z0 are the bus's positive / zero-sequence Thevenin impedances
    (z0 None with z0_known=True means no zero-sequence path).

    Returns None when bus_kv is not known.
    """
    try:
        un_v = float(bus_kv) * 1000.0
    except (TypeError, ValueError):
        return None
    if un_v <= 0:
        return None

    ratio = parse_pt_ratio(pt_props.get("ratio"))
    conn = str(pt_props.get("connection") or "").strip().lower()
    upr = ratio["primary"]
    u_ph = un_v / math.sqrt(3)
    # The nameplate marks a winding by the voltage it is rated for: a single-
    # phase phase-to-earth unit "11000/√3", a three-phase earthed-star unit
    # by the line voltage "11000/110". Take whichever of Un and Un/sqrt3 is
    # nearer (log scale). A declared phase-to-phase winding is always across
    # the line voltage, so a 6.35 kV unit declared phase-to-phase on an
    # 11 kV bus is correctly seen at 173 %.
    if conn == "phase_phase" or abs(math.log(upr / un_v)) <= abs(math.log(upr / u_ph)):
        u_service, marking = un_v, "line"
    else:
        u_service, marking = u_ph, "phase"
    v_frac = u_service / upr

    # Earth fault factor at the bus. Only a declared phase-to-phase winding
    # sees no rise (line voltages are unchanged by an earth fault); anything
    # else — including a three-phase earthed-star VT nameplated by the line
    # voltage — has phase-to-earth windings that do. v_frac is the same per
    # phase for either marking (Un/Upr = (Un/sqrt3)/(Upr/sqrt3)).
    k = None
    if z0_known and z1 is not None:
        k = earth_fault_factor(z1, z0)
    earthed_star = conn != "phase_phase"
    required = k * v_frac if (k is not None and earthed_star) else v_frac

    vf = parse_pt_voltage_factor(pt_props.get("voltage_factor"))
    return {
        "rated_primary_v": upr,
        "ratio_parsed": ratio["parsed"],
        "connection": "phase_phase" if not earthed_star else "phase_earth",
        "marking": marking,
        "connection_declared": conn in ("phase_phase", "phase_earth"),
        # windings that see the earth-fault rise (everything but a declared
        # phase-to-phase connection)
        "earthed_star": earthed_star,
        "service_voltage_pct": v_frac * 100.0,
        "earth_fault_factor": k,
        "effectively_earthed": (k is not None and k <= _EFFECTIVELY_EARTHED_MAX_K),
        "required_voltage_factor": required,
        "voltage_factor": vf[0] if vf else None,
        "voltage_factor_duration_s": vf[1] if vf else None,
        "voltage_factor_declared": vf is not None,
    }
