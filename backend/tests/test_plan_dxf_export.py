"""Plan DXF export: text (one style, a paper height at a scale, labels along their cable, device names visible), colours (true
colour per layer, ByLayer lines, an entity's own colour only where it differs, dashed cables) and the background drawing (the
original merged exactly, or rebuilt from the parsed copy; only what the plan shows, on BG- layers, placed where the plan has it)."""
import io
import json
import math

import ezdxf
import pytest

from backend.analysis.plan_dxf import build_dxf, parse_dxf, BG_PREFIX, TEXT_STYLE


def _read(data: bytes):
    return ezdxf.read(io.StringIO(data.decode("utf-8")))


def _payload(**kw):
    p = {"factor": 0.05, "floorName": "", "domain": "retic", "textH": 1.25, "ltscale": 5,
         "layers": [{"name": "RT_SERVICE", "color": "#22c55e"}, {"name": "RT_FIBREBB", "color": "#a855f7", "linetype": "DASHED"},
                    {"name": "EL_PLANT", "color": "#22c55e"}],
         "extraLayers": {"PP_TRENCH": "#787878", "PP_TEXT": "#111827"},
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
    (lab,) = [t for t in texts if t.dxf.layer == "PP_LABELS"]
    assert lab.dxf.height == pytest.approx(1.25)
    assert abs(lab.dxf.rotation) == pytest.approx(90)          # along the longest (vertical) segment, read upright
    note = sorted([t for t in texts if t.dxf.layer == "PP_TEXT"], key=lambda t: -t.dxf.insert.y)
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
