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

import ezdxf
from ezdxf.enums import TextEntityAlignment

APPID = "PROTECTIONPRO"
META_BLOCK = "PP_META"
# Attribute tags carried on every device blockref.
ATTR_TAGS = ["NAME", "TYPE", "DBOARD", "CIRCUIT", "PHASE", "LOAD_VA", "CABLE"]


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
def _build_block(doc, name: str, prims: List[dict], size_world: float, factor: float):
    """Create a block whose geometry (in metres) matches the on-screen glyph.

    Art box is 0..40 centred on (20,20); a glyph spans `size_world` px, so one
    art unit = size_world/40 px = size_world/40*factor metres. Y is flipped.
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
    for i, tag in enumerate(ATTR_TAGS):
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

    # Symbol blocks (one per variant).
    variants = payload.get("blocks", {})
    for name, v in variants.items():
        _build_block(doc, name, v.get("prims", []), v.get("sizeWorld", 24), factor)

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
        ref.add_auto_attribs({t: str(attrs.get(t, "")) for t in ATTR_TAGS})

    # Routes → SPLINE (curved) or LWPOLYLINE (straight), + a cable label.
    for r in payload.get("routes", []):
        pts = [(X(p[0]), Y(p[1])) for p in r.get("pts", [])]
        if len(pts) < 2:
            continue
        layer = r.get("layer", "PP_ROUTES")
        if r.get("curved") and len(pts) >= 3:
            msp.add_spline(fit_points=[(x, y, 0) for x, y in pts], dxfattribs={"layer": layer})
        else:
            msp.add_lwpolyline(pts, dxfattribs={"layer": layer})
        label = r.get("label")
        if label:
            mid = pts[len(pts) // 2]
            msp.add_text(label, dxfattribs={"height": 0.9, "layer": "PP_LABELS"}).set_placement(mid, align=TextEntityAlignment.MIDDLE_LEFT)

    # Trenches / measurements → polylines; rooms → closed polylines; texts.
    for t in payload.get("trenches", []):
        pts = [(X(p[0]), Y(p[1])) for p in t.get("pts", [])]
        if len(pts) >= 2:
            msp.add_lwpolyline(pts, dxfattribs={"layer": "PP_TRENCH"})
    for rm in payload.get("rooms", []):
        pts = [(X(p[0]), Y(p[1])) for p in rm.get("pts", [])]
        if len(pts) >= 3:
            msp.add_lwpolyline(pts, close=True, dxfattribs={"layer": "PP_ROOMS"})
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
            msp.add_line((X(p1[0]), Y(p1[1])), (X(p2[0]), Y(p2[1])), dxfattribs={"layer": "PP_TRENCH"})
    for tx in payload.get("texts", []):
        msp.add_text(str(tx.get("text", "")), dxfattribs={
            "height": max(0.05, tx.get("h", 2) * factor), "layer": "PP_TEXT",
        }).set_placement((X(tx["x"]), Y(tx["y"])), align=TextEntityAlignment.MIDDLE_LEFT)

    # Metadata block: carries the scale factor so import inverts exactly.
    if META_BLOCK not in doc.blocks:
        mb = doc.blocks.new(META_BLOCK)
        mb.add_attdef("FACTOR", dxfattribs={"height": 0.001, "invisible": 1}).set_placement((0, 0))
        mb.add_attdef("FLOOR", dxfattribs={"height": 0.001, "invisible": 1}).set_placement((0, -0.001))
    mref = msp.add_blockref(META_BLOCK, (0, 0), dxfattribs={"layer": META_BLOCK})
    mref.add_auto_attribs({"FACTOR": repr(float(factor)), "FLOOR": str(payload.get("floorName", ""))})

    out = io.StringIO()
    doc.write(out)
    return out.getvalue().encode("utf-8")


# ─────────────────────────────────────────────────────────────────────────
# Import
# ─────────────────────────────────────────────────────────────────────────
def _meta_factor(msp):
    for e in msp.query("INSERT"):
        if e.dxf.name == META_BLOCK:
            vals = {a.dxf.tag: a.dxf.text for a in e.attribs}
            try:
                return float(vals.get("FACTOR", "0")), vals.get("FLOOR", "")
            except ValueError:
                return None, ""
    return None, ""


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


def parse_dxf(data: bytes) -> Dict[str, Any]:
    """Read a DXF. If it's one of ours (has PP_META + PP_* blocks) reconstruct
    native devices/routes; otherwise flatten it to a reference-underlay entity
    list (foreign blocks exploded to real geometry)."""
    text = data.decode("utf-8", errors="replace")
    doc = ezdxf.read(io.StringIO(text))
    msp = doc.modelspace()
    factor, floor_name = _meta_factor(msp)
    ours = factor is not None and factor > 0

    if ours:
        def to_px(x, y):
            return [x / factor, -y / factor]

        devices, routes, trenches, rooms, texts, measurements = [], [], [], [], [], []
        for e in msp.query("INSERT"):
            name = e.dxf.name or ""
            if name == META_BLOCK or not name.startswith("PP_bd_"):
                continue
            attrs = {a.dxf.tag: a.dxf.text for a in e.attribs}
            px = to_px(e.dxf.insert.x, e.dxf.insert.y)
            devices.append({
                "type": attrs.get("TYPE") or name,
                "block": name,
                "x": px[0], "y": px[1],
                "rotation": (-float(e.dxf.rotation)) % 360,
                "name": attrs.get("NAME", ""),
                "attrs": attrs,
            })
        for e in msp:
            t = e.dxftype()
            layer = e.dxf.layer
            if t == "SPLINE":
                pts = [to_px(x, y) for x, y in _spline_pts(e)]
                if len(pts) >= 2:
                    routes.append({"curved": True, "layer": layer, "pts": pts})
            elif t == "LWPOLYLINE":
                pts = [to_px(p[0], p[1]) for p in e.get_points("xy")]
                if len(pts) < 2:
                    continue
                if layer == "PP_TRENCH":
                    trenches.append({"pts": pts})
                elif layer == "PP_ROOMS":
                    rooms.append({"pts": pts})
                elif layer == "PP_DIM":
                    measurements.append({"pts": pts})
                else:
                    routes.append({"curved": False, "layer": layer, "pts": pts})
            elif t == "TEXT" and layer == "PP_TEXT":
                p = to_px(e.dxf.insert.x, e.dxf.insert.y)
                texts.append({"x": p[0], "y": p[1], "text": e.dxf.text})
        return {"mode": "roundtrip", "factor": factor, "floorName": floor_name,
                "devices": devices, "routes": routes, "trenches": trenches,
                "rooms": rooms, "texts": texts, "measurements": measurements}

    # Foreign DXF → flatten (explode blocks) into a reference-underlay list.
    ents = []

    def emit(e):
        t = e.dxftype()
        try:
            if t == "LINE":
                ents.append({"type": "line", "x1": e.dxf.start.x, "y1": e.dxf.start.y, "x2": e.dxf.end.x, "y2": e.dxf.end.y})
            elif t == "CIRCLE":
                ents.append({"type": "circle", "cx": e.dxf.center.x, "cy": e.dxf.center.y, "r": e.dxf.radius})
            elif t == "ARC":
                ents.append({"type": "arc", "cx": e.dxf.center.x, "cy": e.dxf.center.y, "r": e.dxf.radius, "a0": e.dxf.start_angle, "a1": e.dxf.end_angle})
            elif t == "LWPOLYLINE":
                ents.append({"type": "lwpolyline", "pts": [[p[0], p[1]] for p in e.get_points("xy")], "closed": bool(e.closed)})
            elif t == "POLYLINE":
                ents.append({"type": "lwpolyline", "pts": [[v.dxf.location.x, v.dxf.location.y] for v in e.vertices], "closed": bool(e.is_closed)})
            elif t in ("TEXT", "MTEXT"):
                ins = e.dxf.insert if e.dxf.hasattr("insert") else (e.dxf.get("insert", (0, 0, 0)))
                txt = e.plain_text() if t == "MTEXT" else e.dxf.text
                ents.append({"type": "text", "x": ins[0], "y": ins[1], "h": getattr(e.dxf, "height", 2) or 2, "text": txt})
        except Exception:
            pass

    for e in msp:
        if e.dxftype() == "INSERT":
            try:
                for ve in e.virtual_entities():
                    emit(ve)
            except Exception:
                pass
        else:
            emit(e)
    return {"mode": "underlay", "entities": ents}
