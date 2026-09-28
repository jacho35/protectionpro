"""cable_sizing.py review — secondary checks."""
import math
from backend.models.schemas import ProjectData, Component, Wire
from backend.analysis.cable_sizing import run_cable_sizing, _get_cable_props, K_FACTORS, _k_factor, _ambient_factor
from backend.analysis.fault import run_fault_analysis
C=lambda i,t,p: Component(id=i,type=t,x=0,y=0,props=p)
W=lambda i,a,b: Wire(id=i,fromComponent=a,fromPort="o",toComponent=b,toPort="i")

print("── F. conductor area used for the withstand check ──")
for props in ({"standard_type":"al_xlpe_95_lv_x","conductor":"Al","insulation":"XLPE","size_mm2":95,"r_per_km":0.4102},
              {"standard_type":"te_cu_4","conductor":"Cu","insulation":"PVC","size_mm2":4,"r_per_km":5.53}):
    cp=_get_cable_props(C("k","cable",props))
    print(f"  prop size_mm2={props['size_mm2']:>3} → engine uses {cp['size_mm2']:.1f} mm² (from r_per_km)")

print("── G. withstand current: IEC 60364-4-43 §434.5.2 — the largest fault current, any fault type ──")
p=ProjectData(projectName="g",baseMVA=100.0,frequency=50,components=[
    C("u","utility",{"name":"Grid","voltage_kv":11,"fault_mva":500,"x_r_ratio":15}),
    C("b1","bus",{"name":"MV","voltage_kv":11}),
    C("t1","transformer",{"name":"T1","rated_mva":1.6,"z_percent":6,"x_r_ratio":8,"voltage_hv_kv":11,"voltage_lv_kv":0.4,"vector_group":"Dyn11","grounding_lv":"solidly"}),
    C("b2","bus",{"name":"LV","voltage_kv":0.4})],wires=[W("1","u","b1"),W("2","b1","t1"),W("3","t1","b2")])
fr=run_fault_analysis(p); b=fr.buses["b2"]
p.components += [C("k","cable",{"name":"K","conductor":"Cu","insulation":"XLPE","size_mm2":16,"r_per_km":1.466,"x_per_km":0.082,"rated_amps":91,"length_km":0.01,"voltage_kv":0.4,"sizing_override":{"clearing_time_s":0.2}}),
                 C("b3","bus",{"name":"LV2","voltage_kv":0.4})]
p.wires += [W("4","b2","k"),W("5","k","b3")]
r=run_cable_sizing(p)["cables"][0]
print(f"  LV bus of a Dyn11 transformer: Ik3 {b.ik3:.2f} kA, Ik1 {b.ik1:.2f} kA (ratio {b.ik1/b.ik3:.3f}); engine: {r['issues']}")

print("── H. ambient-temperature factor vs IEC 60364-5-52 Table B.52.14 (air) ──")
table={"PVC":{25:1.06,35:0.94,40:0.87,45:0.79,50:0.71,55:0.61},"XLPE":{25:1.04,35:0.96,40:0.91,45:0.87,50:0.82,55:0.76,60:0.71}}
for ins,tmax in (("PVC",70),("XLPE",90)):
    worst=max(abs(_ambient_factor(ins,t,False)-f)/f for t,f in table[ins].items())
    old=max(abs(math.sqrt((tmax-t)/(tmax-30))-f)/f for t,f in table[ins].items())
    print(f"  {ins}: engine factor vs table {worst*100:.2f} % (old √ law {old*100:.2f} %)")

print("── I. k (IEC 60364-4-43 Table 43A) ──")
print(f"  Cu PVC 400 mm² table k = 103, engine {_k_factor('Cu','PVC',400)}; Al PVC 400 table 68, engine {_k_factor('Al','PVC',400)}")
print(f"  Al + unlisted insulation (EPR) → engine k = {_k_factor('Al','EPR',95)} (Al/PVC 76, lowest insulated)")
