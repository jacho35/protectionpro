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
    assert r.json() == {"ok": True, "users": 0, "email_configured": False}


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


def test_user_search_lists_registered_users(client):
    admin = _register(client, "owner@x.com", name="Owner").json()["access_token"]
    code = client.post("/api/auth/invites", json={}, headers=_hdr(admin)).json()["code"]
    _register(client, "thandi@x.com", invite=code, name="Thandi Nkosi")
    r = client.get("/api/auth/users/search?q=thand", headers=_hdr(admin))
    assert r.status_code == 200
    assert [u["email"] for u in r.json()] == ["thandi@x.com"]
    assert client.get("/api/auth/users/search?q=owner", headers=_hdr(admin)).json() == []
    assert client.get("/api/auth/users/search?q=a").status_code == 401


# ── Email settings, invites by email, password reset ──

def _admin(client):
    return _hdr(_register(client, "admin@x.com", name="Admin").json()["access_token"])


@pytest.fixture()
def outbox(monkeypatch):
    from backend import mailer
    sent = []
    monkeypatch.setattr(mailer, "send_email", lambda cfg, to, subj, text, html=None: sent.append((to, subj, text)))
    return sent


EMAIL_CFG = {"enabled": True, "host": "smtp.test", "port": 587, "security": "starttls",
             "username": "u", "password": "secret", "from_name": "PP",
             "from_address": "noreply@x.com", "app_url": "https://pp.example.com/"}


def test_email_settings_admin_only_and_password_hidden(client):
    h = _admin(client)
    assert client.get("/api/health").json()["email_configured"] is False
    r = client.put("/api/settings/email", json=EMAIL_CFG, headers=h)
    assert r.status_code == 200
    body = r.json()
    assert body["configured"] and body["has_password"] and "password" not in body
    assert body["app_url"] == "https://pp.example.com"
    assert client.get("/api/health").json()["email_configured"] is True
    # Keeping the password when omitted
    r = client.put("/api/settings/email", json={**EMAIL_CFG, "password": None}, headers=h)
    assert r.json()["has_password"] is True
    # Non-admin refused
    code = client.post("/api/auth/invites", json={}, headers=h).json()["code"]
    bob = _hdr(_register(client, "bob@x.com", invite=code).json()["access_token"])
    assert client.get("/api/settings/email", headers=bob).status_code == 403
    assert client.put("/api/settings/email", json=EMAIL_CFG, headers=bob).status_code == 403


def test_email_validation(client):
    h = _admin(client)
    r = client.put("/api/settings/email", json={**EMAIL_CFG, "host": ""}, headers=h)
    assert r.status_code == 400
    r = client.put("/api/settings/email", json={"enabled": False}, headers=h)   # skip = fine
    assert r.status_code == 200 and r.json()["configured"] is False


def test_test_email_reports_success_and_failure(client, outbox, monkeypatch):
    from backend import mailer
    h = _admin(client)
    r = client.post("/api/settings/email/test", json=EMAIL_CFG, headers=h).json()
    assert r["ok"] and outbox[0][0] == "admin@x.com"

    def boom(*a, **k):
        raise mailer.MailError("Couldn't connect to smtp.test:587.")
    monkeypatch.setattr(mailer, "send_email", boom)
    r = client.post("/api/settings/email/test", json=EMAIL_CFG, headers=h).json()
    assert r == {"ok": False, "message": "Couldn't connect to smtp.test:587."}


def test_invite_without_email_gives_link_only(client, outbox):
    h = _admin(client)
    r = client.post("/api/auth/invites", json={"email": "n@x.com", "send_email": True,
                                               "base_url": "https://pp.test", "expires_days": 7}, headers=h).json()
    assert r["emailed"] is False and r["email_error"]
    assert r["link"] == f"https://pp.test/#invite={r['code']}"
    assert outbox == []
    # Invite with an expiry still registers (naive/aware datetime handling)
    assert _register(client, "n@x.com", invite=r["code"]).status_code == 200


def test_invite_by_email_and_check(client, outbox):
    h = _admin(client)
    client.put("/api/settings/email", json=EMAIL_CFG, headers=h)
    r = client.post("/api/auth/invites", json={"email": "nomsa@x.com", "send_email": True, "note": "Hi!"},
                    headers=h).json()
    assert r["emailed"] is True
    to, subj, text = outbox[0]
    assert to == "nomsa@x.com" and "invited you" in subj
    assert f"https://pp.example.com/#invite={r['code']}" in text   # configured address wins
    chk = client.get(f"/api/auth/invite-check/{r['code']}").json()
    assert chk["valid"] and chk["email"] == "nomsa@x.com"
    assert client.get("/api/auth/invite-check/nope").json() == {"valid": False}


def test_forgot_and_reset_flow(client, outbox):
    h = _admin(client)
    code = client.post("/api/auth/invites", json={}, headers=h).json()["code"]
    _register(client, "bob@x.com", invite=code)
    # Email off → generic answer, nothing sent, UI told why
    r = client.post("/api/auth/forgot", json={"email": "bob@x.com"}).json()
    assert r == {"ok": True, "email_enabled": False} and outbox == []
    client.put("/api/settings/email", json=EMAIL_CFG, headers=h)
    # Unknown and known addresses answer identically
    assert client.post("/api/auth/forgot", json={"email": "ghost@x.com"}).json()["ok"]
    assert outbox == []
    client.post("/api/auth/forgot", json={"email": "bob@x.com"})
    link = [l for l in outbox[0][2].split() if "#reset=" in l][0]
    token = link.split("#reset=")[1]
    ok = client.post("/api/auth/reset", json={"token": token, "password": "brand-new-pw1"})
    assert ok.status_code == 200 and ok.json()["user"]["email"] == "bob@x.com"
    assert client.post("/api/auth/login", json={"email": "bob@x.com", "password": "brand-new-pw1"}).status_code == 200
    assert client.post("/api/auth/login", json={"email": "bob@x.com", "password": "password123"}).status_code == 401
    # Single use
    assert client.post("/api/auth/reset", json={"token": token, "password": "another-pw-22"}).status_code == 400
    assert client.post("/api/auth/reset", json={"token": "garbage", "password": "another-pw-22"}).status_code == 400


def test_admin_reset_link_without_email(client):
    h = _admin(client)
    code = client.post("/api/auth/invites", json={}, headers=h).json()["code"]
    bob = _register(client, "bob@x.com", invite=code).json()
    uid = bob["user"]["id"]
    r = client.post(f"/api/auth/users/{uid}/reset-link", json={"base_url": "https://pp.test"}, headers=h).json()
    assert r["link"].startswith("https://pp.test/#reset=") and not r["emailed"]
    assert client.post(f"/api/auth/users/{uid}/reset-link", json={}, headers=_hdr(bob["access_token"])).status_code == 403
    token = r["link"].split("#reset=")[1]
    assert client.post("/api/auth/reset", json={"token": token, "password": "reset-by-admin1"}).status_code == 200


def test_forgot_ignores_client_base_url_and_app_url_required(client, outbox):
    h = _admin(client)
    code = client.post("/api/auth/invites", json={}, headers=h).json()["code"]
    _register(client, "bob@x.com", invite=code)
    assert client.put("/api/settings/email", json={**EMAIL_CFG, "app_url": ""}, headers=h).status_code == 400
    assert client.put("/api/settings/email", json={**EMAIL_CFG, "app_url": "javascript:alert(1)"}, headers=h).status_code == 400
    client.put("/api/settings/email", json=EMAIL_CFG, headers=h)
    client.post("/api/auth/forgot", json={"email": "bob@x.com", "base_url": "https://evil.example"})
    assert "evil.example" not in outbox[0][2] and "https://pp.example.com/#reset=" in outbox[0][2]


def test_welcome_email_on_join_and_manual(client, outbox):
    h = _admin(client)
    client.put("/api/settings/email", json={**EMAIL_CFG, "welcome_note": "Start with Phase 2."}, headers=h)
    code = client.post("/api/auth/invites", json={}, headers=h).json()["code"]
    r = _register(client, "bob@x.com", invite=code, name="Bob")
    assert r.status_code == 200
    to, subj, text = outbox[-1]
    assert to == "bob@x.com" and subj == "Welcome to ProtectionPro"
    assert "Start with Phase 2." in text and "https://pp.example.com" in text
    n = len(outbox)
    # Manual send; admin only
    uid = r.json()["user"]["id"]
    assert client.post(f"/api/auth/users/{uid}/welcome", headers=h).json()["emailed"] is True
    assert len(outbox) == n + 1
    assert client.post(f"/api/auth/users/{uid}/welcome", headers=_hdr(r.json()["access_token"])).status_code == 403
    # Auto-send can be switched off
    client.put("/api/settings/email", json={**EMAIL_CFG, "welcome_auto": False}, headers=h)
    code2 = client.post("/api/auth/invites", json={}, headers=h).json()["code"]
    _register(client, "amy@x.com", invite=code2)
    assert len(outbox) == n + 1


def test_welcome_manual_needs_email(client):
    h = _admin(client)
    assert client.post("/api/auth/users/1/welcome", headers=h).status_code == 400


def test_user_can_change_own_password(client):
    h = _admin(client)
    r = client.post("/api/auth/change-password", json={"current_password": "wrong-pass", "new_password": "new-password-1"}, headers=h)
    assert r.status_code == 400
    assert client.post("/api/auth/change-password", json={"current_password": "password123", "new_password": "short"}, headers=h).status_code == 422
    assert client.post("/api/auth/change-password", json={"current_password": "password123", "new_password": "password123"}, headers=h).status_code == 400
    assert client.post("/api/auth/change-password", json={"current_password": "password123", "new_password": "new-password-1"}, headers=h).status_code == 200
    assert client.post("/api/auth/login", json={"email": "admin@x.com", "password": "new-password-1"}).status_code == 200
    assert client.post("/api/auth/login", json={"email": "admin@x.com", "password": "password123"}).status_code == 401
    assert client.post("/api/auth/change-password", json={"current_password": "a", "new_password": "new-password-2"}).status_code == 401
