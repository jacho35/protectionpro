# V2b: saturation-induced relay DELAY. Reference: sim(sat, full offset) - sim(ideal CT)
# (both through the same 1-cycle DFT, so the DFT window cancels). Engine delay:
# static t(clipped) - static t(ideal), for RMS-sym, RMS-kappa, FUND-sym, FUND-sym at V_AL.
from ctsim import *
def fund_eta(ks):
    th = math.acos(1-2*ks); return max(math.hypot(th-math.sin(2*th)/2, math.sin(th)**2)/math.pi, 0.05)
ct = {"ratio": "400/5", "accuracy_class": "5P20", "burden_va": 15, "rct_ohm": 0.3}
p0 = ct_saturation_params(ct); R = p0["total_z"]; vk = p0["knee_point_v"]; ratio = p0["ratio"]
def eng_fund(I, vsat):
    ks = vsat/((I/ratio)*R); return I if ks >= 1 else I*fund_eta(ks)
curves = {"SI": (0.14, 0.02), "EI": (80.0, 2.0)}
worst = {}
for cname, (k, a) in curves.items():
  for pickup, tms in ((400, 0.1), (400, 0.3), (800, 0.2)):
    print(f"\n{cname} pickup {pickup} TMS {tms}   (delays in ms, reference = offset sim, and symmetric sim)")
    print(" X/R I(kA) | ref_off ref_sym | RMSsym RMSkappa FUNDsym")
    for x_r in (10, 40):
        kappa = 1.02 + 0.98*math.exp(-3/x_r)
        for I in (8000, 16000, 32000):
            Isec = I/ratio
            ideal = [f*ratio for f in dft_fund(simulate(Isec, R, 1e9, x_r, offset=True, tmax=1.5))]
            t0 = idmt_time_dynamic(ideal, pickup, tms, k, a)
            sat = [f*ratio for f in dft_fund(simulate(Isec, R, vk, x_r, offset=True, tmax=1.5))]
            ssym = [f*ratio for f in dft_fund(simulate(Isec, R, vk, x_r, offset=False, tmax=1.5))]
            ref = (idmt_time_dynamic(sat, pickup, tms, k, a) - t0)*1000
            refs = (idmt_time_dynamic(ssym, pickup, tms, k, a) - t0)*1000
            ti = idmt_static(I, pickup, tms, k, a)
            d = lambda Ie: (idmt_static(Ie, pickup, tms, k, a) - ti)*1000
            pk = ct_saturation_params(ct, kappa=kappa)
            r = (d(ct_effective_current(I, p0)), d(ct_effective_current(I, pk)), d(eng_fund(I, vk)))
            print(f"{x_r:4d} {I/1000:4.0f} | {ref:7.1f} {refs:7.1f} | {r[0]:6.1f} {r[1]:8.1f} {r[2]:7.1f}")
