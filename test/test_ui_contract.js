'use strict';
//
// UI CONTRACT test.
//
// ─── WHY ────────────────────────────────────────────────────────────────────
//
// The renderer talks to the main process through two string-keyed contracts,
// and BOTH fail silently when they drift:
//
//   1. `document.getElementById('x')` returns null for a typo'd id, and the
//      subsequent `.innerHTML =` throws deep inside a callback nobody watches.
//   2. `studio.someMethod()` is undefined if preload.js never exposed it —
//      again a runtime TypeError, not a build error.
//
// Neither is caught by the unit suites (which never load the DOM) nor by the
// bundler (which does not parse HTML). This is a cheap static cross-check: it
// reads the three files as text and asserts every id and every `studio.*` call
// the advisor code uses actually exists on the other side.
//
// ponytail: deliberately a string/regex scan rather than a headless browser.
// A real DOM harness would need jsdom or Electron and would test far more than
// the contract that actually broke. If this starts missing real bugs, that is
// the upgrade path.

const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const appHtml = fs.readFileSync(path.join(root, 'app.html'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const mainJs = fs.readFileSync(path.join(root, 'electron-main.js'), 'utf8');

test('EVERY element id used by app.js exists in app.html', () => {
  // Widened from `advisor-*` to all ids.
  //
  // The narrow version was justified as "the rest of the app predates this
  // change and is already exercised by the smoke test", but the smoke test
  // drives the IPC surface, not the DOM — it cannot see a renderer reaching
  // for an id that no longer exists. Regrouping the Setup tab deleted
  // #engines-list and #models-list, exactly the kind of edit where a missed
  // getElementById call yields `null` and a TypeError at first paint.
  const ids = [...appJs.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(ids.length >= 15, `expected many ids, found ${ids.length}`);

  const missing = [...new Set(ids)].filter((id) => !appHtml.includes(`id="${id}"`));
  assert.deepEqual(missing, [], `app.html is missing: ${missing.join(', ')}`);
});

test('every studio.advisor* call in app.js is exposed by preload.js', () => {
  const calls = [...appJs.matchAll(/studio\.(advisor[A-Za-z]*|onAdvisorStartup)\s*\??\.?\(/g)]
    .map((m) => m[1]);
  assert.ok(calls.length >= 3, `expected several advisor calls, found ${calls.length}`);
  for (const fn of new Set(calls)) {
    assert.match(preload, new RegExp(`\\b${fn}\\s*:`), `preload.js does not expose studio.${fn}`);
  }
});

test('every advisor channel in preload.js is handled in the main process', () => {
  // preload invokes 'advisor:x'; main must ipcMain.handle('advisor:x').
  // A missing handler rejects at call time with an opaque "No handler" error.
  const invoked = [...preload.matchAll(/ipcRenderer\.invoke\('(advisor:[^']+)'/g)].map((m) => m[1]);
  assert.ok(invoked.length >= 3, `expected several advisor channels, found ${invoked.length}`);
  for (const ch of new Set(invoked)) {
    assert.ok(mainJs.includes(`ipcMain.handle('${ch}'`), `electron-main.js does not handle '${ch}'`);
  }
});

test('the startup event name matches on both sides', () => {
  // main: webContents.send('advisor:startup') -> preload: ipcRenderer.on(same)
  assert.ok(mainJs.includes("send('advisor:startup'"), 'main must emit advisor:startup');
  assert.ok(preload.includes("on('advisor:startup'"), 'preload must listen for advisor:startup');
});

test('the startup advice waits for the renderer to be listening', () => {
  // REGRESSION TEST for a real race found while tracing the user flow.
  //
  // `webContents.send()` to a page that has not yet executed app.js is DROPPED
  // SILENTLY — no queue, no error. The first version sent from a bare
  // setImmediate(), which fires on the next tick. Measured: the hardware probe
  // takes ~40 ms while a page load is 50-300 ms, so the send almost always beat
  // the listener and the Setup tab sat on "Scanning hardware…" until the user
  // switched tabs.
  //
  // did-finish-load is the event that guarantees app.js has run. A fixed delay
  // would only make the race rarer, which is worse: it would pass in testing
  // and fail on slow machines.
  assert.ok(
    mainJs.includes("once('did-finish-load'") || mainJs.includes('once("did-finish-load"'),
    'startup advice must wait for did-finish-load, not fire on a bare tick',
  );
  assert.ok(!/setImmediate\(\(\) => \{\s*try \{\s*const hw = hardware\.profile/.test(mainJs),
    'the old setImmediate send must be gone');

  // The renderer needs its own safety net: an event that is lost for any other
  // reason must not leave a permanent spinner.
  assert.match(appJs, /advisorArrived/, 'renderer must track whether the event arrived');
  assert.match(appJs, /setTimeout\(\(\) => \{ if \(!advisorArrived\) refreshAdvisor\(\)/,
    'renderer must fall back to pulling the advice itself');
});

test('advisorArrived is declared before the listener that assigns it', () => {
  // `let` is hoisted but sits in the temporal dead zone. If the listener were
  // defined above the declaration and fired first, it would throw a
  // ReferenceError inside an IPC callback — invisible unless someone is
  // watching devtools.
  const decl = appJs.indexOf('let advisorArrived');
  const use = appJs.indexOf('advisorArrived = true');
  assert.ok(decl !== -1 && use !== -1, 'both the declaration and the assignment must exist');
  assert.ok(decl < use, 'declaration must precede the assigning listener');
});

test('CONTROL: the scan detects a deliberately broken reference', () => {
  // Without this, all four tests above would also pass if the regexes simply
  // matched nothing. Proves the id check can actually fail.
  const fakeJs = "getElementById('advisor-does-not-exist')";
  const ids = [...fakeJs.matchAll(/getElementById\('(advisor-[^']+)'\)/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['advisor-does-not-exist']);
  assert.ok(!appHtml.includes('id="advisor-does-not-exist"'),
    'control id must genuinely be absent from the HTML');
});
