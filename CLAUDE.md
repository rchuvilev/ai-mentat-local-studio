# CLAUDE.md — Hexstack Mentat Local Studio

Electron app for fully local AI media generation — images, narration, music and
video. Nothing is sent anywhere: every engine and model runs on the user's
machine and installs from inside the app.

## Run and test

```sh
npm install
npm run gui            # bundle main process with esbuild, then launch
npm test               # 59 tests: JS suite + transpiled TS suite
npm run test:unit      # 33 JS tests only
npm run test:ts        # 26 TS tests only (builds .ts-build/ first)
npm run test:smoke     # the original Electron smoke test (needs a display)
```

⚠️ `npm test` used to be the Electron smoke test, which cannot run headless.
It is now the unit suite; the smoke test moved to `test:smoke`. Use the glob
form `node --test 'test/test_*.js'` — `node --test test/` treats the bare
directory as a file named `test` and runs nothing useful.

## Architecture

| Layer | Path | Notes |
|---|---|---|
| Main process | `electron-main.js` | IPC, window, process supervision |
| UI | `app.html` / `app.css` / `app.js` | single page |
| **Engine logic** | **`ai/*.js`** | **13 modules, 2400 lines, all Electron-free** |
| Build | `shared/*.js` | esbuild bundling, auto-update, publish/release |
| Engine fetch | `scripts/download-sdcpp.js` | pulls stable-diffusion.cpp builds |

**Every module under `ai/` loads under plain node** — no `require('electron')`,
each exports its surface. That is why the unit suite needs no display and why
new engine logic belongs there rather than inline in `electron-main.js`.

### TypeScript: which files, and why esbuild

`ai/hardware.ts`, `ai/advisor.ts` and `ai/stacks.ts` are TypeScript; everything
else is still CommonJS JavaScript. The mix is deliberate — these three carry
the most structured data (hardware profiles, placements, model entries) and
benefit most from types, while converting working modules wholesale would be
churn with no payoff.

**They are transpiled by esbuild, which was already a dependency** (it bundles
the main process). Four options were measured before choosing:

| Option | Result |
|---|---|
| `node --experimental-strip-types` | **Fails.** This Node v22.23.2 reports `ERR_NO_TYPESCRIPT` — not compiled with TS support |
| `tsc` | Adds a dependency purely for type erasure. Rejected |
| `bun test` | Works, but splits the suite across two runtimes — half the tests silently stop running |
| **esbuild → `node --test`** | **Chosen.** Zero new deps, one runtime, one command |

⚠️ **esbuild strips types WITHOUT CHECKING THEM.** A type error will not fail
the build. That is an accepted trade for adding no dependency; the TS buys
documentation and editor support here, not verification. Add `tsc --noEmit` as
a separate lint step if that stops being enough.

⚠️ `scripts/build-ts.js` uses `bundle: true`. Without it esbuild emits
`require('./advisor.ts')` with the extension intact and Node cannot resolve it —
measured: the unbundled variant fails, the bundled one passes. The Electron
bundler needs no change at all, because it already bundles the whole import
graph and resolves `.ts` transparently.

## Design decisions worth preserving

**Capacity estimation exists to make the length slider honest.** A slider
without a cost estimate is meaningless, so `ai/capacity.js` answers one
question: given this machine and this mode, how long will N seconds take?
`recommendedMaxSeconds()` walks down from the max until the estimate fits the
~3 minute `TARGET_RUN_SECONDS` budget.

**Ken Burns is the cheap path on purpose.** It is an ffmpeg pan/zoom over a
still, not frame-by-frame diffusion — that ordering is asserted by a test, so
it cannot silently invert during a retune.

**The advisor gates hard, and the estimator only advises.** `ai/capacity.js`
answers "how long?" and may be wrong without consequence. `ai/advisor.ts`
answers "can this even load?" and a wrong answer costs the user a failed
multi-gigabyte download. They stay separate for that reason — and
`capacity:hardware` was left untouched when `advisor:hardware` was added, so an
advisor failure cannot break the existing time display.

**Selection is per ROLE, not per stack.** Upstream ranks one list of chat LLMs;
this app must fill five roles at once and they are not interchangeable. A mixed
lite/studio result is the normal, correct outcome.

**Peak memory is the MAX stage, not the SUM.** The pipeline is sequential
(script → image → motion → voice → music) and each stage unloads before the
next starts. Summing would reject perfectly good stacks on 8 GB machines. This
is asserted by a test *specifically so that* making `runner.js` concurrent
breaks the test rather than silently invalidating the reasoning.

**`cpuHostile` is separate from `heavy` on purpose.** `heavy` is about SIZE and
the memory gate already handles it. `cpuHostile` is about THROUGHPUT: a model
can fit comfortably and still be the wrong answer. Frame-by-frame video
diffusion fits in 4 GB and would run for hours there, while Ken Burns produces
motion in seconds. A memory gate alone cannot express that.

**One registry, not two.** `ai/setup.js` derives its `MODELS` list from
`ai/stacks.ts` rather than keeping its own. When they were separate, a model
added to one and missing from the other resolved to `null` in `Setup.find()` —
surfacing as "model not downloaded" for a model the advisor had just
recommended, with every unit test still green. `test/test_wiring.js` exists to
catch exactly that and is mutation-tested against it.

**The queue is built for unattended overnight runs**, which drives three
things: settings are shared (an item carries a prompt, not its own config), an
error skips to the next item rather than halting the batch, and state is
persisted after every transition so a crash resumes instead of restarting.
An item left `running` by a crash is reset to `pending` on load — leaving it
`running` would strand it forever, because nothing picks up a running item.

## 🔴 Bugs fixed

**A weak CPU box was recommended the BIGGEST model that fit.** Found by running
the advisor against this sandbox's real hardware rather than a synthetic
profile: a 7.4 GB, 1-core, CPU-only machine was told to run **Qwen3 8B**. The
memory check was correct (5.48 GB needed vs 5.91 GB usable) but the *advice* was
bad — 0.43 GB of headroom on a box also running Electron, and an 8B model on one
core at ~4 tok/s.

Cause: every CPU placement scored an identical 55, so `chooseStack`'s
best-first walk always took the largest model that fit. On a GPU the headroom
term already differentiated candidates; on CPU nothing did. Fix is two
graduated penalties (memory pressure, size-per-core) **plus** making the relaxed
fallback sort by score instead of taking the first match — the penalties alone
would have done nothing, since the fallback ignored scores entirely. After the
fix the same machine takes the lite stack: 5.0 GB instead of 10.8 GB, 9.6 tok/s
instead of 4.2. Both halves are mutation-tested, and a control asserts capable
machines still get the studio stack — otherwise "always pick the smallest model"
would pass.

**Synthetic test profiles cannot catch probe failures.** The unit suite passed
throughout while `hardware.ts` had never been run on a real machine. The
sandbox is deliberately hostile — `os.cpus()` returns `[]`, no GPU, restricted
`/proc` — and running the real probes there is what confirmed the "degrade,
never throw" rule actually holds end to end.

**`os.cpus()` can return an EMPTY array** — measured on this Android sandbox,
and it also happens in some containers and restricted VMs. All three call sites
in `capacity.js` then produced 0: the UI read **"CPU (0 cores)"**, `probe()`
reported `cores: 0`, and any per-core scaling collapsed to nothing. `cpuCount()`
now floors at 1 — under-reporting only slows an estimate, zero breaks the
arithmetic that consumes it.

**`Queue.persist()` swallowed every write failure.** That is the one error that
loses real work: an unattended batch which cannot write its state restarts from
scratch after a crash. It still must not throw (that would abort the run in
progress), but it is now recorded via `reportQueueError` and readable through
`recentQueueErrors()`.

**A throwing UI listener was swallowed too** — the batch survived, which is
correct, but nobody could find out why the UI stopped updating.

## Testing conventions

- **Assert properties, not constants.** The cost coefficients in `capacity.js`
  are tuned by measurement; a test pinned to "24 seconds" breaks on every
  retune while proving nothing. The tests assert monotonicity (longer costs
  more, quality costs more than fast), bounds (recommendation stays inside the
  slider range) and finiteness (never `NaN` in the UI).
- **Prove the helper works before trusting a green test.** `add()` was verified
  to actually persist to `queue.json` — a test against a method that silently
  does nothing passes for the wrong reason.
- Error buffers are bounded (50 for the queue): this app runs for hours
  unattended and an unbounded buffer is a slow leak.
- **Check the test premise before "fixing" the code.** Two advisor tests failed
  on first run and both were the TEST's fault, not the code's:
  - `4070 Ti` vs `4070` was asserted to differ; both legitimately map to
    504 GB/s, so the assertion was unprovable. Rewritten around pairs whose
    values genuinely differ (`3070 Ti` 608 vs `3070` 448), with an explicit
    guard asserting the premise before relying on it.
  - "4 GB fits no animation model" was false — AnimateDiff needs 2.0 GB and
    4 GB × 0.80 = 3.2 GB usable. Measuring the arithmetic is what caught it.
    The corrected test uses 2 GB, and the *real* hazard it was groping toward
    (fits ≠ usable) became the `cpuHostile` gate.
- **Mutation-test every gate.** A green suite proves nothing until breaking the
  code turns it red. Five mutations were run against the advisor — disabling the
  `cpuHostile` gate, letting the fallback re-admit it, `max`→`sum` for peak
  memory, removing the CPU size penalty, and reverting the fallback to
  first-match — and each killed exactly one test.
- **Grep for a renamed symbol is not a presence check.** `grep -c "class Ltx"`
  on the bundle returned **0** for code that was correctly included: esbuild
  emits `var Ltx`. Verify with a string only that module can contain (a unique
  error message), not with a declaration form the bundler is free to rewrite.
