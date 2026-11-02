"""Run every check.bat backend constituent, retaining failures after the first gate failure."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time


def hashes(root: Path) -> dict[str, str]:
    return {
        str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
        for folder in ("backend", "tests", "scripts")
        for path in sorted((root / folder).rglob("*.py"))
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-python", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--compare-result", type=Path)
    args = parser.parse_args()
    root = args.repo_python.resolve()
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    if (out / "summary.json").exists():
        raise SystemExit("Output already contains a gate; use a fresh output directory.")
    commands = {
        "compile": [sys.executable, "-c", "import compileall; raise SystemExit(0 if all(compileall.compile_dir(folder, quiet=1) for folder in ('backend', 'tests', 'scripts')) else 1)"],
        "architecture": [sys.executable, str(root / "scripts/architecture_check.py")],
        "bootstrap": [sys.executable, "-m", "scripts.bootstrap_smoke"],
        "format": [sys.executable, "-m", "ruff", "format", "--check", "backend", "tests", "scripts"],
        "lint": [sys.executable, "-m", "ruff", "check", "backend", "tests", "scripts"],
        "mypy": [sys.executable, "-m", "mypy", "backend", "scripts"],
        "pytest": [sys.executable, "-m", "pytest", "-q", "--tb=short"],
    }
    env = dict(os.environ, OMP_NUM_THREADS="1", MKL_NUM_THREADS="1", OPENBLAS_NUM_THREADS="1",
               NUMBA_CACHE_DIR="/tmp/karaoke-numba-cache")
    summary = {
        "python": sys.version, "platform": sys.platform,
        "startedAt": datetime.now(timezone.utc).isoformat(), "cwd": str(root),
        "entrypoint": "check.bat backend -> scripts/build-steps.mjs -> python/scripts/run_checks.py --require-dev-tools",
        "scope": "All ordered constituent checks; official entrypoint stops on first nonzero. Here later checks also run for full failure inventory, with no ignored failures. Pytest uses --tb=short only to shorten tracebacks.",
        "runChecksSha256": hashlib.sha256((root / "scripts/run_checks.py").read_bytes()).hexdigest(),
        "environment": {key: env[key] for key in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "NUMBA_CACHE_DIR")},
        "versions": {name: importlib.metadata.version(name) for name in ("torch", "torchaudio", "numpy", "scipy", "librosa", "pytest", "ruff", "mypy")},
        "sourceHashesBefore": hashes(root), "checks": {},
    }
    started = time.perf_counter()
    for name, command in commands.items():
        print(f"Starting {name}", flush=True)
        begin = time.perf_counter()
        with (out / f"{name}.log").open("w") as log:
            completed = subprocess.run(command, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)
        summary["checks"][name] = {"command": command, "exitCode": completed.returncode,
                                  "seconds": round(time.perf_counter() - begin, 3)}
        (out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
        print(name, summary["checks"][name], flush=True)
    summary["sourceHashesAfter"] = hashes(root)
    summary["sourceUnchanged"] = summary["sourceHashesBefore"] == summary["sourceHashesAfter"]
    summary["finishedAt"] = datetime.now(timezone.utc).isoformat()
    summary["wallSeconds"] = round(time.perf_counter() - started, 3)
    summary["firstFailedGate"] = next((name for name, check in summary["checks"].items() if check["exitCode"]), None)
    summary["runnerExitCode"] = int(summary["firstFailedGate"] is not None or not summary["sourceUnchanged"])
    (out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    log = (out / "pytest.log").read_text()
    failures = re.findall(r"^FAILED (\S+)", log, re.M)
    errors = re.findall(r"^ERROR (\S+)", log, re.M)
    pytest_summary = next((line for line in reversed(log.splitlines()) if re.search(r"\b\d+ (?:failed|passed)", line)), None)
    pytest_completed = summary["checks"]["pytest"]["exitCode"] in (0, 1) and pytest_summary is not None
    result = {
        "runnerExitCode": summary["runnerExitCode"], "firstFailedGate": summary["firstFailedGate"],
        "pytestSummary": pytest_summary, "pytestCompleted": pytest_completed,
        "sourceUnchanged": summary["sourceUnchanged"], "wallSeconds": summary["wallSeconds"],
        "checks": summary["checks"], "failureCount": len(failures) if pytest_completed else None,
        "failureIDs": failures, "errorIDs": errors, "failureIDsIncomplete": not pytest_completed,
    }
    if args.compare_result:
        prior = json.loads(args.compare_result.read_text())
        if not pytest_completed or not prior.get("pytestCompleted"):
            raise RuntimeError("Cannot compare failure sets when either pytest run did not finish.")
        result["comparedResult"] = str(args.compare_result.resolve())
        result["newFailureIDs"] = sorted(set(failures) - set(prior["failureIDs"]))
        result["resolvedFailureIDs"] = sorted(set(prior["failureIDs"]) - set(failures))
        result["newErrorIDs"] = sorted(set(errors) - set(prior.get("errorIDs", [])))
    (out / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    (out / "failure-ids.txt").write_text("\n".join(failures) + "\n")
    print(json.dumps({key: value for key, value in result.items() if key not in ("checks", "failureIDs")}, indent=2), flush=True)
    return summary["runnerExitCode"]


if __name__ == "__main__":
    raise SystemExit(main())
