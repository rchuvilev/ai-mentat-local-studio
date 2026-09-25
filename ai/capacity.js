'use strict';
//
// System-capacity probing and generation-time estimation.
//
// Design note (Apr 29): "propose system capacity based ouptut max length for
// selected type and use it (5 sec min, detected sec max) to spend ~3 mins to
// generate output (approx) - place notification in UI as row before run button"
// and "add slide control to set output length between min 5s and max 60s with
// updating capacity-based estimated time".
//
// The point is that a length slider is meaningless without telling the user what
// it will cost them. Everything here exists to answer one question: given this
// machine and this mode, how long will a run of N seconds take?

const os = require('os');
const { execSync } = require('child_process');

const TARGET_RUN_SECONDS = 180;   // the ~3 minute budget from the design note
const MIN_OUTPUT_SECONDS = 5;
const MAX_OUTPUT_SECONDS = 60;
const FPS = 8;                    // frames per second of generated video

let cached = null;

// os.cpus() can legitimately return an EMPTY array — measured on this Android
// sandbox, and it also happens in some containers and restricted VMs. Every
// call site then produced 0: "CPU (0 cores)" in the UI, cores: 0 in the probe,
// and any per-core scaling silently collapsing to nothing. Node itself offers
// no guaranteed count, so fall back to a conservative 1 rather than 0 —
// under-reporting slows an estimate, zero breaks the arithmetic that uses it.
function cpuCount() {
  const n = os.cpus()?.length || 0;
  return n > 0 ? n : 1;
}

// ─── Hardware probe ────────────────────────────────────────────────────────

function detectAccelerator() {
  const platform = process.platform;

  if (platform === 'darwin') {
    // Apple Silicon exposes Metal to stable-diffusion.cpp; Intel Macs do not
    // have a usable GPU path here and fall back to CPU.
    const arm = os.cpus()[0]?.model?.includes('Apple') || process.arch === 'arm64';
    if (arm) return { kind: 'metal', label: 'Apple GPU (Metal)', gpu: true };
    return { kind: 'cpu', label: 'CPU (Intel Mac)', gpu: false };
  }

  // NVIDIA is the only broadly supported CUDA path for the engines used here.
  try {
    const out = execSync('nvidia-smi --query-gpu=name --format=csv,noheader', {
      timeout: 4000, stdio: 'pipe',
    }).toString().trim();
    if (out) return { kind: 'cuda', label: `${out.split('\n')[0]} (CUDA)`, gpu: true };
  } catch {}

  return { kind: 'cpu', label: `CPU (${cpuCount()} cores)`, gpu: false };
}

function probe() {
  if (cached) return cached;
  const accel = detectAccelerator();
  cached = {
    platform: process.platform,
    arch: process.arch,
    cores: cpuCount(),
    totalMemGb: +(os.totalmem() / 1024 ** 3).toFixed(1),
    accelerator: accel,
  };
  return cached;
}

// ─── Cost model ────────────────────────────────────────────────────────────
//
// Seconds of wall clock per unit of work, indexed by accelerator. These are
// deliberately conservative order-of-magnitude figures, not benchmarks — the
// UI presents them as an estimate and the real per-step timings observed during
// a run feed back in via recordObservation() below.

const BASE_COST = {
  metal: { imageStep: 0.09, ttsSecond: 0.55, musicSecond: 1.6, motionFrame: 1.1, llmPlan: 12 },
  cuda:  { imageStep: 0.05, ttsSecond: 0.30, musicSecond: 0.9, motionFrame: 0.6, llmPlan: 7 },
  cpu:   { imageStep: 0.80, ttsSecond: 2.40, musicSecond: 9.0, motionFrame: 8.0, llmPlan: 45 },
};

// Learned multiplier per accelerator, nudged toward reality as runs complete so
// the estimate stops lying after the first few generations on a given machine.
const observed = {};

function cost(kind) {
  const base = BASE_COST[kind] || BASE_COST.cpu;
  const k = observed[kind];
  if (!k) return base;
  const out = {};
  for (const [key, v] of Object.entries(base)) out[key] = v * k;
  return out;
}

function recordObservation(kind, predictedSec, actualSec) {
  if (!predictedSec || !actualSec || predictedSec <= 0) return;
  const ratio = actualSec / predictedSec;
  // Clamp so one pathological run cannot wreck every future estimate.
  const clamped = Math.max(0.25, Math.min(4, ratio));
  observed[kind] = observed[kind] ? observed[kind] * 0.7 + clamped * 0.3 : clamped;
}

// Image steps are the main quality/time dial.
//
// Design note (Apr 29): "why image-only generation has 20 sd steps? don't we
// just generate single one image?" — a single still is cheap enough to afford
// full quality, while a movie multiplies steps by every scene, so the two cases
// get different budgets rather than one blanket 20.
function stepsFor(mode, quality = 'balanced') {
  const table = {
    fast:     { image: 14, movie: 8 },
    balanced: { image: 24, movie: 12 },
    quality:  { image: 36, movie: 20 },
  };
  const row = table[quality] || table.balanced;
  return mode === 'image' ? row.image : row.movie;
}

/**
 * Estimate wall-clock seconds for a run.
 *
 * @param {object} opts
 * @param {string} opts.mode        image | voice | music | video | movie
 * @param {number} opts.outputSec   requested output length in seconds
 * @param {string} opts.quality     fast | balanced | quality
 * @param {string} opts.motion      animatediff | wan | kenburns
 * @param {string[]} opts.steps     for movie mode, the enabled step ids
 */
function estimateSeconds({ mode, outputSec = 10, quality = 'balanced', motion = 'kenburns', steps = [] }) {
  const { accelerator } = probe();
  const c = cost(accelerator.kind);
  const sceneCount = Math.max(1, Math.round(outputSec / 5));

  const part = {
    plan:   () => c.llmPlan,
    image:  () => stepsFor(mode, quality) * c.imageStep * (mode === 'image' ? 1 : sceneCount),
    voice:  () => outputSec * c.ttsSecond,
    music:  () => outputSec * c.musicSecond,
    // Ken Burns is an ffmpeg pan/zoom over a still — near free next to real
    // frame-by-frame diffusion, which is the whole reason it stayed as the
    // fallback path.
    video:  () => motion === 'kenburns'
      ? Math.max(2, outputSec * 0.3)
      : outputSec * FPS * c.motionFrame,
    compose: () => Math.max(3, outputSec * 0.4),
  };

  let total = 0;
  if (mode === 'movie') {
    const enabled = steps.length ? steps : ['plan', 'image', 'voice', 'music', 'video', 'compose'];
    for (const s of enabled) if (part[s]) total += part[s]();
  } else if (part[mode]) {
    if (mode === 'video') total += part.image() + part.video() + part.compose();
    else total += part[mode]();
  }
  return Math.round(total);
}

/**
 * Longest output length that still fits inside the ~3 minute budget, clamped to
 * the 5..60s range the slider exposes.
 */
function recommendedMaxSeconds(opts) {
  for (let sec = MAX_OUTPUT_SECONDS; sec >= MIN_OUTPUT_SECONDS; sec -= 1) {
    if (estimateSeconds({ ...opts, outputSec: sec }) <= TARGET_RUN_SECONDS) return sec;
  }
  return MIN_OUTPUT_SECONDS;
}

function humanDuration(sec) {
  if (sec < 60) return `${Math.max(1, Math.round(sec))}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return s ? `${m}m ${s}s` : `${m}m`;
}

/** Everything the "row before the run button" needs, in one call. */
function summary(opts) {
  const hw = probe();
  const eta = estimateSeconds(opts);
  const maxSec = recommendedMaxSeconds(opts);
  return {
    hardware: hw,
    accelerator: hw.accelerator.label,
    usingGpu: hw.accelerator.gpu,
    estimateSeconds: eta,
    estimateHuman: humanDuration(eta),
    recommendedMaxSeconds: maxSec,
    minSeconds: MIN_OUTPUT_SECONDS,
    maxSeconds: MAX_OUTPUT_SECONDS,
    overBudget: eta > TARGET_RUN_SECONDS,
    targetSeconds: TARGET_RUN_SECONDS,
  };
}

module.exports = {
  probe, summary, estimateSeconds, recommendedMaxSeconds, recordObservation,
  stepsFor, humanDuration,
  MIN_OUTPUT_SECONDS, MAX_OUTPUT_SECONDS, TARGET_RUN_SECONDS, FPS,
};
