import { QueryProvider } from "../../../../test/QueryProvider";
import { useSongRecordings } from "../../songs/useSongRecordings";
vi.mock("../../songs/useSongRecordings");
vi.mock("../analysis", () => ({ PerformanceAnalysisModal: () => null }));
import { ru } from "../../../../i18n/messages.ru";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RecordingDto, SongDto } from "../../../../contracts/models";
import { RecordingsModal } from "./index";


vi.mock("../../../../services/desktopClient", () => ({ desktopClient: { revealInExplorer: vi.fn() } }));
vi.mock("./RecordingPlayer", () => ({ RecordingPlayer: ({ recording }: { recording: RecordingDto }) => <div data-testid="playing-version">{recording.id}</div> }));
afterEach(cleanup);

const original = { id: "take", songId: "song", displayName: "My performance", createdAt: "2026-10-23T12:00:00Z", sizeBytes: 10 } as RecordingDto;
const master = { ...original, id: "master", sourceRecordingId: original.id, displayName: "", sizeBytes: 20 };
const props = { song: { title: "Song" } as SongDto, onClose: vi.fn(), onRename: vi.fn(), onAnalyze: vi.fn(), onDelete: vi.fn() };

const renderRecordings = (recordings: readonly RecordingDto[], extra: Partial<ReturnType<typeof useSongRecordings>> = {}) => {
  vi.mocked(useSongRecordings).mockReturnValue({
    song: props.song, recordings, close: props.onClose, rename: props.onRename,
    analyze: props.onAnalyze, remove: props.onDelete, open: vi.fn(),
    analysis: null, analysisSong: null, analysisRecordId: null,
    analysisProgress: {}, analysisFailures: {}, cancelAnalysis: vi.fn(),
    studioMaster: null, createStudioMaster: vi.fn(), closeAnalysis: vi.fn(), ...extra,
  });
  return render(<QueryProvider><RecordingsModal songs={[props.song]} ready /></QueryProvider>);
};

it("offers opening an existing analysis and explicitly recalculating it", () => {
  renderRecordings([{ ...original, analyzed: true, analysisStatus: "Succeeded" }]);
  fireEvent.click(screen.getByRole("button", { name: ru.recordingOpenAnalysis }));
  expect(props.onAnalyze).toHaveBeenLastCalledWith(expect.objectContaining({ id: "take" }));
  fireEvent.click(screen.getByRole("button", { name: "Другие действия" }));
  fireEvent.click(screen.getByRole("menuitem", { name: ru.recordingReanalyze }));
  expect(props.onAnalyze).toHaveBeenLastCalledWith(expect.objectContaining({ id: "take" }), true);
});

it("shows a queued analysis and lets its owner cancel it", () => {
  const cancel = vi.fn();
  renderRecordings([original], { cancelAnalysis: cancel,
    analysisProgress: { take: { recordingId: "take", jobId: "job", state: "Queued", stage: "Queued", progress: 0 } } });
  expect(screen.getByText((text) => text.includes(ru.analysisQueued))).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: ru.analysisCancel }));
  expect(cancel).toHaveBeenCalledWith("job");
});

it("counts one performance and switches its original and Studio Master inside the same card", () => {
  renderRecordings([master, original]);
  const list = screen.getByRole("list", { name: "Записи" });
  expect(within(list).getAllByRole("listitem")).toHaveLength(1);
  expect(screen.getByText("Записей: 1")).toBeInTheDocument();
  expect(screen.getByTestId("playing-version")).toHaveTextContent("take");
  fireEvent.click(screen.getByRole("tab", { name: ru.studioMasterTitle }));
  expect(screen.getByTestId("playing-version")).toHaveTextContent("master");
  fireEvent.click(within(list).getByRole("button", { name: ru.recordingDelete }));
  expect(props.onDelete).toHaveBeenLastCalledWith(master);
});

it("keeps a Studio Master accessible when its source has been removed", () => {
  renderRecordings([master]);
  expect(screen.getByRole("list", { name: "Записи" }).children).toHaveLength(1);
  expect(screen.getByTestId("playing-version")).toHaveTextContent("master");
});
