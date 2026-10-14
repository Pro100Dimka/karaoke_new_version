import { expect, it, vi } from "vitest";
import { radioTrackFrom, readStreamTitle } from "./RadioNowPlaying";
import { radioTrackText, trayMenuTemplate } from "./TrayRadio";
import { activityFor } from "./DiscordPresence";
import { idleShellStatus, type ShellStatus } from "./DesktopShell";

it("splits an Icecast title into artist and title", () => {
  expect(radioTrackFrom("StreamTitle='Thomas Lemmer & Setsuna - Juno';StreamUrl='https://x';")).toEqual({
    artist: "Thomas Lemmer & Setsuna",
    title: "Juno",
  });
  expect(radioTrackFrom("StreamTitle='Station ID';")).toEqual({ title: "Station ID" });
  expect(radioTrackFrom("StreamTitle='';")).toBeNull();
  expect(radioTrackFrom("")).toBeNull();
});

it("reads only up to the first title block of a stream", async () => {
  const metaint = 8;
  const title = Buffer.from("StreamTitle='Complete Cycle - Everything''s Amazing';");
  const block = Buffer.alloc(Math.ceil(title.length / 16) * 16);
  title.copy(block);
  const audio = Buffer.alloc(metaint, 1);
  const body = Buffer.concat([audio, Buffer.from([block.length / 16]), block, Buffer.alloc(100_000)]);
  const fetchImpl = vi.fn(async () => new Response(new Uint8Array(body), { headers: { "icy-metaint": String(metaint) } }));

  expect(await readStreamTitle("https://radio.example/stream", fetchImpl as unknown as typeof fetch)).toEqual({
    artist: "Complete Cycle",
    title: "Everything''s Amazing",
  });
  expect(fetchImpl).toHaveBeenCalledWith(
    "https://radio.example/stream",
    expect.objectContaining({ headers: expect.objectContaining({ "Icy-MetaData": "1" }) }),
  );
});

it("a station without titles answers nothing", async () => {
  const fetchImpl = vi.fn(async () => new Response(new Uint8Array(1000)));
  expect(await readStreamTitle("https://radio.example/stream", fetchImpl as unknown as typeof fetch)).toBeNull();
});

it("shows what the radio plays in the tray and on Discord", () => {
  const status: ShellStatus = {
    ...idleShellStatus,
    screen: "library",
    radio: { available: true, enabled: true, station: "Radio Paradise", track: { artist: "Tom Petty", title: "Good Enough" } },
  };
  expect(radioTrackText(status)).toBe("Tom Petty — Good Enough");
  const labels = trayMenuTemplate(status, { open: vi.fn(), quit: vi.fn(), send: vi.fn() }).map((item) => item.label);
  expect(labels).toContain("♪ Tom Petty — Good Enough");
  expect(activityFor(status, 0)?.state).toBe("Tom Petty — Good Enough");

  const withoutTrack: ShellStatus = { ...status, radio: { ...status.radio, track: undefined } };
  expect(activityFor(withoutTrack, 0)?.state).toBe("Radio Paradise");
});
