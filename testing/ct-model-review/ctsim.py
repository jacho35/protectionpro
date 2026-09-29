"""Independent reference: square-loop CT time-domain simulation.
Secondary loop purely resistive (Rct+Rb). Core ideal (zero magnetising
current) until |flux| = psi_sat, then i2=0 while primary drives it further.
psi in secondary volt-seconds; psi_sat = sqrt2*Vsat/omega (Vsat rms EMF).
Relay: 1-cycle full-cycle DFT fundamental of i2 (rms), IEC 60255-151 IDMT
integrated as ∫dt/t(M)=1 (dynamic definition, ideal disc reset ignored)."""
import math, sys
sys.path.insert(0, '/work')
from backend.analysis.ct_model import ct_saturation_params, ct_effective_current

F = 50.0; W = 2*math.pi*F; N = 400  # samples/cycle
dt = 1/(F*N)

def simulate(i_sym_rms_sec, R, vsat, x_r, offset=True, tmax=1.0):
    tp = x_r / W
    psi_sat = math.sqrt(2)*vsat/W
    psi = 0.0; out = []
    n = int(tmax/dt)
    for k in range(n):
        t = k*dt
        i1 = math.sqrt(2)*i_sym_rms_sec*((math.exp(-t/tp) if offset else 0) - math.cos(W*t)) if offset \
             else math.sqrt(2)*i_sym_rms_sec*math.sin(W*t)
        dpsi = R*i1*dt
        if (psi >= psi_sat and dpsi > 0) or (psi <= -psi_sat and dpsi < 0):
            i2 = 0.0
        else:
            i2 = i1; psi = max(-psi_sat, min(psi_sat, psi + dpsi))
        out.append(i2)
    return out

def dft_fund(samples):
    """sliding 1-cycle DFT fundamental rms, per sample (valid from k>=N)."""
    re = im = 0.0; res = [0.0]*len(samples)
    c = [math.cos(W*k*dt) for k in range(N)]; s = [math.sin(W*k*dt) for k in range(N)]
    for k in range(len(samples)):
        re += samples[k]*c[k % N]; im += samples[k]*s[k % N]
        if k >= N:
            re -= samples[k-N]*c[(k-N) % N]; im -= samples[k-N]*s[(k-N) % N]
        res[k] = math.hypot(re, im)*2/N/math.sqrt(2) if k >= N-1 else 0.0
    return res

def rms_steady(samples):
    last = samples[-N:]
    return math.sqrt(sum(x*x for x in last)/N)

SI = (0.14, 0.02)
def idmt_time_dynamic(fund_prim, pickup, tms, k=0.14, a=0.02):
    acc = 0.0
    for i, I in enumerate(fund_prim):
        M = I/pickup
        if M > 1.0:
            acc += dt/(tms*k/(M**a-1))
            if acc >= 1: return i*dt
    return math.inf
def idmt_static(I, pickup, tms, k=0.14, a=0.02):
    M = I/pickup
    return tms*k/(M**a-1) if M > 1 else math.inf
