import { expect, it, vi } from "vitest";

it("remembers a fetched room project across restarts of the app", async () => {
  window.localStorage.clear();
  const first = await import("./roomProjectCopies");
  expect(first.roomProjectCopy("song", 3)).toBeUndefined();
  first.rememberRoomProjectCopy("song", 3, "local-song");
  vi.resetModules(); // a restart: the in-memory cache is gone, the stored copy is not
  const restarted = await import("./roomProjectCopies");
  expect(restarted.roomProjectCopy("song", 3)).toBe("local-song");
  expect(restarted.roomProjectCopy("song", 4)).toBeUndefined();
  expect(restarted.roomProjectCopy(undefined, 3)).toBeUndefined();
});
