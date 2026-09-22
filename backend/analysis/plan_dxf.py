"""Plan Markup ↔ DXF (AC1015 / R2000) using ezdxf.

Export and import are done here (not in the browser) so the file is guaranteed
spec-valid — real BLOCK/INSERT with ATTRIB attributes, true SPLINE curves, and
LWPOLYLINE straights that open cleanly in AutoCAD / BricsCAD / QCAD.

Coordinate model
----------------
The plan works in image pixels; metres = px * factor. We export world0-relative
with the Y axis flipped (DXF Y is up):  X_m = x*factor,  Y_m = -y*factor.
That makes the inverse trivial on import (x = X_m/factor, y = -Y_m/factor), so a
round-trip lands devices back on their original pixels. `factor` is embedded in
a PP_META block so import can invert without guessing.

Symbols
-------
The frontend is the single source of truth for glyph shapes: it sends each
distinct symbol *variant* as a list of primitives in the 0..40 art box
(the same PLAN_SYMBOLS recipe it draws), plus the per-instance placement and
attributes. We translate those primitives into block geometry (in metres) so
the DXF symbol matches the screen exactly, and INSERT one blockref per device.
"""

from __future__ import annotations
import io
import math
from typing import Any, Dict, List

import logging

import ezdxf
from ezdxf.enums import TextEntityAlignment


class _NoFontWarning(logging.Filter):
    """The backend image has no system fonts, so ezdxf warns "no default font
    found" once per text it measures while rendering DIMENSION/MTEXT virtual
    entities — dozens of lines per import. Glyph metrics don't matter here (we
    keep text as text, not outlines), so drop just that message and let every
    other ezdxf warning through."""

    def filter(self, record):
        return not str(record.getMessage()).startswith("no default font found")


logging.getLogger("ezdxf").addFilter(_NoFontWarning())

APPID = "PROTECTIONPRO"
META_BLOCK = "PP_META"
# Core attribute tags carried on every device blockref. REF/TYPE/DBFED/
# CIRCUIT/PHASE/CABLE match the AutoCAD LISP toolkit's own block-attribute
# vocabulary directly (see CLAUDE.md's Plan Markup DXF notes); LOAD_VA is
# ProtectionPro's own (a computed VA figure — the LISP side has no single
# equivalent tag, it varies per block and is in raw watts, not VA). A
# LISP-block-named element (frontend `dxfBlock`) may carry additional
# per-field tags (WATTS/LUMENS/ZONE/HEIGHT/SIZE/CONDUCTOR/PP_VARIANT) — see
# `blocks[name].attrTags` in the payload from plan-dxf.js.
ATTR_TAGS = ["REF", "TYPE", "DBFED", "CIRCUIT", "PHASE", "LOAD_VA", "CABLE"]


def _hex_to_rgb(h: str):
    if not h:
        return None
    h = h.lstrip("#")
    if len(h) != 6:
        return None
    try:
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
    except ValueError:
        return None


def _ensure_layer(doc, name: str, color_hex: str | None):
    if name in doc.layers:
        return
    layer = doc.layers.add(name)
    rgb = _hex_to_rgb(color_hex)
    if rgb:
        layer.rgb = rgb


# ── Block geometry from art-box (0..40) primitives ──
def _build_block(doc, name: str, prims: List[dict], size_world: float, factor: float, attr_tags: List[str] | None = None):
    """Create a block whose geometry (in metres) matches the on-screen glyph.

    Art box is 0..40 centred on (20,20); a glyph spans `size_world` px, so one
    art unit = size_world/40 px = size_world/40*factor metres. Y is flipped.
    `attr_tags` (default ATTR_TAGS) is this block's own attribute-definition
    list — a LISP-named block carries extra per-field tags beyond the core set.
    """
    blk = doc.blocks.new(name=name)
    s = (size_world / 40.0) * factor  # metres per art unit

    def pt(ax, ay):
        return ((ax - 20.0) * s, -(ay - 20.0) * s)

    for p in prims:
        k = p.get("k")
        col = _attr_color(p)
        if k == "c":  # circle
            blk.add_circle(pt(p["cx"], p["cy"]), abs(p.get("r", 1)) * s, dxfattribs=col)
        elif k == "a":  # arc — art angles are canvas (Y-down, radians); flip to CCW deg
            import_deg = lambda rad: math.degrees(rad)
            start = -import_deg(p.get("a1", 0))
            end = -import_deg(p.get("a0", 0))
            blk.add_arc(pt(p["cx"], p["cy"]), abs(p.get("r", 1)) * s, start, end, dxfattribs=col)
        elif k == "r":  # rectangle → closed lwpolyline
            x, y, w, h = p["x"], p["y"], p["w"], p["h"]
            corners = [pt(x, y), pt(x + w, y), pt(x + w, y + h), pt(x, y + h)]
            blk.add_lwpolyline(corners, close=True, dxfattribs=col)
        elif k == "l":  # line
            blk.add_line(pt(p["x1"], p["y1"]), pt(p["x2"], p["y2"]), dxfattribs=col)
        elif k == "p":  # polyline / polygon
            pts = [pt(px, py) for px, py in p.get("pts", [])]
            if len(pts) >= 2:
                blk.add_lwpolyline(pts, close=bool(p.get("close")), dxfattribs=col)
        elif k == "t":  # text
            h = max(0.001, p.get("size", 8) * s)
            txt = blk.add_text(str(p.get("str", "")), dxfattribs={"height": h, **col})
            txt.set_placement(pt(p["x"], p["y"]), align=TextEntityAlignment.MIDDLE_CENTER)

    # Attribute definitions (filled per-INSERT). Stacked below the glyph.
    yoff = -(size_world * 0.5 * factor) - 0.001
    for i, tag in enumerate(attr_tags or ATTR_TAGS):
        ad = blk.add_attdef(tag, dxfattribs={"height": max(0.001, size_world / 40.0 * factor * 3),
                                             "invisible": 1})
        ad.set_placement((0, yoff - i * 0.001), align=TextEntityAlignment.MIDDLE_CENTER)


def _attr_color(p):
    """Primitive stroke/fill colour → DXF true_color dxfattribs (skip 'col'
    which means 'use the layer/entity colour')."""
    for key in ("s", "f"):
        v = p.get(key)
        if v and v not in ("col", "faint", "white", "bg", "none", "faintLine"):
            rgb = _hex_to_rgb(v)
            if rgb:
                return {"true_color": ezdxf.rgb2int(rgb)}
    return {}


def _set_meta(entity, fields: Dict[str, Any]):
    """Carry our own per-entity attributes as XDATA (APPID group, KEY=value
    strings) so a curve round-trips with its type/cable/etc. — a plain DXF
    reader simply ignores them."""
    tags = []
    for k, v in fields.items():
        if v is None or v == "":
            continue
        tags.append((1000, f"{k}={v}"[:255]))
    if tags:
        entity.set_xdata(APPID, tags)


def _get_meta(entity) -> Dict[str, str]:
    try:
        if not entity.has_xdata(APPID):
            return {}
        out = {}
        for code, value in entity.get_xdata(APPID):
            if code == 1000 and "=" in str(value):
                k, v = str(value).split("=", 1)
                out[k] = v
        return out
    except Exception:
        return {}


def build_dxf(payload: Dict[str, Any]) -> bytes:
    factor = payload.get("factor")
    if not factor or factor <= 0:
        raise ValueError("Plan is not calibrated — DXF export needs a scale (metres per pixel).")

    doc = ezdxf.new("R2000", setup=True)
    doc.appids.add(APPID)
    msp = doc.modelspace()

    # Layers (discipline colours).
    for lyr in payload.get("layers", []):
        _ensure_layer(doc, lyr["name"], lyr.get("color"))
    for extra in ("PP_ROUTES", "PP_LABELS", "PP_TRENCH", "PP_ROOMS", "PP_TEXT", "PP_DIM", META_BLOCK):
        _ensure_layer(doc, extra, None)

    def X(x):
        return x * factor

    def Y(y):
        return -y * factor

    # Symbol blocks (one per variant, or one per LISP-named type).
    variants = payload.get("blocks", {})
    block_attr_tags: Dict[str, List[str]] = {}
    for name, v in variants.items():
        tags = v.get("attrTags") or ATTR_TAGS
        block_attr_tags[name] = tags
        _build_block(doc, name, v.get("prims", []), v.get("sizeWorld", 24), factor, tags)

    # Devices → blockref + attributes.
    for el in payload.get("elements", []):
        name = el.get("block")
        if not name or name not in doc.blocks:
            continue
        rot = -float(el.get("rotation", 0) or 0)  # screen CW → DXF CCW
        ref = msp.add_blockref(name, (X(el["x"]), Y(el["y"])), dxfattribs={
            "layer": el.get("layer", "0"),
            "rotation": rot,
        })
        attrs = el.get("attrs", {}) or {}
        tags = block_attr_tags.get(name, ATTR_TAGS)
        ref.add_auto_attribs({t: str(attrs.get(t, "")) for t in tags})

    # Routes → SPLINE (curved) or LWPOLYLINE (straight), + a cable label.
    for r in payload.get("routes", []):
        pts = [(X(p[0]), Y(p[1])) for p in r.get("pts", [])]
        if len(pts) < 2:
            continue
        layer = r.get("layer", "PP_ROUTES")
        if r.get("curved") and len(pts) >= 3:
            ent = msp.add_spline(fit_points=[(x, y, 0) for x, y in pts], dxfattribs={"layer": layer})
        else:
            ent = msp.add_lwpolyline(pts, dxfattribs={"layer": layer})
        _set_meta(ent, {"KIND": "route", "TYPE": r.get("type"), "CABLE": r.get("cable"),
                        "CURVED": "1" if r.get("curved") else "0",
                        "FROM": r.get("fromName"), "TO": r.get("toName")})
        label = r.get("label")
        if label:
            mid = pts[len(pts) // 2]
            msp.add_text(label, dxfattribs={"height": 0.9, "layer": "PP_LABELS"}).set_placement(mid, align=TextEntityAlignment.MIDDLE_LEFT)

    # Trenches / measurements → polylines; rooms → closed polylines; texts.
    for t in payload.get("trenches", []):
        pts = [(X(p[0]), Y(p[1])) for p in t.get("pts", [])]
        if len(pts) >= 2:
            ent = msp.add_lwpolyline(pts, dxfattribs={"layer": "PP_TRENCH"})
            _set_meta(ent, {"KIND": "trench", "EXC": t.get("excType"), "NAME": t.get("name")})
    for rm in payload.get("rooms", []):
        pts = [(X(p[0]), Y(p[1])) for p in rm.get("pts", [])]
        if len(pts) >= 3:
            ent = msp.add_lwpolyline(pts, close=True, dxfattribs={"layer": "PP_ROOMS"})
            _set_meta(ent, {"KIND": "room", "NAME": rm.get("label")})
        if rm.get("label") and pts:
            cx = sum(p[0] for p in pts) / len(pts)
            cy = sum(p[1] for p in pts) / len(pts)
            msp.add_text(rm["label"], dxfattribs={"height": 0.9, "layer": "PP_ROOMS"}).set_placement((cx, cy), align=TextEntityAlignment.MIDDLE_CENTER)
    for m in payload.get("measurements", []):
        pts = [(X(p[0]), Y(p[1])) for p in m.get("pts", [])]
        if len(pts) >= 2:
            msp.add_lwpolyline(pts, dxfattribs={"layer": "PP_DIM"})
    for c in payload.get("crossings", []):
        p1, p2 = c.get("p1"), c.get("p2")
        if p1 and p2:
            ent = msp.add_line((X(p1[0]), Y(p1[1])), (X(p2[0]), Y(p2[1])), dxfattribs={"layer": "PP_TRENCH"})
            _set_meta(ent, {"KIND": "crossing", "SIZE": c.get("size"), "NAME": c.get("name")})
    for tx in payload.get("texts", []):
        msp.add_text(str(tx.get("text", "")), dxfattribs={
            "height": max(0.05, tx.get("h", 2) * factor), "layer": "PP_TEXT",
        }).set_placement((X(tx["x"]), Y(tx["y"])), align=TextEntityAlignment.MIDDLE_LEFT)

    # Metadata block: carries the scale factor so import inverts exactly.
    if META_BLOCK not in doc.blocks:
        mb = doc.blocks.new(META_BLOCK)
        mb.add_attdef("FACTOR", dxfattribs={"height": 0.001, "invisible": 1}).set_placement((0, 0))
        mb.add_attdef("FLOOR", dxfattribs={"height": 0.001, "invisible": 1}).set_placement((0, -0.001))
        mb.add_attdef("DOMAIN", dxfattribs={"height": 0.001, "invisible": 1}).set_placement((0, -0.002))
    mref = msp.add_blockref(META_BLOCK, (0, 0), dxfattribs={"layer": META_BLOCK})
    mref.add_auto_attribs({"FACTOR": repr(float(factor)), "FLOOR": str(payload.get("floorName", "")),
                           "DOMAIN": str(payload.get("domain", ""))})
    # Real-world units: the file is drawn in metres.
    doc.header["$INSUNITS"] = 6

    out = io.StringIO()
    doc.write(out)
    # Encode in the drawing's own code page (R2000 → cp1252, with \U+XXXX
    # escapes for anything outside it). Writing UTF-8 bytes under an ANSI_1252
    # header garbled "mm²" in AutoCAD and on our own re-import.
    return doc.encode(out.getvalue())




# ─────────────────────────────────────────────────────────────────────────
# Import
# ─────────────────────────────────────────────────────────────────────────
# $INSUNITS code → metres per drawing unit (0 = unitless → None).
_UNIT_M = {
    1: 0.0254, 2: 0.3048, 3: 1609.344, 4: 0.001, 5: 0.01, 6: 1.0, 7: 1000.0,
    8: 2.54e-8, 9: 2.54e-5, 10: 0.9144, 13: 1e-6, 14: 0.1, 15: 10.0, 16: 100.0,
}
_UNIT_NAME = {1: "in", 2: "ft", 3: "mi", 4: "mm", 5: "cm", 6: "m", 7: "km", 10: "yd", 14: "dm"}

# Hard ceiling on emitted primitives — a guard against pathological files
# (a 60 MB survey with hatching everywhere), not a normal-use limit.
MAX_PRIMS = 600_000


def _meta_block(msp):
    for e in msp.query("INSERT"):
        if e.dxf.name == META_BLOCK:
            vals = {a.dxf.tag: a.dxf.text for a in e.attribs}
            try:
                return float(vals.get("FACTOR", "0")), vals.get("FLOOR", ""), vals.get("DOMAIN", "")
            except ValueError:
                return None, "", ""
    return None, "", ""


def _spline_pts(e):
    try:
        fp = list(e.fit_points)
        if fp:
            return [(p[0], p[1]) for p in fp]
    except Exception:
        pass
    try:
        return [(p[0], p[1]) for p in e.control_points]
    except Exception:
        return []


def _hex(rgb):
    return "#%02x%02x%02x" % tuple(int(c) for c in rgb)


def _entity_color(e):
    """Explicit entity colour: '#rrggbb', 'B' (ByBlock) or None (ByLayer)."""
    try:
        if e.dxf.hasattr("true_color"):
            return _hex(e.rgb)
        aci = e.dxf.get("color", 256)
    except Exception:
        return None
    if aci == 0:
        return "B"
    if aci == 256 or aci is None:
        return None
    try:
        from ezdxf.colors import aci2rgb
        return _hex(aci2rgb(abs(int(aci))))
    except Exception:
        return None


def _layer_table(doc):
    from ezdxf.colors import aci2rgb
    out = {}
    for ly in doc.layers:
        name = ly.dxf.name
        try:
            aci = abs(int(ly.dxf.get("color", 7))) or 7
            col = _hex(ly.rgb) if ly.dxf.hasattr("true_color") and ly.rgb else _hex(aci2rgb(aci))
        except Exception:
            aci, col = 7, "#ffffff"
        out[name] = {
            "name": name, "color": col, "aci7": aci == 7,
            "on": not ly.is_off(), "frozen": bool(ly.is_frozen()),
            "n": 0,
        }
    return out


def _effective_block_name(doc, name):
    """Dynamic blocks are referenced through anonymous '*U##' copies; the
    original name is recorded as a handle in the anonymous BLOCK_RECORD's
    AcDbBlockRepBTag XDATA. Fall back to the stored name."""
    if not name or not name.startswith("*"):
        return name
    try:
        br = doc.blocks.get(name).block_record
        if br.has_xdata("AcDbBlockRepBTag"):
            for code, value in br.get_xdata("AcDbBlockRepBTag"):
                if code == 1005:
                    orig = doc.entitydb.get(value)
                    if orig is not None and orig.dxf.hasattr("name"):
                        return orig.dxf.name
    except Exception:
        pass
    return name


_H_ALIGN = {"LEFT": "l", "CENTER": "c", "RIGHT": "r", "MIDDLE": "c", "ALIGNED": "l", "FIT": "l"}


def _text_align(align):
    n = align.name  # e.g. MIDDLE_CENTER, TOP_LEFT, LEFT, CENTER
    if "_" in n:
        v, h = n.split("_", 1)
        return h[0].lower(), {"BOTTOM": "b", "MIDDLE": "m", "TOP": "t"}.get(v, "a")
    if n == "MIDDLE":
        return "c", "m"
    return _H_ALIGN.get(n, "l"), "a"   # 'a' = alphabetic baseline


def _insert_xform(e):
    """INSERT placement in WCS: (x, y, rotation°, sx, sy). A block mirrored in
    CAD is often stored with extrusion (0,0,-1) — its insert point is then in
    OCS (x mirrored), which is the same as rotation → -rotation, sx → -sx."""
    ins = e.dxf.insert
    r = e.dxf.get("rotation", 0.0) or 0.0
    sx, sy = e.dxf.get("xscale", 1.0) or 1.0, e.dxf.get("yscale", 1.0) or 1.0
    try:
        z = e.dxf.get("extrusion", (0, 0, 1))
        if not (abs(z[0]) < 1e-9 and abs(z[1]) < 1e-9 and z[2] > 0):
            w = e.ocs().to_wcs(ins)
            if abs(z[0]) < 1e-9 and abs(z[1]) < 1e-9:
                return w.x, w.y, -r, -sx, sy
            return w.x, w.y, r, sx, sy
    except Exception:
        pass
    return ins.x, ins.y, r, sx, sy


class _Reader:
    """Normalises one DXF document into the compact underlay structure.

    Coordinates are kept in DXF drawing units. Model-space geometry is shifted
    by `origin` — the lower-left of the *robust* extent (see
    `_robust_bounds`), not necessarily the true lower-left — so large survey
    coordinates (e.g. Lo29 ≈ 3 000 000 m) keep full precision once they reach
    a canvas, and an isolated far-off record (a stray XREF insertion point, a
    legend table left off in space) doesn't drag `origin`/`bbox` out to meet
    it. Block definitions stay in their own local coordinates.

    Entity records (short keys keep the stored JSON small):
      {t:'l', p:[x1,y1,x2,y2]}                      line
      {t:'p', p:[x,y,x,y,…], c:closed, f:[…]?}      polyline (curves flattened;
                                                     SPLINE keeps fit points in f)
      {t:'c', p:[cx,cy,r]}                          circle
      {t:'a', p:[cx,cy,r,a0,a1]}                    arc, CCW degrees
      {t:'x', p:[x,y], h, r, s, ha, va}             text (rotation deg CCW)
      {t:'o', p:[x,y]}                              point
      {t:'i', b, p:[x,y], r, sx, sy}                nested insert (blocks only)
    Every record carries l (layer) and optionally k (colour: '#hex' | 'B').
    Top-level model-space records also carry h (handle) and, for curves, g
    (source type) so they can be converted to routes later.
    """

    def __init__(self, doc):
        from ezdxf import path as ezpath
        self.ezpath = ezpath
        self.doc = doc
        self.layers = _layer_table(doc)
        self.blocks: Dict[str, dict] = {}
        self.prims = 0
        self.truncated = False
        self.skipped: Dict[str, int] = {}
        ext_span = self._raw_span()
        # Flattening tolerance ~ 1/20000 of the drawing — sub-mm on a building.
        self.tol = max(ext_span / 20000.0, 1e-9)

    def _raw_span(self):
        # The real modelspace geometry, not $EXTMIN/$EXTMAX, is the trustworthy
        # source — the header is frequently stale (never refreshed after a ZOOM
        # EXTENTS, or left over from a purged xref) and, taken at face value on
        # a real-world site plan, can overstate the drawing's actual span by
        # orders of magnitude. That inflates the flattening/round tolerance
        # below until curves and small features round away to nothing — a
        # "successful" import that renders as a blank canvas. Fall back to the
        # header only when the geometry scan itself is unavailable.
        try:
            from ezdxf import bbox
            b = bbox.extents(self.doc.modelspace(), fast=True)
            if b.has_data:
                span = max(b.size.x, b.size.y)
                if 0 < span < 1e12:
                    return span
        except Exception:
            pass
        try:
            lo, hi = self.doc.header.get("$EXTMIN"), self.doc.header.get("$EXTMAX")
            span = max(hi[0] - lo[0], hi[1] - lo[1])
            if 0 < span < 1e12:
                return span
        except Exception:
            pass
        return 1000.0

    def _count(self, n=1):
        self.prims += n
        if self.prims > MAX_PRIMS:
            self.truncated = True
            return False
        return True

    # ── one entity → list of records ──
    def convert(self, e, out: List[dict], top: bool):
        t = e.dxftype()
        base = {"l": e.dxf.get("layer", "0")}
        k = _entity_color(e)
        if k:
            base["k"] = k
        if top:
            try:
                base["h"] = e.dxf.handle
            except Exception:
                pass
        try:
            if t == "LINE":
                s, en = e.dxf.start, e.dxf.end
                self._emit(out, {**base, "t": "l", "p": [s.x, s.y, en.x, en.y]})
            elif t in ("CIRCLE", "ARC") and self._is_planar(e):
                c = e.dxf.center
                if t == "CIRCLE":
                    self._emit(out, {**base, "t": "c", "p": [c.x, c.y, abs(e.dxf.radius)]})
                else:
                    self._emit(out, {**base, "t": "a", "g": "ARC",
                                     "p": [c.x, c.y, abs(e.dxf.radius), e.dxf.start_angle, e.dxf.end_angle]})
            elif t == "LWPOLYLINE" and self._is_planar(e) and not any(b for *_, b in e.get_points("xyb")):
                pts = [c for p in e.get_points("xy") for c in (p[0], p[1])]
                if len(pts) >= 4:
                    self._emit(out, {**base, "t": "p", "g": t, "p": pts, "c": bool(e.closed)})
            elif t in ("LWPOLYLINE", "POLYLINE", "SPLINE", "ELLIPSE", "CIRCLE", "ARC",
                       "SOLID", "TRACE", "3DFACE", "HELIX"):
                if t == "POLYLINE" and (e.is_poly_face_mesh or e.is_polygon_mesh):
                    for ve in e.virtual_entities():
                        self.convert(ve, out, False)
                    return
                p = self.ezpath.make_path(e)
                closed = t in ("SOLID", "TRACE", "3DFACE") or (t == "CIRCLE") or \
                    (t in ("LWPOLYLINE", "POLYLINE") and bool(getattr(e, "is_closed", False) or getattr(e, "closed", False)))
                for sp in (p.sub_paths() if p.has_sub_paths else [p]):
                    pts = [c for v in sp.flattening(self.tol) for c in (v.x, v.y)]
                    if len(pts) >= 4:
                        rec = {**base, "t": "p", "g": t, "p": pts, "c": closed}
                        if t == "SPLINE":
                            rec["f"] = [c for x, y in _spline_pts(e) for c in (x, y)]
                        self._emit(out, rec)
            elif t == "HATCH" or t == "MPOLYGON":
                for p in self.ezpath.from_hatch(e):
                    for sp in (p.sub_paths() if p.has_sub_paths else [p]):
                        pts = [c for v in sp.flattening(self.tol) for c in (v.x, v.y)]
                        if len(pts) >= 4:
                            self._emit(out, {**base, "t": "p", "g": "HATCH", "p": pts, "c": True})
            elif t == "POINT":
                loc = e.dxf.location
                self._emit(out, {**base, "t": "o", "p": [loc.x, loc.y]})
            elif t in ("TEXT", "ATTRIB", "ATTDEF"):
                self._emit_text(out, base, e)
            elif t == "MTEXT":
                ins = e.dxf.insert
                ap = int(e.dxf.get("attachment_point", 1))
                ha = "lcr"[(ap - 1) % 3]
                va = "tmb"[(ap - 1) // 3]
                try:
                    rot = e.get_rotation()
                except Exception:
                    rot = e.dxf.get("rotation", 0.0)
                txt = e.plain_text()
                if txt and txt.strip():
                    self._emit(out, {**base, "t": "x", "p": [ins.x, ins.y], "h": e.dxf.get("char_height", 1.0) or 1.0,
                                     "r": rot, "s": txt, "ha": ha, "va": va})
            elif t in ("DIMENSION", "ARC_DIMENSION", "LARGE_RADIAL_DIMENSION", "LEADER",
                       "MULTILEADER", "MLEADER", "ACAD_TABLE", "MLINE", "ACAD_PROXY_ENTITY"):
                for ve in e.virtual_entities():
                    self.convert(ve, out, False)
            elif t == "INSERT":
                # Only reached for inserts nested inside a block definition, or
                # inside a dimension's virtual entities.
                self._nested_insert(out, base, e)
            else:
                self.skipped[t] = self.skipped.get(t, 0) + 1
        except Exception:
            self.skipped[t] = self.skipped.get(t, 0) + 1

    @staticmethod
    def _is_planar(e):
        try:
            z = e.dxf.get("extrusion", (0, 0, 1))
            return abs(z[0]) < 1e-9 and abs(z[1]) < 1e-9 and z[2] > 0
        except Exception:
            return True

    def _emit(self, out, rec):
        if self._count():
            out.append(rec)

    def _emit_text(self, out, base, e):
        txt = e.dxf.get("text", "")
        if not txt or not str(txt).strip():
            return
        try:
            if e.dxftype() in ("ATTRIB", "ATTDEF") and e.is_invisible:
                return
        except Exception:
            pass
        align, p1, p2 = e.get_placement()
        ha, va = _text_align(align)
        pt = p2 if (p2 is not None and align.name not in ("LEFT", "ALIGNED", "FIT")) else p1
        try:
            txt = e.plain_text()
        except Exception:
            pass
        self._emit(out, {**base, "t": "x", "p": [pt.x, pt.y], "h": e.dxf.get("height", 1.0) or 1.0,
                         "r": e.dxf.get("rotation", 0.0), "s": str(txt), "ha": ha, "va": va})

    def _nested_insert(self, out, base, e):
        name = e.dxf.name
        if not self.block(name):
            return
        x, y, r, sx, sy = _insert_xform(e)
        rec = {**base, "t": "i", "b": name, "p": [x, y], "r": r, "sx": sx, "sy": sy}
        rec.pop("h", None)
        self._emit(out, rec)
        for a in getattr(e, "attribs", []):
            self._emit_text(out, {"l": a.dxf.get("layer", base["l"])}, a)

    # ── block definitions (lazily, once per name) ──
    def block(self, name):
        if name in self.blocks:
            return self.blocks[name]
        try:
            layout = self.doc.blocks.get(name)
        except Exception:
            layout = None
        if layout is None:
            return None
        rec = {"name": name, "n": _effective_block_name(self.doc, name), "e": [], "tags": [],
               "bp": [0.0, 0.0], "xref": False}
        self.blocks[name] = rec  # registered before recursion: guards self-reference
        try:
            bp = layout.block.dxf.base_point
            rec["bp"] = [bp.x, bp.y]
            rec["xref"] = bool(layout.block.is_xref)
        except Exception:
            pass
        for be in layout:
            if be.dxftype() == "ATTDEF":
                rec["tags"].append(be.dxf.tag)
                continue      # attribute templates: values come from the INSERT
            self.convert(be, rec["e"], False)
        return rec

    # ── model-space insert → placed block record (with attributes) ──
    def insert(self, e, handle):
        name = e.dxf.name
        blk = self.block(name)
        if blk is None:
            return None
        x, y, r, sx, sy = _insert_xform(e)
        attrs, at = {}, []
        for a in getattr(e, "attribs", []):
            attrs[a.dxf.tag] = a.dxf.text
            self._emit_text(at, {"l": a.dxf.get("layer", e.dxf.layer), **({"k": _entity_color(a)} if _entity_color(a) else {})}, a)
        rec = {"h": handle, "b": name, "l": e.dxf.get("layer", "0"), "p": [x, y],
               "r": r, "sx": sx, "sy": sy, "a": attrs}
        k = _entity_color(e)
        if k:
            rec["k"] = k
        if at:
            rec["at"] = at
        self._count()
        return rec


def _rec_points(rec):
    t, p = rec["t"], rec.get("p", [])
    if t == "c" or t == "a":
        return [(p[0] - p[2], p[1] - p[2]), (p[0] + p[2], p[1] + p[2])]
    if t in ("x", "o", "i"):
        return [(p[0], p[1])]
    return [(p[i], p[i + 1]) for i in range(0, len(p) - 1, 2)]


def _block_bbox(rd, name, memo, depth=0):
    if name in memo:
        return memo[name]
    memo[name] = None
    blk = rd.blocks.get(name)
    if not blk or depth > 12:
        return None
    xs, ys = [], []
    for r in blk["e"]:
        if r["t"] == "i":
            sub = _block_bbox(rd, r["b"], memo, depth + 1)
            if sub:
                for cx, cy in _corners(sub, r, rd.blocks.get(r["b"], {}).get("bp", [0, 0])):
                    xs.append(cx); ys.append(cy)
        else:
            for x, y in _rec_points(r):
                xs.append(x); ys.append(y)
    bb = [min(xs), min(ys), max(xs), max(ys)] if xs else None
    blk["bb"] = bb
    memo[name] = bb
    return bb


def _corners(bb, ins, bp):
    th = math.radians(ins.get("r", 0.0) or 0.0)
    c, s = math.cos(th), math.sin(th)
    sx, sy = ins.get("sx", 1.0) or 1.0, ins.get("sy", 1.0) or 1.0
    out = []
    for x, y in ((bb[0], bb[1]), (bb[2], bb[1]), (bb[2], bb[3]), (bb[0], bb[3])):
        lx, ly = (x - bp[0]) * sx, (y - bp[1]) * sy
        out.append((ins["p"][0] + lx * c - ly * s, ins["p"][1] + lx * s + ly * c))
    return out


def _shift(rec, ox, oy):
    """Translate a model-space record by (-ox, -oy) in place."""
    t, p = rec["t"], rec.get("p")
    if not p:
        return
    if t in ("c", "a", "x", "o", "i"):
        p[0] -= ox; p[1] -= oy
    else:
        for i in range(0, len(p) - 1, 2):
            p[i] -= ox; p[i + 1] -= oy
        f = rec.get("f")
        if f:
            for i in range(0, len(f) - 1, 2):
                f[i] -= ox; f[i + 1] -= oy


# A real site plan is legitimately large and often clustered (separate
# buildings, feeder runs kilometres apart) — that must never be mistaken for
# an outlier. What genuinely breaks the initial view is a handful of records
# sitting far beyond everything else: an unresolved XREF's insertion point,
# a schedule/legend table block left off in space, a misplaced grip-edit.
# _robust_bounds finds that kind of isolated tail and excludes it from the
# origin/bbox that drives the importer's initial placement and zoom-to-fit —
# the records themselves are never dropped, so panning out still finds them.
_ROBUST_MIN_N = 20        # below this, every point counts: never trim
_ROBUST_OUTER_FRAC = 0.02 # only look for a cut within the outer ~2% of points
_ROBUST_OUTER_MIN = 3
_ROBUST_OUTER_MAX = 40
_ROBUST_ISOLATION = 10.0  # the cut gap must dwarf (10x) the typical local gap
# Below this span (drawing units — mm on a typical file), a corner-anchored
# origin already keeps every local coordinate small: no reason to disturb the
# established (0,0)-at-the-corner convention small fixtures/tests rely on.
_MEDIAN_ORIGIN_SPAN = 50_000


def _robust_bounds(values):
    """min/max of `values`, but excluding a small isolated tail at either end
    (see module comment above). Falls back to plain min/max when there's
    nothing to work with or nothing anomalous to trim."""
    if not values:
        return None
    v = sorted(values)
    n = len(v)
    if n < _ROBUST_MIN_N:
        return v[0], v[-1]
    gaps = [v[i] - v[i - 1] for i in range(1, n)]
    nonzero = [g for g in gaps if g > 0]
    if not nonzero:
        return v[0], v[-1]
    nonzero.sort()
    typical = nonzero[len(nonzero) // 2]  # median gap: robust to the rare huge one
    if typical <= 0:
        return v[0], v[-1]
    outer = max(_ROBUST_OUTER_MIN, min(_ROBUST_OUTER_MAX, int(n * _ROBUST_OUTER_FRAC)))
    lo, hi = 0, n - 1
    # Largest gap within the outer window at the top: if it dwarfs the
    # typical gap, cut there — everything above is an isolated tail.
    start = max(0, n - 1 - outer)
    best_i, best_g = None, 0.0
    for i in range(start, n - 1):
        if gaps[i] > best_g:
            best_g, best_i = gaps[i], i
    if best_i is not None and best_g > _ROBUST_ISOLATION * typical:
        hi = best_i
    # Symmetric check at the bottom.
    end = min(n - 1, outer)
    best_i, best_g = None, 0.0
    for i in range(0, end):
        if gaps[i] > best_g:
            best_g, best_i = gaps[i], i
    if best_i is not None and best_g > _ROBUST_ISOLATION * typical:
        lo = best_i + 1
    if lo >= hi:
        return v[0], v[-1]
    return v[lo], v[hi]


def _round(rec, nd):
    for key in ("p", "f"):
        v = rec.get(key)
        if v:
            rec[key] = [round(c, nd) for c in v]


def _parse_foreign(doc) -> Dict[str, Any]:
    msp = doc.modelspace()
    rd = _Reader(doc)
    entities, inserts = [], []
    for e in msp:
        t = e.dxftype()
        if t == "INSERT":
            try:
                if e.mcount > 1:   # MINSERT array → one placed record per cell
                    for i, ve in enumerate(e.multi_insert()):
                        rec = rd.insert(ve, f"{e.dxf.handle}:{i}")
                        if rec:
                            inserts.append(rec)
                else:
                    rec = rd.insert(e, e.dxf.handle)
                    if rec:
                        inserts.append(rec)
            except Exception:
                rd.skipped["INSERT"] = rd.skipped.get("INSERT", 0) + 1
        else:
            rd.convert(e, entities, True)
        if rd.truncated:
            break

    # Extents over what was actually read (not $EXTMIN, which is often stale).
    xs, ys = [], []
    for r in entities:
        for x, y in _rec_points(r):
            xs.append(x); ys.append(y)
    memo: Dict[str, Any] = {}
    for ins in inserts:
        bb = _block_bbox(rd, ins["b"], memo)
        pts = _corners(bb, ins, rd.blocks[ins["b"]]["bp"]) if bb else [tuple(ins["p"])]
        for x, y in pts:
            xs.append(x); ys.append(y)
        for r in ins.get("at", []):
            xs.append(r["p"][0]); ys.append(r["p"][1])
    for name in list(rd.blocks):
        _block_bbox(rd, name, memo)
    if not xs:
        return {"mode": "underlay", "format": 2, "empty": True, "skipped": rd.skipped}
    (lox, hix), (loy, hiy) = _robust_bounds(xs), _robust_bounds(ys)
    if len(xs) >= _ROBUST_MIN_N and max(hix - lox, hiy - loy) > _MEDIAN_ORIGIN_SPAN:
        # Anchor the shift to the MEDIAN, not a bbox corner: a real site plan's
        # dense, relevant content can sit far from the corner of its own
        # bounding box (a second building cluster kilometres away, an outlying
        # legend). Shifting by a corner then leaves the majority of the
        # drawing's local coordinates in the millions — exactly the magnitude
        # a canvas's transform pipeline (commonly single-precision internally)
        # loses enough precision over that geometry silently fails to paint,
        # even though the origin/bbox fit (above) is already correct and the
        # entities parse without error. The median sits inside the densest
        # cluster by construction, so most of the drawing gets small,
        # precise local coordinates; a genuinely isolated minority pays the
        # precision cost instead.
        ox, oy = sorted(xs)[len(xs) // 2], sorted(ys)[len(ys) // 2]
    else:
        ox, oy = lox, loy
    for r in entities:
        _shift(r, ox, oy)
    for ins in inserts:
        ins["p"][0] -= ox; ins["p"][1] -= oy
        for r in ins.get("at", []):
            _shift(r, ox, oy)
    # Round coordinates to a tenth of the flattening tolerance — invisible at
    # any zoom, and it roughly halves the stored JSON.
    nd = max(0, min(9, -int(math.floor(math.log10(rd.tol / 10.0)))))
    for r in entities:
        _round(r, nd)
    for ins in inserts:
        _round(ins, nd)
        for r in ins.get("at", []):
            _round(r, nd)
    for blk in rd.blocks.values():
        for r in blk["e"]:
            _round(r, nd)

    # Layer usage counts (model space + block contents via their inserts).
    def bump(name, n=1):
        ly = rd.layers.get(name)
        if ly is None:
            ly = rd.layers[name] = {"name": name, "color": "#ffffff", "aci7": True, "on": True, "frozen": False, "n": 0}
        ly["n"] += n
    for r in entities:
        bump(r["l"])
    for ins in inserts:
        bump(ins["l"])
    for blk in rd.blocks.values():
        for r in blk["e"]:
            if r["l"] != "0":
                bump(r["l"], 0)   # make sure the layer is listed

    insunits = int(doc.header.get("$INSUNITS", 0) or 0)
    return {
        "mode": "underlay", "format": 2,
        "units": {"code": insunits, "m": _UNIT_M.get(insunits), "name": _UNIT_NAME.get(insunits, ""),
                  "metric": int(doc.header.get("$MEASUREMENT", 1) or 0) == 1},
        "origin": [ox, oy],
        "bbox": [lox - ox, loy - oy, hix - ox, hiy - oy],
        "layers": [ly for ly in rd.layers.values()],
        "blocks": {k: v for k, v in rd.blocks.items()},
        "inserts": inserts,
        "entities": entities,
        "count": len(entities) + len(inserts),
        "truncated": rd.truncated,
        "skipped": rd.skipped,
    }


def _parse_ours(doc, factor, floor_name, domain) -> Dict[str, Any]:
    msp = doc.modelspace()

    def to_px(x, y):
        return [x / factor, -y / factor]

    devices, routes, trenches, rooms, texts, measurements, crossings = [], [], [], [], [], [], []
    for e in msp.query("INSERT"):
        name = e.dxf.name or ""
        # Round-trip mode is already gated on the PP_META block (parse_dxf);
        # every other INSERT in one of our own files is a device — LISP-named
        # blocks (LUMINAIRE, DB, ...) no longer carry a "PP_" prefix, so that
        # can't gate device recognition any more.
        if name == META_BLOCK:
            continue
        attrs = {a.dxf.tag: a.dxf.text for a in e.attribs}
        px = to_px(e.dxf.insert.x, e.dxf.insert.y)
        devices.append({
            "type": attrs.get("TYPE") or (name[3:] if name.startswith("PP_") else name),
            "block": name,
            "x": px[0], "y": px[1],
            "rotation": (-float(e.dxf.rotation)) % 360,
            "name": attrs.get("REF") or attrs.get("NAME", ""),
            "attrs": attrs,
        })
    for e in msp:
        t = e.dxftype()
        layer = e.dxf.layer
        meta = _get_meta(e)
        kind = meta.get("KIND")
        if t == "SPLINE":
            pts = [to_px(x, y) for x, y in _spline_pts(e)]
            if len(pts) >= 2:
                routes.append({"curved": True, "layer": layer, "pts": pts, "meta": meta})
        elif t == "LWPOLYLINE":
            pts = [to_px(p[0], p[1]) for p in e.get_points("xy")]
            if len(pts) < 2:
                continue
            if kind == "trench" or (not kind and layer == "PP_TRENCH"):
                trenches.append({"pts": pts, "meta": meta})
            elif kind == "room" or (not kind and layer == "PP_ROOMS"):
                rooms.append({"pts": pts, "meta": meta})
            elif layer == "PP_DIM":
                measurements.append({"pts": pts})
            else:
                routes.append({"curved": meta.get("CURVED") == "1", "layer": layer, "pts": pts, "meta": meta})
        elif t == "LINE" and kind == "crossing":
            crossings.append({"p1": to_px(e.dxf.start.x, e.dxf.start.y), "p2": to_px(e.dxf.end.x, e.dxf.end.y), "meta": meta})
        elif t == "TEXT" and layer == "PP_TEXT":
            p = to_px(e.dxf.insert.x, e.dxf.insert.y)
            texts.append({"x": p[0], "y": p[1], "text": e.dxf.text})
        elif t == "TEXT" and layer == "PP_ROOMS":
            # Room label: attach to the room polygon that contains it (older
            # files carry no NAME xdata on the polyline).
            p = to_px(e.dxf.insert.x, e.dxf.insert.y)
            texts.append({"x": p[0], "y": p[1], "text": e.dxf.text, "roomLabel": True})
    # Resolve room labels onto rooms lacking a NAME.
    labels = [t for t in texts if t.get("roomLabel")]
    texts = [t for t in texts if not t.get("roomLabel")]
    for rm in rooms:
        if rm["meta"].get("NAME"):
            rm["label"] = rm["meta"]["NAME"]
            continue
        for lb in labels:
            if _pip(lb["x"], lb["y"], rm["pts"]):
                rm["label"] = lb["text"]
                break
    if not domain:
        domain = "building" if any(d["type"].startswith("bd_") for d in devices) or not devices else "retic"
    return {"mode": "roundtrip", "factor": factor, "floorName": floor_name, "domain": domain,
            "devices": devices, "routes": routes, "trenches": trenches, "crossings": crossings,
            "rooms": rooms, "texts": texts, "measurements": measurements}


def _pip(x, y, pts):
    inside = False
    n = len(pts)
    for i in range(n):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % n]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / ((y2 - y1) or 1e-12) + x1:
            inside = not inside
    return inside


def _read_doc(data: bytes):
    """Load DXF bytes the way ezdxf reads a file: it sniffs binary vs ASCII,
    honours $DWGCODEPAGE for pre-2007 files and copes with CRLF line endings
    (a decoded str in a StringIO keeps the '\r' and silently parses to an
    empty drawing — most AutoCAD files on Windows are CRLF). Damaged files
    fall back to the recover loader."""
    import os
    import tempfile
    fd, path = tempfile.mkstemp(suffix=".dxf")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        try:
            return ezdxf.readfile(path)
        except Exception:
            from ezdxf import recover
            doc, _auditor = recover.readfile(path)
            return doc
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def parse_dxf(data: bytes) -> Dict[str, Any]:
    """Read a DXF. One of ours (PP_META block) → native plan entities
    ('roundtrip'); anything else → the structured underlay ('underlay'):
    layers, block definitions, placed blocks with their attributes, and
    model-space geometry with every curve type resolved."""
    doc = _read_doc(data)
    msp = doc.modelspace()
    factor, floor_name, domain = _meta_block(msp)
    if factor is not None and factor > 0:
        return _parse_ours(doc, factor, floor_name, domain)
    return _parse_foreign(doc)
