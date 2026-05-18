#!/usr/bin/env node
'use strict';

/**
 * private-content-scan.js — Stop hook.
 *
 * After Claude finishes a turn, scan files changed vs. HEAD for private
 * content. Non-zero exit blocks the Stop event in the hook protocol.
 *
 * If we're not in a git repo, exit 0 silently — the gate doesn't apply.
 */

const fs = require('fs');
const { execFileSync } = require('child_process');
const { scan } = require('../release-gate/lib/private-patterns');

let changedFiles = [];
try {
  changedFiles = execFileSync('git', ['diff', '--name-only', 'HEAD'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim().split(/\r?\n/).filter(Boolean);
} catch {
  process.exit(0);
}

const findings = [];
for (const rel of changedFiles) {
  if (!fs.existsSync(rel)) continue;
  let buf;
  try {
    buf = fs.readFileSync(rel);
  } catch {
    continue;
  }
  if (buf.includes(0)) continue;
  findings.push(...scan(rel, buf.toString('utf8')));
}

if (findings.length) {
  process.stderr.write('[private-content-scan] findings in changed files:\n');
  for (const f of findings.slice(0, 10)) {
    process.stderr.write(`  ${f.pattern}  ${f.file}:${f.line}  ${f.match.slice(0, 80)}\n`);
  }
  if (findings.length > 10) {
    process.stderr.write(`  ... and ${findings.length - 10} more\n`);
  }
  process.exit(1);
}
process.exit(0);
