"""HTTP-level tests for the design-automation routes and the deliverables pack.

The engines have their own test modules; these check the wiring (request
models, status codes) and that a pack has the pages, bookmarks and footer it
promises.
"""

import base64
import io

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pypdf import PdfReader
from reportlab.pdfgen import canvas

from backend.routes import analysis, reports
from backend.tests.test_building_circuits import _dev, _rect, _req as _bc_req
from backend.tests.test_retic_mv_design import LADDER
from backend.tests.test_fixes import _project

app = FastAPI()
app.include_router(analysis.router, prefix="/api")
app.include_router(reports.report_router, prefix="/api")
client = TestClient(app)


def _pdf(pages, label):
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(595, 842))
    for i in range(pages):
        c.drawString(100, 700, f"{label} {i + 1}")
        c.showPage()
    c.save()
    return base64.b64encode(buf.getvalue()).decode()


class TestAnalysisRoutes:
    def test_building_circuits(self):
        req = _bc_req(devices=[_dev("l1", "r1", 2, 2), _dev("s1", "r1", 3, 2, "bd_socket", va=300)])
        r = client.post("/api/analysis/building-circuits", json=req)
        assert r.status_code == 200
        assert len(r.json()["circuits"]) == 2

    def test_building_circuits_bad_mode_is_400(self):
        r = client.post("/api/analysis/building-circuits", json=_bc_req(mode="teleport"))
        assert r.status_code == 400

    def test_mv_design(self):
        r = client.post("/api/analysis/retic-mv-design", json={
            "topology": "radial", "voltage_kv": 11,
            "supply": {"x": 0, "y": 0, "fault_mva": 250, "clearing_time_s": 0.02},
            "subs": [{"id": "A", "x": 1000, "y": 0, "kva": 1000}], "cables": LADDER})
        assert r.status_code == 200 and r.json()["cable"]["id"] == "al50"

    def test_mv_design_bad_topology_is_400(self):
        r = client.post("/api/analysis/retic-mv-design", json={
            "topology": "star", "supply": {"x": 0, "y": 0, "fault_mva": 250},
            "subs": [{"id": "A", "x": 1, "y": 0, "kva": 1}], "cables": LADDER})
        assert r.status_code == 400

    def test_fixes_and_fix_all(self):
        body = _project().model_dump()
        body["issues"] = [{"key": "db-1:w1", "kind": "db_way", "board_id": "db-1", "way_id": "w1"},
                          {"key": "db-1:w2", "kind": "db_way", "board_id": "db-1", "way_id": "w2"}]
        one = client.post("/api/analysis/fixes", json=body)
        assert one.status_code == 200 and len(one.json()["fixes"]) == 2
        every = client.post("/api/analysis/fix-all", json=body)
        assert every.status_code == 200
        assert [f["issue_key"] for f in every.json()["automatic"]] == ["db-1:w1"]


class TestDeliverables:
    def _req(self, **kw):
        req = {"projectName": "Clinic block", "projectDetails": {"client": "Acme", "revision": "B"},
               "revisions": [{"rev": "A", "date": "2026-11-01", "description": "First issue", "by": "JvZ"}],
               "parts": [{"group": "Design report", "title": "Circuit checks", "pdf_b64": _pdf(3, "checks")},
                         {"group": "Drawings", "title": "Floor plans", "pdf_b64": _pdf(2, "plans")},
                         {"group": "Drawings", "title": "Board single lines", "pdf_b64": _pdf(1, "dbs")}]}
        req.update(kw)
        return req

    def test_pages_bookmarks_and_numbers(self):
        r = client.post("/api/reports/deliverables", json=self._req())
        assert r.status_code == 200 and r.headers["content-type"] == "application/pdf"
        pdf = PdfReader(io.BytesIO(r.content))
        assert len(pdf.pages) == 1 + 1 + 3 + 2 + 1          # cover, contents, parts = 8
        assert r.headers["x-pack-pages"] == "8"
        titles = [o.title if not isinstance(o, list) else [x.title for x in o] for o in pdf.outline]
        assert titles == ["Design report", ["Circuit checks"], "Drawings", ["Floor plans", "Board single lines"]]
        assert "Contents" in pdf.pages[1].extract_text()
        assert "Floor plans" in pdf.pages[1].extract_text() and "6" in pdf.pages[1].extract_text()
        assert "page 8 of 8" in pdf.pages[7].extract_text()
        assert "page" not in pdf.pages[0].extract_text()    # no footer on the cover
        assert "Clinic block" in pdf.pages[0].extract_text()

    def test_unticked_parts_are_left_out(self):
        req = self._req()
        req["parts"][1]["include"] = False
        pdf = PdfReader(io.BytesIO(client.post("/api/reports/deliverables", json=req).content))
        assert len(pdf.pages) == 1 + 1 + 3 + 1

    def test_a_bad_part_is_refused_by_name(self):
        req = self._req()
        req["parts"][0]["pdf_b64"] = base64.b64encode(b"not a pdf").decode()
        r = client.post("/api/reports/deliverables", json=req)
        assert r.status_code == 400 and "Circuit checks" in r.json()["detail"]

    def test_nothing_selected_is_refused(self):
        r = client.post("/api/reports/deliverables", json=self._req(parts=[]))
        assert r.status_code == 400
