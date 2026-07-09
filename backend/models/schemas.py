"""Pydantic schemas for API request/response validation."""

from pydantic import BaseModel, PrivateAttr, field_serializer, model_validator
from typing import Optional
from datetime import datetime


class ComponentProps(BaseModel):
    """Flexible component properties — varies by type."""
    class Config:
        extra = "allow"


# Prop keys that are always textual and must never be coerced to numbers,
# even when their value happens to be a digit-string (e.g. name: "123").
_TEXTUAL_PROP_KEYS = {
    "name", "label", "id", "state", "description", "notes",
    "tag", "designation",
}


def _coerce_numeric(v: str):
    """Return the int/float a digit-string represents, or None if not numeric."""
    try:
        return int(v)
    except ValueError:
        try:
            return float(v)
        except ValueError:
            return None  # Genuinely a string (e.g. vector_group, cb_type)


class Component(BaseModel):
    # Preserve unknown fields (pageId, label offsets added later, …) so
    # save/load round-trips don't silently drop them
    model_config = {"extra": "allow"}

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

    # Props exactly as received, before numeric coercion — used by the
    # serializer below so persistence round-trips user strings byte-exact.
    _raw_props: Optional[dict] = PrivateAttr(default=None)

    @model_validator(mode="after")
    def _coerce_numeric_props(self):
        """Coerce string values in props to numbers where possible.

        Frontend JSON (and old stored projects) may send numeric fields as
        strings (e.g. "11" instead of 11). This prevents TypeError in analysis
        code that does arithmetic on props. Clearly-textual keys (name, label,
        id, state, ...) are never coerced.

        The pristine props are kept in `_raw_props` and restored on
        `model_dump()` (see `_serialize_props`), so the coercion is visible
        only to code reading `comp.props` in-process (the analysis engines) —
        the save path (projects.py stores `model_dump()`) persists exactly
        what the user sent, e.g. a tag/reference field "007" stays "007".
        """
        self._raw_props = dict(self.props)
        for k, v in self.props.items():
            if k in _TEXTUAL_PROP_KEYS:
                continue
            if isinstance(v, str):
                coerced = _coerce_numeric(v)
                if coerced is not None:
                    self.props[k] = coerced
        return self

    @field_serializer("props")
    def _serialize_props(self, props: dict, _info):
        """Serialize props with the original (pre-coercion) string values.

        For each key, emit the raw as-received value when the current value
        is still what coercion produced from it; if analysis code mutated a
        prop after validation, the mutated value wins so dumps of modified
        models (e.g. motor_starting's deep copy) stay correct.
        """
        raw = self._raw_props
        if raw is None:
            return props
        out = {}
        for k, v in props.items():
            if k in raw:
                rv = raw[k]
                if rv is v:
                    out[k] = v
                    continue
                if isinstance(rv, str) and _coerce_numeric(rv) == v:
                    out[k] = rv  # unchanged since coercion → restore original
                    continue
            out[k] = v
        return out


class Wire(BaseModel):
    # Preserve bendPoints, routeMode, pageId, … through save/load
    model_config = {"extra": "allow"}

    id: str
    fromComponent: str
    fromPort: str
    toComponent: str
    toPort: str


class Scenario(BaseModel):
    model_config = {"extra": "allow"}

    id: str
    name: str
    description: str = ""
    timestamp: str = ""
    components: list[Component] = []
    wires: list[Wire] = []
    nextId: int = 1


class ProjectDetails(BaseModel):
    projectNumber: str = ""
    client: str = ""
    company: str = ""
    engineerName: str = ""
    checkedBy: str = ""
    approvedBy: str = ""
    revisionNumber: str = ""
    date: str = ""
    description: str = ""
    companyLogo: Optional[str] = None  # base64 data URL


class ProjectData(BaseModel):
    # Preserve unknown top-level fields (dataVersion, pages, groups,
    # wireRouteMode, annotation offsets, …) through save/load round-trips.
    # Dropping them corrupted projects: without dataVersion the frontend's
    # one-time cable-resistance migration re-ran on EVERY load, compounding
    # cable R by ~1.28× per load→save cycle, and pages/groups were lost.
    model_config = {"extra": "allow"}

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


class RevisionSummary(BaseModel):
    id: int
    project_id: int
    label: str = ""
    created_at: datetime

    class Config:
        from_attributes = True


class RevisionDetail(BaseModel):
    id: int
    project_id: int
    label: str = ""
    data: str  # JSON string
    created_at: datetime

    class Config:
        from_attributes = True


class RevisionCreate(BaseModel):
    label: str = ""


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
    method: str = "IEEE 1584-2002"
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
    energized: bool = True  # False when the bus sits in a sourceless island
    # Power the busbar carries: outgoing branch flows + local load. Unlike
    # p_mw/q_mvar (net injection, which is ~0 for pass-through and swing
    # buses), this is meaningful for every energized bus.
    p_through_mw: float = 0
    q_through_mvar: float = 0


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


class DispatchEntry(BaseModel):
    """Merit-order generation dispatch result for one source."""
    source_id: str
    source_name: str = ""
    source_type: str = ""
    bus_id: str = ""
    island: int = 0          # electrical island number (0 = disconnected)
    priority: float = 0      # dispatch priority, 1 = dispatched first
    mode: str = "must_run"   # must_run | merit_order
    role: str = "dispatched"  # balancer | dispatched | curtailed | offline
    available_mw: float = 0
    dispatched_mw: float = 0
    curtailed_mw: float = 0


class LoadFlowResults(BaseModel):
    buses: dict[str, LoadFlowBus]
    branches: list[LoadFlowBranch] = []
    warnings: list[LoadFlowWarning] = []
    converged: bool
    iterations: int
    method: str
    dispatch: list[DispatchEntry] = []


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
