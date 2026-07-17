"""Authentication utilities and FastAPI dependencies.

JWT bearer auth (HS256) with bcrypt password hashing. The signing secret comes
from the SECRET_KEY env var, else a value persisted in the app_settings table
(generated once), so tokens survive restarts and no default is ever committed.

Kept separate from routes/auth.py so the dependencies (get_current_user,
require_admin, require_project) can be imported by the project/report routers
without a circular import through the router module.
"""

import os
import secrets
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.orm import Session

from .models.database import get_db, User, Project, ProjectShare, AppSetting

ALGORITHM = "HS256"
TOKEN_TTL = timedelta(days=7)

_SECRET_CACHE = None


def _load_or_create_secret() -> str:
    """Resolve the JWT secret: env → persisted app_setting → generate+persist.

    Called lazily (not at import) because it touches the DB, which must be
    initialised first. Cached after first resolution.
    """
    global _SECRET_CACHE
    if _SECRET_CACHE:
        return _SECRET_CACHE
    env = os.environ.get("SECRET_KEY")
    if env:
        _SECRET_CACHE = env
        return _SECRET_CACHE
    from .models.database import SessionLocal
    db = SessionLocal()
    try:
        row = db.query(AppSetting).filter(AppSetting.key == "jwt_secret").first()
        if row:
            _SECRET_CACHE = row.value
        else:
            _SECRET_CACHE = secrets.token_hex(32)
            db.add(AppSetting(key="jwt_secret", value=_SECRET_CACHE))
            db.commit()
    finally:
        db.close()
    return _SECRET_CACHE


# ── Password hashing (bcrypt) ──

def hash_password(password: str) -> str:
    # bcrypt silently truncates > 72 bytes; encode then hash the raw bytes.
    return bcrypt.hashpw(password.encode("utf-8")[:72], bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8")[:72], password_hash.encode("utf-8"))
    except (ValueError, TypeError):
        return False


# ── JWT ──

def create_access_token(user: User) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user.id),
        "email": user.email,
        "iat": now,
        "exp": now + TOKEN_TTL,
    }
    return jwt.encode(payload, _load_or_create_secret(), algorithm=ALGORITHM)


def decode_token(token: str) -> dict:
    return jwt.decode(token, _load_or_create_secret(), algorithms=[ALGORITHM])


# ── Dependencies ──

_bearer = HTTPBearer(auto_error=False)


def _unauthorized(detail: str = "Not authenticated") -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


def get_current_user(
    cred: HTTPAuthorizationCredentials = Depends(_bearer),
    db: Session = Depends(get_db),
) -> User:
    if cred is None or not cred.credentials:
        raise _unauthorized()
    try:
        payload = decode_token(cred.credentials)
        user_id = int(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError):
        raise _unauthorized("Invalid or expired token")
    user = db.query(User).filter(User.id == user_id).first()
    if user is None or not user.is_active:
        raise _unauthorized("User not found or deactivated")
    return user


def require_admin(user: User = Depends(get_current_user)) -> User:
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


# ── Project access control ──

_LEVELS = {"view": 0, "edit": 1, "owner": 2}


def resolve_access(db: Session, project: Project, user: User):
    """Return the caller's access to a project: 'owner' | 'edit' | 'view' | None."""
    if project.owner_id == user.id:
        return "owner"
    share = (db.query(ProjectShare)
             .filter(ProjectShare.project_id == project.id,
                     ProjectShare.user_id == user.id)
             .first())
    return share.role if share else None


def require_project(min_level: str = "view"):
    """Dependency factory: load the project at {project_id} and enforce access.

    Returns (project, level). Raises 404 when the caller has no access at all
    (don't leak existence of others' projects) and 403 when they have some
    access but not enough (e.g. a viewer hitting an edit endpoint).
    """
    def dep(project_id: int,
            db: Session = Depends(get_db),
            user: User = Depends(get_current_user)):
        project = db.query(Project).filter(Project.id == project_id).first()
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")
        level = resolve_access(db, project, user)
        if level is None:
            raise HTTPException(status_code=404, detail="Project not found")
        if _LEVELS[level] < _LEVELS[min_level]:
            raise HTTPException(status_code=403, detail="Insufficient access")
        return project, level
    return dep
