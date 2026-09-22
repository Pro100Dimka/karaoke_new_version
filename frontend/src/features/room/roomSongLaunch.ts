interface ImportedRoomSong {
  id: string;
}

interface RoomSongLaunchSteps {
  download(): Promise<string>;
  importProject(path: string): Promise<ImportedRoomSong>;
  refresh(): Promise<unknown>;
  markPlayed(songId: string): void;
  beginTransition(): void;
  waitForTransition(): Promise<unknown>;
  navigate(songId: string): void;
}

/** Keeps the long transfer/import phase visible; the curtain is only the final route transition. */
export const prepareAndLaunchRoomSong = async (steps: RoomSongLaunchSteps): Promise<void> => {
  const path = await steps.download();
  const imported = await steps.importProject(path);
  await steps.refresh();
  steps.markPlayed(imported.id);
  steps.beginTransition();
  await steps.waitForTransition();
  steps.navigate(imported.id);
};
