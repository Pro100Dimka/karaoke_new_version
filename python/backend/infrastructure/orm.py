from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    """SQLAlchemy declarative base; persistence-only representation."""


class SongRow(Base):
    __tablename__ = "songs"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    song_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    title: Mapped[str] = mapped_column(String(300), index=True)
    title_normalized: Mapped[str] = mapped_column(String(300), index=True)
    artist: Mapped[str] = mapped_column(String(300), index=True)
    artist_normalized: Mapped[str] = mapped_column(String(300), index=True)
    album: Mapped[str | None] = mapped_column(String(300))
    genre: Mapped[str | None] = mapped_column(String(200))
    artwork_url: Mapped[str | None] = mapped_column(String(2000))
    video_url: Mapped[str | None] = mapped_column(String(2000))
    recognition_provider: Mapped[str | None] = mapped_column(String(100))
    recognition_external_id: Mapped[str | None] = mapped_column(String(300))
    source_identity: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    source_state: Mapped[str] = mapped_column(String(32))
    source_path: Mapped[str | None] = mapped_column(String(1200))
    duration: Mapped[float | None] = mapped_column(Float)
    media_format: Mapped[str | None] = mapped_column(String(64))
    embedded_lyrics: Mapped[str | None] = mapped_column(Text)
    language: Mapped[str] = mapped_column(String(32))
    cover_state: Mapped[str] = mapped_column(String(32))
    cover_path: Mapped[str | None] = mapped_column(String(1200))
    metadata_provenance_json: Mapped[str] = mapped_column(Text)
    user_overrides_json: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(32), index=True)
    active_revision: Mapped[int] = mapped_column(Integer)
    project_format_version: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


class ProjectRevisionRow(Base):
    __tablename__ = "project_revisions"
    __table_args__ = (UniqueConstraint("song_id", "revision"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    song_id: Mapped[str] = mapped_column(String(64), index=True)
    revision: Mapped[int] = mapped_column(Integer)
    fingerprint: Mapped[str] = mapped_column(String(64))
    project_format_version: Mapped[int] = mapped_column(Integer)
    lineage_id: Mapped[str] = mapped_column(String(64), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class JobRow(Base):
    __tablename__ = "jobs"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    job_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    job_type: Mapped[str] = mapped_column(String(64), index=True)
    state: Mapped[str] = mapped_column(String(32), index=True)
    entity_id: Mapped[str | None] = mapped_column(String(128), index=True)
    mode: Mapped[str | None] = mapped_column(String(32))
    correlation_id: Mapped[str | None] = mapped_column(String(128), index=True)
    stage: Mapped[str | None] = mapped_column(String(100))
    stage_progress: Mapped[float] = mapped_column(Float)
    overall_progress: Mapped[float] = mapped_column(Float)
    eta_seconds: Mapped[float | None] = mapped_column(Float)
    error_json: Mapped[str | None] = mapped_column(Text)
    report_json: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class RecordingRow(Base):
    __tablename__ = "recordings"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    recording_id: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    song_id: Mapped[str | None] = mapped_column(String(64), index=True)
    song_revision: Mapped[int | None] = mapped_column(Integer)
    file_path: Mapped[str] = mapped_column(String(1200))
    duration: Mapped[float] = mapped_column(Float)
    sample_rate: Mapped[int] = mapped_column(Integer)
    channels: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    gaps_json: Mapped[str] = mapped_column(Text)
    session_json: Mapped[str] = mapped_column(Text)


class AnalysisRow(Base):
    __tablename__ = "analysis_results"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    analysis_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    recording_id: Mapped[str] = mapped_column(String(128), index=True)
    song_id: Mapped[str] = mapped_column(String(64), index=True)
    song_revision: Mapped[int] = mapped_column(Integer)
    algorithm_version: Mapped[str] = mapped_column(String(64))
    recording_identity: Mapped[str] = mapped_column(String(64))
    state: Mapped[str] = mapped_column(String(32), index=True)
    pitch_accuracy_percent: Mapped[float | None] = mapped_column(Float)
    mean_semitone_deviation: Mapped[float | None] = mapped_column(Float)
    section_results_json: Mapped[str] = mapped_column(Text)
    problem_regions_json: Mapped[str] = mapped_column(Text)
    error_json: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class ModelRow(Base):
    __tablename__ = "ai_models"
    __table_args__ = (UniqueConstraint("model_id", "version"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    model_id: Mapped[str] = mapped_column(String(128), index=True)
    purpose: Mapped[str] = mapped_column(String(32), index=True)
    version: Mapped[str] = mapped_column(String(128))
    size: Mapped[int] = mapped_column(Integer)
    checksum: Mapped[str] = mapped_column(String(64))
    state: Mapped[str] = mapped_column(String(32), index=True)
    local_path: Mapped[str | None] = mapped_column(String(1200))
    selected: Mapped[bool] = mapped_column(Boolean)
    download_url: Mapped[str | None] = mapped_column(String(2000))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class HistoryRow(Base):
    __tablename__ = "history_events"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    event_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    event_type: Mapped[str] = mapped_column(String(100), index=True)
    entity_type: Mapped[str | None] = mapped_column(String(64))
    entity_id: Mapped[str | None] = mapped_column(String(128), index=True)
    details_json: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


class SettingsRow(Base):
    __tablename__ = "application_settings"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    settings_schema_version: Mapped[int] = mapped_column(Integer)
    payload_json: Mapped[str] = mapped_column(Text)


class IdempotencyRow(Base):
    __tablename__ = "idempotency"
    __table_args__ = (UniqueConstraint("operation", "key"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    operation: Mapped[str] = mapped_column(String(64), index=True)
    key: Mapped[str] = mapped_column(String(256), index=True)
    request_hash: Mapped[str] = mapped_column(String(64))
    response_json: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
