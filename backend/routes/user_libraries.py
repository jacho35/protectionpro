"""Per-user component libraries — the app-level library store.

Libraries (cables, transformers, CBs, fuses, load classes) belong to the user, not
to a project: projects only record which custom entries they use and are reconciled
with these on open (see frontend StandardData.reviewProjectLibraries). One JSON
document per user, replaced whole on save (last write wins).
"""

import json

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..auth import get_current_user
from ..models.database import get_db, User, UserLibrary
from ..models.schemas import UserLibraryIn, UserLibraryOut

router = APIRouter(prefix="/user-libraries", tags=["user-libraries"])

LIBRARY_KEYS = ("cables", "transformers", "cbs", "fuses", "loadClasses")
MAX_BYTES = 5 * 1024 * 1024


def _validate(data: dict) -> str:
    """Only the five known libraries, each a list of objects that have an id."""
    for key, val in data.items():
        if key == "version":
            continue
        if key not in LIBRARY_KEYS:
            raise HTTPException(status_code=422, detail=f"Unknown library '{key}'")
        if not isinstance(val, list) or any(not isinstance(e, dict) or not e.get("id") for e in val):
            raise HTTPException(status_code=422, detail=f"Library '{key}' must be a list of entries with an id")
    raw = json.dumps(data, separators=(",", ":"))
    if len(raw.encode()) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="Library data too large")
    return raw


@router.get("", response_model=UserLibraryOut)
def get_my_libraries(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    row = db.query(UserLibrary).filter(UserLibrary.user_id == user.id).first()
    if row is None:
        return UserLibraryOut(data=None, updated_at=None)
    return UserLibraryOut(data=json.loads(row.data), updated_at=row.updated_at)


@router.put("", response_model=UserLibraryOut)
def save_my_libraries(body: UserLibraryIn, user: User = Depends(get_current_user),
                      db: Session = Depends(get_db)):
    raw = _validate(body.data)
    row = db.query(UserLibrary).filter(UserLibrary.user_id == user.id).first()
    if row is None:
        row = UserLibrary(user_id=user.id, data=raw)
        db.add(row)
    else:
        row.data = raw
    db.commit()
    db.refresh(row)
    return UserLibraryOut(data=json.loads(row.data), updated_at=row.updated_at)


@router.delete("")
def reset_my_libraries(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Forget the user's saved libraries (back to the shipped defaults)."""
    db.query(UserLibrary).filter(UserLibrary.user_id == user.id).delete()
    db.commit()
    return {"ok": True}
