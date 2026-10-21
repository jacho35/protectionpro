#!/usr/bin/env python3
"""Digitise the operating-characteristic charts of the CBI MCCB catalogue (thermal-magnetic "D" types).

Input : the CBI MCCB catalogue PDF ("CBI MCCB PDF.pdf", 36 pages): the data-sheet pages of G15D / G25D, F15D / F25D,
        G35D, F35D, K25D, K35D and K50D, each with one or more "Operating Characteristics" charts (minimum + maximum AC
        curve; the dashed DC curves are not traced).
Output: data/cbi_mccb_curves.json — per chart `<page>_<n>`: {"min": [[x In, s], ...], "max": [...], "W": decade width}.
Method: cbi_mccb_chart.py (grid-line calibration, raster tracing of the thick strokes).

    python digitize_cbi_mccb.py "CBI MCCB  PDF.pdf"
"""
import json, os, sys
import cbi_curves as C
import cbi_mccb_chart as M

HERE = os.path.dirname(os.path.abspath(__file__))
# data-sheet page -> number of real charts expected (frames that calibrate cleanly)
PAGES = {5: 3, 7: 2, 9: 2, 11: 2, 15: 1, 17: 1, 21: 2}


def main(pdf):
    out = {}
    for pg, n in PAGES.items():
        P = C.svg_paths(pdf, pg)
        k = 0
        for fr in M.charts(P):
            cal = M.calibrate(P, fr)
            if cal["hit"] < 4 or cal["hit"] < cal["nx"] - 2 or cal["W"] < 55:
                continue
            _, cv = M.curves_in(pdf, pg, P, fr)
            cv = [c for c in cv if c[1][0][1] > 1000]                 # a curve starts at the top of the chart
            assert len(cv) == 2, (pg, k, len(cv))
            mn, mx = cv[0][1], cv[1][1]
            out[f"{pg}_{k}"] = {"min": C.thin_mt(mn), "max": C.thin_mt(mx), "W": round(float(cal["W"]), 2)}
            print(pg, k, "min", len(out[f"{pg}_{k}"]["min"]), out[f"{pg}_{k}"]["min"][-2:], "max", len(out[f"{pg}_{k}"]["max"]), out[f"{pg}_{k}"]["max"][-2:])
            k += 1
        assert k == n, (pg, k, n)
    # F65DV (page 13): the curve pieces join end to end, so the vector strokes are chained instead of tracing a raster.
    # Charts A (Ir up to 32 A), B (32-50 A), C (45-100 A), D (70-250 A); the third frame is not found by the grid detector.
    P = C.svg_paths(pdf, 13)
    frs = M.charts(P)
    frames = {"A": frs[0], "B": frs[1], "C": (326.6, 427.1, 522.4, 643.6), "D": frs[2]}
    for key, fr in frames.items():
        cal = M.calibrate(P, fr)
        assert cal["hit"] >= 5 and 55 < cal["W"] < 65, (key, cal)
        cv = M.curves_vec(P, fr, "1.122")
        assert len(cv) == 2, key
        out[f"13_{key}"] = {"min": C.thin_mt(cv[0]), "max": C.thin_mt(cv[1]), "W": round(float(cal["W"]), 2)}
        print("13", key, "min", out[f"13_{key}"]["min"][-2:], "max", out[f"13_{key}"]["max"][-2:])
    with open(os.path.join(HERE, "data", "cbi_mccb_curves.json"), "w") as f:
        json.dump(out, f)
        f.write("\n")


if __name__ == "__main__":
    main(sys.argv[1])
