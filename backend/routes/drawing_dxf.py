"""Drawing DXF export — SLD, Demand topology, street-light schematic, DB single line, GA."""
from ._http import content_disposition
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response

from ..analysis.drawing_dxf import build_drawing_dxf

router = APIRouter(prefix="/drawing", tags=["drawing-dxf"])


@router.post("/dxf-export")
async def drawing_dxf_export(request: Request):
    payload = await request.json()
    try:
        data = build_drawing_dxf(payload)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:  # pragma: no cover - defensive
        raise HTTPException(status_code=500, detail=f"DXF export failed: {e}")
    disposition = content_disposition(payload.get("fileName") or "drawing", "dxf", "drawing")
    return Response(content=data, media_type="application/dxf",
                    headers={"Content-Disposition": disposition})
