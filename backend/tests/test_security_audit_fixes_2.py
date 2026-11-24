"""Regression tests for the 2026-11 security audit fixes (SEC-05 .. SEC-07)."""

import threading

from backend.tests.test_auth import client, _hdr, _register  # noqa: F401


# ── SEC-05: logout ends the session server-side ──

def test_logout_revokes_the_token(client):
    token = _register(client, "admin@x.com").json()["access_token"]
    assert client.get("/api/auth/me", headers=_hdr(token)).status_code == 200
    assert client.post("/api/auth/logout", headers=_hdr(token)).status_code == 200
    assert client.get("/api/auth/me", headers=_hdr(token)).status_code == 401
    login = client.post("/api/auth/login", json={"email": "admin@x.com", "password": "password123"})
    assert login.status_code == 200
    assert client.get("/api/auth/me", headers=_hdr(login.json()["access_token"])).status_code == 200


# ── SEC-06: the first account cannot be claimed twice, or without the setup key ──

def test_setup_key_is_required_when_configured(client, monkeypatch):
    monkeypatch.setenv("BOOTSTRAP_TOKEN", "s3cret-key")
    assert _register(client, "evil@x.com").status_code == 403
    assert _register(client, "evil@x.com", invite="wrong").status_code == 403
    r = _register(client, "admin@x.com", invite="s3cret-key")
    assert r.status_code == 200 and r.json()["user"]["is_admin"] is True
    # once set up, the key is not an invite
    assert _register(client, "late@x.com", invite="s3cret-key").status_code == 400


def test_simultaneous_first_registrations_make_one_admin(client):
    results = []

    def go(i):
        results.append(_register(client, f"u{i}@x.com"))

    threads = [threading.Thread(target=go, args=(i,)) for i in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    ok = [r for r in results if r.status_code == 200]
    assert len(ok) == 1 and ok[0].json()["user"]["is_admin"] is True


# ── SEC-07: passwords longer than bcrypt reads are refused, not truncated ──

def test_overlong_passwords_are_rejected(client):
    long_pw = "a" * 73
    assert _register(client, "a@x.com", password=long_pw).status_code == 422
    # multi-byte characters count as bytes: 37 x 2 bytes = 74
    assert _register(client, "a@x.com", password="é" * 37).status_code == 422
    token = _register(client, "a@x.com", password="a" * 72).json()["access_token"]
    r = client.post("/api/auth/change-password",
                    json={"current_password": "a" * 72, "new_password": "b" * 73}, headers=_hdr(token))
    assert r.status_code == 422
