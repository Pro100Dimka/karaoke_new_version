import { isSupportedAudio } from "./importModel";

export interface BatchImportResult {
  imported: number;
  /** File names that could not be added (unsupported format or a failed import). */
  failed: string[];
}

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;
const extension = (path: string) => {
  const name = fileName(path);
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1);
};

/**
 * Adds several files one after another, so each one appears in the library and joins the processing
 * queue in the order it was chosen; one bad file does not stop the rest.
 */
export const importOneByOne = async (
  paths: readonly string[],
  importOne: (path: string) => Promise<unknown>,
): Promise<BatchImportResult> => {
  const result: BatchImportResult = { imported: 0, failed: [] };
  for (const path of paths) {
    if (!isSupportedAudio(extension(path))) {
      result.failed.push(fileName(path));
      continue;
    }
    try {
      await importOne(path);
      result.imported += 1;
    } catch {
      result.failed.push(fileName(path));
    }
  }
  return result;
};
