"""Authentication and invite routes."""

import hashlib
import os
import secrets
import time
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from .. import mailer
from ..models.database import get_db, User, Project, Folder, Invite, PasswordReset, SharedLibrary, DeviceAuth, PlanImage
from ..models.schemas import (
    RegisterRequest, LoginRequest, Token, UserOut,
    InviteCreate, InviteOut, InviteCreated, ForgotRequest, ResetRequest, ChangePasswordRequest, AdminRoleRequest, ApproverRequest, ActiveRequest, ResetLinkRequest,
    DeviceStartRequest, DevicePollRequest,
)
from ..auth import (
    hash_password, verify_password, create_access_token,
    get_current_user, require_admin,
)

router = APIRouter(prefix="/auth", tags=["auth"])


# ── Rate limiting ──
# In-process sliding windows (one uvicorn worker, no extra dependency); nginx adds a
# coarse second layer. Only failed sign-ins count toward the login limits.

_WINDOW = 900
_LOGIN_EMAIL_MAX = 10
_LOGIN_IP_MAX = 30
_IP_MAX = 20
_hits: dict[str, list[float]] = {}


def _now() -> float:
    return time.time()


def _reset_limits():
    _hits.clear()
    _forgot_hits.clear()


# X-Real-IP is only believed when the deployment says a proxy sets it (docker-compose does:
# nginx puts the real client address there). Run bare, a caller could send any value.
_TRUST_PROXY = os.environ.get("PP_TRUST_PROXY", "") not in ("", "0", "false")


def _client_ip(request: Request) -> str:
    peer = request.client.host if request.client else ""
    ip = (request.headers.get("x-real-ip") if _TRUST_PROXY else None) or peer
    return (ip or "unknown").strip()[:64]


def _recent(key: str) -> list[float]:
    now = _now()
    hits = [t for t in _hits.get(key, []) if now - t < _WINDOW]
    if hits:
        _hits[key] = hits
    else:
        _hits.pop(key, None)
    return hits


def _count(key: str):
    if len(_hits) > 5000:   # keys nobody comes back to would otherwise sit there for good
        for k in list(_hits):
            _recent(k)
    _hits[key] = _recent(key) + [_now()]


def _throttled(key: str, limit: int) -> bool:
    return len(_recent(key)) >= limit


def _too_many(msg: str = "Too many attempts. Try again in a few minutes."):
    raise HTTPException(status_code=429, detail=msg, headers={"Retry-After": str(_WINDOW)})


def _ip_limit(request: Request, bucket: str):
    """Count every call to `bucket` from this IP and refuse past the limit."""
    key = f"{bucket}:{_client_ip(request)}"
    if _throttled(key, _IP_MAX):
        _too_many()
    _count(key)


def _clean_text(value: str, limit: int) -> str:
    """Printable characters only (no control or line-break characters), capped."""
    return "".join(c for c in (value or "") if c.isprintable()).strip()[:limit]


def _norm_email(email: str) -> str:
    return (email or "").strip().lower()


def _token_for(user: User) -> Token:
    return Token(access_token=create_access_token(user), token_type="bearer",
                 user=UserOut.model_validate(user))


@router.post("/register", response_model=Token)
def register(data: RegisterRequest, background: BackgroundTasks, request: Request,
             db: Session = Depends(get_db)):
    _ip_limit(request, "register")
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
def login(data: LoginRequest, request: Request, db: Session = Depends(get_db)):
    email = _norm_email(data.email)
    ip_key, email_key = f"login-ip:{_client_ip(request)}", f"login:{email}"
    if _throttled(ip_key, _LOGIN_IP_MAX) or _throttled(email_key, _LOGIN_EMAIL_MAX):
        _too_many("Too many sign-in attempts. Try again in a few minutes.")
    user = db.query(User).filter(User.email == email).first()
    # Generic error for both unknown email and bad password (no enumeration).
    if user is None or not verify_password(data.password, user.password_hash):
        _count(ip_key)
        _count(email_key)
        raise HTTPException(status_code=401, detail="Invalid email or password")
    _hits.pop(email_key, None)
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


@router.post("/change-password", response_model=Token)
def change_password(data: ChangePasswordRequest, user: User = Depends(get_current_user),
                    db: Session = Depends(get_db)):
    """Any signed-in user can change their own password (needs the current one)."""
    if not verify_password(data.current_password, user.password_hash):
        raise HTTPException(status_code=400, detail="Your current password is incorrect")
    if data.current_password == data.new_password:
        raise HTTPException(status_code=400, detail="Choose a password different from the current one")
    user.password_hash = hash_password(data.new_password)
    user.token_version = (user.token_version or 0) + 1   # every other session ends
    db.commit()
    db.refresh(user)
    return _token_for(user)   # this session carries on under the new version


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
    if user.is_admin and not data.is_admin:
        user.token_version = (user.token_version or 0) + 1
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
    if user.is_active and not data.is_active:
        user.token_version = (user.token_version or 0) + 1
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
    db.query(PlanImage).filter(PlanImage.owner_id == user.id).update({PlanImage.owner_id: heir.id}, synchronize_session=False)
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
def forgot_password(data: ForgotRequest, request: Request, db: Session = Depends(get_db)):
    """Always answers the same way (no account enumeration)."""
    _ip_limit(request, "forgot")
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
def reset_password(data: ResetRequest, request: Request, db: Session = Depends(get_db)):
    _ip_limit(request, "reset")
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
    user.token_version = (user.token_version or 0) + 1
    row.used_at = now
    db.commit()
    db.refresh(user)
    return _token_for(user)


# ── Sign in with a link (device-code flow) ──
# A non-browser client (the MCP server) starts a request, shows the person a link
# to /#device=<user_code>, and polls. The person opens the link in the app where
# they are already signed in and approves; the next poll returns a normal token.

DEVICE_MINUTES = 10
DEVICE_POLL_SECONDS = 3
_USER_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"   # no 0/O/1/I/L


def _utc(dt):
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _new_user_code(db) -> str:
    for _ in range(10):
        raw = "".join(secrets.choice(_USER_CODE_ALPHABET) for _ in range(8))
        code = f"{raw[:4]}-{raw[4:]}"
        if not db.query(DeviceAuth).filter(DeviceAuth.user_code == code).first():
            return code
    raise HTTPException(status_code=503, detail="Could not allocate a code, try again")


def _device_by_code(db, user_code: str) -> DeviceAuth:
    code = (user_code or "").strip().upper()
    row = db.query(DeviceAuth).filter(DeviceAuth.user_code == code).first()
    if row is None or _utc(row.expires_at) < datetime.now(timezone.utc):
        raise HTTPException(status_code=404, detail="This sign-in request has expired. Start it again from the client.")
    return row


@router.post("/device/start")
def device_start(data: DeviceStartRequest, request: Request, db: Session = Depends(get_db)):
    _ip_limit(request, "device")
    now = datetime.now(timezone.utc)
    # Housekeeping, and a cap so an anonymous caller can't fill the table.
    db.query(DeviceAuth).filter(DeviceAuth.expires_at < now - timedelta(hours=1)).delete()
    if db.query(DeviceAuth).filter(DeviceAuth.status == "pending",
                                   DeviceAuth.expires_at > now).count() >= 200:
        raise HTTPException(status_code=429, detail="Too many pending sign-in requests")
    device_code = secrets.token_urlsafe(32)
    user_code = _new_user_code(db)
    db.add(DeviceAuth(device_hash=hashlib.sha256(device_code.encode()).hexdigest(),
                      user_code=user_code,
                      client_name=_clean_text(data.client_name, 40),
                      expires_at=now + timedelta(minutes=DEVICE_MINUTES)))
    db.commit()
    return {"device_code": device_code, "user_code": user_code,
            "verification_path": f"/#device={user_code}",
            "expires_in": DEVICE_MINUTES * 60, "interval": DEVICE_POLL_SECONDS}


@router.post("/device/poll")
def device_poll(data: DevicePollRequest, db: Session = Depends(get_db)):
    digest = hashlib.sha256((data.device_code or "").encode()).hexdigest()
    row = db.query(DeviceAuth).filter(DeviceAuth.device_hash == digest).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Unknown sign-in request")
    if row.status == "used" or _utc(row.expires_at) < datetime.now(timezone.utc):
        return {"status": "expired"}
    if row.status == "denied":
        return {"status": "denied"}
    if row.status != "approved":
        return {"status": "pending"}
    user = db.query(User).filter(User.id == row.user_id).first()
    if user is None or not user.is_active:
        return {"status": "denied"}
    row.status = "used"            # a token is handed out exactly once
    db.commit()
    tok = Token(access_token=create_access_token(user, amr="device"), token_type="bearer",
                user=UserOut.model_validate(user))
    return {"status": "approved", "access_token": tok.access_token,
            "token_type": "bearer", "user": tok.user}


@router.get("/device/{user_code}")
def device_info(user_code: str, user: User = Depends(get_current_user),
                db: Session = Depends(get_db)):
    row = _device_by_code(db, user_code)
    return {"user_code": row.user_code, "client_name": row.client_name,
            "status": row.status, "email": user.email}


def _device_decide(user_code, status, user, db):
    row = _device_by_code(db, user_code)
    if row.status != "pending":
        raise HTTPException(status_code=409, detail="This request was already answered")
    row.status = status
    row.user_id = user.id
    db.commit()
    return {"status": status}


@router.post("/device/{user_code}/approve")
def device_approve(user_code: str, user: User = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    return _device_decide(user_code, "approved", user, db)


@router.post("/device/{user_code}/deny")
def device_deny(user_code: str, user: User = Depends(get_current_user),
                db: Session = Depends(get_db)):
    return _device_decide(user_code, "denied", user, db)
