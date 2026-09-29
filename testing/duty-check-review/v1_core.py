"""duty_check.py review — IEC 60947-2 / IEC 60269 / IEC 62271-100 anchors."""
import math
from backend.models.schemas import ProjectData, Component, Wire
from backend.analysis.duty_check import run_duty_check
from backend.analysis.fault import run_fault_analysis
C = lambda i, t, p: Component(id=i, type=t, x=0, y=0, props=p)
W = lambda i, a, b: Wire(id=i, fromComponent=a, fromPort="o", toComponent=b, toPort="i")

def dev(res, i):
    return next(d for d in res["devices"] if d["device_id"] == i)

# ── A. hand anchors: making factor, asymmetric capability ─────────────────
print("A. IEC 62271-100 making = 2.5·Isc (50 Hz); asym capability Isc·√(1+2β²), β = e^(−0.1/0.045) =",
      round(math.exp(-0.1 / 0.045), 4))

# ── B. largest fault type: LV genset, solidly earthed, x0 unset (Z0 = 0.5·Z1) ─
p = ProjectData(projectName="g", baseMVA=100.0, frequency=50, components=[
    C("g", "generator", {"name": "G", "rated_mva": 1.0, "voltage_kv": 0.4, "xd_pp": 0.12,
                         "power_factor": 0.8, "dispatch_mode": "must_run"}),
    C("b", "bus", {"name": "B", "voltage_kv": 0.4}),
    C("cb", "cb", {"name": "CB", "rated_voltage_kv": 0.415, "rated_current_a": 1600,
                   "breaking_capacity_ka": 0, "cb_type": "acb", "state": "closed"}),
    C("b2", "bus", {"name": "B2", "voltage_kv": 0.4}),
], wires=[W("1", "g", "b"), W("2", "b", "cb"), W("3", "cb", "b2")])
fr = run_fault_analysis(p).buses["b"]
icu = round((fr.ik3 + fr.ik1) / 2, 2)             # a rating between Ik3 and Ik1
for c in p.components:
    if c.id == "cb": c.props["breaking_capacity_ka"] = icu
d = dev(run_duty_check(p), "cb")
print(f"B. Ik3 {fr.ik3:.2f} kA, Ik1 {fr.ik1:.2f} kA; Icu {icu} kA → IEC 60947-2 (Icu ≥ largest prospective): FAIL;"
      f" engine interrupt_ok={d['interrupt_ok']} duty {d['breaking_duty_ka']} kA")

# ── C. LV breaker / fuse near motors: Ib < Ik″ ───────────────────────────
def lv_motor(dev_type, rating):
    return ProjectData(projectName="m", baseMVA=100.0, frequency=50, components=[
        C("u", "utility", {"name": "Grid", "voltage_kv": 11, "fault_mva": 250, "x_r_ratio": 15}),
        C("b1", "bus", {"name": "MV", "voltage_kv": 11}),
        C("t", "transformer", {"name": "T", "rated_mva": 2.0, "z_percent": 6, "x_r_ratio": 8,
                               "voltage_hv_kv": 11, "voltage_lv_kv": 0.4, "vector_group": "Dyn11"}),
        C("b2", "bus", {"name": "LV", "voltage_kv": 0.4}),
        C("m1", "motor_induction", {"name": "M1", "rated_kw": 800, "voltage_kv": 0.4, "poles": 4}),
        C("m2", "motor_induction", {"name": "M2", "rated_kw": 800, "voltage_kv": 0.4, "poles": 4}),
        C("d", dev_type, {"name": "D", "rated_voltage_kv": 0.415, "rated_current_a": 400,
                          "breaking_capacity_ka": rating, "cb_type": "mccb", "state": "closed"}),
        C("b3", "bus", {"name": "LV2", "voltage_kv": 0.4}),
    ], wires=[W("1", "u", "b1"), W("2", "b1", "t"), W("3", "t", "b2"), W("4", "b2", "m1"),
              W("5", "b2", "m2"), W("6", "b2", "d"), W("7", "d", "b3")])
p = lv_motor("cb", 0)
fr = run_fault_analysis(p, fault_type="3phase").buses["b2"]
rating = round((fr.ik3 + fr.ib) / 2, 2)
for kind in ("cb", "fuse"):
    p = lv_motor(kind, rating)
    d = dev(run_duty_check(p), "d")
    print(f"C. {kind}: Ik″3 {fr.ik3:.2f} kA, Ib {fr.ib:.2f} kA, rating {rating} kA → IEC (prospective Ik″): FAIL;"
          f" engine interrupt_ok={d['interrupt_ok']} basis {d['duty_basis']}")

# ── D. device on a distribution board ────────────────────────────────────
p = ProjectData(projectName="d", baseMVA=100.0, frequency=50, components=[
    C("u", "utility", {"name": "Grid", "voltage_kv": 0.4, "fault_mva": 30}),
    C("db", "distribution_board", {"name": "DB", "voltage_kv": 0.4, "rated_kva": 0}),
    C("cb", "cb", {"name": "CB", "rated_voltage_kv": 0.415, "rated_current_a": 63,
                   "breaking_capacity_ka": 6, "cb_type": "mcb", "state": "closed"}),
    C("l", "static_load", {"name": "L", "rated_kva": 10}),
], wires=[W("1", "u", "db"), W("2", "db", "cb"), W("3", "cb", "l")])
r = run_duty_check(p)
print(f"D. 6 kA MCB on a board with {run_fault_analysis(p).buses['db'].ik3:.1f} kA: devices checked {len(r['devices'])}; warnings {r['warnings']}")
