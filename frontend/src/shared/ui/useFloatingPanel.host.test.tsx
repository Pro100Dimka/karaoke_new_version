import { cleanup, fireEvent, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resizeEdges, type FloatingPanelOptions } from '@neo-ui-kit/react';
import { HostWindowContext } from './hostWindow';
import { useFloatingPanel, type PanelLayout } from './useFloatingPanel';

const release: (() => void)[] = [];
const initial = { left: 100, top: 100, width: 200, height: 100 };
beforeEach(() => {
  vi.stubGlobal('innerWidth', 800);
  vi.stubGlobal('innerHeight', 600);
});
afterEach(() => {
  cleanup();
  for (const stop of release.splice(0).reverse()) stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const television = (): Window => {
  const iframe = document.createElement('iframe');
  document.body.append(iframe);
  release.push(() => iframe.remove());
  const host = iframe.contentWindow;
  if (!host) throw new Error('TV window unavailable');
  Object.assign(host, { innerWidth: 1400, innerHeight: 900 });
  return host;
};
const pointer = (target: Element, type: string, x: number, y: number) => {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons: type === 'pointerup' ? 0 : 1,
    clientX: x,
    clientY: y,
    screenX: 3000 + x,
    screenY: 100 + y,
  });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  fireEvent(target, event);
};
const element = (root: ParentNode, selector: string): HTMLElement => {
  const found = root.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`Missing test element: ${selector}`);
  return found;
};

const Frame = ({ options }: { options: FloatingPanelOptions }) => {
  const ref = useRef<HTMLDivElement>(null);
  const floating = useFloatingPanel(ref, options);
  return (
    <div
      ref={ref}
      data-testid="frame"
      data-active={floating.active}
      style={floating.layout ?? undefined}
      onPointerDown={floating.beginMove}
      onPointerMove={floating.handleMove}
      onPointerUp={floating.handleUp}
      onPointerCancel={floating.handleCancel}
      onKeyDown={(event) => floating.handleKeyDown(event, true)}
      tabIndex={0}
    >
      <label>
        <input />
      </label>
      <button>Control</button>
      <div contentEditable suppressContentEditableWarning>
        Text
      </div>
      <span className="ignore-zone">Ignored</span>
      {resizeEdges.map((edge) => (
        <span
          key={edge}
          data-edge={edge}
          onPointerDown={floating.beginResize(edge)}
        />
      ))}
    </div>
  );
};
const openFrame = (host: Window, options: FloatingPanelOptions = {}) => {
  const container = host.document.createElement('div');
  host.document.body.append(container);
  release.push(() => container.remove());
  const props = { layout: initial, ...options };
  const view = render(
    <HostWindowContext.Provider value={host}>
      <Frame options={props} />
    </HostWindowContext.Provider>,
    { container },
  );
  return {
    frame: element(container, '[data-testid="frame"]'),
    setHost(next: Window) {
      next.document.body.append(container);
      view.rerender(
        <HostWindowContext.Provider value={next}>
          <Frame options={props} />
        </HostWindowContext.Provider>,
      );
    },
  };
};
const expectLayout = (frame: HTMLElement, layout: PanelLayout) =>
  expect({
    left: frame.style.left,
    top: frame.style.top,
    width: frame.style.width,
    height: frame.style.height,
  }).toEqual({
    left: `${layout.left}px`,
    top: `${layout.top}px`,
    width: `${layout.width}px`,
    height: `${layout.height}px`,
  });

it.each(['main', 'tv'])(
  'preserves %s threshold, control guards and pointer cancellation',
  (surface) => {
    const saved = vi.fn();
    const { frame } = openFrame(surface === 'main' ? window : television(), {
      onLayoutChange: saved,
      ignore: '.ignore-zone',
    });
    for (const selector of [
      'label',
      'input',
      'button',
      '[contenteditable]',
      '.ignore-zone',
    ]) {
      pointer(element(frame, selector), 'pointerdown', 110, 110);
      pointer(frame, 'pointermove', 150, 150);
      pointer(frame, 'pointerup', 150, 150);
      expectLayout(frame, initial);
    }
    pointer(frame, 'pointerdown', 110, 110);
    pointer(frame, 'pointermove', 113, 113);
    expectLayout(frame, initial);
    pointer(frame, 'pointermove', 160, 150);
    expectLayout(frame, { ...initial, left: 150, top: 140 });
    pointer(frame, 'pointercancel', 160, 150);
    expectLayout(frame, initial);
    expect(saved).not.toHaveBeenCalled();
  },
);

it('moves across the TV viewport without tearing off at the laptop edge', () => {
  const outside = vi.fn();
  const { frame } = openFrame(television(), { onDragOutside: outside });
  pointer(frame, 'pointerdown', 110, 110);
  pointer(frame, 'pointermove', 1010, 650);
  expect(outside).not.toHaveBeenCalled();
  expectLayout(frame, { ...initial, left: 1000, top: 640 });
  pointer(frame, 'pointermove', 1410, 650);
  expect(outside).toHaveBeenCalledExactlyOnceWith(
    { ...initial, left: 4400, top: 740 },
    { screenX: 4410, screenY: 750 },
  );
});

it('clamps and subscribes to the current viewport, then releases TV listeners on return', () => {
  const tv = television();
  const mainListen = vi.spyOn(window, 'addEventListener');
  const tvListen = vi.spyOn(tv, 'addEventListener');
  const tvRemove = vi.spyOn(tv, 'removeEventListener');
  const { frame, setHost } = openFrame(tv, {
    layout: { left: 1300, top: 850, width: 300, height: 200 },
  });
  expectLayout(frame, { left: 1100, top: 700, width: 300, height: 200 });
  expect(tvListen.mock.calls.some(([type]) => type === 'resize')).toBe(true);
  expect(mainListen.mock.calls.some(([type]) => type === 'resize')).toBe(false);
  Object.assign(tv, { innerWidth: 1200, innerHeight: 800 });
  fireEvent(tv, new Event('resize'));
  expectLayout(frame, { left: 900, top: 600, width: 300, height: 200 });
  setHost(window);
  expectLayout(frame, { left: 500, top: 400, width: 300, height: 200 });
  expect(tvRemove.mock.calls.some(([type]) => type === 'resize')).toBe(true);
});

it.each(resizeEdges)('preserves the %s resize edge on both windows', (edge) => {
  for (const host of [window, television()]) {
    const saved = vi.fn();
    const { frame } = openFrame(host, { onLayoutChange: saved });
    pointer(element(frame, `[data-edge="${edge}"]`), 'pointerdown', 110, 110);
    pointer(frame, 'pointermove', 140, 130);
    pointer(frame, 'pointerup', 140, 130);
    const expected = {
      left: 100 + (edge.includes('w') ? 30 : 0),
      top: 100 + (edge.includes('n') ? 20 : 0),
      width: 200 + (edge.includes('e') ? 30 : edge.includes('w') ? -30 : 0),
      height: 100 + (edge.includes('s') ? 20 : edge.includes('n') ? -20 : 0),
    };
    expectLayout(frame, expected);
    expect(saved).toHaveBeenCalledExactlyOnceWith(expected);
  }
});

it.each(['main', 'tv'])(
  'preserves %s keyboard moves, resize limits and control input',
  (surface) => {
    const { frame } = openFrame(surface === 'main' ? window : television(), {
      limits: { minWidth: 190, maxWidth: 210, minHeight: 90, maxHeight: 110 },
    });
    fireEvent.keyDown(element(frame, 'input'), { key: 'ArrowRight' });
    expectLayout(frame, initial);
    fireEvent.keyDown(frame, { key: 'ArrowRight' });
    fireEvent.keyDown(frame, { key: 'ArrowUp' });
    fireEvent.keyDown(frame, { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(frame, { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(frame, { key: 'ArrowUp', shiftKey: true });
    fireEvent.keyDown(frame, { key: 'ArrowUp', shiftKey: true });
    expectLayout(frame, { left: 110, top: 90, width: 210, height: 90 });
    for (let step = 0; step < 3; step++) {
      fireEvent.keyDown(frame, { key: 'ArrowLeft', shiftKey: true });
      fireEvent.keyDown(frame, { key: 'ArrowDown', shiftKey: true });
    }
    expectLayout(frame, { left: 110, top: 90, width: 190, height: 110 });
  },
);

it('deactivates only outside the TV panel, accepting nodes from its own realm', () => {
  const tv = television();
  const { frame } = openFrame(tv);
  pointer(frame, 'pointerdown', 110, 110);
  pointer(frame, 'pointerup', 110, 110);
  expect(frame).toHaveAttribute('data-active', 'true');
  pointer(element(frame, 'label'), 'pointerdown', 110, 110);
  expect(frame).toHaveAttribute('data-active', 'true');
  pointer(tv.document.body, 'pointerdown', 500, 500);
  expect(frame).toHaveAttribute('data-active', 'false');
});

it('resets a pending gesture when its screen changes windows', () => {
  const { frame, setHost } = openFrame(television());
  pointer(frame, 'pointerdown', 110, 110);
  pointer(frame, 'pointermove', 160, 150);
  expectLayout(frame, { ...initial, left: 150, top: 140 });
  setHost(window);
  pointer(frame, 'pointermove', 180, 170);
  expectLayout(frame, initial);
});
