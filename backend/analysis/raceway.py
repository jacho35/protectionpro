"""Underground Raceway / Conduit Fill Analysis.

Checks each defined raceway (conduit with assigned cables) for:

1. Conduit fill — Σ(cable areas) / conduit internal area, against the
   NEC Chapter 9 Table 1 limits (also common IEC/SANS practice):
     1 cable: 53 %,  2 cables: 31 %,  3+ cables: 40 %
2. Jam ratio — for exactly 3 cables of similar OD pulled together:
     JR = 1.05 · ID / OD_avg   (1.05 allows for conduit ovality at bends)
   A ratio between 2.8 and 3.2 risks cables jamming in a wedge at bends.
3. Grouping derating — IEC 60364-5-52 Table B.52.17 reference method
   (bunched in conduit, item 1): each multicore cable counts as one
   circuit; the factor applies to every cable's ampacity in the group.

Cable outside diameters use an explicit ``od_mm`` when supplied, else a
typical 3/4-core Cu XLPE SWA OD estimated from the conductor size (flagged
in the result — manufacturer data governs for construction).
"""

import math

from ..models.schemas import (
    RacewayRequest, RacewayResults, RacewayResult, RacewayCableRow,
)

# NEC Chapter 9 Table 1 fill limits by cable count
FILL_LIMITS = {1: 53.0, 2: 31.0}
FILL_LIMIT_3_PLUS = 40.0

# Typical internal diameters (mm) for nominal heavy-duty rigid conduit
# (approximate — per SANS 61386 / typical PVC pressure conduit catalogues)
CONDUIT_ID_MM = {
    20: 17.0, 25: 21.4, 32: 27.8, 40: 35.4, 50: 45.1, 63: 57.0,
    75: 68.9, 90: 83.4, 110: 102.7, 125: 117.0, 160: 150.0,
}

# IEC 60364-5-52 Table B.52.17, item 1 (bunched in air, on a surface,
# embedded or enclosed) — factor by number of circuits/multicore cables.
GROUPING_FACTORS = [
    (1, 1.00), (2, 0.80), (3, 0.70), (4, 0.65), (5, 0.60), (6, 0.57),
    (7, 0.54), (8, 0.52), (9, 0.50), (12, 0.45), (16, 0.41), (20, 0.38),
]

# Typical overall diameter (mm) of 3/4-core Cu XLPE SWA cable by conductor
# cross-section (mm²) — catalogue-typical values for OD estimation only.
TYPICAL_OD_MM = {
    1.5: 12.5, 2.5: 13.5, 4: 15.0, 6: 16.5, 10: 19.0, 16: 21.5,
    25: 26.0, 35: 28.5, 50: 32.0, 70: 36.0, 95: 41.0, 120: 45.0,
    150: 50.0, 185: 55.0, 240: 62.0, 300: 68.0, 400: 77.0,
}


def grouping_factor(n_circuits: int) -> float:
    """IEC 60364-5-52 Table B.52.17 item 1; between tabulated counts the
    next-higher count's factor applies (conservative)."""
    if n_circuits <= 0:
        return 1.0
    factor = GROUPING_FACTORS[-1][1]
    for count, f in GROUPING_FACTORS:
        if n_circuits <= count:
            factor = f
            break
    return factor


def estimate_od_mm(size_mm2: float) -> float:
    """Typical 3/4-core SWA OD for a conductor size; log-interpolates
    between catalogue points, clamps at the table ends."""
    sizes = sorted(TYPICAL_OD_MM)
    if size_mm2 <= sizes[0]:
        return TYPICAL_OD_MM[sizes[0]]
    if size_mm2 >= sizes[-1]:
        return TYPICAL_OD_MM[sizes[-1]]
    for lo, hi in zip(sizes, sizes[1:]):
        if lo <= size_mm2 <= hi:
            t = (math.log(size_mm2) - math.log(lo)) / (math.log(hi) - math.log(lo))
            return TYPICAL_OD_MM[lo] + t * (TYPICAL_OD_MM[hi] - TYPICAL_OD_MM[lo])
    return TYPICAL_OD_MM[sizes[-1]]


def conduit_internal_diameter(nominal_mm: float, override_id_mm: float) -> float:
    if override_id_mm and override_id_mm > 0:
        return override_id_mm
    if nominal_mm in CONDUIT_ID_MM:
        return CONDUIT_ID_MM[nominal_mm]
    # Unknown nominal: assume ID ≈ 0.9 × nominal (typical wall ratio)
    return 0.9 * nominal_mm


def run_raceway_analysis(req: RacewayRequest) -> RacewayResults:
    results = []
    for rw in req.raceways:
        warnings = []
        conduit_id = conduit_internal_diameter(rw.conduit_nominal_mm, rw.conduit_id_mm)
        if not rw.conduit_id_mm and rw.conduit_nominal_mm not in CONDUIT_ID_MM:
            warnings.append(
                f"Nominal {rw.conduit_nominal_mm:g} mm is not a standard conduit size — "
                f"internal diameter assumed {conduit_id:.1f} mm (0.9 × nominal).")
        conduit_area = math.pi * (conduit_id / 2) ** 2

        rows = []
        total_cable_area = 0.0
        for c in rw.cables:
            estimated = not (c.od_mm and c.od_mm > 0)
            od = c.od_mm if not estimated else estimate_od_mm(c.size_mm2 or 25.0)
            if estimated and not c.size_mm2:
                warnings.append(
                    f"Cable '{c.name or c.cable_id}': no size or OD given — "
                    "OD assumed for 25 mm² (set the cable type or an OD).")
            area = math.pi * (od / 2) ** 2
            total_cable_area += area
            rows.append({"cable": c, "od": od, "area": area, "estimated": estimated})

        n = len(rows)
        fill_pct = 100.0 * total_cable_area / conduit_area if conduit_area > 0 else 0.0
        fill_limit = FILL_LIMITS.get(n, FILL_LIMIT_3_PLUS)
        fill_ok = fill_pct <= fill_limit and n > 0

        # Jam ratio — meaningful for 3 cables of similar OD
        jam_ratio = None
        jam_warning = False
        if n == 3:
            ods = [r["od"] for r in rows]
            if max(ods) <= 1.2 * min(ods):
                jam_ratio = 1.05 * conduit_id / (sum(ods) / 3)
                jam_warning = 2.8 <= jam_ratio <= 3.2
                if jam_warning:
                    warnings.append(
                        f"Jam ratio {jam_ratio:.2f} is in the 2.8–3.2 danger band — "
                        "cables may wedge at bends during pulling. Change the "
                        "conduit size to move outside the band.")

        gf = grouping_factor(n)
        cable_rows = []
        derate_fail = False
        for r in rows:
            c = r["cable"]
            derated = (c.rated_amps or 0.0) * gf
            ok = True
            if c.load_amps and c.load_amps > 0:
                ok = derated >= c.load_amps
                if not ok:
                    derate_fail = True
            cable_rows.append(RacewayCableRow(
                cable_id=c.cable_id, name=c.name or c.cable_id,
                od_mm=round(r["od"], 1), od_estimated=r["estimated"],
                area_mm2=round(r["area"], 1),
                rated_amps=c.rated_amps or 0.0,
                derated_amps=round(derated, 1),
                load_amps=c.load_amps or 0.0,
                adequate=ok,
            ))

        if n == 0:
            warnings.append("No cables assigned to this raceway.")
            status = "empty"
        elif not fill_ok:
            status = "fail"
        elif derate_fail:
            status = "fail"
        elif jam_warning:
            status = "warning"
        else:
            status = "pass"

        results.append(RacewayResult(
            name=rw.name,
            conduit_nominal_mm=rw.conduit_nominal_mm,
            conduit_id_mm=round(conduit_id, 1),
            conduit_area_mm2=round(conduit_area, 1),
            cable_area_mm2=round(total_cable_area, 1),
            num_cables=n,
            fill_pct=round(fill_pct, 1),
            fill_limit_pct=fill_limit,
            fill_ok=fill_ok,
            jam_ratio=round(jam_ratio, 2) if jam_ratio is not None else None,
            jam_warning=jam_warning,
            grouping_factor=gf,
            cables=cable_rows,
            status=status,
            warnings=warnings,
        ))

    summary = {
        "total": len(results),
        "pass": sum(1 for r in results if r.status == "pass"),
        "warning": sum(1 for r in results if r.status == "warning"),
        "fail": sum(1 for r in results if r.status == "fail"),
    }
    return RacewayResults(raceways=results, summary=summary)
