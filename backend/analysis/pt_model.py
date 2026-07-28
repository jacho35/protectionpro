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
"""

_DEFAULT_RATIO = {"primary": 11000.0, "secondary": 110.0, "ratio": 100.0}

# IEC 61869-3 Table 2 — limits of voltage (ratio) error and phase
# displacement for MEASURING voltage transformers, at rated frequency,
# 80-120% rated voltage, 25-100% rated burden at rated power factor.
# IEC 61869-3 Table 3 — limits for PROTECTIVE voltage transformers
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


def parse_pt_ratio(ratio_str):
    """Parse a "primary/secondary" PT ratio string, e.g. "11000/110".

    Mirrors ct_model.parse_ct_ratio(): falls back to an 11000/110 default
    (IEC 61869-3 standard 110 V secondary) on any missing/malformed input.
    """
    if not ratio_str or not isinstance(ratio_str, str):
        return dict(_DEFAULT_RATIO)
    parts = ratio_str.split("/")
    if len(parts) != 2:
        return dict(_DEFAULT_RATIO)
    try:
        primary, secondary = float(parts[0]), float(parts[1])
    except ValueError:
        return dict(_DEFAULT_RATIO)
    if primary > 0 and secondary > 0:
        return {"primary": primary, "secondary": secondary, "ratio": primary / secondary}
    return dict(_DEFAULT_RATIO)


def parse_pt_accuracy_limits(accuracy_class):
    """Ratio-error / phase-displacement limits for an IEC 61869-3 class.

    Accepts measuring classes 0.1/0.2/0.5/1.0/3.0 (IEC 61869-3 Table 2) and
    protective classes 3P/6P (IEC 61869-3 Table 3). Unrecognised/missing
    input falls back to class 0.5 (the component's own default
    accuracy_class), matching the default-parses-to-a-moderate-value
    convention used by ct_model.parse_ct_accuracy_alf.

    Returns {"class": str, "ratio_error_pct": float, "phase_error_min": float|None}.
    """
    key = str(accuracy_class).strip().upper() if accuracy_class else "0.5"
    if key not in _ACCURACY_LIMITS:
        # Try a bare-number match (e.g. "0.50" -> "0.5")
        try:
            key = f"{float(key):g}"
        except ValueError:
            key = "0.5"
    ratio_pct, phase_min = _ACCURACY_LIMITS.get(key, _ACCURACY_LIMITS["0.5"])
    return {"class": key if key in _ACCURACY_LIMITS else "0.5",
            "ratio_error_pct": ratio_pct, "phase_error_min": phase_min}


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
    qualified_min_va = rated_va * _BURDEN_QUALIFIED_MIN_FRAC
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
        "accuracy_class": limits["class"],
        "ratio_error_pct": limits["ratio_error_pct"],
        "phase_error_min": limits["phase_error_min"],
    }
