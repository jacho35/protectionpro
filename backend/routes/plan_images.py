"""Plan Markup image store — upload / fetch / claim / delete background plans.

Binary plan rasters (and the original PDFs they were rendered from) live here
as DB BLOBs so they never enter the project JSON (which is snapshotted into a
Revision row on every save). The project JSON references rows by integer id.
"""

from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Response
from sqlalchemy.orm import Session

from ..auth import get_current_user, resolve_access
from ..models.database import get_db, PlanImage, Project, User
from ..models.schemas import PlanImageMeta, PlanImageClaim

router = APIRouter(prefix="/plan-images", tags=["plan-images"])

# Raster rendered from an A0/A1 PDF at high DPI can be tens of MB; cap well
# above that but below anything that would threaten the DB.
MAX_UPLOAD_BYTES = 60 * 1024 * 1024
# `application/json` carries a DXF trace-over underlay: the normalised entity
# list the DXF import already produces, stored instead of the source DXF so a
# reload is one GET rather than another ezdxf parse.
ALLOWED_MIME = {"image/png", "image/jpeg", "image/webp", "application/pdf", "application/json"}
ALLOWED_KIND = {"raster", "pdf", "dxf"}
# Orphan uploads (never attached to a saved project) are swept after this.
ORPHAN_TTL = timedelta(hours=24)

_LEVELS = {"view": 0, "edit": 1, "owner": 2}


def _project_level(db, project_id, user):
    project = db.query(Project).filter(Project.id == project_id).first() if project_id else None
    return resolve_access(db, project, user) if project else None


def _can(db: Session, img, user: User, level: str) -> bool:
    """The uploader, or anyone whose access to the image's project reaches `level`."""
    if img.owner_id == user.id:
        return True
    got = _project_level(db, img.project_id, user)
    return got is not None and _LEVELS[got] >= _LEVELS[level]


def _load(db: Session, image_id: int, user: User, level: str) -> PlanImage:
    """The image, or 404 — also when it exists but the caller has no access."""
    img = db.query(PlanImage).filter(PlanImage.id == image_id).first()
    if not img or not _can(db, img, user, level):
        raise HTTPException(status_code=404, detail="Plan image not found")
    return img


_META_COLUMNS = (
    PlanImage.id, PlanImage.project_id, PlanImage.kind, PlanImage.name,
    PlanImage.mime, PlanImage.width, PlanImage.height, PlanImage.size_bytes,
    PlanImage.created_at,
)


@router.post("", response_model=PlanImageMeta)
async def upload_plan_image(
    file: UploadFile = File(...),
    project_id: int | None = Form(None),
    kind: str = Form("raster"),
    name: str = Form(""),
    width: int = Form(0),
    height: int = Form(0),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if project_id is not None:
        level = _project_level(db, project_id, user)
        if level is None or _LEVELS[level] < _LEVELS["edit"]:
            raise HTTPException(status_code=404, detail="Project not found")
    if kind not in ALLOWED_KIND:
        raise HTTPException(status_code=400, detail=f"Invalid kind: {kind}")
    mime = (file.content_type or "").lower()
    if mime not in ALLOWED_MIME:
        raise HTTPException(status_code=400, detail=f"Unsupported content type: {mime}")

    payload = await file.read()
    if not payload:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(payload) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File exceeds {MAX_UPLOAD_BYTES // (1024 * 1024)} MB limit",
        )

    img = PlanImage(
        project_id=project_id,
        owner_id=user.id,
        kind=kind,
        name=name or (file.filename or ""),
        mime=mime,
        width=max(0, width),
        height=max(0, height),
        size_bytes=len(payload),
        data=payload,
    )
    db.add(img)
    db.commit()
    db.refresh(img)
    return img


@router.get("/{image_id}")
def get_plan_image(image_id: int, db: Session = Depends(get_db),
                   user: User = Depends(get_current_user)):
    img = _load(db, image_id, user, "view")
    return Response(
        content=img.data,
        media_type=img.mime,
        # Rows are immutable, so the bytes for a given id never change.
        headers={"Cache-Control": "private, max-age=31536000, immutable",
                 "X-Content-Type-Options": "nosniff"},
    )


@router.get("/{image_id}/meta", response_model=PlanImageMeta)
def get_plan_image_meta(image_id: int, db: Session = Depends(get_db),
                        user: User = Depends(get_current_user)):
    # Explicit columns so the multi-MB `data` blob is never loaded.
    row = db.query(*_META_COLUMNS, PlanImage.owner_id).filter(PlanImage.id == image_id).first()
    if not row or not _can(db, row, user, "view"):
        raise HTTPException(status_code=404, detail="Plan image not found")
    meta = {k: v for k, v in row._mapping.items() if k != "owner_id"}
    return PlanImageMeta(**meta)


@router.patch("/{image_id}", response_model=PlanImageMeta)
def claim_plan_image(image_id: int, body: PlanImageClaim, db: Session = Depends(get_db),
                     user: User = Depends(get_current_user)):
    img = _load(db, image_id, user, "view")
    # Only an unattached image is claimed. The client re-sends every referenced id on
    # each save (incl. a "Save as" copy), so one already on a project stays where it is.
    if img.project_id is None and body.project_id is not None:
        level = _project_level(db, body.project_id, user)
        if level is None or _LEVELS[level] < _LEVELS["edit"]:
            raise HTTPException(status_code=404, detail="Project not found")
        img.project_id = body.project_id
        db.commit()
        db.refresh(img)
    return img


@router.delete("/{image_id}")
def delete_plan_image(image_id: int, db: Session = Depends(get_db),
                      user: User = Depends(get_current_user)):
    # 404-tolerant: the frontend fires deletes and forgets, so a
    # double-delete or a race must not surface as an error.
    img = db.query(PlanImage).filter(PlanImage.id == image_id).first()
    if img and _can(db, img, user, "edit"):
        db.delete(img)
        db.commit()
    return {"ok": True}


@router.post("/cleanup")
def cleanup_plan_images(db: Session = Depends(get_db),
                        user: User = Depends(get_current_user)):
    """Sweep unclaimed orphan uploads older than the TTL.

    Images whose project was deleted have project_id set NULL by the FK
    (ondelete="SET NULL"), so this one rule covers both never-saved uploads
    and images left behind by a deleted project. Each caller sweeps their own.
    """
    cutoff = datetime.now(timezone.utc) - ORPHAN_TTL
    mine = PlanImage.owner_id == user.id
    if user.is_admin:   # rows from before ownership existed belong to nobody
        mine = mine | PlanImage.owner_id.is_(None)
    orphans = (
        db.query(PlanImage)
        .filter(PlanImage.project_id.is_(None), PlanImage.created_at < cutoff, mine)
        .all()
    )
    count = len(orphans)
    for img in orphans:
        db.delete(img)
    db.commit()
    return {"deleted": count}
