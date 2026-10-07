import { afterEach, expect, it, vi } from "vitest";
import { AppLogUploader, sendAppLogs } from "./AppLogUploader";

const transport = vi.hoisted(() => ({ request: vi.fn(), participantId: vi.fn(async () => "profile-1") }));
vi.mock("./RoomServerTransport", () => ({ roomServerRequest: transport.request }));
vi.mock("./RoomIdentity", () => ({ roomParticipantId: transport.participantId }));

afterEach(() => vi.useRealTimers());

it("uploads timestamped service lines in order and retries a failed batch", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-07T12:00:00.000Z"));
  const send = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
  const logs = new AppLogUploader(send);
  logs.start();
  logs.write("audio-service", "error", Buffer.from("WASAPI: GetBuffer"));
  logs.write("audio-service", "error", Buffer.from("Size error\nWASAPI: Start failed\n"));
  await vi.advanceTimersByTimeAsync(2_000);
  expect(send).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[0]?.[0]).toEqual(send.mock.calls[1]?.[0]);
  expect(send.mock.calls[1]?.[0]).toEqual([
    {
      timestamp: "2026-10-07T12:00:00.000Z",
      source: "audio-service",
      level: "error",
      message: "WASAPI: GetBufferSize error",
    },
    {
      timestamp: "2026-10-07T12:00:00.000Z",
      source: "audio-service",
      level: "error",
      message: "WASAPI: Start failed",
    },
  ]);
  logs.stop();
});

it("bounds offline logs and removes local usernames and room keys", async () => {
  vi.useFakeTimers();
  const send = vi.fn().mockResolvedValue(undefined);
  const logs = new AppLogUploader(send);
  for (let index = 0; index < 1_100; index++)
    logs.add("electron", "error", `Error ${index} C:\\Users\\Alice\\AppData X-AD-Voice-Room-Key: deadbeef`);
  await logs.flush();
  expect(send.mock.calls[0]?.[0]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ source: "electron", message: expect.stringContaining("Dropped 100") }),
    ]),
  );
  const messages = JSON.stringify(send.mock.calls[0]?.[0]);
  expect(messages).not.toContain("Alice");
  expect(messages).not.toContain("deadbeef");
  logs.stop();
});

it("records Electron console errors while preserving the original console", async () => {
  const send = vi.fn().mockResolvedValue(undefined);
  const logs = new AppLogUploader(send);
  const original = vi.fn();
  const target = { error: original };
  logs.captureConsole(target);
  target.error("AudioService", new Error("ASIO driver missing"));
  await logs.flush();
  expect(original).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledWith([
    expect.objectContaining({
      source: "electron",
      level: "error",
      message: expect.stringContaining("ASIO driver missing"),
    }),
  ]);
});

it("keeps an in-flight batch for retry when the queue fills", async () => {
  let fail!: (error: Error) => void;
  const send = vi.fn().mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject; })).mockResolvedValue(undefined);
  const logs = new AppLogUploader(send);
  logs.add("electron", "info", "first");
  const uploading = logs.flush();
  for (let index = 0; index < 1_000; index++) logs.add("electron", "info", `later ${index}`);
  fail(new Error("offline"));
  await uploading;
  await logs.flush();
  expect(send.mock.calls[1]?.[0]).toEqual(
    expect.arrayContaining([expect.objectContaining({ message: "first" })]),
  );
});

it("redacts JSON credentials and token query parameters", async () => {
  const send = vi.fn().mockResolvedValue(undefined);
  const logs = new AppLogUploader(send);
  logs.add("python", "error", 'driver error {"apiKey":"secret1","voiceToken":"secret2"} https://x.test/?token=secret3');
  await logs.flush();
  const message = send.mock.calls[0]?.[0][0].message as string;
  expect(message).not.toMatch(/secret[123]/);
  expect(message).toContain("<redacted>");
});

it("redacts escaped Windows home paths in Python tracebacks and retains their severity", async () => {
  const send = vi.fn().mockResolvedValue(undefined);
  const logs = new AppLogUploader(send);
  logs.write("python", "info", Buffer.from(String.raw`{"level":"ERROR","exception":"C:\\Users\\Alice\\AppData\\Local\\x.py"}` + "\n"));
  await logs.flush();
  expect(send.mock.calls[0]?.[0][0]).toEqual(expect.objectContaining({
    level: "error",
    message: expect.not.stringContaining("Alice"),
  }));
});

it("uses Uvicorn severity prefixes from Python stderr without changing other errors", async () => {
  const send = vi.fn().mockResolvedValue(undefined);
  const logs = new AppLogUploader(send);
  const severities = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"];
  for (const severity of severities)
    logs.write("python", "error", Buffer.from(`${severity}: Uvicorn event\n`));
  logs.write("python", "error", Buffer.from("Unclassified Python failure\n"));
  logs.write("audio-service", "error", Buffer.from("INFO: Native device failure\n"));
  await logs.flush();
  expect(send.mock.calls[0]?.[0]).toEqual([
    ...severities.map((severity) => expect.objectContaining({
      source: "python", level: severity.toLowerCase(), message: `${severity}: Uvicorn event`,
    })),
    expect.objectContaining({ source: "python", level: "error", message: "Unclassified Python failure" }),
    expect.objectContaining({ source: "audio-service", level: "error", message: "INFO: Native device failure" }),
  ]);
});

it("sends logs to the common server outside a room under this profile identity", async () => {
  const entries = [{ timestamp: "2026-10-07T12:00:00Z", source: "renderer", level: "error", message: "failed" }];
  transport.request.mockResolvedValueOnce({ ok: true, status: 204, body: null });
  await sendAppLogs(entries);
  expect(transport.request).toHaveBeenCalledWith({
    method: "POST",
    path: "/app-logs",
    body: { clientId: "profile-1", entries },
  });
});

it("keeps escaped log batches below the server body limit and drains every entry", async () => {
  const send = vi.fn().mockResolvedValue(undefined);
  const logs = new AppLogUploader(send);
  for (let index = 0; index < 100; index++) logs.add("python", "error", "\\".repeat(4_096));
  let sent = 0;
  for (let attempt = 0; attempt < 3 && sent < 100; attempt++) {
    await logs.flush();
    const entries = send.mock.calls[attempt]?.[0] as unknown[];
    expect(Buffer.byteLength(JSON.stringify({ clientId: "0".repeat(32), entries }))).toBeLessThanOrEqual(512 * 1024);
    sent += entries.length;
  }
  expect(send).toHaveBeenCalledTimes(2);
  expect(sent).toBe(100);
});
