def _review_stop(
    words: Sequence[ctc.AlignedWord],
    heard: Mapping[int, tuple[float, float]],
    reviewed: frozenset[int],
    first: int,
    last: int,
    target: int,
    margin: float,
    total: float,
    voiced: np.ndarray | None,
    onsets: Sequence[float],
    last_target: int,
) -> int:
    stops = [
        stop
        for stop in range(target + 1, min(last, first + _REVIEW_MAX_WORDS) + 1)
        if stop == first + 1
        or (candidate := _review_window(words, heard, first, stop, margin, total)).end
        - candidate.start
        <= _REVIEW_MAX_SECONDS
    ]
    stop = max(stops)
    if stop < last and last_target >= stop:
        return max(
            (boundary for boundary in stops if boundary >= min(target + 2, stop)),
            key=lambda boundary: (
                _review_boundary(words, heard, reviewed, boundary, voiced, onsets)[0],
                boundary,
            ),
        )
    return stop


def _review_windows(
    words: Sequence[ctc.AlignedWord],
    heard: Mapping[int, tuple[float, float]],
    reviewed: frozenset[int],
    margin: float,
    total: float,
    *,
    voiced: np.ndarray | None = None,
    onsets: Sequence[float] = (),
) -> list[ctc.Window]:
    """Plan disjoint local repairs; an indivisible sustained word may exceed the time cap."""
    ranges: list[tuple[int, int]] = []
    targets = sorted(index for index in reviewed if 0 <= index < len(words))
    for index in targets:
        first, last = max(0, index - 1), min(len(words), index + 2)
        if ranges and first < ranges[-1][1]:
            ranges[-1] = ranges[-1][0], max(ranges[-1][1], last)
        else:
            ranges.append((first, last))
    result: list[ctc.Window] = []
    cursor = 0
    for first, last in ranges:
        last_target = targets[bisect_left(targets, last) - 1]
        while cursor < len(targets) and targets[cursor] < last:
            target = targets[cursor]
            first = max(first, target - 1)
            context = _review_window(words, heard, first, target + 1, margin, total)
            if first < target and context.end - context.start > _REVIEW_MAX_SECONDS:
                first = target
            stop = _review_stop(
                words, heard, reviewed, first, last, target, margin, total, voiced, onsets, last_target
            )
            result.append(_review_window(words, heard, first, stop, margin, total))
            first = stop
            cursor = bisect_left(targets, stop, cursor + 1)
    result = _separate_review_audio(result, words, heard, reviewed, voiced, onsets)
    return _coalesce_review_windows(result, frozenset(first for first, _ in ranges))
