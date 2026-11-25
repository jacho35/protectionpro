"""Report export routes — CSV and PDF generation."""

import csv
import io
import json
from typing import Optional
from pydantic import BaseModel, field_validator
from ._http import content_disposition
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from ..models.database import get_db, Project
from ..models.schemas import ProjectData
from ..analysis.changeover import expand_changeovers
from ..analysis.offpage import expand_offpage_links
from ..auth import get_current_user, require_project
from ..analysis.fault import run_fault_analysis
from ..analysis.loadflow import run_load_flow
from ..analysis.deliverables_pack import build_pack, PackError
from ..analysis.pdf_reports import generate_full_report, generate_arcflash_labels, generate_calculations_report
from ..analysis.solar_report import generate_solar_report

router = APIRouter(prefix="/projects", tags=["reports"])


# ── New POST-based PDF endpoints (use current app state, no project ID needed) ──

_MAX_IMAGE_CHARS = 28_000_000   # ~20 MB of image once decoded


class ReportRequest(BaseModel):
    """Request body for server-side PDF generation."""
    projectName: str = "Untitled Project"
    baseMVA: float = 100.0
    frequency: int = 50
    components: list[dict] = []
    faultResults: Optional[dict] = None
    loadFlowResults: Optional[dict] = None
    arcFlashResults: Optional[dict] = None
    dbCheckResults: Optional[dict] = None  # per-way DB circuit-check verdicts
    sections: Optional[list[str]] = None  # which report sections to include
    diagramImage: Optional[str] = None  # base64-encoded PNG of the single-line diagram
    dbDiagrams: Optional[dict] = None  # board id -> base64 PNG of its DB single line
    projectDetails: Optional[dict] = None  # project metadata for cover page

    @field_validator("diagramImage")
    @classmethod
    def _image_size(cls, v):
        if v is not None and len(v) > _MAX_IMAGE_CHARS:
            raise ValueError("diagramImage is too large")
        return v

    @field_validator("dbDiagrams")
    @classmethod
    def _images_size(cls, v):
        if v is not None and sum(len(x) for x in v.values() if isinstance(x, str)) > _MAX_IMAGE_CHARS:
            raise ValueError("dbDiagrams are too large")
        return v


class CalculationsReportRequest(BaseModel):
    """Request body for the detailed calculations report."""
    projectName: str = "Untitled Project"
    baseMVA: float = 100.0
    frequency: int = 50
    components: list[dict] = []
    faultResults: Optional[dict] = None
    loadFlowResults: Optional[dict] = None
    arcFlashResults: Optional[dict] = None
    cableSizingResults: Optional[dict] = None
    motorStartingResults: Optional[dict] = None
    dynamicMotorResults: Optional[dict] = None
    stabilityResults: Optional[dict] = None
    dutyCheckResults: Optional[dict] = None
    loadDiversityResults: Optional[dict] = None
    groundingResults: Optional[dict] = None
    projectDetails: Optional[dict] = None  # project metadata for cover page


class SolarReportRequest(BaseModel):
    """Request body for the Solar PV design report: what the Solar PV Design modal already computed."""
    projectName: str = "Untitled Project"
    inputs: dict = {}
    result: dict
    strings: Optional[dict] = None
    protection: Optional[dict] = None
    shading: Optional[dict] = None
    images: Optional[list[dict]] = None       # [{title, png}] pictures of the roofs: data URLs (JPEG / PNG)
    projectDetails: Optional[dict] = None

    @field_validator("images")
    @classmethod
    def _images_size(cls, v):
        if v is not None and (len(v) > 6 or sum(len(str(x.get("png", ""))) for x in v) > _MAX_IMAGE_CHARS):
            raise ValueError("images are too large")
        return v


report_router = APIRouter(prefix="/reports", tags=["reports"])


@report_router.post("/pdf")
def generate_pdf_report(req: ReportRequest):
    """Generate a PDF report from current analysis results."""
    buf = generate_full_report(
        project_name=req.projectName,
        base_mva=req.baseMVA,
        frequency=req.frequency,
        fault_results=req.faultResults,
        loadflow_results=req.loadFlowResults,
        arcflash_results=req.arcFlashResults,
        components=req.components,
        sections=req.sections,
        diagram_image=req.diagramImage,
        project_details=req.projectDetails,
        db_check_results=req.dbCheckResults,
        db_diagrams=req.dbDiagrams,
    )
    disposition = content_disposition(f"{req.projectName}_report", "pdf")
    return StreamingResponse(
        buf,
        media_type="application/pdf",
        headers={"Content-Disposition": disposition}
    )


@report_router.post("/solar")
def generate_solar_pdf(req: SolarReportRequest):
    """Solar PV design report PDF from the modal's results."""
    try:
        buf = generate_solar_report(req.projectName, {"inputs": req.inputs, "result": req.result, "strings": req.strings,
                                                       "protection": req.protection, "shading": req.shading, "images": req.images}, req.projectDetails)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Solar report generation failed: {exc}") from exc
    return StreamingResponse(buf, media_type="application/pdf",
                             headers={"Content-Disposition": content_disposition(f"{req.projectName}_solar_pv", "pdf")})


@report_router.post("/calculations")
def generate_calculations_pdf(req: CalculationsReportRequest):
    """Generate a detailed calculations report PDF showing formulas and intermediate values."""
    try:
        buf = generate_calculations_report(
            project_name=req.projectName,
            base_mva=req.baseMVA,
            frequency=req.frequency,
            fault_results=req.faultResults,
            loadflow_results=req.loadFlowResults,
            arcflash_results=req.arcFlashResults,
            cable_results=req.cableSizingResults,
            motor_results=req.motorStartingResults,
            dynamic_motor_results=req.dynamicMotorResults,
            stability_results=req.stabilityResults,
            duty_results=req.dutyCheckResults,
            load_diversity_results=req.loadDiversityResults,
            grounding_results=req.groundingResults,
            components=req.components,
            project_details=req.projectDetails,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Calculations report generation failed: {exc}") from exc
    disposition = content_disposition(f"{req.projectName}_calculations", "pdf")
    return StreamingResponse(
        buf,
        media_type="application/pdf",
        headers={"Content-Disposition": disposition}
    )


@report_router.post("/arcflash-labels")
def generate_arcflash_labels_pdf(req: ReportRequest):
    """Generate NFPA 70E arc flash warning labels as PDF."""
    if not req.arcFlashResults or not req.arcFlashResults.get("buses"):
        raise HTTPException(status_code=400, detail="No arc flash results provided.")
    buf = generate_arcflash_labels(
        project_name=req.projectName,
        arcflash_results=req.arcFlashResults,
        components=req.components,
    )
    if not buf:
        raise HTTPException(status_code=400, detail="No arc flash results to generate labels.")
    disposition = content_disposition(f"{req.projectName}_ArcFlash_Labels", "pdf")
    return StreamingResponse(
        buf,
        media_type="application/pdf",
        headers={"Content-Disposition": disposition}
    )


# ── Existing project-ID-based endpoints ──

def _csv_safe(value):
    """Neutralize spreadsheet formula injection in user-controlled string cells.

    String cells starting with =, +, -, @ (or tab/CR) are prefixed with a
    single quote so Excel/LibreOffice treat them as literal text instead of
    evaluating them as formulas (e.g. a bus named `=HYPERLINK(...)`).
    Non-string values (numeric columns) pass through untouched. Structural
    CSV escaping — quoting cells containing commas/quotes/newlines and
    doubling internal quotes — is handled by csv.writer (QUOTE_MINIMAL).
    """
    if isinstance(value, str) and value.startswith(("=", "+", "-", "@", "\t", "\r")):
        return "'" + value
    return value


@router.get("/{project_id}/export/csv")
def export_csv(project_id: int, ctx=Depends(require_project("view"))):
    """Export analysis results as CSV."""
    project, _level = ctx

    data = expand_offpage_links(expand_changeovers(ProjectData(**json.loads(project.data))))

    # Run analyses
    fault = run_fault_analysis(data)
    loadflow = run_load_flow(data)

    output = io.StringIO()
    writer = csv.writer(output)

    # Fault results
    writer.writerow(["=== FAULT ANALYSIS (IEC 60909) ==="])
    writer.writerow(["Bus ID", "Bus Name", "Voltage (kV)", "I\"k3 (kA)", "I\"k1 (kA)", "I\"kLL (kA)"])
    for bus_id, result in fault.buses.items():
        writer.writerow([
            _csv_safe(result.bus_id), _csv_safe(result.bus_name), result.voltage_kv,
            result.ik3, result.ik1, result.ikLL
        ])

    writer.writerow([])

    # Load flow results
    writer.writerow(["=== LOAD FLOW RESULTS ==="])
    writer.writerow(["Method", loadflow.method, "Converged", loadflow.converged, "Iterations", loadflow.iterations])
    writer.writerow(["Bus ID", "Bus Name", "V (p.u.)", "V (kV)", "Angle (deg)", "P (MW)", "Q (MVAr)"])
    for bus_id, result in loadflow.buses.items():
        writer.writerow([
            _csv_safe(result.bus_id), _csv_safe(result.bus_name), result.voltage_pu,
            result.voltage_kv, result.angle_deg, result.p_mw, result.q_mvar
        ])

    if loadflow.branches:
        writer.writerow([])
        writer.writerow(["=== BRANCH FLOWS ==="])
        writer.writerow(["Element", "From Bus", "To Bus", "P (MW)", "Q (MVAr)", "Loading (%)", "Losses (MW)"])
        for br in loadflow.branches:
            writer.writerow([
                _csv_safe(br.elementId), _csv_safe(br.from_bus), _csv_safe(br.to_bus),
                br.p_mw, br.q_mvar, br.loading_pct, br.losses_mw
            ])

    output.seek(0)
    return StreamingResponse(
        output,
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename=protectionpro_report_{project_id}.csv"}
    )


class DeliverablesRequest(BaseModel):
    """The project's deliverables as one PDF: each part is a PDF the client made (base64)."""
    projectName: str = "Untitled Project"
    projectDetails: Optional[dict] = None
    revisions: list[dict] = []
    parts: list[dict]


@report_router.post("/deliverables")
def build_deliverables(req: DeliverablesRequest):
    """Merge the parts into one PDF with a cover, contents, bookmarks and page numbers."""
    try:
        buf, toc = build_pack(req.projectName, req.parts, req.projectDetails, req.revisions)
    except PackError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return StreamingResponse(
        buf, media_type="application/pdf",
        headers={"Content-Disposition": content_disposition(f"{req.projectName}_deliverables", "pdf"),
                 "X-Pack-Pages": str(toc[-1]["first_page"] + toc[-1]["pages"] - 1)})
