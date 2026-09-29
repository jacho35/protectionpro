"""Build the representative gG pre-arcing table from the IEC 60269-1 Table 3
gates (TC1). Prints rows for constants.js FUSE_CURVES_GG and arcflash.py
_FUSE_CURVES_GG (kept verbatim-identical).

Construction per rating In (all log-log straight segments between points):
  1.6·In  -> 600 s   conventional fusing current If (IEC 60269-1 Table 2) —
                     melts well inside the conventional time
  sqrt(Imin(10 s)·Imax(5 s))   -> sqrt(10·5) = 7.07 s   mid 10 s/5 s gate
  sqrt(Imin(0.1 s)·Imax(0.1 s)) -> 0.1 s                mid 0.1 s gate
  1.25x, 2x, 3.125x that current -> 0.04, 0.01, 0.004 s — the previous
                     table's tail shape (steeper than I²t = const until the
                     pre-arcing becomes adiabatic near 10 ms). Extrapolating
                     I²t = const from the 0.1 s gate overstated the melting
                     I²t 3-4x (400 A at 10 kA: 36 ms vs ~10 ms for real links).
The resulting pre-arcing I²t at 0.01 s lies inside the IEC 60269-1 Table 7
corridor (minimum pre-arcing .. maximum operating I²t) for every rating —
see I2T_001 and check() below.
Currents are rounded to 3 significant figures.
"""
import math

GATES = {16: (33, 65, 85, 150), 20: (42, 85, 110, 200), 25: (52, 110, 150, 260),
         32: (75, 150, 200, 350), 40: (95, 190, 260, 450), 50: (125, 250, 350, 610),
         63: (160, 320, 450, 820), 80: (215, 425, 610, 1100), 100: (290, 580, 820, 1450),
         125: (355, 715, 1100, 1910), 160: (460, 950, 1450, 2590), 200: (610, 1250, 1910, 3420),
         250: (750, 1650, 2590, 4500), 315: (1050, 2200, 3420, 6000),
         400: (1420, 2840, 4500, 8060), 500: (1780, 3800, 6000, 10600),
         630: (2200, 5100, 8060, 14140)}


# IEC 60269-1 Table 7 (gG): (minimum pre-arcing I²t, maximum operating I²t)
# at 0.01 s, A²s — from a published reproduction; confirm against a licensed
# copy before tightening anything on it.
I2T_001 = {16: (0.3e3, 1.0e3), 20: (0.5e3, 1.8e3), 25: (1.0e3, 3.0e3),
           32: (1.8e3, 5.0e3), 40: (3.0e3, 9.0e3), 50: (5.0e3, 16e3),
           63: (9.0e3, 27e3), 80: (16e3, 46e3), 100: (27e3, 86e3),
           125: (46e3, 140e3), 160: (86e3, 250e3), 200: (140e3, 400e3),
           250: (250e3, 760e3), 315: (400e3, 1300e3), 400: (760e3, 2250e3),
           500: (1300e3, 3800e3), 630: (2250e3, 7500e3)}


def check():
    for inr, (lo, hi) in I2T_001.items():
        i = next(i for i, t in curve(inr) if t == 0.01)
        i2t = i * i * 0.01
        print(f"  {inr:4d} A: I²t(0.01 s) = {i2t:10.3g}  corridor {lo:.3g}..{hi:.3g}  "
              f"{'ok' if lo <= i2t <= hi else 'OUT'}")


def r3(x):
    return float(f"{x:.3g}")


def curve(inr):
    i10, i5, i01a, i01b = GATES[inr]
    i7 = math.sqrt(i10 * i5)
    i01 = math.sqrt(i01a * i01b)
    pts = [(1.6 * inr, 600), (i7, 7.07), (i01, 0.1),
           (1.25 * i01, 0.04), (2 * i01, 0.01), (3.125 * i01, 0.004)]
    return [(r3(i), t) for i, t in pts]


def fmt(v):
    return f"{v:g}"


if __name__ == "__main__":
    import sys
    if "--check" in sys.argv:
        check()
        raise SystemExit
    for inr in GATES:
        row = ",".join(f"[{fmt(i)},{fmt(t)}]" for i, t in curve(inr))
        print(f"  {inr}: [{row}],")
