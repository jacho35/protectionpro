from h import *
c=1.1; base=100.
def net(extra=(), extra_w=()):
    comps=[C("u","utility",fault_mva=250,x_r_ratio=10,voltage_kv=11),C("b1","bus",voltage_kv=11),
        C("t","transformer",rated_mva=1,z_percent=6,x_r_ratio=8,voltage_hv_kv=11,voltage_lv_kv=0.42,vector_group="Dyn11",grounding_hv="ungrounded",grounding_lv="solidly_grounded"),
        C("b2","bus",voltage_kv=0.4),C("m","motor_induction",rated_kw=200,efficiency=0.93,power_factor=0.85,x_pp=0.17,x_r_ratio=10)]+list(extra)
    wires=[W("u","b1"),W("b1","t","bottom","primary"),W("t","b2","secondary","top"),W("b2","m")]+list(extra_w)
    return P(comps,wires)
print("V3a voltage depression with / without one unconnected spare bus")
r=F.run_fault_analysis(net()).buses["b2"]
print("  without spare bus: b1 retained (subtransient) =", (r.voltage_depression or {}).get("b1",{}).get("subtransient_pu"))
r=F.run_fault_analysis(net([C("spare","bus",voltage_kv=0.4,name="Spare")])).buses["b2"]
print("  with spare bus   : voltage_depression =", r.voltage_depression, "; warnings =", r.topology_warnings)

print("V3b motor re-acceleration profile at an LV bus fed through a transformer")
r=F.run_fault_analysis(net()).buses["b2"]
prof=r.motor_recovery
print("  min v_pu over profile =", min(p["v_pu"] for p in prof), " points:", len(prof))

print("V3c HV-side branch current for an LV fault, off-nominal 11/0.42 unit on a 0.4 kV bus")
proj=P([C("u","utility",fault_mva=250,x_r_ratio=10,voltage_kv=11),C("b1","bus",voltage_kv=11),
        C("cbh","cb",state="closed"),
        C("t","transformer",rated_mva=1,z_percent=6,x_r_ratio=8,voltage_hv_kv=11,voltage_lv_kv=0.42,vector_group="Dyn11",grounding_hv="ungrounded",grounding_lv="solidly_grounded"),
        C("b2","bus",voltage_kv=0.4)],
       [W("u","b1"),W("b1","cbh"),W("cbh","t","bottom","primary"),W("t","b2","secondary","top")])
r=F.run_fault_analysis(proj,fault_type="3phase").buses["b2"]
br={b.element_id:b for b in r.branches}
pred=r.ik3*0.42/11   # ampere-turn balance through the RATED ratio
cmp("HV breaker current kA (Ik3 x 0.42/11)",pred,br["cbh"].ik_ka)
cmp("utility branch current kA",pred,br["u"].ik_ka)

print("V3d steady-state Ik: generator behind a step-up transformer, fault on the HV bus")
proj=P([C("g","generator",rated_mva=10,xd_pp=0.15,xd_p=0.25,xd=1.2,voltage_kv=11,power_factor=0.85),C("bg","bus",voltage_kv=11),
        C("t","transformer",rated_mva=10,z_percent=10,x_r_ratio=20,voltage_hv_kv=33,voltage_lv_kv=11,vector_group="YNd11",winding_config="step_up",grounding_hv="solidly_grounded",grounding_lv="ungrounded"),
        C("bh","bus",voltage_kv=33)],
       [W("g","bg"),W("bg","t","bottom","primary"),W("t","bh","secondary","top")])
r=F.run_fault_analysis(proj).buses["bh"]
# IEC 60909-0 §4.6.2: Ik = λ·I_rGt; λ_max from TR 60909-1 Eq. 88 (x_dsat = Xd = 1.2
# here, no SCR given), λ_min from the figs. 18/19 curve; I″kG/I_rG at the machine.
s85=math.sqrt(1-0.85**2)
kg=1.1/(1+0.15*s85); kt=0.95*1.1/(1+0.6*0.10*20/math.hypot(1,20))
zg=complex(0.07*0.15*kg,0.15*kg)        # machine base, R_G = 0.07·X″d (IEC §3.6.1)
zt=complex(0.10/math.hypot(1,20),0.10*20/math.hypot(1,20))*kt
irg_hv=10/(math.sqrt(3)*11)*11/33
def l88(x,r,u): return min(r,u*math.sqrt(1+2*x*s85+x*x)/(x-0.15+(1+0.15*s85)/r))
def lmn(r): return min(r,1/(2.0-0.2+(1+0.2*s85)/r))
cmp("Ik_max kA (λ_max·I_rGt, Eq. 88)",l88(1.2,1.1/abs(zg+zt),1.3)*irg_hv,r.ik_steady)
cmp("Ik_min kA (λ_min·I_rGt, c_min 1.0)",lmn(1.0/abs(zg+zt))*irg_hv,r.ik_steady_min)

print("V3e asymmetric breaking current on a lossless (R=0) network")
proj=P([C("u","utility",fault_mva=250,x_r_ratio=1e9,voltage_kv=11),C("b1","bus",voltage_kv=11)],[W("u","b1")])
r=F.run_fault_analysis(proj).buses["b1"]
print(f"  Ik3={r.ik3} ib={r.ib} ib_asym={r.ib_asymmetric}; with no decay i_dc=√2·Ik → Ib_asym={math.sqrt(r.ib**2+2*r.ik3**2):.3f}")
proj=P([C("u","utility",fault_mva=250,x_r_ratio=1e4,voltage_kv=11),C("b1","bus",voltage_kv=11)],[W("u","b1")])
r2=F.run_fault_analysis(proj).buses["b1"]
print(f"  X/R=1e4 → ib_asym={r2.ib_asymmetric}  (discontinuity at R→0)")

print("V3f κ for a radial bus fed by two independent branches of different R/X")
# IEC 60909-0 §8.1.2: ip = Σ ip_i. Utility X/R 3 (weak cable-fed grid) + generator X/R 40
kv=11; ib=base/(math.sqrt(3)*kv)
proj=P([C("u","utility",fault_mva=150,x_r_ratio=3,voltage_kv=11),C("g","generator",rated_mva=20,xd_pp=0.15,voltage_kv=11,x_r_ratio=40),
        C("b1","bus",voltage_kv=11)],[W("u","b1"),W("g","b1")])
r=F.run_fault_analysis(proj).buses["b1"]
Zu=complex(c*base/150/math.hypot(1,3),3*c*base/150/math.hypot(1,3))
Zg=F._generator_impedance(proj.components[1],base,11)
ipsum=0
for Z in (Zu,Zg):
    ipsum+=(1.02+0.98*math.exp(-3*Z.real/Z.imag))*math.sqrt(2)*c/abs(Z)*ib
cmp("ip kA (Σ ip_i, IEC §8.1.2)",ipsum,r.ip)
