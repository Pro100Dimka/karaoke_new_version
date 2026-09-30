import { useEffect, useRef } from "react";
import hostEmblem from "./host-emblem.svg?raw";

const INNER_LAP_MS = 5600;
const OUTER_LAP_MS = 8400;

export const HostSeal = ({ photo }: { photo?: string }) => {
  const sealRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const seal = sealRef.current;
    const image = seal?.querySelector<SVGImageElement>(".host-emblem__photo");
    const crown = seal?.querySelector<SVGGraphicsElement>(".host-emblem__crown");
    image?.setAttribute("href", photo ?? "");
    crown?.classList.toggle("host-emblem__crown--hidden", Boolean(photo));
  }, [photo]);

  useEffect(() => {
    const emblem = sealRef.current?.querySelector<SVGSVGElement>(".host-emblem");
    if (!emblem || typeof emblem.animate !== "function") return;

    const animations: Animation[] = [];
    const addAnimation = (
      element: Element | null,
      keyframes: Keyframe[],
      options: KeyframeAnimationOptions,
      id: string,
    ) => {
      if (!element) return;
      const animation = element.animate(keyframes, { iterations: Infinity, easing: "linear", ...options });
      animation.id = id;
      animation.pause();
      animation.currentTime = 0;
      animations.push(animation);
    };

    for (const layer of emblem.querySelectorAll<SVGGraphicsElement>("[data-host-rotor]")) {
      const name = layer.dataset.hostRotor ?? "outer";
      const inner = name.startsWith("inner-");
      addAnimation(
        layer,
        [{ transform: "rotate(0deg)" }, { transform: `rotate(${inner ? 360 : -360}deg)` }],
        { duration: inner ? INNER_LAP_MS : OUTER_LAP_MS },
        `host-${name}`,
      );
    }
    addAnimation(
      emblem.querySelector(".host-motion__gold-glow"),
      [{ opacity: 0.55 }, { opacity: 0.95 }, { opacity: 0.55 }],
      { duration: 4200, easing: "ease-in-out" },
      "host-crown-light",
    );

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const syncMotion = () => {
      const shouldPlay = !reducedMotion.matches && !document.hidden;
      for (const animation of animations) {
        if (shouldPlay) animation.play();
        else {
          animation.pause();
          if (reducedMotion.matches) animation.currentTime = 0;
        }
      }
    };

    document.addEventListener("visibilitychange", syncMotion);
    reducedMotion.addEventListener("change", syncMotion);
    syncMotion();
    return () => {
      document.removeEventListener("visibilitychange", syncMotion);
      reducedMotion.removeEventListener("change", syncMotion);
      for (const animation of animations) animation.cancel();
    };
  }, []);

  return (
    <div
      ref={sealRef}
      className={`seal seal--host${photo ? " seal--host-photo" : ""}`}
      aria-hidden
      dangerouslySetInnerHTML={{ __html: hostEmblem }}
    />
  );
};
