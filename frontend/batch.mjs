import { chromium } from "@playwright/test";
import fs from "node:fs";
const files = fs.readFileSync("/tmp/batch.txt", "utf8").split("\n").filter(Boolean);
const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
const page = b.contexts()[0].pages().find(p => p.url().includes("index.html"));
const py = (method, path, body, headers) => page.evaluate(([m, p, b, h]) => window.desktop.pythonRequest({ method: m, path: p, body: b, headers: h }), [method, path, body, headers]);
const key = () => "b-" + Math.random();
const existing = (await py("GET", "/songs?limit=200")).body.items;
const ids = new Set(existing.map(s => s.songId));
for (const f of files) {
  const r = await py("POST", "/songs", { sourcePath: "E:/Музыка/" + f }, { "Idempotency-Key": key() });
  if (r.status === 201) { ids.add(r.body.songId); console.log("imported", r.body.title, "|", r.body.artist); }
  else console.log("skip", f, r.status);
}
for (const s of (await py("GET", "/songs?limit=200")).body.items) await py("POST", `/songs/${s.songId}/processing`, { mode: "Auto", onlineLyrics: true }, { "Idempotency-Key": key() });
for (let i = 0; i < 600; i++) {
  const list = (await py("GET", "/songs?limit=200")).body.items;
  if (!list.some(s => ["Processing", "Queued", "Imported"].includes(s.status))) break;
  if (i % 20 === 0) console.log(i * 6, "s waiting:", list.filter(s => ["Processing", "Queued", "Imported"].includes(s.status)).length);
  await new Promise(r => setTimeout(r, 6000));
}
const out = {};
for (const s of (await py("GET", "/songs?limit=200")).body.items) {
  if (s.status !== "Ready") { console.log("NOT READY", s.status, s.title); continue; }
  const doc = (await py("GET", `/songs/${s.songId}/editor`)).body.document;
  const a = await page.evaluate(([id, rev]) => window.desktop.resolveProjectArtifacts(id, rev), [s.songId, s.activeRevision]);
  out[s.title + " | " + s.artist] = { vocal: a.vocals, lyrics: doc.lyrics, words: doc.words.map(x => [x.text, x.start, x.end, x.letters?.length === x.text.length]) };
}
fs.writeFileSync("/tmp/words.json", JSON.stringify(out));
console.log("done", Object.keys(out).length);
process.exit(0);
