"""Drawing DXF export (SLD / Demand / street-light / DB single line / GA).

The browser sends a neutral payload (mm, y up); these pin what the writer
makes of it: a clean audit, symbols as blocks with ATTDEFs, inserts carrying
visible label attributes and invisible data attributes, unicode text, and
the attribute definitions placed in block coordinates.
"""

import io
import math

import ezdxf
import pytest

from backend.analysis.drawing_dxf import build_drawing_dxf


def _payload(**kw):
    base = {
        "fileName": "test",
        "layers": {"SYMBOLS": "#d32f2f", "TEXT": None, "WIRES": "#222222"},
        "blocks": [{"name": "PP_CB", "entities": [
            {"t": "line", "a": [0, -5], "b": [0, 5], "layer": "SYMBOLS"},
            {"t": "circle", "c": [0, 0], "r": 1.2, "fill": "#d32f2f", "layer": "SYMBOLS"},
            {"t": "text", "at": [3, 0], "h": 1.5, "s": "×", "layer": "SYMBOLS"},
        ]}],
        "entities": [
            {"t": "line", "a": [0, 0], "b": [100, 0], "layer": "WIRES", "lw": 0.85},
            {"t": "poly", "pts": [[0, 0], [10, 0], [10, 10]], "closed": True, "fill": "#2e7d32", "dash": 2},
            {"t": "text", "at": [5, 20], "h": 2.5, "s": "Board 1 — 400/230 V · 2.5 mm² Ω", "align": "center",
             "valign": "middle", "layer": "TEXT"},
            {"t": "insert", "name": "PP_CB", "at": [50, 50], "sx": 0.25, "sy": 0.25, "rot": 90, "layer": "SYMBOLS",
             "attribs": [
                 {"tag": "WAY", "value": "W12 · 20 A C", "at": [56, 40], "h": 2.2, "align": "center"},
                 {"tag": "RATING_A", "value": "20", "invisible": True},
                 {"tag": "CABLE_MM2", "value": "2.5", "invisible": True},
             ]},
            {"t": "insert", "name": "PP_CB", "at": [80, 50], "sx": 0.25, "sy": 0.25, "rot": 0,
             "attribs": [{"tag": "WAY", "value": "W13", "at": [80, 40], "h": 2.2}]},
        ],
    }
    base.update(kw)
    return base


def _read(data: bytes):
    return ezdxf.read(io.StringIO(data.decode("utf-8")))


def test_writes_a_clean_r2010_file_in_mm():
    doc = _read(build_drawing_dxf(_payload()))
    assert doc.dxfversion == "AC1024"
    assert doc.header["$INSUNITS"] == 4
    auditor = doc.audit()
    assert not auditor.has_errors, [str(e) for e in auditor.errors]


def test_symbols_are_blocks_with_attributes():
    doc = _read(build_drawing_dxf(_payload()))
    blk = doc.blocks.get("PP_CB")
    assert blk is not None
    tags = {a.dxf.tag for a in blk.query("ATTDEF")}
    assert tags == {"WAY", "RATING_A", "CABLE_MM2"}
    inserts = doc.modelspace().query("INSERT")
    assert len(inserts) == 2
    first = inserts[0]
    vals = {a.dxf.tag: a.dxf.text for a in first.attribs}
    assert vals == {"WAY": "W12 · 20 A C", "RATING_A": "20", "CABLE_MM2": "2.5"}
    vis = {a.dxf.tag: a.is_invisible for a in first.attribs}
    assert vis == {"WAY": False, "RATING_A": True, "CABLE_MM2": True}
    assert first.dxf.rotation == pytest.approx(90)
    assert first.dxf.xscale == pytest.approx(0.25)


def test_attdef_sits_in_block_coordinates():
    # The WAY attribute of the rotated, scaled insert is at world (56, 40):
    # 6 right / 10 below an insert at (50, 50) turned 90°, scale 0.25.
    doc = _read(build_drawing_dxf(_payload()))
    ad = next(a for a in doc.blocks.get("PP_CB").query("ATTDEF") if a.dxf.tag == "WAY")
    x, y = ad.dxf.align_point.x, ad.dxf.align_point.y
    # Back to world through the insert transform:
    r = math.radians(90)
    wx = 50 + 0.25 * (x * math.cos(r) - y * math.sin(r))
    wy = 50 + 0.25 * (x * math.sin(r) + y * math.cos(r))
    assert (wx, wy) == (pytest.approx(56), pytest.approx(40))


def test_unicode_text_survives():
    doc = _read(build_drawing_dxf(_payload()))
    texts = [t.dxf.text for t in doc.modelspace().query("TEXT")]
    assert "Board 1 — 400/230 V · 2.5 mm² Ω" in texts


def test_fills_dashes_and_lineweights():
    doc = _read(build_drawing_dxf(_payload()))
    msp = doc.modelspace()
    assert len(msp.query("HATCH")) == 1
    poly = msp.query("LWPOLYLINE")[0]
    assert poly.dxf.linetype == "PP_DASHED"
    line = msp.query("LINE")[0]
    assert line.dxf.lineweight in (80, 90)      # 0.85 mm → a standard weight


def test_unknown_block_and_bad_entities_are_skipped():
    p = _payload()
    p["entities"] += [{"t": "insert", "name": "NOPE", "at": [0, 0]}, "junk",
                      {"t": "text", "at": [0, 0], "h": 0, "s": "x"}, {"t": "poly", "pts": [[0, 0]]}]
    doc = _read(build_drawing_dxf(p))
    assert not doc.audit().has_errors


def test_route_returns_a_dxf(monkeypatch):
    from fastapi.testclient import TestClient
    from backend.main import app
    from backend import auth

    app.dependency_overrides[auth.get_current_user] = lambda: object()
    try:
        r = TestClient(app).post("/api/drawing/dxf-export", json=_payload(fileName="DB-1 single line"))
    finally:
        app.dependency_overrides.clear()
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/dxf")
    assert 'filename="DB-1 single line.dxf"' in r.headers["content-disposition"]
    assert _read(r.content).blocks.get("PP_CB") is not None
