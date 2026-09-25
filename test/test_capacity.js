'use strict';
// Unit tests for ai/capacity.js — generation-time estimation.
// Run: npm run test:unit   (node --test 'test/test_*.js')
//
// These assert PROPERTIES (monotonicity, bounds, ordering), not exact second
// counts. The cost constants are tuned by measurement and will change; a test
// pinned to "24 seconds" would break on every retune while proving nothing.
// What must never break is the shape of the answer.

const { test } = require('node:test');
const assert = require('node:assert');
const C = require('../ai/capacity');

// ── stepsFor ───────────────────────────────────────────────────────────────

test('quality tiers are strictly ordered', () => {
  // If quality did not cost more steps than fast, the setting would be a lie.
  for (const mode of ['image', 'movie']) {
    const fast = C.stepsFor(mode, 'fast');
    const bal = C.stepsFor(mode, 'balanced');
    const qual = C.stepsFor(mode, 'quality');
    assert.ok(fast < bal, `${mode}: fast must be cheaper than balanced`);
    assert.ok(bal < qual, `${mode}: balanced must be cheaper than quality`);
  }
});

test('a movie frame uses fewer steps than a standalone image', () => {
  // A movie needs many frames, so per-frame cost must be lower or a short
  // clip would cost more than the whole time budget.
  for (const q of ['fast', 'balanced', 'quality']) {
    assert.ok(C.stepsFor('movie', q) < C.stepsFor('image', q), `quality=${q}`);
  }
});

test('an unknown quality falls back to balanced rather than crashing', () => {
  // Quality comes from persisted UI state; an old or hand-edited value must
  // not take the app down.
  assert.strictEqual(C.stepsFor('image', 'nonsense'), C.stepsFor('image', 'balanced'));
  assert.strictEqual(C.stepsFor('image', undefined), C.stepsFor('image', 'balanced'));
});

// ── estimateSeconds ────────────────────────────────────────────────────────

test('estimate grows with requested output length', () => {
  // The slider promises "longer costs more". If this were flat the estimate
  // would be actively misleading.
  const short = C.estimateSeconds({ mode: 'movie', outputSec: 5 });
  const long = C.estimateSeconds({ mode: 'movie', outputSec: 60 });
  assert.ok(long > short, `60s (${long}) must cost more than 5s (${short})`);
});

test('estimate grows with quality', () => {
  const fast = C.estimateSeconds({ mode: 'movie', outputSec: 20, quality: 'fast' });
  const qual = C.estimateSeconds({ mode: 'movie', outputSec: 20, quality: 'quality' });
  assert.ok(qual > fast, `quality (${qual}) must cost more than fast (${fast})`);
});

test('ken burns is cheaper than frame-by-frame motion', () => {
  // This is the entire reason ken burns remains the fallback path: it is an
  // ffmpeg pan/zoom over a still, not real diffusion per frame.
  const kb = C.estimateSeconds({ mode: 'movie', outputSec: 20, motion: 'kenburns' });
  const real = C.estimateSeconds({ mode: 'movie', outputSec: 20, motion: 'diffusion' });
  assert.ok(kb < real, `kenburns (${kb}) must be cheaper than diffusion (${real})`);
});

test('disabling steps lowers the estimate', () => {
  const all = C.estimateSeconds({ mode: 'movie', outputSec: 20 });
  const fewer = C.estimateSeconds({ mode: 'movie', outputSec: 20, steps: ['plan', 'image'] });
  assert.ok(fewer < all, 'a subset of steps must cost less than all of them');
});

test('an unknown step name is ignored, not fatal', () => {
  // steps[] comes from UI checkboxes; a renamed step must not throw.
  assert.doesNotThrow(() => C.estimateSeconds({ mode: 'movie', steps: ['plan', 'nosuchstep'] }));
});

test('every estimate is a non-negative finite integer', () => {
  // The value is rendered directly into the UI — NaN or Infinity would show
  // up as "NaN seconds" next to the run button.
  for (const mode of ['image', 'movie', 'video']) {
    for (const outputSec of [5, 10, 30, 60]) {
      const v = C.estimateSeconds({ mode, outputSec });
      assert.ok(Number.isFinite(v), `${mode}/${outputSec}: not finite`);
      assert.ok(Number.isInteger(v), `${mode}/${outputSec}: not an integer`);
      assert.ok(v >= 0, `${mode}/${outputSec}: negative`);
    }
  }
});

test('an unknown mode yields 0 rather than NaN', () => {
  assert.strictEqual(C.estimateSeconds({ mode: 'nosuchmode', outputSec: 10 }), 0);
});

// ── recommendedMaxSeconds ──────────────────────────────────────────────────

test('recommendation stays inside the slider bounds', () => {
  // It feeds a slider with a fixed range; anything outside is unselectable.
  for (const quality of ['fast', 'balanced', 'quality']) {
    const rec = C.recommendedMaxSeconds({ mode: 'movie', quality });
    assert.ok(rec >= C.MIN_OUTPUT_SECONDS, `${quality}: below min`);
    assert.ok(rec <= C.MAX_OUTPUT_SECONDS, `${quality}: above max`);
  }
});

test('the recommendation respects the time budget when it can', () => {
  const rec = C.recommendedMaxSeconds({ mode: 'movie' });
  const cost = C.estimateSeconds({ mode: 'movie', outputSec: rec });
  // At the floor the budget may be unmeetable on a slow machine — that is
  // allowed, and the recommendation clamps to the minimum rather than
  // returning something unselectable.
  if (rec > C.MIN_OUTPUT_SECONDS) {
    assert.ok(cost <= C.TARGET_RUN_SECONDS,
      `recommended ${rec}s costs ${cost}s, over the ${C.TARGET_RUN_SECONDS}s budget`);
  }
});

test('a slower configuration never recommends MORE time', () => {
  // Monotonicity: raising quality cannot increase what fits in a fixed budget.
  const fast = C.recommendedMaxSeconds({ mode: 'movie', quality: 'fast' });
  const qual = C.recommendedMaxSeconds({ mode: 'movie', quality: 'quality' });
  assert.ok(qual <= fast, `quality (${qual}) must not exceed fast (${fast})`);
});

// ── humanDuration ──────────────────────────────────────────────────────────

test('humanDuration renders without NaN for a wide range', () => {
  for (const s of [0, 1, 59, 60, 61, 3599, 3600, 7325]) {
    const out = C.humanDuration(s);
    assert.strictEqual(typeof out, 'string');
    assert.ok(out.length > 0, `${s}: empty`);
    assert.ok(!/NaN|undefined/.test(out), `${s}: rendered "${out}"`);
  }
});

// ── probe ──────────────────────────────────────────────────────────────────

test('probe reports a usable machine description', () => {
  const p = C.probe();
  assert.ok(p.cores > 0, 'cores must be positive');
  assert.ok(p.totalMemGb > 0, 'memory must be positive');
  assert.ok(p.accelerator && typeof p.accelerator.kind === 'string');
  assert.ok(typeof p.accelerator.gpu === 'boolean');
});

test('core count never reports 0, even where os.cpus() is empty', () => {
  // REGRESSION: os.cpus() returns an EMPTY array on this Android sandbox, and
  // does the same in some containers and restricted VMs. Every call site then
  // produced 0 — the UI read "CPU (0 cores)" and any per-core scaling
  // collapsed to nothing. A conservative 1 only slows an estimate; 0 breaks
  // the arithmetic that consumes it.
  const p = C.probe();
  assert.ok(p.cores >= 1, `cores was ${p.cores}`);
  assert.ok(!/\(0 cores\)/.test(p.accelerator.label), `label read "${p.accelerator.label}"`);
});

test('probe is cached, so repeated UI reads do not re-shell out', () => {
  // detectAccelerator() runs nvidia-smi; calling that on every slider move
  // would spawn a process per frame.
  assert.strictEqual(C.probe(), C.probe(), 'must return the identical object');
});
