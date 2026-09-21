#!/usr/bin/env python3
import json
import pathlib
import shlex
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

root = pathlib.Path(__file__).resolve().parents[1]
build = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else root / "build-static-analysis").resolve()
commands = json.loads((build / "compile_commands.json").read_text())
clang = shutil.which("clang++")
if not clang:
    raise SystemExit("clang++ is required for static analysis")

def analyze(entry):
    source = pathlib.Path(entry["file"]).resolve()
    try:
        source.relative_to(root / "src")
    except ValueError:
        return None
    args = shlex.split(entry["command"])
    filtered = []
    skip_next = False
    for arg in args[1:]:
        if skip_next:
            skip_next = False
            continue
        if arg == "-c":
            continue
        if arg == "-o":
            skip_next = True
            continue
        if arg.startswith("-o") and len(arg) > 2:
            continue
        if arg == "-Werror":
            continue
        filtered.append(arg)
    output = build / "analyzer" / (source.stem + ".plist")
    output.parent.mkdir(parents=True, exist_ok=True)
    command = [clang, "--analyze", "-Xclang", "-analyzer-output=plist", *filtered, "-o", str(output)]
    result = subprocess.run(command, cwd=entry["directory"], text=True, capture_output=True)
    diagnostics = (result.stdout + result.stderr).strip()
    if result.returncode != 0 or "warning:" in diagnostics or "error:" in diagnostics:
        return source, diagnostics
    return None

with ThreadPoolExecutor(max_workers=4) as executor:
    failures = [result for result in executor.map(analyze, commands) if result is not None]

if failures:
    for source, diagnostics in failures:
        print(f"Static analysis failed: {source.relative_to(root)}", file=sys.stderr)
        if diagnostics:
            print(diagnostics, file=sys.stderr)
    raise SystemExit(1)
print("Clang static analysis passed")
