import { useCallback, useEffect, useRef, useState } from "react";
import qftRuntime from "./qftRuntime.js?worker&url";
import "./quantum-field.css";
import { publishSpectrum } from "./spectrumEvents";
import { useSpectrumFeed, type SpectrumFrame } from "./useSpectrumFeed";

// Palette of the animation particles; the theme kit exposes the same names as CSS variables.
const palette = {
  primary: "#ff153f",
  primaryHover: "#ff5a69",
  secondary: "#a20b1d",
  accent: "#ff693f",
  highlight: "#ffe0d6"
} as const;

const source = `
<style>
  html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}
</style>
<script type="module" src="${new URL(qftRuntime, document.baseURI).href}"></script>
`;

const cssName = (key: string): string => `--color-${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`;

/**
 * The application-wide backdrop: the theme picture with the Quantum Fields particle animation, rendered by a
 * sandboxed runtime in an iframe so its WebGL loop never competes with React. Mounted once for every screen.
 */
export const QuantumFieldBackdrop = () => {
  const frame = useRef<HTMLIFrameElement>(null);
  const [visible, setVisible] = useState(() => !document.hidden);

  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  const sendSpectrum = useCallback(
    (spectrum: SpectrumFrame) => {
      publishSpectrum(spectrum);
      frame.current?.contentWindow?.postMessage({ type: "QFT_AUDIO", ...spectrum }, "*");
    },
    []
  );
  useSpectrumFeed(visible, sendSpectrum);

  useEffect(() => {
    const iframe = frame.current;
    if (!visible || !iframe) return;
    const root = document.documentElement;
    const abort = new AbortController();
    const { signal } = abort;
    const post = (type: string, data: object = {}) => iframe.contentWindow?.postMessage({ type, ...data }, "*");

    const sendTheme = () => {
      const css = getComputedStyle(root);
      const read = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
      const theme = root.dataset.theme ?? "dark";
      post("QFT_THEME", {
        theme,
        // The picture is drawn by the container, so the runtime only renders transparent particles.
        backgroundImage: "none",
        backgroundColor: "transparent",
        palette: Object.fromEntries(Object.entries(palette).map(([key, fallback]) => [key, read(cssName(key), fallback)]))
      });
    };

    window.addEventListener(
      "message",
      ({ source: origin, data }: MessageEvent<{ type?: string }>) => {
        if (origin === iframe.contentWindow && data?.type === "QFT_READY") sendTheme();
      },
      { signal }
    );

    const observer = new MutationObserver(sendTheme);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });

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
        movePointer((clientX / Math.max(1, innerWidth)) * 2 - 1, (clientY / Math.max(1, innerHeight)) * 2 - 1),
      { passive: true, signal }
    );
    window.addEventListener("blur", () => movePointer(0, 0), { signal });

    sendTheme();
    return () => {
      post("QFT_DISPOSE");
      abort.abort();
      observer.disconnect();
      cancelAnimationFrame(pointerFrame);
    };
  }, [visible]);

  if (!visible) return null;
  return (
    <div className="qft-original-backdrop" aria-hidden>
      <iframe ref={frame} className="qft-original-frame" title="Quantum Fields visualizer" tabIndex={-1} srcDoc={source} />
    </div>
  );
};
