from __future__ import annotations

from datetime import datetime

from pydantic import Field

from backend.api.base_dto import ApiModel, JobRefDto
from backend.editor.domain import EditorDocument
from backend.lyrics.domain import LyricsDocument, Note, Word
from backend.processing.domain import Job, ProcessingMode
from backend.songs.domain import Language, Song, SongStatus


class SongDto(ApiModel):
    song_id: str
    title: str
    artist: str
    album: str | None
    duration: float | None
    language: Language
    status: SongStatus
    active_revision: int
    project_format_version: int
    cover_state: str
    created_at: datetime
    updated_at: datetime


class SongPageDto(ApiModel):
    items: list[SongDto]
    next_cursor: str | None


class ImportSongDto(ApiModel):
    source_path: str = Field(min_length=1, max_length=4096)
    title: str | None = Field(default=None, max_length=300)
    artist: str | None = Field(default=None, max_length=300)
    language: Language = Language.AUTO


class UpdateSongDto(ApiModel):
    title: str | None = Field(default=None, max_length=300)
    artist: str | None = Field(default=None, max_length=300)
    language: Language | None = None
    cover_path: str | None = Field(default=None, max_length=4096)


class StartProcessingDto(ApiModel):
    mode: ProcessingMode = ProcessingMode.AUTO
    online_lyrics: bool = True


class NoteDto(ApiModel):
    note: int
    start: float
    end: float


class WordDto(ApiModel):
    text: str
    start: float
    end: float
    notes: list[NoteDto]
    letters: list[float] = []


class LyricsDocumentDto(ApiModel):
    title: str
    artist: str
    duration: float
    bpm: float | None
    key: str | None
    lyrics: str
    words: list[WordDto]


class EditorDto(ApiModel):
    song_id: str
    revision: int
    document: LyricsDocumentDto


class SaveEditorDto(ApiModel):
    expected_revision: int = Field(ge=1)
    document: LyricsDocumentDto


class ResetEditorDto(ApiModel):
    expected_revision: int = Field(ge=1)


class RevisionDto(ApiModel):
    revision: int


class CompatibilityDto(ApiModel):
    compatibility: str


def song_dto(song: Song) -> SongDto:
    return SongDto(
        song_id=song.song_id,
        title=song.title,
        artist=song.artist,
        album=song.album,
        duration=song.duration,
        language=song.language,
        status=song.status,
        active_revision=song.active_revision,
        project_format_version=song.project_format_version,
        cover_state=song.cover_state.value,
        created_at=song.created_at,
        updated_at=song.updated_at,
    )


def job_dto(job: Job) -> JobRefDto:
    return JobRefDto(job_id=job.job_id, state=job.state.value)


def editor_dto(editor: EditorDocument) -> EditorDto:
    return EditorDto(
        song_id=editor.song_id,
        revision=editor.revision,
        document=lyrics_document_dto(editor.document),
    )


def lyrics_document_dto(document: LyricsDocument) -> LyricsDocumentDto:
    words = [
        WordDto(
            text=word.text,
            start=word.start,
            end=word.end,
            notes=[NoteDto(note=item.note, start=item.start, end=item.end) for item in word.notes],
            letters=list(word.letters),
        )
        for word in document.words
    ]
    return LyricsDocumentDto(
        title=document.title,
        artist=document.artist,
        duration=document.duration,
        bpm=document.bpm,
        key=document.key,
        lyrics=document.lyrics,
        words=words,
    )


def lyrics_document(dto: LyricsDocumentDto) -> LyricsDocument:
    words = tuple(
        Word(
            word.text,
            word.start,
            word.end,
            tuple(Note(note.note, note.start, note.end) for note in word.notes),
            tuple(word.letters),
        )
        for word in dto.words
    )
    return LyricsDocument(
        dto.title,
        dto.artist,
        dto.duration,
        dto.bpm,
        dto.key,
        dto.lyrics,
        words,
    )
