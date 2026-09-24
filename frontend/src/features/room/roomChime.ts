export type RoomChimeKind = "join" | "leave";

export const roomChimeKinds = (change: { joined: number; left: number }): RoomChimeKind[] => [
  ...(change.joined > 0 ? ["join" as const] : []),
  ...(change.left > 0 ? ["leave" as const] : []),
];
