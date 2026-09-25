'use strict';
//
// Per-run logging.
//
// Design note (Apr 29): "why processing fails silently? can we add writing log
// file per run (same file) to debug?"
//
// Two things were wrong in the original: failures inside the pipeline were
// swallowed, and there was nothing on disk to look at afterwards. So every run
// gets its own timestamped file *and* appends to a single rolling studio.log —
// "per run" for isolating one generation, "same file" for watching the app as a
// whole. Both survive a crash, which matters because the crash is the thing you
// need the log for.

const fs = require('fs');
const path = require('path');

const ROLLING_MAX_BYTES = 2 * 1024 * 1024;

class RunLogger {
  /**
   * @param {string} logsDir  directory that holds studio.log and runs/
   * @param {string} runId    identifier for this run
   */
  constructor(logsDir, runId) {
    this.logsDir = logsDir;
    this.runId = runId;
    this.runsDir = path.join(logsDir, 'runs');
    this.runFile = path.join(this.runsDir, `${runId}.log`);
    this.rollingFile = path.join(logsDir, 'studio.log');
    this.listeners = new Set();
    this.lines = [];
    this.startedAt = Date.now();

    for (const d of [this.logsDir, this.runsDir]) {
      try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch {}
    }
    this.trimRolling();
  }

  trimRolling() {
    try {
      const st = fs.statSync(this.rollingFile);
      if (st.size > ROLLING_MAX_BYTES) {
        const kept = fs.readFileSync(this.rollingFile, 'utf8').slice(-ROLLING_MAX_BYTES / 2);
        fs.writeFileSync(this.rollingFile, kept);
      }
    } catch {} // absent on first run
  }

  onLine(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  write(level, msg) {
    const line = `[${new Date().toISOString()}] ${level ? level.toUpperCase() + ' ' : ''}${msg}`;
    this.lines.push(line);
    // appendFileSync rather than a stream: a stream can lose its tail when the
    // process dies mid-generation, which is exactly the case being debugged.
    try { fs.appendFileSync(this.runFile, line + '\n'); } catch {}
    try { fs.appendFileSync(this.rollingFile, `[${this.runId}] ${line}\n`); } catch {}
    for (const fn of this.listeners) { try { fn(line); } catch {} }
    return line;
  }

  info(msg) { return this.write('', msg); }
  warn(msg) { return this.write('warn', msg); }
  error(msg) { return this.write('error', msg); }

  /** Marks a pipeline phase, with the percentage the UI shows on the bar. */
  phase(name, pct) {
    this.write('', `phase: ${name} (${pct}%)`);
    for (const fn of this.listeners) { try { fn(null, { phase: name, pct }); } catch {} }
  }

  /** Records a thrown error with its stack — the part that used to vanish. */
  fail(err) {
    this.error(err && err.stack ? err.stack : String(err));
  }

  header(meta) {
    this.write('', `=== Run ${this.runId} started ${new Date(this.startedAt).toISOString()} ===`);
    for (const [k, v] of Object.entries(meta || {})) {
      this.write('', `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
    }
    this.write('', '---');
  }

  footer(status, extra = {}) {
    const elapsed = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    this.write('', `=== Run ${this.runId} ${status} in ${elapsed}s ===`);
    for (const [k, v] of Object.entries(extra)) {
      this.write('', `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
    }
    return +elapsed;
  }

  snapshot(n = 400) { return this.lines.slice(-n); }
}

/** Lists past runs, newest first, for the log browser in the UI. */
function listRuns(logsDir, limit = 50) {
  const runsDir = path.join(logsDir, 'runs');
  try {
    return fs.readdirSync(runsDir)
      .filter((f) => f.endsWith('.log'))
      .map((f) => {
        const p = path.join(runsDir, f);
        const st = fs.statSync(p);
        return { runId: f.replace(/\.log$/, ''), file: p, size: st.size, at: st.mtimeMs };
      })
      .sort((a, b) => b.at - a.at)
      .slice(0, limit);
  } catch { return []; }
}

function readRun(logsDir, runId) {
  try {
    return fs.readFileSync(path.join(logsDir, 'runs', `${runId}.log`), 'utf8');
  } catch (e) { return `(log unavailable: ${e.message})`; }
}

module.exports = { RunLogger, listRuns, readRun };
