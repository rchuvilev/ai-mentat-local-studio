const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('studio', {
  // Setup
  setupStatus: () => ipcRenderer.invoke('setup:status'),
  setupInstall: (id) => ipcRenderer.invoke('setup:install', id),
  setupCancel: (id) => ipcRenderer.invoke('setup:cancel', id),
  setupUninstall: (id) => ipcRenderer.invoke('setup:uninstall', id),
  setupPaths: () => ipcRenderer.invoke('setup:paths'),
  onSetupProgress: (cb) => ipcRenderer.on('setup:progress', (_, p) => cb(p)),

  // Capacity / hardware
  capacitySummary: (opts) => ipcRenderer.invoke('capacity:summary', opts),
  capacityHardware: () => ipcRenderer.invoke('capacity:hardware'),
  motionList: () => ipcRenderer.invoke('motion:list'),

  // Hardware advisor — deep profile and per-role model recommendations.
  // Separate from capacity* on purpose: capacity answers "how long will this
  // take", the advisor answers "what should this machine even run".
  advisorHardware: () => ipcRenderer.invoke('advisor:hardware'),
  advisorAdvise: (opts) => ipcRenderer.invoke('advisor:advise', opts),
  advisorCatalogue: () => ipcRenderer.invoke('advisor:catalogue'),
  advisorApply: (chosen) => ipcRenderer.invoke('advisor:apply', chosen),
  // Fired once after launch with the startup compatibility check.
  onAdvisorStartup: (cb) => ipcRenderer.on('advisor:startup', (_, r) => cb(r)),

  // Settings
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings:set', patch),

  // Runs
  runStart: (req) => ipcRenderer.invoke('run:start', req),
  runStop: () => ipcRenderer.invoke('run:stop'),
  runStatus: () => ipcRenderer.invoke('run:status'),
  onRunUpdate: (cb) => ipcRenderer.on('run:update', (_, u) => cb(u)),

  // Queue
  queueList: () => ipcRenderer.invoke('queue:list'),
  queueAdd: (prompts) => ipcRenderer.invoke('queue:add', prompts),
  queueRemove: (id) => ipcRenderer.invoke('queue:remove', id),
  queueClear: (which) => ipcRenderer.invoke('queue:clear', which),
  queueRetryFailed: () => ipcRenderer.invoke('queue:retry-failed'),
  queueStart: () => ipcRenderer.invoke('queue:start'),
  queueStop: () => ipcRenderer.invoke('queue:stop'),
  onQueueUpdate: (cb) => ipcRenderer.on('queue:update', (_, s) => cb(s)),

  // Gallery / logs
  runsList: (opts) => ipcRenderer.invoke('runs:list', opts),
  runsDelete: (runId) => ipcRenderer.invoke('runs:delete', runId),
  logsList: () => ipcRenderer.invoke('logs:list'),
  logsRead: (runId) => ipcRenderer.invoke('logs:read', runId),

  // Shell / dialogs
  openPath: (p) => ipcRenderer.invoke('shell:open-path', p),
  showItem: (p) => ipcRenderer.invoke('shell:show-item', p),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  pickImage: () => ipcRenderer.invoke('dialog:pick-image'),
  mediaUrl: (p) => ipcRenderer.invoke('media:url', p),

  // Navigation from the app menu
  onNavTab: (cb) => ipcRenderer.on('nav:tab', (_, tab) => cb(tab)),


  // Auto-update
  onUpdateAvailable: (cb) => ipcRenderer.on('update:available', (_, i) => cb(i)),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update:downloaded', (_, i) => cb(i)),
  installUpdate: () => ipcRenderer.invoke('update:install'),
});
