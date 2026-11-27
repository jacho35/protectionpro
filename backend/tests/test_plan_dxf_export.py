"""Plan DXF export: text (one style, a paper height at a scale, labels along their cable, device names visible), colours (true
colour per layer, ByLayer lines, an entity's own colour only where it differs, dashed cables) and the background drawing (the
original merged exactly, or rebuilt from the parsed copy; only what the plan shows, on BG- layers, placed where the plan has it)."""
import io
import json
import math

import ezdxf
import pytest

from backend.analysis.plan_dxf import build_dxf, parse_dxf, BG_PREFIX, TEXT_STYLE


@pytest.fixture(autouse=True)
def _no_template(tmp_path, monkeypatch):
    """No title-block template unless a test makes one (the repo's own templates/ folder is local only)."""
    monkeypatch.setenv("PP_DXF_TEMPLATES", str(tmp_path / "no-templates"))


def _read(data: bytes):
    return ezdxf.read(io.StringIO(data.decode("utf-8")))


def _payload(**kw):
    p = {"factor": 0.05, "floorName": "", "domain": "retic", "textH": 1.25, "ltscale": 5,
         "layers": [{"name": "RT_SERVICE", "color": "#22c55e"}, {"name": "RT_FIBREBB", "color": "#a855f7", "linetype": "DASHED"},
                    {"name": "EL_PLANT", "color": "#22c55e"}],
         "extraLayers": {"EL_TRENCH": "#787878", "EL_TEXT": "#111827"},
         "blocks": {"PP_kiosk": {"sizeWorld": 24, "prims": [{"k": "r", "x": 8, "y": 8, "w": 24, "h": 24, "s": "col"}]}},
         "elements": [{"block": "PP_kiosk", "type": "kiosk", "x": 100, "y": 100, "rotation": 180, "layer": "EL_PLANT",
                       "color": "#ef4444", "attrs": {"REF": "K1", "TYPE": "kiosk"}}],
         "routes": [{"layer": "RT_SERVICE", "type": "service", "curved": False, "label": "16 mm² 12.00 m",
                     "pts": [[0, 0], [10, 0], [10, 300]], "color": "#22c55e", "linetype": "CONTINUOUS"},
                    {"layer": "RT_FIBREBB", "type": "fibreBB", "curved": False, "label": "", "pts": [[0, 0], [200, 0]],
                     "color": "#123456", "linetype": "DASHED"}],
         "trenches": [{"pts": [[0, 0], [50, 0]], "color": "#787878"}], "rooms": [], "measurements": [],
         "crossings": [{"p1": [0, 0], "p2": [0, 40], "size": "160", "color": "#b91c1c"}],
         "texts": [{"x": 50, "y": 60, "text": "Note A\nline 2", "rel": 2, "color": "#2563eb"}]}
    p.update(kw)
    return p


def test_text_one_style_paper_height_labels_along_their_cable():
    doc = _read(build_dxf(_payload()))
    msp = doc.modelspace()
    assert TEXT_STYLE in doc.styles and doc.styles.get(TEXT_STYLE).dxf.font.lower() == "arial.ttf"
    texts = list(msp.query("TEXT"))
    assert texts and all(t.dxf.style == TEXT_STYLE for t in texts)
    (lab,) = [t for t in texts if t.dxf.layer == "RT_SERVICE_LABELS"]
    assert lab.dxf.height == pytest.approx(1.25)
    assert abs(lab.dxf.rotation) == pytest.approx(90)          # along the longest (vertical) segment, read upright
    note = sorted([t for t in texts if t.dxf.layer == "EL_TEXT"], key=lambda t: -t.dxf.insert.y)
    assert [t.dxf.text for t in note] == ["Note A", "line 2"] and note[0].dxf.height == pytest.approx(2.5)
    assert note[0].rgb == (0x25, 0x63, 0xEB)
    (ref,) = msp.query("INSERT[name=='PP_kiosk']")
    a = [x for x in ref.attribs if x.dxf.tag == "REF"][0]
    assert not a.is_invisible and a.dxf.text == "K1" and a.dxf.height == pytest.approx(1.25)
    assert a.dxf.rotation == pytest.approx(0)                   # upright beside a symbol turned 180°
    assert all(x.is_invisible for x in ref.attribs if x.dxf.tag != "REF")


def test_colours_by_layer_with_own_colour_only_where_different_and_dashed_cables():
    doc = _read(build_dxf(_payload()))
    msp = doc.modelspace()
    assert doc.layers.get("RT_SERVICE").rgb == (0x22, 0xC5, 0x5E)
    assert doc.layers.get("RT_FIBREBB").dxf.linetype == "DASHED"
    svc = [e for e in msp.query("LWPOLYLINE") if e.dxf.layer == "RT_SERVICE"][0]
    assert not svc.dxf.hasattr("true_color") and svc.dxf.color == 256          # same as its layer: ByLayer
    assert svc.dxf.get("linetype", "BYLAYER").upper() == "BYLAYER"
    assert {st.dxf.name for st in doc.styles} <= {"Standard", TEXT_STYLE}     # one text style, no sample styles
    fib = [e for e in msp.query("LWPOLYLINE") if e.dxf.layer == "RT_FIBREBB"][0]
    assert fib.rgb == (0x12, 0x34, 0x56)                                       # its own colour where it differs
    (ref,) = msp.query("INSERT[name=='PP_kiosk']")
    assert ref.rgb == (0xEF, 0x44, 0x44)
    assert all(e.dxf.color == 0 for e in doc.blocks.get("PP_kiosk") if e.dxftype() != "ATTDEF")   # the symbol follows its INSERT
    (x,) = msp.query("LINE")
    assert x.rgb == (0xB9, 0x1C, 0x1C)
    assert doc.header["$LTSCALE"] == pytest.approx(5)


def _foreign():
    d = ezdxf.new("R2010", setup=True)
    d.header["$INSUNITS"] = 6
    d.layers.add("C-WATER", color=5, linetype="DASHED")
    d.layers.add("C-HIDE", color=1)
    m = d.modelspace()
    m.add_line((1000, 2000), (1100, 2000), dxfattribs={"layer": "C-WATER"})
    m.add_text("WATER 110", dxfattribs={"layer": "C-WATER", "height": 2, "style": "OpenSans"}).set_placement((1010, 2005))
    m.add_line((1000, 2100), (1100, 2100), dxfattribs={"layer": "C-HIDE"})
    far = m.add_line((5000, 9000), (5100, 9000), dxfattribs={"layer": "C-WATER"})
    h = m.add_lwpolyline([(1000, 2050), (1050, 2050)], dxfattribs={"layer": "C-WATER"})
    blk = d.blocks.new("VALVE")
    blk.add_circle((0, 0), 1)
    m.add_blockref("VALVE", (1050, 2000), dxfattribs={"layer": "C-WATER"})
    out = io.StringIO(); d.write(out)
    return out.getvalue().encode("utf-8"), h.dxf.handle


def _bg(parsed, **kw):
    # the plan placed it: drawing units are metres, shifted by the parsed copy's origin, rotated 30° and moved (export metres)
    r = math.radians(30)
    b = {"name": "civils", "origin": parsed["origin"], "m": [math.cos(r), -math.sin(r), 500, math.sin(r), math.cos(r), -300],
         "hidden": ["C-HIDE"], "converted": [], "colors": {}}
    b.update(kw)
    return b


@pytest.mark.parametrize("source", ["original", "parsed"])
def test_background_goes_in_where_the_plan_has_it_only_what_it_shows(source):
    raw, conv_handle = _foreign()
    parsed = parse_dxf(raw)
    ox, oy = parsed["origin"]
    area = [[-10 - ox + 1000, -10 - oy + 2000], [200 - ox + 1000, -10 - oy + 2000], [200 - ox + 1000, 200 - oy + 2000], [-10 - ox + 1000, 200 - oy + 2000]]
    store = {7: raw, 8: json.dumps(parsed).encode()}
    bg = _bg(parsed, area=area, converted=[conv_handle], colors={"C-WATER": "#00ff00"}, **({"srcId": 7, "imageId": 8} if source == "original" else {"imageId": 8}))
    notes = []
    doc = _read(build_dxf(_payload(backgrounds=[bg]), load_image=lambda i: store[int(i)], notes=notes))
    assert notes and notes[0].startswith("civils: the original") == (source == "original")
    msp = doc.modelspace()
    (ins,) = [e for e in msp.query("INSERT") if e.dxf.layer.startswith(BG_PREFIX)]
    blk = doc.blocks.get(ins.dxf.name)
    layers = {e.dxf.layer for e in blk}
    assert "BG-C-WATER" in layers and "BG-C-HIDE" not in layers and "C-WATER" not in layers
    assert doc.layers.get("BG-C-WATER").rgb == (0, 255, 0)                     # the colour set on the plan
    lines = [e for e in blk.query("LINE")]
    assert len(lines) == 1                                                      # the hidden layer and the line outside the area left out
    assert not any(e.dxftype() == "LWPOLYLINE" for e in blk)                    # the converted polyline left out
    assert any(e.dxftype() == "TEXT" and "WATER 110" in e.dxf.text for e in blk)
    assert any(e.dxftype() == "INSERT" for e in blk)                            # the valve block came too
    # where it lands: the line's start (1000, 2000) → the plan's placement
    from ezdxf.math import Matrix44
    p = ins.matrix44().transform(lines[0].dxf.start)
    r = math.radians(30); lx, ly = 1000 - ox, 2000 - oy
    assert p.x == pytest.approx(math.cos(r) * lx - math.sin(r) * ly + 500, abs=1e-6)
    assert p.y == pytest.approx(math.sin(r) * lx + math.cos(r) * ly - 300, abs=1e-6)
    if source == "original":
        assert doc.layers.get("BG-C-WATER").dxf.linetype == "DASHED"           # exact: the drawing's own linetype
    # our own re-import ignores the background
    back = parse_dxf(build_dxf(_payload(backgrounds=[bg]), load_image=lambda i: store[int(i)]))
    assert [d["name"] for d in back["devices"]] == ["K1"]


def test_a_background_that_cannot_be_read_is_left_out_with_a_note():
    notes = []
    data = build_dxf(_payload(backgrounds=[{"name": "lost", "imageId": 99, "m": [1, 0, 0, 0, 1, 0]}]),
                     load_image=lambda i: (_ for _ in ()).throw(KeyError(i)), notes=notes)
    assert data and notes and notes[0].startswith("lost: left out")


# ── layout sheets ────────────────────────────────────────────────────────

def _sheeted(**kw):
    base = dict(
        layers=[{"name": "EL_LV", "color": "#22c55e"}, {"name": "EL_FI", "color": "#a855f7", "linetype": "DASHED"}],
        elements=[{"block": "PP_kiosk", "type": "kiosk", "x": 100, "y": 100, "layer": "EL_LV", "attrs": {"REF": "K1"}}],
        routes=[{"layer": "EL_LV", "type": "lv", "label": "95 mm² 10.00 m", "pts": [[0, 0], [100, 0]]},
                {"layer": "EL_FI", "type": "fibreBB", "label": "trunk", "pts": [[0, 0], [0, 100]]}],
        sheets=[{"id": "MV", "name": "MV"}, {"id": "LV", "name": "LV"}, {"id": "FIBRE", "name": "Fibre"}],
        layerSheets={"EL_LV": ["MV", "LV"], "EL_FI": ["FIBRE"], "EL_TRENCH": ["MV", "LV", "SL", "FIBRE"],
                     "EL_DUCTS": ["MV", "LV", "SL", "FIBRE"], "EL_TEXT": "all"},
        layout={"paper": "A1", "margin": 10, "scale": 500, "extents": [0, -10, 20, 0]})
    base.update(kw)
    return _payload(**base)


def _viewport(doc, name):
    (vp,) = [v for v in doc.layouts.get(name).query("VIEWPORT") if v.dxf.id != 1]
    return vp


def test_one_paper_space_layout_per_sheet_each_freezing_the_other_layers():
    doc = _read(build_dxf(_sheeted()))
    assert [l.name for l in doc.layouts if l.name != "Model"] == ["MV", "LV", "Fibre"]     # Layout1 replaced, in the order sent
    mv, fi = _viewport(doc, "MV"), _viewport(doc, "Fibre")
    assert "EL_FI" in mv.frozen_layers and "EL_FI_LABELS" in mv.frozen_layers           # labels follow their cable
    assert "EL_LV" not in mv.frozen_layers and "EL_TEXT" not in mv.frozen_layers
    assert {"EL_LV", "EL_LV_LABELS"} <= set(fi.frozen_layers) and "EL_TRENCH" not in fi.frozen_layers
    assert "PP_META" in mv.frozen_layers                                                 # the hidden data block shows nowhere
    # A1 less 10 mm margins and the legend column (98 mm + 3 mm gap): 720 × 574 mm; 574 mm at 1:500 = 287 m of plan
    assert (mv.dxf.width, mv.dxf.height) == pytest.approx((720, 574))
    assert mv.dxf.view_height == pytest.approx(287)
    assert (mv.dxf.view_center_point.x, mv.dxf.view_center_point.y) == pytest.approx((10, -5))
    assert doc.layers.get("EL_VIEWPORTS").dxf.plot == 0


def test_ducts_sheet_shows_the_road_crossing_ducts_alone():
    doc = _read(build_dxf(_sheeted(
        layers=[{"name": "EL_LV", "color": "#22c55e"}, {"name": "EL_FI", "color": "#a855f7"}, {"name": "EL_DUCTS", "color": "#8a6a00"}],
        sheets=[{"id": "LV", "name": "LV"}, {"id": "FIBRE", "name": "Fibre"}, {"id": "DUCTS", "name": "Ducts"}],
        layerSheets={"EL_LV": ["MV", "LV"], "EL_FI": ["FIBRE"], "EL_DUCTS": ["MV", "LV", "SL", "FIBRE", "DUCTS"], "EL_TEXT": "all"})))
    assert [l.name for l in doc.layouts if l.name != "Model"] == ["LV", "Fibre", "Ducts"]
    du = set(_viewport(doc, "Ducts").frozen_layers)
    assert {"EL_LV", "EL_LV_LABELS", "EL_FI", "EL_FI_LABELS"} <= du                    # no cables
    assert "EL_DUCTS" not in du and "EL_TEXT" not in du                                  # the ducts, and what shows on every sheet


def test_paper_size_and_scale_set_the_viewport():
    doc = _read(build_dxf(_sheeted(layout={"paper": "A3", "scale": 1000, "extents": [0, 0, 1, 1]})))
    vp = _viewport(doc, "LV")
    assert (vp.dxf.width, vp.dxf.height) == pytest.approx((299, 277))
    assert vp.dxf.view_height == pytest.approx(277)


def test_no_sheets_keeps_the_plain_file():
    doc = _read(build_dxf(_payload()))
    assert [l.name for l in doc.layouts if l.name != "Model"] == ["Layout1"]


def test_fixed_layers_round_trip_and_older_pp_names_still_import():
    p = _sheeted(trenches=[{"pts": [[0, 0], [50, 0]]}], measurements=[{"pts": [[0, 0], [9, 9]]}],
                 rooms=[{"label": "Store", "pts": [[0, 0], [40, 0], [40, 40], [0, 40]]}])
    data = build_dxf(p)
    doc = _read(data)
    layers = {e.dxf.layer for e in doc.modelspace()}
    assert {"EL_TRENCH", "EL_DUCTS", "EL_DIM", "EL_ROOMS", "EL_TEXT"} <= layers and not any(l.startswith("PP_") and l != "PP_META" for l in layers)
    r = parse_dxf(data)
    assert (len(r["trenches"]), len(r["crossings"]), len(r["measurements"]), len(r["rooms"]), len(r["texts"])) == (1, 1, 1, 1, 2)
    assert r["rooms"][0].get("label") == "Store"
    # a file from before: the old PP_ layers with no KIND data are read by their layer
    old = ezdxf.new("R2010")
    msp = old.modelspace()
    for name in ("PP_TRENCH", "PP_ROOMS", "PP_DIM", "PP_TEXT"):
        old.layers.add(name)
    mb = old.blocks.new("PP_META")
    mb.add_attdef("FACTOR", dxfattribs={"height": 0.001}).set_placement((0, 0))
    msp.add_blockref("PP_META", (0, 0)).add_auto_attribs({"FACTOR": "0.05"})
    msp.add_lwpolyline([(0, 0), (5, 0)], dxfattribs={"layer": "PP_TRENCH"})
    msp.add_lwpolyline([(0, 0), (5, 0), (5, 5)], close=True, dxfattribs={"layer": "PP_ROOMS"})
    msp.add_lwpolyline([(0, 0), (1, 1)], dxfattribs={"layer": "PP_DIM"})
    msp.add_text("old note", dxfattribs={"layer": "PP_TEXT"}).set_placement((1, 1))
    buf = io.StringIO()
    old.write(buf)
    r = parse_dxf(buf.getvalue().encode("utf-8"))
    assert (len(r["trenches"]), len(r["rooms"]), len(r["measurements"]), len(r["texts"])) == (1, 1, 1, 1)


def test_wifi_signal_contours_are_polylines_with_a_level_label_on_their_own_layer():
    zones = [{"pts": [[0, 0], [100, 0], [100, 100], [0, 100]], "closed": True, "color": "#8dbe4a", "label": "5 GHz -65 dBm"},
             {"pts": [[0, 0], [40, 40]], "closed": False, "color": "#e07b39", "label": "5 GHz -75 dBm"}]
    doc = _read(build_dxf(_payload(wifiZones=zones, extraLayers={"EL_TRENCH": "#787878", "EL_TEXT": "#111827", "EL_WIFI_COVERAGE": "#0e7490"},
                                   fixedLayers={"wifi": "EL_WIFI_COVERAGE"})))
    msp = doc.modelspace()
    polys = [e for e in msp.query("LWPOLYLINE") if e.dxf.layer == "EL_WIFI_COVERAGE"]
    assert len(polys) == 2 and sorted(p.closed for p in polys) == [False, True]
    labels = sorted(t.dxf.text for t in msp.query("TEXT") if t.dxf.layer == "EL_WIFI_COVERAGE")
    assert labels == ["5 GHz -65 dBm", "5 GHz -75 dBm"]
    assert "EL_WIFI_COVERAGE" in doc.layers
    # a plan without WiFi has neither the layer's entities nor a changed output
    plain = _read(build_dxf(_payload()))
    assert not [e for e in plain.modelspace() if e.dxf.layer == "EL_WIFI_COVERAGE"]


def test_cctv_dori_zones_are_polylines_with_a_level_label_on_their_own_layer():
    zones = [{"pts": [[0, 0], [100, 0], [100, 100], [0, 100]], "closed": True, "color": "#3e8bd0", "label": "Recognise 125 px/m"},
             {"pts": [[0, 0], [40, 40]], "closed": False, "color": "#8cb9e3", "label": "Observe 62 px/m"}]
    doc = _read(build_dxf(_payload(cctvZones=zones, extraLayers={"EL_TRENCH": "#787878", "EL_TEXT": "#111827", "EL_CCTV_COVERAGE": "#7c3aed"},
                                   fixedLayers={"cctv": "EL_CCTV_COVERAGE"})))
    msp = doc.modelspace()
    polys = [e for e in msp.query("LWPOLYLINE") if e.dxf.layer == "EL_CCTV_COVERAGE"]
    assert len(polys) == 2 and sorted(p.closed for p in polys) == [False, True]
    labels = sorted(t.dxf.text for t in msp.query("TEXT") if t.dxf.layer == "EL_CCTV_COVERAGE")
    assert labels == ["Observe 62 px/m", "Recognise 125 px/m"]
    assert "EL_CCTV_COVERAGE" in doc.layers
    # a plan without CCTV has neither the layer's entities nor a changed output
    plain = _read(build_dxf(_payload()))
    assert not [e for e in plain.modelspace() if e.dxf.layer == "EL_CCTV_COVERAGE"]
