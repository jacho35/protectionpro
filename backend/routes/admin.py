"""Administrator tools over everyone's projects.

Deliberately metadata-only: an admin can SEE that a project exists (name, owner,
last change) and move ownership, but cannot open other people's projects. To read
one, an admin takes ownership — an explicit, visible act.
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..auth import require_admin
from ..models.database import get_db, User, Project, ProjectShare
from ..models.schemas import TransferRequest

router = APIRouter(prefix="/admin", tags=["admin"])


@router.get("/projects")
def all_projects(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    users = {u.id: u for u in db.query(User).all()}
    rows = (db.query(Project.id, Project.name, Project.owner_id, Project.updated_at)
            .order_by(Project.updated_at.desc()).all())
    out = []
    for pid, name, owner_id, updated in rows:
        o = users.get(owner_id)
        out.append({"id": pid, "name": name, "owner_id": owner_id,
                    "owner_name": (o.name or o.email) if o else "(no owner)",
                    "owner_email": o.email if o else "",
                    "owner_active": bool(o and o.is_active),
                    "updated_at": updated.isoformat() if updated else None})
    return out


@router.post("/projects/{project_id}/transfer")
def transfer_project(project_id: int, data: TransferRequest, admin: User = Depends(require_admin),
                     db: Session = Depends(get_db)):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    target = db.query(User).filter(User.id == data.to_user_id).first()
    if not target or not target.is_active:
        raise HTTPException(status_code=400, detail="Choose an active user to receive the project.")
    old_id = project.owner_id
    if old_id == target.id:
        raise HTTPException(status_code=400, detail="That user already owns this project.")
    # The new owner can't also hold a share on it.
    db.query(ProjectShare).filter(ProjectShare.project_id == project.id,
                                  ProjectShare.user_id == target.id).delete(synchronize_session=False)
    project.owner_id = target.id
    project.folder_id = None          # the old owner's folders aren't the new owner's
    kept = False
    old = db.query(User).filter(User.id == old_id).first() if old_id else None
    if data.keep_access and old and old.is_active:
        db.add(ProjectShare(project_id=project.id, user_id=old.id, role="edit"))
        kept = True
    db.commit()
    return {"ok": True, "owner_id": target.id, "previous_owner_kept_edit": kept}
