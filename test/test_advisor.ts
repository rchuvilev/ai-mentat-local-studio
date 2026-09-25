//
// Tests for the hardware advisor.
//
// CONVENTION (inherited from test_capacity.js): assert PROPERTIES, not
// constants. The efficiency coefficients and cost figures here are tuned
// estimates; a test pinned to "42 tok/s" would break on every retune while
// proving nothing. What must hold is monotonicity, ordering, bounds, and the
// hard exclusions — those are the claims the rest of the app relies on.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  throughput, placeModel, chooseStack, stackFits, tierFor, advise, TIERS,
  VRAM_SAFETY,
} from '../ai/advisor';
import type { HardwareProfile } from '../ai/hardware';
import { gpuBandwidth, cpuCount, GPU_BANDWIDTH_GBPS } from '../ai/hardware';
import { registry, ROLES, COMPANIONS, totalCost } from '../ai/stacks';

/** Build a synthetic machine. Defaults describe a mid-range CPU-only laptop. */
function machine(over: Partial<HardwareProfile> = {}): HardwareProfile {
  return {
    platform: 'linux', arch: 'x64',
    cpu: { model: 'Test CPU', cores: 8, features: { avx: true, avx2: true, avx512: false, neon: false } },
    ram: { totalGb: 16, freeGb: 8, speedMhz: 3200, channels: 2, type: 'DDR4', bandwidthGbps: 51.2, source: 'test' },
    gpus: [], primaryGpu: null, totalVramGb: 0, unifiedMemory: false,
    aiMemoryGb: 10.4, freeDiskGb: 500, backend: 'cpu',
    ...over,
  };
}

function withGpu(vramGb: number, bandwidthGbps = 500, ramGb = 32): HardwareProfile {
  return machine({
    ram: { totalGb: ramGb, freeGb: ramGb / 2, speedMhz: 3200, channels: 2, type: 'DDR4', bandwidthGbps: 51.2, source: 'test' },
    gpus: [{ vendor: 'NVIDIA', name: 'Test GPU', vramGb, dedicated: true, bandwidthGbps, backend: 'cuda' }],
    primaryGpu: { vendor: 'NVIDIA', name: 'Test GPU', vramGb, dedicated: true, bandwidthGbps, backend: 'cuda' },
    totalVramGb: vramGb, backend: 'cuda',
  });
}

// ─── throughput ─────────────────────────────────────────────────────────────

test('throughput rises with bandwidth and falls with model size', () => {
  const slow = throughput({ weightsGb: 4, bandwidthGbps: 50, efficiency: 0.5 });
  const fast = throughput({ weightsGb: 4, bandwidthGbps: 500, efficiency: 0.5 });
  assert.ok(fast > slow, 'more bandwidth must be faster');

  const small = throughput({ weightsGb: 2, bandwidthGbps: 500, efficiency: 0.5 });
  const big = throughput({ weightsGb: 20, bandwidthGbps: 500, efficiency: 0.5 });
  assert.ok(small > big, 'a smaller model must decode faster');
});

test('throughput is finite and never NaN at the degenerate edges', () => {
  // A zero-bandwidth machine is nonsense, but the UI must not print NaN.
  assert.equal(throughput({ weightsGb: 4, bandwidthGbps: 0, efficiency: 0.5 }), 0);
  assert.ok(Number.isFinite(throughput({ weightsGb: 0.001, bandwidthGbps: 1000, efficiency: 0.5 })));
});

// ─── placeModel: the hard gates ─────────────────────────────────────────────

test('a model larger than all memory is UNUSABLE, not merely slow', () => {
  // This is the LTX-2.3 case: 27.5 GB on a 16 GB laptop. It must be excluded,
  // because "offered and broken" costs the user a 27.5 GB download.
  const p = placeModel(machine(), 27.5, { kvCacheGb: 2 });
  assert.equal(p.fits, false);
  assert.equal(p.mode, 'unusable');
  assert.equal(p.score, 0);
});

test('LTX-2.3 fits a 32 GB-class machine but not a 16 GB one', () => {
  const ltx = ROLES.animation.find((m) => m.id === 'ltx-2.3-distilled')!;
  assert.ok(ltx, 'LTX entry must exist');

  const small = placeModel(machine({ ram: { ...machine().ram, totalGb: 16 } }), ltx.weightsGb, { kvCacheGb: ltx.kvCacheGb });
  assert.equal(small.fits, false, '16 GB must not be offered LTX');

  const big = placeModel(withGpu(48, 1000, 64), ltx.weightsGb, { kvCacheGb: ltx.kvCacheGb });
  assert.equal(big.fits, true, 'a 48 GB card must be able to run LTX');
});

test('a fully resident model outranks the same model in hybrid mode', () => {
  // The ordering that makes chooseStack prefer a smaller fully-resident model.
  const resident = placeModel(withGpu(24, 900), 4);
  const hybrid = placeModel(withGpu(6, 400), 10);
  assert.equal(resident.mode, 'full-vram');
  assert.equal(hybrid.mode, 'hybrid');
  assert.ok(resident.score > hybrid.score, 'full VRAM must score above hybrid');
});

test('VRAM_SAFETY headroom is genuinely enforced', () => {
  // Just inside the safety margin fits; just outside does not. If VRAM_SAFETY
  // were ignored, both would fit and this test fails.
  const hw = withGpu(10, 500);
  const inside = placeModel(hw, 10 * VRAM_SAFETY - 0.6, { kvCacheGb: 0.5 });
  const outside = placeModel(hw, 10 * VRAM_SAFETY + 0.1, { kvCacheGb: 0.5 });
  assert.equal(inside.mode, 'full-vram');
  assert.notEqual(outside.mode, 'full-vram');
});

test('Apple unified memory has no hybrid regime', () => {
  // Memory is memory on Apple Silicon — a hybrid split would be meaningless.
  const mac = machine({
    unifiedMemory: true, totalVramGb: 24, backend: 'metal',
    ram: { totalGb: 32, freeGb: 16, speedMhz: 0, channels: 0, type: 'Unified', bandwidthGbps: 400, source: 'test' },
    primaryGpu: { vendor: 'Apple', name: 'M3 Max', vramGb: 24, dedicated: false, unified: true, bandwidthGbps: 400, backend: 'metal' },
  });
  for (const size of [1, 4, 12, 20]) {
    assert.notEqual(placeModel(mac, size).mode, 'hybrid');
  }
});

// ─── GPU bandwidth table ────────────────────────────────────────────────────

test('longest-key-first matching: a longer key is never shadowed by its prefix', () => {
  // Short-first iteration would report the base card's bandwidth for every
  // suffixed variant, under-estimating it and mis-ranking every recommendation.
  //
  // NOTE ON TEST DESIGN: the first version of this test used "4070 Ti" vs
  // "4070" — which CANNOT prove the property, because both legitimately map to
  // 504 GB/s in the real table. The assertion failed with expected 504,
  // actual 504: a correct implementation flunking a test that asserted
  // something untrue. Only pairs whose table values genuinely DIFFER can
  // demonstrate shadowing, so all three below were checked to differ first.
  const pairs: Array<[string, string, string]> = [
    ['NVIDIA GeForce RTX 3070 Ti', '3070 ti', '3070'],          // 608 vs 448
    ['NVIDIA GeForce RTX 4080 SUPER', '4080 super', '4080'],    // 736 vs 717
    ['NVIDIA GeForce RTX 4070 Ti SUPER', '4070 ti super', '4070 ti'], // 672 vs 504
  ];
  for (const [name, longKey, shortKey] of pairs) {
    assert.notEqual(GPU_BANDWIDTH_GBPS[longKey], GPU_BANDWIDTH_GBPS[shortKey],
      `test premise: ${longKey} and ${shortKey} must differ to prove anything`);
    assert.equal(gpuBandwidth(name), GPU_BANDWIDTH_GBPS[longKey],
      `${name} must match the longer key`);
  }
});

test('unknown GPUs fall back by VRAM rather than returning zero', () => {
  // Zero bandwidth would make throughput() return 0 and rank everything equally.
  const bw = gpuBandwidth('Some Unreleased Card 9999', 24);
  assert.ok(bw > 0, 'fallback must be positive');
  assert.ok(gpuBandwidth('Unknown', 24) > gpuBandwidth('Unknown', 6), 'more VRAM implies a bigger card');
});

test('cpuCount never returns zero', () => {
  // os.cpus() returns [] on this Android sandbox and in some containers; zero
  // would break every downstream calculation.
  assert.ok(cpuCount() >= 1);
});

// ─── Stack selection ────────────────────────────────────────────────────────

test('a weak CPU laptop still gets a complete, working stack', () => {
  const { chosen } = chooseStack(machine({ ram: { ...machine().ram, totalGb: 8 } }), registry());
  for (const role of ['plot', 'images', 'diction', 'music']) {
    assert.ok(chosen[role], `role ${role} must be filled even on a weak machine`);
  }
});

test('animation may legitimately resolve to nothing (Ken Burns covers it)', () => {
  // A machine too small for ANY video model must leave the optional role empty
  // rather than crashing or picking something bogus.
  //
  // NOTE ON TEST DESIGN: this first asserted the same for 4 GB RAM and FAILED,
  // because AnimateDiff needs 1.7 + 0.3 = 2.0 GB and 4 GB * RAM_SAFETY = 3.2 GB
  // usable — it genuinely fits. The CODE was right and the test premise was
  // wrong. Measuring the arithmetic (rather than "fixing" placeModel) is what
  // caught it. 2 GB is the size that actually fits nothing.
  const tiny = machine({ ram: { ...machine().ram, totalGb: 2 }, freeDiskGb: 100 });
  const { chosen } = chooseStack(tiny, registry());
  assert.equal(chosen.animation, null, '2 GB fits no animation model at all');
});

test('heavy video models are not proposed for CPU-only machines', () => {
  // The real hazard the previous test was groping toward: *fitting in memory*
  // is not the same as *being usable*. AnimateDiff fits a 4 GB box, but
  // frame-by-frame diffusion with no accelerator runs for hours — the Ken Burns
  // ffmpeg path produces motion in seconds instead. Fit alone is the wrong gate
  // for this role, so `cpuHostile` marks the models it applies to.
  const cpuBox = machine({ ram: { ...machine().ram, totalGb: 16 }, freeDiskGb: 500 });
  assert.equal(cpuBox.backend, 'cpu');
  const { chosen, rejected } = chooseStack(cpuBox, registry());
  assert.equal(chosen.animation, null, 'no diffusion animation without an accelerator');
  assert.ok(
    rejected.some((r) => r.role === 'animation' && /accelerator/i.test(r.why)),
    'the reason must say why, so the UI can explain the greyed-out entry',
  );

  // Control: the SAME model on a GPU machine must be offered. Without this the
  // test above could pass by never selecting animation anywhere.
  const gpuBox = withGpu(12, 600, 32);
  const gpu = chooseStack(gpuBox, registry());
  assert.ok(gpu.chosen.animation, 'a GPU machine must still get an animation model');
});

test('a big machine prefers the studio stack over the lite stack', () => {
  const { chosen } = chooseStack(withGpu(24, 1000, 64), registry());
  assert.equal(chosen.images?.stack, 'studio', 'should pick FLUX.2 over SD 1.5');
  assert.equal(chosen.plot?.stack, 'studio', 'should pick Qwen3 over Qwen2.5');
  assert.equal(chosen.music?.stack, 'studio', 'should pick ACE-Step over MusicGen');
});

test('the disk gate blocks a model that cannot be stored', () => {
  // 3 GB free cannot hold a 4.68 GB download, regardless of memory.
  const cramped = withGpu(24, 1000, 64);
  cramped.freeDiskGb = 3;
  const { chosen, rejected } = chooseStack(cramped, registry());
  assert.ok(rejected.some((r) => /free disk/.test(r.why)), 'a disk rejection must be reported');
  if (chosen.plot) assert.ok(chosen.plot.downloadGb + 2 <= 3, 'any pick must fit the disk');
});

test('unknown free disk is treated as unknown, NOT as zero', () => {
  // null must not disable everything — that would brick machines we merely
  // failed to measure.
  const unknown = withGpu(24, 1000, 64);
  unknown.freeDiskGb = null;
  const { chosen } = chooseStack(unknown, registry());
  assert.ok(chosen.images, 'a null disk reading must not block selection');
});

// ─── Whole-stack validation ─────────────────────────────────────────────────

test('stack peak memory is the LARGEST stage, not the sum', () => {
  // The pipeline is sequential, so summing would reject good stacks on 8 GB
  // machines. If someone makes runner.js concurrent, this assertion should
  // start failing — which is the point.
  const hw = withGpu(12, 600, 32);
  const { chosen } = chooseStack(hw, registry());
  const models = Object.values(chosen).filter(Boolean);
  const fit = stackFits(hw, chosen);
  const sum = models.reduce((a, m) => a + m!.placement.needGb, 0);
  const max = Math.max(...models.map((m) => m!.placement.needGb));
  assert.equal(fit.peakGb, +max.toFixed(2));
  if (models.length > 1) assert.ok(fit.peakGb < sum, 'peak must be below the naive sum');
});

test('reported download total includes mandatory companions', () => {
  // ACE-Step needs its LM stage: quoting 1.35 GB then downloading 3.19 GB
  // would make the disk gate meaningless.
  const ace = ROLES.music.find((m) => m.id === 'acestep-1.5')!;
  const cost = totalCost(ace);
  assert.ok(cost.downloadGb > ace.downloadGb, 'companion bytes must be added');
  assert.ok(cost.downloadGb >= ace.downloadGb + COMPANIONS['acestep-lm'].downloadGb - 0.01);
});

// ─── Tiers and the top-level call ───────────────────────────────────────────

test('no tier blurb promises a model that tier cannot run resident', () => {
  // Found while tracing the user flow: the Tier 5 blurb said "Runs the full
  // Studio stack including LTX-2.3 video", but LTX needs 27.5 + 2.0 = 29.5 GB,
  // so a 24 GB card (the tier's own floor) falls to HYBRID at ~2.9 tok/s. The
  // placement was right; the promise was not. A tier that names a model must be
  // able to hold it at the tier's MINIMUM, not just at its most expensive member.
  const ltx = ROLES.animation.find((m) => m.id === 'ltx-2.3-distilled')!;
  for (const tier of TIERS) {
    if (!/LTX/i.test(tier.blurb)) continue;

    // A blurb may mention LTX to say it is NOT used ("Ken Burns motion instead
    // of LTX video" on Tier 3). That is an honest statement, not a promise —
    // an earlier version of this test flagged it, which was the TEST being too
    // crude rather than the blurb being wrong.
    if (/instead of|rather than|not? LTX/i.test(tier.blurb)) continue;

    const atFloor = placeModel(withGpu(tier.min, 900, tier.min * 4), ltx.weightsGb, { kvCacheGb: ltx.kvCacheGb });
    const qualified = /32 ?GB|spill|slow|needs/i.test(tier.blurb);
    assert.ok(atFloor.mode === 'full-vram' || qualified,
      `tier "${tier.name}" mentions LTX but at its ${tier.min} GB floor the placement is `
      + `"${atFloor.mode}" and the blurb does not qualify the claim`);
  }
});

test('tiers increase monotonically with VRAM', () => {
  const ids = [2, 6, 10, 16, 32].map((v) => tierFor(withGpu(v)).id);
  for (let i = 1; i < ids.length; i++) {
    assert.ok(ids[i] >= ids[i - 1], `tier must not decrease as VRAM grows: ${ids}`);
  }
});

test('advise() returns a coherent, self-explaining report', () => {
  const report = advise(registry(), { hardware: withGpu(16, 700, 32) });
  assert.ok(report.tier.name);
  assert.ok(report.summary.includes(report.tier.name));
  assert.ok(['lite', 'studio', 'mixed', 'none'].includes(report.stack));
  assert.ok(Number.isFinite(report.fit.totalDownloadGb));
  // Every rejection must carry a reason — "why is this greyed out?" has to be
  // answerable from the report alone.
  for (const r of report.rejected) assert.ok(r.why && r.why.length > 3, 'rejection needs a reason');
});

test('advise() never proposes a stack it has just declared unfittable', () => {
  const report = advise(registry(), { hardware: machine({ ram: { ...machine().ram, totalGb: 8 } }) });
  for (const [role, pick] of Object.entries(report.chosen)) {
    if (pick) assert.equal(pick.placement.fits, true, `${role} pick must fit`);
  }
});

// ─── CPU size penalty ───────────────────────────────────────────────────────

test('a weak CPU box is not handed the biggest model that merely fits', () => {
  // REGRESSION TEST for a real defect found by running the advisor against this
  // sandbox's actual hardware: a 7.4 GB, 1-core, CPU-only machine was
  // recommended Qwen3 8B. Memory-wise it fit (5.48 GB needed vs 5.91 usable),
  // but it left 0.43 GB of headroom on a box also running Electron and put an
  // 8B model on one core at ~4 tok/s.
  //
  // Cause: every CPU fit scored an identical 55, so the best-first walk always
  // took the LARGEST fitting model. The fix is a graduated size/pressure
  // penalty plus a fallback that sorts by score instead of taking the first.
  const weak = machine({
    cpu: { model: 'Weak', cores: 1, features: { avx: false, avx2: false, avx512: false, neon: true } },
    ram: { totalGb: 7.4, freeGb: 3, speedMhz: 3200, channels: 2, type: 'DDR4', bandwidthGbps: 51.2, source: 'test' },
    freeDiskGb: 500,
  });
  const { chosen } = chooseStack(weak, registry());

  assert.ok(chosen.plot, 'a planner must still be chosen');
  assert.notEqual(chosen.plot!.id, 'llm-qwen3-8b', '8B must not be picked on a 1-core 7.4 GB box');

  // Headroom must be real, not marginal.
  const usable = 7.4 * 0.80;
  assert.ok(chosen.plot!.placement.needGb < usable * 0.85,
    `chosen planner should leave headroom: needs ${chosen.plot!.placement.needGb} of ${usable.toFixed(2)}`);
});

test('CONTROL: capable machines still get the studio stack', () => {
  // Without this control, the penalty above could be satisfied by an advisor
  // that simply always picks the smallest model — which would be a worse bug
  // than the one it fixed.
  const strong = withGpu(24, 936, 64);
  const { chosen } = chooseStack(strong, registry());
  assert.equal(chosen.plot?.id, 'llm-qwen3-8b', '24 GB VRAM must get the 8B planner');
  assert.equal(chosen.images?.stack, 'studio');
  assert.equal(chosen.animation?.id, 'ltx-2.3-distilled', 'LTX must be offered at 24 GB VRAM');
});

test('recommendations never regress as hardware improves', () => {
  // Monotonicity across the whole ladder. A scoring tweak that accidentally
  // makes a bigger machine choose a smaller model shows up here.
  const ladder = [
    machine({ ram: { ...machine().ram, totalGb: 8 }, cpu: { model: 'c', cores: 4, features: { avx: true, avx2: true, avx512: false, neon: false } } }),
    machine({ ram: { ...machine().ram, totalGb: 32 }, cpu: { model: 'c', cores: 16, features: { avx: true, avx2: true, avx512: false, neon: false } } }),
    withGpu(8, 448, 16),
    withGpu(12, 504, 32),
    withGpu(24, 936, 64),
    withGpu(48, 1008, 128),
  ];
  let prevDownload = -1;
  for (const hw of ladder) {
    const { chosen } = chooseStack(hw, registry());
    const total = Object.values(chosen).filter(Boolean)
      .reduce((a, m) => a + m!.downloadGb, 0);
    assert.ok(total >= prevDownload - 0.01,
      `a more capable machine must not receive a strictly smaller stack (${total} after ${prevDownload})`);
    prevDownload = total;
  }
});

// ─── Registry integrity ─────────────────────────────────────────────────────

test('every registry entry has a verified-shape URL and positive sizes', () => {
  for (const [role, list] of Object.entries(ROLES)) {
    for (const m of list) {
      assert.match(m.url, /^https:\/\/huggingface\.co\/.+\/resolve\/main\/.+/, `${m.id} URL shape`);
      assert.ok(m.weightsGb > 0, `${m.id} weightsGb must be positive`);
      assert.ok(m.downloadGb > 0, `${m.id} downloadGb must be positive`);
      assert.equal(m.role, role, `${m.id} role field must match its bucket`);
    }
  }
});

test('each role lists candidates best-first by descending capability', () => {
  // The advisor takes the FIRST that fits, so a mis-ordered list silently
  // downgrades every machine. Studio entries must precede lite ones.
  for (const [role, list] of Object.entries(ROLES)) {
    const firstLite = list.findIndex((m) => m.stack === 'lite');
    const lastStudio = list.map((m) => m.stack).lastIndexOf('studio');
    if (firstLite !== -1 && lastStudio !== -1) {
      assert.ok(lastStudio < firstLite, `${role}: studio models must come before lite ones`);
    }
  }
});
