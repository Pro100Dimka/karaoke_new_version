import { QueryProvider } from "../../test/QueryProvider";
import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { SongDto } from "../../contracts/models";
import { KaraokeIntro } from "./KaraokeIntro";

const song = { id: "song", title: "Song", artist: "Artist" } as SongDto;

describe("KaraokeIntro readiness", () => {
  it("stays visible as a loader until the local audio session is prepared", () => {
    vi.useFakeTimers();
    const onStart = vi.fn();
    const onDone = vi.fn();
    const view = render(
      <QueryProvider application>
        <KaraokeIntro
          song={song}
          ready={false}
          onStart={onStart}
          onDone={onDone}
        />
      </QueryProvider>,
    );

    act(() => vi.advanceTimersByTime(10_000));
    expect(onStart).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();

    view.rerender(
      <QueryProvider application>
        <KaraokeIntro song={song} ready onStart={onStart} onDone={onDone} />
      </QueryProvider>,
    );
    act(() => vi.advanceTimersByTime(2_400));
    expect(onStart).toHaveBeenCalledOnce();
    act(() => vi.advanceTimersByTime(800));
    expect(onDone).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
