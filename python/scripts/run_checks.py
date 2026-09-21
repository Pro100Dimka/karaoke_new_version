from __future__ import annotations

import argparse
import compileall
import importlib.util
import subprocess
import sys
from pathlib import Path
from collections.abc import Sequence

ROOT = Path(__file__).resolve().parents[1]


def _run(command: Sequence[str]) -> int:
    result = subprocess.run(command, cwd=ROOT, check=False)
    return result.returncode


def _tool_available(module: str) -> bool:
    return importlib.util.find_spec(module) is not None


def _dev_tool_commands(require: bool) -> tuple[list[str], ...]:
    commands: list[list[str]] = []
    missing: list[str] = []
    if _tool_available("ruff"):
        commands.append(
            [sys.executable, "-m", "ruff", "format", "--check", "backend", "tests", "scripts"]
        )
        commands.append([sys.executable, "-m", "ruff", "check", "backend", "tests", "scripts"])
    else:
        missing.append("ruff")
    if _tool_available("mypy"):
        commands.append([sys.executable, "-m", "mypy", "backend", "scripts"])
    else:
        missing.append("mypy")
    if require and missing:
        print(f"Missing required dev tools: {', '.join(missing)}", file=sys.stderr)
        return ([sys.executable, "-c", "raise SystemExit(2)"],)
    if missing:
        print(
            "Dev tools unavailable locally; CI requires them: " + ", ".join(missing),
            file=sys.stderr,
        )
    return tuple(commands)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--require-dev-tools", action="store_true")
    parser.add_argument("--skip-tests", action="store_true")
    args = parser.parse_args(argv)

    compiled = all(
        compileall.compile_dir(ROOT / folder, quiet=1) for folder in ("backend", "tests", "scripts")
    )
    if not compiled:
        return 1

    commands: list[Sequence[str]] = [
        [sys.executable, str(ROOT / "scripts" / "architecture_check.py")],
        [sys.executable, "-m", "scripts.bootstrap_smoke"],
        *_dev_tool_commands(args.require_dev_tools),
    ]
    if not args.skip_tests:
        commands.append([sys.executable, "-m", "pytest", "-q"])

    for command in commands:
        code = _run(command)
        if code:
            return code
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
