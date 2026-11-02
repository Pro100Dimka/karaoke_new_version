"""Derive an auditable paired timing mode from the already verified strict-cache harness."""
from pathlib import Path
import hashlib,json
root=Path(__file__).parent
original=root/'benchmark_cached_alignment.py'
source=original.read_text()
replacements=[]
def replace(old,new):
 global source
 assert source.count(old)==1,old[:90]
 source=source.replace(old,new)
 replacements.append({'oldSha256':hashlib.sha256(old.encode()).hexdigest(),'newSha256':hashlib.sha256(new.encode()).hexdigest(),'description':old[:100]})
replace('import argparse\n','import argparse\nimport ast\nimport __future__\n')
helper='''def version_selector(baseline, final):
    from backend.ai_worker import ctc, speech, word_guidance
    modules = {"ctc.py": ctc, "word_guidance.py": word_guidance}
    changed = {"ctc.py": {"with_voice_onsets"},
               "word_guidance.py": {"_reviewed_words", "_review_candidates", "_supported_review", "_candidates"}}
    added = {"ctc.py": {"_voice_entries"}, "word_guidance.py": {
        "_inactive_core", "_active_replacement", "_active_review_candidates", "_active_core_candidates", "_review_entries"}}
    before, after = backend_hashes(baseline), backend_hashes(final)
    differing = {name for name in before.keys() | after.keys() if before.get(name) != after.get(name)}
    if differing != {"backend/ai_worker/" + name for name in modules}:
        raise ValueError(f"Unexpected backend differences: {differing}")
    functions, proof = {}, []
    for filename, module in modules.items():
        old_path, new_path = (repo / "backend/ai_worker" / filename for repo in (baseline, final))
        old_tree, new_tree = ast.parse(old_path.read_text()), ast.parse(new_path.read_text())
        old_nodes = {node.name: node for node in old_tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))}
        new_nodes = {node.name: node for node in new_tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))}
        if set(new_nodes) - set(old_nodes) != added[filename] or set(old_nodes) - set(new_nodes):
            raise ValueError("Unexpected added/removed functions")
        actual_changes = {name for name in old_nodes.keys() & new_nodes.keys()
                          if ast.dump(old_nodes[name], include_attributes=False) != ast.dump(new_nodes[name], include_attributes=False)}
        if actual_changes != changed[filename]:
            raise ValueError(f"Unexpected changed functions: {actual_changes}")
        ignored = changed[filename] | added[filename]
        old_rest = ast.Module(body=[node for node in old_tree.body if getattr(node, "name", None) not in ignored], type_ignores=[])
        new_rest = ast.Module(body=[node for node in new_tree.body if getattr(node, "name", None) not in ignored], type_ignores=[])
        if ast.dump(old_rest, include_attributes=False) != ast.dump(new_rest, include_attributes=False):
            raise ValueError("Untoggled imports, globals, or other source differ")
        for name in sorted(changed[filename]):
            local = {}
            compiled = compile(ast.Module(body=[old_nodes[name]], type_ignores=[]), str(old_path), "exec", flags=__future__.annotations.compiler_flag)
            exec(compiled, module.__dict__, local)
            functions[(module, name)] = {"baseline-v4": local[name], "final-v5": getattr(module, name)}
            if local[name].__globals__ is not module.__dict__:
                raise AssertionError("Baseline function must use current production module globals")
        proof.append({"file": filename, "baselineSha256": sha(old_path), "finalSha256": sha(new_path),
                      "toggledFunctions": sorted(changed[filename]), "newHelpersUnusedByBaseline": sorted(added[filename]),
                      "allOtherAstNodesEqual": True})
    def select(label):
        for (module, name), versions in functions.items():
            setattr(module, name, versions[label])
        speech.with_voice_onsets = ctc.with_voice_onsets
    return select, {"onlyChangedBackendFiles": sorted(differing), "modules": proof}, before


'''
replace('def benchmark_case(args, case, source_hashes):\n',helper+'def benchmark_case(args, case, source_hashes):\n')
replace('    expected = json.loads((reference_dir / "payload.json").read_text())\n','''    baseline_reference_dir = args.baseline_reference_dir / case["case"]
    baseline_meta = read_completed_metadata(baseline_reference_dir, case)
    if baseline_meta["sourceHashes"] != args.baseline_hashes:
        raise ValueError("Baseline reference trace source differs")
    expected_versions = {"final-v5": json.loads((reference_dir / "payload.json").read_text()),
                         "baseline-v4": json.loads((baseline_reference_dir / "payload.json").read_text())}
    expected = expected_versions["final-v5"]
''')
replace('    def verify(payload):\n','    def verify(payload, label="final-v5"):\n')
replace('        if payload != expected:\n','        if payload != expected_versions[label]:\n')
start=source.index('        # Observe calls once OUTSIDE warmups/timing; timed runs have no trace wrappers.')
end=source.index('    if array_hashes != ',start)
old=source[start:end]
replace(old,'''        # No trace/call-count wrappers in this paired control; use the separate ABBA evidence.
        patches.callback(args.select_version, "final-v5")
        observed_asr = {}
        samples = {label: {"wall": [], "cpu": [], "lookups": []} for label in ("baseline-v4", "final-v5")}
        paired_runs = []
        for _ in range(args.warmups):
            for label in ("baseline-v4", "final-v5"):
                args.select_version(label)
                verify(align(), label)
        for index in range(args.iterations):
            order = ("baseline-v4", "final-v5") if index % 2 == 0 else ("final-v5", "baseline-v4")
            pair = {"pair": index, "order": list(order), "versions": {}}
            for label in order:
                args.select_version(label)  # All module changes occur before the timer.
                hits = recognition.hits
                cpu_start, start = time.process_time_ns(), time.perf_counter_ns()
                payload = align()
                elapsed_wall, elapsed_cpu = time.perf_counter_ns() - start, time.process_time_ns() - cpu_start
                verify(payload, label)  # Output comparison and cache checks occur after the timer.
                wall_ms, cpu_ms = elapsed_wall / 1e6, elapsed_cpu / 1e6
                samples[label]["wall"].append(wall_ms)
                samples[label]["cpu"].append(cpu_ms)
                samples[label]["lookups"].append(recognition.hits - hits)
                pair["versions"][label] = {"wallMs": wall_ms, "cpuMs": cpu_ms}
            paired_runs.append(pair)
        wall, cpu, lookup_counts = (samples["final-v5"][key] for key in ("wall", "cpu", "lookups"))
''')
replace('            "observedCallsOutsideTimer": dict(calls), "observedCtcWindowsOutsideTimer": windows,\n','''            "pairedVersions": {label: {"wallRunsMs": sample["wall"], "cpuRunsMs": sample["cpu"],
                                         "medianWallMs": statistics.median(sample["wall"]), "medianCpuMs": statistics.median(sample["cpu"]),
                                         "asrLookupCounts": sample["lookups"]} for label, sample in samples.items()},
            "pairedRuns": paired_runs, "pairedMedianWallDeltaMs": statistics.median([
                pair["versions"]["final-v5"]["wallMs"] - pair["versions"]["baseline-v4"]["wallMs"] for pair in paired_runs]),
            "baselineReferencePayloadSha256": sha(baseline_reference_dir / "payload.json"),
            "observedCallsOutsideTimer": dict(calls), "observedCtcWindowsOutsideTimer": windows,
''')
replace('    parser.add_argument("--reference-dir", type=Path, required=True)\n','''    parser.add_argument("--reference-dir", type=Path, required=True)
    parser.add_argument("--baseline-python", type=Path, required=True)
    parser.add_argument("--baseline-reference-dir", type=Path, required=True)
''')
replace('    parser.add_argument("--iterations", type=int, default=9)\n','    parser.add_argument("--iterations", type=int, default=18)\n')
replace('    sources = backend_hashes(args.repo_python)\n','''    sources = backend_hashes(args.repo_python)
    args.select_version, selector_proof, args.baseline_hashes = version_selector(args.baseline_python, args.repo_python)
''')
replace('              "cases": []}\n','''              "pairedControl": {"selectorProof": selector_proof,
                                "method": "One imported final module graph; only verified changed AST function definitions toggle outside each timer. Three warmup pairs; 18 measured AB/BA alternating pairs. Same cache, waveforms, imports, process, exact frozen output per version. Raw ABBA remains a separate result; no samples removed.",
                                "baselineRepositoryPython": str(args.baseline_python), "baselineSourceHashes": args.baseline_hashes},
              "cases": []}
''')
replace('        report["completed"] = True\n','''        if backend_hashes(args.baseline_python) != args.baseline_hashes:
            raise AssertionError("Baseline source changed during paired benchmark")
        report["completed"] = True
''')
replace('"""Time production speech.align on frozen evidence, without tracing, I/O or models.','"""Paired same-process control of production speech.align on frozen evidence.')
target=root/'benchmark_paired_alignment.py'
compile(source,str(target),'exec')
target.write_text(source)
(root/'benchmark-paired-origin.json').write_text(json.dumps({'origin':str(original),'originSha256':hashlib.sha256(original.read_bytes()).hexdigest(),'derived':str(target),'derivedSha256':hashlib.sha256(target.read_bytes()).hexdigest(),'scope':'Only harness timing mode changed; strict evidence, model prohibition, waveform integrity and exact output guards retained. No production edits.','replacements':replacements},indent=2)+'\n')
print(target)
