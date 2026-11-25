import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { installBridge } from '../../services/audioClientFixture';
import {
  enqueueAudioOperation,
  waitForAudioOperations,
} from '../../services/audioSession';
import { useEditorPreview } from './useEditorPreview';

afterEach(async () => {
  await waitForAudioOperations();
  Reflect.deleteProperty(window, 'desktop');
});

it.each(['replace', 'unmount'] as const)(
  'cancels queued editor seeks on %s and preserves coalescing in the next generation',
  async (leave) => {
    let frame = 0;
    const { requests } = installBridge(async (request) => {
      if (request.command === 'Seek') frame = Number(request.args?.frame);
      return {
        status: 0,
        text: `SessionState: Running\nPlaybackState: 2\nPlaybackPositionFrames: ${frame}\nRuntimeOutputSampleRate: 48000`,
      };
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const preceding = enqueueAudioOperation(() => blocked);
    const failed = vi.fn();
    const previous = renderHook(
      ({ ready }) => useEditorPreview(ready, failed),
      { initialProps: { ready: true } },
    );
    let obsolete!: Promise<void>[];
    act(() => {
      obsolete = [
        previous.result.current.seek(1),
        previous.result.current.seek(2),
      ];
    });
    if (leave === 'replace') {
      previous.rerender({ ready: false });
      previous.rerender({ ready: true });
    } else previous.unmount();
    await act(async () => {
      release();
      await preceding;
      await Promise.all(obsolete);
    });
    expect
      .soft(requests.filter(({ command }) => command === 'Seek'))
      .toHaveLength(0);

    const current =
      leave === 'replace'
        ? previous
        : renderHook(() => useEditorPreview(true, failed));
    await act(async () => {
      await Promise.all([
        current.result.current.seek(3),
        current.result.current.seek(4),
      ]);
    });
    expect(
      requests
        .filter(({ command }) => command === 'Seek')
        .map(({ args }) => args?.frame),
    ).toEqual([4 * 48_000]);
    expect(current.result.current.position).toBe(4);
    current.unmount();
  },
);
