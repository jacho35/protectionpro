"""Analysis routes — fault analysis, load flow, arc flash, cable sizing,
motor starting, equipment duty check, load diversity, grounding system,
and study manager."""

import traceback
from typing import Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from ..models.schemas import ProjectData, FaultResults, LoadFlowResults, ArcFlashResults
from ..analysis.fault import run_fault_analysis
from ..analysis.loadflow import run_load_flow
from ..analysis.arcflash import run_arc_flash
from ..analysis.cable_sizing import run_cable_sizing
from ..analysis.motor_starting import run_motor_starting
from ..analysis.duty_check import run_duty_check
from ..analysis.load_diversity import run_load_diversity
from ..analysis.grounding_system import run_grounding_analysis
from ..analysis.study_manager import run_study_manager

router = APIRouter(prefix="/analysis", tags=["analysis"])


@router.post("/fault", response_model=FaultResults)
def fault_analysis(data: ProjectData):
    """Run IEC 60909 short-circuit analysis."""
    try:
        return run_fault_analysis(data, fault_bus_id=data.faultBusId, fault_type=data.faultType)
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


@router.post("/arcflash", response_model=ArcFlashResults)
def arc_flash(data: ProjectData):
    """Run IEEE 1584-2018 arc flash analysis.

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


@router.post("/cable-sizing")
def cable_sizing(data: ProjectData):
    """Run cable sizing analysis — thermal, voltage drop, and fault withstand checks."""
    try:
        return run_cable_sizing(data)
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


@router.post("/grounding")
def grounding_analysis(data: ProjectData):
    """Run IEEE 80 grounding system analysis."""
    try:
        return run_grounding_analysis(data)
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Grounding analysis error: {e}")


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
