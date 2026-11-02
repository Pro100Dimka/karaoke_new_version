"""Run the six unchanged full-suite variances sequentially on two frozen sources."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--plan", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
plan = json.loads(args.plan.read_text())
if args.output.exists():
    raise SystemExit("Use a fresh output directory; previous observations are retained")
args.output.mkdir(parents=True)
env = dict(os.environ, **plan["environment"])
report = {"startedUtc": datetime.now(timezone.utc).isoformat(), "scope": plan["scope"],
          "nodeIDs": plan["nodeIDs"], "environment": plan["environment"],
          "planSha256": hashlib.sha256(args.plan.read_bytes()).hexdigest(), "runs": []}
for label, directory in plan["repositories"].items():
    root = Path(directory)
    code = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for folder in ("backend", "tests", "scripts") for p in sorted((root / folder).rglob("*.py"))}
    command = [sys.executable, "-m", "pytest", "-vv", "--tb=short",
               "--junitxml=" + str((args.output / (label + ".xml")).resolve()), *plan["nodeIDs"]]
    print("Starting", label, flush=True)
    started = time.perf_counter()
    with (args.output / (label + ".log")).open("w") as log:
        completed = subprocess.run(command, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)
    text = (args.output / (label + ".log")).read_text()
    row = {"label": label, "cwd": str(root), "command": command, "exitCode": completed.returncode,
           "wallSeconds": time.perf_counter() - started,
           "pytestSummary": next((line for line in reversed(text.splitlines()) if re.search(r"\b\d+ (?:failed|passed)", line)), None),
           "failureIDs": re.findall(r"^FAILED (\S+)", text, re.M),
           "sourceHashes": code,
           "sourceUnchanged": all(hashlib.sha256((root / name).read_bytes()).hexdigest() == digest for name, digest in code.items())}
    report["runs"].append(row)
    (args.output / "result.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({key: value for key, value in row.items() if key not in ("sourceHashes", "command")}, indent=2), flush=True)
report["finishedUtc"] = datetime.now(timezone.utc).isoformat()
report["runnerExitCode"] = int(any(row["exitCode"] or not row["sourceUnchanged"] for row in report["runs"]))
report["interpretation"] = "These selective reruns do not replace the raw full-suite counts. A passing rerun alone does not prove a root cause or complete release gate."
(args.output / "result.json").write_text(json.dumps(report, indent=2) + "\n")
sys.exit(report["runnerExitCode"])
