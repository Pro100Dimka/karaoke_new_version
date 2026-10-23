import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RecordingDto, SongDto } from "../../contracts/models";
import { RecordingsModal } from "./RecordingsModal";

vi.mock("../../i18n/useText", () => ({ useText: () => (key: string, values?: { count?: number }) => values?.count === undefined ? key : `${key}:${values.count}` }));
vi.mock("../../app/LibraryProvider", () => ({ useLibraryFiles: () => ({ revealInExplorer: vi.fn() }) }));
vi.mock("./RecordingPlayer", () => ({ RecordingPlayer: ({ recording }: { recording: RecordingDto }) => <div data-testid="playing-version">{recording.id}</div> }));
afterEach(cleanup);

const original = { id: "take", songId: "song", displayName: "My performance", createdAt: "2026-10-23T12:00:00Z", sizeBytes: 10 } as RecordingDto;
const master = { ...original, id: "master", sourceRecordingId: original.id, displayName: "", sizeBytes: 20 };
const props = { song: { title: "Song" } as SongDto, onClose: vi.fn(), onRename: vi.fn(), onAnalyze: vi.fn(), onDelete: vi.fn() };

it("offers opening an existing analysis and explicitly recalculating it", () => {
  render(<RecordingsModal {...props} recordings={[{ ...original, analyzed: true, analysisStatus: "Succeeded" }]} />);
  fireEvent.click(screen.getByRole("button", { name: "recordingOpenAnalysis" }));
  expect(props.onAnalyze).toHaveBeenLastCalledWith(expect.objectContaining({ id: "take" }));
  fireEvent.click(screen.getByRole("button", { name: "Другие действия" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "recordingReanalyze" }));
  expect(props.onAnalyze).toHaveBeenLastCalledWith(expect.objectContaining({ id: "take" }), true);
});

it("shows a queued analysis and lets its owner cancel it", () => {
  const cancel = vi.fn();
  render(<RecordingsModal {...props} recordings={[original]} onCancelAnalysis={cancel}
    progress={{ take: { recordingId: "take", jobId: "job", state: "Queued", stage: "Queued", progress: 0 } }} />);
  expect(screen.getByText(/analysisQueued/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "analysisCancel" }));
  expect(cancel).toHaveBeenCalledWith("job");
});

it("counts one performance and switches its original and Studio Master inside the same card", () => {
  render(<RecordingsModal {...props} recordings={[master, original]} />);
  const list = screen.getByRole("list", { name: "recordings" });
  expect(within(list).getAllByRole("listitem")).toHaveLength(1);
  expect(screen.getByText("recordingsCount:1")).toBeInTheDocument();
  expect(screen.getByTestId("playing-version")).toHaveTextContent("take");
  fireEvent.click(screen.getByRole("tab", { name: "studioMasterTitle" }));
  expect(screen.getByTestId("playing-version")).toHaveTextContent("master");
  fireEvent.click(within(list).getByRole("button", { name: "recordingDelete" }));
  expect(props.onDelete).toHaveBeenLastCalledWith(master);
});

it("keeps a Studio Master accessible when its source has been removed", () => {
  render(<RecordingsModal {...props} recordings={[master]} />);
  expect(screen.getByRole("list", { name: "recordings" }).children).toHaveLength(1);
  expect(screen.getByTestId("playing-version")).toHaveTextContent("master");
});
