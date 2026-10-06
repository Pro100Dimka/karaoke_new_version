export const roomEn = {
  participantJoined: "{name} joined",
  participantLeft: "{name} left",
  roomClosed: "The room was closed",
  roomNetworkUnavailable: "Network unavailable. Local features keep working.",
  roomProjectConflict:
    "You have a different version of this song. Your copy was kept.",
  roomReplaceProject: "Replace with the host's version",
  roomReconnecting: "Reconnecting to the room…",
  roomCheckSync: "Check synchronization",
  roomSyncResult: "Voice latency estimate",
  roomSyncEstimateHint:
    "Estimated from the audio buffer, RTT and adaptive jitter buffer",
  roomQualityClose: "Like one room: everyone hears everyone {ms} ms late",
  roomQualityFollower:
    "You sing on the leader's beat: your music is shifted by {ms} ms",
  roomQualitySynchronized:
    "Server synchronization: everyone hears the same timeline with a {ms} ms safety delay",
  roomQualityNoticeable:
    "You hear the others {ms} ms late: noticeable, but fine for singing",
  roomQualityFar:
    "High latency ({ms} ms): a cable instead of Wi‑Fi, ASIO and wired headphones will help a lot",
  roomPing: "Ping",
  roomJitter: "Jitter",
  roomRoute: "Route",
  roomRouteDirect: "direct",
  roomRouteRelay: "via server",
  roomDeviceStarving:
    "This computer's sound card cannot keep up and crackles. Choose a larger buffer in the audio settings.",
  roomUnstableLink:
    "The connection stalls and voices break up. Connect this computer by cable instead of Wi‑Fi.",
  roomTimingDetails: "What the latency means",
  roomSyncClicksHint: "Four shared reference clicks will play in three seconds",
  hostLeavingTitle: "You are the host",
  hostLeavingBody:
    "Leaving transfers the host role to the participant who joined first.",
  transferHost: "Transfer host and leave",
  transferHostAction: "Make {name} the host",
  closeRoom: "Close room",
  removeParticipant: "Remove {name}",
  removeParticipantTitle: "Remove participant?",
  removeParticipantBody:
    "{name} will leave the room and must join again to return.",
  removedFromRoom: "You were removed from the room.",
  cancelTransfer: "Cancel transfer",
  retryTransfer: "Retry transfer",
  roomCodePasteHint: "Paste the code from a friend: you join right away",
} as const;
