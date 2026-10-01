"""Diff the engine's IEC 60364-5-52 capacities against the reference.

Pre-fix (commit 9a5433d) this compared the single-valued IEC_AMPACITY_TABLE
and found most columns matched neither the 2- nor the 3-loaded table (see
reviews/IEC_60364_TABLES_REVIEW.md). Post-fix it checks base_ampacity_a(loaded=2|3)
against the reference cell by cell; every row should read "neither 0".

    python testing/iec-60364-tables-review/v1_diff.py [reference.json]
"""
import json, sys, pathlib
from backend.analysis.iec_60364_tables import base_ampacity_a
src = sys.argv[1] if len(sys.argv) > 1 else pathlib.Path(__file__).with_name("iec_60364_5_52_data.json")
ref = json.load(open(src))
ref = ref.get("ampacity", ref)
IEC_AMPACITY_TABLE = {}
for key, by_l in ref.items():
    for l, by_m in by_l.items():
        for m, cells in by_m.items():
            for size in cells:
                v = base_ampacity_a(float(size), m, key.split("_")[1], key.split("_")[0], int(l))
                IEC_AMPACITY_TABLE.setdefault(float(size), {}).setdefault(m + "@" + l, {})[key] = v
tot = {}
for size, methods in IEC_AMPACITY_TABLE.items():
    for m, cells in methods.items():
        for key, val in cells.items():
            if val is None: continue
            meth, want = m.split("@")
            r2 = ref.get(key, {}).get("2", {}).get(meth, {}).get(str(float(size))) if want == "2" else None
            r3 = ref.get(key, {}).get("3", {}).get(meth, {}).get(str(float(size))) if want == "3" else None
            t = tot.setdefault((m, key), {"n": 0, "eq2": 0, "eq3": 0, "neither": []})
            t["n"] += 1
            if r2 is not None and abs(r2 - val) < 1e-9: t["eq2"] += 1
            elif r3 is not None and abs(r3 - val) < 1e-9: t["eq3"] += 1
            else: t["neither"].append((size, val, r2, r3))
for (m, key), t in sorted(tot.items()):
    bad = t["neither"]
    print(f"{m:3s} {key:8s} n={t['n']:2d}  =2-loaded {t['eq2']:2d}  =3-loaded {t['eq3']:2d}  neither {len(bad):2d}"
          + (f"  e.g. {bad[:3]}" if bad else ""))
