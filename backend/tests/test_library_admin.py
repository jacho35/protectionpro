"""Library admin tools: activity log / entry history, retiring entries, handing a library to
another owner, layer order validation, and opt-in notification emails."""

import os
import tempfile

_TMP_DIR = tempfile.mkdtemp(prefix="protectionpro-test-libadmin-")
_TEST_DB_URL = f"sqlite:///{_TMP_DIR}/test_library_admin.db"
os.environ["DATABASE_URL"] = _TEST_DB_URL

from backend.models import database as _database  # noqa: E402
from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402
import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from backend.main import app  # noqa: E402
from backend import notifications as _notifications, mailer as _mailer  # noqa: E402

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


def _uid(client, h):
    return client.get("/api/auth/me", headers=h).json()["id"]


def _company(client):
    _login(client, "admin@x.com")
    admin = _ADMIN["h"]
    c = [l for l in client.get(LIB, headers=admin).json() if l["is_company_default"]]
    if c:
        return c[0]["id"], admin
    lib = client.post(LIB, json={"name": "Acme"}, headers=admin).json()["id"]
    client.put(f"{LIB}/{lib}/company-default", json={"value": True}, headers=admin)
    return lib, admin


def test_activity_log_records_entries_and_library_events(client):
    lib, admin = _company(client)
    h = {"Authorization": admin["Authorization"]}
    client.put(f"{LIB}/{lib}/entries/cbs/h1", json={"data": {"id": "h1", "name": "MCCB", "rated_current_a": 100}}, headers=h)
    client.put(f"{LIB}/{lib}/entries/cbs/h1", json={"data": {"id": "h1", "name": "MCCB", "rated_current_a": 125}, "base_version": 1}, headers=h)
    client.put(f"{LIB}/{lib}/currency", json={"currency": "ZAR"}, headers=h)
    hist = client.get(f"{LIB}/activity", params={"entry_id": "h1"}, headers=h).json()
    assert [(x["action"], x["version"]) for x in hist] == [("entry_updated", 2), ("entry_created", 1)]
    assert hist[0]["data"]["rated_current_a"] == 125 and hist[0]["by"] == "admin@x.com"
    allx = [x["action"] for x in client.get(f"{LIB}/activity", params={"library_id": lib}, headers=h).json()]
    assert "company_designated" in allx and "currency_changed" in allx
    client.delete(f"{LIB}/{lib}/entries/cbs/h1", headers=h)
    assert client.get(f"{LIB}/activity", params={"entry_id": "h1", "action": "entry_deleted"}, headers=h).json()[0]["data"]["rated_current_a"] == 125


def test_activity_visibility_for_non_admins(client):
    lib, admin = _company(client)
    other = _login(client, "a1@x.com")
    mine = client.post(LIB, json={"name": "Private"}, headers=other).json()["id"]
    secret = client.post(LIB, json={"name": "Hidden"}, headers=admin).json()["id"]
    got = client.get(f"{LIB}/activity", params={"limit": 1000}, headers=other).json()
    ids = {x["library_id"] for x in got}
    assert mine in ids and lib in ids and secret not in ids          # own + the company standard; not someone's private one
    assert secret in {x["library_id"] for x in client.get(f"{LIB}/activity", params={"limit": 1000}, headers=admin).json()}


def test_retire_and_restore(client):
    lib, admin = _company(client)
    plain = _login(client, "r1@x.com")
    client.put(f"{LIB}/{lib}/entries/cbs/old1", json={"data": {"id": "old1", "name": "Old MCCB"}}, headers=admin)
    assert client.put(f"{LIB}/{lib}/entries/cbs/old1/retired", json={"value": True}, headers=plain).status_code == 403
    r = client.put(f"{LIB}/{lib}/entries/cbs/old1/retired", json={"value": True}, headers=admin)
    assert r.status_code == 200 and r.json()["retired"] is True and r.json()["version"] == 1      # no new version
    ents = {e["id"]: e for l in client.get(LIB, headers=plain).json() if l["id"] == lib for e in l["entries"]}
    assert ents["old1"]["retired"] is True
    n = [i for i in client.get("/api/notifications", headers=plain).json()["items"] if i["kind"] == "library_entry_retired"]
    assert n and "retired" in n[0]["message"]
    assert client.put(f"{LIB}/{lib}/entries/cbs/nope/retired", json={"value": True}, headers=admin).status_code == 404
    assert client.put(f"{LIB}/{lib}/entries/cbs/old1/retired", json={"value": False}, headers=admin).json()["retired"] is False
    acts = [x["action"] for x in client.get(f"{LIB}/activity", params={"entry_id": "old1"}, headers=admin).json()]
    assert acts[:2] == ["entry_restored", "entry_retired"]


def test_change_owner(client):
    lib, admin = _company(client)
    a, b = _login(client, "o1@x.com"), _login(client, "o2@x.com")
    mine = client.post(LIB, json={"name": "Handover"}, headers=a).json()["id"]
    assert client.put(f"{LIB}/{mine}/owner", json={"user_id": _uid(client, b)}, headers=b).status_code in (403, 404)
    r = client.put(f"{LIB}/{mine}/owner", json={"user_id": _uid(client, b)}, headers=a)
    assert r.status_code == 200
    assert [x for x in client.get(LIB, headers=b).json() if x["id"] == mine][0]["role"] == "owner"
    assert any(i["kind"] == "library_owner_changed" for i in client.get("/api/notifications", headers=b).json()["items"])
    assert client.put(f"{LIB}/{mine}/owner", json={"user_id": 99999}, headers=b).status_code == 400
    # any admin can hand over the company standard even when someone else owns it
    owned = client.post(LIB, json={"name": "CoOwned"}, headers=a).json()["id"]
    client.put(f"{LIB}/{owned}/company-default", json={"value": True}, headers=admin)
    assert client.put(f"{LIB}/{owned}/owner", json={"user_id": _uid(client, b)}, headers=admin).status_code == 200
    client.put(f"{LIB}/{lib}/company-default", json={"value": True}, headers=admin)          # restore the shared fixture


def test_layer_order_validated(client):
    h = _login(client, "lo@x.com")
    ok = client.put("/api/user-libraries", headers=h, json={"data": {"format": "overrides", "version": 3, "layerOrder": [3, 1, 2]}})
    assert ok.status_code == 200 and ok.json()["data"]["layerOrder"] == [3, 1, 2]
    for bad in ("x", ["a"], [1.5], list(range(300))):
        assert client.put("/api/user-libraries", headers=h, json={"data": {"format": "overrides", "version": 3, "layerOrder": bad}}).status_code == 422


def test_email_notifications_are_opt_in(client, monkeypatch):
    sent = []
    cfg = {"enabled": True, "host": "x", "from_address": "a@b.co"}
    monkeypatch.setattr(_mailer, "get_config", lambda db: cfg)
    monkeypatch.setattr(_mailer, "send_email", lambda c, to, subject, text, html=None: sent.append((to, subject, text)))
    monkeypatch.setattr(_notifications, "EMAIL_SYNC", True)
    owner, guest = _login(client, "e1@x.com"), _login(client, "e2@x.com")
    p = client.get(f"/api/notifications/preferences", headers=guest).json()
    assert p["email_enabled"] is False and p["email_available"] is True
    pid = client.post("/api/projects", json={"projectName": "P", "components": [], "wires": []}, headers=owner).json()["id"]
    client.post(f"/api/projects/{pid}/shares", json={"email": "e2@x.com", "role": "edit"}, headers=owner)
    assert sent == []                                              # not opted in
    r = client.put("/api/notifications/preferences", headers=guest, json={"email_enabled": True, "categories": ["projects", "bogus"]})
    assert r.json()["categories"] == ["projects"]
    client.post(f"/api/projects/{pid}/shares", json={"email": "e2@x.com", "role": "view"}, headers=owner)   # role change
    assert len(sent) == 1 and sent[0][0] == "e2@x.com" and "view access" in sent[0][2]
    # edits on the shared project stay in the bell; library events are filtered out by category
    client.put(f"/api/projects/{pid}", json={"projectName": "P", "components": [], "wires": []}, headers=owner)
    lib, admin = _company(client)
    client.put(f"{LIB}/{lib}/entries/cbs/em1", json={"data": {"id": "em1", "name": "E"}}, headers=admin)
    assert len(sent) == 1
    client.put("/api/notifications/preferences", headers=guest, json={"email_enabled": False, "categories": ["projects"]})
    client.post(f"/api/projects/{pid}/shares", json={"email": "e2@x.com", "role": "edit"}, headers=owner)
    assert len(sent) == 1
