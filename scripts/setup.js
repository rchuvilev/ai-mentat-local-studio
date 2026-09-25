#!/usr/bin/env node
/** `npm run setup` — install every npm and non-npm dependency needed to run. */
'use strict';
const path = require('path');
const { setup } = require('../sdk/logic/app-scripts');

setup({
  appName: "ai-mentat-local-studio",
  root: path.resolve(__dirname, '..'),
  system: [],
  extra: () => {
  // stable-diffusion.cpp engines are large; fetch on demand
  console.log('--> run `npm run download:engines` to fetch AI engines');
  },
});
