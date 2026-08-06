"""Pydantic schemas for API request/response validation."""

from pydantic import BaseModel, PrivateAttr, field_serializer, model_validator, Field
from typing import Optional, Literal
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
        # The overhead conductor-temperature correction (see
        # analysis/conductor_temp) is an in-process modelling correction, not
        # user data: the project must keep the library's 20 °C resistance so
        # the properties panel still matches the conductor library and a
        # save/load round-trip is byte-stable. Restore the base and drop the
        # bookkeeping keys. Engines that dump-and-rebuild a project get clean
        # 20 °C props and the correction is simply re-applied on rebuild.
        base_r = props.get("_r20_per_km")
        if base_r is not None:
            out["r_per_km"] = base_r
        base_r0 = props.get("_r0_20_per_km")
        if base_r0 is not None:
            out["r0_per_km"] = base_r0
        for k in ("_r20_per_km", "_r0_20_per_km", "_r_temp_applied_c"):
            out.pop(k, None)
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
    voltageFactor: Optional[float] = None  # IEC 60909 voltage factor c; None → engine default (c_max = 1.10)
    # [PS-3] Conductor temperature (°C) for MINIMUM short-circuit studies:
    # cable resistance is scaled by 1 + 0.004·(θ − 20) per IEC 60909-0 §5.3.1
    # (use with voltageFactor = 0.95 = c_min). None → 20 °C (maximum-current
    # convention, unchanged legacy behaviour).
    conductorTemperatureC: Optional[float] = None
    stabilityDisturbance: Optional[dict] = None  # transient-stability event spec (see transient_stability)
    dynamicMotorSchedule: Optional[dict] = None  # dynamic motor-start timeline: {"motors": [{"id","role","start_time_s"}]}
    openConductorBranchId: Optional[str] = None  # cable/feeder id for open-conductor (series-fault) analysis
    twoConductorOpenBranchId: Optional[str] = None  # cable/feeder id for two-conductor-open (series-fault) analysis
    simultaneousFaultBranchId: Optional[str] = None  # cable/feeder id for the series (open-conductor) leg
    simultaneousFaultSeriesType: Optional[str] = None  # "open_conductor" | "two_conductor_open"
    simultaneousFaultBusId: Optional[str] = None  # bus/board id for the shunt-fault leg, elsewhere in the network
    simultaneousFaultShuntType: Optional[str] = None  # "3phase" | "slg" | "ll" | "llg"

    @model_validator(mode="after")
    def _correct_overhead_resistance(self):
        """Bring overhead-line resistance to its operating temperature.

        The overhead library is quoted at 20 °C while the cable library is
        quoted hot, so without this an overhead line ran cold in every engine
        and its losses / voltage drop came out ~15–25 % optimistic. Correcting
        here — once, as the project is built — means load flow, fault,
        harmonics, unbalanced, contingency and the rest all see the same value
        without each having to remember. Idempotent (see conductor_temp).
        """
        from ..analysis.conductor_temp import apply_to_components
        apply_to_components(self.components)
        return self


class ProjectSummary(BaseModel):
    id: int
    name: str
    folder_id: Optional[int] = None
    created_at: datetime
    updated_at: datetime
    # Ownership / access — populated by the route (computed, not plain ORM attrs)
    owner_id: Optional[int] = None
    owner_email: Optional[str] = None
    owner_name: Optional[str] = None
    access: str = "owner"          # 'owner' | 'edit' | 'view'

    class Config:
        from_attributes = True


# ── Auth / users ──

class UserOut(BaseModel):
    id: int
    email: str
    name: str
    is_admin: bool
    is_active: bool
    created_at: datetime

    class Config:
        from_attributes = True


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


class RegisterRequest(BaseModel):
    email: str
    password: str = Field(min_length=8)
    name: str = ""
    invite_code: Optional[str] = None


class LoginRequest(BaseModel):
    email: str
    password: str


# ── Invites ──

class InviteCreate(BaseModel):
    email: Optional[str] = None
    expires_at: Optional[datetime] = None


class InviteOut(BaseModel):
    id: int
    code: str
    email: Optional[str] = None
    used_by: Optional[int] = None
    used_at: Optional[datetime] = None
    expires_at: Optional[datetime] = None
    created_at: datetime

    class Config:
        from_attributes = True


# ── Project sharing ──

class ShareCreate(BaseModel):
    email: str
    role: Literal["view", "edit"] = "view"


class ShareRoleUpdate(BaseModel):
    role: Literal["view", "edit"]


class ShareOut(BaseModel):
    user_id: int
    email: str
    name: str
    role: str
    created_at: datetime


# ── ADMD / reticulation demand estimation ───────────────────────────────────


class ErfInput(BaseModel):
    """A single stand/erf (consumer connection point) on a kiosk."""
    model_config = {"extra": "allow"}

    id: Optional[str] = None
    erfNumber: Optional[str] = None
    length: float = 0                       # service-cable length (m); >0 ⇒ active
    phase: Optional[str] = None             # "Red"|"White"|"Blue"|"3 Phase"|None
    cableType: Optional[str] = None
    ratedAmps: Optional[float] = None
    ampsOverride: Optional[float] = None    # fixed, undiversified load (A)


class KioskInput(BaseModel):
    """A distribution kiosk feeding a group of erven."""
    model_config = {"extra": "allow"}

    id: Optional[str] = None
    name: str = ""
    fedFrom: Optional[str] = None           # upstream cable-row id (topology)
    loadClass: Optional[str] = None         # per-kiosk class override
    admdOverride: Optional[float] = None    # per-kiosk ADMD override (kVA)
    streetLightKVA: Optional[float] = None  # fixed, undiversified SL load (kVA)
    erfs: list[ErfInput] = []


class AdmdSettings(BaseModel):
    """Project-level demand-estimation settings."""
    model_config = {"extra": "allow"}

    estimationMethod: str = "Empirical"     # "Empirical" | "Herman Beta"
    correctionMethod: str = "AMEU"          # "AMEU" | "British" | "None"
    loadClass: str = "urban1"               # default class id
    admd: float = 4.04                      # default ADMD (kVA)
    riskZ: float = 1.28                     # Herman-Beta risk factor
    networkDiversity: float = 1.0           # applied to Σ minisub demands (NMD)
    loadClassLib: Optional[list[dict]] = None  # project override of default classes


class MinisubInput(BaseModel):
    """A minisub / transformer source; ADMD diversity is applied per minisub
    across all kiosks fed (transitively) from it."""
    model_config = {"extra": "allow"}

    id: str
    name: str = ""


class AdmdRequest(BaseModel):
    settings: AdmdSettings = AdmdSettings()
    kiosks: list[KioskInput] = []
    minisubs: list[MinisubInput] = []       # empty ⇒ one implicit source


class AdmdKioskResult(BaseModel):
    model_config = {"extra": "allow"}

    kioskId: Optional[str] = None
    name: str = ""
    totalKVA: float
    currentA: float
    admdKVA: float
    conns: int
    overrideKVA: float = 0
    cls: str = ""
    clsId: str = ""


class AdmdMinisubResult(BaseModel):
    """Diversified demand of one minisub's downstream group."""
    model_config = {"extra": "allow"}

    minisubId: str
    name: str = ""
    totalKVA: float
    currentA: float
    overrideKVA: float = 0
    streetLightKVA: float = 0
    conns: int
    numKiosks: int


class AdmdFeederTotal(BaseModel):
    totalKVA: float                          # sumKVA × networkDiversity
    currentA: float
    overrideKVA: float = 0
    streetLightKVA: float = 0
    conns: int
    numKiosks: int
    sumKVA: float = 0                        # Σ per-minisub diversified demands
    networkDiversity: float = 1.0


class AdmdResults(BaseModel):
    kiosks: list[AdmdKioskResult] = []
    minisubs: list[AdmdMinisubResult] = []
    total: AdmdFeederTotal
    settings: dict


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


# ── Plan Markup image store ──

class PlanImageMeta(BaseModel):
    """Metadata for a stored plan image — never carries the binary `data`."""
    id: int
    project_id: Optional[int] = None
    kind: str = "raster"
    name: str = ""
    mime: str = "image/png"
    width: int = 0
    height: int = 0
    size_bytes: int = 0
    created_at: datetime

    class Config:
        from_attributes = True


class PlanImageClaim(BaseModel):
    """PATCH body to claim an orphan upload for a project on first save."""
    project_id: int


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
    # [EE-7 contract] frontend SLG calc-display inputs (declared here so they
    # survive FastAPI response_model serialization — see fault.FaultResultBus)
    z2_mag: Optional[float] = None      # |Z2| used for Ik1/IkLL (p.u.)
    z_slg_mag: Optional[float] = None   # |Z1 + Z2 + Z0| SLG denominator (p.u.)
    # [EE-11] Thermal-equivalent short-circuit current Ith = Ik″·√(m+n)
    ith_ka: Optional[float] = None
    # [PS-1] Network topology seen from this fault location: "radial" when the
    # enumerated source paths share no impedance element (per-path parallel
    # combination is exact), "meshed" when they do — the Thevenin impedance is
    # then solved nodally (Zbus) instead of by paralleling path totals.
    network_topology: Optional[str] = None
    # [PS-1] Study warnings (meshed-network solution notes, path-enumeration
    # truncation, …) that previously went only to the server console.
    topology_warnings: Optional[list[str]] = None
    # [R3] "per-path-fallback" when a meshed topology's nodal solve failed and
    # the OVERSTATING per-path combination was used — consumers (arc flash,
    # duty check, compliance) must annotate/refuse rather than silently trust
    # this bus's currents. None on healthy solves.
    thevenin_basis: Optional[str] = None


class FaultResults(BaseModel):
    buses: dict[str, FaultResultBus]
    base_mva: float
    method: str = "IEC 60909"
    # [PS-10/PS-11] Fixed study conventions — printed as report assumptions
    # so signable outputs disclose the screening-level conventions used.
    study_assumptions: Optional[list[str]] = None


class OpenConductorResults(BaseModel):
    """One-conductor-open (single-phasing) series fault on a cable branch.
    See fault.run_open_conductor_analysis for the derivation."""
    branch_id: str
    branch_name: str = ""
    source_bus_id: str = ""      # side used as the driving EMF (upstream)
    source_bus_name: str = ""
    load_bus_id: str = ""        # side represented as impedance only (downstream)
    load_bus_name: str = ""
    voltage_kv: float = 0
    base_mva: float = 100
    prefault_current_a: float = 0  # prefault branch current (compensation-theorem driver)
    z1_pu: list[float] = []      # [real, imag] total positive-seq Za1 = Zx1+Zy1
    z2_pu: list[float] = []      # [real, imag] total negative-seq Za2
    z0_pu: list[float] = []      # [real, imag] total zero-seq Za0
    z1_source_pu: list[float] = []  # [real, imag] Zx1 (upstream, incl. branch impedance)
    z1_load_pu: list[float] = []    # [real, imag] Zy1 (downstream)
    ia1_ka: float = 0            # positive-sequence current at the break (kA)
    ia2_ka: float = 0            # negative-sequence current at the break (kA)
    ia0_ka: float = 0            # zero-sequence current at the break (kA)
    ib_ka: float = 0             # healthy-phase B current (kA)
    ic_ka: float = 0             # healthy-phase C current (kA)
    ig_ka: float = 0             # residual/ground current 3·Ia0 (kA)
    negative_seq_pct: float = 0  # Ia2/Ia1 × 100% — NEMA MG-1 motor single-phasing stress proxy
    downstream_va_pu: float = 0  # downstream bus phase voltages post-event (p.u.)
    downstream_vb_pu: float = 0
    downstream_vc_pu: float = 0
    has_downstream_source: bool = False
    warnings: list[str] = []
    method: str = "Open conductor"


class TwoConductorOpenResults(BaseModel):
    """Two-conductors-open (single surviving phase) series fault on a cable
    branch — the series-connected-sequence-network dual of a bolted SLG
    shunt fault. See fault.run_two_conductor_open_analysis for the
    derivation."""
    branch_id: str
    branch_name: str = ""
    source_bus_id: str = ""      # side used as the driving EMF (upstream)
    source_bus_name: str = ""
    load_bus_id: str = ""        # side represented as impedance only (downstream)
    load_bus_name: str = ""
    voltage_kv: float = 0
    base_mva: float = 100
    prefault_current_a: float = 0  # prefault branch current (compensation-theorem driver)
    z1_pu: list[float] = []      # [real, imag] total positive-seq Za1 = Zx1+Zy1
    z2_pu: list[float] = []      # [real, imag] total negative-seq Za2
    z0_pu: list[float] = []      # [real, imag] total zero-seq Za0
    z1_source_pu: list[float] = []  # [real, imag] Zx1 (upstream, incl. branch impedance)
    z1_load_pu: list[float] = []    # [real, imag] Zy1 (downstream)
    ia1_ka: float = 0            # positive-sequence current at the break (kA) — equals ia2, ia0
    ia2_ka: float = 0            # negative-sequence current at the break (kA)
    ia0_ka: float = 0            # zero-sequence current at the break (kA)
    ia_ka: float = 0             # surviving-phase current, 3·Ia1 (kA)
    ig_ka: float = 0             # residual/ground current 3·Ia0 (kA) — identically equals ia_ka
    negative_seq_pct: float = 0  # Ia2/Ia1 × 100% — forced to 100% by the boundary condition
    downstream_va_pu: float = 0  # downstream bus phase voltages post-event (p.u.)
    downstream_vb_pu: float = 0
    downstream_vc_pu: float = 0
    has_downstream_source: bool = False
    warnings: list[str] = []
    method: str = "Two-conductor-open"


class SimultaneousFaultResults(BaseModel):
    """Simultaneous series (open-conductor) + shunt fault at two DIFFERENT
    network locations, coupled through the network's sequence transfer
    impedance — the two-fault-point generalization of
    OpenConductorResults/TwoConductorOpenResults. See
    fault.run_simultaneous_fault_analysis for the derivation."""
    # Series (break) side — same field vocabulary as OpenConductorResults/
    # TwoConductorOpenResults; ib_ka/ic_ka apply for series_type =
    # "open_conductor", ia_ka for "two_conductor_open".
    branch_id: str
    branch_name: str = ""
    series_type: str = ""        # "open_conductor" | "two_conductor_open"
    source_bus_id: str = ""      # upstream side of the break
    source_bus_name: str = ""
    load_bus_id: str = ""        # downstream side of the break
    load_bus_name: str = ""
    voltage_kv: float = 0        # break-point (upstream) voltage base
    prefault_current_a: float = 0
    ia1_ka: float = 0            # positive-seq current at the break (kA)
    ia2_ka: float = 0
    ia0_ka: float = 0
    ib_ka: float = 0             # healthy-phase B current (open_conductor only)
    ic_ka: float = 0             # healthy-phase C current (open_conductor only)
    ia_ka: float = 0             # surviving-phase current (two_conductor_open only)
    ig_ka: float = 0             # residual/ground current 3·Ia0 at the break (kA)
    negative_seq_pct: float = 0  # Ia2/Ia1 × 100% at the break

    # Shunt side — the second, independent fault location
    shunt_bus_id: str = ""
    shunt_bus_name: str = ""
    shunt_type: str = ""         # "3phase" | "slg" | "ll" | "llg"
    shunt_voltage_kv: float = 0
    ip1_ka: float = 0            # positive-seq current into the shunt fault (kA)
    ip2_ka: float = 0
    ip0_ka: float = 0
    ipa_ka: float = 0            # shunt-fault phase currents (kA)
    ipb_ka: float = 0
    ipc_ka: float = 0
    ig_shunt_ka: float = 0       # residual/ground current 3·Ip0 at the shunt fault (kA)

    base_mva: float = 100
    # Coupling impedances (p.u.) — exposed for transparency/debugging, not
    # normally shown to the user: [real, imag] pairs.
    za1_pu: list[float] = []     # port-F (break) self-impedance
    za2_pu: list[float] = []
    za0_pu: list[float] = []
    zp1_pu: list[float] = []     # port-P (shunt) self-impedance
    zp2_pu: list[float] = []
    zp0_pu: list[float] = []
    zfp1_pu: list[float] = []    # transfer impedance between the break and the shunt fault
    zfp2_pu: list[float] = []
    zfp0_pu: list[float] = []

    has_downstream_source: bool = False
    warnings: list[str] = []
    method: str = "Simultaneous series+shunt fault"


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
    method: str = "IEEE 1584-2002"
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
    pf: float = 0        # calculated power factor of the flow, |P| / S (0 if S≈0)


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
    # Reactive counterparts, so the results table can report apparent power
    # (S = √(P²+Q²)) as well as real power. Default 0 keeps every consumer that
    # only reads the MW fields unchanged.
    available_mvar: float = 0
    dispatched_mvar: float = 0
    curtailed_mvar: float = 0


class LoadFlowResults(BaseModel):
    buses: dict[str, LoadFlowBus]
    branches: list[LoadFlowBranch] = []
    warnings: list[LoadFlowWarning] = []
    converged: bool
    iterations: int
    method: str
    dispatch: list[DispatchEntry] = []
    svc: list[dict] = []          # SVC/STATCOM reactive-output summary
    # Solution-quality classification, distinct from raw convergence:
    #   "ok"                — converged to a plausible operating point
    #   "low_voltage_root"  — converged, but an energized bus sits implausibly
    #                         low (likely the low-voltage/collapse root or an
    #                         infeasible point presented as valid)
    #   "non_converged"     — the solver did not converge (see `converged`)
    solution_quality: str = "ok"


# ── Load Flow Study Manager (named full-snapshot cases) ──────────────────────
class LoadFlowCaseInput(BaseModel):
    """One study case: a self-contained network snapshot to run load flow on.

    Carrying `components` as validated `Component` models means the numeric
    coercion validator runs automatically, so grid-edited string values (e.g.
    "11") reach the engine as numbers."""
    model_config = {"extra": "allow"}

    id: str
    name: str = ""
    components: list[Component] = []
    wires: list[Wire] = []
    baseMVA: Optional[float] = None
    loadFlowMethod: Optional[str] = None


class LoadFlowCaseSummary(BaseModel):
    converged: bool = False
    iterations: int = 0
    min_v_pu: Optional[float] = None
    min_v_bus: str = ""
    max_v_pu: Optional[float] = None
    max_v_bus: str = ""
    total_losses_mw: float = 0
    overloaded_branch_count: int = 0
    worst_branch_name: str = ""
    worst_branch_loading_pct: float = 0
    deenergized_bus_count: int = 0


class LoadFlowCaseResult(BaseModel):
    id: str
    name: str = ""
    result: LoadFlowResults
    summary: LoadFlowCaseSummary


class LoadFlowCasesResults(BaseModel):
    cases: list[LoadFlowCaseResult] = []
    method: str = ""


class LoadFlowCasesRequest(ProjectData):
    """The full live project (the implicit "Current network" case) plus the
    saved study cases to run alongside it."""
    cases: list[LoadFlowCaseInput] = []
    includeCurrent: bool = True


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


# ── Lightning Risk Assessment (IEC 62305-2) ──

class LightningLine(BaseModel):
    """A service line (power or telecom) connected to the structure."""
    name: str = "Power supply"
    type: str = "power"                 # power | telecom
    length_m: float = 1000.0            # L_L — use 1000 m when unknown (A.9)
    installation: str = "buried"        # aerial | buried (C_I, Table A.2)
    environment: str = "suburban"       # rural | suburban | urban | urban_tall_buildings (C_E)
    has_transformer: bool = True        # HV/LV transformer at entrance (C_T = 0.2)
    shielded: bool = False              # shielded line bonded at equipment (P_LD)


class LightningRiskRequest(BaseModel):
    # Structure geometry & site
    length_m: float = 20.0
    width_m: float = 15.0
    height_m: float = 8.0
    location: str = "surrounded_same_height"  # C_D key (Table A.1)
    ground_flash_density: float = 4.0   # N_G flashes/km²/yr
    # Occupancy & use
    structure_use: str = "other"        # LF_BY_USE key (Table C.2)
    persons_in_zone: float = 10
    persons_total: float = 10
    hours_per_year: float = 8760.0      # t_z
    hazard_level: str = "none"          # h_z key (Table C.6)
    # Construction & fire
    floor_type: str = "agricultural_concrete"  # r_t key (Table C.3)
    fire_risk: str = "ordinary"         # r_f key (Table C.5)
    fire_protection: str = "none"       # r_p key (Table C.4)
    explosion_risk: bool = False
    # Internal systems
    equipment_withstand_kv: float = 2.5  # U_W for K_S4 / P_LI
    # Existing protection
    lps_class: str = "none"             # none | IV | III | II | I
    spd_level: str = "none"             # none | III-IV | II | I
    # Service lines
    lines: list[LightningLine] = []


class LightningRiskComponentRow(BaseModel):
    code: str                           # RA, RB, ...
    description: str
    value: float                        # contribution to R1 (per year)
    share_pct: float


class LightningProtectionOption(BaseModel):
    lps_class: str
    spd_level: str
    label: str
    r1: float
    compliant: bool


class LightningRiskResult(BaseModel):
    collection_area_m2: float           # A_D
    collection_area_near_m2: float      # A_M
    flashes_to_structure_per_year: float   # N_D
    flashes_near_structure_per_year: float  # N_M
    r1: float
    tolerable_r1: float
    compliant: bool
    components: list[LightningRiskComponentRow]
    options: list[LightningProtectionOption]
    recommendation: str
    systems_life_risk: bool
    warnings: list[str] = []


# ── Raceway / Conduit Fill Analysis ──

class RacewayCable(BaseModel):
    cable_id: str
    name: str = ""
    size_mm2: float = 0.0        # conductor cross-section, for OD estimation
    od_mm: float = 0.0           # explicit overall diameter override (mm)
    rated_amps: float = 0.0      # base ampacity before grouping derating
    load_amps: float = 0.0       # operating current, if known (0 = unknown)


class RacewayDef(BaseModel):
    name: str = "Raceway"
    conduit_nominal_mm: float = 50.0
    conduit_id_mm: float = 0.0   # explicit internal diameter override (mm)
    cables: list[RacewayCable] = []


class RacewayRequest(BaseModel):
    raceways: list[RacewayDef] = []


class RacewayCableRow(BaseModel):
    cable_id: str
    name: str
    od_mm: float
    od_estimated: bool
    area_mm2: float
    rated_amps: float
    derated_amps: float
    load_amps: float
    adequate: bool


class RacewayResult(BaseModel):
    name: str
    conduit_nominal_mm: float
    conduit_id_mm: float
    conduit_area_mm2: float
    cable_area_mm2: float
    num_cables: int
    fill_pct: float
    fill_limit_pct: float
    fill_ok: bool
    jam_ratio: Optional[float] = None
    jam_warning: bool = False
    grouping_factor: float
    cables: list[RacewayCableRow] = []
    status: str                  # pass | warning | fail | empty
    warnings: list[str] = []


class RacewayResults(BaseModel):
    raceways: list[RacewayResult] = []
    summary: dict = {}


# ── DC Load Flow (resistive nodal power flow) ──

class DCLoadFlowBus(BaseModel):
    bus_id: str
    bus_name: str = ""
    voltage_v: float                 # Solved DC bus voltage (V)
    nominal_v: float                 # Nominal DC voltage (V)
    voltage_pu: float                # voltage_v / nominal_v
    drop_pct: float = 0              # Deviation from nominal (%), positive = sag
    load_kw: float = 0               # Local DC load drawn at this bus (kW)
    energized: bool = True           # False when the bus has no reachable source


class DCLoadFlowBranch(BaseModel):
    elementId: str
    element_name: str = ""
    from_bus: str
    to_bus: str
    current_a: float                 # Branch current (A), sign per from→to
    voltage_drop_v: float = 0        # |V_from − V_to| across the branch (V)
    loss_kw: float = 0               # I²R loss in the branch (kW)
    resistance_ohm: float = 0        # Loop resistance used (Ω)
    loading_pct: float = 0           # |I| / cable ampacity (%)


class DCLoadFlowSource(BaseModel):
    source_id: str
    source_name: str = ""
    source_type: str = ""            # rectifier | charger | dc_battery
    bus_id: str = ""
    voltage_v: float = 0             # Terminal voltage (V)
    current_a: float = 0             # Output current (A), positive = discharging
    power_kw: float = 0
    loading_pct: float = 0           # |output| / rated (%)
    current_limited: bool = False    # True when clamped to its rated current


class DCLoadFlowResults(BaseModel):
    buses: dict[str, DCLoadFlowBus] = {}
    branches: list[DCLoadFlowBranch] = []
    sources: list[DCLoadFlowSource] = []
    warnings: list[LoadFlowWarning] = []
    converged: bool = True
    iterations: int = 0
    method: str = "DC Nodal (resistive)"


# ── DC Short Circuit (IEC 61660-1) ──

class DCShortCircuitContribution(BaseModel):
    source_id: str
    source_name: str = ""
    source_type: str = ""            # dc_battery | rectifier | charger
    ik_ka: float = 0                 # Quasi steady-state SC current (kA)
    ip_ka: float = 0                 # Peak SC current (kA)
    tp_ms: float = 0                 # Time to peak (ms)
    r_mohm: float = 0                # Source-branch resistance to the fault (mΩ)


class DCShortCircuitBus(BaseModel):
    bus_id: str
    bus_name: str = ""
    nominal_v: float = 0
    ik_ka: float = 0                 # Total quasi steady-state SC current (kA)
    ip_ka: float = 0                 # Total peak SC current (kA)
    tp_ms: float = 0                 # Time to peak of the combined current (ms)
    time_constant_ms: float = 0      # Dominant rise time constant τ (ms)
    contributions: list[DCShortCircuitContribution] = []
    note: str = ""


class DCShortCircuitResults(BaseModel):
    buses: dict[str, DCShortCircuitBus] = {}
    warnings: list[LoadFlowWarning] = []
    converged: bool = True
    method: str = "IEC 61660-1"
    standard: str = "IEC 61660-1"


# ── Voltage Stability (P-V / Q-V, loadability margin) ──

class PVBusCurve(BaseModel):
    """One bus's voltage trajectory over the P-V load-scaling sweep.

    v_pu is aligned index-for-index with the top-level ``lam`` / ``load_mw``
    arrays; an entry is null where that bus was de-energized at that λ."""
    bus_id: str
    bus_name: str = ""
    is_critical: bool = False
    v_pu: list[Optional[float]] = []


class QVCurvePoint(BaseModel):
    v_pu: float                      # held bus voltage (p.u.)
    q_mvar: float                    # reactive injection required to hold it (MVAr)


class VoltageStabilityResults(BaseModel):
    converged: bool = True           # base case solved
    collapsed: bool = False          # a nose was found within lambda_max
    lambda_critical: float = 1.0     # load-scale factor at the collapse point
    loading_margin_pct: float = 0.0  # (lambda_critical − 1) × 100
    base_load_mw: float = 0.0
    critical_load_mw: float = 0.0    # total demand at the nose
    critical_bus_id: str = ""
    critical_bus_name: str = ""
    nose_v_pu: float = 0.0           # weakest-bus voltage at the nose
    # P-V curve arrays (index-aligned)
    lam: list[float] = []
    load_mw: list[float] = []
    min_v_pu: list[float] = []       # weakest-bus voltage at each λ
    bus_curves: list[PVBusCurve] = []
    # Q-V reactive-margin curve at the critical / requested bus
    qv_bus_id: str = ""
    qv_bus_name: str = ""
    qv_curve: list[QVCurvePoint] = []
    # [EE-7] qv_min_mvar is the NET-INJECTION minimum (condenser Q minus the
    # bus's local reactive load) — at a load bus it is offset from the
    # classical fictitious-condenser margin by exactly the local Q load.
    # qv_margin_mvar (operating point → curve bottom distance) is offset-free
    # and is the figure to quote as the reactive margin.
    qv_min_mvar: Optional[float] = None      # bottom of the Q-V curve (net injection)
    # [EE-R2-2] Condenser-output view of the curve bottom: net-injection min
    # plus the bus's local reactive load — the figure comparable to a
    # condenser / SVC datasheet rating.
    qv_condenser_min_mvar: Optional[float] = None
    qv_local_load_mvar: Optional[float] = None  # local Q load at the Q-V bus
    qv_margin_mvar: Optional[float] = None   # op-point Q − curve-bottom Q (reactive margin)
    qv_operating_v_pu: Optional[float] = None
    qv_operating_mvar: Optional[float] = None
    method: str = "P-V load-scaling continuation"
    warnings: list[str] = []
    note: str = ""


class VoltageStabilityRequest(ProjectData):
    """ProjectData plus voltage-stability sweep options (all optional)."""
    qv_bus_id: Optional[str] = None          # None → auto (weakest bus)
    step: Optional[float] = None             # λ increment (default 0.10)
    lambda_max: Optional[float] = None       # λ cap (default 4.0)
    v_floor: Optional[float] = None          # collapse floor p.u. (default 0.40)


# ── Contingency Analysis (N-1 / N-2) ──

class ContingencyViolation(BaseModel):
    kind: str                        # overload | undervoltage | overvoltage | deenergized | non_converged
    element_id: str = ""
    element_name: str = ""
    value: float = 0.0               # actual value (loading %, p.u., or MW lost)
    limit: float = 0.0               # the limit breached
    detail: str = ""


class ContingencyResult(BaseModel):
    id: str
    label: str = ""
    outaged_ids: list[str] = []
    outaged_names: str = ""
    order: int = 1                   # 1 = N-1, 2 = N-2
    converged: bool = True
    status: str = "secure"           # secure | violations | islanded | non_converged
    violation_count: int = 0
    max_loading_pct: float = 0.0
    worst_branch: str = ""
    min_v_pu: float = 0.0
    max_v_pu: float = 0.0
    lost_load_mw: float = 0.0
    violations: list[ContingencyViolation] = []


class ContingencyResults(BaseModel):
    base_converged: bool = True
    base_violation_count: int = 0
    base_violations: list[ContingencyViolation] = []
    n_minus_1_secure: bool = True
    n_minus_1_count: int = 0
    analyzed: int = 0
    skipped: int = 0
    mode: str = "N-1"
    worst_case_id: str = ""
    worst_case_label: str = ""
    limits: dict = {}
    contingencies: list[ContingencyResult] = []
    method: str = "Load-flow contingency screening"
    warnings: list[str] = []


class ContingencyRequest(ProjectData):
    """ProjectData plus contingency screening options (all optional)."""
    include_n2: bool = False
    v_min: Optional[float] = None            # default 0.95
    v_max: Optional[float] = None            # default 1.05
    loading_limit_pct: Optional[float] = None  # default 100
    max_contingencies: Optional[int] = None  # N-2 pair cap (default 400)


# ── Time-series / quasi-dynamic load flow ──

class TimeSeriesBusEnvelope(BaseModel):
    """Min/max voltage a bus sees over the horizon, and the step each occurred."""
    bus_id: str
    bus_name: str = ""
    min_v_pu: float = 0.0
    min_v_step: int = 0
    max_v_pu: float = 0.0
    max_v_step: int = 0


class TimeSeriesBranchPeak(BaseModel):
    """Worst thermal loading a branch sees over the horizon."""
    element_id: str
    element_name: str = ""
    peak_loading_pct: float = 0.0
    peak_step: int = 0
    peak_p_mw: float = 0.0


class TimeSeriesBatteryTrajectory(BaseModel):
    """SoC trajectory for one BESS / hybrid-PV battery, carried between steps."""
    battery_id: str
    battery_name: str = ""
    soc_pct: list[float] = []
    dispatched_mw: list[float] = []   # +discharge / −charge, AC side, per step


class TimeSeriesLoadFlowResults(BaseModel):
    """Quasi-dynamic time-series load flow — the existing balanced solver
    re-run at each time step over a load/generation profile, with BESS state
    of charge and OLTC tap position carried forward step-to-step (not
    independently re-derived — that is what makes this "quasi-dynamic" rather
    than N unrelated snapshots)."""
    converged: bool = True                 # False only if every step failed
    steps: int = 0
    step_minutes: float = 60.0
    horizon_hours: float = 24.0
    t_hours: list[float] = []              # step timestamps, hours from t=0
    non_converged_steps: list[int] = []
    violation_step_count: int = 0          # steps with any V/thermal violation
    total_losses_mwh: float = 0.0          # Σ losses_mw × dt, integrated over the horizon
    bus_envelopes: list[TimeSeriesBusEnvelope] = []
    branch_peaks: list[TimeSeriesBranchPeak] = []
    battery_trajectories: list[TimeSeriesBatteryTrajectory] = []
    # Network-wide per-step series, for the results chart:
    # None at a non-converged step (excluded from the aggregates/chart gap).
    min_v_pu_series: list[Optional[float]] = []
    max_v_pu_series: list[Optional[float]] = []
    max_loading_pct_series: list[Optional[float]] = []
    losses_mw_series: list[Optional[float]] = []
    limits: dict = {}
    solve_time_s: float = 0.0
    method: str = "newton_raphson"
    profiles_used: dict = {}                # component_id -> profile name assigned
    warnings: list[str] = []
    note: str = ""


class TimeSeriesLoadFlowRequest(ProjectData):
    """ProjectData plus time-series sweep options (all optional)."""
    horizon_hours: Optional[float] = None    # default 24
    step_minutes: Optional[float] = None     # default 60
    default_profile: Optional[str] = None    # overrides the per-type default
    profile_overrides: dict[str, str] = {}   # component_id -> built-in profile name
    v_min: Optional[float] = None            # default 0.95 (violation counting only)
    v_max: Optional[float] = None            # default 1.05
    loading_limit_pct: Optional[float] = None  # default 100


# ── Harmonic Analysis (IEEE 519-2014) ──

class ReliabilityResults(BaseModel):
    model_config = {"extra": "allow"}

    converged: bool = False
    indices: dict = {}                 # SAIFI/SAIDI/CAIDI/ASAI/MAIFI/EENS
    fmea: list[dict] = []              # per failure mode, ranked by SAIDI
    load_points: list[dict] = []       # per-bus λ, unavailability, CAIDI
    method: str = ""
    warnings: list[str] = []
    note: str = ""


class FilterSizingRequest(ProjectData):
    """ProjectData plus passive-filter sizing options (all optional)."""
    filter_bus_id: Optional[str] = None    # None → worst-THD bus
    total_kvar: Optional[float] = None     # None → island reactive demand
    quality_factor: Optional[float] = None # default 30
    max_branches: Optional[int] = None     # default 3 (≤4)


class FilterSizingResults(BaseModel):
    model_config = {"extra": "allow"}

    converged: bool = False
    bus_id: str = ""
    bus_name: str = ""
    voltage_kv: float = 0.0
    total_kvar: float = 0.0
    design: list[dict] = []            # per branch: order, tuning, kvar, C/L/R
    meets_ieee519: bool = False
    baseline: dict = {}                # THD/compliance before
    with_filter: dict = {}             # THD/compliance after
    method: str = ""
    warnings: list[str] = []
    note: str = ""


class HostingCapacityRequest(ProjectData):
    """ProjectData plus nodal hosting-capacity options (all optional)."""
    candidate_bus_ids: Optional[list[str]] = None  # None → all energized buses
    hc_power_factor: Optional[float] = None    # DER power factor (default 1.0)
    v_min: Optional[float] = None              # default 0.95
    v_max: Optional[float] = None              # default 1.05
    loading_limit_pct: Optional[float] = None  # default 100
    step_mw: Optional[float] = None            # sweep resolution (default 0.5)
    max_mw_per_bus: Optional[float] = None     # search cap (default 10.0)
    # Fault-level / protection screen (Fault Analysis + Duty Check re-run at
    # each bus's discovered capacity). On by default — a hosting-capacity
    # answer that ignores switchgear duty is not a usable answer.
    fault_screen: Optional[bool] = None            # default True
    fault_rise_limit_pct: Optional[float] = None   # default 10.0
    der_share_limit_pct: Optional[float] = None    # default 10.0


class HostingCapacityResults(BaseModel):
    model_config = {"extra": "allow"}

    converged: bool = False
    buses: list[dict] = []             # per-bus hosting_capacity_mw + limiting factor
    power_factor: float = 1.0
    v_min: float = 0.95
    v_max: float = 1.05
    loading_limit_pct: float = 100.0
    step_mw: float = 0.5
    max_mw_per_bus: float = 10.0
    fault_screen: bool = True
    fault_rise_limit_pct: float = 10.0
    der_share_limit_pct: float = 10.0
    method: str = ""
    warnings: list[str] = []
    note: str = ""


class FlickerAnalysisRequest(ProjectData):
    """ProjectData plus voltage-flicker screening options (all optional)."""
    pst_limit: Optional[float] = None        # default 1.0 (IEC 61000-3-3 LV)
    plt_limit: Optional[float] = None        # default 0.65 (IEC 61000-3-3 LV)
    d_anchor_pct: Optional[float] = None      # curve calibration (default 3.0)
    exponent: Optional[float] = None          # curve exponent (default 0.31)


class FlickerAnalysisResults(BaseModel):
    model_config = {"extra": "allow"}

    converged: bool = False
    sources: list[dict] = []           # per-motor Pst/Plt + compliance
    compliant: bool = True
    d_anchor_pct: float = 3.0
    exponent: float = 0.31
    method: str = ""
    warnings: list[str] = []
    note: str = ""


class CapacitorPlacementRequest(ProjectData):
    """ProjectData plus capacitor-placement options (all optional)."""
    candidate_bus_ids: Optional[list[str]] = None   # None → all energized buses
    unit_kvar: Optional[float] = None               # standard bank unit (default 100)
    max_kvar_per_bus: Optional[float] = None        # default 2000
    max_total_kvar: Optional[float] = None          # default 5000
    v_min: Optional[float] = None                   # default 0.95
    v_max: Optional[float] = None                   # default 1.05


class CapacitorPlacementResults(BaseModel):
    model_config = {"extra": "allow"}

    converged: bool = False
    unit_kvar: float = 0.0
    total_kvar: float = 0.0
    placements: list[dict] = []        # per-bus recommended kvar + voltages
    moves: list[dict] = []             # greedy placement log
    baseline: dict = {}
    optimized: dict = {}
    loss_reduction_kw: float = 0.0
    energy_savings_mwh_yr: float = 0.0
    savings_per_yr: float = 0.0
    method: str = ""
    warnings: list[str] = []
    note: str = ""


class OPFRequest(ProjectData):
    """ProjectData plus OPF options (all optional)."""
    objective: Optional[str] = None            # 'cost' (default) | 'loss'
    v_min: Optional[float] = None              # voltage band (default 0.95)
    v_max: Optional[float] = None              # (default 1.05)
    loading_limit_pct: Optional[float] = None  # thermal limit (default 100)
    use_dispatch: Optional[bool] = None        # economic re-dispatch (default on)
    use_capacitors: Optional[bool] = None      # cap steps control (default on)
    use_taps: Optional[bool] = None            # transformer taps (default on)
    use_setpoints: Optional[bool] = None       # gen/utility V setpoints (default on)
    max_moves: Optional[int] = None            # hill-climb move budget (default 25)


class OPFResults(BaseModel):
    model_config = {"extra": "allow"}

    converged: bool = False
    objective: str = "cost"
    baseline: dict = {}                # {cost_per_h, losses_mw, violations[]}
    optimized: dict = {}
    savings_per_h: float = 0.0
    loss_reduction_kw: float = 0.0
    moves: list[dict] = []             # applied control moves (from → to)
    settings: list[dict] = []          # final control values
    dispatch: list[dict] = []          # per-source MW + cost
    lf_evaluations: int = 0
    method: str = ""
    warnings: list[str] = []
    note: str = ""


class BatterySizingRequest(ProjectData):
    """ProjectData plus battery-sizing options (all optional)."""
    battery_id: Optional[str] = None           # None → first battery-backed unit
    duty_cycle: Optional[list[dict]] = None    # [{duration_min, load_kw}]; None → island load
    aging_factor: Optional[float] = None       # default 1.25 (IEEE 485 §6.3.3)
    design_margin: Optional[float] = None      # default 1.10 (IEEE 485 §6.3.2)
    temperature_c: Optional[float] = None      # default 25 °C
    autonomy_target_min: Optional[float] = None  # derived-duty duration (default 120)


class BatterySizingResults(BaseModel):
    model_config = {"extra": "allow"}

    converged: bool = False
    battery_id: str = ""
    battery_name: str = ""
    chemistry: str = ""
    installed_kwh: float = 0.0
    required_kwh: float = 0.0
    required_ah: float = 0.0
    sized_ok: bool = False
    duty: list[dict] = []
    duty_kwh: float = 0.0
    peak_kw: float = 0.0
    factors: dict = {}
    violations: list[dict] = []
    trajectory: dict = {}              # {t_min[], soc_pct[], v_pu[], load_kw[]}
    runtime_to_floor_min: Optional[float] = None
    min_v_pu: Optional[float] = None
    method: str = ""
    warnings: list[str] = []
    note: str = ""


class FrequencyScanRequest(ProjectData):
    """ProjectData plus frequency-scan sweep options (all optional)."""
    scan_bus_ids: Optional[list[str]] = None   # None → all (non-synthetic) buses
    h_max: Optional[float] = None              # top harmonic order (default 25)
    h_step: Optional[float] = None             # sweep resolution (default 0.05)


class FrequencyScanResults(BaseModel):
    model_config = {"extra": "allow"}

    converged: bool = False
    f0_hz: float = 50.0
    h_max: float = 0.0
    h_step: float = 0.0
    h: list[float] = []               # swept harmonic orders (x-axis)
    buses: list[dict] = []            # per-bus {id, name, voltage_kv, z1_ohm, z_ohm[]}
    resonances: list[dict] = []       # {bus_id, bus_name, kind, h, f_hz, z_ohm, z_pu, prominence}
    worst_bus_id: str = ""
    worst_bus_name: str = ""
    worst_h: float = 0.0
    worst_f_hz: float = 0.0
    worst_z_ohm: float = 0.0
    method: str = ""
    warnings: list[str] = []
    note: str = ""


class HarmonicsResults(BaseModel):
    model_config = {"extra": "allow"}

    converged: bool = False
    fundamental_converged: bool = False
    orders: list[int] = []
    buses: list[dict] = []            # per-bus THD_V / IHD / compliance
    worst_thd_pct: float = 0.0
    worst_bus_id: str = ""
    worst_bus_name: str = ""
    pcc: Optional[dict] = None        # PCC current TDD + IEEE 519 verdict
    vfd_sources: list[dict] = []      # per-VFD current spectrum
    compliant: bool = True
    method: str = "Frequency-domain harmonic current-injection (IEEE 519-2014)"
    warnings: list[str] = []
    note: str = ""


class WennerReading(BaseModel):
    """One field measurement from a Wenner four-pin test."""
    model_config = {"extra": "allow"}

    spacing_m: float                        # probe spacing a (m)
    apparent_resistivity_ohm_m: float       # ρa measured at that spacing (Ω·m)


class WennerTestRequest(BaseModel):
    readings: list[WennerReading] = []


class WennerTestResults(BaseModel):
    model_config = {"extra": "allow"}

    rho1_ohm_m: float = 0.0
    rho2_ohm_m: float = 0.0
    upper_layer_thickness_m: float = 0.0
    rmse_pct: float = 0.0
    converged: bool = False
    points: list[dict] = []
    method: str = "Sunde two-layer earth model, nonlinear least squares (IEEE Std 81)"
