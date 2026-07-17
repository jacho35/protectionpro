"""Database setup with SQLAlchemy + SQLite."""

import os
from sqlalchemy import (create_engine, event, Column, Integer, String, Text,
                        DateTime, Float, Boolean, ForeignKey, LargeBinary,
                        UniqueConstraint)
from sqlalchemy.engine import Engine
from sqlalchemy.orm import declarative_base, sessionmaker, relationship
from datetime import datetime, timezone

DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite:///./protectionpro.db")

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})


@event.listens_for(Engine, "connect")
def _sqlite_fk_pragma(dbapi_connection, connection_record):
    """Enable foreign-key enforcement on SQLite connections.

    SQLite ignores FK ON DELETE actions unless this pragma is set, so without
    it PlanImage.project_id (ondelete="SET NULL") would dangle after a project
    is deleted instead of being nulled for the cleanup sweep. Guarded so a
    non-SQLite backend is unaffected.
    """
    if DATABASE_URL.startswith("sqlite"):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


class Folder(Base):
    __tablename__ = "folders"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    name = Column(String(255), nullable=False, default="New Folder")
    parent_id = Column(Integer, ForeignKey("folders.id"), nullable=True)
    # Folders are owner-scoped (no folder sharing). Nullable so legacy rows and
    # the bootstrap-claim (assign to first admin) work; set on create.
    owner_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc),
                        onupdate=lambda: datetime.now(timezone.utc))

    owner = relationship("User", back_populates="owned_folders",
                         foreign_keys=[owner_id])
    children = relationship("Folder", backref="parent", remote_side=[id],
                            foreign_keys=[parent_id], lazy="select",
                            cascade="all, delete-orphan",
                            single_parent=True)
    projects = relationship("Project", back_populates="folder", lazy="select")


class Project(Base):
    __tablename__ = "projects"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    name = Column(String(255), nullable=False, default="Untitled Project")
    data = Column(Text, nullable=False)  # JSON string of the full project
    base_mva = Column(Float, default=100.0)
    frequency = Column(Integer, default=50)
    folder_id = Column(Integer, ForeignKey("folders.id"), nullable=True)
    # Owner of the project. Nullable so legacy rows and the bootstrap-claim
    # (assign existing projects to the first admin) work; set on create.
    owner_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc),
                        onupdate=lambda: datetime.now(timezone.utc))

    folder = relationship("Folder", back_populates="projects")
    owner = relationship("User", back_populates="owned_projects",
                         foreign_keys=[owner_id])
    shares = relationship("ProjectShare", back_populates="project",
                          cascade="all, delete-orphan")
    revisions = relationship("Revision", back_populates="project", cascade="all, delete-orphan",
                             order_by="Revision.created_at.desc()")


class Revision(Base):
    __tablename__ = "revisions"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=False, index=True)
    data = Column(Text, nullable=False)  # Full ProjectData JSON snapshot
    label = Column(String(255), nullable=False, default="")  # e.g. "Manual save", "Auto-save"
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    project = relationship("Project", back_populates="revisions")


class PlanImage(Base):
    """Background site/floor-plan images for the Plan Markup workspace.

    Stored as BLOBs in the DB (not in the project JSON) so the potentially
    multi-MB rasters never bloat Project.data or the per-save Revision
    snapshots — the project JSON references these rows by integer id only.
    Rows are immutable once written (id never reused with different bytes),
    which is why GET can be cached aggressively.
    """
    __tablename__ = "plan_images"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    # SET NULL on project delete so orphaned images can be swept by cleanup
    # rather than cascade-deleted (older revisions may still reference them).
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="SET NULL"),
                        nullable=True, index=True)
    kind = Column(String(16), nullable=False, default="raster")   # 'raster' | 'pdf'
    name = Column(String(255), nullable=False, default="")
    mime = Column(String(64), nullable=False, default="image/png")
    width = Column(Integer, default=0)      # raster px (0 for pdf kind)
    height = Column(Integer, default=0)
    size_bytes = Column(Integer, default=0)
    data = Column(LargeBinary, nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    # Email is stored lowercased/stripped by the route; unique for login.
    email = Column(String(255), unique=True, nullable=False, index=True)
    password_hash = Column(String(255), nullable=False)
    name = Column(String(255), nullable=False, default="")
    is_admin = Column(Boolean, nullable=False, default=False)
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    owned_projects = relationship("Project", back_populates="owner",
                                  foreign_keys="Project.owner_id")
    owned_folders = relationship("Folder", back_populates="owner",
                                 foreign_keys="Folder.owner_id")


class ProjectShare(Base):
    """A grant of access to a project for a specific (non-owner) user."""
    __tablename__ = "project_shares"

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"),
                        nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"),
                     nullable=False, index=True)
    role = Column(String(8), nullable=False, default="view")   # 'view' | 'edit'
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    __table_args__ = (UniqueConstraint("project_id", "user_id",
                                       name="uq_share_project_user"),)

    project = relationship("Project", back_populates="shares")
    user = relationship("User")


class Invite(Base):
    """A single-use registration invite generated by an admin."""
    __tablename__ = "invites"

    id = Column(Integer, primary_key=True, autoincrement=True)
    code = Column(String(64), unique=True, nullable=False, index=True)
    email = Column(String(255), nullable=True)   # optional restriction / prefill
    created_by = Column(Integer, ForeignKey("users.id"), nullable=False)
    used_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    used_at = Column(DateTime, nullable=True)
    expires_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    creator = relationship("User", foreign_keys=[created_by])
    consumer = relationship("User", foreign_keys=[used_by])


class AppSetting(Base):
    """Tiny key/value store — persists the JWT secret across restarts."""
    __tablename__ = "app_settings"

    key = Column(String(64), primary_key=True)
    value = Column(Text, nullable=False)


def init_db():
    Base.metadata.create_all(bind=engine)
    _migrate_add_folder_id()
    _migrate_add_owner_id("projects")
    _migrate_add_owner_id("folders")


def _migrate_add_folder_id():
    """Add folder_id column to projects table if it doesn't exist (legacy DB migration)."""
    from sqlalchemy import inspect, text
    insp = inspect(engine)
    if "projects" in insp.get_table_names():
        columns = [c["name"] for c in insp.get_columns("projects")]
        if "folder_id" not in columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE projects ADD COLUMN folder_id INTEGER REFERENCES folders(id)"))


def _migrate_add_owner_id(table: str):
    """Add owner_id column to an existing table if missing (legacy DB migration).

    `create_all` never alters existing tables, so a populated production DB
    needs this idempotent ALTER (mirrors _migrate_add_folder_id). `table` is a
    fixed internal literal, never user input.
    """
    from sqlalchemy import inspect, text
    insp = inspect(engine)
    if table in insp.get_table_names():
        columns = [c["name"] for c in insp.get_columns(table)]
        if "owner_id" not in columns:
            with engine.begin() as conn:
                conn.execute(text(
                    f"ALTER TABLE {table} ADD COLUMN owner_id INTEGER REFERENCES users(id)"))


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
