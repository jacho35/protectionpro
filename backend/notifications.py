"""Notification service — the one place that writes notifications.

Routes call `notify()` *before* their own `db.commit()`, so the notification is
stored in the same transaction as the change it announces (no notification for a
rolled-back change, no change without its notification).
"""

import json
import logging
import threading
from datetime import datetime, timezone

from sqlalchemy import event
from sqlalchemy.orm import Session

from .models import database as _db
from .models.database import Notification, User, NotificationPref

log = logging.getLogger("protectionpro.notifications")

CATEGORIES = ("libraries", "projects", "approvals")


def display_name(user: User | None) -> str:
    if user is None:
        return "Someone"
    return (user.name or "").strip() or user.email


def all_active_user_ids(db: Session) -> set[int]:
    return {uid for (uid,) in db.query(User.id).filter(User.is_active.is_(True)).all()}


def notify(db: Session, user_ids, category: str, kind: str, message: str, *,
           actor: User | None = None, link: dict | None = None,
           group_key: str | None = None, message_many: str | None = None) -> None:
    """Notify each of `user_ids` (the actor is always skipped — nobody needs to be
    told about their own action). With a `group_key`, an unread notification with
    the same key is updated in place (count + 1, text refreshed, bumped to the top)
    instead of adding another row."""
    if category not in CATEGORIES:
        raise ValueError(f"unknown notification category {category!r}")
    now = datetime.now(timezone.utc)
    link_json = json.dumps(link, separators=(",", ":")) if link else None
    actor_id = actor.id if actor is not None else None
    for uid in set(user_ids):
        if uid == actor_id:
            continue
        existing = None
        if group_key:
            existing = (db.query(Notification)
                        .filter(Notification.user_id == uid, Notification.group_key == group_key,
                                Notification.read_at.is_(None)).first())
        if existing:
            existing.count += 1
            existing.kind, existing.message, existing.message_many = kind, message, message_many
            existing.link, existing.actor_id, existing.created_at = link_json, actor_id, now
        else:
            db.add(Notification(user_id=uid, actor_id=actor_id, category=category, kind=kind,
                                message=message, message_many=message_many, count=1,
                                link=link_json, group_key=group_key, created_at=now))
            if kind not in NO_EMAIL_KINDS:
                db.info.setdefault("pending_emails", []).append((uid, category, message))


def render_message(n: Notification) -> str:
    if n.count > 1 and n.message_many:
        return n.message_many.replace("{count}", str(n.count))
    return n.message


# ── Email (optional): a user who opted in gets new notifications by email ──

# Edits on a shared project arrive in bursts; they stay in the bell.
NO_EMAIL_KINDS = {"project_edited"}
DEFAULT_CATEGORIES = ["libraries", "projects", "approvals"]
EMAIL_SYNC = False          # tests: deliver in the committing thread


def get_prefs(db: Session, user_id: int) -> tuple[bool, list[str]]:
    row = db.query(NotificationPref).filter(NotificationPref.user_id == user_id).first()
    if row is None:
        return False, list(DEFAULT_CATEGORIES)
    try:
        cats = [c for c in json.loads(row.categories) if c in CATEGORIES]
    except ValueError:
        cats = list(DEFAULT_CATEGORIES)
    return bool(row.email_enabled), cats


def deliver_emails(pending: list) -> None:
    """Send one email per opted-in user listing their new notifications. Never raises."""
    from . import mailer
    db = _db.SessionLocal()
    try:
        cfg = mailer.get_config(db)
        if not cfg:
            return
        by_user: dict[int, list[str]] = {}
        for uid, category, message in pending:
            enabled, cats = get_prefs(db, uid)
            if enabled and category in cats:
                by_user.setdefault(uid, []).append(message)
        for uid, msgs in by_user.items():
            user = db.query(User).filter(User.id == uid, User.is_active.is_(True)).first()
            if not user:
                continue
            n = len(msgs)
            subject = f"ProtectionPro: {msgs[0]}" if n == 1 else f"ProtectionPro: {n} new notifications"
            text = "\n\n".join(msgs) + "\n\nOpen ProtectionPro to see them. You can turn these emails off in the notifications panel."
            try:
                mailer.send_email(cfg, user.email, subject[:200], text)
            except Exception as e:           # a mail problem must never affect the app
                log.warning("Notification email to user %s failed: %s", uid, e)
    except Exception as e:
        log.warning("Notification emails failed: %s", e)
    finally:
        db.close()


@event.listens_for(Session, "after_commit")
def _send_pending_emails(session):
    pending = session.info.pop("pending_emails", None)
    if not pending:
        return
    if EMAIL_SYNC:
        deliver_emails(pending)
    else:
        threading.Thread(target=deliver_emails, args=(pending,), daemon=True).start()


@event.listens_for(Session, "after_rollback")
def _drop_pending_emails(session):
    session.info.pop("pending_emails", None)
