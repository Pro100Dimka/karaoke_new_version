# Verification status

## Passed in the current build environment

- GCC C++20 Release + warnings-as-errors.
- Clang C++20 Release + warnings-as-errors.
- Portable CTest suite including fixed-seed state fuzzing.
- Clang Static Analyzer on portable production sources.
- AddressSanitizer + UndefinedBehaviorSanitizer.
- Hard-RT instrumentation test for allocation/free/blocking/disk/network/IPC violations.
- FakeBackend deterministic drift/jitter/variable-packet/fault/stale-callback/replay tests.
- 10,000 Start/Stop cycles.
- 1,000 reconfiguration cycles.
- 1,000 recording Start/Stop cycles.

## Commands

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DAUDIOSERVICE_WARNINGS_AS_ERRORS=ON
cmake --build build -j
ctest --test-dir build --output-on-failure
./tools/static-analysis.sh
```

Release repetition gates:

```sh
cmake -S . -B build-release -DCMAKE_BUILD_TYPE=Release \
  -DAUDIOSERVICE_BUILD_TESTS=OFF -DAUDIOSERVICE_BUILD_RELEASE_GATES=ON
cmake --build build-release -j
ctest --test-dir build-release -L repetition --output-on-failure
```

## Requires Windows / hardware

Use `build-windows.bat` for the Windows build and `build-windows-analysis.bat` for the MSVC `/analyze`
build. Physical latency, vendor-driver behavior, device loss, hardware matrix, long soak and final user acceptance
must still be performed on actual target machines.
