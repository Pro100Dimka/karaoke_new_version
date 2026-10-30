import { QueryProvider } from "../../../../../test/QueryProvider";
import { store } from "../../../../../providers/store";
import { ru } from "../../../../../i18n/messages.ru";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { SongCard } from "./index";
import type { SongDto } from "../../../../../contracts/models";

const state = vi.hoisted(() => ({
  translate: vi.fn((key: string) => key),
}));
vi.mock("@neo-ui-kit/react", async (original) => ({
  ...await original<typeof import("@neo-ui-kit/react")>(), tr: state.translate, useLocale: () => "ru",
}));
vi.mock("../../SongStatusBadge", () => ({ SongStatusBadge: () => null }));

it("shows a still cover without an equalizer or pointer tilt", () => {
  const noop = () => {};
  const view = render(
    <SongCard
      song={
        {
          id: "song",
          title: "Song",
          artist: "Artist",
          status: "ready",
          artworkUrl: "https://example.com/cover.jpg",
        } as SongDto
      }
      onPlay={noop}
    />, { wrapper: QueryProvider },
  );
  expect(view.container.querySelector("img")).toHaveAttribute(
    "src",
    "https://example.com/cover.jpg",
  );
  expect(view.container.querySelector(".ad-equalizer")).toBeNull();
  expect(view.container.querySelector(".ad-tilt")).toBeNull();
});

it("skips parent updates when the song and room selection stay unchanged", () => {
  const noop = () => {};
  const song = {
    id: "song",
    title: "Song",
    artist: "Artist",
    status: "ready",
  } as SongDto;
  const view = render(
    <SongCard
      song={song}
      onPlay={noop}
      roomSelection={{ role: "host", selected: false }}
    />, { wrapper: QueryProvider },
  );
  const calls = state.translate.mock.calls.length;
  view.rerender(
    <SongCard
      song={song}
      onPlay={noop}
      roomSelection={{ role: "host", selected: false }}
    />,
  );
  expect(state.translate).toHaveBeenCalledTimes(calls);
  view.rerender(
    <SongCard
      song={song}
      onPlay={noop}
      roomSelection={{ role: "participant", selected: true }}
    />,
  );
  expect(state.translate.mock.calls.length).toBeGreaterThan(calls);
});

it("disables karaoke and rehearsal on every ready card during local processing", () => {
  const play = vi.fn();
  const song = {
    id: "ready",
    title: "Ready",
    artist: "A",
    status: "ready",
  } as SongDto;
  const view = render(<SongCard song={song} onPlay={play} />, { wrapper: QueryProvider });
  expect(screen.getByRole("button", { name: ru.play })).toBeEnabled();
  view.rerender(<SongCard song={song} onPlay={play} playbackDisabled />);
  const button = screen.getByRole("button", { name: ru.play });
  expect(button).toBeDisabled();
  fireEvent.click(button);
  expect(play).not.toHaveBeenCalled();
  const rehearsal = screen.getByRole("button", {
    name: ru.recordingRehearsal,
  });
  expect(rehearsal).toBeDisabled();
  fireEvent.click(rehearsal);
  expect(play).not.toHaveBeenCalled();
  view.rerender(<SongCard song={song} onPlay={play} />);
  expect(screen.getByRole("button", { name: ru.play })).toBeEnabled();
});


it("exposes the prototype action row without the legacy overflow menu", () => {
  const noop = () => {};
  render(<SongCard song={{ id: "song", title: "Song", artist: "Artist", status: "ready" } as SongDto}
    onPlay={noop} />, { wrapper: QueryProvider });
  expect(screen.queryByRole("button", { name: ru.moreActions })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: ru.songSettings }));
  expect(store.libraryDialogs.settingsSong?.id).toBe("song");
});
