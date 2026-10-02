"""Drift: the user's overrides document accepts `base` versions, and a change to a company
entry notifies users whose own edit of it is out of date (unless already reviewed)."""

import os
import tempfile

_TMP_DIR = tempfile.mkdtemp(prefix="protectionpro-test-drift-")
_TEST_DB_URL = f"sqlite:///{_TMP_DIR}/test_library_drift.db"
os.environ["DATABASE_URL"] = _TEST_DB_URL

from backend.models import database as _database  # noqa: E402
from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402
import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from backend.main import app  # noqa: E402

LIB = "/api/shared-libraries"
_ADMIN = {}


@pytest.fixture(scope="module")
def client():
    _database.engine = create_engine(_TEST_DB_URL, connect_args={"check_same_thread": False})
    _database.SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=_database.engine)
    with TestClient(app) as c:
        yield c


def _login(client, email):
    if not _ADMIN:
        r = client.post("/api/auth/register", json={"email": "admin@x.com", "password": "password123"})
        _ADMIN["h"] = {"Authorization": f"Bearer {r.json()['access_token']}"}
    r = client.post("/api/auth/login", json={"email": email, "password": "password123"})
    if r.status_code != 200:
        code = client.post("/api/auth/invites", json={}, headers=_ADMIN["h"]).json()["code"]
        r = client.post("/api/auth/register", json={"email": email, "password": "password123", "invite_code": code})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def _drift_notes(client, h):
    return [n for n in client.get("/api/notifications", headers=h).json()["items"] if n["kind"] == "override_out_of_date"]


def _setup(client):
    _login(client, "admin@x.com")
    admin = _ADMIN["h"]
    lib = client.post(LIB, json={"name": "Acme"}, headers=admin).json()["id"]
    client.put(f"{LIB}/{lib}/company-default", json={"value": True}, headers=admin)
    client.put(f"{LIB}/{lib}/entries/cbs/cb1", json={"data": {"id": "cb1", "name": "MCCB 250", "rated_current_a": 250}}, headers=admin)
    client.put(f"{LIB}/{lib}/entries/cbs/cb2", json={"data": {"id": "cb2", "name": "MCCB 400", "rated_current_a": 400}}, headers=admin)
    return lib, admin


def test_base_versions_validated_and_roundtrip(client):
    h = _login(client, "u1@x.com")
    doc = lambda base: {"format": "overrides", "version": 3, "cbs": {"set": [{"id": "cb1", "name": "x"}], "removed": [], "base": base}}
    ok = client.put("/api/user-libraries", json={"data": doc({"cb1": {"library": 1, "version": 2}})}, headers=h)
    assert ok.status_code == 200 and ok.json()["data"]["cbs"]["base"]["cb1"] == {"library": 1, "version": 2}
    for bad in ({"cb1": 5}, {"cb1": {"library": 1, "version": 0}}, {"cb1": {"library": "a", "version": 1}}, [1]):
        assert client.put("/api/user-libraries", json={"data": doc(bad)}, headers=h).status_code == 422


def test_company_change_notifies_overrider_once_and_only_if_unreviewed(client):
    lib, admin = _setup(client)
    u, other = _login(client, "u2@x.com"), _login(client, "u3@x.com")
    # u2 overrides cb1 (based on v1); u3 overrides cb2 and has already reviewed v2 of it
    client.put("/api/user-libraries", headers=u, json={"data": {"format": "overrides", "version": 3,
        "cbs": {"set": [{"id": "cb1", "name": "My MCCB 250"}], "removed": [], "base": {"cb1": {"library": lib, "version": 1}}}}})
    client.put("/api/user-libraries", headers=other, json={"data": {"format": "overrides", "version": 3,
        "cbs": {"set": [{"id": "cb2", "name": "Mine"}], "removed": [], "base": {"cb2": {"library": lib, "version": 2}}}}})
    client.put(f"{LIB}/{lib}/entries/cbs/cb1", json={"data": {"id": "cb1", "name": "MCCB 250", "rated_current_a": 260}, "base_version": 1}, headers=admin)
    client.put(f"{LIB}/{lib}/entries/cbs/cb2", json={"data": {"id": "cb2", "name": "MCCB 400", "rated_current_a": 410}, "base_version": 1}, headers=admin)
    n = _drift_notes(client, u)
    assert len(n) == 1 and "My MCCB 250" in n[0]["message"] and "out of date" in n[0]["message"]
    assert n[0]["link"] == {"type": "library", "id": lib, "drift": True}
    assert _drift_notes(client, other) == []                 # v2 already reviewed (cb2 is now v2)
    assert _drift_notes(client, admin) == []                # the editor is never told
    # a second change coalesces into the same unread notification
    client.put(f"{LIB}/{lib}/entries/cbs/cb1", json={"data": {"id": "cb1", "name": "MCCB 250", "rated_current_a": 270}, "base_version": 2}, headers=admin)
    n = _drift_notes(client, u)
    assert len(n) == 1 and n[0]["count"] == 2


def test_batch_publish_and_non_overriders(client):
    lib, admin = _setup(client)
    u = _login(client, "u4@x.com")           # no overrides at all
    client.put(f"{LIB}/{lib}/entries/cbs/cb1", json={"data": {"id": "cb1", "name": "MCCB 250", "rated_current_a": 99}, "base_version": 1}, headers=admin)
    assert _drift_notes(client, u) == []
    w = _login(client, "u5@x.com")
    client.put("/api/user-libraries", headers=w, json={"data": {"format": "overrides", "version": 3,
        "cbs": {"set": [{"id": "cb1", "name": "A"}, {"id": "cb2", "name": "B"}], "removed": []}}})   # no base recorded
    r = client.post(f"{LIB}/{lib}/entries/upsert", headers=admin, json={"entries": [
        {"kind": "cbs", "data": {"id": "cb1", "name": "MCCB 250", "rated_current_a": 100}, "base_version": 2},
        {"kind": "cbs", "data": {"id": "cb2", "name": "MCCB 400", "rated_current_a": 100}, "base_version": 1},
        {"kind": "rates", "data": {"id": "R-1", "rate": 1}}]}).json()
    assert len(r["updated"]) == 2 and not r["conflicts"]
    n = _drift_notes(client, w)
    assert len(n) == 1 and n[0]["message"].startswith("2 of your edited")
