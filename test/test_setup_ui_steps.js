'use strict';
//
// SETUP UI: STEP-GROUPED RENDERING
//
// These are source-level contract checks on app.js rather than DOM tests: the
// renderer is loaded by Electron, and standing up a full window to assert on
// markup costs more than it buys. What they guard is specific and has already
// bitten:
//
// ─── THE DUPLICATE-ID PROBLEM ───────────────────────────────────────────────
//
// Grouping by step makes ONE component render in TWO places — sd.cpp appears
// under Stills and under Motion, and every image model appears under both.
// The existing progress plumbing does:
//
//     document.querySelector(`[data-fill="${p.id}"]`)      // SINGULAR
//
// `querySelector` returns the FIRST match only. With a component on screen
// twice, a download would animate one progress bar and leave the other frozen
// at 0% — for the same download, in the same tab, at the same time. Worse, the
// frozen copy also keeps its "Download" button, so a user clicks it again.
//
// So every per-component lookup must be `querySelectorAll` and update ALL
// matches. That is the single behavioural requirement of this change, and it is
// invisible in a screenshot of a machine where nothing is downloading.

const fs = require('node:fs');
const nodePath = require('node:path');
const test = require('node:test');
const assert = require('node:assert');

const repoRoot = nodePath.resolve(__dirname, '..');
const appJs = fs.readFileSync(nodePath.join(repoRoot, 'app.js'), 'utf8');
const appHtml = fs.readFileSync(nodePath.join(repoRoot, 'app.html'), 'utf8');

test('the Setup tab has a step-grouped container', () => {
  assert.match(appHtml, /id="setup-steps"/,
    'app.html needs a #setup-steps container for the grouped view');
});

test('the renderer builds groups from the payload, not a second hardcoded list', () => {
  // STEP_GROUPS lives in ai/setup.js and the runner owns ALL_STEPS. A third
  // copy of the step names in the renderer is how the Setup tab ends up
  // showing a step the pipeline no longer runs.
  assert.match(appJs, /renderSetupSteps/, 'expected a renderSetupSteps function');

  // The renderer must read s.steps rather than re-deriving groups.
  assert.match(appJs, /s\.steps/, 'renderer does not consume the steps payload');

  // POSITIVE CONTROL: the step LABELS must not be retyped in app.js for the
  // setup view. STEP_META (movie mode) legitimately has its own labels, so we
  // check that no *second* literal list of setup step ids appears.
  const setupStepLiterals = appJs.match(/'(plan|image|voice|music|video|compose)'\s*:/g) || [];
  assert.ok(setupStepLiterals.length <= 6,
    `found ${setupStepLiterals.length} step-keyed literals — a second taxonomy has appeared`);
});

test('EVERY per-component DOM lookup updates ALL matches, not just the first', () => {
  // THE CORE GUARD. A component now renders in more than one step group, so
  // querySelector (singular) on data-fill / data-note / data-cancel silently
  // updates one copy and freezes the other.
  const singular = [];
  const re = /document\.querySelector\(\s*`\[data-(fill|note|cancel|install|uninstall)=/g;
  let m;
  while ((m = re.exec(appJs))) singular.push(m[1]);

  assert.deepEqual(singular, [],
    `querySelector (singular) used for duplicated component attrs: ${singular.join(', ')}`);

  // POSITIVE CONTROL: the plural form must actually be present, or this test
  // passes on a file that does no lookups at all.
  assert.match(appJs, /querySelectorAll\(\s*`\[data-(fill|note)=/,
    'no querySelectorAll for component progress — control failed');
});

test('progress and notes are applied to every rendered copy', () => {
  // Both helpers must iterate. A forEach on a NodeList of one is harmless; a
  // direct assignment to [0] is the bug.
  const fillFn = appJs.match(/function onSetupProgress[\s\S]{0,400}?\n}/);
  assert.ok(fillFn, 'could not locate onSetupProgress — control failed');
  assert.match(fillFn[0], /forEach/, 'onSetupProgress must update all matching bars');

  const noteFn = appJs.match(/function setComponentNote[\s\S]{0,400}?\n}/);
  assert.ok(noteFn, 'could not locate setComponentNote — control failed');
  assert.match(noteFn[0], /forEach/, 'setComponentNote must update all matching notes');
});

test('a duplicated component is visually marked as borrowed', () => {
  // Without this, Motion looks like it needs its own copy of a 5 GB model the
  // user already downloaded for Stills.
  assert.match(appJs, /sharedWith/,
    'renderer must surface sharedWith so a borrowed row reads as borrowed');
});

test('borrowed rows are COLLAPSED, not listed inline with the step\'s own', () => {
  // Measured in the rendered tab: the Motion card came out 13 rows long, of
  // which 9 were borrowed image models already listed under Stills — and the
  // Compose card was a single row that was 100% borrowed. Marking them is not
  // enough; repeating nine multi-gigabyte rows buries the four that the step
  // actually adds, which is the opposite of what grouping was for.
  //
  // So `sharedWith` rows go in a collapsed <details>, keeping them reachable
  // (a user may well want to install an image model from the Motion card)
  // without letting them dominate it.
  assert.match(appJs, /<details/, 'borrowed rows need a collapsed container');

  // The split must be explicit in the renderer, not left to CSS: a hidden row
  // that still counts toward the card's length is the same problem.
  assert.match(appJs, /filter\(\s*\(?\w+\)?\s*=>\s*!?\w+\.sharedWith/,
    'renderer must partition items on sharedWith');
});

test('a step whose components are ALL borrowed still says something', () => {
  // Measured after collapsing: the Compose card rendered 0 visible rows and a
  // collapsed "1 component shared with earlier steps" — a card that looks
  // empty and broken. Compose genuinely owns nothing (it IS ffmpeg), so the
  // card must state that rather than render a blank list.
  assert.match(appJs, /own\.length/,
    'renderer must handle a step with no components of its own');
});

test('companions render as dependents of their parent', () => {
  assert.match(appJs, /companionOf/,
    'renderer must surface companionOf so a 5 GB text encoder is not mistaken for a choice');
});

test('each step group shows its own readiness and size', () => {
  for (const token of ['g.ready', 'g.downloadGb']) {
    assert.ok(appJs.includes(token), `renderer does not use ${token}`);
  }
});

test('the old flat lists are gone, not left beside the grouped view', () => {
  // Two views of the same data in one tab is how they drift: a fix applied to
  // one list and not the other looks like a partially-working feature.
  for (const dead of ['engines-list', 'models-list']) {
    assert.ok(!appHtml.includes(`id="${dead}"`), `app.html still has #${dead}`);
    assert.ok(!appJs.includes(`'${dead}'`), `app.js still populates #${dead}`);
  }
  // POSITIVE CONTROL: the replacement really is present.
  assert.ok(appHtml.includes('id="setup-steps"'), 'grouped container missing — control failed');
});
