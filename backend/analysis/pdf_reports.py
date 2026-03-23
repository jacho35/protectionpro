"""Server-side PDF report generation using fpdf2."""

import base64
import io
import math
import tempfile
from datetime import date
from fpdf import FPDF


def _safe(text):
    """Replace Unicode chars that core fonts can't handle."""
    return str(text).replace("\u2014", "-").replace("\u2013", "-").replace("\u00b2", "2").replace("\u00b0", " deg").replace("\u2022", "-")


class SafePDF(FPDF):
    """FPDF subclass that sanitizes Unicode text for core fonts."""

    def cell(self, *args, **kwargs):
        # Sanitize text argument (3rd positional or 'text'/'txt' keyword)
        args = list(args)
        if len(args) > 2 and isinstance(args[2], str):
            args[2] = _safe(args[2])
        for k in ("text", "txt"):
            if k in kwargs and isinstance(kwargs[k], str):
                kwargs[k] = _safe(kwargs[k])
        return super().cell(*args, **kwargs)

    def text(self, x, y, txt=""):
        return super().text(x, y, _safe(txt))


class ReportPDF(SafePDF):
    """Custom PDF with header/footer for ProtectionPro reports."""

    def __init__(self, project_name="Untitled Project", **kwargs):
        super().__init__(orientation="landscape", unit="mm", format="A4", **kwargs)
        self.project_name = project_name
        self.set_auto_page_break(auto=True, margin=15)

    def header(self):
        if self.page_no() == 1:
            return  # Title page has custom header
        self.set_font("Helvetica", "I", 8)
        self.set_text_color(150, 150, 150)
        self.cell(0, 5, f"ProtectionPro — {self.project_name}", align="L")
        self.ln(8)
        self.set_text_color(0, 0, 0)

    def footer(self):
        self.set_y(-10)
        self.set_font("Helvetica", "I", 8)
        self.set_text_color(150, 150, 150)
        self.cell(0, 5, f"Page {self.page_no()}/{{nb}}", align="C")
        self.set_text_color(0, 0, 0)

    def section_title(self, title):
        self.set_font("Helvetica", "B", 14)
        self.cell(0, 8, title, new_x="LMARGIN", new_y="NEXT")
        self.ln(2)


def _table(pdf, headers, rows, col_widths=None, header_color=(0, 120, 215)):
    """Render a table with alternating row colors."""
    if col_widths is None:
        avail = pdf.w - pdf.l_margin - pdf.r_margin
        col_widths = [avail / len(headers)] * len(headers)

    # Header
    pdf.set_font("Helvetica", "B", 8)
    pdf.set_fill_color(*header_color)
    pdf.set_text_color(255, 255, 255)
    for i, h in enumerate(headers):
        pdf.cell(col_widths[i], 6, h, border=1, fill=True, align="C")
    pdf.ln()
    pdf.set_text_color(0, 0, 0)

    # Rows
    pdf.set_font("Helvetica", "", 8)
    for ri, row in enumerate(rows):
        if ri % 2 == 1:
            pdf.set_fill_color(245, 245, 245)
        else:
            pdf.set_fill_color(255, 255, 255)
        for i, val in enumerate(row):
            align = "L" if i == 0 else "R"
            pdf.cell(col_widths[i], 5, str(val), border=1, fill=True, align=align)
        pdf.ln()
        # Page break check
        if pdf.get_y() > pdf.h - 20:
            pdf.add_page()


def generate_full_report(project_name, base_mva, frequency,
                         fault_results=None, loadflow_results=None,
                         arcflash_results=None, components=None,
                         sections=None, diagram_image=None):
    """Generate a full analysis report PDF.

    Args:
        sections: list of section IDs to include. If None, include all available.
        diagram_image: base64-encoded PNG of the single-line diagram.
    """
    pdf = ReportPDF(project_name=project_name)
    pdf.alias_nb_pages()

    all_sections = sections or ["title", "fault", "fault_branches", "voltage_depression",
                                "loadflow_bus", "loadflow_branch", "equipment",
                                "settings_schedule", "arcflash"]

    comp_map = {}
    if components:
        for c in components:
            comp_map[c.get("id", c.get("bus_id", ""))] = c

    for sec in all_sections:
        if sec == "title":
            _render_title(pdf, project_name, base_mva, frequency)
        elif sec == "diagram":
            _render_diagram(pdf, diagram_image)
        elif sec == "fault":
            _render_fault_table(pdf, fault_results, comp_map)
        elif sec == "fault_branches":
            _render_fault_branches(pdf, fault_results, comp_map)
        elif sec == "voltage_depression":
            _render_voltage_depression(pdf, fault_results, comp_map)
        elif sec == "loadflow_bus":
            _render_loadflow_bus(pdf, loadflow_results)
        elif sec == "loadflow_branch":
            _render_loadflow_branch(pdf, loadflow_results)
        elif sec == "equipment":
            _render_equipment(pdf, components)
        elif sec == "settings_schedule":
            _render_settings_schedule(pdf, components)
        elif sec == "arcflash":
            _render_arcflash(pdf, arcflash_results, comp_map)

    buf = io.BytesIO()
    pdf.output(buf)
    buf.seek(0)
    return buf


def _render_title(pdf, project_name, base_mva, frequency):
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 22)
    pdf.ln(30)
    pdf.cell(0, 12, "ProtectionPro — Analysis Report", align="C", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 12)
    pdf.ln(8)
    pdf.cell(0, 8, f"Project: {project_name}", align="C", new_x="LMARGIN", new_y="NEXT")
    pdf.cell(0, 8, f"Base MVA: {base_mva}   |   Frequency: {frequency} Hz   |   Date: {date.today().isoformat()}", align="C", new_x="LMARGIN", new_y="NEXT")


def _png_dimensions(data: bytes):
    """Read width and height from a PNG file's IHDR chunk."""
    import struct
    # PNG header: 8 bytes signature, then IHDR chunk: 4 len + 4 type + 4 width + 4 height
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        return None, None
    w = struct.unpack('>I', data[16:20])[0]
    h = struct.unpack('>I', data[20:24])[0]
    return w, h


def _render_diagram(pdf, diagram_image):
    """Render the single-line diagram from a base64-encoded PNG.

    For tall diagrams the image is scaled to fit the page width and
    allowed to overflow onto subsequent pages via fpdf2's automatic
    page-break handling.
    """
    if not diagram_image:
        return
    # Strip data URL prefix if present
    if "," in diagram_image:
        diagram_image = diagram_image.split(",", 1)[1]
    try:
        img_bytes = base64.b64decode(diagram_image)
    except Exception:
        return

    import os
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
        tmp.write(img_bytes)
        tmp_path = tmp.name

    try:
        img_w_px, img_h_px = _png_dimensions(img_bytes)
        if not img_w_px or not img_h_px:
            return

        margin = pdf.l_margin
        avail_w = pdf.w - margin - pdf.r_margin

        # Calculate rendered height at full page width
        scale = avail_w / img_w_px
        rendered_h = img_h_px * scale

        pdf.add_page()
        pdf.section_title("Single Line Diagram")
        top_y = pdf.get_y()
        avail_h = pdf.h - top_y - 15

        if rendered_h <= avail_h:
            # Fits on one page — render at full page width
            pdf.image(tmp_path, x=margin, y=top_y, w=avail_w, h=rendered_h)
        else:
            # Tall diagram — fit entire image on one page by scaling to
            # the available height, centering horizontally
            fit_scale_w = avail_w / img_w_px
            fit_scale_h = avail_h / img_h_px
            fit_scale = min(fit_scale_w, fit_scale_h)
            fit_w = img_w_px * fit_scale
            fit_h = img_h_px * fit_scale
            x_offset = margin + (avail_w - fit_w) / 2
            pdf.image(tmp_path, x=x_offset, y=top_y, w=fit_w, h=fit_h)
    except Exception:
        pdf.set_font("Helvetica", "", 10)
        pdf.cell(0, 8, "Diagram image could not be rendered.", new_x="LMARGIN", new_y="NEXT")
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def _render_fault_table(pdf, fault_results, comp_map):
    if not fault_results or not fault_results.get("buses"):
        return
    pdf.add_page()
    pdf.section_title("Fault Analysis — IEC 60909")

    headers = ["Bus", "V (kV)", "I\"k3 (kA)", "ip (kA)", "I\"k1 (kA)", "I\"kLL (kA)", "I\"kLLG (kA)"]
    avail = pdf.w - pdf.l_margin - pdf.r_margin
    widths = [avail * 0.22, avail * 0.11, avail * 0.13, avail * 0.13, avail * 0.13, avail * 0.13, avail * 0.15]

    rows = []
    for bus_id, r in fault_results["buses"].items():
        name = r.get("bus_name", bus_id)
        rows.append([
            name,
            f"{r['voltage_kv']:.1f}" if r.get("voltage_kv") is not None else "—",
            f"{r['ik3']:.3f}" if r.get("ik3") is not None else "—",
            f"{r['ip']:.3f}" if r.get("ip") is not None else "—",
            f"{r['ik1']:.3f}" if r.get("ik1") is not None else "—",
            f"{r['ikLL']:.3f}" if r.get("ikLL") is not None else "—",
            f"{r['ikLLG']:.3f}" if r.get("ikLLG") is not None else "—",
        ])
    _table(pdf, headers, rows, widths)


def _render_fault_branches(pdf, fault_results, comp_map):
    if not fault_results or not fault_results.get("buses"):
        return
    rows = []
    for bus_id, r in fault_results["buses"].items():
        branches = r.get("branches", [])
        if not branches:
            continue
        bus_name = r.get("bus_name", bus_id)
        for br in branches:
            el_name = br.get("element_name", br.get("element_id", ""))
            rows.append([
                bus_name, el_name, br.get("element_type", "").replace("_", " "),
                f"{br['ik_ka']:.3f}" if br.get("ik_ka") else "—",
                f"{br['contribution_pct']:.1f}%" if br.get("contribution_pct") else "—",
                br.get("source_name", "—"),
            ])
    if not rows:
        return

    pdf.add_page()
    pdf.section_title("Branch Fault Current Contributions")
    headers = ["Faulted Bus", "Element", "Type", "If (kA)", "%", "Source"]
    avail = pdf.w - pdf.l_margin - pdf.r_margin
    widths = [avail * 0.2, avail * 0.2, avail * 0.15, avail * 0.15, avail * 0.1, avail * 0.2]
    _table(pdf, headers, rows, widths, header_color=(183, 28, 28))


def _render_voltage_depression(pdf, fault_results, comp_map):
    if not fault_results or not fault_results.get("buses"):
        return
    rows = []
    for bus_id, r in fault_results["buses"].items():
        dep = r.get("voltage_depression")
        if not dep:
            continue
        fault_name = r.get("bus_name", bus_id)
        for dep_id, d in dep.items():
            if dep_id == bus_id:
                continue
            v_sub = d.get("subtransient_pu", 1.0)
            v_tr = d.get("transient_pu", v_sub)
            v_ss = d.get("steadystate_pu", v_tr)
            worst = min(v_sub, v_tr, v_ss)
            status = "Normal" if worst >= 0.8 else "Moderate Sag" if worst >= 0.5 else "Severe Sag" if worst >= 0.3 else "Near Collapse"
            rows.append([
                fault_name,
                d.get("bus_name", dep_id),
                f"{d.get('voltage_kv', 0):.1f}",
                f"{v_sub * 100:.1f}%",
                f"{v_tr * 100:.1f}%",
                f"{v_ss * 100:.1f}%",
                f"{d.get('retained_kv', 0):.2f}",
                status,
            ])
    if not rows:
        return

    pdf.add_page()
    pdf.section_title("Voltage Depression During Fault")
    headers = ["Faulted Bus", "Affected Bus", "Rated kV", "Sub-trans", "Transient", "Steady-state", "Retained kV", "Status"]
    avail = pdf.w - pdf.l_margin - pdf.r_margin
    widths = [avail * 0.15, avail * 0.15, avail * 0.1, avail * 0.12, avail * 0.12, avail * 0.12, avail * 0.12, avail * 0.12]
    _table(pdf, headers, rows, widths)


def _render_loadflow_bus(pdf, loadflow_results):
    if not loadflow_results or not loadflow_results.get("buses"):
        return
    pdf.add_page()
    method = "Newton-Raphson" if loadflow_results.get("method") == "newton_raphson" else "Gauss-Seidel"
    conv = "Converged" if loadflow_results.get("converged") else "Not Converged"
    pdf.section_title(f"Load Flow — {method} ({conv})")

    headers = ["Bus", "V (p.u.)", "V (kV)", "Angle (°)", "P (MW)", "Q (MVAr)"]
    avail = pdf.w - pdf.l_margin - pdf.r_margin
    widths = [avail * 0.25, avail * 0.15, avail * 0.15, avail * 0.15, avail * 0.15, avail * 0.15]

    rows = []
    for bus_id, r in loadflow_results["buses"].items():
        rows.append([
            r.get("bus_name", bus_id),
            f"{r.get('voltage_pu', 0):.4f}",
            f"{r.get('voltage_kv', 0):.2f}",
            f"{r.get('angle_deg', 0):.2f}",
            f"{r.get('p_mw', 0):.4f}",
            f"{r.get('q_mvar', 0):.4f}",
        ])
    _table(pdf, headers, rows, widths, header_color=(46, 125, 50))


def _render_loadflow_branch(pdf, loadflow_results):
    if not loadflow_results or not loadflow_results.get("branches"):
        return
    branches = loadflow_results["branches"]
    if not branches:
        return

    # Don't add page if loadflow_bus just added one and there's space
    if pdf.get_y() > pdf.h - 40:
        pdf.add_page()
    pdf.ln(4)
    pdf.section_title("Branch Flows")

    headers = ["Element", "From", "To", "P (MW)", "Q (MVAr)", "Loading (%)", "I (A)"]
    avail = pdf.w - pdf.l_margin - pdf.r_margin
    widths = [avail * 0.2, avail * 0.15, avail * 0.15, avail * 0.13, avail * 0.13, avail * 0.12, avail * 0.12]

    rows = []
    for br in branches:
        rows.append([
            br.get("element_name", br.get("elementId", "")),
            br.get("from_bus", "—"),
            br.get("to_bus", "—"),
            f"{br.get('p_mw', 0):.4f}",
            f"{br.get('q_mvar', 0):.4f}",
            f"{br.get('loading_pct', 0):.1f}%",
            f"{br.get('i_amps', 0):.1f}",
        ])
    _table(pdf, headers, rows, widths, header_color=(46, 125, 50))


def _render_equipment(pdf, components):
    if not components:
        return
    pdf.add_page()
    pdf.section_title("Equipment Summary")

    headers = ["Name", "Type", "Key Parameters"]
    avail = pdf.w - pdf.l_margin - pdf.r_margin
    widths = [avail * 0.25, avail * 0.2, avail * 0.55]

    type_labels = {
        "bus": "Bus", "transformer": "Transformer", "generator": "Generator",
        "utility": "Utility Source", "cable": "Cable/Feeder", "cb": "Circuit Breaker",
        "fuse": "Fuse", "relay": "Relay", "motor_induction": "Induction Motor",
        "load": "Load", "capacitor": "Capacitor", "ct": "CT", "pt": "PT",
        "arrester": "Surge Arrester", "solar_pv": "Solar PV", "wind_turbine": "Wind Turbine",
    }

    rows = []
    for c in components:
        props = c.get("props", {})
        label = type_labels.get(c.get("type", ""), c.get("type", ""))
        name = props.get("name", c.get("id", ""))
        params = []
        if props.get("voltage_kv") is not None:
            params.append(f"{props['voltage_kv']} kV")
        if props.get("rated_mva") is not None:
            params.append(f"{props['rated_mva']} MVA")
        if props.get("z_percent") is not None:
            params.append(f"Z: {props['z_percent']}%")
        if props.get("length_km") is not None:
            n = props.get("num_parallel", 1) or 1
            pstr = f"{n}×" if n > 1 else ""
            params.append(f"{pstr}{props['length_km']} km")
        if props.get("rated_current_a") is not None:
            params.append(f"{props['rated_current_a']} A")
        if props.get("rated_amps") is not None:
            n = props.get("num_parallel", 1) or 1
            total = props["rated_amps"] * n
            params.append(f"{total} A" + (f" ({n}×{props['rated_amps']})" if n > 1 else ""))
        rows.append([name, label, ", ".join(params)])

    _table(pdf, headers, rows, widths, header_color=(80, 80, 80))


def _render_settings_schedule(pdf, components):
    if not components:
        return
    rows = []
    for c in components:
        p = c.get("props", {})
        name = p.get("name", c.get("id", ""))
        ctype = c.get("type", "")

        if ctype == "relay":
            rows.append([
                name, "Relay", p.get("relay_type", "50/51"),
                f"Curve: {p.get('curve', 'IEC SI')}",
                f"Pickup: {p.get('pickup_a', '—')} A",
                f"TDS: {p.get('time_dial', '—')}",
            ])
        elif ctype == "cb":
            sub_type = (p.get("cb_type", "mccb") or "mccb").upper()
            rows.append([
                name, "CB", sub_type,
                f"Rating: {p.get('trip_rating_a') or p.get('rated_current_a', '—')} A",
                f"Thermal: {p.get('thermal_pickup', 1.0)}×In",
                f"Mag: {p.get('magnetic_pickup', 10)}×In",
            ])
        elif ctype == "fuse":
            rows.append([
                name, "Fuse", p.get("fuse_type", "gG"),
                f"Rating: {p.get('rated_current_a', '—')} A",
                f"Breaking: {p.get('breaking_capacity_ka', '—')} kA",
                "—",
            ])

    if not rows:
        return

    pdf.add_page()
    pdf.section_title("Protection Device Settings Schedule")
    headers = ["Device", "Type", "Sub-Type", "Setting 1", "Setting 2", "Setting 3"]
    avail = pdf.w - pdf.l_margin - pdf.r_margin
    widths = [avail * 0.18, avail * 0.1, avail * 0.12, avail * 0.2, avail * 0.2, avail * 0.2]
    _table(pdf, headers, rows, widths, header_color=(106, 27, 154))


def _render_arcflash(pdf, arcflash_results, comp_map):
    if not arcflash_results or not arcflash_results.get("buses"):
        return
    pdf.add_page()
    pdf.section_title("Arc Flash Analysis — IEEE 1584-2018")

    headers = ["Bus", "V (kV)", "Ibf (kA)", "Iarc (kA)", "E (cal/cm²)", "PPE Cat", "AFB (m)", "WD (mm)"]
    avail = pdf.w - pdf.l_margin - pdf.r_margin
    widths = [avail * 0.2, avail * 0.1, avail * 0.12, avail * 0.12, avail * 0.13, avail * 0.1, avail * 0.12, avail * 0.11]

    rows = []
    for bus_id, r in arcflash_results["buses"].items():
        rows.append([
            r.get("bus_name", bus_id),
            f"{r.get('voltage_kv', 0):.1f}",
            f"{r.get('bolted_fault_ka', 0):.2f}",
            f"{r.get('arcing_current_ka', 0):.2f}",
            f"{r.get('incident_energy_cal', 0):.2f}",
            str(r.get("ppe_category", "—")),
            f"{r.get('arc_flash_boundary_mm', 0) / 1000:.2f}",
            str(r.get("working_distance_mm", "—")),
        ])
    _table(pdf, headers, rows, widths, header_color=(213, 0, 0))

    # Recommendations
    for bus_id, r in arcflash_results["buses"].items():
        recs = r.get("recommendations", [])
        if recs:
            pdf.ln(4)
            pdf.set_font("Helvetica", "B", 9)
            pdf.cell(0, 5, f"Recommendations for {r.get('bus_name', bus_id)}:", new_x="LMARGIN", new_y="NEXT")
            pdf.set_font("Helvetica", "", 8)
            for rec in recs:
                pdf.cell(5)
                pdf.cell(0, 4, f"• {rec}", new_x="LMARGIN", new_y="NEXT")


def generate_calculations_report(project_name, base_mva, frequency,
                                  fault_results=None, loadflow_results=None,
                                  arcflash_results=None, cable_results=None,
                                  motor_results=None, duty_results=None,
                                  load_diversity_results=None, grounding_results=None,
                                  components=None):
    """Generate a detailed calculations report showing formulas and intermediate values."""
    pdf = ReportPDF(project_name=project_name)
    pdf.set_left_margin(15)
    pdf.set_right_margin(15)
    pdf.alias_nb_pages()

    _calc_title(pdf, project_name, base_mva, frequency)

    if fault_results and fault_results.get("buses"):
        _calc_fault(pdf, fault_results, base_mva)

    if loadflow_results and loadflow_results.get("buses"):
        _calc_loadflow(pdf, loadflow_results, base_mva)

    if arcflash_results and arcflash_results.get("buses"):
        _calc_arcflash(pdf, arcflash_results)

    if cable_results and cable_results.get("cables"):
        _calc_cable(pdf, cable_results)

    if motor_results and motor_results.get("motors"):
        _calc_motor(pdf, motor_results)

    if duty_results and duty_results.get("devices"):
        _calc_duty(pdf, duty_results)

    if load_diversity_results and load_diversity_results.get("buses"):
        _calc_load_diversity(pdf, load_diversity_results)

    if grounding_results:
        _calc_grounding(pdf, grounding_results)

    buf = io.BytesIO()
    pdf.output(buf)
    buf.seek(0)
    return buf


def _calc_label(pdf, text):
    """Print a formula/label line in bold italic."""
    pdf.set_font("Helvetica", "BI", 8)
    pdf.set_text_color(60, 60, 60)
    pdf.cell(0, 5, text, new_x="LMARGIN", new_y="NEXT")
    pdf.set_text_color(0, 0, 0)


def _calc_body(pdf, text):
    """Print a body line."""
    pdf.set_font("Helvetica", "", 8)
    pdf.cell(0, 4.5, text, new_x="LMARGIN", new_y="NEXT")


def _calc_subsection(pdf, text):
    """Print a subsection heading."""
    pdf.set_font("Helvetica", "B", 10)
    pdf.set_fill_color(240, 240, 240)
    pdf.cell(0, 6, "  " + text, border="B", fill=True, new_x="LMARGIN", new_y="NEXT")
    pdf.ln(1)


def _calc_title(pdf, project_name, base_mva, frequency):
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 20)
    pdf.ln(20)
    pdf.cell(0, 10, "ProtectionPro", align="C", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "B", 16)
    pdf.cell(0, 8, "Detailed Calculations Report", align="C", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 11)
    pdf.ln(4)
    pdf.cell(0, 7, f"Project: {project_name}", align="C", new_x="LMARGIN", new_y="NEXT")
    pdf.cell(0, 7, f"System Base: {base_mva} MVA  |  Frequency: {frequency} Hz  |  Date: {date.today().isoformat()}", align="C", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(12)

    # Table of contents
    pdf.set_font("Helvetica", "B", 11)
    pdf.cell(0, 6, "Contents", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 9)
    sections = [
        "1.  Fault Analysis — IEC 60909",
        "2.  Load Flow Analysis",
        "3.  Arc Flash Analysis — IEEE 1584-2018",
        "4.  Cable Sizing Calculations — IEC 60364",
        "5.  Motor Starting Analysis",
        "6.  Equipment Duty Check",
        "7.  Load Diversity & Demand Factors",
        "8.  Grounding System Design — IEEE 80",
    ]
    for s in sections:
        pdf.cell(10)
        pdf.cell(0, 5, s, new_x="LMARGIN", new_y="NEXT")


def _calc_fault(pdf, fault_results, base_mva):
    pdf.add_page()
    pdf.section_title("1.  Fault Analysis — IEC 60909")

    _calc_label(pdf, "Method: Per-unit impedance method (IEC 60909)")
    _calc_label(pdf, f"System Base: S_base = {base_mva} MVA")
    pdf.ln(2)

    _calc_body(pdf, "IEC 60909 defines the initial symmetrical short-circuit current I\"k as:")
    _calc_label(pdf, "  I\"k = c * U_n / (sqrt(3) * |Z_k|)")
    _calc_body(pdf, "  where c = voltage factor (1.0 normal, 1.1 max), U_n = nominal voltage, Z_k = total impedance to fault.")
    pdf.ln(2)
    _calc_body(pdf, "Peak short-circuit current:")
    _calc_label(pdf, "  ip = kappa * sqrt(2) * I\"k")
    _calc_body(pdf, "  kappa = 1.02 + 0.98 * exp(-3 * R/X)  (IEC 60909-0 Eq. 29)")
    pdf.ln(2)
    _calc_body(pdf, "Single-line-to-ground fault:")
    _calc_label(pdf, "  I\"k1 = sqrt(3) * c * U_n / |2*Z1 + Z0|")
    _calc_body(pdf, "  where Z1 = positive-sequence impedance, Z0 = zero-sequence impedance.")
    pdf.ln(4)

    # Per-bus calculations
    for bus_id, r in fault_results["buses"].items():
        _calc_subsection(pdf, f"Bus: {r.get('bus_name', bus_id)}  ({r.get('voltage_kv', '—')} kV)")

        v = r.get("voltage_kv")
        ik3 = r.get("ik3")
        ik1 = r.get("ik1")
        ikLL = r.get("ikLL")
        ikLLG = r.get("ikLLG")
        ip = r.get("ip")

        # Back-calculate |Z_k| if possible
        if v and ik3:
            zk = (v / math.sqrt(3)) / ik3  # in Ohm (kV / kA = Ohm)
            zk_pu = zk / (v ** 2 / base_mva * 1000)  # convert kV²/MVA to Ohm: 1 pu = kV²/MVA*1000 mOhm?
            _calc_body(pdf, f"  Nominal voltage:           U_n     = {v:.3f} kV")
            if ik3:
                _calc_body(pdf, f"  3-phase fault current:     I\"k3    = {ik3:.4f} kA")
                z_ohm = (1.0 * v * 1000) / (math.sqrt(3) * ik3 * 1000)  # Ohm
                z_pu = z_ohm / ((v ** 2) / base_mva * 1000 / 1000)  # pu
                _calc_body(pdf, f"  Equiv. short-circuit Zk   = c*U/(sqrt(3)*I\"k3) = 1.0 * {v:.3f}kV / (1.732 * {ik3:.4f}kA) = {z_ohm:.4f} Ohm  ({z_pu:.4f} pu)")
        if ip and ik3:
            kappa = ip / (math.sqrt(2) * ik3)
            _calc_body(pdf, f"  Peak factor:               kappa   = ip/(sqrt(2)*I\"k3) = {ip:.4f}/{math.sqrt(2)*ik3:.4f} = {kappa:.4f}")
            _calc_body(pdf, f"  Peak current:              ip      = {ip:.4f} kA")
        if ik1:
            _calc_body(pdf, f"  SLG fault current:         I\"k1    = {ik1:.4f} kA")
        if ikLL:
            _calc_body(pdf, f"  L-L fault current:         I\"kLL   = {ikLL:.4f} kA")
            if ik3:
                _calc_body(pdf, f"    Check: I\"kLL / I\"k3 = {ikLL/ik3:.4f}  (theoretical: sqrt(3)/2 = {math.sqrt(3)/2:.4f})")
        if ikLLG:
            _calc_body(pdf, f"  LLG fault current:         I\"kLLG  = {ikLLG:.4f} kA")

        # Branch contributions
        branches = r.get("branches", [])
        if branches:
            _calc_body(pdf, "  Branch contributions:")
            total_if = sum(b.get("ik_ka", 0) or 0 for b in branches)
            for br in branches:
                name = br.get("element_name", br.get("element_id", ""))
                ik = br.get("ik_ka", 0) or 0
                pct = br.get("contribution_pct") or (ik / total_if * 100 if total_if else 0)
                _calc_body(pdf, f"    {name:<30} If = {ik:.4f} kA  ({pct:.1f}%)")

        pdf.ln(2)


def _calc_loadflow(pdf, loadflow_results, base_mva):
    pdf.add_page()
    method_name = "Newton-Raphson" if loadflow_results.get("method") == "newton_raphson" else "Gauss-Seidel"
    pdf.section_title(f"2.  Load Flow Analysis — {method_name}")

    converged = loadflow_results.get("converged", False)
    iterations = loadflow_results.get("iterations", "—")

    _calc_label(pdf, f"Method: {method_name}  |  Status: {'Converged' if converged else 'NOT CONVERGED'}  |  Iterations: {iterations}")
    pdf.ln(2)

    if loadflow_results.get("method") == "newton_raphson":
        _calc_body(pdf, "Newton-Raphson power flow solves the nonlinear mismatch equations:")
        _calc_label(pdf, "  [DP]   [J11 J12] [D_delta]")
        _calc_label(pdf, "  [DQ] = [J21 J22] [D_|V|/|V|]")
        _calc_body(pdf, "  where DP, DQ = active/reactive power mismatches; J = Jacobian matrix.")
        _calc_body(pdf, "  Iteration: x_(k+1) = x_k - J^-1 * f(x_k)  until |mismatch| < tolerance.")
    else:
        _calc_body(pdf, "Gauss-Seidel updates each bus voltage in sequence:")
        _calc_label(pdf, "  V_i^(k+1) = (1/Y_ii) * [ (P_i - jQ_i)/conj(V_i^k) - sum_{j!=i} Y_ij * V_j^k ]")

    pdf.ln(4)

    # Bus results
    _calc_subsection(pdf, "Bus Voltage Results")
    _calc_body(pdf, "  Bus type convention:  SW = Swing/Slack (V,theta specified)  |  PV = Generator (P,|V| specified)  |  PQ = Load (P,Q specified)")
    pdf.ln(1)

    buses = loadflow_results.get("buses", {})
    total_p_gen = total_q_gen = total_p_load = total_q_load = 0.0
    for bus_id, r in buses.items():
        p = r.get("p_mw", 0) or 0
        q = r.get("q_mvar", 0) or 0
        v_pu = r.get("voltage_pu") or r.get("v_pu", 1.0)
        v_kv = r.get("voltage_kv") or r.get("v_kv", 0)
        angle = r.get("angle_deg", 0) or 0
        name = r.get("bus_name", bus_id)
        _calc_body(pdf, f"  {name:<25}  |V| = {v_pu:.4f} pu  ({v_kv:.3f} kV)   d = {angle:+.3f} deg   P = {p:+.4f} MW   Q = {q:+.4f} MVAr")
        if p > 0:
            total_p_gen += p
            total_q_gen += q
        else:
            total_p_load += abs(p)
            total_q_load += abs(q)

    pdf.ln(2)
    losses_p = total_p_gen - total_p_load
    _calc_body(pdf, f"  System totals:  P_gen = {total_p_gen:.4f} MW   P_load = {total_p_load:.4f} MW   P_loss = {losses_p:.4f} MW")
    pdf.ln(2)

    branches = loadflow_results.get("branches", [])
    if branches:
        _calc_subsection(pdf, "Branch Flow Results")
        _calc_body(pdf, "  Branch loading = I_actual / I_rated * 100%")
        _calc_label(pdf, "  S = sqrt(P^2 + Q^2)   |   I = S / (sqrt(3) * V_kV)   [kA]")
        pdf.ln(1)
        for br in branches:
            name = br.get("element_name", br.get("elementId", br.get("element_id", "")))
            p = br.get("p_mw", 0) or 0
            q = br.get("q_mvar", 0) or 0
            s = math.sqrt(p ** 2 + q ** 2)
            load_pct = br.get("loading_pct", 0) or 0
            i_a = br.get("i_amps") or br.get("i_a", 0) or 0
            losses = br.get("losses_mw", 0) or 0
            status = "OVERLOADED" if load_pct > 100 else ("Warning" if load_pct > 80 else "OK")
            _calc_body(pdf, f"  {name:<25}  P={p:+.4f}MW  Q={q:+.4f}MVAr  |S|={s:.4f}MVA  I={i_a:.1f}A  Load={load_pct:.1f}%  Losses={losses:.4f}MW  [{status}]")

        total_losses = sum((br.get("losses_mw", 0) or 0) for br in branches)
        pdf.ln(1)
        _calc_body(pdf, f"  Total system branch losses: {total_losses:.4f} MW")


def _calc_arcflash(pdf, arcflash_results):
    pdf.add_page()
    pdf.section_title("3.  Arc Flash Analysis — IEEE 1584-2018")

    _calc_label(pdf, "Standard: IEEE 1584-2018  (Applicable range: 208 V – 15 kV, 3-phase AC)")
    pdf.ln(2)
    _calc_body(pdf, "Step 1 — Arcing current (intermediate values depend on voltage class and electrode config):")
    _calc_label(pdf, "  lg(I_arc) = k1 + k2*lg(I_bf) + k3*lg(G)  (IEEE 1584-2018 Eq. 1)")
    _calc_body(pdf, "  where I_bf = bolted fault current [kA], G = electrode gap [mm], k1/k2/k3 = regression coefficients.")
    pdf.ln(2)
    _calc_body(pdf, "Step 2 — Incident energy (normalised to 610 mm working distance):")
    _calc_label(pdf, "  E_n = 10^( k1 + k2*lg(I_arc) )   [J/cm^2]")
    _calc_body(pdf, "  E = E_n * (t / 0.2 s) * (610^x / D^x)  where D = working distance [mm], t = arcing duration.")
    pdf.ln(2)
    _calc_body(pdf, "Step 3 — Arc flash boundary (AFB):")
    _calc_label(pdf, "  AFB = [ E_n * t / (E_B * 0.2) ]^(1/x) * 610  [mm]  (E_B = 1.2 cal/cm^2 for bare skin)")
    pdf.ln(2)
    _calc_body(pdf, "PPE Category selection per NFPA 70E Table 130.7(C)(15)(c):")
    for cat, limit in [(1, "4"), (2, "8"), (3, "25"), (4, "40")]:
        _calc_body(pdf, f"  Category {cat}: E <= {limit} cal/cm^2")
    pdf.ln(4)

    for bus_id, r in arcflash_results["buses"].items():
        _calc_subsection(pdf, f"Bus: {r.get('bus_name', bus_id)}  ({r.get('voltage_kv', '—')} kV)")
        ibf = r.get("bolted_fault_ka", 0) or 0
        iarc = r.get("arcing_current_ka", 0) or 0
        e = r.get("incident_energy_cal", 0) or 0
        ppe = r.get("ppe_category", "—")
        afb_mm = r.get("arc_flash_boundary_mm", 0) or 0
        wd = r.get("working_distance_mm", 0) or 0
        v_kv = r.get("voltage_kv", 0) or 0

        _calc_body(pdf, f"  Nominal voltage:           U_n     = {v_kv:.3f} kV")
        _calc_body(pdf, f"  Bolted fault current:      I_bf    = {ibf:.4f} kA  (from fault analysis)")
        _calc_body(pdf, f"  Arcing current:            I_arc   = {iarc:.4f} kA")
        if ibf > 0 and iarc > 0:
            ratio = iarc / ibf
            _calc_body(pdf, f"    I_arc / I_bf ratio = {ratio:.4f}  (typical 0.85–0.98 for MV; lower for LV)")
        _calc_body(pdf, f"  Working distance:          WD      = {wd} mm")
        _calc_body(pdf, f"  Incident energy:           E       = {e:.4f} cal/cm^2")
        _calc_body(pdf, f"  PPE category:              Cat     = {ppe}")
        _calc_body(pdf, f"  Arc flash boundary:        AFB     = {afb_mm/1000:.3f} m  ({afb_mm:.0f} mm)")

        recs = r.get("recommendations", [])
        if recs:
            _calc_body(pdf, "  Recommendations:")
            for rec in recs:
                _calc_body(pdf, f"    - {rec}")
        pdf.ln(2)


def _calc_cable(pdf, cable_results):
    pdf.add_page()
    pdf.section_title("4.  Cable Sizing Calculations — IEC 60364")

    _calc_label(pdf, "Standard: IEC 60364-5-52 / IEC 60502 / SANS 1339")
    pdf.ln(2)
    _calc_body(pdf, "Thermal check (continuous current rating):")
    _calc_label(pdf, "  I_load <= I_z  where I_z = derating * I_rated_tabulated")
    pdf.ln(1)
    _calc_body(pdf, "Voltage drop check:")
    _calc_label(pdf, "  dV% = (I * (R*cos(phi) + X*sin(phi)) * L * 2) / U_n * 100%")
    _calc_body(pdf, "  (single-phase: factor 2; three-phase: factor sqrt(3); limit: 3% for final, 5% total)")
    pdf.ln(1)
    _calc_body(pdf, "Fault withstand (adiabatic method, IEC 60364-5-54):")
    _calc_label(pdf, "  S >= sqrt(I^2 * t) / k  [mm^2]")
    _calc_body(pdf, "  where k = material constant (115 for Cu/PVC, 143 for Cu/XLPE), t = fault clearing time [s].")
    pdf.ln(4)

    for cable in cable_results.get("cables", []):
        name = cable.get("cable_name", cable.get("cable_id", ""))
        _calc_subsection(pdf, f"Cable: {name}")
        _calc_body(pdf, f"  From: {cable.get('from_bus', '-')}  ->  To: {cable.get('to_bus', '-')}")

        i_load = cable.get("load_current_a", 0) or 0
        thermal_pct = cable.get("thermal_loading_pct", 0) or 0
        thermal_ok = cable.get("thermal_ok", True)
        vd_pct = cable.get("voltage_drop_pct", 0) or 0
        vd_ok = cable.get("voltage_drop_ok", True)
        fw_ok = cable.get("fault_withstand_ok", True)
        status = cable.get("status", "—")
        rec = cable.get("recommended_cable", "")

        _calc_body(pdf, f"  Load current:              I_load  = {i_load:.2f} A")
        _calc_body(pdf, f"  Thermal loading:           {thermal_pct:.1f}%   {'[OK]' if thermal_ok else '[FAIL]'}")
        _calc_body(pdf, f"  Voltage drop:              {vd_pct:.2f}%   {'[OK]' if vd_ok else '[FAIL]'}")
        _calc_body(pdf, f"  Fault withstand:           {'[OK]' if fw_ok else '[FAIL]'}")
        _calc_body(pdf, f"  Overall status:            {status.upper()}")
        if rec:
            _calc_body(pdf, f"  Recommended cable:         {rec}")

        issues = cable.get("issues", [])
        if issues:
            _calc_body(pdf, "  Issues:")
            for iss in issues:
                _calc_body(pdf, f"    - {iss}")
        pdf.ln(2)


def _calc_motor(pdf, motor_results):
    pdf.add_page()
    pdf.section_title("5.  Motor Starting Analysis")

    _calc_label(pdf, "Method: Locked-rotor current method; voltage dip per IEC 60034-12")
    pdf.ln(2)
    _calc_body(pdf, "Locked-rotor (starting) current:")
    _calc_label(pdf, "  I_LR = I_FLA * LRC_multiplier  (typical 5–7 x FLA for DOL start)")
    pdf.ln(1)
    _calc_body(pdf, "Voltage dip at motor terminals:")
    _calc_label(pdf, "  dV% = (Z_source / (Z_source + Z_motor)) * 100%")
    _calc_body(pdf, "  where Z_source = Thevenin impedance at bus, Z_motor = V^2/S_LR")
    pdf.ln(4)

    for motor in motor_results.get("motors", []):
        name = motor.get("motor_name", motor.get("motor_id", ""))
        _calc_subsection(pdf, f"Motor: {name}")

        v_dip = motor.get("max_system_dip_pct", 0) or 0
        status = motor.get("status", "pass")
        v_ok = status != "fail"
        _calc_body(pdf, f"  Max system voltage dip:    dV      = {v_dip:.2f}%   {'[OK - <= 15%]' if v_ok else '[FAIL - > 15%]'}")

        simple_fields = {
            "terminal_bus": "Terminal bus",
            "rated_kw": "Rated power (kW)",
            "start_current_a": "Starting current (A)",
            "motor_terminal_voltage_pu": "Terminal voltage at start (pu)",
            "motor_will_start": "Motor will start",
            "max_dip_bus": "Worst dip location",
        }
        for k, label in simple_fields.items():
            val = motor.get(k)
            if val is None:
                continue
            if isinstance(val, float):
                _calc_body(pdf, f"  {label:<40} = {val:.4f}")
            else:
                _calc_body(pdf, f"  {label:<40} = {val}")

        issues = motor.get("issues", [])
        if issues:
            _calc_body(pdf, "  Issues:")
            for iss in issues:
                _calc_body(pdf, f"    - {iss}")
        pdf.ln(2)

    warnings = motor_results.get("warnings", [])
    if warnings:
        _calc_subsection(pdf, "Warnings")
        for w in warnings:
            _calc_body(pdf, f"  - {w}")


def _calc_duty(pdf, duty_results):
    pdf.add_page()
    pdf.section_title("6.  Equipment Duty Check")

    _calc_label(pdf, "Verification: Calculated fault current <= Equipment rated interrupting capacity")
    pdf.ln(2)
    _calc_body(pdf, "Symmetrical rated interrupting capacity (IEC 62271-100 / IEEE C37.09):")
    _calc_label(pdf, "  I_sc_rated >= I\"k  (peak rated >= ip)")
    _calc_body(pdf, "  Duty margin = (I_rated - I_calc) / I_rated * 100%")
    pdf.ln(4)

    headers = ["Device", "I_fault (kA)", "I_rated (kA)", "Utilisation (%)", "Status"]
    avail = pdf.w - pdf.l_margin - pdf.r_margin
    widths = [avail * 0.35, avail * 0.15, avail * 0.15, avail * 0.15, avail * 0.20]
    rows = []
    for eq in duty_results.get("devices", []):
        name = eq.get("device_name", eq.get("device_id", ""))
        i_fault = eq.get("prospective_fault_ka", 0) or 0
        i_rated = eq.get("breaking_capacity_ka", 0) or 0
        utilisation = eq.get("utilisation_pct", 0) or 0
        ok = eq.get("interrupt_ok", True)
        status = (eq.get("status") or ("pass" if ok else "fail")).upper()
        rows.append([name, f"{i_fault:.3f}", f"{i_rated:.3f}", f"{utilisation:.1f}%", status])

    _table(pdf, headers, rows, widths, header_color=(80, 80, 80))
    pdf.ln(2)

    warnings = duty_results.get("warnings", [])
    if warnings:
        pdf.set_font("Helvetica", "B", 9)
        pdf.cell(0, 5, "Warnings:", new_x="LMARGIN", new_y="NEXT")
        pdf.set_font("Helvetica", "", 8)
        for w in warnings:
            pdf.cell(0, 4, f"  - {w}", new_x="LMARGIN", new_y="NEXT")


def _calc_load_diversity(pdf, ld_results):
    pdf.add_page()
    pdf.section_title("7.  Load Diversity & Demand Factors")

    _calc_label(pdf, "Method: Demand factor / diversity factor analysis (IEC 60364-1 / SANS 10142)")
    pdf.ln(2)
    _calc_body(pdf, "Maximum demand:")
    _calc_label(pdf, "  MD = sum(P_i * DF_i)  where DF_i = demand factor for load i")
    _calc_body(pdf, "Diversity factor:")
    _calc_label(pdf, "  FD = sum(MD_i) / MD_total  (FD >= 1.0)")
    pdf.ln(4)

    summary = ld_results.get("summary", {})
    if summary:
        _calc_subsection(pdf, "System Summary")
        for k, v in summary.items():
            label = k.replace("_", " ").title()
            val = f"{v:.3f}" if isinstance(v, float) else str(v)
            _calc_body(pdf, f"  {label:<35} = {val}")
        pdf.ln(2)

    buses = ld_results.get("buses", [])
    if buses:
        _calc_subsection(pdf, "Load Calculations per Bus")
        headers = ["Load", "Bus", "Installed (kW)", "Demand Factor", "Demand (kW)"]
        avail = pdf.w - pdf.l_margin - pdf.r_margin
        widths = [avail * 0.25, avail * 0.2, avail * 0.18, avail * 0.17, avail * 0.2]
        rows = []
        for bus in buses:
            bus_name = bus.get("bus_name", bus.get("bus_id", ""))
            for ld in bus.get("loads", []):
                name = ld.get("load_name", ld.get("load_id", ""))
                rated = ld.get("installed_kw", 0) or 0
                df = ld.get("demand_factor", 1.0) or 1.0
                demand = ld.get("demand_kw", rated * df) or 0
                rows.append([name, bus_name, f"{rated:.1f}", f"{df:.3f}", f"{demand:.1f}"])
        if rows:
            _table(pdf, headers, rows, widths, header_color=(100, 60, 160))


def _calc_grounding(pdf, grounding_results):
    pdf.add_page()
    pdf.section_title("8.  Grounding System Design — IEEE 80")

    _calc_label(pdf, "Standard: IEEE Std 80-2013 — Guide for Safety in AC Substation Grounding")
    pdf.ln(2)
    _calc_body(pdf, "Tolerable touch voltage (IEEE 80 Eq. 29):")
    _calc_label(pdf, "  E_touch = (1000 + 1.5 * C_s * rho_s) * 0.116 / sqrt(t_s)  [V]  (50 kg person)")
    _calc_body(pdf, "Tolerable step voltage (IEEE 80 Eq. 28):")
    _calc_label(pdf, "  E_step  = (1000 + 6.0 * C_s * rho_s) * 0.116 / sqrt(t_s)  [V]")
    _calc_body(pdf, "  where C_s = surface layer derating, rho_s = surface resistivity [Ohm.m], t_s = fault duration [s].")
    pdf.ln(2)
    _calc_body(pdf, "Ground potential rise:")
    _calc_label(pdf, "  GPR = I_G * R_g  [V]  where I_G = ground fault current, R_g = grid resistance.")
    pdf.ln(2)
    _calc_body(pdf, "Grid resistance (Schwarz formula, IEEE 80 Eq. 53):")
    _calc_label(pdf, "  R_g = rho/(4*r) + rho/(L_T) * (1 + 1/(1 + h*sqrt(20/A)))")
    _calc_body(pdf, "  where r = equiv. radius of grid, L_T = total conductor length, A = grid area, h = burial depth.")
    pdf.ln(4)

    bus_results = grounding_results.get("buses", [])
    field_labels = [
        ("bus_name", "Bus"),
        ("voltage_kv", "Voltage (kV)"),
        ("soil_resistivity", "Soil resistivity (Ohm.m)"),
        ("grid_area_m2", "Grid area (m2)"),
        ("grid_dimensions", "Grid dimensions"),
        ("total_conductor_length_m", "Total conductor length (m)"),
        ("fault_current_ka", "Ground fault current (kA)"),
        ("grid_resistance_ohm", "Grid resistance (Ohm)"),
        ("gpr_v", "Ground potential rise (V)"),
        ("tolerable_touch_v", "Tolerable touch voltage (V)"),
        ("tolerable_step_v", "Tolerable step voltage (V)"),
        ("mesh_voltage_v", "Calculated mesh/touch voltage (V)"),
        ("step_voltage_v", "Calculated step voltage (V)"),
        ("touch_ok", "Touch voltage OK"),
        ("step_ok", "Step voltage OK"),
        ("min_conductor_mm2", "Min. conductor size (mm2)"),
        ("recommended_conductor_mm2", "Recommended conductor (mm2)"),
        ("status", "Status"),
    ]
    for bus in bus_results:
        bus_name = bus.get("bus_name", bus.get("bus_id", ""))
        _calc_subsection(pdf, f"Bus: {bus_name}")
        for k, label in field_labels:
            val = bus.get(k)
            if val is None:
                continue
            if isinstance(val, float):
                _calc_body(pdf, f"  {label:<45} = {val:.4f}")
            else:
                _calc_body(pdf, f"  {label:<45} = {val}")
        issues = bus.get("issues", [])
        for iss in issues:
            _calc_body(pdf, f"  ! {iss}")
        pdf.ln(1)

    warnings = grounding_results.get("warnings", [])
    if warnings:
        _calc_subsection(pdf, "Warnings")
        for w in warnings:
            _calc_body(pdf, f"  - {w}")


def generate_arcflash_labels(project_name, arcflash_results, components=None):
    """Generate NFPA 70E arc flash warning labels as PDF."""
    if not arcflash_results or not arcflash_results.get("buses"):
        return None

    pdf = SafePDF(orientation="P", unit="mm", format="A4")
    pdf.set_auto_page_break(auto=False)

    comp_map = {}
    if components:
        for c in components:
            comp_map[c.get("id", "")] = c

    label_w = 95
    label_h = 70
    page_w = 210
    margin_x = (page_w - label_w * 2 - 10) / 2
    margin_y = 12
    col = 0
    row = 0

    entries = list(arcflash_results["buses"].items())
    for idx, (bus_id, r) in enumerate(entries):
        if col == 0 and row == 0:
            pdf.add_page()

        x = margin_x + col * (label_w + 10)
        y = margin_y + row * (label_h + 8)

        if y + label_h > 287:
            pdf.add_page()
            row = 0
            col = 0
            x = margin_x
            y = margin_y

        bus_name = r.get("bus_name", bus_id)
        _draw_label(pdf, x, y, label_w, label_h, bus_name, r, project_name)

        col += 1
        if col >= 2:
            col = 0
            row += 1

    buf = io.BytesIO()
    pdf.output(buf)
    buf.seek(0)
    return buf


def _draw_label(pdf, x, y, w, h, bus_name, r, project_name):
    """Draw a single NFPA 70E arc flash warning label."""
    # Danger header
    danger_h = 11
    pdf.set_fill_color(213, 0, 0)
    pdf.rect(x, y, w, danger_h, "F")
    pdf.set_font("Helvetica", "B", 14)
    pdf.set_text_color(255, 255, 255)
    pdf.set_xy(x, y + 1)
    pdf.cell(w, 6, "DANGER", align="C")
    pdf.set_font("Helvetica", "B", 6)
    pdf.set_xy(x, y + 6)
    pdf.cell(w, 4, "ARC FLASH AND SHOCK HAZARD", align="C")

    # Orange warning stripe
    pdf.set_fill_color(255, 152, 0)
    pdf.rect(x, y + danger_h, w, 2.5, "F")

    # White body
    body_y = y + danger_h + 2.5
    body_h = h - danger_h - 2.5
    pdf.set_fill_color(255, 255, 255)
    pdf.rect(x, body_y, w, body_h, "F")

    # Border
    pdf.set_draw_color(0, 0, 0)
    pdf.set_line_width(0.4)
    pdf.rect(x, y, w, h)

    # Bus name and project
    pdf.set_text_color(0, 0, 0)
    pdf.set_font("Helvetica", "B", 9)
    pdf.set_xy(x + 3, body_y + 2)
    pdf.cell(w * 0.6, 4, bus_name[:30])
    pdf.set_font("Helvetica", "", 6)
    pdf.set_xy(x + w * 0.6, body_y + 2)
    pdf.cell(w * 0.4 - 3, 4, project_name[:25], align="R")

    # Data fields
    energy = f"{r.get('incident_energy_cal', 0):.2f}" if r.get("incident_energy_cal") is not None else "—"
    ppe = r.get("ppe_category", "—")
    afb = f"{r.get('arc_flash_boundary_mm', 0) / 1000:.2f}" if r.get("arc_flash_boundary_mm") else "—"
    iarc = f"{r.get('arcing_current_ka', 0):.2f}" if r.get("arcing_current_ka") else "—"
    ibf = f"{r.get('bolted_fault_ka', 0):.2f}" if r.get("bolted_fault_ka") else "—"
    wd = r.get("working_distance_mm", "—")
    vkv = r.get("voltage_kv", "—")

    fields = [
        ("Incident Energy:", f"{energy} cal/cm²"),
        ("PPE Category:", f"Cat {ppe}"),
        ("Arc Flash Boundary:", f"{afb} m"),
        ("Arcing Current:", f"{iarc} kA"),
        ("Bolted Fault Current:", f"{ibf} kA"),
        ("Working Distance:", f"{wd} mm"),
        ("Nominal Voltage:", f"{vkv} kV"),
    ]

    ly = body_y + 9
    line_h = 5
    for label, value in fields:
        pdf.set_font("Helvetica", "B", 7.5)
        pdf.set_xy(x + 3, ly)
        pdf.cell(38, line_h, label)
        pdf.set_font("Helvetica", "", 7.5)
        pdf.cell(w - 44, line_h, str(value))
        ly += line_h

    # Footer
    pdf.set_font("Helvetica", "I", 5.5)
    pdf.set_text_color(100, 100, 100)
    pdf.set_xy(x + 3, y + h - 5)
    pdf.cell(w * 0.5, 3, "NFPA 70E / IEEE 1584-2018")
    pdf.set_xy(x + w * 0.5, y + h - 5)
    pdf.cell(w * 0.5 - 3, 3, date.today().isoformat(), align="R")
    pdf.set_text_color(0, 0, 0)
