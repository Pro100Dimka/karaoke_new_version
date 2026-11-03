import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlaybackSnapshot } from '../../contracts/models';
import { usePositionPolling } from './usePositionPolling';

const { observeSnapshots, invalidateAudioSnapshots } = vi.hoisted(() => ({
  observeSnapshots: vi.fn(), invalidateAudioSnapshots: vi.fn(),
}));
vi.mock('../../services/audioClient', () => ({
  audioClient: { observeSnapshots }, invalidateAudioSnapshots,
}));
let deliver: (value: PlaybackSnapshot) => void;
let fail: () => void;
let stop: ReturnType<typeof vi.fn<() => void>>;
const snapshot = (positionSeconds: number, state: PlaybackSnapshot['state'] = 'playing'): PlaybackSnapshot => ({
  sessionId: 's', state, positionSeconds, durationSeconds: 200,
  monitoring: false, inputLevel: 0, pitchHz: 440,
});
const options = () => ({
  enabled: true, isPollable: () => true, isPlaying: () => true,
  onPosition: vi.fn(), onSnapshot: vi.fn(), onFinished: vi.fn(), onLost: vi.fn(),
});
beforeEach(() => {
  vi.clearAllMocks();
  observeSnapshots.mockImplementation((onValue, onError) => {
    deliver = onValue;
    fail = onError;
    stop = vi.fn();
    return stop;
  });
});
describe('native position notifications', () => {
  it('delivers authoritative position and microphone pitch immediately without a polling timer', () => {
    const callbacks = options();
    renderHook(() => usePositionPolling(callbacks));
    act(() => deliver(snapshot(1)));
    expect(callbacks.onPosition).toHaveBeenCalledWith(1);
    expect(callbacks.onSnapshot).toHaveBeenCalledWith(expect.objectContaining({pitchHz:440}));
  });
  it('retains one subscription while room updates replace callbacks', () => {
    const callbacks = options();
    const { rerender } = renderHook(({ current }) => usePositionPolling(current), {initialProps:{current:callbacks}});
    const latest = options();
    for (let update = 0; update < 50; update++) rerender({current:latest});
    act(() => deliver(snapshot(12)));
    expect(observeSnapshots).toHaveBeenCalledOnce();
    expect(callbacks.onPosition).not.toHaveBeenCalled();
    expect(latest.onPosition).toHaveBeenCalledWith(12);
  });
  it('does not subscribe while disabled and releases the subscription on disable', () => {
    const callbacks = options();
    const { rerender } = renderHook(({enabled}) => usePositionPolling({...callbacks,enabled}), {initialProps:{enabled:false}});
    expect(observeSnapshots).not.toHaveBeenCalled();
    rerender({enabled:true});
    rerender({enabled:false});
    expect(stop).toHaveBeenCalledOnce();
  });
  it('preserves ordered native observations and finished notification', () => {
    const callbacks = options();
    renderHook(() => usePositionPolling(callbacks));
    act(() => {deliver(snapshot(1));deliver(snapshot(2));deliver(snapshot(3,'finished'));});
    expect(callbacks.onPosition.mock.calls.map(([position])=>position)).toEqual([1,2,3]);
    expect(callbacks.onFinished).toHaveBeenCalledOnce();
  });
  it('does not apply an observation to an unprepared session', () => {
    const callbacks = {...options(),isPollable:()=>false};
    renderHook(() => usePositionPolling(callbacks));
    act(() => deliver(snapshot(1)));
    expect(callbacks.onPosition).not.toHaveBeenCalled();
  });
  it('invalidates pending native observations around a seek', () => {
    const {result} = renderHook(() => usePositionPolling(options()));
    result.current.invalidate();
    expect(invalidateAudioSnapshots).toHaveBeenCalledOnce();
  });
  it('reports a confirmed audio-service loss', () => {
    const callbacks = options();
    renderHook(() => usePositionPolling(callbacks));
    act(() => fail());
    expect(callbacks.onLost).toHaveBeenCalledOnce();
  });
});
