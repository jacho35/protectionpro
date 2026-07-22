"""Python API client (clients/python) — end-to-end against the real app.

The client is exercised in-process by injecting a FastAPI TestClient (an
httpx.Client) — the same wiring documented in clients/python/README.md — over
a temp-file SQLite DB, so auth, project CRUD and analysis runs all cross the
real HTTP/Pydantic layer without a server.
"""

import os
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("SECRET_KEY", "test-secret-key-for-pytest")

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from fastapi.testclient import TestClient

from backend.main import app
from backend.models.database import Base, get_db

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "clients" / "python"))
from protectionpro_client import ProtectionPro, ProtectionProError  # noqa: E402


NETWORK = {
    "projectName": "Client Test Net",
    "baseMVA": 100.0,
    "frequency": 50,
    "components": [
        {"id": "utility-1", "type": "utility", "x": 0, "y": 0,
         "props": {"name": "Grid", "voltage_kv": 11.0, "fault_mva": 100.0,
                   "x_r_ratio": 1000.0}},
        {"id": "bus-1", "type": "bus", "x": 0, "y": 100,
         "props": {"name": "Main Bus", "voltage_kv": 11.0}},
        {"id": "static_load-1", "type": "static_load", "x": 0, "y": 200,
         "props": {"name": "L1", "rated_kva": 5000.0, "power_factor": 0.9,
                   "demand_factor": 1.0, "voltage_kv": 11.0}},
        {"id": "capacitor_bank-1", "type": "capacitor_bank", "x": 100, "y": 200,
         "props": {"name": "PFC", "rated_kvar": 4000.0, "voltage_kv": 11.0}},
    ],
    "wires": [
        {"id": "w1", "fromComponent": "utility-1", "fromPort": "out",
         "toComponent": "bus-1", "toPort": "at_0"},
        {"id": "w2", "fromComponent": "bus-1", "fromPort": "at_1",
         "toComponent": "static_load-1", "toPort": "in"},
        {"id": "w3", "fromComponent": "bus-1", "fromPort": "at_2",
         "toComponent": "capacitor_bank-1", "toPort": "in"},
    ],
}


@pytest.fixture()
def pp():
    tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    tmp.close()
    engine = create_engine(f"sqlite:///{tmp.name}",
                           connect_args={"check_same_thread": False})
    TestSession = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    Base.metadata.create_all(bind=engine)

    def override_get_db():
        db = TestSession()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    client = ProtectionPro(http=TestClient(app))
    client.register("client@test.local", "password123", name="Client")
    yield client
    app.dependency_overrides.clear()
    os.unlink(tmp.name)


class TestPythonClient:
    def test_auth_and_me(self, pp):
        assert pp.token
        assert pp.me()["email"] == "client@test.local"

    def test_bad_login_raises_with_status(self, pp):
        with pytest.raises(ProtectionProError) as e:
            pp.login("client@test.local", "wrong-password")
        assert e.value.status_code == 401

    def test_project_crud_roundtrip(self, pp):
        created = pp.save_project(NETWORK)
        pid = created["id"]
        assert created["name"] == "Client Test Net"
        assert any(p["id"] == pid for p in pp.projects())
        fetched = pp.project(pid)
        assert fetched["projectName"] == "Client Test Net"
        assert {c["id"] for c in fetched["components"]} == \
               {c["id"] for c in NETWORK["components"]}
        exported = pp.export_json(pid)
        assert exported["projectName"] == "Client Test Net"
        pp.delete_project(pid)
        assert not any(p["id"] == pid for p in pp.projects())

    def test_loadflow_through_client(self, pp):
        lf = pp.loadflow(NETWORK)
        assert lf["converged"]
        assert lf["buses"]["bus-1"]["voltage_pu"] == pytest.approx(1.0, abs=1e-6)

    def test_fault_through_client(self, pp):
        """Ik3 at the incomer reproduces the declared 100 MVA fault level:
        100/(√3·11) = 5.25 kA."""
        res = pp.fault(NETWORK, fault_type="3phase")
        bus = res["buses"]["bus-1"]
        assert bus["ik3"] == pytest.approx(100.0 / (3 ** 0.5 * 11.0), rel=0.02)

    def test_frequency_scan_through_client(self, pp):
        """The 4 Mvar bank on the 100 MVA grid resonates at h = √(100/4) = 5."""
        scan = pp.frequency_scan(NETWORK, h_max=10.0)
        assert scan["converged"]
        assert scan["worst_h"] == pytest.approx(5.0, abs=0.1)

    def test_generic_analyze_escape_hatch(self, pp):
        out = pp.analyze("load_diversity", NETWORK)
        assert isinstance(out, dict)

    def test_unauthenticated_call_raises_401(self, pp):
        pp.token = None
        with pytest.raises(ProtectionProError) as e:
            pp.projects()
        assert e.value.status_code == 401
