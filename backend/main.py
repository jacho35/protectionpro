"""ProtectionPro — FastAPI Backend Server."""

from fastapi import FastAPI, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session
from pathlib import Path

from .models.database import init_db, get_db, User
from .routes import projects, analysis, reports, plan_images, plan_dxf, auth
from .auth import get_current_user

app = FastAPI(
    title="ProtectionPro",
    description="Single Line Diagram Builder with IEC 60909 Fault Analysis and Load Flow",
    version="1.0.0",
)

# CORS for frontend dev
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Public liveness/first-run endpoint. Unauthenticated on purpose (the
# docker-compose healthcheck hits it, and the frontend uses `users` to decide
# whether to show first-run admin signup vs login).
@app.get("/api/health")
def health(db: Session = Depends(get_db)):
    return {"ok": True, "users": db.query(User).count()}


# API routes. auth.router is public/self-guarding. Every other router requires
# a logged-in user; project/report routes additionally enforce per-project
# access via require_project(...) inside their handlers.
_auth_gate = [Depends(get_current_user)]
app.include_router(auth.router, prefix="/api")
app.include_router(projects.router, prefix="/api")
app.include_router(reports.router, prefix="/api")
from .routes.reports import report_router
app.include_router(analysis.router, prefix="/api", dependencies=_auth_gate)
app.include_router(report_router, prefix="/api", dependencies=_auth_gate)
app.include_router(plan_images.router, prefix="/api", dependencies=_auth_gate)
app.include_router(plan_dxf.router, prefix="/api", dependencies=_auth_gate)

# Serve frontend static files
frontend_path = Path(__file__).parent.parent / "frontend"
if frontend_path.exists():
    app.mount("/", StaticFiles(directory=str(frontend_path), html=True), name="frontend")


@app.on_event("startup")
def startup():
    init_db()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("backend.main:app", host="0.0.0.0", port=8000, reload=True)
