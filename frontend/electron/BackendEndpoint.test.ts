import { afterEach, expect, it, vi } from "vitest";
import { BackendEndpoint } from "./BackendEndpoint";

afterEach(() => vi.unstubAllGlobals());

it("bounds incomplete output and ignores malformed or duplicate endpoint announcements", async () => {
  const endpoint = new BackendEndpoint();
  const fetch = vi.fn(() => Promise.resolve(new Response("{}")));
  vi.stubGlobal("fetch", fetch);
  endpoint.started();
  endpoint.stdout(Buffer.from("x".repeat(100_000)));
  endpoint.stdout(Buffer.from("AD_VOICE_BACKEND_READY:12345\nAD_VOICE_BACKEND_READY:0\nAD_VOICE_BACKEND_READY:65536\n"));
  await expect(endpoint.request("/health/ready")).rejects.toThrow("starting or stopped");
  expect(fetch).not.toHaveBeenCalled();
  endpoint.stdout(Buffer.from("AD_VOICE_BACKEND_READY:52123\r\nAD_VOICE_BACKEND_READY:52124\n"));
  await endpoint.request("/health/ready");
  expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:52123/health/ready", expect.anything());
});

it("rejects an old response after restart even if the network has already returned it", async () => {
  const endpoint = new BackendEndpoint();
  endpoint.stdout(Buffer.from("AD_VOICE_BACKEND_READY:52123\n"));
  let reply!: (text: string) => void;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200, ok: true, text: () => new Promise<string>(resolve => { reply = resolve; }) }));
  const request = endpoint.request("/songs");
  await Promise.resolve();
  endpoint.stopped();
  reply("{}");
  await expect(request).rejects.toThrow();
});

it("applies a deadline to the response body as well as the connection", async () => {
  const timeout = new AbortController();
  const spy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
  try {
    const endpoint = new BackendEndpoint();
    endpoint.stdout(Buffer.from("AD_VOICE_BACKEND_READY:52123\n"));
    vi.stubGlobal("fetch", vi.fn(async (_url, { signal }: RequestInit) => ({
      text: () => new Promise<string>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    })));
    const request = endpoint.request("/songs");
    await Promise.resolve();
    timeout.abort(new Error("request deadline"));
    await expect(request).rejects.toThrow("request deadline");
    expect(spy).toHaveBeenCalledWith(30_000);
  } finally { spy.mockRestore(); }
});
