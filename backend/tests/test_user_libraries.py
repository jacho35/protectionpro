"""Per-user library store: isolation between users, replace-whole PUT, validation."""

import os
import tempfile

_TMP_DIR = tempfile.mkdtemp(prefix="protectionpro-test-userlib-")
_TEST_DB_URL = f"sqlite:///{_TMP_DIR}/test_user_libraries.db"
os.environ["DATABASE_URL"] = _TEST_DB_URL

from backend.models import database as _database  # noqa: E402
from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402
import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from backend.main import app  # noqa: E402


@pytest.fixture(scope="module")
def client():
    _database.engine = create_engine(_TEST_DB_URL, connect_args={"check_same_thread": False})
    _database.SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=_database.engine)
    with TestClient(app) as c:
        yield c


_ADMIN = {}


def _login(client, email):
    """First registrant is the admin; everyone after needs an admin-minted invite."""
    if not _ADMIN:
        r = client.post("/api/auth/register", json={"email": "admin@x.com", "password": "password123"})
        _ADMIN["h"] = {"Authorization": f"Bearer {r.json()['access_token']}"}
    r = client.post("/api/auth/login", json={"email": email, "password": "password123"})
    if r.status_code != 200:
        code = client.post("/api/auth/invites", json={}, headers=_ADMIN["h"]).json()["code"]
        r = client.post("/api/auth/register",
                        json={"email": email, "password": "password123", "invite_code": code})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


LIB = {"version": 2,
       "transformers": [{"id": "custom_xfmr_1", "name": "Team 2MVA", "rated_mva": 2}],
       "loadClasses": [{"id": "custom_class_1", "label": "Mine", "admd": 3.3}]}


def test_requires_auth(client):
    assert client.get("/api/user-libraries", headers={"Authorization": ""}).status_code in (401, 403)


def test_empty_then_roundtrip_and_replace(client):
    h = _login(client, "a@x.com")
    assert client.get("/api/user-libraries", headers=h).json()["data"] is None
    r = client.put("/api/user-libraries", json={"data": LIB}, headers=h)
    assert r.status_code == 200 and r.json()["data"] == LIB
    assert client.get("/api/user-libraries", headers=h).json()["data"] == LIB
    smaller = {"version": 2, "fuses": [{"id": "f1", "name": "F"}]}
    client.put("/api/user-libraries", json={"data": smaller}, headers=h)
    assert client.get("/api/user-libraries", headers=h).json()["data"] == smaller   # replaced, not merged


def test_users_are_isolated(client):
    a = _login(client, "iso-a@x.com")
    b = _login(client, "iso-b@x.com")
    client.put("/api/user-libraries", json={"data": LIB}, headers=a)
    assert client.get("/api/user-libraries", headers=b).json()["data"] is None
    client.put("/api/user-libraries", json={"data": {"cbs": [{"id": "x", "name": "X"}]}}, headers=b)
    assert client.get("/api/user-libraries", headers=a).json()["data"] == LIB


@pytest.mark.parametrize("bad", [
    {"nope": []},                              # unknown library
    {"cables": "x"},                           # not a list
    {"cables": [{"name": "no id"}]},           # entry without id
    {"cables": ["str"]},                       # entry not an object
])
def test_validation(client, bad):
    h = _login(client, "val@x.com")
    assert client.put("/api/user-libraries", json={"data": bad}, headers=h).status_code == 422


def test_reset(client):
    h = _login(client, "reset@x.com")
    client.put("/api/user-libraries", json={"data": LIB}, headers=h)
    assert client.delete("/api/user-libraries", headers=h).status_code == 200
    assert client.get("/api/user-libraries", headers=h).json()["data"] is None
