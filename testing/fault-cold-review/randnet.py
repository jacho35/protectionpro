"""Random network generators for fuzzing the engine against ref60909."""
import random
from common import C, P
from backend.models.schemas import Wire


class G:
    def __init__(self, seed):
        self.r = random.Random(seed)
        self.comps, self.wires, self.n = [], [], 0

    def id(self, t):
        self.n += 1
        return f"{t}{self.n}"

    def add(self, cid, t, **p):
        self.comps.append(C(cid, t, **p))
        return cid

    def wire(self, a, ap, b, bp):
        self.n += 1
        self.wires.append(Wire(id=f"w{self.n}", fromComponent=a, fromPort=ap, toComponent=b, toPort=bp))

    def bus(self, kv, db=False):
        if db:
            return self.add(self.id("db"), "distribution_board", voltage_kv=kv,
                            rated_kva=self.r.choice([100, 250, 400]),
                            motor_fraction=self.r.choice([0, 0, 0.3, 0.5]), motor_lrc_ratio=6,
                            x_r_ratio=self.r.choice([2.4, 10]))
        return self.add(self.id("bus"), "bus", voltage_kv=kv)

    def cable(self, a, b, kv, cb_state=None):
        r = self.r
        extra = ({"r0_per_km": round(r.uniform(0.2, 3), 3), "x0_per_km": round(r.uniform(0.2, 1.5), 3)}
                 if r.random() < 0.5 else {})
        k = self.add(self.id("cab"), "cable", r_per_km=round(r.uniform(0.05, 1.2), 3),
                     x_per_km=round(r.uniform(0.07, 0.4), 3),
                     length_km=round(r.uniform(0.02, 3.0 if kv > 1 else 0.3), 3), **extra)
        if cb_state is not None:
            cb = self.add(self.id("cb"), "cb", state=cb_state)
            self.wire(a, "out", cb, "top")
            self.wire(cb, "bottom", k, "from")
        else:
            self.wire(a, "out", k, "from")
        self.wire(k, "to", b, "in")
        return k

    def xfmr(self, hv_bus, lv_bus, uh, ul, step_up=False, vg=None, off=1.0):
        r = self.r
        vg = vg or r.choice(["Dyn11", "Dyn11", "YNd1", "YNyn0", "Dd0", "Yyn0", "Dyn1"])
        g_hv = "solidly_grounded" if vg.startswith("YN") else "ungrounded"
        g_lv = "solidly_grounded" if "yn" in vg else "ungrounded"
        if vg.startswith("YN") and r.random() < 0.3:
            g_hv = "low_resistance"
        if "yn" in vg and r.random() < 0.3:
            g_lv = "low_resistance"
        t = self.add(self.id("tx"), "transformer", rated_mva=r.choice([0.5, 1, 2.5, 10, 20]),
                     z_percent=r.choice([4, 6, 8, 10]), x_r_ratio=r.choice([5, 10, 20]),
                     voltage_hv_kv=uh, voltage_lv_kv=round(ul * off, 4), vector_group=vg,
                     grounding_hv=g_hv, grounding_lv=g_lv,
                     grounding_hv_resistance=round(r.uniform(5, 50), 2),
                     grounding_lv_resistance=round(r.uniform(0.5, 5), 2) if ul > 1 else 0.2,
                     winding_config="step_up" if step_up else "step_down")
        if step_up:
            self.wire(lv_bus, "out", t, "primary")
            self.wire(t, "secondary", hv_bus, "in")
        else:
            self.wire(hv_bus, "out", t, "primary")
            self.wire(t, "secondary", lv_bus, "in")
        return t

    def utility(self, b, kv):
        r = self.r
        u = self.add(self.id("u"), "utility", fault_mva=r.choice([250, 500, 1500, 5000]),
                     x_r_ratio=r.choice([5, 10, 15]), voltage_kv=kv,
                     z0_z1_ratio=r.choice([1.0, 1.5, 3.0]), z2_z1_ratio=1.0)
        self.wire(u, "out", b, "in")
        return u

    def gen(self, b, kv):
        r = self.r
        g = self.add(self.id("g"), "generator", rated_mva=r.choice([0.5, 2, 10]), voltage_kv=kv,
                     xd_pp=r.choice([0.12, 0.15, 0.2]), xd_p=0.25, xd=1.5, power_factor=0.85,
                     grounding=r.choice(["solidly", "ungrounded"]))
        self.wire(g, "out", b, "in")
        return g

    def motor(self, b, kv):
        r = self.r
        m = self.add(self.id("m"), "motor_induction", rated_kw=r.choice([75, 200, 500, 1500]), voltage_kv=kv,
                     efficiency=0.94, power_factor=0.87, locked_rotor_current=r.choice([5, 6, 7]),
                     x_r_ratio=r.choice([2.4, 10]))
        self.wire(b, "out", m, "in")
        return m

    def load(self, b, kv):
        r = self.r
        ld = self.add(self.id("ld"), "static_load", rated_kva=r.choice([50, 200, 800]), voltage_kv=kv,
                      motor_fraction=r.choice([0, 0.4]), motor_lrc_ratio=6, x_r_ratio=10)
        self.wire(b, "out", ld, "in")
        return ld

    def project(self):
        return P(self.comps, self.wires)


def make(seed, mesh_prob=0.3, open_prob=0.15, step_up_prob=0.2, offnom_prob=0.3, levels=(33.0, 11.0, 0.4)):
    """Three voltage levels, rings, open/closed breakers, off-nominal ratios."""
    g = G(seed)
    r = g.r
    hv = g.bus(levels[0])
    g.utility(hv, levels[0])
    if r.random() < 0.3:
        g.gen(hv, levels[0])
    mv = []
    for _ in range(r.randint(1, 3)):
        b = g.bus(levels[1])
        g.xfmr(hv, b, levels[0], levels[1], step_up=r.random() < step_up_prob,
               off=r.choice([1.0, 1.05]) if r.random() < offnom_prob else 1.0)
        mv.append(b)
    for _ in range(r.randint(1, 4)):
        parent = r.choice(mv)
        b = g.bus(levels[1])
        g.cable(parent, b, levels[1],
                cb_state=("open" if r.random() < open_prob else "closed") if r.random() < 0.5 else None)
        mv.append(b)
    if len(mv) >= 2 and r.random() < mesh_prob:
        a, b = r.sample(mv, 2)
        g.cable(a, b, levels[1], cb_state="closed" if r.random() < 0.5 else None)
    for b in mv:
        x = r.random()
        if x < 0.25:
            g.gen(b, levels[1])
        elif x < 0.6:
            g.motor(b, levels[1])
        if r.random() < 0.3:
            g.load(b, levels[1])
    lv = []
    for _ in range(r.randint(1, 3)):
        parent = r.choice(mv)
        b = g.bus(levels[2])
        g.xfmr(parent, b, levels[1], levels[2], step_up=r.random() < step_up_prob,
               off=r.choice([1.0, 1.05]) if r.random() < offnom_prob else 1.0,
               vg=r.choice(["Dyn11", "Dyn11", "Dyn1", "YNyn0", "Yyn0"]))
        lv.append(b)
    for _ in range(r.randint(0, 4)):
        parent = r.choice(lv)
        b = g.bus(levels[2], db=r.random() < 0.4)
        g.cable(parent, b, levels[2],
                cb_state=("open" if r.random() < open_prob else "closed") if r.random() < 0.5 else None)
        lv.append(b)
    if len(lv) >= 2 and r.random() < mesh_prob:
        a, b = r.sample(lv, 2)
        g.cable(a, b, levels[2])
    for b in lv:
        x = r.random()
        if x < 0.15:
            g.gen(b, levels[2])
        elif x < 0.5:
            g.motor(b, levels[2])
        if r.random() < 0.3:
            g.load(b, levels[2])
    return g.project()


def make2(seed, mf=False):
    """Converters, inverter sources, 2-winding autotransformers, parallel
    transformers with unequal ratios, board chains, step-up gensets."""
    g = G(seed)
    r = g.r
    hv = g.bus(33.0)
    g.utility(hv, 33.0)
    mv = [g.bus(11.0) for _ in range(r.randint(1, 2))]
    for b in mv:
        g.xfmr(hv, b, 33.0, 11.0, vg=r.choice(["Dyn11", "YNd1", "YNyn0"]), off=r.choice([1.0, 1.0, 1.05]))
        if r.random() < 0.4:
            g.xfmr(hv, b, 33.0, 11.0, vg=r.choice(["Dyn11", "YNyn0"]), off=r.choice([1.0, 1.025, 1.05]))
    if r.random() < 0.5:
        b = g.bus(11.0)
        at = g.add(g.id("at"), "autotransformer", windings=2, rated_mva=10, voltage_hv_kv=33.0,
                   voltage_lv_kv=11.0, z_percent=r.choice([4, 8]), x_r_ratio=20)
        g.wire(hv, "out", at, "primary")
        g.wire(at, "secondary", b, "in")
        mv.append(b)
    if r.random() < 0.6:
        gb = g.bus(0.4 if r.random() < 0.5 else 3.3)
        kv = g.comps[-1].props["voltage_kv"]
        g.gen(gb, kv)
        g.xfmr(r.choice(mv), gb, 11.0, kv, step_up=True, vg="YNd1" if kv > 1 else "Dyn11")
    lv = []
    for _ in range(r.randint(1, 3)):
        b = g.bus(0.4)
        g.xfmr(r.choice(mv), b, 11.0, 0.4, vg=r.choice(["Dyn11", "Dyn1"]), off=r.choice([1.0, 1.05]))
        lv.append(b)
    for _ in range(r.randint(0, 3)):
        parent = r.choice(lv)
        d = g.bus(0.4, db=True)
        if not mf:
            g.comps[-1].props["motor_fraction"] = 0
        g.cable(parent, d, 0.4)
        lv.append(d)
    for b in list(lv):
        x = r.random()
        if x < 0.3:
            v = g.add(g.id("vfd"), "vfd", rated_kw=r.choice([55, 200]), efficiency=0.96,
                      front_end=r.choice(["diode", "afe"]), fault_contribution_pu=1.5)
            g.wire(b, "out", v, "in")
            m = g.add(g.id("m"), "motor_induction", rated_kw=200, voltage_kv=0.4, efficiency=0.94,
                      power_factor=0.87, locked_rotor_current=6, x_r_ratio=2.4)
            g.wire(v, "out", m, "in")
        elif x < 0.55:
            u = g.add(g.id("ups"), "ups", rated_kva=r.choice([60, 200]), topology="online_double",
                      static_bypass=r.choice(["yes", "no"]), fault_contribution_pu=2.0)
            ob = g.bus(0.4)
            g.wire(b, "out", u, "ac_in")
            g.wire(u, "ac_out", ob, "in")
            g.load(ob, 0.4)
        elif x < 0.7:
            s = g.add(g.id("pv"), "solar_pv", rated_kw=r.choice([50, 250]), num_inverters=1, voltage_kv=0.4,
                      fault_contribution_pu=1.2)
            g.wire(s, "out", b, "in")
        elif x < 0.8:
            s = g.add(g.id("bess"), "battery", rated_kva=200, fault_contribution_pu=1.1)
            g.wire(s, "out", b, "in")
        if r.random() < 0.4:
            g.motor(b, 0.4)
    if len(lv) >= 2 and r.random() < 0.5:
        a, b = r.sample(lv, 2)
        g.cable(a, b, 0.4)
    for b in mv:
        if r.random() < 0.4:
            g.motor(b, 11.0)
        if r.random() < 0.2:
            g.gen(b, 11.0)
    if r.random() < 0.3:
        w = g.add(g.id("wt"), "wind_turbine", rated_mva=2.0, num_turbines=2,
                  turbine_type=r.choice(["type4_frc", "type3_dfig"]), xd_pp=0.2, x_r_ratio=30)
        g.wire(w, "out", r.choice(mv), "in")
    return g.project()
