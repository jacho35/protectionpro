"""Plan DXF layout sheets: the title block from a company template (filled in, viewport inside its frame, legend in its
panel), the legend per sheet, cable labels as leaders placed clear of the drawing, and line weights as the plan draws them."""
import io

import ezdxf
import pytest

from backend.analysis.plan_dxf import build_dxf, parse_dxf
from backend.analysis import plan_dxf_sheets as S


def _read(data: bytes):
    return ezdxf.read(io.StringIO(data.decode("utf-8")))


@pytest.fixture
def template(tmp_path, monkeypatch):
    """A3 title block like a company's: frame 5..415 × 5..292, title panel from x 335, its free column 200..286."""
    d = ezdxf.new("R2010")
    d.styles.add("CO-NARROW", font="arialn.ttf")
    b = d.blocks.new("CO-TB-A3")
    b.add_lwpolyline([(5, 5), (415, 5), (415, 292), (5, 292)], close=True)
    b.add_line((335, 5), (335, 292))
    for y in (30, 60, 120, 200, 286):
        b.add_line((335, y), (415, y))
    for tag, y in (("DRAWING_NO", 10), ("PROJECT_NAME", 40), ("DRAWING_TITLE1", 50), ("SHEET", 20), ("PANEL_TITLE", 288)):
        b.add_attdef(tag, (337, y), dxfattribs={"height": 2.5, "style": "CO-NARROW"}).dxf.text = "default"
    folder = tmp_path / "tpl"
    folder.mkdir()
    d.saveas(folder / "company.dxf")
    monkeypatch.setenv("PP_DXF_TEMPLATES", str(folder))
    return folder


@pytest.fixture
def no_template(tmp_path, monkeypatch):
    monkeypatch.setenv("PP_DXF_TEMPLATES", str(tmp_path / "none"))


def _payload(**kw):
    sq = [{"k": "r", "x": 8, "y": 8, "w": 24, "h": 24}]
    routes = [{"layer": "EL_LV", "labelLayer": "EL_LV_LABELS", "type": "lv", "pts": [[0, 200], [800, 200]], "color": "#3b82f6",
               "lw": 35, "labelLines": ["XLPE Al 4c 95 mm²", "40.0 m"]},
              {"layer": "EL_FI", "labelLayer": "EL_FI_LABELS", "type": "fibreBB", "pts": [[0, 400], [800, 400]], "color": "#a855f7",
               "lw": 25, "labelLines": ["Fibre duct", "40.0 m"]}]
    for x in range(50, 800, 70):                       # services of the common cable: no label of their own
        routes.append({"layer": "EL_LV", "type": "service", "pts": [[x, 200], [x, 170]], "color": "#22c55e", "lw": 25})
    p = {"factor": 0.05, "textH": 1.25, "scale": 500, "ltscale": 5,
         "layers": [{"name": "EL_LV", "color": "#3b82f6"}, {"name": "EL_FI", "color": "#a855f7"}],
         "blocks": {"PP_kiosk": {"sizeWorld": 24, "prims": sq}},
         "elements": [{"block": "PP_kiosk", "type": "kiosk", "x": 300, "y": 200, "layer": "EL_LV", "attrs": {"REF": "K1"}}],
         "routes": routes, "trenches": [{"pts": [[0, 205], [800, 205]], "color": "#2563eb", "alpha": 0.38, "widthM": 0.5}],
         "crossings": [{"p1": [500, 190], "p2": [500, 260], "size": "110", "color": "#f97316", "lw": 50}],
         "labels": {"style": "circle"},
         "layerSheets": {"EL_LV": ["LV"], "EL_FI": ["FIBRE"], "EL_TRENCH": ["LV", "FIBRE"], "EL_DUCTS": ["LV", "FIBRE"]},
         "sheets": [{"id": "LV", "name": "LV"}, {"id": "FIBRE", "name": "Fibre"}],
         "layout": {"paper": "A3", "scale": 500, "extents": [0, -20, 40, -10]},
         "titleBlock": {"common": {"PROJECT_NAME": "TEST PROJECT", "PANEL_TITLE": "LEGEND"},
                        "sheets": {"LV": {"DRAWING_NO": "E1-EL-01", "SHEET": "1 of 2", "DRAWING_TITLE1": "LV RETICULATION"},
                                   "FIBRE": {"DRAWING_NO": "E1-EL-02", "SHEET": "2 of 2", "DRAWING_TITLE1": "FIBRE NETWORK"}}},
         "legend": {"lengths": True, "entries": [
             {"group": "equipment", "kind": "symbol", "block": "PP_kiosk", "layer": "EL_LV", "label": "Kiosk"},
             {"group": "cables", "kind": "line", "layer": "EL_LV", "label": "LV cable", "lw": 35, "items": [{"text": "XLPE Al 4c 95 mm²", "lenM": 40}]},
             {"group": "cables", "kind": "line", "layer": "EL_FI", "label": "Fibre backbone", "lw": 25},
             {"group": "ducts", "kind": "band", "layer": "EL_TRENCH", "label": "LV/SL trench", "alpha": 0.38}],
             "notes": [{"layer": "EL_LV", "text": "Service cables: PVC Cu 2c 16 mm² unless noted otherwise."}, {"text": "General note."}]}}
    p.update(kw)
    return p


def _legend_texts(doc, layout):
    return [e.dxf.text for e in doc.layouts.get(layout) if e.dxftype() == "TEXT" and e.dxf.layer == S.LEGEND_LAYER]


def test_title_block_from_the_template_filled_in_per_sheet(template):
    doc = _read(build_dxf(_payload()))
    lv = doc.layouts.get("LV")
    (ref,) = [e for e in lv if e.dxftype() == "INSERT" and e.dxf.name == "CO-TB-A3"]
    att = {a.dxf.tag: a.dxf.text for a in ref.attribs}
    assert att["DRAWING_NO"] == "E1-EL-01" and att["SHEET"] == "1 of 2" and att["PROJECT_NAME"] == "TEST PROJECT"
    assert att["DRAWING_TITLE1"] == "LV RETICULATION"
    assert ref.dxf.layer == S.TITLE_LAYER and "CO-NARROW" in doc.styles
    fi = {a.dxf.tag: a.dxf.text for a in next(e for e in doc.layouts.get("Fibre") if e.dxftype() == "INSERT").attribs}
    assert fi["DRAWING_NO"] == "E1-EL-02"
    # the viewport fills the frame left of the title panel, 3 mm in
    vp = next(e for e in lv if e.dxftype() == "VIEWPORT" and e.dxf.layer == "EL_VIEWPORTS")
    assert (vp.dxf.width, vp.dxf.height) == pytest.approx((335 - 3 - 8, 292 - 5 - 6))
    assert vp.dxf.center.x == pytest.approx((8 + 332) / 2)


def test_legend_lists_only_what_the_sheet_shows(template):
    doc = _read(build_dxf(_payload()))
    lv, fi = _legend_texts(doc, "LV"), _legend_texts(doc, "Fibre")
    assert "Kiosk" in lv and "LV cable" in lv and "XLPE Al 4c 95 mm²" in lv and "40 m" in lv
    assert "Fibre backbone" not in lv and "Fibre backbone" in fi and "Kiosk" not in fi
    assert any("unless noted otherwise" in t for t in lv) and not any("unless noted otherwise" in t for t in fi)
    assert any(t.endswith("General note.") for t in fi)
    # in the panel's free column (x 335..415, y 200..286)
    for e in doc.layouts.get("LV"):
        if e.dxftype() == "TEXT" and e.dxf.layer == S.LEGEND_LAYER:
            assert 335 <= e.dxf.insert.x <= 415 and 200 <= e.dxf.insert.y <= 286
            assert e.dxf.style == "CO-NARROW"


def test_lengths_can_be_left_out_of_the_legend(template):
    p = _payload()
    p["legend"]["lengths"] = False
    assert "40 m" not in _legend_texts(_read(build_dxf(p)), "LV")


def test_no_template_plain_frame_and_legend_column(no_template):
    doc = _read(build_dxf(_payload()))
    lv = doc.layouts.get("LV")
    assert not [e for e in lv if e.dxftype() == "INSERT" and "TB" in e.dxf.name]
    assert "LEGEND" in _legend_texts(doc, "LV") and "Kiosk" in _legend_texts(doc, "LV")


def test_long_legend_carries_on_in_a_box_in_the_drawing_area(template):
    p = _payload()
    p["legend"]["notes"] = [{"text": f"Note {i}"} for i in range(40)]
    doc = _read(build_dxf(p))
    xs = [e.dxf.insert.x for e in doc.layouts.get("LV") if e.dxftype() == "TEXT" and e.dxf.text.endswith("Note 39")]
    assert xs and xs[0] < 335                       # past the panel's column, in the box at the bottom left


def test_cable_labels_are_leaders_and_common_services_get_none(template):
    doc = _read(build_dxf(_payload()))
    msp = doc.modelspace()
    mls = list(msp.query("MULTILEADER"))
    assert len(mls) == 2                            # the LV cable and the fibre duct; no service
    assert {m.dxf.layer for m in mls} == {"EL_LV_LABELS", "EL_FI_LABELS"}
    assert not [t for t in msp.query("TEXT") if t.dxf.layer.endswith("_LABELS")]
    assert "EL_CABLE_CIRCLE" in doc.mleader_styles
    # the re-import still works with leaders in the file
    assert len(parse_dxf(build_dxf(_payload()))["routes"]) == len(_payload()["routes"])


def test_cables_side_by_side_share_one_leader(template):
    p = _payload()
    p["routes"][1]["pts"] = [[0, 210], [800, 210]]      # the fibre 0.5 m from the LV cable
    doc = _read(build_dxf(p))
    (ml,) = doc.modelspace().query("MULTILEADER")
    assert sum(len(l.lines) for l in ml.context.leaders) == 2
    assert "XLPE Al 4c 95 mm² · 40.0 m" in ml.context.mtext.default_content


def test_label_text_stays_clear_of_other_cables_and_symbols(template):
    doc = _read(build_dxf(_payload()))
    from ezdxf.math import Vec2
    for ml in doc.modelspace().query("MULTILEADER"):
        ins = ml.context.mtext.insert
        # the text sits off the cables (y = -10 for LV, -20 for fibre, in metres)
        assert abs(ins.y - -10) > 0.6 and abs(ins.y - -20) > 0.6


def test_arrow_style_and_along_style(template):
    doc = _read(build_dxf(_payload(labels={"style": "arrow"})))
    assert "EL_CABLE_ARROW" in doc.mleader_styles and len(list(doc.modelspace().query("MULTILEADER"))) == 2
    p = _payload(labels={"style": "along"})
    p["routes"][0]["label"] = "XLPE 40.00 m"
    doc = _read(build_dxf(p))
    assert not list(doc.modelspace().query("MULTILEADER"))
    assert [t.dxf.text for t in doc.modelspace().query("TEXT") if t.dxf.layer == "EL_LV_LABELS"] == ["XLPE 40.00 m"]


def test_line_weights_as_drawn(template):
    doc = _read(build_dxf(_payload()))
    msp = doc.modelspace()
    # EL_LV mixes 0.35 (LV) and 0.25 (services) and holds symbols: set on each line; EL_FI is one weight: on the layer
    assert doc.layers.get("EL_FI").dxf.lineweight == 25
    lv = [e for e in msp.query("LWPOLYLINE") if e.dxf.layer == "EL_LV"]
    assert sorted({e.dxf.lineweight for e in lv}) == [25, 35]
    assert doc.layers.get("EL_DUCTS").dxf.lineweight == 50
    (tr,) = [e for e in msp.query("LWPOLYLINE") if e.dxf.layer == "EL_TRENCH"]
    assert tr.dxf.const_width == pytest.approx(0.5) and tr.transparency == pytest.approx(0.62, abs=0.01)
    assert doc.header["$LWDISPLAY"] == 1


@pytest.mark.parametrize("px,lw", [(1, 18), (1.2, 18), (1.5, 25), (2, 35), (2.5, 50), (3, 50), (4.5, 70)])
def test_iso_lineweight(px, lw):
    assert S.iso_lineweight(px) == lw


def test_template_info(template):
    info = S.template_info()
    assert info["available"] and info["name"] == "CO" and info["papers"]["A3"]["viewport"] == [324.0, 281.0]


def test_long_titles_wrap_over_their_lines_and_stay_inside_the_box(tmp_path, monkeypatch):
    """Panel x 335..415: a title three lines tall (DRAWING_TITLE1–3), a project name two (PROJECT_NAME + 2), one-line fields."""
    d = ezdxf.new("R2010")
    d.styles.add("CO-ARIAL", font="arial.ttf")
    b = d.blocks.new("CO-TB-A3")
    b.add_lwpolyline([(5, 5), (415, 5), (415, 292), (5, 292)], close=True)
    b.add_line((335, 5), (335, 292))
    for y in (30, 60, 120, 200, 286):
        b.add_line((335, y), (415, y))
    b.add_line((390, 5), (390, 30))                                  # DRAWING_NO's box ends at x 390
    for tag, y, h in (("DRAWING_TITLE1", 52, 4.5), ("DRAWING_TITLE2", 46, 4.5), ("DRAWING_TITLE3", 40, 4.5),
                      ("PROJECT_NAME", 100, 4.5), ("PROJECT_NAME2", 94, 4.5), ("DRAWING_NO", 10, 6.0)):
        b.add_attdef(tag, (336.5, y), dxfattribs={"height": h, "style": "CO-ARIAL"})
    folder = tmp_path / "tpl"
    folder.mkdir()
    d.saveas(folder / "company.dxf")
    monkeypatch.setenv("PP_DXF_TEMPLATES", str(folder))
    p = _payload()
    p["titleBlock"] = {"common": {"PROJECT_NAME": "RIVERSIDE EXTENSION 4 TOWNSHIP ESTABLISHMENT ELECTRICAL RETICULATION PHASE TWO"},
                       "sheets": {"LV": {"DRAWING_TITLE1": "LV RETICULATION AND STREET LIGHTING CABLE LAYOUT",
                                         "DRAWING_TITLE2": "GROUND FLOOR AND BASEMENT PARKING LEVEL", "DRAWING_NO": "E1234-EL-RET-0001-A"}}}
    doc = _read(build_dxf(p))
    ref = next(e for e in doc.layouts.get("LV") if e.dxftype() == "INSERT")
    att = {a.dxf.tag: a for a in ref.attribs}
    title = [att[f"DRAWING_TITLE{i}"].dxf.text for i in (1, 2, 3)]
    assert all(title) and " ".join(title).split() == ("LV RETICULATION AND STREET LIGHTING CABLE LAYOUT "
                                                      "GROUND FLOOR AND BASEMENT PARKING LEVEL").split()
    assert att["PROJECT_NAME2"].dxf.text                                # the name ran on to its second line
    for a in att.values():                                               # every line inside its box
        room = ((390 if a.dxf.tag == "DRAWING_NO" else 415) - 336.5 - 1.0) * S.ROOM_MARGIN
        assert S.text_width(a.dxf.text, a.dxf.height, "arial.ttf", a.dxf.get("width", 1.0)) <= room + 1e-6, a.dxf.tag


def test_text_width_is_arial():
    assert S.text_width("H", 0.716) == pytest.approx(0.722)
    assert S.text_width("H", 0.716, "ARIALN.TTF") == pytest.approx(0.722 * 0.82)


def test_road_crossing_gets_a_leader_and_circle_with_its_duct_count(no_template):
    """3 large (160) + 4 small (110) ducts side by side = one crossing labelled 3L/4S; the labels are not imported back."""
    ducts = [{"p1": [100 + i * 6, 0], "p2": [100 + i * 6, 120], "size": "160" if i < 3 else "110", "name": f"RC{i}"} for i in range(7)]
    p = _payload(crossings=ducts, crossingLabels=[{"p1": [118, 0], "p2": [118, 120], "text": "3L/4S"}])
    doc = _read(build_dxf(p, load_image=lambda i: None, notes=[]))
    msp = doc.modelspace()
    lay = [e for e in msp if e.dxf.layer.endswith("_DUCTS_LABELS")]
    assert [e.dxf.text for e in lay if e.dxftype() == "TEXT"] == ["3L/4S"]
    assert sorted(e.dxftype() for e in lay) == ["CIRCLE", "CIRCLE", "LINE", "TEXT"]
    imported = parse_dxf(build_dxf(p, load_image=lambda i: None, notes=[]))
    assert len(imported["crossings"]) == 7 and not any("3L/4S" in str(t) for t in imported["texts"])
    # off: nothing written
    q = _payload(crossings=ducts)
    assert not [e for e in _read(build_dxf(q, load_image=lambda i: None, notes=[])).modelspace() if e.dxf.layer.endswith("_DUCTS_LABELS")]
