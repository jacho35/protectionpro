"""db_circuit_check.py review — hand references (IEC 60364-4-41/-43/-5-52/-5-54)."""
import cmath, math, sys
sys.path.insert(0, "/work/backend/tests")
from test_db_circuit_check import _way, _board_project, _comp, _wire
from backend.analysis.db_circuit_check import run_db_circuit_check
from backend.models.schemas import ProjectData

def run(ways, **kw):
    r = run_db_circuit_check(_board_project(ways, **kw))
    return {w["way_id"]: w for w in r["ways"]}, r

# ── A. supply Ze: TN single-line-to-ground, Zs = |Z1+Z2+Z0|/3 ────────────
rows, res = run([_way()])
w = rows["w1"]
zb = 0.4 ** 2 / 100
zq = 0.95 * 100 / 500 * cmath.exp(1j * math.atan(15))       # c_min feeder, IEC 60909 Eq. (1)
zt = 0.05 * 100 / 1.0 * cmath.exp(1j * math.atan(10))
kt = 0.95 * 1.1 / (1 + 0.6 * 0.05 * math.sin(math.atan(10)))  # IEC 60909-0 Eq. 12a
for label, k in (("no K_T", 1.0), ("with K_T", kt)):
    z1 = zq + zt * k; z0 = zt * k
    print(f"A. Ze hand ({label}) {abs(2*z1+z0)/3*zb:.5f} Ω   engine {w['z_supply_ohm']}")

# ── B. way Zs and Ief — hand ─────────────────────────────────────────────
r1 = 7.41 * 1.2 * 0.020            # 2.5 mm² Cu at 70 °C, 20 m
print(f"B. R1 hand {r1:.4f} engine {w['r_phase_ohm']};  engine Zs {w['zs_ohm']} = |Ze| + R1 + R2 (arithmetic)")

# ── C. voltage drop — hand (single-phase, b = 2) ────────────────────────
ib = 2000 / (400 / math.sqrt(3))
vd = 2 * ib * 0.020 * (7.41 * 1.2 * 0.9 + 0.090 * math.sqrt(1 - 0.81)) / (400 / math.sqrt(3)) * 100
print(f"C. VD way hand {vd:.4f} %  engine {w['vd_pct']} %   upstream {w['vd_upstream_pct']} % total {w['vd_total_pct']}")

# ── D. undeclared ECC assumes the Table 54.7 size ────────────────────────
long = _way(cable_m=60, cable_mm2=2.5, breaker_a=20, curve="C")
blank = run([long])[0]["w1"]
te = run([dict(long, ecc_mm2=1.5)])[0]["w1"]
print(f"D. blank ECC: engine Zs {blank['zs_ohm']} Ω ({blank['zs_status']}, assumes {blank.get('ecc_assumed_mm2')} mm²): {blank['zs_message'][:110]}")
short = run([dict(_way(cable_m=20), ecc_mm2=1.5)])[0]["w1"]
print(f"   20 m 2.5/1.5 T+E declared: ECC {short['ecc_status']} — {short['ecc_message'][:120]}")
print(f"   real T+E 2.5/1.5: Zs {te['zs_ohm']} Ω ({te['zs_status']}); ECC verdict {te['ecc_status']}: {te['ecc_message']}")
# IEC 60364-5-54 §543.1.2 adiabatic: S >= sqrt(I²t)/k, k = 115 (PVC-insulated Cu
# in the cable, Table 54.3), I = c_max·U0/Zs, t = 0.1 s in the MCB's instantaneous
# region. Only valid where the device actually trips — the 60 m way above never
# reaches the magnetic trip, so its 1.5 mm² CPC cannot be credited; the 20 m way can.
zs20 = short["zs_ohm"]; i_ad = 1.1 * 230.94 / zs20
print(f"   §543.1.2 hand (20 m): I {i_ad:.0f} A, t 0.1 s → S ≥ {math.sqrt(i_ad**2*0.1)/115:.2f} mm² ≤ 1.5 → complies")

# ── E. upstream drop is measured from 1.0 pu, not from the origin ─────────
# Source held at 1.05 pu (lf v_setpoint), board fed through a 16 mm² cable from
# the LV bus: the real drop origin→board is (V_LV − V_board), which the engine
# reads as max(0, 1 − V_board) = 0 when V_board > 1.
p = _board_project([_way()])
p.components = [c for c in p.components]
for c in p.components:
    if c.id == "utility-1":
        c.props["v_setpoint_pu"] = 1.05
p.wires = [w for w in p.wires if w.id != "w-4"]
p.components += [_comp("k-1", "cable", {"name": "Sub", "r_per_km": 1.466, "x_per_km": 0.082,
                                        "length_km": 0.12, "voltage_kv": 0.4, "rated_amps": 91}),
                 _comp("bus-db", "bus", {"name": "DBbus", "voltage_kv": 0.4})]
p.wires += [_wire("w-4a", "bus-lv", "k-1"), _wire("w-4b", "k-1", "bus-db"), _wire("w-4c", "bus-db", "db-1")]
for c in p.components:
    if c.id == "db-1":
        c.props["rated_kva"] = 60
from backend.analysis.loadflow import run_load_flow
lf = run_load_flow(p, "newton_raphson")
r = run_db_circuit_check(p)["ways"][0]
v_lv, v_db = lf.buses["bus-lv"].voltage_pu, lf.buses["bus-db"].voltage_pu
print(f"E. V_LV {v_lv:.4f}  V_board {v_db:.4f} pu → drop origin→board {100*(v_lv-v_db):.2f} %;"
      f"  engine upstream {r['vd_upstream_pct']} %, total {r['vd_total_pct']} %")

# ── F. aluminium way uses copper resistance ──────────────────────────────
from backend.analysis.db_circuit_check import _r_hot_per_km
print(f"F. 16 mm² Al PVC at 70 °C: IEC 60228 R20 1.91 Ω/km ×1.20 = {1.91*1.2:.3f};  engine {_r_hot_per_km(16, 'Al', 'PVC'):.3f}")
