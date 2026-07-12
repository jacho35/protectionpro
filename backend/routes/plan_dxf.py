"""Plan Markup DXF export/import endpoints (ezdxf-backed AC1015)."""
from fastapi import APIRouter, HTTPException, UploadFile, File, Request
from fastapi.responses import Response, JSONResponse

from ..analysis.plan_dxf import build_dxf, parse_dxf

router = APIRouter(prefix="/plan", tags=["plan-dxf"])


@router.post("/dxf-export")
async def dxf_export(request: Request):
    payload = await request.json()
    try:
        data = build_dxf(payload)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:  # pragma: no cover - defensive
        raise HTTPException(status_code=500, detail=f"DXF export failed: {e}")
    name = (payload.get("fileName") or "plan_markup").replace("/", "_")
    return Response(
        content=data,
        media_type="application/dxf",
        headers={"Content-Disposition": f'attachment; filename="{name}.dxf"'},
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
