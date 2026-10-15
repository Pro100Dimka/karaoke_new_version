import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire('D:/Git/karaoke_new_version/frontend/package.json');
const { chromium } = require('playwright');
const exec = promisify(execFile);
const [code, direction, label, seconds = '150', mode = ''] = process.argv.slice(2);
if (!code || !['host-to-laptop', 'laptop-to-host'].includes(direction) || !label)
  throw new Error('capture-run.mjs ROOM DIRECTION LABEL SECONDS');
const dir = process.env.AD_VOICE_EVIDENCE_DIR || path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const control = 'D:/Git/karaoke_new_version/AudioService/build/Release/AudioControl.exe';
const env = { ...process.env, AD_VOICE_AUDIO_ENDPOINT: String.raw`\\.\pipe\ADVoice.AudioService.Dev.v1` };
const parse = raw => Object.fromEntries(raw.split(/\r?\n/).flatMap(line => {
  const colon = line.indexOf(': ');
  return colon > 0 ? [[line.slice(0, colon), line.slice(colon + 2)]] : [];
}));
const command = async (machine, args) => {
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const result = machine === 'host'
        ? await exec(control, args, { env, timeout: 10000 })
        : await exec('ssh', ['pro10@192.168.0.194', 'ac.bat ' + args.join(' ')], { timeout: 12000 });
      if (!result.stdout.trimStart().startsWith('0|')) throw new Error(result.stdout);
      return result.stdout;
    } catch (error) {
      if (attempt === 11) throw error;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
};
const evidence = { code, direction, label, startedAt: new Date().toISOString(), commands: {} };
const uiBrowsers = await Promise.all([9351, 9352].map(port => chromium.connectOverCDP(`http://127.0.0.1:${port}`)));
const uiPages = uiBrowsers.map(browser => {
  const pages = browser.contexts().flatMap(context => context.pages()).filter(page => /\/dist\/index\.html/.test(page.url()));
  if (pages.length !== 1) throw new Error(`Expected exactly one application page, got ${pages.length}`);
  return pages[0];
});
await Promise.all(uiPages.map(page => page.bringToFront()));
if (mode === 'start') {
  await uiPages[0].locator('.songCard').filter({ hasText: 'Мне 25' }).first()
    .getByRole('button', { name: /Запустить караоке/i }).click();
  await Promise.all(uiPages.map(page => page.waitForURL(/#\/karaoke\//, { timeout: 180000 })));
  await Promise.all(uiPages.map(async (page, index) => {
    const sender = (direction === 'host-to-laptop') === (index === 0);
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    await page.mouse.move(viewport.width / 2 + 10, viewport.height - 80);
    await page.mouse.move(viewport.width / 2, viewport.height - 30);
    await page.waitForTimeout(250);
    for (const [name, key] of Object.entries({ 'Музыка': sender ? 'Home' : 'End', 'Вокал': 'Home', 'Мик': 'End' }))
      await page.getByRole('slider', { name, exact: true }).press(key);
    const toggle = page.getByRole('button', { name: sender ? 'Включить мой микрофон' : 'Выключить мой микрофон', exact: true });
    if (await toggle.count()) await toggle.press('Enter');
    const remote = page.getByRole('slider', { name: /^Громкость:/ });
    if (await remote.getAttribute('aria-valuenow') !== '1') throw new Error('Set remote gain to 100% before start');
  }));
  for (let attempt = 0; ; attempt++) {
    const room = await fetch(`http://130.61.169.61:8081/rooms/${code}`).then(response => response.json());
    if (room.playbackState === 'Playing' && room.playbackStartedAt) break;
    if (attempt === 100) throw new Error('UI start did not reach Playing');
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  evidence.userRecordingPreflight = await Promise.all(['host', 'laptop'].map(async machine => {
    const observations = [];
    for (let attempt = 0; attempt < 15; attempt++) {
      const reply = await command(machine, ['GetRecordingState']);
      observations.push({ at: new Date().toISOString(), reply });
      if (['0|0', '0|2', '0|5'].includes(reply.trim()) && observations.length >= 2 &&
          observations.at(-2).reply.trim() === reply.trim()) return { machine, observations };
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`${machine}: recording state did not settle before diagnostic capture`);
  }));
}
let physicalLevels = false, nextUiShot = 0;
const uiFailures = [];
const snapshot = async () => {
  const results = await Promise.allSettled([
    fetch(`http://130.61.169.61:8081/rooms/${code}`).then(r => r.json()),
    ...['host', 'laptop'].map(machine => command(machine, ['GetDiagnostics']).then(raw => {
      if (process.env.AD_VOICE_SAVE_PACKET_TRACE === '1')
        appendFileSync(path.join(dir, `${label}-${machine}-raw-diagnostics.jsonl`),
          JSON.stringify({ at: new Date().toISOString(), raw }) + '\n');
      return parse(raw);
    }))
  ]);
  const row = { at: new Date().toISOString() };
  results.forEach((r, i) => { row[['room', 'host', 'laptop'][i]] = r.status === 'fulfilled' ? r.value : { error: String(r.reason) }; });
  row.ui = await Promise.all(uiPages.map(async (page, index) => ({
    machine: ['host', 'laptop'][index], url: page.url(),
    ...await page.evaluate(() => ({ visibility: document.visibilityState, focused: document.hasFocus(),
      dialogs: [...document.querySelectorAll('dialog[open]')].map(item => item.innerText),
      sliders: [...document.querySelectorAll('[role="slider"]')].map(item => ({
        label: item.getAttribute('aria-label'), value: item.getAttribute('aria-valuenow') })) }))
  })));
  const epoch = evidence.before?.room ?? row.room;
  const songSeconds = (Date.now() - Date.parse(epoch.playbackStartedAt)) / 1000;
  row.originalSongSeconds = songSeconds;
  // The final end transition may return either UI to the library. Every live song sample
  // (including all three mandatory measurement windows) requires the same rendered project.
  if (songSeconds < 160.8) {
    for (let index = 0; index < row.ui.length; index++) {
      const ui = row.ui[index];
      const expected = `#/karaoke/${epoch.songId}`;
      if (!ui.url.endsWith(expected) || ui.dialogs.length)
        uiFailures.push({ at: row.at, songSeconds, machine: ui.machine, reason: 'wrong page or modal', ui });
      if (physicalLevels) {
        const sender = (direction === 'host-to-laptop') === (index === 0);
        const levels = Object.fromEntries(ui.sliders.map(item => [item.label, Number(item.value)]));
        const remote = ui.sliders.find(item => item.label?.startsWith('Громкость:'));
        if (levels['Музыка'] !== Number(!sender) || levels['Вокал'] !== Number(sender) || Number(remote?.value) !== 1)
          uiFailures.push({ at: row.at, songSeconds, machine: ui.machine, reason: 'role levels changed', ui });
      }
    }
  }
  row.uiGateFailures = uiFailures.length;
  if (Date.now() >= nextUiShot) {
    const suffix = `${Math.max(0, Math.round(songSeconds))}s`;
    await Promise.all(uiPages.map((page, index) => page.screenshot({ path: path.join(dir, `${label}-${['host', 'laptop'][index]}-${suffix}.png`), fullPage: true })));
    nextUiShot = Date.now() + 30000;
  }
  appendFileSync(path.join(dir, `${label}-diagnostics.jsonl`), JSON.stringify(row) + '\n');
  return row;
};
evidence.before = await snapshot();
if (uiFailures.length) throw new Error('Both PCs must show the same karaoke page before capture');
for (let index = 0; index < evidence.before.ui.length; index++) {
  const sender = (direction === 'host-to-laptop') === (index === 0);
  const levels = Object.fromEntries(evidence.before.ui[index].sliders.map(item => [item.label, Number(item.value)]));
  const diagnostic = evidence.before[['host', 'laptop'][index]];
  if (levels['Музыка'] !== Number(!sender) || levels['Вокал'] !== 0 ||
      levels['Мик'] !== 1 || diagnostic.MicrophoneEnabled !== String(Number(sender)) ||
      diagnostic.MonitoringEnabled !== '0')
    throw new Error(`${evidence.before.ui[index].machine}: physical role/quiet lead not ready before capture`);
}
for (const machine of ['host', 'laptop']) {
  const sender = (direction === 'host-to-laptop') === (machine === 'host');
  const tap = sender ? 'network' : 'master';
  const wavPath = machine === 'host'
    ? path.join(dir, `${label}-${sender ? 'sender-mic' : 'receiver-master'}.wav`)
    : `C:\\Users\\pro10\\${label}-${sender ? 'sender-mic' : 'receiver-master'}.wav`;
  const commands = [];
  for (const args of [['StopRecording'], ['PrepareRecording', `id=${label}-${tap}`, `path=${wavPath}`, `tap=${tap}`, ...(sender ? [] : ['backing=true'])], ['StartRecording']])
    commands.push({ at: new Date().toISOString(), args, reply: await command(machine, args) });
  evidence.commands[machine] = { wavPath, tap, commands };
}
evidence.recordingStartedAt = new Date().toISOString();
writeFileSync(path.join(dir, `${label}-evidence.json`), JSON.stringify(evidence, null, 2));
const until = Date.now() + Number(seconds) * 1000;
await new Promise(resolve => setTimeout(resolve, 3000));
const senderPort = direction === 'host-to-laptop' ? '9351' : '9352';
await exec(process.execPath, [
  'D:/Git/karaoke_new_version/artifacts/room-e2e/2026-10-15-1919-room-deadline/ui.mjs',
  senderPort, 'levels', JSON.stringify({ 'Вокал': 'End' })
], { timeout: 15000 });
evidence.vocalOnAt = new Date().toISOString();
if (process.env.AD_VOICE_SAVE_PACKET_TRACE === '1') {
  evidence.traceRearm = [];
  for (const machine of ['host', 'laptop'])
    evidence.traceRearm.push({ machine, at: new Date().toISOString(),
      reply: await command(machine, ['SetDiagnosticRoomInput', 'enabled=false', 'resetLateCutSeries=true']) });
}
physicalLevels = true;
writeFileSync(path.join(dir, `${label}-evidence.json`), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ recordingReady: true, label, vocalOnAt: evidence.vocalOnAt }));
while (Date.now() < until) {
  const row = await snapshot();
  console.log(JSON.stringify({ at: row.at, state: row.room?.playbackState, deadlineMs: row.room?.roomPlayoutDelayMs,
    hostPosition: row.host?.PlaybackPositionFrames, laptopPosition: row.laptop?.PlaybackPositionFrames,
    hostPeak: row.host?.InputPeak, laptopPeak: row.laptop?.InputPeak }));
  if (uiFailures.length) break;
  await new Promise(resolve => setTimeout(resolve, Math.min(5000, Math.max(1, until - Date.now()))));
}
evidence.stop = {};
for (const machine of ['host', 'laptop']) {
  evidence.stop[machine] = { at: new Date().toISOString(), reply: await command(machine, ['StopRecording']),
    metadata: await command(machine, ['GetRecordingState', 'details=true']) };
}
evidence.after = await snapshot();
evidence.finishedAt = new Date().toISOString();
evidence.uiGate = { passed: uiFailures.length === 0, failures: uiFailures };
writeFileSync(path.join(dir, `${label}-evidence.json`), JSON.stringify(evidence, null, 2));
await Promise.all(uiBrowsers.map(browser => browser.close()));
console.log(JSON.stringify({ done: true, label, at: evidence.finishedAt }));
if (uiFailures.length) process.exitCode = 1;
