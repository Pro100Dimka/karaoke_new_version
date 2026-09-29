import { expect, it } from "vitest";
import { rememberRoomProjectCopy, roomProjectCopy } from "./roomProjectCopies";

it("reuses a fetched room project in any later room of the same app run", () => {
  expect(roomProjectCopy("song", 3)).toBeUndefined();
  rememberRoomProjectCopy("song", 3, "local-song");
  expect(roomProjectCopy("song", 3)).toBe("local-song");
  expect(roomProjectCopy("song", 4)).toBeUndefined();
  expect(roomProjectCopy(undefined, 3)).toBeUndefined();
});
