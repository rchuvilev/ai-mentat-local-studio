'use strict';
//
// SETUP GROUPED BY PIPELINE STEP
//
// ─── THE PROBLEM THIS SOLVES ────────────────────────────────────────────────
//
// The Setup tab was two flat lists: "Engines" (2 rows) and "Models" (18 rows).
// Nothing connected a row to the thing it makes possible. A user who wants
// narration had to already know that "Kokoro-82M" is the TTS model, and a user
// staring at "Missing required: Stable Diffusion 1.5" had no way to see which
// step would stop working.
//
// Grouping by pipeline step fixes that, and the step list ALREADY EXISTS in
// two places: `ALL_STEPS` in ai/runner.js and `STEP_META` in app.js drive the
// movie-mode checkboxes. So this is a third consumer of the same taxonomy, not
// a new one — which is precisely why it must be derived rather than retyped.
//
// ─── THE TRAPS ──────────────────────────────────────────────────────────────
//
// 1. COMPANIONS HAVE NO ROLE. flux2-vae, flux2-text-encoder, qwen-image-vae,
//    qwen-image-text-encoder and acestep-lm all have `role: undefined`. A naive
//    group-by-role silently drops them into an "undefined" bucket — five
//    mandatory multi-gigabyte downloads in a group with no name. They must be
//    attributed to the step of the model that needs them.
//
// 2. THE PROJECTION FLATTENS `kind`. setup.js maps every registry item to
//    `kind: 'model'`, so `kind: 'companion'` from stacks.ts never reaches the
//    UI. Companion detection cannot use `kind` and must use the reverse of the
//    `companions` arrays.
//
// 3. ONE MODEL SERVES TWO STEPS. The image model is used by the `image` step
//    AND re-used by the `video` step (runner.js resolves the motion stage from
//    the same image model on purpose, so a clip animates the weights the still
//    was drawn with). A mapping that assumes one step per model loses that.
//
// 4. `compose` HAS NO MODEL, only ffmpeg. A step group that renders empty is
//    worse than no group, so steps are only rendered when they own something.

const os = require('node:os');
const fs = require('node:fs');
const nodePath = require('node:path');
const test = require('node:test');
const assert = require('node:assert');
const { buildSync } = require('esbuild');

const repoRoot = nodePath.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'setup-steps-'));

const out = nodePath.join(tmp, 'setup.js');
buildSync({
  entryPoints: [nodePath.join(repoRoot, 'ai/setup.js')],
  bundle: true, platform: 'node', format: 'cjs', outfile: out,
  external: ['node:*', 'electron'],
});
const { MODELS, ENGINES, STEP_GROUPS, groupByStep } = require(out);

const ids = (rows) => rows.map((r) => r.id);
const group = (g, step) => g.find((x) => x.step === step);

// ─── The taxonomy ──────────────────────────────────────────────────────────

test('STEP_GROUPS covers exactly the pipeline steps runner.js executes', () => {
  // ALL_STEPS is the authority. Derived, not retyped: a step added to the
  // runner and forgotten here would render a pipeline stage with no way to
  // install what it needs.
  const runnerSrc = fs.readFileSync(nodePath.join(repoRoot, 'ai/runner.js'), 'utf8');
  const m = runnerSrc.match(/const ALL_STEPS = \[([^\]]+)\]/);
  assert.ok(m, 'could not find ALL_STEPS in runner.js — control failed');
  const allSteps = m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
  assert.deepEqual(allSteps, ['plan', 'image', 'voice', 'music', 'video', 'compose']);

  assert.deepEqual(STEP_GROUPS.map((g) => g.step), allSteps,
    'STEP_GROUPS must list every runner step, in pipeline order');
});

test('every step group carries a label and a purpose', () => {
  for (const g of STEP_GROUPS) {
    assert.ok(g.label && g.label.length > 1, `${g.step} has no label`);
    assert.ok(g.hint && g.hint.length > 10, `${g.step} has no usable hint`);
  }
});

// ─── Attribution ───────────────────────────────────────────────────────────

test('every model and engine lands in at least one step group', () => {
  // THE CORE GUARANTEE. The old flat list could not lose a row; a grouped view
  // can, and a mandatory 5 GB download that renders nowhere is unfixable from
  // the UI.
  const grouped = groupByStep({ models: MODELS, engines: ENGINES });
  const placed = new Set(grouped.flatMap((g) => ids(g.items)));

  const orphans = [...MODELS, ...ENGINES].map((x) => x.id).filter((id) => !placed.has(id));
  assert.deepEqual(orphans, [], `unattributed components: ${orphans.join(', ')}`);
});

test('roleless COMPANIONS are attributed to their parent model step', () => {
  // The trap: these five have role === undefined and would form an "undefined"
  // group under a naive group-by-role.
  const grouped = groupByStep({ models: MODELS, engines: ENGINES });
  const imageIds = ids(group(grouped, 'image').items);

  for (const id of ['flux2-vae', 'flux2-text-encoder', 'qwen-image-vae', 'qwen-image-text-encoder']) {
    assert.ok(imageIds.includes(id), `${id} not attributed to the image step`);
  }
  // acestep-lm is the mandatory LM stage of the music model.
  assert.ok(ids(group(grouped, 'music').items).includes('acestep-lm'),
    'acestep-lm not attributed to the music step');

  // POSITIVE CONTROL: these really are roleless, so the assertions above test
  // the attribution logic rather than restating a role that was already there.
  for (const id of ['flux2-vae', 'qwen-image-text-encoder', 'acestep-lm']) {
    assert.equal(MODELS.find((m) => m.id === id).role, undefined,
      `${id} unexpectedly has a role — control failed`);
  }
});

test('a companion is marked as such and names its parent', () => {
  // The projection flattens kind to 'model', so the UI needs the relationship
  // restored — a 5 GB row that looks like a standalone choice is a row users
  // will try to skip.
  const grouped = groupByStep({ models: MODELS, engines: ENGINES });
  const vae = group(grouped, 'image').items.find((i) => i.id === 'qwen-image-vae');
  assert.equal(vae.companionOf, 'qwen-image-2.1');

  const klein = group(grouped, 'image').items.find((i) => i.id === 'flux2-klein-4b');
  assert.equal(klein.companionOf, undefined, 'a primary model must not be marked a companion');
});

test('the image model is attributed to BOTH the image and video steps', () => {
  // runner.js resolves the motion stage from the same image model on purpose.
  // Losing that would tell a user the video step needs nothing extra.
  const grouped = groupByStep({ models: MODELS, engines: ENGINES });
  assert.ok(ids(group(grouped, 'image').items).includes('sd15'));
  assert.ok(ids(group(grouped, 'video').items).includes('sd15'),
    'video step must show the image model it re-renders from');
});

test('shared components are flagged rather than silently duplicated', () => {
  // sd15 appearing twice must read as "also used here", or the totals a user
  // adds up by eye are wrong.
  const grouped = groupByStep({ models: MODELS, engines: ENGINES });
  const inVideo = group(grouped, 'video').items.find((i) => i.id === 'sd15');
  assert.equal(inVideo.sharedWith, 'image');

  const inImage = group(grouped, 'image').items.find((i) => i.id === 'sd15');
  assert.equal(inImage.sharedWith, undefined, 'the owning step must not be flagged as shared');
});

test('engines are attributed to every step that runs them', () => {
  const grouped = groupByStep({ models: MODELS, engines: ENGINES });
  // sd.cpp draws stills AND the frames behind real motion.
  assert.ok(ids(group(grouped, 'image').items).includes('sdcpp'));
  assert.ok(ids(group(grouped, 'video').items).includes('sdcpp'));
  // ffmpeg is what compose is.
  assert.ok(ids(group(grouped, 'compose').items).includes('ffmpeg'));
});

test('the compose step is not empty', () => {
  // It owns no model at all — only ffmpeg. An empty group is worse than none.
  const grouped = groupByStep({ models: MODELS, engines: ENGINES });
  assert.ok(group(grouped, 'compose').items.length > 0);
  for (const g of grouped) {
    assert.ok(g.items.length > 0, `step ${g.step} rendered with no components`);
  }
});

// ─── supported ─────────────────────────────────────────────────────────────

test('every model reports `supported`, so it can render a Download button', () => {
  // 🔴 PRE-EXISTING BUG, found by actually rendering the tab rather than by a
  // passing test suite.
  //
  // componentRow does:
  //     const state = !c.supported ? 'unsupported' : ...
  //     ${c.supported && !c.installed ? '<button data-install=...>' : ''}
  //
  // `modelStatus()` returned { id, installed, path, sizeOnDisk } and NEVER
  // `supported`. So `!undefined` is true for EVERY model: all 18 rows rendered
  // the "Unavailable" pill and NONE rendered a Download button — since the
  // first commit. Engines were fine because engineStatus() does set it, which
  // is why the bug survived: the Engines list looked correct.
  //
  // A model with no `platforms` restriction is supported everywhere; the field
  // must be present and true rather than absent.
  const nodePathLocal = nodePath.join(repoRoot, 'ai/setup.js');
  assert.ok(fs.existsSync(nodePathLocal));

  const os2 = require('node:os');
  const t2 = fs.mkdtempSync(nodePath.join(os2.tmpdir(), 'supported-'));
  const { Setup } = require(out);
  const setup = new Setup({
    enginesDir: nodePath.join(t2, 'e'),
    modelsDir: nodePath.join(t2, 'm'),
  });
  const st = setup.status();

  const missing = st.models.filter((m) => m.supported !== true && m.supported !== false);
  assert.deepEqual(missing.map((m) => m.id), [],
    `models with no \`supported\` field: ${missing.map((m) => m.id).join(', ')}`);

  // POSITIVE CONTROL: engines have always carried it, so a passing assertion
  // above is about models specifically.
  assert.ok(st.engines.every((e) => typeof e.supported === 'boolean'),
    'engines lost their supported field — control failed');

  // And the practical consequence: an uninstalled, supported model must be
  // offerable. This is the user-visible symptom the field drives.
  const offerable = st.models.filter((m) => m.supported && !m.installed);
  assert.ok(offerable.length > 5,
    `only ${offerable.length} models could render a Download button`);
});

// ─── Per-step readiness ────────────────────────────────────────────────────

test('each group reports whether that step can run', () => {
  // This is the point of the change: "Missing required: Stable Diffusion 1.5"
  // becomes "Stills: not ready", next to the button that fixes it.
  const models = MODELS.map((m) => ({ ...m, installed: false, supported: true }));
  const engines = ENGINES.map((e) => ({ ...e, installed: false, supported: true }));
  const none = groupByStep({ models, engines });
  assert.equal(group(none, 'image').ready, false);

  // Install an image model, its companions and the engine -> the step is ready.
  const readyIds = new Set(['sd15', 'sdcpp']);
  const some = groupByStep({
    models: models.map((m) => ({ ...m, installed: readyIds.has(m.id) })),
    engines: engines.map((e) => ({ ...e, installed: readyIds.has(e.id) })),
  });
  assert.equal(group(some, 'image').ready, true,
    'one working image model plus the engine should make the stills step ready');

  // POSITIVE CONTROL: a step with nothing installed must still be false, or
  // `ready` is just returning true.
  assert.equal(group(some, 'voice').ready, false);
});

test('a step needs only ONE of its alternative models, not all of them', () => {
  // There are four image models. Requiring all four would demand ~18 GB to
  // turn one step green.
  const models = MODELS.map((m) => ({
    ...m, supported: true,
    installed: ['sd15', 'sdcpp'].includes(m.id),
  }));
  const engines = ENGINES.map((e) => ({ ...e, supported: true, installed: e.id === 'sdcpp' }));
  const grouped = groupByStep({ models, engines });
  const img = group(grouped, 'image');

  assert.equal(img.ready, true);
  assert.ok(img.items.filter((i) => i.role === 'images').length >= 4,
    'expected several alternative image models — control failed');
});

test('an installed primary with a MISSING companion is not ready', () => {
  // The exact failure the `companions` comment in setup.js describes: FLUX
  // reporting "ready" with no VAE, which looks installed and fails at load.
  const models = MODELS.map((m) => ({
    ...m, supported: true,
    installed: m.id === 'flux2-klein-4b',   // companions deliberately absent
  }));
  const engines = ENGINES.map((e) => ({ ...e, supported: true, installed: e.id === 'sdcpp' }));
  const grouped = groupByStep({ models, engines });
  assert.equal(group(grouped, 'image').ready, false,
    'a primary model without its mandatory companions must not count as ready');
});

test('optional steps are marked optional', () => {
  // Motion can always fall back to Ken Burns through ffmpeg, so a machine that
  // installs no animation model is not broken. Music and narration are opt-in
  // extras. Stills are not: nothing generates without them.
  const grouped = groupByStep({ models: MODELS, engines: ENGINES });
  assert.equal(group(grouped, 'image').optional, false);
  assert.equal(group(grouped, 'video').optional, true);
});

test('per-step download size EXCLUDES components borrowed from another step', () => {
  // The motion step borrows every image model (it re-renders frames from the
  // same weights). Summing all its rows reports 57 GB, which reads as "motion
  // costs 57 GB ON TOP of stills" — it does not. Only what the step adds is
  // counted, and a test asserts the difference is real rather than assumed.
  const grouped = groupByStep({ models: MODELS, engines: ENGINES });

  for (const g of grouped) {
    const own = g.items.filter((i) => !i.sharedWith)
      .reduce((s, i) => s + (i.downloadGb || 0), 0);
    assert.ok(Math.abs(g.downloadGb - own) < 0.02,
      `${g.step}: reported ${g.downloadGb} GB vs ${own.toFixed(2)} own`);
    assert.ok(g.downloadGb >= 0);
  }

  // POSITIVE CONTROL 1: a group must be non-trivial, or the above is satisfied
  // by every group being zero.
  assert.ok(grouped.some((g) => g.downloadGb > 1), 'no group has a real size — control failed');

  // POSITIVE CONTROL 2: the video step must ACTUALLY carry borrowed rows, or
  // "excludes shared" is untested. And excluding them must change the number.
  const video = group(grouped, 'video');
  const borrowed = video.items.filter((i) => i.sharedWith);
  assert.ok(borrowed.length >= 4, `expected borrowed rows in video, got ${borrowed.length}`);
  const naive = video.items.reduce((s, i) => s + (i.downloadGb || 0), 0);
  assert.ok(naive > video.downloadGb + 5,
    `excluding shared rows must lower the figure: naive ${naive}, reported ${video.downloadGb}`);
});

test('the total across steps does not exceed the real download size', () => {
  // Adding the per-step figures must not overcount: a user summing the column
  // should not be told the app needs more than every component put together.
  const grouped = groupByStep({ models: MODELS, engines: ENGINES });
  const stepSum = grouped.reduce((s, g) => s + g.downloadGb, 0);
  const everything = [...MODELS, ...ENGINES]
    .reduce((s, x) => s + (x.downloadGb || 0), 0);
  assert.ok(stepSum <= everything + 0.02,
    `step totals ${stepSum.toFixed(2)} GB exceed the real ${everything.toFixed(2)} GB`);
  assert.ok(everything > 1, 'registry total is implausibly small — control failed');
});
