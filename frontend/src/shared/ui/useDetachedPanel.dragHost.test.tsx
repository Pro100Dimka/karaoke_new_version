import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useLayoutEffect, useRef, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DetachedPanel } from './DetachedPanel';
import { HostWindowContext } from './hostWindow';
import { useDetachedPanel } from './useDetachedPanel';
import { useFloatingPanel, type PanelLayout } from './useFloatingPanel';

const release: (() => void)[] = [];
const initial = { left: 100, top: 100, width: 200, height: 100 };
class BrowserPointer extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;
  constructor(type: string, options: PointerEventInit = {}) {
    super(type, options);
    this.pointerId = options.pointerId ?? 1;
    this.pointerType = options.pointerType ?? 'mouse';
  }
}
beforeEach(() => {
  vi.stubGlobal('PointerEvent', BrowserPointer);
  for (const [name, value] of Object.entries({
    innerWidth: 800,
    innerHeight: 600,
    outerWidth: 816,
    outerHeight: 640,
    screenX: 80,
    screenY: 40,
  }))
    vi.stubGlobal(name, value);
});
afterEach(() => {
  cleanup();
  window.dispatchEvent(new Event('pointerup'));
  for (const stop of release.splice(0).reverse()) stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const childWindow = (
  left: number,
  top: number,
  width: number,
  height: number,
): Window => {
  const iframe = document.createElement('iframe');
  document.body.append(iframe);
  release.push(() => {
    iframe.contentWindow?.dispatchEvent(new Event('pointerup'));
    iframe.remove();
  });
  const host = iframe.contentWindow;
  if (!host) throw new Error('Child window unavailable');
  Object.assign(host, {
    screenX: left,
    screenY: top,
    innerWidth: width,
    innerHeight: height,
    outerWidth: width,
    outerHeight: height,
  });
  const prototype = Object.getPrototypeOf(
    Object.getPrototypeOf(host.document.createElement('div')),
  );
  Object.assign(prototype, {
    setPointerCapture: () => undefined,
    hasPointerCapture: () => false,
  });
  return host;
};
const mockPanel = () => {
  const panel = childWindow(0, 0, 200, 100);
  vi.spyOn(window, 'open').mockImplementation((_url, _name, features) => {
    const bounds = Object.fromEntries(
      (features ?? '').split(',').map((part) => {
        const [name, value] = part.split('=');
        return [name ?? '', Number(value)];
      }),
    );
    Object.assign(panel, {
      screenX: bounds.left,
      screenY: bounds.top,
      innerWidth: bounds.width,
      innerHeight: bounds.height,
    });
    return panel;
  });
  vi.spyOn(panel, 'close').mockImplementation(() => {
    Object.assign(panel, { closed: true });
    panel.dispatchEvent(new Event('pagehide'));
  });
  const move = vi.spyOn(panel, 'moveTo').mockImplementation((left, top) => {
    Object.assign(panel, { screenX: left, screenY: top });
  });
  return { panel, move };
};
const pointer = (
  target: Window | HTMLElement,
  type: string,
  screenX: number,
  screenY: number,
  clientX = 0,
  clientY = 0,
) => {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons: type === 'pointerup' ? 0 : 1,
    pointerId: 7,
    pointerType: 'mouse',
    screenX,
    screenY,
    clientX,
    clientY,
  });
  fireEvent(target, event);
  return event;
};
const at = (host: Window, x: number, y: number): [number, number] =>
  host === window ? [88 + x, 72 + y] : [2000 + x, 100 + y];

const Panel = ({
  id,
  returned,
}: {
  id: string;
  returned(layout: PanelLayout): void;
}) => {
  const frame = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState(initial);
  const panel = useDetachedPanel(id, 'Panel', initial, (next) => {
    returned(next);
    setLayout(next);
  });
  const floating = useFloatingPanel(frame, {
    layout,
    onLayoutChange: setLayout,
    onDragOutside: (bounds, held) => panel.detach(bounds, held),
  });
  useLayoutEffect(() => {
    if (panel.detached) floating.handleCancel();
    else panel.resumeDrag(frame.current);
  });
  return (
    <DetachedPanel panel={panel} keepMounted>
      <div
        ref={frame}
        data-testid="frame"
        data-detached={panel.detached}
        style={panel.detached ? undefined : (floating.layout ?? undefined)}
        onPointerDown={panel.detached ? undefined : floating.beginMove}
        onPointerMove={panel.detached ? undefined : floating.handleMove}
        onPointerUp={panel.detached ? undefined : floating.handleUp}
        onPointerCancel={panel.detached ? undefined : floating.handleCancel}
      >
        Panel
      </div>
    </DetachedPanel>
  );
};
const openPanel = (host?: Window, id = 'karaokeConsole') => {
  const returned = vi.fn();
  const owner = host ?? window;
  const container = owner.document.createElement('div');
  owner.document.body.append(container);
  release.push(() => container.remove());
  const tree = (current: Window | undefined) =>
    current ? (
      <HostWindowContext.Provider value={current}>
        <Panel id={id} returned={returned} />
      </HostWindowContext.Provider>
    ) : (
      <Panel id={id} returned={returned} />
    );
  const view = render(tree(host), { container });
  const frame = container.querySelector<HTMLElement>('[data-testid="frame"]');
  if (!frame) throw new Error('Panel frame unavailable');
  return {
    frame,
    returned,
    setHost(next: Window) {
      next.document.body.append(container);
      view.rerender(tree(next));
    },
  };
};
const tearOff = async (frame: HTMLElement, host: Window) => {
  const left = parseFloat(frame.style.left) || initial.left;
  const top = parseFloat(frame.style.top) || initial.top;
  pointer(
    frame,
    'pointerdown',
    ...at(host, left + 10, top + 10),
    left + 10,
    top + 10,
  );
  await act(async () => {
    pointer(
      frame,
      'pointermove',
      ...at(host, host.innerWidth + 50, 150),
      host.innerWidth + 50,
      150,
    );
  });
  expect(frame.getAttribute('data-detached')).toBe('true');
};

it.each(['pianoRoll', 'karaokeConsole'])(
  'carries %s from the TV pointer until that host releases it',
  async (id) => {
    const tv = childWindow(2000, 100, 1400, 900);
    const { panel, move } = mockPanel();
    const { frame } = openPanel(tv, id);
    await tearOff(frame, tv);
    move.mockClear();

    pointer(tv, 'pointermove', ...at(tv, 1500, 200));

    expect(move).toHaveBeenLastCalledWith(3490, 290);
    expect(panel.screenX).toBe(3490);
    move.mockClear();
    pointer(window, 'pointermove', 3600, 400);
    expect(move).not.toHaveBeenCalled();
    pointer(tv, 'pointerup', ...at(tv, 1500, 200));
    move.mockClear();
    pointer(tv, 'pointermove', ...at(tv, 1550, 250));
    expect(move).not.toHaveBeenCalled();
  },
);

it('keeps carry, reentry and resumed dragging on the main window by default', async () => {
  const { panel, move } = mockPanel();
  const { frame, returned } = openPanel();
  await tearOff(frame, window);
  move.mockClear();

  pointer(window, 'pointermove', ...at(window, 900, 200));
  expect(move).toHaveBeenLastCalledWith(978, 262);
  pointer(panel, 'pointermove', ...at(window, 300, 200));

  expect(returned).toHaveBeenCalledExactlyOnceWith({
    left: 290,
    top: 190,
    width: 200,
    height: 100,
  });
  expect(frame.getAttribute('data-detached')).toBe('false');
  pointer(frame, 'pointermove', ...at(window, 350, 250), 350, 250);
  expect({ left: frame.style.left, top: frame.style.top }).toEqual({
    left: '340px',
    top: '240px',
  });
  pointer(frame, 'pointerup', ...at(window, 350, 250), 350, 250);
});

it('reenters the TV during a console drag and resumes using TV client coordinates', async () => {
  const tv = childWindow(2000, 100, 1400, 900);
  const { panel } = mockPanel();
  const { frame, returned } = openPanel(tv);
  await tearOff(frame, tv);
  const resumed = vi.fn();
  frame.addEventListener('pointerdown', resumed);

  pointer(panel, 'pointermove', ...at(tv, 1000, 400));

  expect(returned).toHaveBeenCalledExactlyOnceWith({
    left: 990,
    top: 390,
    width: 200,
    height: 100,
  });
  expect(frame.getAttribute('data-detached')).toBe('false');
  expect(resumed).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      pointerId: 7,
      clientX: 1000,
      clientY: 400,
      screenX: 3000,
      screenY: 500,
    }),
  );
  pointer(frame, 'pointermove', ...at(tv, 1050, 450), 1050, 450);
  expect({ left: frame.style.left, top: frame.style.top }).toEqual({
    left: '1040px',
    top: '440px',
  });
  pointer(frame, 'pointerup', ...at(tv, 1050, 450), 1050, 450);
});

it('drops detached notes into the TV at the release position', async () => {
  const tv = childWindow(2000, 100, 1400, 900);
  const { panel } = mockPanel();
  const { frame, returned } = openPanel(tv, 'pianoRoll');
  await tearOff(frame, tv);
  pointer(tv, 'pointerup', panel.screenX + 10, panel.screenY + 10);
  pointer(frame, 'pointerdown', panel.screenX + 10, panel.screenY + 10);
  pointer(frame, 'pointermove', ...at(tv, 1000, 400));
  pointer(frame, 'pointerup', ...at(tv, 1000, 400));
  expect(returned).toHaveBeenCalledExactlyOnceWith({
    left: 990,
    top: 390,
    width: 200,
    height: 100,
  });
  expect(frame.getAttribute('data-detached')).toBe('false');
});

it.each(['main-to-tv', 'tv-to-main'])(
  'returns an already open console after %s host change',
  async (direction) => {
    const tv = childWindow(2000, 100, 1400, 900);
    const from = direction === 'main-to-tv' ? window : tv;
    const to = direction === 'main-to-tv' ? tv : window;
    const { panel } = mockPanel();
    const { frame, returned, setHost } = openPanel(from);
    await tearOff(frame, from);
    pointer(from, 'pointerup', panel.screenX + 10, panel.screenY + 10);
    setHost(to);
    pointer(frame, 'pointerdown', panel.screenX + 10, panel.screenY + 10);

    pointer(panel, 'pointermove', ...at(to, 300, 200));

    expect(returned).toHaveBeenCalledExactlyOnceWith({
      left: 290,
      top: 190,
      width: 200,
      height: 100,
    });
    expect(frame.getAttribute('data-detached')).toBe('false');
    pointer(frame, 'pointermove', ...at(to, 350, 250), 350, 250);
    expect({ left: frame.style.left, top: frame.style.top }).toEqual({
      left: '340px',
      top: '240px',
    });
    pointer(frame, 'pointerup', ...at(to, 350, 250), 350, 250);
    expect(window.open).toHaveBeenCalledTimes(1);
  },
);
