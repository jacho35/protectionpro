import pytest


@pytest.fixture(autouse=True)
def _fresh_auth_limits():
    """The sign-in throttles are process-wide; every test starts with empty windows."""
    from backend.routes import auth
    auth._reset_limits()
    yield
    auth._reset_limits()
