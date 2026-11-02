"""Run the real isolated PipelineOrchestrator; no user project is opened/changed."""
from __future__ import annotations

import argparse
from dataclasses import asdict, replace
from datetime import datetime, timezone
from hashlib import sha256
import json
import os
from pathlib import Path
import resource
import shutil
import sys
import threading
import time
import traceback

parser = argparse.ArgumentParser()
parser.add_argument('--repo-python', type=Path, required=True)
parser.add_argument('--source', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--title', required=True)
parser.add_argument('--artist', required=True)
parser.add_argument('--language', choices=['Russian', 'Ukrainian'], required=True)
parser.add_argument('--setup-only', action='store_true')
parser.add_argument('--models', type=Path, required=True)
parser.add_argument('--numba-cache', type=Path)
parser.add_argument('--cache-from', type=Path)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
profile = args.output / 'profile'
assert not profile.exists(), 'Each run needs a fresh isolated profile and cache'
os.environ['AD_VOICE_DATA'] = str(profile)
os.environ['AD_VOICE_MODELS'] = str(args.models.resolve())
os.environ['PYTHONPATH'] = str(args.repo_python)
numba_cache = (args.numba_cache or args.output / 'numba-cache').resolve()
numba_cache.mkdir(parents=True, exist_ok=True)
os.environ['NUMBA_CACHE_DIR'] = str(numba_cache)
sys.path.insert(0, str(args.repo_python))

from backend.ai.catalog import CATALOG
from backend.ai.domain import AiCapability, AiProviderDescriptor
from backend.bootstrap.build import build_container
from backend.bootstrap.config import BackendConfig
from backend.infrastructure.command_ai_provider import CommandAiProvider
from backend.infrastructure.local_storage import LocalWorkStorage
from backend.infrastructure.process_runner import ProcessRunner
from backend.lyrics.codec import decode_document, encode_document
from backend.processing.compute_policy import ComputeDevice, ExecutionContext
from backend.processing.domain import ProcessingMode, ProcessingOptions
from backend.processing.job_manager import JobContext
from backend.processing.policies import ResourceBudget
from backend.processing.preflight import ProcessingProviders
from backend.processing.reporting import report_payload
from backend.songs.domain import Language
from backend.songs.import_song import ImportSongRequest

recorded = None
if args.cache_from:
    from cached_results import RecordedModels
    recorded = RecordedModels(args.cache_from)
    assert sha256(args.source.read_bytes()).hexdigest() == recorded.metadata['sourceSha256']


def write(name, data):
    (args.output / name).write_text(json.dumps(data, ensure_ascii=False, indent=2, default=str))


class OfflineCatalog:
    # Audio identity lookup is outside the processing timer. We already know the
    # official source metadata; no online catalogue/lyrics/timing hints are used.
    def recognize(self, _source):
        return None


class TraceRunner(ProcessRunner):
    def __init__(self):
        self.sequence = 0
        self.runs = []

    def run(self, command, **options):
        self.sequence += 1
        index = self.sequence
        directory = args.output / 'processes' / f'{index:03}'
        directory.mkdir(parents=True)
        options['environment'] = {**options.get('environment', {}), 'V4_WORKER_TRACE': str(directory / 'worker')}
        if recorded:
            options['environment']['V4_ALIGNMENT_CACHE'] = str(recorded.alignment_directory)
        if isinstance(options.get('input_data'), bytes):
            (directory / 'stdin.json').write_bytes(options['input_data'])
        begin = time.perf_counter()
        cached = None
        try:
            cached = recorded.result(command, options.get('input_data')) if recorded else None
            result = cached if cached is not None else super().run(command, **options)
        except BaseException as error:
            self.runs.append({'index': index, 'command': list(command), 'elapsedSeconds': time.perf_counter() - begin, 'error': repr(error)})
            write('processes.json', self.runs)
            raise
        (directory / 'stdout.json').write_bytes(result.stdout)
        (directory / 'stderr.log').write_bytes(result.stderr)
        self.runs.append({'index': index, 'command': list(command), 'elapsedSeconds': time.perf_counter() - begin, 'exitCode': result.exit_code, 'recordedModelResult': cached is not None})
        write('processes.json', self.runs)
        if recorded:
            write('model-replay.json', recorded.manifest())
        return result


class RetainedWorkStorage(LocalWorkStorage):
    # Only cleanup differs: keep generated analysis artifacts for the comparison.
    def cleanup(self, path):
        destination = args.output / 'analysis-workspace'
        assert not destination.exists()
        path.rename(destination)


budget = ResourceBudget(cpu_threads=1, max_background_jobs=1)
config = replace(BackendConfig.load(profile, args.output / 'empty.env'), resources=budget)
runner = TraceRunner()
descriptor = AiProviderDescriptor('local-torch', '1', frozenset(AiCapability), frozenset({'Russian', 'Ukrainian', 'Auto', 'English'}), tuple(spec.required for spec in CATALOG), {'cpuThreads': 1, 'supportsCuda': True})
worker = 'replay_worker.py' if recorded else 'trace_worker.py'
provider = CommandAiProvider(descriptor, [sys.executable, str(Path(__file__).with_name(worker))], runner, resource_budget=budget)
container = None
before_sources = {str(path.relative_to(args.repo_python)): sha256(path.read_bytes()).hexdigest() for path in (args.repo_python / 'backend').rglob('*.py')}
source_digest = sha256(args.source.read_bytes()).hexdigest()
metadata = {'startedUtc': datetime.now(timezone.utc).isoformat(), 'mode': 'fresh-full-backend-PipelineOrchestrator', 'scope': 'decode/normalize, music, Demucs separation, source-derived ASR lyrics, alignment, CREPE pitch/stabilization, note construction, melody rendering, codec/validation/publication in isolated temporary profile; excludes UI/admission/import/download', 'source': str(args.source), 'sourceSha256': source_digest, 'sourceHashes': before_sources, 'threads': 1, 'seed': 0, 'coldProcessingCache': True, 'modelWeightsAlreadyDownloaded': True, 'sourceUnmodified': None, 'completed': False}
metadata['harnessHashes'] = {name: sha256(Path(__file__).with_name(name).read_bytes()).hexdigest() for name in ('run_full_pipeline.py', 'trace_worker.py', 'cached_results.py', 'replay_worker.py')}
if recorded:
    metadata.update({'mode': 'matched-cached-models-full-rebuild', 'scope': 'actual PipelineOrchestrator with recorded identical normalization/stems/ASR/MMS/pitch evidence; executes music analysis, validation, local alignment/refinement, pitch stabilization, note construction, melody rendering, codec and isolated publication; excludes cache seeding/import and all model inference', 'coldProcessingCache': False, 'cacheSource': str(args.cache_from)})
write('metadata.json', metadata)


def progress(stage, fraction, overall):
    row = {'atUtc': datetime.now(timezone.utc).isoformat(), 'stage': stage, 'fraction': fraction, 'overall': overall}
    with (args.output / 'progress.jsonl').open('a') as stream:
        stream.write(json.dumps(row) + '\n')
    print(stage, fraction, flush=True)


try:
    container = build_container(config, ai_providers=(provider,), lyrics_providers=(), recognition_provider=OfflineCatalog())
    if recorded:
        recorded.seed_normalization_cache(profile / 'cache')
    imported = container.songs.import_song.execute(ImportSongRequest(args.source, title=args.title, artist=args.artist, language=Language(args.language)))
    write('imported-song.json', asdict(imported))
    pipeline = container.songs.start_processing._pipeline
    pipeline._workspaces = RetainedWorkStorage(config.roots.temp)
    # Instrument FFmpeg and validation as well as model subprocesses.
    pipeline._audio._normalize._normalizer._runner = runner
    pipeline._audio._reference._runner = runner
    if args.setup_only:
        metadata.update({'setupOnly': True, 'completed': True, 'sourceUnmodified': sha256(args.source.read_bytes()).hexdigest() == source_digest})
        write('metadata.json', metadata)
        print('Production pipeline wired successfully', flush=True)
    else:
        context = JobContext('verification-v4-full-pipeline', threading.Event(), progress)
        began = time.perf_counter()
        report = pipeline.run(imported, ProcessingOptions(ProcessingMode.FAST, online_lyrics=False), ProcessingProviders(provider, provider, provider, provider), context, ExecutionContext(ComputeDevice.CPU, 1))
        elapsed = time.perf_counter() - began
        write('report.json', report_payload(report))
        storage = pipeline._publisher._storage
        raw = storage.read_text_artifact(imported.song_id, report.revision, 'lyricsSync')
        (args.output / 'lyricsSync.json').write_text(raw)
        document = decode_document(raw)
        assert json.loads(encode_document(document)) == json.loads(raw)
        final_sources = {name: sha256((args.repo_python / name).read_bytes()).hexdigest() for name in before_sources}
        metadata.update({'finishedUtc': datetime.now(timezone.utc).isoformat(), 'completed': True, 'fullBackendWallSeconds': elapsed, 'sourceUnmodified': sha256(args.source.read_bytes()).hexdigest() == source_digest, 'productionSourcesUnmodified': before_sources == final_sources, 'durationSeconds': imported.duration, 'words': len(document.words), 'notes': sum(len(w.notes) for w in document.words), 'maxParentRssKiB': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss, 'maxChildRssKiB': resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss, 'codecRoundTrip': True})
        write('metadata.json', metadata)
        print(json.dumps({key: metadata[key] for key in ('completed', 'fullBackendWallSeconds', 'durationSeconds', 'words', 'notes', 'sourceUnmodified', 'productionSourcesUnmodified')}, ensure_ascii=False), flush=True)
except BaseException as error:
    metadata.update({'completed': False, 'error': repr(error), 'traceback': traceback.format_exc(), 'sourceUnmodified': sha256(args.source.read_bytes()).hexdigest() == source_digest})
    write('metadata.json', metadata)
    raise
finally:
    if container is not None:
        container.shutdown()
