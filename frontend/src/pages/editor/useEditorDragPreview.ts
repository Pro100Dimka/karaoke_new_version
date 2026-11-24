import type { PianoRollGesture } from '@neo-ui-kit/react';
import { useLayoutEffect, useRef } from 'react';

/** Keep the initial response immediate, then publish only the latest sample per paint. */
export const useEditorDragPreview = (
  onPreview: ((gesture: PianoRollGesture) => void) | undefined,
) => {
  const callback = useRef(onPreview);
  callback.current = onPreview;
  const pending = useRef<PianoRollGesture | null>(null);
  const frame = useRef<number | undefined>(undefined);
  const started = useRef(false);
  const generation = useRef(0);
  const cancel = () => {
    generation.current++;
    if (frame.current !== undefined) window.cancelAnimationFrame(frame.current);
    frame.current = undefined;
    pending.current = null;
    started.current = false;
  };
  useLayoutEffect(() => cancel, []);
  const tick = () => {
    frame.current = undefined;
    const gesture = pending.current;
    pending.current = null;
    if (!gesture) return;
    const current = generation.current;
    callback.current?.(gesture);
    if (generation.current === current)
      frame.current = window.requestAnimationFrame(tick);
  };
  return {
    cancel,
    queue(gesture: PianoRollGesture) {
      started.current = true;
      if (frame.current !== undefined) {
        pending.current = gesture;
        return;
      }
      const current = generation.current;
      callback.current?.(gesture);
      if (generation.current === current)
        frame.current = window.requestAnimationFrame(tick);
    },
    finish(gesture: PianoRollGesture) {
      const changed =
        started.current ||
        gesture.seconds !== 0 ||
        (gesture.kind === 'move' && gesture.pitch !== 0);
      cancel();
      if (changed) callback.current?.(gesture);
    },
  };
};
