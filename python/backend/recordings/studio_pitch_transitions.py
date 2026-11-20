"""Bounded, immutable pYIN transition reuse for its isolated Librosa namespace."""

from collections.abc import Callable
from functools import lru_cache
from inspect import signature
import threading
from types import FunctionType

import numpy as np

Transition = Callable[..., np.ndarray]
_MAX_STATES = 1024
_BUILD_LOCK = threading.Lock()


def _supported(reference: Transition, name: str, arguments: tuple[str, ...]) -> bool:
    return (
        isinstance(reference, FunctionType)
        and reference.__module__ == "librosa.sequence"
        and reference.__name__ == name
        and reference.__code__.co_name == name
        and tuple(signature(reference).parameters) == arguments
    )


@lru_cache(maxsize=4)
def _local(reference: Transition, states: int, width: int) -> np.ndarray:
    result = reference(states, width, window="triangle", wrap=False)
    result.flags.writeable = False
    return result


@lru_cache(maxsize=4)
def _loop(reference: Transition, states: int, probability: float) -> np.ndarray:
    result = reference(states, probability)
    result.flags.writeable = False
    return result


def transition_local(
    n_states: int,
    width: int,
    *,
    window: object = "triangle",
    wrap: bool = False,
    reference: Transition,
) -> np.ndarray:
    supported = _supported(reference, "transition_local", ("n_states", "width", "window", "wrap"))
    bounded = type(n_states) is int and 0 < n_states <= _MAX_STATES and type(width) is int
    if supported and bounded and isinstance(window, str) and window == "triangle" and wrap is False:
        # The lock surrounds lookup as well: concurrent cold chunks build once.
        with _BUILD_LOCK:
            return _local(reference, n_states, width)
    return reference(n_states, width, window=window, wrap=wrap)


def transition_loop(n_states: int, prob: float, *, reference: Transition) -> np.ndarray:
    supported = _supported(reference, "transition_loop", ("n_states", "prob"))
    bounded = type(n_states) is int and 0 < n_states <= _MAX_STATES and type(prob) is float
    if supported and bounded:
        with _BUILD_LOCK:
            return _loop(reference, n_states, prob)
    return reference(n_states, prob)
