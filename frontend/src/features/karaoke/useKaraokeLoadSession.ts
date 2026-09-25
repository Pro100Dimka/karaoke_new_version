import { useEffect, useRef, useState } from "react";
import { useServices } from "../../app/ServicesContext";
import type { AudioCapabilities, MixerChannelGains } from "../../contracts/models";
import { audioClient } from "../../services/audioClient";
import { pythonClient } from "../../services/pythonClient";
import { editorApi } from "../editor/editorApi";
import type { EditorDocument } from "../editor/editorModel";
import type { SongPreferences } from "../library/songPreferences";
import { resolveKaraokeLoad, type KaraokeLoad } from "./karaokeLoader";
import type { KaraokeOpenMode } from "./useKaraokeSession";

const noMicrophone: AudioCapabilities = { microphone: "missing", keyboardLighting: false };
const mixerChannels = ["music", "mic", "reference", "melody"] as const;

export const useKaraokeLoadSession = (
  songId: string,
  reloadKey: KaraokeOpenMode,
  gains: MixerChannelGains,
  onPrepared: () => void,
  onFailure: (error: unknown) => void,
  onRestart: () => void = () => undefined,
) => {
  const { pythonEpoch } = useServices();
  const preparedSession = useRef("");
  const [load, setLoad] = useState<KaraokeLoad>({ kind: "loading" });
  const [document, setDocument] = useState<EditorDocument | null>(null);
  const [songPrefs, setSongPrefs] = useState<SongPreferences | null>(null);
  const [capabilities, setCapabilities] = useState<AudioCapabilities>(noMicrophone);

  useEffect(() => {
    let active = true;
    const key = JSON.stringify([songId, reloadKey]);
    if (preparedSession.current === key) {
      void pythonClient.getSong(songId).then(song => {
        if (active) setLoad(current => current.kind === "ready" && current.song.id === songId
          ? { ...current, song: { ...current.song, artworkUrl: song.artworkUrl, videoUrl: song.videoUrl } } : current);
      }).catch(() => undefined);
      return () => { active = false; };
    }
    preparedSession.current = "";
    setLoad({ kind: "loading" });
    setDocument(null);
    setSongPrefs(null);
    onRestart();
    void (async () => {
      const resolved = await resolveKaraokeLoad(songId);
      if (!active) return;
      setLoad(resolved.load);
      if (resolved.load.kind !== "ready" || !resolved.prefs) return;
      const song = resolved.load.song;
      setSongPrefs(resolved.prefs);
      const loadedDocument = await editorApi.load(song.id).catch(() => null);
      if (!active) return;
      setDocument(loadedDocument);
      try {
        const actualCapabilities = await audioClient.capabilities().catch(() => noMicrophone);
        if (!active) return;
        setCapabilities(actualCapabilities);
        await audioClient.prepareSong(song);
        if (!active) return;
        await audioClient.setPlaybackRate(1);
        if (!active) return;
        await audioClient.setPitchShift(0);
        for (const channel of mixerChannels) {
          if (!active) return;
          await audioClient.setMixer(channel, gains[channel]);
        }
        if (active) {
          preparedSession.current = key;
          onPrepared();
        }
      } catch (error) {
        if (active) onFailure(error);
      }
    })();
    return () => { active = false; };
  }, [songId, reloadKey, pythonEpoch]); // callbacks and opening gains intentionally belong to this one session

  return { load, document, songPrefs, capabilities };
};
