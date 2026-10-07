import json
import os
import subprocess
import tempfile
import unittest
import wave
from pathlib import Path

import numpy as np


RUNNER = Path(__file__).parents[2] / "tools" / "audio-quality-test.mjs"


class AudioQualityRunnerTests(unittest.TestCase):
    def test_local_stress_plan_keeps_scenarios_separate_and_seeded(self):
        run = subprocess.run(["node", str(RUNNER), "--local", "--stress", "--plan"],
                             capture_output=True, text=True, check=False)
        self.assertEqual(run.returncode, 0, run.stderr)
        plan = json.loads(run.stdout)
        self.assertEqual(plan["seed"], 12345)
        self.assertEqual(plan["mode"], "local")
        names = [scenario["name"] for scenario in plan["scenarios"]]
        self.assertEqual(len(names), len(set(names)))
        self.assertGreaterEqual(len(names), 7)
        self.assertTrue(all(scenario["mode"] == "local" for scenario in plan["scenarios"]))
        self.assertNotIn("network-jitter", names)

    def test_room_plan_is_distinct_and_includes_network_conditions(self):
        run = subprocess.run(["node", str(RUNNER), "--room", "--stress", "--plan"],
                             capture_output=True, text=True, check=False)
        self.assertEqual(run.returncode, 0, run.stderr)
        plan = json.loads(run.stdout)
        self.assertEqual(plan["mode"], "room")
        self.assertTrue(any(scenario["name"] == "network-jitter-loss"
                            for scenario in plan["scenarios"]))
        self.assertTrue(all(scenario["mode"] == "room" for scenario in plan["scenarios"]))

    def test_one_named_scenario_can_be_reproduced_without_running_the_matrix(self):
        run = subprocess.run(["node", str(RUNNER), "--local", "--stress", "--plan",
                              "--scenario", "cpu-saturation", "--seed", "7"],
                             capture_output=True, text=True, check=False)
        self.assertEqual(run.returncode, 0, run.stderr)
        plan = json.loads(run.stdout)
        self.assertEqual(plan["seed"], 7)
        self.assertEqual([row["name"] for row in plan["scenarios"]], ["cpu-saturation"])
        self.assertEqual(plan["scenarios"][0]["affinity"], 1)

    def test_seeded_source_is_repeatable_and_has_no_synthesis_clicks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sources = []
            for name in ("a", "b"):
                target = root / f"{name}.wav"
                run = subprocess.run(["node", str(RUNNER), "--source-only", str(target),
                                      "--seed", "77"], capture_output=True, text=True,
                                     check=False)
                self.assertEqual(run.returncode, 0, run.stderr)
                sources.append(target.read_bytes())
            self.assertEqual(sources[0], sources[1])
            with wave.open(str(root / "a.wav"), "rb") as source:
                samples = np.frombuffer(source.readframes(source.getnframes()),
                                        dtype="<i2").reshape(-1, 2)[:, 0] / 32768
            self.assertLess(np.max(np.abs(np.diff(samples))), 0.06)

    def test_room_command_runs_existing_ui_gate_and_keeps_quality_inconclusive(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            gate = root / "gate.mjs"
            gate.write_text('console.log(JSON.stringify({result:"PASS",artifacts:"fixture"}));',
                            encoding="utf-8")
            env = {**os.environ, "AD_VOICE_QUALITY_ROOM_GATE": str(gate)}
            run = subprocess.run(["node", str(RUNNER), "--room", "--scenario", "normal",
                                  "--out", str(root / "out")], env=env,
                                 capture_output=True, text=True, check=False)
            self.assertEqual(run.returncode, 3, run.stderr)
            report = json.loads((root / "out" / "room" / "normal" /
                                 "report.json").read_text(encoding="utf-8"))
            self.assertEqual(report["uiGate"]["result"], "PASS")
            self.assertEqual(report["status"], "INCONCLUSIVE")


if __name__ == "__main__":
    unittest.main()
