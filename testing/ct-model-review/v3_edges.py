import sys; sys.path.insert(0,'/work')
from backend.analysis.ct_model import *
base = {"ratio": "400/5", "accuracy_class": "5P20", "rct_ohm": 0.3}
for b in (2.5, 15, 30, 60):
    p = ct_saturation_params(dict(base, burden_va=b)); print(f"burden {b:5} VA -> I_sat {p['i_sat_primary']:.0f} A (knee {p['knee_point_v']:.1f} V)")
for r in (0.3, 1.0, 3.0):
    p = ct_saturation_params(dict(base, burden_va=15, rct_ohm=r)); print(f"Rct {r} -> I_sat {p['i_sat_primary']:.0f} A")
import math
p = ct_saturation_params(dict(base, burden_va=15)); I = 20*400
ks = p['knee_point_v']/((I/p['ratio'])*p['total_z']); th = math.acos(1-2*ks)
print(f"at ALF*In: engine RMS error {100*(1-ct_effective_current(I,p)/I):.1f}%  fundamental error {100*(1-math.hypot(th-math.sin(2*th)/2, math.sin(th)**2)/math.pi):.1f}%  (5P guarantees composite <=5%)")
for cls in ("5P20","10P10","5PR10","5P 10","PX","TPY","C200","0.5","0.5FS5"):
    print(f"class {cls!r:9} -> ALF {parse_ct_accuracy_alf(cls)}")
