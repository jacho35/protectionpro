# V4 (post-fix): engine arc-flash relay time (static fundamental clip + time-domain
# dc delay at 64 samples/cycle) vs the 400-sample reference: static ideal time plus
# (offset sim with saturating CT - offset sim with ideal CT).
import time
from ctsim import *
from backend.analysis.arcflash import _relay_operate_time

cts = [({"ratio": "400/5", "accuracy_class": "5P20", "burden_va": 15, "rct_ohm": 0.3}, (8000, 16000, 32000)),
       ({"ratio": "200/1", "accuracy_class": "10P10", "burden_va": 5, "rct_ohm": 2.0}, (2000, 5000, 12000)),
       ({"ratio": "1200/1", "accuracy_class": "5P20", "burden_va": 10, "rct_ohm": 5}, (10000, 25000, 40000))]
curves = {"IEC Standard Inverse": (0.14, 0.02), "IEC Very Inverse": (13.5, 1.0),
          "IEC Extremely Inverse": (80.0, 2.0)}
errs = []
tt = 0.0
nev = 0
for ct, Is in cts:
    p = ct_saturation_params(ct)
    R, vs, ratio = p["total_z"], p["knee_point_v"], p["ratio"]
    for cname, (k, a) in curves.items():
        for pu, tms in ((1.0, 0.1), (1.0, 0.4), (2.0, 0.2)):
            pickup = pu * p["primary"]
            for x_r in (5, 10, 40):
                kappa = 1.02 + 0.98 * math.exp(-3 / x_r)
                for I in Is:
                    Isec = I / ratio
                    t0 = idmt_time_dynamic([f * ratio for f in dft_fund(simulate(Isec, R, 1e9, x_r, True, 2.0))],
                                           pickup, tms, k, a)
                    tr = idmt_time_dynamic([f * ratio for f in dft_fund(simulate(Isec, R, vs, x_r, True, 2.0))],
                                           pickup, tms, k, a)
                    ref = idmt_static(I, pickup, tms, k, a) + (tr - t0)
                    c0 = time.perf_counter()
                    eng = _relay_operate_time({"pickup_a": pickup, "time_dial": tms, "curve": cname},
                                              I, ct, kappa, 50.0)
                    tt += time.perf_counter() - c0
                    nev += 1
                    errs.append((round(eng - ref, 4), ct["ratio"], cname, pu, tms, x_r, I,
                                 round(ref, 3), round(eng, 3)))
errs.sort()
print("n", len(errs))
print("worst under", errs[0])
print("worst over ", errs[-1])
print("under-reads > 10 ms:", sum(1 for e in errs if e[0] < -0.010),
      " mean |err| ms", round(1000 * sum(abs(e[0]) for e in errs) / len(errs), 1))
print(f"engine time per evaluation {1000 * tt / nev:.1f} ms")
