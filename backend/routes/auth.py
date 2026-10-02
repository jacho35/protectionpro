"""Authentication and invite routes."""

import hashlib
import secrets
import time
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import mailer
from ..models.database import get_db, User, Project, Folder, Invite, PasswordReset, SharedLibrary
from ..models.schemas import (
    RegisterRequest, LoginRequest, Token, UserOut,
    InviteCreate, InviteOut, InviteCreated, ForgotRequest, ResetRequest, ChangePasswordRequest, AdminRoleRequest, ApproverRequest, ActiveRequest, ResetLinkRequest,
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
def register(data: RegisterRequest, background: BackgroundTasks, db: Session = Depends(get_db)):
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
        exp = invite.expires_at if invite else None
        if exp is not None and exp.tzinfo is None:
            exp = exp.replace(tzinfo=timezone.utc)   # SQLite hands back naive datetimes
        if invite is None or invite.used_by is not None or (exp is not None and exp < now):
            raise HTTPException(status_code=400, detail="Invalid or expired invite code")
        if invite.email and _norm_email(invite.email) != email:
            raise HTTPException(status_code=400,
                                detail="This invite is for a different email address")

    user = User(
        email=email,
        password_hash=hash_password(data.password),
        name=(data.name or "").strip(),
        is_admin=first_user or bool(invite and invite.is_admin),
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
    cfg = mailer.get_config(db)
    if cfg and not first_user and cfg.get("welcome_auto", True) and _base(cfg, None):
        background.add_task(_send_welcome, cfg, user.name, user.email)   # best effort, off the request
    return _token_for(user)


def _send_welcome(cfg, name, email):
    subject, text, html = mailer.welcome_message(name, email, _base(cfg, None), cfg.get("welcome_note", ""))
    try:
        mailer.send_email(cfg, email, subject, text, html)
    except mailer.MailError:
        pass


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


@router.get("/users/search")
def search_users(q: str = "", user: User = Depends(get_current_user),
                 db: Session = Depends(get_db)):
    """Registered, active users matching name/email — feeds the share picker."""
    q = (q or "").strip().lower().replace("%", "").replace("_", "")
    if not q:
        return []
    like = f"%{q}%"
    rows = (db.query(User)
            .filter(User.is_active == True, User.id != user.id)  # noqa: E712
            .filter((User.email.like(like)) | (User.name.ilike(like)))
            .order_by(User.name, User.email).limit(8).all())
    return [{"id": u.id, "email": u.email, "name": u.name} for u in rows]


@router.post("/change-password")
def change_password(data: ChangePasswordRequest, user: User = Depends(get_current_user),
                    db: Session = Depends(get_db)):
    """Any signed-in user can change their own password (needs the current one)."""
    if not verify_password(data.current_password, user.password_hash):
        raise HTTPException(status_code=400, detail="Your current password is incorrect")
    if data.current_password == data.new_password:
        raise HTTPException(status_code=400, detail="Choose a password different from the current one")
    user.password_hash = hash_password(data.new_password)
    db.commit()
    return {"ok": True}


@router.post("/logout")
def logout(user: User = Depends(get_current_user)):
    # Stateless JWT — the client discards the token. Endpoint exists for symmetry.
    return {"ok": True}


# ── Admin invite management ──

@router.get("/invites", response_model=list[InviteOut])
def list_invites(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    return db.query(Invite).order_by(Invite.created_at.desc()).all()


RESET_MINUTES = 60
_forgot_hits: dict = {}   # ip/email → recent request times (in-memory throttle)


def _base(cfg, supplied, trusted=False):
    """Origin used in links. The admin-configured address always wins; a
    client-supplied one is accepted only from an authenticated admin
    (`trusted=True`), and only if it is a plain http(s) URL. Unauthenticated
    callers (forgot-password) never influence it — otherwise an attacker could
    have a victim's reset link emailed pointing at their own domain."""
    base = ((cfg or {}).get("app_url") or (supplied if trusted else "") or "").strip().rstrip("/")
    return base if mailer.valid_base_url(base) else ""


def _invite_link(base: str, code: str) -> str:
    return f"{base}/#invite={code}"


def _reset_link(base: str, token: str) -> str:
    return f"{base}/#reset={token}"


def _expiry_days(inv: Invite) -> int:
    if not inv.expires_at:
        return 0
    exp = inv.expires_at if inv.expires_at.tzinfo else inv.expires_at.replace(tzinfo=timezone.utc)
    return max(1, round((exp - datetime.now(timezone.utc)).total_seconds() / 86400))


def _email_invite(db, inv: Invite, admin: User, base_url, note=""):
    """(emailed, error). Never raises."""
    cfg = mailer.get_config(db)
    if not cfg:
        return False, "Email isn't set up on this server."
    if not inv.email:
        return False, "This invite has no email address."
    base = _base(cfg, base_url, trusted=True)
    if not base:
        return False, "No server address known for the link."
    subject, text, html = mailer.invite_message(
        admin.name or admin.email, _invite_link(base, inv.code), _expiry_days(inv) or 7, note)
    try:
        mailer.send_email(cfg, inv.email, subject, text, html)
        return True, None
    except mailer.MailError as e:
        return False, str(e)


@router.post("/invites", response_model=InviteCreated)
def create_invite(data: InviteCreate, admin: User = Depends(require_admin),
                  db: Session = Depends(get_db)):
    email = _norm_email(data.email) if data.email else None
    if email and not mailer.valid_address(email):
        raise HTTPException(status_code=400, detail="That email address doesn't look right")
    expires = data.expires_at
    if data.expires_days:
        expires = datetime.now(timezone.utc) + timedelta(days=data.expires_days)
    invite = Invite(code=secrets.token_urlsafe(24), email=email, is_admin=data.is_admin,
                    created_by=admin.id, expires_at=expires)
    db.add(invite)
    db.commit()
    db.refresh(invite)
    cfg = mailer.get_config(db)
    emailed, err = False, None
    if data.send_email:
        emailed, err = _email_invite(db, invite, admin, data.base_url, data.note or "")
    return InviteCreated(id=invite.id, code=invite.code, email=invite.email,
                         expires_at=invite.expires_at,
                         link=_invite_link(_base(cfg, data.base_url, trusted=True), invite.code),
                         emailed=emailed, email_error=err)


@router.post("/invites/{invite_id}/send")
def resend_invite(invite_id: int, data: ResetLinkRequest, admin: User = Depends(require_admin),
                  db: Session = Depends(get_db)):
    inv = db.query(Invite).filter(Invite.id == invite_id).first()
    if not inv or inv.used_by is not None:
        raise HTTPException(status_code=404, detail="Invite not found or already used")
    emailed, err = _email_invite(db, inv, admin, data.base_url)
    return {"emailed": emailed, "email_error": err}


@router.get("/invite-check/{code}")
def check_invite(code: str, db: Session = Depends(get_db)):
    """Public: lets the join screen show who invited you and lock the email."""
    inv = db.query(Invite).filter(Invite.code == code).first()
    now = datetime.now(timezone.utc)
    exp = inv.expires_at if inv and inv.expires_at and inv.expires_at.tzinfo else (
        inv.expires_at.replace(tzinfo=timezone.utc) if inv and inv.expires_at else None)
    if not inv or inv.used_by is not None or (exp and exp < now):
        return {"valid": False}
    return {"valid": True, "email": inv.email or "", "is_admin": inv.is_admin, "inviter": inv.creator.name or inv.creator.email}


@router.delete("/invites/{invite_id}")
def delete_invite(invite_id: int, admin: User = Depends(require_admin),
                  db: Session = Depends(get_db)):
    invite = db.query(Invite).filter(Invite.id == invite_id).first()
    if invite:
        db.delete(invite)
        db.commit()
    return {"ok": True}


# ── Users (admin) and password reset ──

@router.get("/users")
def list_users(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    return [{"id": u.id, "email": u.email, "name": u.name, "is_admin": u.is_admin,
             "is_approver": bool(u.is_approver), "is_active": u.is_active} for u in db.query(User).order_by(User.name, User.email).all()]


@router.patch("/users/{user_id}/admin")
def set_admin(user_id: int, data: AdminRoleRequest, admin: User = Depends(require_admin),
              db: Session = Depends(get_db)):
    """Promote a user to administrator, or demote one. Admin only."""
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.id == admin.id:
        raise HTTPException(status_code=400, detail="You can't change your own role. Ask another administrator.")
    if not data.is_admin and user.is_admin:
        others = db.query(User).filter(User.is_admin == True, User.is_active == True,  # noqa: E712
                                       User.id != user.id).count()
        if others == 0:
            raise HTTPException(status_code=400, detail="There must be at least one administrator.")
    if data.is_admin and not user.is_active:
        raise HTTPException(status_code=400, detail="That account is deactivated.")
    user.is_admin = data.is_admin
    db.commit()
    return {"id": user.id, "is_admin": user.is_admin}


def _guard_other_user(db, admin: User, user_id: int, verb: str) -> User:
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.id == admin.id:
        raise HTTPException(status_code=400, detail=f"You can't {verb} your own account.")
    if user.is_admin and user.is_active:
        others = db.query(User).filter(User.is_admin == True, User.is_active == True,  # noqa: E712
                                       User.id != user.id).count()
        if others == 0:
            raise HTTPException(status_code=400, detail="There must be at least one active administrator.")
    return user


@router.patch("/users/{user_id}/approver")
def set_approver(user_id: int, data: ApproverRequest, admin: User = Depends(require_admin),
                 db: Session = Depends(get_db)):
    """Make a user a library approver (or remove that). Admin only. Administrators approve anyway."""
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if data.is_approver and not user.is_active:
        raise HTTPException(status_code=400, detail="That account is deactivated.")
    user.is_approver = data.is_approver
    db.commit()
    return {"id": user.id, "is_approver": user.is_approver}


@router.patch("/users/{user_id}/active")
def set_active(user_id: int, data: ActiveRequest, admin: User = Depends(require_admin),
               db: Session = Depends(get_db)):
    """Deactivate (blocks sign-in, keeps everything) or reactivate a user."""
    user = _guard_other_user(db, admin, user_id, "deactivate") if not data.is_active else (
        db.query(User).filter(User.id == user_id).first())
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    user.is_active = data.is_active
    db.commit()
    return {"id": user.id, "is_active": user.is_active}


@router.delete("/users/{user_id}")
def delete_user(user_id: int, transfer_to: int = None, admin: User = Depends(require_admin),
                db: Session = Depends(get_db)):
    """Remove a user. Their projects, folders and team libraries move to
    `transfer_to` (default: the deleting admin); their shares, memberships and
    personal libraries go."""
    user = _guard_other_user(db, admin, user_id, "delete")
    heir = admin
    if transfer_to is not None:
        heir = db.query(User).filter(User.id == transfer_to).first()
        if not heir or not heir.is_active or heir.id == user.id:
            raise HTTPException(status_code=400, detail="Choose an active user to receive their projects.")
    moved = db.query(Project).filter(Project.owner_id == user.id).count()
    db.query(Project).filter(Project.owner_id == user.id).update({Project.owner_id: heir.id}, synchronize_session=False)
    db.query(Folder).filter(Folder.owner_id == user.id).update({Folder.owner_id: heir.id}, synchronize_session=False)
    db.query(SharedLibrary).filter(SharedLibrary.owner_id == user.id).update({SharedLibrary.owner_id: heir.id}, synchronize_session=False)
    db.query(Invite).filter(Invite.created_by == user.id).update({Invite.created_by: heir.id}, synchronize_session=False)
    db.query(Invite).filter(Invite.used_by == user.id).update({Invite.used_by: None}, synchronize_session=False)
    db.delete(user)
    db.commit()
    return {"ok": True, "projects_moved": moved, "transferred_to": heir.id}


def _new_reset(db, user: User) -> str:
    token = secrets.token_urlsafe(32)
    db.add(PasswordReset(user_id=user.id, token_hash=hashlib.sha256(token.encode()).hexdigest(),
                         expires_at=datetime.now(timezone.utc) + timedelta(minutes=RESET_MINUTES)))
    db.commit()
    return token


def _email_reset(cfg, user: User, link: str):
    subject, text, html = mailer.reset_message(user.name, link, RESET_MINUTES)
    mailer.send_email(cfg, user.email, subject, text, html)


@router.post("/users/{user_id}/welcome")
def send_welcome(user_id: int, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    cfg = mailer.get_config(db)
    if not cfg:
        raise HTTPException(status_code=400, detail="Email isn't set up on this server. Set it up in Settings › Email.")
    base = _base(cfg, None)
    if not base:
        raise HTTPException(status_code=400, detail="Set the server address in Settings › Email first.")
    subject, text, html = mailer.welcome_message(user.name, user.email, base, cfg.get("welcome_note", ""))
    try:
        mailer.send_email(cfg, user.email, subject, text, html)
    except mailer.MailError as e:
        return {"emailed": False, "email_error": str(e)}
    return {"emailed": True, "email_error": None}


@router.post("/forgot")
def forgot_password(data: ForgotRequest, db: Session = Depends(get_db)):
    """Always answers the same way (no account enumeration)."""
    cfg = mailer.get_config(db)
    out = {"ok": True, "email_enabled": cfg is not None}
    if not cfg:
        return out
    email = _norm_email(data.email)
    now = time.time()
    hits = [t for t in _forgot_hits.get(email, []) if now - t < 900]
    if len(hits) >= 5:
        return out
    _forgot_hits[email] = hits + [now]
    user = db.query(User).filter(User.email == email, User.is_active == True).first()  # noqa: E712
    base = _base(cfg, data.base_url)
    if user and base:
        token = _new_reset(db, user)
        try:
            _email_reset(cfg, user, _reset_link(base, token))
        except mailer.MailError:
            pass   # admin sees failures via the test button; the user gets the generic answer
    return out


@router.post("/users/{user_id}/reset-link")
def admin_reset_link(user_id: int, data: ResetLinkRequest, admin: User = Depends(require_admin),
                     db: Session = Depends(get_db)):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    cfg = mailer.get_config(db)
    link = _reset_link(_base(cfg, data.base_url, trusted=True), _new_reset(db, user))
    emailed, err = False, None
    if data.send_email:
        if not cfg:
            err = "Email isn't set up on this server."
        else:
            try:
                _email_reset(cfg, user, link)
                emailed = True
            except mailer.MailError as e:
                err = str(e)
    return {"link": link, "emailed": emailed, "email_error": err, "expires_minutes": RESET_MINUTES}


@router.post("/reset", response_model=Token)
def reset_password(data: ResetRequest, db: Session = Depends(get_db)):
    h = hashlib.sha256(data.token.strip().encode()).hexdigest()
    row = db.query(PasswordReset).filter(PasswordReset.token_hash == h).first()
    now = datetime.now(timezone.utc)
    exp = row.expires_at if row and row.expires_at.tzinfo else (
        row.expires_at.replace(tzinfo=timezone.utc) if row else None)
    if not row or row.used_at is not None or exp < now:
        raise HTTPException(status_code=400, detail="This reset link is invalid or has expired")
    user = db.query(User).filter(User.id == row.user_id).first()
    if not user or not user.is_active:
        raise HTTPException(status_code=400, detail="This reset link is invalid or has expired")
    user.password_hash = hash_password(data.password)
    row.used_at = now
    db.commit()
    db.refresh(user)
    return _token_for(user)
