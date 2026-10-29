"""ip, Ib, Ik_max and Ith on a bus fed by independent branches (IEC 60909-0
§8.1.2, §9.1.2, §4.6.2, §12). Expected: exact agreement."""
# ip, Ib, Ik, Ith on a bus fed by independent branches (IEC §8.1.2, §9.1.2, §4.6.2)
import math
from common import C, W, P, F, SQ3, cmp, par
c = 1.1; base = 100.0; U = 11.0; ib0 = base / (SQ3 * U)
comps = [C("u", "utility", fault_mva=250, x_r_ratio=12, voltage_kv=U), C("B", "bus", voltage_kv=U),
         C("g", "generator", rated_mva=10, voltage_kv=U, xd_pp=0.15, xd=1.2, power_factor=0.85),
         C("m", "motor_induction", rated_kw=2000, voltage_kv=U, efficiency=0.95, power_factor=0.88,
           locked_rotor_current=6, x_r_ratio=10, poles=4)]
p = P(comps, [W("u", "B"), W("g", "B"), W("B", "m", "out", "in")])
cm = {x.id: x for x in comps}
ZQ = F._utility_impedance(cm["u"], base, c)
sphi = math.sqrt(1 - 0.85**2); KG = 1.1 / (1 + 0.15 * sphi)
ZG = KG * complex(0.07 * 0.15, 0.15) * base / 10
SrM = 2.0 / (0.95 * 0.88); ZM = (1 / 6) * base / SrM * complex(0.1, 1) / abs(complex(0.1, 1))
I = {k: c / abs(z) for k, z in (("Q", ZQ), ("G", ZG), ("M", ZM))}
kap = {k: 1.02 + 0.98 * math.exp(-3 * z.real / z.imag) for k, z in (("Q", ZQ), ("G", ZG), ("M", ZM))}
Ztot = par(ZQ, ZG, ZM)
e = F.run_fault_analysis(p, fault_type="3phase").buses["B"]
print("topology:", e.network_topology)
cmp("Ik3 kA", c / abs(Ztot) * ib0, e.ik3)
ip = sum(kap[k] * math.sqrt(2) * I[k] for k in I) * ib0
cmp("ip kA (Σ κ_i·√2·I″k_i)", ip, e.ip)
rG = I["G"] * base / 10; rM = I["M"] * base / SrM
mu = lambda r: 1.0 if r <= 2 else min(1, 0.62 + 0.72 * math.exp(-0.32 * r))
q = max(0, min(1, 0.57 + 0.12 * math.log(2.0 / 2)))
Ib = (I["Q"] + mu(rG) * I["G"] + mu(rM) * q * I["M"]) * ib0
cmp("Ib kA (t_min 0.1 s, m = 1 MW/pole pair)", Ib, e.ib)
# steady state: Q keeps I″k, generator λmax·IrG, motor 0
r = I["G"] * base / 10
lam = min(r, 1.3 * math.sqrt(1 + 2 * 1.2 * sphi + 1.44) / (1.2 - 0.15 + (1 + 0.15 * sphi) / r))
Ik = I["Q"] * ib0 + lam * 10 / (SQ3 * U)
cmp("Ik_max kA (I″kQ + λmax·IrG)", Ik, e.ik_steady)
kapeq = e.ip / (math.sqrt(2) * e.ik3)
m = (math.exp(4 * 50 * 1 * math.log(kapeq - 1)) - 1) / (2 * 50 * 1 * math.log(kapeq - 1))
cmp("Ith kA (Tk 1 s, n = 1)", e.ik3 * math.sqrt(m + 1), e.ith_ka)
