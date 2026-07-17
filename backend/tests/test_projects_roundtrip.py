"""Route-level persistence regression tests (audit DEV-12).

Pins two properties of the projects API that have historically regressed:

1. Save/load round-trips are byte-exact: `extra="allow"` fields
   (dataVersion, pages, groups, wire bendPoints/routeMode, unknown future
   fields) survive POST/PUT -> GET, and — per the DEV-18 fix — textual
   digit-string props (e.g. a reference field "007") are NOT rewritten to
   numbers in the stored project, while the analysis layer still receives
   coerced numbers (backward compatibility with old string-number files).

2. The CSV export endpoint neutralizes spreadsheet formula injection in
   user-controlled string cells and properly quotes cells containing
   newlines (audit DEV-10, backend half).

Uses a temporary SQLite database so the real protectionpro.db is never
touched.
"""

import csv
import io
import os
import tempfile

# ── Redirect the database to a temp file BEFORE the app is imported ──
_TMP_DIR = tempfile.mkdtemp(prefix="protectionpro-test-db-")
_TEST_DB_URL = f"sqlite:///{_TMP_DIR}/test_projects.db"
os.environ["DATABASE_URL"] = _TEST_DB_URL

from backend.models import database as _database  # noqa: E402

if str(_database.engine.url) != _TEST_DB_URL:
    # database.py was already imported (by another test module) with the
    # default URL — rebind its module globals; init_db() and get_db() read
    # them at call time, so this is sufficient.
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    _database.engine = create_engine(
        _TEST_DB_URL, connect_args={"check_same_thread": False}
    )
    _database.SessionLocal = sessionmaker(
        autocommit=False, autoflush=False, bind=_database.engine
    )

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from backend.main import app  # noqa: E402


@pytest.fixture(scope="module")
def client():
    # Context manager triggers the startup event (init_db on the temp engine).
    with TestClient(app) as c:
        # The API is now auth-gated; register the first user (auto-admin, no
        # invite needed) and send its bearer token on every request by default.
        reg = c.post("/api/auth/register",
                     json={"email": "test-admin@x.com", "password": "password123"})
        assert reg.status_code == 200, reg.text
        c.headers["Authorization"] = f"Bearer {reg.json()['access_token']}"
        yield c


# ── Helpers ──

def assert_preserved(expected, actual, path="$"):
    """Assert every posted field survives byte-exact (type- and value-strict).

    `actual` may contain extra keys (schema defaults filled in on save);
    every key/value present in `expected` must match exactly, including type
    (so "007" surviving as 7 or 7.0 fails).
    """
    if isinstance(expected, dict):
        assert isinstance(actual, dict), (
            f"{path}: expected dict, got {type(actual).__name__}"
        )
        for k, v in expected.items():
            assert k in actual, f"{path}.{k}: dropped on round-trip"
            assert_preserved(v, actual[k], f"{path}.{k}")
    elif isinstance(expected, list):
        assert isinstance(actual, list), (
            f"{path}: expected list, got {type(actual).__name__}"
        )
        assert len(actual) == len(expected), (
            f"{path}: length {len(expected)} became {len(actual)}"
        )
        for i, (e, a) in enumerate(zip(expected, actual)):
            assert_preserved(e, a, f"{path}[{i}]")
    else:
        assert type(actual) is type(expected), (
            f"{path}: {expected!r} ({type(expected).__name__}) became "
            f"{actual!r} ({type(actual).__name__})"
        )
        assert actual == expected, f"{path}: {expected!r} became {actual!r}"


def _roundtrip_payload():
    """A project exercising every field class that must survive persistence."""
    return {
        "projectName": "Roundtrip Test",
        "baseMVA": 100.0,
        "frequency": 50,
        "nextId": 7,
        # extra="allow" top-level fields (the DEV-2/H8 corruption class)
        "dataVersion": 2,
        "wireRouteMode": "orthogonal",
        "pages": [
            {"id": "page_1", "name": "Sheet 1"},
            {"id": "page_2", "name": "Sheet 2"},
        ],
        "groups": {"group_1": {"name": "Incomer", "memberIds": ["bus-1", "utility-1"]}},
        # unknown future field — must survive untouched
        "futureField": {"nested": [1, "two", {"deep": True}], "flag": None},
        "components": [
            {
                "id": "utility-1",
                "type": "utility",
                "x": 100.0,
                "y": 40.0,
                "rotation": 0.0,
                "pageId": "page_1",
                "props": {
                    "name": "Grid",
                    "voltage_kv": 11,
                    "fault_mva": 500,
                    "x_r_ratio": 15,
                },
            },
            {
                "id": "bus-1",
                "type": "bus",
                "x": 100.0,
                "y": 160.0,
                "rotation": 90.0,
                "pageId": "page_1",
                "labelOffsetX": 12.5,
                # unknown per-component future field
                "futureCompField": "keep-me",
                "props": {
                    "name": "MV Bus",
                    "voltage_kv": 11,
                    # textual digit-strings — DEV-18: must NOT become numbers
                    "tag": "007",           # in the textual allowlist
                    "panel_ref": "007",     # NOT allowlisted — pins the fix
                    "feeder_code": "0815",  # leading zero would be destroyed
                    "setting_note": "12.50",  # trailing zero would be destroyed
                },
            },
        ],
        "wires": [
            {
                "id": "w1",
                "fromComponent": "utility-1",
                "fromPort": "bottom",
                "toComponent": "bus-1",
                "toPort": "top",
                "bendPoints": [{"x": 100, "y": 90}, {"x": 120, "y": 120}],
                "routeMode": "manual",
                "pageId": "page_1",
            },
        ],
    }


def _bus1_props(project_json):
    comp = next(c for c in project_json["components"] if c["id"] == "bus-1")
    return comp["props"]


# ── (a) POST -> GET round-trip ──

def test_post_get_roundtrip_byte_exact(client):
    payload = _roundtrip_payload()
    resp = client.post("/api/projects", json=payload)
    assert resp.status_code == 200, resp.text
    project_id = resp.json()["id"]

    got = client.get(f"/api/projects/{project_id}")
    assert got.status_code == 200
    data = got.json()

    # Every posted field survives byte-exact (type-strict).
    assert_preserved(payload, data)

    # Explicitly pin DEV-18: digit-string props are still strings.
    props = _bus1_props(data)
    for key in ("tag", "panel_ref", "feeder_code", "setting_note"):
        assert isinstance(props[key], str), (
            f"props.{key} was coerced to {type(props[key]).__name__} on save"
        )
    assert props["panel_ref"] == "007"
    assert props["feeder_code"] == "0815"
    assert props["setting_note"] == "12.50"


# ── (b) PUT -> GET stays intact ──

def test_put_get_roundtrip_byte_exact(client):
    payload = _roundtrip_payload()
    resp = client.post("/api/projects", json=payload)
    assert resp.status_code == 200, resp.text
    project_id = resp.json()["id"]

    updated = _roundtrip_payload()
    updated["projectName"] = "Roundtrip Test rev B"
    updated["components"][1]["x"] = 240.0
    updated["components"][1]["props"]["panel_ref"] = "0099"
    updated["futureField"]["nested"].append("rev-b")

    resp = client.put(f"/api/projects/{project_id}", json=updated)
    assert resp.status_code == 200, resp.text

    got = client.get(f"/api/projects/{project_id}")
    assert got.status_code == 200
    data = got.json()

    assert_preserved(updated, data)
    assert _bus1_props(data)["panel_ref"] == "0099"
    assert isinstance(_bus1_props(data)["panel_ref"], str)


# ── Backward compatibility: analysis still coerces string numbers ──

def test_analysis_still_coerces_string_numeric_props(client):
    """Old stored projects hold numeric props as strings; the analysis layer
    must keep coercing them (the reason the coercion exists at all)."""
    payload = _csv_project_payload()
    for comp in payload["components"]:
        p = comp["props"]
        for key in ("voltage_kv", "fault_mva", "x_r_ratio", "length_km",
                    "r_per_km", "x_per_km", "rated_kw", "power_factor"):
            if key in p:
                p[key] = str(p[key])

    resp = client.post("/api/analysis/fault", json=payload)
    assert resp.status_code == 200, resp.text
    buses = resp.json()["buses"]
    assert buses, "fault analysis returned no buses"
    for bus in buses.values():
        assert bus["ik3"] > 0


# ── (c) CSV export escaping (DEV-10 backend) ──

EVIL_NAME = '=HYPERLINK("http://x","y")'
NEWLINE_NAME = "Main\nBus"


def _csv_project_payload():
    """Minimal analyzable network: utility -> bus-1 -> cable -> bus-2 -> load."""
    return {
        "projectName": "CSV Escape Test",
        "baseMVA": 100.0,
        "frequency": 50,
        "components": [
            {
                "id": "utility-1", "type": "utility", "x": 0.0, "y": 0.0,
                "props": {"name": "Grid", "voltage_kv": 11, "fault_mva": 500,
                          "x_r_ratio": 15},
            },
            {
                "id": "bus-1", "type": "bus", "x": 0.0, "y": 100.0,
                "props": {"name": EVIL_NAME, "voltage_kv": 11},
            },
            {
                "id": "cable-1", "type": "cable", "x": 0.0, "y": 200.0,
                "props": {"name": "C1", "length_km": 0.5, "r_per_km": 0.32,
                          "x_per_km": 0.08, "rated_amps": 200,
                          "voltage_kv": 11, "size_mm2": 95,
                          "material": "copper", "insulation": "XLPE"},
            },
            {
                "id": "bus-2", "type": "bus", "x": 0.0, "y": 300.0,
                "props": {"name": NEWLINE_NAME, "voltage_kv": 11},
            },
            {
                "id": "static_load-1", "type": "static_load", "x": 0.0, "y": 400.0,
                "props": {"name": "L1", "rated_kw": 500, "power_factor": 0.9,
                          "voltage_kv": 11},
            },
        ],
        "wires": [
            {"id": "w1", "fromComponent": "utility-1", "fromPort": "bottom",
             "toComponent": "bus-1", "toPort": "top"},
            {"id": "w2", "fromComponent": "bus-1", "fromPort": "bottom",
             "toComponent": "cable-1", "toPort": "top"},
            {"id": "w3", "fromComponent": "cable-1", "fromPort": "bottom",
             "toComponent": "bus-2", "toPort": "top"},
            {"id": "w4", "fromComponent": "bus-2", "fromPort": "bottom",
             "toComponent": "static_load-1", "toPort": "top"},
        ],
    }


def test_csv_export_escapes_formulas_and_newlines(client):
    resp = client.post("/api/projects", json=_csv_project_payload())
    assert resp.status_code == 200, resp.text
    project_id = resp.json()["id"]

    csv_resp = client.get(f"/api/projects/{project_id}/export/csv")
    assert csv_resp.status_code == 200, csv_resp.text
    assert csv_resp.headers["content-type"].startswith("text/csv")
    text = csv_resp.text

    rows = list(csv.reader(io.StringIO(text)))
    bus1_rows = [r for r in rows if len(r) >= 2 and r[0] == "bus-1"]
    bus2_rows = [r for r in rows if len(r) >= 2 and r[0] == "bus-2"]
    assert bus1_rows, f"no bus-1 result rows in CSV:\n{text}"
    assert bus2_rows, f"no bus-2 result rows in CSV:\n{text}"

    # Formula injection neutralized: every occurrence of the evil name is
    # prefixed with a single quote so spreadsheets treat it as text.
    for row in bus1_rows:
        assert row[1] == "'" + EVIL_NAME, (
            f"unescaped formula cell in CSV row: {row!r}"
        )

    # Newline names are quoted so they parse back as ONE cell of ONE row
    # (csv.reader only reconstructs the embedded newline if properly quoted).
    for row in bus2_rows:
        assert row[1] == NEWLINE_NAME, (
            f"newline name not properly quoted, parsed as: {row!r}"
        )
    # And the quoting doubled nothing into a stray unquoted line.
    assert '"Main\nBus"' in text or '"Main\r\nBus"' in text
