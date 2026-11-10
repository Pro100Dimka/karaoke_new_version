from pathlib import Path
import ast


def test_unmask_runs_for_both_vocal_sources():
    source = Path(__file__).resolve().parents[1] / "backend/recordings/studio_render.py"
    module = ast.parse(source.read_text(encoding="utf-8"))
    cls = next(n for n in module.body if isinstance(n, ast.ClassDef) and n.name == "MasterRender")
    method = next(n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name == "_unmask")
    assert not any(isinstance(n, ast.If) and isinstance(n.test, ast.Attribute) and n.test.attr == "process_voice" for n in ast.walk(method))
    assert any(isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "_unmask_backing" for n in ast.walk(method))
