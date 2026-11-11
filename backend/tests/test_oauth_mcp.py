"""OAuth (PKCE) + built-in MCP endpoint."""

import base64
import hashlib
import json
import os
import secrets
import tempfile
from urllib.parse import urlsplit, parse_qs

os.environ.setdefault("SECRET_KEY", "test-secret-key-for-pytest")
os.environ["PUBLIC_URL"] = "https://pp.example.test"

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.main import app
from backend.models.database import Base, get_db

REDIRECT = "http://localhost:8765/cb"


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
    c = TestClient(app, follow_redirects=False)
    r = c.post("/api/auth/register", json={"email": "a@example.com", "password": "correct-horse-1", "name": "A"})
    assert r.status_code == 200, r.text
    c.user_headers = {"Authorization": f"Bearer {r.json()['access_token']}"}
    yield c
    app.dependency_overrides.clear()


def pkce():
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


def register(c, uris=(REDIRECT,)):
    r = c.post("/oauth/register", json={"client_name": "Hermes", "redirect_uris": list(uris)})
    return r


def start(c, client_id, challenge, scope="mcp:read mcp:write", redirect=REDIRECT):
    r = c.get("/oauth/authorize", params={
        "response_type": "code", "client_id": client_id, "redirect_uri": redirect,
        "code_challenge": challenge, "code_challenge_method": "S256", "scope": scope, "state": "xyz"})
    return r


def approve(c, rid, scope=None):
    r = c.post(f"/api/oauth/consent/{rid}/approve", json={"scope": scope} if scope else {},
               headers=c.user_headers)
    assert r.status_code == 200, r.text
    q = parse_qs(urlsplit(r.json()["redirect_url"]).query)
    assert q["state"] == ["xyz"]
    return q["code"][0]


def connect(c, scope="mcp:read mcp:write", approved=None):
    cid = register(c).json()["client_id"]
    verifier, challenge = pkce()
    r = start(c, cid, challenge, scope)
    assert r.status_code == 302 and r.headers["location"].startswith("/#mcp-consent=")
    rid = r.headers["location"].split("=", 1)[1]
    code = approve(c, rid, approved)
    t = c.post("/oauth/token", data={"grant_type": "authorization_code", "client_id": cid, "code": code,
                                     "redirect_uri": REDIRECT, "code_verifier": verifier})
    assert t.status_code == 200, t.text
    return cid, t.json()


def rpc(c, token, method, params=None, id=1):
    return c.post("/mcp", json={"jsonrpc": "2.0", "id": id, "method": method, "params": params or {}},
                  headers={"Authorization": f"Bearer {token}"})


def test_discovery_uses_public_url(client):
    d = client.get("/.well-known/oauth-authorization-server").json()
    assert d["issuer"] == "https://pp.example.test"
    assert d["code_challenge_methods_supported"] == ["S256"]
    r = client.get("/.well-known/oauth-protected-resource").json()
    assert r["resource"] == "https://pp.example.test/mcp"


def test_mcp_without_token_is_401_with_pointer(client):
    r = client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"})
    assert r.status_code == 401
    assert "oauth-protected-resource" in r.headers["www-authenticate"]


def test_register_rejects_bad_redirects(client):
    for bad in ("http://evil.example/cb", "javascript:alert(1)", "https://x.example/cb#frag"):
        assert register(client, [bad]).status_code == 400
    assert register(client, ["https://app.example/cb"]).status_code == 201


def test_authorize_unknown_redirect_is_error_not_redirect(client):
    cid = register(client).json()["client_id"]
    _, ch = pkce()
    r = start(client, cid, ch, redirect="https://evil.example/cb")
    assert r.status_code == 400


def test_pkce_required_and_checked(client):
    cid = register(client).json()["client_id"]
    r = client.get("/oauth/authorize", params={"response_type": "code", "client_id": cid,
                                               "redirect_uri": REDIRECT})
    assert r.status_code == 302 and "error=invalid_request" in r.headers["location"]
    verifier, challenge = pkce()
    rid = start(client, cid, challenge).headers["location"].split("=", 1)[1]
    code = approve(client, rid)
    bad = client.post("/oauth/token", data={"grant_type": "authorization_code", "client_id": cid, "code": code,
                                            "redirect_uri": REDIRECT, "code_verifier": secrets.token_urlsafe(48)})
    assert bad.status_code == 400 and bad.json()["error"] == "invalid_grant"


def test_code_reuse_revokes_grant(client):
    cid = register(client).json()["client_id"]
    verifier, challenge = pkce()
    rid = start(client, cid, challenge).headers["location"].split("=", 1)[1]
    code = approve(client, rid)
    form = {"grant_type": "authorization_code", "client_id": cid, "code": code,
            "redirect_uri": REDIRECT, "code_verifier": verifier}
    first = client.post("/oauth/token", data=form)
    assert first.status_code == 200
    assert client.post("/oauth/token", data=form).status_code == 400
    # the access token minted by the first exchange no longer works
    assert rpc(client, first.json()["access_token"], "ping").status_code == 401


def test_deny_returns_access_denied(client):
    cid = register(client).json()["client_id"]
    _, ch = pkce()
    rid = start(client, cid, ch).headers["location"].split("=", 1)[1]
    r = client.post(f"/api/oauth/consent/{rid}/deny", headers=client.user_headers)
    assert "error=access_denied" in r.json()["redirect_url"]


def test_consent_requires_login(client):
    cid = register(client).json()["client_id"]
    _, ch = pkce()
    rid = start(client, cid, ch).headers["location"].split("=", 1)[1]
    assert client.post(f"/api/oauth/consent/{rid}/approve", json={}).status_code == 401


def test_refresh_rotation_and_reuse(client):
    cid, tok = connect(client)
    r1 = client.post("/oauth/token", data={"grant_type": "refresh_token", "client_id": cid,
                                           "refresh_token": tok["refresh_token"]})
    assert r1.status_code == 200
    new = r1.json()
    assert new["refresh_token"] != tok["refresh_token"]
    # presenting the rotated-out token again kills the whole grant
    again = client.post("/oauth/token", data={"grant_type": "refresh_token", "client_id": cid,
                                              "refresh_token": tok["refresh_token"]})
    assert again.status_code == 400
    assert rpc(client, new["access_token"], "ping").status_code == 401
    dead = client.post("/oauth/token", data={"grant_type": "refresh_token", "client_id": cid,
                                             "refresh_token": new["refresh_token"]})
    assert dead.status_code == 400


def test_refresh_wrong_client(client):
    cid, tok = connect(client)
    other = register(client).json()["client_id"]
    r = client.post("/oauth/token", data={"grant_type": "refresh_token", "client_id": other,
                                          "refresh_token": tok["refresh_token"]})
    assert r.status_code == 400


def test_tools_follow_scope(client):
    _, full = connect(client)
    names = {t["name"] for t in rpc(client, full["access_token"], "tools/list").json()["result"]["tools"]}
    assert {"list_projects", "add_component", "rename_project"} <= names
    assert not any("delete_project" in n for n in names)
    _, ro = connect(client, approved="mcp:read")
    assert ro["scope"] == "mcp:read"
    names = {t["name"] for t in rpc(client, ro["access_token"], "tools/list").json()["result"]["tools"]}
    assert "list_projects" in names and "add_component" not in names
    r = rpc(client, ro["access_token"], "tools/call", {"name": "add_component", "arguments": {}})
    assert "error" in r.json()


def test_end_to_end_edit_and_revision(client):
    _, tok = connect(client)
    t = tok["access_token"]

    def call(tool, **args):
        r = rpc(client, t, "tools/call", {"name": tool, "arguments": args}).json()["result"]
        assert not r["isError"], r
        return json.loads(r["content"][0]["text"]) if r["content"][0]["text"].startswith(("{", "[")) else r["content"][0]["text"]

    pid = call("create_project", name="Via MCP")["id"]
    call("add_component", project_id=pid, type="bus", x=100, y=100)
    comps = call("list_components", project_id=pid)
    assert comps and comps[0]["type"] == "bus"
    revs = client.get(f"/api/projects/{pid}/revisions", headers=client.user_headers).json()
    assert any("MCP" in (r.get("label") or "") for r in revs)
    # init handshake + notification
    init = rpc(client, t, "initialize", {"protocolVersion": "2025-06-18"}).json()["result"]
    assert init["capabilities"]["tools"] is not None
    n = client.post("/mcp", json={"jsonrpc": "2.0", "method": "notifications/initialized"},
                    headers={"Authorization": f"Bearer {t}"})
    assert n.status_code == 202


def test_mcp_token_cannot_reach_other_api(client):
    _, tok = connect(client)
    h = {"Authorization": f"Bearer {tok['access_token']}"}
    assert client.get("/api/projects", headers=h).status_code == 200
    assert client.get("/api/auth/users", headers=h).status_code == 403
    assert client.get("/api/user-libraries", headers=h).status_code == 403
    pid = client.post("/api/projects", headers=h, json={"projectName": "x", "components": [], "wires": []}).json()["id"]
    assert client.delete(f"/api/projects/{pid}", headers=h).status_code == 403
    _, ro = connect(client, approved="mcp:read")
    hr = {"Authorization": f"Bearer {ro['access_token']}"}
    assert client.put(f"/api/projects/{pid}", headers=hr, json={"projectName": "y"}).status_code == 403


def test_mcp_rejects_normal_session_token_and_foreign_origin(client):
    assert rpc(client, client.user_headers["Authorization"][7:], "ping").status_code == 401
    _, tok = connect(client)
    r = client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"},
                    headers={"Authorization": f"Bearer {tok['access_token']}", "Origin": "https://evil.example"})
    assert r.status_code == 403


def test_disconnect_revokes(client):
    _, tok = connect(client)
    grants = client.get("/api/oauth/grants", headers=client.user_headers).json()
    assert len(grants) == 1 and grants[0]["client_name"] == "Hermes"
    assert client.delete(f"/api/oauth/grants/{grants[0]['id']}", headers=client.user_headers).status_code == 200
    assert rpc(client, tok["access_token"], "ping").status_code == 401
    assert client.get("/api/oauth/grants", headers=client.user_headers).json() == []


def test_revoke_endpoint(client):
    cid, tok = connect(client)
    assert client.post("/oauth/revoke", data={"token": tok["refresh_token"], "client_id": cid}).status_code == 200
    assert rpc(client, tok["access_token"], "ping").status_code == 401
