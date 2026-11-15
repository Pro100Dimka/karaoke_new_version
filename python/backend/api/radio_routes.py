from typing import Annotated

from fastapi import APIRouter, Query

from backend.infrastructure.youtube_radio import YoutubeRadio

router = APIRouter()


@router.get("/radio/youtube")
def youtube_radio(
    playlist_id: Annotated[str, Query(pattern=r"^[A-Za-z0-9_-]{10,100}$")],
    index: Annotated[int, Query(ge=1, le=100_000)] = 1,
) -> dict[str, str | int]:
    return YoutubeRadio().resolve(playlist_id, index)
