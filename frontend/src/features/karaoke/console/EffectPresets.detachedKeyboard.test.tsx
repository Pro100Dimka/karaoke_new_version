import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { DetachedPanel } from '../../../shared/ui/DetachedPanel';
import { useDetachedPanel } from '../../../shared/ui/useDetachedPanel';
import { useKaraokeShortcuts } from '../useKaraokeShortcuts';
import { EffectPresets } from './EffectPresets';

type Session = Parameters<typeof useKaraokeShortcuts>[0];
type ShortcutSession = Pick<
  Session,
  | 'interactive'
  | 'practiceLocked'
  | 'position'
  | 'speed'
  | 'showNotes'
  | 'showLyrics'
  | 'gains'
  | 'togglePlay'
  | 'seek'
  | 'changeGain'
  | 'changeKey'
  | 'changeSpeed'
  | 'toggleMonitoring'
  | 'setShowNotes'
  | 'setShowLyrics'
>;
const releases: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const release of releases.splice(0).reverse()) release();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const commands = (): ShortcutSession => ({
  interactive: true,
  practiceLocked: false,
  position: 30,
  speed: 1,
  showNotes: true,
  showLyrics: true,
  gains: { master: 0.8, mic: 1, music: 1, reference: 0, melody: 0 },
  togglePlay: vi.fn(async () => undefined),
  seek: vi.fn(async () => undefined),
  changeGain: vi.fn(async () => undefined),
  changeKey: vi.fn(async () => undefined),
  changeSpeed: vi.fn(async () => undefined),
  toggleMonitoring: vi.fn(async () => undefined),
  setShowNotes: vi.fn(),
  setShowLyrics: vi.fn(),
});

const ControlSurface = ({
  session,
  exit,
  select,
}: {
  session: ReturnType<typeof commands>;
  exit(): void;
  select(): void;
}) => {
  const [open, setOpen] = useState(false);
  const panel = useDetachedPanel('karaokeConsole', 'Console', {
    width: 1144,
    height: 220,
  });
  // Only session command ports are observed; the real shortcut hook handles the events.
  useKaraokeShortcuts(session as Session, 200, exit);
  return (
    <>
      <button data-testid="detach" onClick={() => panel.detach()}>
        Detach
      </button>
      <DetachedPanel panel={panel} keepMounted>
        <EffectPresets
          selected={null}
          microphoneAvailable
          open={open}
          onOpenChange={setOpen}
          onSelect={select}
        />
        <input aria-label="Control input" />
        <button data-testid="outside">Outside</button>
        <button
          data-testid="handled"
          onKeyDown={(event) => event.preventDefault()}
        >
          Handled
        </button>
      </DetachedPanel>
    </>
  );
};
const element = (owner: Document | Element, selector: string): HTMLElement => {
  const found = owner.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`Missing control: ${selector}`);
  return found;
};
const press = (target: HTMLElement, key: string, code?: string) => {
  const event = new KeyboardEvent('keydown', {
    key,
    code,
    bubbles: true,
    cancelable: true,
  });
  fireEvent(target, event);
  return event;
};
const surface = async (detached: boolean) => {
  const session = commands();
  const exit = vi.fn();
  const select = vi.fn();
  let owner = document;
  if (detached) {
    const iframe = document.createElement('iframe');
    document.body.append(iframe);
    releases.push(() => iframe.remove());
    const panel = iframe.contentWindow;
    if (!panel) throw new Error('Detached window unavailable');
    vi.spyOn(window, 'open').mockReturnValue(panel);
    vi.spyOn(panel, 'close').mockImplementation(() =>
      panel.dispatchEvent(new Event('pagehide')),
    );
    owner = panel.document;
  }
  const added = vi.spyOn(owner, 'addEventListener');
  const removed = vi.spyOn(owner, 'removeEventListener');
  render(<ControlSurface session={session} exit={exit} select={select} />);
  if (detached)
    await act(async () =>
      fireEvent.click(element(document, '[data-testid="detach"]')),
    );
  const trigger = element(owner, '.consolePresetsTrigger');
  fireEvent.click(trigger);
  const popup = element(owner, '[role="dialog"]');
  const preset = element(popup, 'button:not(:disabled)');
  expect(owner.activeElement).toBe(preset);
  return {
    owner,
    trigger,
    popup,
    preset,
    session,
    exit,
    select,
    added,
    removed,
  };
};

it.each([false, true])(
  'closes presets with Escape before karaoke exit (detached: %s)',
  async (detached) => {
    const { owner, trigger, preset, session, exit, select } =
      await surface(detached);

    expect(press(preset, 'Escape').defaultPrevented).toBe(true);

    expect(owner.querySelector('[role="dialog"]') === null).toBe(true);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(owner.activeElement === trigger).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    press(element(owner, 'input'), 'k', 'KeyK');
    press(trigger, ' ', 'Space');
    expect(session.togglePlay).not.toHaveBeenCalled();
    press(trigger, 'Escape');
    expect(exit).toHaveBeenCalledExactlyOnceWith();
  },
);

it.each([false, true])(
  'dismisses outside presets without stealing control focus (detached: %s)',
  async (detached) => {
    const { owner, popup, preset, trigger, exit, select } =
      await surface(detached);
    fireEvent.pointerDown(preset);
    fireEvent.pointerDown(trigger);
    expect(owner.querySelector('[role="dialog"]')).toBe(popup);
    const outside = element(owner, '[data-testid="outside"]');
    outside.focus();

    fireEvent.pointerDown(outside);

    expect(owner.querySelector('[role="dialog"]') === null).toBe(true);
    expect(owner.activeElement === outside).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  },
);

it('does not forward keys already handled by controls in a detached panel', async () => {
  const { owner, trigger, session, exit } = await surface(true);
  fireEvent.click(trigger);
  const handled = element(owner, '[data-testid="handled"]');

  expect(press(handled, 'Escape').defaultPrevented).toBe(true);
  expect(press(handled, 'k', 'KeyK').defaultPrevented).toBe(true);

  expect(exit).not.toHaveBeenCalled();
  expect(session.togglePlay).not.toHaveBeenCalled();
});

const returnToMain = async (owner: Document, method: 'drag' | 'close') => {
  const panel = owner.defaultView;
  if (!panel) throw new Error('Detached window unavailable');
  if (method === 'close') {
    fireEvent(panel, new Event('pagehide'));
    return;
  }
  for (const [name, value] of Object.entries({
    innerWidth: 1920,
    innerHeight: 1080,
    outerWidth: 1920,
    outerHeight: 1080,
    screenX: 0,
    screenY: 0,
  }))
    vi.stubGlobal(name, value);
  Object.assign(panel, {
    screenX: 2200,
    screenY: 100,
    innerWidth: 1144,
    innerHeight: 220,
  });
  const mount = element(owner, '.detachedPanel');
  mount.setPointerCapture = () => undefined;
  Object.assign(owner.body, {
    hasPointerCapture: () => false,
    setPointerCapture: () => undefined,
  });
  vi.spyOn(panel, 'moveTo').mockImplementation(() => undefined);
  const pointer = (
    target: HTMLElement | Window,
    type: string,
    screenX: number,
    screenY: number,
  ) => {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
      screenX,
      screenY,
    });
    Object.defineProperties(event, {
      pointerId: { value: 7 },
      pointerType: { value: 'mouse' },
    });
    fireEvent(target, event);
    return event;
  };
  // The real detached drag handler prevents default, keeping the popup open until the return.
  expect(pointer(mount, 'pointerdown', 2210, 110).defaultPrevented).toBe(true);
  expect(
    element(owner, '.consolePresetsTrigger').getAttribute('aria-expanded'),
  ).toBe('true');
  await act(async () => pointer(panel, 'pointermove', 300, 200));
};

it.each([
  { method: 'drag' as const, dismiss: 'escape' },
  { method: 'drag' as const, dismiss: 'outside' },
  { method: 'close' as const, dismiss: 'escape' },
  { method: 'close' as const, dismiss: 'outside' },
])(
  'closes presets on panel $method and reopens safely for $dismiss in the main window',
  async ({ method, dismiss }) => {
    const { owner, trigger, exit, added, removed } = await surface(true);
    const input = owner.querySelector<HTMLInputElement>('input');
    if (!input) throw new Error('Draft input unavailable');
    fireEvent.change(input, { target: { value: 'retained draft' } });
    const listeners = added.mock.calls.filter(
      ([type]) => type === 'keydown' || type === 'pointerdown',
    );
    expect(listeners).toHaveLength(2);

    await returnToMain(owner, method);

    expect(element(document, '.consolePresetsTrigger') === trigger).toBe(true);
    expect(document.querySelector('input') === input).toBe(true);
    expect(input.value).toBe('retained draft');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(owner.querySelector('[role="dialog"]') === null).toBe(true);
    for (const [type, listener] of listeners)
      expect(removed).toHaveBeenCalledWith(type, listener);
    expect(exit).not.toHaveBeenCalled();

    fireEvent.click(trigger);
    const popup = element(document, '[role="dialog"]');
    if (dismiss === 'escape') {
      press(element(popup, 'button:not(:disabled)'), 'Escape');
      expect(document.activeElement === trigger).toBe(true);
    } else {
      const outside = element(document, '[data-testid="outside"]');
      outside.focus();
      fireEvent.pointerDown(outside);
      expect(document.activeElement === outside).toBe(true);
    }
    expect(document.querySelector('[role="dialog"]') === null).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    press(trigger, 'Escape');
    expect(exit).toHaveBeenCalledExactlyOnceWith();
  },
);
