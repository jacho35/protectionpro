"""ProtectionPro — FastAPI Backend Server."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pathlib import Path

from .models.database import init_db
from .routes import projects, analysis, reports

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

# API routes
app.include_router(projects.router, prefix="/api")
app.include_router(analysis.router, prefix="/api")
app.include_router(reports.router, prefix="/api")
from .routes.reports import report_router
app.include_router(report_router, prefix="/api")

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
