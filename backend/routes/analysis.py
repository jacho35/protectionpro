"""Analysis routes — fault analysis, load flow, and arc flash."""

import traceback
from fastapi import APIRouter, HTTPException
from ..models.schemas import ProjectData, FaultResults, LoadFlowResults, ArcFlashResults
from ..analysis.fault import run_fault_analysis
from ..analysis.loadflow import run_load_flow
from ..analysis.arcflash import run_arc_flash

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
