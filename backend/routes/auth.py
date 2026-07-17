"""Authentication and invite routes."""

import secrets
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..models.database import get_db, User, Project, Folder, Invite
from ..models.schemas import (
    RegisterRequest, LoginRequest, Token, UserOut,
    InviteCreate, InviteOut,
)
from ..auth import (
    hash_password, verify_password, create_access_token,
    get_current_user, require_admin,
)

router = APIRouter(prefix="/auth", tags=["auth"])


def _norm_email(email: str) -> str:
    return (email or "").strip().lower()


def _token_for(user: User) -> Token:
    return Token(access_token=create_access_token(user), token_type="bearer",
                 user=UserOut.model_validate(user))


@router.post("/register", response_model=Token)
def register(data: RegisterRequest, db: Session = Depends(get_db)):
    email = _norm_email(data.email)
    if "@" not in email or len(email) < 3:
        raise HTTPException(status_code=400, detail="A valid email is required")
    if db.query(User).filter(User.email == email).first():
        raise HTTPException(status_code=400, detail="An account with that email already exists")

    first_user = db.query(User).count() == 0

    invite = None
    if not first_user:
        code = (data.invite_code or "").strip()
        if not code:
            raise HTTPException(status_code=400, detail="An invite code is required to register")
        invite = db.query(Invite).filter(Invite.code == code).first()
        now = datetime.now(timezone.utc)
        if (invite is None or invite.used_by is not None
                or (invite.expires_at is not None and invite.expires_at < now)):
            raise HTTPException(status_code=400, detail="Invalid or expired invite code")
        if invite.email and _norm_email(invite.email) != email:
            raise HTTPException(status_code=400,
                                detail="This invite is for a different email address")

    user = User(
        email=email,
        password_hash=hash_password(data.password),
        name=(data.name or "").strip(),
        is_admin=first_user,
        is_active=True,
    )
    db.add(user)
    db.flush()   # assign user.id

    if first_user:
        # Bootstrap-claim: assign all pre-existing ownerless data to the admin
        # so current projects/folders keep working under the new auth model.
        db.query(Project).filter(Project.owner_id.is_(None)).update(
            {Project.owner_id: user.id}, synchronize_session=False)
        db.query(Folder).filter(Folder.owner_id.is_(None)).update(
            {Folder.owner_id: user.id}, synchronize_session=False)
    else:
        invite.used_by = user.id
        invite.used_at = datetime.now(timezone.utc)

    db.commit()
    db.refresh(user)
    return _token_for(user)


@router.post("/login", response_model=Token)
def login(data: LoginRequest, db: Session = Depends(get_db)):
    email = _norm_email(data.email)
    user = db.query(User).filter(User.email == email).first()
    # Generic error for both unknown email and bad password (no enumeration).
    if user is None or not verify_password(data.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    if not user.is_active:
        raise HTTPException(status_code=403, detail="This account has been deactivated")
    return _token_for(user)


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)):
    return user


@router.post("/logout")
def logout(user: User = Depends(get_current_user)):
    # Stateless JWT — the client discards the token. Endpoint exists for symmetry.
    return {"ok": True}


# ── Admin invite management ──

@router.get("/invites", response_model=list[InviteOut])
def list_invites(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    return db.query(Invite).order_by(Invite.created_at.desc()).all()


@router.post("/invites", response_model=InviteOut)
def create_invite(data: InviteCreate, admin: User = Depends(require_admin),
                  db: Session = Depends(get_db)):
    invite = Invite(
        code=secrets.token_urlsafe(24),
        email=_norm_email(data.email) if data.email else None,
        created_by=admin.id,
        expires_at=data.expires_at,
    )
    db.add(invite)
    db.commit()
    db.refresh(invite)
    return invite


@router.delete("/invites/{invite_id}")
def delete_invite(invite_id: int, admin: User = Depends(require_admin),
                  db: Session = Depends(get_db)):
    invite = db.query(Invite).filter(Invite.id == invite_id).first()
    if invite:
        db.delete(invite)
        db.commit()
    return {"ok": True}
