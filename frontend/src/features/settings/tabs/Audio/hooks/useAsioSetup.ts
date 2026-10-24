import { useCallback, useEffect, useRef, useState } from "react";
import type { DeviceDto } from "../../../../../contracts/models";
import {
  useSettingsAudio,
  useSettingsDesktop,
} from "../../../../../app/SettingsProvider";

type SetupState = {
  phase: "idle" | "downloading" | "launched" | "detected" | "failed";
  error?: string;
};

export const useAsioSetup = (
  onAsioDriverDetected: (device: DeviceDto) => void,
) => {
  const audio = useSettingsAudio();
  const desktop = useSettingsDesktop();
  const [setup, setSetup] = useState<SetupState>({ phase: "idle" });
  const mounted = useRef(false);
  const checking = useRef(false);
  const detectedCallback = useRef(onAsioDriverDetected);
  // Session updates may replace the handler without postponing driver polling.
  useEffect(() => {
    detectedCallback.current = onAsioDriverDetected;
  }, [onAsioDriverDetected]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const detect = useCallback(async () => {
    if (checking.current) return false;
    checking.current = true;
    try {
      const drivers = (await audio.listDevices()).filter(
        (device) => device.backend === "ASIO",
      );
      if (!mounted.current) return false;
      const driver =
        drivers.find((device) => /asio4all/i.test(device.name)) ?? drivers[0];
      if (!driver) {
        setSetup((current) =>
          current.error === undefined ? current : { phase: current.phase },
        );
        return false;
      }
      detectedCallback.current(driver);
      setSetup({ phase: "detected" });
      return true;
    } catch (reason) {
      if (mounted.current)
        setSetup((current) => ({
          ...current,
          error: reason instanceof Error ? reason.message : String(reason),
        }));
      return false;
    } finally {
      checking.current = false;
    }
  }, [audio]);

  useEffect(() => {
    if (setup.phase !== "launched") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const found = await detect();
      if (!cancelled && !found) timer = setTimeout(() => void poll(), 1500);
    };
    timer = setTimeout(() => void poll(), 1500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [setup.phase, detect]);

  const install = async () => {
    setSetup({ phase: "downloading" });
    try {
      await desktop.installAsio4All();
      if (!mounted.current) return;
      setSetup({ phase: "launched" });
    } catch (reason) {
      if (!mounted.current) return;
      setSetup({
        phase: "failed",
        error: reason instanceof Error ? reason.message : String(reason),
      });
    }
  };

  const restart = async () => {
    try {
      await desktop.relaunchApp();
    } catch (reason) {
      if (mounted.current)
        setSetup((current) => ({
          ...current,
          error: reason instanceof Error ? reason.message : String(reason),
        }));
    }
  };

  return { ...setup, install, detect, restart };
};
