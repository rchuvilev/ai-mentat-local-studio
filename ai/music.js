'use strict';
//
// Music generation.
//
// Design notes (Apr 29):
//   "why separate music generation stuck"
//   "again music generation nearly ended and window closed ruining all
//    progress..."
//
// Two distinct bugs behind those. First, a long generation with no progress
// signal is indistinguishable from a hang — so this reports progress and
// enforces a hard timeout instead of blocking forever. Second, a crash near the
// end destroyed everything: generation now writes segments incrementally, so an
// interrupted run keeps whatever finished rather than losing the lot.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const compose = require('./compose');

// Longest single segment to synthesize at once. MusicGen degrades and slows
// sharply past roughly this length, and shorter segments give the progress
// reporter something to report.
const SEGMENT_SECONDS = 10;

class Music {
  constructor({ modelPath, binary, logger }) {
    this.modelPath = modelPath;
    this.binary = binary;
    this.logger = logger;
  }

  available() { return !!(this.modelPath && fs.existsSync(this.modelPath) && this.binary && fs.existsSync(this.binary)); }

  assertAvailable() {
    if (!this.modelPath || !fs.existsSync(this.modelPath)) {
      throw new Error('Music model not installed. Download MusicGen Small in Setup.');
    }
    if (!this.binary || !fs.existsSync(this.binary)) {
      throw new Error('Music engine not installed. Install it from Setup.');
    }
  }

  /**
   * @param {object} o
   * @param {string} o.prompt
   * @param {string} o.outPath
   * @param {number} o.seconds
   * @param {AbortSignal} o.signal
   * @param {(pct:number, note:string)=>void} [o.onProgress]
   */
  async generate(o) {
    this.assertAvailable();
    fs.mkdirSync(path.dirname(o.outPath), { recursive: true });

    const segments = Math.max(1, Math.ceil(o.seconds / SEGMENT_SECONDS));
    const workDir = path.join(path.dirname(o.outPath), 'music-parts');
    fs.mkdirSync(workDir, { recursive: true });

    this.logger?.info(`music: "${o.prompt}" ${o.seconds}s in ${segments} segment(s)`);
    const parts = [];

    for (let i = 0; i < segments; i++) {
      if (o.signal?.aborted) break;
      const secs = Math.min(SEGMENT_SECONDS, o.seconds - i * SEGMENT_SECONDS);
      const part = path.join(workDir, `seg_${String(i).padStart(3, '0')}.wav`);
      o.onProgress?.((i / segments) * 100, `Segment ${i + 1} of ${segments}`);

      try {
        await this.runSegment({ prompt: o.prompt, outPath: part, seconds: secs, signal: o.signal });
        parts.push(part);
      } catch (e) {
        if (o.signal?.aborted) break;
        // Keep what completed. Losing 40 seconds of finished audio because the
        // fifth segment failed is the "ruining all progress" complaint.
        this.logger?.warn(`music segment ${i + 1} failed: ${e.message}`);
        if (!parts.length) throw e;
        break;
      }
    }

    if (!parts.length) throw new Error('Music generation produced nothing');

    if (parts.length === 1) fs.copyFileSync(parts[0], o.outPath);
    else await compose.concatClips({ clips: parts, outPath: o.outPath, logger: this.logger, signal: o.signal });

    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    o.onProgress?.(100, 'Done');

    const seconds = compose.probeDuration(o.outPath) || 0;
    return { path: o.outPath, seconds, partial: parts.length < segments };
  }

  runSegment({ prompt, outPath, seconds, signal }) {
    return new Promise((resolve, reject) => {
      const args = ['-m', this.modelPath, '-p', prompt, '-o', outPath, '-t', String(Math.round(seconds))];
      const proc = spawn(this.binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let tail = '';
      let settled = false;
      const finish = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };

      // A generation that stops emitting is a hang, not progress. Without this
      // the UI sat on "music…" indefinitely — the "why separate music
      // generation stuck" report.
      const budgetMs = Math.max(120000, seconds * 20000);
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
        finish(reject, new Error(`Music generation exceeded ${Math.round(budgetMs / 1000)}s for a ${seconds}s segment and was stopped.`));
      }, budgetMs);

      const onAbort = () => { try { proc.kill('SIGKILL'); } catch {} finish(reject, new Error('cancelled')); };
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      }

      const cap = (b) => {
        const t = b.toString();
        tail = (tail + t).slice(-2000);
        for (const l of t.split(/[\r\n]+/)) if (l.trim()) this.logger?.info(`music| ${l.trim()}`);
      };
      proc.stdout.on('data', cap);
      proc.stderr.on('data', cap);
      proc.on('error', (e) => finish(reject, e));
      proc.on('exit', (code) => {
        if (code === 0 && fs.existsSync(outPath)) return finish(resolve, undefined);
        finish(reject, new Error(`music engine failed (${code}): ${tail.trim().split('\n').slice(-2).join(' | ')}`));
      });
    });
  }
}

module.exports = { Music, SEGMENT_SECONDS };
