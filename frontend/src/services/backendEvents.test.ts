import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nextJobChange, refreshOnJobChanges } from "./backendEvents";

let listeners: ((event: unknown) => void)[] = [];
const push = (event: unknown) => [...listeners].forEach(listener => listener(event));
const jobChanged = (jobId: string) => push({ type: "job.changed", data: { jobId } });

beforeEach(() => {
  vi.useFakeTimers();
  listeners = [];
  Object.assign(window, { desktop: { onBackendEvent: (listener: (event: unknown) => void) => {
    listeners.push(listener);
    return () => { listeners = listeners.filter(item => item !== listener); };
  } } });
});
afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(window, "desktop");
});

it("wakes a job wait on that job's change or a reconnection, not on another job", async () => {
  const resolved = vi.fn();
  void nextJobChange("j1", 250).then(resolved);
  jobChanged("other");
  await vi.advanceTimersByTimeAsync(1000);
  expect(resolved).not.toHaveBeenCalled();
  jobChanged("j1");
  await vi.advanceTimersByTimeAsync(0);
  expect(resolved).toHaveBeenCalled();
  expect(listeners).toHaveLength(0);

  const afterReconnect = vi.fn();
  void nextJobChange("j1", 250).then(afterReconnect);
  push({ type: "connected" });
  await vi.advanceTimersByTimeAsync(0);
  expect(afterReconnect).toHaveBeenCalled();
});

it("still checks a job now and then when its change never arrives", async () => {
  const resolved = vi.fn();
  void nextJobChange("j1", 250).then(resolved);
  await vi.advanceTimersByTimeAsync(4999);
  expect(resolved).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(resolved).toHaveBeenCalled();
});

it("polls at the given interval when nothing can be pushed", async () => {
  Reflect.deleteProperty(window, "desktop");
  const resolved = vi.fn();
  void nextJobChange("j1", 250).then(resolved);
  await vi.advanceTimersByTimeAsync(250);
  expect(resolved).toHaveBeenCalled();
});

it("refreshes after a burst of job changes at most once per interval and stops when unsubscribed", async () => {
  const refresh = vi.fn();
  const unsubscribe = refreshOnJobChanges(refresh, 1000);
  jobChanged("a"); jobChanged("b"); jobChanged("a");
  await vi.advanceTimersByTimeAsync(0);
  expect(refresh).toHaveBeenCalledTimes(1);
  jobChanged("a");
  await vi.advanceTimersByTimeAsync(999);
  expect(refresh).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(refresh).toHaveBeenCalledTimes(2);
  unsubscribe();
  jobChanged("a");
  await vi.advanceTimersByTimeAsync(5000);
  expect(refresh).toHaveBeenCalledTimes(2);
});
