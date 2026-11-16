export const allSongs = async (readPage) => {
  const songs = [];
  for (;;) {
    const page = await readPage(
      `/songs?limit=200${songs.length ? `&offset=${songs.length}` : ''}`,
    );
    if (!Array.isArray(page?.items))
      throw new Error('Client song catalog failed (invalid page)');
    songs.push(...page.items);
    if (
      page.items.length < (page.limit ?? 200) ||
      page.items.length === 0 ||
      (page.total !== undefined && songs.length >= page.total)
    )
      return songs;
  }
};

export const clientSongs = (page) =>
  allSongs(async (route) => {
    const response = await page.evaluate(
      (path) => window.desktop.pythonRequest({ method: 'GET', path }),
      route,
    );
    if (!response.ok)
      throw new Error(`Client song catalog failed (${response.status})`);
    return response.body;
  });

export const clientRoom = async (page, code) => {
  const response = await page.evaluate(
    (roomCode) =>
      window.desktop.roomRequest({
        method: 'GET',
        path: `/rooms/${encodeURIComponent(roomCode)}`,
      }),
    code,
  );
  if (!response.ok || typeof response.body?.roomId !== 'string')
    throw new Error(`Client room snapshot failed (${response.status})`);
  return response.body;
};
