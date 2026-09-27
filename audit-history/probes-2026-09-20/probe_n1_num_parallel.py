"""N-1 [NEW] — `num_parallel` is dropped for cables on two chain-assembly paths.

loadflow.py:2334-2338 and network_reduction.py:204-206 re-derive the cable
impedance inline to pick up the zone voltage, and omit the `/ num_parallel`
that _get_impedance applies. This is the same bug unbalanced_loadflow.py:346-352
documents as already fixed on its own side.

Expected: V(bus-2) is BIT-IDENTICAL across num_parallel 1/2/4 on the legacy
path, and varies correctly on the exact _kron_reduce_two_port path.
Reproduces the table in Part 3, N-1.
"""
from _net import xfmr_chain
import backend.analysis.loadflow as lf
from backend.analysis import network_reduction as nr

print("N-1  num_parallel dropped\n")

for label, v_lv in (("LEGACY path  (voltage_lv_kv 0.4, t == 1)", 0.4),
                    ("EXACT path   (voltage_lv_kv 0.42, t != 1)", 0.42)):
    print(label)
    seen = []
    for n in (1, 2, 4):
        res = lf.run_load_flow(xfmr_chain(n, voltage_lv_kv=v_lv))
        v = res.buses["bus-2"].voltage_pu
        br = next(b for b in res.branches if b.elementId == "cable-1")
        seen.append(v)
        print(f"   num_parallel={n}:  V(bus-2)={v:.6f}   loading={br.loading_pct:>5.2f}%   I={br.i_amps:.2f} A")
    identical = len(set(round(x, 9) for x in seen)) == 1
    print(f"   -> V identical across 1/2/4: {identical}"
          f"  {'<-- DEFECT' if identical else '(correct: parallel divide applied)'}\n")

print("network_reduction.build_port_zbus  (no exact-path alternative: always affected)")
seen = []
for n in (1, 2, 4):
    z = nr.build_port_zbus(xfmr_chain(n, voltage_lv_kv=0.42, with_load=False), ["bus-2"])["Z"][0, 0]
    seen.append(z)
    print(f"   num_parallel={n}:  Zth(bus-2) = {z:.5f} pu")
print(f"   -> Zth identical across 1/2/4: {len(set(str(z) for z in seen)) == 1}  <-- DEFECT")
print("\n   Note loading_pct is NOT affected (it uses rated_amps * num_parallel),")
print("   so the UI shows a comfortably loaded cable beside an inflated voltage drop.")
