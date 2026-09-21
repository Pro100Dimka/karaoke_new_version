from __future__ import annotations

from backend.domain_errors import NotFoundError
from backend.editor.domain import EditorDocument
from backend.lyrics.codec import decode_document
from backend.persistence import UnitOfWorkFactory
from backend.projects.ports import ProjectStorage


class GetEditorDocument:
    def __init__(self, uow: UnitOfWorkFactory, projects: ProjectStorage) -> None:
        self._uow = uow
        self._projects = projects

    def execute(self, song_id: str) -> EditorDocument:
        with self._uow.create() as transaction:
            song = transaction.songs.get(song_id)
        if song is None:
            raise NotFoundError("SongNotFound", "Song was not found", songId=song_id)
        raw = self._projects.read_text_artifact(song_id, song.active_revision, "lyricsSync")
        try:
            document = decode_document(raw)
        except ValueError as exc:
            raise NotFoundError(
                "ProjectInvalid", "Editor document is invalid", songId=song_id
            ) from exc
        return EditorDocument(song_id, song.active_revision, document)
