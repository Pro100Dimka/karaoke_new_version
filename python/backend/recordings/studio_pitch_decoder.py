"""Isolate the supported Librosa decoder without replacing any library globals."""

from collections.abc import Callable
from functools import lru_cache, partial
from inspect import signature
from types import CodeType, FunctionType, ModuleType
from typing import cast

import numpy as np

from backend.recordings.studio_pitch_kernels import decode, predecessors
from backend.recordings.studio_pitch_transitions import (
    Transition,
    transition_local,
    transition_loop,
)

Kernel = Callable[[np.ndarray, np.ndarray, np.ndarray, float], tuple[np.ndarray, np.ndarray]]
_MAX_STATES = 2048
_MAX_PREDECESSORS = 256
_DECODER_ARGUMENTS = ("prob", "transition", "p_init", "return_logp", "transition_min_prob")
_CORE_ARGUMENTS = ("log_prob", "log_trans", "log_p_init", "log_trans_threshold")


def _uses_core(code: CodeType) -> bool:
    return "_viterbi" in code.co_names or any(
        _uses_core(item) for item in code.co_consts if isinstance(item, CodeType)
    )


def _supported(decoder: object, core: object) -> bool:
    source = getattr(core, "py_func", None)
    code = getattr(core, "__code__", None)
    return (
        isinstance(decoder, FunctionType)
        and isinstance(source, FunctionType)
        and isinstance(code, CodeType)
        and callable(core)
        and decoder.__module__ == "librosa.sequence"
        and source.__module__ == "librosa.sequence"
        and source.__name__ == "_viterbi"
        and source.__code__.co_name == code.co_name == "_viterbi"
        and _uses_core(decoder.__code__)
        and tuple(signature(decoder).parameters) == _DECODER_ARGUMENTS
        and tuple(signature(source).parameters) == _CORE_ARGUMENTS
    )


def _copy(function: FunctionType, namespace: dict[str, object]) -> FunctionType:
    result = FunctionType(
        function.__code__, namespace, function.__name__, function.__defaults__, function.__closure__
    )
    result.__kwdefaults__ = function.__kwdefaults__
    return result


@lru_cache(maxsize=4)
def _isolated(
    function: FunctionType,
    sequence: ModuleType,
    decoder: FunctionType,
    core: Kernel,
    local: Transition,
    loop: Transition,
) -> FunctionType:
    decoder_globals = dict(decoder.__globals__)
    decoder_globals["_viterbi"] = partial(compact_viterbi, reference=core)
    private = ModuleType(sequence.__name__)
    private.__dict__.update(vars(sequence))
    setattr(private, "viterbi", _copy(decoder, decoder_globals))
    setattr(private, "transition_local", partial(transition_local, reference=local))
    setattr(private, "transition_loop", partial(transition_loop, reference=loop))
    namespace = dict(function.__globals__)
    namespace["sequence"] = private
    return _copy(function, namespace)


def isolate_decoder(function: FunctionType) -> FunctionType:
    sequence = function.__globals__.get("sequence")
    if not isinstance(sequence, ModuleType):
        return function
    decoder = getattr(sequence, "viterbi", None)
    local, loop = (
        getattr(sequence, "transition_local", None),
        getattr(sequence, "transition_loop", None),
    )
    core = decoder.__globals__.get("_viterbi") if isinstance(decoder, FunctionType) else None
    if (
        not _supported(decoder, core)
        or not isinstance(local, FunctionType)
        or not isinstance(loop, FunctionType)
    ):
        return function
    return _isolated(
        function, sequence, cast(FunctionType, decoder), cast(Kernel, core), local, loop
    )


def compact_viterbi(
    probability: np.ndarray,
    transition: np.ndarray,
    initial: np.ndarray,
    threshold: float,
    *,
    reference: Kernel,
) -> tuple[np.ndarray, np.ndarray]:
    if not np.isfinite(threshold) or not 0 < probability.shape[1] <= _MAX_STATES:
        return reference(probability, transition, initial, threshold)
    counts = np.count_nonzero(transition >= threshold, axis=0)
    width = int(np.max(counts))
    if np.any(counts == 0) or width > _MAX_PREDECESSORS:
        return reference(probability, transition, initial, threshold)
    indices, weights, counts = predecessors(transition, threshold, width)
    return decode(probability, indices, weights, counts, initial)
