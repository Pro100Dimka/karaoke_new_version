"""Bundle the current GPU worker and its backend imports into the release notebook."""
from __future__ import annotations

import ast
import base64
import hashlib
import json
import re
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _backend_imports(source: bytes) -> set[str]:
    modules: set[str] = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            modules.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                raise ValueError("Use absolute imports in the bundled Kaggle worker")
            if node.module:
                modules.add(node.module)
                modules.update(f"{node.module}.{alias.name}" for alias in node.names)
    return {name for name in modules if name == "backend" or name.startswith("backend.")}


def _worker_assets() -> dict[str, str]:
    pending = [ROOT / "kaggle" / "ad_voice_server.py"]
    sources: dict[str, bytes] = {}
    while pending:
        path = pending.pop()
        relative = path.relative_to(ROOT).as_posix()
        if relative in sources:
            continue
        sources[relative] = path.read_bytes()
        for module in _backend_imports(sources[relative]):
            parts = module.split(".")
            candidates = [ROOT / "python" / Path(*parts).with_suffix(".py")]
            candidates.extend(
                ROOT / "python" / Path(*parts[:length]) / "__init__.py"
                for length in range(1, len(parts) + 1)
            )
            pending.extend(candidate for candidate in candidates if candidate.is_file())
    return {
        relative: base64.b64encode(zlib.compress(source, 9)).decode("ascii")
        for relative, source in sorted(sources.items())
    }


def build_notebook(target: Path) -> str:
    notebook = json.loads((ROOT / "kaggle" / "ad_voice_p100.ipynb").read_text("utf-8"))
    setup = "".join(notebook["cells"][1]["source"])
    setup, count = re.subn(
        r"assets = \{.*?\}\n(?=for relative)",
        lambda _match: f"assets = {json.dumps(_worker_assets(), sort_keys=True)}\n",
        setup,
        flags=re.DOTALL,
    )
    if count != 1:
        raise ValueError("Kaggle notebook must contain exactly one embedded asset map")
    revision_line = 'os.environ["AD_VOICE_KAGGLE_REVISION"] = '
    setup = re.sub(r"^" + re.escape(revision_line) + r".*\n", "", setup, flags=re.MULTILINE)
    notebook["cells"][1]["source"] = setup.splitlines(keepends=True)
    code = ["".join(cell["source"]) for cell in notebook["cells"] if cell["cell_type"] == "code"]
    revision = hashlib.sha256(json.dumps(code, ensure_ascii=False).encode("utf-8")).hexdigest()
    notebook["cells"][1]["source"].append(f'{revision_line}"{revision}"\n')
    notebook["metadata"]["ad_voice_revision"] = revision
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(notebook, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return revision


if __name__ == "__main__":
    print(f"Kaggle worker revision: {build_notebook(Path(sys.argv[1]))}")
