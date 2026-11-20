/** Source-order interval blocks avoid scanning the full document on each scroll. */
export const editorRollIndex = <
  T extends { id: string; start: number; end: number },
>(
  items: readonly T[],
) => {
  const size = 128;
  const indices = new Map(items.map((item, index) => [item.id, index]));
  const blocks: { from: number; to: number; start: number; end: number }[] = [];
  for (let from = 0; from < items.length; from += size) {
    const to = Math.min(items.length, from + size);
    let start = Infinity;
    let end = -Infinity;
    for (let index = from; index < to; index++) {
      start = Math.min(start, items[index]!.start);
      end = Math.max(end, items[index]!.end);
    }
    blocks.push({ from, to, start, end });
  }
  return {
    indexOf: (id: string) => indices.get(id),
    visible(
      start: number,
      end: number,
      pinned: readonly (string | null)[] = [],
    ) {
      const keep = new Set(
        pinned.flatMap((id) => (id === null ? [] : [indices.get(id)])),
      );
      const result: T[] = [];
      for (const block of blocks) {
        if (
          (block.end < start || block.start > end) &&
          ![...keep].some(
            (index) =>
              index !== undefined && index >= block.from && index < block.to,
          )
        )
          continue;
        for (let index = block.from; index < block.to; index++) {
          const item = items[index]!;
          if (keep.has(index) || (item.end >= start && item.start <= end))
            result.push(item);
        }
      }
      return result;
    },
  };
};
