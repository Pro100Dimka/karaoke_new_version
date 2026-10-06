import { useEffect, useRef, useState } from "react";

interface Sample {
  transfer: string;
  atMilliseconds: number;
  progress: number;
}

/**
 * Minutes left of a project transfer, from how fast its progress has moved since it started
 * (whole minutes, rounded up); undefined until it has moved at all.
 */
export const useTransferEta = (
  transfer: string | undefined,
  progress: number | undefined,
): number | undefined => {
  const first = useRef<Sample | undefined>(undefined);
  const [minutes, setMinutes] = useState<number>();

  useEffect(() => {
    if (!transfer || progress === undefined || progress >= 100) {
      first.current = undefined;
      setMinutes(undefined);
      return;
    }
    const now = Date.now();
    if (first.current?.transfer !== transfer)
      first.current = { transfer, atMilliseconds: now, progress };
    const moved = progress - first.current.progress;
    const elapsed = now - first.current.atMilliseconds;
    setMinutes(
      moved > 0 && elapsed > 0
        ? Math.ceil(((100 - progress) * elapsed) / moved / 60_000)
        : undefined,
    );
  }, [transfer, progress]);

  return minutes;
};
