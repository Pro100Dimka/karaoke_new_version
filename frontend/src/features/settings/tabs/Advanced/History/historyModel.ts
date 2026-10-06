import type { HistoryEventDto } from "../../../../../contracts/models";

export type HistoryTab = "performances" | "processing";

export const historyKinds = {
  performances: ["RecordingRegistered", "AnalysisCompleted"],
  processing: ["ProcessingStarted", "ProcessingSucceeded", "ProcessingFailed"],
} as const satisfies Record<HistoryTab, readonly string[]>;
export type HistoryKind = (typeof historyKinds)[HistoryTab][number];

const performanceKinds: ReadonlySet<string> = new Set(historyKinds.performances);
const processingKinds: ReadonlySet<string> = new Set(historyKinds.processing);

/** The message key of a kind's name, or none for a kind this version does not know. */
export const historyKindLabel = (kind: string): `historyKind${HistoryKind}` | null =>
  performanceKinds.has(kind) || processingKinds.has(kind) ? (`historyKind${kind}` as `historyKind${HistoryKind}`) : null;

export const historyTabOf = (event: HistoryEventDto): HistoryTab | null => {
  if (performanceKinds.has(event.kind)) return "performances";
  if (processingKinds.has(event.kind)) return "processing";
  return null;
};

export const eventsForTab = (
  events: readonly HistoryEventDto[],
  tab: HistoryTab,
): readonly HistoryEventDto[] =>
  events.filter((event) => historyTabOf(event) === tab);
