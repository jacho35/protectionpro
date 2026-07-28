"""Conductor operating temperature → positive/zero-sequence resistance.

The two conductor libraries quote resistance at different temperatures, which
made mixed studies internally inconsistent:

  * ``STANDARD_CABLES`` (underground) stores **hot** values — the 90 °C XLPE /
    70 °C PVC maximum operating temperature — because that is how cable
    datasheets and IEC 60364 volt-drop tables are published.
  * ``STANDARD_OVERHEAD_LINES`` stores **20 °C** values, the codeword-conductor
    convention (BS 215 / IEC 61089).

The engines used both as-is, so in one network the cables ran hot and the
overhead lines ran cold. Aluminium's temperature coefficient is ≈0.004/°C, so a
line at its 75 °C rated conductor temperature carries ~22 % more resistance than
the library's 20 °C figure — which is exactly how much the overhead load-flow
losses and voltage drop were being under-reported.

This module corrects an overhead line's resistance to its operating
temperature::

    R(T) = R₂₀ · [1 + α·(T − 20)]

It is applied once, centrally, when a ``ProjectData`` is built, so every engine
(load flow, fault, harmonics, unbalanced, contingency, reduction, …) sees the
same corrected value without each having to remember.

Underground cables are deliberately left alone: their library values are
already at operating temperature, and re-correcting them would double-count.

The correction is idempotent — the untouched 20 °C value is kept in
``_r20_per_km`` / ``_r0_20_per_km`` and the applied temperature in
``_r_temp_applied_c``, so re-validating a project (or round-tripping it through
``model_dump``) recomputes from the base rather than compounding.
"""

from __future__ import annotations

# Temperature coefficient of resistance at 20 °C (per °C).
TEMP_COEFF = {
    "ACSR": 0.00403,     # steel-reinforced aluminium — aluminium strands carry the current
    "AAAC": 0.00360,     # aluminium alloy (slightly lower than pure aluminium)
    "AAC": 0.00403,
    "ACAR": 0.00380,
    "ALUMINIUM": 0.00403,
    "ALUMINUM": 0.00403,
    "COPPER": 0.00393,
}
DEFAULT_ALPHA = 0.00403          # aluminium — every conductor in the OH library

# Default operating temperature for an overhead line with no explicit prop.
# 75 °C is the conductor temperature the library's own `rated_amps` is quoted
# at (~40 °C ambient, still air), so resistance and ampacity then describe the
# same conductor state. Conservative for a lightly-loaded line — the safe
# direction for losses, volt drop and protection reach — and overridable per
# line with `temperature_c`.
DEFAULT_OVERHEAD_TEMP_C = 75.0
BASE_TEMP_C = 20.0


def alpha_for(material: str | None) -> float:
    """Temperature coefficient for a conductor material name."""
    if not material:
        return DEFAULT_ALPHA
    return TEMP_COEFF.get(str(material).strip().upper(), DEFAULT_ALPHA)


def resistance_at(r20: float, temp_c: float, material: str | None = None) -> float:
    """R(T) = R₂₀·[1 + α(T − 20)], floored at zero."""
    factor = 1.0 + alpha_for(material) * (float(temp_c) - BASE_TEMP_C)
    return max(0.0, float(r20) * factor)


def _num(value, default=None):
    try:
        f = float(value)
    except (TypeError, ValueError):
        return default
    return f


def apply_to_props(props: dict) -> bool:
    """Correct one component's resistance in place. Returns True if changed.

    A no-op unless the component is an overhead feeder. Safe to call repeatedly:
    the 20 °C base is stashed on first use and every later call recomputes from
    it, so the correction never compounds.
    """
    if not isinstance(props, dict):
        return False
    if str(props.get("construction", "")).strip().lower() != "overhead":
        return False

    temp = _num(props.get("temperature_c"), DEFAULT_OVERHEAD_TEMP_C)
    if temp is None:
        temp = DEFAULT_OVERHEAD_TEMP_C
    material = props.get("material") or props.get("conductor_material")

    applied = _num(props.get("_r_temp_applied_c"))
    if applied is not None and abs(applied - temp) < 1e-9:
        return False   # already at this temperature

    changed = False
    for key, base_key in (("r_per_km", "_r20_per_km"), ("r0_per_km", "_r0_20_per_km")):
        # The base is whatever the library gave us the first time round.
        base = _num(props.get(base_key))
        if base is None:
            base = _num(props.get(key))
            if base is None:
                continue
            props[base_key] = base
        props[key] = round(resistance_at(base, temp, material), 6)
        changed = True

    if changed:
        props["_r_temp_applied_c"] = temp
    return changed


def apply_to_components(components) -> int:
    """Correct every overhead feeder in an iterable of components (in place).

    Accepts either dicts or pydantic ``Component`` objects (anything exposing a
    mutable ``props`` mapping and a ``type``). Returns the number corrected.
    """
    n = 0
    for comp in components or []:
        if isinstance(comp, dict):
            ctype, props = comp.get("type"), comp.get("props")
        else:
            ctype, props = getattr(comp, "type", None), getattr(comp, "props", None)
        if ctype != "cable" or not isinstance(props, dict):
            continue
        if apply_to_props(props):
            n += 1
    return n


def base_resistance(props: dict, key: str = "r_per_km", default: float = 0.1) -> float:
    """The uncorrected 20 °C resistance, for callers that must start there.

    A minimum-fault study (IEC 60909-0 §5.3.1) scales resistance from 20 °C to
    the assumed fault-time conductor temperature; it must not compound on top of
    an operating-temperature correction already applied here.
    """
    base_key = "_r20_per_km" if key == "r_per_km" else "_r0_20_per_km"
    val = _num(props.get(base_key))
    if val is not None:
        return val
    return _num(props.get(key), default) or default
