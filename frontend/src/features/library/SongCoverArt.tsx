import { Music2 } from "lucide-react";
import "./song-cover-art.css";

const barCount = 16;
const baseSpeedMs = 720;

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

/** Cover of a song without artwork: a glowing note over a small animated equalizer, phase-shifted per card. */
export const SongCoverArt = ({ cardIndex }: { cardIndex: number }) => (
  <div className="songCoverArt" aria-hidden>
    <Music2 className="songCoverNote" />
    <div className="songCoverBars">
      {bars.map(({ key, level, speed }, index) => (
        <span
          key={key}
          className="songCoverBar"
          style={{
            ["--bar-level" as string]: level,
            animation: `song-cover-wave ${speed + ((cardIndex * 29) % 240)}ms ease-in-out ${(cardIndex + index) * -85}ms infinite alternate`
          }}
        />
      ))}
    </div>
  </div>
);
