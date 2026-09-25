import assert from "node:assert/strict";
import test from "node:test";
import { clientSongs } from "./smoke-catalog.mjs";

test("room catalog queries use the selected client's backend bridge", async () => {
  const requests = [];
  globalThis.window = { desktop: { pythonRequest: async request => {
    requests.push(request);
    return { ok: true, status: 200, body: { items: [{ songId: "profile-song" }] } };
  } } };
  try {
    assert.deepEqual(await clientSongs({ evaluate: query => query() }), [{ songId: "profile-song" }]);
    assert.deepEqual(requests, [{ method: "GET", path: "/songs?limit=200" }]);
  } finally { delete globalThis.window; }
});

test("room catalog failures are reported instead of becoming an empty ready library", async () => {
  for (const response of [{ ok: false, status: 503 }, { ok: true, status: 200, body: {} }]) {
    await assert.rejects(clientSongs({ evaluate: async () => response }), /Client song catalog failed/);
  }
});
