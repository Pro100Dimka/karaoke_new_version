#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="${1:-$ROOT/build-static-analysis}"
rm -rf "$BUILD"
cmake -S "$ROOT" -B "$BUILD" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CXX_COMPILER=clang++ \
  -DCMAKE_EXPORT_COMPILE_COMMANDS=ON \
  -DAUDIOSERVICE_WARNINGS_AS_ERRORS=ON
cmake --build "$BUILD" -j2
python3 "$ROOT/tools/run-clang-analyzer.py" "$BUILD"
ctest --test-dir "$BUILD" --output-on-failure
if command -v clang-tidy >/dev/null 2>&1; then
  find "$ROOT/src" -name '*.cpp' -print0 | xargs -0 -n1 clang-tidy -p "$BUILD" --warnings-as-errors='*'
fi
