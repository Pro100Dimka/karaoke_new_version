import type { HistoryEventDto } from "../../contracts/models";

export type HistoryTab = "performances" | "processing";

const performanceKinds = new Set(["RecordingRegistered", "AnalysisCompleted"]);
const processingKinds = new Set(["ProcessingStarted", "ProcessingSucceeded", "ProcessingFailed"]);

export const historyTabOf = (event: HistoryEventDto): HistoryTab | null => {
  if (performanceKinds.has(event.kind)) return "performances";
  if (processingKinds.has(event.kind)) return "processing";
  return null;
};

export const eventsForTab = (events: readonly HistoryEventDto[], tab: HistoryTab): readonly HistoryEventDto[] =>
  events.filter(event => historyTabOf(event) === tab);
