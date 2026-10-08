import { useCallback, useEffect, useRef, useState } from "react";
import { useTick } from "@ad-voice/ui";
import qftRuntime from "./qftRuntime.js?worker&url";
import "./quantum-field.css";
import { publishSpectrum } from "./spectrumEvents";
import { useSpectrumFeed, type SpectrumFrame } from "./useSpectrumFeed";
import { useApp } from "../AppContext";
import type { ThemeName } from "../../contracts/models";
import { appThemes, backdropColors } from "../appTheme";
import { useBackdropCovered } from "./backdropCoverage";
import { useAppOnScreen } from "../useAppOnScreen";

const source = `
<style>
  html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}
</style>
<script type="module" src="${new URL(qftRuntime, document.baseURI).href}"></script>
`;

/**
 * The application-wide backdrop: the theme picture with the Quantum Fields particle animation, rendered by a
 * separate iframe runtime. Opaque scene backgrounds release the hidden WebGL renderer;
 * the spectrum feed stays alive for the visible lyrics and other music-reactive UI.
 */
export const QuantumFieldBackdrop = () => {
  const { preferences } = useApp("preferences");
  const reducedMotion = preferences.reducedMotion;
  const covered = useBackdropCovered();
  const frame = useRef<HTMLIFrameElement>(null);
  const visible = useAppOnScreen();
  const [audioActive, setAudioActive] = useState(false);

  const sendSpectrum = useCallback((spectrum: SpectrumFrame) => {
    publishSpectrum(spectrum);
    setAudioActive(spectrum.active);
    frame.current?.contentWindow?.postMessage(
      { type: "QFT_AUDIO", ...spectrum },
      "*",
    );
  }, []);
  useSpectrumFeed(visible && !reducedMotion, sendSpectrum);
  // The backdrop draws on the interface's motion clock, so both change in the same frame.
  useTick(
    () => frame.current?.contentWindow?.postMessage({ type: "QFT_TICK" }, "*"),
    visible && !reducedMotion && !covered && audioActive,
  );

  useEffect(() => {
    const iframe = frame.current;
    if (!visible || reducedMotion || covered || !iframe) return;
    const root = document.documentElement;
    const abort = new AbortController();
    const { signal } = abort;
    const post = (type: string, data: object = {}) =>
      iframe.contentWindow?.postMessage({ type, ...data }, "*");

    const sendTheme = () => {
      const theme = (root.dataset.theme ?? "dark") as ThemeName;
      post("QFT_THEME", {
        theme,
        // The picture is drawn by the container, so the runtime only renders transparent particles.
        backgroundImage: "none",
        backgroundColor: "transparent",
        palette: backdropColors(theme in appThemes ? theme : "dark"),
      });
    };

    window.addEventListener(
      "message",
      ({ source: origin, data }: MessageEvent<{ type?: string }>) => {
        if (origin === iframe.contentWindow && data?.type === "QFT_READY")
          sendTheme();
      },
      { signal },
    );

    // The runtime may finish starting before this effect listens for its ready signal; its load is a second chance.
    iframe.addEventListener("load", sendTheme, { signal });

    const observer = new MutationObserver(sendTheme);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    let pointerFrame = 0;
    const pointer = { x: 0, y: 0 };
    const movePointer = (x: number, y: number) => {
      pointer.x = x;
      pointer.y = y;
      pointerFrame ||= requestAnimationFrame(() => {
        pointerFrame = 0;
        post("QFT_POINTER", pointer);
      });
    };
    window.addEventListener(
      "pointermove",
      ({ clientX, clientY }) =>
        movePointer(
          (clientX / Math.max(1, innerWidth)) * 2 - 1,
          (clientY / Math.max(1, innerHeight)) * 2 - 1,
        ),
      { passive: true, signal },
    );
    window.addEventListener("blur", () => movePointer(0, 0), { signal });

    sendTheme();
    return () => {
      post("QFT_DISPOSE");
      abort.abort();
      observer.disconnect();
      cancelAnimationFrame(pointerFrame);
    };
  }, [visible, reducedMotion, covered]);

  if (!visible) return null;
  return (
    <div className="qft-original-backdrop" aria-hidden>
      {!reducedMotion && !covered && (
        <iframe
          ref={frame}
          className="qft-original-frame"
          title="Quantum Fields visualizer"
          tabIndex={-1}
          aria-hidden="true"
          srcDoc={source}
        />
      )}
    </div>
  );
};
