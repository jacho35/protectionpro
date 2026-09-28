# Simultaneous open-conductor + shunt fault vs an independent PHASE-DOMAIN solve.
# All elements have Z0 = Z1 = Z2 and no mutual coupling, so the three phases are
# independent single-phase networks; prefault load current is forced to 0 (the
# prefault load flow is patched to fail), so every EMF = c and Ea = 0 in the engine.
from h import *
import numpy as np
import backend.analysis.loadflow as LF
def _boom(*a, **k): raise RuntimeError("patched: no prefault load flow")
LF.run_load_flow=_boom
c=1.1; base=100.; kv=11.; zb=kv**2/base; ibase=base/(math.sqrt(3)*kv)
cab=lambda cid,r,x: C(cid,"cable",r_per_km=r,x_per_km=x,r0_per_km=r,x0_per_km=x,length_km=1)
def project(shunt_side):
    comps=[C("u","utility",fault_mva=200,x_r_ratio=10,voltage_kv=kv,z0_z1_ratio=1,grounding="solidly"),
           C("A","bus",voltage_kv=kv),cab("K",0.4,0.3),C("B","bus",voltage_kv=kv),
           C("g","generator",rated_mva=5,xd_pp=0.15,voltage_kv=kv,x_r_ratio=20,grounding="solidly"),
           cab("L",0.3,0.2),C("PB","bus",voltage_kv=kv)]
    wires=[W("u","A"),W("A","K"),W("K","B"),W("g","B")]
    wires+= [W("B","L"),W("L","PB")] if shunt_side=="down" else [W("A","L"),W("L","PB")]
    return P(comps,wires)
a=cmath.exp(2j*math.pi/3); ph=[1,a*a,a]
def reference(proj, shunt_side, shunt_type):
    comps={x.id:x for x in proj.components}
    ZU=F._utility_impedance(comps["u"],base,c); ZG=F._generator_impedance(comps["g"],base,kv)
    ZK=complex(0.4,0.3)/zb; ZL=complex(0.3,0.2)/zb
    nodes=["A","B","PB"]; ix={n:i for i,n in enumerate(nodes)}
    Ip=[];Ik=[]
    faulted={"3phase":[0,1,2],"slg":[0]}[shunt_type]
    for p in range(3):
        Y=np.zeros((3,3),complex); I=np.zeros(3,complex)
        def br(n1,n2,z):
            y=1/z; i,j=ix[n1],ix[n2]; Y[i,i]+=y;Y[j,j]+=y;Y[i,j]-=y;Y[j,i]-=y
        Y[0,0]+=1/ZU; I[0]+=c*ph[p]/ZU
        Y[1,1]+=1/ZG; I[1]+=c*ph[p]/ZG
        if p!=0: br("A","B",ZK)          # phase a of K is open
        br("B" if shunt_side=="down" else "A","PB",ZL)
        if p in faulted: Y[2,:]=0; Y[2,2]=1; I[2]=0   # bolted to ground
        V=np.linalg.solve(Y,I)
        up="B" if shunt_side=="down" else "A"
        Ip.append((V[ix[up]]-V[2])/ZL if p in faulted else 0)
        Ik.append((V[0]-V[1])/ZK if p!=0 else 0)
    return [abs(x)*ibase for x in Ip],[abs(x)*ibase for x in Ik]
for side in ("up","down"):
    for st in ("3phase","slg"):
        proj=project(side)
        r=F.run_simultaneous_fault_analysis(proj,"K","open_conductor","PB",st)
        ip,ik=reference(proj,side,st)
        print(f"shunt bus on {side.upper()} side, {st}:")
        eng_ip=[r.ipa_ka,r.ipb_ka,r.ipc_ka]
        for n,pv,ev in zip("abc",ip,eng_ip):
            if pv>1e-9 or ev>1e-9: cmp(f"shunt fault current phase {n} kA",pv,ev)
        cmp("break current phase b kA",ik[1],r.ib_ka); cmp("break current phase c kA",ik[2],r.ic_ka)
