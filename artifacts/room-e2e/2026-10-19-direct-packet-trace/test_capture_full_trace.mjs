import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const scriptUrl = new URL('../2026-10-15-real-mic-v2/capture-run.mjs', import.meta.url);
const source = readFileSync(scriptUrl, 'utf8').replace(/^import .*;\r?\n/gm, '')
  .replaceAll('import.meta.url', JSON.stringify(scriptUrl.href));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function run({ fullTrace = true, failPlay = false } = {}) {
  const events = [], files = new Map();
  const levels = [{ 'Музыка': 0, 'Вокал': 0, 'Мик': 1 }, { 'Музыка': 1, 'Вокал': 0, 'Мик': 1 }];
  const pages = levels.map((values, index) => ({
    bringToFront: async () => {}, url: () => 'file:///dist/index.html#/karaoke/fixture-song',
    mouse: { move: async () => {} }, waitForTimeout: async () => {}, waitForURL: async () => {},
    screenshot: async () => {},
    evaluate: async callback => String(callback).includes('innerWidth') ? { width: 1000, height: 800 } : {
      visibility: 'visible', focused: true, dialogs: [],
      sliders: [...Object.entries(values).map(([label, value]) => ({ label, value: String(value) })),
        { label: 'Громкость: peer', value: '1' }],
    },
    locator() {
      return { filter() { return this; }, first() { return this; }, getByRole() {
        return { click: async () => { events.push('UI_PLAY'); if (failPlay) throw Error('fixture UI failure'); } };
      } };
    },
    getByRole(role, { name }) {
      return { count: async () => 0, getAttribute: async () => '1',
        press: async key => { if (role === 'slider' && typeof name === 'string') values[name] = Number(key === 'End'); } };
    },
  }));
  const execFile = async (program, args) => {
    if (program === 'fixture-node') {
      levels[0]['Вокал'] = 1;
      return { stdout: '' };
    }
    const machine = program === 'ssh' ? 'laptop' : 'host';
    const command = machine === 'laptop' ? args[1] : args.join(' ');
    if (!command.startsWith('ac.bat ') && machine === 'laptop') return { stdout: '' };
    events.push(`${machine}:${command.replace(/^ac\.bat /, '')}`);
    if (command.includes('GetDiagnostics'))
      return { stdout: `0|0\nMicrophoneEnabled: ${machine === 'host' ? 1 : 0}\nMonitoringEnabled: 0\n` };
    return { stdout: '0|0' };
  };
  let browserIndex = 0;
  const chromium = { connectOverCDP: async () => {
    const index = browserIndex++;
    return { contexts: () => [{ pages: () => [pages[index]] }],
      close: async () => { events.push(`CLOSE_${index}`); } };
  } };
  const process = { argv: ['node', 'capture-run', 'fixture-room', 'host-to-laptop', 'fixture-label', '0', 'start'],
    env: { AD_VOICE_EVIDENCE_DIR: 'D:/Git/karaoke_new_version/artifacts/room-e2e/2026-10-19-direct-packet-trace',
      AD_VOICE_SAVE_FULL_PACKET_TRACE: fullTrace ? '1' : '0', AD_VOICE_SAVE_PACKET_TRACE: '1' }, execPath: 'fixture-node' };
  const script = new AsyncFunction('execFile', 'promisify', 'appendFileSync', 'writeFileSync', 'mkdirSync',
    'path', 'createRequire', 'process', 'fetch', 'setTimeout', 'console', source);
  let error;
  try {
    await script(execFile, value => value, () => {}, (file, data) => files.set(file, data), () => {},
      path, () => () => ({ chromium }), process,
      async () => ({ json: async () => ({ playbackState: 'Playing', playbackStartedAt: new Date().toISOString(), songId: 'fixture-song' }) }),
      callback => queueMicrotask(callback), { log() {} });
  } catch (caught) { error = caught; }
  return { events, files, error };
}

test('full trace starts before UI play and stops before export on both physical PCs', async () => {
  const { events, files, error } = await run();
  assert.ifError(error);
  for (const machine of ['host', 'laptop']) {
    const start = events.findIndex(value => value.startsWith(`${machine}:SetDiagnosticRoomInput packetTrace=start`));
    const stop = events.findIndex(value => value.startsWith(`${machine}:SetDiagnosticRoomInput packetTrace=stop`));
    const exported = events.findIndex(value => value.startsWith(`${machine}:SetDiagnosticRoomInput packetTrace=export tracePath=`));
    const recordingStopped = events.findLastIndex(value => value === `${machine}:StopRecording`);
    assert.ok(start >= 0 && start < events.indexOf('UI_PLAY'), `missing early start for ${machine}`);
    assert.ok(recordingStopped < stop && stop < exported, `stop/export ordering for ${machine}`);
  }
  assert.ok(events.some(value => value.includes('fixture-label-main-packet-trace')));
  assert.ok(events.some(value => value.includes('fixture-label-laptop-packet-trace')));
  assert.equal(events.some(value => value.includes('enabled=')), false);
  assert.ok([...files.values()].some(value => JSON.parse(value).fullPacketTrace?.commands?.length === 6));
});

test('failed UI play still stops and exports each started trace', async () => {
  const { events, error } = await run({ failPlay: true });
  assert.match(String(error), /fixture UI failure/);
  for (const machine of ['host', 'laptop']) {
    assert.ok(events.includes(`${machine}:SetDiagnosticRoomInput packetTrace=stop`));
    assert.ok(events.some(value => value.startsWith(`${machine}:SetDiagnosticRoomInput packetTrace=export tracePath=`)));
  }
  assert.ok(events.includes('CLOSE_0') && events.includes('CLOSE_1'));
});

test('ordinary capture does not enable the full trace', async () => {
  const { events, error } = await run({ fullTrace: false });
  assert.ifError(error);
  assert.equal(events.some(value => value.includes('packetTrace=')), false);
});
