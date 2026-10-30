"""Reproductions of every defect found in the 2026-10 cold-eyes review of the
IEC 60909 fault engine. Each check builds a minimal network, computes the
expected value independently (hand calculation or ref60909), and runs the
engine. A check reports DEFECT while the engine still disagrees.

    python testing/fault-cold-review/findings.py          # all
    python testing/fault-cold-review/findings.py F05 F07  # some
"""
import math
import sys
import types

from common import C, W, P, F, R, SQ3, cmp, par, quiet, compare

c = 1.1
BASE = 100.0
CHECKS = []


def check(fid, title, tol=0.5):
    def deco(fn):
        CHECKS.append((fid, title, tol, fn))
        return fn
    return deco


def _ang(xr):
    return complex(1 / xr, 1) / abs(complex(1 / xr, 1))


@check("F01", "Three-winding autotransformer is not expanded by the fault engine")
def f01():
    proj = P([C("u", "utility", fault_mva=5000, x_r_ratio=15, voltage_kv=132, z0_z1_ratio=1.0),
              C("H", "bus", voltage_kv=132), C("L", "bus", voltage_kv=66), C("T", "bus", voltage_kv=11),
              C("at", "autotransformer", windings=3, rated_mva=20, voltage_hv_kv=132, voltage_lv_kv=66,
                voltage_tv_kv=11, z_percent=8, z_ht_percent=26, z_lt_percent=16, x_r_ratio=30)],
             [W("u", "H"), W("H", "at", "out", "primary"), W("at", "L", "secondary", "in"),
              W("at", "T", "tertiary", "in")])
    eng = quiet(F.run_fault_analysis, proj).buses
    ref = R.faults(proj)
    e = [cmp("Ik3 at the 11 kV tertiary bus (kA)", ref["T"]["ik3"], eng["T"].ik3),
         cmp("Ik1 at the 66 kV bus (delta tertiary is a Z0 source) (kA)", ref["L"]["ik1"], eng["L"].ik1),
         cmp("IkE2E at the 66 kV bus (kA)", ref["L"]["ikLLG"], eng["L"].ikLLG)]
    print(f"     tertiary Ik1: expected 0 (delta winding), engine {eng['T'].ik1} kA")
    return e


@check("F02", "Zero-sequence path sharing is not detected when the positive sequence is radial")
def f02():
    errs = []
    # (a) utility + YNd1 transformer on an HV bus, line to a remote bus
    U, L = 132.0, 30.0
    zb, ib = U ** 2 / BASE, BASE / (SQ3 * U)
    zq = c * BASE / 3000.0
    ZQ = zq * _ang(12)
    ZL1, ZL0 = complex(0.08 / 1.275, 0.40) * L / zb, complex(0.25 / 1.275, 1.20) * L / zb
    xt = 0.12 * 40 / math.hypot(1, 40)
    ZT = 0.12 * BASE / 60 * _ang(40) * 0.95 * 1.1 / (1 + 0.6 * xt)
    proj = P([C("u", "utility", fault_mva=3000, x_r_ratio=12, voltage_kv=U, z0_z1_ratio=1.0),
              C("A", "bus", voltage_kv=U), C("B", "bus", voltage_kv=33), C("Cb", "bus", voltage_kv=U),
              C("t", "transformer", rated_mva=60, z_percent=12, x_r_ratio=40, voltage_hv_kv=U, voltage_lv_kv=33,
                vector_group="YNd1", grounding_hv="solidly_grounded", grounding_lv="ungrounded"),
              C("l", "cable", r_per_km=0.08, x_per_km=0.40, r0_per_km=0.25, x0_per_km=1.20, length_km=L)],
             [W("u", "A"), W("A", "t", "out", "primary"), W("t", "B", "secondary", "in"),
              W("A", "l", "out", "from"), W("l", "Cb", "to", "in")])
    r = quiet(F.run_fault_analysis, proj, fault_type="slg").buses["Cb"]
    Z1, Z0 = ZQ + ZL1, ZL0 + par(ZQ, ZT)
    print(f"     (a) line from an HV bus with grid + YNd1 unit; engine topology = {r.network_topology}")
    errs.append(cmp("(a) Ik1 at the remote bus (kA)", 3 * c / abs(2 * Z1 + Z0) * ib, r.ik1))
    # (b) YNyn0 unit fed from an HV bus that also carries a YNd1 unit
    proj = P([C("u", "utility", fault_mva=1500, x_r_ratio=10, voltage_kv=33), C("H", "bus", voltage_kv=33),
              C("t1", "transformer", rated_mva=2.5, z_percent=8, x_r_ratio=10, voltage_hv_kv=33, voltage_lv_kv=11,
                vector_group="YNyn0", grounding_hv="solidly_grounded", grounding_lv="solidly_grounded"),
              C("L", "bus", voltage_kv=11),
              C("t2", "transformer", rated_mva=20, z_percent=6, x_r_ratio=10, voltage_hv_kv=33, voltage_lv_kv=11,
                vector_group="YNd1", grounding_hv="solidly_grounded", grounding_lv="ungrounded"),
              C("M", "bus", voltage_kv=11)],
             [W("u", "H"), W("H", "t1", "out", "primary"), W("t1", "L", "secondary", "in"),
              W("H", "t2", "out", "primary"), W("t2", "M", "secondary", "in")])
    eng = quiet(F.run_fault_analysis, proj).buses["L"]
    ref = R.faults(proj)["L"]
    errs.append(cmp("(b) Ik1 on the LV side of a YNyn0 unit (kA)", ref["ik1"], eng.ik1))
    errs.append(cmp("(b) IkE2E on the LV side of a YNyn0 unit (kA)", ref["ikLLG"], eng.ikLLG))
    return errs


@check("F03", "Earthed zigzag (Yzn11 / Yzn1) secondary gives no earth-fault current")
def f03():
    errs = []
    for vg in ("Yzn11", "Yzn1"):
        proj = P([C("u", "utility", fault_mva=250, x_r_ratio=10, voltage_kv=11), C("b1", "bus", voltage_kv=11),
                  C("t", "transformer", rated_mva=0.2, z_percent=4.5, x_r_ratio=3, voltage_hv_kv=11,
                    voltage_lv_kv=0.4, vector_group=vg, grounding_hv="ungrounded", grounding_lv="solidly_grounded"),
                  C("b2", "bus", voltage_kv=0.4)],
                 [W("u", "b1"), W("b1", "t", "out", "primary"), W("t", "b2", "secondary", "in")])
        eng = quiet(F.run_fault_analysis, proj).buses["b2"]
        ref = R.faults(proj)["b2"]
        errs.append(cmp(f"{vg}: Ik1 on the LV bus, Z0T = Z1T convention (kA)", ref["ik1"], eng.ik1))
    return errs


@check("F04", "LV utility earthing system TT / IT is ignored", tol=5.0)
def f04():
    U = 0.4
    zb, ib = U ** 2 / BASE, BASE / (SQ3 * U)
    ZQ = c * BASE / 20.0 * _ang(3)
    def run(es):
        proj = P([C("u", "utility", fault_mva=20, x_r_ratio=3, voltage_kv=U, z0_z1_ratio=1.0, earthing_system=es,
                    earth_electrode_r_source=1.0, earth_electrode_r_installation=20.0),
                  C("b", "bus", voltage_kv=U)], [W("u", "b")])
        return quiet(F.run_fault_analysis, proj, fault_type="slg").buses["b"].ik1
    # the engine rounds kA to 3 decimals: compare in amps with a 5 % band
    e = [cmp("TT: Ik1 with 3·(R_A + R_B) = 63 ohm in the loop (kA)",
             3 * c / abs(3 * ZQ + 3 * 21.0 / zb) * ib, run("TT"))]
    print(f"     IT: engine Ik1 = {run('IT')} kA, expected about 0")
    return e


@check("F05", "Generator with rated voltage different from the bus nominal voltage")
def f05():
    errs = []
    for UrG, Un in ((10.5, 10.0), (10.5, 11.0), (0.415, 0.4)):
        sphi = math.sqrt(1 - 0.85 ** 2)
        Xd = 0.15 * UrG ** 2 / 10
        KG = (Un / UrG) * 1.1 / (1 + 0.15 * sphi)
        Z = KG * complex((0.07 if UrG > 1 else 0.15) * Xd, Xd)
        proj = P([C("g", "generator", rated_mva=10, voltage_kv=UrG, xd_pp=0.15, power_factor=0.85),
                  C("b", "bus", voltage_kv=Un)], [W("g", "b")])
        r = quiet(F.run_fault_analysis, proj).buses["b"]
        errs.append(cmp(f"U_rG {UrG} kV on a {Un} kV bus: Ik3 (kA)", c * Un / (SQ3 * abs(Z)), r.ik3))
    return errs


@check("F06", "More than 200 source paths: sources silently dropped")
def f06():
    errs = []
    for last in (False, True):
        comps, wires = [C("B", "bus", voltage_kv=0.4)], []
        u = C("u", "utility", fault_mva=30, x_r_ratio=5, voltage_kv=0.4)
        if not last:
            comps.append(u); wires.append(W("u", "B"))
        for i in range(250):
            comps.append(C(f"m{i}", "motor_induction", rated_kw=15, voltage_kv=0.4, efficiency=0.9,
                           power_factor=0.85, locked_rotor_current=6, x_r_ratio=2.4))
            wires.append(W("B", f"m{i}", "out", "in"))
        if last:
            comps.append(u); wires.append(W("u", "B"))
        p = P(comps, wires)
        e = quiet(F.run_fault_analysis, p, fault_type="3phase").buses["B"]
        errs.append(cmp(f"250 motors on one bus, utility wired {'last' if last else 'first'}: Ik3 (kA)",
                        R.faults(p)["B"]["ik3"], e.ik3))
    return errs


@check("F07", "Minimum-current run keeps motor contributions (IEC 60909-0 §2.5: neglect motors)")
def f07():
    comps = [C("u", "utility", fault_mva=250, x_r_ratio=10, voltage_kv=11), C("A", "bus", voltage_kv=11),
             C("t", "transformer", rated_mva=1.6, z_percent=6, x_r_ratio=8, voltage_hv_kv=11, voltage_lv_kv=0.4,
               vector_group="Dyn11", grounding_hv="ungrounded", grounding_lv="solidly_grounded"),
             C("B", "bus", voltage_kv=0.4),
             C("m", "motor_induction", rated_kw=600, voltage_kv=0.4, efficiency=0.95, power_factor=0.87,
               locked_rotor_current=6, x_r_ratio=2.4)]
    p = P(comps, [W("u", "A"), W("A", "t", "out", "primary"), W("t", "B", "secondary", "in"),
                  W("B", "m", "out", "in")])
    eng = quiet(F.run_fault_analysis, p, voltage_factor=0.95, conductor_temperature_c="final").buses["B"]
    ref = R.faults(p, 0.95, {"motors": False})["B"]
    return [cmp("minimum study Ik3 at the motor bus, motors neglected (kA)", ref["ik3"], eng.ik3),
            cmp("minimum study Ik1 at the motor bus, motors neglected (kA)", ref["ik1"], eng.ik1)]


@check("F08", "Ib below IEC 60909-0 Eq. (75) when machines feed through a shared branch", tol=1.0)
def f08():
    U = 11.0
    zb, ibase = U ** 2 / BASE, BASE / (SQ3 * U)
    errs = []
    for L in (1.0, 3.0):
        comps = [C("u", "utility", fault_mva=250, x_r_ratio=10, voltage_kv=U), C("A", "bus", voltage_kv=U),
                 C("g", "generator", rated_mva=10, voltage_kv=U, xd_pp=0.12, power_factor=0.85),
                 C("m", "motor_induction", rated_kw=3000, voltage_kv=U, efficiency=0.95, power_factor=0.88,
                   locked_rotor_current=6, x_r_ratio=10, poles=4),
                 C("k", "cable", r_per_km=0.15 * 1.275, x_per_km=0.1, length_km=L), C("B", "bus", voltage_kv=U)]
        p = P(comps, [W("u", "A"), W("g", "A"), W("A", "m", "out", "in"), W("A", "k", "out", "from"),
                      W("k", "B", "to", "in")])
        cm = {x.id: x for x in comps}
        ZQ = F._utility_impedance(cm["u"], BASE, c)
        ZG = F._generator_impedance(cm["g"], BASE, U)
        ZM = F._motor_induction_impedance(cm["m"], BASE)
        Zc = complex(0.15, 0.1) * L / zb
        Ys = 1 / ZQ + 1 / ZG + 1 / ZM
        If = c / (Zc + 1 / Ys)
        VA = If / Ys
        IG, IM = VA / ZG, VA / ZM
        mu = lambda r: 1.0 if r <= 2 else min(1.0, 0.62 + 0.72 * math.exp(-0.32 * r))
        muG = mu(abs(IG) * BASE / 10.0)
        muM = mu(abs(IM) * BASE / (3.0 / (0.95 * 0.88)))
        qM = max(0.0, min(1.0, 0.57 + 0.12 * math.log(3.0 / 2)))
        Ib = (abs(If) - abs(ZG.imag * IG) / c * (1 - muG) * abs(IG)
              - abs(ZM.imag * IM) / c * (1 - muM * qM) * abs(IM))
        e = quiet(F.run_fault_analysis, p, fault_type="3phase").buses["B"]
        errs.append(cmp(f"cable {L} km: Ib at B vs Eq. (75) (kA)", Ib * ibase, e.ib, tol=1.0))
    return errs


@check("F09", "Branch fault currents mis-split when sources share an upstream branch")
def f09():
    U = 11.0
    zb, ib0 = U ** 2 / BASE, BASE / (SQ3 * U)
    errs = []
    for L in (1.0, 5.0):
        comps = [C("u", "utility", fault_mva=250, x_r_ratio=10, voltage_kv=U), C("cbu", "cb", state="closed"),
                 C("A", "bus", voltage_kv=U), C("cbm", "cb", state="closed"),
                 C("m", "motor_induction", rated_kw=3000, voltage_kv=U, efficiency=0.95, power_factor=0.88,
                   locked_rotor_current=6, x_r_ratio=10),
                 C("k", "cable", r_per_km=0.15 * 1.275, x_per_km=0.1, length_km=L), C("B", "bus", voltage_kv=U)]
        p = P(comps, [W("u", "cbu", "out", "top"), W("cbu", "A", "bottom", "in"), W("A", "cbm", "out", "top"),
                      W("cbm", "m", "bottom", "in"), W("A", "k", "out", "from"), W("k", "B", "to", "in")])
        cm = {x.id: x for x in comps}
        ZQ = F._utility_impedance(cm["u"], BASE, c)
        ZM = F._motor_induction_impedance(cm["m"], BASE)
        Zc = complex(0.15, 0.1) * L / zb
        It = c / (Zc + par(ZQ, ZM))
        IQ = It * (1 / ZQ) / (1 / ZQ + 1 / ZM)
        e = quiet(F.run_fault_analysis, p, fault_type="3phase").buses["B"]
        br = {b.element_id: b.ik_ka for b in e.branches}
        errs.append(cmp(f"cable {L} km: utility incomer current (kA)", abs(IQ) * ib0, br.get("cbu", 0)))
        errs.append(cmp(f"cable {L} km: motor breaker current (kA)", abs(It - IQ) * ib0, br.get("cbm", 0)))
    return errs


@check("F10", "Rotating fraction of a board / static load counted once per parallel path")
def f10():
    comps = [C("u", "utility", fault_mva=20, x_r_ratio=5, voltage_kv=0.4), C("A", "bus", voltage_kv=0.4),
             C("k1", "cable", r_per_km=0.1, x_per_km=0.08, length_km=0.05),
             C("k2", "cable", r_per_km=0.1, x_per_km=0.08, length_km=0.05),
             C("db", "distribution_board", voltage_kv=0.4, rated_kva=1000, motor_fraction=0.5, motor_lrc_ratio=6,
               x_r_ratio=2.4)]
    p = P(comps, [W("u", "A"), W("A", "k1", "out", "from"), W("k1", "db", "to", "in"),
                  W("A", "k2", "out", "from"), W("k2", "db", "to", "in")])
    e = quiet(F.run_fault_analysis, p, fault_type="3phase").buses["A"]
    print(f"     engine topology at A = {e.network_topology}")
    return [cmp("Ik3 at A, board with 50 % motors behind two cables (kA)", R.faults(p)["A"]["ik3"], e.ik3)]


@check("F11", "Diode-front-end drive fed by a cable (no bus at the drive) back-feeds")
def f11():
    U = 0.4
    ZQ = c * U ** 2 / 20 * _ang(10)
    comps = [C("u", "utility", fault_mva=20, x_r_ratio=10, voltage_kv=U), C("b", "bus", voltage_kv=U),
             C("k", "cable", r_per_km=0.1, x_per_km=0.08, length_km=0.05),
             C("vfd", "vfd", rated_kw=200, efficiency=0.96, front_end="diode"),
             C("m", "motor_induction", rated_kw=200, efficiency=0.95, power_factor=0.85, locked_rotor_current=6,
               x_r_ratio=10, voltage_kv=U)]
    p = P(comps, [W("u", "b"), W("b", "k", "out", "from"), W("k", "vfd", "to", "in"), W("vfd", "m", "out", "in")])
    e = quiet(F.run_fault_analysis, p, fault_type="3phase").buses["b"]
    return [cmp("Ik3 at the supply bus = grid only (kA)", c * U / (SQ3 * abs(ZQ)), e.ik3)]


@check("F12", "Two loads on the end of one cable (no bus): phantom cable between them")
def f12():
    U = 11.0
    zb, ib = U ** 2 / BASE, BASE / (SQ3 * U)
    ZQ = c * BASE / 250.0 * _ang(10)
    Zc = complex(0.3 / 1.275, 0.2) * 2.0 / zb
    def zm(kw):
        x = (1 / 6) / math.hypot(1, 0.1) * BASE / (kw / (0.95 * 0.9 * 1000))
        return complex(x / 10, x)
    comps = [C("u", "utility", fault_mva=250, x_r_ratio=10, voltage_kv=U), C("A", "bus", voltage_kv=U),
             C("k", "cable", r_per_km=0.3, x_per_km=0.2, length_km=2.0)]
    for i, kw in ((1, 2000), (2, 1500)):
        comps.append(C(f"m{i}", "motor_induction", rated_kw=kw, efficiency=0.95, power_factor=0.9,
                       locked_rotor_current=6, x_r_ratio=10, voltage_kv=U))
    p = P(comps, [W("u", "A"), W("A", "k", "out", "from"), W("k", "m1", "to", "in"), W("k", "m2", "to", "in")])
    e = quiet(F.run_fault_analysis, p, fault_type="3phase").buses
    # the common node is a junction bus once fixed, else each motor's own terminal bus
    node = next((k for k in e if k.startswith("__tee__")), "__term__m1")
    return [cmp("Ik3 at the motors' common terminal (kA)", c / abs(par(ZQ + Zc, zm(2000), zm(1500))) * ib,
                e[node].ik3)]


@check("F13", "Synthetic terminal bus takes the load's nameplate voltage, not the network's")
def f13():
    errs = []
    ZQ = c * 0.4 ** 2 / 20 * _ang(5)
    zc = complex(0.2 / 1.275, 0.08) * 0.1
    for kv in (0.38, 0.23):
        comps = [C("u", "utility", fault_mva=20, x_r_ratio=5, voltage_kv=0.4), C("A", "bus", voltage_kv=0.4),
                 C("k", "cable", r_per_km=0.2, x_per_km=0.08, length_km=0.1),
                 C("ld", "static_load", rated_kva=50, voltage_kv=kv)]
        p = P(comps, [W("u", "A"), W("A", "k", "out", "from"), W("k", "ld", "to", "in")])
        e = quiet(F.run_fault_analysis, p, fault_type="3phase").buses["__term__ld"]
        errs.append(cmp(f"load nameplate {kv} kV on a 0.4 kV cable: terminal Ik3 (kA)",
                        c * 0.4 / (SQ3 * abs(ZQ + zc)), e.ik3))
    return errs


@check("F14", "Motor rated voltage different from the bus nominal voltage", tol=0.05)
def f14():
    errs = []
    for UrM, Un in ((0.38, 0.4), (6.0, 6.6)):
        s = 0.5 / (0.95 * 0.88)
        ZM = (1 / 6) * UrM ** 2 / s * _ang(10)
        Sk = 20.0 if Un < 1 else 50.0
        ZQ = c * Un ** 2 / Sk * _ang(10)
        p = P([C("u", "utility", fault_mva=Sk, x_r_ratio=10, voltage_kv=Un),
               C("m", "motor_induction", rated_kw=500, efficiency=0.95, power_factor=0.88, locked_rotor_current=6,
                 x_r_ratio=10, voltage_kv=UrM), C("b", "bus", voltage_kv=Un)],
              [W("u", "b"), W("b", "m", "out", "in")])
        e = quiet(F.run_fault_analysis, p, fault_type="3phase").buses["b"]
        errs.append(cmp(f"U_rM {UrM} kV on {Un} kV: bus Ik3 incl. motor (kA)",
                        c * Un / (SQ3 * abs(par(ZQ, ZM))), e.ik3, tol=0.05))
    return errs


@check("F15", "Transformer without grounding props: YN HV star treated as unearthed")
def f15():
    t = C("t", "transformer", rated_mva=10, z_percent=8, x_r_ratio=10, voltage_hv_kv=33, voltage_lv_kv=11,
          vector_group="YNd1")
    p = P([C("u", "utility", fault_mva=500, x_r_ratio=10, voltage_kv=33), C("H", "bus", voltage_kv=33), t,
           C("L", "bus", voltage_kv=11)], [W("u", "H"), W("H", "t", "out", "primary"), W("t", "L", "secondary", "in")])
    e = quiet(F.run_fault_analysis, p).buses["H"]
    return [cmp("YNd1 with no grounding props, Ik1 on the HV bus (kA)", R.faults(p)["H"]["ik1"], e.ik1)]


@check("F16", "K_G not applied to an entered generator X2 / X0", tol=0.1)
def f16():
    p = P([C("g", "generator", rated_mva=2, voltage_kv=0.4, xd_pp=0.25, power_factor=0.8, x2=0.15, x0=0.06,
             x_r_ratio=20, grounding="solidly"), C("b", "bus", voltage_kv=0.4)], [W("g", "b")])
    e = quiet(F.run_fault_analysis, p).buses["b"]
    r = R.faults(p)["b"]
    return [cmp("Ik1 (kA)", r["ik1"], e.ik1, tol=0.1), cmp("IkLL (kA)", r["ikLL"], e.ikLL, tol=0.1)]


@check("F17", "PV / battery current limit scaled by the voltage factor c")
def f17():
    p = P([C("s", "solar_pv", rated_kw=500, num_inverters=1, voltage_kv=0.4, fault_contribution_pu=1.2),
           C("b", "bus", voltage_kv=0.4)], [W("s", "b")])
    e = quiet(F.run_fault_analysis, p, fault_type="3phase").buses["b"]
    return [cmp("PV terminal Ik3 = 1.2 x I_r (kA)", 1.2 * 0.5 / (SQ3 * 0.4), e.ik3)]


@check("F18", "Retained voltage ignores a board's own rotating fraction")
def f18():
    import numpy as np
    comps = [C("u", "utility", fault_mva=20, x_r_ratio=5, voltage_kv=0.4), C("A", "bus", voltage_kv=0.4),
             C("k1", "cable", r_per_km=0.3, x_per_km=0.08, length_km=0.1),
             C("db", "distribution_board", voltage_kv=0.4, rated_kva=800, motor_fraction=0.6, motor_lrc_ratio=6,
               x_r_ratio=2.4),
             C("k2", "cable", r_per_km=0.3, x_per_km=0.08, length_km=0.1), C("Bf", "bus", voltage_kv=0.4)]
    p = P(comps, [W("u", "A"), W("A", "k1", "out", "from"), W("k1", "db", "to", "in"),
                  W("A", "k2", "out", "from"), W("k2", "Bf", "to", "in")])
    eng = quiet(F.run_fault_analysis, p).buses["Bf"].voltage_depression["db"]["subtransient_pu"]
    m = R.build(p)
    Z = np.linalg.inv(m["Y"][1])
    k, j = m["idx"][m["net"].bus_node("Bf")], m["idx"][m["net"].bus_node("db")]
    return [cmp("fault at Bf: retained voltage at the board (pu)", abs(1 - Z[j, k] / Z[k, k]), eng)]


def main(sel):
    rows = []
    for fid, title, tol, fn in CHECKS:
        if sel and fid not in sel:
            continue
        print(f"\n{fid} {title}")
        errs = [e for e in fn() if e is not None]
        worst = max((abs(e) for e in errs), default=0.0)
        rows.append((fid, title, worst, worst > tol))
    print("\nSummary")
    for fid, title, worst, bad in rows:
        w = "inf" if worst == float("inf") else f"{worst:.1f} %"
        print(f"  {fid}  {'DEFECT' if bad else 'ok    '}  worst {w:>9s}  {title}")
    return 1 if any(b for *_, b in rows) else 0


if __name__ == "__main__":
    sys.exit(main(set(sys.argv[1:])))
