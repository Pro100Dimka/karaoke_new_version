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

const open = (onImport: (path: string, metadata: { title?: string; artist?: string }) => Promise<void>) =>
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
    const onImport = vi.fn(async () => undefined);
    open(onImport);
    await screen.findByText("Нервы - Кофе мой друг (zaycev.net).mp3");
    fireEvent.submit(document.querySelector(".audioFilePicker")?.closest("form") as HTMLFormElement);

    await waitFor(() => expect(onImport).toHaveBeenCalledWith("C:/music/song.mp3", {}));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
