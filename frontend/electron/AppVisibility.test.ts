import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { watchAppVisibility } from './AppVisibility';

const fakeWindow = () => {
  const window = Object.assign(new EventEmitter(), {
    minimized: false,
    visible: true,
    destroyed: false,
    focused: true,
    isFocused() {
      return this.focused;
    },
    isDestroyed() {
      return this.destroyed;
    },
    isVisible() {
      return this.visible;
    },
    isMinimized() {
      return this.minimized;
    },
  });
  const set = (minimized: boolean) => {
    window.minimized = minimized;
    window.emit(minimized ? 'minimize' : 'restore');
  };
  return { window, set };
};

it('reports the app off screen only while neither the main window nor a detached panel can be seen', () => {
  const main = fakeWindow();
  const states: boolean[] = [];
  const visibility = watchAppVisibility(main.window, (onScreen) =>
    states.push(onScreen),
  );

  main.set(true);
  expect(states).toEqual([false]);
  main.set(false);
  expect(states).toEqual([false, true]);

  const panel = fakeWindow();
  visibility.addPanel(panel.window);
  main.set(true);
  expect(states).toEqual([false, true]); // the detached room panel is still on screen
  panel.set(true);
  expect(states).toEqual([false, true, false]);
  panel.set(false);
  panel.window.destroyed = true;
  panel.window.emit('closed');
  expect(states).toEqual([false, true, false, true, false]);
});

it('repeats the current state for a renderer that has just loaded', () => {
  const main = fakeWindow();
  const states: boolean[] = [];
  const visibility = watchAppVisibility(main.window, (onScreen) =>
    states.push(onScreen),
  );
  visibility.republish();
  visibility.republish();
  expect(states).toEqual([true, true]);
});

it('resynchronizes visibility on focus when restore arrived before the native window state settled', () => {
  const main = fakeWindow();
  const states: boolean[] = [];
  watchAppVisibility(main.window, (shown) => states.push(shown));
  main.set(true);
  main.window.emit('restore');
  main.window.minimized = false;
  main.window.emit('focus');
  expect(states).toEqual([false, true]);
});

it('keeps app focus while focus moves between the main window and its panel', () => {
  vi.useFakeTimers();
  try {
    const main = fakeWindow();
    const panel = fakeWindow();
    panel.window.focused = false;
    const focused = vi.fn();
    const visibility = watchAppVisibility(
      main.window,
      () => undefined,
      focused,
    );
    visibility.addPanel(panel.window);
    visibility.republish();
    expect(focused).toHaveBeenLastCalledWith(true);
    focused.mockClear();
    main.window.focused = false;
    main.window.emit('blur');
    panel.window.focused = true;
    panel.window.emit('focus');
    main.set(true);
    vi.advanceTimersByTime(100);
    expect(focused).not.toHaveBeenCalledWith(false);
    panel.window.focused = false;
    panel.window.emit('blur');
    vi.advanceTimersByTime(100);
    expect(focused).toHaveBeenLastCalledWith(false);
    panel.window.focused = true;
    panel.window.emit('focus');
    expect(focused).toHaveBeenLastCalledWith(true);
    panel.window.destroyed = true;
    panel.window.emit('closed');
    vi.advanceTimersByTime(100);
    expect(focused).toHaveBeenLastCalledWith(false);
  } finally {
    vi.useRealTimers();
  }
});
