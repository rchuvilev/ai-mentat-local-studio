'use strict';
//
// Scene planning.
//
// Design note (Apr 29): "no procedural approach, use llms: prompt" — the first
// version split a prompt into scenes with string heuristics and produced
// nonsense. When a planner model is installed the split is done by the model;
// when it is not, we fall back to a deliberately dumb even split AND say so,
// rather than pretending the result was planned.
//
// The model runs through node-llama-cpp when present. That dependency is
// optional: the app must stay usable (and honest) without it.

const fs = require('fs');

const SYSTEM = `You are a shot planner for a short generated video.
Given a single idea, produce a JSON array of scenes. Each scene is an object:
  { "title": short label, "image": a vivid visual prompt for an image model,
    "narration": one sentence of voiceover }
Return ONLY the JSON array. No prose, no code fences.
Keep image prompts concrete and visual: subject, setting, lighting, style.
Keep every scene visually consistent with the others.`;

class Planner {
  /**
   * @param {object} o
   * @param {string|null} o.modelPath
   * @param {import('./logger').RunLogger} o.logger
   */
  constructor({ modelPath, logger }) {
    this.modelPath = modelPath;
    this.logger = logger;
    this._session = null;
  }

  available() { return !!(this.modelPath && fs.existsSync(this.modelPath) && hasLlamaCpp()); }

  /**
   * @returns {Promise<{scenes:Array, planned:boolean, note:string|null}>}
   */
  async plan({ prompt, sceneCount, signal }) {
    if (!this.available()) {
      const why = !this.modelPath || !fs.existsSync(this.modelPath)
        ? 'planner model not installed'
        : 'node-llama-cpp not available in this build';
      this.logger?.warn(`planner unavailable (${why}) — falling back to an even split`);
      return { ...evenSplit(prompt, sceneCount), planned: false,
        note: `Scenes were split evenly (${why}). Install the planner model in Setup for scripted scenes.` };
    }

    try {
      const scenes = await this.runModel(prompt, sceneCount, signal);
      if (!scenes.length) throw new Error('planner returned no scenes');
      this.logger?.info(`planner produced ${scenes.length} scene(s)`);
      return { scenes, planned: true, note: null };
    } catch (e) {
      if (signal?.aborted) throw e;
      // A planner failure must not sink the whole run — degrade and continue.
      this.logger?.warn(`planner failed (${e.message}) — falling back to an even split`);
      return { ...evenSplit(prompt, sceneCount), planned: false,
        note: `Planner failed (${e.message}); scenes were split evenly.` };
    }
  }

  async runModel(prompt, sceneCount, signal) {
    const { getLlama, LlamaChatSession } = require('node-llama-cpp');
    if (!this._session) {
      this.logger?.info(`loading planner model: ${this.modelPath}`);
      const llama = await getLlama();
      const model = await llama.loadModel({ modelPath: this.modelPath });
      const context = await model.createContext({ contextSize: 2048 });
      this._session = new LlamaChatSession({ contextSequence: context.getSequence(), systemPrompt: SYSTEM });
    }
    const answer = await this._session.prompt(
      `Idea: ${prompt}\nProduce exactly ${sceneCount} scenes.`,
      { maxTokens: 900, signal },
    );
    return parseScenes(answer, sceneCount);
  }

  dispose() { this._session = null; }
}

function hasLlamaCpp() {
  try { require.resolve('node-llama-cpp'); return true; } catch { return false; }
}

/** Models wrap JSON in prose and fences no matter how firmly you ask them not to. */
function parseScenes(text, sceneCount) {
  const cleaned = String(text).replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];
  let arr;
  try { arr = JSON.parse(cleaned.slice(start, end + 1)); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((s) => s && (s.image || s.title))
    .slice(0, sceneCount)
    .map((s, i) => ({
      title: String(s.title || `Scene ${i + 1}`).slice(0, 120),
      image: String(s.image || s.title || '').slice(0, 600),
      narration: String(s.narration || '').slice(0, 400),
    }));
}

/** Fallback: same prompt for every scene, with a varied camera hint. */
function evenSplit(prompt, sceneCount) {
  const angles = [
    'wide establishing shot', 'medium shot', 'close-up detail',
    'low angle', 'high angle', 'over-the-shoulder', 'dramatic silhouette',
  ];
  const scenes = Array.from({ length: sceneCount }, (_, i) => ({
    title: `Scene ${i + 1}`,
    image: `${prompt}, ${angles[i % angles.length]}`,
    narration: '',
  }));
  return { scenes };
}

module.exports = { Planner, parseScenes, evenSplit };
