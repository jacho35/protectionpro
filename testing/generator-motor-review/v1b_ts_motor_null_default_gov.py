"""Null-disturbance: a 0 % load step must leave every state flat.
Genset island, governor + AVR off, one induction motor + a static load."""
from backend.models.schemas import ProjectData, Component, Wire
from backend.analysis.transient_stability import run_transient_stability
C=lambda i,t,p: Component(id=i,type=t,x=0,y=0,props=p)
W=lambda i,a,b: Wire(id=i,fromComponent=a,fromPort="o",toComponent=b,toPort="i")
def proj(ts_dyn, df):
    return ProjectData(projectName="n", baseMVA=100.0, frequency=50, components=[
        C("busg","bus",{"name":"G","voltage_kv":0.4}),
        C("busl","bus",{"name":"L","voltage_kv":0.4}),
        C("fdr","cable",{"name":"F","voltage_kv":0.4,"r_per_km":0.1,"x_per_km":0.07,"length_km":0.05}),
        C("g1","generator",{"name":"G1","rated_mva":1.0,"voltage_kv":0.4,"xd_p":0.25,"inertia_h_s":2.0,
            "dispatch_mode":"must_run","gov_mode":"isochronous"}),
        C("ld","static_load",{"name":"LD","voltage_kv":0.4,"rated_kva":200,"power_factor":0.9}),
        C("m1","motor_induction",{"name":"M1","rated_kw":400,"voltage_kv":0.4,"efficiency":0.93,
            "power_factor":0.85,"demand_factor":df,"rated_speed_rpm":1480,"ts_dynamic":ts_dyn,
            "motor_j_kgm2":10,"load_j_kgm2":10}),
    ], wires=[W("a","busg","fdr"),W("b","fdr","busl"),W("c","g1","busg"),W("d","busl","ld"),W("e","busl","m1")])
for ts_dyn, df in [("off",1.0),("on",1.0),("on",0.5)]:
    r = run_transient_stability(proj(ts_dyn, df), {"type":"load_step","element":"ld","delta_pct":0,"time_s":1,"t_end_s":5})
    f = r["curves"]["speed_hz"]; t=r["curves"]["t"]
    gi=[i for i,n in enumerate(r["curves"]["machines"]) if n!="Utility"][0]
    k1=min(range(len(t)),key=lambda k:abs(t[k]-1.0))
    vb=r["curves"].get("bus_v") or r["curves"].get("vbus")
    print(f"ts_dynamic={ts_dyn:3s} df={df}: Δf at t=1s {f[gi][k1]:+.4f} Hz, at t=5s {f[gi][-1]:+.4f} Hz, stable={r['stable']}")
print("-- peak excursion before the (null) disturbance, default governor/AVR --")
for ts_dyn, df in [("off",1.0),("on",1.0),("on",0.5)]:
    r = run_transient_stability(proj(ts_dyn, df), {"type":"load_step","element":"ld","delta_pct":0,"time_s":3,"t_end_s":6})
    f = r["curves"]["speed_hz"]; t=r["curves"]["t"]
    gi=[i for i,n in enumerate(r["curves"]["machines"]) if n!="Utility"][0]
    pk=max(abs(f[gi][k]) for k in range(len(t)) if t[k]<3)
    print(f"ts_dynamic={ts_dyn} df={df}: peak |Δf| in 0-3 s = {pk:.3f} Hz")
