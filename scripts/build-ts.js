#!/usr/bin/env node
/**
 * Compile the TypeScript sources and their tests to CommonJS for `node --test`.
 *
 * ─── WHY THIS EXISTS, AND WHY IT IS NOT `tsc` ───────────────────────────────
 *
 * The new advisor modules are TypeScript (requested). The repo's tests run on
 * `node --test`, and running TS there needs *something* to strip the types.
 * Four options were measured on this machine before picking:
 *
 *   1. `node --experimental-strip-types`  — FAILS. This Node v22.23.2 build
 *      reports `ERR_NO_TYPESCRIPT: Node.js is not compiled with TypeScript
 *      support`. Native stripping is unavailable here regardless of flags, so
 *      the obvious zero-cost route is genuinely closed.
 *
 *   2. `tsc` — would add the `typescript` package as a new devDependency for
 *      nothing but type erasure. Rejected: no new dependency if it can be
 *      avoided.
 *
 *   3. `bun test` — works (measured, 1 pass). Rejected anyway: it would split
 *      the suite across two runtimes, leaving the 28 existing `node --test`
 *      assertions on one and the new ones on another. One command must run
 *      everything, or CI silently covers half the code.
 *
 *   4. esbuild → `node --test` — CHOSEN. esbuild 0.28.2 is ALREADY a
 *      dependency (it bundles the Electron main process in
 *      sdk/utils/bundle-electron.js), it strips types natively, and it keeps a
 *      single test runtime. Zero new dependencies.
 *
 * ─── PONYTAIL NOTE ──────────────────────────────────────────────────────────
 *
 * ponytail: this is a deliberate corner-cut with a known ceiling. esbuild
 * strips types WITHOUT CHECKING THEM — a type error will not fail this build.
 * That is an accepted trade for adding no dependency, and it is honest about
 * what the TS buys here: documentation and editor support, not verification.
 * Upgrade path when type errors start biting: add `typescript` as a
 * devDependency and run `tsc --noEmit` as a separate lint step, leaving this
 * script as the (faster) test compiler.
 *
 * `bundle: true` matters. Without it, esbuild emits `require('./advisor.ts')`
 * with the .ts extension intact and Node cannot resolve it. Bundling inlines
 * the import graph and sidesteps extension rewriting entirely — measured: the
 * unbundled variant fails, the bundled one passes.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const outdir = path.join(root, '.ts-build');

// Discover TS tests rather than listing them: a new test file must be picked up
// automatically, or someone will add one and quietly never run it.
const testDir = path.join(root, 'test');
const entries = fs.readdirSync(testDir)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => path.join(testDir, f));

if (!entries.length) {
  console.log('No TypeScript tests found — nothing to build.');
  process.exit(0);
}

fs.rmSync(outdir, { recursive: true, force: true });
fs.mkdirSync(outdir, { recursive: true });

const result = buildSync({
  entryPoints: entries,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outdir,
  // Node builtins and electron must not be inlined; everything else is local
  // source we WANT bundled so the .ts extensions disappear.
  external: ['node:*', 'electron'],
  sourcemap: 'inline',      // stack traces point at the .ts, not the bundle
  logLevel: 'warning',
});

if (result.errors.length) {
  console.error('TypeScript build failed');
  process.exit(1);
}

console.log(`Compiled ${entries.length} TypeScript test file(s) -> .ts-build/`);
