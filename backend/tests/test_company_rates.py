"""Company price list: `rates` library kind validation, any admin edits the company
standard, library currency, and the batch upsert used to publish rates."""

import os
import tempfile

_TMP_DIR = tempfile.mkdtemp(prefix="protectionpro-test-rates-")
_TEST_DB_URL = f"sqlite:///{_TMP_DIR}/test_company_rates.db"
os.environ["DATABASE_URL"] = _TEST_DB_URL

from backend.models import database as _database  # noqa: E402
from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402
import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from backend.main import app  # noqa: E402

API = "/api/shared-libraries"
_ADMIN = {}


@pytest.fixture(scope="module")
def client():
    _database.engine = create_engine(_TEST_DB_URL, connect_args={"check_same_thread": False})
    _database.SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=_database.engine)
    with TestClient(app) as c:
        yield c


def _login(client, email, admin=False):
    if not _ADMIN:
        r = client.post("/api/auth/register", json={"email": "admin@x.com", "password": "password123"})
        _ADMIN["h"] = {"Authorization": f"Bearer {r.json()['access_token']}"}
    r = client.post("/api/auth/login", json={"email": email, "password": "password123"})
    if r.status_code != 200:
        code = client.post("/api/auth/invites", json={"is_admin": admin}, headers=_ADMIN["h"]).json()["code"]
        r = client.post("/api/auth/register",
                        json={"email": email, "password": "password123", "invite_code": code})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def _company(client):
    """A company library owned by a regular user (so 'any admin edits' is exercised)."""
    _login(client, "admin@x.com")
    owner = _login(client, "owner@x.com")
    lib = client.post(API, json={"name": "Acme"}, headers=owner).json()["id"]
    r = client.put(f"{API}/{lib}/company-default", json={"value": True}, headers=_ADMIN["h"])
    assert r.status_code == 200, r.text
    return lib, owner


RATE = {"id": "CBL-95-AL-XLPE-LV", "rate": 318.5, "labour": 40, "waste": 5, "supplier": "ACME",
        "priceDate": "2026-10-01"}


def test_rates_kind_validation(client):
    lib, owner = _company(client)
    put = lambda eid, data, h=owner: client.put(f"{API}/{lib}/entries/rates/{eid}", json={"data": data}, headers=h)
    assert put(RATE["id"], RATE).status_code == 200
    assert put("BAD KEY!", {"id": "BAD KEY!", "rate": 1}).status_code == 422
    assert put("K1", {"id": "K1", "rate": -1}).status_code == 422
    assert put("K1", {"id": "K1", "rate": "12"}).status_code == 422
    assert put("K1", {"id": "K1", "rate": True}).status_code == 422
    assert put("K1", {"id": "K1", "rule": {"basis": "fixed"}}).status_code == 422     # rules stay in the project
    assert put("K1", {"id": "K1", "priceDate": "1 Oct 2026"}).status_code == 422
    assert put("K1", {"id": "K1", "rate": None, "labour": 12}).status_code == 200


def test_any_admin_edits_company_standard_others_only_read(client):
    lib, _ = _company(client)
    admin, other = _ADMIN["h"], _login(client, "plain@x.com")
    r = client.put(f"{API}/{lib}/entries/rates/ADM-1", json={"data": {"id": "ADM-1", "rate": 5}}, headers=admin)
    assert r.status_code == 200, r.text
    assert client.get(API, headers=admin).json()[0]["role"] in ("edit", "owner")
    r = client.put(f"{API}/{lib}/entries/rates/USR-1", json={"data": {"id": "USR-1", "rate": 5}}, headers=other)
    assert r.status_code == 403
    mine = [x for x in client.get(API, headers=other).json() if x["id"] == lib][0]
    assert mine["role"] == "view"
    assert any(e["id"] == "ADM-1" for e in mine["entries"])          # everyone reads the company price list


def test_currency(client):
    lib, owner = _company(client)
    other = _login(client, "plain@x.com")
    assert client.put(f"{API}/{lib}/currency", json={"currency": "R"}, headers=other).status_code == 403
    assert client.put(f"{API}/{lib}/currency", json={"currency": ""}, headers=_ADMIN["h"]).status_code == 422
    assert client.put(f"{API}/{lib}/currency", json={"currency": "123456789"}, headers=_ADMIN["h"]).status_code == 422
    r = client.put(f"{API}/{lib}/currency", json={"currency": " ZAR "}, headers=_ADMIN["h"])
    assert r.status_code == 200 and r.json()["currency"] == "ZAR"
    assert [x for x in client.get(API, headers=other).json() if x["id"] == lib][0]["currency"] == "ZAR"
    n = client.get("/api/notifications", headers=other).json()["items"]
    assert any(i["kind"] == "library_currency_changed" and "ZAR" in i["message"] for i in n)


def test_upsert_create_update_unchanged_conflict(client):
    lib, owner = _company(client)
    other = _login(client, "plain2@x.com")
    up = lambda entries, h=owner: client.post(f"{API}/{lib}/entries/upsert", json={"entries": entries}, headers=h)
    a = {"id": "UPS-A", "rate": 10}
    b = {"id": "UPS-B", "rate": 20}
    r = up([{"kind": "rates", "data": a}, {"kind": "rates", "data": b}]).json()
    assert [c["id"] for c in r["created"]] == ["UPS-A", "UPS-B"] and not r["updated"] and not r["conflicts"]
    # update A with its version; B unchanged (skipped); C created
    r = up([{"kind": "rates", "data": {"id": "UPS-A", "rate": 11}, "base_version": 1},
            {"kind": "rates", "data": b, "base_version": 1},
            {"kind": "rates", "data": {"id": "UPS-C", "rate": 1}}]).json()
    assert [(c["id"], c["version"]) for c in r["updated"]] == [("UPS-A", 2)]
    assert [c["id"] for c in r["created"]] == ["UPS-C"] and not r["conflicts"]
    # stale base_version, and a create that collides, are reported not applied
    r = up([{"kind": "rates", "data": {"id": "UPS-A", "rate": 99}, "base_version": 1},
            {"kind": "rates", "data": {"id": "UPS-B", "rate": 99}},
            {"kind": "rates", "data": {"id": "UPS-D", "rate": 4}}]).json()
    assert {c["id"] for c in r["conflicts"]} == {"UPS-A", "UPS-B"}
    assert [c["id"] for c in r["created"]] == ["UPS-D"]
    assert [x for x in r["conflicts"] if x["id"] == "UPS-A"][0]["current"]["data"]["rate"] == 11
    # a non-editor cannot publish
    assert up([{"kind": "rates", "data": {"id": "UPS-Z", "rate": 1}}], other).status_code == 403
    # validation rejects the whole call
    assert up([{"kind": "rates", "data": {"id": "UPS-E", "rate": -5}}]).status_code == 422
    # one notification per batch, not one per entry
    notes = [i for i in client.get("/api/notifications", headers=other).json()["items"]
             if i["kind"] == "library_entries_published"]
    assert len(notes) == 3 and "(1 new, 1 updated)" in notes[1]["message"]   # newest first
