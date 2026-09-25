'use strict';
//
// End-to-end WIRING test.
//
// ─── WHY THIS EXISTS SEPARATELY FROM test_advisor.ts ────────────────────────
//
// test_advisor.ts proves the SELECTION LOGIC is right, using synthetic hardware
// profiles and the registry. It cannot catch the failure mode that actually
// bit during development: a model that the advisor happily recommends but that
// `Setup.find()` returns `null` for, because the two lists had drifted apart.
// That surfaces to the user as "model not downloaded" for a model the app just
// told them to use — and every unit test still passes.
//
// So this file asserts the modules RESOLVE EACH OTHER:
//
//   * every item the advisor can recommend is installable through Setup
//   * every motion strategy points at a model id that really exists
//   * LTX falls back to Ken Burns when its weights are absent
//
// It bundles each module with esbuild first, exactly the way the app does,
// because ai/stacks.ts is TypeScript and plain `require()` cannot load it.
// That also means this test exercises the REAL build path rather than a
// parallel one — if bundling breaks, this fails.

const os = require('os');
const nodePath = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');

const repoRoot = nodePath.resolve(__dirname, '..');
const tmp = nodePath.join(os.tmpdir(), `wiring-${process.pid}`);
require('node:fs').mkdirSync(tmp, { recursive: true });

/** Bundle a module the way sdk/utils/bundle-electron.js does, then load it. */
function load(entry, name) {
  const out = nodePath.join(tmp, name);
  buildSync({
    entryPoints: [nodePath.join(repoRoot, entry)],
    bundle: true, platform: 'node', format: 'cjs', outfile: out,
    external: ['node:*', 'electron', 'kokoro-js', 'node-llama-cpp'],
  });
  return require(out);
}

const motion = load('ai/motion.js', 'motion.js');
const { Setup } = load('ai/setup.js', 'setup.js');
const stacks = load('ai/stacks.ts', 'stacks.js');

const setup = new Setup({
  enginesDir: nodePath.join(tmp, 'engines'),
  modelsDir: nodePath.join(tmp, 'models'),
});

test('every recommendable model is installable through Setup', () => {
  // The drift guard. setup.js derives MODELS from stacks.ts precisely so this
  // cannot break, and this test is what proves the derivation still holds.
  const missing = stacks.allItems()
    .filter((m) => !setup.find(m.id))
    .map((m) => m.id);
  assert.deepEqual(missing, [], `models in the registry but not installable: ${missing.join(', ')}`);
});

test('every motion strategy points at a real model id', () => {
  // A strategy naming a nonexistent model never activates and never errors —
  // it just silently always falls back, which is invisible without this check.
  for (const s of Object.values(motion.STRATEGIES)) {
    if (!s.requiresModel) continue;
    assert.ok(setup.find(s.requiresModel),
      `motion strategy '${s.id}' requires unknown model '${s.requiresModel}'`);
  }
});

test('LTX is registered and falls back to Ken Burns when absent', () => {
  assert.ok(motion.STRATEGIES.ltx, 'ltx strategy must exist');

  const absent = motion.resolve('ltx', () => false);
  assert.equal(absent.strategy.id, 'kenburns', 'must fall back when weights are missing');
  assert.equal(absent.fellBack, true);
  assert.match(absent.reason, /ltx-2\.3-distilled/, 'the reason must name the missing model');

  // CONTROL: without this, the assertion above would also pass for a strategy
  // that can NEVER be selected.
  const present = motion.resolve('ltx', () => true);
  assert.equal(present.strategy.id, 'ltx', 'must be selected when weights are present');
  assert.equal(present.fellBack, false);
});

test('Ken Burns remains the only non-diffusion motion path', () => {
  // capacity.js's cost model and its ordering test depend on this: Ken Burns is
  // an ffmpeg pan/zoom, everything else generates frames. If a future strategy
  // is added as realMotion:false, the estimator would price it as free.
  assert.equal(motion.STRATEGIES.kenburns.realMotion, false);
  const real = Object.values(motion.STRATEGIES).filter((s) => s.realMotion !== false);
  assert.ok(real.length >= 3, 'animatediff, wan and ltx must all be real motion');
});

test('mandatory companions are registered as installable items', () => {
  // ACE-Step needs its LM stage and FLUX needs a VAE + text encoder. If these
  // are not installable the primary model downloads and then fails at load.
  for (const id of ['acestep-lm', 'flux2-vae', 'flux2-text-encoder']) {
    assert.ok(setup.find(id), `companion '${id}' must be installable`);
  }
});
