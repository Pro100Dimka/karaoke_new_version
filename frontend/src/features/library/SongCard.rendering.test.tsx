import { render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { SongCard, type SongCardHandlers } from "./SongCard";
import type { SongDto } from "../../contracts/models";

const state = vi.hoisted(() => ({
  translate: vi.fn((key: string) => key),
}));
vi.mock("../../i18n/useText", () => ({ useText: () => state.translate }));
vi.mock("./SongStatusBadge", () => ({ SongStatusBadge: () => null }));

it("shows a still cover without an equalizer or pointer tilt", () => {
  const noop = () => {};
  const handlers: SongCardHandlers = {
    onPlay: noop,
    onProcess: noop,
    onCancel: noop,
    onDetails: noop,
    onSettings: noop,
    onRecordings: noop,
    onOpenFolder: noop,
    onDelete: noop,
    onViewError: noop,
  };
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
      handlers={handlers}
    />,
  );
  expect(view.container.querySelector("img")).toHaveAttribute("src", "https://example.com/cover.jpg");
  expect(view.container.querySelector(".ad-equalizer")).toBeNull();
  expect(view.container.querySelector(".ad-tilt")).toBeNull();
});

it("skips parent updates when the song and room selection stay unchanged", () => {
  const noop = () => {};
  const handlers: SongCardHandlers = {
    onPlay: noop,
    onProcess: noop,
    onCancel: noop,
    onDetails: noop,
    onSettings: noop,
    onRecordings: noop,
    onOpenFolder: noop,
    onDelete: noop,
    onViewError: noop,
  };
  const song = {
    id: "song",
    title: "Song",
    artist: "Artist",
    status: "ready",
  } as SongDto;
  const view = render(
    <SongCard
      song={song}
      handlers={handlers}
      roomSelection={{ role: "host", selected: false }}
    />,
  );
  const calls = state.translate.mock.calls.length;
  view.rerender(
    <SongCard
      song={song}
      handlers={handlers}
      roomSelection={{ role: "host", selected: false }}
    />,
  );
  expect(state.translate).toHaveBeenCalledTimes(calls);
  view.rerender(
    <SongCard
      song={song}
      handlers={handlers}
      roomSelection={{ role: "participant", selected: true }}
    />,
  );
  expect(state.translate.mock.calls.length).toBeGreaterThan(calls);
});
