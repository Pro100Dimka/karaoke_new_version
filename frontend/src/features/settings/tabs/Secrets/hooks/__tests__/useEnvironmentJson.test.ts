import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useEnvironmentJson } from "../useEnvironmentJson";

it("keeps a dirty JSON draft when background values change", () => {
  const onApply = vi.fn(async () => undefined);
  const { result, rerender } = renderHook(
    ({ values }) => useEnvironmentJson(values, onApply),
    { initialProps: { values: { port: "8081" } } },
  );
  act(() => result.current.change('{"port":"8181"}'));
  rerender({ values: { port: "8281" } });
  expect(result.current.source).toBe('{"port":"8181"}');
});

it("does not clear newer JSON edits when an older save completes", async () => {
  let finish!: () => void;
  const onApply = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const { result, rerender } = renderHook(
    ({ values }) => useEnvironmentJson(values, onApply),
    { initialProps: { values: { port: "8081" } } },
  );
  act(() => result.current.change('{"port":"8181"}'));
  act(() => void result.current.apply());
  act(() => result.current.change('{"port":"8381"}'));
  rerender({ values: { port: "8181" } });
  await act(async () => finish());
  expect(result.current.source).toBe('{"port":"8381"}');
  expect(onApply).toHaveBeenCalledExactlyOnceWith('{"port":"8181"}');
});

it("ignores an older failed attempt when the same JSON is retried successfully", async () => {
  let failFirst!: (error: unknown) => void;
  let finishSecond!: () => void;
  const first = new Promise<void>((_resolve, reject) => {
    failFirst = reject;
  });
  const second = new Promise<void>((resolve) => {
    finishSecond = resolve;
  });
  const onApply = vi
    .fn()
    .mockReturnValueOnce(first)
    .mockReturnValueOnce(second);
  const { result, rerender } = renderHook(
    ({ values }) => useEnvironmentJson(values, onApply),
    { initialProps: { values: { port: "8081" } } },
  );
  act(() => result.current.change('{"port":"8181"}'));
  act(() => void result.current.apply());
  act(() => void result.current.apply());
  await act(async () => failFirst(new Error("Earlier save failed")));
  expect(result.current.error).toBeUndefined();
  rerender({ values: { port: "8181" } });
  await act(async () => finishSecond());
  expect(result.current.source).toBe(JSON.stringify({ port: "8181" }, null, 2));
  expect(result.current.error).toBeUndefined();
  expect(onApply).toHaveBeenCalledTimes(2);
});
