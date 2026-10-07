import { afterEach, expect, it, vi } from "vitest";
import { avatarFromFile } from "./avatarImage";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("closes the decoded image when canvas initialization fails", async () => {
  const close = vi.fn();
  vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({
    width: 32,
    height: 32,
    close,
  }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);

  await expect(avatarFromFile(new File([], "photo.png"))).rejects.toThrow(
    "Canvas is unavailable",
  );
  expect(close).toHaveBeenCalledOnce();
});
