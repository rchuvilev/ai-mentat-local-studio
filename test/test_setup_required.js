'use strict';
//
// "Required" must mean required FOR THE SELECTED STACK.
//
// ─── THE BUG THIS EXISTS TO PREVENT ─────────────────────────────────────────
//
// `required` was a hardcoded flag on sd15, set long before a second stack
// existed. Once the advisor could recommend FLUX.2 Klein, a Studio-stack user
// saw a warning badge and "Missing required: Stable Diffusion 1.5" for a 1.7 GB
// model the app would never load — pushing a pointless download and implying
// the app was not ready when it was.
//
// Found by tracing the end-to-end user flow, not by a failing test: every suite
// was green because nothing compared the advisor's output against Setup's
// notion of "required".

const os = require('os');
const nodePath = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');

const repoRoot = nodePath.resolve(__dirname, '..');
const tmp = nodePath.join(os.tmpdir(), `required-${process.pid}`);
require('node:fs').mkdirSync(tmp, { recursive: true });

const out = nodePath.join(tmp, 'setup.js');
buildSync({
  entryPoints: [nodePath.join(repoRoot, 'ai/setup.js')],
  bundle: true, platform: 'node', format: 'cjs', outfile: out,
  external: ['node:*', 'electron'],
});
const { Setup } = require(out);

const setup = new Setup({
  enginesDir: nodePath.join(tmp, 'engines'),
  modelsDir: nodePath.join(tmp, 'models'),
});

const STUDIO = {
  plot: 'llm-qwen3-8b', images: 'flux2-klein-4b',
  animation: 'wan-i2v', diction: 'tts-kokoro', music: 'acestep-1.5',
};
const LITE = {
  plot: 'llm-planner', images: 'sd15',
  diction: 'tts-kokoro', music: 'music-musicgen',
};

const requiredIds = (stack) =>
  setup.status(stack ? { modelStack: stack } : {})
    .models.filter((m) => m.required).map((m) => m.id);

test('a studio stack does not demand the lite stack\'s image model', () => {
  const ids = requiredIds(STUDIO);
  assert.ok(!ids.includes('sd15'), 'sd15 must not be required when FLUX was chosen');
  assert.ok(ids.includes('flux2-klein-4b'), 'the chosen image model must be required');
});

test('CONTROL: a lite stack still requires sd15', () => {
  // Without this, the test above could pass by never requiring anything —
  // which would be a worse bug than the one being fixed.
  assert.ok(requiredIds(LITE).includes('sd15'));
});

test('mandatory companions are required alongside their primary model', () => {
  // A primary model with no companions looks installed and then fails at load.
  // This regressed once already: setup.js's mapping dropped the `companions`
  // field entirely, so this assertion is what caught it.
  const ids = requiredIds(STUDIO);
  for (const c of ['flux2-vae', 'flux2-text-encoder', 'acestep-lm']) {
    assert.ok(ids.includes(c), `companion '${c}' must be required`);
  }
});

test('the optional animation role is never required', () => {
  // Ken Burns covers motion with no model at all, so demanding a 9 GB (or
  // 27.5 GB) video model to reach "ready" would be wrong.
  const ids = requiredIds(STUDIO);
  assert.ok(!ids.includes('wan-i2v'));
  assert.ok(!ids.includes('ltx-2.3-distilled'));
});

test('with no stack selected it falls back to the static flag', () => {
  // The pre-advisor behaviour, and the right answer on a first launch that has
  // not yet reached the startup check.
  assert.deepEqual(requiredIds(null), ['sd15']);
});

test('per-row required flags agree with missingRequired', () => {
  // The banner and the pills are rendered from the same status() call; if they
  // disagreed the UI would contradict itself.
  const st = setup.status({ modelStack: STUDIO });
  const flagged = st.models.filter((m) => m.required && !m.installed).map((m) => m.name);
  for (const name of flagged) {
    assert.ok(st.missingRequired.includes(name),
      `'${name}' is flagged required but absent from missingRequired`);
  }
});
