import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HistoryEventDto } from "../../../../../../../contracts/models";
import { useHistory } from "../useHistory";

const backend = vi.hoisted(() => ({ history: vi.fn(), listSongs: vi.fn() }));
vi.mock("../../../../../../../app/SettingsProvider", () => ({
  useSettingsBackend: () => backend,
}));

const event = (id: string, kind = "RecordingRegistered"): HistoryEventDto => ({
  id,
  kind,
  createdAt: "2026-01-01T00:00:00Z",
});
type Page = { items: readonly HistoryEventDto[]; total: number };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

beforeEach(() => {
  backend.history.mockReset().mockResolvedValue({ items: [], total: 0 });
  backend.listSongs.mockReset().mockResolvedValue([]);
});
afterEach(cleanup);

it("recovers a failed initial history request without retrying the catalog", async () => {
  const recovered = event("recovered");
  backend.history
    .mockRejectedValueOnce(new Error("History is unavailable"))
    .mockResolvedValueOnce({ items: [recovered], total: 1 });
  const { result } = renderHook(useHistory);
  await waitFor(() => expect(result.current.failed).toBe(true));
  expect(result.current.events).toEqual([]);
  expect(result.current.total).toBe(0);

  act(() => result.current.retry());
  await waitFor(() => expect(result.current.events).toEqual([recovered]));
  expect(result.current.failed).toBe(false);
  expect(backend.history).toHaveBeenLastCalledWith(50, 0, [
    "RecordingRegistered",
    "AnalysisCompleted",
  ]);
  expect(backend.listSongs).toHaveBeenCalledOnce();
});

it("preserves loaded history when another page fails and retries that offset", async () => {
  const first = event("first");
  const next = event("next", "AnalysisCompleted");
  backend.history
    .mockResolvedValueOnce({ items: [first], total: 2 })
    .mockRejectedValueOnce(new Error("Next page is unavailable"))
    .mockResolvedValueOnce({ items: [next], total: 2 });
  const { result } = renderHook(useHistory);
  await waitFor(() => expect(result.current.events).toEqual([first]));

  act(() => result.current.loadMore());
  await waitFor(() => expect(result.current.failed).toBe(true));
  expect(result.current.events).toEqual([first]);
  expect(result.current.total).toBe(2);

  act(() => result.current.loadMore());
  await waitFor(() => expect(result.current.events).toEqual([first, next]));
  expect(result.current.failed).toBe(false);
  expect(result.current.events).toHaveLength(result.current.total);
  expect(backend.history).toHaveBeenLastCalledWith(50, 1, [
    "RecordingRegistered",
    "AnalysisCompleted",
  ]);
});

it("ignores a failed history request after switching tabs", async () => {
  const previous = deferred<Page>();
  const processing = event("processing-event", "ProcessingFailed");
  backend.history
    .mockReturnValueOnce(previous.promise)
    .mockResolvedValueOnce({ items: [processing], total: 1 });
  const { result } = renderHook(useHistory);
  await waitFor(() => expect(backend.history).toHaveBeenCalledOnce());

  act(() => result.current.setTab("processing"));
  await waitFor(() => expect(result.current.events).toEqual([processing]));
  expect(backend.history).toHaveBeenLastCalledWith(50, 0, [
    "ProcessingStarted",
    "ProcessingSucceeded",
    "ProcessingFailed",
  ]);
  await act(async () => previous.reject(new Error("Old tab failed")));
  expect(result.current.failed).toBe(false);
  expect(result.current.events).toEqual([processing]);
  expect(backend.history).toHaveBeenCalledTimes(2);
});

it("ignores the first request after returning to the same history tab", async () => {
  const previous = deferred<Page>();
  const current = event("current-performance");
  backend.history
    .mockReturnValueOnce(previous.promise)
    .mockResolvedValueOnce({ items: [], total: 0 })
    .mockResolvedValueOnce({ items: [current], total: 1 });
  const { result } = renderHook(useHistory);
  await waitFor(() => expect(backend.history).toHaveBeenCalledOnce());
  act(() => result.current.setTab("processing"));
  await waitFor(() => expect(backend.history).toHaveBeenCalledTimes(2));
  act(() => result.current.setTab("performances"));
  await waitFor(() => expect(result.current.events).toEqual([current]));

  await act(async () =>
    previous.resolve({
      items: [event("stale-performance", "AnalysisCompleted")],
      total: 100,
    }),
  );
  expect(result.current.events).toEqual([current]);
  expect(result.current.total).toBe(1);
});

it("keeps failed title discovery unknown and retries only the catalog", async () => {
  const recorded = { ...event("recording"), songId: "song" };
  backend.history.mockResolvedValue({ items: [recorded], total: 1 });
  backend.listSongs
    .mockRejectedValueOnce(new Error("temporary catalog failure"))
    .mockResolvedValueOnce([{ id: "song", artist: "Artist", title: "Title" }]);
  const { result } = renderHook(useHistory);
  await waitFor(() => expect(result.current.catalog.failed).toBe(true));
  expect(result.current.catalog.titles).toBeNull();
  expect(result.current.events).toEqual([recorded]);

  act(() => result.current.retry());
  await waitFor(() =>
    expect(result.current.catalog.titles?.has("song")).toBe(true),
  );
  expect(result.current.catalog.failed).toBe(false);
  expect(backend.history).toHaveBeenCalledOnce();
  expect(backend.listSongs).toHaveBeenCalledTimes(2);
});

it("distinguishes an unfinished catalog from a successful empty catalog", async () => {
  const titles = deferred<[]>();
  backend.history.mockResolvedValue({
    items: [{ ...event("recording"), songId: "missing" }],
    total: 1,
  });
  backend.listSongs.mockReturnValueOnce(titles.promise);
  const { result } = renderHook(useHistory);
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.catalog.titles).toBeNull();
  expect(result.current.catalog.failed).toBe(false);

  await act(async () => titles.resolve([]));
  expect(result.current.catalog.titles).toEqual(new Map());
  expect(result.current.catalog.failed).toBe(false);
});

it("clears the previous tab's total before a failed tab change", async () => {
  const recorded = event("recording");
  backend.history
    .mockResolvedValueOnce({ items: [recorded], total: 100 })
    .mockRejectedValueOnce(new Error("processing unavailable"));
  const { result } = renderHook(useHistory);
  await waitFor(() => expect(result.current.events).toEqual([recorded]));
  expect(result.current.total).toBe(100);

  act(() => result.current.setTab("processing"));
  await waitFor(() => expect(result.current.failed).toBe(true));
  expect(result.current.events).toEqual([]);
  expect(result.current.total).toBe(0);
});
