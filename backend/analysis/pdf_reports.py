"""Server-side PDF report generation using fpdf2."""

import io
import math
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
                         sections=None):
    """Generate a full analysis report PDF.

    Args:
        sections: list of section IDs to include. If None, include all available.
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
