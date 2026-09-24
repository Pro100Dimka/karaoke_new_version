import { Music2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { useRadio } from "../../app/RadioContext";
import { subscribeSpectrum } from "../../app/backdrop/spectrumEvents";
import "./song-cover-art.css";

const barCount = 16;
const baseSpeedMs = 720;
const minimumLevel = 0.12;
const spectrumGain = 1.6;

interface Bar {
  key: string;
  level: number;
  speed: number;
}

const bars: readonly Bar[] = Array.from({ length: barCount }, (_, index) => ({
  key: `bar-${index}`,
  level: 0.28 + ((index * 37 + 19) % 61) / 100,
  speed: baseSpeedMs + ((index * 113 + 47) % 620)
}));

/**
 * Cover of a song without artwork: a glowing note over a small equalizer. It plays a phase-shifted idle animation per card;
 * while the radio plays, the bars follow the output spectrum instead, like the animated backdrop.
 */
export const SongCoverArt = ({
  cardIndex,
  variant = "cover",
}: {
  cardIndex: number;
  variant?: "cover" | "overlay";
}) => {
  const radio = useRadio();
  const barElements = useRef<(HTMLSpanElement | null)[]>([]);

  useEffect(() => {
    if (!radio.enabled) return;
    return subscribeSpectrum(frame => {
      barElements.current.forEach((element, index) => {
        const band = frame.bands[Math.floor((index / barCount) * frame.bands.length)] ?? 0;
        element?.style.setProperty("--bar-level", String(Math.min(1, Math.max(minimumLevel, band * spectrumGain))));
      });
    });
  }, [radio.enabled]);

  return (
    <div
      className="songCoverArt"
      data-reactive={radio.enabled || undefined}
      data-variant={variant}
      aria-hidden
    >
      {variant === "cover" && <Music2 className="songCoverNote" />}
      <div className="songCoverBars">
        {bars.map(({ key, level, speed }, index) => (
          <span
            key={key}
            ref={element => {
              barElements.current[index] = element;
            }}
            className="songCoverBar"
            style={{
              ["--bar-level" as string]: level,
              ["--wave-duration" as string]: `${speed + ((cardIndex * 29) % 240)}ms`,
              ["--wave-delay" as string]: `${(cardIndex + index) * -85}ms`
            }}
          />
        ))}
      </div>
    </div>
  );
};
