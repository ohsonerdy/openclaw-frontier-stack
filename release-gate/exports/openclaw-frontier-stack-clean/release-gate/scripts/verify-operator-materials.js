#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const forbidden = [
  /^release-gate\/scripts\/(run-frontier-live-eval|frontier-presence-probe|score-frontier-maturity|generate-release-status)\.js$/,
  /^release-gate\/OPERATOR_UPLOAD_APPROVAL_REQUIRED\.md$/,
  /^release-gate\/LICENSE_SELECTION_REQUIRED\.md$/,
  /(^|\/)\.vault(\/|$)/,
  /(^|\/)KEYS(\/|$)/,
];
const findings = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      if (['.git', 'node_modules', 'exports', 'reports', 'artifacts'].includes(entry.name)) continue;
      walk(full);
    } else if (forbidden.some((re) => re.test(rel))) {
      findings.push({ path: rel, issue: 'operator-private-material-in-public-tree' });
    }
  }
}
walk(root);
const ok = findings.length === 0;
console.log(JSON.stringify({ schema: 'openclaw-frontier.operator-materials.v1', ok, findings }, null, 2));
process.exit(ok ? 0 : 1);