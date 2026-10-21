#!/usr/bin/env python3
"""Build the standalone CBI trip-curve viewer from the CBI libraries in this folder.

Reads every cbi_*_breakers.json and its trip-unit profile file (frontend/js/vendor-trip-units-cbi*.js) and embeds the
minimum / maximum curves of each profile in cbi-tool/template.html:
  cbi-tool/cbi-curves.fragment.html   the page body for the Artifact tool (the host wraps it in a document)
  cbi-tool/cbi-curves.html            the same wrapped in a full document, to open from a file

    python testing/vendor-libraries/build_cbi_tool.py
"""
import glob
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
JS = os.path.join(ROOT, "frontend", "js")
ORDER = ["cbi", "qf13", "qf18", "qf26lr", "qf26hr", "g15d", "g25d", "f15d", "f25d", "g35d", "f35d", "k25d", "k35d", "k50d", "f65dv", "jframe"]
LABEL = {"cbi": "L Frame (L20B / L40B)", "qf13": "QF(13)", "qf18": "QF(18)", "qf26lr": "QF(26)LR", "qf26hr": "QF(26)HR", "jframe": "J-Series (JS25 / J25S)"}


def profiles(path):
    src = open(path).read()
    head = "Object.assign(TRIP_UNITS, "
    return json.loads(src[src.index(head) + len(head):src.rindex(");")])


def main():
    fams, profs = [], {}
    for key in ORDER:
        lib = os.path.join(HERE, f"cbi_{'' if key == 'cbi' else key + '_'}breakers.json")
        pjs = os.path.join(JS, "vendor-trip-units-cbi.js" if key == "cbi" else f"vendor-trip-units-cbi-{key}.js")
        if not (os.path.exists(lib) and os.path.exists(pjs)):
            continue
        pr = profiles(pjs)
        entries = []
        for e in json.load(open(lib))["entries"]:
            d = e["data"]
            pid = d["default_trip_unit"]
            p = pr[pid]
            profs[pid] = {"mn": p["curve"]["tol"]["long_time"]["min_points"], "mx": p["curve"]["thermal"]["points"],
                          "p": p["curve"]["tol"]["pickup"]}
            lab = f"{d['trip_rating_a']} A" + (f", {d['model'].split(' ', 1)[1]}" if key.startswith("qf") and " " in d["model"] else "")
            if key == "cbi":
                lab = f"{d['model']} {d['trip_rating_a']} A"
            entries.append({"id": d["id"], "name": d["name"], "label": lab, "rating": d["trip_rating_a"], "pid": pid,
                            "icu": d.get("breaking_ka", 0), "series": f"{d['series']} {d['model']}".strip() if key == "cbi" else d["series"],
                            "source": d.get("source", ""), "check": d.get("check", "")})
        fams.append({"id": key, "label": LABEL.get(key, key.upper()), "entries": entries})
    data = json.dumps({"families": fams, "profiles": profs}, separators=(",", ":"))
    tpl = open(os.path.join(HERE, "cbi-tool", "template.html")).read()
    page = tpl.replace("__DATA__", data)
    out = os.path.join(HERE, "cbi-tool")
    open(os.path.join(out, "cbi-curves.fragment.html"), "w").write(page)
    full = ('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
            '<style>:root{color-scheme:light}body{margin:0;font-size:14px}[hidden]{display:none!important}</style></head><body>' + page + "</body></html>")
    open(os.path.join(out, "cbi-curves.html"), "w").write(full)
    print(f"{sum(len(f['entries']) for f in fams)} breakers, {len(profs)} curve sets, {len(page) // 1024} KB")


if __name__ == "__main__":
    main()
