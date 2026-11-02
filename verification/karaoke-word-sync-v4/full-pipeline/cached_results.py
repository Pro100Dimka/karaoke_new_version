"""Exact model-output replay for controlled full-orchestrator comparisons.

This is verification instrumentation, not a production inference substitute.
Every consumed audio artifact is checked against the completed fresh run.
"""
from __future__ import annotations

from hashlib import sha256
import json
from pathlib import Path
import shutil

from backend.infrastructure.process_runner import ProcessResult


def digest(path: Path) -> str:
    return sha256(path.read_bytes()).hexdigest()


def argument(command, name):
    return command[command.index(name) + 1]


class RecordedModels:
    def __init__(self, source: Path):
        self.source = source
        self.metadata = json.loads((source / 'metadata.json').read_text())
        assert self.metadata['completed'], 'Require a successfully completed fresh pipeline'
        self.runs = json.loads((source / 'processes.json').read_text())
        self.operations = {}
        self.hits = []
        for operation in ('separate', 'transcribe-many', 'align', 'pitch'):
            matches = [run for run in self.runs if len(run['command']) > 2 and run['command'][2] == operation]
            assert len(matches) == 1, f'Expected one recorded {operation}, got {len(matches)}'
            self.operations[operation] = matches[0]

    def directory(self, operation):
        return self.source / 'processes' / f"{self.operations[operation]['index']:03}"

    def original_path(self, raw):
        path = Path(raw)
        if path.exists():
            return path
        relative = path.relative_to(self.source / 'profile' / 'temp')
        path = self.source / 'analysis-workspace' / Path(*relative.parts[1:])
        assert path.is_file(), f'Recorded artifact missing: {path}'
        return path

    def verify_audio(self, current, original):
        current_path = Path(current)
        original_path = self.original_path(original)
        actual, expected = digest(current_path), digest(original_path)
        assert actual == expected, f'Audio changed for cached model: {current_path}'
        return actual

    @property
    def alignment_directory(self):
        return self.directory('align') / 'worker'

    def seed_normalization_cache(self, target):
        shutil.copytree(self.source / 'profile' / 'cache', target, dirs_exist_ok=True)

    def result(self, command, input_data):
        if len(command) < 3:
            return None
        operation = command[2]
        if operation not in ('separate', 'transcribe-many', 'pitch'):
            return None
        recorded = self.operations[operation]
        directory = self.directory(operation)
        payload_file = directory / 'stdout.json'
        payload = json.loads(payload_file.read_text())
        audio_hashes = []
        if operation == 'transcribe-many':
            assert isinstance(input_data, bytes), 'Expected the production nonstreaming request'
            expected = json.loads((directory / 'stdin.json').read_text())['requests']
            actual = json.loads(input_data)['requests']
            assert len(expected) == len(actual)
            assert argument(command, '--language') == argument(recorded['command'], '--language')
            for current, previous in zip(actual, expected, strict=True):
                assert current.get('startSeconds') == previous.get('startSeconds')
                audio_hashes.append(self.verify_audio(current['input'], previous['input']))
        else:
            audio_hashes.append(self.verify_audio(argument(command, '--input'), argument(recorded['command'], '--input')))
            if operation == 'separate':
                target = Path(argument(command, '--output'))
                target.mkdir(parents=True, exist_ok=True)
                for field in ('instrumental', 'referenceVocal'):
                    old = self.original_path(payload[field])
                    new = target / old.name
                    shutil.copyfile(old, new)
                    assert digest(old) == digest(new)
                    payload[field] = str(new)
        self.hits.append({'operation': operation, 'sourceWorker': recorded['index'], 'payloadSha256': digest(payload_file), 'audioSha256': audio_hashes})
        return ProcessResult(0, json.dumps(payload, ensure_ascii=False).encode(), b'')

    def manifest(self):
        return {'source': str(self.source), 'sourceCompleted': self.metadata['completed'], 'sourceAudioSha256': self.metadata['sourceSha256'], 'alignmentEvidence': str(self.alignment_directory), 'hits': self.hits}
