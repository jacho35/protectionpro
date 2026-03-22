"""Report export routes — CSV and PDF generation."""

import csv
import io
import json
from typing import Optional
from pydantic import BaseModel
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from ..models.database import get_db, Project
from ..models.schemas import ProjectData
from ..analysis.fault import run_fault_analysis
from ..analysis.loadflow import run_load_flow
from ..analysis.pdf_reports import generate_full_report, generate_arcflash_labels, generate_calculations_report

router = APIRouter(prefix="/projects", tags=["reports"])


# ── New POST-based PDF endpoints (use current app state, no project ID needed) ──

class ReportRequest(BaseModel):
    """Request body for server-side PDF generation."""
    projectName: str = "Untitled Project"
    baseMVA: float = 100.0
    frequency: int = 50
    components: list[dict] = []
    faultResults: Optional[dict] = None
    loadFlowResults: Optional[dict] = None
    arcFlashResults: Optional[dict] = None
    sections: Optional[list[str]] = None  # which report sections to include


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
    dutyCheckResults: Optional[dict] = None
    loadDiversityResults: Optional[dict] = None
    groundingResults: Optional[dict] = None


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
    )
    filename = f"{req.projectName.replace(' ', '_')}_report.pdf"
    return StreamingResponse(
        buf,
        media_type="application/pdf",
        headers={"Content-Disposition": f"attachment; filename={filename}"}
    )


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
            duty_results=req.dutyCheckResults,
            load_diversity_results=req.loadDiversityResults,
            grounding_results=req.groundingResults,
            components=req.components,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Calculations report generation failed: {exc}") from exc
    filename = f"{req.projectName.replace(' ', '_')}_calculations.pdf"
    return StreamingResponse(
        buf,
        media_type="application/pdf",
        headers={"Content-Disposition": f"attachment; filename={filename}"}
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
    filename = f"{req.projectName.replace(' ', '_')}_ArcFlash_Labels.pdf"
    return StreamingResponse(
        buf,
        media_type="application/pdf",
        headers={"Content-Disposition": f"attachment; filename={filename}"}
    )


# ── Existing project-ID-based endpoints ──

@router.get("/{project_id}/export/csv")
def export_csv(project_id: int, db: Session = Depends(get_db)):
    """Export analysis results as CSV."""
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    data = ProjectData(**json.loads(project.data))

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
            result.bus_id, result.bus_name, result.voltage_kv,
            result.ik3, result.ik1, result.ikLL
        ])

    writer.writerow([])

    # Load flow results
    writer.writerow(["=== LOAD FLOW RESULTS ==="])
    writer.writerow(["Method", loadflow.method, "Converged", loadflow.converged, "Iterations", loadflow.iterations])
    writer.writerow(["Bus ID", "Bus Name", "V (p.u.)", "V (kV)", "Angle (deg)", "P (MW)", "Q (MVAr)"])
    for bus_id, result in loadflow.buses.items():
        writer.writerow([
            result.bus_id, result.bus_name, result.voltage_pu,
            result.voltage_kv, result.angle_deg, result.p_mw, result.q_mvar
        ])

    if loadflow.branches:
        writer.writerow([])
        writer.writerow(["=== BRANCH FLOWS ==="])
        writer.writerow(["Element", "From Bus", "To Bus", "P (MW)", "Q (MVAr)", "Loading (%)", "Losses (MW)"])
        for br in loadflow.branches:
            writer.writerow([
                br.elementId, br.from_bus, br.to_bus,
                br.p_mw, br.q_mvar, br.loading_pct, br.losses_mw
            ])

    output.seek(0)
    return StreamingResponse(
        output,
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename=protectionpro_report_{project_id}.csv"}
    )
