'use strict';
//
// Narration.
//
// Design notes (Apr 28-29):
//   "Error invoking remote method 'run:pipeline': Error: Unsupported model type:
//    style_text_to_speech_2"
//   "closes on narration (check logs) and fix"
//
// Both failures came from the same place: the app loaded whatever ONNX file was
// present and let an unsupported architecture throw deep inside the runtime,
// which took the window down with it. Two rules here as a result:
//   1. Validate the model before loading it, and name the problem.
//   2. Never let a synthesis failure escape as an uncaught exception — the
//      pipeline decides whether a run continues without narration.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const compose = require('./compose');

// Architectures this app knows how to drive. The Apr 28 crash was
// style_text_to_speech_2 (StyleTTS2), which needs a phonemizer and a different
// input signature than Kokoro.
const SUPPORTED = new Set(['kokoro']);

class Tts {
  constructor({ modelPath, logger }) {
    this.modelPath = modelPath;
    this.logger = logger;
  }

  available() { return !!(this.modelPath && fs.existsSync(this.modelPath) && hasOnnxRuntime()); }

  /**
   * Reject unsupported checkpoints up front with a message that says what to do,
   * instead of failing inside the ONNX runtime.
   */
  validate() {
    if (!this.modelPath || !fs.existsSync(this.modelPath)) {
      throw new Error('Narration model not installed. Download Kokoro TTS in Setup.');
    }
    const name = path.basename(this.modelPath).toLowerCase();
    const arch = name.includes('kokoro') ? 'kokoro'
      : name.includes('style_text_to_speech') || name.includes('styletts') ? 'style_text_to_speech_2'
      : 'unknown';
    if (!SUPPORTED.has(arch)) {
      throw new Error(
        `Unsupported narration model type: ${arch}. `
        + `This build drives Kokoro. Remove the current model in Setup and download Kokoro TTS.`,
      );
    }
    if (!hasOnnxRuntime()) {
      throw new Error('onnxruntime-node is not available in this build, so narration cannot run.');
    }
    return arch;
  }

  /**
   * Synthesize `text` to a wav.
   *
   * @returns {Promise<{path:string, seconds:number}>}
   */
  async speak({ text, outPath, voice = 'af_heart', speed = 1.0, signal, maxSeconds }) {
    this.validate();
    const clean = String(text || '').trim();
    if (!clean) throw new Error('Nothing to narrate');

    this.logger?.info(`tts: ${clean.length} chars, voice=${voice}, speed=${speed}`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });

    // Long scripts are chunked at sentence boundaries: a single huge forward
    // pass is where the original ran out of memory and took the window with it.
    const chunks = chunkText(clean, 320);
    const parts = [];
    try {
      const { KokoroTTS } = require('kokoro-js');
      if (!this._tts) {
        this._tts = await KokoroTTS.from_pretrained(this.modelPath, { dtype: 'q8' });
      }
      for (let i = 0; i < chunks.length; i++) {
        if (signal?.aborted) throw new Error('cancelled');
        const part = outPath.replace(/\.wav$/, `.part${i}.wav`);
        const audio = await this._tts.generate(chunks[i], { voice, speed });
        await audio.save(part);
        parts.push(part);
      }
    } catch (e) {
      for (const p of parts) { try { fs.unlinkSync(p); } catch {} }
      if (signal?.aborted) throw new Error('cancelled');
      throw new Error(`Narration failed: ${e.message}`);
    }

    if (parts.length === 1) {
      fs.renameSync(parts[0], outPath);
    } else {
      await compose.concatClips({ clips: parts, outPath, logger: this.logger, signal });
      for (const p of parts) { try { fs.unlinkSync(p); } catch {} }
    }

    let seconds = compose.probeDuration(outPath) || 0;
    // Keep narration inside the clip length so the mux does not stretch the video.
    if (maxSeconds && seconds > maxSeconds) {
      this.logger?.warn(`narration ${seconds.toFixed(1)}s exceeds ${maxSeconds}s — trimming`);
      const trimmed = outPath.replace(/\.wav$/, '.trim.wav');
      await compose.runFfmpeg(['-i', outPath, '-t', String(maxSeconds), trimmed], { logger: this.logger, signal });
      fs.renameSync(trimmed, outPath);
      seconds = maxSeconds;
    }
    return { path: outPath, seconds };
  }

  dispose() { this._tts = null; }
}

function hasOnnxRuntime() {
  try { require.resolve('kokoro-js'); return true; } catch { return false; }
}

/** Split on sentence boundaries, never mid-word. */
function chunkText(text, maxLen) {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const out = [];
  let cur = '';
  for (const s of sentences) {
    if ((cur + ' ' + s).trim().length > maxLen && cur) { out.push(cur.trim()); cur = s; }
    else cur = (cur + ' ' + s).trim();
  }
  if (cur.trim()) out.push(cur.trim());
  return out.length ? out : [text];
}

module.exports = { Tts, chunkText, SUPPORTED };
