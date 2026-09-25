//
// ─── Model stack advisor ────────────────────────────────────────────────────
//
// Turns a hardware profile into a decision: which model fills each role — plot,
// images, animation, diction, music — on THIS machine.
//
// ─── THE PROBLEM ────────────────────────────────────────────────────────────
//
// The app now ships two stacks (see stacks.ts). Without an advisor the user
// faces ~13 models with no way to know which combination their machine holds,
// and the failure mode is expensive and delayed: LTX-2.3 is a MEASURED 27.5 GB
// download that fails at load time on a 16 GB laptop — after the download.
//
// So: measure the machine, then only ever propose what fits.
//
// ─── SCORING (adapted from keplerTR/LocalAI-Advisor, MIT) ───────────────────
//
// Upstream's key insight, kept here: local inference is MEMORY BANDWIDTH BOUND,
// not FLOP bound. Every generated token streams the active weights through the
// memory bus, so:
//
//     tokens/sec ≈ (bandwidth × efficiency) / (active_weights + kv_cache)
//
// That one relation explains why a 4090 (1008 GB/s) is ~20x faster than
// dual-channel DDR4 (51 GB/s) on the same model, and needs no benchmark.
//
// Also taken: Amdahl-style hybrid modelling. When a model half-fits in VRAM,
// runtime is the GPU fraction plus the CPU fraction, and the CPU part dominates
// badly — which is why hybrid scores FAR below a full fit, not slightly below.
//
// ─── DELIBERATE DIVERGENCE FROM UPSTREAM ────────────────────────────────────
//
// 1. Upstream ranks ONE list of chat LLMs. This app fills FIVE ROLES at once
//    and they are not interchangeable — a great image model does not help
//    narration. Selection is per role; the result is a STACK, not a ranking.
//
// 2. Upstream's models are all transformer LLMs where tok/s applies directly.
//    Diffusion models (FLUX, LTX, SD) are iterative denoisers whose cost is
//    seconds/step. The bandwidth relation still predicts their RELATIVE cost so
//    it is used for ranking, but wall-clock estimation stays in capacity.js,
//    which already models steps. Reused rather than duplicated (ponytail r2).
//
// 3. Upstream's tiers are advisory labels; here the memory gate is HARD. A
//    model whose weights cannot fit is never offered, because "offered and
//    broken" is worse than "not offered".

import { profile } from './hardware';
import type { HardwareProfile } from './hardware';

// Fraction of theoretical peak bandwidth real inference achieves. Nobody hits
// 100%: cache misses, kernel launch gaps, synchronisation stalls. Upstream
// measured ~0.55 GPU and 0.45/0.30 CPU with/without AVX2.
//
// These are ESTIMATION coefficients, never correctness gates — wrong here means
// a slightly-off ETA, not a model that fails to load.
export const GPU_EFFICIENCY = 0.55;
export const CPU_EFFICIENCY_AVX2 = 0.45;
export const CPU_EFFICIENCY_BASE = 0.30;

// Fraction of VRAM a model may claim; the rest holds activations, KV cache and
// the driver's working set. Exceeding it means an OOM abort mid-run.
export const VRAM_SAFETY = 0.92;

// Same for system RAM, stricter — the OS, Electron and ffmpeg live here too,
// and swapping turns a slow run into an apparent hang.
export const RAM_SAFETY = 0.80;

export type InferenceMode = 'full-vram' | 'hybrid' | 'cpu' | 'unusable';

export interface Placement {
  mode: InferenceMode; fits: boolean; score: number;
  tokensPerSec: number; needGb: number; label: string;
}

export interface StackModel {
  id: string; stack: 'lite' | 'studio'; role: string; name: string;
  purpose: string; engine: string; file: string; url: string;
  weightsGb: number; downloadGb: number; kvCacheGb?: number;
  heavy?: boolean; note?: string; companions?: string[];
  /**
   * Runs so badly without an accelerator that offering it is a disservice,
   * even when it fits in memory.
   *
   * WHY THIS IS SEPARATE FROM `heavy`: `heavy` is about SIZE and is already
   * handled by the memory gate. This is about THROUGHPUT — frame-by-frame video
   * diffusion on CPU takes hours per clip, while the Ken Burns ffmpeg fallback
   * produces motion in seconds. A model can comfortably fit and still be the
   * wrong answer, which the memory gate alone cannot express.
   */
  cpuHostile?: boolean;
  /** Non-permissive weights, surfaced in the UI rather than left in a comment. */
  license?: string;
  /**
   * Credit string a licence obliges the app to display (Qwen clause 6.b).
   * Travels with the model so the UI cannot silently drop it.
   */
  attribution?: string;
  /**
   * Win the role whenever this model FITS, overriding the score sort.
   *
   * WHY THIS EXISTS: `chooseStack` falls back to the highest-scoring survivor,
   * and CPU placement scores a big model below a small one even when both fit
   * comfortably — Qwen-Image-2.1 scored 27/47 against FLUX.2 Klein's 55 on
   * 16/32 GB CPU boxes while reporting fits=true on both. Declaration order
   * could not express "this is the default", because the fallback sorts rather
   * than taking the first. Without this flag, promoting a default is invisible.
   *
   * Deliberately NOT a score override: the memory, disk and cpuHostile gates
   * must still be able to decline it, so a machine that cannot hold the model
   * falls through to the next candidate instead of being handed something
   * unusable.
   */
  preferred?: boolean;
}

export interface Registry {
  roles: Record<string, StackModel[]>;
  optionalRoles: string[];
}

export interface Choice extends StackModel { placement: Placement; diskOk: boolean }

/**
 * Predict decode throughput in tokens/sec.
 *
 * Exported because it is the most testable piece: its PROPERTIES
 * (monotonic in bandwidth, inversely monotonic in size) are asserted rather
 * than any constant, since the constants are tuned estimates and a test pinned
 * to "42 tok/s" would break on every retune while proving nothing.
 */
export function throughput(o: {
  weightsGb: number; bandwidthGbps: number; efficiency: number; kvCacheGb?: number;
}): number {
  const working = o.weightsGb + (o.kvCacheGb ?? 0.5);
  if (working <= 0 || o.bandwidthGbps <= 0) return 0;
  return (o.bandwidthGbps * o.efficiency) / working;
}

/**
 * Decide where one model runs on one machine.
 *
 * The modes are genuinely different regimes, not points on a continuum:
 *   full-vram — resident on the accelerator. Fast.
 *   hybrid    — split GPU/CPU; Amdahl says the CPU share dominates.
 *   cpu       — no accelerator.
 *   unusable  — does not fit anywhere. HARD EXCLUSION.
 */
export function placeModel(
  hw: HardwareProfile, weightsGb: number, opts: { kvCacheGb?: number } = {},
): Placement {
  const kvCacheGb = opts.kvCacheGb ?? 0.5;
  const vram = hw.totalVramGb || 0;
  const ramUsable = hw.ram.totalGb * RAM_SAFETY;
  const gpuBw = hw.primaryGpu?.bandwidthGbps || 0;
  const ramBw = hw.ram.bandwidthGbps || 25;
  const cpuEff = hw.cpu.features.avx2 || hw.cpu.features.neon
    ? CPU_EFFICIENCY_AVX2 : CPU_EFFICIENCY_BASE;
  const need = weightsGb + kvCacheGb;

  // Apple unified memory: no PCIe boundary, so there is NO hybrid regime —
  // memory is memory. Treating it as GPU-resident is correct because Metal
  // reaches the same bandwidth the CPU does.
  if (hw.unifiedMemory) {
    const budget = hw.ram.totalGb * 0.75;
    if (need <= budget) {
      const headroom = budget - need;
      return {
        mode: 'full-vram', fits: true,
        score: Math.min(100, 90 + (headroom >= 8 ? 10 : headroom >= 3 ? 6 : 2)),
        tokensPerSec: +throughput({ weightsGb, bandwidthGbps: gpuBw, efficiency: GPU_EFFICIENCY, kvCacheGb }).toFixed(1),
        needGb: +need.toFixed(2), label: 'Unified memory (Metal)',
      };
    }
    return {
      mode: 'unusable', fits: false, score: 0, tokensPerSec: 0, needGb: +need.toFixed(2),
      label: `Needs ${need.toFixed(1)} GB, budget ${budget.toFixed(1)} GB`,
    };
  }

  // Discrete GPU, fully resident.
  if (vram > 0 && need <= vram * VRAM_SAFETY) {
    const headroom = vram * VRAM_SAFETY - need;
    return {
      mode: 'full-vram', fits: true,
      score: Math.min(100, 90 + (headroom >= 6 ? 10 : headroom >= 2 ? 6 : 2)),
      tokensPerSec: +throughput({ weightsGb, bandwidthGbps: gpuBw, efficiency: GPU_EFFICIENCY, kvCacheGb }).toFixed(1),
      needGb: +need.toFixed(2), label: '100% GPU VRAM',
    };
  }

  // Hybrid. Requires a GPU holding a meaningful share — below ~45% the PCIe
  // round-trips cost more than they save and pure CPU is faster, hence a
  // threshold rather than a smooth fallback.
  if (vram > 0 && need <= ramUsable && vram >= need * 0.45) {
    const gpuFraction = Math.min(1, (vram * VRAM_SAFETY) / need);
    const tGpu = (gpuFraction * weightsGb) / (gpuBw * GPU_EFFICIENCY || 1);
    const tCpu = ((1 - gpuFraction) * weightsGb) / (ramBw * cpuEff || 1);
    const tps = 1 / (tGpu + tCpu + 0.002);       // +2ms PCIe latency per token
    return {
      mode: 'hybrid', fits: true, score: 70,
      tokensPerSec: +Math.max(0.1, tps).toFixed(1), needGb: +need.toFixed(2),
      label: `Hybrid — ${Math.round(gpuFraction * 100)}% on GPU`,
    };
  }

  // Pure CPU.
  if (need <= ramUsable) {
    const base = hw.cpu.features.avx2 || hw.cpu.features.neon ? 55 : 40;

    // SIZE PENALTY — CPU only.
    //
    // Found by running the advisor against real hardware: a 7.4 GB, 1-core
    // CPU-only box was recommended Qwen3 **8B**. The memory check was right
    // (5.48 GB needed vs 5.91 usable) but the ADVICE was bad — it left 0.43 GB
    // of headroom on a machine also running Electron, and put an 8B model on a
    // single core at ~4 tok/s.
    //
    // The cause: every CPU fit scored an identical 55, so `chooseStack`'s
    // best-first walk always took the LARGEST model that fit. On a GPU the
    // headroom term already differentiates candidates; on CPU nothing did.
    //
    // Two independent penalties, because they are different failure modes:
    //   * consuming most of usable RAM (thrash/OOM risk under UI load)
    //   * being large in absolute terms with few cores (unbearably slow)
    // Both are graduated rather than cliff-edged so a slightly-too-big model
    // loses to a smaller one without being excluded outright.
    const pressure = need / ramUsable;                       // 0..1
    const pressurePenalty = pressure > 0.85 ? 20 : pressure > 0.65 ? 10 : 0;
    const perCoreGb = weightsGb / Math.max(1, hw.cpu.cores);
    const sizePenalty = perCoreGb > 2 ? 15 : perCoreGb > 1 ? 8 : 0;

    return {
      mode: 'cpu', fits: true,
      score: Math.max(10, base - pressurePenalty - sizePenalty),
      tokensPerSec: +throughput({ weightsGb, bandwidthGbps: ramBw, efficiency: cpuEff, kvCacheGb }).toFixed(1),
      needGb: +need.toFixed(2),
      label: hw.cpu.features.avx2 ? 'CPU (AVX2)' : hw.cpu.features.neon ? 'CPU (NEON)' : 'CPU (baseline)',
    };
  }

  // HARD EXCLUSION — never surfaced as a choice.
  return {
    mode: 'unusable', fits: false, score: 0, tokensPerSec: 0, needGb: +need.toFixed(2),
    label: `Needs ${need.toFixed(1)} GB, only ${ramUsable.toFixed(1)} GB usable`,
  };
}

export interface Tier { id: number; min: number; name: string; blurb: string }

// Coarse labels adapted from upstream's five tiers. Their ONLY job is to
// explain the decision in one line — the actual choice is made per model, never
// by tier. Keeping tiers advisory avoids upstream's trap where a machine one GB
// under a boundary takes a whole-tier downgrade it does not deserve.
export const TIERS: Tier[] = [
  // The blurb deliberately does NOT promise LTX video at 24 GB. Measured: LTX
  // needs 27.5 + 2.0 = 29.5 GB, so on a 24 GB card it falls to HYBRID (75% on
  // GPU, the rest streamed over PCIe) at ~2.9 tok/s. The placement is correct,
  // but telling a 4090 owner they will "run LTX-2.3 video" sets an expectation
  // the hardware does not meet — it needs a 32 GB-class card to stay resident,
  // which is exactly what the registry entry's own note says.
  { id: 5, min: 24, name: 'Monster AI Workstation', blurb: 'Runs the full Studio stack at maximum quality. LTX-2.3 video needs 32 GB+ to stay in VRAM; below that it spills to system RAM and is slow.' },
  { id: 4, min: 12, name: 'High-End AI Setup', blurb: 'Runs the Studio stack — FLUX.2 Klein, Qwen3 8B, ACE-Step 1.5 — at high speed.' },
  { id: 3, min: 8, name: 'Balanced AI (Sweet Spot)', blurb: 'Runs the Studio stack at 4-bit with Ken Burns motion instead of LTX video.' },
  { id: 2, min: 4, name: 'Entry-to-Mid AI', blurb: 'Runs the Lite stack fully, plus selected Studio models in hybrid mode.' },
  { id: 1, min: 0, name: 'Basic CPU', blurb: 'Runs the Lite stack on CPU. Expect minutes, not seconds, per image.' },
];

/**
 * Classify a machine. Keyed on VRAM where a dedicated GPU exists, else on
 * blended AI memory — a 64 GB CPU box genuinely can run big models, just
 * slowly, and calling it Tier 1 next to an 8 GB netbook would be wrong.
 */
export function tierFor(hw: HardwareProfile): Tier {
  const key = hw.totalVramGb > 0 ? hw.totalVramGb : hw.aiMemoryGb / 2;
  return TIERS.find((t) => key >= t.min) || TIERS[TIERS.length - 1];
}

/**
 * Choose the best model for each role.
 *
 * ALGORITHM, and why greedy rather than a joint optimiser:
 *
 *   1. Each role's candidates are ordered BEST FIRST — declared by a human in
 *      stacks.ts, not inferred from parameter count (bigger is not reliably
 *      better across architectures: FLUX.2 Klein 4B beats SD 1.5 decisively).
 *   2. Take the first that fits AND clears `minScore`. A model that only runs
 *      in degraded hybrid mode should lose to a smaller one that runs fully
 *      resident — for diffusion work a 5x speed gap beats a modest quality edge.
 *   3. If nothing clears it, fall back to the best that merely FITS, so a weak
 *      machine still gets a working stack rather than an empty one.
 *   4. Optional roles (animation) may resolve to nothing: Ken Burns already
 *      covers motion without a video model.
 *
 * Greedy is correct because the roles run SEQUENTIALLY in the pipeline
 * (script → image → motion → voice → music), so only one large model is
 * resident at a time. Peak memory is the max, not the sum — see stackFits.
 */
export function chooseStack(
  hw: HardwareProfile, registry: Registry, opts: { minScore?: number } = {},
): { chosen: Record<string, Choice | null>; rejected: Array<{ role: string; id: string; why: string }> } {
  const minScore = opts.minScore ?? 70;
  const chosen: Record<string, Choice | null> = {};
  const rejected: Array<{ role: string; id: string; why: string }> = [];

  for (const [role, candidates] of Object.entries(registry.roles)) {
    let pick: Choice | null = null;
    const evaluated: Choice[] = [];

    for (const cand of candidates) {
      const placement = placeModel(hw, cand.weightsGb, { kvCacheGb: cand.kvCacheGb });

      // Disk gate. null means UNKNOWN and must NOT be read as zero — zero would
      // disable every model on a machine we merely failed to measure.
      const diskOk = hw.freeDiskGb == null || hw.freeDiskGb >= cand.downloadGb + 2;

      const entry: Choice = { ...cand, placement, diskOk };
      evaluated.push(entry);

      // Throughput gate, distinct from the memory gate above. A cpuHostile
      // model on a machine with no accelerator would technically load and then
      // run for hours; the pipeline has a fast fallback for exactly this case,
      // so decline rather than offer a trap. Checked BEFORE `fits` so the
      // reported reason names the real cause instead of a memory figure.
      if (cand.cpuHostile && hw.backend === 'cpu') {
        rejected.push({
          role, id: cand.id,
          why: 'Needs a GPU accelerator — unusably slow on CPU (Ken Burns is used instead)',
        });
        continue;
      }

      if (!placement.fits) { rejected.push({ role, id: cand.id, why: placement.label }); continue; }
      if (!diskOk) {
        rejected.push({ role, id: cand.id, why: `Needs ${cand.downloadGb} GB free disk, has ${hw.freeDiskGb}` });
        continue;
      }
      if (placement.score >= minScore && !pick) pick = entry;
    }

    // Survivors of every hard gate: memory, disk, and the CPU-throughput veto.
    //
    // The cpuHostile exclusion is REPEATED here (it also runs in the loop
    // above). Without it the fallback re-admits exactly what the gate already
    // declined, silently undoing it — the classic "second lookup forgets the
    // first one's rules" bug.
    const viable = evaluated.filter((e) => e.placement.fits && e.diskOk
      && !(e.cpuHostile && hw.backend === 'cpu'));

    // A `preferred` model wins its role whenever it is VIABLE — it is the
    // declared default, not merely the highest scorer.
    //
    // 🔴 This is checked against `viable`, NOT against every candidate, and
    // that distinction is the whole safety property. Qwen-Image-2.1 needs
    // ~11.11 GB; an 8 GB box must fall through to a lighter image model rather
    // than be handed the default it cannot load. Preferring before filtering
    // would have produced exactly the "recommends a model that cannot run"
    // failure the memory gate exists to prevent.
    //
    // It also overrides the minScore pass above, deliberately: on a CPU box
    // Qwen scores 27–47 against Klein's 55 while both fit, and score is a
    // throughput proxy, not a quality ranking. Choosing the slower-but-better
    // model is the product decision; the gates still decide whether it can run
    // at all.
    const preferred = viable.find((e) => e.preferred);
    if (preferred) pick = preferred;

    // Relaxed second pass — better a slow stack than no stack.
    //
    // Takes the HIGHEST-SCORING survivor, not the first. Declaration order is
    // quality-first, so `find` would hand back the biggest model that merely
    // fits — which is how a 1-core 7.4 GB box got recommended Qwen3 8B. Once
    // the CPU penalties above differentiate the scores, sorting is what
    // actually acts on them.
    if (!pick) {
      pick = viable.sort((a, b) => b.placement.score - a.placement.score)[0] || null;
    }
    chosen[role] = pick;
  }

  return { chosen, rejected };
}

/**
 * Verify the whole stack is simultaneously satisfiable.
 *
 * Peak memory is the LARGEST single model, not the sum, because the pipeline is
 * sequential and each stage unloads before the next starts. Pessimism here
 * would reject good stacks on 8 GB machines; optimism would OOM mid-run. The
 * sequential behaviour is a real property of runner.js, so `max` is correct —
 * and it is asserted by a test so a future move to concurrent execution cannot
 * silently invalidate this reasoning.
 */
export function stackFits(hw: HardwareProfile, chosen: Record<string, Choice | null>): {
  ok: boolean; peakGb: number; budgetGb: number; totalDownloadGb: number; reason: string;
} {
  const models = Object.values(chosen).filter(Boolean) as Choice[];
  if (!models.length) {
    return { ok: false, peakGb: 0, budgetGb: 0, totalDownloadGb: 0, reason: 'No models selected' };
  }

  const peakGb = Math.max(...models.map((m) => m.placement.needGb));
  const budget = hw.unifiedMemory
    ? hw.ram.totalGb * 0.75
    : (hw.totalVramGb > 0
      ? Math.max(hw.totalVramGb * VRAM_SAFETY, hw.ram.totalGb * RAM_SAFETY)
      : hw.ram.totalGb * RAM_SAFETY);

  return {
    ok: peakGb <= budget,
    peakGb: +peakGb.toFixed(2),
    budgetGb: +budget.toFixed(2),
    totalDownloadGb: +models.reduce((a, m) => a + m.downloadGb, 0).toFixed(2),
    reason: peakGb <= budget
      ? 'Sequential pipeline — peak is the largest single stage'
      : `Largest stage needs ${peakGb.toFixed(1)} GB, budget ${budget.toFixed(1)} GB`,
  };
}

/**
 * Full startup advisory — what the app calls on launch.
 *
 * Returns everything the UI needs to explain itself: tier, chosen stack, what
 * was rejected AND WHY, and the total download. Surfacing rejections matters:
 * "why is LTX greyed out?" should be answerable without reading source.
 */
export function advise(registry: Registry, opts: {
  hardware?: HardwareProfile; modelsDir?: string; minScore?: number;
} = {}) {
  const hw = opts.hardware || profile(opts.modelsDir);
  const tier = tierFor(hw);
  const { chosen, rejected } = chooseStack(hw, registry, opts);
  const fit = stackFits(hw, chosen);

  // Descriptive only — selection is per role and may legitimately mix stacks.
  const picked = Object.values(chosen).filter(Boolean) as Choice[];
  const studioCount = picked.filter((m) => m.stack === 'studio').length;
  const stack = !picked.length ? 'none'
    : studioCount === picked.length ? 'studio'
      : studioCount === 0 ? 'lite' : 'mixed';

  return {
    hardware: hw, tier, stack, chosen, rejected, fit,
    summary: `${tier.name} — ${stack} stack, ${picked.length} model${picked.length === 1 ? '' : 's'}, ${fit.totalDownloadGb} GB download`,
  };
}
