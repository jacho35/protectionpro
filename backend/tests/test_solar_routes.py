"""Solar PV routes: sign-in required, library listing, size / strings / row-spacing round trips."""

import os
import tempfile

_TMP_DIR = tempfile.mkdtemp(prefix="protectionpro-test-solar-")
_TEST_DB_URL = f"sqlite:///{_TMP_DIR}/test_solar_routes.db"
os.environ["DATABASE_URL"] = _TEST_DB_URL

from backend.models import database as _database  # noqa: E402
from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402
import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from backend.main import app  # noqa: E402

API = "/api/analysis"


@pytest.fixture(scope="module")
def client():
    _database.engine = create_engine(_TEST_DB_URL, connect_args={"check_same_thread": False})
    _database.SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=_database.engine)
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="module")
def auth(client):
    r = client.post("/api/auth/register", json={"email": "solar@x.com", "password": "password123"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def test_sign_in_required(client):
    assert client.get(f"{API}/solar-library").status_code in (401, 403)
    assert client.post(f"{API}/solar-size", json={}).status_code in (401, 403)


def test_library_lists_modules_inverters_and_hermanus(client, auth):
    r = client.get(f"{API}/solar-library", headers=auth)
    assert r.status_code == 200
    d = r.json()
    assert len(d["modules"]) >= 4 and len(d["inverters"]) >= 5
    assert "Hermanus" in [x["name"] for x in d["locations"]]
    assert "Screening" in d["data_note"]


def test_size_round_trip_and_errors(client, auth):
    body = {"location": "Hermanus", "tilt_deg": 25, "azimuth_deg": 0, "usable_area_m2": 60, "annual_kwh": 12000,
            "inverter": "inv_10k_2mppt"}
    r = client.post(f"{API}/solar-size", json=body, headers=auth)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["modules"] >= 1 and len(d["months"]) == 12 and d["annual_kwh"] > 0
    assert client.post(f"{API}/solar-size", json={"location": "Atlantis", "usable_area_m2": 10},
                       headers=auth).status_code == 400
    assert client.post(f"{API}/solar-size", json={"location": "Pretoria"}, headers=auth).status_code == 400


def test_row_spacing(client, auth):
    r = client.post(f"{API}/solar-row-spacing", headers=auth,
                    json={"lat": -25.75, "tilt_deg": 15, "module_length_m": 2.28, "roof_depth_m": 9.2})
    assert r.status_code == 200 and r.json()["rows"] == 3
    assert client.post(f"{API}/solar-row-spacing", headers=auth,
                       json={"lat": -80, "tilt_deg": 15, "module_length_m": 2.28, "hour_angle_deg": 90}).status_code == 400


def test_protection_route(client, auth):
    r = client.post(f"{API}/solar-protection", headers=auth, json={
        "module": "pv_550_mono", "inverter": "inv_10k_2mppt", "modules_per_string": 8,
        "strings_per_mppt": [2, 1], "export_limit_kw": 8})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["export_limited"] is True and d["items"][0]["id"] == "string_fuse"
    assert client.post(f"{API}/solar-protection", headers=auth, json={
        "module": "pv_550_mono", "inverter": "inv_10k_2mppt", "modules_per_string": 8,
        "strings_per_mppt": [2, 1], "string_cable_m": -1}).status_code == 400


def test_shading_route_and_removed_duplicates(client, auth):
    r = client.post(f"{API}/solar-size", headers=auth, json={
        "location": "Pretoria", "tilt_deg": 25, "usable_area_m2": 40, "mode": "roof",
        "obstructions": [{"height_m": 4, "distance_m": 6, "bearing_deg": 0, "width_m": 20}]})
    assert r.status_code == 200 and r.json()["shading_loss_pct"] > 5
    # string checks, fault contribution and voltage rise are the app's own studies, not solar routes
    for gone in ("solar-strings", "solar-voltage-rise"):
        assert client.post(f"{API}/{gone}", headers=auth, json={}).status_code in (404, 405)


def test_sun_route(client, auth):
    r = client.post(f"{API}/solar-sun", headers=auth, json={"lat": -25.75, "hour_angle_deg": -30})
    assert r.status_code == 200 and 30 < r.json()["elevation_deg"] < 36


def test_sun_grid_and_shading_routes(client, auth, monkeypatch):
    import gzip, json
    from backend.analysis import pvgis_tmy
    path = os.path.join(os.path.dirname(__file__), "..", "..", "testing", "solar", "tmy", "tmy_-26.20_28.04.json.gz")
    monkeypatch.setattr(pvgis_tmy, "get_tmy", lambda la, lo: json.load(gzip.open(path, "rt")))
    assert client.post(f"{API}/solar-sun-grid", json={"location": "Johannesburg"}).status_code in (401, 403)
    g = client.post(f"{API}/solar-sun-grid", headers=auth, json={"location": "Johannesburg"})
    assert g.status_code == 200 and len(g.json()["samples"]) > 100
    n = len(g.json()["samples"])
    ok = client.post(f"{API}/solar-shading", headers=auth, json={
        "location": "Johannesburg", "arrays": [{"name": "A", "tilt_deg": 30, "azimuth_deg": 0, "modules": 2, "per_string": 2,
                                                "shade": ["0" * n, "1" * n]}]})
    assert ok.status_code == 200 and 20 < ok.json()["loss_pct"] < 50 and len(ok.json()["strings"]) == 1
    bad = client.post(f"{API}/solar-shading", headers=auth, json={
        "location": "Johannesburg", "arrays": [{"name": "A", "tilt_deg": 30, "modules": 2, "shade": ["0", "1"]}]})
    assert bad.status_code == 400
