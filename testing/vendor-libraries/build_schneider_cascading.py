#!/usr/bin/env python3
"""Schneider Electric cascading (back-up protection) tables, Ue 380-415 V AC (Ph/N 220-240 V AC).

Writes (never edit the outputs by hand):
  testing/vendor-libraries/schneider_cascading.json   the tables — re-extracted only with --pdf
  frontend/js/vendor-cascading.js                     CASCADE_TABLES for frontend/js/cascading.js
  backend/analysis/cascading_data.py                  the same tables + library id -> model map for cascading.py

Usage:
  python testing/vendor-libraries/build_schneider_cascading.py                 rebuild the outputs from the JSON
  python testing/vendor-libraries/build_schneider_cascading.py --pdf <guide>   re-extract the JSON from the guide first

Source: Schneider Electric "Selectivity, Cascading and Coordination Guide" 2025 (LVPED318033EN, version 3.0),
https://www.se.com/nz/en/download/document/LVPED318033EN/ — pages A-197 to A-203 (PDF pages 205-211):
  A-197  upstream iC40, iC60 N/H/L, iC60P, C120 N/H, NG125 N/H/L   -> downstream iC60, C120, NG125
  A-198  upstream NSXm E/B/F/N/H, NSX100 B/F/N/H/S/L              -> downstream iC60
  A-199  upstream NSXm, NSX100                                     -> downstream C120, NG125, NSXm, NSX100
  A-200  upstream NSX160, NSX250                                   -> downstream iC60
  A-201  upstream NSX160, NSX250                                   -> downstream C120, NG125, NSXm, NSX100
  A-202  upstream NSX160/250, NSX400/630                           -> downstream NSXm, NSX100...NSX630
  A-203  upstream NS630b-1600, NS1600-3200, MTZ1 L1, MTZ2 L1       -> downstream NSX100...NSX630, NS630b-1600
Each value is the reinforced breaking capacity (kA) of the downstream breaker according to IEC/EN 60947-2 Annex A.
A blank cell = no tested combination (no cascading).

Extraction: `pdftotext -bbox` word positions. The upstream "Icu (kA)" header row gives one x position per column;
every number in a table row goes to the column whose x it shares (cells are left aligned, so a blank cell is a missing
x, never a shifted value). Checked against the page renders.

What the guide says about using the tables (A-193 / A-194), and how the app applies it
--------------------------------------------------------------------------------------
* The values cover every fault type (phase-phase, phase-neutral, phase-earth) in every earthing system; in IT they
  do not cover the double fault. Valid on 380-415 V three-phase systems and, for line-to-earth faults, on the
  220-240 V Ph/N circuits of them (the 220-240 V tables, not carried here, are only for line-to-neutral faults).
* Three breakers A > B > C in series: C is covered when A + C reaches the fault at C (whatever B + C gives), or when
  B + C does and B is itself covered by A. cascading.py / cascading.js apply exactly this.
* Upstream iC60L and iC60P columns are per rating band of the UPSTREAM breaker (<= 25 / 32-40 / 50-63 A,
  20-40 / 50-63 A); a downstream row is per its own rating band.

Left out (no entry in the app's breaker libraries): downstream iC40 / iCV40 / iCVm40, RCBOs, the ARC / VigiARC
add-on rows (same values as the plain breaker), iC60P (+ limiter), NS630b-1600. The 440 V and 220-240 V tables
(A-204 to A-211), fuse -> MCB and motor-protection cascading are not transcribed.
"""
import argparse
import html
import json
import pprint
import re
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
DATA = HERE / "schneider_cascading.json"
JS_OUT = ROOT / "frontend" / "js" / "vendor-cascading.js"
PY_OUT = ROOT / "backend" / "analysis" / "cascading_data.py"
LIBRARY = HERE / "schneider_breakers.json"

DOC = "LVPED318033EN"
PAGES = (205, 211)          # PDF pages of A-197 ... A-203 (PDF page = label + 8)
NUM = re.compile(r"^\d+(\.\d+)?$")
# downstream rows kept: products the breaker libraries carry (+ NG125)
KEEP_DOWN = re.compile(r"^(iC60[NHL]|C120[NH]|NG125[NHL]|NSXm[EBFNH]|NSX(100|160|250|400|630)[BFNHSL])$")


# ─── extraction ───
WORD = re.compile(r'<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="[\d.]+">([^<]*)</word>')


def _lines(page):
    words = [dict(x0=float(a), y0=float(b), x1=float(c), t=html.unescape(t)) for a, b, c, t in WORD.findall(page)]
    words.sort(key=lambda w: (round(w["y0"]), w["x0"]))
    lines = []
    for w in words:
        if lines and abs(lines[-1]["y"] - w["y0"]) < 2.5:
            lines[-1]["w"].append(w)
        else:
            lines.append({"y": w["y0"], "w": [w]})
    for ln in lines:
        ln["w"].sort(key=lambda w: w["x0"])
        ln["text"] = " ".join(w["t"] for w in ln["w"])
    return lines


def _model(family, level):
    level = re.sub(r"\s*\[\d\]", "", level or "").strip()
    if family.startswith("MTZ"):
        return f"{family} {level}"
    return family if family.endswith(level) else family + level       # iC60P / P -> iC60P


def _band(text):
    """Rating text -> [lo, hi] amps ('0.5-25', '<= 16', '>= 20-<=40', '32', 'y 25' (≤ 25), '32/40')."""
    t = text.replace(" ", "").replace("y", "<=")
    if t.startswith("<="):
        return [0, float(t[2:])]
    m = re.match(r"^>=?(\d+(?:\.\d+)?)-<=?(\d+(?:\.\d+)?)$", t)
    if m:
        return [float(m.group(1)), float(m.group(2))]
    parts = [float(x) for x in re.split(r"[-/]", t) if x]
    return [min(parts), max(parts)]


def extract(pdf):
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "bbox.html"
        subprocess.run(["pdftotext", "-f", str(PAGES[0]), "-l", str(PAGES[1]), "-bbox", str(pdf), str(out)],
                       check=True)
        txt = out.read_text(encoding="utf-8")
    tables = []
    for pi, page in enumerate(txt.split("<page ")[1:]):
        label = f"A-{PAGES[0] - 8 + pi}"
        L = _lines(page)
        i = 0
        while i < len(L):
            if not L[i]["text"].startswith("Upstream CB"):
                i += 1
                continue
            fam_line, lvl_line = L[i], L[i + 1]
            j, cons_line = i + 2, None
            while "Icu" not in L[j]["text"]:
                cons_line, j = L[j], j + 1
            cols = [w for w in L[j]["w"] if NUM.match(w["t"])]
            xs = [c["x0"] for c in cols]

            def col_of(x):
                k = min(range(len(xs)), key=lambda c: abs(xs[c] - x))
                if abs(xs[k] - x) > 6:
                    raise ValueError(f"{label}: value at x={x:.1f} is in no column {xs}")
                return k

            def spread(line, skip=()):
                res = {}
                for w in (line["w"] if line else []):
                    if w["t"] in skip or w["x0"] < xs[0] - 6:
                        continue
                    k = max(c for c in range(len(xs)) if xs[c] - 6 <= w["x0"])
                    res.setdefault(k, []).append(w["t"])
                return {k: " ".join(v) for k, v in res.items()}

            fam, lvl, cons = spread(fam_line, ("Upstream", "CB")), spread(lvl_line), spread(cons_line)
            upstream, cur_fam, cur_lvl = [], None, None
            for k, c in enumerate(cols):
                cur_fam = fam.get(k, cur_fam)
                cur_lvl = lvl.get(k, cur_lvl)
                upstream.append({"model": _model(cur_fam, cur_lvl), "icu_ka": float(c["t"]),
                                 "rating_a": _band(cons[k]) if k in cons else None})
            while "Rating" not in L[j]["text"]:
                j += 1
            rating_x = next(w["x0"] for w in L[j]["w"] if w["t"] == "Rating")
            icu_x = next(w["x0"] for w in L[j]["w"] if w["t"] == "Icu")
            j += 1
            rows, name = [], None
            while j < len(L):
                t = L[j]["text"]
                if re.match(r"^(\[1\]|Upstream CB|VD:|se\.com|A-\d+)", t):
                    break
                ws = L[j]["w"]
                nm = [w["t"] for w in ws if w["x1"] < rating_x - 1 and not re.match(r"^\[\d\]$", w["t"])]
                rt = [w["t"] for w in ws if rating_x - 1 <= w["x0"] < icu_x - 1]
                vals = {col_of(w["x0"]): float(w["t"]) for w in ws if w["x0"] >= xs[0] - 6 and NUM.match(w["t"])}
                if nm and (rt or vals):
                    name = " ".join(nm)
                elif nm:                       # a name-only line: a variant listed under the row (ARC add-on)
                    name = None
                if name and rt:
                    rows.append({"model": name.replace(" ", ""), "rating_a": _band(" ".join(rt)),
                                 "values": [vals.get(k) for k in range(len(cols))]})
                j += 1
            rows = [r for r in rows if KEEP_DOWN.match(r["model"])]
            tables.append({"page": label, "upstream": upstream, "rows": rows})
            i = j
    return {
        "format": "pp-cascading/1",
        "manufacturer": "Schneider Electric",
        "source": f"Schneider Electric, Selectivity, Cascading and Coordination Guide 2025 ({DOC} v3.0), "
                  "pages A-197 to A-203",
        "standard": "IEC/EN 60947-2 Annex A",
        "ue": "380-415 V AC (Ph/N 220-240 V AC)",
        "tables": tables,
    }


# ─── outputs ───
def library_models():
    lib = json.loads(LIBRARY.read_text())
    return {e["data"]["id"]: [e["data"]["model"], e["data"]["trip_rating_a"]]
            for e in lib["entries"] if e.get("kind") == "cbs"}


def write_outputs(data):
    body = json.dumps(data, indent=1)
    JS_OUT.write_text(
        "// GENERATED by testing/vendor-libraries/build_schneider_cascading.py — do not edit by hand.\n"
        f"// {data['manufacturer']} cascading tables ({data['standard']}), Ue {data['ue']}: {data['source']}.\n"
        "// Read through Cascading (cascading.js).\n"
        f"const CASCADE_TABLES = [{body}];\n", encoding="utf-8")
    PY_OUT.write_text(
        '"""GENERATED by testing/vendor-libraries/build_schneider_cascading.py — do not edit.\n\n'
        f"{data['manufacturer']} cascading tables ({data['standard']}), Ue {data['ue']}.\n"
        f"Source: {data['source']}.\n"
        "LIBRARY_MODELS: library breaker id -> [model, rating A], so a diagram breaker's `standard_type`\n"
        'resolves to its table row. Read through cascading.py.\n"""\n\n'
        f"CASCADE_TABLES = [{pprint.pformat(data, width=118, sort_dicts=False)}]\n\n"
        f"LIBRARY_MODELS = {pprint.pformat(library_models(), width=118)}\n", encoding="utf-8")
    n = sum(len(t["rows"]) for t in data["tables"])
    print(f"{len(data['tables'])} tables, {n} downstream rows -> {JS_OUT.name}, {PY_OUT.name}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", help="the guide PDF, to re-extract schneider_cascading.json")
    a = ap.parse_args()
    if a.pdf:
        data = extract(a.pdf)
        DATA.write_text(json.dumps(data, indent=1) + "\n", encoding="utf-8")
    data = json.loads(DATA.read_text())
    write_outputs(data)


if __name__ == "__main__":
    sys.exit(main())
