import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { SongDto } from '../../../../contracts/models';
import { VirtualGrid } from './index';

const song: SongDto = {
  id: 'song',
  title: 'Visible song',
  artist: 'Singer',
  language: 'English',
  status: 'ready',
  durationSeconds: 60,
  createdAt: '2026-01-01',
  coverState: 'Fallback',
  activeRevision: 1,
  projectFormatVersion: 1,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('restores cards after the minimized window reports zero-sized elements', () => {
  let size = 600;
  const observers = new Set<() => void>();
  vi.stubGlobal(
    'ResizeObserver',
    class implements ResizeObserver {
      targets = new Set<Element>();
      constructor(callback: ResizeObserverCallback) {
        this.notify = () =>
          callback(
            [...this.targets].map((target) => ({
              target,
              contentRect: new DOMRect(0, 0, size, size),
              borderBoxSize: [{ inlineSize: size, blockSize: size }],
              contentBoxSize: [{ inlineSize: size, blockSize: size }],
              devicePixelContentBoxSize: [
                { inlineSize: size, blockSize: size },
              ],
            })),
            this,
          );
        observers.add(this.notify);
      }
      notify: () => void;
      observe(target: Element) {
        this.targets.add(target);
      }
      unobserve(target: Element) {
        this.targets.delete(target);
      }
      disconnect() {
        observers.delete(this.notify);
      }
    },
  );
  for (const property of [
    'offsetWidth',
    'offsetHeight',
    'clientWidth',
  ] as const)
    vi.spyOn(HTMLElement.prototype, property, 'get').mockImplementation(
      () => size,
    );
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(0, 0, size, size),
  );

  const scroll = { current: document.body };
  const rowHeightReads = vi.fn();
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(
    function (this: HTMLElement) {
      if (this.hasAttribute('data-index')) rowHeightReads();
      return size;
    },
  );
  render(
    <VirtualGrid
      items={[song]}
      scrollParent={scroll}
      itemKey={(item) => item.id}
      renderItem={(item) => <span>{item.title}</span>}
      label="Songs"
    />,
  );

  expect(screen.getByText(song.title)).toBeInTheDocument();
  expect(rowHeightReads).not.toHaveBeenCalled();
  act(() => {
    [...observers].forEach((notify) => notify());
  });
  expect(screen.getByRole('list', { name: 'Songs' })).toHaveStyle({
    height: '600px',
  });
  for (let cycle = 0; cycle < 3; cycle++) {
    for (const nextSize of [0, 600]) {
      act(() => {
        size = nextSize;
        [...observers].forEach((notify) => notify());
      });
    }
    expect(screen.getByText(song.title)).toBeInTheDocument();
  }
});
