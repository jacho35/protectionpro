"""Build the IEC 60364-5-52 reference (Tables B.52.2–B.52.5, B.52.10–B.52.13)
from the TiSoft reproductions rendered to JSON (tisoft*.json), and write
reference_tables.json. Source pages:
https://www.ti-soft.com/en/support/help/electricaldesign/standards/iec-60364-5-52/current-carrying-capacity/
"""
import json, sys, pathlib
src = pathlib.Path(sys.argv[1])
d = {**json.load(open(src / "tisoft.json")), **json.load(open(src / "tisoft2.json"))}
def num(x):
    try: return float(x)
    except ValueError: return None
ref = {}   # ref[key][loaded][method][size] ; key = pvc_cu etc
spec = {"table_b_52_2": ("pvc", 2), "table_b_52_3": ("xlpe", 2),
        "table_b_52_4": ("pvc", 3), "table_b_52_5": ("xlpe", 3)}
for tname, (ins, loaded) in spec.items():
    cond = None
    for row in d[tname]["tables"][0]:
        if row and row[0].startswith("Copper"): cond = "cu"; continue
        if row and row[0].startswith("Alumin"): cond = "al"; continue
        if cond and len(row) == 8 and num(row[0]):
            for m, v in zip(["A1","A2","B1","B2","C","D1","D2"], row[1:]):
                if num(v) is not None:
                    ref.setdefault(f"{ins}_{cond}", {}).setdefault(loaded, {}).setdefault(m, {})[num(row[0])] = num(v)
free = {"table_b_52_10": "pvc_cu", "table_b_52_11": "pvc_al", "table_b_52_12": "xlpe_cu", "table_b_52_13": "xlpe_al"}
cols = [("E",2),("E",3),("F",2),("F",3),("F_flat",3),("G_h",3),("G_v",3)]
for tname, key in free.items():
    for row in d[tname]["tables"][0]:
        if len(row) == 8 and num(row[0]):
            for (m, loaded), v in zip(cols, row[1:]):
                if num(v) is not None:
                    ref.setdefault(key, {}).setdefault(loaded, {}).setdefault(m, {})[num(row[0])] = num(v)
json.dump(ref, open(src / "reference_tables.json", "w"), indent=1)
print({k: {l: sorted(v2) for l, v2 in v.items()} for k, v in ref.items()})
