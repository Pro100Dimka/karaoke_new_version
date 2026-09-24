import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppProvider } from "../../app/AppContext";
import { AddSongModal } from "./AddSongModal";

vi.mock("../../services/desktopClient", () => ({
  desktopClient: {
    statFile: vi.fn(async () => ({ name: "Нервы - Кофе мой друг (zaycev.net).mp3", extension: "mp3", sizeBytes: 1000 })),
    pickAudioFile: vi.fn(async () => null),
    setAppIcon: vi.fn(async () => undefined)
  }
}));

const open = (onImport: AddSongModalImport) =>
  render(
    <AppProvider>
      <AddSongModal open initialPath="C:/music/song.mp3" onClose={() => undefined} onImport={onImport} />
    </AppProvider>
  );

describe("AddSongModal", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows one custom audio picker without title and artist fields", async () => {
    open(vi.fn(async () => undefined));

    await screen.findByText("Нервы - Кофе мой друг (zaycev.net).mp3");
    expect(document.querySelector('input[name="title"]')).toBeNull();
    expect(document.querySelector('input[name="artist"]')).toBeNull();
    expect(document.querySelector(".audioFilePicker")).toBeInstanceOf(HTMLButtonElement);
  });

  it("imports the selected path without overriding detected metadata", async () => {
    const onImport = vi.fn<AddSongModalImport>(async () => undefined);
    open(onImport);
    await screen.findByText("Нервы - Кофе мой друг (zaycev.net).mp3");
    fireEvent.submit(document.querySelector(".audioFilePicker")?.closest("form") as HTMLFormElement);

    await waitFor(() => expect(onImport).toHaveBeenCalled());
    expect(onImport.mock.calls[0]?.slice(0, 2)).toEqual(["C:/music/song.mp3", {}]);
    expect(typeof onImport.mock.calls[0]?.[2].onProgress).toBe("function");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows import progress and cancels the background import", async () => {
    let signal: AbortSignal | undefined;
    const onImport: AddSongModalImport = vi.fn((_path, _metadata, options) => {
      signal = options.signal;
      options.onProgress({ jobId: "import-1", stage: "Copying", progress: 35 });
      return new Promise<void>(() => undefined);
    });
    open(onImport);
    await screen.findByText("Нервы - Кофе мой друг (zaycev.net).mp3");
    fireEvent.submit(document.querySelector(".audioFilePicker")?.closest("form") as HTMLFormElement);

    expect(await screen.findByRole("progressbar")).toHaveAttribute(
      "aria-valuenow", "35"
    );
    fireEvent.click(screen.getByRole("button", { name: /Отменить импорт|cancelImport/i }));
    expect(signal?.aborted).toBe(true);
  });
});

type AddSongModalImport = (
  path: string,
  metadata: { title?: string; artist?: string },
  options: {
    signal: AbortSignal;
    onProgress(value: { jobId: string; stage: string; progress: number }): void;
  },
) => Promise<void>;
