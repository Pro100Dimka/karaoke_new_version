import type { EditorWord } from '../../application/editor/editorModel';
import { type LyricLine } from './karaokeLyrics';
const word = (id: string, start: number, end: number): EditorWord => ({
  id,
  text: id,
  start,
  end,
});
const line = (start: number, end: number): LyricLine => ({
  words: [word('w', start, end)],
  start,
  end,
});
export { word, line };
