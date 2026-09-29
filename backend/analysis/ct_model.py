"""Current-transformer saturation model — shared by relay/TCC clearing-time
evaluation (arcflash.py) and the CT accuracy-limit adequacy check
(duty_check.py).

Steady state: ports the frontend's symmetrical CT saturation model
(frontend/js/constants.js: parseCTRatio/parseCTAccuracyClass/
ctSaturationParams/ctEffectiveCurrent) so the backend relay evaluation used
for arc-flash clearing times sees the same saturation-clipped current the
TCC chart plots ([PS-9] residual).

The core is an ideal square loop: the CT reproduces the primary current
until the secondary flux reaches the saturation flux Psi_sat =
sqrt(2)*V_sat/omega, then delivers nothing for the rest of the half-cycle.
V_sat is the class's accuracy-limit EMF, E_AL = ALF x I_sn x (Rct + R_b)
(IEC 61869-2), or the knee-point EMF when one is entered.

Transient (dc offset): [C3] a fully offset fault current raises the flux
demand by the IEC 61869-2 transient factor Ktf = 1 + omega*Tp*(1 - e^-t/Tp)
(up to 1 + X/R), not by the IEC 60909 peak factor kappa — kappa measures
the first current PEAK, while flux is the integral of the current, and the
dc component integrates. The transient cannot be folded into a steady-state
threshold, so ``ct_fundamental_series`` simulates the square-loop core in
the time domain (full offset, zero remanence) and returns the fundamental a
numerical relay measures sample by sample; arcflash.py integrates the relay
characteristic over it. Remanence is not modelled (it can only make
saturation earlier — a PR-class core limits it to 10 %).
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


# [C4] IEC 61869-2 protective classes: 5P20, 10P10, 5PR10 (low remanence),
# PX / PXR (knee-point specified), TPX / TPY / TPZ (transient); IEEE C57.13
# C-class (C200 = 200 V at the terminals at 20 x I_sn); measuring classes
# (0.2, 0.5, 0.2S, 1, 3, 5) with an optional instrument security factor FS.
_P_RE = re.compile(r"(\d+(?:\.\d+)?)\s*P\s*(R?)\s*(\d+)", re.IGNORECASE)
_PX_RE = re.compile(r"^\s*(PXR?|TP[XYZ])\s*$", re.IGNORECASE)
_C_RE = re.compile(r"^\s*[CK]\s*(\d+)\s*$", re.IGNORECASE)
_METER_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*S?\s*(?:FS\s*(\d+))?\s*$", re.IGNORECASE)

_DEFAULT_ALF = 20.0
_DEFAULT_FS = 5.0


def parse_ct_accuracy_class(accuracy_class):
    """Classify an accuracy-class string.

    Returns {kind, alf, c_voltage, warning}: kind is "P" (incl. PR),
    "C" (IEEE C-class, c_voltage set), "PX" (PX/PXR/TPx — knee point must
    be entered), "metering" (alf = FS) or "unknown". ``alf`` is the limit
    factor the accuracy-limit EMF is built from; for the guessed kinds a
    ``warning`` says what was assumed.
    """
    s = accuracy_class.strip() if isinstance(accuracy_class, str) else ""
    if not s:
        return {"kind": "P", "alf": _DEFAULT_ALF, "c_voltage": None, "warning": None}
    m = _P_RE.search(s)
    if m:
        return {"kind": "P", "alf": float(m.group(3)), "c_voltage": None, "warning": None}
    m = _C_RE.match(s)
    if m:
        return {"kind": "C", "alf": 20.0, "c_voltage": float(m.group(1)), "warning": None}
    if _PX_RE.match(s):
        return {"kind": "PX", "alf": _DEFAULT_ALF, "c_voltage": None,
                "warning": (f"class {s} is specified by its knee-point EMF — enter "
                            f"the knee point voltage; ALF {_DEFAULT_ALF:.0f} assumed")}
    m = _METER_RE.match(s)
    if m:
        fs = float(m.group(2)) if m.group(2) else None
        return {"kind": "metering", "alf": fs or _DEFAULT_FS, "c_voltage": None,
                "warning": (f"measuring class {s} feeding a protection relay — a "
                            "metering core is designed to saturate early"
                            + ("" if fs else f"; FS {_DEFAULT_FS:.0f} assumed"))}
    return {"kind": "unknown", "alf": _DEFAULT_ALF, "c_voltage": None,
            "warning": f"accuracy class '{s}' not recognised — ALF {_DEFAULT_ALF:.0f} assumed"}


def parse_ct_accuracy_alf(accuracy_class):
    """ALF of an IEC 61869-2 accuracy class like "5P20" -> 20.0 (see
    parse_ct_accuracy_class; 20 when absent/unrecognised)."""
    return parse_ct_accuracy_class(accuracy_class)["alf"]


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
    accuracy_class, burden_va (RATED burden), connected_burden_va (the
    burden actually driven — relay plus lead loop; absent/0 = rated),
    rct_ohm, knee_point_v (all optional).

    ``kappa`` is accepted for backwards compatibility and ignored: [C3]
    the dc offset is not a steady-state derating (see module docstring and
    ct_fundamental_series). ``i_sat_primary`` is the symmetrical
    saturation-onset primary current.
    """
    ct = parse_ct_ratio(ct_props.get("ratio"))
    cls = parse_ct_accuracy_class(ct_props.get("accuracy_class"))
    alf = cls["alf"]
    burden_va = _num_or(ct_props.get("burden_va"), 15.0)
    i_sec_rated = ct["secondary"]
    # [PS-16] Rct defaults to a typical secondary-winding resistance for the
    # rated secondary (~0.3 Ohm for 5A cores, ~3 Ohm for 1A cores).
    rct_ohm = _num_or(ct_props.get("rct_ohm"), 3.0 if i_sec_rated <= 1 else 0.3)

    # Burden in ohms: Z = VA / I^2. [C2] The class's accuracy-limit EMF is
    # defined at the RATED burden, but the CT drives its CONNECTED burden:
    # the effective limit factor is ALF' = ALF (Rct + R_rated)/(Rct + R_conn).
    # Using one burden for both made them cancel — the onset never moved.
    burden_ohm = burden_va / (i_sec_rated * i_sec_rated)
    conn_va = _num_or(ct_props.get("connected_burden_va"), 0.0)
    conn_ohm = conn_va / (i_sec_rated * i_sec_rated) if conn_va > 0 else burden_ohm

    warnings = [cls["warning"]] if cls["warning"] else []
    knee_entered = _num_or(ct_props.get("knee_point_v"), 0.0)
    if knee_entered > 0:
        # A rated knee (PX) sits below the square-loop saturation EMF, so
        # using it as V_sat is conservative.
        v_sat = knee_entered
        warnings = [w for w in warnings if not w.startswith("class ")]
    elif cls["kind"] == "C":
        # [C4] IEEE C57.13: V_C at the terminals at 20 x I_sn (<= 10 % ratio
        # error) -> EMF = V_C + 20 I_sn Rct.
        v_sat = cls["c_voltage"] + 20.0 * i_sec_rated * rct_ohm
    else:
        # [L1] Class-derived: the square-loop saturation EMF is the
        # accuracy-limit EMF itself. The previous 0.8 x E_AL clipped a 5P20
        # core by 7.4 % (RMS) at 20 x I_n on rated burden, where IEC 61869-2
        # guarantees <= 5 % composite error — stricter than the class.
        v_sat = alf * i_sec_rated * (rct_ohm + burden_ohm)

    total_z = rct_ohm + conn_ohm
    i_sat_secondary = v_sat / total_z if total_z > 0 else math.inf
    i_sat_primary = i_sat_secondary * ct["ratio"]
    alf_eff = (i_sat_secondary / i_sec_rated) if total_z > 0 else math.inf

    return {
        "ratio": ct["ratio"], "primary": ct["primary"], "secondary": ct["secondary"],
        "i_sat_primary": i_sat_primary,
        # legacy keys (the symmetrical threshold; kappa no longer derates it)
        "i_sat_primary_symmetric": i_sat_primary,
        "dc_offset_factor": 1.0,
        "knee_point_v": v_sat,
        "knee_point_v_symmetric": v_sat,
        "sat_emf_v": v_sat,
        "rct_ohm": rct_ohm, "burden_ohm": burden_ohm, "connected_burden_ohm": conn_ohm,
        "alf": alf, "alf_effective": alf_eff, "total_z": total_z,
        "class_kind": cls["kind"], "warnings": warnings,
    }


def _fundamental_factor(ks):
    """[C1] Fundamental (rms) of the square-loop clipped sine relative to the
    unclipped one. Conduction angle theta = acos(1 - 2 ks) from the flux
    swing; the half-wave i = sin wt on (0, theta), 0 on (theta, pi) has
    Fourier coefficients b1 = (theta - sin 2theta / 2)/pi and
    a1 = sin^2 theta / pi."""
    theta = math.acos(1 - 2 * ks)
    return math.hypot(theta - math.sin(2 * theta) / 2, math.sin(theta) ** 2) / math.pi


def ct_effective_current(i_primary, sat_params):
    """Fundamental primary current a symmetrically saturated CT delivers to
    its relay. Mirrors frontend ctEffectiveCurrent().

    Below the saturation threshold: unchanged. Above it, [C1] the
    FUNDAMENTAL of the clipped waveform — what an IEC 60255-151 numerical
    relay measures (DFT) — not its true RMS, which is 1.1-1.8x higher
    because clipping moves energy into harmonics and so understated the
    saturation delay by up to half. Floored at 5 % so a fully saturated CT
    never reports exactly zero.
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
    return i_primary * max(_fundamental_factor(ks), 0.05)


# ── Transient (dc offset) ────────────────────────────────────────────────

_X_R_MAX = 200.0


def x_r_from_kappa(kappa):
    """X/R at the fault point from the IEC 60909-0 peak factor
    kappa = 1.02 + 0.98 e^(-3 R/X) (Eq. 55). None/<=1.02 -> 0 (no offset)."""
    try:
        k = float(kappa)
    except (TypeError, ValueError):
        return 0.0
    if not k or k <= 1.02:
        return 0.0
    if k >= 2.0:
        return _X_R_MAX
    return min(3.0 / -math.log((k - 1.02) / 0.98), _X_R_MAX)


def ct_transient_saturates(i_primary, sat_params, x_r):
    """True if a fully offset current of symmetrical rms ``i_primary`` can
    drive the square-loop core into saturation: peak flux demand
    Ktf,max x psi_ac = (1 + X/R) I_sec Z_total vs V_sat (IEC 61869-2)."""
    if not sat_params or not math.isfinite(sat_params["i_sat_primary"]):
        return False
    i_sec = i_primary / sat_params["ratio"]
    return (1.0 + max(x_r, 0.0)) * i_sec * sat_params["total_z"] > sat_params["knee_point_v"]


def ct_time_to_saturation(i_primary, sat_params, x_r, freq_hz=50.0):
    """Time (s) for a fully offset fault to saturate the CT — IEC 61869-2
    Ktf = 1 + omega Tp (1 - e^(-t/Tp)) with the CT's own secondary time
    constant taken as infinite (gapless core; conservative), i.e.
    IEEE C37.110 t_s = -Tp ln(1 - (Ks - 1)/(omega Tp)), Ks = V_sat /
    (I_sec Z). 0 if it saturates symmetrically, inf if never."""
    if not sat_params or not math.isfinite(sat_params["i_sat_primary"]) or i_primary <= 0:
        return math.inf
    ks = sat_params["knee_point_v"] / (i_primary / sat_params["ratio"] * sat_params["total_z"])
    if ks <= 1.0:
        return 0.0
    omega = 2 * math.pi * freq_hz
    if x_r <= 0:
        return math.inf
    tp = x_r / omega
    arg = 1.0 - (ks - 1.0) / (omega * tp)
    if arg <= 0:
        return math.inf
    return -tp * math.log(arg)


def ct_fundamental_series(i_primary, sat_params, x_r, freq_hz=50.0,
                          offset=True, n_per_cycle=64):
    """[C3] Time-domain square-loop CT: yields (t, i_meas) indefinitely —
    the one-cycle DFT fundamental (rms, primary amps) of the secondary
    current, as a numerical relay measures it.

    Primary: i = sqrt2 I (e^(-t/Tp) - cos wt) when ``offset`` (full dc
    offset, the worst case), else the symmetrical -sqrt2 I cos wt, whose
    flux is centred from t = 0. Secondary loop purely resistive
    (Z_total); zero remanence; zero magnetising current below saturation;
    no output while the primary drives the flux beyond +/-Psi_sat.
    ``sat_params=None`` gives an ideal CT. Values before one full cycle
    are the partial-window DFT (the relay's own measurement delay).
    """
    omega = 2 * math.pi * freq_hz
    n = int(n_per_cycle)
    dt = 1.0 / (freq_hz * n)
    ratio = sat_params["ratio"] if sat_params else 1.0
    i_sec = i_primary / ratio
    r = sat_params["total_z"] if sat_params else 0.0
    psi_sat = (math.sqrt(2) * sat_params["knee_point_v"] / omega
               if sat_params and math.isfinite(sat_params["i_sat_primary"]) else math.inf)
    decay = math.exp(-dt * omega / x_r) if (offset and x_r > 0) else 0.0
    cs = [math.cos(omega * k * dt) for k in range(n)]
    sn = [math.sin(omega * k * dt) for k in range(n)]
    buf = [0.0] * n
    re_acc = im_acc = 0.0
    psi = 0.0
    dc = 1.0 if (offset and x_r > 0) else 0.0
    amp = math.sqrt(2) * i_sec
    scale = 2.0 / n / math.sqrt(2) * ratio
    k = 0
    while True:
        j = k % n
        i1 = amp * (dc - cs[j])
        dc *= decay
        dpsi = r * i1 * dt
        if (psi >= psi_sat and dpsi > 0) or (psi <= -psi_sat and dpsi < 0):
            i2 = 0.0
        else:
            i2 = i1
            psi = max(-psi_sat, min(psi_sat, psi + dpsi))
        re_acc += (i2 - buf[j]) * cs[j]
        im_acc += (i2 - buf[j]) * sn[j]
        buf[j] = i2
        k += 1
        yield k * dt, math.hypot(re_acc, im_acc) * scale
