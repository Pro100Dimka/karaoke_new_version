"""Execute the existing frontend gate constituents, retaining every exit code."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--repo", type=Path, required=True)
parser.add_argument("--freeze", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
frontend = args.repo / "frontend"
freeze = json.loads(args.freeze.read_text())
frontend_hashes = {name: digest for name, digest in freeze["files"].items() if name.startswith("frontend/")}
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
if any(sha(args.repo / name) != digest for name, digest in frontend_hashes.items()):
    raise SystemExit("Frontend does not match the requested source freeze")
package = json.loads((frontend / "package.json").read_text())
assert package["scripts"]["typecheck"] == "tsc -b tsconfig.app.json --pretty false && tsc -p electron/tsconfig.json --noEmit --pretty false"
assert package["scripts"]["test"] == 'node scripts/check-architecture.mjs && vitest run && node --test "electron/*.test.mjs" "scripts/*.test.mjs"'
commands = {
    "typecheck-app": ["node", "node_modules/typescript/bin/tsc", "-b", "tsconfig.app.json", "--pretty", "false"],
    "typecheck-electron": ["node", "node_modules/typescript/bin/tsc", "-p", "electron/tsconfig.json", "--noEmit", "--pretty", "false"],
    "architecture": ["node", "scripts/check-architecture.mjs"],
    "vitest": ["node", "node_modules/vitest/vitest.mjs", "run"],
    "node-tests": ["node", "--test", "electron/*.test.mjs", "scripts/*.test.mjs"],
}
args.output.mkdir(parents=True, exist_ok=True)
if (args.output / "summary.json").exists():
    raise SystemExit("Output exists; choose a fresh frontend run directory")
env = dict(os.environ, OMP_NUM_THREADS="1", MKL_NUM_THREADS="1", OPENBLAS_NUM_THREADS="1")
report = {"startedUtc": datetime.now(timezone.utc).isoformat(), "repository": str(args.repo.resolve()),
          "scope": "All existing npm run typecheck and npm test constituents, in sequence. Later checks still run after a failure; no failures suppressed. Existing dependencies only. No UI/Electron launch or live audio verification. Shared-CPU test duration is not a benchmark.",
          "freezeManifestSha256": sha(args.freeze), "packageSha256": sha(frontend / "package.json"),
          "scripts": {name: package["scripts"][name] for name in ("typecheck", "test")},
          "nodeVersion": subprocess.check_output(["node", "--version"], text=True).strip(),
          "environment": {name: env[name] for name in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS")},
          "sourceHashesBefore": frontend_hashes, "checks": {}}
start = time.perf_counter()
for name, command in commands.items():
    print("Starting", name, flush=True)
    begin = time.perf_counter()
    with (args.output / f"{name}.log").open("w") as log:
        result = subprocess.run(command, cwd=frontend, env=env, stdout=log, stderr=subprocess.STDOUT)
    report["checks"][name] = {"command": command, "exitCode": result.returncode,
                             "seconds": time.perf_counter() - begin}
    (args.output / "summary.json").write_text(json.dumps(report, indent=2) + "\n")
    print(name, report["checks"][name], flush=True)
report["sourceHashesAfter"] = {name: sha(args.repo / name) for name in frontend_hashes}
report["sourceUnchanged"] = report["sourceHashesBefore"] == report["sourceHashesAfter"]
report["wallSeconds"] = time.perf_counter() - start
report["finishedUtc"] = datetime.now(timezone.utc).isoformat()
report["runnerExitCode"] = int(not report["sourceUnchanged"] or any(row["exitCode"] for row in report["checks"].values()))
(args.output / "summary.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps({"runnerExitCode": report["runnerExitCode"], "sourceUnchanged": report["sourceUnchanged"],
                  "exitCodes": {name: row["exitCode"] for name, row in report["checks"].items()}}, indent=2), flush=True)
sys.exit(report["runnerExitCode"])
