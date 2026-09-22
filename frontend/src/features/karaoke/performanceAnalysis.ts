import type { AnalysisDto } from "../../contracts/models";

interface AnalysisClient {
  latestAnalysis(recordingId: string): Promise<AnalysisDto | null>;
  analyzeRecording(recordingId: string): Promise<AnalysisDto>;
}

/** A manually stopped take is complete input: analyse the saved partial duration immediately. */
export const ensurePerformanceAnalysis = async (
  recordingId: string,
  client: AnalysisClient,
): Promise<AnalysisDto> =>
  (await client.latestAnalysis(recordingId)) ?? client.analyzeRecording(recordingId);
