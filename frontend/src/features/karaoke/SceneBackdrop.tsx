import { useEffect, useRef, useState } from "react";
import type { ThemeName } from "../../contracts/models";
import { desktopClient } from "../../services/desktopClient";
import { sceneBackgrounds } from "./sceneBackgrounds";

interface SceneBackdropProps {
  theme: ThemeName;
  videoUrl: string;
  positionSeconds: number;
  playing: boolean;
  rate: number;
}

const driftToleranceSeconds = 0.35;

const isYoutubeUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.hostname === "youtu.be" || url.hostname.endsWith("youtube.com") || url.hostname.endsWith("youtube-nocookie.com");
  } catch {
    return false;
  }
};

/**
 * Visual companion only: the video is always muted and follows the AudioService position.
 * Priority: song video, then the theme background; a failing video never affects audio.
 */
export const SceneBackdrop = ({ theme, videoUrl, positionSeconds, playing, rate }: SceneBackdropProps) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [failedUrl, setFailedUrl] = useState("");
  const [sceneUrl, setSceneUrl] = useState("");

  useEffect(() => {
    let active = true;
    void desktopClient.sceneVideoUrl().then(url => active && setSceneUrl(url ?? ""));
    return () => {
      active = false;
    };
  }, []);

  // A failing source falls through to the next one without touching audio.
  const source = [videoUrl, sceneUrl].find(url => url !== "" && url !== failedUrl && !isYoutubeUrl(url)) ?? "";
  const useVideo = source !== "";
  // The song's own video is worth following exactly; the generic scene fallback is a short ambient clip
  // (see main.ts's sceneVideoUrl handler) meant to loop, since most songs outlast it.
  const isOwnVideo = source !== "" && source === videoUrl;

  useEffect(() => {
    const video = videoRef.current;
    return () => {
      if (!video) return;
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [source]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const synchronize = () => {
      video.playbackRate = rate;
      const target =
        !isOwnVideo && Number.isFinite(video.duration) && video.duration > 0
          ? positionSeconds % video.duration
          : positionSeconds;
      if (Math.abs(video.currentTime - target) > driftToleranceSeconds) video.currentTime = target;
      // Chromium may reject play() while the whole window is minimized. That is suspension, not a
      // broken clip: keep the source and retry when the document becomes visible again.
      if (playing && video.paused && !document.hidden) void video.play().catch(() => undefined);
      if (!playing && !video.paused) video.pause();
    };
    synchronize();
    const onVisibility = () => {
      if (!document.hidden) synchronize();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [positionSeconds, playing, rate, source, isOwnVideo]);

  return (
    <div className="sceneBackdrop" aria-hidden style={{ backgroundImage: `url(${sceneBackgrounds[theme]})` }}>
      {useVideo ? (
        <video
          ref={videoRef}
          className="sceneVideo"
          src={source}
          muted
          playsInline
          preload="auto"
          onError={() => setFailedUrl(source)}
        />
      ) : null}
    </div>
  );
};
