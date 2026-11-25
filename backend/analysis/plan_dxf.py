"""Plan Markup ↔ DXF (export AC1024 / R2010 — true colour needs R2004 or later; import any version) using ezdxf.

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
from typing import Any, Dict, List, Tuple

import logging

import ezdxf
from ezdxf.enums import TextEntityAlignment

from . import plan_dxf_sheets as sheets_mod


class _NoFontWarning(logging.Filter):
    """The backend image has no system fonts, so ezdxf warns "no default font
    found" once per text it measures while rendering DIMENSION/MTEXT virtual
    entities — dozens of lines per import. Glyph metrics don't matter here (we
    keep text as text, not outlines), so drop just that message and let every
    other ezdxf warning through."""

    def filter(self, record):
        return not str(record.getMessage()).startswith("no default font found")


logging.getLogger("ezdxf").addFilter(_NoFontWarning())
log = logging.getLogger(__name__)

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

# Layers of the plan items that are not symbols or routes (frontend PLAN_DXF_LAYERS.fixed sends the same names as `fixedLayers`).
FIXED_LAYERS = {"trench": "EL_TRENCH", "crossing": "EL_DUCTS", "room": "EL_ROOMS", "measurement": "EL_DIM", "text": "EL_TEXT"}
# What the importer reads by layer when an entity carries no KIND: the current name and the one used before.
_IMPORT_LAYERS = {k: {v, old} for (k, v), old in zip(FIXED_LAYERS.items(), ("PP_TRENCH", "PP_TRENCH", "PP_ROOMS", "PP_DIM", "PP_TEXT"))}

# Layout sheets: paper sizes (mm, landscape) and the margin round the one viewport of each sheet.
PAPERS = {"A0": (1189.0, 841.0), "A1": (841.0, 594.0), "A2": (594.0, 420.0), "A3": (420.0, 297.0), "A4": (297.0, 210.0)}
SHEET_MARGIN_MM = 10.0
VIEWPORT_LAYER = "EL_VIEWPORTS"


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
def _build_block(doc, name: str, prims: List[dict], size_world: float, factor: float, attr_tags: List[str] | None = None,
                 text_h: float | None = None):
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
        col = _attr_color(p) or {"color": 0}   # the device's own colour: ByBlock, so the INSERT (ByLayer, or its own colour) decides
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
            txt = blk.add_text(str(p.get("str", "")), dxfattribs={"height": h, "style": TEXT_STYLE, **col})
            txt.set_placement(pt(p["x"], p["y"]), align=TextEntityAlignment.MIDDLE_CENTER)

    # Attribute definitions (filled per-INSERT). REF — the device's name — is visible, the text height of the drawing, to the right
    # of the symbol (each INSERT then turns it upright, `_upright_ref`); the rest are data, invisible and stacked below the glyph.
    half = size_world * 0.5 * factor
    yoff = -half - 0.001
    for i, tag in enumerate(attr_tags or ATTR_TAGS):
        if tag == "REF" and text_h:
            ad = blk.add_attdef(tag, dxfattribs={"height": text_h, "style": TEXT_STYLE})
            ad.set_placement((half + 0.4 * text_h, 0), align=TextEntityAlignment.MIDDLE_LEFT)
            continue
        ad = blk.add_attdef(tag, dxfattribs={"height": max(0.001, size_world / 40.0 * factor * 3),
                                             "flags": 1, "style": TEXT_STYLE})
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


TEXT_STYLE = "PP_ARIAL"
BG_PREFIX = "BG-"          # background layers (xref-style, but '|' is reserved for real xrefs in AutoCAD)


def _readable(deg: float) -> float:
    """A text angle turned so it never reads upside down: (-90°, 90°]."""
    a = (deg + 180.0) % 360.0 - 180.0
    if a > 90.0:
        a -= 180.0
    elif a <= -90.0:
        a += 180.0
    return a


def _route_label_at(pts, h):
    """Where a cable's label goes: the middle of its longest segment, along it, read upright, 0.8 × the text height to one side."""
    best = None
    for i in range(1, len(pts)):
        (x0, y0), (x1, y1) = pts[i - 1], pts[i]
        L = math.hypot(x1 - x0, y1 - y0)
        if best is None or L > best[0]:
            best = (L, x0, y0, x1, y1)
    if not best or best[0] <= 0:
        return pts[len(pts) // 2], 0.0
    _, x0, y0, x1, y1 = best
    ang = _readable(math.degrees(math.atan2(y1 - y0, x1 - x0)))
    r = math.radians(ang)
    nx, ny = -math.sin(r), math.cos(r)              # left of the reading direction = above the line as read
    return ((x0 + x1) / 2 + nx * 0.8 * h, (y0 + y1) / 2 + ny * 0.8 * h), ang


def _color_attribs(hex_color, layer_hex=None):
    """An entity's own colour, only where it differs from its layer's (ByLayer otherwise)."""
    rgb = _hex_to_rgb(hex_color) if hex_color else None
    if not rgb or (layer_hex and _hex_to_rgb(layer_hex) == rgb):
        return {}
    return {"true_color": ezdxf.rgb2int(rgb)}


# ── Backgrounds ──
# A plan's DXF underlay goes into the export as one block per drawing, on BG- layers (the drawing's own layer names, prefixed), placed
# by an INSERT with the plan's own scale / rotation / offset. Only what the plan shows: layers hidden on the plan, entities already
# turned into plan items (`converted`) and anything outside the working area are left out. Two sources:
#   • the original DXF (`srcId`, kept on import since the original is stored): loaded with ezdxf's xref loader — everything exact,
#     linetypes, text styles, hatches, dimensions;
#   • the parsed copy the plan draws from (`imageId`, or `data` inline for a drawing not yet stored): rebuilt from its records —
#     lines, arcs, circles, polylines (curves flattened, hatches as outlines), points, text, blocks; colours kept.
# `m` = [a, b, c, d, e, f]: export (m) = (a·x + b·y + c, d·x + e·y + f) of a point in the parsed copy's coordinates (the drawing's
# own units, less `origin`).

_VALIGN = {"b": "BOTTOM", "m": "MIDDLE", "t": "TOP"}
_HALIGN = {"l": "LEFT", "c": "CENTER", "r": "RIGHT"}


def _text_alignment(ha, va):
    h = _HALIGN.get(ha or "l", "LEFT")
    v = _VALIGN.get(va or "a")
    try:
        return TextEntityAlignment[f"{v}_{h}"] if v else TextEntityAlignment[h]
    except KeyError:
        return TextEntityAlignment.LEFT


def _bg_layer_name(name: str) -> str:
    return (BG_PREFIX + (name or "0"))[:250]


def _pip_xy(x, y, poly):
    c = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi:
            c = not c
        j = i
    return c


def _area_keeper(area):
    """A test for 'touches the working area' on a box (x0, y0, x1, y1) in the parsed copy's coordinates; None = no area."""
    if not area or len(area) < 3:
        return None
    ax0 = min(p[0] for p in area); ax1 = max(p[0] for p in area)
    ay0 = min(p[1] for p in area); ay1 = max(p[1] for p in area)

    def keep(x0, y0, x1, y1):
        if x1 < ax0 or x0 > ax1 or y1 < ay0 or y0 > ay1:
            return False
        if any(_pip_xy(x, y, area) for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1), ((x0 + x1) / 2, (y0 + y1) / 2))):
            return True
        return any(x0 <= px <= x1 and y0 <= py <= y1 for px, py in area)
    return keep


def _rec_box(r):
    p = r.get("p") or []
    t = r.get("t")
    if t in ("c", "a") and len(p) >= 3:
        return p[0] - p[2], p[1] - p[2], p[0] + p[2], p[1] + p[2]
    if len(p) >= 2:
        xs, ys = p[0::2], p[1::2]
        return min(xs), min(ys), max(xs), max(ys)
    return None


def _place(msp, bname, m, origin, layer):
    """The INSERT that puts a background block (in the drawing's raw coordinates when `origin` is given) where the plan has it."""
    a, b, c, d, e, f = [float(v) for v in m]
    ox, oy = origin or (0.0, 0.0)
    tx, ty = c - a * ox - b * oy, f - d * ox - e * oy
    sx = math.hypot(a, d)
    det = a * e - b * d
    rot = math.degrees(math.atan2(d, a))
    return msp.add_blockref(bname, (tx, ty), dxfattribs={"layer": layer, "xscale": sx, "yscale": sx if det >= 0 else -sx, "rotation": rot})


def _unique_block(doc, base):
    base = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in base)[:200] or "BG"
    name, n = base, 1
    while name in doc.blocks:
        n += 1
        name = f"{base}_{n}"
    return name


def _add_background(doc, msp, bg, idx, load_image) -> str:
    name = bg.get("name") or f"background {idx + 1}"
    hidden = set(bg.get("hidden") or [])
    converted = set(str(h) for h in (bg.get("converted") or []))
    colors = bg.get("colors") or {}
    origin = bg.get("origin") or [0.0, 0.0]
    keep_box = _area_keeper(bg.get("area"))
    if not bg.get("m"):
        raise ValueError("no placement")
    _ensure_layer(doc, _bg_layer_name("0"), colors.get("0"))
    src = None
    if bg.get("srcId") is not None and load_image:
        try:
            src = load_image(bg["srcId"])
        except Exception:
            src = None
    if src:
        n = _bg_from_original(doc, msp, bg, idx, src, hidden, converted, colors, origin, keep_box)
        return f"{name}: the original drawing, {n} entities"
    data = bg.get("data")
    if data is None and bg.get("imageId") is not None and load_image:
        import json
        data = json.loads(load_image(bg["imageId"]))
    if not data:
        raise ValueError("its drawing could not be read")
    n = _bg_from_parsed(doc, msp, bg, idx, data, hidden, converted, colors, keep_box)
    return f"{name}: rebuilt from the plan's copy, {n} entities (import it again to export the original exactly)"


def _bg_from_original(doc, msp, bg, idx, raw, hidden, converted, colors, origin, keep_box) -> int:
    from ezdxf import xref, bbox
    sdoc = _read_doc(raw)
    smsp = sdoc.modelspace()
    ox, oy = origin
    keep_h = set()
    for e in smsp:
        lay = e.dxf.get("layer", "0")
        if lay in hidden or str(e.dxf.handle) in converted:
            continue
        if keep_box:
            try:
                ext = bbox.extents([e], fast=True)
                if not ext.has_data or not keep_box(ext.extmin.x - ox, ext.extmin.y - oy, ext.extmax.x - ox, ext.extmax.y - oy):
                    continue
            except Exception:
                pass
        keep_h.add(e.dxf.handle)
    # the drawing's layers become BG-<name> (layer 0 stays: inside the block it takes the INSERT's layer, BG-0), with any colour set on the plan
    for ly in list(sdoc.layers):
        nm = ly.dxf.name
        if nm == "0" or nm.lower() == "defpoints":
            continue
        new = _bg_layer_name(nm)
        if new in sdoc.layers:
            continue
        try:
            ly.rename(new)
        except Exception:
            continue
        rgb = _hex_to_rgb(colors.get(nm) or "")
        if rgb:
            ly.rgb = rgb
    bname = _unique_block(doc, f"BG-{idx + 1}-{bg.get('name') or 'drawing'}")
    blk = doc.blocks.new(bname)
    loader = xref.Loader(sdoc, doc, conflict_policy=xref.ConflictPolicy.NUM_PREFIX)
    loader.load_modelspace(target_layout=blk, filter_fn=lambda e: e.dxf.handle in keep_h)
    loader.execute()
    _place(msp, bname, bg["m"], origin, _bg_layer_name("0"))
    return len(blk)


def _bg_from_parsed(doc, msp, bg, idx, data, hidden, converted, colors, keep_box) -> int:
    layers = {ly.get("name"): ly for ly in data.get("layers", []) or []}

    def lay(nm):
        if nm == "0":
            return "0"
        new = _bg_layer_name(nm)
        if new not in doc.layers:
            ly = doc.layers.add(new)
            info = layers.get(nm) or {}
            over = colors.get(nm)
            if over and _hex_to_rgb(over):
                ly.rgb = _hex_to_rgb(over)
            elif info.get("aci7", True):
                ly.color = 7
            elif _hex_to_rgb(info.get("color") or ""):
                ly.rgb = _hex_to_rgb(info["color"])
            if isinstance(info.get("w"), int) and info["w"] >= 0:
                ly.dxf.lineweight = info["w"]
        return new

    def col(r):
        k, w = r.get("k"), r.get("w")
        out = {}
        if k == "B":
            out["color"] = 0
        else:
            rgb = _hex_to_rgb(k) if k else None
            if rgb:
                out["true_color"] = ezdxf.rgb2int(rgb)
        if w == "B":
            out["lineweight"] = -2
        elif isinstance(w, int) and w >= 0:
            out["lineweight"] = w
        return out

    def emit(lo, r, block_names):
        t, p = r.get("t"), r.get("p") or []
        da = {"layer": lay(r.get("l", "0")), **col(r)}
        if t == "l" and len(p) >= 4:
            lo.add_line((p[0], p[1]), (p[2], p[3]), dxfattribs=da)
        elif t == "p" and len(p) >= 4:
            lo.add_lwpolyline(list(zip(p[0::2], p[1::2])), close=bool(r.get("c")), dxfattribs=da)
        elif t == "c" and len(p) >= 3:
            lo.add_circle((p[0], p[1]), p[2], dxfattribs=da)
        elif t == "a" and len(p) >= 5:
            lo.add_arc((p[0], p[1]), p[2], p[3], p[4], dxfattribs=da)
        elif t == "o" and len(p) >= 2:
            lo.add_point((p[0], p[1]), dxfattribs=da)
        elif t == "x" and len(p) >= 2 and str(r.get("s", "")).strip():
            for k, line in enumerate(str(r["s"]).split("\n")):
                h = float(r.get("h") or 1.0)
                rr = math.radians(float(r.get("r") or 0.0))
                at = (p[0] + math.sin(rr) * 1.5 * h * k, p[1] - math.cos(rr) * 1.5 * h * k)
                lo.add_text(line, dxfattribs={**da, "height": h, "rotation": float(r.get("r") or 0.0), "style": TEXT_STYLE}
                            ).set_placement(at, align=_text_alignment(r.get("ha"), r.get("va")))
        elif t == "i" and r.get("b") in block_names and len(p) >= 2:
            lo.add_blockref(block_names[r["b"]], (p[0], p[1]), dxfattribs={**da, "rotation": float(r.get("r") or 0.0),
                                                                          "xscale": float(r.get("sx") or 1.0), "yscale": float(r.get("sy") or 1.0)})

    # block definitions the drawing uses (its own coordinates, base point kept); nested inserts resolved by name
    blocks = data.get("blocks") or {}
    names = {b: _unique_block(doc, f"BG{idx + 1}-{b}") for b in blocks}
    for b, rec in blocks.items():
        bl = doc.blocks.new(names[b], base_point=tuple((rec.get("bp") or [0, 0])[:2]))
        for r in rec.get("e", []):
            emit(bl, r, names)

    bname = _unique_block(doc, f"BG-{idx + 1}-{bg.get('name') or 'drawing'}")
    blk = doc.blocks.new(bname)
    n = 0

    def wanted(r):
        if r.get("l") in hidden or (r.get("h") is not None and str(r["h"]) in converted):
            return False
        if keep_box:
            bb = _rec_box(r)
            if bb and not keep_box(*bb):
                return False
        return True

    for r in data.get("entities", []) or []:
        if wanted(r):
            emit(blk, r, names)
            n += 1
    for ins in data.get("inserts", []) or []:
        if not wanted(ins) or ins.get("b") not in names:
            continue
        emit(blk, {**ins, "t": "i"}, names)
        for a in ins.get("at", []) or []:
            emit(blk, a, names)
        n += 1
    _place(msp, bname, bg["m"], None, _bg_layer_name("0"))
    return n



def build_dxf(payload: Dict[str, Any], load_image=None, notes: List[str] | None = None) -> bytes:
    """`load_image(id) -> bytes` reads a stored plan image (the background's original DXF or its parsed copy) for `backgrounds`;
    `notes` collects one line per background (how it went in, or why it was left out)."""
    factor = payload.get("factor")
    if not factor or factor <= 0:
        raise ValueError("Plan is not calibrated — DXF export needs a scale (metres per pixel).")

    # R2010: true colour (layers and entities) needs R2004+; R2000 dropped every colour that is not an index colour
    doc = ezdxf.new("R2010", setup=["linetypes"])          # the standard linetypes (DASHED…), not ezdxf's sample text styles
    doc.appids.add(APPID)
    msp = doc.modelspace()

    # One text style for every text written here (a TrueType font, so it plots the same everywhere).
    if TEXT_STYLE not in doc.styles:
        doc.styles.add(TEXT_STYLE, font="arial.ttf")
    # Text height (m): a paper height at a drawing scale (2.5 mm at 1:500 = 1.25 m); a payload without one keeps the old 0.9 m.
    H = float(payload.get("textH") or 0.9)
    doc.header["$TEXTSTYLE"] = TEXT_STYLE
    doc.header["$TEXTSIZE"] = H
    if payload.get("ltscale"):
        doc.header["$LTSCALE"] = float(payload["ltscale"])

    # Layers (the plan's colours, true colour; a dashed cable type's layer gets the DASHED linetype).
    layer_hex: Dict[str, str] = {}
    for lyr in payload.get("layers", []):
        _ensure_layer(doc, lyr["name"], lyr.get("color"))
        layer_hex[lyr["name"]] = lyr.get("color") or ""
        lt = lyr.get("linetype")
        if lt and lt in doc.linetypes:
            doc.layers.get(lyr["name"]).dxf.linetype = lt
    fixed = {**FIXED_LAYERS, **(payload.get("fixedLayers") or {})}
    L_TRENCH, L_DUCTS, L_ROOMS, L_DIM, L_TEXT = (fixed[k] for k in ("trench", "crossing", "room", "measurement", "text"))
    extras = payload.get("extraLayers") or {}
    for extra in (*extras.keys(), L_TRENCH, L_DUCTS, L_ROOMS, L_DIM, L_TEXT, META_BLOCK):
        _ensure_layer(doc, extra, extras.get(extra))
        layer_hex.setdefault(extra, extras.get(extra) or "")

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
        _build_block(doc, name, v.get("prims", []), v.get("sizeWorld", 24), factor, tags, text_h=H)

    # Devices → blockref + attributes.
    for el in payload.get("elements", []):
        name = el.get("block")
        if not name or name not in doc.blocks:
            continue
        rot = -float(el.get("rotation", 0) or 0)  # screen CW → DXF CCW
        lay = el.get("layer", "0")
        ref = msp.add_blockref(name, (X(el["x"]), Y(el["y"])), dxfattribs={
            "layer": lay, "rotation": rot, **_color_attribs(el.get("color"), layer_hex.get(lay)),
        })
        attrs = el.get("attrs", {}) or {}
        tags = block_attr_tags.get(name, ATTR_TAGS)
        ref.add_auto_attribs({t: str(attrs.get(t, "")) for t in tags})
        # the name reads upright, to the right of the symbol, whatever way the symbol is turned
        half = (variants.get(name, {}).get("sizeWorld", 24) or 24) * 0.5 * factor
        for a in ref.attribs:
            if a.dxf.tag == "REF" and not a.is_invisible:
                a.dxf.rotation = 0.0
                a.set_placement((X(el["x"]) + half + 0.4 * H, Y(el["y"])), align=TextEntityAlignment.MIDDLE_LEFT)

    # Routes → SPLINE (curved) or LWPOLYLINE (straight), + a cable label: a leader to a clear spot (labels.style 'circle' /
    # 'arrow', placed once every route is drawn) or, 'along', the text along the longest segment.
    label_style = str((payload.get("labels") or {}).get("style") or "along")
    leader_routes: List[dict] = []
    lw_of: Dict[str, List[Tuple[Any, int]]] = {}        # layer → [(entity, line weight)]: set on the layer when they agree
    for r in payload.get("routes", []):
        pts = [(X(p[0]), Y(p[1])) for p in r.get("pts", [])]
        if len(pts) < 2:
            continue
        layer = r.get("layer") or "PP_ROUTES"
        _ensure_layer(doc, layer, r.get("color"))
        da = {"layer": layer, **_color_attribs(r.get("color"), layer_hex.get(layer))}
        lt = r.get("linetype")              # its own linetype only where it differs from its layer's (ByLayer otherwise)
        lay_lt = (doc.layers.get(layer).dxf.linetype if layer in doc.layers else "Continuous") or "Continuous"
        if lt and lt in doc.linetypes and lt.lower() != lay_lt.lower():
            da["linetype"] = lt
        if r.get("curved") and len(pts) >= 3:
            ent = msp.add_spline(fit_points=[(x, y, 0) for x, y in pts], dxfattribs=da)
        else:
            ent = msp.add_lwpolyline(pts, dxfattribs=da)
        _set_meta(ent, {"KIND": "route", "TYPE": r.get("type"), "CABLE": r.get("cable"),
                        "CURVED": "1" if r.get("curved") else "0",
                        "FROM": r.get("fromName"), "TO": r.get("toName")})
        if r.get("lw"):
            lw_of.setdefault(layer, []).append((ent, int(r["lw"])))
        if label_style != "along":
            if r.get("labelLines"):
                lab_layer = r.get("labelLayer") or (layer + "_LABELS")
                _ensure_layer(doc, lab_layer, layer_hex.get(layer) or r.get("color"))
                layer_hex.setdefault(lab_layer, layer_hex.get(layer) or r.get("color") or "")
                leader_routes.append({"ptsM": pts, "labelLines": r["labelLines"], "labelLayer": lab_layer})
            else:
                leader_routes.append({"ptsM": pts})
            continue
        label = r.get("label")
        if label:
            at, ang = _route_label_at(pts, H)
            lab_layer = r.get("labelLayer") or (layer + "_LABELS")    # each cable layer's labels on a layer of their own
            _ensure_layer(doc, lab_layer, layer_hex.get(layer) or r.get("color"))
            layer_hex.setdefault(lab_layer, layer_hex.get(layer) or r.get("color") or "")
            msp.add_text(label, dxfattribs={"height": H, "layer": lab_layer, "style": TEXT_STYLE, "rotation": ang,
                                            **_color_attribs(r.get("color"), layer_hex.get(lab_layer))}).set_placement(at, align=TextEntityAlignment.MIDDLE_CENTER)

    # Trenches / measurements → polylines; rooms → closed polylines; texts.
    for t in payload.get("trenches", []):
        pts = [(X(p[0]), Y(p[1])) for p in t.get("pts", [])]
        if len(pts) >= 2:
            da = {"layer": L_TRENCH, **_color_attribs(t.get("color"), layer_hex.get(L_TRENCH))}
            if t.get("widthM"):                       # drawn at its real width, as the plan draws it
                da["const_width"] = float(t["widthM"])
            ent = msp.add_lwpolyline(pts, dxfattribs=da)
            if t.get("alpha") is not None:
                ent.transparency = max(0.0, min(1.0, 1.0 - float(t["alpha"])))
            _set_meta(ent, {"KIND": "trench", "EXC": t.get("excType"), "NAME": t.get("name")})
    for rm in payload.get("rooms", []):
        pts = [(X(p[0]), Y(p[1])) for p in rm.get("pts", [])]
        if len(pts) >= 3:
            ent = msp.add_lwpolyline(pts, close=True, dxfattribs={"layer": L_ROOMS, **_color_attribs(rm.get("color"), layer_hex.get(L_ROOMS))})
            _set_meta(ent, {"KIND": "room", "NAME": rm.get("label")})
            if rm.get("lw"):
                lw_of.setdefault(L_ROOMS, []).append((ent, int(rm["lw"])))
        if rm.get("label") and pts:
            cx = sum(p[0] for p in pts) / len(pts)
            cy = sum(p[1] for p in pts) / len(pts)
            lab = msp.add_text(rm["label"], dxfattribs={"height": H, "layer": L_ROOMS, "style": TEXT_STYLE})
            lab.set_placement((cx, cy), align=TextEntityAlignment.MIDDLE_CENTER)
            _set_meta(lab, {"KIND": "roomlabel"})
    for m in payload.get("measurements", []):
        pts = [(X(p[0]), Y(p[1])) for p in m.get("pts", [])]
        if len(pts) >= 2:
            ent = msp.add_lwpolyline(pts, dxfattribs={"layer": L_DIM, **_color_attribs(m.get("color"), layer_hex.get(L_DIM))})
            _set_meta(ent, {"KIND": "measurement"})
    for c in payload.get("crossings", []):
        p1, p2 = c.get("p1"), c.get("p2")
        if p1 and p2:
            # colour by duct size (ACI 1 red = 160 mm, 30 orange = 110 mm), matching the plan; the size is also in the entity's data
            col = _color_attribs(c.get("color"), layer_hex.get(L_DUCTS)) if c.get("color") else {"color": 1 if str(c.get("size")) == "160" else 30}
            ent = msp.add_line((X(p1[0]), Y(p1[1])), (X(p2[0]), Y(p2[1])), dxfattribs={"layer": L_DUCTS, **col})
            _set_meta(ent, {"KIND": "crossing", "SIZE": c.get("size"), "NAME": c.get("name")})
            if c.get("lw"):
                lw_of.setdefault(L_DUCTS, []).append((ent, int(c["lw"])))
    # Plan texts: the drawing's text height scaled by their size on the plan (14 = normal), anchored top-left as the plan draws them,
    # in their own colour; a payload from before text heights keeps the old size in plan units.
    for tx in payload.get("texts", []):
        h = H * float(tx.get("rel")) if tx.get("rel") else max(0.05, tx.get("h", 2) * factor)
        for i, line in enumerate(str(tx.get("text", "")).split("\n")):
            if not line.strip():
                continue
            ent = msp.add_text(line, dxfattribs={"height": h, "layer": L_TEXT, "style": TEXT_STYLE,
                                                 **_color_attribs(tx.get("color"), layer_hex.get(L_TEXT))})
            ent.set_placement((X(tx["x"]), Y(tx["y"]) - i * 1.5 * h), align=TextEntityAlignment.TOP_LEFT)
            _set_meta(ent, {"KIND": "text"})

    # Cable labels as leaders, now that everything they must keep clear of is known.
    if label_style != "along" and leader_routes:
        obstacles = []
        for el in payload.get("elements", []):
            half = (variants.get(el.get("block"), {}).get("sizeWorld", 24) or 24) * 0.5 * factor
            obstacles.append((X(el["x"]), Y(el["y"]), half))
        text_style = TEXT_STYLE
        sheets_mod.place_labels(msp, doc, leader_routes, obstacles, H, label_style, text_style)

    # A leader and a circle per road crossing with its duct count (3L/4S = 3 large 160 mm, 4 small 110 mm).
    xl = payload.get("crossingLabels") or []
    if xl:
        xl_layer = L_DUCTS + "_LABELS"
        _ensure_layer(doc, xl_layer, layer_hex.get(L_DUCTS))
        lab_in = []
        for q in xl:
            a, p2 = q.get("p1"), q.get("p2")
            if not a or not p2:
                continue
            A, B = (X(a[0]), Y(a[1])), (X(p2[0]), Y(p2[1]))
            mid = ((A[0] + B[0]) / 2, (A[1] + B[1]) / 2)
            lab_in.append({"a": mid, "dir": (B[0] - A[0], B[1] - A[1]) if A != B else (1.0, 0.0), "text": q.get("text") or "",
                           "lines": [(A, B)]})
        allines = [l for q in lab_in for l in q["lines"]]
        for q in lab_in:
            q["lines"] = [q["lines"][0]] + [l for l in allines if l != q["lines"][0]]
        obst = [(X(el["x"]), Y(el["y"]), (variants.get(el.get("block"), {}).get("sizeWorld", 24) or 24) * 0.5 * factor)
                for el in payload.get("elements", [])]
        sheets_mod.place_crossing_labels(msp, [q for q in lab_in if q["text"]], obst, H, xl_layer, TEXT_STYLE, _set_meta)

    sym_layers = {el.get("layer") for el in payload.get("elements", [])}
    # Line weights as the plan draws the lines: on the layer when every line on it has the same one, else on each line.
    for lay, items in lw_of.items():
        ws = {w for _, w in items}
        if len(ws) == 1 and len(items) and lay in doc.layers and lay not in sym_layers:   # a symbol's own lines stay as drawn
            doc.layers.get(lay).dxf.lineweight = ws.pop()
        else:
            for ent, w in items:
                ent.dxf.lineweight = w
    if lw_of:
        doc.header["$LWDISPLAY"] = 1

    # Backgrounds (the plan's DXF underlays): what the plan shows of each, on BG- layers, as one block each.
    for i, bg in enumerate(payload.get("backgrounds", []) or []):
        try:
            note = _add_background(doc, msp, bg, i, load_image)
        except Exception as e:  # one bad background never stops the export
            note = f"{bg.get('name') or 'background'}: left out ({e})"
        if notes is not None and note:
            notes.append(note)

    # Metadata block: carries the scale factor so import inverts exactly.
    if META_BLOCK not in doc.blocks:
        mb = doc.blocks.new(META_BLOCK)
        mb.add_attdef("FACTOR", dxfattribs={"height": 0.001, "flags": 1}).set_placement((0, 0))
        mb.add_attdef("FLOOR", dxfattribs={"height": 0.001, "flags": 1}).set_placement((0, -0.001))
        mb.add_attdef("DOMAIN", dxfattribs={"height": 0.001, "flags": 1}).set_placement((0, -0.002))
    mref = msp.add_blockref(META_BLOCK, (0, 0), dxfattribs={"layer": META_BLOCK})
    mref.add_auto_attribs({"FACTOR": repr(float(factor)), "FLOOR": str(payload.get("floorName", "")),
                           "DOMAIN": str(payload.get("domain", ""))})
    # Real-world units: the file is drawn in metres.
    doc.header["$INSUNITS"] = 6

    # Layout sheets: one paper-space layout per sheet, each showing only its layers.
    if payload.get("sheets"):
        _add_layouts(doc, msp, payload)

    out = io.StringIO()
    doc.write(out)
    # Encode in the drawing's own code page (R2007 and later → UTF-8; an older one → its ANSI code page, with \U+XXXX
    # escapes for anything outside it). Writing UTF-8 bytes under an ANSI_1252
    # header garbled "mm²" in AutoCAD and on our own re-import.
    return doc.encode(out.getvalue())




def _add_layouts(doc, msp, payload):
    """One paper-space layout per sheet (in the order sent), each with one viewport at the drawing scale on the plan's
    extents that freezes the layers not on that sheet. `layerSheets` = {layer: [sheet ids] | 'all'}; a layer it does not
    name (backgrounds, labels of an unlisted layer) shows on every sheet. Layout1 is replaced.

    With a title-block template (plan_dxf_sheets): the template's block for the paper size at the sheet's origin, its
    attributes filled from `titleBlock` ({common: {tag: text}, sheets: {sheet id: {tag: text}}}), the viewport inside its
    frame left of the title panel, the legend in the panel's free column. Without one: the viewport within a margin, the
    legend in a column on its right."""
    lay_cfg = payload.get("layout") or {}
    paper = str(lay_cfg.get("paper") or "A1").upper()
    pw, ph = PAPERS.get(paper, PAPERS["A1"])
    margin = float(lay_cfg.get("margin") or SHEET_MARGIN_MM)
    scale = float(lay_cfg.get("scale") or payload.get("scale") or 500)
    factor = float(payload.get("factor") or 1.0)
    ext = lay_cfg.get("extents")
    if ext and len(ext) == 4:
        cx, cy = (ext[0] + ext[2]) / 2.0, (ext[1] + ext[3]) / 2.0
    else:
        try:
            from ezdxf import bbox
            b = bbox.extents(msp, fast=True)
            cx, cy = (b.center.x, b.center.y) if b.has_data else (0.0, 0.0)
        except Exception:
            cx, cy = 0.0, 0.0
    layer_sheets = dict(payload.get("layerSheets") or {})
    # a cable layer's labels go where the cable goes
    for ly in list(doc.layers):
        nm = ly.dxf.name
        if nm.endswith("_LABELS") and nm not in layer_sheets and nm[:-7] in layer_sheets:
            layer_sheets[nm] = layer_sheets[nm[:-7]]
    layer_sheets.setdefault(META_BLOCK, [])

    tb = sheets_mod.import_title_block(doc, paper) if lay_cfg.get("titleBlock", True) else None
    geo = sheets_mod.title_block_geometry(doc, tb) if tb else None
    if geo and geo.get("panel") is not None:
        fx0, fy0, fx1, fy1 = geo["frame"]
        vp_box = (fx0 + 3, fy0 + 3, geo["panel"] - 3, fy1 - 3)
        lx0, ly0, lx1, ly1 = geo["legend"]
        legend_rect = (lx0, ly0 + 1, lx1, ly1 - 1)
    else:
        tb = None
        col = 98.0                                   # must match PlanDXF.LEGEND_COL_MM
        vp_box = (margin, margin, pw - margin - col - 3, ph - margin)
        legend_rect = (pw - margin - col, margin, pw - margin, ph - margin)
    # the legend in the title block's own lettering (its attributes' text style), else ours
    style = next((a.dxf.style for a in doc.blocks.get(tb).attdefs() if a.dxf.style in doc.styles), TEXT_STYLE) if tb else TEXT_STYLE
    _ensure_layer(doc, VIEWPORT_LAYER, None)
    _ensure_layer(doc, sheets_mod.TITLE_LAYER, None)
    _ensure_layer(doc, sheets_mod.LEGEND_LAYER, None)
    names = [ly.dxf.name for ly in doc.layers]
    tvals = payload.get("titleBlock") or {}
    made = []
    for sh in payload.get("sheets") or []:
        sid, title = str(sh.get("id")), str(sh.get("name") or sh.get("id"))
        if title in doc.layouts:
            continue
        layout = doc.layouts.new(title)
        layout.page_setup(size=(pw, ph), margins=(0, 0, 0, 0), units="mm")
        vx0, vy0, vx1, vy1 = vp_box
        uw, uh = vx1 - vx0, vy1 - vy0
        vp = layout.add_viewport(center=((vx0 + vx1) / 2.0, (vy0 + vy1) / 2.0), size=(uw, uh), view_center_point=(cx, cy),
                                 view_height=uh * scale / 1000.0)
        vp.dxf.layer = VIEWPORT_LAYER
        frozen = [n for n in names if isinstance(layer_sheets.get(n), list) and sid not in layer_sheets[n]]
        vp.frozen_layers = frozen
        if tb:
            ref = layout.add_blockref(tb, (0, 0), dxfattribs={"layer": sheets_mod.TITLE_LAYER})
            vals = {**(tvals.get("common") or {}), **((tvals.get("sheets") or {}).get(sid) or {})}
            fitted = sheets_mod.fit_attribs(doc, tb, vals)        # long titles wrap over their lines and stay inside their boxes
            ref.add_auto_attribs({t: v[0] for t, v in fitted.items()})
            for at in ref.attribs:
                _, wf, hh = fitted.get(at.dxf.tag, (None, 1.0, at.dxf.height))
                if abs(wf - 1.0) > 1e-6:
                    at.dxf.width = math.floor(wf * 1000) / 1000.0      # down: never past the box
                if abs(hh - at.dxf.height) > 1e-6:
                    at.dxf.height = math.floor(hh * 1000) / 1000.0
        else:
            layout.add_lwpolyline([(vx0, vy0), (vx1, vy0), (vx1, vy1), (vx0, vy1)], close=True,
                                  dxfattribs={"layer": sheets_mod.TITLE_LAYER})
            lx0, ly0, lx1, ly1 = legend_rect
            layout.add_lwpolyline([(lx0, ly0), (lx1, ly0), (lx1, ly1), (lx0, ly1)], close=True,
                                  dxfattribs={"layer": sheets_mod.TITLE_LAYER})

        def overflow(need, vx0=vx0, vy0=vy0):
            return (vx0 + 2, vy0 + 2, vx0 + 2 + (legend_rect[2] - legend_rect[0]), vy0 + 2 + need)
        try:
            sheets_mod.draw_legend(doc, layout, legend_rect, overflow, sid, payload, layer_sheets, style, scale, factor,
                                   title=bool(tb))
        except Exception as e:  # pragma: no cover - a legend never stops the export
            log.warning("legend for sheet %s left out: %s", sid, e)
        made.append(title)
    if made:
        doc.layers.get(VIEWPORT_LAYER).dxf.plot = 0      # the viewport frames do not plot
        if "Layout1" in doc.layouts and "Layout1" not in made:
            doc.layouts.delete("Layout1")
        doc.layouts.set_active_layout(made[0])


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


def _entity_lineweight(e):
    """Explicit entity line weight: hundredths of a mm (0–211), 'B' (ByBlock) or None (ByLayer / default)."""
    try:
        lw = int(e.dxf.get("lineweight", -1))
    except Exception:
        return None
    if lw == -2:
        return "B"
    return lw if lw >= 0 else None


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
        try:
            lw = int(ly.dxf.get("lineweight", -3))
        except Exception:
            lw = -3
        if lw >= 0:
            out[name]["w"] = lw   # hundredths of a millimetre; absent = the drawing's default
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
    Every record carries l (layer) and optionally k (colour: '#hex' | 'B') and w (line weight in
    hundredths of a mm | 'B' = ByBlock; absent = ByLayer — the layer's w, else the file's `lwDefault`).
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
        w = _entity_lineweight(e)
        if w is not None:
            base["w"] = w
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
        w = _entity_lineweight(e)
        if w is not None:
            rec["w"] = w
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
        "lwDefault": 25,   # AutoCAD's default line weight (0.25 mm); a DXF does not carry the setting
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
        if name == META_BLOCK or (e.dxf.get("layer", "") or "").startswith(BG_PREFIX):
            continue      # the metadata block; a background drawing exported with the plan (not part of it)
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
            if kind == "trench" or (not kind and layer in _IMPORT_LAYERS["trench"]):
                trenches.append({"pts": pts, "meta": meta})
            elif kind == "room" or (not kind and layer in _IMPORT_LAYERS["room"]):
                rooms.append({"pts": pts, "meta": meta})
            elif kind == "measurement" or (not kind and layer in _IMPORT_LAYERS["measurement"]):
                measurements.append({"pts": pts})
            else:
                routes.append({"curved": meta.get("CURVED") == "1", "layer": layer, "pts": pts, "meta": meta})
        elif t == "LINE" and kind == "crossing":
            crossings.append({"p1": to_px(e.dxf.start.x, e.dxf.start.y), "p2": to_px(e.dxf.end.x, e.dxf.end.y), "meta": meta})
        elif t == "TEXT" and (kind == "text" or (not kind and layer in _IMPORT_LAYERS["text"])):
            p = to_px(e.dxf.insert.x, e.dxf.insert.y)
            texts.append({"x": p[0], "y": p[1], "text": e.dxf.text})
        elif t == "TEXT" and (kind == "roomlabel" or (not kind and layer in _IMPORT_LAYERS["room"])):
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
