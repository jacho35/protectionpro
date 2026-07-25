from backend.models.schemas import Component, ProjectData, Wire
from backend.analysis.optimal_powerflow import run_opf

def _c(cid,t,p): return Component(id=cid,type=t,x=0,y=0,props=p)
def _w(wid,a,b): return Wire(id=wid,fromComponent=a,fromPort="p",toComponent=b,toPort="q")

proj = ProjectData(projectName="opfisland", baseMVA=100.0, frequency=50, components=[
  _c("generator-1","generator",{"name":"GenCheap","voltage_kv":11,"rated_mva":20,"cost_per_mwh":20.0,"v_setpoint_pu":1.0,"x_r_ratio":10,"sub_x_pct":15}),
  _c("bus-1","bus",{"name":"B1","voltage_kv":11}),
  _c("generator-2","generator",{"name":"GenDear","voltage_kv":11,"rated_mva":20,"cost_per_mwh":90.0,"v_setpoint_pu":1.0,"x_r_ratio":10,"sub_x_pct":15}),
  _c("static_load-1","static_load",{"name":"L","rated_kva":10000,"power_factor":0.95,"demand_factor":1.0,"voltage_kv":11}),
], wires=[_w("w1","generator-1","bus-1"),_w("w2","generator-2","bus-1"),_w("w3","bus-1","static_load-1")])
r=run_opf(proj,objective="cost",use_capacitors=False,use_taps=False,use_setpoints=False)
print("baseline cost/h:",r["baseline"]["cost_per_h"],"optimized cost/h:",r["optimized"]["cost_per_h"])
print("warnings:",r["warnings"])
for d in r["dispatch"]:
    print("  dispatch:",d["source_name"],"role=",d["role"],"MW=",round(d["dispatched_mw"],2),"$/MWh=",d["cost_per_mwh"])
