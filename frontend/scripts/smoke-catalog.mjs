export const clientSongs = async page => {
  const response = await page.evaluate(() => window.desktop.pythonRequest({ method: "GET", path: "/songs?limit=200" }));
  if (!response.ok || !Array.isArray(response.body?.items)) {
    throw new Error(`Client song catalog failed (${response.status})`);
  }
  return response.body.items;
};
