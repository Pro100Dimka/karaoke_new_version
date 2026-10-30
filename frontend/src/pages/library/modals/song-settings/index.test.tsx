import { store } from "../../../../providers/store";
import { runInAction } from "mobx";
import { QueryProvider } from "../../../../test/QueryProvider";
import { fireEvent, render, screen } from "@testing-library/react";
import { TestRouter } from "../../../../test/QueryProvider";
import { describe, expect, it } from "vitest";

import type { SongDto } from "../../../../contracts/models";
import { SongSettingsModal } from "./index";

const renderSettings = (
  status: SongDto["status"] = "ready",
  overrides: Partial<SongDto> = {},
) => {
  const song: SongDto = {
    id: "existing",
    title: "Song",
    artist: "Artist",
    language: "Auto",
    status,
    durationSeconds: 200,
    createdAt: "2026-10-20",
    coverState: "Fallback",
    activeRevision: 2,
    projectFormatVersion: 1,
    ...overrides,
  };
  runInAction(() => { store.libraryDialogs.settingsSong = song; });
  render(
    <TestRouter>
      <QueryProvider application>
        <>
          <SongSettingsModal />
        </>
      </QueryProvider>
    </TestRouter>,
  );
  return { song };
};

describe("existing song lyric realignment", () => {
  it("offers no processing or realignment for an existing song", () => {
    renderSettings();
    expect(
      screen.queryByRole("button", {
        name: /Уточнить слова и ноты|Переобработать/,
      }),
    ).toBeNull();
  });
  it("keeps full reprocessing out of the song settings menu", () => {
    renderSettings();
    fireEvent.click(screen.getByRole("button", { name: "Другие действия" }));
    expect(
      screen.queryByRole("menuitem", { name: "Переобработать" }),
    ).not.toBeInTheDocument();
  });

  it("previews discovered artwork, explains the video override and keeps deletion out of the save row", () => {
    renderSettings("ready", {
      artworkUrl: "https://example.org/cover.jpg",
      videoUrl: "https://example.org/video",
    });
    expect(screen.getByRole("img", { name: "Artist — Song" })).toHaveAttribute(
      "src",
      "https://example.org/cover.jpg",
    );
    expect(screen.getByText(/Найденный клип/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Удалить песню" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Язык Определять автоматически" }),
    ).toHaveTextContent("Определять автоматически");
  });
  it("keeps word and note realignment out of the settings", () => {
    renderSettings();
    expect(
      screen.queryByRole("button", { name: "Уточнить слова и ноты" }),
    ).toBeNull();
  });

  it.each(["queued", "processing", "not-processed"] as const)(
    "does not offer realignment while the song is %s",
    (status) => {
      renderSettings(status);
      expect(
        screen.queryByRole("button", { name: "Уточнить слова и ноты" }),
      ).toBeNull();
    },
  );
});
