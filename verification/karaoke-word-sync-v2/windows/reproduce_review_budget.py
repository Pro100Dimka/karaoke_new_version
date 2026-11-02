"""Execute the current pure window planner without requiring model dependencies."""

import ast
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace


root = Path("python/backend/ai_worker")
namespace = {"dataclass": dataclass, "Sequence": Sequence, "Mapping": Mapping}
classes = [
    node
    for node in ast.parse((root / "ctc.py").read_text()).body
    if isinstance(node, ast.ClassDef) and node.name in {"AlignedWord", "Window"}
]
exec(compile(ast.Module(body=classes, type_ignores=[]), "ctc.py", "exec"), namespace)
namespace["ctc"] = SimpleNamespace(
    AlignedWord=namespace["AlignedWord"], Window=namespace["Window"]
)
function = next(
    node
    for node in ast.parse((root / "word_guidance.py").read_text()).body
    if isinstance(node, ast.FunctionDef) and node.name == "_review_windows"
)
exec(compile(ast.Module(body=[function], type_ignores=[]), "word_guidance.py", "exec"), namespace)
words = [
    namespace["AlignedWord"]("дом", i * 0.8, i * 0.8 + 0.4, (), 0.9)
    for i in range(100)
]
reviewed = frozenset(range(0, 99, 3))
windows = namespace["_review_windows"](words, {}, reviewed, 0.6, 80)
assert all(window.last - window.first <= 12 for window in windows), windows
assert all(window.end - window.start <= 8 for window in windows), windows
assert sorted(
    index for window in windows for index in reviewed if window.first <= index < window.last
) == sorted(reviewed)
