"""Compliance review — builds the LV test network and runs the REAL fault
engine at maximum (c_max) and minimum (c_min = 0.95, 70 °C) conditions, the
same two studies app.js stores in AppState.faultResults / faultResultsMin.
Writes net_lv.json for v1_core.mjs. Run from the repo root in the backend
image:  docker run --rm -v "$PWD":/work -w /work -e PYTHONPATH=/work \
          protectionpro-backend python testing/compliance-review/build_fault.py"""
import json, os
from backend.models.schemas import Component, ProjectData, Wire
from backend.analysis.fault import run_fault_analysis

def C(i, t, p): return Component(id=i, type=t, x=0, y=0, props=p)
def W(i, a, b, fp="bottom", tp="top"): return Wire(id=i, fromComponent=a, fromPort=fp, toComponent=b, toPort=tp)

cable = lambda name, s, r, x, l, amps: {"name": name, "conductor": "Cu", "insulation": "PVC", "size_mm2": s,
    "r_per_km": r, "x_per_km": x, "length_km": l, "voltage_kv": 0.4, "rated_amps": amps, "num_parallel": 1}
comps = [
    C("u", "utility", {"name": "Grid", "voltage_kv": 11, "fault_mva": 250, "x_r_ratio": 10}),
    C("b11", "bus", {"name": "MV", "voltage_kv": 11}),
    C("t", "transformer", {"name": "T1", "rated_mva": 1.0, "voltage_hv_kv": 11, "voltage_lv_kv": 0.42,
        "z_percent": 5, "x_r_ratio": 8, "vector_group": "Dyn11", "grounding_hv": "ungrounded",
        "grounding_lv": "solidly_grounded", "earthing_system": "TN-S"}),
    C("bA", "bus", {"name": "MSB", "voltage_kv": 0.4}),
    # sub-main: 160 A MCCB (Ir 160 A, magnetic 10x) -> 35 mm² Cu/PVC, 200 m -> DB-1
    C("cbF", "cb", {"name": "CB-SubMain", "cb_type": "mccb", "rated_current_a": 160, "trip_rating_a": 160,
        "magnetic_pickup": 10, "thermal_pickup": 1, "long_time_delay": 10, "rated_voltage_kv": 0.4,
        "breaking_capacity_ka": 36, "circuit_type": "distribution"}),
    C("cF", "cable", cable("C-SubMain", 35, 0.524, 0.08, 0.2, 140)),
    C("bB", "bus", {"name": "DB-1", "voltage_kv": 0.4}),
    # final circuit: 32 A type-C MCB -> 4 mm² Cu/PVC, 60 m -> socket bus
    C("cbS", "cb", {"name": "MCB-Sockets", "cb_type": "mcb", "mcb_curve": "C", "rated_current_a": 32,
        "trip_rating_a": 32, "magnetic_pickup": 10, "thermal_pickup": 1, "long_time_delay": 10,
        "rated_voltage_kv": 0.4, "breaking_capacity_ka": 6, "circuit_type": "final_socket"}),
    C("cS", "cable", cable("C-Sockets", 4, 4.61, 0.1, 0.06, 36)),
    C("bC", "bus", {"name": "Sockets", "voltage_kv": 0.4}),
]
wires = [W("1", "u", "b11"), W("2", "b11", "t", tp="primary"), W("3", "t", "bA", fp="secondary"),
         W("4", "bA", "cbF"), W("5", "cbF", "cF"), W("6", "cF", "bB"),
         W("7", "bB", "cbS"), W("8", "cbS", "cS"), W("9", "cS", "bC")]
p = ProjectData(projectName="compliance-review", baseMVA=100, frequency=50, components=comps, wires=wires)
mx = run_fault_analysis(p)
mn = run_fault_analysis(p, voltage_factor=0.95, conductor_temperature_c=70)
out = {"project": json.loads(p.model_dump_json()), "faultResults": json.loads(mx.model_dump_json()),
       "faultResultsMin": json.loads(mn.model_dump_json())}
here = os.path.dirname(__file__)
json.dump(out, open(os.path.join(here, "net_lv.json"), "w"), indent=1)
for b in ("bA", "bB", "bC"):
    print(f"{b}: max ik3 {mx.buses[b].ik3:.3f} ik1 {mx.buses[b].ik1:.3f} kA | min ik3 {mn.buses[b].ik3:.3f} ik1 {mn.buses[b].ik1:.3f} kA")

# Parity: the reviewed Cable Sizing study's §434.5.2 verdicts on the same net
from backend.analysis.cable_sizing import run_cable_sizing
cs = run_cable_sizing(p)
rows = (cs.get("cables") or cs.get("results") or []) if isinstance(cs, dict) else getattr(cs, "cables", None) or cs.results
for r in rows:
    r = r if isinstance(r, dict) else r.model_dump()
    fw = [i for i in r.get("issues", []) if "withstand" in i.lower()]
    print(f"cable sizing {r.get('cable_name') or r.get('name')}: fault_withstand_ok={r.get('fault_withstand_ok')} {fw}")
