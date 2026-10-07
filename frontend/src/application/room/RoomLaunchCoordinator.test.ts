import { afterEach, expect, it, vi } from "vitest";
import type { RoomStateDto, SongDto } from "../../contracts/models";
import type { RoomSessionScope } from "./RoomSessionController";
import { RoomLaunchCoordinator } from "./RoomLaunchCoordinator";

const snapshot = (): RoomStateDto => ({
  code: "room-a", hostId: "host", role: "host", playbackLocked: false,
  songId: "song", revision: 1, playbackState: "playing", participants: [],
});
const localSong = { id: "song", activeRevision: 1, status: "ready" } as SongDto;
const setup = () => {
  let active = true;
  let room = snapshot();
  let path = "/";
  const scope: RoomSessionScope = {
    code: "room-a", generation: 1, signal: new AbortController().signal,
    isCurrent: () => active, getRoom: () => active ? room : null,
    setSnapshot: (next) => { if (!active) return false; room = next; return true; },
    disconnect: () => { active = false; return true; },
  };
  const project = { prepare: vi.fn(async (): Promise<readonly SongDto[] | undefined> => [localSong]),
    cancel: vi.fn() };
  const view = { pathname: () => path, navigate: vi.fn(), curtain: vi.fn() };
  return { scope, project, view,
    launch: new RoomLaunchCoordinator(scope, project, () => undefined, view),
    leave: () => { active = false; }, setPath: (value: string) => { path = value; } };
};
afterEach(() => vi.useRealTimers());

it("opens a prepared room once even when duplicate start snapshots arrive", () => {
  vi.useFakeTimers();
  const { launch, view } = setup();
  launch.observe(snapshot(), [localSong]);
  launch.observe(snapshot(), [localSong]);
  expect(view.curtain).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(400);
  expect(view.navigate).toHaveBeenCalledOnce();
});

it("does not navigate after leave wins against an in-flight opening", () => {
  vi.useFakeTimers();
  const { launch, view, leave } = setup();
  launch.observe(snapshot(), [localSong]);
  leave();
  launch.stop();
  vi.advanceTimersByTime(500);
  expect(view.navigate).not.toHaveBeenCalled();
  expect(view.curtain).toHaveBeenLastCalledWith(false);
});

it("keeps one project transfer across a connection recovery for the same selection", async () => {
  const { launch, project } = setup();
  launch.observe(snapshot(), []);
  launch.observe({ ...snapshot(), connectionStatus: "reconnecting" }, []);
  expect(project.prepare).toHaveBeenCalledOnce();
});
