"""Shared (team) libraries: membership + roles, company standard, per-entry versioned
saves (409 on a stale save), isolation, cascades."""

import os
import tempfile

_TMP_DIR = tempfile.mkdtemp(prefix="protectionpro-test-sharedlib-")
_TEST_DB_URL = f"sqlite:///{_TMP_DIR}/test_shared_libraries.db"
os.environ["DATABASE_URL"] = _TEST_DB_URL

from backend.models import database as _database  # noqa: E402
from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402
import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from backend.main import app  # noqa: E402


@pytest.fixture(scope="module")
def client():
    _database.engine = create_engine(_TEST_DB_URL, connect_args={"check_same_thread": False})
    _database.SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=_database.engine)
    with TestClient(app) as c:
        yield c


_ADMIN = {}
_ME = {}


def _login(client, email):
    """First registrant is the admin; everyone after needs an admin-minted invite."""
    if not _ADMIN:
        r = client.post("/api/auth/register", json={"email": "admin@x.com", "password": "password123"})
        _ADMIN["h"] = {"Authorization": f"Bearer {r.json()['access_token']}"}
    r = client.post("/api/auth/login", json={"email": email, "password": "password123"})
    if r.status_code != 200:
        code = client.post("/api/auth/invites", json={}, headers=_ADMIN["h"]).json()["code"]
        r = client.post("/api/auth/register",
                        json={"email": email, "password": "password123", "invite_code": code})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def _uid(client, h):
    return client.get("/api/auth/me", headers=h).json()["id"]


def _admin(client):
    _login(client, "admin@x.com")
    return _ADMIN["h"]


XF = {"id": "custom_xfmr_1", "name": "Team 2MVA", "rated_mva": 2}
API = "/api/shared-libraries"


def _new_lib(client, h, name="Team"):
    r = client.post(API, json={"name": name}, headers=h)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_requires_auth(client):
    assert client.get(API, headers={"Authorization": ""}).status_code in (401, 403)


def test_create_list_rename_delete(client):
    o = _login(client, "own1@x.com")
    lid = _new_lib(client, o, "Ops")
    libs = client.get(API, headers=o).json()
    mine = [l for l in libs if l["id"] == lid][0]
    assert mine["role"] == "owner" and mine["name"] == "Ops" and mine["entries"] == []
    assert client.patch(f"{API}/{lid}", json={"name": "Ops 2"}, headers=o).json()["name"] == "Ops 2"
    assert client.post(API, json={"name": "  "}, headers=o).status_code == 422
    assert client.delete(f"{API}/{lid}", headers=o).status_code == 200
    assert all(l["id"] != lid for l in client.get(API, headers=o).json())


def test_isolation_and_membership_roles(client):
    o = _login(client, "own2@x.com")
    e = _login(client, "edit2@x.com")
    v = _login(client, "view2@x.com")
    x = _login(client, "stranger2@x.com")
    lid = _new_lib(client, o)
    # a stranger can neither see nor touch it (404, no existence leak)
    assert all(l["id"] != lid for l in client.get(API, headers=x).json())
    assert client.put(f"{API}/{lid}/entries/transformers/custom_xfmr_1",
                      json={"data": XF}, headers=x).status_code == 404
    # add members
    assert client.post(f"{API}/{lid}/members", json={"email": "edit2@x.com", "role": "edit"}, headers=o).status_code == 200
    assert client.post(f"{API}/{lid}/members", json={"email": "view2@x.com", "role": "view"}, headers=o).status_code == 200
    assert client.post(f"{API}/{lid}/members", json={"email": "nobody@x.com"}, headers=o).status_code == 404
    assert client.post(f"{API}/{lid}/members", json={"email": "own2@x.com"}, headers=o).status_code == 400
    # editor writes; viewer reads but cannot write; only owner manages members
    assert client.put(f"{API}/{lid}/entries/transformers/custom_xfmr_1", json={"data": XF}, headers=e).status_code == 200
    assert client.put(f"{API}/{lid}/entries/transformers/custom_xfmr_1",
                      json={"data": XF, "base_version": 1}, headers=v).status_code == 403
    seen = [l for l in client.get(API, headers=v).json() if l["id"] == lid][0]
    assert seen["role"] == "view" and [en["id"] for en in seen["entries"]] == ["custom_xfmr_1"]
    assert seen["entries"][0]["updated_by"] == "edit2@x.com"
    assert client.get(f"{API}/{lid}/members", headers=e).status_code == 403
    assert client.post(f"{API}/{lid}/members", json={"email": "x@x.com"}, headers=e).status_code == 403
    assert client.patch(f"{API}/{lid}", json={"name": "hijack"}, headers=e).status_code == 403
    assert client.delete(f"{API}/{lid}", headers=e).status_code == 403
    # role change + member list
    uid_v = _uid(client, v)
    client.patch(f"{API}/{lid}/members/{uid_v}", json={"role": "edit"}, headers=o)
    assert {m["email"]: m["role"] for m in client.get(f"{API}/{lid}/members", headers=o).json()}["view2@x.com"] == "edit"
    # removing a member takes the library away from them
    client.delete(f"{API}/{lid}/members/{uid_v}", headers=o)
    assert all(l["id"] != lid for l in client.get(API, headers=v).json())


def test_member_can_leave_but_not_remove_others(client):
    o = _login(client, "own3@x.com")
    a = _login(client, "a3@x.com")
    b = _login(client, "b3@x.com")
    lid = _new_lib(client, o)
    for em in ("a3@x.com", "b3@x.com"):
        client.post(f"{API}/{lid}/members", json={"email": em, "role": "view"}, headers=o)
    assert client.delete(f"{API}/{lid}/members/{_uid(client, b)}", headers=a).status_code == 403
    assert client.delete(f"{API}/{lid}/members/{_uid(client, a)}", headers=a).status_code == 200
    assert all(l["id"] != lid for l in client.get(API, headers=a).json())
    assert any(l["id"] == lid for l in client.get(API, headers=b).json())


def test_versioned_entries_reject_stale_saves(client):
    o = _login(client, "own4@x.com")
    e = _login(client, "edit4@x.com")
    lid = _new_lib(client, o)
    client.post(f"{API}/{lid}/members", json={"email": "edit4@x.com", "role": "edit"}, headers=o)
    url = f"{API}/{lid}/entries/transformers/custom_xfmr_1"
    r = client.put(url, json={"data": XF}, headers=o)
    assert r.status_code == 200 and r.json()["version"] == 1
    # creating again without a base version is a conflict, never an overwrite
    assert client.put(url, json={"data": {**XF, "rated_mva": 9}}, headers=e).status_code == 409
    # both load version 1; the editor saves first
    assert client.put(url, json={"data": {**XF, "rated_mva": 3}, "base_version": 1}, headers=e).json()["version"] == 2
    # the owner's save was based on version 1: refused, told who changed it, current entry returned
    r = client.put(url, json={"data": {**XF, "rated_mva": 5}, "base_version": 1}, headers=o)
    assert r.status_code == 409
    d = r.json()["detail"]
    assert "edit4@x.com" in d["message"] and d["current"]["version"] == 2 and d["current"]["data"]["rated_mva"] == 3
    # retrying with the fresh version succeeds
    assert client.put(url, json={"data": {**XF, "rated_mva": 5}, "base_version": 2}, headers=o).json()["version"] == 3
    # stale delete refused; current delete works; deleting twice is fine
    assert client.delete(f"{url}?base_version=1", headers=e).status_code == 409
    assert client.delete(f"{url}?base_version=3", headers=e).status_code == 200
    assert client.delete(url, headers=e).status_code == 200
    # editing something that was deleted under you is a conflict too
    assert client.put(url, json={"data": XF, "base_version": 3}, headers=o).status_code == 409


@pytest.mark.parametrize("kind,eid,data,code", [
    ("nope", "a", {"id": "a"}, 422),                    # unknown library
    ("cables", "a", {"id": "b"}, 422),                  # id must match the path
    ("cables", "a", {"name": "no id"}, 422),            # entry without id
    ("cables", "a", {"id": "a", "blob": "x" * 300000}, 413),   # too large
])
def test_entry_validation(client, kind, eid, data, code):
    o = _login(client, "val@x.com")
    lid = _new_lib(client, o)
    assert client.put(f"{API}/{lid}/entries/{kind}/{eid}", json={"data": data}, headers=o).status_code == code


def test_bulk_import_is_create_only(client):
    o = _login(client, "own5@x.com")
    lid = _new_lib(client, o)
    client.put(f"{API}/{lid}/entries/fuses/f1", json={"data": {"id": "f1", "name": "orig"}}, headers=o)
    r = client.post(f"{API}/{lid}/entries/import", headers=o, json={"entries": [
        {"kind": "fuses", "data": {"id": "f1", "name": "CHANGED"}},
        {"kind": "fuses", "data": {"id": "f2", "name": "new"}},
        {"kind": "cbs", "data": {"id": "c1", "name": "cb"}}]}).json()
    assert r["skipped"] == [{"kind": "fuses", "id": "f1"}]
    assert {(c["kind"], c["id"]) for c in r["created"]} == {("fuses", "f2"), ("cbs", "c1")}
    lib = [l for l in client.get(API, headers=o).json() if l["id"] == lid][0]
    assert {en["id"]: en["data"]["name"] for en in lib["entries"] if en["kind"] == "fuses"}["f1"] == "orig"


def test_company_default_is_admin_only_single_and_read_only(client):
    admin = _admin(client)
    o = _login(client, "own6@x.com")
    u = _login(client, "user6@x.com")
    company = _new_lib(client, admin, "Company standard")
    other = _new_lib(client, admin, "Other")
    client.put(f"{API}/{company}/entries/cables/c1", json={"data": {"id": "c1", "name": "Std cable"}}, headers=admin)
    # a non-admin cannot designate it
    assert client.put(f"{API}/{company}/company-default", json={"value": True}, headers=o).status_code == 403
    assert client.put(f"{API}/{company}/company-default", json={"value": True}, headers=admin).status_code == 200
    # everyone now reads it, read-only, without being a member
    seen = [l for l in client.get(API, headers=u).json() if l["id"] == company][0]
    assert seen["role"] == "view" and seen["is_company_default"] and seen["entries"][0]["id"] == "c1"
    assert client.put(f"{API}/{company}/entries/cables/c2", json={"data": {"id": "c2"}}, headers=u).status_code == 403
    # only one company standard at a time
    client.put(f"{API}/{other}/company-default", json={"value": True}, headers=admin)
    flags = {l["id"]: l["is_company_default"] for l in client.get(API, headers=admin).json()}
    assert flags[other] is True and flags[company] is False
    assert all(l["id"] != company for l in client.get(API, headers=u).json())
    # clearing works
    client.put(f"{API}/{other}/company-default", json={"value": False}, headers=admin)
    assert all(l["id"] != other for l in client.get(API, headers=u).json())


def test_deleting_library_cascades(client):
    o = _login(client, "own7@x.com")
    m = _login(client, "mem7@x.com")
    lid = _new_lib(client, o)
    client.post(f"{API}/{lid}/members", json={"email": "mem7@x.com"}, headers=o)
    client.put(f"{API}/{lid}/entries/cbs/c1", json={"data": {"id": "c1"}}, headers=o)
    client.delete(f"{API}/{lid}", headers=o)
    s = _database.SessionLocal()
    try:
        assert s.query(_database.SharedLibraryEntry).filter_by(library_id=lid).count() == 0
        assert s.query(_database.SharedLibraryMember).filter_by(library_id=lid).count() == 0
    finally:
        s.close()
    assert all(l["id"] != lid for l in client.get(API, headers=m).json())
