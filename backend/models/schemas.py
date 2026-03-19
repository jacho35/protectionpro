"""Pydantic schemas for API request/response validation."""

from pydantic import BaseModel
from typing import Optional
from datetime import datetime


class ComponentProps(BaseModel):
    """Flexible component properties — varies by type."""
    class Config:
        extra = "allow"


class Component(BaseModel):
    id: str
    type: str
    x: float
    y: float
    rotation: float = 0
    props: dict


class Wire(BaseModel):
    id: str
    fromComponent: str
    fromPort: str
    toComponent: str
    toPort: str


class ProjectData(BaseModel):
    projectName: str = "Untitled Project"
    baseMVA: float = 100.0
    frequency: int = 50
    components: list[Component] = []
    wires: list[Wire] = []
    nextId: int = 1
    loadFlowMethod: Optional[str] = None


class ProjectSummary(BaseModel):
    id: int
    name: str
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class FaultResultBus(BaseModel):
    bus_id: str
    bus_name: str
    voltage_kv: float
    ik3: Optional[float] = None  # 3-phase fault kA
    ik1: Optional[float] = None  # SLG fault kA
    ikLL: Optional[float] = None  # Line-to-line fault kA


class FaultResults(BaseModel):
    buses: dict[str, FaultResultBus]
    base_mva: float
    method: str = "IEC 60909"


class LoadFlowBus(BaseModel):
    bus_id: str
    bus_name: str
    voltage_pu: float
    voltage_kv: float
    angle_deg: float
    p_mw: float = 0
    q_mvar: float = 0


class LoadFlowBranch(BaseModel):
    elementId: str
    element_name: str = ""
    from_bus: str
    to_bus: str
    p_mw: float
    q_mvar: float
    s_mva: float = 0
    i_amps: float = 0
    loading_pct: float = 0
    losses_mw: float = 0


class LoadFlowResults(BaseModel):
    buses: dict[str, LoadFlowBus]
    branches: list[LoadFlowBranch] = []
    converged: bool
    iterations: int
    method: str
