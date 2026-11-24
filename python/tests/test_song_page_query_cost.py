from __future__ import annotations

from contextlib import contextmanager
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import delete, event, insert, text

from backend.infrastructure.database import Database
from backend.infrastructure.migrations import DatabaseMigrator
from backend.infrastructure.orm import SongRow
from backend.songs.ports import SongSearch


@pytest.fixture
def catalog(tmp_path: Path):
    database = Database(tmp_path / "library.db")
    DatabaseMigrator().migrate(database.engine)
    now = datetime(2026, 1, 1, tzinfo=UTC)
    with database.engine.begin() as connection:
        connection.execute(
            insert(SongRow),
            [
                {
                    "song_id": f"song-{index:05}",
                    "title": f"Song {index}",
                    "title_normalized": f"song {index}",
                    "artist": "Artist",
                    "artist_normalized": "artist",
                    "source_identity": f"source-{index}",
                    "source_state": "Managed",
                    "status": "Ready" if index % 2 == 0 else "Imported",
                    "active_revision": 1,
                    "project_format_version": 1,
                    "created_at": now + timedelta(days=index // 3000),
                    "updated_at": now,
                    "language": "Auto",
                    "cover_state": "Fallback",
                    "metadata_provenance_json": "{}",
                    "user_overrides_json": "{}",
                }
                for index in range(6000)
            ],
        )
    try:
        yield database
    finally:
        database.dispose()


@contextmanager
def query_work(database):
    steps = []
    connections = set()

    def measure(connection, _cursor, statement, _parameters, _context, _many):
        if statement.lstrip().upper().startswith("SELECT"):
            raw = connection.connection.driver_connection
            connections.add(raw)
            raw.set_progress_handler(lambda: steps.append(100), 100)

    event.listen(database.engine, "before_cursor_execute", measure)
    try:
        yield steps
    finally:
        event.remove(database.engine, "before_cursor_execute", measure)
        for connection in connections:
            connection.set_progress_handler(None, 0)


@pytest.mark.parametrize("status", ["all", "ready"])
@pytest.mark.parametrize("descending", [False, True])
@pytest.mark.parametrize("offset", [0, 2000])
def test_date_sorted_catalog_page_avoids_sorting_all_equal_dates(
    catalog, status, descending, offset
):
    expected = sorted(
        (index for index in range(6000) if status == "all" or index % 2 == 0),
        key=lambda index: (-(index // 3000) if descending else index // 3000, index),
    )
    query = SongSearch(status=status, descending=descending, limit=20)
    if offset:
        with catalog.create() as transaction:
            previous = transaction.songs.search(replace(query, limit=offset))
        query = replace(query, cursor=previous.next_cursor)
        assert query.cursor is not None
    with query_work(catalog) as steps, catalog.create() as transaction:
        page = transaction.songs.search(query)
    assert [item.song_id for item in page.items] == [
        f"song-{index:05}" for index in expected[offset : offset + 20]
    ]
    assert sum(steps) < 6000, f"A 20-song date page required {sum(steps)} SQLite VM steps"


def test_catalog_date_indexes_upgrade_a_populated_schema_four_database(catalog):
    names = (
        "ix_songs_catalog_newest",
        "ix_songs_catalog_oldest",
        "ix_songs_catalog_status_newest",
        "ix_songs_catalog_status_oldest",
    )
    with catalog.engine.begin() as connection:
        for name in names:
            connection.execute(text(f"DROP INDEX IF EXISTS {name}"))
    DatabaseMigrator().migrate(catalog.engine)
    DatabaseMigrator().migrate(catalog.engine)
    with catalog.engine.connect() as connection:
        indexes = {row[1] for row in connection.execute(text("PRAGMA index_list(songs)"))}
        assert set(names) <= indexes
        assert connection.execute(text("PRAGMA user_version")).scalar_one() == 4
        assert connection.execute(text("SELECT COUNT(*) FROM songs")).scalar_one() == 6000
    with query_work(catalog) as steps, catalog.create() as transaction:
        page = transaction.songs.search(SongSearch(status="ready", limit=20))
    assert [item.song_id for item in page.items] == [
        f"song-{index:05}" for index in range(3000, 3040, 2)
    ]
    assert sum(steps) < 6000


@pytest.mark.parametrize("status", ["all", "ready", "not-processed"])
@pytest.mark.parametrize("descending", [False, True])
@pytest.mark.parametrize("search", [None, "Song 300"])
def test_date_cursor_crosses_tie_boundaries_without_skipping_or_repeating_songs(
    catalog, status, descending, search
):
    kept = [*range(14), *range(3000, 3014)]
    with catalog.engine.begin() as connection:
        connection.execute(
            delete(SongRow).where(SongRow.song_id.not_in([f"song-{index:05}" for index in kept]))
        )
    expected = sorted(
        (
            index
            for index in kept
            if (status == "all" or index % 2 == (0 if status == "ready" else 1))
            and (search is None or search in f"Song {index}")
        ),
        key=lambda index: (-(index // 3000) if descending else index // 3000, index),
    )
    query = SongSearch(status=status, descending=descending, search=search, limit=7)
    actual = []
    for _ in range(5):
        with catalog.create() as transaction:
            page = transaction.songs.search(query)
        actual.extend(item.song_id for item in page.items)
        if page.next_cursor is None:
            break
        query = replace(query, cursor=page.next_cursor)
    else:
        pytest.fail("Catalog did not reach the final page")
    assert actual == [f"song-{index:05}" for index in expected]
