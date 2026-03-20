"""Analysis routes — fault analysis, load flow, and arc flash."""

from fastapi import APIRouter
from ..models.schemas import ProjectData, FaultResults, LoadFlowResults, ArcFlashResults
from ..analysis.fault import run_fault_analysis
from ..analysis.loadflow import run_load_flow
from ..analysis.arcflash import run_arc_flash

router = APIRouter(prefix="/analysis", tags=["analysis"])


@router.post("/fault", response_model=FaultResults)
def fault_analysis(data: ProjectData):
    """Run IEC 60909 short-circuit analysis."""
    return run_fault_analysis(data, fault_bus_id=data.faultBusId, fault_type=data.faultType)


@router.post("/loadflow", response_model=LoadFlowResults)
def load_flow(data: ProjectData):
    """Run power flow analysis (Newton-Raphson or Gauss-Seidel)."""
    method = data.loadFlowMethod or "newton_raphson"
    return run_load_flow(data, method)


@router.post("/arcflash", response_model=ArcFlashResults)
def arc_flash(data: ProjectData):
    """Run IEEE 1584-2018 arc flash analysis.

    Requires fault analysis data. Runs fault analysis first if needed.
    """
    fault_results = run_fault_analysis(data, fault_bus_id=None, fault_type=None)
    return run_arc_flash(data, fault_results)
