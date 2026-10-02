"""Submissions to the company library: users propose entries, admins decide.

A submission is a snapshot of one entry (cable, breaker, … or a rate price) plus a note.
The company standard library is not touched until an admin approves; approving writes the
entry through the same versioned path as a direct edit (so everyone is notified, and users
whose own edit of it is now out of date are told). An admin cannot decide their own
submission. Decisions notify the submitter (category 'approvals').
"""

import json
import uuid
from collections import defaultdict
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..auth import get_current_user, require_reviewer
from ..models.database import (get_db, User, SharedLibrary, SharedLibraryEntry, LibrarySubmission)
from ..models.schemas import (SubmissionCreate, SubmissionOut, SubmissionDecision, SubmissionResubmit)
from ..notifications import notify, display_name
from .shared_libraries import (_check_entry, _entry_label, _notify_entry, _notify_override_drift,
                               _entry_out, _lib_label, log_activity)

router = APIRouter(prefix="/library-submissions", tags=["library-submissions"])

OPEN = ("pending", "changes_requested")
MAX_BATCH = 500


def _company(db: Session) -> SharedLibrary:
    lib = db.query(SharedLibrary).filter(SharedLibrary.is_company_default.is_(True)).first()
    if lib is None:
        raise HTTPException(status_code=409, detail="There is no company library to submit to yet")
    return lib


def _company_entry(db: Session, lib: SharedLibrary, kind: str, entry_id: str):
    return (db.query(SharedLibraryEntry)
            .filter(SharedLibraryEntry.library_id == lib.id, SharedLibraryEntry.kind == kind,
                    SharedLibraryEntry.entry_id == entry_id).first())


def _out(s: LibrarySubmission, current=None) -> SubmissionOut:
    data = json.loads(s.data)
    return SubmissionOut(
        id=s.id, kind=s.kind, entry_id=s.entry_id, label=_entry_label(s.kind, s.entry_id, data), data=data,
        note=s.note, change_type=s.change_type, base_version=s.base_version, status=s.status,
        decision_note=s.decision_note, submitter=display_name(s.submitter), submitter_id=s.submitter_id,
        decided_by=display_name(s.decider) if s.decider else None, decided_at=s.decided_at, batch=s.batch,
        created_at=s.created_at, updated_at=s.updated_at, current=current)


def _reviewer_ids(db: Session) -> set[int]:
    """Who is told about new submissions: administrators and library approvers."""
    return {uid for (uid,) in db.query(User.id).filter(User.is_active.is_(True),
                                                       (User.is_admin.is_(True)) | (User.is_approver.is_(True))).all()}


def _is_reviewer(user: User) -> bool:
    return bool(user.is_admin or user.is_approver)


def _get(db: Session, sid: int) -> LibrarySubmission:
    s = db.query(LibrarySubmission).filter(LibrarySubmission.id == sid).first()
    if s is None:
        raise HTTPException(status_code=404, detail="Submission not found")
    return s


def _can_see(s: LibrarySubmission, user: User) -> bool:
    return _is_reviewer(user) or s.submitter_id == user.id


# ── submit ──

@router.post("", response_model=list[SubmissionOut])
def submit(body: SubmissionCreate, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Submit entries to the company library. An open submission of the same entry by the same
    person is replaced (and goes back to pending); an entry identical to the company's is skipped."""
    lib = _company(db)
    if not body.entries:
        raise HTTPException(status_code=422, detail="Nothing to submit")
    if len(body.entries) > MAX_BATCH:
        raise HTTPException(status_code=413, detail=f"Too many entries in one submission (max {MAX_BATCH})")
    batch = str(uuid.uuid4()) if len(body.entries) > 1 else None
    note = (body.note or "").strip()[:2000]
    out = []
    for item in body.entries:
        eid = item.data.get("id")
        raw = _check_entry(item.kind, eid, item.data)
        cur = _company_entry(db, lib, item.kind, eid)
        if cur is not None and json.loads(cur.data) == item.data:
            continue                                  # nothing to propose
        row = (db.query(LibrarySubmission)
               .filter(LibrarySubmission.submitter_id == user.id, LibrarySubmission.kind == item.kind,
                       LibrarySubmission.entry_id == eid, LibrarySubmission.status.in_(OPEN)).first())
        if row is None:
            row = LibrarySubmission(submitter_id=user.id, library_id=lib.id, kind=item.kind, entry_id=eid, data=raw)
            db.add(row)
        row.data, row.note, row.batch = raw, note, batch
        row.library_id = lib.id
        row.change_type = "change" if cur is not None else "new"
        row.base_version = (item.base_version if item.base_version is not None else cur.version) if cur is not None else None
        row.status, row.decision_note, row.decided_by, row.decided_at = "pending", "", None, None
        out.append(row)
    if not out:
        raise HTTPException(status_code=422, detail="The company library already has exactly these entries")
    db.flush()
    n, who = len(out), display_name(user)
    first = _entry_label(out[0].kind, out[0].entry_id, json.loads(out[0].data))
    notify(db, _reviewer_ids(db), "approvals", "submission_received",
           f"{who} submitted “{first}” to the company library." if n == 1
           else f"{who} submitted {n} entries to the company library (“{first}” and {n - 1} more).",
           actor=user, link={"type": "submissions", "id": out[0].id})
    db.commit()
    for r in out:
        db.refresh(r)
    return [_out(r) for r in out]


# ── read ──

@router.get("", response_model=list[SubmissionOut])
def list_submissions(status: str | None = None, mine: bool = False, limit: int = 500,
                     user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Reviewers (admins, approvers): everyone's (or only theirs with ?mine=true). Everyone else: their own."""
    q = db.query(LibrarySubmission)
    if mine or not _is_reviewer(user):
        q = q.filter(LibrarySubmission.submitter_id == user.id)
    if status:
        q = q.filter(LibrarySubmission.status == status)
    rows = q.order_by(LibrarySubmission.created_at.desc(), LibrarySubmission.id.desc()).limit(min(limit, 1000)).all()
    return [_out(r) for r in rows]


@router.get("/counts")
def counts(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """For the badge: waiting (admins: every pending submission) and the caller's own that need changes."""
    waiting = db.query(LibrarySubmission).filter(LibrarySubmission.status == "pending").count() if _is_reviewer(user) else 0
    mine = (db.query(LibrarySubmission)
            .filter(LibrarySubmission.submitter_id == user.id, LibrarySubmission.status == "changes_requested").count())
    return {"waiting": waiting, "changes_requested": mine}


@router.get("/{sid}", response_model=SubmissionOut)
def get_submission(sid: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    s = _get(db, sid)
    if not _can_see(s, user):
        raise HTTPException(status_code=404, detail="Submission not found")
    lib = db.query(SharedLibrary).filter(SharedLibrary.is_company_default.is_(True)).first()
    cur = _company_entry(db, lib, s.kind, s.entry_id) if lib else None
    current = {"data": json.loads(cur.data), "version": cur.version} if cur else None
    return _out(s, current)


# ── decide ──

def _apply(db: Session, lib: SharedLibrary, admin: User, s: LibrarySubmission, force: bool):
    """Write the submitted entry into the company library. Returns None, or a conflict dict."""
    data = json.loads(s.data)
    raw = _check_entry(s.kind, s.entry_id, data)
    cur = _company_entry(db, lib, s.kind, s.entry_id)
    if not force:
        if s.change_type == "new" and cur is not None:
            return {"message": "The company library gained an entry with this id since it was submitted.",
                    "current": _entry_out(cur).model_dump(mode="json")}
        if s.change_type == "change" and (cur is None or cur.version != s.base_version):
            return {"message": "The company entry changed since this was submitted." if cur else "The company entry was deleted since this was submitted.",
                    "current": _entry_out(cur).model_dump(mode="json") if cur else None}
    label = _entry_label(s.kind, s.entry_id, data)
    if cur is None:
        db.add(SharedLibraryEntry(library_id=lib.id, kind=s.kind, entry_id=s.entry_id, data=raw,
                                  version=1, updated_by=s.submitter_id))
        _notify_entry(db, lib, admin, s.kind, s.entry_id, label, "added")
        log_activity(db, lib, admin, "entry_created", kind=s.kind, entry_id=s.entry_id, version=1, data=data,
                     detail=f"approved submission #{s.id} from {display_name(s.submitter)}")
    elif json.loads(cur.data) != data:
        cur.data, cur.version, cur.updated_by = raw, cur.version + 1, s.submitter_id
        _notify_entry(db, lib, admin, s.kind, s.entry_id, label, "updated")
        _notify_override_drift(db, lib, [(s.kind, s.entry_id, cur.version)], admin)
        log_activity(db, lib, admin, "entry_updated", kind=s.kind, entry_id=s.entry_id, version=cur.version, data=data,
                     detail=f"approved submission #{s.id} from {display_name(s.submitter)}")
    lib.updated_at = datetime.now(timezone.utc)
    return None


@router.post("/decide")
def decide(body: SubmissionDecision, admin: User = Depends(require_reviewer), db: Session = Depends(get_db)):
    """Approve, request changes to, or reject submissions (admins and approvers; never your own)."""
    if body.action not in ("approve", "request_changes", "reject"):
        raise HTTPException(status_code=422, detail="action must be approve, request_changes or reject")
    note = (body.note or "").strip()[:2000]
    if body.action == "request_changes" and not note:
        raise HTTPException(status_code=422, detail="Say what needs changing")
    lib = db.query(SharedLibrary).filter(SharedLibrary.is_company_default.is_(True)).first()
    if body.action == "approve" and lib is None:
        raise HTTPException(status_code=409, detail="There is no company library")
    done, errors = [], []
    decided = defaultdict(list)                       # submitter id -> [submission]
    for sid in body.ids:
        s = db.query(LibrarySubmission).filter(LibrarySubmission.id == sid).first()
        if s is None:
            errors.append({"id": sid, "error": "Not found"}); continue
        if s.submitter_id == admin.id:
            errors.append({"id": sid, "error": "You cannot decide your own submission"}); continue
        if s.status not in OPEN:
            errors.append({"id": sid, "error": f"Already {s.status.replace('_', ' ')}"}); continue
        if body.action == "approve":
            if s.status != "pending":
                errors.append({"id": sid, "error": "Waiting for the submitter's changes"}); continue
            conflict = _apply(db, lib, admin, s, body.force)
            if conflict:
                errors.append({"id": sid, "error": conflict["message"], "conflict": conflict}); continue
            s.status = "approved"
        elif body.action == "request_changes":
            s.status = "changes_requested"
        else:
            s.status = "rejected"
        s.decision_note, s.decided_by, s.decided_at = note, admin.id, datetime.now(timezone.utc)
        decided[s.submitter_id].append(s)
        done.append(sid)
    verb = {"approve": "approved", "request_changes": "asked for changes to", "reject": "rejected"}[body.action]
    kind = {"approve": "submission_approved", "request_changes": "submission_changes_requested",
            "reject": "submission_rejected"}[body.action]
    for uid, subs in decided.items():
        first = _entry_label(subs[0].kind, subs[0].entry_id, json.loads(subs[0].data))
        n = len(subs)
        msg = f"{display_name(admin)} {verb} your submission “{first}”" if n == 1 else \
            f"{display_name(admin)} {verb} {n} of your submissions (“{first}” and {n - 1} more)"
        if body.action == "approve":
            msg += f" — it is now in {_lib_label(lib)}."
        elif note:
            msg += f": “{note}”"
        else:
            msg += "."
        notify(db, [uid], "approvals", kind, msg, actor=admin, link={"type": "submissions", "id": subs[0].id})
    db.commit()
    return {"done": done, "errors": errors}


# ── submitter actions ──

@router.post("/{sid}/resubmit", response_model=SubmissionOut)
def resubmit(sid: int, body: SubmissionResubmit, user: User = Depends(get_current_user),
             db: Session = Depends(get_db)):
    """After 'changes requested' (or to amend a pending one): send the updated entry back."""
    s = _get(db, sid)
    if s.submitter_id != user.id:
        raise HTTPException(status_code=404, detail="Submission not found")
    if s.status not in OPEN:
        raise HTTPException(status_code=409, detail=f"This submission is already {s.status.replace('_', ' ')}")
    if body.data is not None:
        s.data = _check_entry(s.kind, s.entry_id, body.data)
    if body.note is not None:
        s.note = body.note.strip()[:2000]
    lib = db.query(SharedLibrary).filter(SharedLibrary.is_company_default.is_(True)).first()
    cur = _company_entry(db, lib, s.kind, s.entry_id) if lib else None
    s.change_type = "change" if cur is not None else "new"
    s.base_version = cur.version if cur is not None else None
    s.status, s.decision_note, s.decided_by, s.decided_at = "pending", "", None, None
    notify(db, _reviewer_ids(db), "approvals", "submission_received",
           f"{display_name(user)} updated their submission “{_entry_label(s.kind, s.entry_id, json.loads(s.data))}” for review.",
           actor=user, link={"type": "submissions", "id": s.id})
    db.commit()
    db.refresh(s)
    return _out(s)


@router.delete("/{sid}")
def withdraw(sid: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    s = _get(db, sid)
    if s.submitter_id != user.id:
        raise HTTPException(status_code=404, detail="Submission not found")
    if s.status not in OPEN:
        raise HTTPException(status_code=409, detail="Only an open submission can be withdrawn")
    db.delete(s)
    db.commit()
    return {"ok": True}
