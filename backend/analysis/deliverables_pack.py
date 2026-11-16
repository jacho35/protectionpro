"""Build deliverables: one PDF from the project's separately made parts.

The client renders each part (design report, floor plans, DB single lines,
schedules, BOQ ...) as its own PDF; this puts them in one file with a cover
page (project info + revision table), a contents page with real page numbers,
outline bookmarks per group and section, and a running footer
"<project> · page N of M" on every page after the cover.
"""

import base64
import binascii
import io

from pypdf import PdfReader, PdfWriter
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas

MAX_PARTS = 300
MAX_PART_BYTES = 60 * 1024 * 1024
LINES_PER_CONTENTS_PAGE = 36


class PackError(ValueError):
    pass


def _read_parts(parts):
    out = []
    for i, p in enumerate(parts):
        if p.get("include") is False:
            continue
        try:
            raw = base64.b64decode(p.get("pdf_b64") or "", validate=True)
        except (binascii.Error, ValueError):
            raise PackError(f"Part {i + 1} ({p.get('title') or 'untitled'}) is not valid base64.")
        if not raw:
            raise PackError(f"Part {i + 1} ({p.get('title') or 'untitled'}) is empty.")
        if len(raw) > MAX_PART_BYTES:
            raise PackError(f"Part {i + 1} ({p.get('title') or 'untitled'}) is larger than 60 MB.")
        try:
            reader = PdfReader(io.BytesIO(raw))
            n = len(reader.pages)
        except Exception:
            raise PackError(f"Part {i + 1} ({p.get('title') or 'untitled'}) is not a readable PDF.")
        if n == 0:
            continue
        out.append({"group": p.get("group") or "", "title": p.get("title") or f"Part {i + 1}",
                    "reader": reader, "pages": n})
    return out


def _cover(project_name, details, revisions):
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    w, h = A4
    c.setFont("Helvetica-Bold", 26)
    c.drawString(25 * mm, h - 60 * mm, project_name or "Project")
    c.setFont("Helvetica", 12)
    y = h - 75 * mm
    for label, key in (("Client", "client"), ("Project number", "number"), ("Prepared by", "designer"),
                       ("Checked by", "checker"), ("Revision", "revision"), ("Date", "date")):
        v = (details or {}).get(key)
        if v:
            c.setFont("Helvetica-Bold", 10)
            c.drawString(25 * mm, y, label.upper())
            c.setFont("Helvetica", 12)
            c.drawString(65 * mm, y, str(v)[:80])
            y -= 8 * mm
    if revisions:
        y -= 8 * mm
        c.setFont("Helvetica-Bold", 10)
        for x, t in ((25, "REV"), (40, "DATE"), (70, "DESCRIPTION"), (160, "BY")):
            c.drawString(x * mm, y, t)
        y -= 2 * mm
        c.line(25 * mm, y, w - 25 * mm, y)
        y -= 6 * mm
        c.setFont("Helvetica", 10)
        for r in revisions[:20]:
            c.drawString(25 * mm, y, str(r.get("rev", ""))[:6])
            c.drawString(40 * mm, y, str(r.get("date", ""))[:12])
            c.drawString(70 * mm, y, str(r.get("description", ""))[:60])
            c.drawString(160 * mm, y, str(r.get("by", ""))[:12])
            y -= 6 * mm
    c.showPage()
    c.save()
    buf.seek(0)
    return PdfReader(buf)


def _contents(project_name, entries, pages):
    """entries: [(indent, text, page or None)] → a PdfReader of ``pages`` contents pages."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    w, h = A4
    for pg in range(pages):
        c.setFont("Helvetica-Bold", 16)
        c.drawString(25 * mm, h - 30 * mm, "Contents" if pg == 0 else "Contents (continued)")
        y = h - 42 * mm
        for indent, text, page in entries[pg * LINES_PER_CONTENTS_PAGE:(pg + 1) * LINES_PER_CONTENTS_PAGE]:
            c.setFont("Helvetica-Bold" if indent == 0 else "Helvetica", 11 if indent == 0 else 10)
            c.drawString((25 + 8 * indent) * mm, y, text[:80])
            if page is not None:
                c.drawRightString(w - 25 * mm, y, str(page))
            y -= 6.5 * mm
        c.showPage()
    c.save()
    buf.seek(0)
    return PdfReader(buf)


def _footer(width, height, text):
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(width, height))
    c.setFont("Helvetica", 8)
    c.setFillGray(0.35)
    c.drawString(12 * mm, 6 * mm, text[0])
    c.drawRightString(width - 12 * mm, 6 * mm, text[1])
    c.showPage()
    c.save()
    buf.seek(0)
    return PdfReader(buf).pages[0]


def build_pack(project_name, parts, details=None, revisions=None):
    """Returns (BytesIO of the PDF, contents list [{group, title, first_page, pages}])."""
    if len(parts) > MAX_PARTS:
        raise PackError(f"At most {MAX_PARTS} parts.")
    parts = _read_parts(parts)
    if not parts:
        raise PackError("No sections were selected.")

    # contents lines: a group heading, then its sections with their first page
    lines, order = [], []
    group = None
    for p in parts:
        if p["group"] != group:
            group = p["group"]
            if group:
                lines.append([0, group, None])
        lines.append([1 if group else 0, p["title"], None])
        order.append(len(lines) - 1)
    cpages = max(1, -(-len(lines) // LINES_PER_CONTENTS_PAGE))
    page = 1 + cpages + 1           # cover, contents, then the first part
    toc = []
    for p, li in zip(parts, order):
        lines[li][2] = page
        toc.append({"group": p["group"], "title": p["title"], "first_page": page, "pages": p["pages"]})
        page += p["pages"]
    total = page - 1

    w = PdfWriter()
    for src in (_cover(project_name, details, revisions or []), _contents(project_name, lines, cpages)):
        for pg in src.pages:
            w.add_page(pg)
    parent = None
    last_group = None
    for p, t in zip(parts, toc):
        start = len(w.pages)
        for pg in p["reader"].pages:
            w.add_page(pg)
        if p["group"] and p["group"] != last_group:
            parent = w.add_outline_item(p["group"], start)
            last_group = p["group"]
        elif not p["group"]:
            parent, last_group = None, None
        w.add_outline_item(p["title"], start, parent=parent)
    for i, pg in enumerate(w.pages):
        if i == 0:
            continue
        pw, ph = float(pg.mediabox.width), float(pg.mediabox.height)
        pg.merge_page(_footer(pw, ph, (project_name or "Project", f"page {i + 1} of {total}")))
    out = io.BytesIO()
    w.write(out)
    out.seek(0)
    return out, toc
