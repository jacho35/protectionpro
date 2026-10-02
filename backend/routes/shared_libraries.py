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
import re
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..auth import get_current_user, require_admin
from ..notifications import notify, display_name, all_active_user_ids
from ..models.database import (get_db, User, SharedLibrary, SharedLibraryMember,
                               SharedLibraryEntry, UserLibrary, LibraryActivity)
from ..models.schemas import (SharedLibraryCreate, SharedLibraryRename,
                              SharedLibraryCompanyFlag, LibraryMemberAdd,
                              LibraryMemberRole, LibraryMemberOut, LibraryEntryIn,
                              LibraryEntryOut, LibraryBulkIn, SharedLibraryOut,
                              SharedLibraryCurrency, LibraryUpsertIn, EntryRetired,
                              LibraryOwnerChange, ActivityOut)

router = APIRouter(prefix="/shared-libraries", tags=["shared-libraries"])

KINDS = ("cables", "transformers", "cbs", "fuses", "loadClasses", "rates")
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
        # Any admin maintains the company standard's entries; everyone else reads it.
        return "edit" if user.is_admin else "view"
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
                           version=e.version, retired=bool(e.retired),
                           updated_by=e.editor.email if e.editor else None,
                           updated_at=e.updated_at)


def _lib_out(db: Session, lib: SharedLibrary, role: str, with_entries: bool) -> SharedLibraryOut:
    return SharedLibraryOut(
        id=lib.id, name=lib.name, owner_id=lib.owner_id, owner_email=lib.owner.email,
        role=role, is_company_default=lib.is_company_default, currency=lib.currency,
        entries=[_entry_out(e) for e in lib.entries] if with_entries else [])


def _members_out(lib: SharedLibrary) -> list[LibraryMemberOut]:
    return [LibraryMemberOut(user_id=m.user_id, email=m.user.email, name=m.user.name, role=m.role)
            for m in lib.members]


def _audience(db: Session, lib: SharedLibrary) -> set[int]:
    """Who hears about a change to this library: owner + members, and everyone if it
    is the company standard."""
    if lib.is_company_default:
        return all_active_user_ids(db)
    return {lib.owner_id} | {m.user_id for m in lib.members}


def _lib_label(lib: SharedLibrary) -> str:
    return f"{lib.name} (company standard)" if lib.is_company_default else lib.name


def log_activity(db: Session, lib: SharedLibrary | None, user: User | None, action: str, *, kind=None,
                 entry_id=None, version=None, data=None, detail: str = "") -> None:
    """Append to the library activity log (same transaction as the change it records)."""
    db.add(LibraryActivity(library_id=lib.id if lib is not None else None, library_name=lib.name if lib is not None else "",
                           user_id=user.id if user is not None else None, by=display_name(user) if user is not None else "",
                           action=action, kind=kind, entry_id=entry_id, version=version,
                           data=json.dumps(data, separators=(",", ":")) if data is not None else None, detail=detail))


def _entry_label(kind: str, entry_id: str, data: dict | None) -> str:
    return str((data or {}).get("name") or entry_id)


def _notify_entry(db, lib, user, kind, entry_id, label, verb):
    who, where = display_name(user), _lib_label(lib)
    notify(db, _audience(db, lib), "libraries", "library_entry_changed",
           f"{who} {verb} “{label}” in {where}.", actor=user,
           message_many=f"{who} changed {{count}} entries in {where}.",
           link={"type": "library", "id": lib.id, "kind": kind, "entryId": entry_id},
           group_key=f"lib:{lib.id}")


_RATE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._\-]{0,127}$")
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
# A rates entry is one BOQ item's price: id = the item key (e.g. CBL-95-AL-XLPE-LV).
# Quantity rules stay with the project; only what a price list carries is shared.
_RATE_FIELDS = {"id", "rate", "labour", "waste", "supplier", "priceDate", "desc", "unit", "cat"}


def _check_rate(data: dict) -> None:
    if not _RATE_ID.match(str(data.get("id", ""))):
        raise HTTPException(status_code=422, detail="A rate's id must be its item key (letters, digits, . _ -)")
    extra = set(data) - _RATE_FIELDS
    if extra:
        raise HTTPException(status_code=422, detail=f"Unknown rate field(s): {', '.join(sorted(extra))}")
    for f in ("rate", "labour", "waste"):
        v = data.get(f)
        if v is not None and (isinstance(v, bool) or not isinstance(v, (int, float)) or v < 0 or v != v):
            raise HTTPException(status_code=422, detail=f"Rate field '{f}' must be a number of 0 or more")
    for f, n in (("supplier", 64), ("desc", 255), ("unit", 16), ("cat", 16)):
        v = data.get(f)
        if v is not None and (not isinstance(v, str) or len(v) > n):
            raise HTTPException(status_code=422, detail=f"Rate field '{f}' must be text up to {n} characters")
    d = data.get("priceDate")
    if d is not None and not (isinstance(d, str) and _DATE.match(d)):
        raise HTTPException(status_code=422, detail="priceDate must be YYYY-MM-DD")


def _notify_override_drift(db: Session, lib: SharedLibrary, changed: list, actor: User,
                           removed: bool = False) -> None:
    """Tell users who hold their OWN edit of an entry that has just changed in this library
    that their copy is now out of date. `changed` = [(kind, entry_id, new_version)], rates
    excluded (they are not overridden). A user whose override already records this version
    (or a newer one) as reviewed is left alone."""
    changed = [c for c in changed if c[0] != "rates"]
    if not changed:
        return
    audience = _audience(db, lib) - {actor.id}
    if not audience:
        return
    where = _lib_label(lib)
    rows = db.query(UserLibrary).filter(UserLibrary.user_id.in_(audience)).all()
    for row in rows:
        try:
            doc = json.loads(row.data)
        except ValueError:
            continue
        if doc.get("format") != "overrides":
            continue
        hit = []
        for kind, eid, version in changed:
            ov = doc.get(kind)
            if not isinstance(ov, dict):
                continue
            mine = next((e for e in ov.get("set", []) if isinstance(e, dict) and e.get("id") == eid), None)
            if mine is None:
                continue
            rec = (ov.get("base") or {}).get(eid)
            if isinstance(rec, dict) and rec.get("library") == lib.id:
                if removed and rec.get("gone"):
                    continue                   # already knows it is gone
                if not removed and (rec.get("version") or 0) >= version:
                    continue                   # already reviewed this version
            hit.append(str(mine.get("name") or mine.get("label") or eid))
        if hit:
            one = len(hit) == 1
            verb = "removed" if removed else "changed"
            notify(db, [row.user_id], "libraries", "override_out_of_date",
                   f"Your edited “{hit[0]}” is out of date — {where} has {verb} it." if one
                   else f"{len(hit)} of your edited library entries are out of date — {where} has {verb} them.",
                   actor=actor, link={"type": "library", "id": lib.id, "drift": True},
                   message_many=f"Some of your edited library entries are out of date — {where} has changed them.",
                   group_key=f"drift:{lib.id}")


def _check_entry(kind: str, entry_id: str, data: dict) -> str:
    if kind not in KINDS:
        raise HTTPException(status_code=422, detail=f"Unknown library '{kind}'")
    if not entry_id or data.get("id") != entry_id:
        raise HTTPException(status_code=422, detail="Entry data must carry the same id as its path")
    if kind == "rates":
        _check_rate(data)
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
    db.flush()
    log_activity(db, lib, user, "library_created")
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
    log_activity(db, lib, user, "library_renamed", detail=f"{lib.name} → {name[:255]}")
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
    was = lib.is_company_default
    lib.is_company_default = data.value
    if data.value != was:
        who = display_name(admin)
        msg = (f"{who} set “{lib.name}” as the company standard library."
               if data.value else f"{who} cleared “{lib.name}” as the company standard library.")
        notify(db, all_active_user_ids(db), "libraries", "company_standard_changed", msg,
               actor=admin, link={"type": "library", "id": lib.id})
        log_activity(db, lib, admin, "company_designated" if data.value else "company_cleared")
    db.commit()
    return _lib_out(db, lib, _role_for(db, lib, admin) or "view", False)


@router.put("/{library_id}/currency", response_model=SharedLibraryOut)
def set_currency(library_id: int, data: SharedLibraryCurrency,
                 user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """The currency of this library's rates. Needs edit access (any admin for the company standard)."""
    lib, role = _get_lib(db, library_id, user, "edit")
    cur = data.currency.strip()
    if not cur or len(cur) > 8:
        raise HTTPException(status_code=422, detail="Currency must be 1-8 characters")
    if cur != lib.currency:
        log_activity(db, lib, user, "currency_changed", detail=f"{lib.currency or '—'} → {cur}")
        lib.currency = cur
        notify(db, _audience(db, lib), "libraries", "library_currency_changed",
               f"{display_name(user)} set the currency of {_lib_label(lib)} to {cur}.", actor=user,
               link={"type": "library", "id": lib.id})
    db.commit()
    return _lib_out(db, lib, role, False)


@router.delete("/{library_id}")
def delete_library(library_id: int, user: User = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    lib, _ = _get_lib(db, library_id, user, "owner")
    notify(db, _audience(db, lib), "libraries", "library_deleted",
           f"{display_name(user)} deleted the library “{lib.name}”.", actor=user)
    log_activity(db, lib, user, "library_deleted")
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
    access = "edit access" if data.role == "edit" else "view access"
    link = {"type": "library", "id": lib.id}
    if m:
        if m.role != data.role:
            notify(db, [target.id], "libraries", "library_role_changed",
                   f"{display_name(user)} changed your access to the library “{lib.name}” to {access}.",
                   actor=user, link=link)
            log_activity(db, lib, user, "member_role", detail=f"{target.email}: {data.role}")
        m.role = data.role
    else:
        db.add(SharedLibraryMember(library_id=lib.id, user_id=target.id, role=data.role))
        notify(db, [target.id], "libraries", "library_shared",
               f"{display_name(user)} added you to the library “{lib.name}” ({access}).",
               actor=user, link=link)
        log_activity(db, lib, user, "member_added", detail=f"{target.email}: {data.role}")
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
    if m.role != data.role:
        access = "edit access" if data.role == "edit" else "view access"
        notify(db, [user_id], "libraries", "library_role_changed",
               f"{display_name(user)} changed your access to the library “{lib.name}” to {access}.",
               actor=user, link={"type": "library", "id": lib.id})
    log_activity(db, lib, user, "member_role", detail=f"user {user_id}: {data.role}")
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
        if user_id != user.id:
            notify(db, [user_id], "libraries", "library_unshared",
                   f"{display_name(user)} removed you from the library “{lib.name}”.", actor=user)
        log_activity(db, lib, user, "member_removed" if user_id != user.id else "member_left", detail=f"user {user_id}")
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
        _notify_entry(db, lib, user, kind, entry_id, _entry_label(kind, entry_id, body.data), "added")
        log_activity(db, lib, user, "entry_created", kind=kind, entry_id=entry_id, version=1, data=body.data,
                     detail=f"restored from v{body.restored_from}" if body.restored_from else "")
    else:
        if body.base_version is None:
            raise _conflict(e, "An entry with this id already exists.")
        if body.base_version != e.version:
            who = e.editor.email if e.editor else "someone else"
            raise _conflict(e, f"Changed by {who} since you loaded it.")
        e.data, e.version, e.updated_by = raw, e.version + 1, user.id
        _notify_entry(db, lib, user, kind, entry_id, _entry_label(kind, entry_id, body.data), "updated")
        _notify_override_drift(db, lib, [(kind, entry_id, e.version)], user)
        log_activity(db, lib, user, "entry_updated", kind=kind, entry_id=entry_id, version=e.version, data=body.data,
                     detail=f"restored from v{body.restored_from}" if body.restored_from else "")
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
    try:
        label = _entry_label(kind, entry_id, json.loads(e.data))
    except ValueError:
        label = entry_id
    _notify_entry(db, lib, user, kind, entry_id, label, "removed")
    _notify_override_drift(db, lib, [(kind, entry_id, e.version)], user, removed=True)
    log_activity(db, lib, user, "entry_deleted", kind=kind, entry_id=entry_id, version=e.version, data=json.loads(e.data))
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
        log_activity(db, lib, user, "entry_created", kind=item.kind, entry_id=eid, version=1, data=item.data, detail="import")
    if created:
        n = len(created)
        notify(db, _audience(db, lib), "libraries", "library_entries_added",
               f"{display_name(user)} added {n} {'entry' if n == 1 else 'entries'} to {_lib_label(lib)}.",
               actor=user, link={"type": "library", "id": lib.id})
    db.commit()
    return {"created": created, "skipped": skipped}


@router.post("/{library_id}/entries/upsert")
def upsert_entries(library_id: int, body: LibraryUpsertIn, user: User = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    """Create or update many entries in one call (publishing a price list). Each item states
    the version it was based on (`base_version`, omitted to create); one that is stale — or
    would create an id that exists — is reported in `conflicts` with the current entry and
    left untouched, while the rest are applied. One notification covers the batch."""
    lib, _ = _get_lib(db, library_id, user, "edit")
    if len(body.entries) > 2000:
        raise HTTPException(status_code=413, detail="Too many entries in one call (max 2000)")
    created, updated, conflicts = [], [], []
    for item in body.entries:
        eid = item.data.get("id")
        raw = _check_entry(item.kind, eid, item.data)
        e = (db.query(SharedLibraryEntry)
             .filter(SharedLibraryEntry.library_id == lib.id, SharedLibraryEntry.kind == item.kind,
                     SharedLibraryEntry.entry_id == eid).first())
        if e is None:
            if item.base_version is not None:
                conflicts.append({"kind": item.kind, "id": eid, "message": "Deleted by someone else.",
                                  "current": None})
                continue
            db.add(SharedLibraryEntry(library_id=lib.id, kind=item.kind, entry_id=eid, data=raw,
                                      version=1, updated_by=user.id))
            created.append({"kind": item.kind, "id": eid, "version": 1})
            log_activity(db, lib, user, "entry_created", kind=item.kind, entry_id=eid, version=1, data=item.data, detail="publish")
        else:
            if item.base_version != e.version:
                conflicts.append({"kind": item.kind, "id": eid,
                                  "message": "Changed since you loaded it." if item.base_version is not None
                                  else "An entry with this id already exists.",
                                  "current": _entry_out(e).model_dump(mode="json")})
                continue
            if json.loads(e.data) == item.data:
                continue                      # nothing changed: no new version
            e.data, e.version, e.updated_by = raw, e.version + 1, user.id
            updated.append({"kind": item.kind, "id": eid, "version": e.version})
            log_activity(db, lib, user, "entry_updated", kind=item.kind, entry_id=eid, version=e.version, data=item.data, detail="publish")
    n = len(created) + len(updated)
    _notify_override_drift(db, lib, [(u["kind"], u["id"], u["version"]) for u in updated], user)
    if n:
        lib.updated_at = datetime.now(timezone.utc)
        notify(db, _audience(db, lib), "libraries", "library_entries_published",
               f"{display_name(user)} published {n} {'entry' if n == 1 else 'entries'} to {_lib_label(lib)}"
               f" ({len(created)} new, {len(updated)} updated).", actor=user,
               link={"type": "library", "id": lib.id})
    db.commit()
    return {"created": created, "updated": updated, "conflicts": conflicts}


# ── retiring, ownership, activity ──

@router.put("/{library_id}/entries/{kind}/{entry_id}/retired", response_model=LibraryEntryOut)
def set_entry_retired(library_id: int, kind: str, entry_id: str, body: EntryRetired,
                      user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Retire (hide from pickers; projects that use it are unaffected) or restore an entry."""
    lib, _ = _get_lib(db, library_id, user, "edit")
    e = _company_or_lib_entry(db, lib, kind, entry_id)
    if bool(e.retired) != body.value:
        e.retired = body.value
        label = _entry_label(kind, entry_id, json.loads(e.data))
        where = _lib_label(lib)
        notify(db, _audience(db, lib), "libraries", "library_entry_retired",
               f"{display_name(user)} retired “{label}” in {where} — it no longer appears in pickers; projects using it are unaffected."
               if body.value else f"{display_name(user)} restored “{label}” in {where}.",
               actor=user, link={"type": "library", "id": lib.id, "kind": kind, "entryId": entry_id})
        log_activity(db, lib, user, "entry_retired" if body.value else "entry_restored", kind=kind, entry_id=entry_id, version=e.version)
        lib.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(e)
    return _entry_out(e)


def _company_or_lib_entry(db: Session, lib: SharedLibrary, kind: str, entry_id: str) -> SharedLibraryEntry:
    e = (db.query(SharedLibraryEntry)
         .filter(SharedLibraryEntry.library_id == lib.id, SharedLibraryEntry.kind == kind,
                 SharedLibraryEntry.entry_id == entry_id).first())
    if e is None:
        raise HTTPException(status_code=404, detail="Entry not found")
    return e


@router.put("/{library_id}/owner", response_model=SharedLibraryOut)
def change_owner(library_id: int, body: LibraryOwnerChange, user: User = Depends(get_current_user),
                 db: Session = Depends(get_db)):
    """Hand a library to another active user. The owner can; for the company standard so can any admin."""
    lib = db.query(SharedLibrary).filter(SharedLibrary.id == library_id).first()
    if lib is None or _role_for(db, lib, user) is None:
        raise HTTPException(status_code=404, detail="Library not found")
    if lib.owner_id != user.id and not (lib.is_company_default and user.is_admin):
        raise HTTPException(status_code=403, detail="Only the owner (or an admin, for the company standard) can hand it over")
    target = db.query(User).filter(User.id == body.user_id, User.is_active.is_(True)).first()
    if target is None:
        raise HTTPException(status_code=400, detail="Choose an active user")
    if target.id != lib.owner_id:
        # The new owner no longer needs a membership.
        db.query(SharedLibraryMember).filter(SharedLibraryMember.library_id == lib.id,
                                             SharedLibraryMember.user_id == target.id).delete(synchronize_session=False)
        log_activity(db, lib, user, "library_owner_changed", detail=f"user {lib.owner_id} → {target.email}")
        lib.owner_id = target.id
        notify(db, [target.id], "libraries", "library_owner_changed",
               f"{display_name(user)} made you the owner of the library “{lib.name}”.", actor=user,
               link={"type": "library", "id": lib.id})
    db.commit()
    db.refresh(lib)
    return _lib_out(db, lib, _role_for(db, lib, user) or "view", False)


@router.get("/activity", response_model=list[ActivityOut])
def activity(library_id: int | None = None, kind: str | None = None, entry_id: str | None = None,
             action: str | None = None, limit: int = 200,
             user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """The activity log: admins see everything; others see libraries they can read."""
    q = db.query(LibraryActivity)
    if library_id is not None:
        q = q.filter(LibraryActivity.library_id == library_id)
    if kind:
        q = q.filter(LibraryActivity.kind == kind)
    if entry_id:
        q = q.filter(LibraryActivity.entry_id == entry_id)
    if action:
        q = q.filter(LibraryActivity.action == action)
    rows = q.order_by(LibraryActivity.created_at.desc(), LibraryActivity.id.desc()).limit(min(max(limit, 1), 1000)).all()
    if not user.is_admin:
        readable = {}
        out = []
        for r in rows:
            if r.library_id is None:
                continue
            if r.library_id not in readable:
                lib = db.query(SharedLibrary).filter(SharedLibrary.id == r.library_id).first()
                readable[r.library_id] = bool(lib and _role_for(db, lib, user))
            if readable[r.library_id]:
                out.append(r)
        rows = out
    return [ActivityOut(id=r.id, library_id=r.library_id, library_name=r.library_name, by=r.by, action=r.action,
                        kind=r.kind, entry_id=r.entry_id, version=r.version,
                        data=json.loads(r.data) if r.data else None, detail=r.detail, created_at=r.created_at)
            for r in rows]
