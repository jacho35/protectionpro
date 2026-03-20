"""Analysis routes — fault analysis and load flow."""

from fastapi import APIRouter
from ..models.schemas import ProjectData, FaultResults, LoadFlowResults
from ..analysis.fault import run_fault_analysis
from ..analysis.loadflow import run_load_flow

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
