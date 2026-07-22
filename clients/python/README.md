# ProtectionPro Python client

Scripted access to the ProtectionPro REST API for batch and parametric
studies — the ProtectionPro equivalent of `etapPy` / PowerFactory's Python
API / `psspy`, built on the fact that every analysis endpoint is already
stateless JSON-in/JSON-out.

## Install

```bash
pip install ./clients/python          # from the repo
# or copy protectionpro_client.py next to your script — it is a single file
# depending only on httpx.
```

## Quickstart

```python
from protectionpro_client import ProtectionPro

pp = ProtectionPro("http://localhost:8000")
pp.login("you@example.com", "your-password")

# Load a saved project (the full ProjectData dict the frontend uses)
project = pp.project(1)

# Run analyses — results are plain dicts matching the API schemas
lf = pp.loadflow(project)
print(lf["converged"],
      min(b["voltage_pu"] for b in lf["buses"].values() if b["energized"]))

fault = pp.fault(project, fault_type="3phase")
scan = pp.frequency_scan(project, h_max=25)
if scan["resonances"]:
    r = scan["resonances"][0]
    print(f"resonance: {r['f_hz']} Hz at {r['bus_name']}")
```

Auth is a JWT bearer: `login()` stores it on the client; you can also pass
`token=` directly, or `register()` the first user on a fresh database.

## Parametric sweep example

Sweep a feeder length and record the receiving-bus voltage — the pattern
generalises to any prop / any engine:

```python
import copy

pp = ProtectionPro("http://localhost:8000")
pp.login("you@example.com", "your-password")
base = pp.project(1)

def set_prop(project, comp_id, key, value):
    p = copy.deepcopy(project)
    for c in p["components"]:
        if c["id"] == comp_id:
            c["props"][key] = value
            return p
    raise KeyError(comp_id)

for km in [0.5, 1.0, 2.0, 4.0, 8.0]:
    lf = pp.loadflow(set_prop(base, "cable-1", "length_km", km))
    v = lf["buses"]["bus-2"]["voltage_pu"]
    print(f"{km:4.1f} km → {v:.4f} pu")
```

## API surface

| Method | Endpoint | Engine |
|---|---|---|
| `fault(p, fault_bus_id=, fault_type=, voltage_factor=, conductor_temperature_c=)` | `/api/analysis/fault` | IEC 60909 short circuit |
| `loadflow(p, method=)` | `/api/analysis/loadflow` | NR / Gauss-Seidel power flow |
| `unbalanced_loadflow(p)` | `/api/analysis/unbalanced-loadflow` | 3-phase asymmetric |
| `voltage_stability(p, qv_bus_id=, step=, lambda_max=, v_floor=)` | `/api/analysis/voltage-stability` | P-V / Q-V continuation |
| `contingency(p, include_n2=, v_min=, v_max=, loading_limit_pct=, max_contingencies=)` | `/api/analysis/contingency` | N-1 / N-2 screening |
| `harmonics(p)` | `/api/analysis/harmonics` | IEEE 519 penetration |
| `frequency_scan(p, scan_bus_ids=, h_max=, h_step=)` | `/api/analysis/frequency-scan` | Z(f) resonance scan |
| `arc_flash(p)` | `/api/analysis/arcflash` | IEEE 1584-2002 |
| `cable_sizing(p)` | `/api/analysis/cable-sizing` | IEC 60364 |
| `motor_starting(p)` / `dynamic_motor_starting(p)` | `/api/analysis/motor-starting`, `…/dynamic-motor-starting` | Voltage dip / time-domain accel |
| `transient_stability(p, disturbance=)` | `/api/analysis/transient-stability` | Rotor-angle simulation |
| `duty_check(p)` / `load_diversity(p)` / `grounding(p)` | respective endpoints | Duty / ADMD / IEEE 80 |
| `dc_loadflow(p)` / `dc_shortcircuit(p)` | `/api/analysis/dc-*` | DC networks (IEC 61660) |
| `study_manager(p, **opts)` | `/api/analysis/study-manager` | Batch runner |
| `analyze(kind, p, **params)` | `/api/analysis/{kind}` | Escape hatch for anything new |

Projects: `projects()`, `project(id)`, `save_project(p)`, `update_project(id, p)`,
`delete_project(id)`, `export_json(id)`, `export_csv(id)`.

Errors raise `ProtectionProError` with `.status_code` and the backend `detail`.

## In-process testing (no server)

`fastapi.testclient.TestClient` is an `httpx.Client`, so the whole client can
run against the app directly:

```python
from fastapi.testclient import TestClient
from backend.main import app
from protectionpro_client import ProtectionPro

pp = ProtectionPro(http=TestClient(app))
pp.register("ci@test.local", "password123")   # first user on a fresh DB
```

This is exactly how `backend/tests/test_python_client.py` exercises it.
