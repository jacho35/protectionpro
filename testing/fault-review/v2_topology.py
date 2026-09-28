from h import *
c=1.1; base=100.
def zu(S,xr): z=c*base/S; x=z*xr/math.hypot(1,xr); return complex(x/xr,x)
kv=11.; zb=kv**2/base
Zc=complex(0.5,0.3)/zb
# motor: 1000 kW, eff .95 pf .9, x''=0.17, X/R 10
Sm=1000/(0.95*0.9*1000); xm=0.17*base/Sm; Zm=complex(xm/10,xm)
ZQ=zu(100,10)
print("V2a shared cable, motor on the upstream bus (nodal path)")
proj=P([C("u","utility",fault_mva=100,x_r_ratio=10),C("b1","bus",voltage_kv=kv),
        C("m","motor_induction",rated_kw=1000,efficiency=0.95,power_factor=0.9,x_pp=0.17,x_r_ratio=10),
        C("cb1","cable",r_per_km=0.5,x_per_km=0.3,length_km=1),C("b2","bus",voltage_kv=kv)],
       [W("u","b1"),W("b1","m"),W("b1","cb1"),W("cb1","b2")])
r=F.run_fault_analysis(proj).buses["b2"]
Z=Zc+ZQ*Zm/(ZQ+Zm); ib=base/(math.sqrt(3)*kv)
cmp("Ik3 kA (Zc + ZQ||ZM)",c/abs(Z)*ib,r.ik3)

print("V2b distribution board's OWN rotating load, faulted at the board")
# DB 500 kVA, motor_fraction 0.5, LRC 6 -> motor 0.25 MVA, x''=1/6, X/R 10; fed from 0.4 kV grid bus by cable
kv=0.4; zb=kv**2/base; ib=base/(math.sqrt(3)*kv)
Zc=complex(0.02,0.008)/zb
Sm=0.25; xm=(1/6)*base/Sm; ZM=complex(xm/10,xm)
ZQ=zu(20,10)
proj=P([C("u","utility",fault_mva=20,x_r_ratio=10,voltage_kv=0.4),C("b1","bus",voltage_kv=kv),
        C("cb1","cable",r_per_km=0.2,x_per_km=0.08,length_km=0.1),
        C("db","distribution_board",voltage_kv=0.4,rated_kva=500,motor_fraction=0.5,motor_lrc_ratio=6,x_r_ratio=10)],
       [W("u","b1"),W("b1","cb1"),W("cb1","db","bottom","in")])
res=F.run_fault_analysis(proj)
r=res.buses["db"]; rb1=res.buses["b1"]
Z=ZQ+Zc; Zdb=1/(1/Z+1/ZM)
cmp("Ik3 at DB, incl. its own motors",c/abs(Zdb)*ib,r.ik3)
print(f"  (grid only would be {c/abs(Z)*ib:.4f} kA; motor_count at DB = {r.motor_count}, at b1 = {rb1.motor_count})")
Zb1=1/(1/ZQ+1/(Zc+ZM)); cmp("Ik3 at upstream bus b1 (DB motors via cable)",c/abs(Zb1)*ib,rb1.ik3)

print("V2c UPS and VFD are zero-impedance pass-throughs")
kv=0.4; ib=base/(math.sqrt(3)*kv)
proj=P([C("u","utility",fault_mva=20,x_r_ratio=10,voltage_kv=0.4),C("b1","bus",voltage_kv=kv),
        C("ups","ups",rated_kva=100),C("b2","bus",voltage_kv=kv),
        C("vfd","vfd",rated_kw=200),C("m","motor_induction",rated_kw=200,efficiency=0.95,power_factor=0.85,x_pp=0.17,x_r_ratio=10)],
       [W("u","b1"),W("b1","ups","bottom","ac_in"),W("ups","b2","ac_out","top"),W("b2","vfd","bottom","in"),W("vfd","m","out","in")])
res=F.run_fault_analysis(proj)
print(f"  b1 Ik3 = {res.buses['b1'].ik3} kA; b2 (UPS output, 100 kVA) Ik3 = {res.buses['b2'].ik3} kA, motors counted at b2 = {res.buses['b2'].motor_count}")
print(f"  a 100 kVA UPS inverter delivers ~1.5-3 x In = {1.5*100/(math.sqrt(3)*0.4)/1000:.3f}-{3*100/(math.sqrt(3)*0.4)/1000:.3f} kA on inverter")

print("V2d [F5] online UPS without bypass; VFD diode vs AFE")
import copy
def ups_net(bypass, front_end="diode"):
    return P([C("u","utility",fault_mva=20,x_r_ratio=10,voltage_kv=0.4),C("b1","bus",voltage_kv=kv),
        C("ups","ups",rated_kva=100,topology="online_double",static_bypass=bypass,fault_contribution_pu=2.0),C("b2","bus",voltage_kv=kv),
        C("vfd","vfd",rated_kw=200,efficiency=0.96,front_end=front_end),C("m","motor_induction",rated_kw=200,efficiency=0.95,power_factor=0.85,x_pp=0.17,x_r_ratio=10)],
       [W("u","b1"),W("b1","ups","bottom","ac_in"),W("ups","b2","ac_out","top"),W("b1","vfd","bottom","in"),W("vfd","m","out","in")])
ZQ=zu(20,10); ib=base/(math.sqrt(3)*kv)
r=F.run_fault_analysis(ups_net("no"))
cmp("UPS output Ik3 = 2.0 x In (inverter)",2.0*0.1/(math.sqrt(3)*0.4),r.buses["b2"].ik3)
cmp("b1 Ik3, diode VFD: grid only",c/abs(ZQ)*ib,r.buses["b1"].ik3)
r=F.run_fault_analysis(ups_net("yes"))
cmp("UPS output Ik3 with bypass = upstream level",c/abs(ZQ)*ib,r.buses["b2"].ik3)
r=F.run_fault_analysis(ups_net("no","afe"))
sm=0.2/0.96; zm=(1/3)*base/sm; ZM=zm*complex(0.1,1)/abs(complex(0.1,1))  # IEC: |Z_M|=U²/(3·S_rM), R/X 0.1
cmp("b1 Ik3, AFE VFD: grid || (I_LR/I_rM=3 motor)",c/abs(ZQ*ZM/(ZQ+ZM))*ib,r.buses["b1"].ik3)
