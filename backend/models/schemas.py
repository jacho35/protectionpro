"""Pydantic schemas for API request/response validation."""

from pydantic import BaseModel, model_validator
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

    @model_validator(mode="after")
    def _coerce_numeric_props(self):
        """Coerce string values in props to numbers where possible.

        Frontend JSON may send numeric fields as strings (e.g. "11" instead of 11).
        This prevents TypeError in analysis code that does arithmetic on props.
        """
        for k, v in self.props.items():
            if isinstance(v, str):
                try:
                    self.props[k] = int(v)
                except ValueError:
                    try:
                        self.props[k] = float(v)
                    except ValueError:
                        pass  # Genuinely a string (e.g. name, state)
        return self


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


class ProjectDetails(BaseModel):
    projectNumber: str = ""
    clientCompany: str = ""
    engineerName: str = ""
    checkedBy: str = ""
    approvedBy: str = ""
    revisionNumber: str = ""
    date: str = ""
    description: str = ""
    companyLogo: Optional[str] = None  # base64 data URL


class ProjectData(BaseModel):
    projectName: str = "Untitled Project"
    projectDetails: Optional[ProjectDetails] = None
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
    folder_id: Optional[int] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class FolderSummary(BaseModel):
    id: int
    name: str
    parent_id: Optional[int] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class FolderCreate(BaseModel):
    name: str = "New Folder"
    parent_id: Optional[int] = None


class FolderUpdate(BaseModel):
    name: Optional[str] = None
    parent_id: Optional[int] = None


class ProjectRename(BaseModel):
    name: str


class ProjectMove(BaseModel):
    folder_id: Optional[int] = None


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
    # IEC 60909 time-varying fault currents (3-phase)
    ip: Optional[float] = None  # Peak short-circuit current (kA) — ip = κ × √2 × I"k
    kappa: Optional[float] = None  # Peak factor κ (1.02–2.0)
    ib: Optional[float] = None  # Symmetrical breaking current (kA) at t_min
    ib_asymmetric: Optional[float] = None  # Asymmetric breaking current (kA)
    ik_steady: Optional[float] = None  # Steady-state short-circuit current Ik (kA)
    branches: list[FaultBranchContribution] = []
    # Voltage depression at all buses when THIS bus is faulted
    # {bus_id: {subtransient_pu, transient_pu, steadystate_pu, retained_kv}}
    voltage_depression: Optional[dict] = None
    # Motor reacceleration voltage recovery profile (post-clearing)
    # [{t_ms: float, v_pu: float}]
    motor_recovery: Optional[list] = None


class FaultResults(BaseModel):
    buses: dict[str, FaultResultBus]
    base_mva: float
    method: str = "IEC 60909"


class ArcFlashBusResult(BaseModel):
    bus_id: str
    bus_name: str
    voltage_kv: float
    bolted_fault_ka: float
    arcing_current_ka: float
    arcing_current_reduced_ka: float
    incident_energy_cal: float  # cal/cm²
    incident_energy_reduced_cal: float
    arc_flash_boundary_mm: float
    clearing_time_s: float
    working_distance_mm: float
    electrode_config: str
    gap_mm: float
    ppe_category: int
    ppe_name: str
    ppe_description: str
    warning: str = ""
    label_html: str = ""
    recommendations: list[str] = []  # Suggestions to reduce incident energy / PPE category


class ArcFlashResults(BaseModel):
    buses: dict[str, ArcFlashBusResult]
    method: str = "IEEE 1584-2018"
    warnings: list[str] = []


class DCArcFlashBusResult(BaseModel):
    bus_id: str
    bus_name: str
    voltage_kv: float
    system_voltage_v: float
    bolted_fault_ka: float
    dc_arcing_current_a: float
    arc_voltage_v: float
    incident_energy_cal: float
    arc_flash_boundary_mm: float
    clearing_time_s: float
    working_distance_mm: float
    gap_mm: float
    ppe_category: int
    ppe_name: str
    ppe_description: str
    warning: str = ""
    label_html: str = ""
    recommendations: list[str] = []


class DCArcFlashResults(BaseModel):
    buses: dict[str, DCArcFlashBusResult]
    method: str = "Stokes & Oppenlander (DC)"
    warnings: list[str] = []


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


class UnbalancedLoadFlowBus(BaseModel):
    bus_id: str
    bus_name: str
    voltage_kv: float               # Nominal line-to-line voltage (kV)
    # Per-phase voltages (p.u., referenced to nominal phase-to-neutral)
    va_pu: float
    vb_pu: float
    vc_pu: float
    # Per-phase voltage angles (degrees)
    angle_a_deg: float
    angle_b_deg: float
    angle_c_deg: float
    # Per-phase voltages in kV (phase-to-neutral)
    va_kv: float
    vb_kv: float
    vc_kv: float
    # Sequence voltages (p.u. magnitudes)
    v1_pu: float                    # Positive sequence
    v2_pu: float                    # Negative sequence
    v0_pu: float                    # Zero sequence
    # Voltage Unbalance Factor per IEC 61000-3-13: |V2|/|V1| × 100 %
    vuf_pct: float
    # Per-phase active power injections (MW, positive = generation)
    pa_mw: float = 0
    pb_mw: float = 0
    pc_mw: float = 0


class UnbalancedLoadFlowBranch(BaseModel):
    elementId: str
    element_name: str = ""
    from_bus: str
    to_bus: str
    # Per-phase currents (A)
    ia_amps: float
    ib_amps: float
    ic_amps: float
    in_amps: float                  # Neutral current = |Ia + Ib + Ic|
    # Sequence currents (A)
    i1_amps: float
    i2_amps: float
    i0_amps: float
    loading_pct: float = 0


class UnbalancedLoadFlowResults(BaseModel):
    buses: dict[str, UnbalancedLoadFlowBus]
    branches: list[UnbalancedLoadFlowBranch] = []
    warnings: list[LoadFlowWarning] = []
    converged: bool
    iterations: int
    method: str = "Sequence Component (Unbalanced)"
