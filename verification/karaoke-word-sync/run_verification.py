"""Run the existing Linux-compatible backend gates without hiding an earlier failure."""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import subprocess
import sys
import time


def source_hashes(root: Path) -> dict[str, str]:
    return {
        str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
        for folder in ("backend", "tests", "scripts")
        for path in sorted((root / folder).rglob("*.py"))
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("python_root", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    root, output = args.python_root.resolve(), args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "OMP_NUM_THREADS": "1", "MKL_NUM_THREADS": "1", "OPENBLAS_NUM_THREADS": "1"}
    before = source_hashes(root)
    checks = {
        "compile": ["-m", "compileall", "-q", "backend", "tests", "scripts"],
        "architecture": ["scripts/architecture_check.py"],
        "bootstrap": ["-m", "scripts.bootstrap_smoke"],
        "format": ["-m", "ruff", "format", "--check", "backend", "tests", "scripts"],
        "lint": ["-m", "ruff", "check", "backend", "tests", "scripts"],
        "mypy": ["-m", "mypy", "backend", "scripts"],
        "pytest": ["-m", "pytest", "-q", "--tb=short"],
    }
    summary: dict[str, object] = {
        "python": sys.version,
        "platform": sys.platform,
        "versions": {
            name: importlib.metadata.version(name)
            for name in ("torch", "torchaudio", "numpy", "scipy", "librosa", "pytest", "ruff", "mypy")
        },
        "checks": {},
        "source_hashes_before": before,
    }
    for name, options in checks.items():
        command = [sys.executable, *options]
        started = time.perf_counter()
        with (output / f"{name}.log").open("w", encoding="utf-8") as stream:
            result = subprocess.run(command, cwd=root, env=env, stdout=stream, stderr=subprocess.STDOUT)
        summary["checks"][name] = {
            "command": command,
            "exit_code": result.returncode,
            "seconds": round(time.perf_counter() - started, 3),
        }
        (output / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
        print(f"{name}: exit {result.returncode}", flush=True)
    after = source_hashes(root)
    summary["source_unchanged_during_checks"] = before == after
    summary["source_hashes_after"] = after
    (output / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    return int(not all(item["exit_code"] == 0 for item in summary["checks"].values()) or before != after)


if __name__ == "__main__":
    raise SystemExit(main())
