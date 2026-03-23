"""Database setup with SQLAlchemy + SQLite."""

import os
from sqlalchemy import create_engine, Column, Integer, String, Text, DateTime, Float, ForeignKey
from sqlalchemy.orm import declarative_base, sessionmaker, relationship
from datetime import datetime, timezone

DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite:///./protectionpro.db")

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


class Folder(Base):
    __tablename__ = "folders"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    name = Column(String(255), nullable=False, default="New Folder")
    parent_id = Column(Integer, ForeignKey("folders.id"), nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc),
                        onupdate=lambda: datetime.now(timezone.utc))

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
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc),
                        onupdate=lambda: datetime.now(timezone.utc))

    folder = relationship("Folder", back_populates="projects")


def init_db():
    Base.metadata.create_all(bind=engine)
    _migrate_add_folder_id()


def _migrate_add_folder_id():
    """Add folder_id column to projects table if it doesn't exist (legacy DB migration)."""
    from sqlalchemy import inspect, text
    insp = inspect(engine)
    if "projects" in insp.get_table_names():
        columns = [c["name"] for c in insp.get_columns("projects")]
        if "folder_id" not in columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE projects ADD COLUMN folder_id INTEGER REFERENCES folders(id)"))


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
