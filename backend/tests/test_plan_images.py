"""Plan Markup image-store API tests.

Pins the contract the frontend relies on: multipart upload returns metadata
(never the bytes), GET returns the exact bytes back, orphan uploads can be
claimed by a project, deletes are idempotent, oversize is rejected, and — the
reason the store exists at all — the binary never rides in the project JSON.

Uses a dedicated temp SQLite DB so the real protectionpro.db is untouched.
"""

import os
import tempfile

# ── Redirect the database to a temp file BEFORE the app is imported ──
_TMP_DIR = tempfile.mkdtemp(prefix="protectionpro-test-planimg-")
_TEST_DB_URL = f"sqlite:///{_TMP_DIR}/test_plan_images.db"
os.environ["DATABASE_URL"] = _TEST_DB_URL

from backend.models import database as _database  # noqa: E402

from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from backend.main import app  # noqa: E402

# 1x1 opaque-red PNG
_PNG_BYTES = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108020000009077"
    "53de0000000c49444154789c6360f8cf00000301010018dd8db10000000049454e44ae426082"
)


@pytest.fixture(scope="module")
def client():
    # Force this module's temp DB regardless of test collection order, then
    # let the TestClient context manager fire startup (init_db) against it.
    _database.engine = create_engine(
        _TEST_DB_URL, connect_args={"check_same_thread": False}
    )
    _database.SessionLocal = sessionmaker(
        autocommit=False, autoflush=False, bind=_database.engine
    )
    with TestClient(app) as c:
        yield c


def _upload(client, data=_PNG_BYTES, mime="image/png", **form):
    files = {"file": ("plan.png", data, mime)}
    return client.post("/api/plan-images", files=files, data=form)


# ── Upload → meta returns metadata without bytes ──

def test_upload_returns_metadata(client):
    resp = _upload(client, kind="raster", name="Site Layout", width=800, height=600)
    assert resp.status_code == 200, resp.text
    meta = resp.json()
    assert meta["id"] > 0
    assert meta["kind"] == "raster"
    assert meta["name"] == "Site Layout"
    assert meta["mime"] == "image/png"
    assert meta["width"] == 800 and meta["height"] == 600
    assert meta["size_bytes"] == len(_PNG_BYTES)
    assert meta["project_id"] is None
    # The binary must never be echoed in the metadata payload.
    assert "data" not in meta


# ── GET returns the exact bytes back ──

def test_get_returns_exact_bytes(client):
    image_id = _upload(client).json()["id"]
    got = client.get(f"/api/plan-images/{image_id}")
    assert got.status_code == 200
    assert got.content == _PNG_BYTES
    assert got.headers["content-type"] == "image/png"
    assert "immutable" in got.headers.get("cache-control", "")


def test_get_meta_omits_data(client):
    image_id = _upload(client, name="meta-test").json()["id"]
    meta = client.get(f"/api/plan-images/{image_id}/meta")
    assert meta.status_code == 200
    body = meta.json()
    assert body["id"] == image_id
    assert body["name"] == "meta-test"
    assert "data" not in body


# ── PATCH claims an orphan for a project ──

def test_claim_orphan_for_project(client):
    # A real project must exist — FK enforcement (PRAGMA foreign_keys=ON)
    # rejects claiming an image for a non-existent project id.
    proj = client.post("/api/projects", json={
        "projectName": "Claim Target", "baseMVA": 100.0, "frequency": 50,
        "components": [], "wires": [],
    })
    assert proj.status_code == 200, proj.text
    project_id = proj.json()["id"]

    image_id = _upload(client).json()["id"]
    assert _upload(client).json()["project_id"] is None
    resp = client.patch(f"/api/plan-images/{image_id}", json={"project_id": project_id})
    assert resp.status_code == 200, resp.text
    assert resp.json()["project_id"] == project_id


def test_project_delete_nulls_image_fk(client):
    # ondelete="SET NULL" must actually fire (proves FK enforcement is on),
    # leaving the image as a claimable/cleanable orphan rather than dangling.
    proj = client.post("/api/projects", json={
        "projectName": "Delete Me", "baseMVA": 100.0, "frequency": 50,
        "components": [], "wires": [],
    })
    project_id = proj.json()["id"]
    image_id = _upload(client, project_id=project_id).json()["id"]
    assert client.get(f"/api/plan-images/{image_id}/meta").json()["project_id"] == project_id

    assert client.delete(f"/api/projects/{project_id}").status_code == 200
    # Image survives, project_id nulled.
    meta = client.get(f"/api/plan-images/{image_id}/meta")
    assert meta.status_code == 200
    assert meta.json()["project_id"] is None


# ── DELETE is idempotent (404-tolerant) ──

def test_delete_is_idempotent(client):
    image_id = _upload(client).json()["id"]
    first = client.delete(f"/api/plan-images/{image_id}")
    assert first.status_code == 200 and first.json() == {"ok": True}
    # Second delete of the same id must still succeed.
    second = client.delete(f"/api/plan-images/{image_id}")
    assert second.status_code == 200 and second.json() == {"ok": True}
    # And the bytes are gone.
    assert client.get(f"/api/plan-images/{image_id}").status_code == 404


# ── Validation ──

def test_oversize_rejected(client):
    big = b"\x00" * (60 * 1024 * 1024 + 1)
    resp = _upload(client, data=big)
    assert resp.status_code == 413, resp.text


def test_bad_mime_rejected(client):
    resp = _upload(client, data=b"BMdata", mime="image/gif")
    assert resp.status_code == 400


def test_bad_kind_rejected(client):
    resp = _upload(client, kind="bogus")
    assert resp.status_code == 400


def test_missing_image_404(client):
    assert client.get("/api/plan-images/999999").status_code == 404
    assert client.get("/api/plan-images/999999/meta").status_code == 404
    assert client.patch("/api/plan-images/999999", json={"project_id": 1}).status_code == 404
