import { chromium } from "@playwright/test";
import fs from "node:fs";
const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
const page = b.contexts()[0].pages().find(p => p.url().includes("index.html"));
const py = (method, path) => page.evaluate(([m, p]) => window.desktop.pythonRequest({ method: m, path: p }), [method, path]);
const out = {};
for (const s of (await py("GET", "/songs?limit=100")).body.items.filter(s => s.status === "Ready")) {
  const w = (await py("GET", `/songs/${s.songId}/editor`)).body.document.words;
  const a = await page.evaluate(([id, rev]) => window.desktop.resolveProjectArtifacts(id, rev), [s.songId, s.activeRevision]);
  out[s.title] = { vocal: a.vocals, words: w.map(x => [x.text, x.start, x.end]) };
}
fs.writeFileSync("/tmp/words.json", JSON.stringify(out));
process.exit(0);
