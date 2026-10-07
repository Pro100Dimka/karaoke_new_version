import type { RoomStateDto, SongDto } from "../../contracts/models";
import { routes } from "../../shared/routes";
import type { RoomSessionScope } from "./RoomSessionController";
import { roomKaraokeNavigation } from "./roomNavigation";

type Selection = { songId: string; revision: number };
type Launch =
  | { type: "idle" }
  | { type: "preparing"; selection: Selection }
  | { type: "opening"; selection: Selection; timer: ReturnType<typeof setTimeout> }
  | { type: "opened"; selection: Selection }
  | { type: "failed"; selection: Selection };
type ProjectPreparation = {
  prepare(songId: string, revision: number): Promise<readonly SongDto[] | undefined>;
  cancel(): void;
};
type RoomView = {
  pathname(): string;
  navigate(songId: string): void;
  curtain(visible: boolean): void;
};

const selected = (room: RoomStateDto): Selection | undefined =>
  room.songId && room.revision !== undefined
    ? { songId: room.songId, revision: room.revision } : undefined;
const same = (a?: Selection, b?: Selection): boolean =>
  a?.songId === b?.songId && a?.revision === b?.revision;

/** Decides when a local copy may open without taking authority from the Room Server. */
export class RoomLaunchCoordinator {
  private selection?: Selection;
  private completed?: Selection;
  private launch: Launch = { type: "idle" };

  constructor(
    private readonly scope: RoomSessionScope,
    private readonly project: ProjectPreparation,
    private readonly localCopy: (songId?: string, revision?: number) => string | undefined,
    private readonly view: RoomView,
  ) {}

  selectionChanged(room: RoomStateDto): void {
    const next = selected(room);
    if (same(next, this.selection)) return;
    this.cancel();
    this.selection = next;
  }

  recordPlaybackTransition(before: RoomStateDto, after: RoomStateDto): void {
    const next = selected(after);
    if (!next) {
      this.completed = undefined;
      return;
    }
    if (["playing", "paused"].includes(before.playbackState ?? "") &&
        after.playbackState === "stopped") this.completed = next;
    else if (same(this.completed, next) && after.participants.some((person) =>
      person.connected && person.readiness !== "ready")) this.completed = undefined;
  }

  observe(snapshot: RoomStateDto, library: readonly SongDto[]): void {
    if (!this.scope.isCurrent()) return;
    this.selectionChanged(snapshot);
    const next = this.selection;
    if (!next) return;
    const pathname = this.view.pathname();
    const decision = roomKaraokeNavigation(
      snapshot, pathname, library, this.localCopy(next.songId, next.revision),
      this.completed ? `${this.completed.songId}:${this.completed.revision}` : undefined,
    );
    if (decision.kind === "stay") {
      if (pathname === routes.karaoke(snapshot.songId ?? "")) {
        this.launch = { type: "idle" };
        const current = this.scope.getRoom();
        if (current) this.scope.setSnapshot({ ...current, transferProgress: undefined,
          transferId: undefined, transferBytes: undefined, transferTotalBytes: undefined,
          transferError: undefined });
      }
      return;
    }
    if (this.launch.type !== "idle" && same(this.launch.selection, next)) {
      if (this.launch.type !== "failed" || snapshot.participants.find((person) => person.self)?.readiness === "failed")
        return;
    }
    this.cancel();
    if (decision.kind === "open") {
      this.view.curtain(true);
      const timer = setTimeout(() => {
        if (!this.scope.isCurrent() || this.launch.type !== "opening" ||
            !same(this.launch.selection, next)) return;
        this.view.navigate(decision.songId);
        this.view.curtain(false);
        this.launch = { type: "opened", selection: next };
      }, 400);
      this.launch = { type: "opening", selection: next, timer };
      return;
    }
    this.launch = { type: "preparing", selection: next };
    void this.project.prepare(decision.songId, decision.revision).then((songs) => {
      if (!this.scope.isCurrent() || this.launch.type !== "preparing" ||
          !same(this.launch.selection, next)) return;
      this.launch = songs ? { type: "idle" } : { type: "failed", selection: next };
      if (songs) this.observe(this.scope.getRoom() ?? snapshot, songs);
    });
  }

  cancel(): void {
    const previous = this.launch;
    this.launch = { type: "idle" };
    if (previous.type === "opening") {
      clearTimeout(previous.timer);
      this.view.curtain(false);
    }
    if (previous.type === "preparing") this.project.cancel();
  }

  stop(): void {
    this.cancel();
  }
}
