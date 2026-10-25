import { createContext, useEffect, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { KaraokeHost } from "./KaraokeHost";
import { useKaraokeTv } from "./tv/karaokeTv";

const calls = vi.hoisted(() => ({
  prepare: vi.fn(),
  release: vi.fn(),
  close: vi.fn(),
  finished: undefined as
    undefined | ((songId: string, takeId?: string) => void),
}));
vi.mock("../../app/AppContext", () => ({ useApp: () => ({ room: null }) }));
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
  parseKaraokeMode: () => "Rehearsal",
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

it("keeps one session and its song position when returning from TV through a router transition", () => {
  function Remote() {
    const tv = useKaraokeTv()!;
    return (
      <button onClick={tv.active ? tv.bringBack : tv.send}>
        {tv.active ? "Return" : "TV"}
      </button>
    );
  }
  render(
    <MemoryRouter initialEntries={["/karaoke/song"]}>
      <KaraokeHost>
        <Remote />
      </KaraokeHost>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByText("Position 0"));
  fireEvent.click(screen.getByText("TV"));
  expect(screen.getByText("Position 42")).toBeInTheDocument();
  fireEvent.click(screen.getByText("Return"));
  expect(screen.getByText("Position 42")).toBeInTheDocument();
  expect(calls.prepare).toHaveBeenCalledOnce();
  expect(calls.release).not.toHaveBeenCalled();
});

it("darkens the finished performance before returning with its analysis beneath the curtain", () => {
  cleanup();
  vi.useFakeTimers();
  function Location() {
    const location = useLocation();
    return <output>{JSON.stringify(location)}</output>;
  }
  const view = render(
    <MemoryRouter initialEntries={["/karaoke/song"]}>
      <KaraokeHost>
        <Location />
      </KaraokeHost>
    </MemoryRouter>,
  );
  act(() => calls.finished!("song", "take"));
  expect(view.container.querySelector(".sceneCurtain")).toBeInTheDocument();
  expect(screen.getByRole("status").textContent).toContain("/karaoke/song");
  act(() => vi.advanceTimersByTime(399));
  expect(screen.getByRole("status").textContent).toContain("/karaoke/song");
  act(() => vi.advanceTimersByTime(1));
  expect(screen.getByRole("status").textContent).toContain(
    '"performanceReturn":true',
  );
  expect(screen.getByRole("status").textContent).toContain(
    '"analysisFor":"take"',
  );
  vi.useRealTimers();
});
