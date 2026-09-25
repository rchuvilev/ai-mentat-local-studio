//
// IPC smoke test.
//
// Boots the real main process under Electron and drives the IPC surface the
// renderer depends on. Not a unit test — the point is to catch a handler that
// was renamed, a module that throws on load, or a contract the UI relies on
// quietly changing shape.
//
//   npm run bundle && npm test
//
// Headless smoke test: boots the real main process under Electron, exercises the
// IPC surface the renderer depends on, and exits with a pass/fail summary.
const { app, ipcMain, BrowserWindow } = require('electron');
const path = require('path');

// Load the real main process: its ipcMain.handle(...) calls run at module scope.
require(require('path').join(__dirname, '..', 'electron-main.bundle.js'));

app.whenReady().then(async () => {
  // Close the window the app opens; this test drives IPC only.
  setTimeout(() => BrowserWindow.getAllWindows().forEach(w => w.destroy()), 300);
  await new Promise(r => setTimeout(r, 600));
  const results = [];
  const check = async (name, fn) => {
    try { const v = await fn(); results.push(['PASS', name, v]); }
    catch (e) { results.push(['FAIL', name, e.message]); }
  };

  // Invoke the handlers the main process registered, the way the renderer does.
  const invoke = (channel, ...args) => {
    const h = ipcMain._invokeHandlers.get(channel);
    if (!h) throw new Error(`no handler for ${channel}`);
    return h({}, ...args);
  };

  await check('setup:status', async () => {
    const s = await invoke('setup:status');
    if (!Array.isArray(s.engines) || !Array.isArray(s.models)) throw new Error('bad shape');
    return `${s.engines.length} engines, ${s.models.length} models, ready=${s.ready}, missing=[${s.missingRequired.join('|')}]`;
  });
  await check('capacity:summary', async () => {
    const c = await invoke('capacity:summary', { mode: 'movie', outputSec: 15 });
    if (!c.estimateHuman) throw new Error('no estimate');
    return `${c.estimateHuman} on ${c.accelerator}, maxLen=${c.recommendedMaxSeconds}s`;
  });
  await check('motion:list', async () => (await invoke('motion:list')).map(m => m.id).join(','));
  await check('settings:get', async () => {
    const s = await invoke('settings:get');
    return `mode=${s.mode} len=${s.outputSec} steps=${Object.keys(s.steps).length}`;
  });
  await check('settings:set roundtrip', async () => {
    await invoke('settings:set', { outputSec: 23 });
    const s = await invoke('settings:get');
    if (s.outputSec !== 23) throw new Error('not persisted');
    await invoke('settings:set', { outputSec: 10 });
    return 'persisted';
  });
  await check('queue add/list/remove', async () => {
    const a = await invoke('queue:add', 'smoke one\nsmoke two');
    const l = await invoke('queue:list');
    const id = l.items[0].id;
    await invoke('queue:remove', id);
    const after = await invoke('queue:list');
    await invoke('queue:clear', 'all');
    return `added=${a.added} listed=${l.items.length} afterRemove=${after.items.length}`;
  });
  await check('runs:list', async () => `${(await invoke('runs:list', {})).length} runs`);
  await check('setup:paths', async () => {
    const p = await invoke('setup:paths');
    if (!p.root) throw new Error('no root');
    return `ffmpeg=${p.ffmpeg ? 'yes' : 'no'}`;
  });
  await check('run:start rejects empty prompt', async () => {
    const r = await invoke('run:start', { mode: 'image', prompt: '   ' });
    if (r.success) throw new Error('should have failed');
    return `rejected: ${r.error}`;
  });
  await check('run:start reports missing engine', async () => {
    const r = await invoke('run:start', { mode: 'image', prompt: 'a lighthouse' });
    if (r.success) throw new Error('unexpectedly succeeded without engines');
    return `surfaced: ${r.error || (r.warnings||[]).join(';')}`;
  });
  await check('media:url rejects path traversal', async () => {
    const u = await invoke('media:url', '/etc/passwd');
    if (u !== null) throw new Error('allowed outside outputs dir!');
    return 'blocked';
  });

  let fails = 0;
  for (const [st, name, info] of results) {
    if (st === 'FAIL') fails++;
    console.log(`${st}  ${name.padEnd(34)} ${String(info).slice(0, 110)}`);
  }
  console.log(`\n${results.length - fails}/${results.length} passed`);
  app.exit(fails ? 1 : 0);
});
