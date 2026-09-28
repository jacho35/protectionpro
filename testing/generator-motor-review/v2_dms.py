import sys, math, copy
sys.path.insert(0, "/work/backend/tests")
from test_dynamic_motor_starting import _project, _motor_props, _comp, _wire
from backend.analysis.dynamic_motor_starting import run_dynamic_motor_starting, _fit_motor_model, _rated_slip
from backend.analysis.dynamic_motor_starting import _load_torque_fn

# --- B. running motor double-counted: weak supply, one motor RUNNING only
p=_project(_motor_props(dyn_role="running"), fault_mva=50.0, tx_mva=1.0)
r=run_dynamic_motor_starting(p)["motors"][0]
print(f"B. running motor only (nothing starts): V_pre={r['v_prestart_pu']}  min V_bus={r['min_v_bus_pu']}  'dip'={r['max_bus_dip_pct']}%")

# --- C. star-delta thermal and spurious <0.8 warning
for meth in ("dol","star_delta","autotransformer"):
    r=run_dynamic_motor_starting(_project(_motor_props(starting_method=meth, load_torque_pct=30)))["motors"][0]
    print(f"C. {meth:15s} status={r['status']:8s} accel={r['accel_time_s']} thermal={r['thermal_used_pct']}% minVbus={r['min_v_bus_pu']} minVmotor={r['min_v_motor_pu']} issues={r['issues']}")
    if meth=="star_delta":
        rsd=r
# recompute star-delta winding-current I²t from the curves (winding I = √3 × line I while in star)
c=rsd["curves"]; tr=rsd["transition"]["t_s"]
t=c["t"]; i=c["current_xflc"]
wl=wl3=0.0
for k in range(1,len(t)):
    dt=t[k]-t[k-1]; ik=i[k-1]
    wl+=ik*ik*dt; wl3+=(3 if t[k-1]<tr else 1)*ik*ik*dt
cap=36*15
print(f"   star-delta I²t from line current {wl/cap*100:.1f}%  vs winding-current basis {wl3/cap*100:.1f}% (decimated curves)")

# --- D. motor nameplate voltage ≠ bus voltage: 415 V motor on a 400 V bus
for vk in (0.4, 0.415, 0.38):
    r=run_dynamic_motor_starting(_project(_motor_props(voltage_kv=vk)))["motors"][0]
    print(f"D. motor {vk*1000:.0f} V on 400 V bus: accel={r['accel_time_s']} s peak={r['peak_current_xflc']}xFLC  te(0)={r['curves']['te_pu'][0]}")
