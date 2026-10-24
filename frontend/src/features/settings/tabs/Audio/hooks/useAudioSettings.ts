import { useEffect, useSyncExternalStore } from "react";
import { useApp } from "../../../../../app/AppContext";
import { useNotify } from "../../../../../app/NotificationsProvider";
import type { DeviceDto } from "../../../../../contracts/models";
import { useText } from "../../../../../i18n/useText";
import { safeAudioConfiguration } from "../../../../../shared/preferences/preferences";
import { useSettingsAudio } from "../../../SettingsProvider";
import { audioSessionFor } from "../model/audioSession";
import {
  automaticAudioTiming,
  changeAudioValue,
  displayedAudioValues,
  toAudioRequest,
  toAudioValues,
  type AudioCommit,
} from "../model/audioConfiguration";

/** The view subscribes to the session; displayed runtime values never become a request draft. */
export const useAudioSettings = (enabled = true) => {
  const audio = useSettingsAudio();
  const { preferences, updatePreferences } = useApp("preferences");
  const t = useText();
  const notify = useNotify();
  const session = audioSessionFor(audio);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const effects = {
    onAccepted: (request: typeof preferences.audio) =>
      updatePreferences({ audio: request }),
    onError: (error: unknown) =>
      notify(
        `${t("settingsApplyFailed")}: ${error instanceof Error ? error.message : String(error)}`,
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
      changeAudioValue(toAudioValues(current.requested), name, value),
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
  return {
    ready: state.ready,
    audio: {
      values: displayedAudioValues(
        state.requested,
        state.runtime,
        state.audioAvailable && !state.applying,
      ),
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
            `${t("outputTestFailed")}: ${error instanceof Error ? error.message : String(error)}`,
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
