#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const rel = 'docs/maintainer-handoff.md';
const full = path.join(root, rel);
const requiredPhrases = [
  'This is not publication approval',
  'Synthetic demo data only',
  'What maintainers must not import',
  'Work only from `release-gate/exports/openclaw-frontier-stack-clean`',
  'readyForGithubUpload',
  'may not publish, upload, create releases, enable CI, or invite contributors',
];
const deniedPatterns = [
  ['home-path', /\/Users\/[A-Za-z0-9._-]+|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['token', /\b(?:sk-[A-Za-z0-9_-]{20,}|(?:ghp|github_pat)_[A-Za-z0-9_]{20,}|xox[abpors]-[A-Za-z0-9-]{20,})\b/],
  ['telegram-token', /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/],
  ['tailscale-ip', /\b100\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/],
  ['email-address', /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i],
];

const findings = [];
if (!fs.existsSync(full)) {
  findings.push({ issue: 'missing-maintainer-handoff', path: rel });
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
console.log(JSON.stringify({
  schema: 'openclaw-frontier.maintainer-handoff-verification.v1',
  ok,
  file: rel,
  findings,
}, null, 2));
process.exit(ok ? 0 : 1);
