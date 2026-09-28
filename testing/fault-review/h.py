import math, sys, cmath
sys.path.insert(0, "/work")
from backend.models.schemas import Component, ProjectData, Wire
from backend.analysis import fault as F

def C(cid, t, **p): return Component(id=cid, type=t, x=0, y=0, props=p)
_n=[0]
def W(a, b, fp="bottom", tp="top"):
    _n[0]+=1; return Wire(id=f"w{_n[0]}", fromComponent=a, fromPort=fp, toComponent=b, toPort=tp)
def P(comps, wires, base=100.0):
    return ProjectData(projectName="t", baseMVA=base, frequency=50, components=comps, wires=wires)
def cmp(label, pred, eng):
    err = (eng-pred)/pred*100 if pred else float('nan')
    print(f"  {label:44s} predicted {pred:10.4f}  engine {eng:10.4f}  err {err:+7.2f}%")
