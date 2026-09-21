from __future__ import annotations

from backend.lyrics.codec import decode_document
from backend.projects.ports import ProjectStorage
from backend.editor.save_document import SaveEditorDocument


class ResetEditorDocument:
    def __init__(self, projects: ProjectStorage, save: SaveEditorDocument) -> None:
        self._projects = projects
        self._save = save

    def execute(self, song_id: str, expected_revision: int) -> int:
        raw = self._projects.read_text_artifact(song_id, expected_revision, "lyricsBaseline")
        document = decode_document(raw)
        return self._save.execute(song_id, expected_revision, document)
