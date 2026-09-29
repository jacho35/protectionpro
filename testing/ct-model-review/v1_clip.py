# V1: symmetric steady-state clipping — engine eta (RMS) vs simulated RMS and DFT fundamental
from ctsim import *
R = 0.3 + 15/25; vk = 1.0  # normalised
for ks in (0.95, 0.8, 0.6, 0.5, 0.3, 0.1):
    Isec = vk/(ks*R)          # rms symmetric secondary current with ks = Vk/(I R)
    s = simulate(Isec, R, vk, 10, offset=False, tmax=0.2)
    f = dft_fund(s)[-1]/Isec; r = rms_steady(s)/Isec
    th = math.acos(1-2*ks); eta = math.sqrt((th-math.sin(2*th)/2)/math.pi)
    fund = math.hypot(th-math.sin(2*th)/2, math.sin(th)**2)/math.pi
    print(f"ks={ks:4.2f}  engine eta(RMS)={eta:.4f}  sim RMS={r:.4f}  | analytic fund={fund:.4f} sim DFT fund={f:.4f}  RMS/fund={eta/fund:.3f}")
