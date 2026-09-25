'use strict';
//
// Motion strategies, and the fallback chain between them.
//
// Design notes (Apr 29):
//   "if we remove ken-burns approach, will frames be generated truly for real
//    gen-video outpput?"
//   "Yes, with usage on 'Cinematic' preset uses AnimateDiff."
//   "Do all these with ken-burns as fallback for unsupprted platform
//    configurations"
//
// Three strategies, ordered by fidelity. The distinction that matters: Ken Burns
// is a camera move over ONE still, while animatediff and wan generate genuinely
// distinct frames. The UI must never imply real motion when it silently fell
// back, so resolve() reports what it picked and why, and the run log records it.

const fs = require('fs');
const path = require('path');
const compose = require('./compose');

const STRATEGIES = {
  kenburns: {
    id: 'kenburns',
    name: 'Ken Burns',
    realMotion: false,
    describe: 'Pan and zoom across a single generated still. Fast, works everywhere.',
    requiresModel: null,
  },
  animatediff: {
    id: 'animatediff',
    name: 'AnimateDiff (Cinematic)',
    realMotion: true,
    describe: 'Generates every frame through a motion module. The Cinematic preset.',
    requiresModel: 'animatediff',
  },
  wan: {
    id: 'wan',
    name: 'Wan 2.1 I2V',
    realMotion: true,
    describe: 'True image-to-video diffusion. Highest quality, slowest by far.',
    requiresModel: 'wan-i2v',
  },
  // Top rung of the ladder. Listed LAST because the order here is the
  // cost order that capacity.js's estimator and its ordering test depend on:
  // kenburns (ffmpeg) < animatediff < wan < ltx. LTX is both the slowest and
  // by far the largest (a MEASURED 27.5 GB), so placing it earlier would make
  // the estimator offer the most expensive path to the weakest machines.
  //
  // No special-casing is needed for the "not installed" path: resolve() below
  // already falls back to Ken Burns for any strategy whose requiresModel is
  // absent, which is exactly the desired behaviour for a 27.5 GB download the
  // user has not fetched.
  ltx: {
    id: 'ltx',
    name: 'LTX-2.3',
    realMotion: true,
    describe: 'State-of-the-art video diffusion. Needs a 32 GB-class machine and 27.5 GB of weights.',
    requiresModel: 'ltx-2.3-distilled',
  },
};

/**
 * Decide which strategy will actually run.
 *
 * @param {string} requested       strategy id the user picked
 * @param {(id:string)=>boolean} hasModel
 * @returns {{strategy:object, fellBack:boolean, reason:string|null}}
 */
function resolve(requested, hasModel) {
  const want = STRATEGIES[requested] || STRATEGIES.kenburns;
  if (!want.requiresModel) return { strategy: want, fellBack: false, reason: null };
  if (hasModel(want.requiresModel)) return { strategy: want, fellBack: false, reason: null };
  return {
    strategy: STRATEGIES.kenburns,
    fellBack: true,
    reason: `${want.name} needs the "${want.requiresModel}" model, which is not installed — using Ken Burns instead.`,
  };
}

/**
 * Render one scene to a video clip.
 *
 * @param {object} o
 * @param {object} o.strategy   resolved strategy
 * @param {string} o.still      the scene's base image
 * @param {string} o.prompt
 * @param {string} o.outPath
 * @param {number} o.seconds  @param {number} o.fps
 * @param {string} o.orientation
 * @param {import('./sdcpp').SdCpp} o.sd
 * @param {string} o.workDir
 * @param {import('./logger').RunLogger} o.logger
 * @param {AbortSignal} o.signal
 * @param {(pct:number)=>void} [o.onProgress]
 */
async function renderScene(o) {
  const { strategy, logger } = o;
  logger?.info(`motion: ${strategy.name} (${strategy.realMotion ? 'per-frame generation' : 'camera move over one still'})`);

  if (!strategy.realMotion) {
    return compose.kenBurns({
      image: o.still, outPath: o.outPath, seconds: o.seconds, fps: o.fps,
      orientation: o.orientation, logger, signal: o.signal,
    });
  }

  // LTX is a native video model: it emits a whole clip in one call rather than
  // a frame at a time, so it does NOT go through the img2img chain below.
  // Driving it frame-by-frame would throw away the temporal coherence that is
  // the entire reason to use it.
  //
  // If the runtime is missing we fall back to Ken Burns rather than failing the
  // run — same contract resolve() applies to a missing model, kept consistent
  // here so a half-installed LTX behaves like an uninstalled one.
  if (strategy.id === 'ltx') {
    if (o.ltx?.available()) {
      return o.ltx.generate({
        initImage: o.still,
        prompt: o.prompt,
        outPath: o.outPath,
        seconds: o.seconds,
        signal: o.signal,
        onProgress: (p) => o.onProgress?.(p.pct),
      });
    }
    const why = o.ltx?.unavailableReason() || 'LTX runtime unavailable.';
    logger?.warn(`${why} Falling back to Ken Burns.`);
    o.onFallback?.(why);
    return compose.kenBurns({
      image: o.still, outPath: o.outPath, seconds: o.seconds, fps: o.fps,
      orientation: o.orientation, logger, signal: o.signal,
    });
  }

  // Real motion: generate a frame per tick via img2img chained off the previous
  // frame, which keeps the subject coherent instead of producing a flickering
  // sequence of unrelated images.
  const frameDir = path.join(o.workDir, 'frames');
  fs.mkdirSync(frameDir, { recursive: true });

  const frameCount = Math.max(2, Math.round(o.seconds * o.fps));
  const { w, h } = compose.dimensionsFor(o.orientation);
  let prev = o.still;

  for (let i = 0; i < frameCount; i++) {
    if (o.signal?.aborted) throw new Error('cancelled');
    const outFrame = path.join(frameDir, `frame_${String(i).padStart(5, '0')}.png`);

    if (i === 0) {
      fs.copyFileSync(o.still, outFrame);
    } else {
      await o.sd.generate({
        prompt: o.prompt,
        outPath: outFrame,
        // Low strength per step: enough to move, not enough to lose the subject.
        initImage: prev,
        strength: 0.22,
        steps: 8,
        width: w, height: h,
        signal: o.signal,
      });
    }
    prev = outFrame;
    o.onProgress?.(((i + 1) / frameCount) * 100);
  }

  return compose.framesToVideo({
    pattern: path.join(frameDir, 'frame_%05d.png'),
    outPath: o.outPath, fps: o.fps, logger, signal: o.signal,
  });
}

function list() {
  return Object.values(STRATEGIES).map((s) => ({
    id: s.id, name: s.name, realMotion: s.realMotion,
    describe: s.describe, requiresModel: s.requiresModel,
  }));
}

module.exports = { STRATEGIES, resolve, renderScene, list };
