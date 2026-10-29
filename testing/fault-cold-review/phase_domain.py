"""Simultaneous open-conductor + shunt faults vs an exact PHASE-DOMAIN solve
(Z_abc = A·diag(Z0, Z1, Z2)·A⁻¹ per element, so the generator's Z0 = 0.5·Z1
convention is carried). Unloaded and loaded prefault (I_L = 0.4 pu through
the broken branch). Expected: agreement ≤ 0.01 %.

Supersedes testing/fault-review/v4 and v5, whose phase-domain references
predate the 20 °C cable rule and the generator Z0 default."""
import cmath
import math
import types
import numpy as np
from common import C, W, P, F, SQ3, cmp
import backend.analysis.loadflow as LF

c, base, kv = 1.1, 100.0, 11.0
zb, ibase = kv ** 2 / base, base / (SQ3 * kv)
a = cmath.exp(2j * math.pi / 3)
A = np.array([[1, 1, 1], [1, a * a, a], [1, a, a * a]])
Ainv = np.linalg.inv(A)


def zabc(z0, z1, z2):
    return A @ np.diag([z0, z1, z2]) @ Ainv


def cab(cid, r, x):
    return C(cid, "cable", r_per_km=r, x_per_km=x, r0_per_km=r, x0_per_km=x, length_km=1)


def project(side):
    comps = [C("u", "utility", fault_mva=200, x_r_ratio=10, voltage_kv=kv, z0_z1_ratio=1, grounding="solidly"),
             C("A", "bus", voltage_kv=kv), cab("K", 0.4, 0.3), C("B", "bus", voltage_kv=kv),
             C("g", "generator", rated_mva=5, xd_pp=0.15, voltage_kv=kv, x_r_ratio=20, grounding="solidly"),
             cab("L", 0.3, 0.2), C("PB", "bus", voltage_kv=kv)]
    wires = [W("u", "A"), W("A", "K", "out", "from"), W("K", "B", "to", "in"), W("g", "B")]
    up = "B" if side == "down" else "A"
    wires += [W(up, "L", "out", "from"), W("L", "PB", "to", "in")]
    return P(comps, wires)


def reference(proj, side, shunt, series_type, IL):
    cm = {x.id: x for x in proj.components}
    ZU = F._utility_impedance(cm["u"], base, c)
    ZG = F._generator_impedance(cm["g"], base, kv)
    ZK = complex(0.4 / 1.275, 0.3) / zb
    ZL = complex(0.3 / 1.275, 0.2) / zb
    if side == "up":
        EA, EB = c, c - IL * (ZU + ZK + ZG)
    else:
        EB, EA = c, c + IL * (ZU + ZK + ZG)
    nodes = ["A", "B", "PB"]
    Y = np.zeros((9, 9), complex); I = np.zeros(9, complex)
    def blk(nd):
        k = nodes.index(nd); return slice(3 * k, 3 * k + 3)
    def src(nd, Zs, E):
        Ys = np.linalg.inv(Zs); Y[blk(nd), blk(nd)] += Ys; I[blk(nd)] += Ys @ (E * np.array([1, a * a, a]))
    def ser(n1, n2, Zs, open_ph=()):
        keep = [p for p in range(3) if p not in open_ph]
        Ys = np.zeros((3, 3), complex); sub = np.linalg.inv(Zs[np.ix_(keep, keep)])
        for i, p in enumerate(keep):
            for j, q in enumerate(keep):
                Ys[p, q] = sub[i, j]
        Y[blk(n1), blk(n1)] += Ys; Y[blk(n2), blk(n2)] += Ys
        Y[blk(n1), blk(n2)] -= Ys; Y[blk(n2), blk(n1)] -= Ys
        return Ys
    src("A", zabc(ZU, ZU, ZU), EA)
    src("B", zabc(0.5 * ZG, ZG, ZG), EB)
    YK = ser("A", "B", zabc(ZK, ZK, ZK), (0,) if series_type == "open_conductor" else (1, 2))
    up = "B" if side == "down" else "A"
    YL = ser(up, "PB", zabc(ZL, ZL, ZL))
    for p in {"3phase": [0, 1, 2], "slg": [0]}[shunt]:
        Y[6 + p, :] = 0; Y[6 + p, 6 + p] = 1; I[6 + p] = 0
    V = np.linalg.solve(Y, I)
    return np.abs(YL @ (V[blk(up)] - V[blk("PB")])) * ibase, np.abs(YK @ (V[blk("A")] - V[blk("B")])) * ibase


worst = 0.0
for IL in (0.0, 0.4):
    if IL == 0.0:
        def _lf(*_a, **_k):
            raise RuntimeError("no prefault load flow")
    else:
        def _lf(*_a, **_k):
            return types.SimpleNamespace(converged=True, branches=[
                types.SimpleNamespace(elementId="K", i_amps=IL * ibase * 1000)])
    LF.run_load_flow = _lf
    for series_type in ("open_conductor", "two_conductor_open"):
        for side in ("up", "down"):
            for st in ("3phase", "slg"):
                r = F.run_simultaneous_fault_analysis(project(side), "K", series_type, "PB", st)
                ip, ik = reference(project(side), side, st, series_type, IL)
                print(f"{series_type}, shunt bus {side}, {st}, I_L = {IL} pu")
                for nm, pv, ev in zip("abc", ip, (r.ipa_ka, r.ipb_ka, r.ipc_ka)):
                    if pv > 1e-6:
                        worst = max(worst, abs(cmp(f"shunt fault current phase {nm} (kA)", pv, ev, tol=0.01)))
                brk = (("b", ik[1], r.ib_ka), ("c", ik[2], r.ic_ka)) if series_type == "open_conductor" \
                    else (("a", ik[0], r.ia_ka),)
                for nm, pv, ev in brk:
                    if pv > 1e-6:
                        worst = max(worst, abs(cmp(f"break current phase {nm} (kA)", pv, ev, tol=0.01)))
print(f"\nworst: {worst:.4f} %")
