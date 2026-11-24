import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PianoRollGesture } from '@neo-ui-kit/react';
import { EditorPianoRoll } from './EditorPianoRoll';

const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
beforeEach(() => {
  frames.clear();
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    frames.delete(id);
  });
});
afterEach(() => vi.restoreAllMocks());

const paint = () =>
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(performance.now());
  });

const pointer = (target: Element, type: string, x: number, y = 50) => {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: x,
    clientY: y,
  });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  fireEvent(target, event);
};

const openRoll = (kind: 'move' | 'resize') => {
  const preview = vi.fn<(gesture: PianoRollGesture) => void>();
  const finish = vi.fn();
  const view = render(
    <EditorPianoRoll
      document={{
        revision: 1,
        words: [{ id: 'word', text: 'Voice', start: 0, end: 10 }],
        notes: [{ id: 'note', wordId: 'word', pitch: 60, start: 1, end: 2 }],
      }}
      duration={10}
      minPitch={55}
      maxPitch={79}
      readPosition={() => 0}
      onNoteDrag={preview}
      onNoteDragEnd={finish}
    />,
  );
  const world = view.container.querySelector<HTMLElement>(
    '.ad-piano-roll-world',
  )!;
  vi.spyOn(world, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, 1000, 250),
  );
  const target = world.querySelector(
    kind === 'move' ? '.ad-piano-roll-note-body' : '[data-edge="end"]',
  )!;
  pointer(target, 'pointerdown', 100);
  return { ...view, world, target, preview, finish };
};

it.each(['move', 'resize'] as const)(
  'coalesces a burst of %s samples while keeping the first preview immediate',
  (kind) => {
    const { world, preview } = openRoll(kind);
    for (let sample = 1; sample <= 100; sample++)
      pointer(world, 'pointermove', 100 + sample);
    expect(preview).toHaveBeenCalledTimes(1);
    expect(preview.mock.calls[0]?.[0].seconds).toBe(0.01);
    paint();
    expect(preview).toHaveBeenCalledTimes(2);
    expect(preview.mock.calls[1]?.[0].seconds).toBe(1);
    for (let sample = 1; sample <= 100; sample++)
      pointer(world, 'pointermove', 200 + sample);
    expect(preview).toHaveBeenCalledTimes(2);
    paint();
    expect(preview).toHaveBeenCalledTimes(3);
    expect(preview.mock.calls[2]?.[0].seconds).toBe(2);
  },
);

it.each(['move', 'resize'] as const)(
  'commits the final %s release coordinate before ending and drops queued work',
  (kind) => {
    const { world, preview, finish } = openRoll(kind);
    pointer(world, 'pointermove', 110);
    pointer(world, 'pointermove', 120);
    pointer(world, 'pointerup', 150, 20);
    expect(preview).toHaveBeenLastCalledWith(
      kind === 'move'
        ? { kind: 'move', ids: ['note'], seconds: 0.5, pitch: 3 }
        : { kind: 'resize', id: 'note', edge: 'end', seconds: 0.5 },
    );
    expect(finish).toHaveBeenCalledOnce();
    expect(preview.mock.invocationCallOrder.at(-1)).toBeLessThan(
      finish.mock.invocationCallOrder[0]!,
    );
    const count = preview.mock.calls.length;
    paint();
    expect(preview).toHaveBeenCalledTimes(count);
  },
);

it.each(['Escape', 'pointercancel', 'lostpointercapture'])(
  'discards a queued preview on %s without resurrecting the cancelled drag',
  (cancel) => {
    const { world, preview, finish } = openRoll('move');
    pointer(world, 'pointermove', 110);
    pointer(world, 'pointermove', 120);
    if (cancel === 'Escape') fireEvent.keyDown(world, { key: 'Escape' });
    else pointer(world, cancel, 130);
    expect(preview).toHaveBeenLastCalledWith({
      kind: 'move',
      ids: ['note'],
      seconds: 0,
      pitch: 0,
    });
    expect(finish).toHaveBeenCalledOnce();
    const count = preview.mock.calls.length;
    paint();
    pointer(world, 'pointerup', 140);
    expect(preview).toHaveBeenCalledTimes(count);
    expect(finish).toHaveBeenCalledOnce();
  },
);

it('cancels the scheduled preview on unmount', () => {
  const { world, preview, finish, unmount } = openRoll('move');
  pointer(world, 'pointermove', 110);
  pointer(world, 'pointermove', 120);
  const count = preview.mock.calls.length;
  unmount();
  paint();
  expect(preview).toHaveBeenCalledTimes(count);
  expect(finish).not.toHaveBeenCalled();
});

it.each(['move', 'resize'] as const)(
  'does not create a document preview for a %s click without movement',
  (kind) => {
    const { world, preview, finish } = openRoll(kind);
    pointer(world, 'pointerup', 100);
    expect(preview).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledOnce();
    paint();
    expect(preview).not.toHaveBeenCalled();
  },
);

it('does not schedule a new frame if the immediate preview unmounts the editor', () => {
  const { world, preview, unmount } = openRoll('move');
  preview.mockImplementationOnce(unmount);
  const requests = vi.mocked(window.requestAnimationFrame).mock.calls.length;
  pointer(world, 'pointermove', 110);
  expect(window.requestAnimationFrame).toHaveBeenCalledTimes(requests);
  paint();
  expect(preview).toHaveBeenCalledOnce();
});
