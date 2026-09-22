from __future__ import annotations

# Two moments this close together are indistinguishable once rounded to a displayed millisecond; the
# alignment model is not bit-for-bit reproducible between process runs (CUDA algorithm selection varies),
# so a "same instant" tie is not always exactly equal in floating point, only this close.
TIE_EPSILON_SECONDS = 0.004


def is_tied_with(candidate: float | None, first: float) -> bool:
    return candidate is not None and abs(candidate - first) < TIE_EPSILON_SECONDS


def spread_tied_moments(moments: list[float | None], end: float) -> list[float | None]:
    """Several moments landing on (near enough) the same instant -- a fast consonant cluster the
    alignment model resolved to one frame, or several letters independently clamped to the same new
    boundary -- would otherwise all flash by together. Spreading a tied run evenly across the gap to the
    next distinct moment (or ``end``) keeps them visibly distinct instead. Entries that are ``None``
    (no moment at all, e.g. a silent character) are left untouched.
    """
    result: list[float | None] = list(moments)
    index = 0
    while index < len(result):
        first = result[index]
        if first is None:
            index += 1
            continue
        run_end = index + 1
        while run_end < len(result) and is_tied_with(result[run_end], first):
            run_end += 1
        run_length = run_end - index
        if run_length > 1:
            later = next((moment for moment in result[run_end:] if moment is not None), end)
            if later > first:
                span = later - first
                for offset in range(run_length):
                    result[index + offset] = first + span * offset / run_length
        index = run_end
    return result
