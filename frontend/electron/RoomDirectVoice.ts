import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { sendAudioRequest, type AudioRequest } from "./AudioServiceTransport";
import type { RoomServerRequest, RoomServerResponse } from "./RoomServerTransport";

const serverMix = "__room_server_mix__";
interface Peer { participantId: string; host: string; port: number; voiceToken: string;
  localHosts?: string[]; localPort?: number }
const validPeer = (value: unknown): value is Peer => {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return typeof p.participantId === "string" && /^[^|\r\n\0]{1,128}$/.test(p.participantId)
    && typeof p.host === "string" && isIP(p.host) === 4
    && Number.isInteger(p.port) && Number(p.port) > 0 && Number(p.port) <= 65535
    && typeof p.voiceToken === "string" && /^[0-9a-f]{16}$/i.test(p.voiceToken);
};
const localAddresses = () => Object.values(networkInterfaces()).flatMap(entries =>
  (entries ?? []).filter(entry => entry.family === "IPv4" && !entry.internal));
const ipv4 = (address: string) => address.split(".").reduce((n, octet) => (n << 8) | Number(octet), 0);

/** Probes the ordinary room's authenticated peer before changing which voice is audible. */
export class RoomDirectVoice {
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: Promise<void>;
  private stopped = false;
  private peer?: Peer;
  private packets = 0;
  private active = false;
  private attempts = 0;
  private startedAt = Date.now();
  private discovered = false;
  private readonly gains = new Map<string, number>();

  constructor(private readonly identity: { roomId: string; participantId: string; voiceToken: string },
    private readonly request: (request: RoomServerRequest) => Promise<RoomServerResponse>,
    private readonly current: () => boolean) {}

  get route(): "checking" | "direct" | "relay" {
    if (this.active) return "direct";
    return (!this.discovered || this.peer) && Date.now() - this.startedAt < 10_000 ? "checking" : "relay";
  }

  private async audio(command: string, args?: AudioRequest["args"]): Promise<string> {
    if (this.stopped || !this.current()) throw new Error("Direct voice session ended");
    const response = await sendAudioRequest({ command, ...(args && { args }) });
    if (response.status !== 0) throw new Error(response.text);
    if (this.stopped || !this.current()) throw new Error("Direct voice session ended");
    return response.text;
  }

  async start(localPort: number): Promise<void> {
    const response = await this.request({ method: "POST", path: "/voice/candidate",
      body: { ...this.identity, localPort, localHosts: localAddresses().map(entry => entry.address).slice(0, 8) } });
    if (!response.ok) throw new Error("Direct voice candidate registration failed");
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped || !this.current()) return;
    this.timer = setTimeout(() => {
      this.pending = this.poll().catch(async () => {
        if (!this.stopped && this.current()) await this.release().catch(() => undefined);
      }).finally(() => { this.pending = undefined; this.schedule(); });
    }, 1000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.pending;
  }

  async setGain(id: string, gain: number): Promise<void> {
    this.gains.set(id, gain);
    if (this.peer?.participantId === id)
      await this.audio("SetRemoteGain", { participantId: id, value: gain });
  }

  private async release(): Promise<void> {
    const hadPeer = this.peer !== undefined;
    if (this.peer) await this.audio("RemoveRemoteParticipant", { participantId: this.peer.participantId });
    this.peer = undefined;
    this.packets = 0;
    this.attempts = 0;
    if (hadPeer || this.active) await this.audio("SetRemoteMute", { participantId: serverMix, muted: false });
    this.active = false;
  }

  private async poll(): Promise<void> {
    const diagnostics = await this.audio("GetDiagnostics");
    const prefix = `RemoteDirectFirstPackets.${this.peer?.participantId}: `;
    const packets = Number(diagnostics.split(/\r?\n/).find(line => line.startsWith(prefix))?.slice(prefix.length) ?? 0);
    let received = this.peer !== undefined && packets > this.packets;
    this.packets = packets;
    const response = await this.request({ method: "POST", path: "/voice/peers", body: {
      ...this.identity, ...(received && { receivedPeerToken: this.peer!.voiceToken }),
    } });
    if (this.stopped || !this.current()) return;
    if (!response.ok) throw new Error("Direct voice discovery failed");
    this.discovered = true;
    const body = response.body as { peers?: unknown[]; directReady?: boolean } | null;
    const candidate = body?.peers?.length === 1 ? body.peers[0] : undefined;
    if (!validPeer(candidate) || candidate.participantId === this.identity.participantId) {
      await this.release(); return;
    }
    if (candidate.participantId !== this.peer?.participantId || candidate.voiceToken !== this.peer?.voiceToken) {
      received = false;
      await this.release();
      await this.audio("AddRemoteParticipant", { participantId: candidate.participantId });
      this.peer = candidate;
      this.startedAt = Date.now();
      await this.audio("SetRemoteMute", { participantId: candidate.participantId, muted: true });
      await this.audio("SetRemoteGain", { participantId: candidate.participantId,
        value: this.gains.get(candidate.participantId) ?? 1 });
    }
    const ready = received && body?.directReady === true;
    if (Boolean(ready) !== this.active) {
      // Mute the old route first: never play both copies of the same singer together.
      await this.audio("SetRemoteMute", { participantId: ready ? serverMix : candidate.participantId, muted: true });
      await this.audio("SetRemoteMute", { participantId: ready ? candidate.participantId : serverMix, muted: false });
      this.active = Boolean(ready);
    }
    if (!received) {
      const locals = (candidate.localHosts ?? []).filter(host => isIP(host) === 4 &&
        localAddresses().some(entry => (ipv4(host) & ipv4(entry.netmask)) === (ipv4(entry.address) & ipv4(entry.netmask))));
      const endpoints = [
        ...(Number.isInteger(candidate.localPort) && candidate.localPort! > 0 && candidate.localPort! <= 65535
          ? locals.map(host => ({ host, port: candidate.localPort! })) : []),
        { host: candidate.host, port: candidate.port },
      ];
      const endpoint = endpoints[Math.floor(this.attempts++ / 3) % endpoints.length]!;
      await this.audio("SetDirectPeer", { participantId: candidate.participantId,
        voiceToken: candidate.voiceToken, ...endpoint });
    }
  }
}
