from __future__ import annotations

import ast
import io
import tokenize
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = PROJECT_ROOT / "backend"
TEST_ROOT = PROJECT_ROOT / "tests"
MAX_FILE_LINES = 500
MAX_FUNCTION_LINES = 40
MAX_CONSTRUCTOR_DEPENDENCIES = 9
WARNING_FILE_LINES = 300
WARN_FUNCTION_LINES = 30
MAX_BRANCH_NODES = 12
_ALLOWED_ANY = {"backend/serialization.py"}
_ALLOWED_SUBPROCESS = {"backend/infrastructure/process_runner.py"}
_ALLOWED_BROAD_EXCEPTIONS = {
    "backend/infrastructure/job_executor.py",
    "backend/processing/job_manager.py",
}
_BANNED_CLASS_NAMES = {
    "BackendService",
    "ApplicationManager",
    "SystemManager",
    "EverythingRepository",
    "CoreService",
    "GlobalService",
    "AppManager",
}
_BANNED_MARKERS = ("TODO", "FIXME", "XXX")
_REQUIRED_DOMAIN_DIRS = {
    "ai",
    "analysis",
    "api",
    "bootstrap",
    "capabilities",
    "diagnostics",
    "editor",
    "history",
    "infrastructure",
    "lyrics",
    "models",
    "packages",
    "processing",
    "projects",
    "recordings",
    "recovery",
    "room",
    "settings",
    "songs",
    "storage",
}
_FORBIDDEN_FILE_TOKENS = {"legacy", "old", "v2", "v3", "final"}
_REQUIRED_TEST_FILES = {
    "contracts/repository_contract.py",
    "contracts/test_ai_provider_contract.py",
    "contracts/test_sql_repository_contracts.py",
    "test_disk_preflight.py",
    "test_fault_injection.py",
    "test_package_migration.py",
    "test_platform_language.py",
}


def main() -> int:
    errors = check_project()
    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        return 1
    for warning in _warnings():
        print(f"WARNING: {warning}")
    print("Architecture checks passed")
    return 0


def check_project() -> list[str]:
    errors: list[str] = []
    modules = _modules()
    graph: dict[str, set[str]] = {name: set() for name in modules}
    for module_name, path in modules.items():
        relative = path.relative_to(PROJECT_ROOT).as_posix()
        text = path.read_text(encoding="utf-8")
        errors.extend(_text_checks(relative, text))
        tree = ast.parse(text, filename=str(path))
        errors.extend(_ast_checks(relative, tree))
        graph[module_name].update(_internal_imports(tree, modules))
    errors.extend(_cycle_checks(graph))
    errors.extend(_dead_module_checks(graph))
    errors.extend(_duplicate_contract_checks(modules))
    errors.extend(_layout_checks())
    errors.extend(_test_checks())
    return errors


def check_warnings() -> list[str]:
    warnings: list[str] = []
    for path in BACKEND_ROOT.rglob("*.py"):
        relative = path.relative_to(PROJECT_ROOT).as_posix()
        text = path.read_text(encoding="utf-8")
        lines = text.splitlines()
        if len(lines) > WARNING_FILE_LINES:
            warnings.append(f"{relative}: {len(lines)} lines requires responsibility review")
        tree = ast.parse(text, filename=str(path))
        warnings.extend(_size_and_dependency_warnings(relative, tree))
    return warnings


def _modules() -> dict[str, Path]:
    result: dict[str, Path] = {}
    for path in BACKEND_ROOT.rglob("*.py"):
        relative = path.relative_to(PROJECT_ROOT).with_suffix("")
        parts = relative.parts
        if parts[-1] == "__init__":
            parts = parts[:-1]
        result[".".join(parts)] = path
    return result


def _text_checks(relative: str, text: str) -> list[str]:
    errors: list[str] = []
    lines = text.splitlines()
    if len(lines) > MAX_FILE_LINES:
        errors.append(f"{relative}: {len(lines)} lines exceeds {MAX_FILE_LINES}")
    for line_number, line in enumerate(lines, start=1):
        if any(marker in line for marker in _BANNED_MARKERS):
            errors.append(f"{relative}:{line_number}: unresolved marker")
        if "# type: ignore" in line:
            errors.append(f"{relative}:{line_number}: type ignore requires explicit review")
    try:
        tokens = tokenize.generate_tokens(io.StringIO(text).readline)
        for token in tokens:
            if token.type == tokenize.OP and token.string == ";":
                errors.append(
                    f"{relative}:{token.start[0]}: semicolon-separated statements are forbidden"
                )
    except tokenize.TokenError as exc:
        errors.append(f"{relative}: tokenization failed: {exc}")
    return errors


def _ast_checks(relative: str, tree: ast.Module) -> list[str]:
    errors: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            size = (node.end_lineno or node.lineno) - node.lineno + 1
            if size > MAX_FUNCTION_LINES:
                errors.append(
                    f"{relative}:{node.lineno}: {node.name} has {size} lines; limit is {MAX_FUNCTION_LINES}"
                )
            branches = sum(
                isinstance(
                    item, (ast.If, ast.For, ast.While, ast.Try, ast.Match, ast.BoolOp, ast.IfExp)
                )
                for item in ast.walk(node)
            )
            if branches > MAX_BRANCH_NODES:
                errors.append(
                    f"{relative}:{node.lineno}: {node.name} complexity proxy {branches} exceeds {MAX_BRANCH_NODES}"
                )
            errors.extend(_annotation_checks(relative, node))
            if any(isinstance(item, (ast.Import, ast.ImportFrom)) for item in node.body):
                errors.append(f"{relative}:{node.lineno}: local imports are forbidden")
        elif isinstance(node, ast.ClassDef):
            if node.name in _BANNED_CLASS_NAMES:
                errors.append(f"{relative}:{node.lineno}: banned god-service name {node.name}")
            if node.name.endswith("Service"):
                errors.append(
                    f"{relative}:{node.lineno}: generic Service class is forbidden: {node.name}"
                )
            errors.extend(_dependency_count_checks(relative, node))
        elif isinstance(node, ast.ExceptHandler):
            if _is_broad_exception(node) and relative not in _ALLOWED_BROAD_EXCEPTIONS:
                errors.append(f"{relative}:{node.lineno}: broad exception handler is forbidden")
        elif isinstance(node, ast.Name) and node.id == "Any" and relative not in _ALLOWED_ANY:
            errors.append(f"{relative}:{node.lineno}: Any is outside the serialization boundary")
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            if node.func.id in {"eval", "exec", "__import__"}:
                errors.append(f"{relative}:{node.lineno}: dynamic execution/import is forbidden")

    imports = _import_names(tree)
    if "subprocess" in imports and relative not in _ALLOWED_SUBPROCESS:
        errors.append(f"{relative}: subprocess must go through process_runner.py")
    if (
        "threading" in imports
        and "Thread(" in _source_text(relative)
        and relative != "backend/infrastructure/job_executor.py"
    ):
        errors.append(f"{relative}: thread creation must go through job_executor.py")
    if "json" in imports and relative != "backend/serialization.py":
        errors.append(f"{relative}: JSON library access must go through serialization.py")
    if any(name.startswith("sqlalchemy") for name in imports) and not relative.startswith(
        "backend/infrastructure/"
    ):
        errors.append(f"{relative}: SQLAlchemy is restricted to infrastructure")
    if any(name.startswith("fastapi") for name in imports) and not relative.startswith(
        "backend/api/"
    ):
        errors.append(f"{relative}: FastAPI is restricted to the API layer")
    if relative.endswith("/domain.py"):
        forbidden = {
            name
            for name in imports
            if name.startswith(("fastapi", "sqlalchemy", "backend.api", "backend.infrastructure"))
        }
        if forbidden:
            errors.append(f"{relative}: domain imports forbidden dependencies: {sorted(forbidden)}")
    errors.extend(_mutable_global_checks(relative, tree))
    return errors


def _dependency_count_checks(relative: str, node: ast.ClassDef) -> list[str]:
    errors: list[str] = []
    for item in node.body:
        if not isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)) or item.name != "__init__":
            continue
        arguments = [*item.args.posonlyargs, *item.args.args, *item.args.kwonlyargs]
        count = sum(argument.arg not in {"self", "cls"} for argument in arguments)
        if count > MAX_CONSTRUCTOR_DEPENDENCIES:
            errors.append(
                f"{relative}:{item.lineno}: constructor has {count} dependencies; "
                f"limit is {MAX_CONSTRUCTOR_DEPENDENCIES}"
            )
    return errors


def _is_broad_exception(node: ast.ExceptHandler) -> bool:
    if node.type is None:
        return True
    if isinstance(node.type, ast.Name):
        return node.type.id in {"Exception", "BaseException"}
    return False


def _annotation_checks(
    relative: str,
    node: ast.FunctionDef | ast.AsyncFunctionDef,
) -> list[str]:
    errors: list[str] = []
    if node.returns is None:
        errors.append(f"{relative}:{node.lineno}: {node.name} lacks a return annotation")
    arguments = [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs]
    for argument in arguments:
        if argument.arg in {"self", "cls"}:
            continue
        if argument.annotation is None:
            errors.append(
                f"{relative}:{node.lineno}: {node.name}.{argument.arg} lacks a type annotation"
            )
    return errors


def _mutable_global_checks(relative: str, tree: ast.Module) -> list[str]:
    errors: list[str] = []
    for node in tree.body:
        if not isinstance(node, (ast.Assign, ast.AnnAssign)):
            continue
        value = node.value
        if isinstance(value, (ast.List, ast.Dict, ast.Set)):
            errors.append(f"{relative}:{node.lineno}: mutable module-level state is forbidden")
    return errors


def _import_names(tree: ast.Module) -> set[str]:
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            names.add(node.module)
    return names


def _internal_imports(tree: ast.Module, modules: dict[str, Path]) -> set[str]:
    result: set[str] = set()
    for name in _import_names(tree):
        if name in modules:
            result.add(name)
    return result


def _cycle_checks(graph: dict[str, set[str]]) -> list[str]:
    errors: list[str] = []
    visited: set[str] = set()
    active: set[str] = set()
    stack: list[str] = []

    def visit(module: str) -> None:
        visited.add(module)
        active.add(module)
        stack.append(module)
        for dependency in graph[module]:
            if dependency not in visited:
                visit(dependency)
            elif dependency in active:
                index = stack.index(dependency)
                cycle = " -> ".join([*stack[index:], dependency])
                errors.append(f"import cycle: {cycle}")
        stack.pop()
        active.remove(module)

    for module in graph:
        if module not in visited:
            visit(module)
    return errors


def _source_text(relative: str) -> str:
    return (PROJECT_ROOT / relative).read_text(encoding="utf-8")


def _dead_module_checks(graph: dict[str, set[str]]) -> list[str]:
    inbound = {module: 0 for module in graph}
    for dependencies in graph.values():
        for dependency in dependencies:
            inbound[dependency] += 1
    entrypoints = {
        "backend",
        "backend.main",
        "backend.ai_worker",
        "backend.ai_worker.__main__",
    }  # the AI worker is a separate process
    return [
        f"{module}: production module has no production importer"
        for module, count in sorted(inbound.items())
        if count == 0 and module not in entrypoints
    ]


def _duplicate_contract_checks(modules: dict[str, Path]) -> list[str]:
    protocols: dict[str, list[str]] = {}
    schemas: dict[str, list[str]] = {}
    for path in modules.values():
        relative = path.relative_to(PROJECT_ROOT).as_posix()
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in tree.body:
            if not isinstance(node, ast.ClassDef):
                continue
            bases = {_base_name(base) for base in node.bases}
            if "Protocol" in bases:
                protocols.setdefault(node.name, []).append(relative)
            if relative.startswith("backend/api/") and bases & {"ApiModel", "BaseModel"}:
                schemas.setdefault(node.name, []).append(relative)
    errors: list[str] = []
    for kind, definitions in (("protocol", protocols), ("API schema", schemas)):
        for name, paths in sorted(definitions.items()):
            if len(paths) > 1:
                errors.append(f"duplicate {kind} definition {name}: {paths}")
    return errors


def _base_name(node: ast.expr) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return ""


def _size_and_dependency_warnings(relative: str, tree: ast.Module) -> list[str]:
    warnings: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            size = (node.end_lineno or node.lineno) - node.lineno + 1
            if size > WARN_FUNCTION_LINES:
                warnings.append(
                    f"{relative}:{node.lineno}: {node.name} has {size} lines; review responsibility"
                )
            if node.name == "__init__":
                arguments = [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs]
                count = sum(argument.arg not in {"self", "cls"} for argument in arguments)
                if count > MAX_CONSTRUCTOR_DEPENDENCIES:
                    warnings.append(
                        f"{relative}:{node.lineno}: constructor has {count} dependencies"
                    )
    return warnings


def _layout_checks() -> list[str]:
    errors: list[str] = []
    present = {
        path.name for path in BACKEND_ROOT.iterdir() if path.is_dir() and path.name != "__pycache__"
    }
    missing = sorted(_REQUIRED_DOMAIN_DIRS - present)
    if missing:
        errors.append(f"missing required domain directories: {missing}")
    for path in BACKEND_ROOT.rglob("*.py"):
        stem_parts = {part.lower() for part in path.stem.replace("-", "_").split("_")}
        forbidden = sorted(stem_parts & _FORBIDDEN_FILE_TOKENS)
        if forbidden:
            relative = path.relative_to(PROJECT_ROOT).as_posix()
            errors.append(
                f"{relative}: replacement/legacy filename token is forbidden: {forbidden}"
            )
    return errors


def _test_checks() -> list[str]:
    errors: list[str] = []
    for path in TEST_ROOT.rglob("*.py"):
        relative = path.relative_to(PROJECT_ROOT).as_posix()
        text = path.read_text(encoding="utf-8")
        if "time.sleep(" in text or "asyncio.sleep(" in text:
            errors.append(f"{relative}: sleep-based test synchronization is forbidden")
    present = {path.relative_to(TEST_ROOT).as_posix() for path in TEST_ROOT.rglob("*.py")}
    missing = sorted(_REQUIRED_TEST_FILES - present)
    if missing:
        errors.append(f"required contract/fault tests are missing: {missing}")
    ci = PROJECT_ROOT / ".github" / "workflows" / "ci.yml"
    if not ci.exists():
        errors.append(".github/workflows/ci.yml is required")
    elif "--require-dev-tools" not in ci.read_text(encoding="utf-8"):
        errors.append("CI must require Ruff and mypy through --require-dev-tools")
    return errors


def _warnings() -> list[str]:
    warnings: list[str] = []
    for path in BACKEND_ROOT.rglob("*.py"):
        count = len(path.read_text(encoding="utf-8").splitlines())
        if WARNING_FILE_LINES < count <= MAX_FILE_LINES:
            relative = path.relative_to(PROJECT_ROOT).as_posix()
            warnings.append(f"{relative}: {count} lines; review responsibility")
    return warnings


if __name__ == "__main__":
    raise SystemExit(main())
