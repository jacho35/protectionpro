"""Revision history: snapshots, explicit-state snapshots, eviction order, access."""

import os
import tempfile

_TMP_DIR = tempfile.mkdtemp(prefix="protectionpro-test-db-")
_TEST_DB_URL = f"sqlite:///{_TMP_DIR}/test_revisions.db"
os.environ["DATABASE_URL"] = _TEST_DB_URL

import json  # noqa: E402

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402

from backend.models import database as _database  # noqa: E402
from backend.main import app  # noqa: E402
from backend.routes import projects as projects_routes  # noqa: E402


def _proj(name, n_buses=1):
    return {"projectName": name, "baseMVA": 100, "frequency": 50, "wires": [],
            "components": [{"id": f"bus_{i}", "type": "bus", "x": 0, "y": i * 100,
                            "rotation": 0, "props": {"name": f"B{i}"}}
                           for i in range(1, n_buses + 1)]}


@pytest.fixture(scope="module")
def client():
    # Rebind the shared DB globals (other API test modules rebind them too).
    _database.engine = create_engine(_TEST_DB_URL, connect_args={"check_same_thread": False})
    _database.SessionLocal = sessionmaker(autocommit=False, autoflush=False,
                                          bind=_database.engine)
    with TestClient(app) as c:
        reg = c.post("/api/auth/register",
                     json={"email": "rev-admin@x.com", "password": "password123"})
        assert reg.status_code == 200, reg.text
        c.headers["Authorization"] = f"Bearer {reg.json()['access_token']}"
        yield c


def _new(client, name="P", n=1):
    r = client.post("/api/projects", json=_proj(name, n))
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _rev(client, pid, label, **kw):
    r = client.post(f"/api/projects/{pid}/revisions", json={"label": label, **kw})
    assert r.status_code == 200, r.text
    return r.json()


def test_snapshot_is_the_saved_state_and_newest_first(client):
    pid = _new(client, n=1)
    first = _rev(client, pid, "one")
    client.put(f"/api/projects/{pid}", json=_proj("P", 3))
    second = _rev(client, pid, "two")
    listed = client.get(f"/api/projects/{pid}/revisions").json()
    assert [r["label"] for r in listed] == ["two", "one"]
    n = lambda rid: len(json.loads(client.get(
        f"/api/projects/{pid}/revisions/{rid}").json()["data"])["components"])
    assert (n(first["id"]), n(second["id"])) == (1, 3)


def test_explicit_state_is_snapshotted_not_the_saved_one(client):
    """The browser's unsaved diagram ('Before restore') must be what is stored."""
    pid = _new(client, n=1)
    rev = _rev(client, pid, "Before restore", data=_proj("P", 5))
    data = json.loads(client.get(f"/api/projects/{pid}/revisions/{rev['id']}").json()["data"])
    assert len(data["components"]) == 5
    # the saved project itself is untouched
    assert len(client.get(f"/api/projects/{pid}").json()["components"]) == 1


def test_invalid_explicit_state_rejected(client):
    pid = _new(client)
    r = client.post(f"/api/projects/{pid}/revisions",
                    json={"label": "x", "data": {"components": "nope"}})
    assert r.status_code == 422


def test_cap_evicts_autosaves_and_agent_snapshots_before_manual_saves(client):
    pid = _new(client)
    _rev(client, pid, "Manual save")
    _rev(client, pid, "Before MCP update of bus_1")
    for i in range(projects_routes.MAX_REVISIONS + 5):
        _rev(client, pid, "Auto-save")
    labels = [r["label"] for r in client.get(f"/api/projects/{pid}/revisions").json()]
    assert len(labels) == projects_routes.MAX_REVISIONS
    assert "Manual save" in labels
    assert "Before MCP update of bus_1" not in labels


def test_cap_still_holds_when_everything_is_manual(client):
    pid = _new(client)
    for i in range(projects_routes.MAX_REVISIONS + 3):
        _rev(client, pid, f"Manual {i}")
    labels = [r["label"] for r in client.get(f"/api/projects/{pid}/revisions").json()]
    assert len(labels) == projects_routes.MAX_REVISIONS
    assert labels[0] == f"Manual {projects_routes.MAX_REVISIONS + 2}"  # newest kept
    assert "Manual 0" not in labels


def test_delete_revision_and_project_cascade(client):
    pid = _new(client)
    rev = _rev(client, pid, "x")
    assert client.delete(f"/api/projects/{pid}/revisions/{rev['id']}").status_code == 200
    assert client.get(f"/api/projects/{pid}/revisions/{rev['id']}").status_code == 404
    _rev(client, pid, "y")
    assert client.delete(f"/api/projects/{pid}").status_code == 200
    with _database.SessionLocal() as db:
        assert db.query(_database.Revision).filter_by(project_id=pid).count() == 0


def test_revisions_are_scoped_to_their_project(client):
    a, b = _new(client, "A"), _new(client, "B")
    rev = _rev(client, a, "mine")
    assert client.get(f"/api/projects/{b}/revisions/{rev['id']}").status_code == 404
    assert client.get(f"/api/projects/{b}/revisions").json() == []
