'use strict';
//
// Engine and model installation.
//
// Design notes:
//   "we need to avoid manual pinokio install (replace with bundable solution or
//    embed into app (per-os executables)"
//   "but i wanted download for user, not manual install"
//   "why Wan 2.1 I2V (real video diffusion) isnt installable (no button)?"
//
// The original shipped a Pinokio dependency the user had to install by hand.
// Here every engine and model is an entry in a registry with a download button,
// a size, a status probe and an uninstall — including the video engines, which
// is what "no button" was complaining about. Nothing is hidden behind a manual
// step, and anything not installable on the current platform says why instead of
// silently missing its button.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawn } = require('child_process');
const { downloadFile, fetchJson, humanBytes } = require('./download');

// ─── Platform ──────────────────────────────────────────────────────────────

function platformKey() {
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'macos-arm64' : 'macos-x64';
  if (process.platform === 'win32') return 'win-x64';
  return 'linux-x64';
}

// ─── Registry ──────────────────────────────────────────────────────────────
//
// `kind: 'engine'` entries are executables, `kind: 'model'` entries are weights.
// `platforms: null` means every platform.

const ENGINES = [
  {
    id: 'sdcpp',
    kind: 'engine',
    name: 'stable-diffusion.cpp',
    purpose: 'Image generation (and the still frames behind every video mode)',
    required: true,
    platforms: null,
    // Resolved from the GitHub release feed at install time; upstream renames
    // assets between builds, so pinning a filename here would rot.
    //
    // It rotted anyway. The previous matchers looked for `bin-macos-arm64.zip`,
    // `bin-win-avx2-x64.zip` and `bin-ubuntu.*x64.zip`; by release
    // master-889-c678dfe upstream had renamed macOS builds to
    // `Darwin-macOS-<version>-arm64`, dropped the `avx2` win build in favour of
    // per-backend `win-{cpu,cuda12,vulkan,rocm}`, and switched Linux to
    // `Linux-Ubuntu-24.04-x86_64`. ALL FOUR matched nothing, so the engine —
    // `required: true` — could not install on any platform.
    //
    // So these are written as OS-token + arch-token tests rather than
    // full-filename patterns: they describe the two things that actually
    // identify a build, and tolerate whatever decoration upstream adds around
    // them. `deny` removes the variants that are not portable (see below).
    //
    // macos-x64 is ABSENT ON PURPOSE. Upstream publishes an arm64 macOS build
    // only — checked across the four most recent releases, each carrying
    // exactly one `Darwin-macOS-*-arm64.zip` and no x64 counterpart. Listing a
    // matcher for it would advertise a build that does not exist and fail at
    // download time; omitting it makes `installEngine` say "no build for
    // macos-x64" up front, which is the truth and is actionable.
    github: { repo: 'leejet/stable-diffusion.cpp', assetMatch: {
      'macos-arm64': /(darwin|macos)/i,
      'win-x64':     /(^|[-_])win/i,
      'linux-x64':   /(linux|ubuntu)/i,
    } },
    // Arch tokens, applied on top of assetMatch. Kept separate because the OS
    // and the arch rotate independently upstream (x64 -> x86_64 happened while
    // the OS token stayed put).
    assetArch: {
      'macos-arm64': /(arm64|aarch64)/i,
      'win-x64':     /(x64|x86[-_]?64|amd64)/i,
      'linux-x64':   /(x64|x86[-_]?64|amd64)/i,
    },
    // Rejected regardless of platform:
    //   cuda/vulkan/rocm — need a matching GPU runtime installed. The portable
    //     CPU build is the only one that runs on an arbitrary user machine, and
    //     a silently-downloaded rocm build fails at exec time with a link error
    //     rather than anything a user can act on.
    //   cudart-*         — a side-car of CUDA runtime DLLs containing NO sd
    //     binary at all. It sorts first alphabetically, so a loose win matcher
    //     picks it and the install "succeeds" with nothing executable in it.
    assetDeny: /(cuda|cudart|vulkan|rocm|hip|sycl|musa)/i,
    binary: { 'win-x64': 'sd-cli.exe', default: 'sd-cli' },
    approxBytes: 12 * 1024 * 1024,
  },
  {
    id: 'ffmpeg',
    kind: 'engine',
    name: 'FFmpeg',
    purpose: 'Composition, Ken Burns motion, audio muxing',
    required: true,
    platforms: null,
    // Preferred from the system: distro packages are better maintained than a
    // vendored copy, and most machines already have one.
    system: { probe: 'ffmpeg -version', hint: {
      darwin: 'brew install ffmpeg',
      win32: 'winget install Gyan.FFmpeg',
      linux: 'sudo apt install ffmpeg',
    } },
    approxBytes: 0,
  },
];

/**
 * Run modes accepted by the current sd.cpp CLI.
 *
 * Source of truth: `modes_str[]` in examples/common/common.cpp @c678dfe.
 * Exported so the driver and its tests cannot drift from it independently —
 * `-M img2img` was passed for months after upstream removed that mode, and
 * nothing caught it because the string lived inline in one file.
 */
const SDCPP_MODES = ['img_gen', 'adetailer', 'vid_gen', 'convert', 'upscale', 'metadata'];

/**
 * Pick the release asset for a platform.
 *
 * Split out of `installEngine` so it is testable WITHOUT a network call: the
 * defect this guards against is a pure string-matching bug, and a test that
 * needed the live GitHub feed would be skipped in CI and never run.
 *
 * @param {object} engine  registry entry with github.assetMatch
 * @param {string} key     platform key, e.g. 'linux-x64'
 * @param {string[]} names asset filenames from the release feed
 * @returns {string|null}  the chosen filename, or null when nothing fits
 */
function matchAsset(engine, key, names) {
  const os = engine.github?.assetMatch?.[key];
  if (!os) return null;
  const arch = engine.assetArch?.[key];
  const deny = engine.assetDeny;

  const fits = (names || []).filter((n) => {
    if (deny && deny.test(n)) return false;
    if (!os.test(n)) return false;
    if (arch && !arch.test(n)) return false;
    return true;
  });
  if (!fits.length) return null;

  // Shortest name wins among equals. Upstream decorates non-portable variants
  // with extra tokens ("-vulkan", "-rocm-7.14.0"), so the plain build is
  // reliably the shortest — a stable tie-break that does not need a new rule
  // every time a backend is added.
  fits.sort((a, b) => a.length - b.length || a.localeCompare(b));
  return fits[0];
}

// Models come from the two-stack registry in stacks.ts rather than a second
// hardcoded list.
//
// WHY: this file used to own its own `MODELS` array. Adding the Studio stack
// would have meant maintaining the same models in two places, and the two would
// drift — a model added to stacks.ts but missing here resolves to `null` in
// `find()`, which surfaces as "model not downloaded" for a model the advisor
// just recommended. One registry, one source of truth.
//
// The shape is adapted, not replaced: `approxBytes` is what the download UI and
// progress bars already use, so it is derived from the registry's measured
// `downloadGb` instead of being restated.
const { allItems } = require('./stacks');

const MODELS = allItems().map((m) => ({
  id: m.id,
  kind: 'model',
  name: m.name,
  purpose: m.purpose,
  engine: m.engine,
  // Only the baseline image model and the planner are required for a usable
  // first run; everything else is opt-in, exactly as before. The advisor
  // decides what to SUGGEST, this decides what is mandatory.
  required: m.id === 'sd15',
  file: m.file,
  url: m.url,
  approxBytes: Math.round((m.downloadGb || 0) * 1024 ** 3),
  heavy: !!m.heavy,
  stack: m.stack,
  role: m.role,
  note: m.note,
  // Carried through so status() can mark a primary model's mandatory
  // companions as required too. Dropping this field made FLUX report "ready"
  // with no VAE or text encoder — which looks installed and then fails at load.
  companions: m.companions,
  // Sizes in GB, kept alongside approxBytes. approxBytes alone cannot express
  // a companion's cost to anything that reasons about totals without
  // re-dividing by 1024**3 at every call site, and this projection silently
  // dropping a field is precisely the bug the `companions` note above
  // describes — so the size fields travel with it.
  downloadGb: m.downloadGb,
  weightsGb: m.weightsGb,
  kvCacheGb: m.kvCacheGb,
  // Non-Apache weights must stay visible all the way to the UI. Qwen-Image-2.1
  // is research/non-commercial; a licence that is only in a source comment is
  // a licence nobody sees.
  license: m.license,
  // Qwen Research Licence clause 6.b requires "Built with Qwen" to be
  // PROMINENTLY DISPLAYED. A tooltip on a licence pill is not prominent, and
  // a notice that stops at the registry is a notice nobody sees — the same
  // failure the `license` field above was added to fix.
  attribution: m.attribution,
}));

// ─── Step grouping ─────────────────────────────────────────────────────────
//
// The Setup tab used to be two flat lists — "Engines" (2 rows) and "Models"
// (18 rows) — with nothing connecting a row to what it makes possible. A user
// who wanted narration had to already know that "Kokoro-82M" is the TTS model,
// and "Missing required: Stable Diffusion 1.5" gave no clue which step would
// stop working.
//
// These groups are keyed to the PIPELINE STEPS the runner executes, so the
// Setup tab reads in the same order and vocabulary as movie mode's checkboxes:
// plan -> stills -> narration -> music -> motion -> compose.
//
// `step` values and their order MUST match `ALL_STEPS` in ai/runner.js; a test
// parses that array and compares, because a step added to the runner and
// forgotten here would render a pipeline stage with no way to install what it
// needs.
//
// `roles` is the set of registry roles whose models the step consumes. Note
// that `video` lists `images` as well as `animation`: the motion stage
// deliberately re-renders from the SAME image model as the stills stage, so a
// clip animates the weights the still was drawn with.

const STEP_GROUPS = [
  {
    step: 'plan', label: 'Plan', hint: 'Splits the idea into scenes with the planner model',
    roles: ['plot'], engines: [], optional: true,
  },
  {
    step: 'image', label: 'Stills', hint: 'Draws the image for each scene',
    roles: ['images'], engines: ['sdcpp'], optional: false,
  },
  {
    step: 'voice', label: 'Narration', hint: 'Speaks the script aloud',
    roles: ['diction'], engines: [], optional: true,
  },
  {
    step: 'music', label: 'Music', hint: 'Generates a background track',
    roles: ['music'], engines: [], optional: true,
  },
  {
    // Optional because motion ALWAYS has a path: Ken Burns pans and zooms over
    // a single still through ffmpeg, so a machine with no animation model is
    // not broken, it just gets no real motion.
    step: 'video', label: 'Motion', hint: 'Turns stills into moving clips',
    roles: ['animation', 'images'], engines: ['sdcpp', 'ffmpeg'], optional: true,
  },
  {
    // Owns no model at all — it IS ffmpeg. Included so the step list matches
    // the pipeline rather than skipping a stage that can still be missing.
    step: 'compose', label: 'Compose', hint: 'Concatenates clips and muxes the audio',
    roles: [], engines: ['ffmpeg'], optional: false,
  },
];

/**
 * Reverse of every `companions` array: companion id -> the model that needs it.
 *
 * Built rather than declared because the forward direction already exists in
 * stacks.ts, and two hand-maintained directions drift. This is what lets a
 * roleless companion be attributed to a step at all.
 *
 * WHY IT CANNOT USE `kind`: the MODELS projection above rewrites every item to
 * `kind: 'model'`, so `kind: 'companion'` from stacks.ts never reaches here.
 * Five mandatory multi-gigabyte downloads (flux2-vae, flux2-text-encoder,
 * qwen-image-vae, qwen-image-text-encoder, acestep-lm) have `role: undefined`
 * and would otherwise fall into an unnamed "undefined" bucket.
 */
function companionParents(models) {
  const parent = new Map();
  for (const m of models) {
    for (const cid of m.companions || []) parent.set(cid, m.id);
  }
  return parent;
}

/**
 * Group components by the pipeline step they serve.
 *
 * @param {{models: object[], engines: object[]}} src  rows as returned by status()
 * @returns {object[]} one entry per step, in pipeline order
 */
function groupByStep({ models = [], engines = [] } = {}) {
  const parent = companionParents(models);
  const byId = new Map([...models, ...engines].map((x) => [x.id, x]));

  // Which step OWNS each role, so a model shared by two steps is flagged in
  // the borrowing step instead of looking like two separate downloads.
  const ownerOfRole = new Map();
  for (const g of STEP_GROUPS) {
    for (const role of g.roles) if (!ownerOfRole.has(role)) ownerOfRole.set(role, g.step);
  }

  return STEP_GROUPS.map((g) => {
    const items = [];
    const seen = new Set();
    const add = (row, extra = {}) => {
      if (!row || seen.has(row.id)) return;
      seen.add(row.id);
      items.push({ ...row, ...extra });
    };

    for (const e of g.engines) {
      const row = byId.get(e);
      // An engine listed by several steps is owned by the first that claims it.
      const owner = STEP_GROUPS.find((x) => x.engines.includes(e))?.step;
      add(row, owner && owner !== g.step ? { sharedWith: owner } : {});
    }

    for (const role of g.roles) {
      const owner = ownerOfRole.get(role);
      const shared = owner && owner !== g.step ? { sharedWith: owner } : {};
      for (const m of models.filter((x) => x.role === role)) {
        add(m, shared);
        // Companions ride with their parent so a 5 GB text encoder is never a
        // row the user has to know to look for.
        for (const cid of m.companions || []) {
          add(byId.get(cid), { ...shared, companionOf: m.id });
        }
      }
    }

    // Any companion whose parent lives in this step but was not reached above
    // (defensive: a companion declared on a roleless model).
    for (const [cid, pid] of parent) {
      if (seen.has(cid)) continue;
      if (seen.has(pid)) add(byId.get(cid), { companionOf: pid });
    }

    // READY means: every engine this step runs is installed, AND — when the
    // step consumes models — at least ONE complete alternative is installed.
    //
    // "Complete" is load-bearing. There are four image models; requiring all
    // of them would demand ~18 GB to turn one step green. But a primary whose
    // mandatory companions are missing does NOT count: that is exactly the
    // case the `companions` note above describes, where FLUX reported "ready"
    // with no VAE and then failed at load.
    const enginesOk = g.engines.every((e) => byId.get(e)?.installed);
    const primaries = g.roles.flatMap((role) => models.filter((m) => m.role === role));
    const complete = (m) =>
      m.installed && (m.companions || []).every((cid) => byId.get(cid)?.installed);
    const modelsOk = primaries.length === 0 || primaries.some(complete);

    return {
      ...g,
      items,
      ready: !!(enginesOk && modelsOk),
      // ONLY what this step adds. Rows flagged `sharedWith` are borrowed from
      // an earlier step and are already counted there.
      //
      // Measured: the motion step borrows all four image models, so summing
      // every row reports 57.16 GB against 38.20 GB of its own — and summing
      // the column across steps claimed 89.61 GB when the entire registry is
      // 70.65 GB. "Motion: 57 GB" reads as 57 GB ON TOP of stills, which is
      // wrong in the direction that makes a machine look incapable.
      downloadGb: +items
        .filter((i) => !i.sharedWith)
        .reduce((s, i) => s + (i.downloadGb || 0), 0)
        .toFixed(2),
    };
  });
}

// ─── Paths ─────────────────────────────────────────────────────────────────

class Setup {
  /** @param {{enginesDir:string, modelsDir:string}} dirs */
  constructor({ enginesDir, modelsDir }) {
    this.enginesDir = enginesDir;
    this.modelsDir = modelsDir;
    for (const d of [enginesDir, modelsDir]) {
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    }
    this.active = new Map(); // id -> AbortController
  }

  engineBinaryPath(engine) {
    const key = platformKey();
    const name = engine.binary ? (engine.binary[key] || engine.binary.default) : engine.id;
    return path.join(this.enginesDir, engine.id, name);
  }

  modelPath(model) { return path.join(this.modelsDir, model.file); }

  // ─── Status ──────────────────────────────────────────────────────────────

  systemBinary(engine) {
    if (!engine.system) return null;
    try {
      execSync(engine.system.probe, { timeout: 5000, stdio: 'pipe' });
      return engine.id;
    } catch { return null; }
  }

  engineStatus(engine) {
    const supported = !engine.platforms || engine.platforms.includes(platformKey());
    if (!supported) {
      return { id: engine.id, installed: false, supported: false,
        reason: `Not available for ${platformKey()}` };
    }
    if (engine.system) {
      const found = this.systemBinary(engine);
      return {
        id: engine.id, installed: !!found, supported: true, viaSystem: true,
        hint: found ? null : engine.system.hint[process.platform],
      };
    }
    const p = this.engineBinaryPath(engine);
    return { id: engine.id, installed: fs.existsSync(p), supported: true, path: p };
  }

  modelStatus(model) {
    const p = this.modelPath(model);
    let size = 0;
    try { size = fs.statSync(p).size; } catch {}
    // `supported` is NOT optional.
    //
    // 🔴 It was absent here since the first commit, and the renderer does
    //      const state = !c.supported ? 'unsupported' : ...
    //      ${c.supported && !c.installed ? '<button data-install=...>' : ''}
    // so `!undefined` made EVERY model render the "Unavailable" pill with NO
    // Download button — all 18 of them, i.e. the Models list could not install
    // anything at all. engineStatus() does set the field, so the Engines list
    // looked correct and the bug stayed invisible.
    //
    // Found by rendering the Setup tab and looking at it, not by a test: every
    // suite was green because none of them asserted on the field the markup
    // keys off.
    //
    // Weights are platform-independent unless the registry says otherwise —
    // the same .gguf loads on any OS, which is why there is nothing to check
    // beyond an explicit `platforms` restriction.
    const supported = !model.platforms || model.platforms.includes(platformKey());
    return {
      id: model.id,
      installed: size > 0,
      supported,
      ...(supported ? {} : { reason: `Not available for ${platformKey()}` }),
      path: p,
      sizeOnDisk: size,
    };
  }

  /**
   * @param {object} [opts]
   * @param {Record<string,string>} [opts.modelStack] the advisor's per-role
   *   selection, from settings. When present it REPLACES the static `required`
   *   flag for models.
   */
  status(opts = {}) {
    const engines = ENGINES.map((e) => ({
      ...e, github: undefined, system: undefined, binary: undefined,
      approxHuman: e.approxBytes ? humanBytes(e.approxBytes) : null,
      ...this.engineStatus(e),
    }));
    const models = MODELS.map((m) => ({
      ...m, url: undefined,
      approxHuman: humanBytes(m.approxBytes),
      ...this.modelStatus(m),
    }));

    // "Required" means required FOR THE SELECTED STACK, not a fixed list.
    //
    // Before this, `required` was hardcoded to sd15. Once the advisor could
    // recommend FLUX.2 Klein, a Studio-stack user was shown a warning badge and
    // "Missing required: Stable Diffusion 1.5" for a 1.7 GB model the app would
    // never load — pushing a pointless download and implying the app was not
    // ready when it was.
    //
    // With a stack selected, the requirement is exactly the models filling the
    // roles the pipeline cannot skip, PLUS their mandatory companions (ACE-Step
    // needs its LM stage; FLUX needs its VAE and text encoder — a primary model
    // alone looks installed and then fails at load).
    //
    // Falls back to the static flag when no stack has been chosen yet, which is
    // the pre-advisor behaviour and the correct answer on a first run that has
    // not reached the startup check.
    const stack = opts.modelStack && Object.keys(opts.modelStack).length ? opts.modelStack : null;
    let requiredModelIds;
    if (stack) {
      // 'animation' is intentionally excluded: it is the one optional role, and
      // Ken Burns covers motion without any model at all.
      const essential = ['plot', 'images', 'diction', 'music'];
      requiredModelIds = new Set();
      for (const role of essential) {
        const id = stack[role];
        if (!id) continue;
        requiredModelIds.add(id);
        const entry = MODELS.find((m) => m.id === id);
        for (const c of entry?.companions || []) requiredModelIds.add(c);
      }
    }

    const modelIsRequired = (m) => (requiredModelIds ? requiredModelIds.has(m.id) : m.required);

    const missingRequired = [
      ...engines.filter((e) => e.required && !e.installed).map((e) => e.name),
      ...models.filter((m) => modelIsRequired(m) && !m.installed).map((m) => m.name),
    ];
    // Re-stamp each row's `required` flag so the per-model "Required" pill
    // agrees with the banner above it. Leaving the static flag here would
    // show "Required" on SD 1.5 while the banner said everything was ready.
    const stampedModels = models.map((m) => ({ ...m, required: modelIsRequired(m) }));

    return {
      platform: platformKey(),
      engines,
      models: stampedModels,
      // Same rows, grouped by the pipeline step they serve. Computed here
      // rather than in the renderer so the grouping cannot disagree with the
      // flat lists it is derived from, and so one IPC round trip carries both.
      steps: groupByStep({ models: stampedModels, engines }),
      ready: missingRequired.length === 0,
      missingRequired,
      enginesDir: this.enginesDir,
      modelsDir: this.modelsDir,
    };
  }

  // ─── Install ─────────────────────────────────────────────────────────────

  find(id) {
    return ENGINES.find((e) => e.id === id) || MODELS.find((m) => m.id === id) || null;
  }

  cancel(id) {
    const ctrl = this.active.get(id);
    if (ctrl) { ctrl.abort(); this.active.delete(id); return true; }
    return false;
  }

  async install(id, onProgress = () => {}) {
    const item = this.find(id);
    if (!item) throw new Error(`Unknown component: ${id}`);
    if (this.active.has(id)) throw new Error(`${item.name} is already downloading`);

    const ctrl = new AbortController();
    this.active.set(id, ctrl);
    try {
      if (item.kind === 'model') return await this.installModel(item, onProgress, ctrl.signal);
      return await this.installEngine(item, onProgress, ctrl.signal);
    } finally {
      this.active.delete(id);
    }
  }

  async installModel(model, onProgress, signal) {
    const dest = this.modelPath(model);
    onProgress({ id: model.id, phase: 'download', pct: 0, note: `Downloading ${model.name}` });
    await downloadFile(model.url, dest, {
      signal,
      onProgress: (p) => onProgress({
        id: model.id, phase: 'download', pct: p.pct,
        note: `${humanBytes(p.received)} of ${humanBytes(p.total)} · ${humanBytes(p.speed)}/s`,
      }),
    });
    onProgress({ id: model.id, phase: 'done', pct: 100, note: 'Installed' });
    return { installed: true, path: dest };
  }

  async installEngine(engine, onProgress, signal) {
    if (engine.system) {
      // Nothing to download — surface the one command that installs it.
      const found = this.systemBinary(engine);
      if (found) return { installed: true, viaSystem: true };
      throw new Error(
        `${engine.name} must come from your package manager. Run: ${engine.system.hint[process.platform]}`,
      );
    }

    const key = platformKey();
    if (!engine.github.assetMatch[key]) throw new Error(`${engine.name} has no build for ${key}`);

    onProgress({ id: engine.id, phase: 'resolve', pct: 0, note: 'Finding latest release…' });
    const rel = await fetchJson(`https://api.github.com/repos/${engine.github.repo}/releases/latest`);
    const names = (rel.assets || []).map((a) => a.name);
    const chosen = matchAsset(engine, key, names);
    if (!chosen) {
      throw new Error(`No ${key} asset in ${engine.github.repo} ${rel.tag_name}. Assets: ${names.join(', ') || 'none'}`);
    }
    const asset = (rel.assets || []).find((a) => a.name === chosen);

    const outDir = path.join(this.enginesDir, engine.id);
    fs.mkdirSync(outDir, { recursive: true });
    const zipPath = path.join(outDir, asset.name);

    await downloadFile(asset.browser_download_url, zipPath, {
      signal,
      onProgress: (p) => onProgress({
        id: engine.id, phase: 'download', pct: p.pct * 0.9,
        note: `${humanBytes(p.received)} of ${humanBytes(p.total)} · ${rel.tag_name}`,
      }),
    });

    onProgress({ id: engine.id, phase: 'extract', pct: 92, note: 'Extracting…' });
    await extractZip(zipPath, outDir);
    try { fs.unlinkSync(zipPath); } catch {}

    // Release archives vary in whether they nest a directory; find the binary.
    const binName = engine.binary[key] || engine.binary.default;
    const found = findFile(outDir, binName);
    if (!found) throw new Error(`Extracted ${engine.name} but could not find "${binName}" inside the archive`);
    const target = this.engineBinaryPath(engine);
    if (found !== target) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(found, target);
    }
    if (process.platform !== 'win32') { try { fs.chmodSync(target, 0o755); } catch {} }

    onProgress({ id: engine.id, phase: 'done', pct: 100, note: `Installed ${rel.tag_name}` });
    return { installed: true, path: target, version: rel.tag_name };
  }

  uninstall(id) {
    const item = this.find(id);
    if (!item) throw new Error(`Unknown component: ${id}`);
    const target = item.kind === 'model' ? this.modelPath(item) : path.join(this.enginesDir, item.id);
    try { fs.rmSync(target, { recursive: true, force: true }); } catch (e) { throw new Error(e.message); }
    return { installed: false };
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function extractZip(zip, dest) {
  return new Promise((resolve, reject) => {
    // Both platforms ship a usable extractor, which avoids pulling a native
    // unzip dependency into the packaged app.
    const cmd = process.platform === 'win32'
      ? { bin: 'powershell', args: ['-NoProfile', '-Command', `Expand-Archive -LiteralPath "${zip}" -DestinationPath "${dest}" -Force`] }
      : { bin: 'unzip', args: ['-o', '-q', zip, '-d', dest] };
    const p = spawn(cmd.bin, cmd.args, { stdio: 'pipe' });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', reject);
    p.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Extract failed (${code}): ${err.trim()}`)));
  });
}

function findFile(dir, name, depth = 4) {
  if (depth < 0) return null;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name === name) return p;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const hit = findFile(path.join(dir, e.name), name, depth - 1);
      if (hit) return hit;
    }
  }
  return null;
}

module.exports = { Setup, ENGINES, MODELS, platformKey, matchAsset, SDCPP_MODES, STEP_GROUPS, groupByStep };
