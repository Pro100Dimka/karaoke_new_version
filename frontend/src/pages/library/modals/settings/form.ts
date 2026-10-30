import { socialClient } from "../../../../services/socialClient";
import { tr, useForm, type FormApi } from "@neo-ui-kit/react";
import { store } from "../../../../providers/store";
import { initialSettings } from "../../../../utils/consts";
import type { SettingsFormValues } from "../../../../utils/contracts";
import type { SettingsTab } from "../../../../contracts/models";
import { parsePreferences, type Preferences } from "../../../../shared/preferences/preferences";
import { toggleRadio, setRadioStation, setRadioVolume } from "../../../../providers/radio";

import { useNotify } from "../../../../providers/notifications";
import { usePersonPhoto } from "../../../../features/social/usePersonPhoto";
import { avatarFromFile } from "../../../../features/social/avatarImage";
import { useKeyboardLighting } from "./appearance/keyboardlighting/useKeyboardLighting";
import { useAudioSettings } from "./audio/useAudioSettings";
import { useInputMonitoring } from "./audio/useInputMonitoring";
import { useEffect, useState } from "react";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { pythonClient } from "../../../../services/pythonClient";
import { desktopClient } from "../../../../services/desktopClient";

const preferences = {
  "profile.displayName": "displayName",
  "interface.theme": "theme", "interface.language": "language",
  "interface.headingFont": "headingFont", "interface.textFont": "textFont",
  "interface.reducedMotion": "reducedMotion", "application.autoUpdate": "autoUpdate",
  "integrations.discordPresence": "discordPresence",
} as const satisfies Record<string, keyof Preferences>;

export default function useSettingsForm(tab: SettingsTab): FormApi<SettingsFormValues> {
  const localForm = useForm({ initialValues: initialSettings });
  const radio = store.radio;
  const audio = useAudioSettings(tab === "audio");
  const monitoring = useInputMonitoring(tab === "audio" && audio.audio.audioAvailable &&
    audio.audio.capabilities.microphone === "ready");
  useEffect(() => {
    if (tab !== "audio") monitoring.setTestingInput(false);
  }, [tab]);
  const lighting = useKeyboardLighting(tab === "appearance");
  const inbox = store.inbox;
  const notify = useNotify();
  const client = useQueryClient();
  const savingBackend = useIsMutating({ mutationKey: ["processing-settings"] }) > 0;
  const processing = useQuery({ queryKey: ["processing-settings"],
    queryFn: async ({ signal }) => {
      const settings = await pythonClient.getAiProcessingSettings();
      signal.throwIfAborted();
      return settings;
    }, enabled: tab === "ai" && !savingBackend, staleTime: Infinity, refetchOnMount: "always" });
  const storageRoot = useQuery({ queryKey: ["storage-root"],
    queryFn: async ({ signal }) => {
      const root = await desktopClient.getStorageRoot();
      signal.throwIfAborted();
      return root;
    }, enabled: tab === "ai", staleTime: Infinity, refetchOnMount: "always" });
  const saveBackend = useMutation({
    mutationKey: ["processing-settings"],
    onMutate: () => client.cancelQueries({ queryKey: ["processing-settings"] }),
    mutationFn: (processingBackend: "Local" | "Kaggle") => pythonClient.updateAiProcessingSettings({ processingBackend }),
    onSuccess: (settings) => client.setQueryData(["processing-settings"], settings),
    onError: async (error) => {
      notify(error.message, "error");
      await client.invalidateQueries({ queryKey: ["processing-settings"] });
    },
  });
  const me = inbox.type === "inbox" ? inbox.me : undefined;
  const photo = usePersonPhoto(me?.accountId, me?.avatarVersion ?? 0);
  const [changingPhoto, setChangingPhoto] = useState(false);
  const values: SettingsFormValues = {
    ...localForm.values, profile: { ...store.profile, photo: photo ?? store.profile.photo, canChangePhoto: !!me && !changingPhoto },
    interface: store.interface, application: store.application,
    integrations: store.integrations,
    audio: { ...store.audio, configuration: { ...audio.audio.values, bufferFrames: audio.audio.values.backend === "WASAPI Shared"
        ? audio.audio.values.periodFrames : audio.audio.values.bufferFrames },
      voice: { ...store.audio.voice, monitoring: monitoring.testingInput } },
    audioStatus: { ...audio.audio, inputLevel: monitoring.inputLevel,
      canToggle: monitoring.canToggle, ready: audio.ready },
    radio,
    keyboardLighting: { show: lighting.capabilities?.available ?? false },
    ai: { ...localForm.values.ai, backend: processing.data?.processingBackend ?? "Local",
      transferToLibraryPath: storageRoot.data ?? "", savingBackend: savingBackend || !processing.data,
      error: processing.error?.message ?? storageRoot.error?.message ?? "" },
  };
  const changePhoto = async (file: File) => {
    if (!me || changingPhoto) return;
    setChangingPhoto(true);
    try {
      const photo = await avatarFromFile(file);
      await socialClient.setAvatar(photo.mime, photo.data);
      store.updatePreferences({ profilePhoto: `data:${photo.mime};base64,${photo.data}` });
    } catch (error) {
      notify(error instanceof Error ? error.message : tr("photoUnreadable"), "error");
    } finally {
      setChangingPhoto(false);
    }
  };
  const setValue = (path: string, value: unknown) => {
    const backend = (["ASIO", "WASAPI Shared", "WASAPI Exclusive"] as const).find((item) => item === value);
    if (Object.hasOwn(preferences, path)) {
      const key = preferences[path as keyof typeof preferences];
      if (key === "displayName" && typeof value === "string") value = value.slice(0, 48);
      const parsed = parsePreferences({ ...store.preferences, [key]: value });
      store.updatePreferences({ [key]: parsed[key] });
    } else if (path === "profile.photo") {
      if (Array.isArray(value) && value[0] instanceof File) void changePhoto(value[0]);
    } else if (path.startsWith("integrations.keyboardLighting.")) {
      const key = path.slice("integrations.keyboardLighting.".length);
      const parsed = parsePreferences({ ...store.preferences,
        keyboardLighting: { ...store.preferences.keyboardLighting, [key]: value } });
      lighting.update(parsed.keyboardLighting);
    } else if (path === "radio.volume" && typeof value === "number" && radio.canControl) {
      setRadioVolume(value);
    } else if (path === "radio.stationId" && typeof value === "string" && radio.canControl) {
      setRadioStation(value);
    } else if (path === "radio.enabled" && typeof value === "boolean" && radio.canControl) {
      if (value !== radio.enabled) toggleRadio();
    } else if (path === "ai.retry") {
      void client.invalidateQueries({ queryKey: ["processing-settings"] });
      void client.invalidateQueries({ queryKey: ["storage-root"] });
    } else if (path === "ai.backend") {
      const backend = (["Local", "Kaggle"] as const).find((item) => item === value);
      if (backend && !client.isMutating({ mutationKey: ["processing-settings"] })) saveBackend.mutate(backend);
    } else if (path === "ai.transferToLibraryPath" && typeof value === "string") {
      void client.cancelQueries({ queryKey: ["storage-root"] });
      client.setQueryData(["storage-root"], value);
    } else if (path === "audio.playTestSound") {
      void audio.audio.onPlayTestSound();
    } else if (path === "audio.configureDevices") {
      audio.audio.onOpenAsioControlPanel();
    } else if (path === "audio.voice.monitoring" && typeof value === "boolean") {
      monitoring.setTestingInput(value);
    } else if (path === "audio.configuration.backend" && backend) {
      audio.audio.onAudioCommit("backend", backend);
    } else if (path === "audio.configuration.lowLatencyInput" && typeof value === "boolean") {
      audio.audio.onAudioCommit("lowLatencyInput", value);
    } else if (path === "audio.releaseAsioInBackground" && typeof value === "boolean") {
      audio.audio.onReleaseAsioInBackgroundChange(value);
    } else if (path === "audio.voice.gain" && typeof value === "number") {
      const parsed = parsePreferences({ ...store.preferences, voiceGain: value });
      store.updatePreferences({ voiceGain: parsed.voiceGain });
    } else if (path === "audio.voice.effects.noiseSuppression" && typeof value === "number") {
      const parsed = parsePreferences({ ...store.preferences, noiseSuppression: value });
      store.updatePreferences({ noiseSuppression: parsed.noiseSuppression });
    } else {
      const numberKey = (["sampleRate", "bufferFrames", "periodFrames", "inputPeriodFrames"] as const)
        .find((key) => path === `audio.configuration.${key}`);
      const deviceKey = (["inputDeviceId", "outputDeviceId"] as const)
        .find((key) => path === `audio.configuration.${key}`);
      if (numberKey && typeof value === "number") audio.audio.onAudioCommit(numberKey === "bufferFrames" && audio.audio.values.backend === "WASAPI Shared"
        ? "periodFrames" : numberKey, value);
      else if (deviceKey && typeof value === "string") audio.audio.onAudioCommit(deviceKey, value);
      else localForm.setValue(path, value);
    }
  };
  return {
    ...localForm, values, setValue,
    reset: () => localForm.reset(),
    field(path) {
      let value: unknown = values;
      for (const key of path.split("."))
        value = value && typeof value === "object" ? Reflect.get(value, key) : undefined;
      return { ...localForm.field(path), value, onValueChange: (value) => setValue(path, value) };
    },
  };
}
