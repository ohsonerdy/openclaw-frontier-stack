#!/usr/bin/env node
'use strict';

const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
if (nodeMajor < 20) {
  console.error(`OpenClaw Frontier Stack requires Node.js >=20; current runtime is ${process.version}.`);
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  message: 'No external dependencies are required. Run npm run demo, then npm run verify.',
  node: process.version,
}, null, 2));
