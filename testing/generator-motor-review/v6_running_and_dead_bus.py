"""[N5] Running motors are dynamic (null disturbance exact, they slow during
another start); a motor on a de-energised bus is not simulated."""
import sys
sys.path.insert(0, "/work/backend/tests")
from test_dynamic_motor_starting import _project, _motor_props, _comp, _wire
from backend.analysis.dynamic_motor_starting import run_dynamic_motor_starting

r = run_dynamic_motor_starting(_project(_motor_props(dyn_role="running"), fault_mva=50.0, tx_mva=1.0))["motors"][0]
print(f"running only: speed {r['curves']['speed_pct'][0]}→{r['final_speed_pct']} %  dip {r['max_bus_dip_pct']} %  status {r['status']}")

p = _project(_motor_props(dyn_role="running", name="RUN"), fault_mva=50.0, tx_mva=1.0)
p.components.append(_comp("m2", "motor_induction", _motor_props(name="BIG", rated_kw=250.0)))
p.wires.append(_wire("w5", "bus-2", "m2"))
res = run_dynamic_motor_starting(p)["motors"]
run = next(m for m in res if m["motor_name"] == "RUN")
big = next(m for m in res if m["motor_name"] == "BIG")
print(f"with BIG starting: RUN min speed {min(run['curves']['speed_pct'])} % (started at {run['curves']['speed_pct'][0]}), status {run['status']}; BIG {big['sim_status']} {big['accel_time_s']} s")

p = _project(_motor_props())
for c in p.components:
    if c.type == "transformer":
        pass
p.components.append(_comp("cb", "cb", {"name": "CB", "state": "open"}))
p.wires = [w for w in p.wires if not (w.fromComponent == "bus-1" and w.toComponent == "transformer-1")]
p.wires += [_wire("wa", "bus-1", "cb"), _wire("wb", "cb", "transformer-1")]
out = run_dynamic_motor_starting(p)
print("dead bus:", [m.get("sim_status") for m in out["motors"]], [w for w in out["warnings"] if "de-energised" in w])
