'use strict';
//
// stable-diffusion.cpp driver — every still frame in the app comes from here.
//
// Runs the `sd` binary as a child process, streaming its output into the run log
// so a failure is visible rather than silent, and honouring cancellation so the
// Stop button can actually interrupt a generation mid-step.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/** Progress lines from sd.cpp look like "  |==>  | 7/20 - 1.23s/it". */
const STEP_RE = /(\d+)\s*\/\s*(\d+)/;

/**
 * Checkpoint layout for a registry model id.
 *
 * Keyed off the ID rather than the filename: a renamed .gguf would defeat any
 * filename sniff, and the id is what the registry guarantees.
 *
 * Lives here, in ONE place, because the arch and its companion paths were
 * previously re-derived inline at two call sites in runner.js — adding a third
 * architecture would have meant a third copy of a ternary chain, which is how
 * the two sites drift apart.
 *
 * @param {string} id  registry model id
 * @returns {'sd'|'flux'|'qwen'}
 */
function archFor(id) {
  if (/^qwen-image/i.test(id)) return 'qwen';
  if (/^flux/i.test(id)) return 'flux';
  return 'sd';
}

/**
 * Companion weight ids an architecture cannot run without.
 * Empty for plain SD/SDXL, which ship one monolithic checkpoint.
 */
const COMPANIONS = {
  flux: { vae: 'flux2-vae', text: 'flux2-text-encoder' },
  qwen: { vae: 'qwen-image-vae', text: 'qwen-image-text-encoder' },
  sd: {},
};

class SdCpp {
  /**
   * @param {object} opts
   * @param {string} opts.binary     path to the `sd` executable
   * @param {string} opts.modelPath  path to the .gguf weights
   * @param {string} [opts.arch]     'sd' (default) | 'flux' | 'qwen'
   * @param {string} [opts.vaePath]  FLUX/Qwen — separate VAE weights
   * @param {string} [opts.clipPath] FLUX/Qwen — separate text encoder
   * @param {import('./logger').RunLogger} opts.logger
   */
  constructor({ binary, modelPath, logger, arch = 'sd', vaePath, clipPath }) {
    this.binary = binary;
    this.modelPath = modelPath;
    this.logger = logger;
    // FLUX is not a drop-in for the SD checkpoint layout. sd.cpp loads a
    // monolithic SD/SDXL checkpoint with `-m`, but FLUX ships the transformer,
    // VAE and text encoder as SEPARATE files and needs `--diffusion-model`
    // instead — passing a FLUX transformer to `-m` fails with an unhelpful
    // tensor-shape error. Hence an explicit arch switch rather than sniffing
    // the filename, which would misfire on a renamed file.
    this.arch = arch;
    this.vaePath = vaePath;
    this.clipPath = clipPath;
  }

  available() {
    return !!(this.binary && fs.existsSync(this.binary) && this.modelPath && fs.existsSync(this.modelPath));
  }

  assertAvailable() {
    if (!this.binary || !fs.existsSync(this.binary)) {
      throw new Error('Image engine missing. Install stable-diffusion.cpp from the Setup tab.');
    }
    if (!this.modelPath || !fs.existsSync(this.modelPath)) {
      // The original surfaced exactly this as a dead-end string; it now names
      // the fix and the app has a button for it.
      throw new Error('SD model not downloaded yet. Open Setup and download an image model first.');
    }
  }

  /**
   * Generate one image.
   *
   * @param {object} o
   * @param {string} o.prompt
   * @param {string} [o.negative]
   * @param {string} o.outPath
   * @param {number} [o.steps]
   * @param {number} [o.width] @param {number} [o.height]
   * @param {number} [o.seed]
   * @param {string} [o.initImage]  reference image for img2img
   * @param {number} [o.strength]   img2img denoise strength
   * @param {AbortSignal} [o.signal]
   * @param {(p:{step:number,total:number,pct:number})=>void} [o.onProgress]
   */
  /**
   * Assemble the CLI arguments for one generation.
   *
   * Separated from `generate()` so the argument contract is testable without
   * spawning a binary. Three architectures with different flag sets, two of
   * which fail SILENTLY when mixed up (a wrong text-encoder flag reads an 8B
   * LLM as a CLIP checkpoint; a clamped CFG yields washed-out images blamed on
   * the model), is exactly the surface that needs assertions rather than a
   * manual eyeball.
   */
  buildArgs(o) {
    const monolithic = this.arch === 'sd';

    // SD/SDXL load one checkpoint with `-m`. FLUX and Qwen ship the
    // transformer, VAE and text encoder separately and need
    // `--diffusion-model` — passing such a transformer to `-m` fails with an
    // unhelpful tensor-shape error.
    const args = monolithic
      ? ['-m', this.modelPath]
      : ['--diffusion-model', this.modelPath];

    if (!monolithic) {
      if (this.vaePath && fs.existsSync(this.vaePath)) args.push('--vae', this.vaePath);
      if (this.clipPath && fs.existsSync(this.clipPath)) {
        // THE FLAG DIFFERS BY ARCHITECTURE AND IS NOT INTERCHANGEABLE.
        // FLUX.2's text encoder is a CLIP-family model (`--clip_l`).
        // Qwen-Image-2.1's is Qwen3-VL-8B, a full vision-language model loaded
        // through llama.cpp with `--llm`.
        args.push(this.arch === 'qwen' ? '--llm' : '--clip_l', this.clipPath);
      }
    }

    // Qwen-Image-2.1 requires dimensions divisible by 32
    // (docs/qwen_image_2.1.md). sd.cpp does NOT round for you — an odd size
    // aborts on a shape mismatch mid-run. Applied only for qwen: silently
    // resizing SD output would change results users already depend on.
    let w = o.width ?? 512;
    let h = o.height ?? 512;
    if (this.arch === 'qwen') {
      w = Math.max(32, Math.round(w / 32) * 32);
      h = Math.max(32, Math.round(h / 32) * 32);
    }

    args.push(
      '-p', o.prompt,
      '-o', o.outPath,
      '--steps', String(o.steps ?? 20),
      '-W', String(w),
      '-H', String(h),
      '--seed', String(o.seed ?? -1),
    );

    // FLUX.2 Klein is a guidance-DISTILLED flow-matching model: it is trained
    // to produce its result in very few steps and IGNORES a negative prompt,
    // and some builds reject the combination outright — so negatives are
    // dropped and CFG is pinned to 1.0.
    //
    // Qwen-Image-2.1 is NOT distilled. Upstream's own example runs
    // `--cfg-scale 6.0`; clamping it to 1.0 yields washed-out images that
    // ignore the prompt — a defect that looks like a bad model rather than a
    // bad flag. Negatives work and are forwarded.
    if (o.negative && this.arch !== 'flux') args.push('-n', o.negative);
    if (this.arch === 'flux') args.push('--cfg-scale', '1.0');
    if (this.arch === 'qwen') {
      args.push('--cfg-scale', String(o.cfgScale ?? 6.0));
      // Euler is what upstream documents for this scheduler (flow matching with
      // dynamic shifting); the sd.cpp default is tuned for SD-era models.
      args.push('--sampling-method', 'euler');
      // A 7B transformer and an 8B text encoder do not sit in VRAM together on
      // consumer hardware. Streaming from system RAM is slower, but it is the
      // difference between "slow" and "out of memory".
      args.push('--offload-to-cpu');
    }

    // Reference-image support, from "can we use reference images for our movie
    // generation?" — img2img keeps every scene anchored to the same subject
    // instead of drifting between shots.
    //
    // NO `-M img2img`. That mode string was removed upstream; the current CLI
    // accepts only [img_gen, adetailer, vid_gen, upscale, convert, metadata]
    // (modes_str[] in examples/common/common.cpp) and ABORTS on an unknown
    // mode — so every reference-image run was failing outright, taking the
    // movie pipeline's scene-to-scene consistency with it.
    //
    // img_gen is the default mode and selects img2img by itself when an init
    // image is present, so the correct call is to pass the image and drop the
    // mode flag rather than to rename it.
    if (o.initImage && fs.existsSync(o.initImage)) {
      args.push('-i', o.initImage, '--strength', String(o.strength ?? 0.55));
    }

    return args;
  }

  async generate(o) {
    this.assertAvailable();
    fs.mkdirSync(path.dirname(o.outPath), { recursive: true });

    const args = this.buildArgs(o);

    this.logger?.info(`sd: ${path.basename(this.modelPath)} ${o.width ?? 512}x${o.height ?? 512} steps=${o.steps ?? 20}${o.initImage ? ' (img2img)' : ''}`);

    return this.run(args, o.signal, (line) => {
      const m = line.match(STEP_RE);
      if (m && o.onProgress) {
        const step = +m[1], total = +m[2];
        if (total > 0 && step <= total) o.onProgress({ step, total, pct: (step / total) * 100 });
      }
    }).then(() => {
      if (!fs.existsSync(o.outPath)) {
        throw new Error('stable-diffusion.cpp exited cleanly but produced no image — see the run log.');
      }
      return o.outPath;
    });
  }

  run(args, signal, onLine) {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let tail = '';

      const onAbort = () => {
        try { proc.kill('SIGTERM'); } catch {}
        // SIGKILL if it ignores the polite request — a diffusion step can take
        // seconds and Stop must feel immediate.
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 1500);
      };
      if (signal) {
        if (signal.aborted) { onAbort(); return reject(new Error('cancelled')); }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      const handle = (buf) => {
        const text = buf.toString();
        tail = (tail + text).slice(-4000);
        for (const line of text.split(/[\r\n]+/)) {
          const t = line.trim();
          if (!t) continue;
          this.logger?.info(`sd| ${t}`);
          onLine?.(t);
        }
      };
      proc.stdout.on('data', handle);
      proc.stderr.on('data', handle);

      proc.on('error', (e) => reject(
        e.code === 'ENOENT'
          ? new Error(`Image engine not found at ${this.binary}. Reinstall it from Setup.`)
          : e,
      ));
      proc.on('exit', (code, sig) => {
        if (signal?.aborted) return reject(new Error('cancelled'));
        if (code === 0) return resolve();
        reject(new Error(`stable-diffusion.cpp failed (code ${code}${sig ? `, ${sig}` : ''}): ${tail.trim().split('\n').slice(-3).join(' | ')}`));
      });
    });
  }
}

module.exports = { SdCpp, archFor, COMPANIONS };
