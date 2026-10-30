import { store } from "../../../../../providers/store";
import { tr, useLocale } from "@neo-ui-kit/react";
import { ru } from "../../../../../i18n/messages.ru";
import { audioOptions, deviceOptions } from "./audioOptions";
import { useEffect, useSyncExternalStore } from "react";
import { useNotify } from "../../../../../providers/notifications";
import type { DeviceDto } from "../../../../../contracts/models";
import { safeAudioConfiguration } from "../../../../../shared/preferences/preferences";
import { audioClient as audio } from "../../../../../services/audioClient";
import { audioSessionFor } from "./audioSession";
import {
  automaticAudioTiming,
  changeAudioValue,
  displayedAudioValues,
  toAudioRequest,
  toAudioValues,
  type AudioCommit,
} from "./audioConfiguration";

/** The view subscribes to the session; negotiated timing remains display-only. */
export const useAudioSettings = (enabled = true) => {
  const { preferences, updatePreferences } = store;
  useLocale();
  const notify = useNotify();
  const session = audioSessionFor(audio);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const effects = {
    onAccepted: (request: typeof preferences.audio) =>
      updatePreferences({ audio: request }),
    onError: (error: unknown) =>
      notify(
        `${tr(ru.settingsApplyFailed)}: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      ),
  };
  useEffect(() => {
    session.setSavedConfiguration(preferences.audio);
  }, [session, preferences.audio]);
  useEffect(() => {
    if (!enabled) return;
    void session.start();
    return session.stop;
  }, [session, enabled]);
  const commit: AudioCommit = (name, value) => {
    const current = session.getSnapshot();
    const request = toAudioRequest(
      changeAudioValue(
        toAudioValues(
          current.requested,
          current.audioAvailable && !current.asioUnavailable ? current.runtime : undefined,
        ),
        name,
        value,
      ),
    );
    if (request.backend === "ASIO") request.userSelectedAsio = true;
    if (
      request.backend === "ASIO" &&
      !current.devices.some((device) => device.backend === "ASIO")
    )
      session.selectUnavailableAsio(request);
    else
      void session.apply(
        safeAudioConfiguration(request, current.devices),
        effects,
      );
  };
  const prepareAsio = (driver: DeviceDto) => {
    const request = safeAudioConfiguration(
      {
        backend: "ASIO",
        inputDeviceId: driver.id,
        outputDeviceId: driver.id,
        userSelectedAsio: true,
        ...automaticAudioTiming,
      },
      [driver],
    );
    void session.prepareAsio(request, driver, effects);
  };
  const values = displayedAudioValues(state.requested, state.runtime, state.audioAvailable && !state.applying);
  return {
    ready: state.ready,
    audio: {
      values,
      options: audioOptions({ values, runtime: state.runtime,
        configurationCapabilities: state.configurationCapabilities,
        capabilitiesBackend: state.configurationCapabilitiesBackend }),
      deviceOptions: (kind: "input" | "output", current: string) => deviceOptions(
        state.devices.filter((device) => device.kind === kind &&
          (values.backend === "ASIO" ? device.backend === "ASIO" : device.backend !== "ASIO")), current),
      runtime: state.runtime,
      devices: state.devices,
      capabilities: state.capabilities,
      configurationCapabilities: state.configurationCapabilities,
      configurationCapabilitiesBackend: state.configurationCapabilitiesBackend,
      audioAvailable: state.audioAvailable,
      asioUnavailable: state.asioUnavailable,
      asioReadyToRestart: state.asioReadyToRestart,
      onPlayTestSound: async () => {
        try {
          await audio.playTestSound();
        } catch (error) {
          notify(
            `${tr(ru.outputTestFailed)}: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
        }
      },
      onAsioDriverDetected: prepareAsio,
      onOpenAsioControlPanel: () => {
        const request = session.getSnapshot().requested;
        void session
          .enqueue(async () => {
            await audio.openBackendControlPanel(request);
          })
          .catch(effects.onError);
      },
      releaseAsioInBackground: preferences.releaseAsioInBackground,
      onReleaseAsioInBackgroundChange: (value: boolean) =>
        updatePreferences({ releaseAsioInBackground: value }),
      onAudioCommit: commit,
    },
  };
};
