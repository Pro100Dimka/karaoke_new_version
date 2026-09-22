export interface RoomProjectDownloadRequest {
  roomId: string;
  participantId: string;
  songId: string;
  revision: number;
}

interface DownloadOptions {
  attempts?: number;
  intervalMilliseconds?: number;
}

const projectIsStillPublishing = (error: unknown): boolean =>
  error instanceof Error && /room project download failed \(404\)/i.test(error.message);

/** A library item is advertised before its archive necessarily finishes exporting on its owner. */
export const downloadAvailableRoomProject = async (
  download: (request: RoomProjectDownloadRequest) => Promise<string>,
  wait: (milliseconds: number) => Promise<unknown>,
  request: RoomProjectDownloadRequest,
  options: DownloadOptions = {}
): Promise<string> => {
  const attempts = Math.max(1, options.attempts ?? 240);
  const intervalMilliseconds = Math.max(0, options.intervalMilliseconds ?? 500);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await download(request);
    } catch (error) {
      if (!projectIsStillPublishing(error) || attempt === attempts) throw error;
      await wait(intervalMilliseconds);
    }
  }
  throw new Error("Room project did not become available");
};
