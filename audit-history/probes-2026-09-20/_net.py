"""Shared synthetic networks for the CALC_AUDIT_REVIEW_2026-09-20 probes.

No customer data — every network here is hand-built from scratch.
"""
import sys, os

# Allow running as `python audit-history/probes-2026-09-20/<probe>.py` from the
# repo root, or from inside the backend Docker image with the repo at /work.
_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from backend.models.schemas import ProjectData  # noqa: E402


def lv_cable_only(cable_vkv, bus_kv=0.4, length_km=0.05, r=0.3, x=0.08):
    """utility(0.4 kV, infinite) → bus → cable → bus → load.

    `cable_vkv` is the cable's own `voltage_kv` prop: 11 reproduces the stale
    palette default, `bus_kv` the value the zone should impose.
    """
    comps = [
        {"id": "utility-1", "type": "utility", "x": 0, "y": 0,
         "props": {"name": "U", "voltage_kv": bus_kv, "fault_mva": 500, "x_r_ratio": 10}},
        {"id": "bus-1", "type": "bus", "x": 0, "y": 100,
         "props": {"name": "B1", "voltage_kv": bus_kv}},
        {"id": "cable-1", "type": "cable", "x": 0, "y": 200,
         "props": {"name": "C1", "length_km": length_km, "r_per_km": r, "x_per_km": x,
                   "voltage_kv": cable_vkv, "rated_amps": 400}},
        {"id": "bus-2", "type": "bus", "x": 0, "y": 300,
         "props": {"name": "B2", "voltage_kv": bus_kv}},
        {"id": "load-1", "type": "static_load", "x": 0, "y": 400,
         "props": {"name": "L", "rated_kva": 50, "power_factor": 0.9, "demand_factor": 1.0}},
    ]
    wires = [
        {"id": "w1", "fromComponent": "utility-1", "fromPort": "out", "toComponent": "bus-1", "toPort": "in"},
        {"id": "w2", "fromComponent": "bus-1", "fromPort": "out", "toComponent": "cable-1", "toPort": "from"},
        {"id": "w3", "fromComponent": "cable-1", "fromPort": "to", "toComponent": "bus-2", "toPort": "in"},
        {"id": "w4", "fromComponent": "bus-2", "fromPort": "out", "toComponent": "load-1", "toPort": "in"},
    ]
    return ProjectData(projectName="probe", baseMVA=100, frequency=50,
                       components=comps, wires=wires)


def xfmr_chain(num_parallel, voltage_lv_kv=0.4, with_load=True):
    """11 kV utility → bus → 1 MVA 11/0.4 transformer → cable → bus (→ load).

    `voltage_lv_kv` selects the code path under test:
      0.4  → chain turns ratio t == 1 → LEGACY z_total sum  (loadflow.py:2323-2339)
      0.42 → t != 1                   → EXACT _kron_reduce_two_port path
    """
    comps = [
        {"id": "utility-1", "type": "utility", "x": 0, "y": 0,
         "props": {"name": "U", "voltage_kv": 11, "fault_mva": 500, "x_r_ratio": 10}},
        {"id": "bus-1", "type": "bus", "x": 0, "y": 100,
         "props": {"name": "B1", "voltage_kv": 11}},
        {"id": "transformer-1", "type": "transformer", "x": 0, "y": 150,
         "props": {"name": "T", "rated_mva": 1.0, "z_percent": 5, "x_r_ratio": 10,
                   "voltage_hv_kv": 11, "voltage_lv_kv": voltage_lv_kv,
                   "tap_position": 0, "tap_step_pct": 2.5, "vector_group": "Dyn11"}},
        {"id": "cable-1", "type": "cable", "x": 0, "y": 200,
         "props": {"name": "C1", "length_km": 0.1, "r_per_km": 0.3, "x_per_km": 0.08,
                   "voltage_kv": 0.4, "rated_amps": 400, "num_parallel": num_parallel}},
        {"id": "bus-2", "type": "bus", "x": 0, "y": 300,
         "props": {"name": "B2", "voltage_kv": 0.4}},
    ]
    wires = [
        {"id": "w1", "fromComponent": "utility-1", "fromPort": "out", "toComponent": "bus-1", "toPort": "in"},
        {"id": "w2", "fromComponent": "bus-1", "fromPort": "out", "toComponent": "transformer-1", "toPort": "primary"},
        {"id": "w3", "fromComponent": "transformer-1", "fromPort": "secondary", "toComponent": "cable-1", "toPort": "from"},
        {"id": "w4", "fromComponent": "cable-1", "fromPort": "to", "toComponent": "bus-2", "toPort": "in"},
    ]
    if with_load:
        comps.append({"id": "load-1", "type": "static_load", "x": 0, "y": 400,
                      "props": {"name": "L", "rated_kva": 100, "power_factor": 0.9,
                                "demand_factor": 1.0}})
        wires.append({"id": "w5", "fromComponent": "bus-2", "fromPort": "out",
                      "toComponent": "load-1", "toPort": "in"})
    return ProjectData(projectName="probe", baseMVA=100, frequency=50,
                       components=comps, wires=wires)
