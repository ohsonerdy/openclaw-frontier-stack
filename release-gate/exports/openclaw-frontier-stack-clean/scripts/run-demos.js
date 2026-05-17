#!/usr/bin/env node
'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const DEFAULT_CHILD_TIMEOUT_MS = Number.parseInt(process.env.FRONTIER_CHILD_TIMEOUT_MS || '120000', 10);
const demos = [
  ['goal-loop-demo', path.join(root, 'examples', 'goal-loop-demo', 'run-goal-demo.js')],
  ['demo-swarm', path.join(root, 'examples', 'demo-swarm', 'run-demo.js')],
  ['memory-demo', path.join(root, 'examples', 'memory-demo', 'run-memory-demo.js')],
  ['remote-approval-demo', path.join(root, 'examples', 'remote-approval-demo', 'run-remote-approval-demo.js')],
];

const results = [];
for (const [name, script] of demos) {
  const started = Date.now();
  try {
    execFileSync(process.execPath, [script], {
      cwd: root,
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: DEFAULT_CHILD_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    results.push({ name, ok: true, ms: Date.now() - started });
  } catch (err) {
    results.push({
      name,
      ok: false,
      ms: Date.now() - started,
      error: String(err.message || err),
      stdout: err.stdout ? String(err.stdout).trim() : '',
      stderr: err.stderr ? String(err.stderr).trim() : '',
    });
  }
}

const ok = results.every((result) => result.ok);
console.log(JSON.stringify({ ok, demos: results }, null, 2));
process.exit(ok ? 0 : 1);
