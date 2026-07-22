"""ProtectionPro Python client — scripted access to the REST API.

A thin, dependency-light (httpx only) wrapper over the ProtectionPro backend
for batch and parametric studies: authenticate, load/save projects, and run
any analysis engine on a ProjectData dict, getting plain dicts back.

Quickstart::

    from protectionpro_client import ProtectionPro

    pp = ProtectionPro("http://localhost:8000")
    pp.login("you@example.com", "your-password")

    project = pp.project(1)                # full ProjectData dict
    lf = pp.loadflow(project)
    print(lf["converged"], min(b["voltage_pu"] for b in lf["buses"].values()))

Every analysis method takes the full ProjectData dict (the same JSON the
frontend sends / the project endpoints return) and returns the engine's
result dict. Study options are keyword arguments merged into the payload —
they mirror the backend request models exactly.

For in-process testing, pass any httpx.Client-compatible object (e.g.
``fastapi.testclient.TestClient(app)``) as ``http=`` — no server needed.
"""

from __future__ import annotations

from typing import Any, Optional

import httpx

__version__ = "0.1.0"
__all__ = ["ProtectionPro", "ProtectionProError"]


class ProtectionProError(RuntimeError):
    """API error: carries the HTTP status code and the backend detail."""

    def __init__(self, status_code: int, detail: str):
        super().__init__(f"HTTP {status_code}: {detail}")
        self.status_code = status_code
        self.detail = detail


class ProtectionPro:
    """Client for one ProtectionPro backend.

    Args:
        base_url: backend root, e.g. ``http://localhost:8000``.
        token: existing JWT bearer token (else call :meth:`login`).
        timeout: per-request timeout in seconds (analyses can be slow).
        http: optional httpx.Client-compatible object to use instead of a new
            ``httpx.Client`` — pass ``fastapi.testclient.TestClient(app)`` to
            drive the API in-process.
    """

    def __init__(self, base_url: str = "http://localhost:8000", *,
                 token: Optional[str] = None, timeout: float = 300.0,
                 http: Optional[httpx.Client] = None):
        self.token = token
        self._http = http or httpx.Client(base_url=base_url.rstrip("/"),
                                          timeout=timeout)

    # ── plumbing ─────────────────────────────────────────────────────

    def _req(self, method: str, path: str, *, json: Any = None,
             expect_json: bool = True) -> Any:
        headers = {}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        resp = self._http.request(method, path, json=json, headers=headers)
        if resp.status_code >= 400:
            try:
                detail = resp.json().get("detail", resp.text)
            except Exception:
                detail = resp.text
            raise ProtectionProError(resp.status_code, str(detail))
        return resp.json() if expect_json else resp

    def close(self):
        self._http.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    # ── auth ─────────────────────────────────────────────────────────

    def register(self, email: str, password: str, name: str = "",
                 invite_code: Optional[str] = None) -> dict:
        """Create a user (first user needs no invite) and store its token."""
        body = {"email": email, "password": password, "name": name}
        if invite_code:
            body["invite_code"] = invite_code
        out = self._req("POST", "/api/auth/register", json=body)
        self.token = out["access_token"]
        return out["user"]

    def login(self, email: str, password: str) -> dict:
        """Log in and store the JWT for subsequent calls."""
        out = self._req("POST", "/api/auth/login",
                        json={"email": email, "password": password})
        self.token = out["access_token"]
        return out["user"]

    def me(self) -> dict:
        return self._req("GET", "/api/auth/me")

    # ── projects ─────────────────────────────────────────────────────

    def projects(self) -> list[dict]:
        """List project summaries (id, name, timestamps, access)."""
        return self._req("GET", "/api/projects")

    def project(self, project_id: int) -> dict:
        """Fetch one project's full ProjectData dict."""
        return self._req("GET", f"/api/projects/{project_id}")

    def save_project(self, project: dict) -> dict:
        """Create a project from a ProjectData dict → {"id", "name"}."""
        return self._req("POST", "/api/projects", json=project)

    def update_project(self, project_id: int, project: dict) -> dict:
        return self._req("PUT", f"/api/projects/{project_id}", json=project)

    def delete_project(self, project_id: int) -> dict:
        return self._req("DELETE", f"/api/projects/{project_id}")

    def export_json(self, project_id: int) -> dict:
        return self._req("GET", f"/api/projects/{project_id}/export/json")

    def export_csv(self, project_id: int) -> str:
        resp = self._req("GET", f"/api/projects/{project_id}/export/csv",
                         expect_json=False)
        return resp.text

    # ── analyses ─────────────────────────────────────────────────────
    #
    # All analysis endpoints accept the full ProjectData JSON; study options
    # are extra top-level fields (the request models extend ProjectData).

    def analyze(self, kind: str, project: dict, **params) -> dict:
        """Run any analysis by endpoint name, e.g. ``analyze("fault", p)``.

        ``kind`` is the path segment after ``/api/analysis/`` with ``_``
        accepted for ``-`` (``dynamic_motor_starting`` →
        ``dynamic-motor-starting``). ``params`` are merged into the payload.
        """
        payload = {**project, **{k: v for k, v in params.items()
                                 if v is not None}}
        return self._req("POST", f"/api/analysis/{kind.replace('_', '-')}",
                         json=payload)

    def fault(self, project: dict, *, fault_bus_id: Optional[str] = None,
              fault_type: Optional[str] = None,
              voltage_factor: Optional[float] = None,
              conductor_temperature_c: Optional[float] = None) -> dict:
        """IEC 60909 short circuit (3ph/SLG/LL/LLG)."""
        return self.analyze("fault", project, faultBusId=fault_bus_id,
                            faultType=fault_type, voltageFactor=voltage_factor,
                            conductorTemperatureC=conductor_temperature_c)

    def loadflow(self, project: dict, *,
                 method: Optional[str] = None) -> dict:
        """Newton-Raphson (default) or Gauss-Seidel power flow."""
        return self.analyze("loadflow", project, loadFlowMethod=method)

    def unbalanced_loadflow(self, project: dict) -> dict:
        return self.analyze("unbalanced-loadflow", project)

    def voltage_stability(self, project: dict, *,
                          qv_bus_id: Optional[str] = None,
                          step: Optional[float] = None,
                          lambda_max: Optional[float] = None,
                          v_floor: Optional[float] = None) -> dict:
        """P-V loadability continuation + Q-V reactive margin."""
        return self.analyze("voltage-stability", project, qv_bus_id=qv_bus_id,
                            step=step, lambda_max=lambda_max, v_floor=v_floor)

    def contingency(self, project: dict, *, include_n2: bool = False,
                    v_min: Optional[float] = None,
                    v_max: Optional[float] = None,
                    loading_limit_pct: Optional[float] = None,
                    max_contingencies: Optional[int] = None) -> dict:
        """N-1 (optionally N-2) security screening."""
        return self.analyze("contingency", project, include_n2=include_n2,
                            v_min=v_min, v_max=v_max,
                            loading_limit_pct=loading_limit_pct,
                            max_contingencies=max_contingencies)

    def harmonics(self, project: dict) -> dict:
        """IEEE 519 harmonic penetration (VFD current sources)."""
        return self.analyze("harmonics", project)

    def frequency_scan(self, project: dict, *,
                       scan_bus_ids: Optional[list[str]] = None,
                       h_max: Optional[float] = None,
                       h_step: Optional[float] = None) -> dict:
        """Driving-point impedance vs frequency (resonance identification)."""
        return self.analyze("frequency-scan", project,
                            scan_bus_ids=scan_bus_ids, h_max=h_max,
                            h_step=h_step)

    def arc_flash(self, project: dict) -> dict:
        """IEEE 1584-2002 arc flash incident energy."""
        return self.analyze("arcflash", project)

    def cable_sizing(self, project: dict) -> dict:
        """IEC 60364 cable sizing checks."""
        return self.analyze("cable-sizing", project)

    def motor_starting(self, project: dict) -> dict:
        """Static (voltage-dip) motor starting."""
        return self.analyze("motor-starting", project)

    def dynamic_motor_starting(self, project: dict) -> dict:
        """Time-domain motor acceleration (swing equation)."""
        return self.analyze("dynamic-motor-starting", project)

    def transient_stability(self, project: dict, *,
                            disturbance: Optional[dict] = None) -> dict:
        """Multi-machine rotor-angle simulation (fault/trip/load step)."""
        return self.analyze("transient-stability", project,
                            stabilityDisturbance=disturbance)

    def duty_check(self, project: dict) -> dict:
        """Equipment fault-current duty verification."""
        return self.analyze("duty-check", project)

    def load_diversity(self, project: dict) -> dict:
        return self.analyze("load-diversity", project)

    def grounding(self, project: dict) -> dict:
        """IEEE 80 grounding grid design."""
        return self.analyze("grounding", project)

    def dc_loadflow(self, project: dict) -> dict:
        return self.analyze("dc-loadflow", project)

    def dc_shortcircuit(self, project: dict) -> dict:
        """IEC 61660 DC short circuit."""
        return self.analyze("dc-shortcircuit", project)

    def filter_sizing(self, project: dict, *,
                      filter_bus_id: Optional[str] = None,
                      total_kvar: Optional[float] = None,
                      quality_factor: Optional[float] = None,
                      max_branches: Optional[int] = None) -> dict:
        """Passive harmonic filter sizing to meet IEEE 519."""
        return self.analyze("filter-sizing", project,
                            filter_bus_id=filter_bus_id,
                            total_kvar=total_kvar,
                            quality_factor=quality_factor,
                            max_branches=max_branches)

    def capacitor_placement(self, project: dict, *,
                            candidate_bus_ids: Optional[list[str]] = None,
                            unit_kvar: Optional[float] = None,
                            max_kvar_per_bus: Optional[float] = None,
                            max_total_kvar: Optional[float] = None,
                            v_min: Optional[float] = None,
                            v_max: Optional[float] = None) -> dict:
        """Optimal capacitor placement (greedy loss-sensitivity)."""
        return self.analyze("capacitor-placement", project,
                            candidate_bus_ids=candidate_bus_ids,
                            unit_kvar=unit_kvar,
                            max_kvar_per_bus=max_kvar_per_bus,
                            max_total_kvar=max_total_kvar,
                            v_min=v_min, v_max=v_max)

    def reliability(self, project: dict) -> dict:
        """SAIDI/SAIFI/MAIFI reliability assessment (IEEE 1366 FMEA)."""
        return self.analyze("reliability", project)

    def flicker(self, project: dict, *, pst_limit: Optional[float] = None,
               plt_limit: Optional[float] = None,
               d_anchor_pct: Optional[float] = None,
               exponent: Optional[float] = None) -> dict:
        """Voltage flicker screening (IEC 61000-3-3 / IEC 61000-4-15)."""
        return self.analyze("flicker", project, pst_limit=pst_limit,
                            plt_limit=plt_limit, d_anchor_pct=d_anchor_pct,
                            exponent=exponent)

    def hosting_capacity(self, project: dict, *,
                         candidate_bus_ids: Optional[list[str]] = None,
                         hc_power_factor: Optional[float] = None,
                         v_min: Optional[float] = None,
                         v_max: Optional[float] = None,
                         loading_limit_pct: Optional[float] = None,
                         step_mw: Optional[float] = None,
                         max_mw_per_bus: Optional[float] = None) -> dict:
        """Nodal hosting capacity — max DER interconnection per bus."""
        return self.analyze("hosting-capacity", project,
                            candidate_bus_ids=candidate_bus_ids,
                            hc_power_factor=hc_power_factor,
                            v_min=v_min, v_max=v_max,
                            loading_limit_pct=loading_limit_pct,
                            step_mw=step_mw, max_mw_per_bus=max_mw_per_bus)

    def opf(self, project: dict, *, objective: Optional[str] = None,
            v_min: Optional[float] = None, v_max: Optional[float] = None,
            loading_limit_pct: Optional[float] = None,
            use_dispatch: Optional[bool] = None,
            use_capacitors: Optional[bool] = None,
            use_taps: Optional[bool] = None,
            use_setpoints: Optional[bool] = None,
            max_moves: Optional[int] = None) -> dict:
        """Optimal power flow — economic dispatch + Volt/VAR optimization."""
        return self.analyze("opf", project, objective=objective, v_min=v_min,
                            v_max=v_max, loading_limit_pct=loading_limit_pct,
                            use_dispatch=use_dispatch,
                            use_capacitors=use_capacitors, use_taps=use_taps,
                            use_setpoints=use_setpoints, max_moves=max_moves)

    def battery_sizing(self, project: dict, *,
                       battery_id: Optional[str] = None,
                       duty_cycle: Optional[list[dict]] = None,
                       aging_factor: Optional[float] = None,
                       design_margin: Optional[float] = None,
                       temperature_c: Optional[float] = None,
                       autonomy_target_min: Optional[float] = None) -> dict:
        """Duty-cycle battery sizing + discharge simulation (IEEE 485-style)."""
        return self.analyze("battery-sizing", project, battery_id=battery_id,
                            duty_cycle=duty_cycle, aging_factor=aging_factor,
                            design_margin=design_margin,
                            temperature_c=temperature_c,
                            autonomy_target_min=autonomy_target_min)

    def study_manager(self, project: dict, **params) -> dict:
        """Batch-run selected studies (see study_manager engine)."""
        return self.analyze("study-manager", project, **params)
