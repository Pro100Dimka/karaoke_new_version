from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True)
class PendingPcm:
    """One singer's samples of one musical position, collected until the position closes."""

    samples: list[int]
    present: list[bool]
    ingress_lateness_frames: int

    @classmethod
    def empty(cls, frames: int, ingress_lateness_frames: int) -> PendingPcm:
        return cls([0] * frames, [False] * frames, ingress_lateness_frames)

    def write(self, offset: int, values: tuple[int, ...]) -> None:
        self.samples[offset : offset + len(values)] = values
        self.present[offset : offset + len(values)] = [True] * len(values)

    def complete(self) -> bool:
        missing = [index for index, present in enumerate(self.present) if not present]
        if not missing:
            return True
        if len(missing) != 1:
            return False
        # Scaling a continuous 44.1 kHz capture timeline to 48 kHz can leave one frame between
        # adjacent 120-frame packets (the inverse rounding produces an overlap elsewhere). This
        # is not packet loss: interpolate that single sample so one harmless rounding point does
        # not discard an entire 2.5 ms musical position.
        index = missing[0]
        left = self.samples[index - 1] if index > 0 and self.present[index - 1] else None
        right = (
            self.samples[index + 1]
            if index + 1 < len(self.samples) and self.present[index + 1]
            else None
        )
        if left is not None and right is not None:
            value = (left + right) // 2
        elif left is not None:
            value = left
        elif right is not None:
            value = right
        else:
            return False
        self.samples[index] = value
        self.present[index] = True
        return True

    def coverage(self) -> dict[str, object]:
        missing = [index for index, present in enumerate(self.present) if not present]
        ranges: list[list[int]] = []
        for index in missing:
            if not ranges or index != ranges[-1][1] + 1:
                ranges.append([index, index])
            else:
                ranges[-1][1] = index
        return {
            "expected_frames": len(self.present),
            "present_frames": len(self.present) - len(missing),
            "missing_frames": len(missing),
            "missing_ranges": ranges,
        }
