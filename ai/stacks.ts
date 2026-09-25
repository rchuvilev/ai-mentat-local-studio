//
// ─── Model stack registry ───────────────────────────────────────────────────
//
// The catalogue the advisor selects from. Two stacks, five roles.
//
// ─── WHY TWO STACKS ─────────────────────────────────────────────────────────
//
// The original ('lite') set was chosen so the app would run at all on a
// CPU-only laptop: SD 1.5, Qwen2.5 3B, MusicGen Small. That constraint produced
// a modest ceiling — SD 1.5 is a 2022 model and MusicGen Small is audibly weak.
//
// The 'studio' stack is the requested modern set for machines that can hold it:
//
//     Plot       Qwen 3 4B / 8B
//     Images     FLUX.2 Klein 4B
//     Animation  LTX-2.3            ("when the laptop has enough memory")
//     Diction    Kokoro-82M         (unchanged — already best in class)
//     Music      ACE-Step 1.5
//     Assembly   FFmpeg             (unchanged, not a model)
//
// Both stay installed and selectable. The advisor picks per ROLE, so a mixed
// result is normal and correct: a 12 GB machine may take FLUX.2 Klein for
// images while keeping Ken Burns for motion.
//
// ─── EVERY URL HERE WAS VERIFIED, AND HOW ───────────────────────────────────
//
// Each `url` was checked with a ranged GET (`curl -r 0-255 -L`) returning
// **206 Partial Content**. That is only meaningful against controls, so it ran
// alongside two negatives:
//
//     bogus filename in a real repo  -> 404
//     nonexistent org                -> 401
//     real file                      -> 206
//
// This matters: an earlier pass returned **429 (rate limited)** for the negative
// control, which would have made every result meaningless — a 429 proves
// nothing about existence. Checks were re-run paced at 5s until the controls
// discriminated correctly.
//
// `approxBytes` / `downloadGb` are MEASURED, from the `Content-Range` total of
// that same request. They gate disk and memory, so guessed numbers would
// produce a recommender that confidently proposes models the machine cannot
// hold.
//
// ─── A CORRECTION WORTH RECORDING ───────────────────────────────────────────
//
// The requested stack named "FLUX.2 Klein 4B", "LTX-2.3" and "ACE-Step 1.5". An
// exact-id probe reported FLUX.2-klein and ACE-Step-v1.5-3.5B as NOT FOUND, and
// concluding "not released yet" would have been WRONG. They exist under
// different ids:
//
//     FLUX.2 Klein 4B -> black-forest-labs/FLUX.2-klein-4B
//                        (GGUF: unsloth/FLUX.2-klein-4B-GGUF)
//     ACE-Step 1.5    -> ACE-Step/Ace-Step1.5
//                        (GGUF: Serveurperso/ACE-Step-1.5-GGUF)
//     LTX-2.3         -> Lightricks/LTX-2.3  (fp8: Lightricks/LTX-2.3-fp8)
//
// A keyword search found them immediately. A negative from an exact-id probe
// means "that id is wrong", not "that model does not exist" — the search is the
// control distinguishing the two.

import type { StackModel } from './advisor';

export interface Companion {
  id: string; kind: 'companion'; name: string; purpose: string; engine: string;
  file: string; url: string; approxBytes: number; weightsGb: number; downloadGb: number;
  optionalUntilVerified?: boolean;
}

// ─── Licence attribution ────────────────────────────────────────────────────
//
// Qwen RESEARCH LICENSE clause 6.b: "you shall prominently display 'Built with
// Qwen' or 'Improved using Qwen' in the related product documentation."
//
// This is the ONLY clause the app can breach. Clause 3 (Redistribution) —
// which carries the heavy conditions: ship a copy of the Agreement, mark
// modified files, include a Notice file — never triggers, because the repo
// bundles ZERO weights (measured: 0 *.gguf / *.safetensors outside
// node_modules) and `ai/download.js` fetches every model from HuggingFace at
// runtime. The app is a client, not a distributor.
//
// A tooltip on a licence pill is not "prominent display", so the notice is a
// first-class field that travels to the UI, exactly like `license` does.
export const ATTRIBUTION: Record<string, { notice: string; license: string; url: string }> = {
  qwen: {
    notice: 'Built with Qwen',
    license: 'Qwen Research License — research / non-commercial use only',
    url: 'https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE',
  },
};

// Order within each role is BEST FIRST, declared deliberately. The advisor takes
// the first that fits, so this ordering IS the quality ranking — not inferred
// from parameter count, because bigger is not reliably better across
// architectures.
//
// Field meanings:
//   weightsGb   resident memory when loaded; drives the memory gate.
//   downloadGb  bytes over the network; drives the disk gate.
//   kvCacheGb   attention working set. Meaningful for autoregressive models;
//               diffusion models get a small activation allowance instead.
export const ROLES: Record<string, StackModel[]> = {
  // ─── PLOT: prompt -> scene-by-scene script ────────────────────────────────
  plot: [
    {
      id: 'llm-qwen3-8b', stack: 'studio', role: 'plot',
      name: 'Qwen 3 8B (Q4_K_M)',
      purpose: 'Best script quality — richer scene structure, stronger instruction following',
      engine: 'llm',
      file: 'qwen3-8b-q4_k_m.gguf',
      url: 'https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf',
      weightsGb: 4.68, downloadGb: 4.68, kvCacheGb: 0.8,     // measured 5027783488 B
    },
    {
      id: 'llm-qwen3-4b', stack: 'studio', role: 'plot',
      name: 'Qwen 3 4B (Q4_K_M)',
      purpose: 'Modern planner that fits comfortably alongside an image model',
      engine: 'llm',
      file: 'qwen3-4b-q4_k_m.gguf',
      url: 'https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf',
      weightsGb: 2.33, downloadGb: 2.33, kvCacheGb: 0.5,     // measured 2497280256 B
    },
    {
      id: 'llm-planner', stack: 'lite', role: 'plot',
      name: 'Qwen2.5 3B Instruct (Q4_K_M)',
      purpose: 'Original planner — smallest usable script writer',
      engine: 'llm',
      file: 'qwen2.5-3b-instruct-q4_k_m.gguf',
      url: 'https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf',
      weightsGb: 2.0, downloadGb: 2.0, kvCacheGb: 0.4,
    },
  ],

  // ─── IMAGES ───────────────────────────────────────────────────────────────
  images: [
    {
      // Qwen-Image-2.1 — the heaviest and most capable image path.
      //
      // WHY IT IS NOT THE DEFAULT, despite being better at prompt adherence
      // and text rendering: it costs 9.9 GB against FLUX.2 Klein's 2.85 GB,
      // because its text encoder is Qwen3-VL-8B (5.03 GB) rather than a small
      // CLIP.
      //
      // ─── NOW THE DEFAULT (2026-09-24) ───────────────────────────────────
      //
      // The app is a FREE, non-monetised Electron project. The Qwen RESEARCH
      // LICENSE defines Non-Commercial as "research or evaluation purposes
      // only" (clause 1.i) and only requires a separate licence for commercial
      // use (clause 2.b) — so the sole reason this was opt-in has gone.
      //
      // 🔴 MAKING IT THE DEFAULT IS NOT A REORDER. It was ALREADY declared
      // first, and already reported fits=true on a 16 GB CPU box (need
      // 11.11 GB). It still lost, because `chooseStack` falls back to the
      // HIGHEST-SCORING survivor and CPU placement scores it 27 (16 GB) /
      // 47 (32 GB) against Klein's 55. `preferred` below is what actually
      // decides it; reordering alone would have changed nothing while looking
      // like it worked.
      //
      // WHAT IT UNIQUELY BUYS: a 64-channel RGBA VAE with NATIVE TRANSPARENCY.
      // Klein cannot produce an alpha channel at all — this is real
      // transparent output, not background removal after the fact.
      //
      // ─── WHY THE "UNCENSORED" REPO, AND WHAT IT IS NOT ──────────────────
      //
      // Switched on explicit instruction. Recording the measurement so nobody
      // re-litigates it from the repo name: this is a RE-QUANTIZATION of the
      // stock weights, NOT a finetune. Comparing this repo's own `main` (UC)
      // and `base` branches tensor-by-tensor at each file's own data offset:
      //
      //     297 vs 297 tensors, identical shapes/types, offset delta {0}
      //     BF16 (unquantized passthrough) tensors ... identical 4/4
      //     Q4_K (quantized) tensors ................ differ     2/2
      //
      // A finetune alters the underlying weights, so the BF16 passthrough
      // tensors would differ too. They do not. The card agrees without meaning
      // to — "Source model: Qwen/Qwen-Image-2.1, Conversion: sd.cpp" — and
      // contains no training language at all. "Uncensored" describes the
      // absence of a PIPELINE-level filter that a bare GGUF never had.
      // Cost of the swap: +407 MB (4604558112 vs 4197494816 B).
      //
      // Engine support landed in stable-diffusion.cpp on 2026-09-20 (day zero
      // with the model). Sizes below are MEASURED from Content-Range (206),
      // against a 404 control on a fabricated filename in the same repo.
      id: 'qwen-image-2.1', stack: 'studio', role: 'images',
      name: 'Qwen-Image-2.1 Uncensored (Q4_K_M)',
      purpose: 'Best prompt adherence and text rendering, plus native transparent (RGBA) output',
      engine: 'sdcpp',
      // The companions stay on Comfy-Org / Qwen GGUF. The UC repo also ships
      // ComfyUI-shaped companions, but its int8 text encoder is 8.71 GiB
      // against the 4.68 GiB GGUF used here — adopting them would nearly
      // double text-encoder memory for no quality gain.
      file: 'qwen-image-2.1-uc-q4_k_m.gguf',
      url: 'https://huggingface.co/abenzerps/Qwen-Image-2.1-Uncensored-GGUF/resolve/main/qwen-image-2.1-UC-Q4_K_M.gguf',
      weightsGb: 4.29, downloadGb: 4.29, kvCacheGb: 1.2,   // measured 4604558112 B
      companions: ['qwen-image-vae', 'qwen-image-text-encoder'],
      license: 'Qwen Research License — non-commercial use only',
      attribution: ATTRIBUTION.qwen.notice,
      // Chosen for its role whenever it fits, overriding the score sort.
      preferred: true,
    },
    {
      id: 'flux2-klein-4b', stack: 'studio', role: 'images',
      name: 'FLUX.2 Klein 4B (Q4_K_M)',
      purpose: 'Modern image model — far better prompt adherence and text rendering than SD 1.5',
      engine: 'sdcpp',
      file: 'flux-2-klein-4b-q4_k_m.gguf',
      url: 'https://huggingface.co/unsloth/FLUX.2-klein-4B-GGUF/resolve/main/flux-2-klein-4b-Q4_K_M.gguf',
      weightsGb: 2.43, downloadGb: 2.43, kvCacheGb: 0.6,     // measured 2604311104 B
      // FLUX needs a text encoder and VAE beside the transformer.
      companions: ['flux2-vae', 'flux2-text-encoder'],
    },
    {
      id: 'sdxl-turbo', stack: 'lite', role: 'images',
      name: 'SDXL Turbo (Q5_K)',
      purpose: 'Higher-fidelity stills in very few steps',
      engine: 'sdcpp',
      file: 'sdxl-turbo-q5_k.gguf',
      url: 'https://huggingface.co/second-state/sdxl-turbo-GGUF/resolve/main/sdxl-turbo-Q5_K_M.gguf',
      weightsGb: 4.5, downloadGb: 4.5, kvCacheGb: 0.5,
    },
    {
      id: 'sd15', stack: 'lite', role: 'images',
      name: 'Stable Diffusion 1.5 (Q8_0)',
      purpose: 'Baseline image model — the fallback that runs anywhere',
      engine: 'sdcpp',
      file: 'sd-v1-5-q8_0.gguf',
      url: 'https://huggingface.co/second-state/stable-diffusion-v1-5-GGUF/resolve/main/stable-diffusion-v1-5-Q8_0.gguf',
      weightsGb: 1.7, downloadGb: 1.7, kvCacheGb: 0.3,
    },
  ],

  // ─── ANIMATION ────────────────────────────────────────────────────────────
  //
  // OPTIONAL by design: every entry can be declined and the pipeline still
  // produces video through the Ken Burns ffmpeg path. A machine that fits
  // nothing here is not an error.
  animation: [
    {
      id: 'ltx-2.3-distilled', stack: 'studio', role: 'animation',
      cpuHostile: true,   // frame-by-frame diffusion: hours per clip without a GPU
      name: 'LTX-2.3 22B distilled (fp8)',
      purpose: 'True video diffusion at high quality — the "enough memory" path',
      engine: 'ltx',
      file: 'ltx-2.3-22b-distilled-fp8.safetensors',
      url: 'https://huggingface.co/Lightricks/LTX-2.3-fp8/resolve/main/ltx-2.3-22b-distilled-fp8.safetensors',
      weightsGb: 27.5, downloadGb: 27.5, kvCacheGb: 2.0,     // measured 29531884062 B
      heavy: true,
      // The screenshot's own caveat, encoded as a GATE rather than a footnote.
      // Below a 32 GB-class machine placeModel() excludes this before the user
      // can start a 27.5 GB download that would fail at load.
      note: 'Requires a 32 GB-class machine. Excluded automatically below that.',
    },
    {
      id: 'wan-i2v', stack: 'lite', role: 'animation',
      cpuHostile: true,   // frame-by-frame diffusion: hours per clip without a GPU
      name: 'Wan 2.1 I2V (14B, Q4_K_S)',
      purpose: 'Image-to-video diffusion — slow on CPU but far smaller than LTX',
      engine: 'sdcpp',
      file: 'wan2.1-i2v-14b-480p-q4_k_s.gguf',
      url: 'https://huggingface.co/city96/Wan2.1-I2V-14B-480P-gguf/resolve/main/wan2.1-i2v-14b-480p-Q4_K_S.gguf',
      weightsGb: 9.0, downloadGb: 9.0, kvCacheGb: 1.0,
      heavy: true,
    },
    {
      id: 'animatediff', stack: 'lite', role: 'animation',
      cpuHostile: true,   // frame-by-frame diffusion: hours per clip without a GPU
      name: 'AnimateDiff motion module v1.5.2',
      purpose: 'Frame-by-frame motion on top of SD 1.5',
      engine: 'sdcpp',
      file: 'animatediff-v15-v2.ckpt',
      url: 'https://huggingface.co/guoyww/animatediff/resolve/main/mm_sd_v15_v2.ckpt',
      weightsGb: 1.7, downloadGb: 1.7, kvCacheGb: 0.3,
    },
  ],

  // ─── DICTION ──────────────────────────────────────────────────────────────
  //
  // Kokoro-82M is in BOTH stacks: the screenshot names it and it is already
  // what the app uses. At 82M it runs on anything, so there is no second
  // candidate and no reason to invent one — a bigger TTS model would cost
  // memory the image stage needs more.
  diction: [
    {
      id: 'tts-kokoro', stack: 'studio', role: 'diction',
      name: 'Kokoro TTS (82M)',
      purpose: 'Narration voice — best quality-per-byte available, runs anywhere',
      engine: 'tts',
      file: 'kokoro-v1.0.onnx',
      url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_q8f16.onnx',
      weightsGb: 0.09, downloadGb: 0.09, kvCacheGb: 0.05,
    },
  ],

  // ─── MUSIC ────────────────────────────────────────────────────────────────
  music: [
    {
      id: 'acestep-1.5', stack: 'studio', role: 'music',
      name: 'ACE-Step 1.5 base (Q4_K_M)',
      purpose: 'Modern music generation — full songs with structure, replaces MusicGen',
      engine: 'acestep',
      file: 'acestep-v15-base-q4_k_m.gguf',
      url: 'https://huggingface.co/Serveurperso/ACE-Step-1.5-GGUF/resolve/main/acestep-v15-base-Q4_K_M.gguf',
      weightsGb: 1.35, downloadGb: 1.35, kvCacheGb: 0.4,     // measured 1445710208 B
      // Two-stage system: an autoregressive LM proposes the musical plan, the
      // diffusion base renders audio. Both required.
      companions: ['acestep-lm'],
    },
    {
      id: 'music-musicgen', stack: 'lite', role: 'music',
      name: 'MusicGen Small',
      purpose: 'Original background music model — smaller, noticeably weaker',
      engine: 'music',
      file: 'musicgen-small-q8.gguf',
      url: 'https://huggingface.co/ggerganov/musicgen-small-ggml/resolve/main/musicgen-small-q8_0.gguf',
      weightsGb: 1.2, downloadGb: 1.2, kvCacheGb: 0.3,
    },
  ],
};

// Files a primary model cannot run without. Kept separate so the role lists stay
// readable and so disk/memory accounting adds them EXPLICITLY rather than
// hiding them inside one number.
export const COMPANIONS: Record<string, Companion> = {
  'acestep-lm': {
    id: 'acestep-lm', kind: 'companion',
    name: 'ACE-Step 1.5 LM 1.7B (Q8_0)',
    purpose: 'Autoregressive planning stage for ACE-Step 1.5',
    engine: 'acestep',
    file: 'acestep-5hz-lm-1.7b-q8_0.gguf',
    url: 'https://huggingface.co/Serveurperso/ACE-Step-1.5-GGUF/resolve/main/acestep-5Hz-lm-1.7B-Q8_0.gguf',
    approxBytes: 1975837568,          // measured
    weightsGb: 1.84, downloadGb: 1.84,
  },
  // FLUX companions live in the base repo. Declared so the UI shows the true
  // total download and so a partial install is detectable rather than surfacing
  // as a cryptic runtime error.
  'flux2-vae': {
    id: 'flux2-vae', kind: 'companion',
    name: 'FLUX.2 VAE', purpose: 'Latent decoder for FLUX.2', engine: 'sdcpp',
    file: 'flux2-vae.safetensors',
    url: 'https://huggingface.co/black-forest-labs/FLUX.2-klein-4B/resolve/main/vae/diffusion_pytorch_model.safetensors',
    approxBytes: 168 * 1024 ** 2, weightsGb: 0.17, downloadGb: 0.17,
    optionalUntilVerified: true,
  },
  'flux2-text-encoder': {
    id: 'flux2-text-encoder', kind: 'companion',
    name: 'FLUX.2 text encoder', purpose: 'Prompt encoder for FLUX.2', engine: 'sdcpp',
    file: 'flux2-text-encoder.safetensors',
    url: 'https://huggingface.co/black-forest-labs/FLUX.2-klein-4B/resolve/main/text_encoder/model.safetensors',
    approxBytes: 246 * 1024 ** 2, weightsGb: 0.25, downloadGb: 0.25,
    optionalUntilVerified: true,
  },
  // Qwen companions. Both are MANDATORY — the transformer alone generates
  // nothing — and the text encoder is the reason this stack costs 9.9 GB
  // rather than the 4.2 GB the transformer suggests. Declared so `totalCost`
  // quotes the truth and the disk gate is meaningful.
  'qwen-image-vae': {
    id: 'qwen-image-vae', kind: 'companion',
    name: 'Qwen-Image-2.1 VAE',
    purpose: '64-channel RGBA latent decoder — this is what enables transparency',
    engine: 'sdcpp',
    file: 'qwen_image_2.1_vae_bf16.safetensors',
    url: 'https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/vae/qwen_image_2.1_vae_bf16.safetensors',
    // NOT interchangeable with the earlier Qwen-Image or Wan 2.2 VAE weights;
    // upstream calls this out explicitly and the failure is a decode error
    // rather than a clear refusal.
    approxBytes: 675509688, weightsGb: 0.68, downloadGb: 0.68,   // measured
  },
  'qwen-image-text-encoder': {
    id: 'qwen-image-text-encoder', kind: 'companion',
    name: 'Qwen3-VL-8B text encoder (Q4_K_M)',
    purpose: 'Prompt encoder for Qwen-Image-2.1 — a full 8B vision-language model',
    engine: 'sdcpp',
    file: 'qwen3vl-8b-instruct-q4_k_m.gguf',
    url: 'https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct-GGUF/resolve/main/Qwen3VL-8B-Instruct-Q4_K_M.gguf',
    // Passed with `--llm`, NOT `--clip_l`. See ai/sdcpp.js buildArgs().
    approxBytes: 5027784800, weightsGb: 5.03, downloadGb: 5.03,  // measured
  },
};

/**
 * Total cost including everything a model cannot run without.
 *
 * Exists because a bare `downloadGb` UNDERSTATES ACE-Step by 1.84 GB — the LM
 * stage is mandatory, and quoting 1.35 GB then downloading 3.19 GB is the kind
 * of small dishonesty that makes a disk gate useless.
 */
export function totalCost(model: StackModel) {
  const extras = (model.companions || []).map((id) => COMPANIONS[id]).filter(Boolean);
  return {
    downloadGb: +(model.downloadGb + extras.reduce((a, c) => a + c.downloadGb, 0)).toFixed(2),
    weightsGb: +(model.weightsGb + extras.reduce((a, c) => a + c.weightsGb, 0)).toFixed(2),
    companions: extras,
  };
}

/**
 * Registry with companion costs folded in. The advisor consumes THIS, not
 * ROLES, so its fit checks see true totals.
 */
export function registry() {
  const roles: Record<string, StackModel[]> = {};
  for (const [role, list] of Object.entries(ROLES)) {
    roles[role] = list.map((m) => {
      const t = totalCost(m);
      return { ...m, downloadGb: t.downloadGb, weightsGb: t.weightsGb };
    });
  }
  return { roles, optionalRoles: ['animation'] };
}

/** Flat list of every installable item, for the setup/download UI. */
export function allItems(): Array<StackModel | Companion> {
  return [...Object.values(ROLES).flat(), ...Object.values(COMPANIONS)];
}

/** Look up any model or companion by id. */
export function byId(id: string): StackModel | Companion | null {
  return allItems().find((m) => m.id === id) || null;
}
