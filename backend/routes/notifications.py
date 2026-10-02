"""Notifications center API — every route is scoped to the signed-in user."""

import json
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..auth import get_current_user
from ..models.database import get_db, User, Notification
from ..models.database import NotificationPref
from ..models.schemas import (NotificationOut, NotificationList, NotificationsRead, UnreadCounts,
                              NotificationPrefs, NotificationPrefsOut)
from ..notifications import CATEGORIES, display_name, render_message, get_prefs
from .. import mailer

router = APIRouter(prefix="/notifications", tags=["notifications"])

RETAIN_READ_DAYS = 90


def _out(n: Notification) -> NotificationOut:
    return NotificationOut(
        id=n.id, category=n.category, kind=n.kind, message=render_message(n), count=n.count,
        link=json.loads(n.link) if n.link else None,
        actor=display_name(n.actor) if n.actor else None,
        created_at=n.created_at, read=n.read_at is not None)


def _counts(db: Session, user: User) -> UnreadCounts:
    rows = (db.query(Notification.category, func.count(Notification.id))
            .filter(Notification.user_id == user.id, Notification.read_at.is_(None))
            .group_by(Notification.category).all())
    by = {c: 0 for c in CATEGORIES}
    by.update({c: n for c, n in rows})
    return UnreadCounts(total=sum(by.values()), by_category=by)


@router.get("", response_model=NotificationList)
def list_notifications(category: str | None = None, unread_only: bool = False,
                       before_id: int | None = None, limit: int = Query(50, ge=1, le=200),
                       user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if category is not None and category not in CATEGORIES:
        raise HTTPException(status_code=422, detail="Unknown category")
    # Housekeeping: read notifications expire.
    cutoff = datetime.now(timezone.utc) - timedelta(days=RETAIN_READ_DAYS)
    db.query(Notification).filter(Notification.user_id == user.id,
                                  Notification.read_at.isnot(None),
                                  Notification.read_at < cutoff).delete(synchronize_session=False)
    db.commit()
    q = db.query(Notification).filter(Notification.user_id == user.id)
    if category:
        q = q.filter(Notification.category == category)
    if unread_only:
        q = q.filter(Notification.read_at.is_(None))
    if before_id is not None:
        q = q.filter(Notification.id < before_id)
    rows = q.order_by(Notification.created_at.desc(), Notification.id.desc()).limit(limit + 1).all()
    return NotificationList(items=[_out(n) for n in rows[:limit]], has_more=len(rows) > limit,
                            unread=_counts(db, user))


@router.get("/unread-count", response_model=UnreadCounts)
def unread_count(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _counts(db, user)


@router.post("/read", response_model=UnreadCounts)
def mark_read(body: NotificationsRead, user: User = Depends(get_current_user),
              db: Session = Depends(get_db)):
    """Mark the listed ids read, or — with no ids — everything (optionally one category)."""
    q = db.query(Notification).filter(Notification.user_id == user.id,
                                      Notification.read_at.is_(None))
    if body.ids is not None:
        q = q.filter(Notification.id.in_(body.ids))
    elif body.category:
        if body.category not in CATEGORIES:
            raise HTTPException(status_code=422, detail="Unknown category")
        q = q.filter(Notification.category == body.category)
    q.update({Notification.read_at: datetime.now(timezone.utc)}, synchronize_session=False)
    db.commit()
    return _counts(db, user)


@router.get("/preferences", response_model=NotificationPrefsOut)
def get_preferences(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    enabled, cats = get_prefs(db, user.id)
    return NotificationPrefsOut(email_enabled=enabled, categories=cats, email_available=mailer.get_config(db) is not None)


@router.put("/preferences", response_model=NotificationPrefsOut)
def set_preferences(body: NotificationPrefs, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    cats = [c for c in body.categories if c in CATEGORIES]
    row = db.query(NotificationPref).filter(NotificationPref.user_id == user.id).first()
    if row is None:
        row = NotificationPref(user_id=user.id)
        db.add(row)
    row.email_enabled, row.categories = body.email_enabled, json.dumps(cats)
    db.commit()
    return NotificationPrefsOut(email_enabled=row.email_enabled, categories=cats, email_available=mailer.get_config(db) is not None)


@router.delete("/{notification_id}")
def delete_notification(notification_id: int, user: User = Depends(get_current_user),
                        db: Session = Depends(get_db)):
    db.query(Notification).filter(Notification.id == notification_id,
                                  Notification.user_id == user.id).delete(synchronize_session=False)
    db.commit()
    return {"ok": True}
