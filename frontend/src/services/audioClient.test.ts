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

  it("registers voice with both the room and participant identity", async () => {
    const joinRoomVoice = vi.fn(async () => undefined);
    const audioRequest = vi.fn(async (request: AudioBridgeRequest) => ({
      status: 0,
      text: request.command === "GetDiagnostics" ? "SessionState: Prepared" : "Ok"
    }));
    Object.assign(window, { desktop: { joinRoomVoice, audioRequest } });

    await audioClient.joinVoiceSession("ROOM-1", "person-1");

    expect(joinRoomVoice).toHaveBeenCalledWith("ROOM-1", "person-1");
    expect(audioRequest).toHaveBeenCalledWith({ command: "StartSession", args: undefined });
  });

  it("exposes microphone and per-participant room levels", async () => {
    installBridge(command => ({
      status: 0,
      text: command === "GetDiagnostics"
        ? "InputRMS: 0.2\nRemoteLevel.guest-1: 0.7"
        : "Ok"
    }));

    await expect(audioClient.roomLevels()).resolves.toEqual({
      local: 0.2,
      remote: { "guest-1": 0.7 }
    });
  });

  it("restores current DSP values before monitoring becomes audible", async () => {
    const requests: AudioBridgeRequest[] = [];
    Object.assign(window, { desktop: { audioRequest: vi.fn(async (request: AudioBridgeRequest) => {
      requests.push(request);
      return { status: 0, text: request.command === "GetDiagnostics" ? "SessionState: Running" : "Ok" };
    }) } });
    await audioClient.setDspParameter("reverb.mix", 0.42);
    await audioClient.setDspEnabled(true);
    requests.length = 0;

    await audioClient.setMonitoring(true);

    expect(requests.slice(0, 3)).toEqual([
      { command: "SetDspParameter", args: { name: "reverb.mix", value: 0.42 } },
      { command: "SetDspEnabled", args: { enabled: true } },
      { command: "SetMonitoring", args: { enabled: true } }
    ]);
  });
});
