'use strict';
//
// Pipeline orchestration.
//
// Design notes this implements:
//   "Can we have still initial prompt and add prompts per generation part
//    (single if single radiobutton checked) and for every step if full output
//    video (last option) is chosen"
//   "when movie mode (all steps) chosen the steps buttons should have checkboxes
//    to be included into generation pipeline (also adding its step textarea)"
//   "if single step chosen there should be only main prompt area used"
//   "add stop button to stop running generation if needed"
//   "why processing fails silently?"
//
// One run = one AbortController + one RunLogger + one output directory. Every
// step is optional and independently prompted; a step that fails records why and
// the pipeline decides whether the run can continue without it, instead of
// throwing away everything that already succeeded.

const fs = require('fs');
const path = require('path');

const capacity = require('./capacity');
const compose = require('./compose');
const motion = require('./motion');
const { RunLogger } = require('./logger');
const { SdCpp, archFor, COMPANIONS } = require('./sdcpp');
const { Planner } = require('./llm');
const { Tts } = require('./tts');
const { Music } = require('./music');
const { AceStep } = require('./acestep');
const { Ltx } = require('./ltx');

const ALL_STEPS = ['plan', 'image', 'voice', 'music', 'video', 'compose'];

// Percentage each phase occupies on the progress bar, so the bar advances
// proportionally to real work rather than in equal jumps.
const WEIGHTS = { plan: 6, image: 40, voice: 12, music: 22, video: 15, compose: 5 };

class Runner {
  /**
   * @param {object} deps
   * @param {import('./storage').Storage} deps.storage
   * @param {import('./setup').Setup} deps.setup
   */
  constructor({ storage, setup }) {
    this.storage = storage;
    this.setup = setup;
    this.current = null; // { runId, controller, logger }
  }

  isRunning() { return !!this.current; }

  /** The Stop button. Returns false when nothing was running. */
  stop() {
    if (!this.current) return false;
    this.current.logger.warn('Stop requested by user');
    this.current.controller.abort();
    return true;
  }

  status() {
    if (!this.current) return { running: false };
    return { running: true, runId: this.current.runId, mode: this.current.mode, phase: this.current.phase };
  }

  modelPathFor(id) {
    const m = this.setup.find(id);
    return m ? this.setup.modelPath(m) : null;
  }

  /**
   * Resolve the model id to use for a pipeline role.
   *
   * Order of preference, and why:
   *   1. `settings.modelStack[role]` — what the advisor selected for this
   *      machine (or what the user overrode it with). This is the whole point
   *      of the startup check: the pipeline must actually USE the recommendation.
   *   2. The caller's hardcoded default, which is what every call site passed
   *      before the advisor existed.
   *
   * Falls back to the default whenever the selected model is not on disk.
   * A recommendation the user never downloaded must not break a run — the
   * advisor proposes, the download decides, and the pipeline degrades to
   * whatever is genuinely present.
   *
   * Added here rather than at each call site deliberately: this is the single
   * choke point every stage already funnels through, so one guard covers plan,
   * image, voice and music at once instead of four near-identical patches that
   * would drift apart.
   */
  modelIdForRole(role, fallbackId, settings = {}) {
    const chosen = settings.modelStack?.[role];
    if (chosen && this.hasModel(chosen)) return chosen;
    return fallbackId;
  }

  hasModel(id) {
    const m = this.setup.find(id);
    return !!(m && fs.existsSync(this.setup.modelPath(m)));
  }

  engineBinary(id) {
    const e = this.setup.find(id);
    return e ? this.setup.engineBinaryPath(e) : null;
  }

  /**
   * SdCpp constructor options for an image model id.
   *
   * ONE definition, used by both the stills stage and the motion stage.
   * Previously each site re-derived the architecture and its companion paths
   * with its own inline ternary chain, and the motion site carried a comment
   * requiring it to "resolve identically to the image stage" — a requirement
   * that nothing enforced. Adding a third architecture would have meant a
   * third copy in each, which is precisely how two call sites drift into
   * animating with different weights than the still was drawn with.
   *
   * Architecture and companions come from the registry-backed helpers in
   * sdcpp.js, so a new checkpoint layout is added in one place.
   */
  sdcppFor(imageId) {
    const arch = archFor(imageId);
    const companions = COMPANIONS[arch] || {};
    return {
      binary: this.engineBinary('sdcpp'),
      modelPath: this.modelPathFor(imageId),
      arch,
      vaePath: companions.vae ? this.modelPathFor(companions.vae) : undefined,
      clipPath: companions.text ? this.modelPathFor(companions.text) : undefined,
    };
  }

  /**
   * Execute one generation.
   *
   * @param {object} req
   * @param {string} req.mode          image | voice | music | video | movie
   * @param {string} req.prompt        the main prompt (the only one in single mode)
   * @param {object} [req.stepPrompts] per-step overrides, movie mode only
   * @param {string[]} [req.steps]     enabled steps, movie mode only
   * @param {number} [req.outputSec]
   * @param {string} [req.orientation] @param {string} [req.quality]
   * @param {string} [req.motion]      motion strategy id
   * @param {string} [req.referenceImage]
   * @param {(u:object)=>void} onUpdate
   */
  async run(req, onUpdate = () => {}) {
    if (this.current) throw new Error('A generation is already running');

    const runId = this.storage.newRunId();
    const controller = new AbortController();
    const signal = controller.signal;
    const logger = new RunLogger(this.storage.logsDir, runId);
    const outDir = this.storage.runDir(runId);

    const settings = this.storage.loadSettings();
    const mode = req.mode || settings.mode;
    const outputSec = clamp(req.outputSec ?? settings.outputSec, capacity.MIN_OUTPUT_SECONDS, capacity.MAX_OUTPUT_SECONDS);
    const orientation = req.orientation || settings.orientation;
    const quality = req.quality || settings.quality;

    // In single-step mode only the main prompt applies — the per-step textareas
    // belong to movie mode and must not leak into it.
    const enabledSteps = mode === 'movie'
      ? ALL_STEPS.filter((s) => (req.steps || Object.keys(settings.steps).filter((k) => settings.steps[k])).includes(s))
      : stepsForSingleMode(mode);
    const stepPrompts = mode === 'movie' ? (req.stepPrompts || {}) : {};

    this.current = { runId, controller, logger, mode, phase: 'starting' };

    const started = Date.now();
    const outputs = [];
    const warnings = [];
    let status = 'completed';
    let error = null;

    const emit = (patch) => {
      this.current && (this.current.phase = patch.phase || this.current.phase);
      onUpdate({ runId, ...patch });
    };
    const unsubscribe = logger.onLine((line, phaseInfo) => {
      if (line) onUpdate({ runId, log: line });
      if (phaseInfo) onUpdate({ runId, ...phaseInfo });
    });

    // Progress accounting across the enabled steps only.
    const totalWeight = enabledSteps.reduce((a, s) => a + (WEIGHTS[s] || 0), 0) || 1;
    let doneWeight = 0;
    const stepProgress = (step, pctWithinStep, note) => {
      const pct = ((doneWeight + (WEIGHTS[step] || 0) * (pctWithinStep / 100)) / totalWeight) * 100;
      emit({ phase: step, pct: Math.min(99, pct), note });
    };
    const finishStep = (step) => { doneWeight += WEIGHTS[step] || 0; };

    const estimate = capacity.estimateSeconds({ mode, outputSec, quality, motion: req.motion, steps: enabledSteps });

    logger.header({
      mode, prompt: req.prompt, steps: enabledSteps.join(','), outputSec, orientation, quality,
      motion: req.motion, referenceImage: req.referenceImage || '(none)',
      estimate: capacity.humanDuration(estimate),
      accelerator: capacity.probe().accelerator.label,
    });

    try {
      if (!String(req.prompt || '').trim()) throw new Error('Enter a prompt first');

      const sceneCount = mode === 'movie' ? Math.max(1, Math.round(outputSec / 5)) : 1;
      const { w, h } = compose.dimensionsFor(orientation);

      // ── plan ──────────────────────────────────────────────────────────────
      let scenes = [{ title: 'Scene 1', image: req.prompt, narration: req.prompt }];
      if (enabledSteps.includes('plan')) {
        stepProgress('plan', 0, 'Planning script and scenes…');
        // The advisor's pick for this machine, falling back to the original
        // default when nothing was selected or the selection is not on disk.
        const plotId = this.modelIdForRole('plot', 'llm-planner', settings);
        const planner = new Planner({ modelPath: this.modelPathFor(plotId), logger });
        const res = await planner.plan({
          prompt: stepPrompts.plan || req.prompt, sceneCount, signal,
        });
        scenes = res.scenes;
        if (res.note) warnings.push(res.note);
        planner.dispose();
        finishStep('plan');
      } else if (mode === 'movie') {
        scenes = require('./llm').evenSplit(req.prompt, sceneCount).scenes;
      }
      logger.info(`scenes: ${scenes.length}`);

      // ── image ─────────────────────────────────────────────────────────────
      const stills = [];
      if (enabledSteps.includes('image')) {
        // `settings.imageModel` is the user's explicit override and still wins;
        // the advisor's choice is the default beneath it, and sd15 beneath that.
        const imageId = settings.imageModel
          || this.modelIdForRole('images', 'sd15', settings);

        const sd = new SdCpp({ ...this.sdcppFor(imageId), logger });
        logger.info(`image model: ${this.setup.find(imageId)?.name || imageId}`);
        // A single still can afford full quality; a movie multiplies steps by
        // scene count, so the budgets differ.
        const steps = capacity.stepsFor(mode === 'image' ? 'image' : 'movie', quality);

        for (let i = 0; i < scenes.length; i++) {
          if (signal.aborted) throw new Error('cancelled');
          const outPath = path.join(outDir, `scene_${String(i + 1).padStart(2, '0')}.png`);
          const scenePrompt = mode === 'movie'
            ? (scenes[i].image || req.prompt)
            : (stepPrompts.image || req.prompt);

          stepProgress('image', (i / scenes.length) * 100, `Scene ${i + 1}/${scenes.length}: still`);
          await sd.generate({
            prompt: scenePrompt,
            outPath,
            steps,
            width: mode === 'image' ? Math.max(w, 640) : w,
            height: mode === 'image' ? Math.max(h, 640) : h,
            // Reference image anchors scene 1; each later scene chains off the
            // previous still so the subject stays consistent across shots.
            initImage: i === 0 ? req.referenceImage : stills[i - 1],
            strength: i === 0 ? 0.6 : 0.7,
            signal,
            onProgress: ({ pct }) => stepProgress('image', ((i + pct / 100) / scenes.length) * 100,
              `Scene ${i + 1}/${scenes.length}: still ${Math.round(pct)}%`),
          });
          stills.push(outPath);
          outputs.push({ kind: 'image', path: outPath, label: scenes[i].title || `Scene ${i + 1}` });
        }
        finishStep('image');
      }

      // ── voice ─────────────────────────────────────────────────────────────
      let voicePath = null;
      if (enabledSteps.includes('voice')) {
        stepProgress('voice', 0, 'Generating narration…');
        const script = stepPrompts.voice
          || (mode === 'movie' ? scenes.map((s) => s.narration).filter(Boolean).join(' ') : req.prompt);
        const tts = new Tts({ modelPath: this.modelPathFor('tts-kokoro'), logger });
        try {
          const r = await tts.speak({
            text: script || req.prompt,
            outPath: path.join(outDir, 'narration.wav'),
            signal, maxSeconds: outputSec,
          });
          voicePath = r.path;
          outputs.push({ kind: 'audio', path: voicePath, label: 'Narration' });
        } catch (e) {
          if (signal.aborted) throw e;
          // Narration is optional; losing it must not sink a movie whose images
          // already cost minutes. This is the "closes on narration" crash,
          // downgraded to a warning.
          logger.fail(e);
          warnings.push(`Narration skipped: ${e.message}`);
          if (mode === 'voice') throw e;
        } finally { tts.dispose(); }
        finishStep('voice');
      }

      // ── music ─────────────────────────────────────────────────────────────
      let musicPath = null;
      if (enabledSteps.includes('music')) {
        stepProgress('music', 0, 'Generating music…');
        // Two different music engines with the same call shape. ACE-Step 1.5 is
        // a two-stage system (LM + diffusion base) and gets its own driver;
        // MusicGen remains the fallback that runs on the bundled engine.
        //
        // Both expose generate({prompt,outPath,seconds,signal,onProgress}) and
        // both return {path}, so the surrounding progress/error handling is
        // untouched — that shared shape is why this is a one-line branch rather
        // than a duplicated stage.
        const musicId = this.modelIdForRole('music', 'music-musicgen', settings);
        const music = musicId === 'acestep-1.5'
          ? new AceStep({
            modelPath: this.modelPathFor('acestep-1.5'),
            lmPath: this.modelPathFor('acestep-lm'),
            binary: this.engineBinary('acestep'),
            logger,
          })
          : new Music({
            modelPath: this.modelPathFor('music-musicgen'),
            binary: this.engineBinary('sdcpp'),
            logger,
          });
        try {
          const r = await music.generate({
            prompt: stepPrompts.music || req.prompt,
            outPath: path.join(outDir, 'music.wav'),
            seconds: outputSec,
            signal,
            onProgress: (pct, note) => stepProgress('music', pct, note),
          });
          musicPath = r.path;
          if (r.partial) warnings.push('Music is shorter than requested — some segments failed (see log).');
          outputs.push({ kind: 'audio', path: musicPath, label: 'Music' });
        } catch (e) {
          if (signal.aborted) throw e;
          logger.fail(e);
          warnings.push(`Music skipped: ${e.message}`);
          if (mode === 'music') throw e;
        }
        finishStep('music');
      }

      // ── video ─────────────────────────────────────────────────────────────
      let videoPath = null;
      if (enabledSteps.includes('video') && stills.length) {
        const chosen = motion.resolve(req.motion || settings.motion, (id) => this.hasModel(id));
        if (chosen.fellBack) { logger.warn(chosen.reason); warnings.push(chosen.reason); }
        emit({ motionStrategy: chosen.strategy.id, motionFellBack: chosen.fellBack });

        const perScene = outputSec / stills.length;
        const clips = [];
        // The motion stage re-renders from the SAME image model, so it must
        // resolve identically to the image stage — a mismatch would animate
        // with different weights than the still was drawn with.
        const motionImageId = settings.imageModel
          || this.modelIdForRole('images', 'sd15', settings);
        const sd = new SdCpp({ ...this.sdcppFor(motionImageId), logger });

        for (let i = 0; i < stills.length; i++) {
          if (signal.aborted) throw new Error('cancelled');
          const clip = path.join(outDir, `clip_${String(i + 1).padStart(2, '0')}.mp4`);
          stepProgress('video', (i / stills.length) * 100, `Scene ${i + 1}/${stills.length}: motion (${chosen.strategy.name})`);
          await motion.renderScene({
            strategy: chosen.strategy,
            still: stills[i],
            prompt: scenes[i]?.image || req.prompt,
            outPath: clip,
            seconds: perScene,
            fps: capacity.FPS,
            orientation,
            sd,
            // Only constructed when the LTX strategy is actually selected —
            // building it unconditionally would stat a 27.5 GB path on every
            // run for the large majority of users who will never use it.
            ltx: chosen.strategy.id === 'ltx'
              ? new Ltx({
                modelPath: this.modelPathFor('ltx-2.3-distilled'),
                binary: this.engineBinary('ltx'),
                logger,
              })
              : null,
            onFallback: (why) => warnings.push(why),
            workDir: path.join(outDir, `scene_${i + 1}_work`),
            logger, signal,
            onProgress: (pct) => stepProgress('video', ((i + pct / 100) / stills.length) * 100,
              `Scene ${i + 1}/${stills.length}: motion ${Math.round(pct)}%`),
          });
          clips.push(clip);
        }
        videoPath = path.join(outDir, 'video.mp4');
        await compose.concatClips({ clips, outPath: videoPath, logger, signal });
        finishStep('video');
      }

      // ── compose ───────────────────────────────────────────────────────────
      if (enabledSteps.includes('compose') && (videoPath || stills.length)) {
        stepProgress('compose', 20, 'Composing final output…');
        const base = videoPath || await compose.stillToVideo({
          image: stills[0], outPath: path.join(outDir, 'still.mp4'),
          seconds: outputSec, fps: capacity.FPS, orientation, logger, signal,
        });
        const finalPath = path.join(outDir, 'output.mp4');
        await compose.mux({ video: base, voice: voicePath, music: musicPath, outPath: finalPath, logger, signal });
        outputs.push({ kind: 'video', path: finalPath, label: 'Final output', primary: true });
        finishStep('compose');
      } else if (videoPath) {
        outputs.push({ kind: 'video', path: videoPath, label: 'Video', primary: true });
      }

      emit({ phase: 'done', pct: 100, note: 'Finished' });
    } catch (e) {
      if (signal.aborted || /cancelled/i.test(e.message)) {
        status = 'cancelled';
        logger.warn('Run cancelled');
      } else {
        status = 'failed';
        error = e.message;
        logger.fail(e);
      }
      emit({ phase: status, pct: 0, note: error || 'Cancelled' });
    } finally {
      unsubscribe();
      const elapsed = logger.footer(status, { outputs: outputs.length, warnings: warnings.length });
      // Feed the real timing back so future estimates converge on this machine.
      if (status === 'completed') {
        capacity.recordObservation(capacity.probe().accelerator.kind, estimate, elapsed);
      }
      this.current = null;

      this.storage.recordRun({
        runId, mode, status, error, warnings,
        prompt: req.prompt, outputSec, orientation, quality,
        motion: req.motion || settings.motion,
        steps: enabledSteps,
        outputs, elapsed,
        at: started,
      });
    }

    return { runId, status, error, warnings, outputs, elapsed: (Date.now() - started) / 1000 };
  }
}

/** Which pipeline steps a single-mode selection maps onto. */
function stepsForSingleMode(mode) {
  switch (mode) {
    case 'image': return ['image'];
    case 'voice': return ['voice'];
    case 'music': return ['music'];
    case 'video': return ['image', 'video', 'compose'];
    default: return ALL_STEPS;
  }
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, Number(n) || lo)); }

module.exports = { Runner, ALL_STEPS, stepsForSingleMode, WEIGHTS };
