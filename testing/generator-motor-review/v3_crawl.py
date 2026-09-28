import sys
sys.path.insert(0, "/work/backend/tests")
from test_dynamic_motor_starting import _project, _motor_props
from backend.analysis.dynamic_motor_starting import run_dynamic_motor_starting
hits=0
for tx in (0.4,0.3,0.25,0.2):
  for lt in (60,80,100,120):
    for model in ("quadratic","linear","constant"):
      for lrt in (80,120,150):
        r=run_dynamic_motor_starting(_project(_motor_props(load_torque_pct=lt,load_torque_model=model,locked_rotor_torque_pct=lrt),fault_mva=500,tx_mva=tx))["motors"][0]
        if r["sim_status"]=="started" and r["final_speed_pct"]<90:
            hits+=1
            if hits<=6: print(f"tx={tx} MVA load={lt}% {model} LRT={lrt}%: status={r['status']} sim={r['sim_status']} final speed={r['final_speed_pct']}% accel={r['accel_time_s']}s thermal={r['thermal_used_pct']}% minVbus={r['min_v_bus_pu']}")
print("cases 'started' below 90 % speed:",hits)
r=run_dynamic_motor_starting(_project(_motor_props(load_torque_pct=120,load_torque_model="linear",locked_rotor_torque_pct=150),fault_mva=500,tx_mva=0.2))["motors"][0]
print("crawl case now:", r["status"], r["sim_status"], r["final_speed_pct"], r["accel_time_s"], r["issues"][0])
