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

export const youtubeVideoId = (value: string): string | null => {
  try {
    const url = new URL(value);
    const candidate = url.hostname === "youtu.be"
      ? url.pathname.slice(1).split("/")[0]
      : url.searchParams.get("v") ?? url.pathname.match(/^\/(?:embed|shorts)\/([^/]+)/)?.[1];
    return candidate && /^[A-Za-z0-9_-]{11}$/.test(candidate) ? candidate : null;
  } catch {
    return null;
  }
};

const youtubeEmbedUrl = (id: string): string =>
  `https://www.youtube-nocookie.com/embed/${id}?enablejsapi=1&autoplay=1&mute=1&controls=0&playsinline=1&loop=1&playlist=${id}`;

const youtubeCommand = (frame: HTMLIFrameElement, func: string, args: unknown[] = []) => {
  frame.contentWindow?.postMessage(JSON.stringify({ event: "command", func, args }), "*");
};

/**
 * Visual companion only: the video is always muted and follows the AudioService position.
 * Priority: song video, then the theme background; a failing video never affects audio.
 */
export const SceneBackdrop = ({ theme, videoUrl, positionSeconds, playing, rate }: SceneBackdropProps) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const youtubeRef = useRef<HTMLIFrameElement>(null);
  const youtubeSync = useRef<{ id: string; position: number; at: number; playing: boolean; rate: number } | null>(null);
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
  const source = [videoUrl, sceneUrl].find(url => url !== "" && url !== failedUrl) ?? "";
  const youtubeId = youtubeVideoId(source);
  const useVideo = source !== "";

  useEffect(() => {
    const video = youtubeId ? null : videoRef.current;
    if (!video) return;
    video.playbackRate = rate;
    if (Math.abs(video.currentTime - positionSeconds) > driftToleranceSeconds) video.currentTime = positionSeconds;
    if (playing && video.paused) void video.play().catch(() => setFailedUrl(source));
    if (!playing && !video.paused) video.pause();
  }, [positionSeconds, playing, rate, source, youtubeId]);

  useEffect(() => {
    const frame = youtubeRef.current;
    if (!frame || !youtubeId) return;
    const now = performance.now() / 1000;
    const previous = youtubeSync.current;
    const changedVideo = previous?.id !== youtubeId;
    const expected = previous
      ? previous.position + (previous.playing ? (now - previous.at) * previous.rate : 0)
      : positionSeconds;
    if (changedVideo || Math.abs(positionSeconds - expected) > driftToleranceSeconds) {
      youtubeCommand(frame, "seekTo", [positionSeconds, true]);
    }
    if (changedVideo || previous?.rate !== rate) youtubeCommand(frame, "setPlaybackRate", [rate]);
    if (changedVideo || previous?.playing !== playing) {
      youtubeCommand(frame, playing ? "playVideo" : "pauseVideo");
    }
    youtubeSync.current = { id: youtubeId, position: positionSeconds, at: now, playing, rate };
  }, [playing, positionSeconds, rate, youtubeId]);

  return (
    <div className="sceneBackdrop" aria-hidden style={{ backgroundImage: `url(${sceneBackgrounds[theme]})` }}>
      {youtubeId ? (
        <iframe
          ref={youtubeRef}
          className="sceneVideo"
          src={youtubeEmbedUrl(youtubeId)}
          title="YouTube karaoke background"
          allow="autoplay; encrypted-media"
          referrerPolicy="strict-origin-when-cross-origin"
          onLoad={() => {
            const frame = youtubeRef.current;
            if (!frame) return;
            youtubeCommand(frame, "setPlaybackRate", [rate]);
            youtubeCommand(frame, "seekTo", [positionSeconds, true]);
            youtubeCommand(frame, playing ? "playVideo" : "pauseVideo");
          }}
        />
      ) : useVideo ? (
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
