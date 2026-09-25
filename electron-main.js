'use strict';
//
// Hexstack Mentat Local Studio — main process.
//
// Wires the ai/ modules to the renderer over IPC and owns the two
// process-lifetime concerns the design notes called out:
//
//   "again music generation nearly ended and window closed ruining all
//    progress..."   -> a close during a run is intercepted, and the display is
//                      kept awake so a long generation is not interrupted
//   "how to get to setup screen"
//                   -> Setup is a first-class tab plus a menu item, not a state
//                      you can only reach by having no models installed

const { app, BrowserWindow, ipcMain, shell, dialog, powerSaveBlocker, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

const { setupAutoUpdate } = require('./sdk/logic/auto-update');

const capacity = require('./ai/capacity');
// The advisor modules are TypeScript. esbuild bundles the whole main-process
// import graph (sdk/utils/bundle-electron.js) and resolves .ts transparently, so
// these require() calls need no extension and no build step of their own.
const advisor = require('./ai/advisor');
const stacks = require('./ai/stacks');
const hardware = require('./ai/hardware');
const motion = require('./ai/motion');
const compose = require('./ai/compose');
const { Storage } = require('./ai/storage');
const { Setup } = require('./ai/setup');
const { Runner } = require('./ai/runner');
const { Queue } = require('./ai/queue');
const { listRuns, readRun } = require('./ai/logger');

// ─── Storage root ──────────────────────────────────────────────────────────

// Data lives at <filesystem root>/.hexstack-app/<app-name>/data for every
// build type, dev and packaged alike, so there is one location to inspect.
// resolveDataDir falls back to ~/.hexstack-app/<app>/data when the root is
// not user-writable (see sdk/utils/data-dir.js).
const { resolveDataDir } = require('./sdk/utils/data-dir');
const { registerOpenExternal } = require('./sdk/logic/shell');
const { createWindow: createWindow_ } = require('./sdk/ui/window');
const storageRoot = resolveDataDir("ai-mentat-local-studio");

const storage = new Storage(storageRoot);
const setup = new Setup({ enginesDir: storage.enginesDir, modelsDir: storage.modelsDir });
const runner = new Runner({ storage, setup });
const queue = new Queue({ storage, runner });

let mainWindow;
let powerBlockerId = null;
let forceQuit = false;

// ─── Window ────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = createWindow_({
    BrowserWindow,
    width: 1240,
    height: 860,
    minWidth: 940,
    minHeight: 640,
    title: 'Hexstack Mentat Local Studio',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#14161a',
    preload: path.join(__dirname, 'preload.js'),
    load: { file: path.join(__dirname, 'app.html') },
  });

  // Losing a nearly-finished generation to a stray Cmd-W is the single most
  // expensive mistake this app can make — a movie run costs minutes of compute.
  mainWindow.on('close', (e) => {
    if (forceQuit) return;
    if (!runner.isRunning() && !queue.active) return;
    if (!storage.loadSettings().confirmCloseDuringRun) return;

    e.preventDefault();
    const what = queue.active ? 'A queue batch' : 'A generation';
    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Keep running', 'Stop and close'],
      defaultId: 0,
      cancelId: 0,
      title: 'Generation in progress',
      message: `${what} is still running.`,
      detail: 'Closing now discards the work in progress. Finished files already written to the run folder are kept.',
    }).then(({ response }) => {
      if (response === 1) {
        forceQuit = true;
        queue.stop();
        runner.stop();
        setTimeout(() => mainWindow?.destroy(), 400);
      }
    });
  });
}

// Keep the machine awake for the length of a run. An overnight queue is
// pointless if the display sleeping suspends it.
function updatePowerBlocker() {
  const shouldBlock = (runner.isRunning() || queue.active) && storage.loadSettings().keepAwakeDuringRun;
  if (shouldBlock && powerBlockerId === null) {
    powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
  } else if (!shouldBlock && powerBlockerId !== null) {
    try { powerSaveBlocker.stop(powerBlockerId); } catch {}
    powerBlockerId = null;
  }
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// ─── Menu ──────────────────────────────────────────────────────────────────

function buildMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'Studio',
      submenu: [
        { label: 'Setup', accelerator: 'CmdOrCtrl+,', click: () => send('nav:tab', 'setup') },
        { label: 'Generate', accelerator: 'CmdOrCtrl+1', click: () => send('nav:tab', 'generate') },
        { label: 'Queue', accelerator: 'CmdOrCtrl+2', click: () => send('nav:tab', 'queue') },
        { label: 'Gallery', accelerator: 'CmdOrCtrl+3', click: () => send('nav:tab', 'gallery') },
        { type: 'separator' },
        { label: 'Stop generation', accelerator: 'CmdOrCtrl+.', click: () => { runner.stop(); queue.stop(); } },
        { type: 'separator' },
        { label: 'Open output folder', click: () => shell.openPath(storage.outputsDir) },
        { label: 'Open logs folder', click: () => shell.openPath(storage.logsDir) },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ─── IPC: setup ────────────────────────────────────────────────────────────

// Passes the selected stack so "required" means "required for the models this
// machine will actually use", not a fixed list that predates the advisor.
ipcMain.handle('setup:status', () => setup.status({
  modelStack: storage.loadSettings().modelStack,
}));

ipcMain.handle('setup:install', async (_, id) => {
  try {
    const r = await setup.install(id, (p) => send('setup:progress', p));
    send('setup:progress', { id, phase: 'done', pct: 100, note: 'Installed' });
    return { success: true, ...r };
  } catch (e) {
    send('setup:progress', { id, phase: 'error', pct: 0, note: e.message });
    return { success: false, error: e.message };
  }
});

ipcMain.handle('setup:cancel', (_, id) => ({ cancelled: setup.cancel(id) }));

ipcMain.handle('setup:uninstall', (_, id) => {
  try { return { success: true, ...setup.uninstall(id) }; }
  catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('setup:paths', () => ({
  root: storageRoot,
  engines: storage.enginesDir,
  models: storage.modelsDir,
  outputs: storage.outputsDir,
  logs: storage.logsDir,
  usage: storage.usage(),
  ffmpeg: compose.ffmpegBin(),
}));

// ─── IPC: capacity ─────────────────────────────────────────────────────────

ipcMain.handle('capacity:summary', (_, opts) => capacity.summary(opts || {}));
ipcMain.handle('capacity:hardware', () => capacity.probe());
ipcMain.handle('motion:list', () => motion.list());

// ─── IPC: hardware advisor ─────────────────────────────────────────────────
//
// `capacity:hardware` stays as it was — it answers "how long will this take?"
// and the UI's time row depends on it. These are a different question: "what is
// in this machine, and which models should it run?" Kept as separate channels
// rather than widening the old one, so an advisor failure cannot break the
// existing estimate display.

/** Deep hardware profile: VRAM, bandwidth, vector extensions, free disk. */
ipcMain.handle('advisor:hardware', () => hardware.profile(storage.modelsDir));

/**
 * Full recommendation for this machine. `force` re-probes rather than serving
 * the cache — used by the "re-scan" button after a user frees disk space.
 */
ipcMain.handle('advisor:advise', (_, opts = {}) => {
  const hw = hardware.profile(storage.modelsDir, !!opts.force);
  return advisor.advise(stacks.registry(), { hardware: hw, minScore: opts.minScore });
});

/** The full two-stack catalogue, for the setup screen's model list. */
ipcMain.handle('advisor:catalogue', () => ({
  roles: stacks.ROLES,
  companions: stacks.COMPANIONS,
  tiers: advisor.TIERS,
}));

/**
 * Apply a recommendation: persist the chosen model per role so the runner uses
 * them. Returns the ids actually written so the UI can confirm rather than
 * assume.
 */
ipcMain.handle('advisor:apply', (_, chosen) => {
  const selected = {};
  for (const [role, pick] of Object.entries(chosen || {})) {
    if (pick && pick.id) selected[role] = pick.id;
  }
  // saveSettings() already merges over the current settings, so passing only
  // the changed key is correct — spreading loadSettings() here would duplicate
  // that merge and race with any concurrent write.
  storage.saveSettings({ modelStack: selected });
  return { applied: selected };
});

// ─── IPC: settings ─────────────────────────────────────────────────────────

ipcMain.handle('settings:get', () => storage.loadSettings());
ipcMain.handle('settings:set', (_, patch) => {
  const next = storage.saveSettings(patch);
  updatePowerBlocker();
  return next;
});

// ─── IPC: run ──────────────────────────────────────────────────────────────

ipcMain.handle('run:start', async (_, req) => {
  try {
    updatePowerBlocker();
    const res = await runner.run(req, (u) => send('run:update', u));
    return { success: res.status === 'completed', ...res };
  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    updatePowerBlocker();
  }
});

ipcMain.handle('run:stop', () => ({ stopped: runner.stop() }));
ipcMain.handle('run:status', () => runner.status());

// ─── IPC: queue ────────────────────────────────────────────────────────────

queue.onChange((snap) => send('queue:update', snap));

ipcMain.handle('queue:list', () => queue.snapshot());
ipcMain.handle('queue:add', (_, prompts) => ({ added: queue.add(prompts).length, ...queue.snapshot() }));
ipcMain.handle('queue:remove', (_, id) => ({ removed: queue.remove(id), ...queue.snapshot() }));
ipcMain.handle('queue:clear', (_, which) => { queue.clear(which); return queue.snapshot(); });
ipcMain.handle('queue:retry-failed', () => { queue.retryFailed(); return queue.snapshot(); });

ipcMain.handle('queue:start', async () => {
  try {
    updatePowerBlocker();
    return { success: true, ...(await queue.start((u) => send('run:update', u))) };
  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    updatePowerBlocker();
  }
});

ipcMain.handle('queue:stop', () => ({ stopped: queue.stop() }));

// ─── IPC: gallery / logs ───────────────────────────────────────────────────

ipcMain.handle('runs:list', (_, opts) => storage.listRuns(opts || {}));
ipcMain.handle('runs:delete', (_, runId) => ({ deleted: storage.deleteRun(runId) }));
ipcMain.handle('logs:list', () => listRuns(storage.logsDir));
ipcMain.handle('logs:read', (_, runId) => ({ text: readRun(storage.logsDir, runId) }));

// The renderer echoes back a path the main process produced, but a
// compromised renderer could pass any path — so it is resolved and checked to
// be inside this app's own output directory before anything opens.
ipcMain.handle('shell:open-path', (_, p) => {
  if (typeof p !== 'string') return { success: false };
  const resolved = path.resolve(p);
  const root = path.resolve(dataDir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    console.warn('shell:open-path refused a path outside the data dir:', resolved);
    return { success: false };
  }
  shell.openPath(resolved);
  return { success: true };
});
ipcMain.handle('shell:show-item', (_, p) => { shell.showItemInFolder(p); });
registerOpenExternal(ipcMain, shell);

ipcMain.handle('dialog:pick-image', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a reference image',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
  });
  return r.canceled ? null : r.filePaths[0];
});

// Media is read from disk by the renderer through a file:// URL; this confirms
// the path is inside our own outputs directory before handing it over.
ipcMain.handle('media:url', (_, p) => {
  const resolved = path.resolve(p);
  if (!resolved.startsWith(path.resolve(storage.outputsDir))) return null;
  if (!fs.existsSync(resolved)) return null;
  return `file://${resolved}`;
});

// ─── Lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  if (process.platform === 'darwin' && fs.existsSync(path.join(__dirname, 'icon.png'))) {
    try { app.dock.setIcon(path.join(__dirname, 'icon.png')); } catch {}
  }
  createWindow();
  buildMenu();
  setupAutoUpdate(mainWindow);

  // ─── Startup compatibility check ─────────────────────────────────────────
  //
  // Profile the machine once at launch and push the recommendation to the
  // renderer, so the first thing the user sees already reflects their hardware
  // instead of a generic model list they have to reason about themselves.
  //
  // Design decisions here, and why:
  //
  //   * NON-BLOCKING. This runs AFTER createWindow() and reports via an event
  //     rather than gating startup. The probe shells out to nvidia-smi/wmic,
  //     which can take seconds on a cold driver — blocking the window on that
  //     would make a slow GPU look like a hung app.
  //
  //   * FAILURE IS NON-FATAL. The whole thing is wrapped: hardware detection is
  //     exactly the code most likely to hit an exotic machine, and a broken
  //     probe must degrade to "no advice" rather than an app that will not
  //     start. The renderer simply never receives the event.
  //
  //   * PERSISTS ONLY ON FIRST RUN. If the user has already chosen a stack we
  //     send the advice but do NOT overwrite their selection — the check is
  //     there to help, not to reset preferences on every launch.
  //   * WAITS FOR THE RENDERER TO BE LISTENING. `webContents.send()` to a page
  //     that has not yet executed app.js is DROPPED SILENTLY — there is no
  //     queue and no error. Measured: the probe takes ~40 ms while a page load
  //     is 50-300 ms, so a bare setImmediate() loses this race almost every
  //     time and the Setup tab would sit on "Scanning hardware…" until the user
  //     happened to switch tabs. `did-finish-load` is the event that guarantees
  //     app.js has run; a fixed delay would only make the race less frequent,
  //     not eliminate it.
  const sendStartupAdvice = () => {
    try {
      const hw = hardware.profile(storage.modelsDir);
      const report = advisor.advise(stacks.registry(), { hardware: hw });

      const settings = storage.loadSettings();
      const firstRun = !settings.modelStack || !Object.keys(settings.modelStack).length;
      if (firstRun) {
        const selected = {};
        for (const [role, pick] of Object.entries(report.chosen)) {
          if (pick) selected[role] = pick.id;
        }
        storage.saveSettings({ modelStack: selected });
      }

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('advisor:startup', { ...report, firstRun });
      }
      console.log(`[advisor] ${report.summary}`);
    } catch (e) {
      // Recorded, not thrown. An unreadable machine is a degraded experience,
      // never a failed launch.
      console.error('[advisor] startup check failed:', e?.message || e);
    }
  };

  // `once` so a reload does not re-run the first-run persistence logic.
  // If the page somehow already finished loading, run immediately rather than
  // waiting for an event that has been and gone.
  if (mainWindow.webContents.isLoading()) {
    mainWindow.webContents.once('did-finish-load', sendStartupAdvice);
  } else {
    sendStartupAdvice();
  }
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('before-quit', () => {
  forceQuit = true;
  if (powerBlockerId !== null) { try { powerSaveBlocker.stop(powerBlockerId); } catch {} }
});

process.on('uncaughtException', (e) => {
  if (e.code === 'EPIPE' || e.code === 'ERR_STREAM_DESTROYED') return;
  console.error('Uncaught:', e);
});
