import { act, cleanup, render, screen } from '@testing-library/react';
import { StrictMode, useRef } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useNearView } from './useNearView';

class Observer {
  static instances: Observer[] = [];
  observed = new Set<Element>();
  disconnect = vi.fn(() => this.observed.clear());
  observe = vi.fn((element: Element) => this.observed.add(element));
  unobserve = vi.fn((element: Element) => this.observed.delete(element));
  constructor(
    readonly callback: IntersectionObserverCallback,
    readonly options: IntersectionObserverInit,
  ) {
    Observer.instances.push(this);
  }
  emit(targets: Element[], isIntersecting = true) {
    this.callback(
      targets.map((target) => ({
        target,
        isIntersecting,
      })) as IntersectionObserverEntry[],
      this as unknown as IntersectionObserver,
    );
  }
}

const Item = ({ id, margin }: { id: number; margin?: string }) => {
  const ref = useRef<HTMLDivElement>(null);
  const near = useNearView(ref, margin);
  return <div ref={ref} data-testid={`item-${id}`} data-near={near} />;
};

beforeEach(() => {
  Observer.instances = [];
  vi.stubGlobal('IntersectionObserver', Observer);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('shares one visibility observer across 500 deferred recording players', () => {
  const view = render(
    <>
      {Array.from({ length: 500 }, (_, id) => (
        <Item key={id} id={id} />
      ))}
    </>,
  );
  expect(Observer.instances).toHaveLength(1);
  const observer = Observer.instances[0]!;
  expect(observer.observed.size).toBe(500);
  const first = screen.getByTestId('item-0');
  const last = screen.getByTestId('item-499');
  act(() => observer.emit([first], false));
  expect(first).toHaveAttribute('data-near', 'false');
  act(() => observer.emit([first, last]));
  expect(first).toHaveAttribute('data-near', 'true');
  expect(last).toHaveAttribute('data-near', 'true');
  expect(screen.getByTestId('item-1')).toHaveAttribute('data-near', 'false');
  expect(observer.observed.size).toBe(498);
  expect(observer.disconnect).not.toHaveBeenCalled();
  act(() => observer.emit([first], false));
  expect(first).toHaveAttribute('data-near', 'true');
  view.unmount();
  expect(observer.observed.size).toBe(0);
  expect(observer.disconnect).toHaveBeenCalledTimes(1);
});

it('preserves independent margins and releases an empty observer', () => {
  const view = render(
    <>
      <Item id={1} />
      <Item id={2} margin="400px" />
      <Item id={3} margin="400px" />
    </>,
  );
  expect(Observer.instances).toHaveLength(2);
  const normal = Observer.instances.find(
    ({ options }) => options.rootMargin === '200px',
  )!;
  const wide = Observer.instances.find(
    ({ options }) => options.rootMargin === '400px',
  )!;
  const first = screen.getByTestId('item-1');
  act(() => normal.emit([first]));
  expect(normal.disconnect).toHaveBeenCalledTimes(1);
  expect(wide.observed.size).toBe(2);
  view.unmount();
  render(<Item id={4} />);
  expect(Observer.instances).toHaveLength(3);
  // A queued notification from a detached target cannot activate a new card.
  act(() => normal.emit([first]));
  expect(screen.getByTestId('item-4')).toHaveAttribute('data-near', 'false');
});

it('retains one live observer after strict-effect cleanup and removes all targets on close', () => {
  const view = render(
    <StrictMode>
      <Item id={1} />
      <Item id={2} />
    </StrictMode>,
  );
  const active = Observer.instances.filter(({ observed }) => observed.size);
  expect(active).toHaveLength(1);
  expect(active[0]!.observed.size).toBe(2);
  view.unmount();
  expect(Observer.instances.every(({ observed }) => observed.size === 0)).toBe(
    true,
  );
});

it('renders the player immediately when visibility observation is unavailable', () => {
  vi.stubGlobal('IntersectionObserver', undefined);
  render(<Item id={1} />);
  expect(screen.getByTestId('item-1')).toHaveAttribute('data-near', 'true');
  expect(Observer.instances).toHaveLength(0);
});
