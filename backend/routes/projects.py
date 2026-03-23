"""Project and Folder CRUD routes."""

import json
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from ..models.database import get_db, Project, Folder
from ..models.schemas import (
    ProjectData, ProjectSummary, FolderSummary,
    FolderCreate, FolderUpdate, ProjectRename, ProjectMove,
)

router = APIRouter(prefix="/projects", tags=["projects"])


# ── Folder endpoints ──

@router.get("/folders", response_model=list[FolderSummary])
def list_folders(db: Session = Depends(get_db)):
    return db.query(Folder).order_by(Folder.name).all()


@router.post("/folders", response_model=FolderSummary)
def create_folder(data: FolderCreate, db: Session = Depends(get_db)):
    if data.parent_id is not None:
        parent = db.query(Folder).filter(Folder.id == data.parent_id).first()
        if not parent:
            raise HTTPException(status_code=404, detail="Parent folder not found")
    folder = Folder(name=data.name, parent_id=data.parent_id)
    db.add(folder)
    db.commit()
    db.refresh(folder)
    return folder


@router.put("/folders/{folder_id}", response_model=FolderSummary)
def update_folder(folder_id: int, data: FolderUpdate, db: Session = Depends(get_db)):
    folder = db.query(Folder).filter(Folder.id == folder_id).first()
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")
    if data.name is not None:
        folder.name = data.name
    if data.parent_id is not None:
        # Prevent moving a folder into itself or its descendants
        if data.parent_id == folder_id:
            raise HTTPException(status_code=400, detail="Cannot move folder into itself")
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
def delete_folder(folder_id: int, db: Session = Depends(get_db)):
    folder = db.query(Folder).filter(Folder.id == folder_id).first()
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

@router.get("", response_model=list[ProjectSummary])
def list_projects(db: Session = Depends(get_db)):
    projects = db.query(Project).order_by(Project.updated_at.desc()).all()
    return projects


@router.post("", response_model=dict)
def create_project(data: ProjectData, db: Session = Depends(get_db)):
    project = Project(
        name=data.projectName,
        data=json.dumps(data.model_dump()),
        base_mva=data.baseMVA,
        frequency=data.frequency,
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    return {"id": project.id, "name": project.name}


@router.get("/{project_id}")
def get_project(project_id: int, db: Session = Depends(get_db)):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return json.loads(project.data)


@router.put("/{project_id}")
def update_project(project_id: int, data: ProjectData, db: Session = Depends(get_db)):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    project.name = data.projectName
    project.data = json.dumps(data.model_dump())
    project.base_mva = data.baseMVA
    project.frequency = data.frequency
    db.commit()
    return {"id": project.id, "name": project.name}


@router.delete("/{project_id}")
def delete_project(project_id: int, db: Session = Depends(get_db)):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    db.delete(project)
    db.commit()
    return {"ok": True}


@router.patch("/{project_id}/rename")
def rename_project(project_id: int, data: ProjectRename, db: Session = Depends(get_db)):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
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
def move_project(project_id: int, data: ProjectMove, db: Session = Depends(get_db)):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if data.folder_id is not None:
        folder = db.query(Folder).filter(Folder.id == data.folder_id).first()
        if not folder:
            raise HTTPException(status_code=404, detail="Target folder not found")
    project.folder_id = data.folder_id
    db.commit()
    return {"id": project.id, "name": project.name, "folder_id": project.folder_id}


@router.get("/{project_id}/export/json")
def export_json(project_id: int, db: Session = Depends(get_db)):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return json.loads(project.data)
