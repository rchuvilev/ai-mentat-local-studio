'use strict';
//
// LTX-2.3 video driver.
//
// ─── WHERE THIS SITS IN THE MOTION LADDER ───────────────────────────────────
//
// motion.js already offers three paths, cheapest first:
//
//     kenburns     ffmpeg pan/zoom over a still. Seconds. The default, and the
//                  reason the app produces video at all on a CPU-only laptop.
//     animatediff  frame-by-frame diffusion on top of SD 1.5.
//     wan          Wan 2.1 image-to-video, 9 GB.
//
// LTX-2.3 is the top rung: genuinely good video, and a MEASURED 27.5 GB of
// weights. That size is the entire reason the advisor exists — offering this on
// a 16 GB laptop means a 27.5 GB download that fails at load.
//
// ─── THE ORDERING IS A CORRECTNESS PROPERTY, NOT A PREFERENCE ───────────────
//
// capacity.js's cost model asserts that Ken Burns is the cheap path (an ffmpeg
// pan/zoom, not diffusion) and a test pins that ordering so it cannot silently
// invert during a retune. LTX must sit ABOVE Wan in the same ladder: it is
// slower and far larger. Adding it below would make the estimator recommend the
// most expensive option to the weakest machines.
//
// ─── STATUS: WIRED, PENDING A RUNTIME ───────────────────────────────────────
//
// ponytail: a deliberate, marked simplification, same as acestep.js. LTX-2.3
// ships as fp8 safetensors for a PyTorch/ComfyUI stack; there is no
// single-binary CPU runtime equivalent to sd.cpp. Vendoring Python would
// contradict the app's "no manual install" design note and add hundreds of
// megabytes to every build, including for the majority of users whose hardware
// cannot run this model anyway.
//
// So this driver declares the model (so the advisor can gate it and the setup
// UI can fetch it), shells out to an `ltx` binary when present, and otherwise
// reports a clear reason and lets motion.js fall back. The fallback is the
// important part: a missing LTX runtime must degrade to Ken Burns, never fail
// a run.
//
// Upgrade path: point LTX_BIN at a compiled runtime or a local ComfyUI
// endpoint. Nothing in the registry or the fit logic changes.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/** Frames per second of generated video. Matches capacity.js's FPS. */
const FPS = 8;

/** A single clip may not exceed this. Video diffusion can run away. */
const CLIP_TIMEOUT_MS = 30 * 60 * 1000;

class Ltx {
  /**
   * @param {object} opts
   * @param {string} opts.modelPath  LTX-2.3 fp8 safetensors
   * @param {string} [opts.binary]   path to an `ltx` runtime, if installed
   * @param {import('./logger').RunLogger} opts.logger
   */
  constructor({ modelPath, binary, logger }) {
    this.modelPath = modelPath;
    this.binary = binary;
    this.logger = logger;
  }

  available() {
    return !!(this.binary && fs.existsSync(this.binary)
      && this.modelPath && fs.existsSync(this.modelPath));
  }

  /** Actionable explanation, so the caller can decide whether to fall back. */
  unavailableReason() {
    if (!this.modelPath || !fs.existsSync(this.modelPath)) {
      return 'LTX-2.3 weights not downloaded (27.5 GB). Open Setup to download them, '
        + 'or keep using Ken Burns motion.';
    }
    if (!this.binary || !fs.existsSync(this.binary)) {
      return 'LTX-2.3 runtime not installed. The weights are present but no LTX engine '
        + 'binary is available — Ken Burns motion will be used instead.';
    }
    return null;
  }

  assertAvailable() {
    const reason = this.unavailableReason();
    if (reason) throw new Error(reason);
  }

  /**
   * Render one clip from a still image.
   *
   * @param {object} o
   * @param {string} o.initImage    the still to animate
   * @param {string} o.prompt
   * @param {string} o.outPath      .mp4 destination
   * @param {number} [o.seconds]
   * @param {number} [o.width] @param {number} [o.height]
   * @param {AbortSignal} [o.signal]
   * @param {(p:{pct:number})=>void} [o.onProgress]
   */
  async generate(o) {
    this.assertAvailable();
    if (!o.initImage || !fs.existsSync(o.initImage)) {
      throw new Error('LTX needs a source image; none was produced by the image stage.');
    }
    fs.mkdirSync(path.dirname(o.outPath), { recursive: true });

    const seconds = Math.max(1, o.seconds ?? 5);
    const frames = Math.round(seconds * FPS);

    const args = [
      '--model', this.modelPath,
      '--image', o.initImage,
      '--prompt', o.prompt || '',
      '--frames', String(frames),
      '--fps', String(FPS),
      '--width', String(o.width ?? 704),
      '--height', String(o.height ?? 480),
      '--output', o.outPath,
    ];

    this.logger?.info(`ltx: ${frames} frames @ ${FPS}fps from ${path.basename(o.initImage)}`);

    await this.run(args, o.signal, (line) => {
      // Progress lines look like "step 12/50"; the same shape sd.cpp emits.
      const m = line.match(/(\d+)\s*\/\s*(\d+)/);
      if (m && o.onProgress) {
        const [step, total] = [+m[1], +m[2]];
        if (total > 0 && step <= total) o.onProgress({ pct: (step / total) * 100 });
      }
    });

    if (!fs.existsSync(o.outPath)) {
      throw new Error('LTX exited cleanly but produced no video — see the run log.');
    }
    return o.outPath;
  }

  run(args, signal, onLine) {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let tail = '';
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
        reject(new Error(`LTX clip exceeded ${CLIP_TIMEOUT_MS / 60000} minutes and was stopped.`));
      }, CLIP_TIMEOUT_MS);

      const onAbort = () => { try { proc.kill('SIGTERM'); } catch {} };
      signal?.addEventListener('abort', onAbort, { once: true });

      const capture = (buf) => {
        const s = buf.toString();
        tail = (tail + s).slice(-4000);
        for (const line of s.split('\n')) {
          if (!line.trim()) continue;
          this.logger?.debug(`ltx: ${line.trim()}`);
          onLine?.(line);
        }
      };
      proc.stdout.on('data', capture);
      proc.stderr.on('data', capture);

      proc.on('error', (e) => { clearTimeout(timer); reject(e); });
      proc.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (signal?.aborted) return resolve(null);
        if (code !== 0) return reject(new Error(`LTX exited ${code}. Last output:\n${tail}`));
        resolve(null);
      });
    });
  }
}

module.exports = { Ltx, FPS, CLIP_TIMEOUT_MS };
