"""Engine vs ref60909 on random networks.

    python testing/fault-cold-review/fuzz.py [N]

Sets: 'base' (3 voltage levels, rings, open breakers, off-nominal ratios),
'mesh' (heavily meshed, step-up units, no motor fractions), 'conv'
(converters, inverters, autotransformers, parallel transformers with unequal
ratios, board chains), 'seq' (Z2 ≠ Z1, generator X2 / X0, engine's no-K_G
convention so only structure is compared). Every disagreement > 0.1 % is
printed. At the review date all of them traced to findings F02 and F10."""
import contextlib
import io
import random
import sys
from common import compare
import randnet

N = int(sys.argv[1]) if len(sys.argv) > 1 else 100


def run(name, make, opts=None):
    bad = []
    for seed in range(N):
        p = make(seed)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            try:
                w = compare(p, 1.1, f"{name} seed {seed}", tol=0.1, opts=opts)
            except Exception as e:     # noqa: BLE001
                print("ERROR", repr(e)); w = None
        if w is None or w > 0.1:
            bad.append(buf.getvalue())
    print(f"{name}: {N} networks, {len(bad)} with a difference > 0.1 %")
    for txt in bad[:10]:
        print(txt.rstrip()[:900])


def mesh(seed):
    p = randnet.make(seed + 1000, mesh_prob=0.9, open_prob=0.1, step_up_prob=0.4, offnom_prob=0.6)
    for c in p.components:
        if c.type in ("static_load", "distribution_board"):
            c.props["motor_fraction"] = 0
    return p


def seq(seed):
    p = randnet.make(seed + 3000, mesh_prob=0.5)
    r = random.Random(seed)
    for c in p.components:
        if c.type == "utility":
            c.props["z2_z1_ratio"] = r.choice([0.8, 1.0, 1.3])
        if c.type == "generator":
            c.props["x2"] = r.choice([0, 0.12, 0.18]); c.props["x0"] = r.choice([0, 0.05, 0.08])
        if c.type in ("static_load", "distribution_board"):
            c.props["motor_fraction"] = 0
    return p


run("base", randnet.make)
run("mesh", mesh)
run("conv", randnet.make2)
run("seq", seq, {"engine_x2x0": True})
