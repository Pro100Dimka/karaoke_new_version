import { useCallback, useEffect, useRef, useState } from "react";

const idleHideMs = 2200;
const checkIntervalMs = 250;

/**
 * Idle tracking for the karaoke screen. While the song plays, the floating header buttons fade after a short idle period
 * (pointer, key or fullscreen activity brings them back), and with auto-hide on the console fades with them.
 * `toggleHidden` hides or shows the console on demand when auto-hide is off.
 */
export const useAutoHideConsole = (autoHide: boolean, playing: boolean) => {
  const [active, setActive] = useState(true);
  const [forcedHidden, setForcedHidden] = useState(false);
  const lastActivity = useRef(Date.now());
  const pointer = useRef<readonly [number, number]>([Number.NaN, Number.NaN]);

  const reveal = useCallback(() => {
    lastActivity.current = Date.now();
    setActive(true);
  }, []);

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const [x, y] = pointer.current;
      if (x === event.clientX && y === event.clientY) return;
      pointer.current = [event.clientX, event.clientY];
      reveal();
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerdown", reveal);
    window.addEventListener("keydown", reveal);
    document.addEventListener("fullscreenchange", reveal);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerdown", reveal);
      window.removeEventListener("keydown", reveal);
      document.removeEventListener("fullscreenchange", reveal);
    };
  }, [reveal]);

  useEffect(() => {
    if (!playing) {
      setActive(true);
      return;
    }
    lastActivity.current = Date.now();
    const timer = window.setInterval(() => setActive(Date.now() - lastActivity.current < idleHideMs), checkIntervalMs);
    return () => window.clearInterval(timer);
  }, [playing]);

  const toggleHidden = useCallback(() => setForcedHidden(current => !current), []);
  const consoleVisible = !forcedHidden && (!autoHide || active);
  return { headerVisible: active, consoleVisible, toggleHidden };
};
