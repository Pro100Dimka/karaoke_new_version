import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { useForm } from "@ad-voice/ui";
import { AppProvider } from "../../../../app/AppContext";
import type {
  DeviceDto,
  RuntimeAudioConfiguration,
} from "../../../../contracts/models";
import { AudioSettings } from ".";
import type { AudioValues } from "./settingsModel";

vi.mock("./AudioTests", () => ({
  AudioTests: () => <div>monitoring-section</div>,
}));
const setup = vi.hoisted(() => ({
  install: vi.fn(async () => undefined),
  relaunch: vi.fn(async () => undefined),
  configure: vi.fn(async () => undefined),
  release: vi.fn(),
  listDevices: vi.fn(async (): Promise<readonly DeviceDto[]> => []),
}));
vi.mock("../../../../services/desktopClient", () => ({
  desktopClient: {
    installAsio4All: setup.install,
    relaunchApp: setup.relaunch,
    openMicrophonePrivacy: vi.fn(),
    setAppIcon: vi.fn(async () => undefined),
  },
}));
vi.mock("../../../../services/audioClient", () => ({
  audioClient: { listDevices: setup.listDevices },
}));

const runtime: RuntimeAudioConfiguration = {
  backend: "WASAPI Shared",
  sampleRate: 48000,
  periodFrames: 480,
  endpointBufferFrames: 480,
  estimatedLatencyMs: 20,
};

const View = ({ devices = [], asioUnavailable = false }: {
  devices?: readonly DeviceDto[]; asioUnavailable?: boolean;
}) => {
  const [visibleDevices, setVisibleDevices] = useState(devices);
  const [detected, setDetected] = useState(false);
  const [releaseAsio, setReleaseAsio] = useState(false);
  const form = useForm<AudioValues>({
    initialValues: {
      backend: "ASIO",
      sampleRate: 0,
      periodFrames: 0,
      bufferFrames: 0,
      inputDeviceId: "",
      outputDeviceId: "",
    },
  });
  return (
    <AudioSettings
      key={String(detected)}
      form={form}
      runtime={runtime}
      devices={visibleDevices}
      capabilities={{ microphone: "ready", keyboardLighting: false }}
      configurationCapabilities={{
        sampleRates: [],
        periodFrames: [],
        defaultSampleRate: 0,
        defaultPeriodFrames: 0,
      }}
      audioAvailable
      asioUnavailable={asioUnavailable}
      inputLevel={0}
      testingInput={false}
      onToggleInputTest={() => undefined}
      onPlayTestSound={() => undefined}
      onAudioCommit={() => undefined}
      onOpenAsioControlPanel={setup.configure}
      releaseAsioInBackground={releaseAsio}
      onReleaseAsioInBackgroundChange={(value) => {
        setReleaseAsio(value);
        setup.release(value);
      }}
      asioReadyToRestart={detected}
      onAsioDriverDetected={(device) => {
        setVisibleDevices((current) => [...current, device]);
        setDetected(true);
      }}
    />
  );
};

describe("ASIO setup guidance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setup.listDevices.mockResolvedValue([]);
  });
  it("does not suggest ASIO4ALL when the selected Audient driver is installed but failed to open", () => {
    render(<AppProvider><View asioUnavailable devices={[
      { id: "audient", name: "Audient USB Audio ASIO Driver", kind: "output", channels: 0, backend: "ASIO" },
    ]} /></AppProvider>);
    expect(screen.queryByRole("region", { name: "ASIO4ALL" })).not.toBeInTheDocument();
    expect(screen.getByText("Не удалось открыть выбранный ASIO-драйвер.")).toBeInTheDocument();
  });
  it("keeps ASIO4ALL device configuration available after the driver is installed", () => {
    render(
      <AppProvider>
        <View
          devices={[
            {
              id: "asio4all",
              name: "ASIO4ALL v2",
              kind: "output",
              channels: 2,
              backend: "ASIO",
            },
          ]}
        />
      </AppProvider>,
    );
    expect(screen.getByRole("region", { name: "ASIO4ALL" })).toHaveTextContent(
      "Настройка ASIO4ALL",
    );
    expect(
      screen.getByRole("region", { name: "ASIO4ALL" }),
    ).not.toHaveTextContent("драйвер не найден");
    fireEvent.click(
      screen.getByRole("button", { name: /Настроить устройства/i }),
    );
    expect(setup.configure).toHaveBeenCalledOnce();
  });

  it("keeps one background-release switch in sync when it is enabled and disabled", () => {
    render(
      <AppProvider>
        <View
          devices={[
            {
              id: "asio4all",
              name: "ASIO4ALL v2",
              kind: "output",
              channels: 2,
              backend: "ASIO",
            },
          ]}
        />
      </AppProvider>,
    );
    const release = screen.getByRole("switch", {
      name: "Освобождать ASIO в фоне",
    });
    fireEvent.click(release);
    expect(release).toBeChecked();
    fireEvent.click(release);
    expect(release).not.toBeChecked();
    expect(setup.release.mock.calls).toEqual([[true], [false]]);
  });
});
