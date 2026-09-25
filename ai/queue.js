'use strict';
//
// Overnight prompt queue.
//
// Design note (Apr 29): "can we add queue for prompts (e.g. to leave in the
// evening to generate 20-50 pre-prompted medias by morning)? with catching
// errors and skipping to next in case of error. and with good UX fancy UI.
// settings are shared for all videos (single setup)."
//
// Three requirements drive the design:
//   * settings are shared — an item carries a prompt, not its own configuration
//   * an error skips to the next item, never halts the batch
//   * it runs unattended, so state is persisted after every transition and a
//     crash mid-batch resumes rather than restarting

const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./storage');

const STATES = ['pending', 'running', 'done', 'failed', 'cancelled'];

// Suppressed-error reporting. Kept local and dependency-free so queue.js stays
// loadable under plain node for tests; the buffer is readable from the UI for
// a bug report rather than vanishing into a bare `catch {}`.
const queueErrors = [];
const MAX_QUEUE_ERRORS = 50;
function reportQueueError(op, err, context) {
  const message = err instanceof Error ? err.message : String(err);
  queueErrors.push({ at: Date.now(), op, message, context });
  if (queueErrors.length > MAX_QUEUE_ERRORS) queueErrors.shift();
  console.warn(`[queue] ${op}: ${message}`, context ?? '');
}
function recentQueueErrors() { return queueErrors.slice(); }

class Queue {
  /**
   * @param {object} deps
   * @param {import('./storage').Storage} deps.storage
   * @param {import('./runner').Runner} deps.runner
   */
  constructor({ storage, runner }) {
    this.storage = storage;
    this.runner = runner;
    this.file = path.join(storage.root, 'queue.json');
    this.items = this.load();
    this.active = false;
    this.stopRequested = false;
    this.listeners = new Set();
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() {
    const snap = this.snapshot();
    // A UI listener that throws must not stop the batch or the other
    // listeners — but a swallowed render error is undebuggable, so it is
    // reported. logger is required lazily to keep this module dependency-light.
    for (const fn of this.listeners) {
      try { fn(snap); }
      catch (err) { reportQueueError('queue.listener', err); }
    }
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!Array.isArray(raw)) return [];
      // Anything left mid-flight by a crash is retried, not silently dropped.
      return raw.map((i) => (i.state === 'running' ? { ...i, state: 'pending' } : i));
    } catch { return []; }
  }

  // 🔴 A failed persist is the one error that loses real work: an unattended
  // overnight batch that cannot write its state restarts from scratch after a
  // crash. It must not throw (that would abort the run in progress) but it
  // must never be silent either.
  persist() {
    try { writeJsonAtomic(this.file, this.items); }
    catch (err) { reportQueueError('queue.persist', err, { file: this.file }); }
  }

  snapshot() {
    return {
      active: this.active,
      items: this.items,
      counts: STATES.reduce((a, s) => (a[s] = this.items.filter((i) => i.state === s).length, a), {}),
    };
  }

  // ─── Mutations ───────────────────────────────────────────────────────────

  /** Accepts one prompt or a newline-separated batch — the overnight case. */
  add(prompts) {
    const list = Array.isArray(prompts) ? prompts : String(prompts).split('\n');
    const added = [];
    for (const raw of list) {
      const prompt = raw.trim();
      if (!prompt) continue;
      const item = {
        id: `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        prompt, state: 'pending', addedAt: Date.now(),
        runId: null, error: null, outputs: 0,
      };
      this.items.push(item);
      added.push(item);
    }
    this.persist();
    this.emit();
    return added;
  }

  remove(id) {
    const item = this.items.find((i) => i.id === id);
    if (item?.state === 'running') return false; // stop it first
    this.items = this.items.filter((i) => i.id !== id);
    this.persist();
    this.emit();
    return true;
  }

  clear(which = 'finished') {
    this.items = which === 'all'
      ? this.items.filter((i) => i.state === 'running')
      : this.items.filter((i) => !['done', 'failed', 'cancelled'].includes(i.state));
    this.persist();
    this.emit();
  }

  retryFailed() {
    for (const i of this.items) {
      if (i.state === 'failed') { i.state = 'pending'; i.error = null; }
    }
    this.persist();
    this.emit();
  }

  // ─── Execution ───────────────────────────────────────────────────────────

  /**
   * Drain the queue. Settings are read once so every item in a batch is
   * generated with identical configuration ("settings are shared for all
   * videos (single setup)").
   */
  async start(onUpdate = () => {}) {
    if (this.active) throw new Error('Queue is already running');
    if (!this.items.some((i) => i.state === 'pending')) throw new Error('Queue has nothing pending');

    this.active = true;
    this.stopRequested = false;
    this.emit();

    const settings = this.storage.loadSettings();

    try {
      for (;;) {
        if (this.stopRequested) break;
        const item = this.items.find((i) => i.state === 'pending');
        if (!item) break;

        item.state = 'running';
        item.startedAt = Date.now();
        this.persist();
        this.emit();

        try {
          const res = await this.runner.run({
            mode: settings.mode,
            prompt: item.prompt,
            steps: Object.keys(settings.steps).filter((k) => settings.steps[k]),
            outputSec: settings.outputSec,
            orientation: settings.orientation,
            quality: settings.quality,
            motion: settings.motion,
          }, (u) => onUpdate({ ...u, queueItemId: item.id }));

          item.runId = res.runId;
          item.outputs = res.outputs.length;
          if (res.status === 'completed') {
            item.state = 'done';
          } else if (res.status === 'cancelled') {
            // A cancelled item means the user hit Stop; that ends the batch too,
            // rather than rolling on to the next prompt.
            item.state = 'cancelled';
            this.stopRequested = true;
          } else {
            item.state = 'failed';
            item.error = res.error;
          }
        } catch (e) {
          // The core requirement: one bad prompt must not end the night's work.
          item.state = 'failed';
          item.error = e.message;
        }

        item.finishedAt = Date.now();
        this.persist();
        this.emit();
      }
    } finally {
      this.active = false;
      this.persist();
      this.emit();
    }

    return this.snapshot();
  }

  /** Stops after the current item; also aborts the run in flight. */
  stop() {
    this.stopRequested = true;
    const stopped = this.runner.stop();
    this.emit();
    return stopped;
  }
}

module.exports = { Queue, STATES, recentQueueErrors };
