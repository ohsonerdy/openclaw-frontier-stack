#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const required = [
  'docs/goal-system.md',
  'docs/agent-system.md',
  'examples/goal-loop-demo/README.md',
  'examples/goal-loop-demo/run-goal-demo.js',
  'examples/demo-swarm/run-demo.js',
];
const requiredTerms = [
  ['docs/goal-system.md', '/goal'],
  ['docs/goal-system.md', 'receipts'],
  ['docs/goal-system.md', 'fail-closed'],
  ['docs/goal-system.md', '30-minute'],
  ['docs/agent-system.md', 'Orchestrator'],
  ['docs/agent-system.md', 'Coding-team execution path'],
  ['docs/agent-system.md', 'Production smoke/acceptance scenario path'],
  ['README.md', 'Orchestrator'],
];

const checks = [];
function check(name, ok, detail) { checks.push({ name, ok, detail }); }

for (const rel of required) {
  check(`file-exists:${rel}`, fs.existsSync(path.join(root, rel)), rel);
}
for (const [rel, term] of requiredTerms) {
  const file = path.join(root, rel);
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  check(`term:${rel}:${term}`, text.includes(term), term);
}

const architectureTexts = [
  'README.md',
  'docs/verification-flow.md',
  'docs/end-to-end-trace.md',
  'examples/demo-swarm/run-demo.js',
  'examples/mission-control-demo/board.json',
].map((rel) => [rel, fs.existsSync(path.join(root, rel)) ? fs.readFileSync(path.join(root, rel), 'utf8') : '']);
for (const [rel, text] of architectureTexts) {
  check(`no-neo-master-role:${rel}`, !new RegExp(String.fromCharCode(78,101,111) + ' (as orchestrator|receives|writes|creates|posts|decomposes|owns|orchestrates)').test(text), rel);
}

console.log(JSON.stringify({ ok: checks.every((item) => item.ok), checks }, null, 2));
process.exit(checks.every((item) => item.ok) ? 0 : 1);
