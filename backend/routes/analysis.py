"""Analysis routes — fault analysis, load flow, arc flash, cable sizing,
motor starting, equipment duty check, load diversity, grounding system,
and study manager."""

import traceback
from typing import Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from ..models.schemas import ProjectData, FaultResults, LoadFlowResults, ArcFlashResults, DCArcFlashResults, UnbalancedLoadFlowResults, AdmdRequest, AdmdResults, LightningRiskRequest, LightningRiskResult, RacewayRequest, RacewayResults, DCLoadFlowResults, DCShortCircuitResults
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
                                  voltage_factor=data.voltageFactor)
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
