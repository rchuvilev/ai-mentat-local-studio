'use strict';
//
// QWEN-IMAGE-2.1 ARCHITECTURE SUPPORT
//
// Qwen-Image-2.1 is a third checkpoint layout, and it differs from both
// existing ones in ways that are silent when wrong:
//
//   SD/SDXL   one monolithic checkpoint            -m <ckpt>
//   FLUX.2    transformer + VAE + CLIP text enc    --diffusion-model --vae --clip_l
//   Qwen 2.1  transformer + VAE + an LLM text enc  --diffusion-model --vae --llm
//
// The trap: Qwen's text encoder is Qwen3-VL-8B, a full vision-language model
// passed with `--llm`, NOT `--clip_l`. Passing it as clip_l does not error
// cleanly — sd.cpp tries to read it as a CLIP checkpoint.
//
// The second trap is guidance. FLUX.2 Klein is guidance-distilled, so the
// driver forces `--cfg-scale 1.0` and drops negative prompts for it. Qwen is
// NOT distilled: upstream's own example uses `--cfg-scale 6.0`, and clamping it
// to 1.0 produces washed-out, prompt-ignoring images that look like a bad model
// rather than a bad flag. Negative prompts work and must be forwarded.

const os = require('node:os');
const fs = require('node:fs');
const nodePath = require('node:path');
const test = require('node:test');
const assert = require('node:assert');
const { buildSync } = require('esbuild');

const repoRoot = nodePath.resolve(__dirname, '..');
const tmp = nodePath.join(os.tmpdir(), `qwen-image-${process.pid}`);
fs.mkdirSync(tmp, { recursive: true });

const out = nodePath.join(tmp, 'setup.js');
buildSync({
  entryPoints: [nodePath.join(repoRoot, 'ai/setup.js')],
  bundle: true, platform: 'node', format: 'cjs', outfile: out,
  external: ['node:*', 'electron'],
});
const { MODELS } = require(out);

const { SdCpp, archFor } = require('../ai/sdcpp.js');

// registry() folds companion costs into each model; it is what the advisor
// consumes, so fit assertions must read it rather than the raw ROLES entry.
const stacksOut = nodePath.join(tmp, 'stacks.js');
buildSync({
  entryPoints: [nodePath.join(repoRoot, 'ai/stacks.ts')],
  bundle: true, platform: 'node', format: 'cjs', outfile: stacksOut,
  external: ['node:*', 'electron'],
});
const { registry } = require(stacksOut);

const byId = (id) => MODELS.find((m) => m.id === id);
const roleModels = (role) => registry().roles[role];

// ─── Registry ──────────────────────────────────────────────────────────────

test('qwen-image-2.1 is registered as an image model', () => {
  const m = byId('qwen-image-2.1');
  assert.ok(m, 'qwen-image-2.1 missing from the model registry');
  assert.equal(m.role, 'images');
  assert.equal(m.engine, 'sdcpp');
});

test('its mandatory companions are declared', () => {
  // The transformer alone cannot generate anything. Quoting 4.2 GB and then
  // downloading 9.2 GB is exactly the dishonesty totalCost() exists to stop.
  const m = byId('qwen-image-2.1');
  assert.ok(m.companions.includes('qwen-image-vae'));
  assert.ok(m.companions.includes('qwen-image-text-encoder'));
  for (const id of m.companions) {
    assert.ok(byId(id), `companion ${id} not in the registry`);
  }
});

test('the declared download size reflects the REAL total, not the transformer', () => {
  // Measured with HTTP HEAD against the resolve URLs:
  //   qwen_image_2.1-Q4_K.gguf           4 200 000 000 B
  //   Qwen3VL-8B-Instruct-Q4_K_M.gguf    5 027 784 800 B
  const m = byId('qwen-image-2.1');
  const te = byId('qwen-image-text-encoder');
  assert.ok(te.downloadGb >= 4.5, `text encoder understated at ${te.downloadGb} GB`);

  const total = m.downloadGb + m.companions.reduce((s, id) => s + byId(id).downloadGb, 0);
  assert.ok(total >= 9, `total ${total} GB is implausibly low for this stack`);

  // POSITIVE CONTROL: FLUX.2 Klein must come out far cheaper, or the
  // comparison that justifies keeping Klein as the default is meaningless.
  const klein = byId('flux2-klein-4b');
  const kleinTotal = klein.downloadGb
    + klein.companions.reduce((s, id) => s + byId(id).downloadGb, 0);
  assert.ok(kleinTotal < 4, `Klein total ${kleinTotal} GB — control failed`);
  assert.ok(total > kleinTotal * 2, 'Qwen should be materially heavier than Klein');
});

test('the advisor gates on weights WITH companions folded in', () => {
  // The raw registry entry carries the transformer only (4.2 GB). The advisor
  // must see the true resident cost — transformer + 8B text encoder + VAE —
  // or it will offer Qwen on a machine that cannot load it, which is the exact
  // failure mode the memory gate exists to prevent.
  //
  // Asserted against registry(), which is what the advisor actually consumes,
  // NOT against the ROLES entry: a comment claiming the fold happens is not
  // evidence that it does.
  const qwen = roleModels('images').find((m) => m.id === 'qwen-image-2.1');
  const klein = roleModels('images').find((m) => m.id === 'flux2-klein-4b');

  assert.ok(qwen.weightsGb >= 9, `advisor sees only ${qwen.weightsGb} GB — companions not folded`);
  assert.ok(qwen.weightsGb > klein.weightsGb * 2,
    'qwen must present a much larger footprint than Klein');

  // POSITIVE CONTROL: the raw entry is genuinely smaller, so the assertion
  // above is testing the fold rather than restating the declared number.
  //
  // Compared RELATIVELY rather than against a literal. This previously pinned
  // 4.2 and broke when the weights moved to the UC Q4_K_M quant (4.29 GB,
  // measured 4604558112 B) — a stale literal in a control turns every future
  // quant change into a spurious failure, while proving nothing the inequality
  // does not already prove.
  const raw = byId('qwen-image-2.1').weightsGb;
  assert.ok(raw > 0 && raw < qwen.weightsGb,
    `raw entry (${raw}) must be smaller than the folded total (${qwen.weightsGb})`);
});

test('the non-commercial licence is recorded on the entry', () => {
  // Qwen RESEARCH LICENSE, not Apache: research/evaluation only, commercial use
  // needs a separate grant. The app is a free personal project so this is fine,
  // but it must be visible in the UI rather than buried in a commit message.
  const m = byId('qwen-image-2.1');
  assert.match(m.license || '', /non-commercial|research/i);
});

// ─── Driver ────────────────────────────────────────────────────────────────

test('archFor keys off the model id, not the filename', () => {
  assert.equal(archFor('qwen-image-2.1'), 'qwen');
  assert.equal(archFor('flux2-klein-4b'), 'flux');
  assert.equal(archFor('sd15'), 'sd');
  assert.equal(archFor('sdxl-turbo'), 'sd');
});

function argsFor(opts, ctor) {
  const sd = new SdCpp({ binary: '/bin/true', modelPath: __filename, ...ctor });
  return sd.buildArgs({ prompt: 'p', outPath: nodePath.join(tmp, 'o.png'), ...opts });
}

test('qwen passes its text encoder with --llm, never --clip_l', () => {
  const args = argsFor({}, { arch: 'qwen', vaePath: __filename, clipPath: __filename });
  assert.ok(args.includes('--llm'), 'missing --llm');
  assert.ok(!args.includes('--clip_l'), 'qwen must not use --clip_l');
  assert.ok(args.includes('--diffusion-model'), 'qwen needs --diffusion-model');
  assert.ok(args.includes('--vae'), 'qwen needs its own VAE');
});

test('flux still uses --clip_l and not --llm', () => {
  // POSITIVE CONTROL for the test above: without this, moving every arch onto
  // --llm would pass it.
  const args = argsFor({}, { arch: 'flux', vaePath: __filename, clipPath: __filename });
  assert.ok(args.includes('--clip_l'));
  assert.ok(!args.includes('--llm'));
});

test('qwen keeps a real CFG scale and is NOT clamped to 1.0', () => {
  const args = argsFor({}, { arch: 'qwen' });
  const cfg = args[args.indexOf('--cfg-scale') + 1];
  assert.ok(Number(cfg) >= 4, `qwen cfg-scale clamped to ${cfg}; upstream uses 6.0`);
});

test('flux remains clamped to 1.0', () => {
  const args = argsFor({}, { arch: 'flux' });
  assert.equal(args[args.indexOf('--cfg-scale') + 1], '1.0');
});

test('qwen forwards negative prompts; flux drops them', () => {
  const q = argsFor({ negative: 'blurry' }, { arch: 'qwen' });
  assert.ok(q.includes('-n'), 'qwen must forward a negative prompt');

  const f = argsFor({ negative: 'blurry' }, { arch: 'flux' });
  assert.ok(!f.includes('-n'), 'flux must still drop negative prompts');
});

test('no arch ever emits the removed img2img mode', () => {
  for (const arch of ['sd', 'flux', 'qwen']) {
    const args = argsFor({ initImage: __filename }, { arch });
    assert.ok(!args.includes('img2img'), `${arch} still passes img2img`);
    assert.ok(args.includes('-i'), `${arch} lost its init image`);
    // -M is only valid with a mode from modes_str[]; the driver should not
    // pass it at all, since img_gen is already the default.
    assert.ok(!args.includes('-M'), `${arch} passes a bare -M`);
  }
});

test('qwen image dimensions are a multiple of 32', () => {
  // docs/qwen_image_2.1.md: "Use image dimensions divisible by 32." sd.cpp does
  // not round for you — a 500x500 request produces a shape mismatch abort.
  const args = argsFor({ width: 500, height: 500 }, { arch: 'qwen' });
  const w = Number(args[args.indexOf('-W') + 1]);
  const h = Number(args[args.indexOf('-H') + 1]);
  assert.equal(w % 32, 0, `width ${w} not divisible by 32`);
  assert.equal(h % 32, 0, `height ${h} not divisible by 32`);
  assert.ok(w > 0 && h > 0);
});

test('stills and motion cannot resolve the image model differently', () => {
  // runner.js re-derived arch + companion paths inline at TWO sites, with a
  // comment requiring them to match and nothing enforcing it. This asserts the
  // duplication is gone: one helper, called by both.
  const src = fs.readFileSync(nodePath.join(repoRoot, 'ai/runner.js'), 'utf8');

  const calls = src.match(/this\.sdcppFor\(/g) || [];
  assert.equal(calls.length, 2, `expected both stages to use sdcppFor, found ${calls.length}`);

  // POSITIVE CONTROL: the grep finds real content, and the old inline form is
  // genuinely absent rather than the pattern being wrong.
  assert.ok(src.includes('sdcppFor(imageId)'), 'helper definition missing — control failed');
  assert.ok(!/isFlux\s*\?/.test(src), 'inline arch ternary still present in runner.js');
  assert.ok(!src.includes("'flux2-vae'"), 'runner.js still hardcodes a companion id');
});

test('non-qwen archs keep the exact dimensions asked for', () => {
  // POSITIVE CONTROL: rounding everywhere would pass the test above while
  // silently changing SD output sizes users rely on.
  const args = argsFor({ width: 500, height: 500 }, { arch: 'sd' });
  assert.equal(args[args.indexOf('-W') + 1], '500');
  assert.equal(args[args.indexOf('-H') + 1], '500');
});
