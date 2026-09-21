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

const field = (name: string): HTMLInputElement => {
  const input = document.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  if (!input) throw new Error(`No field ${name}`);
  return input;
};

const open = (onImport: (path: string, metadata: { title?: string; artist?: string }) => Promise<void>) =>
  render(
    <AppProvider>
      <AddSongModal open initialPath="C:/music/song.mp3" onClose={() => undefined} onImport={onImport} />
    </AppProvider>
  );

describe("AddSongModal", () => {
  beforeEach(() => vi.clearAllMocks());

  it("fills the title and artist detected from the file name so wrong parts can be removed", async () => {
    open(vi.fn(async () => undefined));

    await waitFor(() => expect(field("title").value).toBe("Кофе мой друг (zaycev.net)"));
    expect(field("artist").value).toBe("Нервы");
  });

  it("sends only the fields the user changed", async () => {
    const onImport = vi.fn(async () => undefined);
    open(onImport);
    await waitFor(() => expect(field("title").value).not.toBe(""));

    fireEvent.change(field("title"), { target: { value: "Кофе мой друг" } });
    fireEvent.submit(field("title").closest("form") as HTMLFormElement);

    await waitFor(() => expect(onImport).toHaveBeenCalledWith("C:/music/song.mp3", { title: "Кофе мой друг", artist: undefined }));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
