"""Title-block template uploaded from the app: admin only, validated, kept beside the DB, used by the export."""
import io
import os
import tempfile

_TMP_DIR = tempfile.mkdtemp(prefix="protectionpro-test-tplup-")
_TEST_DB_URL = f"sqlite:///{_TMP_DIR}/test_tplup.db"
os.environ["DATABASE_URL"] = _TEST_DB_URL
os.environ["PP_DXF_UPLOADS"] = os.path.join(_TMP_DIR, "uploads")
os.environ["PP_DXF_TEMPLATES"] = os.path.join(_TMP_DIR, "none")

import ezdxf  # noqa: E402
import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402

from backend.main import app  # noqa: E402
from backend.models import database as _database  # noqa: E402

URL = "/api/plan/dxf-template"


def _template_bytes(with_tb=True) -> bytes:
    d = ezdxf.new("R2010")
    b = d.blocks.new("CO-TB-A3" if with_tb else "PLAIN")
    b.add_lwpolyline([(5, 5), (415, 5), (415, 292), (5, 292)], close=True)
    b.add_line((335, 5), (335, 292))
    s = io.StringIO()
    d.write(s)
    return s.getvalue().encode()


@pytest.fixture(scope="module")
def client():
    _database.engine = create_engine(_TEST_DB_URL, connect_args={"check_same_thread": False})
    _database.SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=_database.engine)
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="module")
def heads(client):
    r = client.post("/api/auth/register", json={"email": "admin@x.com", "password": "password123"})
    admin = {"Authorization": f"Bearer {r.json()['access_token']}"}
    code = client.post("/api/auth/invites", json={"is_admin": False}, headers=admin).json()["code"]
    r = client.post("/api/auth/register", json={"email": "u@x.com", "password": "password123", "invite_code": code})
    return admin, {"Authorization": f"Bearer {r.json()['access_token']}"}


def test_upload_replace_remove(client, heads):
    admin, user = heads
    assert client.get(URL, headers=user).json()["available"] is False
    r = client.post(URL, files={"file": ("t.dxf", _template_bytes())}, headers=admin)
    assert r.status_code == 200 and r.json()["available"] and r.json()["name"] == "CO" and "A3" in r.json()["papers"]
    assert client.get(URL, headers=user).json()["available"] is True      # every user sees it
    r = client.delete(URL, headers=admin)
    assert r.status_code == 200 and r.json()["available"] is False


def test_admin_only(client, heads):
    _, user = heads
    assert client.post(URL, files={"file": ("t.dxf", _template_bytes())}, headers=user).status_code == 403
    assert client.delete(URL, headers=user).status_code == 403


def test_rejects_dxf_without_title_blocks_and_junk(client, heads):
    admin, _ = heads
    r = client.post(URL, files={"file": ("t.dxf", _template_bytes(False))}, headers=admin)
    assert r.status_code == 400 and "title blocks" in r.json()["detail"]
    assert client.post(URL, files={"file": ("t.dxf", b"not a dxf")}, headers=admin).status_code == 400
    assert client.get(URL, headers=admin).json()["available"] is False
