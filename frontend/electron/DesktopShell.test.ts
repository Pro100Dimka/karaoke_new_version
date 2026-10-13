import { expect, it, vi } from "vitest";
import {
  DesktopShell,
  commandsFromArguments,
  idleShellStatus,
  parseShellStatus,
  roomCodeFromLink,
} from "./DesktopShell";

it("accepts only well-formed status and trims what the renderer sends", () => {
  expect(parseShellStatus(null)).toEqual(idleShellStatus);
  expect(parseShellStatus({ screen: "hack", playing: "yes", radio: 3 })).toEqual(idleShellStatus);
  expect(
    parseShellStatus({
      language: "uk",
      screen: "karaoke",
      song: { title: "  Люди  ", artist: "Бумбокс" },
      playing: true,
      recording: true,
      room: { code: "AB12", participants: 3.4 },
      radio: { available: true, enabled: false, station: "Lofi" },
      microphoneMuted: true,
      discordPresence: true,
    }),
  ).toEqual({
    language: "uk",
    screen: "karaoke",
    song: { title: "Люди", artist: "Бумбокс" },
    playing: true,
    recording: true,
    room: { code: "AB12", participants: 3 },
    radio: { available: true, enabled: false, station: "Lofi" },
    microphoneMuted: true,
    discordPresence: true,
  });
  // Mute only means something inside a room.
  expect(parseShellStatus({ microphoneMuted: true }).microphoneMuted).toBeUndefined();
});

it("reads room codes only from well-formed invitation links", () => {
  expect(roomCodeFromLink("advoice://room/ab12cd")).toBe("AB12CD");
  expect(roomCodeFromLink("advoice://room/AB12/")).toBe("AB12");
  expect(roomCodeFromLink("ADVOICE://ROOM/AB12")).toBe("AB12");
  for (const bad of ["advoice://room/", "advoice://other/AB12", "https://room/AB12", "advoice://room/a b", "advoice://room/%3Cscript%3E", "not a url"])
    expect(roomCodeFromLink(bad)).toBeUndefined();
});

it("turns launch arguments into commands: links, jump-list tasks and existing audio files", () => {
  const exists = (file: string) => !file.includes("missing");
  expect(
    commandsFromArguments(
      ["C:/app/AD Voice.exe", "--allow-file-access", "advoice://room/ab12", "--add-song", "D:/music/song.MP3", "D:/music/song.MP3", "D:/notes.txt", "D:/missing.wav", "--open-room"],
      exists,
    ),
  ).toEqual([
    { type: "joinRoom", code: "AB12" },
    { type: "addSong" },
    { type: "openRoom" },
    { type: "importFiles", paths: [expect.stringMatching(/song\.MP3$/)] },
  ]);
  expect(commandsFromArguments(["C:/app/AD Voice.exe", "."], exists)).toEqual([]);
});

it("queues commands until the interface listens and reports only real status changes", () => {
  const shell = new DesktopShell();
  shell.send({ type: "addSong" });
  shell.send({ type: "joinRoom", code: "AB12" });
  const delivered = vi.fn();
  shell.connect(delivered);
  expect(delivered.mock.calls.map(([command]) => command.type)).toEqual(["addSong", "joinRoom"]);
  shell.send({ type: "toggleRadio" });
  expect(delivered).toHaveBeenCalledTimes(3);
  shell.disconnect();
  shell.send({ type: "toggleRadio" });
  expect(delivered).toHaveBeenCalledTimes(3);

  const listener = vi.fn();
  shell.onStatus(listener);
  shell.report({ screen: "library", radio: { available: true, enabled: true } });
  shell.report({ screen: "library", radio: { available: true, enabled: true } });
  expect(listener).toHaveBeenCalledOnce();
  expect(shell.status().radio.enabled).toBe(true);
});

it("keeps the other integrations running when one fails", () => {
  const shell = new DesktopShell();
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const after = vi.fn();
  shell.onStatus(() => {
    throw new Error("tray icon missing");
  });
  shell.onStatus(after);
  expect(() => shell.report({ screen: "library", radio: { available: true, enabled: true } })).not.toThrow();
  expect(after).toHaveBeenCalledOnce();
  error.mockRestore();
});
