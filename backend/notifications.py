"""Notification service — the one place that writes notifications.

Routes call `notify()` *before* their own `db.commit()`, so the notification is
stored in the same transaction as the change it announces (no notification for a
rolled-back change, no change without its notification).
"""

import json
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from .models.database import Notification, User

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


def render_message(n: Notification) -> str:
    if n.count > 1 and n.message_many:
        return n.message_many.replace("{count}", str(n.count))
    return n.message
