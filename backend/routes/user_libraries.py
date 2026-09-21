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
from ..models.database import get_db, User, UserLibrary, UserDefaultRates
from ..models.schemas import UserLibraryIn, UserLibraryOut, UserDefaultRatesOut

router = APIRouter(prefix="/user-libraries", tags=["user-libraries"])

LIBRARY_KEYS = ("cables", "transformers", "cbs", "fuses", "loadClasses")
MAX_BYTES = 5 * 1024 * 1024


def _is_entries(val) -> bool:
    return isinstance(val, list) and all(isinstance(e, dict) and e.get("id") for e in val)


def _validate(data: dict) -> str:
    """Two document formats. v2 (no `format`): each library is a full list of entries.
    'overrides': each library is {set: [entries], removed: [ids]} — only what the user
    changed relative to the shipped/shared libraries underneath."""
    fmt = data.get("format")
    if fmt not in (None, "overrides"):
        raise HTTPException(status_code=422, detail=f"Unknown format '{fmt}'")
    for key, val in data.items():
        if key in ("version", "format"):
            continue
        if key not in LIBRARY_KEYS:
            raise HTTPException(status_code=422, detail=f"Unknown library '{key}'")
        if fmt == "overrides":
            ok = (isinstance(val, dict) and _is_entries(val.get("set", []))
                  and isinstance(val.get("removed", []), list)
                  and all(isinstance(r, str) for r in val.get("removed", [])))
            if not ok:
                raise HTTPException(status_code=422,
                                    detail=f"Library '{key}' must be {{set: [entries with an id], removed: [ids]}}")
        elif not _is_entries(val):
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
        # An old app tab still saving full copies would flatten the user's overrides.
        if json.loads(row.data).get("format") == "overrides" and body.data.get("format") != "overrides":
            raise HTTPException(status_code=409,
                                detail="Your libraries were saved by a newer version of the app — reload the page.")
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


# ── The user's default rates (seed for a new project's rate library) ──

def _validate_rates(data: dict) -> str:
    if not isinstance(data.get("items", {}), dict) or not isinstance(data.get("custom", {}), dict):
        raise HTTPException(status_code=422, detail="Default rates need 'items' and 'custom' objects")
    raw = json.dumps(data, separators=(",", ":"))
    if len(raw.encode()) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="Rate data too large")
    return raw


@router.get("/default-rates", response_model=UserDefaultRatesOut)
def get_my_default_rates(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    row = db.query(UserDefaultRates).filter(UserDefaultRates.user_id == user.id).first()
    if row is None:
        return UserDefaultRatesOut(data=None, updated_at=None)
    return UserDefaultRatesOut(data=json.loads(row.data), updated_at=row.updated_at)


@router.put("/default-rates", response_model=UserDefaultRatesOut)
def save_my_default_rates(body: UserLibraryIn, user: User = Depends(get_current_user),
                          db: Session = Depends(get_db)):
    raw = _validate_rates(body.data)
    row = db.query(UserDefaultRates).filter(UserDefaultRates.user_id == user.id).first()
    if row is None:
        row = UserDefaultRates(user_id=user.id, data=raw)
        db.add(row)
    else:
        row.data = raw
    db.commit()
    db.refresh(row)
    return UserDefaultRatesOut(data=json.loads(row.data), updated_at=row.updated_at)


@router.delete("/default-rates")
def delete_my_default_rates(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    db.query(UserDefaultRates).filter(UserDefaultRates.user_id == user.id).delete()
    db.commit()
    return {"ok": True}
