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


def test_strings_and_row_spacing(client, auth):
    r = client.post(f"{API}/solar-strings", headers=auth, json={
        "module": "pv_550_mono", "inverter": "inv_10k_2mppt", "modules_per_string": 20, "strings_per_mppt": [1, 1]})
    assert r.status_code == 200 and r.json()["ok"] is False
    r = client.post(f"{API}/solar-row-spacing", headers=auth,
                    json={"lat": -25.75, "tilt_deg": 15, "module_length_m": 2.28, "roof_depth_m": 9.2})
    assert r.status_code == 200 and r.json()["rows"] == 3
    assert client.post(f"{API}/solar-row-spacing", headers=auth,
                       json={"lat": -80, "tilt_deg": 15, "module_length_m": 2.28, "hour_angle_deg": 90}).status_code == 400
