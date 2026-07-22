"""Analysis routes — fault analysis, load flow, arc flash, cable sizing,
motor starting, equipment duty check, load diversity, grounding system,
and study manager."""

import traceback
from typing import Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from ..models.schemas import ProjectData, FaultResults, LoadFlowResults, ArcFlashResults, DCArcFlashResults, UnbalancedLoadFlowResults, AdmdRequest, AdmdResults, LightningRiskRequest, LightningRiskResult, RacewayRequest, RacewayResults, DCLoadFlowResults, DCShortCircuitResults, LoadFlowCasesRequest, LoadFlowCasesResults, VoltageStabilityRequest, VoltageStabilityResults, ContingencyRequest, ContingencyResults, HarmonicsResults, FrequencyScanRequest, FrequencyScanResults, BatterySizingRequest, BatterySizingResults, OPFRequest, OPFResults, ReliabilityResults, FilterSizingRequest, FilterSizingResults, CapacitorPlacementRequest, CapacitorPlacementResults, FlickerAnalysisRequest, FlickerAnalysisResults, HostingCapacityRequest, HostingCapacityResults
from ..analysis.loadflow_cases import run_loadflow_cases
from ..analysis.voltage_stability import run_voltage_stability
from ..analysis.contingency import run_contingency
from ..analysis.harmonics import run_harmonics
from ..analysis.frequency_scan import run_frequency_scan
from ..analysis.battery_sizing import run_battery_sizing
from ..analysis.optimal_powerflow import run_opf
from ..analysis.reliability import run_reliability
from ..analysis.filter_sizing import run_filter_sizing
from ..analysis.capacitor_placement import run_capacitor_placement
from ..analysis.flicker import run_flicker_analysis
from ..analysis.hosting_capacity import run_hosting_capacity
from ..analysis.admd import run_admd
from ..analysis.lightning_risk import run_lightning_risk
from ..analysis.raceway import run_raceway_analysis
from ..analysis.backup_autonomy import run_backup_autonomy
from ..analysis.fault import run_fault_analysis
from ..analysis.loadflow import run_load_flow
from ..analysis.unbalanced_loadflow import run_unbalanced_load_flow
from ..analysis.dc_loadflow import run_dc_load_flow
from ..analysis.dc_shortcircuit import run_dc_short_circuit
from ..analysis.arcflash import run_arc_flash
from ..analysis.dc_arcflash import run_dc_arc_flash
from ..analysis.cable_sizing import run_cable_sizing
from ..analysis.motor_starting import run_motor_starting
from ..analysis.dynamic_motor_starting import run_dynamic_motor_starting
from ..analysis.transient_stability import run_transient_stability
from ..analysis.duty_check import run_duty_check
from ..analysis.load_diversity import run_load_diversity
from ..analysis.grounding_system import run_grounding_analysis
from ..analysis.study_manager import run_study_manager

router = APIRouter(prefix="/analysis", tags=["analysis"])


@router.post("/fault", response_model=FaultResults)
def fault_analysis(data: ProjectData):
    """Run IEC 60909 short-circuit analysis."""
    try:
        return run_fault_analysis(data, fault_bus_id=data.faultBusId, fault_type=data.faultType,
                                  voltage_factor=data.voltageFactor,
                                  conductor_temperature_c=data.conductorTemperatureC)
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Fault analysis error: {e}")


@router.post("/loadflow", response_model=LoadFlowResults)
def load_flow(data: ProjectData):
    """Run power flow analysis (Newton-Raphson or Gauss-Seidel)."""
    try:
        method = data.loadFlowMethod or "newton_raphson"
        return run_load_flow(data, method)
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Load flow error: {e}")


@router.post("/loadflow-cases", response_model=LoadFlowCasesResults)
def loadflow_cases(data: LoadFlowCasesRequest):
    """Run load flow across several named network cases (Load Flow Study
    Manager) plus the current network, and summarise each for comparison."""
    try:
        method = data.loadFlowMethod or "newton_raphson"
        results = run_loadflow_cases(data, data.cases, method, data.includeCurrent)
        return LoadFlowCasesResults(cases=results, method=method)
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Load flow cases error: {e}")


@router.post("/voltage-stability", response_model=VoltageStabilityResults)
def voltage_stability(data: VoltageStabilityRequest):
    """Run steady-state voltage stability — P-V nose curves, loadability margin,
    and a Q-V reactive-margin curve at the weakest (or requested) bus."""
    try:
        method = data.loadFlowMethod or "newton_raphson"
        kwargs = {}
        if data.qv_bus_id:
            kwargs["qv_bus_id"] = data.qv_bus_id
        if data.step is not None:
            kwargs["step"] = data.step
        if data.lambda_max is not None:
            kwargs["lambda_max"] = data.lambda_max
        if data.v_floor is not None:
            kwargs["v_floor"] = data.v_floor
        return run_voltage_stability(data, method, **kwargs)
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Voltage stability error: {e}")


@router.post("/contingency", response_model=ContingencyResults)
def contingency(data: ContingencyRequest):
    """Run N-1 (and optionally N-2) contingency screening — flag thermal
    overloads, voltage violations and loss of supply for each element outage."""
    try:
        method = data.loadFlowMethod or "newton_raphson"
        kwargs = {"include_n2": data.include_n2}
        if data.v_min is not None:
            kwargs["v_min"] = data.v_min
        if data.v_max is not None:
            kwargs["v_max"] = data.v_max
        if data.loading_limit_pct is not None:
            kwargs["loading_limit_pct"] = data.loading_limit_pct
        if data.max_contingencies is not None:
            kwargs["max_contingencies"] = data.max_contingencies
        return run_contingency(data, method, **kwargs)
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Contingency analysis error: {e}")


@router.post("/harmonics", response_model=HarmonicsResults)
def harmonics(data: ProjectData):
    """Run harmonic penetration analysis — VFDs modelled as harmonic current
    sources, per-bus voltage THD and PCC current TDD checked against IEEE 519."""
    try:
        method = data.loadFlowMethod or "newton_raphson"
        return run_harmonics(data, method)
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Harmonic analysis error: {e}")


@router.post("/frequency-scan", response_model=FrequencyScanResults)
def frequency_scan(data: FrequencyScanRequest):
    """Run the impedance-vs-frequency sweep — per-bus driving-point |Z(h)| on
    the harmonic network model, with parallel/series resonance identification."""
    try:
        kwargs = {}
        if data.scan_bus_ids:
            kwargs["bus_ids"] = data.scan_bus_ids
        if data.h_max is not None:
            kwargs["h_max"] = data.h_max
        if data.h_step is not None:
            kwargs["h_step"] = data.h_step
        return run_frequency_scan(data, **kwargs)
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Frequency scan error: {e}")


@router.post("/opf", response_model=OPFResults)
def optimal_power_flow(data: OPFRequest):
    """Optimal power flow — merit-order economic dispatch by marginal cost +
    greedy discrete Volt/VAR optimization (caps / taps / setpoints)."""
    try:
        kwargs = {"method": data.loadFlowMethod or "newton_raphson"}
        for f in ("objective", "v_min", "v_max", "loading_limit_pct",
                  "use_dispatch", "use_capacitors", "use_taps",
                  "use_setpoints", "max_moves"):
            v = getattr(data, f)
            if v is not None:
                kwargs[f] = v
        return run_opf(data, **kwargs)
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"OPF error: {e}")


@router.post("/filter-sizing", response_model=FilterSizingResults)
def filter_sizing(data: FilterSizingRequest):
    """Size single-tuned passive harmonic filters to meet IEEE 519, verified
    by re-running the harmonic penetration study with the design in place."""
    try:
        kwargs = {"method": data.loadFlowMethod or "newton_raphson"}
        if data.filter_bus_id:
            kwargs["bus_id"] = data.filter_bus_id
        if data.total_kvar is not None:
            kwargs["total_kvar"] = data.total_kvar
        if data.quality_factor is not None:
            kwargs["quality_factor"] = data.quality_factor
        if data.max_branches is not None:
            kwargs["max_branches"] = data.max_branches
        return run_filter_sizing(data, **kwargs)
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Filter sizing error: {e}")


@router.post("/capacitor-placement", response_model=CapacitorPlacementResults)
def capacitor_placement(data: CapacitorPlacementRequest):
    """Optimal capacitor placement — greedy loss-sensitivity placement of
    standard bank units, each trial scored by a full load-flow solve."""
    try:
        kwargs = {"method": data.loadFlowMethod or "newton_raphson"}
        if data.candidate_bus_ids:
            kwargs["bus_ids"] = data.candidate_bus_ids
        for f in ("unit_kvar", "max_kvar_per_bus", "max_total_kvar",
                  "v_min", "v_max"):
            v = getattr(data, f)
            if v is not None:
                kwargs[f] = v
        return run_capacitor_placement(data, **kwargs)
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500,
                            detail=f"Capacitor placement error: {e}")


@router.post("/flicker", response_model=FlickerAnalysisResults)
def flicker_analysis(data: FlickerAnalysisRequest):
    """Voltage flicker screening (IEC 61000-3-3 / IEC 61000-4-15) — Pst/Plt
    planning-level estimate for motors flagged with a repetitive starting
    rate, from a rigorous Thevenin relative-voltage-change calculation."""
    try:
        kwargs = {}
        for f in ("pst_limit", "plt_limit", "d_anchor_pct", "exponent"):
            v = getattr(data, f)
            if v is not None:
                kwargs[f] = v
        return run_flicker_analysis(data, **kwargs)
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Flicker analysis error: {e}")


@router.post("/hosting-capacity", response_model=HostingCapacityResults)
def hosting_capacity(data: HostingCapacityRequest):
    """Nodal hosting capacity — maximum unity-pf PV interconnection at each
    candidate bus before a voltage-rise or thermal-overload limit is hit
    (sweep-then-bisect DER injection search, LF-scored)."""
    try:
        kwargs = {}
        if data.candidate_bus_ids:
            kwargs["bus_ids"] = data.candidate_bus_ids
        for req_field, kw in (("hc_power_factor", "power_factor"),
                              ("v_min", "v_min"), ("v_max", "v_max"),
                              ("loading_limit_pct", "loading_limit_pct"),
                              ("step_mw", "step_mw"),
                              ("max_mw_per_bus", "max_mw_per_bus")):
            v = getattr(data, req_field)
            if v is not None:
                kwargs[kw] = v
        return run_hosting_capacity(data, **kwargs)
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500,
                            detail=f"Hosting capacity error: {e}")


@router.post("/reliability", response_model=ReliabilityResults)
def reliability(data: ProjectData):
    """Distribution reliability — SAIDI/SAIFI/MAIFI (IEEE 1366) via
    analytical FMEA over source-connectivity outages."""
    try:
        return run_reliability(data)
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Reliability error: {e}")


@router.post("/battery-sizing", response_model=BatterySizingResults)
def battery_sizing(data: BatterySizingRequest):
    """Size a battery for a duty cycle (IEEE 485-style factors) and simulate
    the discharge (SoC + terminal voltage vs time, per-chemistry model)."""
    try:
        kwargs = {}
        if data.battery_id:
            kwargs["battery_id"] = data.battery_id
        if data.duty_cycle is not None:
            kwargs["duty_cycle"] = data.duty_cycle
        if data.aging_factor is not None:
            kwargs["aging_factor"] = data.aging_factor
        if data.design_margin is not None:
            kwargs["design_margin"] = data.design_margin
        if data.temperature_c is not None:
            kwargs["temperature_c"] = data.temperature_c
        if data.autonomy_target_min is not None:
            kwargs["autonomy_target_min"] = data.autonomy_target_min
        return run_battery_sizing(data, **kwargs)
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Battery sizing error: {e}")


@router.post("/unbalanced-loadflow", response_model=UnbalancedLoadFlowResults)
def unbalanced_load_flow(data: ProjectData):
    """Run three-phase unbalanced load flow using symmetrical component method."""
    try:
        method = data.loadFlowMethod or "newton_raphson"
        return run_unbalanced_load_flow(data, method)
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Unbalanced load flow error: {e}")


@router.post("/dc-loadflow", response_model=DCLoadFlowResults)
def dc_load_flow(data: ProjectData):
    """Run DC load flow (resistive nodal solve) on the DC bus network."""
    try:
        return run_dc_load_flow(data)
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"DC load flow error: {e}")


@router.post("/dc-shortcircuit", response_model=DCShortCircuitResults)
def dc_short_circuit(data: ProjectData):
    """Run DC short-circuit analysis (IEC 61660-1) on the DC bus network."""
    try:
        return run_dc_short_circuit(data, fault_bus_id=data.faultBusId)
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"DC short circuit error: {e}")


@router.post("/arcflash", response_model=ArcFlashResults)
def arc_flash(data: ProjectData):
    """Run IEEE 1584-2002 arc flash analysis.

    Requires fault analysis data. Runs fault analysis first if needed.
    """
    try:
        fault_results = run_fault_analysis(data, fault_bus_id=None, fault_type=None)
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Fault analysis (pre-arc-flash) error: {e}")

    try:
        return run_arc_flash(data, fault_results)
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Arc flash analysis error: {e}")


@router.post("/dc-arcflash", response_model=DCArcFlashResults)
def dc_arc_flash(data: ProjectData):
    """Run DC arc flash analysis per Stokes & Oppenlander method.

    Requires fault analysis data. Runs fault analysis first if needed.
    """
    try:
        fault_results = run_fault_analysis(data, fault_bus_id=None, fault_type=None)
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Fault analysis (pre-DC-arc-flash) error: {e}")

    try:
        return run_dc_arc_flash(data, fault_results)
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"DC arc flash analysis error: {e}")


class CableSizingRequest(ProjectData):
    """Extends ProjectData with cable sizing options (all optional —
    engine defaults are used when a field is omitted)."""
    ambient_temp_c: Optional[float] = None
    install_method: Optional[str] = None
    max_voltage_drop_pct: Optional[float] = None
    adiabatic_basis: Optional[str] = None


@router.post("/cable-sizing")
def cable_sizing(data: CableSizingRequest):
    """Run cable sizing analysis — thermal, voltage drop, and fault withstand checks."""
    try:
        return run_cable_sizing(
            data,
            ambient_temp_c=data.ambient_temp_c if data.ambient_temp_c is not None else 30,
            install_method=data.install_method or "trefoil",
            max_voltage_drop_pct=(data.max_voltage_drop_pct
                                  if data.max_voltage_drop_pct is not None else 5.0),
            adiabatic_basis=data.adiabatic_basis or "thermal_equivalent",
        )
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Cable sizing error: {e}")


@router.post("/motor-starting")
def motor_starting(data: ProjectData):
    """Run motor starting voltage dip analysis."""
    try:
        return run_motor_starting(data)
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Motor starting analysis error: {e}")


@router.post("/dynamic-motor-starting")
def dynamic_motor_starting(data: ProjectData):
    """Run dynamic motor starting (time-domain acceleration) analysis."""
    try:
        return run_dynamic_motor_starting(data)
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Dynamic motor starting error: {e}")


@router.post("/transient-stability")
def transient_stability(data: ProjectData):
    """Run classical multi-machine transient stability (time-domain rotor angle)."""
    try:
        return run_transient_stability(data, data.stabilityDisturbance)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Transient stability error: {e}")


@router.post("/duty-check")
def duty_check(data: ProjectData):
    """Run equipment duty check — fault current vs. device ratings."""
    try:
        return run_duty_check(data)
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Duty check error: {e}")


@router.post("/load-diversity")
def load_diversity(data: ProjectData):
    """Run load diversity and demand factor analysis."""
    try:
        return run_load_diversity(data)
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Load diversity error: {e}")


@router.post("/backup")
def backup_autonomy(data: ProjectData):
    """Grid-outage backup adequacy & battery autonomy study."""
    try:
        return run_backup_autonomy(data)
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Backup study error: {e}")


@router.post("/grounding")
def grounding_analysis(data: ProjectData):
    """Run IEEE 80 grounding system analysis."""
    try:
        return run_grounding_analysis(data)
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Grounding analysis error: {e}")


@router.post("/admd", response_model=AdmdResults)
def admd(data: AdmdRequest):
    """Estimate After Diversity Maximum Demand (NRS 034-1 / CTEF100).

    Supports the Empirical (ADMD × DCF) and Herman-Beta (statistical) methods.
    Returns per-kiosk diversified demand and the combined feeder total.
    """
    try:
        return run_admd(data.model_dump())
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"ADMD analysis error: {e}")


@router.post("/lightning-risk", response_model=LightningRiskResult)
def lightning_risk(data: LightningRiskRequest):
    """Run IEC 62305-2 lightning risk assessment (R1, loss of human life)."""
    try:
        return run_lightning_risk(data)
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Lightning risk error: {e}")


@router.post("/raceway", response_model=RacewayResults)
def raceway_analysis(data: RacewayRequest):
    """Run conduit fill, jam ratio, and grouping-derating analysis."""
    try:
        return run_raceway_analysis(data)
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Raceway analysis error: {e}")


class StudyManagerRequest(ProjectData):
    """Extends ProjectData with study manager options."""
    enabled_studies: Optional[list[str]] = None


@router.post("/study-manager")
def study_manager(data: StudyManagerRequest):
    """Run all enabled studies in batch and return consolidated results."""
    try:
        return run_study_manager(data, enabled_studies=data.enabled_studies)
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Study manager error: {e}")
