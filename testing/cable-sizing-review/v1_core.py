"""cable_sizing.py review — core checks against IEC 60364-5-52 / 4-43 by hand."""
import math, copy
from backend.models.schemas import ProjectData, Component, Wire
from backend.analysis.cable_sizing import run_cable_sizing
from backend.analysis.fault import run_fault_analysis
from backend.analysis.loadflow import run_load_flow
C=lambda i,t,p: Component(id=i,type=t,x=0,y=0,props=p)
W=lambda i,a,b: Wire(id=i,fromComponent=a,fromPort="o",toComponent=b,toPort="i")

def lv(cable_kv=0.4, length=0.2, cb_in=160, load_kva=50):
    return ProjectData(projectName="c",baseMVA=100.0,frequency=50,components=[
        C("u","utility",{"name":"Grid","voltage_kv":11,"fault_mva":250,"x_r_ratio":15}),
        C("b1","bus",{"name":"MV","voltage_kv":11}),
        C("t1","transformer",{"name":"T1","rated_mva":1.0,"z_percent":6,"x_r_ratio":8,"voltage_hv_kv":11,"voltage_lv_kv":0.4,"vector_group":"Dyn11"}),
        C("b2","bus",{"name":"LV","voltage_kv":0.4}),
        C("cb","cb",{"name":"CB1","rated_current_a":cb_in,"trip_rating_a":cb_in,"magnetic_pickup":10,"cb_type":"mccb","long_time_delay":10,"state":"closed"}),
        C("k1","cable",{"name":"K1","standard_type":"cu_xlpe_16_lv","conductor":"Cu","insulation":"XLPE","size_mm2":16,
                        "r_per_km":1.466,"x_per_km":0.082,"rated_amps":91,"length_km":length,"voltage_kv":cable_kv}),
        C("b3","bus",{"name":"LV2","voltage_kv":0.4}),
        C("ld","static_load",{"name":"L","rated_kva":load_kva,"power_factor":0.9}),
    ],wires=[W("1","u","b1"),W("2","b1","t1"),W("3","t1","b2"),W("4","b2","cb"),W("5","cb","k1"),W("6","k1","b3"),W("7","b3","ld")])

def row(p): return run_cable_sizing(p)["cables"][0]

print("── A. Volt drop: √3·I·L·(R cosφ + X sinφ)/U_LL (IEC 60364-5-52 Annex G) ──")
for kv in (0.4, 11):
    p=lv(cable_kv=kv); r=row(p)
    lf=run_load_flow(p,"newton_raphson"); br=next(b for b in lf.branches if b.elementId=="k1")
    pf=abs(br.p_mw)/br.s_mva; sp=math.sqrt(1-pf*pf)
    hand=math.sqrt(3)*br.i_amps*0.2*(1.466*pf+0.082*sp)/400*100
    print(f"  cable voltage_kv={kv:<4}: I={br.i_amps:.1f} A  hand {hand:.3f} %  engine {r['voltage_drop_pct']} %  → error {r['voltage_drop_pct']/hand:.3f}×")

print("── B. IEC 60364-4-43 §433.1: Ib ≤ In ≤ Iz, I2 ≤ 1.45·Iz ──")
def weak(p):   # 0.5 MVA source transformer so the 16 mm² passes its own withstand check
    for c in p.components:
        if c.id=="t1": c.props.update(rated_mva=0.2, z_percent=4)
    return p
r=row(weak(lv(cb_in=160,length=0.03,load_kva=40)))
print(f"  Iz = 91 A (library), Ib ≈ 58 A, CB In = 160 A → IEC: FAIL (In > Iz).  engine status={r['status']} issues={r['issues']}")

print("── C. §434.5.2 fault withstand: t ≤ (k·S/I)² for a fault at ANY point ──")
p=lv(length=0.2); fr=run_fault_analysis(p, fault_type="3phase")
ik_near=fr.buses["b2"].ik3*1000; ik_far=fr.buses["b3"].ik3*1000
r=row(p)
print(f"  Ik3 source end {ik_near/1000:.2f} kA, far end {ik_far/1000:.3f} kA; CB 160 A, magnetic 10×In = 1600 A")
# hand: far-end current below the magnetic pickup clears on the long-time element;
# long_time_delay 10 s at 6×Ir, I²t law → t = 10·(6·160/I)²
t_far=10*(6*160/ik_far)**2
print(f"  far-end fault {ik_far:.0f} A < 1600 A → long-time trip t ≈ {t_far:.1f} s;"
      f" permissible (k·S/I)² = {(143*16/ik_far)**2:.1f} s → IEC: FAIL")
print(f"  engine: fault_withstand_ok={r['fault_withstand_ok']} overload_ok={r.get('overload_protection_ok')} t_clear={r.get('clearing_time_s')} s")

print("── D. relay-tripped MV breaker ──")
def mv():
    return ProjectData(projectName="m",baseMVA=100.0,frequency=50,components=[
        C("u","utility",{"name":"Grid","voltage_kv":11,"fault_mva":250,"x_r_ratio":10}),
        C("b1","bus",{"name":"MV","voltage_kv":11}),
        C("ct","ct",{"name":"CT","ratio_primary_a":400,"ratio_secondary_a":1}),
        C("cb","cb",{"name":"CB","rated_current_a":630,"magnetic_pickup":10,"cb_type":"mccb","state":"closed"}),
        C("rl","relay",{"name":"R","relay_type":"50/51","associated_ct":"ct","trip_cb":"cb","pickup_a":200,"time_dial":0.3,"curve":"IEC Standard Inverse","inst_pickup_a":0}),
        C("k1","cable",{"name":"K1","standard_type":"cu_xlpe_35_11kv","conductor":"Cu","insulation":"XLPE","size_mm2":35,
                        "r_per_km":0.6681,"x_per_km":0.110,"rated_amps":170,"length_km":1.0,"voltage_kv":11}),
        C("b2","bus",{"name":"MV2","voltage_kv":11}),
        C("ld","static_load",{"name":"L","rated_kva":1000,"power_factor":0.9}),
    ],wires=[W("1","u","b1"),W("2","b1","ct"),W("3","ct","cb"),W("4","cb","k1"),W("5","k1","b2"),W("6","b2","ld")])
p=mv(); r=row(p); fr=run_fault_analysis(p, fault_type="3phase"); ik=fr.buses["b1"].ik3*1000
t_relay=0.3*0.14/((ik/200)**0.02-1)+0.05   # IEC 60255-151 SI + 50 ms breaker
s_req=ik*math.sqrt(t_relay)/143
print(f"  Ik3 {ik/1000:.2f} kA; SI relay 200 A TMS 0.3 → t = {t_relay:.3f} s (IEC 60255-151); S_req ≥ Ik·√t/k = {s_req:.1f} mm² (bare Ik″, before √(m+n))")
from backend.analysis.arcflash import _relay_operate_time
print(f"  relay curve alone (engine) {_relay_operate_time(next(c for c in p.components if c.id=='rl').props, ik):.4f} s = hand {0.3*0.14/((ik/200)**0.02-1):.4f} s")
print(f"  35 mm² → IEC: FAIL.  engine fault_withstand_ok={r['fault_withstand_ok']} t_clear={r.get('clearing_time_s')} s (incl. CT saturation + 80 ms opening) issues={r['issues']}")

print("── E. cumulative volt drop from the origin (IEC 60364-5-52 §525, Table G.52.1) ──")
p=weak(lv(length=0.1,load_kva=20,cb_in=80))
p.components += [C("k2","cable",{"name":"K2","standard_type":"cu_xlpe_16_lv","conductor":"Cu","insulation":"XLPE","size_mm2":16,
                   "r_per_km":1.466,"x_per_km":0.082,"rated_amps":91,"length_km":0.35,"voltage_kv":0.4}),
                 C("b4","bus",{"name":"LV3","voltage_kv":0.4}), C("ld2","static_load",{"name":"L2","rated_kva":10,"power_factor":0.9})]
p.wires += [W("8","b3","k2"),W("9","k2","b4"),W("10","b4","ld2")]
res={c["cable_name"]:c for c in run_cable_sizing(p)["cables"]}
lf=run_load_flow(p,"newton_raphson")
print(f"  K1 {res['K1']['voltage_drop_pct']} % cum {res['K1'].get('cumulative_voltage_drop_pct')} % ({res['K1']['status']}), K2 {res['K2']['voltage_drop_pct']} % cum {res['K2'].get('cumulative_voltage_drop_pct')} % ({res['K2']['status']}); "
      f"origin→LV3 = {res['K1']['voltage_drop_pct']+res['K2']['voltage_drop_pct']:.2f} % (LF: {100*(lf.buses['b2'].voltage_pu-lf.buses['b4'].voltage_pu)/lf.buses['b2'].voltage_pu:.2f} %) vs 5 % limit")
