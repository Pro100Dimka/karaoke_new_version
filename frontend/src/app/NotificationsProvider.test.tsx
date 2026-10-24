import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NotificationsProvider, useNotify } from "./NotificationsProvider";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it("sounds each notice intent once while allowing an existing participant chime to own its notice", () => {
  vi.useFakeTimers();
  const played: string[] = [];
  vi.stubGlobal("Audio", class {
    volume = 1;
    constructor(private url: string) {}
    play() { played.push(this.url); return Promise.resolve(); }
    pause() {}
  });
  function Controls() {
    const notify = useNotify();
    return <><button onClick={() => notify("Saved", "success")}>Save</button>
      <button onClick={() => notify("Joined", "info", { silent: true })}>Participant</button></>;
  }
  render(<NotificationsProvider><Controls /></NotificationsProvider>);
  fireEvent.click(screen.getByText("Save"));
  expect(played).toHaveLength(1);
  expect(screen.getByText("Saved")).toBeInTheDocument();
  fireEvent.click(screen.getByText("Participant"));
  expect(screen.getByText("Joined")).toBeInTheDocument();
  expect(played).toHaveLength(1);
});
