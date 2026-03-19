"""Report export routes — CSV and PDF generation."""

import csv
import io
import json
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from ..models.database import get_db, Project
from ..models.schemas import ProjectData
from ..analysis.fault import run_fault_analysis
from ..analysis.loadflow import run_load_flow

router = APIRouter(prefix="/projects", tags=["reports"])


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


@router.get("/{project_id}/export/pdf")
def export_pdf(project_id: int, db: Session = Depends(get_db)):
    """Export analysis results as PDF."""
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    data = ProjectData(**json.loads(project.data))
    fault = run_fault_analysis(data)
    loadflow = run_load_flow(data)

    try:
        from reportlab.lib.pagesizes import A4
        from reportlab.lib import colors
        from reportlab.lib.units import mm
        from reportlab.platypus import (
            SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
        )
        from reportlab.lib.styles import getSampleStyleSheet
    except ImportError:
        raise HTTPException(status_code=500, detail="ReportLab not installed. Install with: pip install reportlab")

    buffer = io.BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=A4,
                            topMargin=20*mm, bottomMargin=20*mm,
                            leftMargin=15*mm, rightMargin=15*mm)
    styles = getSampleStyleSheet()
    elements = []

    # Title
    elements.append(Paragraph(f"ProtectionPro — Analysis Report", styles['Title']))
    elements.append(Paragraph(f"Project: {data.projectName}", styles['Normal']))
    elements.append(Paragraph(f"Base MVA: {data.baseMVA} | Frequency: {data.frequency} Hz", styles['Normal']))
    elements.append(Spacer(1, 10*mm))

    # Fault Analysis Table
    elements.append(Paragraph("Fault Analysis — IEC 60909 (Symmetrical)", styles['Heading2']))
    fault_data = [["Bus", "Voltage (kV)", "I\"k3 (kA)", "I\"k1 (kA)", "I\"kLL (kA)"]]
    for result in fault.buses.values():
        fault_data.append([
            result.bus_name, f"{result.voltage_kv:.1f}",
            f"{result.ik3:.3f}" if result.ik3 else "—",
            f"{result.ik1:.3f}" if result.ik1 else "—",
            f"{result.ikLL:.3f}" if result.ikLL else "—",
        ])

    if len(fault_data) > 1:
        t = Table(fault_data, repeatRows=1)
        t.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#0078d7')),
            ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
            ('FONTSIZE', (0, 0), (-1, -1), 9),
            ('GRID', (0, 0), (-1, -1), 0.5, colors.grey),
            ('ALIGN', (1, 0), (-1, -1), 'RIGHT'),
            ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#f5f5f5')]),
        ]))
        elements.append(t)
    else:
        elements.append(Paragraph("No fault data available.", styles['Normal']))

    elements.append(Spacer(1, 8*mm))

    # Load Flow Table
    method_label = "Newton-Raphson" if loadflow.method == "newton_raphson" else "Gauss-Seidel"
    conv_label = "Converged" if loadflow.converged else "Did NOT converge"
    elements.append(Paragraph(
        f"Load Flow — {method_label} ({conv_label}, {loadflow.iterations} iterations)",
        styles['Heading2']
    ))

    lf_data = [["Bus", "V (p.u.)", "V (kV)", "Angle (°)", "P (MW)", "Q (MVAr)"]]
    for result in loadflow.buses.values():
        lf_data.append([
            result.bus_name,
            f"{result.voltage_pu:.4f}", f"{result.voltage_kv:.2f}",
            f"{result.angle_deg:.2f}",
            f"{result.p_mw:.3f}", f"{result.q_mvar:.3f}",
        ])

    if len(lf_data) > 1:
        t = Table(lf_data, repeatRows=1)
        t.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#2e7d32')),
            ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
            ('FONTSIZE', (0, 0), (-1, -1), 9),
            ('GRID', (0, 0), (-1, -1), 0.5, colors.grey),
            ('ALIGN', (1, 0), (-1, -1), 'RIGHT'),
            ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#f5f5f5')]),
        ]))
        elements.append(t)

    doc.build(elements)
    buffer.seek(0)
    return StreamingResponse(
        buffer,
        media_type="application/pdf",
        headers={"Content-Disposition": f"attachment; filename=protectionpro_report_{project_id}.pdf"}
    )
