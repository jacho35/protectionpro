"""Plan DXF import — structured underlay (blocks + attributes, every curve type,
layers, units) and the Plan Markup round-trip for both plan domains.

Fixtures are built in-test with ezdxf so each case pins exactly one feature.
"""
import io
import math
import random
import re

import ezdxf
import pytest

from backend.analysis.plan_dxf import _read_doc, build_dxf, parse_dxf


def _bytes(doc):
    s = io.StringIO()
    doc.write(s)
    return s.getvalue().encode("utf-8")


def _foreign(units=4):
    doc = ezdxf.new("R2010", setup=True)
    doc.header["$INSUNITS"] = units
    return doc


def _poly_pts(rec):
    p = rec["p"]
    return [(p[i], p[i + 1]) for i in range(0, len(p), 2)]


# ── Units + origin ──────────────────────────────────────────────────────
def test_units_and_origin_shift_keep_survey_coordinates_precise():
    doc = _foreign(units=6)
    msp = doc.modelspace()
    msp.add_line((50000.0, 3000000.0), (50100.0, 3000040.0))
    r = parse_dxf(_bytes(doc))
    assert r["mode"] == "underlay" and r["format"] == 2
    assert r["units"]["m"] == 1.0 and r["units"]["name"] == "m"
    assert r["origin"] == [50000.0, 3000000.0]
    (ln,) = r["entities"]
    assert ln["t"] == "l" and ln["p"] == [0.0, 0.0, 100.0, 40.0]
    assert r["bbox"] == [0.0, 0.0, 100.0, 40.0]


def test_crlf_line_endings_are_read():
    doc = _foreign()
    doc.modelspace().add_line((0, 0), (10, 0))
    raw = _bytes(doc).replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
    assert len(parse_dxf(raw)["entities"]) == 1


def test_non_utf8_codepage_text_is_read():
    doc = ezdxf.new("R2000")
    doc.header["$DWGCODEPAGE"] = "ANSI_1252"
    doc.modelspace().add_text("Kombuis – Ø25")
    s = io.StringIO()
    doc.write(s)
    raw = s.getvalue().encode("cp1252")
    (t,) = parse_dxf(raw)["entities"]
    assert t["s"] == "Kombuis – Ø25"


def test_unitless_file_reports_no_metres_per_unit():
    doc = _foreign(units=0)
    doc.modelspace().add_line((0, 0), (10, 0))
    assert parse_dxf(_bytes(doc))["units"]["m"] is None


def test_mm_units():
    doc = _foreign(units=4)
    doc.modelspace().add_line((0, 0), (1000, 0))
    assert parse_dxf(_bytes(doc))["units"]["m"] == 0.001


# ── Curves ──────────────────────────────────────────────────────────────
def test_bulged_polyline_is_flattened_through_its_arc():
    doc = _foreign()
    # Semicircle of radius 1000 from (0,0) to (2000,0): bulge = tan(180°/4) = 1
    doc.modelspace().add_lwpolyline([(0, 0, 1.0), (2000, 0, 0)], format="xyb")
    (rec,) = parse_dxf(_bytes(doc))["entities"]
    pts = _poly_pts(rec)
    assert len(pts) > 10, "arc segment must not collapse to a straight chord"
    # every flattened vertex lies on the circle about the chord midpoint
    radii = [math.hypot(x - 1000.0, y - pts[0][1]) for x, y in pts]
    assert max(radii) == pytest.approx(1000, abs=1.0)
    assert min(radii) == pytest.approx(1000, abs=1.0)


def _with_stale_extents(doc, lo, hi):
    # ezdxf's own writer always emits the "unset" sentinel (±1e20) for
    # $EXTMIN/$EXTMAX unless something explicitly recomputes them, so a
    # doc.header assignment doesn't survive doc.write(). Real CAD software
    # (AutoCAD, Civil3D, BricsCAD, …) *does* write a real — often stale —
    # header value, so patch the serialized text directly to reproduce that.
    raw = _bytes(doc).decode("utf-8")

    def patch(text, var, pt):
        pat = re.compile(r"(\$" + var + r"\s*\n\s*10\n)[^\n]*\n(\s*20\n)[^\n]*\n(\s*30\n)[^\n]*")
        return pat.sub(lambda m: f"{m.group(1)}{pt[0]}\n{m.group(2)}{pt[1]}\n{m.group(3)}{pt[2]}", text, count=1)

    raw = patch(raw, "EXTMIN", lo)
    raw = patch(raw, "EXTMAX", hi)
    return raw.encode("utf-8")


def test_stale_bloated_extents_header_does_not_collapse_small_geometry():
    # A real CAD export can leave $EXTMIN/$EXTMAX stale after a purged xref or
    # a ZOOM EXTENTS that was never re-run — claiming a multi-kilometre span
    # while the actual drawing is a normal-sized site plan. The flattening
    # tolerance must come from the real geometry, not that stale header, or
    # curves round away to nothing on import (a "successful" import that
    # renders as a blank canvas).
    doc = _foreign()
    # Semicircle of radius 1000 from (0,0) to (2000,0): bulge = tan(180°/4) = 1
    doc.modelspace().add_lwpolyline([(0, 0, 1.0), (2000, 0, 0)], format="xyb")
    raw = _with_stale_extents(doc, (0.0, 0.0, 0.0), (3_000_000.0, 3_000_000.0, 0.0))
    (rec,) = parse_dxf(raw)["entities"]
    pts = _poly_pts(rec)
    assert len(pts) > 10, "arc segment must not collapse under a stale-header tolerance"


def test_isolated_far_off_entity_does_not_blow_out_the_bbox():
    # A real-world pattern: a dense site plan plus one record dumped kilometres
    # away (an unresolved XREF insertion point, a schedule/legend table left
    # off in space). Naive min/max makes $bbox$ (and the initial zoom-to-fit
    # it drives) span that whole distance, so the actual drawing renders as an
    # imperceptible speck — a "successful" import that looks blank.
    doc = _foreign()
    msp = doc.modelspace()
    random.seed(0)
    for _ in range(30):
        x, y = random.uniform(0, 1000), random.uniform(0, 1000)
        msp.add_line((x, y), (x + 10, y + 10))
    msp.add_line((5_000_000, 500), (5_000_010, 510))   # the isolated outlier
    r = parse_dxf(_bytes(doc))
    assert len(r["entities"]) == 31, "the outlier is still parsed and rendered, just not fit to"
    bx0, by0, bx1, by1 = r["bbox"]
    assert (bx1 - bx0) < 2000 and (by1 - by0) < 2000, "bbox should track the dense cluster, not the outlier"
    xs = [c for e in r["entities"] for c in (e["p"][0], e["p"][2])]
    assert max(xs) > 4_000_000, "the outlier's own coordinates are untouched"


def test_dense_cluster_keeps_small_local_coordinates_despite_a_distant_minority():
    # The bbox/fit fix above isn't enough on its own: a corner-anchored origin
    # still leaves the DENSE cluster's own local coordinates in the millions
    # whenever a smaller, more extreme minority sits at one edge — and a
    # canvas's transform pipeline (commonly single-precision internally) can
    # silently fail to paint geometry at that magnitude even though it parses
    # and the view is aimed at the right place. The origin must anchor to the
    # dense cluster (median), not to whichever corner is numerically lowest.
    doc = _foreign()
    msp = doc.modelspace()
    random.seed(1)
    for _ in range(200):   # the dense cluster: most of the drawing
        x, y = random.uniform(2_000_000, 2_001_000), random.uniform(0, 1000)
        msp.add_line((x, y), (x + 1, y))
    for _ in range(20):    # a smaller, separate cluster far to one side
        x, y = random.uniform(0, 1000), random.uniform(0, 1000)
        msp.add_line((x, y), (x + 1, y))
    r = parse_dxf(_bytes(doc))
    xs = [c for e in r["entities"] for c in (e["p"][0], e["p"][2])]
    xs.sort()
    median_local_x = xs[len(xs) // 2]
    assert abs(median_local_x) < 2000, "the dense cluster (median) must land near local zero"


def test_small_file_is_never_trimmed():
    # Below the robust-trim threshold, behaviour must be byte-identical to
    # plain min/max — most real drawings (and every other fixture in this
    # file) have far fewer than 20 points.
    doc = _foreign()
    doc.modelspace().add_line((0, 0), (10, 0))
    doc.modelspace().add_line((0, 0), (5_000_000, 5_000_000))
    r = parse_dxf(_bytes(doc))
    assert r["bbox"][2] == pytest.approx(5_000_000) and r["bbox"][3] == pytest.approx(5_000_000)


def test_spline_keeps_fit_points_and_flattened_shape():
    doc = _foreign()
    fit = [(0, 0), (1000, 800), (2000, 0), (3000, 800)]
    doc.modelspace().add_spline(fit_points=[(x, y, 0) for x, y in fit])
    r = parse_dxf(_bytes(doc))
    (rec,) = r["entities"]
    assert rec["g"] == "SPLINE" and len(_poly_pts(rec)) > len(fit)
    f, (ox, oy) = rec["f"], r["origin"]   # the curve dips below y=0 → origin shifts
    got = [(f[i] + ox, f[i + 1] + oy) for i in range(0, len(f), 2)]
    assert got == [pytest.approx((float(x), float(y)), abs=0.01) for x, y in fit]   # rounded to tol/10


def test_ellipse_hatch_solid_point_are_all_read():
    doc = _foreign()
    msp = doc.modelspace()
    msp.add_ellipse((0, 0), major_axis=(500, 0), ratio=0.5)
    h = msp.add_hatch()
    h.paths.add_polyline_path([(0, 0), (100, 0), (100, 100), (0, 100)], is_closed=True)
    msp.add_solid([(200, 0), (300, 0), (200, 100), (300, 100)])
    msp.add_point((400, 400))
    r = parse_dxf(_bytes(doc))
    kinds = sorted((e["t"], e.get("g", "")) for e in r["entities"])
    assert ("p", "ELLIPSE") in kinds and ("p", "HATCH") in kinds and ("p", "SOLID") in kinds and ("o", "") in kinds
    assert not r["skipped"]


def test_true_circle_and_arc_kept_as_primitives():
    doc = _foreign()
    msp = doc.modelspace()
    msp.add_circle((100, 100), 50)
    msp.add_arc((300, 100), 40, 0, 90)
    r = parse_dxf(_bytes(doc))
    c = next(e for e in r["entities"] if e["t"] == "c")
    a = next(e for e in r["entities"] if e["t"] == "a")
    assert c["p"][2] == 50 and a["p"][3:] == [0, 90]


def test_mirrored_arc_via_negative_extrusion_is_resolved_in_wcs():
    doc = _foreign()
    doc.modelspace().add_arc((100, 0), 10, 0, 90, dxfattribs={"extrusion": (0, 0, -1)})
    (rec,) = parse_dxf(_bytes(doc))["entities"]
    # OCS centre (100,0) with -Z extrusion is WCS (-100,0): flattened, so the
    # arc points sit on radius 10 about the WCS centre.
    pts = _poly_pts(rec)
    xs = [x for x, _ in pts]
    # origin shifted to min — the arc spans 10 units in x
    assert max(xs) - min(xs) == pytest.approx(10, abs=0.05)


def test_font_warning_is_silenced_but_other_ezdxf_warnings_are_not(caplog):
    import logging
    doc = _foreign()
    doc.modelspace().add_mtext("A\\PB", dxfattribs={"char_height": 100})
    dim = doc.modelspace().add_linear_dim(base=(0, 500), p1=(0, 0), p2=(3000, 0))
    dim.render()
    with caplog.at_level(logging.WARNING, logger="ezdxf"):
        parse_dxf(_bytes(doc))
        logging.getLogger("ezdxf").warning("something else")
    msgs = [r.getMessage() for r in caplog.records]
    assert not any(m.startswith("no default font found") for m in msgs)
    assert "something else" in msgs


def test_dimension_and_text_rotation():
    doc = _foreign()
    msp = doc.modelspace()
    t = msp.add_text("ERF 123", dxfattribs={"height": 250, "rotation": 30})
    t.set_placement((1000, 1000))
    dim = msp.add_linear_dim(base=(0, 500), p1=(0, 0), p2=(3000, 0))
    dim.render()
    r = parse_dxf(_bytes(doc))
    txt = [e for e in r["entities"] if e["t"] == "x"]
    assert any(e["s"] == "ERF 123" and e["r"] == 30 and e["h"] == 250 for e in txt)
    # dimension rendered through its virtual entities (lines + measurement text)
    assert sum(1 for e in r["entities"] if e["t"] == "l") >= 2
    assert any(e["s"].startswith("3000") for e in txt)


# ── Blocks + attributes ─────────────────────────────────────────────────
def _light_block(doc, name="LUM_600"):
    blk = doc.blocks.new(name, base_point=(0, 0))
    blk.add_lwpolyline([(-300, -300), (300, -300), (300, 300), (-300, 300)], close=True)
    blk.add_circle((0, 0), 100, dxfattribs={"layer": "LIGHT_DETAIL"})
    blk.add_attdef("CCT", (0, -400), dxfattribs={"height": 100})
    blk.add_attdef("LOAD", (0, -550), dxfattribs={"height": 100, "flags": 1})  # invisible
    return blk


def test_blocks_are_kept_with_their_attributes():
    doc = _foreign()
    doc.layers.add("LIGHTS", color=2)
    doc.layers.add("LIGHT_DETAIL", color=3)
    _light_block(doc)
    msp = doc.modelspace()
    for i in range(3):
        ref = msp.add_blockref("LUM_600", (i * 2000, 0), dxfattribs={"layer": "LIGHTS", "rotation": 90})
        ref.add_auto_attribs({"CCT": f"L{i + 1}", "LOAD": "36"})
    r = parse_dxf(_bytes(doc))
    assert len(r["inserts"]) == 3 and not r["entities"]
    ins = r["inserts"][1]
    assert ins["b"] == "LUM_600" and ins["l"] == "LIGHTS" and ins["r"] == 90
    assert ins["a"] == {"CCT": "L2", "LOAD": "36"}
    # visible attribute (CCT) is drawn, invisible one (LOAD) is not
    assert [t["s"] for t in ins["at"]] == ["L2"]
    blk = r["blocks"]["LUM_600"]
    assert blk["tags"] == ["CCT", "LOAD"]
    kinds = sorted(e["t"] for e in blk["e"])
    assert kinds == ["c", "p"]   # attdefs are templates, not geometry
    assert any(e["l"] == "LIGHT_DETAIL" for e in blk["e"])
    assert blk["bb"] == [-300.0, -300.0, 300.0, 300.0]
    layers = {ly["name"]: ly for ly in r["layers"]}
    assert layers["LIGHTS"]["n"] == 3 and layers["LIGHTS"]["color"] == "#ffff00"


def test_nested_blocks_resolve_recursively():
    doc = _foreign()
    _light_block(doc)
    grp = doc.blocks.new("LUM_PAIR")
    grp.add_blockref("LUM_600", (0, 0))
    grp.add_blockref("LUM_600", (1000, 0), dxfattribs={"xscale": 2})
    doc.modelspace().add_blockref("LUM_PAIR", (5000, 5000))
    r = parse_dxf(_bytes(doc))
    assert "LUM_600" in r["blocks"]
    nested = [e for e in r["blocks"]["LUM_PAIR"]["e"] if e["t"] == "i"]
    assert len(nested) == 2 and nested[1]["sx"] == 2
    assert r["bbox"][2] == pytest.approx(1900, abs=1e-6)   # -300 … 1000+2·300


def test_minsert_array_expands_to_one_record_per_cell():
    doc = _foreign()
    _light_block(doc)
    ref = doc.modelspace().add_blockref("LUM_600", (0, 0))
    ref.dxf.column_count = 3
    ref.dxf.row_count = 2
    ref.dxf.column_spacing = 1200
    ref.dxf.row_spacing = 1200
    r = parse_dxf(_bytes(doc))
    assert len(r["inserts"]) == 6
    assert len({i["h"] for i in r["inserts"]}) == 6


def test_mirrored_insert_negative_extrusion():
    doc = _foreign()
    _light_block(doc)
    doc.modelspace().add_blockref("LUM_600", (1000, 0), dxfattribs={"extrusion": (0, 0, -1), "rotation": 30})
    doc.modelspace().add_line((-5000, 0), (-5000, 1))   # anchor the origin
    r = parse_dxf(_bytes(doc))
    (ins,) = r["inserts"]
    ox = r["origin"][0]
    assert ins["p"][0] + ox == pytest.approx(-1000)
    assert ins["r"] == pytest.approx(-30) and ins["sx"] == pytest.approx(-1)


def test_hidden_layers_are_reported_not_dropped():
    doc = _foreign()
    doc.layers.add("FURNITURE").off()
    doc.layers.add("FROZEN").freeze()
    msp = doc.modelspace()
    msp.add_line((0, 0), (1, 1), dxfattribs={"layer": "FURNITURE"})
    msp.add_line((0, 0), (2, 1), dxfattribs={"layer": "FROZEN"})
    r = parse_dxf(_bytes(doc))
    layers = {ly["name"]: ly for ly in r["layers"]}
    assert layers["FURNITURE"]["on"] is False and layers["FROZEN"]["frozen"] is True
    assert len(r["entities"]) == 2


def test_entity_colour_bylayer_byblock_and_explicit():
    doc = _foreign()
    msp = doc.modelspace()
    msp.add_line((0, 0), (1, 0))
    msp.add_line((0, 0), (1, 0), dxfattribs={"color": 1})
    ln = msp.add_line((0, 0), (1, 0))
    ln.rgb = (16, 32, 48)
    blk = doc.blocks.new("B")
    blk.add_line((0, 0), (1, 0), dxfattribs={"color": 0})
    msp.add_blockref("B", (0, 0))
    r = parse_dxf(_bytes(doc))
    assert [e.get("k") for e in r["entities"]] == [None, "#ff0000", "#102030"]
    assert r["blocks"]["B"]["e"][0]["k"] == "B"


# ── Round-trip (our own export) for both domains ────────────────────────
def _payload(domain):
    if domain == "retic":
        blocks = {"PP_kiosk": {"sizeWorld": 24, "prims": [{"k": "r", "x": 8, "y": 8, "w": 24, "h": 24, "s": "col"}]},
                  "PP_erf": {"sizeWorld": 24, "prims": [{"k": "c", "cx": 20, "cy": 20, "r": 8, "s": "col"}]}}
        elements = [
            {"block": "PP_kiosk", "type": "kiosk", "x": 100, "y": 50, "rotation": 90, "layer": "EL_PLANT",
             "attrs": {"REF": "K1", "TYPE": "kiosk"}},
            {"block": "PP_erf", "type": "erf", "x": 300, "y": 50, "rotation": 0, "layer": "EL_CONSUMERS",
             "attrs": {"REF": "1234", "TYPE": "erf"}},
        ]
        routes = [{"layer": "RT_SERVICE", "type": "service", "curved": True, "cable": "16mm² 2c Al",
                   "fromName": "K1", "toName": "1234", "label": "x", "pts": [[100, 50], [200, 80], [300, 50]]}]
        trenches = [{"pts": [[100, 60], [300, 60]], "excType": "road", "name": "T1"}]
        crossings = [{"p1": [150, 40], "p2": [150, 90], "size": "160", "name": "X1"}]
        rooms = []
    else:
        blocks = {"PP_bd_db": {"sizeWorld": 24, "prims": [{"k": "r", "x": 8, "y": 8, "w": 24, "h": 24, "s": "col"}]}}
        elements = [{"block": "PP_bd_db", "type": "bd_db", "x": 10, "y": 10, "rotation": 0, "layer": "EL_POWER",
                     "attrs": {"REF": "DB1", "TYPE": "bd_db"}}]
        routes = [{"layer": "RT_CIRCUIT", "type": "circuit", "curved": False, "cable": "2.5mm² T+E",
                   "label": "x", "pts": [[10, 10], [50, 10]]}]
        trenches, crossings = [], []
        rooms = [{"label": "Kitchen", "pts": [[0, 0], [100, 0], [100, 100], [0, 100]]}]
    return {"factor": 0.05, "floorName": "Ground", "domain": domain, "layers": [], "blocks": blocks,
            "elements": elements, "routes": routes, "trenches": trenches, "rooms": rooms,
            "measurements": [], "crossings": crossings, "texts": []}


def test_roundtrip_site_plan_keeps_retic_devices_and_route_attributes():
    r = parse_dxf(build_dxf(_payload("retic")))
    assert r["mode"] == "roundtrip" and r["domain"] == "retic"
    types = sorted(d["type"] for d in r["devices"])
    assert types == ["erf", "kiosk"]
    k = next(d for d in r["devices"] if d["type"] == "kiosk")
    assert k["name"] == "K1" and k["x"] == pytest.approx(100) and k["rotation"] == pytest.approx(90)
    (rt,) = r["routes"]
    assert rt["curved"] and rt["meta"]["TYPE"] == "service" and rt["meta"]["CABLE"] == "16mm² 2c Al"
    assert rt["meta"]["FROM"] == "K1" and rt["meta"]["TO"] == "1234"
    (tr,) = r["trenches"]
    assert tr["meta"]["EXC"] == "road"
    (cx,) = r["crossings"]
    assert cx["meta"]["SIZE"] == "160" and cx["p1"] == pytest.approx([150, 40])


def test_roundtrip_floor_plan_domain_rooms_and_units():
    raw = build_dxf(_payload("building"))
    doc = _read_doc(raw)
    assert doc.header["$INSUNITS"] == 6
    r = parse_dxf(raw)
    assert r["domain"] == "building"
    (rt,) = r["routes"]
    assert not rt["curved"] and rt["meta"]["CABLE"] == "2.5mm² T+E"
    (rm,) = r["rooms"]
    assert rm["label"] == "Kitchen"


def test_legacy_roundtrip_without_domain_infers_it():
    p = _payload("building")
    p.pop("domain")
    r = parse_dxf(build_dxf(p))
    assert r["domain"] == "building"


def test_roundtrip_lisp_named_block_carries_extra_field_tags_and_variant():
    """A Building element with a LISP block-name counterpart (dxfBlock, e.g.
    bd_light -> LUMINAIRE) sends per-field tags (WATTS/LUMENS/...) and a
    PP_VARIANT tag beyond the core set — the backend must build ATTDEFs for
    exactly the block's own `attrTags` list and read them all back."""
    blocks = {"LUMINAIRE": {"sizeWorld": 24, "attrTags": ["REF", "TYPE", "DBFED", "CIRCUIT", "PHASE",
                                                            "LOAD_VA", "CABLE", "WATTS", "LUMENS", "PP_VARIANT"],
                             "prims": [{"k": "c", "cx": 20, "cy": 20, "r": 8, "s": "col"}]}}
    elements = [{"block": "LUMINAIRE", "type": "bd_light", "x": 10, "y": 10, "rotation": 0, "layer": "E-LIGHTING",
                 "attrs": {"REF": "L1", "TYPE": "bd_light", "WATTS": "36", "LUMENS": "3200", "PP_VARIANT": "downlight"}}]
    payload = {"factor": 0.05, "floorName": "Ground", "domain": "building", "layers": [], "blocks": blocks,
               "elements": elements, "routes": [], "trenches": [], "rooms": [], "measurements": [], "crossings": [], "texts": []}
    r = parse_dxf(build_dxf(payload))
    (d,) = r["devices"]
    assert d["type"] == "bd_light" and d["name"] == "L1" and d["block"] == "LUMINAIRE"
    assert d["attrs"]["WATTS"] == "36" and d["attrs"]["LUMENS"] == "3200" and d["attrs"]["PP_VARIANT"] == "downlight"


def test_roundtrip_accepts_lisp_block_names_without_pp_prefix():
    """Device recognition no longer gates on a 'PP_' block-name prefix — a
    LISP-named block (no prefix at all) must still round-trip as a device."""
    blocks = {"DB": {"sizeWorld": 24, "prims": [{"k": "r", "x": 8, "y": 8, "w": 24, "h": 24, "s": "col"}]}}
    elements = [{"block": "DB", "type": "bd_db", "x": 10, "y": 10, "rotation": 0, "layer": "E-DB",
                 "attrs": {"REF": "DB2", "TYPE": "bd_db"}}]
    payload = {"factor": 0.05, "floorName": "Ground", "domain": "building", "layers": [], "blocks": blocks,
               "elements": elements, "routes": [], "trenches": [], "rooms": [], "measurements": [], "crossings": [], "texts": []}
    r = parse_dxf(build_dxf(payload))
    (d,) = r["devices"]
    assert d["type"] == "bd_db" and d["name"] == "DB2" and d["block"] == "DB"


def test_legacy_name_attribute_still_read_as_device_name():
    """Backward compatibility: a file exported before the REF rename (a
    NAME-only ATTDEF, no REF) still resolves its device name on re-import —
    hand-built at the ezdxf level since build_dxf() only ever writes REF now."""
    import backend.analysis.plan_dxf as pdx
    doc = ezdxf.new("R2000", setup=True)
    msp = doc.modelspace()
    blk = doc.blocks.new("PP_bd_db")
    blk.add_attdef("NAME", dxfattribs={"height": 0.1})
    blk.add_attdef("TYPE", dxfattribs={"height": 0.1})
    ref = msp.add_blockref("PP_bd_db", (0, 0))
    ref.add_auto_attribs({"NAME": "DB1", "TYPE": "bd_db"})
    mb = doc.blocks.new(pdx.META_BLOCK)
    mb.add_attdef("FACTOR", dxfattribs={"height": 0.001})
    mb.add_attdef("FLOOR", dxfattribs={"height": 0.001})
    mb.add_attdef("DOMAIN", dxfattribs={"height": 0.001})
    mref = msp.add_blockref(pdx.META_BLOCK, (0, 0))
    mref.add_auto_attribs({"FACTOR": "0.05", "FLOOR": "Ground", "DOMAIN": "building"})
    r = parse_dxf(_bytes(doc))
    assert r["mode"] == "roundtrip"
    (d,) = r["devices"]
    assert d["name"] == "DB1" and d["type"] == "bd_db"


def test_export_is_audit_clean():
    doc = _read_doc(build_dxf(_payload("retic")))
    aud = doc.audit()
    assert not aud.has_errors


def test_endpoint_round_trips_through_http(client=None):
    from fastapi.testclient import TestClient
    from backend.main import app
    from backend.routes import plan_dxf as route_mod
    # Exercise the router directly (auth is gated at app level).
    from fastapi import FastAPI
    mini = FastAPI()
    mini.include_router(route_mod.router, prefix="/api")
    c = TestClient(mini)
    doc = _foreign()
    _light_block(doc)
    doc.modelspace().add_blockref("LUM_600", (0, 0)).add_auto_attribs({"CCT": "L1"})
    resp = c.post("/api/plan/dxf-import", files={"file": ("a.dxf", _bytes(doc), "application/dxf")})
    assert resp.status_code == 200
    j = resp.json()
    assert j["inserts"][0]["a"]["CCT"] == "L1"
