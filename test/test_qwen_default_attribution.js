'use strict';
//
// QWEN AS THE DEFAULT IMAGE MODEL, AND THE ATTRIBUTION THE LICENCE REQUIRES
//
// Three changes are asserted here, all driven by one decision: the app is a
// FREE, non-commercial Electron project that never redistributes weights.
//
// 1. LICENCE ATTRIBUTION (Qwen Research Licence clause 6.b)
//
//    "You shall prominently display 'Built with Qwen' or 'Improved using Qwen'
//    in the related product documentation."
//
//    A licence pill with a tooltip is NOT prominent display — it is a hover
//    affordance on one row of a Setup tab. The attribution has to exist as a
//    visible string. This is the only clause the app can actually breach:
//    clause 3 (Redistribution) never triggers, because `ai/download.js` fetches
//    every weight from HuggingFace at runtime and the repo bundles none
//    (measured: 0 *.gguf / *.safetensors outside node_modules).
//
// 2. QWEN BECOMES THE DEFAULT IMAGE MODEL
//
//    Previously blocked as opt-in ONLY because the Research Licence forbids
//    commercial use. A free project is inside the non-commercial grant, so the
//    blocker is gone.
//
//    🔴 THE MECHANISM IS NOT THE MEMORY GATE. Measured before writing this:
//    Qwen already sat at index 0 of images[] and already reported fits=true on
//    a 16 GB CPU box (need 11.11 GB). It lost on SCORE — the CPU placement
//    scores Qwen 27 (16 GB) / 47 (32 GB) against Klein's 55, and `advise()`
//    falls back to the HIGHEST-SCORING survivor rather than the first that
//    fits. So "make it default" means an explicit preference, not a reorder.
//    Reordering alone would have changed nothing and looked like it worked.
//
// 3. THE UNCENSORED REPO REPLACES leejet's
//
//    Done on explicit instruction, against the measured recommendation: the
//    UC file's BF16 tensors are bit-identical to its own `base` branch while
//    only the Q4_K ones differ, i.e. a re-quantization of the same weights,
//    +407 MB. The tests below therefore pin the things that CAN still break:
//    the URL's filename, the measured byte size, and the arch dispatch.

const os = require('node:os');
const fs = require('node:fs');
const nodePath = require('node:path');
const test = require('node:test');
const assert = require('node:assert');
const { buildSync } = require('esbuild');

const repoRoot = nodePath.resolve(__dirname, '..');
const tmp = nodePath.join(os.tmpdir(), `qwen-default-${process.pid}`);
fs.mkdirSync(tmp, { recursive: true });

function bundle(rel, name) {
  const out = nodePath.join(tmp, name);
  buildSync({
    entryPoints: [nodePath.join(repoRoot, rel)],
    bundle: true, platform: 'node', format: 'cjs', outfile: out,
    external: ['node:*', 'electron'],
  });
  return require(out);
}

const { ROLES, registry, ATTRIBUTION } = bundle('ai/stacks.ts', 'stacks.js');
const advisor = bundle('ai/advisor.ts', 'advisor.js');
const { archFor } = require('../ai/sdcpp.js');

const images = () => registry().roles.images;
const qwen = () => images().find((m) => m.id === 'qwen-image-2.1');

// Mirrors test_advisor.ts's fixture so the two files agree on machine shape.
function machine(over = {}) {
  return {
    platform: 'linux', arch: 'x64',
    cpu: { model: 'Test CPU', cores: 8, features: { avx: true, avx2: true, avx512: false, neon: false } },
    ram: { totalGb: 16, freeGb: 8, speedMhz: 3200, channels: 2, type: 'DDR4', bandwidthGbps: 51.2, source: 'test' },
    gpus: [], primaryGpu: null, totalVramGb: 0, unifiedMemory: false,
    aiMemoryGb: 10.4, freeDiskGb: 500, backend: 'cpu',
    ...over,
  };
}
const ramOf = (totalGb) => ({
  totalGb, freeGb: totalGb / 2, speedMhz: 3200, channels: 2,
  type: 'DDR4', bandwidthGbps: 51.2, source: 'test',
});

// ─── 1. Attribution ─────────────────────────────────────────────────────────

test('ATTRIBUTION exports the exact string the Qwen licence demands', () => {
  assert.ok(ATTRIBUTION, 'stacks must export an ATTRIBUTION record');
  const all = JSON.stringify(ATTRIBUTION);
  // Clause 6.b names two acceptable strings. Accept either, verbatim.
  assert.ok(/Built with Qwen|Improved using Qwen/.test(all),
    'clause 6.b requires the literal string "Built with Qwen" or "Improved using Qwen"');
});

test('the attribution names the model it is attributing', () => {
  const entry = ATTRIBUTION.qwen;
  assert.ok(entry, 'ATTRIBUTION.qwen must exist');
  assert.equal(typeof entry.notice, 'string');
  assert.ok(entry.notice.includes('Built with Qwen'),
    `notice must contain the licence's literal phrase, got: ${entry.notice}`);
  assert.ok(/research|non-commercial/i.test(entry.license),
    'the licence summary must still say research / non-commercial');
});

test('every model carrying a licence also carries an attribution notice', () => {
  // A licence field without the matching notice is exactly the gap clause 6.b
  // penalises: the restriction is shown, the required credit is not.
  for (const list of Object.values(ROLES)) {
    for (const m of list) {
      if (!m.license) continue;
      assert.ok(m.attribution, `${m.id} has a licence but no attribution notice`);
      assert.ok(m.attribution.includes('Built with Qwen') || m.attribution.includes('Improved using Qwen'),
        `${m.id} attribution must carry the licence's literal phrase`);
    }
  }
});

test('the Setup projection carries attribution through to the UI layer', () => {
  // A notice that stops at the registry is a notice nobody sees — the same
  // failure mode the `license` field was added to fix.
  const setup = bundle('ai/setup.js', 'setup-attr.js');
  const m = setup.MODELS.find((x) => x.id === 'qwen-image-2.1');
  assert.ok(m, 'qwen-image-2.1 missing from MODELS');
  assert.ok(m.attribution, 'modelStatus projection dropped `attribution`');
  assert.ok(m.attribution.includes('Built with Qwen'));
});

// ─── 2. Qwen is the default ─────────────────────────────────────────────────

test('qwen-image-2.1 is declared first among image candidates', () => {
  assert.equal(images()[0].id, 'qwen-image-2.1',
    'the default image model must be declared first');
});

test('qwen is chosen for images on a machine that can hold it', () => {
  // 🔴 This is the assertion that actually fails without the change. Qwen
  // already FIT on these machines and was still not picked, because the
  // fallback sorts by score and CPU placement scores it below Klein.
  for (const totalGb of [32, 64]) {
    const hw = machine({ ram: ramOf(totalGb), aiMemoryGb: totalGb * 0.65 });
    const { chosen } = advisor.chooseStack(hw, registry());
    assert.ok(chosen.images, `${totalGb} GB: no image model chosen at all`);
    assert.equal(chosen.images.id, 'qwen-image-2.1',
      `${totalGb} GB machine should default to Qwen, got ${chosen.images.id}`);
  }
});

test('qwen is chosen on a GPU machine', () => {
  const hw = machine({
    ram: ramOf(64),
    gpus: [{ vendor: 'NVIDIA', name: 'G', vramGb: 24, dedicated: true, bandwidthGbps: 1000, backend: 'cuda' }],
    primaryGpu: { vendor: 'NVIDIA', name: 'G', vramGb: 24, dedicated: true, bandwidthGbps: 1000, backend: 'cuda' },
    totalVramGb: 24, backend: 'cuda', aiMemoryGb: 40,
  });
  const { chosen } = advisor.chooseStack(hw, registry());
  assert.equal(chosen.images.id, 'qwen-image-2.1');
});

test('a machine too small for Qwen still gets a working image model', () => {
  // Promoting a default must not strand small machines with nothing. Qwen
  // needs ~11.11 GB; an 8 GB box must fall through to a lighter candidate
  // rather than receive Qwen or null.
  const hw = machine({ ram: ramOf(8), aiMemoryGb: 5.2, freeDiskGb: 500 });
  const { chosen } = advisor.chooseStack(hw, registry());
  assert.ok(chosen.images, 'small machine must still get an image model');
  assert.notEqual(chosen.images.id, 'qwen-image-2.1',
    'an 8 GB machine must not be handed the 9.91 GB model');
});

test('a small-disk machine is not handed the largest download', () => {
  const hw = machine({ ram: ramOf(64), aiMemoryGb: 41, freeDiskGb: 6 });
  const { chosen } = advisor.chooseStack(hw, registry());
  if (chosen.images) {
    assert.ok(chosen.images.downloadGb + 2 <= 6,
      `chose ${chosen.images.id} (${chosen.images.downloadGb} GB) with only 6 GB free`);
  }
});

// ─── 3. The uncensored repo ─────────────────────────────────────────────────

test('the image model points at the uncensored GGUF repo', () => {
  const m = qwen();
  assert.match(m.url, /abenzerps\/Qwen-Image-2\.1-Uncensored-GGUF/,
    'url must point at the instructed repo');
  assert.match(m.url, /qwen-image-2\.1-UC-Q4_K_M\.gguf$/,
    'must use the UC Q4_K_M quant the card recommends');
  assert.equal(m.file, 'qwen-image-2.1-uc-q4_k_m.gguf',
    'local filename must track the new quant, not the old Q4_K one');
});

test('the recorded size matches the measured bytes of the new file', () => {
  // 4604558112 B was read from Content-Range, not estimated. These numbers
  // gate disk and memory, so a stale value from the previous file would
  // under-reserve by 407 MB.
  const m = qwen();
  const bytes = 4604558112;
  const gb = bytes / 1024 ** 3;
  // registry() folds companions in, so compare against the raw ROLES entry.
  const raw = ROLES.images.find((x) => x.id === 'qwen-image-2.1');
  assert.ok(Math.abs(raw.downloadGb - gb) < 0.05,
    `downloadGb ${raw.downloadGb} should be ~${gb.toFixed(2)} (measured ${bytes} B)`);
});

test('arch dispatch still routes the renamed file to the qwen path', () => {
  // archFor() keys off the ID precisely so a renamed .gguf cannot break it.
  // Renaming the file is exactly the event that would expose a filename sniff.
  assert.equal(archFor('qwen-image-2.1'), 'qwen');
});

test('no Q3_K variant is offered', () => {
  // Explicitly declined. Asserted so a later "helpful" addition has to be
  // deliberate rather than silent.
  for (const m of ROLES.images) {
    assert.ok(!/q3_k/i.test(m.file), `${m.id} introduces a Q3_K variant`);
  }
});
