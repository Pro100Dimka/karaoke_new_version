import type { SongDto } from "../../contracts/models";
import type { EditorDocument } from "./editorModel";

export interface EditorRepository {
  load(songId: string): Promise<EditorDocument>;
  reset(songId: string, expectedRevision: number): Promise<number>;
  save(song: SongDto, document: EditorDocument, revision: number): Promise<number>;
}
