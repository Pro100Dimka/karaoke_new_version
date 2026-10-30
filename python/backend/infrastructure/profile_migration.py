"""Move an installed application's legacy profile before its first launch after an update."""
from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
from contextlib import ExitStack, closing
from pathlib import Path
from typing import Sequence

from dotenv import dotenv_values, set_key

from backend.infrastructure.atomic_files import atomic_write_text
from backend.infrastructure.clock import UtcClock
from backend.infrastructure.database import Database
from backend.infrastructure.hashing import sha256_file
from backend.infrastructure.ids import UuidGenerator
from backend.domain_errors import ConflictError, DependencyError
from backend.infrastructure.instance_lock import BackendInstanceLock, _process_exists
from backend.infrastructure.library_storage import SqlLibraryStorage
from backend.infrastructure.local_storage import LocalStorageSystem
from backend.infrastructure.migrations import DatabaseMigrator
from backend.infrastructure.recovery_journal import FileRecoveryJournal
from backend.projects.fingerprint import manifest_fingerprint
from backend.projects.manifest_codec import decode_manifest
from backend.serialization import dumps, loads_object
from backend.storage.domain import StorageRoots
from backend.storage.path_policy import portable_component

_DATA_NAMES = {
    'songs', 'models', 'cache', 'recordings', 'temp', 'quarantine', 'logs', 'recovery',
    'environment', 'backups', 'exports', '.ad-voice-data', 'app.db', 'app.db-wal',
    'app.db-shm', 'backend.lock', 'backend.lock.guard',
}
_LOCK_FILES = {'backend.lock', 'backend.lock.guard'}
_IMMUTABLE_MEDIA = {'.wav', '.flac', '.mp3', '.m4a', '.ogg', '.mp4', '.webm', '.bin', '.pt', '.onnx', '.safetensors', '.zip', '.dll', '.pyd', '.exe', '.whl', '.pak'}
_FILE_FIELDS = {'songs': ('source_path', 'cover_path'), 'recordings': ('file_path',), 'ai_models': ('local_path',)}


class _Progress:
    def __init__(self, root: Path) -> None:
        self._file = root / 'storage-progress.json'
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._state: dict[str, object] = {}
        self._started = time.monotonic()
        self._sent = 0.0
        self._thread = threading.Thread(target=self._heartbeat, daemon=True)
        self._thread.start()

    def update(self, phase: str, done: int = 0, total: int = 0, detail: str = '') -> None:
        with self._lock:
            changed = self._state.get('phase') != phase
            if changed:
                self._started = time.monotonic()
            self._state = {'phase': phase, 'done': done, 'total': total, 'detail': detail, 'pid': os.getpid()}
            if changed or time.monotonic() - self._sent >= 0.25 or (total > 0 and done == total):
                self._emit()

    def _emit(self) -> None:
        if not self._state:
            return
        self._sent = time.monotonic()
        state = {**self._state, 'elapsed': int(self._sent - self._started), 'updatedAt': int(time.time() * 1000)}
        try:
            atomic_write_text(self._file, dumps(state))
        except DependencyError as exc:
            print(f'STORAGE_STATUS_WARNING|{exc.__cause__}', file=sys.stderr, flush=True)
        detail = str(state['detail']).replace('|', '/').replace('\n', ' ').replace('\r', ' ')
        print(f"STORAGE|{state['phase']}|{state['done']}|{state['total']}|{state['elapsed']}|{detail}", flush=True)

    def _heartbeat(self) -> None:
        while not self._stop.wait(1):
            with self._lock:
                self._emit()

    def close(self) -> None:
        self._stop.set()
        self._thread.join()


_progress: _Progress | None = None


def _report(phase: str, done: int = 0, total: int = 0, detail: str = '') -> None:
    if _progress is not None:
        _progress.update(phase, done, total, detail)


def _records(state: dict[str, object], key: str) -> list[dict[str, object]]:
    value = state.get(key)
    if not isinstance(value, list):
        raise ValueError(f'Invalid migration journal: {key}')
    result: list[dict[str, object]] = []
    for item in value:
        if not isinstance(item, dict) or any(not isinstance(field, str) for field in item):
            raise ValueError(f'Invalid migration journal entry: {key}')
        result.append(item)
    return result


def _path(item: dict[str, object], key: str) -> Path:
    value = item.get(key)
    if not isinstance(value, str) or not Path(value).is_absolute():
        raise ValueError(f'Invalid migration path: {key}')
    return Path(value)


def _relocate(value: object, mappings: dict[Path, Path]) -> object:
    if isinstance(value, dict):
        return {key: _relocate(item, mappings) for key, item in value.items()}
    if isinstance(value, list):
        return [_relocate(item, mappings) for item in value]
    if isinstance(value, str) and Path(value).is_absolute():
        for source, target in sorted(mappings.items(), key=lambda item: len(item[0].parts), reverse=True):
            for candidate in (Path(value), Path(value).resolve()):
                if candidate.is_relative_to(source):
                    return str(target / candidate.relative_to(source))
    return value


def _files(source: Path, mappings: dict[Path, Path], ignored: set[Path] | None = None) -> list[Path]:
    ignored = ignored or set()
    if source.is_symlink() or source.is_junction():
        raise ValueError(f'Linked entry needs review before migration: {source}')
    if not source.exists():
        return []
    if source.is_file():
        return [source]
    files: list[Path] = []
    pending = [source]
    while pending:
        for file in pending.pop().iterdir():
            if file in mappings or file in ignored:
                continue
            if file.is_symlink() or file.is_junction():
                raise ValueError(f'Linked entry needs review before migration: {file}')
            if file.is_dir():
                pending.append(file)
            elif file.is_file():
                files.append(file)
            else:
                raise ValueError(f'Legacy entry is unreadable: {file}')
    return files


def _copy(source: Path, target: Path, links: dict[tuple[int, int], Path], temporary_dir: Path,
          expected: str | None = None, *, owned: bool = False) -> str:
    target.parent.mkdir(parents=True, exist_ok=True)
    info = source.stat()
    identity = (info.st_dev, info.st_ino)
    shared = source.suffix.casefold() in _IMMUTABLE_MEDIA
    digest = sha256_file(source)
    if expected is not None and expected != digest:
        raise ValueError(f'Conflicting legacy files map to the same destination: {target}')
    if target.is_file() and sha256_file(target) == digest:
        if shared:
            links.setdefault(identity, target)
        return digest
    descriptor, raw = tempfile.mkstemp(prefix='storage-', dir=temporary_dir)
    os.close(descriptor)
    temporary = Path(raw)
    role = {part.casefold() for part in source.parts}
    source_link = (owned and shared and 'recordings' not in role and
                   bool(role & {'models', 'gpu-runtime', 'revisions'}) and
                   info.st_dev == target.parent.stat().st_dev)
    if shared and (identity in links or source_link):
        temporary.unlink()
        os.link(links.get(identity, source), temporary)
    else:
        shutil.copy2(source, temporary)
        if sha256_file(temporary) != digest:
            raise ValueError(f'Migration checksum failed: {source}')
    if source.stat().st_mtime_ns != info.st_mtime_ns or source.stat().st_size != info.st_size:
        temporary.unlink(missing_ok=True)
        raise ValueError(f'Source changed during migration: {source}')
    os.replace(temporary, target)
    if shared:
        links[identity] = target
    return digest


def _rewrite_database(source: Path, working: Path, mappings: dict[Path, Path],
                      profile_target: Path, stage: Path) -> dict[str, list[int]]:
    original = source / 'app.db'
    if not original.is_file():
        return {}
    target = working / 'app.db'
    target.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(original.as_uri() + '?mode=ro', uri=True)) as before:
        counts = {
            name: before.execute(f'SELECT count(*) FROM "{name}"').fetchone()[0]
            for (name,) in before.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        identities = {
            name: [int(row[0]) for row in before.execute(f'SELECT id FROM "{name}"')]
            for name in counts if any(row[1] == 'id' for row in before.execute(f'PRAGMA table_info("{name}")'))
        }
        available = {
            (table, row[0], field): (Path(row[1]).is_file() or
                (source == working and Path(str(_relocate(row[1], mappings))).is_file()))
            for table, fields in _FILE_FIELDS.items() if table in counts for field in fields
            for row in before.execute(f'SELECT id,"{field}" FROM "{table}"') if row[1]
        }
        if source != working:
            with closing(sqlite3.connect(target)) as after:
                before.backup(after)
    database = Database(target)
    try:
        DatabaseMigrator().migrate(database.engine)
        roots, clock = StorageRoots.under(working), UtcClock()
        library = SqlLibraryStorage(database, roots, LocalStorageSystem(roots, clock), 0,
                                    FileRecoveryJournal(roots.recovery, clock, UuidGenerator()))
        changed = library.relocate(lambda value: _relocate(value, mappings))
        database.validate()
        with closing(sqlite3.connect(target)) as connection:
            for name, count in counts.items():
                if connection.execute(f'SELECT count(*) FROM "{name}"').fetchone()[0] != count:
                    raise ValueError(f'Migration changed the number of rows in {name}')
            for table, fields in _FILE_FIELDS.items():
                for field in fields:
                    for identity, value in connection.execute(f'SELECT id,"{field}" FROM "{table}"'):
                        if not value:
                            continue
                        file = Path(value)
                        if not file.is_absolute() or not file.is_relative_to(profile_target):
                            raise ValueError(f'Migrated file path is outside the installation: {file}')
                        copied = stage / file.relative_to(profile_target)
                        if copied.is_file() != available.get((table, identity, field), False):
                            raise ValueError(f'File availability changed during migration: {file}')
            for song_id, revision in changed:
                fingerprint = connection.execute('SELECT fingerprint FROM project_revisions WHERE song_id=? AND revision=?',
                                                 (song_id, revision)).fetchone()[0]
                folder = roots.songs / song_id / 'revisions' / str(revision)
                manifest = decode_manifest((folder / 'manifest.json').read_text(encoding='utf-8'))
                if manifest_fingerprint(manifest) != fingerprint:
                    raise ValueError(f'Migrated revision fingerprint failed: {song_id}/{revision}')
                for artifact in manifest.artifacts:
                    file = folder / artifact.relative_path
                    if artifact.relative_path.is_absolute() or '..' in artifact.relative_path.parts:
                        raise ValueError('Invalid revision artifact path')
                    original = source / 'songs' / song_id / 'revisions' / str(revision) / artifact.relative_path
                    if file.is_file() != original.is_file():
                        raise ValueError(f'Project artifact availability changed during migration: {file}')
                    if artifact.relative_path == Path('source.ref') and sha256_file(file) != artifact.checksum:
                        raise ValueError(f'Migrated source reference checksum failed: {file}')
            connection.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        atomic_write_text(working / '.ad-voice-data', 'ADVoice.App.v2')
        return identities
    finally:
        database.dispose()


def _plans(profile: Path, target: Path) -> dict[Path, Path]:
    default = profile / 'backend-data'
    saved = profile / 'storage-root.txt'
    active = Path(saved.read_text(encoding='utf-8').strip()) if saved.is_file() else default
    if not active.is_absolute():
        raise ValueError('Legacy storage path must be absolute')
    if saved.is_file() and not active.is_dir():
        raise ValueError(f'Legacy library is unavailable: {active}')
    mappings = {profile: target, active.resolve(): target / 'backend-data'}
    known = profile / 'storage-roots.txt'
    roots = [default, *(Path(line) for line in known.read_text(encoding='utf-8').splitlines() if line.strip())] if known.is_file() else [default]
    for root in roots:
        if not root.is_absolute() or not root.is_dir() or root.resolve() in mappings:
            continue
        root = root.resolve()
        if root != default.resolve() and not (root / '.ad-voice-data').is_file():
            continue
        key = hashlib.sha256(str(root).casefold().encode()).hexdigest()[:16]
        mappings[root] = target / 'legacy-data' / key
    models = default / 'models'
    if models.is_dir() and models.resolve() != active.resolve() / 'models':
        mappings[models.resolve()] = target / 'backend-data' / 'models'
    return mappings


def _external_sources(mappings: dict[Path, Path], target: Path, libraries: list[dict[str, object]]) -> None:
    fields = {
        'songs': ('song_id', ('source_path', 'cover_path')),
        'recordings': ('recording_id', ('file_path',)),
        'ai_models': ('model_id', ('local_path',)),
    }
    for item in libraries:
        source, destination = _path(item, 'source'), _path(item, 'target')
        database = source / 'app.db'
        if not database.is_file():
            continue
        with closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)) as connection:
            connection.row_factory = sqlite3.Row
            tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            for table, (identity, paths) in fields.items():
                if table not in tables:
                    continue
                columns = {row[1] for row in connection.execute(f'PRAGMA table_info("{table}")')}
                for row in connection.execute(f'SELECT * FROM "{table}"'):
                    for field in paths:
                        if field not in columns or not row[field]:
                            continue
                        file = Path(row[field]).resolve()
                        if file.exists() and not file.is_file():
                            raise ValueError(f'Registered media is not a regular file: {file}')
                        group = portable_component(str(row[identity]))
                        if table == 'ai_models':
                            location = target / 'backend-data' / 'models' / group / portable_component(str(row['version'])) / 'model.bin'
                        else:
                            category = 'source' if field == 'source_path' else 'cover'
                            location = destination / ('recordings' if table == 'recordings' else 'songs') / group
                            if table == 'songs':
                                location /= category
                            location /= file.name
                        relocated = _relocate(str(file), mappings)
                        if any(file.is_relative_to(root) for root in mappings) and (table != 'ai_models' or relocated == str(location)):
                            continue
                        mappings[file] = location
                        if table == 'recordings' and file.is_file():
                            for companion in file.parent.glob(file.stem + '*'):
                                if companion.is_file():
                                    mappings[companion.resolve()] = location.parent / companion.name


def _rewrite_metadata(working: Path, mappings: dict[Path, Path]) -> None:
    for file in [*(working / 'recovery').glob('*.json'),
                 *(working / 'recordings').glob('*/recording-recovery.json')]:
        original = loads_object(file.read_text(encoding='utf-8'))
        relocated = _relocate(original, mappings)
        if original != relocated:
            atomic_write_text(file, dumps(relocated))
    for file in (working / 'environment').glob('*.env'):
        for key, value in dotenv_values(file).items():
            relocated = _relocate(value, mappings)
            if isinstance(relocated, str) and relocated != value:
                set_key(file, key, relocated, quote_mode='auto')


def _verify_sources(state: dict[str, object], marker: Path) -> None:
    _report('Verify')
    cleanup = _records(state, 'cleanup')
    inventory = loads_object(marker.with_name('.storage-files.json').read_text(encoding='utf-8'))
    entries = _records(inventory, 'files')
    for item in cleanup:
        if item.get('phase') == 'linked':
            continue
        source, target, backup = (_path(item, key) for key in ('source', 'target', 'backup'))
        if source.exists() and source.resolve() == target.resolve() and not backup.exists():
            continue
        actual_root = backup if backup.is_dir() else source
        if not actual_root.is_dir():
            raise ValueError(f'The legacy profile is unavailable: {actual_root}')
        expected = {_path(entry, 'source').relative_to(source) for entry in entries if _path(entry, 'source').is_relative_to(source)}
        ignored = {actual_root / _path(item, 'source').relative_to(source) / name
                   for item in _records(state, 'libraries') if _path(item, 'source').is_relative_to(source)
                   for name in {*_LOCK_FILES, 'app.db-shm'}}
        actual = {file.relative_to(actual_root) for file in _files(actual_root, {}, ignored)}
        if expected != actual:
            raise ValueError(f'Legacy file inventory changed; its data was preserved: {source}')
    for index, raw in enumerate(entries):
        _report('Verify', index, len(entries), _path(raw, 'source').name)
        file = _path(raw, 'source')
        for item in cleanup:
            source, target, backup = (_path(item, key) for key in ('source', 'target', 'backup'))
            if not file.is_relative_to(source):
                continue
            if item.get('phase') == 'linked':
                break
            if backup.is_dir():
                file = backup / file.relative_to(source)
            elif source.exists() and source.resolve() == target.resolve():
                break
            if not file.is_file() or sha256_file(file) != raw['sha256']:
                raise ValueError(f'Legacy data changed after copying; it was preserved: {file}')
            break
    _report('Verify', len(entries), len(entries))


def _validate_destination(state: dict[str, object], marker: Path) -> None:
    _report('Verify')
    root = marker.parent.resolve()
    identities = state.get('identities')
    if not isinstance(identities, dict):
        raise ValueError('Migration catalog identities are missing')
    for item in _records(state, 'libraries'):
        target = _path(item, 'target')
        if not target.resolve().is_relative_to(root):
            raise ValueError(f'The verified destination library is unavailable: {target}')
        if not item.get('database'):
            continue
        if not (target / 'app.db').is_file():
            raise ValueError(f'The verified destination database is unavailable: {target}')
        database = Database(target / 'app.db')
        try:
            database.validate()
        finally:
            database.dispose()
        expected = identities.get(str(target))
        if not isinstance(expected, dict):
            raise ValueError('Invalid migration catalog identities')
        with closing(sqlite3.connect((target / 'app.db').as_uri() + '?mode=ro', uri=True)) as connection:
            for table, values in expected.items():
                if not isinstance(table, str) or not isinstance(values, list) or any(type(value) is not int for value in values):
                    raise ValueError('Invalid migration catalog identity')
                escaped = table.replace('"', '""')
                actual = {row[0] for row in connection.execute(f'SELECT id FROM "{escaped}"')}
                if not set(values).issubset(actual):
                    raise ValueError(f'The destination no longer contains the original catalog: {table}')
    inventory = loads_object(marker.with_name('.storage-files.json').read_text(encoding='utf-8'))
    for item in _records(inventory, 'files'):
        file = _path(item, 'target')
        if file.suffix.casefold() not in _IMMUTABLE_MEDIA or any(part.casefold() in {'temp', 'tmp', 'cache', 'updates'} for part in file.parts):
            continue
        if not file.is_relative_to(root):
            raise ValueError('Migrated media points outside the installation')
        info = file.stat()
        if info.st_size != item.get('size') or info.st_mtime_ns != item.get('mtime'):
            if sha256_file(file) != item.get('sha256'):
                raise ValueError(f'Migrated media changed before legacy cleanup: {file}')


def _finish(state: dict[str, object], marker: Path, source_locks: Sequence[BackendInstanceLock] = (), wait_parent: int = 0) -> None:
    with ExitStack() as stack:
        locks = list(source_locks)
        seen: set[Path] = {_path(item, 'target').resolve() for item in _records(state, 'libraries')}
        _validate_destination(state, marker)
        for item in _records(state, 'libraries'):
            folder = _path(item, 'source')
            if source_locks or not folder.is_dir() or folder.resolve() in seen:
                continue
            seen.add(folder.resolve())
            lock = BackendInstanceLock(folder / 'backend.lock', adopt_marker=True)
            lock.acquire()
            stack.callback(lock.release)
            locks.append(lock)
        _report('Waiting')
        while wait_parent > 0 and _process_exists(wait_parent):
            time.sleep(0.25)
        _verify_sources(state, marker)
        for lock in locks:
            # The live worker's marker keeps older backends out while Windows directory handles close.
            lock.release(preserve_marker=True)
        deadline = time.monotonic() + 10
        while True:
            try:
                _remove_sources(state, marker)
                break
            except OSError as exc:
                if getattr(exc, 'winerror', 0) not in {5, 32, 33} or time.monotonic() >= deadline:
                    raise
                time.sleep(0.25)


def _remove_sources(state: dict[str, object], marker: Path) -> None:
    cleanup = _records(state, 'cleanup')
    for index, raw in enumerate(cleanup):
        _report('Cleanup', index, len(cleanup), _path(raw, 'source').name)
        source, target, backup = (_path(raw, key) for key in ('source', 'target', 'backup'))
        if (not source.is_absolute() or source == source.parent
                or backup != source.with_name(source.name + '.storage-migrated')
                or not target.resolve().is_relative_to(marker.parent.resolve())
                or source.resolve() == marker.parent.resolve()):
            raise ValueError('Invalid migration cleanup paths')
        if source.exists() and source.resolve() == target.resolve():
            pass
        else:
            if source.exists():
                if backup.exists():
                    raise ValueError(f'Migration backup already exists: {backup}')
                source.rename(backup)
            if not backup.is_dir():
                raise ValueError(f'Migration source disappeared: {source}')
            if os.name != 'nt':
                source.symlink_to(target, target_is_directory=True)
            else:
                import _winapi

                _winapi.CreateJunction(str(target), str(source))
        if source.resolve() != target.resolve():
            raise ValueError(f'Migration compatibility link failed: {source}')
        raw['phase'] = 'linked'
        atomic_write_text(marker, dumps(state))
        if backup.exists():
            shutil.rmtree(backup)
    atomic_write_text(marker.with_name('storage-layout.json'), dumps({**state, 'phase': 'complete'}))
    _remove_temporary(state, marker.parent)
    marker.unlink()
    marker.with_name('.storage-files.json').unlink(missing_ok=True)
    _report('Done')


def _remove_temporary(state: dict[str, object], root: Path) -> None:
    if 'copy_temporary' not in state:
        return
    temporary = _path(state, 'copy_temporary')
    if temporary.parent.resolve() != (root / 'temp').resolve() or not temporary.name.startswith('storage-'):
        raise ValueError('Invalid migration temporary directory')
    if temporary.is_junction() or temporary.is_symlink():
        raise ValueError('Migration temporary directory was replaced with a link')
    if temporary.exists():
        shutil.rmtree(temporary)


def _schedule_finish(state: dict[str, object], marker: Path, lease: BackendInstanceLock,
                     wait_parent: int, source_locks: Sequence[BackendInstanceLock] = ()) -> None:
    root = marker.parent
    with ExitStack() as stack:
        locks = list(source_locks)
        if not locks:
            targets = {_path(item, 'target').resolve() for item in _records(state, 'libraries')}
            for item in _records(state, 'libraries'):
                source = _path(item, 'source')
                if not source.is_dir() or source.resolve() in targets:
                    continue
                lock = BackendInstanceLock(source / 'backend.lock', adopt_marker=True)
                lock.acquire()
                stack.callback(lock.release)
                locks.append(lock)
        _validate_destination(state, marker)
        _verify_sources(state, marker)
        cleanup_marker = marker.with_name('.storage-cleanup')
        if marker != cleanup_marker:
            marker.rename(cleanup_marker)
        _report('Waiting')
        handoff = root / f'.storage-worker-{UuidGenerator().new()}.pid'
        with (root / 'storage-migration.log').open('ab') as log:
            worker = subprocess.Popen(
                [sys.executable, '-B', '-u', '-m', 'backend.infrastructure.profile_migration',
                 str(_path(state, 'source')), str(_path(state, 'target')), '--finish-marker', str(cleanup_marker),
                 '--wait-parent', str(wait_parent), '--handoff-file', str(handoff)],
                stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
            )
        deadline = time.monotonic() + 30
        while not handoff.is_file():
            if worker.poll() is not None or time.monotonic() >= deadline:
                raise ValueError('The storage completion worker did not start; copied data was preserved')
            time.sleep(0.05)
        worker_pid = int(handoff.read_text(encoding='utf-8'))
        for lock in locks:
            lock.transfer_to(worker_pid)
        if _progress is not None:
            _progress.close()
        lease.transfer_to(worker_pid)
        handoff.unlink(missing_ok=True)


def _refresh_profile(target: Path, marker: Path, layout: dict[str, object]) -> None:
    _report('Prepare')
    old_target = layout.get('target', str(target))
    if not isinstance(old_target, str) or not Path(old_target).is_absolute():
        raise ValueError('Invalid installed profile location')
    mappings = {Path(old_target): target, target: target}
    folders = {target / 'backend-data'}
    saved = target / 'storage-roots.txt'
    if saved.is_file():
        for line in saved.read_text(encoding='utf-8').splitlines():
            value = _relocate(line, mappings)
            if isinstance(value, str) and Path(value).is_absolute() and Path(value).resolve().is_relative_to(target.resolve()):
                folders.add(Path(value).resolve())
    libraries: list[dict[str, object]] = [{'source': str(folder), 'target': str(folder)} for folder in sorted(folders)]
    state: dict[str, object] = {'phase': 'refreshing', 'source': str(target), 'target': str(target),
                               'libraries': libraries, 'cleanup': []}
    atomic_write_text(marker, dumps(state))
    with ExitStack() as stack:
        for item in libraries:
            folder = _path(item, 'source')
            lock = BackendInstanceLock(folder / 'backend.lock')
            lock.acquire()
            stack.callback(lock.release)
            item['database'] = (folder / 'app.db').is_file()
        original_roots = set(mappings)
        _external_sources(mappings, target, libraries)
        temporary_root = marker.parent / 'temp'
        temporary_root.mkdir(exist_ok=True)
        temporary = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix='storage-', dir=temporary_root)))
        state['copy_temporary'] = str(temporary)
        atomic_write_text(marker, dumps(state))
        links: dict[tuple[int, int], Path] = {}
        for source, destination in mappings.items():
            if source in original_roots or not source.is_file():
                continue
            _report('Copy', detail=source.name)
            required = source.stat().st_size
            if shutil.disk_usage(temporary_root).free < required + 2**30:
                raise ValueError('Not enough space to move external application media')
            expected = sha256_file(destination) if destination.is_file() else None
            _copy(source, destination, links, temporary, expected, owned=source.is_relative_to(target))
        identities = {}
        for index, item in enumerate(libraries):
            _report('Catalog', index, len(libraries))
            folder = _path(item, 'source')
            if item['database']:
                identities[str(folder)] = _rewrite_database(folder, folder, mappings, target, target)
            _rewrite_metadata(folder, mappings)
        atomic_write_text(target / 'storage-root.txt', str(target / 'backend-data'))
        atomic_write_text(saved, '\n'.join(str(folder) for folder in sorted(folders)))
        atomic_write_text(marker.with_name('storage-layout.json'), dumps({**layout, 'phase': 'complete',
            'version': 1, 'target': str(target), 'libraries': libraries, 'identities': identities}))
        marker.unlink()
        _report('Done')


def _unlink_compatibility(target: Path) -> None:
    root = target.parent.resolve()
    if any((root / name).exists() for name in ('.storage-migration', '.storage-cleanup')):
        raise ValueError('Application data migration must finish before uninstalling')
    layout = root / 'storage-layout.json'
    if not layout.is_file():
        return
    state = loads_object(layout.read_text(encoding='utf-8'))
    with ExitStack() as stack:
        for item in _records(state, 'libraries'):
            folder = _path(item, 'target')
            if not folder.resolve().is_relative_to(root):
                raise ValueError('Invalid installed library location')
            lock = BackendInstanceLock(folder / 'backend.lock')
            lock.acquire()
            stack.callback(lock.release)
        aliases = []
        if 'logical_profile' in state:
            aliases.append((_path(state, 'logical_profile'), target))
        aliases.extend((_path(item, 'source'), _path(item, 'target')) for item in _records(state, 'cleanup'))
        for source, destination in aliases:
            if (not destination.resolve().is_relative_to(root) or source == source.parent
                    or not (source.is_symlink() or source.is_junction())
                    or source.resolve() != destination.resolve()):
                continue
            if source.is_symlink():
                source.unlink()
            else:
                source.rmdir()


def migrate(profile: Path, target: Path, *, wait_parent: int = 0) -> None:
    global _progress
    target = target.absolute()
    installation = target.parents[1].resolve()
    root = target.parent.resolve()
    if not root.is_relative_to(installation):
        raise ValueError('Installed data directory must stay inside its installation')
    target = root / target.name
    root.mkdir(parents=True, exist_ok=True)
    if not target.resolve().is_relative_to(installation):
        raise ValueError('Installed data directory must not point outside its installation')
    lease = BackendInstanceLock(root / '.storage-worker.lock')
    lease.acquire()
    try:
        _progress = _Progress(root)
        _report('Prepare')
        marker = root / '.storage-cleanup' if (root / '.storage-cleanup').is_file() else root / '.storage-migration'
        state = loads_object(marker.read_text(encoding='utf-8')) if marker.is_file() else {}
        stage = root / '.storage-stage'
        if state.get('phase') == 'publishing' and target.is_dir() and not stage.exists():
            state['phase'] = 'published'
            atomic_write_text(marker, dumps(state))
        if state.get('phase') == 'published':
            if wait_parent > 0:
                _schedule_finish(state, marker, lease, wait_parent)
            else:
                _finish(state, marker)
            return
        layout_file = root / 'storage-layout.json'
        if state.get('phase') == 'refreshing' or (not state and target.is_dir() and
                (layout_file.is_file() or (profile.exists() and profile.resolve() == target.resolve()))):
            _remove_temporary(state, root)
            layout = loads_object(layout_file.read_text(encoding='utf-8')) if layout_file.is_file() else {}
            _refresh_profile(target, marker, layout)
            return
        if not profile.exists() and (profile.is_symlink() or profile.is_junction()):
            raise ValueError(f'The legacy profile is unavailable: {profile}')
        if not profile.exists() or profile.resolve() == target.resolve():
            if marker.exists():
                raise ValueError('The legacy migration source is unavailable; no data was discarded')
            target.mkdir(parents=True, exist_ok=True)
            atomic_write_text(layout_file, dumps({'phase': 'complete', 'version': 1, 'target': str(target),
                'cleanup': [], 'libraries': [], 'identities': {}}))
            _report('Done')
            return
        logical_profile, profile = profile.absolute(), profile.resolve()
        if state and (state.get('source') != str(profile) or state.get('target') != str(target)):
            raise ValueError('Migration source changed; the previous staged data was preserved')
        if stage.exists() and not state:
            raise ValueError('An unrecognized migration staging directory was preserved')
        _remove_temporary(state, root)
        if target.is_relative_to(profile) or profile.is_relative_to(target):
            raise ValueError('Migration source and destination overlap')
        if target.exists() and any(target.iterdir()):
            raise ValueError(f'Both profiles already contain data; no files were overwritten: {target}')
        mappings = _plans(profile, target)
        for source in mappings:
            if source.is_dir() and (target.is_relative_to(source) or source.is_relative_to(target)):
                raise ValueError('A legacy library overlaps the installed data directory')
            if source == profile or source.is_relative_to(profile):
                continue
            if not (source / '.ad-voice-data').is_file() or any(item.name not in _DATA_NAMES for item in source.iterdir()):
                raise ValueError(f'Exclusive library ownership could not be verified: {source}')
        cleanup = [source for source in mappings if not any(source != other and source.is_relative_to(other) for other in mappings)]
        cleanup_state = [{'source': str(source), 'target': str(mappings[source]),
                          'backup': str(source.with_name(source.name + '.storage-migrated'))} for source in cleanup]
        libraries: list[dict[str, object]] = [
            {'source': str(source), 'target': str(destination)} for source, destination in mappings.items()
            if destination == target / 'backend-data' or destination.relative_to(target).parts[:1] == ('legacy-data',)
        ]
        state = {'phase': 'copying', 'version': 1, 'source': str(profile), 'logical_profile': str(logical_profile),
                 'target': str(target), 'cleanup': cleanup_state, 'libraries': libraries}
        atomic_write_text(marker, dumps(state))
        stage.mkdir(exist_ok=True)
        with ExitStack() as stack:
            source_locks = []
            for item in libraries:
                source = _path(item, 'source')
                lock = BackendInstanceLock(source / 'backend.lock')
                lock.acquire()
                source_locks.append(lock)
                stack.callback(lock.release)
                item['database'] = (source / 'app.db').is_file()
            _external_sources(mappings, target, libraries)
            ignored = {_path(item, 'source') / name for item in libraries for name in {*_LOCK_FILES, 'app.db-shm'}}
            entries = [(file, stage / destination.relative_to(target) / file.relative_to(source))
                       for source, destination in mappings.items() for file in _files(source, mappings, ignored)]
            unique = {(file.stat().st_dev, file.stat().st_ino): file.stat().st_size for file, _ in entries}
            allocated = {(file.stat().st_dev, file.stat().st_ino): file.stat().st_size for file in stage.rglob('*') if file.is_file()}
            if shutil.disk_usage(root).free < max(0, sum(unique.values()) - sum(allocated.values())) + 2**30:
                raise ValueError('Not enough free space to migrate the application data safely')
            links: dict[tuple[int, int], Path] = {}
            temporary_root = root / 'temp'
            temporary_root.mkdir(exist_ok=True)
            temporary_dir = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix='storage-', dir=temporary_root)))
            state['copy_temporary'] = str(temporary_dir)
            atomic_write_text(marker, dumps(state))
            destination_hashes: dict[Path, str] = {}
            inventory = []
            for index, (file, destination) in enumerate(entries, 1):
                _report('Copy', index - 1, len(entries), file.name)
                owned = any(file.is_relative_to(Path(item['source'])) for item in cleanup_state)
                digest = _copy(file, destination, links, temporary_dir, destination_hashes.get(destination), owned=owned)
                destination_hashes[destination] = digest
                info = destination.stat()
                inventory.append({'source': str(file), 'target': str(target / destination.relative_to(stage)),
                                  'sha256': digest, 'size': info.st_size, 'mtime': info.st_mtime_ns})
            _report('Copy', len(entries), len(entries))
            atomic_write_text(root / '.storage-files.json', dumps({'files': inventory}))
            replacements = {**mappings, logical_profile: target}
            identities = {}
            for index, item in enumerate(libraries):
                _report('Catalog', index, len(libraries))
                source, destination = _path(item, 'source'), _path(item, 'target')
                working = stage / destination.relative_to(target)
                if item['database']:
                    identities[str(destination)] = _rewrite_database(source, working, replacements, target, stage)
                _rewrite_metadata(working, replacements)
            if {str(_path(item, 'target')) for item in libraries if item['database']} != set(identities):
                raise ValueError('A legacy database disappeared during migration; staged data was preserved')
            state['identities'] = identities
            atomic_write_text(stage / 'backend-data' / '.ad-voice-data', 'ADVoice.App.v2')
            atomic_write_text(stage / 'storage-root.txt', str(target / 'backend-data'))
            atomic_write_text(stage / 'storage-roots.txt', '\n'.join(sorted({str(target / 'backend-data'), *(str(_path(item, 'target')) for item in libraries)})))
            _verify_sources(state, marker)
            _report('Publish')
            state['phase'] = 'publishing'
            atomic_write_text(marker, dumps(state))
            if target.exists():
                target.rmdir()
            stage.rename(target)
            state['phase'] = 'published'
            atomic_write_text(marker, dumps(state))
            if wait_parent > 0:
                _schedule_finish(state, marker, lease, wait_parent, source_locks)
            else:
                _finish(state, marker, source_locks)
    finally:
        if _progress is not None:
            _progress.close()
        lease.release()


def main() -> int:
    global _progress
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('profile', type=Path)
    parser.add_argument('target', type=Path)
    parser.add_argument('--wait-parent', type=int, default=0)
    parser.add_argument('--finish-marker', type=Path)
    parser.add_argument('--unlink-compatibility', action='store_true')
    parser.add_argument('--handoff-file', type=Path)
    args = parser.parse_args()
    try:
        if args.unlink_compatibility:
            _unlink_compatibility(args.target)
        elif args.finish_marker:
            marker = args.finish_marker.absolute()
            if marker.parent.resolve() != args.target.parent.resolve() or marker.name != '.storage-cleanup':
                raise ValueError('Invalid migration completion marker')
            if args.handoff_file:
                handoff = args.handoff_file.absolute()
                if (handoff.parent.resolve() != marker.parent.resolve() or
                        not handoff.name.startswith('.storage-worker-') or handoff.suffix != '.pid'):
                    raise ValueError('Invalid migration worker handoff')
                atomic_write_text(handoff, str(os.getpid()))
            lease = BackendInstanceLock(marker.parent / '.storage-worker.lock', adopt_marker=True)
            deadline = time.monotonic() + 10
            while True:
                try:
                    lease.acquire()
                    break
                except ConflictError:
                    if time.monotonic() >= deadline:
                        raise
                    time.sleep(0.1)
            try:
                _progress = _Progress(marker.parent)
                print('STORAGE_CLEANUP|started', flush=True)
                _finish(loads_object(marker.read_text(encoding='utf-8')), marker, wait_parent=args.wait_parent)
                print('STORAGE_CLEANUP|complete', flush=True)
            finally:
                lease.release()
        else:
            migrate(args.profile, args.target, wait_parent=args.wait_parent)
    except Exception as exc:
        _report('Error', detail=str(exc))
        print(f'STORAGE_ERROR|{exc}', flush=True)
        return 1
    finally:
        if _progress is not None:
            _progress.close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
