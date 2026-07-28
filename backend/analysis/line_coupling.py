"""Zero-sequence mutual coupling between parallel overhead circuits.

``num_parallel`` used to be handled as a plain divide: n circuits in parallel
gave Z₀_eff = Z₀_self / n. That is right for the positive sequence, where the
circuits are magnetically independent for practical purposes, and wrong for the
zero sequence, where they are not.

Zero-sequence current is in phase in all three conductors of a circuit and
returns through earth. Two circuits strung on the same tower therefore share a
large mutual coupling through that common earth-return path, and the mutual term
*raises* the effective zero-sequence impedance well above Z₀_self / n. Getting
this wrong skews every earth-fault current on a double-circuit line — by a
factor of ~1.7 on a typical MV tower.

With n identical coupled circuits each carrying I₀/n::

    V₀ = [Z₀s + (n−1)·Z₀m] · (I₀/n)
    Z₀_eff = V₀ / I₀ = [Z₀s + (n−1)·Z₀m] / n

which collapses to Z₀s/n when Z₀m = 0 (the old behaviour) and to Z₀s when
Z₀m = Z₀s (perfectly coupled — paralleling buys nothing in the zero sequence).

Z₀m comes from Carson's earth-return formulation. Per phase pair::

    z_m = π²f·10⁻⁴ + j·4πf·10⁻⁴·ln(D_e / D_m)      Ω/km
    D_e = 658.87·√(ρ / f)                            m  (equivalent earth depth)

and the zero-sequence mutual between two three-phase circuits is Z₀m = 3·z_m,
with D_m the geometric mean distance between the two circuits' conductors.
"""

from __future__ import annotations

import cmath
import math

# Default geometric mean distance between two circuits on a shared tower (m).
# Representative of an MV/sub-transmission double-circuit tower; the true value
# is the geometric mean of the nine inter-circuit conductor distances.
DEFAULT_CIRCUIT_SPACING_M = 8.0
# Default soil resistivity (Ω·m) — the usual "average soil" assumption, and the
# same figure IEEE 80 work in this tool defaults to.
DEFAULT_SOIL_RESISTIVITY = 100.0
# Physical ceiling on the coupling ratio. Z₀m < Z₀s always (the mutual GMD
# exceeds the self GMR), and letting the ratio reach 1 would make parallel
# circuits infinitely lossy in the zero sequence.
MAX_COUPLING_RATIO = 0.95


def earth_return_depth_m(rho_ohm_m: float = DEFAULT_SOIL_RESISTIVITY,
                         freq_hz: float = 50.0) -> float:
    """Carson's equivalent earth-return depth D_e (m)."""
    rho = max(1e-6, float(rho_ohm_m))
    f = max(1e-6, float(freq_hz))
    return 658.87 * math.sqrt(rho / f)


def mutual_z0_per_km(spacing_m: float = DEFAULT_CIRCUIT_SPACING_M,
                     rho_ohm_m: float = DEFAULT_SOIL_RESISTIVITY,
                     freq_hz: float = 50.0) -> complex:
    """Zero-sequence mutual impedance between two 3-phase circuits (Ω/km)."""
    f = max(1e-6, float(freq_hz))
    d_m = max(0.1, float(spacing_m))
    d_e = earth_return_depth_m(rho_ohm_m, f)
    # Below the earth-return depth the log term would go negative — physically
    # the circuits would have to be kilometres apart, so clamp instead.
    ratio = max(1.0, d_e / d_m)
    r_e = (math.pi ** 2) * f * 1e-4
    x_e = 4.0 * math.pi * f * 1e-4 * math.log(ratio)
    return complex(3.0 * r_e, 3.0 * x_e)


def _num(value, default):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def coupling_mode(props: dict) -> str:
    """Resolve the coupling mode for a feeder.

    Overhead circuits on a shared tower are coupled — that is the physical
    default, so `auto` applies unless the user says otherwise. Underground
    parallel circuits default to `none`: they are usually laid in separate
    trenches or ducts and their sheaths carry much of the zero-sequence return,
    so the shared-tower model does not transfer.
    """
    mode = str(props.get("z0_coupling", "") or "").strip().lower()
    if mode in ("none", "auto", "manual"):
        return mode
    return "auto" if str(props.get("construction", "")).strip().lower() == "overhead" else "none"


def parallel_z0_scale(props: dict, z0_self_per_km: complex,
                      freq_hz: float = 50.0) -> complex:
    """Factor F with Z₀_eff = F · Z₀_self for the parallel group.

    F = 1/n with no coupling (the old behaviour), and
    F = [1 + (n−1)·Z₀m/Z₀s] / n with it.
    """
    try:
        n = max(1, int(_num(props.get("num_parallel", 1), 1)))
    except (TypeError, ValueError):
        n = 1
    if n <= 1:
        return complex(1.0, 0.0)

    mode = coupling_mode(props)
    if mode == "none":
        return complex(1.0 / n, 0.0)

    if mode == "manual":
        k = _num(props.get("z0_mutual_factor", 0.0), 0.0)
        ratio = complex(min(max(k, 0.0), MAX_COUPLING_RATIO), 0.0)
    else:
        if abs(z0_self_per_km) < 1e-12:
            return complex(1.0 / n, 0.0)
        z0m = mutual_z0_per_km(
            _num(props.get("circuit_spacing_m"), DEFAULT_CIRCUIT_SPACING_M),
            _num(props.get("soil_resistivity_ohm_m"), DEFAULT_SOIL_RESISTIVITY),
            freq_hz,
        )
        ratio = z0m / z0_self_per_km
        if abs(ratio) > MAX_COUPLING_RATIO:
            ratio = ratio * (MAX_COUPLING_RATIO / abs(ratio))

    return (1.0 + (n - 1) * ratio) / n


def coupling_summary(props: dict, z0_self_per_km: complex,
                     freq_hz: float = 50.0) -> dict | None:
    """Human-readable description of the coupling applied, or None if it is not.

    Used to disclose the assumption in study output — the correction is large
    enough that a reader must be told it was made and on what geometry.
    """
    n = max(1, int(_num(props.get("num_parallel", 1), 1)))
    if n <= 1:
        return None
    mode = coupling_mode(props)
    scale = parallel_z0_scale(props, z0_self_per_km, freq_hz)
    naive = complex(1.0 / n, 0.0)
    out = {
        "num_parallel": n,
        "mode": mode,
        "z0_scale": [round(scale.real, 6), round(scale.imag, 6)],
        "vs_uncoupled": round(abs(scale) / abs(naive), 4) if abs(naive) else None,
    }
    if mode == "auto":
        spacing = _num(props.get("circuit_spacing_m"), DEFAULT_CIRCUIT_SPACING_M)
        rho = _num(props.get("soil_resistivity_ohm_m"), DEFAULT_SOIL_RESISTIVITY)
        z0m = mutual_z0_per_km(spacing, rho, freq_hz)
        out["circuit_spacing_m"] = spacing
        out["soil_resistivity_ohm_m"] = rho
        out["z0_mutual_per_km"] = [round(z0m.real, 5), round(z0m.imag, 5)]
        if abs(z0_self_per_km) > 1e-12:
            raw = abs(z0m / z0_self_per_km)
            # Report the ratio actually USED, not the raw one — the two differ
            # when the cap binds, and disclosing the raw value would describe a
            # calculation the engine did not perform.
            out["coupling_ratio"] = round(min(raw, MAX_COUPLING_RATIO), 4)
            if raw > MAX_COUPLING_RATIO:
                out["coupling_ratio_capped"] = True
                out["coupling_ratio_raw"] = round(raw, 4)
    elif mode == "manual":
        raw = _num(props.get("z0_mutual_factor", 0.0), 0.0)
        out["coupling_ratio"] = round(min(max(raw, 0.0), MAX_COUPLING_RATIO), 4)
        if raw > MAX_COUPLING_RATIO:
            out["coupling_ratio_capped"] = True
            out["coupling_ratio_raw"] = round(raw, 4)
    return out


def coupling_note(props: dict, z0_self_per_km: complex,
                  freq_hz: float = 50.0) -> str | None:
    """One-line disclosure of the parallel zero-sequence treatment, or None.

    The correction is large enough (≈1.7× on a typical MV double-circuit tower)
    that a study report must state that it was made and on what geometry — the
    numbers are not reproducible by a reviewer otherwise. Returns None when
    there is nothing to disclose: a single circuit, or the documented
    underground default where parallel runs sit in separate trenches and the
    plain divide is the intended model.

    The sentence carries no element name — callers hold that (fault analysis
    prefixes it, unbalanced load flow puts it in the warning's element field).
    """
    s = coupling_summary(props, z0_self_per_km, freq_hz)
    if s is None:
        return None                      # single circuit
    n = s["num_parallel"]
    mode = s["mode"]

    if mode == "none":
        if str(props.get("construction", "")).strip().lower() != "overhead":
            return None                  # underground default — not news
        # Overhead with coupling switched OFF is a deliberate override that
        # moves earth-fault current the non-conservative way. Say so.
        return (f"{n} parallel OVERHEAD circuits with zero-sequence mutual "
                f"coupling disabled (z0_coupling: none) — Z0 = Z0_self/{n}. "
                f"Circuits sharing a tower are coupled through the common "
                f"earth return, so this understates Z0 and OVERSTATES "
                f"earth-fault current.")

    parts = [f"{n} parallel circuits: zero-sequence mutual coupling applied, "
             f"Z0_eff = [Z0s + {n - 1}·Z0m]/{n}"]
    if mode == "auto":
        parts.append(f" (Carson earth return, GMD {s['circuit_spacing_m']:g} m, "
                     f"soil {s['soil_resistivity_ohm_m']:g} Ω·m, {freq_hz:g} Hz)")
    else:
        parts.append(" (Z0m/Z0s entered manually)")
    ratio = s.get("coupling_ratio")
    if ratio is not None:
        parts.append(f"; Z0m/Z0s = {ratio:.3f}")
        if s.get("coupling_ratio_capped"):
            parts.append(f" (capped from {s['coupling_ratio_raw']:.3f} at "
                         f"{MAX_COUPLING_RATIO} — the mutual cannot reach the "
                         f"self impedance)")
    vs = s.get("vs_uncoupled")
    if vs:
        parts.append(f"; effective Z0 is {vs:.2f}× the uncoupled Z0/{n}")
    return "".join(parts) + "."


def phase_angle_deg(z: complex) -> float:
    """Convenience for reporting."""
    return math.degrees(cmath.phase(z))
