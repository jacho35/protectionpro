"""Regression tests for the 2026-11 security audit fixes (SEC-01 .. SEC-04)."""

import pytest
from starlette.websockets import WebSocketDisconnect

from backend.tests.test_auth import client, _two_users, _hdr, _register  # noqa: F401
from backend.tests.test_collab import _share, _open
from backend.routes import collab

_PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108020000009077"
    "53de0000000c49444154789c6360f8cf00000301010018dd8db10000000049454e44ae426082"
)


# ── SEC-01: a consumed invite stays consumed after its user is deleted ──

def test_deleted_users_invite_cannot_be_reused(client):
    admin = _register(client, "admin@x.com").json()["access_token"]
    code = client.post("/api/auth/invites", json={"is_admin": True}, headers=_hdr(admin)).json()["code"]
    r = _register(client, "second@x.com", invite=code)
    assert r.status_code == 200
    uid = r.json()["user"]["id"]
    assert client.delete(f"/api/auth/users/{uid}", headers=_hdr(admin)).status_code == 200
    again = _register(client, "second@x.com", invite=code)
    assert again.status_code == 400
    other = _register(client, "third@x.com", invite=code)
    assert other.status_code == 400


# ── SEC-04: image authority follows the project's current permissions ──

def test_former_collaborator_loses_hold_on_attached_image(client):
    admin, bob, pid = _two_users(client)
    _share(client, admin, pid, "edit")
    up = client.post("/api/plan-images", files={"file": ("p.png", _PNG, "image/png")},
                     data={"project_id": str(pid), "kind": "raster"}, headers=_hdr(bob))
    assert up.status_code == 200, up.text
    iid = up.json()["id"]
    assert client.get(f"/api/plan-images/{iid}", headers=_hdr(bob)).status_code == 200

    # downgraded to viewer: can read, cannot delete
    client.patch(f"/api/projects/{pid}/shares/2", json={"role": "view"}, headers=_hdr(admin))
    client.delete(f"/api/plan-images/{iid}", headers=_hdr(bob))
    assert client.get(f"/api/plan-images/{iid}", headers=_hdr(admin)).status_code == 200

    # share removed: no access at all, owner's copy intact
    client.delete(f"/api/projects/{pid}/shares/2", headers=_hdr(admin))
    assert client.get(f"/api/plan-images/{iid}", headers=_hdr(bob)).status_code == 404
    client.delete(f"/api/plan-images/{iid}", headers=_hdr(bob))
    assert client.get(f"/api/plan-images/{iid}", headers=_hdr(admin)).status_code == 200


def test_unattached_upload_stays_with_uploader(client):
    admin, bob, pid = _two_users(client)
    up = client.post("/api/plan-images", files={"file": ("p.png", _PNG, "image/png")},
                     data={"kind": "raster"}, headers=_hdr(bob))
    iid = up.json()["id"]
    assert client.get(f"/api/plan-images/{iid}", headers=_hdr(bob)).status_code == 200
    assert client.get(f"/api/plan-images/{iid}", headers=_hdr(admin)).status_code == 404


# ── SEC-02: live sockets end when access is revoked ──

def test_removing_a_share_closes_the_live_socket(client):
    admin, bob, pid = _two_users(client)
    _share(client, admin, pid, "edit")
    wb, b = _open(client, pid, bob)
    try:
        assert b.receive_json()["type"] == "welcome"
        client.delete(f"/api/projects/{pid}/shares/2", headers=_hdr(admin))
        with pytest.raises(WebSocketDisconnect) as e:
            b.receive_json()
        assert e.value.code == 4403
    finally:
        wb.__exit__(None, None, None)


def test_deactivating_a_user_closes_the_live_socket(client):
    admin, bob, pid = _two_users(client)
    _share(client, admin, pid, "edit")
    wb, b = _open(client, pid, bob)
    try:
        assert b.receive_json()["type"] == "welcome"
        client.patch("/api/auth/users/2/active", json={"is_active": False}, headers=_hdr(admin))
        with pytest.raises(WebSocketDisconnect) as e:
            b.receive_json()
        assert e.value.code == 4403
    finally:
        wb.__exit__(None, None, None)


def test_expired_token_ends_the_socket(client):
    admin, bob, pid = _two_users(client)
    wa, a = _open(client, pid, admin)
    try:
        assert a.receive_json()["type"] == "welcome"
        for room in collab._rooms.values():
            for p in room.values():
                p.exp = 1.0
        a.send_json({"type": "ping"})
        with pytest.raises(WebSocketDisconnect) as e:
            a.receive_json()
        assert e.value.code == 4401
    finally:
        wa.__exit__(None, None, None)


# ── SEC-03: bounded work and retained state ──

def test_malformed_and_oversized_ops_are_rejected(client):
    admin, bob, pid = _two_users(client)
    wa, a = _open(client, pid, admin)
    try:
        a.receive_json()
        for bad in ("nope", [1, 2], [{}] * (collab.MAX_OPS_PER_BATCH + 1)):
            a.send_json({"type": "ops", "ops": bad})
            assert a.receive_json() == {"type": "error", "message": "malformed ops"}
    finally:
        wa.__exit__(None, None, None)


def test_ops_rate_is_limited_and_log_bytes_are_capped(client, monkeypatch):
    monkeypatch.setattr(collab, "OPS_PER_WINDOW", 3)
    monkeypatch.setattr(collab, "MAX_LOG_BYTES", 1500)
    admin, bob, pid = _two_users(client)
    wa, a = _open(client, pid, admin)
    try:
        a.receive_json()
        for _ in range(3):
            a.send_json({"type": "ops", "ops": [{"k": "comp", "id": "x", "v": "y" * 600}]})
        a.send_json({"type": "ops", "ops": [{"k": "comp"}]})
        assert a.receive_json()["message"] == "too many edits, slow down"
        log = collab._logs[pid]
        assert log[2] <= 1500 and len(log[1]) < 3
    finally:
        wa.__exit__(None, None, None)


def test_load_flow_refuses_networks_too_big_for_the_dense_solver():
    from backend.analysis import loadflow
    from backend.models.schemas import ProjectData, Component
    n = loadflow.MAX_DENSE_BUSES + 1
    comps = [Component(id=f"bus_{i}", type="bus", x=0, y=0, props={"voltage_kv": 0.4}) for i in range(n)]
    with pytest.raises(ValueError, match="limited to"):
        loadflow.run_load_flow(ProjectData(components=comps, wires=[]))
