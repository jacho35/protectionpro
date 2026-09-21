"""Shared (team) component libraries.

A shared library is a named set of library entries (cables, transformers, CBs,
fuses, load classes) owned by one user and shared with others by email with a
view/edit role, like project shares. At most one library is the admin-designated
company standard: every user reads it without being a member (read-only).

Entries are stored one row each with a version. A save states the version it is
based on (`base_version`); if someone else changed the entry first the server
answers 409 with the current entry instead of overwriting it.
"""

import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..auth import get_current_user, require_admin
from ..models.database import (get_db, User, SharedLibrary, SharedLibraryMember,
                               SharedLibraryEntry)
from ..models.schemas import (SharedLibraryCreate, SharedLibraryRename,
                              SharedLibraryCompanyFlag, LibraryMemberAdd,
                              LibraryMemberRole, LibraryMemberOut, LibraryEntryIn,
                              LibraryEntryOut, LibraryBulkIn, SharedLibraryOut)

router = APIRouter(prefix="/shared-libraries", tags=["shared-libraries"])

KINDS = ("cables", "transformers", "cbs", "fuses", "loadClasses")
MAX_ENTRY_BYTES = 256 * 1024
_LEVELS = {"view": 0, "edit": 1, "owner": 2}


def _norm_email(email: str) -> str:
    return (email or "").strip().lower()


# ── access ──

def _role_for(db: Session, lib: SharedLibrary, user: User):
    """'owner' | 'edit' | 'view' | None. The company standard is readable by all."""
    if lib.owner_id == user.id:
        return "owner"
    m = (db.query(SharedLibraryMember)
         .filter(SharedLibraryMember.library_id == lib.id,
                 SharedLibraryMember.user_id == user.id).first())
    if m:
        return m.role
    if lib.is_company_default:
        return "view"
    return None


def _get_lib(db: Session, library_id: int, user: User, min_level: str = "view"):
    lib = db.query(SharedLibrary).filter(SharedLibrary.id == library_id).first()
    role = _role_for(db, lib, user) if lib else None
    if role is None:
        raise HTTPException(status_code=404, detail="Library not found")   # don't leak existence
    if _LEVELS[role] < _LEVELS[min_level]:
        raise HTTPException(status_code=403, detail="Insufficient access")
    return lib, role


# ── serialisation ──

def _entry_out(e: SharedLibraryEntry) -> LibraryEntryOut:
    return LibraryEntryOut(kind=e.kind, id=e.entry_id, data=json.loads(e.data),
                           version=e.version,
                           updated_by=e.editor.email if e.editor else None,
                           updated_at=e.updated_at)


def _lib_out(db: Session, lib: SharedLibrary, role: str, with_entries: bool) -> SharedLibraryOut:
    return SharedLibraryOut(
        id=lib.id, name=lib.name, owner_id=lib.owner_id, owner_email=lib.owner.email,
        role=role, is_company_default=lib.is_company_default,
        entries=[_entry_out(e) for e in lib.entries] if with_entries else [])


def _members_out(lib: SharedLibrary) -> list[LibraryMemberOut]:
    return [LibraryMemberOut(user_id=m.user_id, email=m.user.email, name=m.user.name, role=m.role)
            for m in lib.members]


def _check_entry(kind: str, entry_id: str, data: dict) -> str:
    if kind not in KINDS:
        raise HTTPException(status_code=422, detail=f"Unknown library '{kind}'")
    if not entry_id or data.get("id") != entry_id:
        raise HTTPException(status_code=422, detail="Entry data must carry the same id as its path")
    raw = json.dumps(data, separators=(",", ":"))
    if len(raw.encode()) > MAX_ENTRY_BYTES:
        raise HTTPException(status_code=413, detail="Entry too large")
    return raw


def _conflict(entry: SharedLibraryEntry | None, message: str):
    return HTTPException(status_code=409, detail={
        "message": message,
        "current": _entry_out(entry).model_dump(mode="json") if entry else None,
    })


# ── libraries ──

@router.get("", response_model=list[SharedLibraryOut])
def list_libraries(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Every library the caller can read (owned, member of, or the company standard),
    with its entries — one call is all the client needs at sign-in."""
    out, seen = [], set()
    owned = db.query(SharedLibrary).filter(SharedLibrary.owner_id == user.id).all()
    member = (db.query(SharedLibrary).join(SharedLibraryMember)
              .filter(SharedLibraryMember.user_id == user.id).all())
    company = db.query(SharedLibrary).filter(SharedLibrary.is_company_default.is_(True)).all()
    for lib in owned + member + company:
        if lib.id in seen:
            continue
        seen.add(lib.id)
        out.append(_lib_out(db, lib, _role_for(db, lib, user), True))
    return out


@router.post("", response_model=SharedLibraryOut)
def create_library(data: SharedLibraryCreate, user: User = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    name = data.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="A library needs a name")
    lib = SharedLibrary(name=name[:255], owner_id=user.id)
    db.add(lib)
    db.commit()
    db.refresh(lib)
    return _lib_out(db, lib, "owner", True)


@router.patch("/{library_id}", response_model=SharedLibraryOut)
def rename_library(library_id: int, data: SharedLibraryRename,
                   user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    lib, role = _get_lib(db, library_id, user, "owner")
    name = data.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="A library needs a name")
    lib.name = name[:255]
    db.commit()
    return _lib_out(db, lib, role, False)


@router.put("/{library_id}/company-default", response_model=SharedLibraryOut)
def set_company_default(library_id: int, data: SharedLibraryCompanyFlag,
                        admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Admin only. Designates (or clears) the one company standard library."""
    lib = db.query(SharedLibrary).filter(SharedLibrary.id == library_id).first()
    if not lib:
        raise HTTPException(status_code=404, detail="Library not found")
    if data.value:
        db.query(SharedLibrary).filter(SharedLibrary.id != lib.id).update(
            {SharedLibrary.is_company_default: False})
    lib.is_company_default = data.value
    db.commit()
    return _lib_out(db, lib, _role_for(db, lib, admin) or "view", False)


@router.delete("/{library_id}")
def delete_library(library_id: int, user: User = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    lib, _ = _get_lib(db, library_id, user, "owner")
    db.delete(lib)
    db.commit()
    return {"ok": True}


# ── members ──

@router.get("/{library_id}/members", response_model=list[LibraryMemberOut])
def list_members(library_id: int, user: User = Depends(get_current_user),
                 db: Session = Depends(get_db)):
    lib, _ = _get_lib(db, library_id, user, "owner")
    return _members_out(lib)


@router.post("/{library_id}/members", response_model=list[LibraryMemberOut])
def add_member(library_id: int, data: LibraryMemberAdd, user: User = Depends(get_current_user),
               db: Session = Depends(get_db)):
    lib, _ = _get_lib(db, library_id, user, "owner")
    target = db.query(User).filter(User.email == _norm_email(data.email)).first()
    if not target:
        raise HTTPException(status_code=404,
                            detail="No user with that email — they must register first")
    if target.id == lib.owner_id:
        raise HTTPException(status_code=400, detail="You already own this library")
    m = (db.query(SharedLibraryMember)
         .filter(SharedLibraryMember.library_id == lib.id,
                 SharedLibraryMember.user_id == target.id).first())
    if m:
        m.role = data.role
    else:
        db.add(SharedLibraryMember(library_id=lib.id, user_id=target.id, role=data.role))
    db.commit()
    db.refresh(lib)
    return _members_out(lib)


@router.patch("/{library_id}/members/{user_id}", response_model=list[LibraryMemberOut])
def update_member(library_id: int, user_id: int, data: LibraryMemberRole,
                  user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    lib, _ = _get_lib(db, library_id, user, "owner")
    m = (db.query(SharedLibraryMember)
         .filter(SharedLibraryMember.library_id == lib.id,
                 SharedLibraryMember.user_id == user_id).first())
    if not m:
        raise HTTPException(status_code=404, detail="Member not found")
    m.role = data.role
    db.commit()
    db.refresh(lib)
    return _members_out(lib)


@router.delete("/{library_id}/members/{user_id}")
def remove_member(library_id: int, user_id: int, user: User = Depends(get_current_user),
                  db: Session = Depends(get_db)):
    """The owner removes a member, or a member leaves (removes themselves)."""
    lib, role = _get_lib(db, library_id, user, "view")
    if role != "owner" and user_id != user.id:
        raise HTTPException(status_code=403, detail="Only the owner can remove other members")
    m = (db.query(SharedLibraryMember)
         .filter(SharedLibraryMember.library_id == lib.id,
                 SharedLibraryMember.user_id == user_id).first())
    if m:
        db.delete(m)
        db.commit()
    return {"ok": True}


# ── entries (per-entry, versioned) ──

@router.put("/{library_id}/entries/{kind}/{entry_id}", response_model=LibraryEntryOut)
def put_entry(library_id: int, kind: str, entry_id: str, body: LibraryEntryIn,
              user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Create (base_version omitted) or replace (base_version = the version you edited)."""
    lib, _ = _get_lib(db, library_id, user, "edit")
    raw = _check_entry(kind, entry_id, body.data)
    e = (db.query(SharedLibraryEntry)
         .filter(SharedLibraryEntry.library_id == lib.id, SharedLibraryEntry.kind == kind,
                 SharedLibraryEntry.entry_id == entry_id).first())
    if e is None:
        if body.base_version is not None:
            raise _conflict(None, "This entry was deleted by someone else.")
        e = SharedLibraryEntry(library_id=lib.id, kind=kind, entry_id=entry_id,
                               data=raw, version=1, updated_by=user.id)
        db.add(e)
    else:
        if body.base_version is None:
            raise _conflict(e, "An entry with this id already exists.")
        if body.base_version != e.version:
            who = e.editor.email if e.editor else "someone else"
            raise _conflict(e, f"Changed by {who} since you loaded it.")
        e.data, e.version, e.updated_by = raw, e.version + 1, user.id
    lib.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(e)
    return _entry_out(e)


@router.delete("/{library_id}/entries/{kind}/{entry_id}")
def delete_entry(library_id: int, kind: str, entry_id: str, base_version: int | None = None,
                 user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    lib, _ = _get_lib(db, library_id, user, "edit")
    if kind not in KINDS:
        raise HTTPException(status_code=422, detail=f"Unknown library '{kind}'")
    e = (db.query(SharedLibraryEntry)
         .filter(SharedLibraryEntry.library_id == lib.id, SharedLibraryEntry.kind == kind,
                 SharedLibraryEntry.entry_id == entry_id).first())
    if e is None:
        return {"ok": True}
    if base_version is not None and base_version != e.version:
        who = e.editor.email if e.editor else "someone else"
        raise _conflict(e, f"Changed by {who} since you loaded it.")
    db.delete(e)
    db.commit()
    return {"ok": True}


@router.post("/{library_id}/entries/import")
def import_entries(library_id: int, body: LibraryBulkIn, user: User = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    """Add many entries at once (e.g. publishing your own custom entries). Create-only:
    ids that already exist are skipped and reported, never overwritten."""
    lib, _ = _get_lib(db, library_id, user, "edit")
    created, skipped = [], []
    for item in body.entries:
        eid = item.data.get("id")
        raw = _check_entry(item.kind, eid, item.data)
        exists = (db.query(SharedLibraryEntry.id)
                  .filter(SharedLibraryEntry.library_id == lib.id,
                          SharedLibraryEntry.kind == item.kind,
                          SharedLibraryEntry.entry_id == eid).first())
        if exists:
            skipped.append({"kind": item.kind, "id": eid})
            continue
        db.add(SharedLibraryEntry(library_id=lib.id, kind=item.kind, entry_id=eid,
                                  data=raw, version=1, updated_by=user.id))
        created.append({"kind": item.kind, "id": eid})
    db.commit()
    return {"created": created, "skipped": skipped}
