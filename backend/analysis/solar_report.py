"""Solar PV design report (PDF): site and data source, array layout, loss tree, monthly and 25-year yield, string checks,
DC protection, annual shading, reference check and limits. Built from what the Solar PV Design modal already computed
(the `solar-size` result, the string checks, the protection sizing, the annual shading); nothing is recalculated here.

User-facing text states results and sources only. The PVGIS attribution is printed whenever PVGIS data was used.
"""
import base64
import datetime
import io

from .pdf_reports import ReportPDF, _table, _safe
from .pv_data import DEFAULT_LOSSES

HOURLY_CHECK = ("Checked against the PVGIS PV calculator at three South African sites (Johannesburg, Cape Town, Upington) in two "
                "orientations each: annual energy agrees within 3 % in every case (largest difference measured 1.6 %).")
TABLE_CHECK = ("The bundled monthly irradiance table is screening grade: against the PVGIS PV calculator at the same three sites the annual "
               "energy differed by up to about 12 %. Use PVGIS hourly data for design numbers.")
LIMITS = ("Design grade, not bankable. The model does not include spectral or low-light losses, snow, or substring / bypass-diode "
          "behaviour; soiling, wiring and availability are fixed percentages and module mismatch a single percentage. Results should be "
          "confirmed with a measured-data tool before financing or guarantees.")
LOSS_LABELS = {"soiling": "Soiling", "mismatch": "Module mismatch", "dc_wiring": "DC wiring", "inverter": "Inverter efficiency",
               "ac_wiring": "AC wiring", "availability": "Availability"}


def _h(pdf, text):
    if pdf.get_y() > pdf.h - 55:        # keep a heading with the start of its table
        pdf.add_page()
    pdf.ln(3)
    pdf.set_font("Helvetica", "B", 12)
    pdf.cell(0, 7, text, new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 9)


def _p(pdf, text, size=9, italic=False):
    pdf.set_font("Helvetica", "I" if italic else "", size)
    pdf.multi_cell(0, 4.5, _safe(text), new_x="LMARGIN", new_y="NEXT")


def _ltable(pdf, headers, rows, widths):
    """Like _table but every column left-aligned (text tables)."""
    pdf.set_font("Helvetica", "B", 8)
    pdf.set_fill_color(0, 120, 215)
    pdf.set_text_color(255, 255, 255)
    for w, h in zip(widths, headers):
        pdf.cell(w, 6, h, border=1, fill=True)
    pdf.ln()
    pdf.set_text_color(0, 0, 0)
    pdf.set_font("Helvetica", "", 8)
    for ri, row in enumerate(rows):
        pdf.set_fill_color(*((245, 245, 245) if ri % 2 else (255, 255, 255)))
        for w, v in zip(widths, row):
            pdf.cell(w, 5, str(v), border=1, fill=True)
        pdf.ln()
        if pdf.get_y() > pdf.h - 20:
            pdf.add_page()


def _n(v, d=0):
    try:
        return f"{float(v):,.{d}f}"
    except (TypeError, ValueError):
        return "-"


def _pictures(pdf, images):
    """The roof pictures (data URLs from the 3D view), two to a row under their captions; ones that cannot be read are skipped."""
    ok = []
    for im in (images or [])[:6]:
        try:
            raw = str(im.get("png", ""))
            data = base64.b64decode(raw.split(",", 1)[1] if "," in raw else raw)
            from PIL import Image
            w, h = Image.open(io.BytesIO(data)).size
        except Exception:
            continue
        ok.append((str(im.get("title", "")), data, w, h))
    if not ok:
        return
    gap = 6
    pw = (pdf.w - pdf.l_margin - pdf.r_margin - gap) / 2
    first = True
    for r in range(0, len(ok), 2):
        row = ok[r:r + 2]
        ph = max(pw * h / w for _, _, w, h in row)
        if pdf.get_y() + ph + 16 > pdf.h - 15:
            pdf.add_page()
        if first:
            _h(pdf, "Roof model")
            first = False
        y0 = pdf.get_y()
        for c, (title, data, w, h) in enumerate(row):
            x = pdf.l_margin + c * (pw + gap)
            pdf.set_xy(x, y0)
            pdf.set_font("Helvetica", "I", 8)
            pdf.cell(pw, 4, _safe(title))
            pdf.image(io.BytesIO(data), x=x, y=y0 + 5, w=pw, h=pw * h / w)
        pdf.set_y(y0 + 5 + ph + 4)


def _bars(pdf, values, labels, title):
    """Small bar chart of monthly values."""
    x0, w, h = pdf.l_margin, pdf.w - pdf.l_margin - pdf.r_margin, 38
    if pdf.get_y() + h + 14 > pdf.h - 15:
        pdf.add_page()
    y0 = pdf.get_y() + 4
    pdf.set_font("Helvetica", "", 8)
    pdf.cell(0, 4, title, new_x="LMARGIN", new_y="NEXT")
    top = max(values) or 1
    bw = w / len(values)
    pdf.set_fill_color(0, 120, 215)
    for i, v in enumerate(values):
        bh = h * v / top
        pdf.rect(x0 + i * bw + 1, y0 + h - bh, bw - 2, bh, style="F")
        pdf.set_xy(x0 + i * bw, y0 + h + 0.5)
        pdf.cell(bw, 4, labels[i], align="C")
    pdf.set_y(y0 + h + 6)


def generate_solar_report(project_name, design, project_details=None):
    """design = {inputs: {location, module, inverter, perString, irrSrc}, result: solar-size result, strings?: {items, strings,
    left, name}, protection?: solar-protection result, shading?: solar-shading result}. Returns a BytesIO."""
    pd = project_details or {}
    inp = design.get("inputs") or {}
    res = design.get("result")
    if not res:
        raise ValueError("Calculate the array on the Solar PV Design step 1 before making the report")
    pdf = ReportPDF(project_name=project_name, project_number=pd.get("projectNumber", ""))
    pdf.set_left_margin(15)
    pdf.set_right_margin(15)
    pdf.alias_nb_pages()
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 20)
    pdf.cell(0, 12, "Solar PV Design Report", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 11)
    pdf.cell(0, 6, _safe(project_name), new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 9)
    meta = [f"Date: {datetime.date.today().isoformat()}"]
    for k, lab in (("engineer", "Prepared by"), ("checkedBy", "Checked by")):
        if pd.get(k):
            meta.append(f"{lab}: {pd[k]}")
    pdf.cell(0, 5, _safe("   ".join(meta)), new_x="LMARGIN", new_y="NEXT")
    _p(pdf, "Design grade, not bankable.", 9, True)

    _h(pdf, "1. Site and data")
    _ltable(pdf, ["Item", "Value"], [
        ["Location", inp.get("location") or res.get("location", "-")],
        ["Irradiance data", res.get("irradiance_source", "-")],
        ["Energy model", res.get("model", "-")],
        ["Module", inp.get("module", "-")],
        ["Inverter", inp.get("inverter", "-")],
    ], [50, pdf.w - 30 - 50])
    if res.get("attribution"):
        _p(pdf, res["attribution"], 8, True)

    _h(pdf, "2. Array layout")
    rows = []
    for a in res.get("arrays") or []:
        rows.append([a.get("name") or "Roof", a.get("modules"), _n(a.get("kwp"), 2), _n(a.get("tilt_deg"), 0),
                     _n(a.get("azimuth_deg"), 0), _n(a.get("annual_kwh"))])
    if not rows:
        rows.append(["Array", res.get("modules"), _n(res.get("kwp"), 2), _n(res.get("tilt_deg"), 0), _n(res.get("azimuth_deg"), 0),
                     _n(res.get("annual_kwh"))])
    _table(pdf, ["Roof / plane", "Modules", "kWp", "Tilt (deg)", "Azimuth from north (deg)", "Annual energy (kWh)"], rows,
           [60, 25, 25, 25, 50, 50])
    tot = [f"Total {res.get('modules')} modules, {_n(res.get('kwp'), 2)} kWp"]
    if res.get("dc_ac_ratio"):
        tot.append(f"DC/AC ratio {res['dc_ac_ratio']}")
    tot.append(f"specific yield {_n(res.get('specific_yield_kwh_kwp'))} kWh/kWp, annual {_n(res.get('annual_kwh'))} kWh")
    _p(pdf, "; ".join(tot) + ".")

    _pictures(pdf, design.get("images"))

    _h(pdf, "3. Energy yield")
    months = res.get("months") or []
    names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    if months:
        _bars(pdf, [m.get("kwh", 0) for m in months], names, "Monthly AC energy (kWh)")
        cw = (pdf.w - 30 - 30) / 12
        _table(pdf, ["Month"] + names, [["kWh"] + [_n(m.get("kwh")) for m in months]], [30] + [cw] * 12)
    _h(pdf, "4. Losses")
    hourly = str(res.get("model", "")).startswith("hourly")
    loss_rows = [[LOSS_LABELS[k], f"{v * 100:.1f} %" if not (hourly and k == "inverter" and inp.get("inverter")) else "efficiency curve of the chosen inverter"]
                 for k, v in DEFAULT_LOSSES.items()]
    if res.get("clipping_loss_pct") is not None:
        loss_rows.append(["Inverter clipping (modelled hourly)", f"{res['clipping_loss_pct']} % of DC energy"])
    if res.get("shading_loss_pct") is not None:
        loss_rows.append(["Shading (obstruction above the array)", f"{res['shading_loss_pct']} %"])
    sh = design.get("shading")
    if sh:
        loss_rows.append(["Shading (3D roofs, per string)", f"{sh.get('loss_pct')} %"])
    loss_rows.append(["Temperature and incidence angle", "modelled hour by hour" if str(res.get("model", "")).startswith("hourly") else "temperature by month"])
    if res.get("performance_ratio"):
        loss_rows.append(["Performance ratio", f"{res['performance_ratio']}"])
    _ltable(pdf, ["Loss", "Value"], loss_rows, [90, 70])
    life = res.get("lifetime")
    if life:
        _h(pdf, "5. Energy over the system life")
        _p(pdf, "Annual energy after first-year degradation and the yearly rate (the headline annual energy above is the as-new typical year).")
        pick = [1, 2, 5, 10, 15, 20, 25]
        _table(pdf, ["Year"] + [str(y) for y in pick], [["Energy (kWh)"] + [_n(life[y - 1]["kwh"]) for y in pick]],
               [40] + [(pdf.w - 30 - 40) / len(pick)] * len(pick))

    strs = design.get("strings")
    if strs and strs.get("items"):
        _h(pdf, "6. String design checks")
        _p(pdf, f"{strs.get('strings', '-')} string(s) of {inp.get('perString', '-')} modules. Checks follow IEC 62548.")
        _ltable(pdf, ["Result", "Check"], [["PASS" if i.get("status") == "pass" else "FAIL" if i.get("status") == "fail" else str(i.get("status", "")).upper(),
                                           i.get("message", "")] for i in strs["items"]], [20, pdf.w - 30 - 20])
    prot = design.get("protection")
    if prot and prot.get("items"):
        _h(pdf, "7. DC protection and export")
        _ltable(pdf, ["Result", "Item"], [["OK" if i.get("ok") else "FAIL", i.get("label", "")] for i in prot["items"]], [20, pdf.w - 30 - 20])
        if prot.get("export_note"):
            _p(pdf, prot["export_note"])
    if sh:
        _h(pdf, "8. Annual shading")
        _p(pdf, f"Shading loss {sh.get('loss_pct')} % of the annual yield ({_n(sh.get('unshaded_kwh'))} to {_n(sh.get('shaded_kwh'))} kWh).")
        _table(pdf, ["Month"] + names, [["Loss %"] + [str(m.get("loss_pct")) for m in sh.get("months", [])]],
               [24] + [(pdf.w - 30 - 24) / 12] * 12)
        _table(pdf, ["Roof", "String", "Modules", "kWp", "Loss %"],
               [[s.get("array") or "", s.get("string"), s.get("modules"), _n(s.get("kwp"), 2), s.get("loss_pct")] for s in sh.get("strings", [])],
               [70, 25, 25, 25, 25])
        if sh.get("note"):
            _p(pdf, sh["note"], 8, True)
    _h(pdf, "9. Accuracy and limits")
    _p(pdf, HOURLY_CHECK if str(res.get("model", "")).startswith("hourly") else TABLE_CHECK)
    _p(pdf, LIMITS)

    buf = io.BytesIO()
    pdf.output(buf)
    buf.seek(0)
    return buf
