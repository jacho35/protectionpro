"""Live co-editing relay (WS /api/projects/{id}/live): auth, roles, relay, saved."""

import pytest
from starlette.websockets import WebSocketDisconnect

from backend.tests.test_auth import client, _two_users, _hdr, _register  # noqa: F401


def _share(client, admin, pid, role, email="bob@x.com"):
    r = client.post(f"/api/projects/{pid}/shares", json={"email": email, "role": role},
                    headers=_hdr(admin))
    assert r.status_code == 200


def _open(client, pid, token, **hello):
    ws = client.websocket_connect(f"/api/projects/{pid}/live")
    sock = ws.__enter__()
    sock.send_json({"type": "hello", "token": token, **hello})
    return ws, sock


def test_ops_are_relayed_to_the_other_editor_but_not_echoed(client):
    admin, bob, pid = _two_users(client)
    _share(client, admin, pid, "edit")
    wa, a = _open(client, pid, admin)
    wb, b = _open(client, pid, bob)
    try:
        wel_a = a.receive_json()
        assert wel_a["type"] == "welcome" and wel_a["role"] == "edit" and wel_a["peers"] == []
        wel_b = b.receive_json()
        assert [p["client_id"] for p in wel_b["peers"]] == [wel_a["client_id"]]
        assert a.receive_json()["type"] == "peer_join"

        ops = [{"k": "comp", "id": "bus_1", "v": {"id": "bus_1", "x": 40}}]
        a.send_json({"type": "ops", "ops": ops})
        got = b.receive_json()
        assert got == {"type": "ops", "from": wel_a["client_id"], "seq": 1, "ops": ops}

        # a is not sent its own ops: its next message is the pong
        a.send_json({"type": "ping"})
        assert a.receive_json()["type"] == "pong"
    finally:
        wa.__exit__(None, None, None)
        wb.__exit__(None, None, None)


def test_view_only_receives_but_cannot_send_ops(client):
    admin, bob, pid = _two_users(client)
    _share(client, admin, pid, "view")
    wa, a = _open(client, pid, admin)
    wb, b = _open(client, pid, bob)
    try:
        a.receive_json()                      # welcome
        assert b.receive_json()["role"] == "view"
        a.receive_json()                      # peer_join
        b.send_json({"type": "ops", "ops": [{"k": "comp", "id": "x", "v": None}]})
        assert b.receive_json() == {"type": "error", "message": "view-only"}
        b.send_json({"type": "presence", "sel": ["bus_1"]})
        got = a.receive_json()
        assert got["type"] == "presence" and got["sel"] == ["bus_1"]
        a.send_json({"type": "ops", "ops": [{"k": "wire", "id": "w1", "v": None}]})
        assert b.receive_json()["type"] == "ops"
    finally:
        wa.__exit__(None, None, None)
        wb.__exit__(None, None, None)


def test_bad_token_and_no_access_are_refused(client):
    admin, bob, pid = _two_users(client)
    for token, code in (("garbage", 4401), (bob, 4404)):   # bob has no share yet
        with client.websocket_connect(f"/api/projects/{pid}/live") as ws:
            ws.send_json({"type": "hello", "token": token})
            with pytest.raises(WebSocketDisconnect) as e:
                ws.receive_json()
            assert e.value.code == code
    with client.websocket_connect(f"/api/projects/{pid}/live") as ws:
        ws.send_json({"type": "nonsense"})
        with pytest.raises(WebSocketDisconnect) as e:
            ws.receive_json()
        assert e.value.code == 4400


def test_save_is_announced_with_the_new_version(client):
    admin, bob, pid = _two_users(client)
    _share(client, admin, pid, "edit")
    wb, b = _open(client, pid, bob)
    try:
        b.receive_json()                      # welcome
        body = {"projectName": "P1", "components": [], "wires": []}
        r = client.put(f"/api/projects/{pid}", json=body, headers=_hdr(admin))
        assert r.status_code == 200
        got = b.receive_json()
        assert got["type"] == "saved" and got["version"] == r.json()["version"]
    finally:
        wb.__exit__(None, None, None)


def test_reconnect_replays_only_what_was_missed(client):
    admin, bob, pid = _two_users(client)
    _share(client, admin, pid, "edit")
    wa, a = _open(client, pid, admin, session="sa")
    wb, b = _open(client, pid, bob, session="sb")
    try:
        a.receive_json(); b.receive_json(); a.receive_json()          # welcomes, peer_join
        a.send_json({"type": "ops", "ops": [{"k": "comp", "id": "bus_16", "v": {"id": "bus_16"}}]})
        first = b.receive_json()
        assert first["type"] == "ops" and first["seq"] == 1
        wb.__exit__(None, None, None)                                  # bob drops
        a.receive_json()                                               # peer_leave
        a.send_json({"type": "ops", "ops": [{"k": "comp", "id": "bus_32", "v": {"id": "bus_32"}}]})
        a.send_json({"type": "ping"}); assert a.receive_json()["type"] == "pong"

        wb, b = _open(client, pid, bob, session="sb", since=1)          # back, saw seq 1
        wel = b.receive_json()
        assert wel["resync"] is False and wel["seq"] == 2
        rep = b.receive_json()
        assert rep["type"] == "replay"
        assert [(x["seq"], x["ops"][0]["id"]) for x in rep["batches"]] == [(2, "bus_32")]
        wb.__exit__(None, None, None)

        # The sender's own batches are never replayed back to it.
        wa2, a2 = _open(client, pid, admin, session="sa", since=0)
        wel = a2.receive_json()
        assert wel["resync"] is False
        a2.send_json({"type": "ping"})
        assert a2.receive_json()["type"] == "pong"                      # no replay in between
        wa2.__exit__(None, None, None)

        # A seq the server can't vouch for (it restarted, or the log rolled over) => resync.
        wb, b = _open(client, pid, bob, session="sb", since=99)
        assert b.receive_json()["resync"] is True
    finally:
        wa.__exit__(None, None, None)
        wb.__exit__(None, None, None)
