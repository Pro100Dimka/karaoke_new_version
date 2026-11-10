"""Isolated checks of reference-driven EQ selection."""
import ast
from pathlib import Path
import numpy as np
from scipy.ndimage import median_filter

source = Path(__file__).resolve().parents[1] / 'backend/recordings/studio_dynamics.py'
tree = ast.parse(source.read_text(encoding='utf-8'))
functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in {'_reference_cuts', '_tone_envelope'}]
module = ast.Module(body=functions, type_ignores=[])
ns = {'np': np, 'median_filter': median_filter}
exec(compile(module, str(source), 'exec'), ns)


def test_flat_reference_has_no_cuts():
    centers = np.linspace(100, 8000, 300)
    frames = [np.zeros(300) for _ in range(40)]
    reference = (0.0, centers, np.zeros(300))
    filters = []
    result = ns['_reference_cuts'](centers, frames, reference, filters)
    assert filters == [] and result['referenceEqBands'] == []


def test_reference_detects_broad_excess():
    centers = np.linspace(100, 8000, 300)
    bump = 8 * np.exp(-0.5 * ((np.log2(centers / 2500)) / 0.4) ** 2)
    frames = [bump for _ in range(40)]
    filters = []
    result = ns['_reference_cuts'](centers, frames, (0.0, centers, np.zeros(300)), filters)
    assert result['referenceEqBands'] and filters
    assert all(float(f.split(':g=')[1]) < 0 for f in filters)
    assert any(1700 < x['frequencyHz'] < 3500 for x in result['referenceEqBands'])


def test_no_spectral_range_does_not_crash():
    centers = np.linspace(20, 100, 30)
    frames = [np.zeros(30) for _ in range(40)]
    assert ns['_reference_cuts'](centers, frames, (0, centers, np.zeros(30)), [])['referenceEqStatus'] == 'insufficient-spectrum'
