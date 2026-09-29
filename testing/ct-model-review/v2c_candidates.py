from ctsim import *
def fund_eta(ks):
    th = math.acos(1-2*ks); return max(math.hypot(th-math.sin(2*th)/2, math.sin(th)**2)/math.pi, 0.05)
def eng_fund(I, vsat, ratio, R):
    ks = vsat/((I/ratio)*R); return I if ks >= 1 else I*fund_eta(ks)
cts = [({"ratio": "400/5", "accuracy_class": "5P20", "burden_va": 15, "rct_ohm": 0.3}, (8000, 16000, 32000)),
       ({"ratio": "200/1", "accuracy_class": "10P10", "burden_va": 5, "rct_ohm": 2.0}, (2000, 5000, 12000)),
       ({"ratio": "1200/1", "accuracy_class": "5P20", "burden_va": 10, "rct_ohm": 5}, (10000, 25000, 40000))]
curves = {"SI": (0.14, 0.02), "VI": (13.5, 1.0), "EI": (80.0, 2.0)}
ratios = {"A": [], "B": [], "C1": [], "C13": []}
for ct, Is in cts:
  p0 = ct_saturation_params(ct); R = p0["total_z"]; vk = p0["knee_point_v"]; ratio = p0["ratio"]
  prim = p0["primary"]
  for cname, (k, a) in curves.items():
    for pu, tms in ((1.0, 0.1), (1.0, 0.4), (2.0, 0.2)):
      pickup = pu*prim
      for x_r in (5, 10, 20, 40):
        tp = x_r/W; kappa = 1.02 + 0.98*math.exp(-3/x_r)
        for I in Is:
          Isec = I/ratio
          t0 = idmt_time_dynamic([f*ratio for f in dft_fund(simulate(Isec, R, 1e9, x_r, True, 2.0))], pickup, tms, k, a)
          tr = idmt_time_dynamic([f*ratio for f in dft_fund(simulate(Isec, R, vk, x_r, True, 2.0))], pickup, tms, k, a)
          ref = tr - t0
          ti = idmt_static(I, pickup, tms, k, a)
          A = idmt_static(eng_fund(I, vk, ratio, R), pickup, tms, k, a) - ti
          B = idmt_static(eng_fund(I, vk/kappa, ratio, R), pickup, tms, k, a) - ti
          # transient saturation occurs if (1+X/R)*Isec*R > Vk  (Ktf demand beyond knee)
          trans = (1 + x_r)*Isec*R > vk
          C1 = A + (tp if trans else 0); C13 = A + (1.3*tp if trans else 0)
          for key, v in (("A", A), ("B", B), ("C1", C1), ("C13", C13)):
              ratios[key].append((v - ref, ct["ratio"], cname, pu, tms, x_r, I, ref))
for key, lst in ratios.items():
    under = [x for x in lst if x[0] < -0.005]
    worst = min(lst)
    over = max(lst)
    print(f"{key:4s}: n={len(lst)} under-estimates>5ms: {len(under)}  worst under {worst[0]*1000:.0f} ms {worst[1:]}, worst over {over[0]*1000:.0f} ms")
