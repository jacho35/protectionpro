"""Project and Folder CRUD routes (auth-gated, owner-scoped + sharing)."""

import json
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from ..models.database import get_db, Project, Folder, Revision, User, ProjectShare
from ..models.schemas import (
    ProjectData, ProjectSummary, FolderSummary,
    FolderCreate, FolderUpdate, ProjectRename, ProjectMove,
    RevisionSummary, RevisionDetail, RevisionCreate,
    ShareCreate, ShareRoleUpdate, ShareOut,
)
from ..auth import get_current_user, require_project

router = APIRouter(prefix="/projects", tags=["projects"])


def _norm_email(email: str) -> str:
    return (email or "").strip().lower()


# ── Folder endpoints (owner-scoped; no folder sharing) ──

@router.get("/folders", response_model=list[FolderSummary])
def list_folders(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return (db.query(Folder)
            .filter(Folder.owner_id == user.id)
            .order_by(Folder.name).all())


@router.post("/folders", response_model=FolderSummary)
def create_folder(data: FolderCreate, db: Session = Depends(get_db),
                  user: User = Depends(get_current_user)):
    if data.parent_id is not None:
        parent = (db.query(Folder)
                  .filter(Folder.id == data.parent_id, Folder.owner_id == user.id).first())
        if not parent:
            raise HTTPException(status_code=404, detail="Parent folder not found")
    folder = Folder(name=data.name, parent_id=data.parent_id, owner_id=user.id)
    db.add(folder)
    db.commit()
    db.refresh(folder)
    return folder


@router.put("/folders/{folder_id}", response_model=FolderSummary)
def update_folder(folder_id: int, data: FolderUpdate, db: Session = Depends(get_db),
                  user: User = Depends(get_current_user)):
    folder = (db.query(Folder)
              .filter(Folder.id == folder_id, Folder.owner_id == user.id).first())
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")
    if data.name is not None:
        folder.name = data.name
    if data.parent_id is not None:
        # Prevent moving a folder into itself or its descendants
        if data.parent_id == folder_id:
            raise HTTPException(status_code=400, detail="Cannot move folder into itself")
        # Target parent must be owned by the caller too
        if not db.query(Folder).filter(Folder.id == data.parent_id,
                                        Folder.owner_id == user.id).first():
            raise HTTPException(status_code=404, detail="Parent folder not found")
        # Walk up the tree to check for cycles
        check_id = data.parent_id
        while check_id is not None:
            ancestor = db.query(Folder).filter(Folder.id == check_id).first()
            if not ancestor:
                break
            if ancestor.id == folder_id:
                raise HTTPException(status_code=400, detail="Cannot move folder into its own descendant")
            check_id = ancestor.parent_id
        folder.parent_id = data.parent_id
    elif "parent_id" in (data.model_fields_set or set()):
        folder.parent_id = None
    db.commit()
    db.refresh(folder)
    return folder


@router.delete("/folders/{folder_id}")
def delete_folder(folder_id: int, db: Session = Depends(get_db),
                  user: User = Depends(get_current_user)):
    folder = (db.query(Folder)
              .filter(Folder.id == folder_id, Folder.owner_id == user.id).first())
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")
    # Move contained projects to root (no folder) before deleting
    db.query(Project).filter(Project.folder_id == folder_id).update(
        {Project.folder_id: None}, synchronize_session="fetch"
    )
    # Move child folders to root
    db.query(Folder).filter(Folder.parent_id == folder_id).update(
        {Folder.parent_id: None}, synchronize_session="fetch"
    )
    db.delete(folder)
    db.commit()
    return {"ok": True}


# ── Project endpoints ──

def _summary(project: Project, access: str, owner_user) -> ProjectSummary:
    return ProjectSummary(
        id=project.id, name=project.name, folder_id=project.folder_id,
        created_at=project.created_at, updated_at=project.updated_at,
        owner_id=project.owner_id,
        owner_email=owner_user.email if owner_user else None,
        owner_name=owner_user.name if owner_user else None,
        access=access,
    )


@router.get("", response_model=list[ProjectSummary])
def list_projects(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    out = []
    for p in db.query(Project).filter(Project.owner_id == user.id).all():
        out.append(_summary(p, "owner", user))
    shared = (db.query(Project, ProjectShare.role)
              .join(ProjectShare, ProjectShare.project_id == Project.id)
              .filter(ProjectShare.user_id == user.id).all())
    for p, role in shared:
        owner = db.query(User).filter(User.id == p.owner_id).first()
        out.append(_summary(p, role, owner))
    out.sort(key=lambda s: s.updated_at or s.created_at, reverse=True)
    return out


@router.post("", response_model=dict)
def create_project(data: ProjectData, db: Session = Depends(get_db),
                   user: User = Depends(get_current_user)):
    project = Project(
        name=data.projectName,
        data=json.dumps(data.model_dump()),
        base_mva=data.baseMVA,
        frequency=data.frequency,
        owner_id=user.id,
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    return {"id": project.id, "name": project.name}


@router.get("/{project_id}")
def get_project(project_id: int, ctx=Depends(require_project("view"))):
    project, _level = ctx
    return json.loads(project.data)


@router.put("/{project_id}")
def update_project(project_id: int, data: ProjectData,
                   ctx=Depends(require_project("edit")), db: Session = Depends(get_db)):
    project, _level = ctx
    project.name = data.projectName
    project.data = json.dumps(data.model_dump())
    project.base_mva = data.baseMVA
    project.frequency = data.frequency
    db.commit()
    return {"id": project.id, "name": project.name}


@router.delete("/{project_id}")
def delete_project(project_id: int, ctx=Depends(require_project("owner")),
                   db: Session = Depends(get_db)):
    project, _level = ctx
    db.delete(project)
    db.commit()
    return {"ok": True}


@router.patch("/{project_id}/rename")
def rename_project(project_id: int, data: ProjectRename,
                   ctx=Depends(require_project("edit")), db: Session = Depends(get_db)):
    project, _level = ctx
    project.name = data.name
    # Also update the name inside the stored JSON data
    try:
        proj_data = json.loads(project.data)
        proj_data["projectName"] = data.name
        project.data = json.dumps(proj_data)
    except (json.JSONDecodeError, KeyError):
        pass
    db.commit()
    return {"id": project.id, "name": project.name}


@router.patch("/{project_id}/move")
def move_project(project_id: int, data: ProjectMove,
                 ctx=Depends(require_project("owner")), db: Session = Depends(get_db),
                 user: User = Depends(get_current_user)):
    project, _level = ctx
    if data.folder_id is not None:
        folder = (db.query(Folder)
                  .filter(Folder.id == data.folder_id, Folder.owner_id == user.id).first())
        if not folder:
            raise HTTPException(status_code=404, detail="Target folder not found")
    project.folder_id = data.folder_id
    db.commit()
    return {"id": project.id, "name": project.name, "folder_id": project.folder_id}


@router.get("/{project_id}/export/json")
def export_json(project_id: int, ctx=Depends(require_project("view"))):
    project, _level = ctx
    return json.loads(project.data)


# ── Sharing endpoints (owner only) ──

def _shares_out(db: Session, project_id: int) -> list[ShareOut]:
    rows = db.query(ProjectShare).filter(ProjectShare.project_id == project_id).all()
    out = []
    for s in rows:
        u = db.query(User).filter(User.id == s.user_id).first()
        out.append(ShareOut(user_id=s.user_id, email=u.email if u else "",
                            name=u.name if u else "", role=s.role, created_at=s.created_at))
    return out


@router.get("/{project_id}/shares", response_model=list[ShareOut])
def list_shares(project_id: int, ctx=Depends(require_project("owner")),
                db: Session = Depends(get_db)):
    return _shares_out(db, project_id)


@router.post("/{project_id}/shares", response_model=list[ShareOut])
def add_share(project_id: int, data: ShareCreate,
              ctx=Depends(require_project("owner")), db: Session = Depends(get_db)):
    project, _level = ctx
    email = _norm_email(data.email)
    target = db.query(User).filter(User.email == email).first()
    if not target:
        raise HTTPException(status_code=404,
                            detail="No user with that email — they must register first")
    if target.id == project.owner_id:
        raise HTTPException(status_code=400, detail="You already own this project")
    share = (db.query(ProjectShare)
             .filter(ProjectShare.project_id == project.id,
                     ProjectShare.user_id == target.id).first())
    if share:
        share.role = data.role   # upsert / change role
    else:
        db.add(ProjectShare(project_id=project.id, user_id=target.id, role=data.role))
    db.commit()
    return _shares_out(db, project.id)


@router.patch("/{project_id}/shares/{user_id}", response_model=list[ShareOut])
def update_share(project_id: int, user_id: int, data: ShareRoleUpdate,
                 ctx=Depends(require_project("owner")), db: Session = Depends(get_db)):
    share = (db.query(ProjectShare)
             .filter(ProjectShare.project_id == project_id,
                     ProjectShare.user_id == user_id).first())
    if not share:
        raise HTTPException(status_code=404, detail="Share not found")
    share.role = data.role
    db.commit()
    return _shares_out(db, project_id)


@router.delete("/{project_id}/shares/{user_id}", response_model=list[ShareOut])
def remove_share(project_id: int, user_id: int,
                 ctx=Depends(require_project("owner")), db: Session = Depends(get_db)):
    share = (db.query(ProjectShare)
             .filter(ProjectShare.project_id == project_id,
                     ProjectShare.user_id == user_id).first())
    if share:
        db.delete(share)
        db.commit()
    return _shares_out(db, project_id)


# ── Revision endpoints ──

MAX_REVISIONS = 20


@router.get("/{project_id}/revisions", response_model=list[RevisionSummary])
def list_revisions(project_id: int, ctx=Depends(require_project("view")),
                   db: Session = Depends(get_db)):
    return (
        db.query(Revision)
        .filter(Revision.project_id == project_id)
        .order_by(Revision.created_at.desc())
        .limit(MAX_REVISIONS)
        .all()
    )


@router.post("/{project_id}/revisions", response_model=RevisionSummary)
def create_revision(project_id: int, body: RevisionCreate,
                    ctx=Depends(require_project("edit")), db: Session = Depends(get_db)):
    project, _level = ctx
    revision = Revision(
        project_id=project_id,
        data=project.data,  # snapshot current project state
        label=body.label or "",
    )
    db.add(revision)
    db.flush()

    # Trim old revisions beyond the limit
    all_revisions = (
        db.query(Revision)
        .filter(Revision.project_id == project_id)
        .order_by(Revision.created_at.desc())
        .all()
    )
    if len(all_revisions) > MAX_REVISIONS:
        for old in all_revisions[MAX_REVISIONS:]:
            db.delete(old)

    db.commit()
    db.refresh(revision)
    return revision


@router.get("/{project_id}/revisions/{revision_id}", response_model=RevisionDetail)
def get_revision(project_id: int, revision_id: int,
                 ctx=Depends(require_project("view")), db: Session = Depends(get_db)):
    revision = (
        db.query(Revision)
        .filter(Revision.project_id == project_id, Revision.id == revision_id)
        .first()
    )
    if not revision:
        raise HTTPException(status_code=404, detail="Revision not found")
    return revision


@router.delete("/{project_id}/revisions/{revision_id}")
def delete_revision(project_id: int, revision_id: int,
                    ctx=Depends(require_project("edit")), db: Session = Depends(get_db)):
    revision = (
        db.query(Revision)
        .filter(Revision.project_id == project_id, Revision.id == revision_id)
        .first()
    )
    if not revision:
        raise HTTPException(status_code=404, detail="Revision not found")
    db.delete(revision)
    db.commit()
    return {"ok": True}
