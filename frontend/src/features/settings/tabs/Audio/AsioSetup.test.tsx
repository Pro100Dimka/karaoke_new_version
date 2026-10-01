import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { useGetForm } from "../../../../theme/ui";
import { AppProvider } from "../../../../app/AppContext";
import type { DeviceDto, RuntimeAudioConfiguration } from "../../../../contracts/models";
import { AudioSettings } from ".";
import type { AudioValues } from "./settingsModel";

vi.mock("./AudioTests", () => ({ AudioTests: () => <div>monitoring-section</div> }));
const setup = vi.hoisted(() => ({ install: vi.fn(async () => undefined), relaunch: vi.fn(async () => undefined),
  configure: vi.fn(async () => undefined), listDevices: vi.fn(async (): Promise<readonly DeviceDto[]> => []) }));
vi.mock("../../../../services/desktopClient", () => ({ desktopClient: {
  installAsio4All: setup.install, relaunchApp: setup.relaunch, openMicrophonePrivacy: vi.fn(),
  setAppIcon: vi.fn(async () => undefined),
} }));
vi.mock("../../../../services/audioClient", () => ({ audioClient: { listDevices: setup.listDevices } }));

const runtime: RuntimeAudioConfiguration = {
  backend: "WASAPI Shared",
  sampleRate: 48000,
  periodFrames: 480,
  endpointBufferFrames: 480,
  estimatedLatencyMs: 20,
};

const View = ({ devices = [] }: { devices?: readonly DeviceDto[] }) => {
  const [visibleDevices, setVisibleDevices] = useState(devices);
  const [detected, setDetected] = useState(false);
  const formik = useGetForm<AudioValues>({
    initialValues: {
      backend: "ASIO",
      sampleRate: 0,
      periodFrames: 0,
      bufferFrames: 0,
      inputDeviceId: "",
      outputDeviceId: "",
    },
    onSubmit: () => undefined,
  });
  return <AudioSettings key={String(detected)} formik={formik} runtime={runtime} devices={visibleDevices}
    capabilities={{ microphone: "ready", keyboardLighting: false }}
    configurationCapabilities={{ sampleRates: [], periodFrames: [], defaultSampleRate: 0, defaultPeriodFrames: 0 }}
    audioAvailable inputLevel={0} testingInput={false} onToggleInputTest={() => undefined}
    onPlayTestSound={() => undefined} onAudioCommit={() => undefined}
    onOpenAsioControlPanel={setup.configure}
    asioReadyToRestart={detected}
    onAsioDriverDetected={device => {
      setVisibleDevices(current => [...current, device]);
      setDetected(true);
    }} />;
};

describe("ASIO setup guidance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setup.listDevices.mockResolvedValue([]);
  });
  it("offers ASIO4ALL between audio sections when ASIO is selected without an ASIO driver", () => {
    render(<AppProvider><View devices={[{ id: "wasapi", name: "Speakers", kind: "output", channels: 2, backend: "WASAPI Shared" }]} /></AppProvider>);
    const prompt = screen.getByRole("region", { name: "ASIO4ALL" });
    expect(prompt).toHaveTextContent(/ASIO4ALL/);
    expect(screen.getByText("monitoring-section").compareDocumentPosition(prompt) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });

  it("keeps ASIO4ALL device configuration available after the driver is installed", () => {
    render(<AppProvider><View devices={[{ id: "asio4all", name: "ASIO4ALL v2", kind: "output", channels: 2, backend: "ASIO" }]} /></AppProvider>);
    expect(screen.getByRole("region", { name: "ASIO4ALL" })).toHaveTextContent("Настройка ASIO4ALL");
    expect(screen.getByRole("region", { name: "ASIO4ALL" })).not.toHaveTextContent("драйвер не найден");
    fireEvent.click(screen.getByRole("button", { name: /Настроить устройства/i }));
    expect(setup.configure).toHaveBeenCalledOnce();
  });

  it("keeps the setup card visible after detecting the newly installed driver", async () => {
    setup.listDevices.mockResolvedValue([{ id: "asio4all", name: "ASIO4ALL v2", kind: "output", channels: 2, backend: "ASIO" }]);
    render(<AppProvider><View /></AppProvider>);
    fireEvent.click(screen.getByRole("button", { name: /ASIO4ALL/i }));
    const check = await screen.findByRole("button", { name: /Проверить установку/i });
    expect(screen.queryByRole("button", { name: /Скачать и установить/i })).not.toBeInTheDocument();
    fireEvent.click(check);
    await waitFor(() => expect(screen.getByRole("button", { name: /Перезапустить программу/i })).toBeInTheDocument());
  });
});
