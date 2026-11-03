from __future__ import annotations

import gc
import io
import os
import runpy
import sys

import torch
from threadpoolctl import threadpool_limits
from backend.ai_worker.runtime import cpu_threads

from backend.serialization import dumps, loads_object


def serve() -> int:
    """Run the unchanged speech CLI repeatedly, retaining imports but not job results."""
    incoming, outgoing = sys.stdin, sys.stdout
    original_error = sys.stderr
    original_arguments = sys.argv
    try:
        for line in incoming.buffer:
            request = loads_object(line.decode("utf-8"))
            arguments, environment, data = (
                request.get("arguments"),
                request.get("environment"),
                request.get("input"),
            )
            arguments, environment, data = _validate(arguments, environment, data)
            for key, value in environment.items():
                if isinstance(value, str):
                    os.environ[key] = value
            output, errors = io.BytesIO(), io.BytesIO()
            sys.stdin = io.TextIOWrapper(io.BytesIO(data.encode("utf-8")), encoding="utf-8")
            sys.stdout = io.TextIOWrapper(output, encoding="utf-8", write_through=True)
            sys.stderr = io.TextIOWrapper(errors, encoding="utf-8", write_through=True)
            code = _invoke(arguments)
            response = dumps(
                {
                    "code": code,
                    "stdout": output.getvalue().decode("utf-8"),
                    "stderr": errors.getvalue().decode("utf-8"),
                }
            )
            outgoing.buffer.write((response + "\n").encode("utf-8"))
            outgoing.buffer.flush()
            if code:
                return code
    finally:
        sys.stdin, sys.stdout, sys.stderr = incoming, outgoing, original_error
        sys.argv = original_arguments
    return 0


def _validate(
    arguments: object, environment: object, data: object
) -> tuple[list[str], dict[str, str], str]:
    if (
        not isinstance(arguments, list)
        or not arguments
        or not all(isinstance(value, str) for value in arguments)
        or arguments[0] not in ["transcribe", "transcribe-many", "align"]
        or "--stream-input" in arguments
        or not isinstance(environment, dict)
        or not all(isinstance(value, str) for value in environment.values())
        or not isinstance(data, str)
    ):
        raise ValueError("Invalid speech worker request")
    return arguments, environment, data


def _invoke(arguments: list[str]) -> int:
    torch.set_num_threads(cpu_threads())
    sys.argv = ["backend.ai_worker", *arguments]
    code = 0
    try:
        with threadpool_limits(limits=cpu_threads()):
            runpy.run_module("backend.ai_worker", run_name="__main__")
    except SystemExit as error:
        code = int(error.code or 0)
    gc.collect()
    torch.cuda.empty_cache()
    return code
