"""R-1 — the F-1 defect is copy-pasted into 4 modules, not confined to loadflow.

Contradicts CALC_AUDIT_2026-09-20.md F-2 ("network_reduction.py ... unaffected",
"the affected path is narrow"). Reproduces the block in Part 2, R-1.

build_branch_ybus  is imported by transient_stability.py:137
build_port_zbus    is imported by dynamic_motor_starting.py:59
so a stale cable prop reaches both of those engines too.
"""
from _net import lv_cable_only
from backend.analysis import network_reduction as nr
from backend.analysis import unbalanced_loadflow as ul

print("R-1  same defect, four modules\n")

print("network_reduction.build_branch_ybus  (network_reduction.py:210)")
for v in (11, 0.4):
    ctx = nr.build_branch_ybus(lv_cable_only(v))
    bi = ctx["bus_idx"]
    z = -1 / ctx["Y"][bi["bus-1"], bi["bus-2"]]
    print(f"   cable voltage_kv={v:<5} chain Z = {z:.5f} pu")

print("\nnetwork_reduction.build_port_zbus   (Thevenin seen by dynamic motor starting)")
for v in (11, 0.4):
    z = nr.build_port_zbus(lv_cable_only(v), ["bus-2"])["Z"][0, 0]
    print(f"   cable voltage_kv={v:<5} Zth(bus-2) = {z:.5f} pu")

print("\nunbalanced_loadflow                 (unbalanced_loadflow.py:365-375)")
for v in (11, 0.4):
    res = ul.run_unbalanced_load_flow(lv_cable_only(v))
    buses = res.buses.values() if hasattr(res.buses, "values") else res.buses
    for b in buses:
        if getattr(b, "bus_id", None) == "bus-2":
            print(f"   cable voltage_kv={v:<5} Va(bus-2) = {b.va_pu:.6f} pu")

print("\nharmonics.py:274 is a code-read finding: `v_kv = e.props.get(\"voltage_kv\", va) or va`")
print("   falls back to the bus voltage ONLY when the prop is absent/zero;")
print("   a present default of 11 still wins. No probe needed.")
