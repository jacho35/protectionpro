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
    labelOffsetX: Optional[float] = None
    labelOffsetY: Optional[float] = None
    nameLabelOffsetX: Optional[float] = None
    nameLabelOffsetY: Optional[float] = None


class Wire(BaseModel):
    id: str
    fromComponent: str
    fromPort: str
    toComponent: str
    toPort: str


class Scenario(BaseModel):
    id: str
    name: str
    description: str = ""
    timestamp: str = ""
    components: list[Component] = []
    wires: list[Wire] = []
    nextId: int = 1


class ProjectData(BaseModel):
    projectName: str = "Untitled Project"
    baseMVA: float = 100.0
    frequency: int = 50
    components: list[Component] = []
    wires: list[Wire] = []
    nextId: int = 1
    scenarios: list[Scenario] = []
    loadFlowMethod: Optional[str] = None
    faultBusId: Optional[str] = None
    faultType: Optional[str] = None  # "3phase", "slg", "ll", "llg", or None for all


class ProjectSummary(BaseModel):
    id: int
    name: str
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class FaultBranchContribution(BaseModel):
    """Fault current contribution through a single branch path."""
    element_id: str
    element_name: str = ""
    element_type: str = ""
    from_bus: str = ""
    to_bus: str = ""
    ik_ka: float = 0  # Branch fault current in kA for selected fault type
    z_path_real: float = 0  # Total path impedance real (p.u.)
    z_path_imag: float = 0  # Total path impedance imaginary (p.u.)
    z_path_mag: float = 0  # Total path impedance magnitude (p.u.)
    contribution_pct: float = 0  # Percentage of total fault current
    source_name: str = ""  # Name of the source at end of path


class FaultResultBus(BaseModel):
    bus_id: str
    bus_name: str
    voltage_kv: float
    ik3: Optional[float] = None  # 3-phase fault kA
    ik3_angle: Optional[float] = None  # 3-phase fault angle (degrees)
    ik1: Optional[float] = None  # SLG fault kA
    ik1_angle: Optional[float] = None  # SLG fault angle (degrees)
    ikLL: Optional[float] = None  # Line-to-line fault kA
    ikLL_angle: Optional[float] = None  # LL fault angle (degrees)
    ikLLG: Optional[float] = None  # Double line-to-ground fault kA
    ikLLG_angle: Optional[float] = None  # LLG fault angle (degrees)
    z_eq_real: Optional[float] = None  # Z_eq real part (p.u.)
    z_eq_imag: Optional[float] = None  # Z_eq imaginary part (p.u.)
    z_eq_mag: Optional[float] = None   # |Z_eq| magnitude (p.u.)
    # Zero-sequence detail fields
    z0_real: Optional[float] = None    # Z0 real part (p.u.)
    z0_imag: Optional[float] = None    # Z0 imaginary part (p.u.)
    z0_mag: Optional[float] = None     # |Z0| magnitude (p.u.)
    z0_source_count: Optional[int] = None  # Number of Z0 source paths
    z0_sources_detail: Optional[list[str]] = None  # Description of each Z0 source
    # Motor contribution summary
    motor_count: int = 0  # Number of motors contributing to fault
    ik3_motor: Optional[float] = None  # Motor contribution to 3-phase fault (kA)
    ik3_network: Optional[float] = None  # Network (non-motor) contribution to 3-phase fault (kA)
    branches: list[FaultBranchContribution] = []


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


class LoadFlowWarning(BaseModel):
    elementId: str
    element_name: str = ""
    message: str
    expected_kv: float = 0
    actual_kv: float = 0


class LoadFlowResults(BaseModel):
    buses: dict[str, LoadFlowBus]
    branches: list[LoadFlowBranch] = []
    warnings: list[LoadFlowWarning] = []
    converged: bool
    iterations: int
    method: str
