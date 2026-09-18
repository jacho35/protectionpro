"""ADMD (After Diversity Maximum Demand) load-estimation engine.

Faithful Python port of the demand engine in Retic Builder Pro v2.0.5 (verified
byte-identical to cloud build v2.0.44). Implements the two NRS 034-1 estimation
methods used for South African LV reticulation design:

  * **Empirical**   — Diversified demand = N × ADMD × DCF(N), with AMEU / British
                      / None correction-factor sets. UCF (phase-unbalance) is
                      returned for feeder volt-drop but excluded from the kVA total.
  * **Herman-Beta** — Statistical Beta(α,β)·c → Normal(µ,σ) per consumer, summed
                      over N with a Cornish-Fisher skewness-corrected risk factor.
                      Diversity/unbalance are inherent (no DCF/UCF applied).

Aggregation up the network uses per-phase superposition: erven are bucketed into
Red/White/Blue (a 3-phase erf counts as three single-phase connections; erven with
no assigned phase are spread conservatively across all three), demand is computed
per bucket, and the bucket kVAs are summed.

Three-phase load classes (``phase: 3``, e.g. Urban Upmarket I/II 3Φ) tabulate
their parameters PER PHASE (Upmarket I 3Φ: 1.99 kVA/phase = 5.97 kVA/consumer).
Every erf on such a class is therefore a 3-phase connection — one per-phase
variable in each of R/W/B, whatever colour the erf is drawn — and the per-phase
formulae are NEVER multiplied by 3 again. (The source app did both: a ×3 in
Herman-Beta on top of the three buckets gave 3× the demand for "3 Phase" erven,
while R/W/B-coloured erven got too little diversity in Herman-Beta and a third of
the load in Empirical.) Erven with an ``ampsOverride`` are a
fixed, undiversified load and are added on top.

Conventions (from the source app): single-phase 230 V, three-phase line 400 V,
risk z = 1.28, default ADMD 4.04 kVA. All rounding matches the source's
``roundTo2(n) = Math.round(n*100)/100``.
"""

import math

from .admd_data import (
    LOAD_CLASSES,
    CORRECTION_METHODS,
    V_1PH,
    V_3PH_LINE,
    DEFAULT_RISK_Z,
    DEFAULT_ADMD,
)

# Valid single-phase colours; "3 Phase" and unassigned are handled separately.
_PHASE_COLORS = ("Red", "White", "Blue")


def _round2(n):
    """Match the source app's roundTo2: Math.round(n*100)/100 (half up).

    Demand quantities are non-negative, so floor(x+0.5) reproduces JS Math.round
    exactly for this domain (Python's built-in round uses banker's rounding).
    """
    return math.floor(n * 100 + 0.5) / 100


# ── erf helpers ──────────────────────────────────────────────────────────

def _get(erf, key, default=None):
    """Read a field from an erf whether it is a dict or an attribute object."""
    if isinstance(erf, dict):
        return erf.get(key, default)
    return getattr(erf, key, default)


def is_3phase_erf(erf):
    return _get(erf, "phase") == "3 Phase"


def _num_or_zero(v):
    try:
        return float(v) if v is not None else 0.0
    except (TypeError, ValueError):
        return 0.0


def _override_kva_entered(erf):
    """The override's kVA when the user ENTERED it in kVA (overrideUnit "kVA"),
    else None. Used directly so a kVA entry never round-trips through amps."""
    if _get(erf, "overrideUnit") == "kVA":
        v = _num_or_zero(_get(erf, "kvaOverride"))
        return v if v > 0 else None
    return None


def _override_amps(erf):
    ov = _get(erf, "ampsOverride")
    if ov is None:
        ov = _get(erf, "amps_override")
    return _num_or_zero(ov)


def _has_override(erf):
    """A fixed, undiversified load: an amps override, or a kVA-entered one."""
    return _override_kva_entered(erf) is not None or _override_amps(erf) > 0


def _override_voltage(erf):
    """The voltage an override converts through — the erf's OWN connection,
    never its kiosk's load class (an override replaces the class)."""
    return math.sqrt(3) * V_3PH_LINE if is_3phase_erf(erf) else V_1PH


def erf_override_kva(erf):
    """Fixed kVA of an override erf: the entered kVA, else amps x its voltage."""
    kva = _override_kva_entered(erf)
    if kva is not None:
        return kva
    return _override_amps(erf) * _override_voltage(erf) / 1000.0


def _is_active(erf):
    try:
        return float(_get(erf, "length", 0) or 0) > 0
    except (TypeError, ValueError):
        return False


def count_weighted_conns(erven, force_3ph=False):
    """Total connections; a 3-phase erf counts as 3. Active erven only.
    ``force_3ph``: its kiosk is on a 3-phase class, so every erf the CLASS
    describes is 3-phase; an override erf keeps its own phase setting."""
    return sum(3 if (is_3phase_erf(e) or (force_3ph and not _has_override(e))) else 1
               for e in erven if _is_active(e))


def sum_override_kva(erven):
    """Fixed (undiversified) kVA from erven carrying an amps override."""
    total = 0.0
    for e in erven:
        if _is_active(e) and _has_override(e):
            total += erf_override_kva(e)
    return total


# ── class resolution ───────────────────────────────────────────────────────

def resolve_classes(load_class_lib=None):
    """Return the active residential class list (project override or defaults)."""
    if load_class_lib:
        return load_class_lib
    return LOAD_CLASSES


def resolve_demand_param(est_method, cls_id, project_admd=DEFAULT_ADMD,
                         kiosk_admd_override=None, load_class_lib=None,
                         kiosk_cls_id=None):
    """Resolve the demand parameter for a kiosk.

    Herman-Beta → the load-class object (by id, defaulting to urban1).
    Empirical    → an ADMD number: the kiosk's override, else the ADMD of the
                   kiosk's OWN load class (``kiosk_cls_id``), else the project
                   default. A kiosk left on "Default" deliberately takes the
                   project ADMD rather than its class's, since the user may
                   have typed that value. The number (not the class object) is
                   returned: empirical totalKVA is N·ADMD·DCF either way, and
                   network aggregation buckets by the numeric ADMD.
    """
    if est_method == "Herman Beta":
        classes = resolve_classes(load_class_lib)
        by_id = {c["id"]: c for c in classes}
        # Source app falls back to LOAD_CLASSES[2] (Urban Res I), but a project
        # library is user-editable and may be shorter — guard the index.
        fallback = classes[2] if len(classes) > 2 else classes[0]
        return by_id.get(cls_id) or by_id.get("urban1") or fallback
    if kiosk_admd_override and kiosk_admd_override > 0:
        return kiosk_admd_override
    if kiosk_cls_id:
        cls = next((c for c in resolve_classes(load_class_lib) if c["id"] == kiosk_cls_id), None)
        if cls and cls.get("admd"):
            return cls["admd"]
    return project_admd if project_admd else DEFAULT_ADMD


def class_is_3ph(cls_id, load_class_lib=None):
    """True when the load class tabulates per-phase parameters (phase = 3)."""
    cls = next((c for c in resolve_classes(load_class_lib) if c["id"] == cls_id), None)
    return bool(cls) and cls.get("phase") == 3


def _erf_phases(erf, force_3ph=False):
    """The phase buckets one erf loads: all three for a 3-phase connection (or
    any erf on a 3-phase class, or an erf with no valid phase), else its own."""
    ph = _get(erf, "phase")
    if force_3ph or ph == "3 Phase" or ph not in _PHASE_COLORS:
        return _PHASE_COLORS
    return (ph,)


# ── core demand formulae ─────────────────────────────────────────────────────

def beta_params(cls):
    """Beta(α,β)·c → Normal(µ,σ) plus skewness and per-consumer ADMD (kVA)."""
    a, b, c = cls["a"], cls["b"], cls["c"]
    ab = a + b
    mean = a / ab * c
    sigma = c * math.sqrt(a * b / (ab * ab * (ab + 1)))
    skewness = 2 * (b - a) * math.sqrt(ab + 1) / ((ab + 2) * math.sqrt(a * b))
    return {
        "a": a, "b": b, "c": c,
        "mean": mean, "sigma": sigma, "skewness": skewness,
        "admdKVA": _round2(mean * V_1PH / 1000.0),
        "phase": cls.get("phase", 1),
    }


def herman_beta_demand(n_consumers, cls, risk_z=DEFAULT_RISK_Z):
    """Herman-Beta diversified demand for N consumers of one class/phase.

    Design_I = N·µ + z_cf·√N·σ, with z_cf the Cornish-Fisher-corrected risk
    factor. This is ONE phase: N is the consumers on that phase and the result
    is that phase's current and kVA. A 3-phase class's parameters are already
    per phase and its erven are spread over all three buckets by the
    aggregators, so no ×3 is applied here (see the module docstring).
    """
    if not n_consumers or n_consumers <= 0:
        return {"totalKVA": 0, "currentA": 0, "admdKVA": 0}
    z = risk_z or DEFAULT_RISK_Z
    bp = beta_params(cls)
    gamma1 = bp["skewness"] / math.sqrt(n_consumers)          # skewness ~ γ₁/√N
    z_cf = z + (z * z - 1) / 6 * gamma1                        # Cornish-Fisher 1st order
    design_i = n_consumers * bp["mean"] + z_cf * math.sqrt(n_consumers) * bp["sigma"]
    return {
        "totalKVA": _round2(design_i * V_1PH / 1000.0),
        "currentA": _round2(design_i),
        "admdKVA": bp["admdKVA"],
        "designI": _round2(design_i),
        # Working, for the transparency panel.
        "calc": {"n": n_consumers, "a": bp["a"], "b": bp["b"], "c": bp["c"],
                 "mean": round(bp["mean"], 4), "sigma": round(bp["sigma"], 4),
                 "skewness": round(bp["skewness"], 4), "gamma1": round(gamma1, 4),
                 "z": z, "zcf": round(z_cf, 4), "designI": round(design_i, 3),
                 "v": V_1PH},
    }


def empirical_demand(n_consumers, cls_or_admd, corr_method="AMEU"):
    """Empirical diversified demand = N × ADMD × DCF(N).

    ``cls_or_admd`` may be an ADMD number or a class object (its ``admd``).
    Like Herman-Beta this is ONE phase — a 3-phase class's ADMD is per phase —
    so the per-consumer current is ADMD/230 V. UCF is returned as
    ``feederCurrentA`` for distributor volt-drop only; it is NOT included in
    the kVA/current totals.
    """
    if not n_consumers or n_consumers <= 0:
        return {"totalKVA": 0, "currentA": 0, "admdKVA": 0}
    admd = cls_or_admd if isinstance(cls_or_admd, (int, float)) else cls_or_admd["admd"]
    i_admd = admd * 1000.0 / V_1PH                            # per-consumer current
    corr = CORRECTION_METHODS.get(corr_method) or CORRECTION_METHODS["AMEU"]
    dcf = corr["dcf"](n_consumers, admd)
    ucf = corr["ucf"](n_consumers)
    total_i = n_consumers * i_admd * dcf
    return {
        "totalKVA": _round2(total_i * V_1PH / 1000.0),
        "currentA": _round2(total_i),
        "admdKVA": _round2(admd),
        "dcf": _round2(dcf),
        "ucf": _round2(ucf),
        "feederCurrentA": _round2(total_i * ucf),
        "calc": {"n": n_consumers, "admd": admd, "iAdmd": round(i_admd, 4),
                 "corr": corr_method if corr_method in CORRECTION_METHODS else "AMEU",
                 "dcf": round(dcf, 4), "totalI": round(total_i, 3), "v": V_1PH},
    }


def calc_demand(n_consumers, est_method, corr_method, cls_or_admd,
                risk_z=DEFAULT_RISK_Z):
    """Dispatch to the selected estimation method."""
    if est_method == "Herman Beta":
        return herman_beta_demand(n_consumers, cls_or_admd, risk_z)
    return empirical_demand(n_consumers, cls_or_admd, corr_method)


def calc_simple_admd(n_consumers, cls):
    """Undiversified badge demand = N × class ADMD (no diversity). A 3-phase
    class's ADMD is per phase, so each consumer is 3 × ADMD."""
    if not n_consumers or n_consumers <= 0:
        return {"totalKVA": 0, "currentA": 0, "admdKVA": 0}
    phases = 3 if cls.get("phase") == 3 else 1
    total_kva = _round2(n_consumers * cls["admd"] * phases)
    return {
        "totalKVA": total_kva,
        "currentA": _round2(total_kva * 1000.0 / (math.sqrt(3) * V_3PH_LINE)),
        "admdKVA": _round2(cls["admd"]),
    }


# ── per-phase aggregation ────────────────────────────────────────────────────

def _bucket_by_phase(erven, force_3ph=False):
    """Count active, non-override erven per R/W/B phase.

    A 3-phase erf contributes one connection to each phase; an erf with no valid
    phase is spread conservatively across all three phases. ``force_3ph``: the
    kiosk is on a 3-phase class, so every erf is a 3-phase connection.
    """
    by_phase = {}
    for e in erven:
        if not _is_active(e) or _has_override(e):
            continue
        for p in _erf_phases(e, force_3ph):
            by_phase[p] = by_phase.get(p, 0) + 1
    return by_phase


def kiosk_demand(kiosk, settings):
    """Per-kiosk diversified demand using per-phase superposition.

    Mirrors calcKioskDiversifiedDemand: bucket normal erven by phase, run the
    demand calc per bucket, sum the kVA, then add fixed (override) kVA on top.
    """
    est = settings.get("estimationMethod", "Empirical")
    corr = settings.get("correctionMethod", "AMEU")
    default_cls = settings.get("loadClass", "urban1")
    project_admd = settings.get("admd", DEFAULT_ADMD)
    risk_z = settings.get("riskZ") or DEFAULT_RISK_Z
    lib = settings.get("loadClassLib")

    erven = [e for e in _get(kiosk, "erfs", []) if _is_active(e)]
    conns = len(erven)
    own_cls = _get(kiosk, "loadClass")
    cls_id = own_cls or default_cls
    override = _get(kiosk, "admdOverride")
    param = resolve_demand_param(est, cls_id, project_admd, override, lib, own_cls)
    admd_val = param if isinstance(param, (int, float)) else param["admd"]
    three_ph = class_is_3ph(cls_id, lib)
    if est == "Herman Beta":
        admd_src = "class"
    elif override and override > 0:
        admd_src = "override"
    elif own_cls and param != project_admd:
        admd_src = "class"
    else:
        admd_src = "default"

    total_kva = 0.0
    buckets = []
    for ph, n in sorted(_bucket_by_phase(erven, three_ph).items(),
                        key=lambda kv: _PHASE_COLORS.index(kv[0])):
        r = calc_demand(n, est, corr, param, risk_z)
        total_kva += r["totalKVA"]
        buckets.append({"phase": ph, "kva": r["totalKVA"], "currentA": r["currentA"], **r.get("calc", {})})
    override_kva = sum_override_kva(erven)
    # Street lighting is a fixed, undiversified load on the kiosk.
    sl_kva = float(_get(kiosk, "streetLightKVA", 0) or 0)
    diversified_kva = total_kva
    total_kva = _round2(total_kva + override_kva + sl_kva)
    current_a = _round2(total_kva * 1000.0 / (math.sqrt(3) * V_3PH_LINE)) if total_kva else 0
    cls_label = param["label"] if isinstance(param, dict) else f"ADMD {admd_val} kVA"
    cls_obj = next((c for c in resolve_classes(lib) if c["id"] == cls_id), None)

    return {
        "totalKVA": total_kva,
        "currentA": current_a,
        "admdKVA": _round2(admd_val),
        # conns is the erf count (a 3-phase erf counts once), matching the
        # source app's kiosk badge; feeder totals use weighted counts (3φ=3).
        "conns": conns,
        "overrideKVA": _round2(override_kva),
        "streetLightKVA": _round2(sl_kva),
        "cls": cls_label,
        "clsId": cls_id,
        "admdPerPhase": three_ph,
        # Full working for the kiosk header's calculation panel.
        "calc": {
            "method": est, "correction": corr, "riskZ": risk_z,
            "classId": cls_id, "classLabel": cls_obj["label"] if cls_obj else cls_id,
            "classOwn": bool(own_cls), "threePhaseClass": three_ph,
            "admd": admd_val, "admdSource": admd_src,
            "buckets": buckets,
            "diversifiedKVA": _round2(diversified_kva),
            # Erven drawn "3 Phase" on a SINGLE-phase class: the per-phase
            # figures then land on every phase (~3x that household's demand).
            # Computed as such (conservative) and flagged in the UI.
            "mixedPhaseErven": 0 if three_ph else sum(
                1 for e in erven if is_3phase_erf(e) and not _has_override(e)),
            "overrideKVA": _round2(override_kva), "streetLightKVA": _round2(sl_kva),
            # Each fixed load, for the panel: what was entered and what it is.
            "overrides": [{
                "erf": _get(e, "erfNumber") or "",
                "phase": "3 Phase" if is_3phase_erf(e) else (_get(e, "phase") or "—"),
                "entered": "kVA" if _override_kva_entered(e) is not None else "A",
                "amps": _round2(erf_override_kva(e) * 1000.0 / _override_voltage(e)),
                "kva": _round2(erf_override_kva(e)),
                "v": round(_override_voltage(e), 1),
            } for e in erven if _has_override(e)],
            "totalKVA": total_kva, "currentA": current_a, "vLine": V_3PH_LINE,
        },
    }


def feeder_demand(kiosks, settings):
    """Aggregate diversified demand across a set of kiosks (a feeder/tree).

    Diversity is applied across the *combined* downstream consumer count so the
    diversity benefit grows with the whole feeder, not per kiosk:
      * Herman-Beta accumulates erven into class|phase buckets across all kiosks.
      * Empirical accumulates the weighted connection count per resolved ADMD
        value so DCF sees the full N.
    Fixed (override) kVA is summed on top, undiversified.

    Two deliberate deviations from the source app's computeLVCableLoads:
      * per-phase superposition (so a single-kiosk feeder equals that kiosk's
        own demand — the source undercounted it), and
      * the Empirical path resolves each kiosk's own ADMD (honouring
        admdOverride, then the kiosk's own load class), where the source used
        only the project default.
    """
    est = settings.get("estimationMethod", "Empirical")
    corr = settings.get("correctionMethod", "AMEU")
    default_cls = settings.get("loadClass", "urban1")
    project_admd = settings.get("admd", DEFAULT_ADMD)
    risk_z = settings.get("riskZ") or DEFAULT_RISK_Z
    lib = settings.get("loadClassLib")

    total_kva = 0.0
    override_kva = 0.0
    sl_kva = 0.0
    total_conns = 0

    if est == "Herman Beta":
        # key: clsId|phase -> {count, param}
        buckets = {}
        for k in kiosks:
            erven = [e for e in _get(k, "erfs", []) if _is_active(e)]
            cls_id = _get(k, "loadClass") or default_cls
            three_ph = class_is_3ph(cls_id, lib)
            total_conns += count_weighted_conns(erven, three_ph)
            override_kva += sum_override_kva(erven)
            sl_kva += float(_get(k, "streetLightKVA", 0) or 0)
            param = resolve_demand_param(est, cls_id, project_admd,
                                         _get(k, "admdOverride"), lib,
                                         _get(k, "loadClass"))
            for e in erven:
                if _has_override(e):
                    continue
                for p in _erf_phases(e, three_ph):
                    key = f"{cls_id}|{p}"
                    if key not in buckets:
                        buckets[key] = {"count": 0, "param": param}
                    buckets[key]["count"] += 1
        for bk in buckets.values():
            total_kva += calc_demand(bk["count"], est, corr, bk["param"],
                                     risk_z)["totalKVA"]
    else:
        # key: (resolved ADMD value | phase) -> connection count. Per-phase
        # superposition across kiosks — so a single-kiosk feeder equals that
        # kiosk's own demand, while combining consumers per phase across kiosks
        # still grows N (and shrinks DCF) to give the cross-kiosk diversity.
        by_admd_phase = {}
        for k in kiosks:
            erven = [e for e in _get(k, "erfs", []) if _is_active(e)]
            cls_id = _get(k, "loadClass") or default_cls
            three_ph = class_is_3ph(cls_id, lib)
            total_conns += count_weighted_conns(erven, three_ph)
            override_kva += sum_override_kva(erven)
            sl_kva += float(_get(k, "streetLightKVA", 0) or 0)
            admd = resolve_demand_param(est, cls_id, project_admd,
                                        _get(k, "admdOverride"), lib,
                                        _get(k, "loadClass"))
            for e in erven:
                if _has_override(e):
                    continue
                for p in _erf_phases(e, three_ph):
                    key = (admd, p)
                    by_admd_phase[key] = by_admd_phase.get(key, 0) + 1
        for (admd, _p), n in by_admd_phase.items():
            total_kva += calc_demand(n, est, corr, admd)["totalKVA"]

    total_kva = _round2(total_kva + override_kva + sl_kva)
    current_a = _round2(total_kva * 1000.0 / (math.sqrt(3) * V_3PH_LINE)) if total_kva else 0
    return {
        "totalKVA": total_kva,
        "currentA": current_a,
        "overrideKVA": _round2(override_kva),
        "streetLightKVA": _round2(sl_kva),
        "conns": total_conns,
        "numKiosks": len(kiosks),
    }


def _subtree(kiosk_id, children, seen=None):
    """Return the kiosk_id plus all descendants fed (transitively) from it."""
    if seen is None:
        seen = set()
    if kiosk_id in seen:
        return []
    seen.add(kiosk_id)
    out = [kiosk_id]
    for child in children.get(kiosk_id, []):
        out.extend(_subtree(child, children, seen))
    return out


def feeder_tree_rollup(kiosks, settings):
    """Per-kiosk feeder demand: the diversified demand of that kiosk *plus every
    kiosk fed from it* (transitively via ``fedFrom``).

    The cable feeding a kiosk must carry its whole downstream subtree, so this
    is the current used to size/volt-drop-check that feeder segment. Diversity
    applies across the combined subtree (per-phase superposition).
    """
    by_id = {}
    children = {}
    for k in kiosks:
        kid = _get(k, "id")
        by_id[kid] = k
        parent = _get(k, "fedFrom") or "source"
        children.setdefault(parent, []).append(kid)

    rollup = {}
    for k in kiosks:
        kid = _get(k, "id")
        sub_ids = _subtree(kid, children)
        sub_kiosks = [by_id[i] for i in sub_ids if i in by_id]
        d = feeder_demand(sub_kiosks, settings)
        rollup[kid] = {
            "feederKVA": d["totalKVA"],
            "feederA": d["currentA"],
            "subtreeConns": d["conns"],
            "subtreeKiosks": len(sub_kiosks),
        }
    return rollup


def _kiosk_root(kiosk_id, by_id, valid_roots, default_root):
    """Walk ``fedFrom`` up the kiosk chain to the feeding minisub.

    Returns the minisub id at the root of the chain; unknown/legacy roots and
    cycles resolve to ``default_root`` (the first minisub).
    """
    seen = set()
    cur = kiosk_id
    while cur in by_id and cur not in seen:
        seen.add(cur)
        cur = _get(by_id[cur], "fedFrom") or default_root
    return cur if cur in valid_roots else default_root


def run_admd(request):
    """Entry point for the /api/analysis/admd route.

    ``request`` is a dict with ``settings``, ``kiosks`` and optionally
    ``minisubs``. ADMD diversity is applied per minisub — across all loads
    downstream of it — per standard NRS 034 practice; the network total is the
    SUM of the per-minisub diversified demands (diversity earned on one
    transformer cannot be banked by another), optionally scaled by a
    network-level diversity factor (``settings.networkDiversity``, default 1)
    for NMD / MV-feeder estimation. With a single minisub and factor 1 this
    equals the plain all-kiosk diversified total.
    """
    settings = dict(request.get("settings") or {})
    kiosks = request.get("kiosks") or []
    minisubs = request.get("minisubs") or []
    if not minisubs:
        # Legacy projects: one implicit source. Its id matches the frontend's
        # historical fedFrom value so old references resolve.
        minisubs = [{"id": "source", "name": "Minisub 1"}]

    rollup = feeder_tree_rollup(kiosks, settings)

    kiosk_results = []
    for k in kiosks:
        r = kiosk_demand(k, settings)
        kid = _get(k, "id")
        r["kioskId"] = kid
        r["name"] = _get(k, "name", "")
        r["fedFrom"] = _get(k, "fedFrom") or "source"
        r.update(rollup.get(kid, {}))
        kiosk_results.append(r)

    # Group kiosks under their feeding minisub and diversify per group.
    by_id = {_get(k, "id"): k for k in kiosks}
    ms_ids = [_get(m, "id") for m in minisubs]
    valid_roots = set(ms_ids)
    default_root = ms_ids[0]
    groups = {mid: [] for mid in ms_ids}
    for k in kiosks:
        groups[_kiosk_root(_get(k, "id"), by_id, valid_roots, default_root)].append(k)

    ms_results = []
    sum_kva = 0.0
    tot_override = tot_sl = 0.0
    tot_conns = 0
    for m in minisubs:
        mid = _get(m, "id")
        d = feeder_demand(groups[mid], settings)
        ms_results.append({"minisubId": mid, "name": _get(m, "name", ""), **d})
        sum_kva += d["totalKVA"]
        tot_override += d["overrideKVA"]
        tot_sl += d["streetLightKVA"]
        tot_conns += d["conns"]

    try:
        ndf = float(settings.get("networkDiversity") or 1.0)
    except (TypeError, ValueError):
        ndf = 1.0
    if ndf <= 0:
        ndf = 1.0
    total_kva = _round2(sum_kva * ndf)
    total = {
        "totalKVA": total_kva,
        "currentA": _round2(total_kva * 1000.0 / (math.sqrt(3) * V_3PH_LINE)) if total_kva else 0,
        "overrideKVA": _round2(tot_override),
        "streetLightKVA": _round2(tot_sl),
        "conns": tot_conns,
        "numKiosks": len(kiosks),
        "sumKVA": _round2(sum_kva),           # Σ minisub demands before NDF
        "networkDiversity": ndf,
    }

    return {
        "kiosks": kiosk_results,
        "minisubs": ms_results,
        "total": total,
        "settings": {
            "estimationMethod": settings.get("estimationMethod", "Empirical"),
            "correctionMethod": settings.get("correctionMethod", "AMEU"),
            "loadClass": settings.get("loadClass", "urban1"),
            "admd": settings.get("admd", DEFAULT_ADMD),
            "riskZ": settings.get("riskZ") or DEFAULT_RISK_Z,
            "networkDiversity": ndf,
        },
    }
