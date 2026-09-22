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
    video.playbackRate = rate;
    if (Math.abs(video.currentTime - positionSeconds) > driftToleranceSeconds) video.currentTime = positionSeconds;
    if (playing && video.paused) void video.play().catch(() => setFailedUrl(source));
    if (!playing && !video.paused) video.pause();
  }, [positionSeconds, playing, rate, source]);

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
