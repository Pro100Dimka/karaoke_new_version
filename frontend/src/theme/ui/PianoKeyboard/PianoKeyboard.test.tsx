import { fireEvent, render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { HTMLAttributes } from "react";
import PianoKeyboard from "./index";

const renders = vi.hoisted(() => vi.fn());
vi.mock("../_internal/Primitive", () => ({
  default: ({ sx: _sx, ...props }: HTMLAttributes<HTMLDivElement> & { sx?: unknown }) => {
    renders();
    return <div {...props} />;
  },
}));

it("skips unchanged frames while updating pitch, geometry and audition callbacks", () => {
  const props = { minMidi: 60, maxMidi: 72, height: 130, rowHeight: 10, width: 76 };
  const oldAudition = vi.fn();
  const nextAudition = vi.fn();
  const view = render(<PianoKeyboard {...props} auditionNote={oldAudition} />);
  const initialRenders = renders.mock.calls.length;
  for (let frame = 0; frame < 60; frame++) view.rerender(<PianoKeyboard {...props} auditionNote={oldAudition} />);
  expect(renders).toHaveBeenCalledTimes(initialRenders);
  view.rerender(<PianoKeyboard {...props} activeMidi={60} activeHit width={90} auditionNote={nextAudition} />);
  const key = view.container.querySelector('[data-active-pitch="true"]');
  expect(key).toHaveTextContent("C4");
  expect(view.container.querySelector('[data-role="piano-keyboard"]')).toHaveStyle({ width: "90px" });
  fireEvent.pointerDown(key!);
  expect(nextAudition).toHaveBeenCalledWith(60, 220);
  expect(oldAudition).not.toHaveBeenCalled();
});
