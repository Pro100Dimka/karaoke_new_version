import { useEffect, useId, useMemo, useRef } from "react";

type AudioArtworkKind = "header" | "latency" | "levels" | "monitor";

const waveConfig: Record<AudioArtworkKind, {
  width: number;
  height: number;
  paths: number;
  phase: number;
}> = {
  header: { width: 1000, height: 97, paths: 23, phase: .9 },
  latency: { width: 440, height: 105, paths: 23, phase: .2 },
  levels: { width: 420, height: 105, paths: 21, phase: 1.7 },
  monitor: { width: 325, height: 105, paths: 22, phase: 2.8 },
};

const random = (initialSeed: number) => {
  let seed = initialSeed;
  return () => {
    seed = (Math.imul(seed ^ (seed >>> 15), 1 | seed) + 0x6d2b79f5) | 0;
    return (seed >>> 0) / 4294967296;
  };
};

const AudioWave = ({ kind }: { kind: AudioArtworkKind }) => {
  const ref = useRef<SVGSVGElement | null>(null);
  const config = waveConfig[kind];
  const gradientId = `audio-wave-${useId().replaceAll(":", "")}`;
  const stars = useMemo(() => {
    const next = random(7913 + Math.floor(config.phase * 713));
    return Array.from({ length: Math.min(50, Math.floor(config.width / 8)) }, () => ({
      x: next() * config.width,
      y: next() * config.height,
      radius: .25 + next() * .55,
      opacity: .16 + next() * .42,
    }));
  }, [config]);

  useEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    const paths = [...svg.querySelectorAll<SVGPathElement>(".audioWavePath")];
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let started = performance.now();
    let lastPaint = -Infinity;
    const paint = (now: number) => {
      const time = (now - started) / 1000;
      paths.forEach((path, index) => {
        const progress = index / Math.max(1, paths.length - 1);
        const drift = time * .42 + config.phase;
        const a = Math.sin(drift + progress * 1.4) * config.height * .095;
        const b = Math.cos(drift * .8 + progress * 1.8) * config.height * .08;
        const y = config.height * (.38 + progress * .58);
        path.setAttribute("d", index < paths.length * .68
          ? `M-12 ${y + a} C${config.width * .2} ${config.height * 1.28 - progress * config.height * .27 + a} ${config.width * .32} ${config.height * .34 + progress * config.height * .21 + b} ${config.width * .46} ${config.height * .62 + progress * config.height * .12} S${config.width * .67} ${config.height * 1.14 - progress * config.height * .09 + a} ${config.width * .8} ${config.height * .69 - progress * config.height * .22 + b} S${config.width * .94} ${config.height * .43 - progress * config.height * .44 + a} ${config.width + 8} ${config.height * .21 + progress * config.height * .45}`
          : `M-12 ${config.height * (.9 + progress * .12) + b} C${config.width * .21} ${config.height * .98 + a} ${config.width * .33} ${config.height * .24 + progress * config.height * .2 + a} ${config.width * .52} ${config.height * .75 + progress * config.height * .25 + b} S${config.width * .82} ${config.height * .38 + progress * config.height * .27 + a} ${config.width + 8} ${config.height * (.48 + progress * .5) + b}`);
      });
    };
    const tick = (now: number) => {
      if (now - lastPaint >= 1000 / 30) {
        paint(now);
        lastPaint = now;
      }
      frame = requestAnimationFrame(tick);
    };
    const sync = () => {
      cancelAnimationFrame(frame);
      started = performance.now();
      paint(started);
      if (!reducedMotion?.matches && !document.hidden) frame = requestAnimationFrame(tick);
    };
    reducedMotion?.addEventListener("change", sync);
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => {
      cancelAnimationFrame(frame);
      reducedMotion?.removeEventListener("change", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [config]);

  return (
    <svg ref={ref} className="audioWave" viewBox={`0 0 ${config.width} ${config.height}`} preserveAspectRatio="none">
      <defs><linearGradient id={gradientId}><stop stopColor="#6d112b" stopOpacity="0" /><stop offset=".16" stopColor="#af153d" stopOpacity=".35" /><stop offset=".57" stopColor="#ff3b65" stopOpacity=".74" /><stop offset=".78" stopColor="#ff7b95" stopOpacity=".85" /><stop offset="1" stopColor="#d91b43" stopOpacity=".44" /></linearGradient></defs>
      {Array.from({ length: config.paths }, (_, index) => <path key={index} className="audioWavePath" fill="none" stroke={`url(#${gradientId})`} strokeWidth={index === 5 ? 1 : .55} opacity={index === 5 ? .95 : .52} />)}
      {stars.map((star, index) => <circle key={index} cx={star.x} cy={star.y} r={star.radius} fill="#ff6381" opacity={star.opacity} />)}
    </svg>
  );
};

const AudioMonitoringSpectrum = () => {
  const ref = useRef<SVGSVGElement | null>(null);
  const id = useId().replaceAll(":", "");
  useEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    const masks = [...svg.querySelectorAll<SVGRectElement>(".audioSpectrumMask")];
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    let frame = 0;
    const started = performance.now();
    const paint = (now: number) => {
      const time = (now - started) / 1000;
      masks.forEach((mask, index) => {
        const edge = Math.abs(index - 13) / 13;
        const phase = index * .59;
        const height = 12 + edge * (37 + (.5 + .5 * Math.sin(time * 1.8 + phase)) ** 1.7 * 142);
        mask.setAttribute("y", (232 - height).toFixed(1));
        mask.setAttribute("height", height.toFixed(1));
      });
      if (!reducedMotion?.matches && !document.hidden) frame = requestAnimationFrame(paint);
    };
    paint(performance.now());
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <svg ref={ref} className="audioMonitoringSpectrum" viewBox="0 0 325 232" preserveAspectRatio="none">
      <defs>{Array.from({ length: 27 }, (_, index) => <clipPath key={index} id={`audio-spectrum-clip-${id}-${index}`}><rect className="audioSpectrumMask" x={index * 12 + 3} y="232" width="8" height="0" /></clipPath>)}</defs>
      {Array.from({ length: 27 }, (_, index) => (
        <g key={index} className="audioSpectrumColumn" clipPath={`url(#audio-spectrum-clip-${id}-${index})`}>
          {Array.from({ length: 29 }, (__, row) => <rect key={row} x={index * 12 + 3} y={224 - row * 7} width="8" height="5" rx=".35" fill="#b62140" opacity={.17 + row / 35} />)}
        </g>
      ))}
    </svg>
  );
};

export const AudioArtwork = ({ kind }: { kind: AudioArtworkKind }) => (
  <span className={kind === "header" ? "audioSectionArt" : "audioWellArt"} aria-hidden>
    {kind === "monitor" && <AudioMonitoringSpectrum />}
    <AudioWave kind={kind} />
  </span>
);
