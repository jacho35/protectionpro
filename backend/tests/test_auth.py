"""Auth + per-user project sharing regression tests.

Uses a temp-file SQLite DB via a get_db dependency override so it never
touches the dev/prod DB. SECRET_KEY is set so JWT signing doesn't hit the DB.
"""

import os
import json
import tempfile

os.environ.setdefault("SECRET_KEY", "test-secret-key-for-pytest")

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from fastapi.testclient import TestClient

from backend.main import app
from backend.models.database import Base, get_db, Project


@pytest.fixture()
def client():
    tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    tmp.close()
    engine = create_engine(f"sqlite:///{tmp.name}",
                           connect_args={"check_same_thread": False})
    TestSession = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    Base.metadata.create_all(bind=engine)

    # Seed a legacy ownerless project to test the bootstrap-claim.
    seed = TestSession()
    seed.add(Project(name="Legacy Project",
                     data=json.dumps({"projectName": "Legacy Project"}),
                     owner_id=None))
    seed.commit()
    seed.close()

    def override_get_db():
        db = TestSession()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    c = TestClient(app)
    c._engine = engine
    yield c
    app.dependency_overrides.clear()
    os.unlink(tmp.name)


def _hdr(token):
    return {"Authorization": f"Bearer {token}"}


def _register(client, email, password="password123", invite=None, name=""):
    body = {"email": email, "password": password, "name": name}
    if invite is not None:
        body["invite_code"] = invite
    return client.post("/api/auth/register", json=body)


def test_health_reports_user_count(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json() == {"ok": True, "users": 0}


def test_first_user_is_admin_and_claims_legacy_data(client):
    r = _register(client, "admin@x.com", name="Admin")
    assert r.status_code == 200
    body = r.json()
    assert body["token_type"] == "bearer"
    assert body["user"]["is_admin"] is True
    token = body["access_token"]

    # Legacy project now visible to the admin as owner.
    projs = client.get("/api/projects", headers=_hdr(token)).json()
    assert any(p["name"] == "Legacy Project" and p["access"] == "owner" for p in projs)


def test_api_requires_auth(client):
    assert client.get("/api/projects").status_code == 401
    # analysis is gated too (whole-app login)
    assert client.post("/api/analysis/fault", json={"components": [], "wires": []}).status_code == 401


def test_me_and_bad_token(client):
    token = _register(client, "admin@x.com").json()["access_token"]
    assert client.get("/api/auth/me", headers=_hdr(token)).json()["email"] == "admin@x.com"
    assert client.get("/api/auth/me", headers=_hdr("garbage")).status_code == 401
    assert client.get("/api/auth/me").status_code == 401


def test_login_wrong_password(client):
    _register(client, "admin@x.com", password="password123")
    assert client.post("/api/auth/login",
                       json={"email": "admin@x.com", "password": "nope"}).status_code == 401
    ok = client.post("/api/auth/login",
                     json={"email": "admin@x.com", "password": "password123"})
    assert ok.status_code == 200


def test_invite_required_and_single_use(client):
    admin = _register(client, "admin@x.com").json()["access_token"]
    # Second registration without an invite is rejected.
    assert _register(client, "bob@x.com").status_code == 400
    # Admin mints an invite.
    code = client.post("/api/auth/invites", json={}, headers=_hdr(admin)).json()["code"]
    # Register with it → non-admin.
    r = _register(client, "bob@x.com", invite=code)
    assert r.status_code == 200 and r.json()["user"]["is_admin"] is False
    # Reusing the same code fails.
    assert _register(client, "carol@x.com", invite=code).status_code == 400


def _two_users(client):
    admin = _register(client, "admin@x.com").json()["access_token"]
    code = client.post("/api/auth/invites", json={}, headers=_hdr(admin)).json()["code"]
    bob = _register(client, "bob@x.com", invite=code).json()["access_token"]
    pid = client.post("/api/projects",
                      json={"projectName": "P1", "components": [], "wires": []},
                      headers=_hdr(admin)).json()["id"]
    return admin, bob, pid


def test_sharing_view_edit_owner_matrix(client):
    admin, bob, pid = _two_users(client)

    # Bob can't see or touch the project before sharing.
    assert all(p["id"] != pid for p in client.get("/api/projects", headers=_hdr(bob)).json())
    assert client.get(f"/api/projects/{pid}", headers=_hdr(bob)).status_code == 404

    # Unknown email / self-share guarded.
    assert client.post(f"/api/projects/{pid}/shares",
                       json={"email": "ghost@x.com", "role": "view"},
                       headers=_hdr(admin)).status_code == 404
    assert client.post(f"/api/projects/{pid}/shares",
                       json={"email": "admin@x.com", "role": "view"},
                       headers=_hdr(admin)).status_code == 400

    # Share view.
    assert client.post(f"/api/projects/{pid}/shares",
                       json={"email": "bob@x.com", "role": "view"},
                       headers=_hdr(admin)).status_code == 200
    shared = [p for p in client.get("/api/projects", headers=_hdr(bob)).json() if p["id"] == pid]
    assert shared and shared[0]["access"] == "view" and shared[0]["owner_email"] == "admin@x.com"

    # Viewer: read OK, edit/delete/share forbidden.
    assert client.get(f"/api/projects/{pid}", headers=_hdr(bob)).status_code == 200
    put = client.put(f"/api/projects/{pid}",
                     json={"projectName": "P1x", "components": [], "wires": []},
                     headers=_hdr(bob))
    assert put.status_code == 403
    assert client.delete(f"/api/projects/{pid}", headers=_hdr(bob)).status_code == 403
    assert client.get(f"/api/projects/{pid}/shares", headers=_hdr(bob)).status_code == 403

    # Upgrade to edit.
    assert client.patch(f"/api/projects/{pid}/shares/{_uid(client, bob)}",
                        json={"role": "edit"}, headers=_hdr(admin)).status_code == 200
    assert client.put(f"/api/projects/{pid}",
                      json={"projectName": "P1x", "components": [], "wires": []},
                      headers=_hdr(bob)).status_code == 200   # editor can now save
    assert client.delete(f"/api/projects/{pid}", headers=_hdr(bob)).status_code == 403  # still owner-only

    # Revoke → back to no access (404).
    assert client.delete(f"/api/projects/{pid}/shares/{_uid(client, bob)}",
                         headers=_hdr(admin)).status_code == 200
    assert client.get(f"/api/projects/{pid}", headers=_hdr(bob)).status_code == 404


def _uid(client, token):
    return client.get("/api/auth/me", headers=_hdr(token)).json()["id"]


def test_no_access_project_is_404_not_403(client):
    admin, bob, pid = _two_users(client)
    # Bob has no share at all → existence hidden as 404 (not 403).
    assert client.get(f"/api/projects/{pid}", headers=_hdr(bob)).status_code == 404
