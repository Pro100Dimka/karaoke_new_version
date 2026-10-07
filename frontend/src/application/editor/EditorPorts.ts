import type { AudioServiceClient, PythonClient } from "../../contracts/clients";
import type { PlaybackSnapshot, SongDto } from "../../contracts/models";
import type { EditorDocument } from "./editorModel";

export type EditorAudioPort = Pick<AudioServiceClient,
  "prepareSong" | "stop" | "play" | "pause" | "seek"> & {
  snapshot(): Promise<PlaybackSnapshot>;
};

export type EditorBackendPort = Pick<PythonClient, "getSong" | "projectCompatibility">;

export interface EditorRepository {
  load(songId: string): Promise<EditorDocument>;
  save(song: SongDto, document: EditorDocument, revision: number): Promise<number>;
}
