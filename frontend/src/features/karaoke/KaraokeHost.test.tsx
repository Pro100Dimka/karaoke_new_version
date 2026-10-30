import { store } from "../../providers/store";
import { createContext, useEffect, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { TestRouter } from "../../test/QueryProvider";
import { useRouter } from "@neo-ui-kit/react";
import { beforeEach, expect, it, vi } from "vitest";
import { KaraokeHost } from "./KaraokeHost";
import { useKaraokeTv } from "./tv/karaokeTv";

const calls = vi.hoisted(() => ({
  prepare: vi.fn(),
  release: vi.fn(),
  close: vi.fn(),
  finished: undefined as
    undefined | ((songId: string, takeId?: string) => void),
}));
vi.mock("../../providers/application", () => ({ useApp: () => ({ room: null }) }));
vi.mock("../../app/desktop/shellBus", () => ({
  useDisplayCount: () => 2,
  karaokeOnTv: { set: vi.fn() },
}));
vi.mock("./tv/useTvWindow", () => ({
  useTvWindow: () => ({
    open: () => true,
    close: calls.close,
    screen: null,
  }),
}));
vi.mock("./KaraokePage", () => ({
  KaraokeSlotContext: createContext(() => undefined),
  KaraokeScreen: ({ onFinished }: { onFinished: typeof calls.finished }) => {
    calls.finished = onFinished;
    const [position, setPosition] = useState(0);
    useEffect(() => {
      calls.prepare();
      return calls.release;
    }, []);
    return <button onClick={() => setPosition(42)}>Position {position}</button>;
  },
}));

beforeEach(() => vi.clearAllMocks());

it.each(["history", "hash"] as const)("keeps one session and song position through TV navigation (%s)", async mode => {
  function Remote() {
    const tv = useKaraokeTv()!;
    return (
      <button onClick={tv.active ? tv.bringBack : tv.send}>
        {tv.active ? "Return" : "TV"}
      </button>
    );
  }
  render(
    <TestRouter mode={mode} initialEntries={["/karaoke/song"]} routes={[{ path: "/karaoke/:songId", element: <KaraokeHost><Remote /></KaraokeHost> }, { path: "*", element: <KaraokeHost><Remote /></KaraokeHost> }]}>
      <KaraokeHost>
        <Remote />
      </KaraokeHost>
    </TestRouter>,
  );
  fireEvent.click(screen.getByText("Position 0"));
  fireEvent.click(screen.getByText("TV"));
  await waitFor(() => expect(mode === "hash" ? window.location.hash : window.location.pathname).toBe(mode === "hash" ? "#/" : "/"));
  expect(screen.getByText("Position 42")).toBeInTheDocument();
  fireEvent.click(screen.getByText("Return"));
  await waitFor(() => expect(mode === "hash" ? window.location.hash : window.location.pathname).toBe(mode === "hash" ? "#/karaoke/song" : "/karaoke/song"));
  expect(screen.getByText("Position 42")).toBeInTheDocument();
  expect(calls.prepare).toHaveBeenCalledOnce();
  expect(calls.release).not.toHaveBeenCalled();
});

it("returns a finished solo performance with its analysis on the next tick", () => {
  cleanup();
  vi.useFakeTimers();
  function Location() {
    const location = useRouter();
    return <output>{JSON.stringify({ pathname: location.pathname, state: store.playback.returned })}</output>;
  }
  const view = render(
    <TestRouter initialEntries={["/karaoke/song"]} routes={[{ path: "/karaoke/:songId", element: <KaraokeHost><Location /></KaraokeHost> }, { path: "*", element: <KaraokeHost><Location /></KaraokeHost> }]}>
      <KaraokeHost>
        <Location />
      </KaraokeHost>
    </TestRouter>,
  );
  act(() => calls.finished!("song", "take"));
  expect(view.container.querySelector(".sceneCurtain")).toBeInTheDocument();
  expect(screen.getByRole("status").textContent).toContain("/karaoke/song");
  act(() => vi.advanceTimersByTime(0));
  expect(screen.getByRole("status").textContent).toContain(
    '"performanceReturn":true',
  );
  expect(screen.getByRole("status").textContent).toContain(
    '"analysisFor":"take"',
  );
  vi.useRealTimers();
});
