"""Independent IEC 60909-0 reference solver for ProtectionPro project data.

Shares NO code with backend/analysis/fault.py. The network is built straight
from the wires at port level, in physical units (ohms, kV), with every
transformer an ideal transformer at its RATED ratio plus its leakage
impedance (IEC 60909-0 §6.3, K_T applied). Sources are shunt impedances to
the reference, the equivalent voltage source c·U_n/√3 sits at the fault
(§5.1). The bus impedance matrix gives Z(1), Z(2), Z(0) at each bus.

Element formulas follow IEC 60909-0:2016:
  network feeder  Eq. (15)  Z_Q = c·U_nQ²/S″_kQ
  transformer     Eq. (7),(12a)  Z_T = u_kr/100·U_rT²/S_rT, K_T = 0.95·c_max/(1+0.6·x_T)
  generator       Eq. (18)  Z_GK = K_G·(R_G + jX″d), K_G = (U_n/U_rG)·c_max/(1+x″d·sinφ)
                  (K_G also on Z(2), Z(0); not on 3·Z_N)
  async motor     Eq. (29)  Z_M = 1/(I_LR/I_rM)·U_rM²/S_rM
Engine conventions that are modelling CHOICES (not IEC formulas) are
reproduced so that only genuine defects show up: cable Z0 fallback 3·Z1,
generator Z0 = 0.5·Z1 when x0 is not given, inverter current limits,
single-earthed star-star magnetising 0.6 pu, converter actions.
"""
import math, cmath
import numpy as np

SQ3 = math.sqrt(3.0)
TRANSPARENT = {"cb", "switch", "fuse", "ct", "pt", "surge_arrester", "bus_duct"}
BUSLIKE = {"bus", "distribution_board"}
REAL_SOURCES = {"utility", "generator", "solar_pv", "wind_turbine", "battery"}
UNGROUNDED = ("ungrounded", "isolated", "none", "unearthed", "")


def _f(p, k, d):
    v = p.get(k, d)
    try:
        return float(v) if v not in (None, "") else float(d)
    except (TypeError, ValueError):
        return float(d)


def _ang(xr):
    """unit complex with X/R = xr"""
    return complex(1.0 / xr, 1.0) / abs(complex(1.0 / xr, 1.0)) if xr and xr > 0 else complex(0, 1)


class UF:
    def __init__(self):
        self.p = {}

    def find(self, k):
        self.p.setdefault(k, k)
        while self.p[k] != k:
            self.p[k] = self.p[self.p[k]]
            k = self.p[k]
        return k

    def union(self, a, b):
        a, b = self.find(a), self.find(b)
        if a != b:
            self.p[a] = b


class Net:
    """Port-level network: nodes, branches per sequence, shunts per sequence."""

    def __init__(self, project, c=1.1):
        self.c = c
        self.comps = {x.id: x for x in project.components}
        self.wires = project.wires
        uf = UF()
        def ep(cid, port):
            comp = self.comps.get(cid)
            if comp is not None and comp.type in BUSLIKE:
                return (cid, "*")
            return (cid, port)
        for w in self.wires:
            uf.union(ep(w.fromComponent, w.fromPort), ep(w.toComponent, w.toPort))
        # closed transparent devices join their two ports
        self.ports = {}
        for w in self.wires:
            self.ports.setdefault(w.fromComponent, set()).add(w.fromPort)
            self.ports.setdefault(w.toComponent, set()).add(w.toPort)
        for cid, comp in self.comps.items():
            if comp.type in TRANSPARENT:
                if comp.type in ("cb", "switch") and str(comp.props.get("state", "closed")).lower() == "open":
                    continue
                pl = sorted(self.ports.get(cid, []))
                for q in pl[1:]:
                    uf.union((cid, pl[0]), (cid, q))
        for cid, comp in self.comps.items():
            if comp.type in BUSLIKE:
                uf.find((cid, "*"))
        self.uf = uf
        self.ep = ep

    def node(self, cid, port):
        return self.uf.find(self.ep(cid, port))

    def bus_node(self, bid):
        return self.uf.find((bid, "*"))


def build(project, c=1.1, opts=None):
    """Return dict with node list, Y1, Y2, Y0 (Siemens), zone voltages."""
    opts = opts or {}
    net = Net(project, c)
    comps = net.comps
    # ---- zones: nodes joined by cables / transparent (already merged) -------
    zuf = UF()
    nodes = set()
    for w in net.wires:
        nodes.add(net.node(w.fromComponent, w.fromPort))
        nodes.add(net.node(w.toComponent, w.toPort))
    for cid, comp in comps.items():
        if comp.type in BUSLIKE:
            nodes.add(net.bus_node(cid))
    for n in nodes:
        zuf.find(n)
    def portnode(cid, port):
        return net.node(cid, port)
    def port_list(cid):
        return sorted(net.ports.get(cid, []))
    for cid, comp in comps.items():
        if comp.type in ("cable", "vfd", "ups"):     # same nominal voltage both sides
            pl = port_list(cid)
            if len(pl) == 2:
                zuf.union(portnode(cid, pl[0]), portnode(cid, pl[1]))
    zone_v = {}
    for cid, comp in comps.items():
        if comp.type in BUSLIKE:
            z = zuf.find(net.bus_node(cid))
            v = _f(comp.props, "voltage_kv", 0.4 if comp.type == "distribution_board" else 11)
            zone_v.setdefault(z, v)
    def un(n):
        return zone_v.get(zuf.find(n))
    # ---- energisation: connectivity through everything but open switches ----
    euf = UF()
    for n in nodes:
        euf.find(n)
    for cid, comp in comps.items():
        pl = port_list(cid)
        if comp.type in ("cb", "switch") and str(comp.props.get("state", "closed")).lower() == "open":
            continue
        for q in pl[1:]:
            euf.union(portnode(cid, pl[0]), portnode(cid, q))
    live_roots = set()
    for cid, comp in comps.items():
        if comp.type in REAL_SOURCES:
            for q in port_list(cid):
                live_roots.add(euf.find(portnode(cid, q)))
    def live(n):
        return euf.find(n) in live_roots

    idx = {n: i for i, n in enumerate(sorted(nodes, key=str))}
    N = len(idx)
    Y = {s: np.zeros((N, N), dtype=complex) for s in (1, 2, 0)}
    shunt_count = {s: np.zeros(N, dtype=int) for s in (1, 2, 0)}
    info = {"shunts": []}

    def add_shunt(seq, n, z, tag=""):
        if z is None or abs(z) < 1e-15 or not np.isfinite(abs(z)):
            return
        i = idx[n]
        Y[seq][i, i] += 1.0 / z
        shunt_count[seq][i] += 1
        info["shunts"].append((seq, n, z, tag))

    def add_branch(seq, a, b, z):
        if z is None or not np.isfinite(abs(z)):
            return
        if abs(z) < 1e-12:
            z = complex(1e-9, 1e-9)
        i, j = idx[a], idx[b]
        y = 1.0 / z
        Y[seq][i, i] += y; Y[seq][j, j] += y
        Y[seq][i, j] -= y; Y[seq][j, i] -= y

    def add_xfmr(seq, hv, lv, z_lv, t):
        """ideal t:1 (HV:LV) + z on the LV side"""
        i, j = idx[hv], idx[lv]
        y = 1.0 / z_lv
        Y[seq][i, i] += y / (t * t); Y[seq][j, j] += y
        Y[seq][i, j] -= y / t; Y[seq][j, i] -= y / t

    for cid, comp in comps.items():
        p = comp.props
        t = comp.type
        pl = port_list(cid)
        if not pl:
            continue
        if str(p.get("system", "ac")).lower() == "dc":
            continue
        # ---------------- sources and machines (one port) -------------------
        if t == "utility":
            n = portnode(cid, pl[0]); U = un(n) or _f(p, "voltage_kv", 11)
            zq = c * U * U / _f(p, "fault_mva", 500) * _ang(_f(p, "x_r_ratio", 15))
            add_shunt(1, n, zq, cid)
            r2 = _f(p, "z2_z1_ratio", 0) or _f(p, "x2_ratio", 0)
            add_shunt(2, n, zq * (r2 if r2 > 0 else 1.0), cid)
            if str(p.get("grounding", "solidly")).lower() not in UNGROUNDED:
                r0 = _f(p, "z0_z1_ratio", 0) or _f(p, "x0_ratio", 0)
                z0 = zq * (r0 if r0 > 0 else 1.0)
                es = str(p.get("earthing_system", "") or "").upper()
                if opts.get("utility_earthing", True) and U <= 1.0 and es == "IT":
                    z0 = None
                elif opts.get("utility_earthing", True) and U <= 1.0 and es == "TT":
                    z0 = z0 + 3 * (_f(p, "earth_electrode_r_source", 0) + _f(p, "earth_electrode_r_installation", 0))
                add_shunt(0, n, z0, cid)
            continue
        if t == "generator":
            n = portnode(cid, pl[0]); Un = un(n)
            UrG = _f(p, "voltage_kv", 0) or Un
            Sr = _f(p, "rated_mva", 10); xd = _f(p, "xd_pp", 0.15)
            pf = min(max(_f(p, "power_factor", 0.85), 0), 1); sphi = math.sqrt(1 - pf * pf)
            Xd = xd * UrG ** 2 / Sr
            xr = _f(p, "x_r_ratio", 0)
            if xr > 0:
                RG = Xd / xr
            else:
                RG = (0.15 if UrG <= 1.0 else (0.05 if Sr >= 100 else 0.07)) * Xd
            KG = (Un / UrG) * 1.1 / (1 + xd * sphi)
            z1 = KG * complex(RG, Xd)
            add_shunt(1, n, z1, cid)
            x2 = _f(p, "x2", 0)
            KG2 = 1.0 if opts.get("engine_x2x0") else KG
            if x2 > 0:
                X2 = x2 * UrG ** 2 / Sr
                add_shunt(2, n, KG2 * complex(X2 / (_f(p, "x_r_ratio", 40) or 40), X2), cid)
            else:
                add_shunt(2, n, z1, cid)
            g = str(p.get("grounding", "solidly")).lower()
            if g not in UNGROUNDED:
                x0 = _f(p, "x0", 0)
                if x0 > 0:
                    X0 = x0 * UrG ** 2 / Sr
                    z0 = KG2 * complex(X0 / (_f(p, "x_r_ratio", 40) or 40), X0)
                else:
                    z0 = 0.5 * z1
                zn = complex(_f(p, "grounding_resistance_ohm", _f(p, "grounding_resistance", 0)),
                             _f(p, "grounding_reactance_ohm", _f(p, "grounding_reactance", 0)))
                add_shunt(0, n, z0 + 3 * zn, cid)
            continue
        if t in ("motor_induction", "motor_synchronous", "static_load"):
            n = portnode(cid, pl[0])
            if not live(n) or not opts.get("motors", True):
                continue
            Un = un(n)
            if t == "motor_induction":
                UrM = _f(p, "voltage_kv", 0) or Un
                if opts.get("motor_un_base"):
                    UrM = Un
                Sr = _f(p, "rated_kw", 200) / (_f(p, "efficiency", 0.93) * _f(p, "power_factor", 0.85)) / 1000
                xr = _f(p, "x_r_ratio", 10)
                xpp = _f(p, "x_pp", 0)
                if xpp > 0:
                    z = complex(xpp / xr, xpp) * UrM ** 2 / Sr
                else:
                    z = (1.0 / _f(p, "locked_rotor_current", 6)) * UrM ** 2 / Sr * _ang(xr)
                add_shunt(1, n, z, cid); add_shunt(2, n, z, cid)
            elif t == "motor_synchronous":
                UrM = _f(p, "voltage_kv", 0) or Un
                Sr = _f(p, "rated_kva", 500) / 1000; xd = _f(p, "xd_pp", 0.15)
                pf = min(max(_f(p, "power_factor", 0.9), 0), 1); sphi = math.sqrt(1 - pf * pf)
                X = xd * UrM ** 2 / Sr
                xr = _f(p, "x_r_ratio", 0)
                R = X / xr if xr > 0 else (0.15 if UrM <= 1 else (0.05 if Sr >= 100 else 0.07)) * X
                K = (Un / UrM) * 1.1 / (1 + xd * sphi)
                add_shunt(1, n, K * complex(R, X), cid); add_shunt(2, n, K * complex(R, X), cid)
            else:  # static load rotating fraction
                mf = min(_f(p, "motor_fraction", 0), 1)
                if mf > 0:
                    Sm = _f(p, "rated_kva", 0) / 1000 * mf
                    z = (1 / _f(p, "motor_lrc_ratio", 6)) * Un ** 2 / Sm * complex(1 / _f(p, "x_r_ratio", 10), 1)
                    add_shunt(1, n, z, cid); add_shunt(2, n, z, cid)
            continue
        if t in ("solar_pv", "battery", "wind_turbine"):
            n = portnode(cid, pl[0]); Un = un(n)
            if t == "solar_pv":
                S = _f(p, "rated_kw", 100) * _f(p, "num_inverters", 1) / 1000; k = _f(p, "fault_contribution_pu", 1.1)
                z = (1 / max(k, 0.1)) * Un ** 2 / S * complex(0.1, 1)
            elif t == "battery":
                S = _f(p, "rated_kva", 100) / 1000; k = _f(p, "fault_contribution_pu", 1.1)
                z = (1 / max(k, 0.1)) * Un ** 2 / S * complex(0.1, 1)
            else:
                S = _f(p, "rated_mva", 2.0) * _f(p, "num_turbines", 1)
                if p.get("turbine_type", "type3_dfig") == "type4_frc":
                    z = (1 / max(_f(p, "fault_contribution_pu", 1.1), 0.1)) * Un ** 2 / S * complex(0.1, 1)
                else:
                    xr = _f(p, "x_r_ratio", 30)
                    z = _f(p, "xd_pp", 0.2) * Un ** 2 / S * complex(1 / xr, 1)
            add_shunt(1, n, z, cid); add_shunt(2, n, z, cid)
            continue
        # ---------------- distribution board own motors ----------------------
        if t == "distribution_board":
            n = net.bus_node(cid)
            mf = min(_f(p, "motor_fraction", 0), 1)
            if mf > 0 and live(n) and opts.get("motors", True):
                Un = un(n)
                Sm = _f(p, "rated_kva", 0) / 1000 * mf
                z = (1 / _f(p, "motor_lrc_ratio", 6)) * Un ** 2 / Sm * complex(1 / _f(p, "x_r_ratio", 10), 1)
                add_shunt(1, n, z, cid); add_shunt(2, n, z, cid)
            continue
        # ---------------- series elements -------------------------------------
        if t == "cable":
            if len(pl) != 2:
                continue
            a, b = portnode(cid, pl[0]), portnode(cid, pl[1])
            L = _f(p, "length_km", 1); npar = max(1, int(_f(p, "num_parallel", 1)))
            # IEC 60909-0 §2.4: maximum currents with line resistance at 20 °C.
            # Library / typed cable R is quoted hot (90 °C XLPE, 70 °C PVC).
            sid = str(p.get("standard_type") or "").lower()
            if str(p.get("construction", "")).lower() == "overhead":
                hot = 1.0
                rr = _f(p, "_r20_per_km", _f(p, "r_per_km", 0.1))
                rr0 = _f(p, "_r0_20_per_km", _f(p, "r0_per_km", 0))
            else:
                al = sid.startswith("al_") or str(p.get("conductor", "")).lower().startswith("al")
                pvc = "pvc" in sid or str(p.get("insulation", "")).upper() == "PVC"
                hot = 1.20 if pvc else (1.282 if al else 1.275)
                if opts.get("cable_hot", False):
                    hot = 1.0
                rr = _f(p, "r_per_km", 0.1); rr0 = _f(p, "r0_per_km", 0)
            r1 = rr / hot; xx = _f(p, "x_per_km", 0.08)
            z1 = complex(r1, xx) * L / npar
            r0, x0 = rr0 / hot, _f(p, "x0_per_km", 0)
            if r0 > 0 or x0 > 0:
                z0s = complex(r0 if r0 > 0 else 3.5 * r1, x0 if x0 > 0 else 3.5 * xx) * L
            else:
                z0s = 3.0 * complex(r1, xx) * L
            z0 = z0s / npar   # tests use z0_coupling none / single circuits
            add_branch(1, a, b, z1); add_branch(2, a, b, z1); add_branch(0, a, b, z0)
            continue
        if t == "transformer":
            if "primary" not in pl or "secondary" not in pl:
                continue
            step_up = p.get("winding_config") == "step_up"
            hv = portnode(cid, "secondary" if step_up else "primary")
            lv = portnode(cid, "primary" if step_up else "secondary")
            Uh, Ul = _f(p, "voltage_hv_kv", 11), _f(p, "voltage_lv_kv", 0.4)
            Sr, uk, xr = _f(p, "rated_mva", 10), _f(p, "z_percent", 8), _f(p, "x_r_ratio", 10)
            xT = uk / 100 * xr / math.hypot(1, xr)
            KT = 0.95 * 1.1 / (1 + 0.6 * xT)
            zT = uk / 100 * Ul ** 2 / Sr * _ang(xr) * KT          # ohm, LV side
            tr = Uh / Ul
            add_xfmr(1, hv, lv, zT, tr); add_xfmr(2, hv, lv, zT, tr)
            # zero sequence
            vg = str(p.get("vector_group", "Dyn11"))
            m = __import__("re").match(r"^([A-Z]+)([a-z]+)", vg)
            H, Lw = (m.group(1), m.group(2)) if m else ("D", "yn")
            def earthed(side, letter):
                key = "grounding_" + side
                if key in p and p[key] is not None:
                    return str(p[key]).lower() not in UNGROUNDED
                return letter.lower().endswith("n")
            def zn(side, U):
                g = str(p.get("grounding_" + side, "solidly_grounded")).lower()
                if g in ("low_resistance", "high_resistance"):
                    return complex(_f(p, f"grounding_{side}_resistance", 0), 0)
                if g == "reactance_grounded":
                    return complex(0, _f(p, f"grounding_{side}_reactance", 0))
                return complex(0, 0)
            ratio0 = _f(p, "z0_z1_ratio", 0)
            z0T = zT * (ratio0 if ratio0 > 0 else 1.0)          # LV-side ohms
            hk = H[0].upper(); lk = Lw[0].lower()
            h_e = hk in ("Y", "Z") and earthed("hv", H)
            l_e = lk in ("y", "z") and earthed("lv", Lw)
            es = str(p.get("earthing_system", "") or "").upper()
            lv_extra = complex(0, 0)
            lv_blocked = False
            if es and Ul <= 1.0:
                if es == "IT":
                    lv_blocked = True
                elif es == "TT":
                    lv_extra = complex(_f(p, "earth_electrode_r_source", 0) + _f(p, "earth_electrode_r_installation", 0), 0)
            z_nh = zn("hv", Uh) * (Ul / Uh) ** 2      # refer HV neutral ohms to LV side
            z_nl = zn("lv", Ul) + lv_extra
            def mag_branch():
                core = str(p.get("core_construction", "three_limb")).lower().replace("-", "_")
                ov = p.get("z0m_pu")
                if ov not in (None, "", 0, 0.0):
                    zpu = float(ov)
                elif core in ("three_limb", "3_limb"):
                    zpu = 0.6
                else:
                    return None
                xr0 = _f(p, "z0m_x_r_ratio", 0) or xr
                return zpu * Ul ** 2 / Sr * complex(1 / xr0, 1)
            if lk == "z" and l_e and not lv_blocked:
                # earthed zigzag LV: zero-sequence shunt at its own terminals
                add_shunt(0, lv, z0T + 3 * z_nl, cid + ":zn")
            if hk == "Z" and h_e:
                add_shunt(0, hv, (z0T + 3 * z_nh) * tr * tr, cid + ":ZN")
            if hk == "Y" and h_e and lk == "y" and l_e and not lv_blocked:
                add_xfmr(0, hv, lv, z0T + 3 * z_nh + 3 * z_nl, tr)
            elif hk == "Y" and h_e and lk == "d":
                add_shunt(0, hv, (z0T + 3 * z_nh) * tr * tr, cid + ":YNd")
            elif lk == "y" and l_e and hk == "D" and not lv_blocked:
                add_shunt(0, lv, z0T + 3 * z_nl, cid + ":Dyn")
            elif hk == "Y" and h_e and lk == "y" and not l_e:
                zm = mag_branch()
                if zm is not None:
                    add_shunt(0, hv, (z0T + 3 * z_nh + zm) * tr * tr, cid + ":YNy")
            elif lk == "y" and l_e and hk == "Y" and not h_e and not lv_blocked:
                zm = mag_branch()
                if zm is not None:
                    add_shunt(0, lv, z0T + 3 * z_nl + zm, cid + ":Yyn")
            continue
        if t == "autotransformer":
            if "primary" not in pl or "secondary" not in pl:
                continue
            hv, lv = portnode(cid, "primary"), portnode(cid, "secondary")
            Uh, Ul = _f(p, "voltage_hv_kv", 132), _f(p, "voltage_lv_kv", 66)
            Sr, xr = _f(p, "rated_mva", 20), _f(p, "x_r_ratio", 30)
            def kt(zp):
                x = zp / 100 * xr / math.hypot(1, xr)
                return 0.95 * 1.1 / (1 + 0.6 * x)
            zhl = _f(p, "z_percent", 8)
            three = int(_f(p, "windings", 2)) == 3 and "tertiary" in pl
            if not three:
                zT = zhl / 100 * Ul ** 2 / Sr * _ang(xr) * kt(zhl)
                for sq in (1, 2, 0):          # solidly earthed auto: Z0 series = Z_HX
                    add_xfmr(sq, hv, lv, zT, Uh / Ul)
                continue
            # 3-winding: IEC 60909-0 Eq. (13): K_T on each measured pair, then star
            zht, zlt = _f(p, "z_ht_percent", 26), _f(p, "z_lt_percent", 16)
            Ut = _f(p, "voltage_tv_kv", 11)
            tv = portnode(cid, "tertiary")
            zb = Uh ** 2 / Sr                       # ohm base on HV side
            ZAB = zhl / 100 * kt(zhl) * zb * _ang(xr)
            ZAC = zht / 100 * kt(zht) * zb * _ang(xr)
            ZBC = zlt / 100 * kt(zlt) * zb * _ang(xr)
            ZA = 0.5 * (ZAB + ZAC - ZBC); ZB = 0.5 * (ZAB + ZBC - ZAC); ZC = 0.5 * (ZAC + ZBC - ZAB)
            # internal star node on the HV side
            star = ("__star__", cid)
            if star not in idx:
                idx[star] = len(idx)
                for sq in (1, 2, 0):
                    Ynew = np.zeros((len(idx), len(idx)), dtype=complex)
                    Ynew[:-1, :-1] = Y[sq]; Y[sq] = Ynew
                    shunt_count[sq] = np.append(shunt_count[sq], 0)
            for sq in (1, 2):
                add_branch(sq, hv, star, ZA)
                add_xfmr(sq, star, lv, ZB / (Uh / Ul) ** 2, Uh / Ul)
                add_xfmr(sq, star, tv, ZC / (Uh / Ut) ** 2, Uh / Ut)
            # zero sequence: series HV-LV path through star, delta tertiary = Z0 shunt at star
            add_branch(0, hv, star, ZA)
            add_xfmr(0, star, lv, ZB / (Uh / Ul) ** 2, Uh / Ul)
            add_shunt(0, star, ZC, cid + ":tertiary-delta")
            continue
        if t == "vfd":
            # converter: decoupled sides
            if "in" in pl and live(portnode(cid, "in")) and str(p.get("front_end", "diode")).lower() == "afe":
                n = portnode(cid, "in"); Un = un(n)
                S = _f(p, "rated_kw", 200) / 1000 / max(_f(p, "efficiency", 0.96), 1e-3)
                z = (1 / 3.0) * Un ** 2 / S * _ang(10.0)
                add_shunt(1, n, z, cid); add_shunt(2, n, z, cid)
            if "out" in pl:
                n = portnode(cid, "out"); Un = un(n)
                S = _f(p, "rated_kw", 200) / 1000 / max(_f(p, "efficiency", 0.96), 1e-3)
                z = (c / _f(p, "fault_contribution_pu", 1.5)) * Un ** 2 / S * _ang(10.0)
                add_shunt(1, n, z, cid); add_shunt(2, n, z, cid)
            continue
        if t == "ups":
            topo = str(p.get("topology", "online_double")).lower()
            byp = str(p.get("static_bypass", "yes")).lower()
            if topo != "online_double" or byp not in ("no", "false", "0"):
                if "ac_in" in pl and "ac_out" in pl:
                    a, b = portnode(cid, "ac_in"), portnode(cid, "ac_out")
                    for s in (1, 2, 0):
                        add_branch(s, a, b, complex(1e-9, 1e-9))
            elif "ac_out" in pl:
                n = portnode(cid, "ac_out"); Un = un(n)
                S = _f(p, "rated_kva", 100) / 1000
                z = (c / _f(p, "fault_contribution_pu", 2.0)) * Un ** 2 / S * _ang(10.0)
                add_shunt(1, n, z, cid); add_shunt(2, n, z, cid)
            continue
    return {"idx": idx, "Y": Y, "net": net, "un": un, "info": info, "zuf": zuf, "zone_v": zone_v,
            "shunts": shunt_count}


def _zkk(Y, i, has_shunt):
    """Driving-point impedance at node i within its connected component.
    Returns None when the component has no path to the reference."""
    N = Y.shape[0]
    adj = [set() for _ in range(N)]
    nz = np.argwhere(np.abs(Y) > 1e-30)
    for a, b in nz:
        if a != b:
            adj[a].add(b)
    comp, st = {i}, [i]
    while st:
        u = st.pop()
        for v in adj[u]:
            if v not in comp:
                comp.add(v); st.append(v)
    cl = sorted(comp)
    sub = Y[np.ix_(cl, cl)]
    if not any(has_shunt[k] > 0 for k in cl):
        return None
    try:
        Z = np.linalg.inv(sub)
    except np.linalg.LinAlgError:
        return None
    z = Z[cl.index(i), cl.index(i)]
    if not np.isfinite(z) or abs(z) > 1e12:
        return None
    return complex(z)


def faults(project, c=1.1, opts=None):
    """{bus_id: dict(ik3, ik1, ikLL, ikLLG, z1, z2, z0)} in kA / ohm."""
    m = build(project, c, opts)
    out = {}
    for cid, comp in m["net"].comps.items():
        if comp.type not in BUSLIKE or str(comp.props.get("system", "ac")).lower() == "dc":
            continue
        n = m["net"].bus_node(cid)
        if n not in m["idx"]:
            continue
        i = m["idx"][n]
        Un = float(comp.props.get("voltage_kv", 0.4 if comp.type == "distribution_board" else 11))
        z1 = _zkk(m["Y"][1], i, m["shunts"][1]); z2 = _zkk(m["Y"][2], i, m["shunts"][2])
        z0 = _zkk(m["Y"][0], i, m["shunts"][0])
        r = {"z1": z1, "z2": z2, "z0": z0}
        if z1 is None:
            r.update(ik3=0.0, ik1=0.0, ikLL=0.0, ikLLG=0.0)
        else:
            z2 = z2 if z2 is not None else z1
            r["ik3"] = c * Un / (SQ3 * abs(z1))
            r["ikLL"] = c * Un / abs(z1 + z2)
            if z0 is None:
                r["ik1"] = 0.0; r["ikLLG"] = 0.0
            else:
                r["ik1"] = SQ3 * c * Un / abs(z1 + z2 + z0)
                r["ikLLG"] = SQ3 * c * Un * abs(z2) / abs(z1 * z2 + z1 * z0 + z2 * z0)
        out[cid] = r
    return out
