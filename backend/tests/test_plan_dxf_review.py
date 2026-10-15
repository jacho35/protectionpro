"""Plan DXF round trip (reviews/PLAN_DXF_REVIEW.md): geometry lands back on
its original pixels for any scale, any rotation, and texts keep their place."""
import pytest

from backend.analysis.plan_dxf import build_dxf, parse_dxf


def _payload(factor):
    blocks = {"PP_kiosk": {"sizeWorld": 24, "prims": [
        {"k": "r", "x": 8, "y": 8, "w": 24, "h": 24, "s": "col"}]}}
    els = [{"block": "PP_kiosk", "type": "kiosk", "x": 123.5, "y": 456.25,
            "rotation": r, "layer": "EL", "attrs": {"REF": f"K{i}", "TYPE": "kiosk"}}
           for i, r in enumerate((0, 45, 90, 270, 315))]
    return {"factor": factor, "floorName": "G", "domain": "retic", "layers": [],
            "blocks": blocks, "elements": els,
            "routes": [{"layer": "RT", "type": "service", "curved": False,
                        "pts": [[10.5, 20.25], [300.75, 20.25], [300.75, 90]]}],
            "trenches": [], "crossings": [], "measurements": [],
            "rooms": [{"label": "Hall", "pts": [[0, 0], [200, 0], [200, 100], [0, 100]]}],
            "texts": [{"x": 50, "y": 60, "text": "Note A", "h": 12}]}


@pytest.mark.parametrize("factor", [0.01, 0.05, 0.37])
def test_round_trip_lands_on_original_pixels(factor):
    r = parse_dxf(build_dxf(_payload(factor)))
    assert r["factor"] == pytest.approx(factor)
    devs = sorted(r["devices"], key=lambda d: d["name"])
    assert [round(d["rotation"]) for d in devs] == [0, 45, 90, 270, 315]
    for d in devs:
        assert d["x"] == pytest.approx(123.5, abs=1e-6)
        assert d["y"] == pytest.approx(456.25, abs=1e-6)
    (rt,) = r["routes"]
    flat = [v for p in rt["pts"] for v in p]
    assert flat == pytest.approx([10.5, 20.25, 300.75, 20.25, 300.75, 90], abs=1e-6)
    (rm,) = r["rooms"]
    assert rm["label"] == "Hall"
    (tx,) = r["texts"]
    assert tx["text"] == "Note A" and tx["x"] == pytest.approx(50, abs=1e-6)
    assert tx["y"] == pytest.approx(60, abs=1e-6)
