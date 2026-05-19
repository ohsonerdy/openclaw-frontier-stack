#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..', '..');
const exportRoot = path.join(root, 'release-gate', 'exports', 'openclaw-frontier-stack-clean');
const findings = [];

if (!fs.existsSync(exportRoot)) findings.push({ issue: 'missing-release-manifest', path: 'release-gate/exports/openclaw-frontier-stack-clean' });

let tempRoot = null;
let verification = null;
try {
  if (findings.length === 0) {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-frontier-fresh-export-'));
    const candidateRoot = path.join(tempRoot, 'openclaw-frontier-stack-clean');
    fs.cpSync(exportRoot, candidateRoot, { recursive: true });
    const stdout = execFileSync(process.execPath, ['scripts/verify-package.js'], {
      cwd: candidateRoot,
      encoding: 'utf8',
      timeout: 240000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, OPENCLAW_FRONTIER_SKIP_FRESH_EXPORT: '1', OPENCLAW_FRONTIER_STANDALONE_EXPORT: '1' },
    });
    verification = JSON.parse(stdout);
    if (verification.ok !== true) findings.push({ issue: 'fresh-export-package-verifier-failed', output: verification });
  }
} catch (err) {
  findings.push({
    issue: 'fresh-export-verifier-error',
    error: String(err.message || err),
    stdout: err.stdout ? String(err.stdout).slice(0, 4000) : '',
    stderr: err.stderr ? String(err.stderr).slice(0, 4000) : '',
  });
} finally {
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
}

const ok = findings.length === 0;
console.log(JSON.stringify({
  schema: 'openclaw-frontier.fresh-export-verification.v1',
  ok,
  exportPath: 'release-gate/exports/openclaw-frontier-stack-clean',
  nestedCheckCount: verification?.checks?.length ?? 0,
  findings,
}, null, 2));
process.exit(ok ? 0 : 1);
