import { act, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useState, type ReactNode } from "react";
import { SongCard, type SongCardHandlers } from "./SongCard";
import type { SongDto } from "../../contracts/models";

const state = vi.hoisted(() => ({
  translate: vi.fn((key: string) => key),
  publish: undefined as undefined | ((bands: readonly number[]) => void),
}));
vi.mock("../../i18n/useText", () => ({useText: () => state.translate}));
vi.mock("./useRadioSpectrum", () => ({useRadioSpectrum: () => {
  const [bands, setBands] = useState<readonly number[]>([]);
  state.publish = setBands;
  return bands;
}}));
vi.mock("./SongStatusBadge", () => ({SongStatusBadge: () => null}));
vi.mock("@ad-voice/ui", () => ({
  MediaCard: ({levels, actions, children}: {levels: readonly number[]; actions: ReactNode; children: ReactNode}) =>
    <div><span data-testid="spectrum">{levels.join(",")}</span>{actions}{children}</div>,
  IconButton: ({label}: {label: string}) => <button>{label}</button>,
  Menu: () => null,
}));

it("updates the radio surface without rebuilding song actions on every spectrum frame", () => {
  const noop = () => {};
  const handlers: SongCardHandlers = {
    onPlay: noop, onProcess: noop, onCancel: noop, onDetails: noop,
    onSettings: noop, onRecordings: noop, onOpenFolder: noop,
    onDelete: noop, onViewError: noop,
  };
  render(<SongCard song={{id: "song", title: "Song", artist: "Artist", status: "ready"} as SongDto} handlers={handlers} />);
  const calls = state.translate.mock.calls.length;
  act(() => state.publish?.([0.1, 0.8]));
  expect(screen.getByTestId("spectrum")).toHaveTextContent("0.1,0.8");
  expect(state.translate).toHaveBeenCalledTimes(calls);
});

it("skips parent updates when the song and room selection stay unchanged", () => {
  const noop = () => {};
  const handlers: SongCardHandlers = {
    onPlay: noop, onProcess: noop, onCancel: noop, onDetails: noop,
    onSettings: noop, onRecordings: noop, onOpenFolder: noop,
    onDelete: noop, onViewError: noop,
  };
  const song = {id: "song", title: "Song", artist: "Artist", status: "ready"} as SongDto;
  const view = render(<SongCard song={song} handlers={handlers} roomSelection={{role: "host", selected: false}} />);
  const calls = state.translate.mock.calls.length;
  view.rerender(<SongCard song={song} handlers={handlers} roomSelection={{role: "host", selected: false}} />);
  expect(state.translate).toHaveBeenCalledTimes(calls);
  view.rerender(<SongCard song={song} handlers={handlers} roomSelection={{role: "participant", selected: true}} />);
  expect(state.translate.mock.calls.length).toBeGreaterThan(calls);
});
