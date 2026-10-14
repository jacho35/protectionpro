"""Drawing DXF export — the single-line diagram, Demand topology, street-light
schematic and the DB single line / general arrangement (ezdxf, AC1024 / R2010).

The browser converts each page's SVG into a neutral drawing payload (in
millimetres, y up) and posts it here; this module only writes it:

    {
      "fileName": str,
      "layers":   {NAME: "#rrggbb" | null},
      "entities": [prim | insert, ...],
      "blocks":   [{"name": str, "entities": [prim, ...]}, ...],
    }

prim (all coordinates mm):
    {"t": "line",   "a": [x, y], "b": [x, y]}
    {"t": "poly",   "pts": [[x, y], ...], "closed": bool, "fill": "#hex"?}
    {"t": "circle", "c": [x, y], "r": r, "fill": "#hex"?}
    {"t": "text",   "at": [x, y], "h": cap height, "s": str,
                    "align": "left|center|right", "valign": "baseline|middle", "rot": deg}
  common keys: "layer", "color" ("#hex"), "lw" (mm), "dash" (pattern length mm)

insert — a symbol placed as a block reference with attributes:
    {"t": "insert", "name": block, "at": [x, y], "sx": f, "sy": f, "rot": deg, "layer": str,
     "attribs": [{"tag": str, "value": str, "invisible": bool,
                  "at": [x, y], "h": h, "align": ..., "valign": ..., "rot": deg, "color": ...}]}

Every block gets one ATTDEF per tag its inserts use, placed (in block
coordinates) where the first insert shows it, so a block inserted fresh in
CAD prompts for the same fields. Visible attributes are the labels drawn
beside the symbol; invisible ones carry the data (ratings, cable, load…).
"""

from __future__ import annotations

import functools
import io
import math
import re
from typing import Any, Dict, List

import ezdxf
from ezdxf.enums import TextEntityAlignment

_LINEWEIGHTS = [0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100,
                106, 120, 140, 158, 200, 211]
_DASH_PATTERN_MM = 4.5          # PP_DASHED: 3 mm dash, 1.5 mm gap
MAX_ENTITIES = 400_000


def _rgb(h):
    if not isinstance(h, str):
        return None
    m = re.fullmatch(r"#([0-9a-fA-F]{6})", h.strip())
    if not m:
        m3 = re.fullmatch(r"#([0-9a-fA-F]{3})", h.strip())
        if not m3:
            return None
        return tuple(int(c * 2, 16) for c in m3.group(1))
    v = m.group(1)
    return tuple(int(v[i:i + 2], 16) for i in (0, 2, 4))


def _neutral(rgb):
    """Black / white / near-greys draw as ACI 7 (black on white, white on black)."""
    r, g, b = rgb
    return max(r, g, b) - min(r, g, b) < 24 and (max(r, g, b) < 64 or min(r, g, b) > 224)


@functools.lru_cache(maxsize=4096)
def _aci(rgb):
    """Nearest AutoCAD colour index (for viewers that ignore true colour)."""
    if rgb is None or _neutral(rgb):
        return 7
    best, bd = 7, float("inf")
    for i in range(1, 256):
        cr, cg, cb = ezdxf.colors.aci2rgb(i)
        d = (rgb[0] - cr) ** 2 + (rgb[1] - cg) ** 2 + (rgb[2] - cb) ** 2
        if d < bd:
            best, bd = i, d
    return best


def _safe_name(s: str, fallback: str) -> str:
    n = re.sub(r"[^A-Za-z0-9_\-]+", "_", str(s or "")).strip("_").upper()
    return (n or fallback)[:60]


def _safe_tag(s: str) -> str:
    return _safe_name(s, "ATTR").replace("-", "_")[:30]


def _align(align: str, valign: str):
    h = {"center": "CENTER", "middle": "CENTER", "right": "RIGHT", "end": "RIGHT"}.get(align or "", "LEFT")
    if valign == "middle":
        return getattr(TextEntityAlignment, f"MIDDLE_{h}")
    return {"LEFT": TextEntityAlignment.LEFT, "CENTER": TextEntityAlignment.CENTER,
            "RIGHT": TextEntityAlignment.RIGHT}[h]


def _lineweight(mm):
    try:
        v = float(mm) * 100.0
    except (TypeError, ValueError):
        return None
    if v <= 0:
        return None
    return min(_LINEWEIGHTS, key=lambda w: abs(w - v))


def _pt(p):
    return (float(p[0]), float(p[1]))


class _Writer:
    def __init__(self, payload: Dict[str, Any]):
        self.doc = ezdxf.new("R2010", setup=True, units=4)      # mm
        self.doc.header["$MEASUREMENT"] = 1
        self.doc.header["$LWDISPLAY"] = 1
        if "PP_TEXT" not in self.doc.styles:
            self.doc.styles.new("PP_TEXT", dxfattribs={"font": "arial.ttf"})
        if "PP_DASHED" not in self.doc.linetypes:
            self.doc.linetypes.add("PP_DASHED", pattern=[_DASH_PATTERN_MM, 3.0, -1.5],
                                   description="ProtectionPro dashed __ __ __")
        self.count = 0
        for name, col in (payload.get("layers") or {}).items():
            self._layer(name, col)

    # ── tables ──
    def _layer(self, name, col=None):
        name = _safe_name(name, "0")
        if name not in self.doc.layers:
            rgb = _rgb(col)
            lay = self.doc.layers.add(name, color=_aci(rgb))
            if rgb and not _neutral(rgb):
                lay.rgb = rgb
        return name

    def _attribs(self, d: Dict[str, Any], layer_default="0"):
        a = {"layer": self._layer(d.get("layer") or layer_default)}
        rgb = _rgb(d.get("color"))
        if rgb is not None:
            a["color"] = _aci(rgb)
            if not _neutral(rgb):
                a["true_color"] = ezdxf.colors.rgb2int(rgb)
        lw = _lineweight(d.get("lw"))
        if lw is not None:
            a["lineweight"] = lw
        dash = d.get("dash")
        if dash:
            try:
                a["linetype"] = "PP_DASHED"
                a["ltscale"] = max(0.05, float(dash) / _DASH_PATTERN_MM)
            except (TypeError, ValueError):
                pass
        return a

    # ── primitives into a layout or block ──
    def prim(self, space, p: Dict[str, Any]):
        self.count += 1
        if self.count > MAX_ENTITIES:
            raise ValueError("Drawing too large to export.")
        t = p.get("t")
        a = self._attribs(p)
        if t == "line":
            space.add_line(_pt(p["a"]), _pt(p["b"]), dxfattribs=a)
        elif t == "poly":
            pts = [_pt(q) for q in p.get("pts") or []]
            if len(pts) < 2:
                return
            closed = bool(p.get("closed"))
            if p.get("fill") and closed and len(pts) >= 3:
                self._hatch(space, pts, p["fill"], a["layer"])
            space.add_lwpolyline(pts, close=closed, dxfattribs=a)
        elif t == "circle":
            r = float(p.get("r") or 0)
            if r <= 0:
                return
            c = _pt(p["c"])
            if p.get("fill"):
                h = space.add_hatch(dxfattribs={"layer": a["layer"], **self._fill_color(p["fill"])})
                h.paths.add_edge_path().add_arc(c, r, 0, 360)
            space.add_circle(c, r, dxfattribs=a)
        elif t == "text":
            s = str(p.get("s") or "").replace("\n", " ").strip()
            h = float(p.get("h") or 0)
            if not s or h <= 0:
                return
            a.update({"height": h, "style": "PP_TEXT", "rotation": float(p.get("rot") or 0)})
            space.add_text(s, dxfattribs=a).set_placement(_pt(p["at"]), align=_align(p.get("align"), p.get("valign")))

    def _fill_color(self, col):
        rgb = _rgb(col)
        out = {"color": _aci(rgb)}
        if rgb is not None and not _neutral(rgb):
            out["true_color"] = ezdxf.colors.rgb2int(rgb)
        return out

    def _hatch(self, space, pts, col, layer):
        h = space.add_hatch(dxfattribs={"layer": layer, **self._fill_color(col)})
        h.paths.add_polyline_path(pts, is_closed=True)

    # ── blocks ──
    def blocks(self, blocks: List[Dict[str, Any]]):
        for b in blocks or []:
            name = _safe_name(b.get("name"), "PP_SYMBOL")
            if name in self.doc.blocks:
                continue
            blk = self.doc.blocks.new(name=name)
            for p in b.get("entities") or []:
                self.prim(blk, p)

    def insert(self, msp, e: Dict[str, Any], attdefs_done: set):
        name = _safe_name(e.get("name"), "PP_SYMBOL")
        if name not in self.doc.blocks:
            return
        at = _pt(e.get("at") or (0, 0))
        sx, sy = float(e.get("sx") or 1), float(e.get("sy") or 1)
        rot = float(e.get("rot") or 0)
        ref = msp.add_blockref(name, at, dxfattribs={
            "layer": self._layer(e.get("layer") or "SYMBOLS"),
            "xscale": sx, "yscale": sy, "rotation": rot,
        })
        blk = self.doc.blocks[name]
        seen = set()
        for att in e.get("attribs") or []:
            tag = _safe_tag(att.get("tag"))
            if not tag or tag in seen:
                continue
            seen.add(tag)
            value = str(att.get("value") if att.get("value") is not None else "").replace("\n", " ")
            invisible = bool(att.get("invisible"))
            h = float(att.get("h") or 0) or max(0.5, 2.5 * abs(sy))
            apos = _pt(att.get("at") or at)
            arot = float(att.get("rot") or 0)
            align = _align(att.get("align"), att.get("valign"))
            da = self._attribs(att, e.get("layer") or "SYMBOLS")
            da.update({"height": h, "style": "PP_TEXT", "rotation": arot})
            if invisible:
                da["flags"] = 1
            attrib = ref.add_attrib(tag, value, insert=apos, dxfattribs=da)
            attrib.set_placement(apos, align=align)
            if (name, tag) not in attdefs_done:
                # ATTDEF in block coordinates: invert the insert transform.
                attdefs_done.add((name, tag))
                lx, ly = self._to_local(apos, at, sx, sy, rot)
                dda = {"height": h / max(1e-9, abs(sy)), "style": "PP_TEXT",
                       "rotation": arot - rot, "layer": da["layer"]}
                if invisible:
                    dda["flags"] = 1
                ad = blk.add_attdef(tag, insert=(lx, ly), text="", dxfattribs=dda)
                ad.dxf.prompt = tag.replace("_", " ").title()
                ad.set_placement((lx, ly), align=align)

    @staticmethod
    def _to_local(p, at, sx, sy, rot):
        dx, dy = p[0] - at[0], p[1] - at[1]
        r = math.radians(-rot)
        x = dx * math.cos(r) - dy * math.sin(r)
        y = dx * math.sin(r) + dy * math.cos(r)
        return (x / (sx or 1), y / (sy or 1))

    def write(self) -> bytes:
        out = io.StringIO()
        self.doc.write(out)
        return self.doc.encode(out.getvalue())


def build_drawing_dxf(payload: Dict[str, Any]) -> bytes:
    if not isinstance(payload, dict):
        raise ValueError("Bad drawing payload.")
    w = _Writer(payload)
    w.blocks(payload.get("blocks") or [])
    msp = w.doc.modelspace()
    attdefs_done: set = set()
    for e in payload.get("entities") or []:
        if not isinstance(e, dict):
            continue
        if e.get("t") == "insert":
            w.insert(msp, e, attdefs_done)
        else:
            w.prim(msp, e)
    title = str(payload.get("title") or "")[:200]
    if title:
        w.doc.header["$PROJECTNAME"] = title
    return w.write()
