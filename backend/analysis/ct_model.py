"""Current-transformer saturation model — shared by relay/TCC clearing-time
evaluation (arcflash.py) and the CT accuracy-limit adequacy check
(duty_check.py).

Ports the frontend's steady-state (RMS) CT saturation model
(frontend/js/constants.js: parseCTRatio/parseCTAccuracyALF/
ctSaturationParams/ctEffectiveCurrent) so the backend relay evaluation used
for arc-flash clearing times sees the same saturation-clipped current the
TCC chart plots — previously the backend evaluated relay curves against the
raw fault current, unconditionally optimistic on operate time whenever a CT
was undersized for the fault level ([PS-9] residual).

[PS-16 residual] The clipping law itself remains a steady-state symmetric
model (waveform-envelope clipping from the knee-point voltage), not a
time-domain transient simulation of core flux — it does not reproduce
saturation recovery, remanent flux, or the cycle-by-cycle buildup of a fully
offset primary current. To bound the "optimistic for fully-offset close-in
faults" gap without overreaching into an unvalidated EMT-style model, an
optional ``kappa`` (IEC 60909 peak factor, already computed by fault.py at
every bus: ip = kappa*sqrt(2)*Ik'') derates the saturation onset threshold.
kappa is already the standard's own measure of first-peak asymmetry
(1.02 = no dc offset, 2.0 = fully offset) — since ip/  (sqrt(2)*Ik'') = kappa
by definition, the peak flux demand for an offset fault at the same
prospective symmetrical rms current is kappa times the demand of a purely
symmetrical waveform. Dividing the symmetric-only threshold by kappa is a
conservative, bounded proxy: it makes the model saturate SOONER (slower
reported relay operation, higher reported incident energy) under high X/R,
strongly offset conditions, which is the direction the finding requires.
It is still not a full transient simulation (no remanence, no saturation
recovery mid-fault) — that remains a documented residual.
"""

import math
import re

_DEFAULT_RATIO = {"primary": 400.0, "secondary": 5.0, "ratio": 80.0}


def parse_ct_ratio(ratio_str):
    """Parse a "primary/secondary" CT ratio string, e.g. "400/5".

    Mirrors frontend parseCTRatio(): falls back to a 400/5 default on any
    missing/malformed input.
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


_ALF_RE = re.compile(r"(\d+)P(\d+)", re.IGNORECASE)


def parse_ct_accuracy_alf(accuracy_class):
    """Parse an IEC 61869-2 accuracy class like "5P20" -> ALF = 20.0.

    Mirrors frontend parseCTAccuracyALF(); default ALF = 20 when absent/
    unparseable.
    """
    if not accuracy_class or not isinstance(accuracy_class, str):
        return 20.0
    m = _ALF_RE.search(accuracy_class)
    return float(m.group(2)) if m else 20.0


def _num_or(val, default):
    """float(val) if val parses to a nonzero number, else default.

    Mirrors the JS `parseFloat(x) || default` convention used throughout
    this codebase's prop parsing (0/NaN/missing all fall back).
    """
    try:
        f = float(val)
    except (TypeError, ValueError):
        return default
    return f if f else default


def ct_saturation_params(ct_props, kappa=None):
    """Compute CT saturation parameters from its component props.

    Mirrors frontend ctSaturationParams(). ``ct_props`` reads: ratio,
    accuracy_class, burden_va, rct_ohm, knee_point_v (all optional, IEC-
    typical defaults applied per the frontend's documented convention).

    ``kappa``: optional IEC 60909 peak factor (1.02-2.0) at the fault
    point feeding this CT. When given (and > 1.02), the saturation
    threshold is derated by kappa as a conservative dc-offset/asymmetry
    proxy — see module docstring. Returns both the symmetric-only and the
    (possibly offset-derated) threshold so callers can report either.
    """
    ct = parse_ct_ratio(ct_props.get("ratio"))
    alf = parse_ct_accuracy_alf(ct_props.get("accuracy_class"))
    burden_va = _num_or(ct_props.get("burden_va"), 15.0)
    i_sec_rated = ct["secondary"]
    # [PS-16] Rct defaults to a typical secondary-winding resistance for the
    # rated secondary (~0.3 Ohm for 5A cores, ~3 Ohm for 1A cores) instead of
    # 0 — a zero Rct overstates the saturation-free current whenever the
    # burden is small and the user supplies an explicit knee voltage.
    rct_ohm = _num_or(ct_props.get("rct_ohm"), 3.0 if i_sec_rated <= 1 else 0.3)

    # Burden in ohms: Z_burden = VA / I^2
    burden_ohm = burden_va / (i_sec_rated * i_sec_rated)

    # Knee point voltage (user override or derived from the accuracy class).
    # [PS-16] V_AL = ALF x I_sn x (Rct + R_burden) [IEC 61869-2]; the knee
    # (IEC 10%-exciting-current point) of a 5P/10P protection core sits
    # below it: Vk ~= 0.8*V_AL is the standard approximation.
    knee_point_v_symmetric = _num_or(ct_props.get("knee_point_v"), 0.0)
    if knee_point_v_symmetric <= 0:
        knee_point_v_symmetric = 0.8 * alf * i_sec_rated * (rct_ohm + burden_ohm)

    # [PS-16 residual, dc-offset proxy] Scaling the KNEE VOLTAGE itself by
    # 1/kappa (rather than only the reported i_sat_primary) keeps ks =
    # kneePointV / (iSecIdeal * totalZ) self-consistent across the whole
    # clipping formula in ct_effective_current() below — ks still crosses
    # exactly 1 at i_sat_primary and stays in the valid (0, 1) clipping
    # range beyond it. Scaling only the reported threshold without also
    # scaling the knee voltage would desync the two and could spuriously
    # hit the ks>=1 guard (no clipping) just above the derated threshold.
    kssc = float(kappa) if kappa and kappa > 1.02 else 1.0
    knee_point_v = knee_point_v_symmetric / kssc

    # Primary current at which the CT begins to saturate: I_sat_sec = Vk /
    # (Rct + R_burden); I_sat_primary = I_sat_sec x ratio.
    total_z = rct_ohm + burden_ohm
    i_sat_secondary = knee_point_v / total_z if total_z > 0 else math.inf
    i_sat_primary = i_sat_secondary * ct["ratio"]
    i_sat_primary_symmetric = (i_sat_secondary * kssc * ct["ratio"]
                                if total_z > 0 else math.inf)

    return {
        "ratio": ct["ratio"], "primary": ct["primary"], "secondary": ct["secondary"],
        "i_sat_primary": i_sat_primary,
        "i_sat_primary_symmetric": i_sat_primary_symmetric,
        "dc_offset_factor": kssc,
        "knee_point_v": knee_point_v,
        "knee_point_v_symmetric": knee_point_v_symmetric,
        "rct_ohm": rct_ohm, "burden_ohm": burden_ohm, "alf": alf, "total_z": total_z,
    }


def ct_effective_current(i_primary, sat_params):
    """Effective primary current a CT delivers to its relay, accounting for
    saturation clipping. Mirrors frontend ctEffectiveCurrent().

    Below the saturation threshold: unchanged. Above it, the saturation-
    angle waveform-clipping model reduces the effective rms current (floored
    at 5% so a fully saturated CT never reports exactly zero).
    """
    if not sat_params or not math.isfinite(sat_params["i_sat_primary"]):
        return i_primary
    i_sat = sat_params["i_sat_primary"]
    if i_sat <= 0 or i_primary <= i_sat:
        return i_primary

    i_sec_ideal = i_primary / sat_params["ratio"]
    ks = sat_params["knee_point_v"] / (i_sec_ideal * sat_params["total_z"])
    if ks >= 1:
        return i_primary  # guard — should not occur given i_primary > i_sat

    theta = math.acos(1 - 2 * ks)
    eta = math.sqrt(max((theta - math.sin(2 * theta) / 2) / math.pi, 0.0))
    return i_primary * max(eta, 0.05)
