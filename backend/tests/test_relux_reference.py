"""Relux results PDF reader (analysis/relux_reference.py)."""
from backend.analysis.relux_reference import parse_relux_text, parse_relux_pdf
import pytest

DETAIL = """1 Office
1.1 Summary, Office, Light scene 1(C)
1.1.1Result overview, Evaluation area 1
General
Height of luminaire plane 2.70 m
Maintenance factor 0.80
Total power 164.0 W
Total power per area (30.71 m\u00b2) 5.34 W/m\u00b2 (1.01 W/m\u00b2/100lx)
Evaluation area 1 Reference plane 1.1
Horizontal cylindrical
E \u0305m 530 lx 238 lx
Emin 452 lx 202 lx
Emin/E \u0305m (Uo) 0.85 0.85
Emin/Emax (Ud) 0.74
Ez/Eh 0.39
RUG (3.7H 3.9H) <=24.5
M 1.5 (Ceiling) 245 lx 0.45
M 1.1 (Wall) 334 lx 0.69
M 1.2 (Wall) 288 lx 0.78
"""
OVERVIEW = "Rooms\nOffice 4 x Luminaires \nFloor area 30.7 m\u00b2\nWorkshop & Spare Parts9 x Luminaires \n"


def test_parse_detail_page_and_count():
    r = parse_relux_text([OVERVIEW, DETAIL])
    o = r["rooms"]["Office"]
    assert (o["em"], o["emin"], o["uo"], o["ud"], o["rug"]) == (530.0, 452.0, 0.85, 0.74, 24.5)
    assert o["emCyl"] == 238.0 and o["ceilEm"] == 245.0 and o["wallEm"] == [334.0, 288.0]
    assert o["luminaires"] == 4 and o["hLum"] == 2.7 and o["mf"] == 0.8 and o["power"] == 164.0


def test_name_and_count_that_touch():
    from backend.analysis.relux_reference import _norm
    r = parse_relux_text([OVERVIEW, DETAIL.replace("1 Office", "8 Workshop & Spare Parts")])
    assert r["rooms"]["Workshop & Spare Parts"]["luminaires"] == 9


def test_not_a_relux_pdf():
    with pytest.raises(ValueError):
        parse_relux_pdf(b"not a pdf")
    assert parse_relux_text(["nothing here"])["rooms"] == {}
