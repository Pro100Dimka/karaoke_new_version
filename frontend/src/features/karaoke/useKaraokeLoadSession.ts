import { useEffect, useState } from "react";
import type { AudioCapabilities, MixerChannelGains } from "../../contracts/models";
import { audioClient } from "../../services/audioClient";
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
  const [load, setLoad] = useState<KaraokeLoad>({ kind: "loading" });
  const [document, setDocument] = useState<EditorDocument | null>(null);
  const [songPrefs, setSongPrefs] = useState<SongPreferences | null>(null);
  const [capabilities, setCapabilities] = useState<AudioCapabilities>(noMicrophone);

  useEffect(() => {
    let active = true;
    setLoad({ kind: "loading" });
    onRestart();
    void (async () => {
      const resolved = await resolveKaraokeLoad(songId);
      if (!active) return;
      setLoad(resolved.load);
      if (resolved.load.kind !== "ready" || !resolved.prefs) return;
      const song = resolved.load.song;
      setSongPrefs(resolved.prefs);
      setDocument(await editorApi.load(song.id).catch(() => null));
      try {
        setCapabilities(await audioClient.capabilities().catch(() => noMicrophone));
        await audioClient.prepareSong(song);
        await audioClient.setPlaybackRate(1);
        await audioClient.setPitchShift(0);
        for (const channel of mixerChannels) await audioClient.setMixer(channel, gains[channel]);
        if (active) onPrepared();
      } catch (error) {
        if (active) onFailure(error);
      }
    })();
    return () => { active = false; };
  }, [songId, reloadKey]); // callbacks and opening gains intentionally belong to this one session

  return { load, document, songPrefs, capabilities };
};
