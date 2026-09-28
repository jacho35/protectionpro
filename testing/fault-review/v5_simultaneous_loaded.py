# As v4, but with a real prefault current I_L through the broken branch.
# Source EMFs are chosen so that (i) the intact network carries I_L (real, 0°)
# A->B through K, and (ii) the open-circuit voltage at the shunt bus in the
# branch-REMOVED network is exactly c∠0 — i.e. precisely the engine's own
# superposition model (Ea = I_L·Za1, Ep = c). Any mismatch is then in the
# network coupling, not in a driving-source convention.
from h import *
import numpy as np, types
import backend.analysis.loadflow as LF
c=1.1; base=100.; kv=11.; zb=kv**2/base; ibase=base/(math.sqrt(3)*kv)
IL_PU=0.4
def _lf(*a,**k):
    return types.SimpleNamespace(converged=True,branches=[types.SimpleNamespace(elementId="K",i_amps=IL_PU*ibase*1000)])
LF.run_load_flow=_lf
cab=lambda cid,r,x: C(cid,"cable",r_per_km=r,x_per_km=x,r0_per_km=r,x0_per_km=x,length_km=1)
def project(side):
    comps=[C("u","utility",fault_mva=200,x_r_ratio=10,voltage_kv=kv,z0_z1_ratio=1,grounding="solidly"),
           C("A","bus",voltage_kv=kv),cab("K",0.4,0.3),C("B","bus",voltage_kv=kv),
           C("g","generator",rated_mva=5,xd_pp=0.15,voltage_kv=kv,x_r_ratio=20,grounding="solidly"),
           cab("L",0.3,0.2),C("PB","bus",voltage_kv=kv)]
    wires=[W("u","A"),W("A","K"),W("K","B"),W("g","B")]
    wires+=[W("B","L"),W("L","PB")] if side=="down" else [W("A","L"),W("L","PB")]
    return P(comps,wires)
a=cmath.exp(2j*math.pi/3); ph=[1,a*a,a]
def reference(proj, side, st, series):
    comps={x.id:x for x in proj.components}
    ZU=F._utility_impedance(comps["u"],base,c); ZG=F._generator_impedance(comps["g"],base,kv)
    ZK=complex(0.4,0.3)/zb; ZL=complex(0.3,0.2)/zb
    if side=="up": EA=c; EB=c-IL_PU*(ZU+ZK+ZG)
    else:          EB=c; EA=c+IL_PU*(ZU+ZK+ZG)
    # sanity: intact prefault current A->B
    assert abs((EA-EB)/(ZU+ZK+ZG)-IL_PU)<1e-12
    open_ph={"open_conductor":[0],"two_conductor_open":[1,2]}[series]
    faulted={"3phase":[0,1,2],"slg":[0],"ll":None}[st]
    Ip=[];Ik=[]
    for p in range(3):
        Y=np.zeros((3,3),complex); I=np.zeros(3,complex); ix={"A":0,"B":1,"PB":2}
        def br(n1,n2,z):
            y=1/z;i,j=ix[n1],ix[n2];Y[i,i]+=y;Y[j,j]+=y;Y[i,j]-=y;Y[j,i]-=y
        Y[0,0]+=1/ZU; I[0]+=EA*ph[p]/ZU; Y[1,1]+=1/ZG; I[1]+=EB*ph[p]/ZG
        if p not in open_ph: br("A","B",ZK)
        up="B" if side=="down" else "A"; br(up,"PB",ZL)
        if p in faulted: Y[2,:]=0;Y[2,2]=1;I[2]=0
        V=np.linalg.solve(Y,I)
        Ip.append((V[ix[up]]-V[2])/ZL); Ik.append((V[0]-V[1])/ZK if p not in open_ph else 0)
    return [abs(x)*ibase for x in Ip],[abs(x)*ibase for x in Ik]
for series in ("open_conductor","two_conductor_open"):
  for side in ("up","down"):
    for st in ("3phase","slg"):
        proj=project(side)
        r=F.run_simultaneous_fault_analysis(proj,"K",series,"PB",st)
        ip,ik=reference(proj,side,st,series)
        print(f"{series}, shunt bus {side.upper()}stream of break, {st}:")
        cmp("shunt fault current phase a kA",ip[0],r.ipa_ka)
        if series=="open_conductor": cmp("break current phase b kA",ik[1],r.ib_ka)
        else: cmp("break current phase a kA",ik[0],r.ia_ka)
