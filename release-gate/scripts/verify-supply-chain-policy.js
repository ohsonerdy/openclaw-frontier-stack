#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..', '..');
const rel = 'docs/supply-chain-security.md';
const full = path.join(root, rel);
const requiredPhrases = [
  'not a live runtime export',
  'Do not commit `node_modules`',
  'Do not add GitHub Actions secrets',
  'check-export-parity.js',
  'does not authorize publication',
];
const deniedPatterns = [
  ['home-path', /\/Users\/[A-Za-z0-9._-]+|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['token', /\b(?:sk-[A-Za-z0-9_-]{20,}|(?:ghp|github_pat)_[A-Za-z0-9_]{20,}|xox[abpors]-[A-Za-z0-9-]{20,})\b/],
  ['telegram-token', /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/],
  ['tailscale-ip', /\b100\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/],
];

const findings = [];
if (!fs.existsSync(full)) {
  findings.push({ issue: 'missing-supply-chain-policy', path: rel });
} else {
  const text = fs.readFileSync(full, 'utf8');
  for (const phrase of requiredPhrases) {
    if (!text.includes(phrase)) findings.push({ issue: 'missing-required-phrase', phrase });
  }
  for (const [id, regex] of deniedPatterns) {
    if (regex.test(text)) findings.push({ issue: 'denied-pattern', pattern: id });
  }
}
const ok = findings.length === 0;

// Demo outputs are allowed to exist locally only if git itself ignores them.
// .gitignore and create-clean-export.js own export filtering; this verifier only catches unignored local outputs.
for (const out of ['examples/demo-swarm/out', 'examples/memory-demo/out', 'examples/goal-loop-demo/out']) {
  if (fs.existsSync(path.join(root, out))) {
    try {
      execFileSync('git', ['check-ignore', '--quiet', out], { cwd: root, stdio: 'pipe' });
    } catch {
      findings.push({ issue: 'untracked-demo-output-not-gitignored', path: out });
    }
  }
}

console.log(JSON.stringify({
  schema: 'openclaw-frontier.supply-chain-policy-verification.v1',
  ok,
  file: rel,
  findings,
}, null, 2));
process.exit(ok ? 0 : 1);
