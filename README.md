# ai-mentat-local-studio

## Quick start

```sh
git clone --recurse-submodules https://github.com/hexstack-apps/ai-mentat-local-studio.git
cd ai-mentat-local-studio
npm run setup     # install all npm and non-npm dependencies
npm run run       # launch in dev mode
npm test          # unit suite
```

This is a **free personal project and runs from source**. It does not build
installers: no DMG, MSI, deb, code signing, notarization, itch.io channel or
update feed. `npm run run` is the way to use it.

Already cloned without `--recurse-submodules`? Run `npm run setup` — it
initialises the [ai-mentats-sdk](https://github.com/rchuvilev/ai-mentats-sdk)
submodule for you.

| script | what it does |
|---|---|
| `setup` | git submodules, npm dependencies, non-npm/system dependency check, creates the data dir |
| `run` | runs `setup` first, then launches the Electron app in dev mode |
| `gui` | bundle + launch, skipping the setup step |
| `test` | unit suite |
| `check:sdcpp` | live check that the image-engine download still resolves (see below) |

## Where data is stored

```
/.hexstack-app/ai-mentat-local-studio/data
```

The filesystem root is not writable by an unprivileged user on most systems, so
`npm run setup` creates the directory and tells you what to run if it cannot:

```sh
sudo mkdir -p /.hexstack-app && sudo chown -R "$(whoami)" /.hexstack-app
```

Until then the app falls back to `~/.hexstack-app/ai-mentat-local-studio/data` rather than
failing to start.

## Shared code

Common logic, UI and utilities live in
[ai-mentats-sdk](https://github.com/rchuvilev/ai-mentats-sdk), mounted here as
a git submodule at `sdk/`.

---

Fully local AI media generation — images, narration, music and video — in one
Electron app. Nothing is sent anywhere: every engine and model runs on your
machine, and everything it needs installs from inside the app.

## Provenance

This app is a **reimplementation**. Unlike its siblings it never entered any git
repository: it lived only in `hexstack_app/products/ai-local-studio/`, which was
deleted on 2026-08-30 with no backup anywhere. What survived was the session
record — roughly 45 prompts from 2026-04-28/29 describing what it did, what
broke, and how each problem was resolved.

It has been rebuilt from those notes. The module layout follows the one recorded
in the original session logs (`ai/` plus `scripts/`), and every design decision
below traces to a specific note, quoted in the source at the point it applies.

## What it makes

| Mode | Produces |
|---|---|
| 🖼️ Image | A single still |
| 🗣️ Narration | Spoken audio from a script |
| 🎵 Music | A background track |
| 🎬 Video | Stills with motion applied |
| 🎞️ Full movie | Every step, composed into one file |

Full movie is the default on launch. In movie mode each pipeline step —
plan, stills, narration, music, motion, compose — has a checkbox and its own
optional prompt; in every other mode the single main prompt is the only input.

## Model stacks

The app ships **two** model stacks and picks between them per role, based on
what your machine can actually hold.

| Role | Lite stack | Studio stack |
|---|---|---|
| 🧠 Plot | Qwen2.5 3B Instruct | **Qwen 3 4B / 8B** |
| 🎨 Images | SD 1.5, SDXL Turbo | **FLUX.2 Klein 4B**, Qwen-Image-2.1 (24 GB+) |
| 🎬 Animation | AnimateDiff, Wan 2.1 I2V | **LTX-2.3** (32 GB-class machines) |
| 🗣️ Diction | Kokoro-82M | Kokoro-82M *(same — already best in class)* |
| 🎵 Music | MusicGen Small | **ACE-Step 1.5** |
| 🎞️ Assembly | FFmpeg | FFmpeg |

Selection is **per role, not per stack**, so a mixed result is normal and
correct: a 12 GB machine typically takes FLUX.2 Klein for images while keeping
Ken Burns for motion. Nothing is hidden — the Setup tab lists every model in
both stacks with its size, and you can override any choice.

### Why Qwen-Image-2.1 is the image default

> **Built with Qwen**
>
> Qwen-Image-2.1 is used under the [Qwen Research License][qwen-lic] —
> research / non-commercial use only. This app is free and non-commercial, and
> it **never redistributes weights**: models are downloaded from HuggingFace to
> your own machine when you press Download.

[qwen-lic]: https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE

It has noticeably stronger prompt adherence and text rendering than FLUX.2
Klein, and it is the only option here that generates **native transparency**
(its 64-channel RGBA VAE produces a real alpha channel, not a background
removed after the fact). What it costs:

| | transformer | VAE | text encoder | total |
|---|---|---|---|---|
| FLUX.2 Klein 4B | 2.43 | 0.17 | 0.25 (CLIP) | **2.85 GB** |
| Qwen-Image-2.1 Q4_K_M | 4.29 | 0.68 | **5.03** (Qwen3-VL-8B) | **10.00 GB** |

The headline "4.29 GB" is the transformer alone. Qwen's text encoder is a full
8B vision-language model, resident during generation — so the honest figure is
~10 GB, and that is what the advisor gates on. **A machine that cannot hold it
still falls through to FLUX.2 Klein**; being the default does not mean being
forced, and the memory, disk and throughput gates all still apply.

Two further notes, both surfaced in the UI rather than left implicit:

- **Speed.** It runs with `--offload-to-cpu` by default because a 7B
  transformer plus an 8B encoder do not fit in consumer VRAM together. Expect
  it to be slower than Klein, not faster — on a CPU-only box the advisor scores
  it below Klein and picks it anyway, because quality is the product decision
  and the score is only a throughput proxy.
- **"Uncensored" means re-quantized, not retrained.** The weights come from
  [`abenzerps/Qwen-Image-2.1-Uncensored-GGUF`][uc]. Measured against that
  repo's own `base` branch, tensor by tensor: 297 vs 297 tensors, identical
  shapes, **BF16 passthrough tensors bit-identical 4/4** while only the Q4_K
  quantized ones differ. A finetune would change the BF16 tensors too. It is
  the stock model requantized — there is no safety checker inside a bare GGUF
  to remove.

[uc]: https://huggingface.co/abenzerps/Qwen-Image-2.1-Uncensored-GGUF

## Hardware advisor

On launch the app profiles the machine — VRAM, memory bandwidth, CPU vector
extensions, free disk — and selects the best stack it can actually run. The
approach is adapted from
[keplerTR/LocalAI-Advisor](https://github.com/keplerTR/LocalAI-Advisor) (MIT).

The core idea worth stealing: **local inference is memory-bandwidth bound, not
FLOP bound.** Every generated token streams the active weights through the
memory bus, so `tokens/sec ≈ (bandwidth × efficiency) / (weights + kv_cache)`.
That one relation explains why a 4090 is ~20× faster than dual-channel DDR4 on
the same model, and it needs no benchmark to evaluate.

Three things the advisor refuses to do:

- **Offer a model that cannot load.** LTX-2.3 is 27.5 GB. Offering it on a
  16 GB laptop is not a slow run, it is a 27.5 GB download that fails at the
  end. The memory gate is hard, not advisory.
- **Confuse "fits" with "usable".** Frame-by-frame video diffusion fits in
  4 GB of RAM and would take hours there. Models marked `cpuHostile` are
  declined without an accelerator, and Ken Burns covers motion instead.
- **Quote a size that excludes mandatory companions.** ACE-Step 1.5 needs both
  its LM and diffusion stages; the figure shown is the real total.

Every rejection carries a readable reason, so "why is this greyed out?" is
answerable from the UI.

## Motion

Four strategies, and the app is explicit about which one actually ran:

| Strategy | Real motion | Notes |
|---|---|---|
| **Ken Burns** | No | Pan and zoom over *one* still. Fast, always available. |
| **AnimateDiff** | Yes | Per-frame generation. The Cinematic preset. |
| **Wan 2.1 I2V** | Yes | True image-to-video diffusion. |
| **LTX-2.3** | Yes | State of the art. 27.5 GB of weights, 32 GB-class machines only. |

The order above is also the cost order, and that is a correctness property
rather than a preference: the estimator prices each path from it, so listing
LTX anywhere but last would make the app recommend the most expensive option
to the weakest machines.

When a real-motion model isn't installed the run falls back to Ken Burns, says
so in the log, and surfaces a warning — it never implies motion it did not
generate.

## Time estimates

A length slider without a cost is useless, so the row directly above **Generate**
always answers "how long will this take on *this* machine". The estimator
detects your accelerator (Metal / CUDA / CPU), models the cost of each pipeline
step, and reports both the estimate and the longest output that still fits a
~3-minute budget. Real timings feed back after each run, so estimates converge on
your hardware rather than staying at whatever the defaults guessed.

On a CPU-only Intel Mac, for example, a 15s movie estimates at ~4m15s and the app
recommends dropping to 9s.

## Overnight queue

Paste 20–50 prompts, one per line, and leave it running. Every item uses the
settings from the Generate tab — one setup for the whole batch. A prompt that
fails is recorded with its error and the queue moves to the next one; it never
halts the batch. State is persisted after every transition, so a crash resumes
instead of starting over.

## Setup

Everything installs from the Setup tab — there is no manual install step.

The tab is organised by **pipeline step**, not by component type: one card per
stage, in the order the pipeline runs them (Plan → Stills → Narration → Music →
Motion → Compose), each with its own Ready/Optional badge, its own download
size and the components that stage needs. So "I want narration" is one card
rather than knowing in advance that Kokoro-82M is the TTS model, and a stage
that cannot run says so next to the button that fixes it.

A few components serve more than one stage — sd.cpp draws stills *and* the
frames behind real motion, and the motion stage re-renders from the same image
model the still was drawn with. Those appear under the later stage in a
collapsed "shared with earlier steps" section, and are **not** counted twice in
the per-step size. Companion weights (a VAE, a text encoder) are listed under
the model that requires them, marked as dependents, so a 5 GB text encoder is
never mistaken for an alternative you can skip.

**Engines**

| Component | Role |
|---|---|
| stable-diffusion.cpp | Every still, and the frames behind real motion |
| FFmpeg | Composition, Ken Burns, audio muxing (from your package manager) |

**Models** — SD 1.5 (required), SDXL Turbo, FLUX.2 Klein, Qwen-Image-2.1,
AnimateDiff, Wan 2.1 I2V, Qwen2.5 3B planner, Kokoro TTS, MusicGen Small. Each
shows its size and installs with one button. Anything with no build for your
platform says why rather than silently missing its button.

Models that ship their weights in separate pieces — FLUX.2 and Qwen-Image-2.1
both need a VAE and a text encoder beside the transformer — declare those
companions, so the size shown is the size downloaded. macOS is **arm64 only**
for the image engine: upstream publishes no Intel build, and the Setup tab says
so instead of offering a download that cannot resolve.

A headless path exists for CI and for preparing a machine before first launch:

```bash
npm run setup:list        # what is installed, and what each component is for
npm run download:engines  # everything marked required
node scripts/download-sdcpp.js sdcpp sd15 wan-i2v   # specific components
```

## Running from source

```bash
npm install
npm run gui               # bundle + launch
npm test                  # unit suite
npm run test:smoke        # boot the main process and drive its IPC surface
npm run check:sdcpp       # does the image engine still download? (network)
```

There is no packaging step. The project is personal and free, so installers,
signing, notarization, the itch.io channel and the auto-update feed were all
removed rather than left half-configured — a `publish` script pointing at an
empty feed URL is worse than no script.

`check:sdcpp` is deliberately **not** part of `npm test`: it hits the GitHub
API, and a unit suite that fails when the network is down or rate-limited is a
suite people learn to ignore. It exists because upstream renamed every release
asset once already and the installer broke silently — see
`test/test_sdcpp_contract.js`.

The main process is bundled with esbuild before every run. `node-llama-cpp` and `kokoro-js` are deliberately **external**:
they use top-level await and platform-specific dynamic imports that cannot be
inlined into a CJS bundle, so they resolve from `node_modules` at runtime. Both
are optional — the app runs without them and degrades explicitly (an even scene
split instead of a planned one, narration reported as unavailable).

## Storage

Everything the app owns lives under one root — `.local-studio/` beside the source
in dev, `userData` when packaged:

```
settings.json      preferences, shared queue settings
runs.json          index of completed runs
queue.json         queue state, survives a crash
engines/           downloaded executables
models/            downloaded weights
outputs/<runId>/   generated media, one directory per run
logs/studio.log    rolling log across all runs
logs/runs/<id>.log one file per run
```

Outputs are addressed by run id so a run's media, its log and its index entry
never drift apart.

## Debugging

Every run writes a log, and every failure lands in it with a stack — the original
complaint was "why processing fails silently?". Optional steps that fail become
warnings and the run continues, so losing narration doesn't discard stills that
already cost minutes. The run log is visible in the Generate tab and on disk in
`logs/runs/`.

## Known limits

- **Narration** drives Kokoro. Other architectures are rejected at validation
  with a message naming the problem, rather than crashing inside the ONNX runtime
  — that was the `style_text_to_speech_2` failure in the original.
- **Music** uses a segmented MusicGen path with a hard per-segment timeout;
  segments are written incrementally so an interrupted run keeps what finished.
- The **Wan 2.1 I2V** entry points at a 14B quantised checkpoint (~9 GB). It is
  installable and wired, but slow enough on CPU to be impractical — the estimator
  will tell you so before you start.
- **ACE-Step 1.5 and LTX-2.3 are wired but need a runtime.** Both are declared,
  sized, gated and downloadable, and their drivers shell out to an `acestep` /
  `ltx` binary. Neither ships one: the reference implementations are
  PyTorch/Python, and vendoring a Python environment would contradict this
  app's "no manual install" rule and add hundreds of megabytes to every build —
  including for the majority of users whose hardware cannot run these models
  anyway. Until a single-binary runtime exists, ACE-Step reports a clear reason
  and MusicGen remains the working default, while LTX degrades to Ken Burns.
  The registry entries and fit logic do not change when a runtime appears.
- **The advisor's speed numbers are estimates, not benchmarks.** The efficiency
  coefficients (0.55 GPU, 0.45/0.30 CPU) come from upstream's measurements. They
  rank models correctly relative to one another, which is what selection needs;
  they are not a promise of absolute throughput.
- **Type annotations are not type-checked in CI.** The TypeScript modules are
  transpiled with esbuild, which strips types without verifying them. This buys
  documentation and editor support at zero dependency cost; adding `tsc
  --noEmit` is the upgrade path if type errors start slipping through.
