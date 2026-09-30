"""End to end: which current becomes I_G, and what each bus reports.
Utility 11 kV 500 MVA (z0/z1 1) -> MV bus -> Dyn11 2 MVA -> LV bus."""
import math, json
from backend.models.schemas import Component, ProjectData, Wire
from backend.analysis.grounding_system import run_grounding_analysis, _compute_decrement_factor
from backend.analysis.fault import run_fault_analysis
C=lambda i,t,p: Component(id=i,type=t,x=0,y=0,props=p)
W=lambda i,a,b,fp="bottom",tp="top": Wire(id=i,fromComponent=a,fromPort=fp,toComponent=b,toPort=tp)
def proj(utility_extra=None, mv_props=None):
    u={"name":"Grid","voltage_kv":11,"fault_mva":500,"x_r_ratio":15,"z0_z1_ratio":1.0}
    u.update(utility_extra or {})
    return ProjectData(projectName="g",baseMVA=100.0,frequency=50,components=[
        C("u","utility",u), C("b1","bus",{"name":"MV","voltage_kv":11, **(mv_props or {})}),
        C("t","transformer",{"name":"TX","rated_mva":2.0,"z_percent":6.0,"x_r_ratio":10,"voltage_hv_kv":11,"voltage_lv_kv":0.4,"vector_group":"Dyn11","grounding_hv":"ungrounded","grounding_lv":"solidly_grounded"}),
        C("b2","bus",{"name":"LV","voltage_kv":0.4})],
        wires=[W("w1","u","b1","out","top"),W("w2","b1","t","bottom","primary"),W("w3","t","b2","secondary","top")])
p = proj()
fr = run_fault_analysis(p, fault_bus_id=None, fault_type=None)
for bid, bf in fr.buses.items():
    print(bid, "ik3", bf.ik3, "ik1", bf.ik1, "kappa", bf.kappa)
r = run_grounding_analysis(p)
for b in r["buses"]:
    print(b["bus_name"], "Isym", b["symmetrical_fault_ka"], "IG", b["fault_current_ka"], "Df", b["decrement_factor_df"], "GPR", b["gpr_v"], "Em", b["mesh_voltage_v"], b["status"])
# Hand: Ik1 at MV bus with Z1=Z2=Z0 = c*U^2/S: Ik1 = sqrt3*c*U/(3Z) = Ik3 (z0/z1=1)
print("warnings", r["warnings"])
# ungrounded MV source -> ik1 = 0 -> engine falls back to ik3?
p2 = proj({"grounding":"ungrounded","neutral_grounding":"ungrounded"})
fr2 = run_fault_analysis(p2, fault_bus_id=None, fault_type=None)
print("ungrounded utility: MV ik1 =", fr2.buses["b1"].ik1, "ik3 =", fr2.buses["b1"].ik3)
for b in run_grounding_analysis(p2)["buses"]:
    print("  ", b["bus_name"], "Isym used", b["symmetrical_fault_ka"])
print("\n--- after fixes: remote fraction / notes")
for b in run_grounding_analysis(proj())["buses"]:
    print(b["bus_name"], "remote", b["remote_fraction"], "IG", b["fault_current_ka"], "I_cond", b["conductor_current_ka"], "GPR", b["gpr_v"], b["status"])
    for i in b["issues"]: print("    -", i)
# a YNd grounding transformer at the MV bus in parallel with the utility: split by Z0 admittance
p3 = proj()
p3.components.append(C("tg","transformer",{"name":"GT","rated_mva":5.0,"z_percent":6.0,"x_r_ratio":10,"voltage_hv_kv":11,"voltage_lv_kv":0.4,"vector_group":"YNd11","grounding_hv":"solidly_grounded","grounding_lv":"ungrounded"}))
p3.wires.append(W("w9","b1","tg","bottom","primary"))
fr3 = run_fault_analysis(p3, fault_bus_id=None, fault_type=None)
bf = fr3.buses["b1"]
print("\nMV with local YNd: ik1", bf.ik1, "remote fraction", bf.ik1_remote_fraction, bf.z0_sources_detail)
# hand: Z0 utility = Z1 utility = c*U^2/S (pu 100 MVA base: 1.1*100/500=0.22), Z0 xfmr = 0.06*100/5=1.2 (pu)
zu = 1.1*100/500; zt = 0.06*100/5
print("hand remote fraction |Yu|/|Yu+Yt| approx", (1/zu)/(1/zu+1/zt))
print("joint limit: Kf hard-drawn @250C (IEEE 80 Table 2: 11.78):",
      __import__('backend.analysis.grounding_system', fromlist=['x'])._compute_conductor_size(10000,1.0,'copper_hard',40.0,'bolted')*1.973525/10)
