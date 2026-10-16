"""Breaker trip-unit settings shared by the clearing-time and duty engines.

Mirrors the frontend's ``cbPickupBase`` / ``cbPickupRefA`` / ``cbElementsA`` /
``cbThermalCurveTime`` (frontend/js/constants.js): both sides must turn a
pickup multiple into the same amps.

Reference current of a pickup
-----------------------------
The magnetic, short-time and instantaneous pickups are multiples of a
reference current — **Ir** (= ``trip_rating_a`` × ``thermal_pickup``), the
convention of the free-number fields and the generic trip units, or **In**
(``trip_rating_a``) where the manufacturer fixes the element against In: the
Ii of Schneider's TM-D and MicroLogic, ABB's I3. Lowering such a unit's Ir
dial leaves Ii where it is. ``props["pickup_base"]`` holds the non-default
ones, e.g. ``{"instantaneous": "In", "magnetic": "In"}``; absent (every
project saved before the field existed) means Ir, byte-identical.

Manufacturer long-time curve
----------------------------
``props["trip_tol"]`` is its published tolerances (pickup zone, short-time and
instantaneous hold / break times) — see frontend cbTripBand; the clearing time
the engines use is the band's maximum.

``props["thermal_curve"]`` is a trip unit's published long-time characteristic:
``{"points": [[M, t], ...]}`` or ``{"param": "long_time_delay", "tables":
{"<value>": [[M, t], ...]}}`` (M a multiple of Ir, t the published maximum
trip time in s).
"""
from __future__ import annotations

import math

PICKUPS = ("magnetic", "short_time", "instantaneous")


def _f(v, default=0.0) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def pickup_base(props, which: str) -> str:
    """``"In"`` or ``"Ir"`` (the default) for ``which`` in :data:`PICKUPS`."""
    pb = props.get("pickup_base")
    return "In" if isinstance(pb, dict) and pb.get(which) == "In" else "Ir"


def pickup_ref_a(props, which: str, in_a: float, ir_a: float) -> float:
    """Amps one unit of the ``which`` pickup multiple stands for. ``in_a`` and
    ``ir_a`` are the caller's own In and Ir (each engine resolves a missing
    trip rating its own legacy way, so the defaults stay byte-identical)."""
    return in_a if pickup_base(props, which) == "In" else ir_a


def pickup_amps(props, which: str, multiple: float, in_a: float, ir_a: float) -> float:
    return pickup_ref_a(props, which, in_a, ir_a) * multiple


def thermal_curve_time(curve, m: float, props=None):
    """Trip time (s) at ``m`` × Ir on a manufacturer long-time curve, or None
    when there is no usable curve (the generic model then applies).

    A smooth monotone log-log curve through the published points; below the first point
    the first segment's slope carries on down to 1.05 Ir (the conventional
    non-tripping current — ``10000`` s, never trips, at or below it) and I²t
    (t ∝ 1/M²) carries on above the last point. A ``tables`` curve picks the
    table whose key is nearest the breaker's ``param`` setting.
    """
    if not isinstance(curve, dict):
        return None
    if curve.get("i2t"):
        # formula curve t = T x (at_m / M)^2 (ABB Ekip: t1 at 3 x I1), T the
        # trip unit's own `param` setting, `floor_s` its self-protection minimum
        if m <= 1.05:
            return 10000.0
        T = _f((props or {}).get(curve.get("param")))
        if T <= 0:
            return None
        return min(max(T * (curve["i2t"] / m) ** 2, _f(curve.get("floor_s"))), 10000.0)
    pts = curve.get("points")
    tables = curve.get("tables")
    if not pts and isinstance(tables, dict) and tables:
        want = _f((props or {}).get(curve.get("param")))
        key = min(tables, key=lambda k: abs(_f(k) - want))
        pts = tables[key]
    if not isinstance(pts, list) or len(pts) < 2:
        return None
    if m <= 1.05:
        return 10000.0
    return min(_loglog_curve(pts, m), 10000.0)


def _loglog_curve(pts, m: float) -> float:
    """Smooth curve through published (M, t) points on log-log axes: a monotone
    cubic (Fritsch-Carlson) — exact at every point, no overshoot, no kink where
    two published segments meet. Below the first point the first segment's
    slope carries on; above the last, I²t (slope -2) takes over and the cubic
    ends on that slope so the join is smooth. Mirrors _cbLogLogCurve in
    frontend/js/constants.js."""
    n = len(pts)
    x = [math.log(p[0]) for p in pts]
    y = [math.log(p[1]) for p in pts]
    h = [x[k + 1] - x[k] for k in range(n - 1)]
    sec = [(y[k + 1] - y[k]) / h[k] for k in range(n - 1)]
    d = [0.0] * n
    d[0] = sec[0]
    for k in range(1, n - 1):
        if sec[k - 1] * sec[k] <= 0:
            d[k] = 0.0
        else:
            w1 = 2 * h[k] + h[k - 1]
            w2 = h[k] + 2 * h[k - 1]
            d[k] = (w1 + w2) / (w1 / sec[k - 1] + w2 / sec[k])
    last = sec[n - 2]
    d[n - 1] = max(-2.0, 3 * last) if last < 0 else last
    lm = math.log(m)
    if lm <= x[0]:
        return math.exp(y[0] + d[0] * (lm - x[0]))
    if lm >= x[n - 1]:
        return math.exp(y[n - 1] - 2 * (lm - x[n - 1]))
    k = 0
    while x[k + 1] < lm:
        k += 1
    u = (lm - x[k]) / h[k]
    u2, u3 = u * u, u * u * u
    ln = ((2 * u3 - 3 * u2 + 1) * y[k] + (u3 - 2 * u2 + u) * h[k] * d[k]
          + (-2 * u3 + 3 * u2) * y[k + 1] + (u3 - u2) * h[k] * d[k + 1])
    return math.exp(ln)


def table_lookup(table, key: float, default):
    """Value of a manufacturer's ``{"<setting>": v}`` table at the setting
    nearest ``key``; ``default`` when there is no table."""
    if not isinstance(table, dict) or not table:
        return default
    best = min(table, key=lambda k: abs(_f(k) - key))
    return table[best]


def tol_at(spec, x: float) -> float:
    """A tolerance that is one number, or ``[[upTo, tol], ..., [None, tol]]`` by
    ``x`` (x times In). Mirrors _cbTolAt in constants.js."""
    if spec is None:
        return 0.0
    if isinstance(spec, (int, float)):
        return float(spec)
    for up_to, tol in spec:
        if up_to is None or x <= up_to:
            return float(tol)
    return 0.0
