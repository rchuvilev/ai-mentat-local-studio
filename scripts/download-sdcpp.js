#!/usr/bin/env node
'use strict';
//
// CLI counterpart to the in-app Setup tab.
//
// The app can install everything from its own UI ("download for user, not
// manual install"), but a headless install path is useful for CI and for
// preparing a machine before first launch. Both go through the same registry so
// they cannot drift.
//
//   node scripts/download-sdcpp.js                # engine + required models
//   node scripts/download-sdcpp.js sdcpp sd15     # named components
//   node scripts/download-sdcpp.js --list

const path = require('path');
const { Setup, ENGINES, MODELS, platformKey } = require('../ai/setup');
const { humanBytes } = require('../ai/download');

const root = path.join(__dirname, '..', '.local-studio');
const setup = new Setup({
  enginesDir: path.join(root, 'engines'),
  modelsDir: path.join(root, 'models'),
});

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: node scripts/download-sdcpp.js [--list] [component...]

Downloads engines and models into ${root}.
With no arguments, installs everything marked required.`);
  process.exit(0);
}

if (args.includes('--list')) {
  const s = setup.status();
  console.log(`platform: ${platformKey()}\n`);
  for (const group of [['Engines', s.engines], ['Models', s.models]]) {
    console.log(group[0]);
    for (const c of group[1]) {
      const mark = c.installed ? '✓' : c.supported === false ? '–' : ' ';
      console.log(`  ${mark} ${c.id.padEnd(16)} ${(c.approxHuman || '').padStart(8)}  ${c.name}`);
    }
    console.log('');
  }
  process.exit(0);
}

const targets = args.length
  ? args
  : [...ENGINES, ...MODELS].filter((c) => c.required).map((c) => c.id);

(async () => {
  let failed = 0;
  for (const id of targets) {
    const item = setup.find(id);
    if (!item) { console.error(`✕ unknown component: ${id}`); failed++; continue; }

    process.stdout.write(`→ ${item.name}\n`);
    let lastPct = -1;
    try {
      await setup.install(id, (p) => {
        const pct = Math.floor(p.pct || 0);
        // Only redraw on whole-percent changes; a 9 GB download otherwise
        // produces tens of thousands of lines in a CI log.
        if (pct !== lastPct) {
          lastPct = pct;
          process.stdout.write(`\r   ${String(pct).padStart(3)}%  ${p.note || ''}`.padEnd(78));
        }
      });
      process.stdout.write(`\r   ✓ installed`.padEnd(78) + '\n');
    } catch (e) {
      process.stdout.write(`\r   ✕ ${e.message}`.padEnd(78) + '\n');
      failed++;
    }
  }

  const s = setup.status();
  console.log(`\n${s.ready ? 'Ready to generate.' : `Still missing: ${s.missingRequired.join(', ')}`}`);
  const u = { models: 0, engines: 0 };
  try {
    const { Storage } = require('../ai/storage');
    const st = new Storage(root).usage();
    u.models = st.models; u.engines = st.engines;
  } catch {}
  console.log(`on disk: ${humanBytes(u.engines)} engines, ${humanBytes(u.models)} models`);
  process.exit(failed ? 1 : 0);
})();
