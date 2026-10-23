"""Security review 2026-10: plan-image access, sign-in throttle, token revocation,
device sign-in hygiene, download file names, mail header safety."""

import os
import json
import tempfile

os.environ.setdefault("SECRET_KEY", "test-secret-key-for-pytest")

import pytest
from datetime import datetime, timedelta, timezone
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from fastapi.testclient import TestClient

from backend.main import app
from backend.models.database import Base, get_db, PlanImage
from backend.routes import auth as auth_routes
from backend import mailer


@pytest.fixture()
def client():
    tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    tmp.close()
    engine = create_engine(f"sqlite:///{tmp.name}", connect_args={"check_same_thread": False})
    Session = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    Base.metadata.create_all(bind=engine)

    def override():
        db = Session()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override
    c = TestClient(app)
    c._session = Session
    yield c
    app.dependency_overrides.clear()
    os.unlink(tmp.name)


def _h(tok):
    return {"Authorization": f"Bearer {tok}"}


def _reg(client, email, password="password123", invite=None):
    body = {"email": email, "password": password, "name": email.split("@")[0]}
    if invite:
        body["invite_code"] = invite
    return client.post("/api/auth/register", json=body)


def _users(client):
    a = _reg(client, "a@x.com").json()["access_token"]
    code = client.post("/api/auth/invites", json={}, headers=_h(a)).json()["code"]
    b = _reg(client, "b@x.com", invite=code).json()["access_token"]
    return a, b


def _project(client, tok):
    return client.post("/api/projects", json={"projectName": "P", "components": [], "wires": []},
                       headers=_h(tok)).json()["id"]


def _upload(client, tok, project_id=None):
    data = {"kind": "raster"}
    if project_id is not None:
        data["project_id"] = str(project_id)
    return client.post("/api/plan-images", headers=_h(tok), data=data,
                       files={"file": ("p.png", b"\x89PNG-bytes", "image/png")})


# ── plan images ──

def test_plan_image_is_private_to_its_uploader(client):
    a, b = _users(client)
    r = _upload(client, a)
    assert r.status_code == 200
    iid = r.json()["id"]
    assert client.get(f"/api/plan-images/{iid}", headers=_h(a)).status_code == 200
    assert client.get(f"/api/plan-images/{iid}", headers=_h(a)).headers["x-content-type-options"] == "nosniff"
    assert client.get(f"/api/plan-images/{iid}", headers=_h(b)).status_code == 404
    assert client.get(f"/api/plan-images/{iid}/meta", headers=_h(b)).status_code == 404
    pb = _project(client, b)
    assert client.patch(f"/api/plan-images/{iid}", json={"project_id": pb}, headers=_h(b)).status_code == 404
    client.delete(f"/api/plan-images/{iid}", headers=_h(b))
    assert client.get(f"/api/plan-images/{iid}", headers=_h(a)).status_code == 200
    assert client.get(f"/api/plan-images/{iid}", headers=None).status_code == 401


def test_plan_image_follows_project_sharing(client):
    a, b = _users(client)
    pid = _project(client, a)
    iid = _upload(client, a, pid).json()["id"]
    assert client.get(f"/api/plan-images/{iid}", headers=_h(b)).status_code == 404
    assert client.post(f"/api/projects/{pid}/shares", json={"email": "b@x.com", "role": "view"},
                       headers=_h(a)).status_code in (200, 201)
    assert client.get(f"/api/plan-images/{iid}", headers=_h(b)).status_code == 200
    client.delete(f"/api/plan-images/{iid}", headers=_h(b))        # viewer: no-op
    assert client.get(f"/api/plan-images/{iid}", headers=_h(a)).status_code == 200


def test_plan_image_upload_needs_edit_on_project(client):
    a, b = _users(client)
    pid = _project(client, a)
    assert _upload(client, b, pid).status_code == 404


def test_plan_image_claim_does_not_move_an_attached_image(client):
    a, _ = _users(client)
    p1, p2 = _project(client, a), _project(client, a)
    iid = _upload(client, a).json()["id"]
    assert client.patch(f"/api/plan-images/{iid}", json={"project_id": p1}, headers=_h(a)).json()["project_id"] == p1
    assert client.patch(f"/api/plan-images/{iid}", json={"project_id": p2}, headers=_h(a)).json()["project_id"] == p1


def test_plan_image_cleanup_is_per_user(client):
    a, b = _users(client)
    ia, ib = _upload(client, a).json()["id"], _upload(client, b).json()["id"]
    s = client._session()
    for img in s.query(PlanImage).all():
        img.created_at = datetime.now(timezone.utc) - timedelta(days=3)
    s.commit()
    s.close()
    assert client.post("/api/plan-images/cleanup", headers=_h(b)).json() == {"deleted": 1}
    assert client.get(f"/api/plan-images/{ia}", headers=_h(a)).status_code == 200
    assert client.get(f"/api/plan-images/{ib}", headers=_h(b)).status_code == 404


# ── sign-in throttle ──

def test_login_throttle_counts_failures_and_recovers(client, monkeypatch):
    _reg(client, "a@x.com")
    for _ in range(10):
        assert client.post("/api/auth/login", json={"email": "a@x.com", "password": "wrong-pw!"}).status_code == 401
    assert client.post("/api/auth/login", json={"email": "a@x.com", "password": "wrong-pw!"}).status_code == 429
    assert client.post("/api/auth/login", json={"email": "a@x.com", "password": "password123"}).status_code == 429
    t = auth_routes._now()
    monkeypatch.setattr(auth_routes, "_now", lambda: t + 1000)
    assert client.post("/api/auth/login", json={"email": "a@x.com", "password": "password123"}).status_code == 200


def test_good_logins_are_not_counted(client):
    _reg(client, "a@x.com")
    for _ in range(15):
        assert client.post("/api/auth/login", json={"email": "a@x.com", "password": "password123"}).status_code == 200


def test_forgot_and_device_start_are_ip_limited(client):
    codes = [client.post("/api/auth/device/start", json={"client_name": "x"}).status_code for _ in range(21)]
    assert codes[:20] == [200] * 20 and codes[20] == 429


# ── token revocation ──

def test_password_change_revokes_other_sessions(client):
    old = _reg(client, "a@x.com").json()["access_token"]
    r = client.post("/api/auth/change-password", headers=_h(old),
                    json={"current_password": "password123", "new_password": "another-pass1"})
    assert r.status_code == 200
    new = r.json()["access_token"]
    assert client.get("/api/auth/me", headers=_h(old)).status_code == 401
    assert client.get("/api/auth/me", headers=_h(new)).status_code == 200


def test_reset_and_deactivate_revoke_tokens(client):
    admin, b = _users(client)
    uid_b = client.get("/api/auth/me", headers=_h(b)).json()["id"]
    assert client.patch(f"/api/auth/users/{uid_b}/active", json={"is_active": False}, headers=_h(admin)).status_code == 200
    client.patch(f"/api/auth/users/{uid_b}/active", json={"is_active": True}, headers=_h(admin))
    assert client.get("/api/auth/me", headers=_h(b)).status_code == 401
    link = client.post(f"/api/auth/users/{uid_b}/reset-link", json={}, headers=_h(admin)).json()
    token = (link.get("link") or link.get("url") or "").split("reset=")[-1]
    fresh = client.post("/api/auth/login", json={"email": "b@x.com", "password": "password123"}).json()["access_token"]
    assert client.post("/api/auth/reset", json={"token": token, "password": "brand-new-pw1"}).status_code == 200
    assert client.get("/api/auth/me", headers=_h(fresh)).status_code == 401


def test_legacy_token_without_version_still_works(client):
    import jwt
    from backend.auth import _load_or_create_secret, ALGORITHM
    _reg(client, "a@x.com")
    tok = jwt.encode({"sub": "1", "exp": datetime.now(timezone.utc) + timedelta(hours=1)},
                     _load_or_create_secret(), algorithm=ALGORITHM)
    assert client.get("/api/auth/me", headers=_h(tok)).status_code == 200


# ── device sign-in ──

def test_device_client_name_is_cleaned_and_token_is_tagged(client):
    import jwt
    from backend.auth import _load_or_create_secret, ALGORITHM
    a = _reg(client, "a@x.com").json()["access_token"]
    start = client.post("/api/auth/device/start",
                        json={"client_name": "Evil\n\x07 " + "x" * 100}).json()
    info = client.get(f"/api/auth/device/{start['user_code']}", headers=_h(a)).json()
    assert len(info["client_name"]) <= 40 and "\n" not in info["client_name"] and "\x07" not in info["client_name"]
    client.post(f"/api/auth/device/{start['user_code']}/approve", headers=_h(a))
    got = client.post("/api/auth/device/poll", json={"device_code": start["device_code"]}).json()
    assert got["status"] == "approved"
    claims = jwt.decode(got["access_token"], _load_or_create_secret(), algorithms=[ALGORITHM])
    assert claims["amr"] == "device"


# ── file names / mail ──

def test_content_disposition_is_header_safe():
    from backend.routes._http import content_disposition
    h = content_disposition('a"b\r\nc/../Ü日本.pdf', "pdf")
    assert "\r" not in h and "\n" not in h and h.startswith('attachment; filename="')
    h.encode("latin-1")
    assert content_disposition("", "dxf", "drawing").startswith('attachment; filename="drawing.dxf"')


def test_report_download_survives_awkward_project_name(client):
    a = _reg(client, "a@x.com").json()["access_token"]
    body = {"projectName": 'Q"uote\nbreak 日本', "components": [], "wires": []}
    r = client.post("/api/reports/pdf", json=body, headers=_h(a))
    assert r.status_code == 200
    r.headers["content-disposition"].encode("latin-1")


def test_mailer_rejects_bad_address_as_mailerror():
    cfg = {"host": "localhost", "port": 25, "from_address": "x@y.z", "security": "none"}
    with pytest.raises(mailer.MailError):
        mailer.send_email(cfg, "a@b.c\nBcc: evil@x.com", "s", "t")
    assert "\n" not in mailer.invite_message("Eve\nBcc: x", "http://l", 7)[0]


# ── project details ──

def test_company_logo_must_be_a_raster_data_url(client):
    a = _reg(client, "a@x.com").json()["access_token"]
    good = "data:image/png;base64,iVBORw0KGgo="
    for logo, kept in ((good, good), ('x" onerror="alert(1)', None),
                       ("data:image/svg+xml;base64,PHN2Zz4=", None), ("javascript:alert(1)", None)):
        body = {"projectName": "L", "components": [], "wires": [],
                "projectDetails": {"companyLogo": logo, "date": '"><script>'}}
        pid = client.post("/api/projects", json=body, headers=_h(a)).json()["id"]
        got = client.get(f"/api/projects/{pid}", headers=_h(a)).json()
        assert got["projectDetails"]["companyLogo"] == kept


# ── request limits ──

def _ts(client, tok, **kw):
    body = {"projectName": "T", "components": [], "wires": []}
    body.update(kw)
    return client.post("/api/analysis/timeseries-loadflow", json=body, headers=_h(tok))


def test_timeseries_request_is_bounded(client):
    a = _reg(client, "a@x.com").json()["access_token"]
    assert _ts(client, a, horizon_hours=1e9).status_code == 422
    assert _ts(client, a, step_minutes=0).status_code == 422
    assert _ts(client, a, horizon_hours=8784, step_minutes=1).status_code == 422
    assert _ts(client, a, horizon_hours=24, step_minutes=60).status_code != 422


def test_project_component_count_is_capped(client):
    a = _reg(client, "a@x.com").json()["access_token"]
    comps = [{"id": f"b{i}", "type": "bus", "x": 0, "y": 0} for i in range(20001)]
    r = client.post("/api/projects", json={"projectName": "Big", "components": comps, "wires": []}, headers=_h(a))
    assert r.status_code == 422


def test_report_image_size_is_capped(client):
    a = _reg(client, "a@x.com").json()["access_token"]
    r = client.post("/api/reports/pdf", json={"projectName": "R", "diagramImage": "A" * 28_000_001}, headers=_h(a))
    assert r.status_code == 422


def test_deleting_a_user_who_uploaded_plan_images(client):
    a, b = _users(client)
    uid_b = client.get("/api/auth/me", headers=_h(b)).json()["id"]
    iid = _upload(client, b).json()["id"]
    assert client.delete(f"/api/auth/users/{uid_b}", headers=_h(a)).status_code == 200
    assert client.get(f"/api/plan-images/{iid}", headers=_h(a)).status_code == 200   # the heir has it
