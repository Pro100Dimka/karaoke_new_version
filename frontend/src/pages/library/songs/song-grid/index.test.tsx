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
      constructor(callback: ResizeObserverCallback) {
        this.notify = () => callback([], this);
        observers.add(this.notify);
      }
      notify: () => void;
      observe() {}
      unobserve() {}
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
