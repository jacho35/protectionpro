"""Project CRUD routes."""

import json
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from ..models.database import get_db, Project
from ..models.schemas import ProjectData, ProjectSummary

router = APIRouter(prefix="/projects", tags=["projects"])


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


@router.get("/{project_id}/export/json")
def export_json(project_id: int, db: Session = Depends(get_db)):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return json.loads(project.data)
