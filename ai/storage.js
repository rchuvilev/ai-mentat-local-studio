'use strict';
//
// Persistent layout and the run index.
//
// Design note (Apr 23, applied across the Mentat apps): "please make all product
// apps have persistent storage placed in their dirs".
//
// Everything the app owns lives under one root:
//
//   <root>/
//     settings.json        UI preferences, shared queue settings
//     runs.json            index of completed runs (metadata only)
//     engines/             downloaded executables
//     models/              downloaded weights
//     outputs/<runId>/     generated media, one directory per run
//     logs/studio.log      rolling log
//     logs/runs/<id>.log   per-run log
//
// Outputs are addressed by run id so a run's artefacts, its log and its index
// entry never drift apart — which is what makes the preview navigator able to
// walk back through history.

const fs = require('fs');
const path = require('path');

const MAX_INDEXED_RUNS = 300;

class Storage {
  constructor(root) {
    this.root = root;
    this.settingsFile = path.join(root, 'settings.json');
    this.runsFile = path.join(root, 'runs.json');
    this.enginesDir = path.join(root, 'engines');
    this.modelsDir = path.join(root, 'models');
    this.outputsDir = path.join(root, 'outputs');
    this.logsDir = path.join(root, 'logs');
    for (const d of [root, this.enginesDir, this.modelsDir, this.outputsDir, this.logsDir]) {
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    }
  }

  // ─── Settings ────────────────────────────────────────────────────────────

  defaults() {
    return {
      // "make last option initially chosen by default / on start" — the last
      // option in the mode list is the full movie pipeline.
      mode: 'movie',
      steps: { plan: true, image: true, voice: true, music: true, video: true, compose: true },
      outputSec: 10,
      orientation: 'landscape',
      quality: 'balanced',
      motion: 'kenburns',
      imageModel: 'sd15',
      keepAwakeDuringRun: true,
      confirmCloseDuringRun: true,
    };
  }

  loadSettings() {
    try {
      return { ...this.defaults(), ...JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')) };
    } catch { return this.defaults(); }
  }

  saveSettings(patch) {
    const next = { ...this.loadSettings(), ...patch };
    writeJsonAtomic(this.settingsFile, next);
    return next;
  }

  // ─── Runs ────────────────────────────────────────────────────────────────

  newRunId() {
    const d = new Date();
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
      + `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
      + `-${pad(d.getMilliseconds(), 3)}`;
  }

  runDir(runId) {
    const d = path.join(this.outputsDir, runId);
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    return d;
  }

  loadRuns() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.runsFile, 'utf8'));
      return Array.isArray(raw) ? raw : [];
    } catch { return []; }
  }

  recordRun(entry) {
    const runs = this.loadRuns().filter((r) => r.runId !== entry.runId);
    runs.unshift(entry);
    writeJsonAtomic(this.runsFile, runs.slice(0, MAX_INDEXED_RUNS));
    return entry;
  }

  /**
   * Runs that still have their media on disk.
   *
   * The index is metadata only, so a user who deleted an outputs directory by
   * hand would otherwise get a preview navigator full of broken entries.
   */
  listRuns({ limit = 100, mode = null } = {}) {
    return this.loadRuns()
      .filter((r) => !mode || r.mode === mode)
      .map((r) => {
        const outputs = (r.outputs || []).filter((o) => o.path && fs.existsSync(o.path));
        return { ...r, outputs, missing: outputs.length < (r.outputs || []).length };
      })
      .filter((r) => r.outputs.length > 0 || r.status === 'failed' || r.status === 'cancelled')
      .slice(0, limit);
  }

  deleteRun(runId) {
    try { fs.rmSync(path.join(this.outputsDir, runId), { recursive: true, force: true }); } catch {}
    const runs = this.loadRuns().filter((r) => r.runId !== runId);
    writeJsonAtomic(this.runsFile, runs);
    return true;
  }

  usage() {
    const dirSize = (d) => {
      let total = 0;
      const walk = (p) => {
        let entries;
        try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          const full = path.join(p, e.name);
          if (e.isDirectory()) walk(full);
          else { try { total += fs.statSync(full).size; } catch {} }
        }
      };
      walk(d);
      return total;
    };
    return {
      models: dirSize(this.modelsDir),
      engines: dirSize(this.enginesDir),
      outputs: dirSize(this.outputsDir),
    };
  }
}

function writeJsonAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

module.exports = { Storage, writeJsonAtomic };
