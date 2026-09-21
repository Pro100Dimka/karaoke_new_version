import { afterEach, describe, expect, it, vi } from "vitest";
import { audioClient } from "./audioClient";

const installBridge = (reply: (command: string) => { status: number; text: string }) => {
  const commands: string[] = [];
  Object.assign(window, {
    desktop: {
      audioRequest: vi.fn(async (request: { command: string }) => {
        commands.push(request.command);
        return reply(request.command);
      })
    }
  });
  return commands;
};

describe("audioClient contract", () => {
  afterEach(() => Reflect.deleteProperty(window, "desktop"));

  it("reports ready when AudioService answers Running", async () => {
    installBridge(() => ({ status: 0, text: "Running" }));
    expect(await audioClient.health()).toMatchObject({ status: "ready" });
  });

  it("reports unavailable when the transport returns a failure status", async () => {
    installBridge(() => ({ status: -1, text: "AudioService unavailable: ENOENT" }));
    expect(await audioClient.health()).toMatchObject({ status: "unavailable" });
  });

  it("issues Pause and reads a paused snapshot", async () => {
    const commands = installBridge(command => ({
      status: 0,
      text: command === "GetDiagnostics" ? "PlaybackState: 4\nPlaybackPositionFrames: 48000\nRuntimeOutputSampleRate: 48000" : "Ok"
    }));
    const snapshot = await audioClient.pause();
    expect(commands).toEqual(["Pause", "GetDiagnostics"]);
    expect(snapshot).toMatchObject({ state: "paused", positionSeconds: 1 });
  });

  it.each([
    ["Prepared", ["GetDiagnostics", "StartSession", "PlayOutputTest"]],
    ["Failed", ["GetDiagnostics", "StopSession", "GetDevices", "PrepareSession", "StartSession", "PlayOutputTest"]],
    ["Running", ["GetDiagnostics", "PlayOutputTest"]]
  ])("brings a %s session to Running without preparing twice", async (sessionState, expected) => {
    const commands = installBridge(command => ({
      status: 0,
      text: command === "GetDiagnostics" ? `SessionState: ${sessionState}` : command === "GetDevices" ? "" : "Ok"
    }));
    await audioClient.playTestSound();
    expect(commands).toEqual(expected);
  });
});
