import sys, math, cmath
sys.path.insert(0, "/work/backend/tests")
from test_dynamic_motor_starting import _project, _motor_props, _comp, _wire
from backend.analysis.motor_starting import run_motor_starting
from backend.models.schemas import ProjectData

# --- Hand reference: utility 500 MVA X/R15, 10 MVA 10 % X/R10 transformer, 200 kW DOL
#     constant-Z locked rotor at pf 0.3: V = 1/(1 + Z·Y)
p=_project(_motor_props(locked_rotor_pf=0.3))
r=run_motor_starting(p)["motors"][0]
zs=1/5*cmath.rect(1,math.atan(15))            # 100/500 pu
zt=0.10*100/10*cmath.rect(1,math.atan(10))
zth=zs+zt
flc=200/(math.sqrt(3)*0.4*0.93*0.85); s=math.sqrt(3)*0.4*flc*6/1000/100
S=s*complex(0.3,math.sqrt(1-0.09))
print(f"hand constant-Z V_term={abs(1/(1+zth*S.conjugate())):.4f}  engine={r['motor_terminal_voltage_pu']}")

# --- soft-starter current limit prop ignored
for lim in (2.0,3.5,5.0):
    r=run_motor_starting(_project(_motor_props(starting_method="soft_starter",ss_current_limit_xflc=lim)))["motors"][0]
    print(f"soft starter, ss_current_limit_xflc={lim}: static start current = {r['start_current_a']/flc:.2f}×FLC")

# --- VFD start pf
r=run_motor_starting(_project(_motor_props(starting_method="vfd"),fault_mva=20,tx_mva=0.5))["motors"][0]
print(f"VFD: start I={r['start_current_a']/flc:.2f}×FLC dip={r['max_system_dip_pct']}% start_pf={r.get('start_pf')}")

# --- separate island with its own source: phantom dip
p=_project(_motor_props(rated_kw=150), fault_mva=50, tx_mva=1.0)
p.components += [_comp("u2","utility",{"name":"Grid2","voltage_kv":11.0,"fault_mva":500,"x_r_ratio":15}),
                 _comp("b9","bus",{"name":"Other plant","voltage_kv":11.0}),
                 _comp("l9","static_load",{"name":"L9","rated_kva":500,"power_factor":0.9})]
p.wires += [_wire("x1","u2","b9"),_wire("x2","b9","l9")]
r=run_motor_starting(p)["motors"][0]
print("separate island dips:", r["bus_dips"], r["motor_terminal_voltage_pu"], r["issues"])
# constant-Z locked rotor for the 400 kW case that "collapsed"
flc4=400/(math.sqrt(3)*0.4*0.93*0.85); s4=math.sqrt(3)*0.4*flc4*6/1000/100
zth=100/50*cmath.rect(1,math.atan(15))+0.10*100/1*cmath.rect(1,math.atan(10))
zm=1/(s4*complex(0.3,-math.sqrt(1-0.09)))
r=run_motor_starting(_project(_motor_props(rated_kw=400,locked_rotor_pf=0.3),fault_mva=50,tx_mva=1.0))["motors"][0]
print(f"400 kW on 1 MVA: hand constant-Z V = {abs(zm/(zm+zth)):.4f} pu  engine = {r['motor_terminal_voltage_pu']} collapse={r['collapse']}")
# N3: star-delta against a constant 90 % load — a third of the torque cannot break away
for meth in ("dol","star_delta"):
    r=run_motor_starting(_project(_motor_props(starting_method=meth,load_torque_model="constant",load_torque_pct=90)))["motors"][0]
    print(f"N3 {meth:10s} constant 90% load: V={r['motor_terminal_voltage_pu']} torque_ok={r['torque_ok']} will_start={r['motor_will_start']} {r['issues'][:1]}")
