'use strict';
/* global studio */
//
// Renderer.
//
// The interaction rules that came out of the design notes:
//   * movie mode shows per-step checkboxes and per-step prompts; every other
//     mode shows the main prompt only
//   * the length slider always has a live, capacity-aware time estimate beside
//     it, in the row immediately above Run
//   * Stop is available for the whole duration of a run
//   * every output type is previewable, with a navigation bar across the
//     artefacts of a run

const STEP_META = {
  plan:    { label: 'Plan',      hint: 'Split the idea into scenes with the planner model' },
  image:   { label: 'Stills',    hint: 'Generate the image for each scene' },
  voice:   { label: 'Narration', hint: 'Speak the script' },
  music:   { label: 'Music',     hint: 'Generate a background track' },
  video:   { label: 'Motion',    hint: 'Turn stills into moving clips' },
  compose: { label: 'Compose',   hint: 'Concatenate clips and mux the audio' },
};

let settings = {};
let currentOutputs = [];
let currentIndex = 0;
let referenceImage = null;
let running = false;

// ─── Boot ──────────────────────────────────────────────────────────────────

(async function boot() {
  settings = await studio.settingsGet();
  await buildMotionSelect();
  applySettingsToUi();
  renderSteps();
  wireEvents();
  await refreshHardware();
  await refreshCapacity();
  await refreshSetup();
  await refreshQueue();
  await loadGallery();
})();

function wireEvents() {
  // ── The flow ──
  //
  // Generate, Queue and Gallery genuinely ARE peers — three views of one
  // creative loop — so they are not stacked into an accordion; forcing that
  // would mean expanding a section every time you wanted to check the queue.
  // What is sequential here is Setup: you cannot generate without the models.
  // So Setup is a gate, Generate is the surface, and Queue and Gallery open
  // from the header as things you glance at without losing your place.
  flow = HexKit.createSteps(document.getElementById('flow'), {
    steps: [
      { id: 'setup',    title: 'Install what you need', hint: 'Engines and models for the kinds of output you want' },
      { id: 'generate', title: 'Make something',        hint: 'Describe it, pick a length, generate' },
    ],
  });
  flow.body('setup').appendChild(document.querySelector('#tab-setup .panel-scroll'));
  flow.body('generate').appendChild(document.getElementById('tab-generate'));
  document.getElementById('tab-generate').classList.add('active');
  flow.body('generate').classList.add('steps__body--fill');

  const queueBody   = document.querySelector('#tab-queue .panel-scroll') || document.getElementById('tab-queue');
  const galleryBody = document.querySelector('#tab-gallery .panel-scroll') || document.getElementById('tab-gallery');
  document.getElementById('icon-queue').onclick   = () => HexKit.openModal({ title: 'Queue', content: queueBody });
  document.getElementById('icon-gallery').onclick = () => { loadGallery(); HexKit.openModal({ title: 'Gallery', content: galleryBody }); };

  // Generate is reachable immediately — someone already set up should not have
  // to walk the gate again. Setting a step active also opens it, so re-open
  // setup after; refreshSetup() then decides which one should actually be open.
  flow.setState('generate', 'active');
  flow.open('setup');
  refreshSetup();

  // Advisor controls. `force` re-probes instead of serving the cached profile —
  // the point of the button is to pick up a change (freed disk, GPU driver
  // installed) that the cache would otherwise hide.
  const rescan = document.getElementById('advisor-rescan');
  if (rescan) rescan.onclick = async () => {
    rescan.disabled = true;
    try { await refreshAdvisor(true); } finally { rescan.disabled = false; }
  };

  const apply = document.getElementById('advisor-apply');
  if (apply) apply.onclick = async () => {
    if (!lastAdvice) return;
    const res = await studio.advisorApply(lastAdvice.chosen);
    // Re-read settings so the rest of the UI reflects the change rather than
    // assuming the write landed.
    settings = await studio.settingsGet();
    apply.textContent = `Applied (${Object.keys(res.applied).length} roles)`;
    setTimeout(() => { apply.textContent = 'Use recommended models'; }, 2500);
    await refreshSetup();
  };
  studio.onNavTab(showTab);

  document.querySelectorAll('input[name=mode]').forEach((r) => {
    r.onchange = async () => {
      settings.mode = r.value;
      await studio.settingsSet({ mode: r.value });
      renderSteps();
      refreshCapacity();
    };
  });

  const len = document.getElementById('length');
  len.oninput = () => {
    document.getElementById('length-val').textContent = `${len.value}s`;
    refreshCapacity();
  };
  len.onchange = () => studio.settingsSet({ outputSec: +len.value });

  for (const id of ['orientation', 'quality', 'motion']) {
    document.getElementById(id).onchange = (e) => {
      settings[id] = e.target.value;
      studio.settingsSet({ [id]: e.target.value });
      if (id === 'motion') updateMotionNote();
      refreshCapacity();
    };
  }

  document.getElementById('opt-keepawake').onchange = (e) =>
    studio.settingsSet({ keepAwakeDuringRun: e.target.checked });
  document.getElementById('opt-confirmclose').onchange = (e) =>
    studio.settingsSet({ confirmCloseDuringRun: e.target.checked });

  studio.onRunUpdate(onRunUpdate);
  studio.onQueueUpdate(renderQueue);
  studio.onSetupProgress(onSetupProgress);
}

let flow = null;

/**
 * Kept as the one way the rest of the app changes view, so existing callers —
 * "a run finished, show the gallery" — keep working. Queue and Gallery are now
 * dialogs rather than panels, which is the only thing that changed for them.
 */
function showTab(tab) {
  if (!flow) return;
  if (tab === 'gallery') { loadGallery(); return void HexKit.openModal({ title: 'Gallery', content: document.querySelector('#tab-gallery .panel-scroll') || document.getElementById('tab-gallery') }); }
  if (tab === 'queue') return void HexKit.openModal({ title: 'Queue', content: document.querySelector('#tab-queue .panel-scroll') || document.getElementById('tab-queue') });
  if (tab === 'setup') { flow.open('setup'); refreshSetup(); refreshAdvisor(); return; }
  flow.open('generate');
}

function applySettingsToUi() {
  const r = document.querySelector(`input[name=mode][value="${settings.mode}"]`);
  if (r) r.checked = true;
  document.getElementById('length').value = settings.outputSec;
  document.getElementById('length-val').textContent = `${settings.outputSec}s`;
  document.getElementById('orientation').value = settings.orientation;
  document.getElementById('quality').value = settings.quality;
  document.getElementById('opt-keepawake').checked = settings.keepAwakeDuringRun !== false;
  document.getElementById('opt-confirmclose').checked = settings.confirmCloseDuringRun !== false;
}

async function buildMotionSelect() {
  const list = await studio.motionList();
  const sel = document.getElementById('motion');
  sel.innerHTML = list.map((m) => `<option value="${m.id}">${m.name}</option>`).join('');
  sel.value = settings.motion || 'kenburns';
  sel._meta = list;
  updateMotionNote();
}

function updateMotionNote() {
  const sel = document.getElementById('motion');
  const m = (sel._meta || []).find((x) => x.id === sel.value);
  document.getElementById('motion-note').textContent = m ? m.describe : '';
}

// ─── Steps (movie mode only) ───────────────────────────────────────────────

function renderSteps() {
  const block = document.getElementById('steps-block');
  const isMovie = settings.mode === 'movie';
  // "if single step chosen there should be only main prompt area used"
  block.style.display = isMovie ? '' : 'none';
  if (!isMovie) return;

  const list = document.getElementById('steps-list');
  const enabled = settings.steps || {};
  list.innerHTML = Object.entries(STEP_META).map(([id, meta]) => `
    <div class="step-row">
      <label class="check">
        <input type="checkbox" data-step="${id}" ${enabled[id] !== false ? 'checked' : ''}>
        <span class="step-name">${meta.label}</span>
        <em class="hint">${meta.hint}</em>
      </label>
      <textarea class="step-prompt" data-step-prompt="${id}" rows="1"
        placeholder="Optional prompt for ${meta.label.toLowerCase()} — leave blank to use the main prompt"></textarea>
    </div>`).join('');

  list.querySelectorAll('input[data-step]').forEach((cb) => {
    cb.onchange = async () => {
      const steps = { ...(settings.steps || {}), [cb.dataset.step]: cb.checked };
      settings.steps = steps;
      await studio.settingsSet({ steps });
      refreshCapacity();
    };
  });
}

function enabledSteps() {
  if (settings.mode !== 'movie') return [];
  return [...document.querySelectorAll('input[data-step]:checked')].map((c) => c.dataset.step);
}

function stepPrompts() {
  const out = {};
  document.querySelectorAll('[data-step-prompt]').forEach((t) => {
    if (t.value.trim()) out[t.dataset.stepPrompt] = t.value.trim();
  });
  return out;
}

// ─── Capacity row ──────────────────────────────────────────────────────────

async function refreshHardware() {
  const hw = await studio.capacityHardware();
  const b = document.getElementById('hw-badge');
  b.textContent = hw.accelerator.gpu ? `⚡ ${hw.accelerator.label}` : `🐌 ${hw.accelerator.label}`;
  b.classList.toggle('badge--warn', !hw.accelerator.gpu);
}

async function refreshCapacity() {
  const opts = {
    mode: settings.mode,
    outputSec: +document.getElementById('length').value,
    quality: document.getElementById('quality').value,
    motion: document.getElementById('motion').value,
    steps: enabledSteps(),
  };
  const s = await studio.capacitySummary(opts);
  const row = document.getElementById('capacity-row');
  const parts = [
    `About <strong>${s.estimateHuman}</strong> on ${s.accelerator}.`,
  ];
  if (s.overBudget) {
    parts.push(`That is over the ${Math.round(s.targetSeconds / 60)}-minute target — <strong>${s.recommendedMaxSeconds}s</strong> would fit.`);
  } else {
    parts.push(`You could go up to <strong>${s.recommendedMaxSeconds}s</strong> within the ${Math.round(s.targetSeconds / 60)}-minute target.`);
  }
  document.getElementById('capacity-text').innerHTML = parts.join(' ');
  row.classList.toggle('capacity-row--warn', s.overBudget);
}

// ─── Running ───────────────────────────────────────────────────────────────

async function startRun() {
  const prompt = document.getElementById('main-prompt').value.trim();
  if (!prompt) { flashWarning('Enter a prompt first.'); return; }

  setRunning(true);
  clearWarnings();
  document.getElementById('progress-card').style.display = '';
  document.getElementById('run-log').textContent = '';
  setProgress(0, 'Starting…', '');

  const res = await studio.runStart({
    mode: settings.mode,
    prompt,
    steps: enabledSteps(),
    stepPrompts: stepPrompts(),
    outputSec: +document.getElementById('length').value,
    orientation: document.getElementById('orientation').value,
    quality: document.getElementById('quality').value,
    motion: document.getElementById('motion').value,
    referenceImage,
  });

  setRunning(false);

  if (res.warnings?.length) showWarnings(res.warnings);
  if (res.status === 'cancelled') {
    setProgress(0, 'Cancelled', 'Partial files are kept in the run folder.');
  } else if (!res.success) {
    setProgress(0, 'Failed', res.error || 'See the run log.');
    flashWarning(res.error || 'Generation failed — see the run log.');
  } else {
    setProgress(100, 'Done', `${res.outputs.length} file(s) in ${Math.round(res.elapsed)}s`);
  }

  if (res.outputs?.length) showOutputs(res.outputs);
  loadGallery();
}

async function stopRun() { await studio.runStop(); }

function setRunning(on) {
  running = on;
  document.getElementById('run-btn').style.display = on ? 'none' : '';
  document.getElementById('stop-btn').style.display = on ? '' : 'none';
  document.getElementById('run-btn').disabled = on;
}

function onRunUpdate(u) {
  if (u.log) {
    const el = document.getElementById('run-log');
    el.textContent += u.log + '\n';
    el.scrollTop = el.scrollHeight;
  }
  if (u.phase) {
    const label = STEP_META[u.phase]?.label || u.phase;
    setProgress(u.pct ?? null, label, u.note || '');
  }
  if (u.motionFellBack && u.motionStrategy) {
    flashWarning(`Motion fell back to ${u.motionStrategy}.`);
  }
}

function setProgress(pct, phase, note) {
  if (pct !== null) document.getElementById('progress-fill').style.width = `${Math.max(0, Math.min(100, pct))}%`;
  document.getElementById('progress-phase').textContent = phase;
  document.getElementById('progress-note').textContent = note || '';
}

function showWarnings(list) {
  const el = document.getElementById('warnings');
  el.style.display = '';
  el.innerHTML = list.map((w) => `<div class="warn">⚠ ${escapeHtml(w)}</div>`).join('');
}
function flashWarning(msg) { showWarnings([msg]); }
function clearWarnings() {
  const el = document.getElementById('warnings');
  el.style.display = 'none';
  el.innerHTML = '';
}

// ─── Preview ───────────────────────────────────────────────────────────────

async function showOutputs(outputs) {
  currentOutputs = outputs;
  // Primary artefact first — the composed video when there is one.
  const primary = outputs.findIndex((o) => o.primary);
  currentIndex = primary >= 0 ? primary : 0;
  await renderPreview();
}

async function renderPreview() {
  const stage = document.getElementById('preview-stage');
  const nav = document.getElementById('preview-nav');
  const actions = document.getElementById('preview-actions');

  if (!currentOutputs.length) {
    stage.innerHTML = '<div class="preview-empty">Nothing generated yet.</div>';
    nav.innerHTML = '';
    actions.style.display = 'none';
    return;
  }

  const item = currentOutputs[currentIndex];
  const url = await studio.mediaUrl(item.path);
  stage.innerHTML = !url
    ? '<div class="preview-empty">File is no longer on disk.</div>'
    : item.kind === 'video' ? `<video src="${url}" controls autoplay loop></video>`
    : item.kind === 'audio' ? `<div class="audio-wrap"><div class="audio-label">${escapeHtml(item.label)}</div><audio src="${url}" controls></audio></div>`
    : `<img src="${url}" alt="${escapeHtml(item.label)}">`;

  // The navigation bar across every artefact of the run.
  nav.innerHTML = currentOutputs.map((o, i) => `
    <button class="nav-chip ${i === currentIndex ? 'active' : ''}" data-i="${i}" title="${escapeHtml(o.label)}">
      ${o.kind === 'video' ? '🎬' : o.kind === 'audio' ? '🔊' : '🖼️'} ${escapeHtml(o.label)}
    </button>`).join('');
  nav.querySelectorAll('.nav-chip').forEach((b) => {
    b.onclick = () => { currentIndex = +b.dataset.i; renderPreview(); };
  });
  actions.style.display = '';
}

function revealCurrent() { const i = currentOutputs[currentIndex]; if (i) studio.showItem(i.path); }
function openCurrent() { const i = currentOutputs[currentIndex]; if (i) studio.openPath(i.path); }

async function pickReference() {
  const p = await studio.pickImage();
  if (!p) return;
  referenceImage = p;
  document.getElementById('ref-name').textContent = p.split('/').pop();
  document.getElementById('ref-clear').style.display = '';
}
function clearReference() {
  referenceImage = null;
  document.getElementById('ref-name').textContent = 'None — scenes start from the prompt alone';
  document.getElementById('ref-clear').style.display = 'none';
}

// ─── Queue ─────────────────────────────────────────────────────────────────

async function refreshQueue() { renderQueue(await studio.queueList()); }

async function queueAdd() {
  const box = document.getElementById('queue-input');
  if (!box.value.trim()) return;
  await studio.queueAdd(box.value);
  box.value = '';
}

async function queueCurrentPrompt() {
  const p = document.getElementById('main-prompt').value.trim();
  if (!p) { flashWarning('Enter a prompt first.'); return; }
  await studio.queueAdd(p);
  showTab('queue');
}

async function queueStart() {
  const r = await studio.queueStart();
  if (!r.success) flashWarning(r.error);
}
async function queueStop() { await studio.queueStop(); }
async function queueRetry() { renderQueue(await studio.queueRetryFailed()); }
async function queueClear(which) { renderQueue(await studio.queueClear(which)); }

function renderQueue(snap) {
  if (!snap) return;
  const { items, counts, active } = snap;

  const pill = document.getElementById('queue-count');
  const pending = counts.pending + counts.running;
  pill.textContent = pending ? String(pending) : '';
  pill.style.display = pending ? '' : 'none';

  document.getElementById('queue-start-btn').style.display = active ? 'none' : '';
  document.getElementById('queue-stop-btn').style.display = active ? '' : 'none';

  document.getElementById('queue-summary').innerHTML =
    `<span class="pill">${counts.pending} pending</span>
     <span class="pill pill--ok">${counts.done} done</span>
     <span class="pill pill--warn">${counts.failed} failed</span>
     ${active ? '<span class="pill pill--live">running</span>' : ''}`;

  document.getElementById('queue-list').innerHTML = items.length
    ? items.map((i) => `
      <div class="queue-item queue-item--${i.state}">
        <span class="q-state">${{ pending: '•', running: '⟳', done: '✓', failed: '✕', cancelled: '⊘' }[i.state]}</span>
        <span class="q-prompt" title="${escapeHtml(i.prompt)}">${escapeHtml(i.prompt)}</span>
        ${i.error ? `<span class="q-error" title="${escapeHtml(i.error)}">${escapeHtml(i.error)}</span>` : ''}
        ${i.state !== 'running' ? `<button class="btn ghost small" data-remove="${i.id}">Remove</button>` : ''}
      </div>`).join('')
    : '<div class="empty">Queue is empty.</div>';

  document.querySelectorAll('[data-remove]').forEach((b) => {
    b.onclick = async () => renderQueue(await studio.queueRemove(b.dataset.remove));
  });
}

// ─── Gallery ───────────────────────────────────────────────────────────────

async function loadGallery() {
  const mode = document.getElementById('gallery-filter').value;
  const runs = await studio.runsList({ mode: mode || null, limit: 60 });
  const grid = document.getElementById('gallery-grid');

  if (!runs.length) { grid.innerHTML = '<div class="empty">No runs yet.</div>'; return; }

  const cards = await Promise.all(runs.map(async (r) => {
    const thumb = r.outputs.find((o) => o.kind === 'image') || r.outputs[0];
    const url = thumb ? await studio.mediaUrl(thumb.path) : null;
    const icon = { completed: '✓', failed: '✕', cancelled: '⊘' }[r.status] || '';
    return `
      <div class="gcard" data-run="${r.runId}">
        <div class="gthumb">${
          url && thumb.kind === 'image' ? `<img src="${url}">`
          : url && thumb.kind === 'video' ? `<video src="${url}" muted></video>`
          : `<div class="gthumb-empty">${r.status === 'failed' ? '✕' : '🔊'}</div>`}</div>
        <div class="gmeta">
          <strong>${escapeHtml((r.prompt || '').slice(0, 60))}</strong>
          <span class="hint">${icon} ${r.mode} · ${r.outputSec}s · ${Math.round(r.elapsed || 0)}s${r.warnings?.length ? ` · ${r.warnings.length} warning(s)` : ''}</span>
        </div>
      </div>`;
  }));
  grid.innerHTML = cards.join('');

  grid.querySelectorAll('.gcard').forEach((c) => {
    c.onclick = () => {
      const run = runs.find((r) => r.runId === c.dataset.run);
      if (run?.outputs.length) { showOutputs(run.outputs); showTab('generate'); }
    };
  });
}

// ─── Hardware advisor ──────────────────────────────────────────────────────
//
// Renders the startup compatibility check. Kept deliberately plain: this is a
// report, not a control surface. The only actions are "re-scan" (after freeing
// disk space) and "use these", because the per-model install buttons below
// already do everything else.

let lastAdvice = null;

function renderAdvice(r) {
  if (!r) return;
  lastAdvice = r;
  const hw = r.hardware;

  // Free disk is nullable and MUST read as unknown rather than 0 — a machine we
  // failed to measure is not a full disk.
  const disk = hw.freeDiskGb == null ? 'unknown' : `${hw.freeDiskGb} GB free`;
  const gpu = hw.gpus.length
    ? hw.gpus.map((g) => `${g.name} (${g.vramGb} GB${g.vramConfidence === 'inferred' ? ', estimated' : ''})`).join(', ')
    : 'none detected';

  document.getElementById('advisor-summary').innerHTML = `
    <div><strong>${escapeHtml(r.tier.name)}</strong> — ${escapeHtml(r.tier.blurb)}</div>
    <div>CPU: ${escapeHtml(hw.cpu.model)} · ${hw.cpu.cores} cores${hw.cpu.features.avx2 ? ' · AVX2' : ''}${hw.cpu.features.neon ? ' · NEON' : ''}</div>
    <div>RAM: ${hw.ram.totalGb} GB @ ~${hw.ram.bandwidthGbps} GB/s (${escapeHtml(hw.ram.source)})</div>
    <div>GPU: ${escapeHtml(gpu)}</div>
    <div>Disk: ${disk} · Download for this stack: <b>${r.fit.totalDownloadGb} GB</b></div>`;

  // Reuses the existing .component / .component__head / .hint styles rather
  // than introducing new classes — the Setup tab already looks like this.
  document.getElementById('advisor-stack').innerHTML = Object.entries(r.chosen).map(([role, pick]) => {
    if (!pick) {
      return `<div class="component">
        <div class="component__head"><strong>${escapeHtml(role)}</strong>
          <span class="pill">Not used</span></div>
        <div class="hint">Nothing in this role runs well on this machine — the pipeline skips it.</div>
      </div>`;
    }
    const p = pick.placement;
    return `<div class="component">
      <div class="component__head">
        <strong>${escapeHtml(role)}</strong>
        <span class="pill pill--ok">${escapeHtml(pick.stack)}</span>
        ${pick.heavy ? '<span class="pill pill--warn">Large</span>' : ''}
      </div>
      <div class="hint">${escapeHtml(pick.name)} — ${escapeHtml(p.label)} · ~${p.tokensPerSec} tok/s · ${pick.downloadGb} GB</div>
    </div>`;
  }).join('');

  // Rejections are collapsed but present: "why is LTX not offered?" must be
  // answerable in the UI rather than only in the log.
  const wrap = document.getElementById('advisor-rejected-wrap');
  if (r.rejected.length) {
    wrap.style.display = '';
    document.getElementById('advisor-rejected').innerHTML =
      r.rejected.map((x) => `<div>${escapeHtml(x.id)}: ${escapeHtml(x.why)}</div>`).join('');
  } else {
    wrap.style.display = 'none';
  }
}

async function refreshAdvisor(force = false) {
  try {
    renderAdvice(await studio.advisorAdvise({ force }));
  } catch (e) {
    // A failed probe must not blank the Setup tab — the model list below is
    // still usable without advice.
    document.getElementById('advisor-summary').textContent =
      `Hardware scan unavailable: ${e.message}`;
  }
}

// The startup check pushes its result here, so the first paint already reflects
// the machine instead of a generic list.
//
// Registered at module scope (not inside boot()) so the listener exists as
// early as possible. The main process additionally waits for did-finish-load
// before sending, because a send to a page that has not run this line yet is
// dropped silently.
// Declared BEFORE the listener that assigns it: `let` is hoisted but sits in
// the temporal dead zone, so referencing it from a callback defined above the
// declaration would throw if that callback ran first.
let advisorArrived = false;

studio.onAdvisorStartup?.((r) => { advisorArrived = true; renderAdvice(r); });

// Belt and braces: if the startup event never arrives — an old main process, a
// probe that threw, an event lost to a reload — ask for the advice directly
// rather than leaving "Scanning hardware…" on screen forever. A stuck spinner
// looks identical to a hung app.
setTimeout(() => { if (!advisorArrived) refreshAdvisor(); }, 2000);

// ─── Setup ─────────────────────────────────────────────────────────────────

async function refreshSetup() {
  const s = await studio.setupStatus();

  document.getElementById('setup-badge').hidden = !!s.ready;
  if (flow) {
    // A count, not the whole list: the list is right there in the banner
    // inside the step, and a header note is a glance, not a manifest.
    flow.setNote('setup', s.ready ? 'Ready' : `${s.missingRequired.length} missing`);
    // Collapse the gate once it is satisfied and put the user on the surface
    // they came for; keep it open while anything required is still missing.
    if (s.ready && flow.state('setup') !== 'done') { flow.setState('setup', 'done'); flow.open('generate'); }
    if (!s.ready) flow.setState('setup', 'active');
  }
  const banner = document.getElementById('setup-ready');
  banner.className = 'ready-banner ' + (s.ready ? 'ready-banner--ok' : 'ready-banner--warn');
  banner.textContent = s.ready
    ? 'All required components installed — you can generate.'
    : `Missing required: ${s.missingRequired.join(', ')}`;

  renderSetupSteps(s);
  wireComponentButtons();

  const p = await studio.setupPaths();
  document.getElementById('paths-list').innerHTML = `
    <div><span>Data</span><code>${escapeHtml(p.root)}</code></div>
    <div><span>Models</span><code>${escapeHtml(p.models)}</code> <em>${fmtBytes(p.usage.models)}</em></div>
    <div><span>Engines</span><code>${escapeHtml(p.engines)}</code> <em>${fmtBytes(p.usage.engines)}</em></div>
    <div><span>Outputs</span><code>${escapeHtml(p.outputs)}</code> <em>${fmtBytes(p.usage.outputs)}</em></div>
    <div><span>FFmpeg</span><code>${p.ffmpeg ? escapeHtml(p.ffmpeg) : 'not found'}</code></div>`;
}

// ─── Setup, grouped by pipeline step ───────────────────────────────────────
//
// One card per step, in pipeline order, each owning the components that step
// needs. The step list comes from the payload (ai/setup.js STEP_GROUPS, itself
// aligned to ai/runner.js ALL_STEPS) rather than being retyped here — a third
// copy of the step names is how the Setup tab ends up offering a stage the
// pipeline no longer runs.
//
// A component can appear in more than one card: sd.cpp draws stills AND the
// frames behind real motion, and the motion stage re-renders from the same
// image model as the stills stage. Borrowed rows are marked and excluded from
// the card's size, so Motion does not read as needing its own copy of a model
// already downloaded for Stills.

function renderSetupSteps(s) {
  document.getElementById('setup-steps').innerHTML = (s.steps || []).map((g) => {
    const state = g.ready
      ? '<span class="pill pill--ok">Ready</span>'
      : g.optional
        ? '<span class="pill">Optional</span>'
        : '<span class="pill pill--warn">Not ready</span>';

    // Only show a size when there is something left to fetch; "0 GB" next to a
    // finished step is noise.
    const size = g.downloadGb > 0 ? ` · ${g.downloadGb} GB to download` : '';

    // Partition on `sharedWith`, because inlining borrowed rows defeats the
    // grouping. MEASURED in the rendered tab: Motion came out 13 rows, NINE of
    // them image models already listed under Stills, burying the four it
    // actually adds — and Compose was one row that was 100% borrowed.
    //
    // Collapsed rather than dropped: installing an image model from the Motion
    // card is a legitimate thing to want, and a step whose only components are
    // borrowed would otherwise render an empty card.
    const own = g.items.filter((i) => !i.sharedWith);
    const borrowed = g.items.filter((i) => i.sharedWith);

    const borrowedBlock = borrowed.length ? `
        <details class="shared-block">
          <summary class="hint">${borrowed.length} component${borrowed.length === 1 ? '' : 's'} shared with earlier steps</summary>
          <div class="component-list">${borrowed.map(componentRow).join('')}</div>
        </details>` : '';

    return `
      <div class="card" data-step-group="${g.step}">
        <div class="component__head">
          <h3>${escapeHtml(g.label)}</h3>
          ${state}
        </div>
        <div class="hint">${escapeHtml(g.hint)}${size}</div>
        ${own.length
          ? `<div class="component-list">${own.map(componentRow).join('')}</div>`
          // Compose owns nothing — it IS ffmpeg, already listed under Motion.
          // Measured: without this the card rendered an empty list under a
          // "Ready" badge, which reads as broken rather than as complete.
          : `<div class="hint">Nothing extra to install — this step uses ${
              borrowed.map((i) => escapeHtml(i.name)).join(', ')}.</div>`}
        ${borrowedBlock}
      </div>`;
  }).join('');
}

function componentRow(c) {
  const state = !c.supported ? 'unsupported' : c.installed ? 'installed' : 'missing';
  const badge = { installed: '<span class="pill pill--ok">Installed</span>',
    missing: '<span class="pill">Not installed</span>',
    unsupported: '<span class="pill pill--warn">Unavailable</span>' }[state];
  return `
    <div class="component" data-id="${c.id}">
      <div class="component__head">
        <strong>${escapeHtml(c.name)}</strong>
        ${badge}
        ${c.required ? '<span class="pill pill--req">Required</span>' : ''}
        ${c.heavy ? '<span class="pill pill--warn">Large</span>' : ''}
        ${c.license ? `<span class="pill pill--warn" title="${escapeHtml(c.license)}">Licence</span>` : ''}
      </div>
      ${c.attribution ? `<div class="attribution">${escapeHtml(c.attribution)}${c.license ? ` · ${escapeHtml(c.license)}` : ''}</div>` : ''}
      ${c.companionOf ? `<div class="hint">Required by ${escapeHtml(c.companionOf)} — installs alongside it, not instead of it.</div>` : ''}
      ${c.sharedWith ? `<div class="hint">Also used by this step; counted under <strong>${escapeHtml(c.sharedWith)}</strong>.</div>` : ''}
      <div class="hint">${escapeHtml(c.purpose)}${c.approxHuman ? ` · ~${c.approxHuman}` : ''}</div>
      ${c.reason ? `<div class="hint">${escapeHtml(c.reason)}</div>` : ''}
      ${c.hint && !c.installed ? `<div class="hint">Install with: <code>${escapeHtml(c.hint)}</code></div>` : ''}
      <div class="component__progress"><div class="progress-track"><div class="progress-fill" data-fill="${c.id}"></div></div>
        <span class="hint" data-note="${c.id}"></span></div>
      <div class="row">
        ${c.supported && !c.installed && !c.viaSystem ? `<button class="btn small" data-install="${c.id}">Download</button>` : ''}
        ${c.supported && !c.installed && c.viaSystem ? `<button class="btn small secondary" data-install="${c.id}">Check again</button>` : ''}
        ${c.installed && !c.viaSystem ? `<button class="btn small ghost" data-uninstall="${c.id}">Remove</button>` : ''}
        <button class="btn small ghost" data-cancel="${c.id}" style="display:none">Cancel</button>
      </div>
    </div>`;
}

function wireComponentButtons() {
  document.querySelectorAll('[data-install]').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.install;
      // Disable EVERY copy of this button and reveal EVERY cancel, or the
      // duplicate row in another step card stays clickable and starts a second
      // install of something already downloading.
      const setBusy = (busy) => {
        document.querySelectorAll(`[data-install="${id}"]`)
          .forEach((x) => { x.disabled = busy; });
        document.querySelectorAll(`[data-cancel="${id}"]`)
          .forEach((x) => { x.style.display = busy ? '' : 'none'; });
      };
      setBusy(true);
      const r = await studio.setupInstall(id);
      setBusy(false);
      if (!r.success) setComponentNote(id, r.error, true);
      await refreshSetup();
    };
  });
  document.querySelectorAll('[data-uninstall]').forEach((b) => {
    b.onclick = async () => { await studio.setupUninstall(b.dataset.uninstall); refreshSetup(); };
  });
  document.querySelectorAll('[data-cancel]').forEach((b) => {
    b.onclick = () => studio.setupCancel(b.dataset.cancel);
  });
}

// querySelectorAll, NOT querySelector.
//
// Grouping Setup by pipeline step means one component renders in more than one
// card — sd.cpp under both Stills and Motion, every image model under both. The
// singular form returns the FIRST match only, so a download would animate one
// progress bar while an identical row sat frozen at 0% in the card below, for
// the same download, at the same time. The frozen copy also keeps its
// "Download" button, so the natural response is to click it again.
//
// Invisible in a screenshot of a machine where nothing is downloading.
function onSetupProgress(p) {
  document.querySelectorAll(`[data-fill="${p.id}"]`)
    .forEach((fill) => { fill.style.width = `${p.pct || 0}%`; });
  setComponentNote(p.id, p.note || '', p.phase === 'error');
}

function setComponentNote(id, text, isError) {
  // All matches: see the note on onSetupProgress above.
  document.querySelectorAll(`[data-note="${id}"]`).forEach((note) => {
    note.textContent = text || '';
    note.classList.toggle('error', !!isError);
  });
}

// ─── Utils ─────────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}
