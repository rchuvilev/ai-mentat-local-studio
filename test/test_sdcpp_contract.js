'use strict';
//
// sd.cpp INSTALLER + CLI CONTRACT
//
// WHY THIS FILE EXISTS
//
// ai/setup.js deliberately does NOT pin an asset filename — its comment says
// "upstream renames assets between builds, so pinning a filename here would
// rot". That reasoning is right, but the regexes written to avoid the rot
// rotted anyway, silently and completely:
//
//   expected                      actual (release master-889-c678dfe)
//   bin-macos-arm64.zip           sd-master-c678dfe-bin-Darwin-macOS-26.6.2-arm64.zip
//   bin-macos-x64.zip             (no macOS x64 build published at all)
//   bin-win-avx2-x64.zip          sd-master-c678dfe-bin-win-cpu-x64.zip  (+cuda12/vulkan/rocm)
//   bin-ubuntu.*x64.zip           sd-master-c678dfe-bin-Linux-Ubuntu-24.04-x86_64.zip
//
// 0 of 4 matched. The image engine — marked `required: true` — could not
// install on ANY platform, and nothing in the suite noticed, because no test
// ever compared the matchers against a real asset list.
//
// Two further contract breaks were found the same way:
//   * the extracted archive contains `sd-cli`, not `sd`
//   * `-M img2img` is no longer a valid mode; sd.cpp now takes
//     [img_gen, adetailer, vid_gen, upscale, convert, metadata] and selects
//     img2img by the presence of an init image instead
//
// TESTING STRATEGY: offline by default, with a RECORDED asset list.
// Hitting the GitHub API in a unit test would make the suite fail on a plane
// and would be rate-limited in CI. The recorded fixture below is a verbatim
// copy of a real release feed, so these tests are fast and deterministic.
// `npm run check:sdcpp` performs the live check against the current feed and
// is the thing that catches the NEXT rename.
//
// Every assertion here carries a positive control: a matcher test that only
// ever says "no match" would pass just as well against an empty registry.

const os = require('node:os');
const nodePath = require('node:path');
const test = require('node:test');
const assert = require('node:assert');
const { buildSync } = require('esbuild');

// ai/setup.js pulls in stacks.ts, so it cannot be required directly under
// `node --test`. Bundled through esbuild exactly as test_setup_required.js
// does — same convention, no second mechanism.
const repoRoot = nodePath.resolve(__dirname, '..');
const tmp = nodePath.join(os.tmpdir(), `sdcpp-contract-${process.pid}`);
require('node:fs').mkdirSync(tmp, { recursive: true });
const out = nodePath.join(tmp, 'setup.js');
buildSync({
  entryPoints: [nodePath.join(repoRoot, 'ai/setup.js')],
  bundle: true, platform: 'node', format: 'cjs', outfile: out,
  external: ['node:*', 'electron'],
});
const { ENGINES, matchAsset, SDCPP_MODES } = require(out);

// Verbatim asset names from leejet/stable-diffusion.cpp master-889-c678dfe
// (published 2026-09-20T20:54:01Z), fetched from the GitHub releases API.
const RECORDED_ASSETS = [
  'cudart-sd-bin-win-cu12-x64.zip',
  'sd-master-c678dfe-bin-Darwin-macOS-26.6.2-arm64.zip',
  'sd-master-c678dfe-bin-Linux-Ubuntu-24.04-x86_64-rocm-7.14.0.zip',
  'sd-master-c678dfe-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip',
  'sd-master-c678dfe-bin-Linux-Ubuntu-24.04-x86_64.zip',
  'sd-master-c678dfe-bin-win-cpu-x64.zip',
  'sd-master-c678dfe-bin-win-cuda12-x64.zip',
  'sd-master-c678dfe-bin-win-rocm-7.14.0-x64.zip',
  'sd-master-c678dfe-bin-win-vulkan-x64.zip',
];

// An OLDER naming scheme, kept so the matchers are proven to be tolerant of
// upstream churn rather than merely re-pinned to today's names.
const LEGACY_ASSETS = [
  'sd-master-abc1234-bin-macos-arm64.zip',
  'sd-master-abc1234-bin-ubuntu-x64.zip',
  'sd-master-abc1234-bin-win-avx2-x64.zip',
];

const sdcpp = ENGINES.find((e) => e.id === 'sdcpp');

test('the sdcpp engine entry is present and required', () => {
  assert.ok(sdcpp, 'sdcpp engine missing from the registry');
  assert.equal(sdcpp.required, true);
});

test('every platform matcher resolves against a REAL release asset list', () => {
  const platforms = Object.keys(sdcpp.github.assetMatch);
  assert.ok(platforms.length >= 3, 'expected matchers for at least 3 platforms');

  const unmatched = [];
  for (const p of platforms) {
    const hit = matchAsset(sdcpp, p, RECORDED_ASSETS);
    if (!hit) unmatched.push(p);
  }
  assert.deepEqual(unmatched, [], `no release asset matches: ${unmatched.join(', ')}`);
});

test('macos-x64 is declared absent rather than advertised and broken', () => {
  // Upstream ships an arm64 macOS build ONLY (verified across the 4 most
  // recent releases). A matcher for macos-x64 would promise a download that
  // cannot resolve; its absence makes installEngine fail fast with
  // "no build for macos-x64", which is honest and actionable.
  assert.equal(sdcpp.github.assetMatch['macos-x64'], undefined);
  const macAssets = RECORDED_ASSETS.filter((n) => /darwin|macos/i.test(n));
  assert.ok(macAssets.length > 0, 'fixture has no macOS asset — control failed');
  assert.ok(
    macAssets.every((n) => /arm64/i.test(n)),
    'fixture gained a macOS x64 build; re-add the matcher',
  );
});

test('matchers still resolve against the LEGACY naming scheme', () => {
  // Guards against "fix" by re-pinning to the current names only — which would
  // rot again on the next rename exactly as the original did.
  for (const p of ['macos-arm64', 'linux-x64', 'win-x64']) {
    assert.ok(matchAsset(sdcpp, p, LEGACY_ASSETS), `legacy asset unmatched for ${p}`);
  }
});

test('POSITIVE CONTROL: matchers reject an unrelated asset list', () => {
  // Without this, a matcher of /.*/ would pass every test above.
  const junk = ['README.md', 'source.tar.gz', 'checksums.txt'];
  for (const p of Object.keys(sdcpp.github.assetMatch)) {
    assert.equal(matchAsset(sdcpp, p, junk), null, `${p} matched junk — matcher is too loose`);
  }
});

test('platform matchers do not cross-match each other', () => {
  // A win matcher that also catches the Linux zip would install the wrong
  // binary and fail at exec time with a confusing error.
  const win = matchAsset(sdcpp, 'win-x64', RECORDED_ASSETS);
  const linux = matchAsset(sdcpp, 'linux-x64', RECORDED_ASSETS);
  const mac = matchAsset(sdcpp, 'macos-arm64', RECORDED_ASSETS);
  assert.ok(/win/i.test(win), `win matcher picked ${win}`);
  assert.ok(/linux|ubuntu/i.test(linux), `linux matcher picked ${linux}`);
  assert.ok(/darwin|macos/i.test(mac), `macos matcher picked ${mac}`);
  assert.notEqual(win, linux);
  assert.notEqual(linux, mac);
});

test('the CPU build is preferred over GPU-specific variants', () => {
  // cuda12/vulkan/rocm builds need a matching runtime present. The portable
  // CPU build is the only one guaranteed to run on an arbitrary user machine,
  // so an installer that grabs the rocm zip is worse than one that grabs none.
  const win = matchAsset(sdcpp, 'win-x64', RECORDED_ASSETS);
  assert.ok(!/cuda|vulkan|rocm/i.test(win), `win matcher picked an accelerator build: ${win}`);
  const linux = matchAsset(sdcpp, 'linux-x64', RECORDED_ASSETS);
  assert.ok(!/cuda|vulkan|rocm/i.test(linux), `linux matcher picked an accelerator build: ${linux}`);
});

test('the cudart side-car is never mistaken for the engine', () => {
  // 'cudart-sd-bin-win-cu12-x64.zip' ships CUDA runtime DLLs and NO sd binary.
  // It sorts first alphabetically, so a loose win matcher grabs it and the
  // install "succeeds" with no executable in it.
  const win = matchAsset(sdcpp, 'win-x64', RECORDED_ASSETS);
  assert.ok(!/^cudart/i.test(win), `win matcher picked the cudart side-car: ${win}`);
});

test('the engine binary is named sd-cli, not sd', () => {
  // Verified by extracting the real Linux zip: it contains sd-cli, sd-server
  // and shared objects. There is no file called `sd`.
  assert.equal(sdcpp.binary.default, 'sd-cli');
  assert.equal(sdcpp.binary['win-x64'], 'sd-cli.exe');
});

test('img2img is NOT a valid sd.cpp run mode', () => {
  // ai/sdcpp.js used to push `-M img2img`. Current sd.cpp accepts only the
  // modes below (examples/common/common.cpp modes_str @c678dfe); passing
  // img2img aborts the run.
  assert.ok(!SDCPP_MODES.includes('img2img'));
  for (const m of ['img_gen', 'vid_gen', 'upscale', 'convert', 'metadata']) {
    assert.ok(SDCPP_MODES.includes(m), `expected mode ${m} to be known`);
  }
});
