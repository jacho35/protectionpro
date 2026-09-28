# A bus-less tee (three cables meeting on one breaker terminal) in a RADIAL network
# with a motor behind one leg. The shared leg makes _paths_are_meshed() true, so the
# nodal builder runs; it reports each pair of tee legs as its own bus-to-bus branch.
from h import *
c=1.1; base=100.; kv=11.; zb=kv**2/base; ib=base/(math.sqrt(3)*kv)
cab=lambda cid,r,x: C(cid,"cable",r_per_km=r,x_per_km=x,length_km=1)
proj=P([C("u","utility",fault_mva=250,x_r_ratio=10,voltage_kv=kv),C("b1","bus",voltage_kv=kv),
        cab("c1",0.3,0.2),C("tee","cb",state="closed"),cab("c2",0.4,0.25),C("b2","bus",voltage_kv=kv),
        cab("c3",0.5,0.3),C("b3","bus",voltage_kv=kv),
        C("m","motor_induction",rated_kw=2000,efficiency=0.95,power_factor=0.9,x_pp=0.17,x_r_ratio=10)],
       [W("u","b1"),W("b1","c1"),W("c1","tee"),W("tee","c2"),W("c2","b2"),W("tee","c3"),W("c3","b3"),W("b3","m")])
ZQ=F._utility_impedance(proj.components[0],base,c)
Z1,Z2,Z3=complex(0.3,0.2)/zb,complex(0.4,0.25)/zb,complex(0.5,0.3)/zb
Sm=2000/(0.95*0.9*1000); xm=0.17*base/Sm; ZM=complex(xm/10,xm)
res=F.run_fault_analysis(proj)
par=lambda a,b:a*b/(a+b)
print("V6 bus-less tee, radial, motor behind one leg")
cmp("Ik3 at b2 kA",c/abs(Z2+par(ZQ+Z1,Z3+ZM))*ib,res.buses["b2"].ik3)
cmp("Ik3 at b3 kA",c/abs(par(Z3+par(ZQ+Z1,Z2+1e12),ZM))*ib,res.buses["b3"].ik3)
cmp("Ik3 at b1 kA",c/abs(par(ZQ,Z1+Z3+ZM))*ib,res.buses["b1"].ik3)
print("  topology:",res.buses["b2"].network_topology)
