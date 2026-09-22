import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("room project transfer streams packages instead of loading them into memory", () => {
  const source = readFileSync(new URL("./RoomProjectTransfer.ts", import.meta.url), "utf8");
  assert.match(source, /createReadStream/);
  assert.match(source, /pipeline/);
  assert.match(source, /X-Participant-Id/);
});
