"""PT model review — independent evidence (run from the repo root in the
backend image with PYTHONPATH=/work). Prints predicted | engine | verdict."""
import math
from backend.models.schemas import Component, ProjectData, Wire
from backend.analysis.duty_check import run_duty_check
from backend.analysis.pt_model import (earth_fault_factor, parse_pt_ratio,
                                       parse_pt_accuracy_limits, pt_burden_adequacy)

def C(i, t, p): return Component(id=i, type=t, x=0, y=0, props=p)
def W(i, a, b, fp="bottom", tp="top"): return Wire(id=i, fromComponent=a, fromPort=fp, toComponent=b, toPort=tp)

def net(grounding_lv, r_ohm, pt, vg="Dyn11"):
    comps = [C("u", "utility", {"name": "Grid", "voltage_kv": 33, "fault_mva": 500, "x_r_ratio": 10, "z0_z1_ratio": 1.0}),
             C("b33", "bus", {"name": "33kV", "voltage_kv": 33}),
             C("t", "transformer", {"name": "T1", "rated_mva": 10, "voltage_hv_kv": 33, "voltage_lv_kv": 11,
                                    "z_percent": 8, "x_r_ratio": 10, "vector_group": vg,
                                    "grounding_hv": "ungrounded", "grounding_lv": grounding_lv,
                                    "grounding_lv_resistance": r_ohm, "grounding_lv_reactance": 0}),
             C("b11", "bus", {"name": "11kV", "voltage_kv": 11}),
             C("pt", "pt", {"name": "VT", **pt}),
             C("r", "relay", {"name": "R", "relay_type": "67", "associated_pt": "pt"})]
    wires = [W("1", "u", "b33"), W("2", "b33", "t", tp="primary"), W("3", "t", "b11", fp="secondary"),
             W("4", "b11", "pt"), W("5", "pt", "r")]
    return ProjectData(projectName="x", baseMVA=100, frequency=50, components=comps, wires=wires)

def row(p):
    return next(r for r in run_duty_check(p)["pt_checks"] if r["device_id"] == "pt")

print("== Earth fault factor closed form (R0 = R1 = 0): k = sqrt3*sqrt(1+m+m^2)/(2+m), m = X0/X1")
for m in (1, 3, 10, 1e6):
    pred = math.sqrt(3) * math.sqrt(1 + m + m * m) / (2 + m)
    eng = earth_fault_factor(0.1j, 0.1j * m)
    print(f"  m={m:<8g} predicted {pred:.4f} engine {eng:.4f}")
print(f"  unearthed (no Z0 path): predicted {math.sqrt(3):.4f} engine {earth_fault_factor(0.1j, None):.4f}")

pt = {"ratio": "11000/√3/110/√3", "accuracy_class": "0.5/3P", "burden_va": 50, "connection": "phase_earth"}
print("\n== [PT1] voltage factor vs bus earthing (11 kV, phase-to-earth VT)")
for label, g, r in (("solid", "solidly_grounded", 0), ("NER 6.35 ohm (1 kA)", "low_resistance", 6.35), ("unearthed Dd", "ungrounded", 0)):
    for vf in ("1.2", "1.5/30s", "1.9/30s", "1.9/8h"):
        x = row(net(g, r, {**pt, "voltage_factor": vf}, vg="Dd0" if g == "ungrounded" else "Dyn11"))
        print(f"  {label:20} Vf {vf:8} k={x['earth_fault_factor']} req={x['required_voltage_factor']} -> {x['status']}")

print("\n== [PT2] rated primary vs bus voltage (11 kV bus, solid)")
for ratio in ("11000/110", "11kV/110V", "11000/√3/110/√3", "6600/110", "33000/110", "33000/√3/110/√3"):
    x = row(net("solidly_grounded", 0, {"ratio": ratio, "accuracy_class": "3P", "voltage_factor": "1.5/30s"}))
    print(f"  {ratio:18} service {x['service_voltage_pct']}% -> {x['status']}  {x['issues'][:1]}")

print("\n== [PT3] class parsing (IEC 61869-3 Tables 301/302)")
for c in ("1", "3", "0.5/3P", "0.2 3P", "6P", "xyz"):
    L = parse_pt_accuracy_limits(c); print(f"  {c!r:9} -> {L}")

print("\n== [PT4] burden range I (5 VA rated, 0.5 VA connected): class holds 0-100 %")
a = pt_burden_adequacy({"burden_va": 5, "connected_burden_va": 0.5}); print("  within band:", a["within_qualified_band"], "range", a["burden_range"])
a = pt_burden_adequacy({"burden_va": 50, "connected_burden_va": 5}); print("  range II 50 VA @ 10 %: within band:", a["within_qualified_band"])
