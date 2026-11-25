"""Plan DXF export: the layout sheets' title block (from a company DXF template), each sheet's legend, and the cable
labels as leaders placed clear of the drawing.

The template is any DXF in the template folder (`PP_DXF_TEMPLATES`, default `<repo>/templates`) that holds title-block
blocks named `…-TB-A0` … `…-TB-A4` (paper mm, origin at the sheet's lower-left corner). From the chosen one:
- the frame = its closed polyline, the title panel = the vertical line that runs the frame's height, the legend = the
  tallest gap between the panel's full-width lines;
- its attributes are filled by tag (`DRAWING_NO`, `PROJECT_NAME`, `REV1_DESC`, …): whatever the payload sends; a tag it
  does not send keeps the template's default.
No template → the sheets are drawn as before (viewport within a margin) with the legend in a column on the right.
"""
from __future__ import annotations

import math
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import ezdxf
from ezdxf.enums import TextEntityAlignment

TITLE_LAYER = "EL_TITLE"
LEGEND_LAYER = "EL_LEGEND"
_TB_RE = re.compile(r"-TB-(A[0-4])$", re.I)
_TEMPLATE_CACHE: Dict[str, Tuple[float, Any]] = {}

ISO_LW = (13, 18, 25, 35, 50, 70, 100)      # hundredths of a mm


def iso_lineweight(px: float) -> int:
    """A line the plan draws `px` screen pixels wide → its DXF line weight: px × 0.175 mm, the nearest ISO pen."""
    want = max(0.0, float(px or 0)) * 17.5
    return min(ISO_LW, key=lambda w: abs(w - want))


# ── Template ─────────────────────────────────────────────────────────────

def template_dir() -> Path:
    env = os.environ.get("PP_DXF_TEMPLATES")
    return Path(env) if env else Path(__file__).resolve().parents[2] / "templates"


def upload_dir() -> Path:
    """Where a template uploaded from the app is kept: `PP_DXF_UPLOADS`, else next to the database (its volume)."""
    env = os.environ.get("PP_DXF_UPLOADS")
    if env:
        return Path(env)
    try:
        from sqlalchemy.engine import make_url
        from ..models.database import DATABASE_URL
        u = make_url(DATABASE_URL)
        if u.get_backend_name() == "sqlite" and u.database and u.database != ":memory:":
            return Path(u.database).resolve().parent / "dxf_templates"
    except Exception:
        pass
    return template_dir() / "uploaded"


def uploaded_path() -> Path:
    return upload_dir() / "template.dxf"


def validate_template(raw: bytes) -> str:
    """Parse an uploaded DXF; raises ValueError (a message for the user) unless it holds title blocks `…-TB-A0..A4`."""
    import io
    try:
        text = raw.decode("utf-8", "ignore") if raw[:2] != b"\xff\xfe" else raw.decode("utf-16")
        doc = ezdxf.read(io.StringIO(text))
    except Exception:
        try:
            import tempfile
            with tempfile.NamedTemporaryFile(suffix=".dxf") as f:
                f.write(raw); f.flush()
                doc = ezdxf.readfile(f.name)
        except Exception as e:
            raise ValueError(f"Could not read that DXF: {e}")
    names = [b.name for b in doc.blocks if _TB_RE.search(b.name)]
    if not names:
        raise ValueError("That DXF has no title blocks. It needs blocks named like DVM-TB-A1 (one per paper size, A0 to A4).")
    return _TB_RE.sub("", names[0])


def _load_template():
    """The first DXF (an uploaded one first, then the template folder) that has title blocks, read once per file
    version; None when there is none."""
    files = []
    up = uploaded_path()
    if up.is_file():
        files.append(up)
    d = template_dir()
    if d.is_dir():
        files += sorted(d.glob("*.dxf")) + sorted(d.glob("*.DXF"))
    for p in files:
        try:
            mt = p.stat().st_mtime
            hit = _TEMPLATE_CACHE.get(str(p))
            if hit and hit[0] == mt:
                doc = hit[1]
            else:
                doc = ezdxf.readfile(str(p))
                _TEMPLATE_CACHE[str(p)] = (mt, doc)
            if any(_TB_RE.search(b.name) for b in doc.blocks):
                return doc
        except Exception:
            continue
    return None


def template_info() -> Dict[str, Any]:
    """What the export dialog shows: whether a template is there and which paper sizes it has."""
    t = _load_template()
    if t is None:
        return {"available": False, "papers": {}}
    papers = {}
    for b in t.blocks:
        m = _TB_RE.search(b.name)
        if not m:
            continue
        g = title_block_geometry(t, b.name)
        if g and g.get("panel") is not None:
            fx0, fy0, fx1, fy1 = g["frame"]
            papers[m.group(1).upper()] = {"viewport": [round(g["panel"] - 3 - (fx0 + 3), 1), round(fy1 - fy0 - 6, 1)]}
    if not papers:
        return {"available": False, "papers": {}}
    name = next(b.name for b in t.blocks if _TB_RE.search(b.name))
    return {"available": True, "papers": papers, "name": _TB_RE.sub("", name)}


def import_title_block(doc, paper: str) -> Optional[str]:
    """Copy the template's title block for `paper` (and the blocks / styles it uses) into `doc`; its block name, or None."""
    t = _load_template()
    if t is None:
        return None
    src = next((b.name for b in t.blocks if _TB_RE.search(b.name) and _TB_RE.search(b.name).group(1).upper() == paper.upper()), None)
    if not src:
        return None
    from ezdxf.addons import Importer
    imp = Importer(t, doc)
    imp.import_block(src)
    styles = [s.dxf.name for s in t.styles if s.dxf.name.lower() != "standard"]
    if styles:
        imp.import_table("styles", styles, replace=False)
    imp.finalize()
    return src if src in doc.blocks else None


def title_block_geometry(doc, name: str) -> Optional[Dict[str, Any]]:
    """Frame, title-panel x and legend rectangle of a title block (paper mm)."""
    blk = doc.blocks.get(name)
    if blk is None:
        return None
    frame = None
    for e in blk.query("LWPOLYLINE"):
        pts = [(p[0], p[1]) for p in e.get_points()]
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        bb = (min(xs), min(ys), max(xs), max(ys))
        if frame is None or (bb[2] - bb[0]) * (bb[3] - bb[1]) > (frame[2] - frame[0]) * (frame[3] - frame[1]):
            frame = bb
    if frame is None:
        return None
    x0, y0, x1, y1 = frame
    lines = [(e.dxf.start, e.dxf.end) for e in blk.query("LINE")]
    panel = None
    for s, t in lines:
        if abs(s.x - t.x) < 0.01 and abs(abs(t.y - s.y) - (y1 - y0)) < 1.0 and x0 + 1 < s.x < x1 - 1:
            panel = s.x if panel is None else min(panel, s.x)
    if panel is None:
        return {"frame": frame, "panel": None, "legend": None}
    ys = sorted({round(s.y, 3) for s, t in lines if abs(s.y - t.y) < 0.01
                 and abs(min(s.x, t.x) - panel) < 1.0 and abs(max(s.x, t.x) - x1) < 1.0} | {y0, y1})
    gap = max(((ys[i], ys[i + 1]) for i in range(len(ys) - 1)), key=lambda g: g[1] - g[0])
    return {"frame": frame, "panel": panel, "legend": (panel, gap[0], x1, gap[1])}


# ── Title-block text that fits its box ──────────────────────────────────

# Arial / Helvetica advance widths (1/1000 em) and cap height: enough to measure a line without the font file on the server.
_W = dict(zip(" !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~",
              [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278] + [556] * 10 +
              [278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
               667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278,
               556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584]))
_CAP = 0.716
MIN_WIDTH_FACTOR = 0.5


def text_width(text: str, height: float, font: str = "", width_factor: float = 1.0) -> float:
    """Width (drawing units) of `text` at cap `height` in Arial (Arial Narrow when the font file says so: 82 %)."""
    em = height / _CAP
    narrow = 0.82 if "n.ttf" in (font or "").lower() or "narrow" in (font or "").lower() else 1.0
    return sum(_W.get(c, 556) for c in str(text)) / 1000.0 * em * narrow * width_factor


def _attdef_x(a):
    h = a.dxf.get("halign", 0)
    return (a.dxf.align_point.x if h and a.dxf.hasattr("align_point") else a.dxf.insert.x), h


def attdef_room(blk, a) -> float:
    """How wide the text of attribute definition `a` may run: to the nearest line of the block across its row (either side for a
    centred one, leftward for a right-aligned one), 1 mm clear; the block's outline counts as a line."""
    x, h = _attdef_x(a)
    y = a.dxf.insert.y + a.dxf.height / 2.0
    xs = []
    for e in blk.query("LINE"):
        s, t = e.dxf.start, e.dxf.end
        if abs(s.x - t.x) < 0.01 and min(s.y, t.y) - 0.5 <= y <= max(s.y, t.y) + 0.5:
            xs.append(s.x)
    for e in blk.query("LWPOLYLINE"):
        pts = [(p[0], p[1]) for p in e.get_points()]
        if e.closed:
            pts.append(pts[0])
        for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
            if abs(x0 - x1) < 0.01 and min(y0, y1) - 0.5 <= y <= max(y0, y1) + 0.5:
                xs.append(x0)
    right = min([v for v in xs if v > x + 0.5], default=None)
    left = max([v for v in xs if v < x - 0.5], default=None)
    return _room_raw(x, h, left, right) * ROOM_MARGIN if _room_raw(x, h, left, right) < 1e8 else 1e9


ROOM_MARGIN = 0.95          # the width estimate is Arial's metrics; CAD fonts and renderers differ by a few per cent


def _room_raw(x, h, left, right):
    if h == 2:
        return (x - left - 1.0) if left is not None else 1e9
    if h in (1, 4):
        if left is None or right is None:
            return 1e9
        return 2 * min(x - left, right - x) - 2.0
    return (right - x - 1.0) if right is not None else 1e9


def _wrap(words: List[str], room: float, width) -> List[str]:
    lines, cur = [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if cur and width(t) > room:
            lines.append(cur)
            cur = w
        else:
            cur = t
    if cur:
        lines.append(cur)
    return lines


def fit_attribs(doc, block_name: str, values: Dict[str, str]) -> Dict[str, Tuple[str, float, float]]:
    """The title block's text so every value stays inside its box. A numbered group (DRAWING_TITLE1–3, PROJECT_NAME +
    PROJECT_NAME2) is one text wrapped word by word over its lines, the values joined in order. What does not fit at the
    template's height is tried smaller (down to 60 %), then narrowed by the width factor, so nothing runs past its box.
    Returns {tag: (text, width factor, height)} for every attribute definition of the block."""
    blk = doc.blocks.get(block_name)
    defs = {a.dxf.tag: a for a in blk.attdefs()}
    out: Dict[str, Tuple[str, float, float]] = {}
    groups: Dict[str, List[str]] = {}
    for tag in defs:
        m = re.match(r"^(.*?[A-Z_])(\d+)$", tag)
        base = m.group(1) if m else tag
        if m and (base in defs or base + "1" in defs or any(t != tag and re.match(re.escape(base) + r"\d+$", t) for t in defs)):
            groups.setdefault(base, []).append(tag)
        elif not m and (tag + "2") in defs:
            groups.setdefault(tag, []).append(tag)
    for tags in groups.values():
        tags.sort(key=lambda t: -defs[t].dxf.insert.y)          # top line first
    grouped = {t for ts in groups.values() for t in ts}

    def font_of(a):
        st = doc.styles.get(a.dxf.style) if a.dxf.style in doc.styles else None
        return st.dxf.font if st is not None else ""

    def wf0(a):
        return float(a.dxf.get("width", 1.0) or 1.0)

    def fit_lines(texts: List[str], a, room, n) -> List[Tuple[str, float, float]]:
        """`texts` over `n` lines of attdef `a`'s size: (line, width factor, height) each."""
        h0, wf, font = a.dxf.height, wf0(a), font_of(a)
        words = " ".join(t for t in texts if t).split()
        if room <= 0 or room > 1e8 or not words:
            lines = _wrap(words, room if 0 < room < 1e8 else 1e9, lambda t: text_width(t, h0, font, wf)) if words else []
            lines = (lines[:n - 1] + [" ".join(lines[n - 1:])]) if len(lines) > n else lines
            return [(l, wf, h0) for l in lines + [""] * (n - len(lines))]
        for k in (1.0, 0.9, 0.8, 0.7, 0.6):
            h = h0 * k
            width = lambda t, h=h: text_width(t, h, font, wf)
            lines = _wrap(words, room, width)
            if len(lines) <= n and all(width(l) <= room for l in lines):
                return [(l, wf, h) for l in lines + [""] * (n - len(lines))]
            if k == 0.6:
                if len(lines) > n:
                    lines = lines[:n - 1] + [" ".join(lines[n - 1:])]
                res = []
                for l in lines + [""] * (n - len(lines)):
                    w = width(l)
                    res.append((l, wf * room / w if w > room else wf, h))
                return res
        return []

    for tag, a in defs.items():
        if tag not in grouped:
            text = str(values[tag]) if tag in values else a.dxf.text
            room = attdef_room(blk, a)
            if " " not in text.strip():
                h0, wf, w = a.dxf.height, wf0(a), text_width(text, a.dxf.height, font_of(a), wf0(a))
                out[tag] = (text, wf * room / w if 0 < room < w else wf, h0) if w <= room or w * MIN_WIDTH_FACTOR > room \
                    else (text, max(MIN_WIDTH_FACTOR, wf * room / w), h0)
            else:
                (out[tag],) = fit_lines([text], a, room, 1)
    for base, tags in groups.items():
        if not any(t in values for t in tags):
            for t in tags:
                out[t] = (defs[t].dxf.text, wf0(defs[t]), defs[t].dxf.height)
            continue
        room = min(attdef_room(blk, defs[t]) for t in tags)
        for t, v in zip(tags, fit_lines([str(values.get(t, "") or "") for t in tags], defs[tags[0]], room, len(tags))):
            out[t] = v
    return out


# ── Legend ───────────────────────────────────────────────────────────────

GROUPS = (("equipment", "EQUIPMENT"), ("cables", "CABLES & ROUTES"), ("ducts", "DUCTS & TRENCHES"),
          ("labels", "LABELS"), ("notes", "NOTES"))


def _on_sheet(layer: Optional[str], sid: str, layer_sheets: Dict[str, Any]) -> bool:
    if not layer:
        return True
    s = layer_sheets.get(layer)
    return not isinstance(s, list) or sid in s


def draw_legend(doc, layout, rect, overflow_rect_fn, sid: str, payload: Dict[str, Any], layer_sheets: Dict[str, Any],
                style: str, scale: float, factor: float, title: bool) -> None:
    """The sheet's legend in paper space: what is on the sheet (entries whose layer it shows), cables per size with their
    total length, a sample label, and the notes. `rect` = (x0, y0, x1, y1) mm; past its bottom it carries on in
    `overflow_rect_fn(height)`."""
    leg = payload.get("legend") or {}
    entries = [e for e in (leg.get("entries") or []) if _on_sheet(e.get("layer"), sid, layer_sheets)]
    notes = [n for n in (leg.get("notes") or []) if _on_sheet(n.get("layer"), sid, layer_sheets)]
    show_len = leg.get("lengths", True)
    label_style = (payload.get("labels") or {}).get("style") or "circle"
    variants = payload.get("blocks") or {}

    # rows: (height, draw(x0, y_top, x1))
    rows = []
    T, S, HD = 2.5, 2.2, 2.1                         # text, sub-line, group heading heights (mm)

    def text(s, x, y, h, align=TextEntityAlignment.MIDDLE_LEFT, color=None):
        a = {"height": h, "style": style, "layer": LEGEND_LAYER}
        if color is not None:
            a["true_color"] = color
        layout.add_text(str(s), dxfattribs=a).set_placement((x, y), align=align)

    def rgb(hexs):
        hexs = (hexs or "").lstrip("#")
        if len(hexs) != 6:
            return None
        return ezdxf.rgb2int(tuple(int(hexs[i:i + 2], 16) for i in (0, 2, 4)))

    def heading(label):
        rows.append((6.0, lambda x0, y, x1, label=label: text(label, x0 + 2, y - 3.6, HD, color=ezdxf.rgb2int((90, 100, 112)))))

    def sample(e, x, y):
        kind = e.get("kind")
        col = rgb(e.get("color"))
        a = {"layer": LEGEND_LAYER}
        if col is not None:
            a["true_color"] = col
        if kind == "symbol" and e.get("block") in doc.blocks:
            size_m = (variants.get(e["block"], {}).get("sizeWorld", 24) or 24) * factor
            s = 1000.0 / scale
            if size_m * s > 6.0:
                s = 6.0 / size_m
            layout.add_blockref(e["block"], (x + 6.5, y), dxfattribs={**a, "xscale": s, "yscale": s})
        elif kind == "band":
            pl = layout.add_lwpolyline([(x + 1, y), (x + 12, y)], dxfattribs={**a, "const_width": 2.0})
            if e.get("alpha") is not None:
                pl.transparency = max(0.0, min(1.0, 1.0 - float(e["alpha"])))
        elif kind == "crossing":
            layout.add_line((x + 6.5, y - 3), (x + 6.5, y + 3), dxfattribs={**a, "lineweight": int(e.get("lw") or 50)})
        else:
            lt = e.get("linetype")
            if lt and lt in doc.linetypes and lt.upper() != "CONTINUOUS":
                a["linetype"] = lt
                a["ltscale"] = 30.0 / scale            # LTSCALE is scale/100: a dash a third of the pattern on paper
            if e.get("lw"):
                a["lineweight"] = int(e["lw"])
            layout.add_line((x + 0.5, y), (x + 12.5, y), dxfattribs=a)

    for gk, glabel in GROUPS:
        if gk == "labels":
            if not any(e.get("group") == "cables" for e in entries):
                continue
            heading(glabel)

            def lab(x0, y, x1):
                yc = y - 4.5
                layout.add_line((x0 + 2, yc), (x0 + 15, yc), dxfattribs={"layer": LEGEND_LAYER, "true_color": ezdxf.rgb2int((194, 65, 12))})
                px, py = x0 + 5, yc
                if label_style == "arrow":
                    layout.add_solid([(px, py), (px + 0.7, py + 1.6), (px + 1.3, py + 1.2)], dxfattribs={"layer": LEGEND_LAYER})
                else:
                    layout.add_circle((px, py), 1.1, dxfattribs={"layer": LEGEND_LAYER})
                layout.add_lwpolyline([(px + 0.5, py + 1.0), (px + 3, py + 3.5), (x0 + 15, py + 3.5)], dxfattribs={"layer": LEGEND_LAYER})
                text("Cable label:", x0 + 19, yc + 1.6, T)
                text("type, then route length", x0 + 19, yc - 1.8, S)
            rows.append((10.0, lab))
            continue
        if gk == "notes":
            if not notes:
                continue
            heading(glabel)
            for i, n in enumerate(notes, 1):
                rows.append((4.5, lambda x0, y, x1, i=i, n=n: text(f"{i}. {n.get('text', '')}", x0 + 2, y - 2.4, S)))
            continue
        group = [e for e in entries if e.get("group") == gk]
        if not group:
            continue
        heading(glabel)
        for e in group:
            def row(x0, y, x1, e=e):
                sample(e, x0 + 2, y - 3.5)
                text(e.get("label", ""), x0 + 19, y - 3.5, T)
            rows.append((7.0, row))
            for it in e.get("items") or []:
                def sub(x0, y, x1, it=it):
                    text(it.get("text", ""), x0 + 21, y - 2.2, S, color=ezdxf.rgb2int((60, 69, 80)))
                    if show_len and it.get("lenM") is not None:
                        text(f"{float(it['lenM']):,.0f} m".replace(",", " "), x1 - 2, y - 2.2, S,
                             align=TextEntityAlignment.MIDDLE_RIGHT, color=ezdxf.rgb2int((60, 69, 80)))
                rows.append((4.4, sub))
    if not rows:
        return

    x0, y0, x1, y1 = rect
    y = y1
    if title:
        y -= 0.0                                     # the template's PANEL_TITLE holds the heading
    else:
        text("LEGEND", x0 + 2, y - 4, 3.0)
        y -= 7.0
    i = 0
    while i < len(rows) and y - rows[i][0] >= y0 + 1:
        h, fn = rows[i]
        fn(x0, y, x1)
        y -= h
        i += 1
    if i < len(rows):                                # carry on in a box in the drawing area
        rest = rows[i:]
        need = sum(h for h, _ in rest) + 4
        bx0, by0, bx1, by1 = overflow_rect_fn(need)
        layout.add_lwpolyline([(bx0, by0), (bx1, by0), (bx1, by1), (bx0, by1)], close=True, dxfattribs={"layer": LEGEND_LAYER})
        y = by1 - 2
        for h, fn in rest:
            fn(bx0, y, bx1)
            y -= h


# ── Cable labels as leaders ──────────────────────────────────────────────

class _Grid:
    def __init__(self, cell):
        self.c = max(cell, 1e-6)
        self.cells: Dict[Tuple[int, int], List[int]] = {}
        self.items: List[Tuple[str, Any, Any]] = []

    def _keys(self, bx0, by0, bx1, by1):
        c = self.c
        for i in range(int(math.floor(bx0 / c)), int(math.floor(bx1 / c)) + 1):
            for j in range(int(math.floor(by0 / c)), int(math.floor(by1 / c)) + 1):
                yield (i, j)

    def add(self, kind, geom, owner, bb):
        k = len(self.items)
        self.items.append((kind, geom, owner))
        for key in self._keys(*bb):
            self.cells.setdefault(key, []).append(k)

    def near(self, bb):
        seen = set()
        for key in self._keys(*bb):
            for k in self.cells.get(key, ()):
                if k not in seen:
                    seen.add(k)
                    yield self.items[k]


def _seg_seg(a, b, c, d):
    def cr(o, p, q):
        return (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0])
    d1, d2, d3, d4 = cr(c, d, a), cr(c, d, b), cr(a, b, c), cr(a, b, d)
    return ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0))


def _seg_box(a, b, box):
    x0, y0, x1, y1 = box
    if max(a[0], b[0]) < x0 or min(a[0], b[0]) > x1 or max(a[1], b[1]) < y0 or min(a[1], b[1]) > y1:
        return False
    if x0 <= a[0] <= x1 and y0 <= a[1] <= y1 or x0 <= b[0] <= x1 and y0 <= b[1] <= y1:
        return True
    corners = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    return any(_seg_seg(a, b, corners[i], corners[(i + 1) % 4]) for i in range(4))


def _box_box(p, q):
    return not (p[2] < q[0] or q[2] < p[0] or p[3] < q[1] or q[3] < p[1])


ANGLES = (60, 120, 300, 240, 45, 135, 315, 225, 75, 105, 285, 255, 30, 150, 330, 210)


def place_labels(msp, doc, routes: List[dict], obstacles: List[Tuple[float, float, float]], H: float, style: str,
                 text_style: str, taken: Optional[List[Tuple]] = None) -> int:
    """Each route with `labelLines` gets one MULTILEADER: horizontal text in a clear spot, a leader back to the cable
    ending in an open circle round it (`style` 'circle') or an arrow onto it ('arrow'). Cables running side by side
    (a shared trench) get one leader each to one stacked label. `routes[i]['ptsM']` = the route in metres.
    `obstacles` = (x, y, half size) of every symbol. `taken`, when given, collects what the labels use ('box', text box) and
    ('seg', leader start, end) for whatever is placed after them. Returns how many leaders were written."""
    from ezdxf.render import mleader
    from ezdxf.render.arrows import ARROWS
    from ezdxf.math import Vec2

    sname = "EL_CABLE_ARROW" if style == "arrow" else "EL_CABLE_CIRCLE"
    if sname not in doc.mleader_styles:
        doc.mleader_styles.duplicate_entry("Standard", sname)

    cw, lh = 0.6 * H, 1.667 * H                       # character width, MTEXT line pitch
    dog, gap = 1.5 * H, 0.4 * H
    grid = _Grid(12 * H)
    segs_of: Dict[int, List[Tuple[Tuple[float, float], Tuple[float, float]]]] = {}
    for ri, r in enumerate(routes):
        pts = r.get("ptsM") or []
        segs = [(pts[i - 1], pts[i]) for i in range(1, len(pts)) if pts[i - 1] != pts[i]]
        segs_of[ri] = segs
        for a, b in segs:
            grid.add("seg", (a, b), ri, (min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1])))
    for (x, y, h) in obstacles:
        bb = (x - h, y - h, x + h, y + h)
        grid.add("box", bb, None, bb)

    def score(owners, A, E, box):
        s = 0
        for kind, g, own in grid.near(box):
            if kind == "seg":
                if _seg_box(g[0], g[1], box):
                    s += 100
            elif _box_box(g, box):
                s += 100
        lb = (min(A[0], E[0]), min(A[1], E[1]), max(A[0], E[0]), max(A[1], E[1]))
        for kind, g, own in grid.near(lb):
            if kind == "seg":
                if own not in owners and _seg_seg(A, E, g[0], g[1]):
                    s += 8
            elif kind in ("box", "label") and _seg_box(A, E, g):
                s += 30
        return s

    def along(ri, A):
        """Nearest point of route ri to A, and the direction of that segment."""
        best = None
        for a, b in segs_of.get(ri, ()):
            dx, dy = b[0] - a[0], b[1] - a[1]
            L2 = dx * dx + dy * dy
            t = max(0.0, min(1.0, ((A[0] - a[0]) * dx + (A[1] - a[1]) * dy) / L2))
            P = (a[0] + t * dx, a[1] + t * dy)
            d = math.hypot(P[0] - A[0], P[1] - A[1])
            if best is None or d < best[0]:
                best = (d, P, math.atan2(dy, dx))
        return best

    done = set()
    order = sorted(range(len(routes)), key=lambda i: -sum(math.dist(a, b) for a, b in segs_of[i]))
    written = 0
    for ri in order:
        r = routes[ri]
        if ri in done or not r.get("labelLines") or not segs_of[ri]:
            continue
        segs = sorted(segs_of[ri], key=lambda s: -math.dist(*s))[:3]
        anchors = []
        for a, b in segs:
            for t in (0.5, 0.3, 0.7):
                anchors.append(((a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])), math.atan2(b[1] - a[1], b[0] - a[0])))
        # cables running alongside at the first anchor share the label
        A0, th0 = anchors[0]
        members = [ri]
        for rj, rr in enumerate(routes):
            if rj == ri or rj in done or not rr.get("labelLines"):
                continue
            hit = along(rj, A0)
            if hit and hit[0] <= 2.5 * H:
                dth = abs((hit[2] - th0 + math.pi / 2) % math.pi - math.pi / 2)
                if dth < math.radians(15):
                    members.append(rj)
        if len(members) > 1:
            lines = [" · ".join(x for x in routes[m]["labelLines"] if x) for m in members]
        else:
            lines = list(r["labelLines"])
        w = max(len(s) for s in lines) * cw
        h = len(lines) * lh
        best = None
        for (A, th) in (anchors[:1] if len(members) > 1 else anchors):
            for mult in (1.0, 1.6, 2.4, 3.2):
                L = 5 * H * mult
                for deg in ANGLES:
                    ang = math.radians(deg)
                    rel = abs((ang - th + math.pi / 2) % math.pi - math.pi / 2)
                    if rel < math.radians(25):
                        continue
                    E = (A[0] + L * math.cos(ang), A[1] + L * math.sin(ang))
                    right = math.cos(ang) >= 0
                    tx = E[0] + dog + gap if right else E[0] - dog - gap - w
                    box = (tx, E[1] - h / 2, tx + w, E[1] + h / 2)
                    s = score(set(members), A, E, box) + mult * 0.5
                    if best is None or s < best[0]:
                        best = (s, A, E, right, box)
                    if s < 1.6:
                        break
                if best[0] < 1.6:
                    break
            if best and best[0] < 1.6:
                break
        if best is None:
            continue
        _, A, E, right, box = best
        ml = msp.add_multileader_mtext(sname, dxfattribs={"layer": r.get("labelLayer") or "0"})
        ml.set_content("\\P".join(lines), char_height=H, style=text_style,
                       alignment=mleader.TextAlignment.left if right else mleader.TextAlignment.right)
        ml.set_arrow_properties(name=ARROWS.closed_filled if style == "arrow" else ARROWS.dot_blank, size=H)
        ml.set_connection_properties(landing_gap=gap, dogleg_length=dog)
        ml.set_connection_types(left=mleader.HorizontalConnection.middle_of_text,
                                right=mleader.HorizontalConnection.middle_of_text)
        side = mleader.ConnectionSide.left if right else mleader.ConnectionSide.right
        for m in members:
            P = A if m == ri else along(m, A)[1]
            ml.add_leader_line(side, [Vec2(P[0], P[1])])
        ml.build(insert=Vec2(box[0] if right else box[2], box[3]))
        grid.add("label", box, None, box)
        lb = (min(A[0], E[0]), min(A[1], E[1]), max(A[0], E[0]), max(A[1], E[1]))
        grid.add("seg", (A, E), -1, lb)
        if taken is not None:
            taken.append(("box", box))
            taken.append(("seg", A, E))
        done.update(members)
        written += 1
    return written


def _seg_seg_touch(a, b, c, d) -> bool:
    """Segments that cross or touch (collinear overlaps included)."""
    def on(p, q, r):
        return min(p[0], q[0]) - 1e-9 <= r[0] <= max(p[0], q[0]) + 1e-9 and min(p[1], q[1]) - 1e-9 <= r[1] <= max(p[1], q[1]) + 1e-9

    def cr(o, p, q):
        return (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0])
    d1, d2, d3, d4 = cr(c, d, a), cr(c, d, b), cr(a, b, c), cr(a, b, d)
    if ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0)):
        return True
    return (abs(d1) < 1e-9 and on(c, d, a)) or (abs(d2) < 1e-9 and on(c, d, b)) or (abs(d3) < 1e-9 and on(a, b, c)) or (abs(d4) < 1e-9 and on(a, b, d))


def place_crossing_labels(doc, msp, labels: List[dict], obstacles: List[Tuple[float, float, float]], H: float,
                          layer: str, text_style: str, block_prefix: str, avoid_lines: List[List[Tuple[float, float]]],
                          all_ducts: List[Tuple], taken: Optional[List[Tuple]] = None, meta=None) -> int:
    """A leader and a circle with the duct count ('3L/4S': large 160 mm / small 110 mm) for each road crossing, each one
    a BLOCK (`block_prefix` + n: the leader, a dot on the crossing, the circle and a COUNT attribute, drawn relative to
    the crossing's centre) inserted on `layer`.

    `labels` = [{ 'a': the crossing's centre (m), 'dir': its direction, 'text': '3L/4S', 'ducts': [(p, q), ...] its ducts }].
    Clash detection: the circle (with a margin) keeps clear of the symbols, every cable / trench / room line
    (`avoid_lines`, polylines in m), every duct of every crossing (`all_ducts`, a crossing with no label too), the cable labels already placed (`taken`) and the
    circles already placed; the leader keeps off the symbols and other labels and crosses as few lines as it can.
    Spots tried: both sides of the road, sliding along the crossing, further out in steps; the cleanest wins, and the
    first without any clash is taken at once."""
    margin = 0.35 * H
    segs = [(p, q) for pl in avoid_lines for p, q in zip(pl, pl[1:]) if p != q]
    fixed_boxes = [t[1] for t in (taken or []) if t[0] == "box"]
    fixed_segs = [(t[1], t[2]) for t in (taken or []) if t[0] == "seg"]
    placed: List[Tuple[float, float, float, float]] = []
    placed_leaders: List[Tuple[Tuple[float, float], Tuple[float, float]]] = []
    count = 0
    for k, lab in enumerate(labels):
        a, d, text = lab["a"], lab["dir"], str(lab["text"])
        dl = math.hypot(*d) or 1.0
        d = (d[0] / dl, d[1] / dl)
        n = (-d[1], d[0])                                  # along the road
        own = {tuple(x) for x in lab.get("ducts", [])}
        others = [x for x in all_ducts if x not in own]
        r = max(1.3 * H, 0.6 * H * len(text) / 2 + 0.6 * H)
        # half the bundle's width across the road, so the circle starts clear of its own ducts
        half = max([abs((p[0] - a[0]) * n[0] + (p[1] - a[1]) * n[1]) for x in own for p in x] or [0.0])
        # only what is near enough to matter (the search reaches `reach` from the crossing)
        step = r + 2.0 * H
        reach = half + r + margin + step * 0.45 * 30 + r + margin
        near_box = (a[0] - reach, a[1] - reach, a[0] + reach, a[1] + reach)

        def near(sg):
            return [(p, q) for p, q in sg if not (max(p[0], q[0]) < near_box[0] or min(p[0], q[0]) > near_box[2]
                                                  or max(p[1], q[1]) < near_box[1] or min(p[1], q[1]) > near_box[3])]
        l_segs, l_others, l_own = near(segs), near(others), near([tuple(x) for x in own])
        l_fixed_segs, l_placed_leaders = near(fixed_segs), near(placed_leaders)
        l_obst = [(x, y, h) for (x, y, h) in obstacles if abs(x - a[0]) <= reach + h and abs(y - a[1]) <= reach + h]
        l_boxes = [q for q in placed + fixed_boxes if _box_box(q, near_box)]
        # directions round the crossing, across the road first, then slanting, then along it
        angles = sorted(range(-165, 195, 15), key=lambda g: (abs(abs(g) - 90), abs(g)))
        best = None
        first_clear = None
        for k in range(31):
            dist = half + r + margin + step * 0.45 * k
            for g in angles:
                gr = math.radians(g)
                ux, uy = d[0] * math.cos(gr) + n[0] * math.sin(gr), d[1] * math.cos(gr) + n[1] * math.sin(gr)
                e = (a[0] + ux * dist, a[1] + uy * dist)
                box = (e[0] - r - margin, e[1] - r - margin, e[0] + r + margin, e[1] + r + margin)
                s = k * 0.6 + abs(abs(g) - 90) * 0.01
                for (x, y, h) in l_obst:
                    if _box_box(box, (x - h, y - h, x + h, y + h)):
                        s += 100
                for q in l_boxes:
                    if _box_box(box, q):
                        s += 100
                for (p, q) in l_segs:
                    if _seg_box(p, q, box):
                        s += 100
                for (p, q) in l_others + l_own:                # the circle clear of its own ducts as well (the leader starts on them)
                    if _seg_box(p, q, box):
                        s += 100
                for (p, q) in l_fixed_segs + l_placed_leaders:        # the circle on another label's leader
                    if _seg_box(p, q, box):
                        s += 60
                if s < 100:                                    # a clear circle: how the leader fares
                    for (p, q) in l_segs:
                        if _seg_seg_touch(a, e, p, q):
                            s += 4
                    for (p, q) in l_others:
                        if _seg_seg_touch(a, e, p, q):
                            s += 5
                    for (p, q) in l_fixed_segs + l_placed_leaders:
                        if _seg_seg_touch(a, e, p, q):
                            s += 8
                    for (x, y, h) in l_obst:
                        if _seg_box(a, e, (x - h, y - h, x + h, y + h)):
                            s += 20
                    for q in l_boxes:
                        if _seg_box(a, e, q):
                            s += 30
                if best is None or s < best[0]:
                    best = (s, e)
            if best[0] < 100 and first_clear is None:
                first_clear = k
            if first_clear is not None and (best[0] < 1.0 or k >= first_clear + 2):
                break                                           # a clear spot found: look two steps further for a cleaner leader, then stop
        e = best[1]
        ang = math.atan2(e[1] - a[1], e[0] - a[0])
        end = (e[0] - math.cos(ang) * r, e[1] - math.sin(ang) * r)
        rel = (e[0] - a[0], e[1] - a[1])
        name = f"{block_prefix}{k + 1}"
        while name in doc.blocks:
            name += "_"
        blk = doc.blocks.new(name)
        blk.add_line((0, 0), (end[0] - a[0], end[1] - a[1]), dxfattribs={"layer": "0"})
        blk.add_circle((0, 0), 0.25 * H, dxfattribs={"layer": "0"})
        blk.add_circle(rel, r, dxfattribs={"layer": "0"})
        ad = blk.add_attdef("COUNT", rel, text, dxfattribs={"height": H, "layer": "0", "style": text_style})
        ad.set_placement(rel, align=TextEntityAlignment.MIDDLE_CENTER)
        ref = msp.add_blockref(name, a, dxfattribs={"layer": layer})
        ref.add_auto_attribs({"COUNT": text})
        if meta:
            meta(ref, {"KIND": "crossinglabel", "TEXT": text})
        placed.append((e[0] - r, e[1] - r, e[0] + r, e[1] + r))
        placed_leaders.append((a, end))
        count += 1
    return count
