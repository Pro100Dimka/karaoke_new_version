import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPeaksService } from "./PeaksService";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("reads a file's peaks once while it stays the same, and again once it changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "peaks-service-"));
  roots.push(root);
  const file = join(root, "take.wav");
  await writeFile(file, "one");
  const compute = vi.fn(async () => [0.5, 1]);
  const peaks = createPeaksService(compute);

  const [first, second] = await Promise.all([peaks(file, 240), peaks(file, 240)]);
  expect(first).toEqual([0.5, 1]);
  expect(second).toEqual([0.5, 1]);
  expect(compute).toHaveBeenCalledTimes(1);

  await peaks(file, 480);
  expect(compute).toHaveBeenCalledTimes(2);

  await writeFile(file, "changed");
  await utimes(file, new Date(), new Date(Date.now() + 5000));
  await peaks(file, 240);
  expect(compute).toHaveBeenCalledTimes(3);
});

it("forgets a failed read so the next request tries again", async () => {
  const root = await mkdtemp(join(tmpdir(), "peaks-service-"));
  roots.push(root);
  const file = join(root, "take.wav");
  await writeFile(file, "x");
  const compute = vi.fn().mockRejectedValueOnce(new Error("busy")).mockResolvedValueOnce([1]);
  const peaks = createPeaksService(compute);
  await expect(peaks(file, 2)).rejects.toThrow("busy");
  await expect(peaks(file, 2)).resolves.toEqual([1]);
});
