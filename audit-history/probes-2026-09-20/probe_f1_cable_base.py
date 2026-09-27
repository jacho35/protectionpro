"""F-1 — cable-only chains use the cable's own `voltage_kv` prop as the pu base.

Reproduces the table in CALC_AUDIT_REVIEW_2026-09-20.md, Part 1, F-1.
Expected: the 11 kV (stale default) row understates the drop ~735x and the
current ~27.8x versus the 0.4 kV (correct zone) row.
"""
import math
from _net import lv_cable_only
from backend.analysis.loadflow import run_load_flow

print("F-1  loadflow.py:2343 -> _get_impedance (loadflow.py:1654-1660)")
print(f"{'cable voltage_kv':>17} | {'V(bus-2) pu':>12} | {'I (A)':>8} | {'loading %':>9} | {'losses MW':>10}")
print("-" * 70)
rows = {}
for vkv in (11, 0.4):
    res = run_load_flow(lv_cable_only(vkv))
    assert res.converged, "load flow did not converge"
    v = res.buses["bus-2"].voltage_pu
    br = next(b for b in res.branches if b.elementId == "cable-1")
    rows[vkv] = (v, br.i_amps, br.losses_mw)
    print(f"{vkv:>17} | {v:>12.6f} | {br.i_amps:>8.2f} | {br.loading_pct:>9.2f} | {br.losses_mw:>10.6f}")

drop_stale = 1 - rows[11][0]
drop_true = 1 - rows[0.4][0]
print(f"\nvoltage-drop understated : {drop_true / drop_stale:>8.1f}x")
print(f"current understated      : {rows[0.4][1] / rows[11][1]:>8.1f}x   (11/0.4 = {11/0.4:.1f})")
print(f"pu-impedance error       : {(11/0.4)**2:>8.1f}x   (the (11/0.4)^2 figure fault.py:1252 names)")

zb = 0.4 ** 2 / 100
print(f"\nhand check: z_pu on the 0.4 kV base = {complex(0.3*0.05, 0.08*0.05)/zb}")
