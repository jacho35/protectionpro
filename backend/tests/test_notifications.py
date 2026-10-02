"""Notifications center: per-user isolation, project share/edit events (with
coalescing), library events (company fan-out), mark-read, retention."""

import os
import tempfile
from datetime import datetime, timedelta, timezone

_TMP_DIR = tempfile.mkdtemp(prefix="protectionpro-test-notif-")
_TEST_DB_URL = f"sqlite:///{_TMP_DIR}/test_notifications.db"
os.environ["DATABASE_URL"] = _TEST_DB_URL

from backend.models import database as _database  # noqa: E402
from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402
import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from backend.main import app  # noqa: E402

N = "/api/notifications"
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
        r = client.post("/api/auth/register",
                        json={"email": email, "password": "password123", "invite_code": code})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def _admin(client):
    _login(client, "admin@x.com")
    return _ADMIN["h"]


def _list(client, h, **params):
    r = client.get(N, headers=h, params=params)
    assert r.status_code == 200, r.text
    return r.json()


def _project(client, h, name="P1"):
    r = client.post("/api/projects", json={"projectName": name, "components": [], "wires": []}, headers=h)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_requires_auth(client):
    assert client.get(N).status_code in (401, 403)


def test_share_notifies_target_not_actor(client):
    owner, guest = _login(client, "own1@x.com"), _login(client, "guest1@x.com")
    pid = _project(client, owner, "Substation")
    assert client.post(f"/api/projects/{pid}/shares", json={"email": "guest1@x.com", "role": "edit"},
                       headers=owner).status_code == 200
    got = _list(client, guest)
    assert got["unread"]["by_category"]["projects"] == 1
    n = got["items"][0]
    assert n["kind"] == "project_shared" and "Substation" in n["message"] and "edit access" in n["message"]
    assert n["link"] == {"type": "project", "id": pid} and not n["read"]
    assert _list(client, owner)["items"] == []          # the actor is never told about their own action


def test_role_change_and_unshare(client):
    owner, guest = _login(client, "own2@x.com"), _login(client, "guest2@x.com")
    pid = _project(client, owner, "Retic")
    client.post(f"/api/projects/{pid}/shares", json={"email": "guest2@x.com", "role": "view"}, headers=owner)
    client.post(f"/api/projects/{pid}/shares", json={"email": "guest2@x.com", "role": "view"}, headers=owner)  # no change
    client.post(f"/api/projects/{pid}/shares", json={"email": "guest2@x.com", "role": "edit"}, headers=owner)
    uid = [s["user_id"] for s in client.get(f"/api/projects/{pid}/shares", headers=owner).json()][0]
    client.delete(f"/api/projects/{pid}/shares/{uid}", headers=owner)
    kinds = [n["kind"] for n in _list(client, guest)["items"]]
    assert kinds == ["project_unshared", "project_role_changed", "project_shared"]


def test_shared_project_edits_coalesce(client):
    owner, guest = _login(client, "own3@x.com"), _login(client, "guest3@x.com")
    pid = _project(client, owner, "Plant")
    client.post(f"/api/projects/{pid}/shares", json={"email": "guest3@x.com", "role": "edit"}, headers=owner)
    for _ in range(3):
        r = client.put(f"/api/projects/{pid}", json={"projectName": "Plant", "components": [], "wires": []},
                       headers=guest)
        assert r.status_code == 200, r.text
    mine = [n for n in _list(client, owner)["items"] if n["kind"] == "project_edited"]
    assert len(mine) == 1 and mine[0]["count"] == 3 and "3 saves" in mine[0]["message"]
    # the editor is not notified of their own saves
    assert [n for n in _list(client, guest)["items"] if n["kind"] == "project_edited"] == []
    # once read, the next save starts a fresh notification
    client.post(f"{N}/read", json={"ids": [mine[0]["id"]]}, headers=owner)
    client.put(f"/api/projects/{pid}", json={"projectName": "Plant", "components": [], "wires": []}, headers=guest)
    again = [n for n in _list(client, owner)["items"] if n["kind"] == "project_edited"]
    assert len(again) == 2 and again[0]["count"] == 1 and not again[0]["read"]


def test_unshared_project_edit_notifies_nobody(client):
    owner = _login(client, "own4@x.com")
    pid = _project(client, owner, "Solo")
    client.put(f"/api/projects/{pid}", json={"projectName": "Solo", "components": [], "wires": []}, headers=owner)
    assert _list(client, owner)["items"] == []


def test_library_entry_events_reach_members_only(client):
    owner, member, outsider = (_login(client, "lo@x.com"), _login(client, "lm@x.com"),
                               _login(client, "lx@x.com"))
    lib = client.post("/api/shared-libraries", json={"name": "Team"}, headers=owner).json()["id"]
    client.post(f"/api/shared-libraries/{lib}/members", json={"email": "lm@x.com", "role": "view"}, headers=owner)
    client.put(f"/api/shared-libraries/{lib}/entries/transformers/t1",
               json={"data": {"id": "t1", "name": "2 MVA"}}, headers=owner)
    client.put(f"/api/shared-libraries/{lib}/entries/transformers/t2",
               json={"data": {"id": "t2", "name": "4 MVA"}}, headers=owner)
    got = _list(client, member, category="libraries")["items"]
    assert got[0]["kind"] == "library_entry_changed" and got[0]["count"] == 2   # coalesced per library
    assert "2 entries" in got[0]["message"]
    assert got[1]["kind"] == "library_shared"
    assert _list(client, outsider)["items"] == []


def test_company_standard_fans_out_to_everyone(client):
    admin = _admin(client)
    a, b = _login(client, "ca@x.com"), _login(client, "cb@x.com")
    lib = client.post("/api/shared-libraries", json={"name": "Acme"}, headers=admin).json()["id"]
    client.put(f"/api/shared-libraries/{lib}/company-default", json={"value": True}, headers=admin)
    for h in (a, b):
        n = _list(client, h)["items"][0]
        assert n["kind"] == "company_standard_changed" and "company standard" in n["message"]
    assert all(n["kind"] != "company_standard_changed" for n in _list(client, admin)["items"])
    client.put(f"/api/shared-libraries/{lib}/entries/cbs/cb1", json={"data": {"id": "cb1", "name": "MCCB 250"}},
               headers=admin)
    top = _list(client, a)["items"][0]
    assert top["kind"] == "library_entry_changed" and "company standard" in top["message"]
    assert top["link"]["kind"] == "cbs" and top["link"]["entryId"] == "cb1"


def test_mark_read_filters_and_counts(client):
    owner, guest = _login(client, "own5@x.com"), _login(client, "guest5@x.com")
    p1, p2 = _project(client, owner, "A"), _project(client, owner, "B")
    for pid in (p1, p2):
        client.post(f"/api/projects/{pid}/shares", json={"email": "guest5@x.com", "role": "view"}, headers=owner)
    assert client.get(f"{N}/unread-count", headers=guest).json()["total"] == 2
    ids = [n["id"] for n in _list(client, guest)["items"]]
    r = client.post(f"{N}/read", json={"ids": [ids[0]]}, headers=guest)
    assert r.json()["total"] == 1
    assert len(_list(client, guest, unread_only=True)["items"]) == 1
    assert client.post(f"{N}/read", json={"category": "libraries"}, headers=guest).json()["total"] == 1
    assert client.post(f"{N}/read", json={}, headers=guest).json()["total"] == 0
    assert client.get(N, headers=guest, params={"category": "bogus"}).status_code == 422


def test_cannot_touch_someone_elses_notifications(client):
    owner, guest, other = (_login(client, "own6@x.com"), _login(client, "guest6@x.com"),
                           _login(client, "other6@x.com"))
    pid = _project(client, owner, "Z")
    client.post(f"/api/projects/{pid}/shares", json={"email": "guest6@x.com", "role": "view"}, headers=owner)
    nid = _list(client, guest)["items"][0]["id"]
    client.post(f"{N}/read", json={"ids": [nid]}, headers=other)
    client.delete(f"{N}/{nid}", headers=other)
    n = _list(client, guest)["items"][0]
    assert n["id"] == nid and not n["read"]
    client.delete(f"{N}/{nid}", headers=guest)
    assert _list(client, guest)["items"] == []


def test_pagination_and_old_read_notifications_expire(client):
    owner, guest = _login(client, "own7@x.com"), _login(client, "guest7@x.com")
    for i in range(3):
        pid = _project(client, owner, f"Q{i}")
        client.post(f"/api/projects/{pid}/shares", json={"email": "guest7@x.com", "role": "view"}, headers=owner)
    page = _list(client, guest, limit=2)
    assert len(page["items"]) == 2 and page["has_more"]
    rest = _list(client, guest, limit=2, before_id=page["items"][-1]["id"])
    assert len(rest["items"]) == 1 and not rest["has_more"]
    # a read notification older than the retention window is purged on the next list
    client.post(f"{N}/read", json={}, headers=guest)
    with _database.SessionLocal() as db:
        old = datetime.now(timezone.utc) - timedelta(days=200)
        db.query(_database.Notification).filter(_database.Notification.read_at.isnot(None)).update(
            {_database.Notification.read_at: old})
        db.commit()
    assert _list(client, guest)["items"] == []
