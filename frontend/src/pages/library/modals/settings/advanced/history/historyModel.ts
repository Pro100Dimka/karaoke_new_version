export const historyKinds = {
  performances: ["RecordingRegistered", "AnalysisCompleted"],
  processing: ["ProcessingStarted", "ProcessingSucceeded", "ProcessingFailed"],
} as const;
export type HistoryTab = keyof typeof historyKinds;
export type HistoryKind = (typeof historyKinds)[HistoryTab][number];

const knownKinds = new Set<string>(Object.values(historyKinds).flat());

/** Unknown future kinds keep their backend label. */
export const historyKindLabel = (
  kind: string,
): `historyKind${HistoryKind}` | null =>
  knownKinds.has(kind)
    ? (`historyKind${kind}` as `historyKind${HistoryKind}`)
    : null;
