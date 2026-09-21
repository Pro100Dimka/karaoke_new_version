from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends

from backend.api.dependencies import container
from backend.api.song_dto import (
    CompatibilityDto,
    EditorDto,
    ResetEditorDto,
    RevisionDto,
    SaveEditorDto,
    editor_dto,
    lyrics_document,
)
from backend.bootstrap.container import ApplicationContainer

router = APIRouter(prefix="/songs")
ContainerDep = Annotated[ApplicationContainer, Depends(container)]


@router.get("/{song_id}/editor", response_model=EditorDto)
def get_editor(song_id: str, app: ContainerDep) -> EditorDto:
    return editor_dto(app.songs.get_editor.execute(song_id))


@router.put("/{song_id}/editor", response_model=RevisionDto)
def save_editor(song_id: str, body: SaveEditorDto, app: ContainerDep) -> RevisionDto:
    document = lyrics_document(body.document)
    revision = app.songs.save_editor.execute(song_id, body.expected_revision, document)
    return RevisionDto(revision=revision)


@router.post("/{song_id}/editor/reset", response_model=RevisionDto)
def reset_editor(song_id: str, body: ResetEditorDto, app: ContainerDep) -> RevisionDto:
    revision = app.songs.reset_editor.execute(song_id, body.expected_revision)
    return RevisionDto(revision=revision)


@router.get("/{song_id}/project/compatibility", response_model=CompatibilityDto)
def project_compatibility(
    song_id: str,
    revision: int,
    app: ContainerDep,
) -> CompatibilityDto:
    value = app.songs.compatibility.execute(song_id, revision)
    return CompatibilityDto(compatibility=value.value)


@router.post("/{song_id}/project/migrate", response_model=RevisionDto)
def migrate_project(song_id: str, app: ContainerDep) -> RevisionDto:
    revision = app.songs.migrate_project.execute(song_id)
    return RevisionDto(revision=revision)
