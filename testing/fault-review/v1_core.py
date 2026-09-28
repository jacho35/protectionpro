# IEC 60909 hand calc: grid -> Dyn11 (off-nominal 11/0.42 on a 0.4 kV bus) -> LV bus
from h import *
c=1.1; SkQ=250.; xrQ=10.; UnQ=11.; Srt=1.0; ukr=6.; xrT=8.; UrHV=11.; UrLV=0.42; Un=0.4
# ohms referred to LV via RATED ratio
tr=UrHV/UrLV
ZQ=c*UnQ**2/SkQ; XQ=ZQ*xrQ/math.hypot(1,xrQ); ZQ=complex(XQ/xrQ,XQ)/tr**2
ZT=ukr/100*UrLV**2/Srt; XT=ZT*xrT/math.hypot(1,xrT); xT=ukr/100*xrT/math.hypot(1,xrT)
KT=0.95*c/(1+0.6*xT); ZT=complex(XT/xrT,XT)*KT
Z1=ZQ+ZT; Z0=ZT  # Dyn11: grid blocked by delta; Z0T=Z1T (engine convention, no z0_z1_ratio)
Ik3=c*Un/(math.sqrt(3)*abs(Z1)); Ik1=math.sqrt(3)*c*Un/abs(2*Z1+Z0); Ik2=c*Un/abs(2*Z1)
IkE2E=math.sqrt(3)*c*Un/abs(Z1+2*Z0)
kap=1.02+0.98*math.exp(-3*Z1.real/Z1.imag); ip=kap*math.sqrt(2)*Ik3
proj=P([C("u","utility",fault_mva=SkQ,x_r_ratio=xrQ,voltage_kv=11,z0_z1_ratio=1),
        C("b1","bus",voltage_kv=11),
        C("t","transformer",rated_mva=Srt,z_percent=ukr,x_r_ratio=xrT,voltage_hv_kv=UrHV,voltage_lv_kv=UrLV,vector_group="Dyn11",grounding_hv="ungrounded",grounding_lv="solidly_grounded",winding_config="step_down"),
        C("b2","bus",voltage_kv=Un)],
       [W("u","b1"),W("b1","t","bottom","primary"),W("t","b2","secondary","top")])
r=F.run_fault_analysis(proj).buses["b2"]
print("V1 core IEC 60909 (off-nominal Dyn11 LV bus)")
cmp("Ik3 kA",Ik3,r.ik3); cmp("Ik1 kA",Ik1,r.ik1); cmp("Ik2 (LL) kA",Ik2,r.ikLL); cmp("IkE2E kA",IkE2E,r.ikLLG); cmp("ip kA",ip,r.ip)
# scale invariance: same network per-unit at 132/33 kV
def scaled(k):
    return P([C("u","utility",fault_mva=SkQ,x_r_ratio=xrQ,voltage_kv=11*k,z0_z1_ratio=1),C("b1","bus",voltage_kv=11*k),
        C("t","transformer",rated_mva=Srt,z_percent=ukr,x_r_ratio=xrT,voltage_hv_kv=UrHV*k,voltage_lv_kv=UrLV*k,vector_group="Dyn11",grounding_hv="ungrounded",grounding_lv="solidly_grounded"),
        C("b2","bus",voltage_kv=Un*k)],[W("u","b1"),W("b1","t","bottom","primary"),W("t","b2","secondary","top")])
r2=F.run_fault_analysis(scaled(30)).buses["b2"]
cmp("scale x30: Ik3*30 (per-unit invariance)",r.ik3,r2.ik3*30)
cmp("scale x30: Ik1*30",r.ik1,r2.ik1*30)
