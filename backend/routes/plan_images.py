"""Plan Markup image store — upload / fetch / claim / delete background plans.

Binary plan rasters (and the original PDFs they were rendered from) live here
as DB BLOBs so they never enter the project JSON (which is snapshotted into a
Revision row on every save). The project JSON references rows by integer id.
"""

from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Response
from sqlalchemy.orm import Session

from ..models.database import get_db, PlanImage
from ..models.schemas import PlanImageMeta, PlanImageClaim

router = APIRouter(prefix="/plan-images", tags=["plan-images"])

# Raster rendered from an A0/A1 PDF at high DPI can be tens of MB; cap well
# above that but below anything that would threaten the DB.
MAX_UPLOAD_BYTES = 60 * 1024 * 1024
ALLOWED_MIME = {"image/png", "image/jpeg", "image/webp", "application/pdf"}
ALLOWED_KIND = {"raster", "pdf"}
# Orphan uploads (never attached to a saved project) are swept after this.
ORPHAN_TTL = timedelta(hours=24)

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
):
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
def get_plan_image(image_id: int, db: Session = Depends(get_db)):
    img = db.query(PlanImage).filter(PlanImage.id == image_id).first()
    if not img:
        raise HTTPException(status_code=404, detail="Plan image not found")
    return Response(
        content=img.data,
        media_type=img.mime,
        # Rows are immutable, so the bytes for a given id never change.
        headers={"Cache-Control": "private, max-age=31536000, immutable"},
    )


@router.get("/{image_id}/meta", response_model=PlanImageMeta)
def get_plan_image_meta(image_id: int, db: Session = Depends(get_db)):
    # Explicit columns so the multi-MB `data` blob is never loaded.
    row = db.query(*_META_COLUMNS).filter(PlanImage.id == image_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Plan image not found")
    return PlanImageMeta(**row._mapping)


@router.patch("/{image_id}", response_model=PlanImageMeta)
def claim_plan_image(image_id: int, body: PlanImageClaim, db: Session = Depends(get_db)):
    img = db.query(PlanImage).filter(PlanImage.id == image_id).first()
    if not img:
        raise HTTPException(status_code=404, detail="Plan image not found")
    img.project_id = body.project_id
    db.commit()
    db.refresh(img)
    return img


@router.delete("/{image_id}")
def delete_plan_image(image_id: int, db: Session = Depends(get_db)):
    # 404-tolerant: the frontend fires deletes and forgets, so a
    # double-delete or a race must not surface as an error.
    img = db.query(PlanImage).filter(PlanImage.id == image_id).first()
    if img:
        db.delete(img)
        db.commit()
    return {"ok": True}


@router.post("/cleanup")
def cleanup_plan_images(db: Session = Depends(get_db)):
    """Sweep unclaimed orphan uploads older than the TTL.

    Images whose project was deleted have project_id set NULL by the FK
    (ondelete="SET NULL"), so this one rule covers both never-saved uploads
    and images left behind by a deleted project.
    """
    cutoff = datetime.now(timezone.utc) - ORPHAN_TTL
    orphans = (
        db.query(PlanImage)
        .filter(PlanImage.project_id.is_(None), PlanImage.created_at < cutoff)
        .all()
    )
    count = len(orphans)
    for img in orphans:
        db.delete(img)
    db.commit()
    return {"deleted": count}
