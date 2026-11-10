"""Regression: dry and existing-effects stems use the same peak-only delivery."""
from pathlib import Path
import ast


def test_delivery_has_no_stem_dependent_master_loudness():
    source = Path(__file__).resolve().parents[1] / 'backend/recordings/studio_delivery.py'
    tree = ast.parse(source.read_text(encoding='utf-8'))
    cls = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'MasterDelivery')
    run = next(node for node in cls.body if isinstance(node, ast.FunctionDef) and node.name == 'run')
    assert not any(isinstance(node, ast.If) and isinstance(node.test, ast.Attribute) and node.test.attr == 'process_voice' for node in ast.walk(run))
    assert 'alimiter=limit=' in ast.get_source_segment(source.read_text(encoding='utf-8'), run)
