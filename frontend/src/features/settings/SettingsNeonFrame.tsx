import { useEffect, useId, useRef } from "react";
import cx from "../../theme/ui/_internal/cx";

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

export const settingsRoundedRectPath = (width: number, height: number, radius: number) => {
  const inset = .65;
  const right = width - inset;
  const bottom = height - inset;
  const fittedRadius = clamp(radius - inset, 0, Math.min((width - 2 * inset) / 2, (height - 2 * inset) / 2));
  return `M${inset + fittedRadius} ${inset}H${right - fittedRadius}A${fittedRadius} ${fittedRadius} 0 0 1 ${right} ${inset + fittedRadius}V${bottom - fittedRadius}A${fittedRadius} ${fittedRadius} 0 0 1 ${right - fittedRadius} ${bottom}H${inset + fittedRadius}A${fittedRadius} ${fittedRadius} 0 0 1 ${inset} ${bottom - fittedRadius}V${inset + fittedRadius}A${fittedRadius} ${fittedRadius} 0 0 1 ${inset + fittedRadius} ${inset}Z`;
};

export const SettingsNeonFrame = ({ className, variant = "card", order = 0 }: {
  className?: string;
  variant?: "shell" | "card";
  order?: number;
}) => {
  const ref = useRef<SVGSVGElement | null>(null);
  const prefix = `settings-neon-${useId().replaceAll(":", "")}`;

  useEffect(() => {
    const frame = ref.current;
    const owner = frame?.parentElement;
    const outline = frame?.querySelector<SVGPathElement>(".settings-neon-outline");
    if (!frame || !owner || !outline || typeof outline.getTotalLength !== "function") return;
    const lights = [0, 1].map(index => ({
      gradient: frame.querySelector<SVGRadialGradientElement>(`#${prefix}-${index}`),
      redGradient: frame.querySelector<SVGRadialGradientElement>(`#${prefix}-${index}-red`),
      blur: frame.querySelector<SVGFilterElement>(`#${prefix}-${index}-blur`),
      phase: (index * .48 + .535 + order * .051) % 1,
      speed: index === 0 ? 125 : 86,
    }));
    const paths = [...frame.querySelectorAll<SVGPathElement>(".settings-neon-light")];
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
    const radius = variant === "shell" ? 102 : 116;
    let length = 0;
    let animationFrame = 0;
    let elapsed = 0;
    let previous: number | null = null;

    const paint = () => {
      if (!length) return;
      lights.forEach(light => {
        const point = outline.getPointAtLength((light.phase * length + elapsed * light.speed) % length);
        for (const gradient of [light.gradient, light.redGradient]) {
          gradient?.setAttribute("cx", point.x.toFixed(2));
          gradient?.setAttribute("cy", point.y.toFixed(2));
        }
        light.blur?.setAttribute("x", (point.x - radius - 14).toFixed(1));
        light.blur?.setAttribute("y", (point.y - radius - 14).toFixed(1));
      });
    };
    const fit = () => {
      const style = getComputedStyle(owner);
      const width = owner.offsetWidth || Number.parseFloat(style.width);
      const height = owner.offsetHeight || Number.parseFloat(style.height);
      if (!width || !height) return;
      const path = settingsRoundedRectPath(width, height, Number.parseFloat(style.borderTopLeftRadius) || 0);
      frame.setAttribute("viewBox", `0 0 ${width} ${height}`);
      outline.setAttribute("d", path);
      paths.forEach(item => item.setAttribute("d", path));
      length = outline.getTotalLength();
      paint();
    };
    const tick = (now: number) => {
      if (previous !== null) elapsed += Math.min(64, now - previous) / 1000;
      previous = now;
      paint();
      animationFrame = requestAnimationFrame(tick);
    };
    const sync = () => {
      cancelAnimationFrame(animationFrame);
      previous = null;
      fit();
      if (!reducedMotion.matches && !document.hidden) animationFrame = requestAnimationFrame(tick);
    };
    const resize = new ResizeObserver(sync);
    resize.observe(owner);
    reducedMotion.addEventListener("change", sync);
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => {
      cancelAnimationFrame(animationFrame);
      resize.disconnect();
      reducedMotion.removeEventListener("change", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [order, prefix, variant]);

  const radius = variant === "shell" ? 102 : 116;
  const id = (index: number, suffix = "") => `${prefix}-${index}${suffix}`;
  return (
    <svg ref={ref} className={cx("settingsNeonFrame", className)} fill="none" aria-hidden="true">
      <defs>
        {[0, 1].map(index => (
          <g key={index}>
            <radialGradient id={id(index)} gradientUnits="userSpaceOnUse" r={radius}>
              <stop offset="0" stopColor="#fff9f0" />
              <stop offset=".04" stopColor="#ffe2dd" />
              <stop offset=".16" stopColor="#ff798e" />
              <stop offset=".4" stopColor="var(--settings-neon-accent, #ff244c)" stopOpacity=".85" />
              <stop offset=".72" stopColor="var(--settings-neon-accent, #ff1745)" stopOpacity=".32" />
              <stop offset="1" stopColor="var(--settings-neon-accent, #ff1745)" stopOpacity="0" />
            </radialGradient>
            <radialGradient id={id(index, "-red")} gradientUnits="userSpaceOnUse" r={radius}>
              <stop offset="0" stopColor="var(--settings-neon-accent, #ff224b)" />
              <stop offset=".4" stopColor="var(--settings-neon-accent, #ff224b)" stopOpacity=".7" />
              <stop offset="1" stopColor="var(--settings-neon-accent, #ff224b)" stopOpacity="0" />
            </radialGradient>
            <filter id={id(index, "-blur")} filterUnits="userSpaceOnUse" width={radius * 2 + 28} height={radius * 2 + 28} colorInterpolationFilters="sRGB">
              <feGaussianBlur stdDeviation="4.2" />
            </filter>
          </g>
        ))}
      </defs>
      <path className="settings-neon-outline" stroke={variant === "shell" ? "color-mix(in srgb, var(--settings-neon-accent, #ff6373) 65%, transparent)" : "color-mix(in srgb, var(--settings-neon-accent, #ff3353) 16%, transparent)"} strokeWidth={variant === "shell" ? 1.1 : .6} />
      {[0, 1].flatMap(index => [
        <path key={`${index}-aura`} className="settings-neon-light settings-neon-light-aura" stroke={`url(#${id(index, "-red")})`} strokeWidth="7.5" filter={`url(#${id(index, "-blur")})`} opacity=".94" />,
        <path key={`${index}-core`} className="settings-neon-light settings-neon-light-core" stroke={`url(#${id(index)})`} strokeWidth={variant === "shell" ? 1.9 : 1.35} />,
      ])}
    </svg>
  );
};
