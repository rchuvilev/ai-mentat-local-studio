'use strict';
//
// ACE-Step 1.5 music driver.
//
// ─── WHY A SEPARATE DRIVER FROM music.js ────────────────────────────────────
//
// `music.js` drives MusicGen, which is a single autoregressive model: text in,
// audio tokens out, one process. ACE-Step 1.5 is a TWO-STAGE system —
//
//     acestep-5Hz-lm-1.7B   autoregressive LM, proposes the musical plan
//     acestep-v15-base      diffusion model, renders that plan to audio
//
// — and both files are mandatory. Bolting a second required model path and a
// second invocation onto the MusicGen driver would have made one class serve
// two incompatible pipelines; the branch would be larger than this file.
//
// ─── WHAT IS REUSED ─────────────────────────────────────────────────────────
//
// Everything that is not stage-specific: the segmenting strategy, the
// per-segment timeout, incremental writes and the cancellation contract all
// come from music.js and behave identically. That is deliberate — the queue's
// error handling and the UI's progress bar already understand that shape, and
// a driver that reported progress differently would need changes in both.
//
// ─── STATUS: WIRED, PENDING A RUNTIME ───────────────────────────────────────
//
// ponytail: this is a deliberate, marked simplification. ACE-Step has no
// llama.cpp-style single-binary CPU runtime in the way sd.cpp serves diffusion
// images; the reference implementation is Python/PyTorch. Rather than vendor a
// Python environment — which would contradict the app's "no manual install"
// design note and add hundreds of megabytes — this driver:
//
//   * declares the models, sizes and roles so the advisor can reason about them
//     and the download UI can fetch them,
//   * shells out to an `acestep` binary when one is present,
//   * and reports a CLEAR, ACTIONABLE reason when it is not, instead of
//     failing deep inside a run.
//
// Upgrade path: point ACESTEP_BIN at a compiled runtime, or add a GGUF-capable
// backend once one ships. The registry entries and the fit logic do not change.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/** Longest a single segment may take before it is abandoned. */
const SEGMENT_TIMEOUT_MS = 10 * 60 * 1000;

/** Seconds of audio per segment. Matches music.js so the UI maths is shared. */
const SEGMENT_SECONDS = 30;

class AceStep {
  /**
   * @param {object} opts
   * @param {string} opts.modelPath  diffusion base weights (acestep-v15-base)
   * @param {string} opts.lmPath     autoregressive LM weights (acestep-5Hz-lm)
   * @param {string} [opts.binary]   path to an `acestep` runtime, if installed
   * @param {import('./logger').RunLogger} opts.logger
   */
  constructor({ modelPath, lmPath, binary, logger }) {
    this.modelPath = modelPath;
    this.lmPath = lmPath;
    this.binary = binary;
    this.logger = logger;
  }

  /**
   * Both stages must be present. Reporting "available" with only the diffusion
   * base would defer the failure to the middle of a run, after the user has
   * already waited through planning and image generation.
   */
  available() {
    return !!(this.binary && fs.existsSync(this.binary)
      && this.modelPath && fs.existsSync(this.modelPath)
      && this.lmPath && fs.existsSync(this.lmPath));
  }

  /**
   * Explain precisely what is missing.
   *
   * Separate from available() because "not available" is not actionable on its
   * own — the original app's dead-end error strings are exactly what this app
   * set out to avoid.
   */
  unavailableReason() {
    if (!this.binary || !fs.existsSync(this.binary)) {
      return 'ACE-Step runtime not installed. The models are downloaded, but no ACE-Step '
        + 'engine binary is present — install it from the Setup tab, or switch the music '
        + 'model to MusicGen Small, which runs on the bundled engine.';
    }
    if (!this.modelPath || !fs.existsSync(this.modelPath)) {
      return 'ACE-Step base model not downloaded. Open Setup and download "ACE-Step 1.5 base".';
    }
    if (!this.lmPath || !fs.existsSync(this.lmPath)) {
      // The failure this exists to prevent: the base model alone looks like a
      // complete install, and the LM's absence would otherwise surface as an
      // opaque runtime error two stages into a run.
      return 'ACE-Step LM stage missing. ACE-Step 1.5 needs BOTH the base model and the '
        + '1.7B LM — open Setup and download "ACE-Step 1.5 LM".';
    }
    return null;
  }

  assertAvailable() {
    const reason = this.unavailableReason();
    if (reason) throw new Error(reason);
  }

  /**
   * Generate music.
   *
   * @param {object} o
   * @param {string} o.prompt
   * @param {string} o.outPath
   * @param {number} [o.seconds]
   * @param {AbortSignal} [o.signal]
   * @param {(p:{pct:number,segment:number,total:number})=>void} [o.onProgress]
   */
  async generate(o) {
    this.assertAvailable();
    fs.mkdirSync(path.dirname(o.outPath), { recursive: true });

    const seconds = Math.max(1, o.seconds ?? SEGMENT_SECONDS);
    const total = Math.ceil(seconds / SEGMENT_SECONDS);
    const parts = [];

    for (let i = 0; i < total; i++) {
      if (o.signal?.aborted) break;
      const segSeconds = Math.min(SEGMENT_SECONDS, seconds - i * SEGMENT_SECONDS);
      const segPath = o.outPath.replace(/\.wav$/, `.part${i}.wav`);

      const args = [
        '--lm', this.lmPath,
        '--model', this.modelPath,
        '--prompt', o.prompt,
        '--duration', String(segSeconds),
        '--output', segPath,
      ];

      this.logger?.info(`acestep: segment ${i + 1}/${total} (${segSeconds}s)`);
      await this.run(args, o.signal);

      // Written incrementally so an interrupted run keeps whatever finished —
      // the same contract music.js offers, and what the overnight queue assumes.
      if (fs.existsSync(segPath)) parts.push(segPath);
      o.onProgress?.({ pct: ((i + 1) / total) * 100, segment: i + 1, total });
    }

    if (!parts.length) {
      throw new Error('ACE-Step produced no audio — see the run log.');
    }
    return { path: parts.length === 1 ? parts[0] : parts[0], parts };
  }

  run(args, signal) {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let tail = '';
      const timer = setTimeout(() => {
        // A wedged segment must not strand an unattended overnight batch.
        try { proc.kill('SIGKILL'); } catch {}
        reject(new Error(`ACE-Step segment exceeded ${SEGMENT_TIMEOUT_MS / 60000} minutes and was stopped.`));
      }, SEGMENT_TIMEOUT_MS);

      const onAbort = () => { try { proc.kill('SIGTERM'); } catch {} };
      signal?.addEventListener('abort', onAbort, { once: true });

      const capture = (buf) => {
        const s = buf.toString();
        tail = (tail + s).slice(-4000);
        for (const line of s.split('\n')) if (line.trim()) this.logger?.debug(`acestep: ${line.trim()}`);
      };
      proc.stdout.on('data', capture);
      proc.stderr.on('data', capture);

      proc.on('error', (e) => { clearTimeout(timer); reject(e); });
      proc.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (signal?.aborted) return resolve(null);
        if (code !== 0) return reject(new Error(`ACE-Step exited ${code}. Last output:\n${tail}`));
        resolve(null);
      });
    });
  }
}

module.exports = { AceStep, SEGMENT_SECONDS, SEGMENT_TIMEOUT_MS };
