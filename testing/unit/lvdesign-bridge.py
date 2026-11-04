"""stdin: {"kind": "earth" | "design" | "admd", "body": {...}} → stdout: the engine's answer (used by lvdesign-ui.test.js)."""
import json
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
req = json.load(sys.stdin)
kind, body = req["kind"], req["body"]
if kind == "earth":
    from backend.analysis.retic_earth import run_retic_earth_check as run
elif kind == "design":
    from backend.analysis.retic_lv_design import run_retic_lv_design as run
elif kind == "admd":
    from backend.analysis.admd import run_admd as run
else:
    raise SystemExit("unknown kind " + kind)
print(json.dumps(run(body), default=str))
