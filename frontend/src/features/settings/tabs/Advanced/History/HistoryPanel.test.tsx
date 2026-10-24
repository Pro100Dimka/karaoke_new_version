import {
  act,
  render as baseRender,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { readFileSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
import { HistoryPanel } from ".";
import type { HistoryEventDto } from "../../../../../contracts/models";
import { desktopClient } from "../../../../../services/desktopClient";
import { pythonClient } from "../../../../../services/pythonClient";
import { SettingsProvider } from "../../../SettingsProvider";
import { DiagnosticsPanel } from "../Diagnostics";
import { StoragePanel } from "../Storage";

const render = (ui: Parameters<typeof baseRender>[0]) =>
  baseRender(ui, { wrapper: SettingsProvider });

vi.mock("../../../../../i18n/useText", () => ({
  useText: () => (key: string) => key,
}));

vi.mock("../../../../../services/pythonClient", () => ({
  pythonClient: {
    history: vi.fn(),
    listSongs: vi.fn(),
    listJobs: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../../../../../services/desktopClient", () => ({
  desktopClient: {
    keyboardLightingCapabilities: vi
      .fn()
      .mockResolvedValue({ available: false, deviceCount: 0 }),
    copyText: vi.fn().mockResolvedValue(undefined),
    saveTextFile: vi.fn().mockResolvedValue(true),
  },
}));
vi.mock("../../../../../app/NotificationsProvider", () => ({
  useNotify: () => vi.fn(),
}));
vi.mock("../../../../../app/DialogProvider", () => ({ useAsk: () => vi.fn() }));

beforeEach(() => vi.clearAllMocks());

it("keeps storage totals and cleanup actions visible with an optional category breakdown", () => {
  const { container } = render(
    <StoragePanel
      usage={{
        songs: 100,
        models: 200,
        cache: 30,
        recordings: 40,
        temp: 5,
        free: 1000,
      }}
      onChanged={vi.fn()}
    />,
  );
  const disclosure = container.querySelector("details");
  expect(disclosure).not.toBeNull();
  expect(disclosure).not.toHaveAttribute("open");
  expect(screen.getByText("storageUsed")).toBeVisible();
  for (const name of ["clearCache", "removeTemporaryFiles"]) {
    expect(screen.getByRole("button", { name })).toBeVisible();
  }
  expect(screen.getByText("storageSongs")).not.toBeVisible();
  fireEvent.click(screen.getByText("storageBreakdown"));
  expect(screen.getByText("storageSongs")).toBeVisible();
  expect(screen.getByText("storageModels")).toBeVisible();
  expect(screen.getByText("storageTemp")).toBeVisible();
});

it("keeps primary health and accessible diagnostics actions visible while secondary details collapse", async () => {
  const refresh = vi.fn();
  const { container } = render(
    <DiagnosticsPanel
      health={{
        loading: false,
        backend: null,
        audio: { ServiceState: "Running", XRuns: "0" },
        audioVersion: "1",
        refresh,
      }}
    />,
  );
  const disclosure = container.querySelector("details");
  expect(disclosure).not.toBeNull();
  expect(disclosure).not.toHaveAttribute("open");
  expect(screen.getByText("pythonBackend")).toBeVisible();
  expect(screen.getByText("audioServiceLabel")).toBeVisible();
  expect(screen.getByText("unavailable")).toBeVisible();
  expect(screen.getByText("Running")).toBeVisible();
  expect(screen.getByText("keyboardLighting")).not.toBeVisible();
  expect(
    screen.getByRole("button", { name: "copyDiagnostics" }),
  ).toHaveTextContent("copyDiagnostics");
  for (const name of ["exportDiagnostics", "refresh"]) {
    const button = screen.getByRole("button", { name });
    expect(button).toHaveClass("ad-icon-button");
    expect(button).toHaveAttribute("title", name);
  }
  fireEvent.click(screen.getByRole("button", { name: "refresh" }));
  expect(refresh).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "exportDiagnostics" }));
  await waitFor(() =>
    expect(desktopClient.saveTextFile).toHaveBeenCalledOnce(),
  );
  fireEvent.click(screen.getByRole("button", { name: "copyDiagnostics" }));
  await waitFor(() => expect(desktopClient.copyText).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByText("diagnosticsDetails"));
  expect(screen.getByText("keyboardLighting")).toBeVisible();
  expect(screen.getByText("audioXruns")).toBeVisible();
});

it("retains every secondary subsystem detail when diagnostics expand", async () => {
  await act(async () => {
    render(
      <DiagnosticsPanel
        health={{
          loading: false,
          backend: {
            state: "Ready",
            database: true,
            cudaAvailable: true,
            gpuName: "Test GPU",
            ffmpegVersion: "7.1",
            interruptedTransactions: 0,
            backendVersion: "1",
            apiVersion: 1,
            dbSchema: 1,
            projectFormat: 2,
            storage: {
              songs: 0,
              models: 0,
              cache: 0,
              recordings: 0,
              temp: 0,
              free: 1000,
            },
          },
          audio: { ServiceState: "Running", XRuns: "2", DeadlineMisses: "3" },
          audioVersion: "1",
          refresh: vi.fn(),
        }}
      />,
    );
  });
  for (const name of [
    "database",
    "aiRuntime",
    "FFmpeg",
    "audioXruns",
    "keyboardLighting",
  ]) {
    expect(screen.getByText(name)).not.toBeVisible();
  }
  fireEvent.click(screen.getByText("diagnosticsDetails"));
  for (const name of [
    "database",
    "aiRuntime",
    "FFmpeg",
    "audioXruns",
    "keyboardLighting",
    "Test GPU",
    "7.1",
    "2 / 3",
  ]) {
    expect(screen.getByText(name)).toBeVisible();
  }
});

it("shows one recoverable failure state instead of an empty history table", async () => {
  vi.mocked(pythonClient.history)
    .mockRejectedValueOnce(new Error("History is unavailable"))
    .mockResolvedValueOnce({
      items: [
        {
          id: "recovered",
          kind: "RecordingRegistered",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
      total: 1,
    });
  vi.mocked(pythonClient.listSongs).mockResolvedValue([]);

  render(<HistoryPanel />);
  expect(await screen.findByText("historyLoadFailed")).toBeVisible();
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
  expect(screen.queryByText("historyEmpty")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "retry" }));
  expect(
    await screen.findByText("historyKindRecordingRegistered"),
  ).toBeVisible();
  expect(screen.queryByText("historyLoadFailed")).not.toBeInTheDocument();
  expect(pythonClient.history).toHaveBeenLastCalledWith(50, 0, [
    "RecordingRegistered",
    "AnalysisCompleted",
  ]);
});

it("lets history grow with its rows instead of adding a capped inner scroller", async () => {
  vi.mocked(pythonClient.history).mockResolvedValue({
    items: [
      {
        id: "performance",
        kind: "RecordingRegistered",
        createdAt: "2026-01-01T00:00:00Z",
      },
    ],
    total: 1,
  });
  vi.mocked(pythonClient.listSongs).mockResolvedValue([]);

  render(<HistoryPanel />);
  const table = await screen.findByRole("table");
  expect(
    table.closest<HTMLElement>(".ad-data-table-scroll")!.style.maxHeight,
  ).toBe("");
});

it("keeps Advanced content and decoration free of fixed height constraints", () => {
  const advancedStyles = readFileSync(
    "src/features/settings/tabs/Advanced/advanced.css",
    "utf8",
  );
  const constrainedHeights = [
    ...advancedStyles.matchAll(
      /(?:^|[;{])\s*(?:min-|max-)?height\s*:\s*([^;}]+)/gm,
    ),
  ]
    .map((match) => match[1]!.trim())
    .filter((value) => !["auto", "none", "0"].includes(value));
  expect(constrainedHeights).toEqual([]);
});

it("preserves loaded history when another page fails and retries that page", async () => {
  const first = {
    id: "first",
    kind: "RecordingRegistered",
    createdAt: "2026-01-01T00:00:00Z",
  };
  const next = {
    id: "next",
    kind: "AnalysisCompleted",
    createdAt: "2026-01-02T00:00:00Z",
  };
  vi.mocked(pythonClient.history)
    .mockResolvedValueOnce({ items: [first], total: 2 })
    .mockRejectedValueOnce(new Error("Next page is unavailable"))
    .mockResolvedValueOnce({ items: [next], total: 2 });
  vi.mocked(pythonClient.listSongs).mockResolvedValue([]);

  render(<HistoryPanel />);
  expect(
    await screen.findByText("historyKindRecordingRegistered"),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "loadMore" }));
  expect(await screen.findByText("historyLoadFailed")).toBeVisible();
  expect(screen.getByText("historyKindRecordingRegistered")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "loadMore" }));
  expect(await screen.findByText("historyKindAnalysisCompleted")).toBeVisible();
  expect(screen.getByText("historyKindRecordingRegistered")).toBeVisible();
  expect(pythonClient.history).toHaveBeenLastCalledWith(50, 1, [
    "RecordingRegistered",
    "AnalysisCompleted",
  ]);
  expect(
    screen.queryByRole("button", { name: "loadMore" }),
  ).not.toBeInTheDocument();
});

it("ignores a failed history request after switching tabs", async () => {
  let rejectPrevious!: (error: Error) => void;
  vi.mocked(pythonClient.history)
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectPrevious = reject;
        }),
    )
    .mockResolvedValueOnce({
      items: [
        {
          id: "processing-event",
          kind: "ProcessingFailed",
          createdAt: "2026-01-01T00:00:00Z",
        } satisfies HistoryEventDto,
      ],
      total: 1,
    });
  vi.mocked(pythonClient.listSongs).mockResolvedValue([]);

  render(<HistoryPanel />);
  fireEvent.click(screen.getByText("historyProcessing"));
  expect(await screen.findByText("historyKindProcessingFailed")).toBeVisible();

  await act(async () => rejectPrevious(new Error("Old tab failed")));
  expect(pythonClient.history).toHaveBeenCalledTimes(2);
  expect(screen.queryByText("historyLoadFailed")).not.toBeInTheDocument();
});

it("ignores the first request after returning to the same history tab", async () => {
  let resolvePrevious!: (
    page: Awaited<ReturnType<typeof pythonClient.history>>,
  ) => void;
  vi.mocked(pythonClient.history)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePrevious = resolve;
        }),
    )
    .mockResolvedValueOnce({ items: [], total: 0 })
    .mockResolvedValueOnce({
      items: [
        {
          id: "current-performance",
          kind: "RecordingRegistered",
          createdAt: "2026-01-02T00:00:00Z",
        },
      ],
      total: 1,
    });
  vi.mocked(pythonClient.listSongs).mockResolvedValue([]);

  render(<HistoryPanel />);
  fireEvent.click(screen.getByText("historyProcessing"));
  fireEvent.click(screen.getByText("historyPerformances"));
  expect(
    await screen.findByText("historyKindRecordingRegistered"),
  ).toBeVisible();

  await act(async () => {
    resolvePrevious({
      items: [
        {
          id: "stale-performance",
          kind: "AnalysisCompleted",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
      total: 1,
    });
  });
  expect(screen.getByText("historyKindRecordingRegistered")).toBeVisible();
  expect(
    screen.queryByText("historyKindAnalysisCompleted"),
  ).not.toBeInTheDocument();
});
