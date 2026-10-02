"""Submissions to the company library: submit → admin decides (approve writes a versioned
company entry; request changes / reject notify), never your own, conflicts, resubmit, withdraw."""

import os
import tempfile

_TMP_DIR = tempfile.mkdtemp(prefix="protectionpro-test-subm-")
_TEST_DB_URL = f"sqlite:///{_TMP_DIR}/test_library_submissions.db"
os.environ["DATABASE_URL"] = _TEST_DB_URL

from backend.models import database as _database  # noqa: E402
from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402
import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from backend.main import app  # noqa: E402

S = "/api/library-submissions"
LIB = "/api/shared-libraries"
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
        r = client.post("/api/auth/register", json={"email": email, "password": "password123", "invite_code": code})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def _setup(client):
    _login(client, "admin@x.com")
    admin = _ADMIN["h"]
    company = [l for l in client.get(LIB, headers=admin).json() if l["is_company_default"]]
    if not company:
        lib = client.post(LIB, json={"name": "Acme"}, headers=admin).json()["id"]
        client.put(f"{LIB}/{lib}/company-default", json={"value": True}, headers=admin)
    else:
        lib = company[0]["id"]
    return lib, admin


def _notes(client, h, kind):
    return [n for n in client.get("/api/notifications", headers=h).json()["items"] if n["kind"] == kind]


def _entries(client, h, lib):
    return {e["id"]: e for l in client.get(LIB, headers=h).json() if l["id"] == lib for e in l["entries"]}


def test_needs_company_library_and_validates(client):
    u = _login(client, "s0@x.com")
    r = client.post(S, json={"entries": [{"kind": "cbs", "data": {"id": "x", "name": "X"}}]}, headers=u)
    assert r.status_code == 409                                  # no company library yet
    lib, admin = _setup(client)
    for bad in ([], [{"kind": "nope", "data": {"id": "x"}}], [{"kind": "rates", "data": {"id": "R", "rate": -1}}]):
        assert client.post(S, json={"entries": bad}, headers=u).status_code == 422


def test_submit_approve_writes_versioned_company_entry_and_notifies(client):
    lib, admin = _setup(client)
    u, other = _login(client, "s1@x.com"), _login(client, "s2@x.com")
    r = client.post(S, json={"entries": [{"kind": "cbs", "data": {"id": "my_cb", "name": "My MCCB", "rated_current_a": 250}}],
                             "note": "Used on every job"}, headers=u)
    assert r.status_code == 200, r.text
    sub = r.json()[0]
    assert sub["status"] == "pending" and sub["change_type"] == "new" and sub["submitter"] == "s1@x.com"
    assert _notes(client, admin, "submission_received")[0]["category"] == "approvals"
    assert _notes(client, u, "submission_received") == []        # the submitter is not told about their own
    # visibility: submitter sees theirs, another user sees none, admin sees all
    assert [x["id"] for x in client.get(S, headers=u).json()] == [sub["id"]]
    assert client.get(S, headers=other).json() == []
    assert client.get(f"{S}/{sub['id']}", headers=other).status_code == 404
    # non-admins cannot decide
    assert client.post(f"{S}/decide", json={"ids": [sub["id"]], "action": "approve"}, headers=u).status_code == 403
    r = client.post(f"{S}/decide", json={"ids": [sub["id"]], "action": "approve", "note": "Thanks"}, headers=admin).json()
    assert r["done"] == [sub["id"]] and not r["errors"]
    e = _entries(client, admin, lib)["my_cb"]
    assert e["version"] == 1 and e["data"]["name"] == "My MCCB"
    n = _notes(client, u, "submission_approved")[0]
    assert "approved" in n["message"] and n["category"] == "approvals"
    assert client.get(S, headers=u).json()[0]["status"] == "approved"
    assert client.get(S, headers=u, params={"status": "pending"}).json() == []
    # everyone else heard the company library changed
    assert any("my_cb" in i["message"] or "My MCCB" in i["message"] for i in client.get("/api/notifications", headers=other).json()["items"])


def test_change_conflict_force_and_never_your_own(client):
    lib, admin = _setup(client)
    u = _login(client, "s3@x.com")
    client.put(f"{LIB}/{lib}/entries/cbs/chg", json={"data": {"id": "chg", "name": "Orig", "rated_current_a": 100}}, headers=admin)
    sub = client.post(S, json={"entries": [{"kind": "cbs", "data": {"id": "chg", "name": "Better", "rated_current_a": 100}}]}, headers=u).json()[0]
    assert sub["change_type"] == "change" and sub["base_version"] == 1
    # the company edits it meanwhile -> approving reports a conflict with the current entry
    client.put(f"{LIB}/{lib}/entries/cbs/chg", json={"data": {"id": "chg", "name": "Orig2", "rated_current_a": 110}, "base_version": 1}, headers=admin)
    r = client.post(f"{S}/decide", json={"ids": [sub["id"]], "action": "approve"}, headers=admin).json()
    assert r["done"] == [] and r["errors"][0]["conflict"]["current"]["version"] == 2
    detail = client.get(f"{S}/{sub['id']}", headers=admin).json()
    assert detail["current"]["version"] == 2 and detail["status"] == "pending"
    r = client.post(f"{S}/decide", json={"ids": [sub["id"]], "action": "approve", "force": True}, headers=admin).json()
    assert r["done"] == [sub["id"]]
    assert _entries(client, admin, lib)["chg"]["version"] == 3
    # an admin cannot decide their own submission
    mine = client.post(S, json={"entries": [{"kind": "cbs", "data": {"id": "adm1", "name": "A"}}]}, headers=admin).json()[0]
    r = client.post(f"{S}/decide", json={"ids": [mine["id"]], "action": "approve"}, headers=admin).json()
    assert r["done"] == [] and "own" in r["errors"][0]["error"]


def test_request_changes_resubmit_reject_withdraw(client):
    lib, admin = _setup(client)
    u = _login(client, "s4@x.com")
    sub = client.post(S, json={"entries": [{"kind": "rates", "data": {"id": "TRM-70", "rate": 90}}], "note": "n"}, headers=u).json()[0]
    assert client.post(f"{S}/decide", json={"ids": [sub["id"]], "action": "request_changes"}, headers=admin).status_code == 422
    client.post(f"{S}/decide", json={"ids": [sub["id"]], "action": "request_changes", "note": "Price date missing"}, headers=admin)
    n = _notes(client, u, "submission_changes_requested")[0]
    assert "Price date missing" in n["message"]
    assert client.get(f"{S}/counts", headers=u).json()["changes_requested"] == 1
    # cannot approve something waiting on the submitter
    r = client.post(f"{S}/decide", json={"ids": [sub["id"]], "action": "approve"}, headers=admin).json()
    assert r["done"] == [] and r["errors"]
    r = client.post(f"{S}/{sub['id']}/resubmit", json={"data": {"id": "TRM-70", "rate": 90, "priceDate": "2026-10-02"}}, headers=u)
    assert r.status_code == 200 and r.json()["status"] == "pending" and r.json()["data"]["priceDate"] == "2026-10-02"
    assert client.get(f"{S}/counts", headers=admin).json()["waiting"] >= 1
    client.post(f"{S}/decide", json={"ids": [sub["id"]], "action": "reject", "note": "Not standard"}, headers=admin)
    assert client.get(f"{S}/{sub['id']}", headers=u).json()["status"] == "rejected"
    assert client.post(f"{S}/{sub['id']}/resubmit", json={}, headers=u).status_code == 409
    assert client.delete(f"{S}/{sub['id']}", headers=u).status_code == 409           # decided: cannot withdraw
    # a fresh one can be withdrawn; only by its submitter
    s2 = client.post(S, json={"entries": [{"kind": "rates", "data": {"id": "TRM-95", "rate": 1}}]}, headers=u).json()[0]
    assert client.delete(f"{S}/{s2['id']}", headers=admin).status_code == 404
    assert client.delete(f"{S}/{s2['id']}", headers=u).status_code == 200
    assert client.get(f"{S}/{s2['id']}", headers=u).status_code == 404


def test_batch_submit_replace_open_and_batch_decision(client):
    lib, admin = _setup(client)
    u = _login(client, "s5@x.com")
    entries = [{"kind": "rates", "data": {"id": f"B-{i}", "rate": i + 1}} for i in range(3)]
    subs = client.post(S, json={"entries": entries, "note": "batch"}, headers=u).json()
    assert len(subs) == 3 and len({s["batch"] for s in subs}) == 1
    assert len([n for n in _notes(client, admin, "submission_received") if "3 entries" in n["message"]]) == 1
    # re-submitting the same entry replaces the open one instead of adding a second
    again = client.post(S, json={"entries": [{"kind": "rates", "data": {"id": "B-0", "rate": 99}}]}, headers=u).json()
    assert again[0]["id"] == subs[0]["id"] and again[0]["data"]["rate"] == 99
    assert len(client.get(S, headers=u).json()) >= 3
    r = client.post(f"{S}/decide", json={"ids": [s["id"] for s in subs], "action": "approve"}, headers=admin).json()
    assert len(r["done"]) == 3
    ents = _entries(client, admin, lib)
    assert ents["B-0"]["data"]["rate"] == 99 and "B-2" in ents
    # exactly what the company has is not a submission
    assert client.post(S, json={"entries": [{"kind": "rates", "data": {"id": "B-1", "rate": 2}}]}, headers=u).status_code == 422
    n = _notes(client, u, "submission_approved")
    assert len(n) == 1 and "3 of your submissions" in n[0]["message"]


def test_approver_role_reviews_without_being_admin(client):
    lib, admin = _setup(client)
    appr, user = _login(client, "ap1@x.com"), _login(client, "ap2@x.com")
    me = client.get("/api/auth/me", headers=appr).json()
    assert me["is_approver"] is False
    sub = client.post(S, json={"entries": [{"kind": "cbs", "data": {"id": "ap_cb", "name": "AP CB"}}]}, headers=user).json()[0]
    # nobody but reviewers sees the queue or decides
    assert client.get(S, headers=appr).json() == []
    assert client.post(f"{S}/decide", json={"ids": [sub["id"]], "action": "approve"}, headers=appr).status_code == 403
    # only an admin can make someone an approver
    assert client.patch(f"/api/auth/users/{me['id']}/approver", json={"is_approver": True}, headers=user).status_code == 403
    assert client.patch(f"/api/auth/users/{me['id']}/approver", json={"is_approver": True}, headers=admin).json()["is_approver"] is True
    assert client.get("/api/auth/me", headers=appr).json()["is_approver"] is True
    assert sub["id"] in [x["id"] for x in client.get(S, headers=appr).json()]
    assert client.get(f"{S}/counts", headers=appr).json()["waiting"] >= 1
    # approvers are told about NEW submissions too
    s2 = client.post(S, json={"entries": [{"kind": "cbs", "data": {"id": "ap_cb2", "name": "AP CB 2"}}]}, headers=user).json()[0]
    assert any("AP CB 2" in n["message"] for n in client.get("/api/notifications", headers=appr).json()["items"])
    r = client.post(f"{S}/decide", json={"ids": [sub["id"], s2["id"]], "action": "approve"}, headers=appr).json()
    assert len(r["done"]) == 2
    assert _entries(client, admin, lib)["ap_cb"]["version"] == 1
    # an approver cannot decide their own submission either
    mine = client.post(S, json={"entries": [{"kind": "cbs", "data": {"id": "ap_own", "name": "Own"}}]}, headers=appr).json()[0]
    r = client.post(f"{S}/decide", json={"ids": [mine["id"]], "action": "approve"}, headers=appr).json()
    assert r["done"] == [] and "own" in r["errors"][0]["error"]
    # removing the role takes the access away again
    client.patch(f"/api/auth/users/{me['id']}/approver", json={"is_approver": False}, headers=admin)
    assert client.post(f"{S}/decide", json={"ids": [mine["id"]], "action": "reject"}, headers=appr).status_code == 403


def test_restore_version_is_recorded_in_history(client):
    lib, admin = _setup(client)
    P = f"{LIB}/{lib}/entries/cbs/rest1"
    client.put(P, json={"data": {"id": "rest1", "name": "A", "rated_current_a": 100}}, headers=admin)
    client.put(P, json={"data": {"id": "rest1", "name": "A", "rated_current_a": 200}, "base_version": 1}, headers=admin)
    r = client.put(P, json={"data": {"id": "rest1", "name": "A", "rated_current_a": 100}, "base_version": 2, "restored_from": 1}, headers=admin)
    assert r.status_code == 200 and r.json()["version"] == 3
    hist = client.get(f"{LIB}/activity", params={"entry_id": "rest1"}, headers=admin).json()
    assert hist[0]["detail"] == "restored from v1" and hist[0]["version"] == 3
    client.delete(P, headers=admin)
    gone = client.get(f"{LIB}/activity", params={"entry_id": "rest1", "action": "entry_deleted"}, headers=admin).json()[0]
    r = client.put(P, json={"data": gone["data"], "restored_from": 3}, headers=admin)          # undelete = create again
    assert r.status_code == 200 and r.json()["version"] == 1
