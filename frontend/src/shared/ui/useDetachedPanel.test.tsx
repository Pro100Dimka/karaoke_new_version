import { act, render, renderHook, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DetachedPanel } from "./DetachedPanel";
import { useDetachedPanel } from "./useDetachedPanel";
import { clearStorage } from "../storage/localStore";

const fakePanelWindow = () => {
  const panelDocument = document.implementation.createHTMLDocument("panel");
  const listeners = new Map<string, () => void>();
  return {
    document: panelDocument,
    closed: false,
    innerWidth: 310,
    innerHeight: 600,
    screenX: 1900,
    screenY: 40,
    close: vi.fn(),
    focus: vi.fn(),
    addEventListener: (name: string, listener: () => void) =>
      listeners.set(name, listener),
    fire: (name: string) => listeners.get(name)?.(),
  };
};

afterEach(() => {
  vi.restoreAllMocks();
  clearStorage();
  document.head
    .querySelectorAll("style[data-test]")
    .forEach((node) => node.remove());
});

it("opens only an empty app panel window and shows the app's styles and theme in it", () => {
  const style = document.createElement("style");
  style.dataset.test = "1";
  style.textContent = ".roomDock { color: red; }";
  document.head.append(style);
  document.documentElement.dataset.theme = "neon";
  const panelWindow = fakePanelWindow();
  const open = vi
    .spyOn(window, "open")
    .mockReturnValue(panelWindow as unknown as Window);

  const { result } = renderHook(() =>
    useDetachedPanel("room", "Room", { width: 300, height: 640 }),
  );
  act(() => result.current.detach());

  expect(open).toHaveBeenCalledWith(
    "about:blank",
    "ad-voice-panel:room",
    "width=300,height=640",
  );
  expect(result.current.detached).toBe(true);
  expect(panelWindow.document.head.textContent).toContain(".roomDock");
  expect(panelWindow.document.documentElement.dataset.theme).toBe("neon");
  expect(result.current.container?.ownerDocument).toBe(panelWindow.document);
});

it("returns the panel when its window closes and reopens it where it was left", () => {
  const first = fakePanelWindow();
  const open = vi
    .spyOn(window, "open")
    .mockReturnValue(first as unknown as Window);
  const { result } = renderHook(() =>
    useDetachedPanel("room", "Room", { width: 300, height: 640 }),
  );
  act(() => result.current.detach());
  act(() => first.fire("pagehide"));
  expect(result.current.detached).toBe(false);

  open.mockReturnValue(fakePanelWindow() as unknown as Window);
  act(() => result.current.detach());
  expect(open).toHaveBeenLastCalledWith(
    "about:blank",
    "ad-voice-panel:room",
    "width=310,height=600,left=1900,top=40",
  );
});

it("renders the panel in its window while detached and in place otherwise", () => {
  const panelWindow = fakePanelWindow();
  vi.spyOn(window, "open").mockReturnValue(panelWindow as unknown as Window);
  const Harness = () => {
    const panel = useDetachedPanel("roll", "Roll", { width: 900, height: 200 });
    return (
      <>
        <button onClick={() => panel.detach()}>detach</button>
        <DetachedPanel panel={panel}>
          <p>notes</p>
        </DetachedPanel>
      </>
    );
  };
  render(<Harness />);
  expect(screen.getByText("notes")).toBeInTheDocument();
  act(() => screen.getByText("detach").click());
  expect(screen.queryByText("notes")).not.toBeInTheDocument();
  expect(panelWindow.document.body.textContent).toContain("notes");
});
