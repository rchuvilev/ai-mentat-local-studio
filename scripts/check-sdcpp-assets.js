#!/usr/bin/env node
/**
 * LIVE check: do the sd.cpp asset matchers still resolve against the current
 * GitHub release?
 *
 * ─── WHY THIS IS SEPARATE FROM THE UNIT TEST ────────────────────────────────
 *
 * test/test_sdcpp_contract.js runs against a RECORDED asset list so the suite
 * is fast, offline and deterministic. That protects against regressions in our
 * matching logic, but it cannot see upstream renaming its assets tomorrow —
 * which is exactly what happened last time:
 *
 *   the registry looked for `bin-macos-arm64.zip`, `bin-win-avx2-x64.zip` and
 *   `bin-ubuntu.*x64.zip`; upstream had moved to `Darwin-macOS-<ver>-arm64`,
 *   per-backend `win-{cpu,cuda12,vulkan,rocm}` and `Linux-Ubuntu-24.04-x86_64`.
 *   All four matched nothing. The image engine — `required: true` — could not
 *   install on any platform, and no test noticed, because none of them had
 *   ever compared the matchers against a real asset list.
 *
 * Run this when the image engine fails to install, or periodically. It is
 * deliberately NOT part of `npm test`: a unit suite that fails when GitHub is
 * unreachable, or when the API rate-limits, teaches people to ignore it.
 *
 *     node scripts/check-sdcpp-assets.js
 *
 * Exit 0 = every platform resolves. Exit 1 = at least one does not.
 */
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { buildSync } = require('esbuild');

const repoRoot = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdcpp-live-'));
const out = path.join(tmp, 'setup.js');
buildSync({
  entryPoints: [path.join(repoRoot, 'ai/setup.js')],
  bundle: true, platform: 'node', format: 'cjs', outfile: out,
  external: ['node:*', 'electron'],
});
const { ENGINES, matchAsset } = require(out);

const engine = ENGINES.find((e) => e.id === 'sdcpp');

(async () => {
  const url = `https://api.github.com/repos/${engine.github.repo}/releases/latest`;
  const res = await fetch(url, { headers: { 'user-agent': 'ai-mentat-local-studio' } });
  if (!res.ok) {
    console.error(`GitHub API returned ${res.status} — cannot check (not a matcher failure).`);
    process.exit(2);
  }
  const rel = await res.json();
  const names = (rel.assets || []).map((a) => a.name);

  console.log(`release ${rel.tag_name} — ${names.length} assets\n`);

  // A release with no assets would make every matcher "fail" for a reason that
  // has nothing to do with the matchers. Say so rather than reporting 3 breaks.
  if (!names.length) {
    console.error('Release carries no assets at all; nothing to match against.');
    process.exit(2);
  }

  let bad = 0;
  for (const platform of Object.keys(engine.github.assetMatch)) {
    const hit = matchAsset(engine, platform, names);
    if (hit) {
      console.log(`  ok    ${platform.padEnd(13)} -> ${hit}`);
    } else {
      bad++;
      console.log(`  BROKEN ${platform.padEnd(12)} -> no match`);
    }
  }

  // POSITIVE CONTROL: if a junk list also matched, the matchers are too loose
  // and the "ok" lines above mean nothing.
  const junk = ['README.md', 'source.tar.gz'];
  const loose = Object.keys(engine.github.assetMatch)
    .filter((p) => matchAsset(engine, p, junk));
  if (loose.length) {
    console.log(`\n  CONTROL FAILED: matched junk for ${loose.join(', ')}`);
    bad += loose.length;
  }

  console.log(`\nassets: ${names.join('\n        ')}`);
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  console.error(`check failed: ${e.message}`);
  process.exit(2);
});
