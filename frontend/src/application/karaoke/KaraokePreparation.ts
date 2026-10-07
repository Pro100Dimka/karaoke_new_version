import type { EditorRepository } from "../editor/EditorPorts";
import type { EditorDocument } from "../editor/editorModel";
import type { AudioCapabilities, MixerChannelGains } from "../../contracts/models";
import type { KaraokeAudioPort, KaraokeBackendPort } from "./KaraokePorts";
import { resolveKaraokeLoad, type ResolvedKaraoke } from "./karaokeLoader";

const noMicrophone: AudioCapabilities = {
  microphone: "missing",
  keyboardLighting: false,
};
const mixerChannels = ["music", "mic", "reference", "melody", "master"] as const;

interface Preparation {
  songId: string;
  gains: MixerChannelGains;
  backend: KaraokeBackendPort;
  repository: Pick<EditorRepository, "load">;
  audio: Pick<KaraokeAudioPort,
    "capabilities" | "prepareSong" | "setPlaybackRate" | "setPitchShift" | "setMixer">;
  isCurrent(): boolean;
  onResolved(value: ResolvedKaraoke): void;
  onDocument(value: EditorDocument | null): void;
  onCapabilities(value: AudioCapabilities): void;
  onPrepared(): void;
  onFailure(error: unknown): void;
}

/** Loads a project and prepares native playback only while its owning route is current. */
export const prepareKaraokeSession = async (options: Preparation): Promise<void> => {
  const { songId, backend, repository, audio, gains, isCurrent } = options;
  const resolved = await resolveKaraokeLoad(songId, backend);
  if (!isCurrent()) return;
  options.onResolved(resolved);
  if (resolved.load.kind !== "ready" || !resolved.prefs) return;
  const document = await repository.load(resolved.load.song.id).catch(() => null);
  if (!isCurrent()) return;
  options.onDocument(document);
  try {
    const capabilities = await audio.capabilities().catch(() => noMicrophone);
    if (!isCurrent()) return;
    options.onCapabilities(capabilities);
    await audio.prepareSong(resolved.load.song);
    if (!isCurrent()) return;
    await audio.setPlaybackRate(1);
    if (!isCurrent()) return;
    await audio.setPitchShift(0);
    for (const channel of mixerChannels) {
      if (!isCurrent()) return;
      await audio.setMixer(channel, gains[channel]);
    }
    if (isCurrent()) options.onPrepared();
  } catch (error) {
    if (isCurrent()) options.onFailure(error);
  }
};
