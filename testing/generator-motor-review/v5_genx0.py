from backend.models.schemas import ProjectData, Component, Wire
from backend.analysis import fault
C=lambda i,t,p: Component(id=i,type=t,x=0,y=0,props=p)
W=lambda i,a,b: Wire(id=i,fromComponent=a,fromPort="o",toComponent=b,toPort="i")
def run(x0):
    g={"name":"G","rated_mva":0.5,"voltage_kv":0.4,"xd_pp":0.15,"x_r_ratio":40,"power_factor":0.8}
    if x0: g["x0"]=x0
    p=ProjectData(projectName="g",baseMVA=100.0,frequency=50,components=[C("g","generator",g),C("b","bus",{"name":"B","voltage_kv":0.4})],wires=[W("w","g","b")])
    r=fault.run_fault_analysis(p) if hasattr(fault,"run_fault_analysis") else fault.run_fault(p)
    b=r.buses[0] if hasattr(r,"buses") and isinstance(r.buses,list) else list(r.buses.values())[0]
    d=b.model_dump() if hasattr(b,"model_dump") else b
    return d.get("ik3"), d.get("ik1")
for x0 in (0, 0.05, 0.08):
    ik3,ik1=run(x0); print(f"x0={x0 or 'unset (default)'}: Ik3={ik3:.2f} kA  Ik1={ik1:.2f} kA  Ik1/Ik3={ik1/ik3:.2f}")
