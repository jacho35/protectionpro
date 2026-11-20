"""Plan Markup DXF export/import endpoints (ezdxf; export R2010)."""
from ._http import content_disposition
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, UploadFile, File, Request, Depends
from fastapi.responses import Response, JSONResponse
from sqlalchemy.orm import Session

from ..analysis.plan_dxf import build_dxf, parse_dxf
from ..auth import get_current_user
from ..models.database import get_db, User
from .plan_images import _load as _load_image

router = APIRouter(prefix="/plan", tags=["plan-dxf"])


@router.post("/dxf-export")
async def dxf_export(request: Request, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    payload = await request.json()
    notes: list = []
    # a background's stored drawing (original DXF or the plan's parsed copy), with the caller's own access to it
    load = lambda image_id: _load_image(db, int(image_id), user, "view").data
    try:
        data = build_dxf(payload, load_image=load, notes=notes)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:  # pragma: no cover - defensive
        raise HTTPException(status_code=500, detail=f"DXF export failed: {e}")
    disposition = content_disposition(payload.get("fileName") or "plan_markup", "dxf", "plan_markup")
    return Response(
        content=data,
        media_type="application/dxf",
        # how each background went in (the original drawing, or rebuilt from the plan's copy), for the toast
        headers={"Content-Disposition": disposition, "X-PP-Notes": quote(" | ".join(notes)[:1500]),
                 "Access-Control-Expose-Headers": "X-PP-Notes"},
    )


@router.post("/dxf-import")
async def dxf_import(file: UploadFile = File(...)):
    raw = await file.read()
    if len(raw) > 60 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="DXF too large (60 MB limit).")
    try:
        result = parse_dxf(raw)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not read that DXF: {e}")
    return JSONResponse(result)
